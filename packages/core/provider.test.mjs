import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { sdkProvider, retryAfterMilliseconds, REVIEW_PROTOCOL, acquireModelRequestSlot, acquireRequestSlot, configureRequestSlots, liveRequestSlots, sharedCooldown } from './provider.mjs';
import { providerCapacityFailure } from './request-recovery.mjs';
import { createTextWire } from './text-wire.mjs';

const units = [{ id: 'u1', source: 'Start', revision: 1 }, { id: 'u2', source: 'Continue', revision: 1 }];
const wire = createTextWire({ task: 'translation', units, referenceOnly: [], glossary: [] });
const request = { system: 'Return the current short-reference text protocol.', prompt: wire.prompt, wire };
const reviewWire = createTextWire({ task: 'proofreading', responseProtocol: REVIEW_PROTOCOL, units: units.slice(0, 1), referenceOnly: [], glossary: [] });
const reviewRequest = { ...request, prompt: reviewWire.prompt, wire: reviewWire, responseProtocol: REVIEW_PROTOCOL };

test('only an explicit in-flight budget response receives temporary capacity classification and its actual Retry-After', () => {
  const body = { error: { code: 402, message: 'Current in-flight budget exceeded.', metadata: { reason: 'in_flight_budget_exhausted', headers: { 'Retry-After': '120' } } } };
  const failure = providerCapacityFailure({ statusCode: 402, body: JSON.stringify(body), responseHeaders: new Headers() });
  assert.equal(failure.code, 'PROVIDER_CAPACITY');
  assert.equal(failure.retryAfterMs, 120000);
  assert.equal(failure.providerReason, 'in_flight_budget_exhausted');
  assert.equal(providerCapacityFailure({ statusCode: 402, body: { error: { code: 402, message: 'Insufficient credits.' } } }), undefined);
  assert.equal(providerCapacityFailure({ statusCode: 400, body }), undefined);
  assert.equal(providerCapacityFailure({ statusCode: 402, body: 'invalid JSON' }), undefined);
});

test('a request queued behind a slot rechecks new cooldowns, releases its slot while waiting and remains cancellable', async t => {
  configureRequestSlots(1);
  const releases = [];
  t.after(() => { releases.forEach(release => release()); configureRequestSlots(Infinity); });
  const held = await acquireRequestSlot(); releases.push(held);
  const key = `neutral-capacity-${Date.now()}`;
  let admitted = false;
  const pending = acquireModelRequestSlot({ key }).then(release => { admitted = true; releases.push(release); return release; });
  await delay(30);
  sharedCooldown.defer(key, { retryAfterMs: 50 });
  held();
  await delay(60);
  assert.equal(admitted, false);
  assert.equal(liveRequestSlots(), 0, 'a newly cooled connection gives its queued slot back');
  const independent = await acquireModelRequestSlot({ key: `${key}-independent` }); independent();
  const controller = new AbortController();
  const cancelled = acquireModelRequestSlot({ key, signal: controller.signal });
  controller.abort(new Error('Neutral cancelled capacity wait.'));
  await assert.rejects(cancelled, /Neutral cancelled capacity wait/);
  assert.equal(liveRequestSlots(), 0);
  (await pending)();
  assert.equal(liveRequestSlots(), 0);
});

test('OpenAI-compatible local endpoint accepts an empty key, trailing slash and separate reasoning', async t => {
  let requestBody, authorization, pathname, requests = 0;
  const server = createServer(async (request, response) => {
    requests++;
    authorization = request.headers.authorization;
    pathname = request.url;
    let body = '';
    for await (const chunk of request) body += chunk;
    requestBody = JSON.parse(body);
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('x-request-id', 'neutral-json-request');
    response.end(JSON.stringify({
      id: 'local-model-fixture', object: 'chat.completion', created: 1, model: requestBody.model,
      choices: [{ index: 0, message: { role: 'assistant', reasoning_content: 'Neutral reasoning.', content: '```json\n{"text":[["u1","开始游戏",""]]}\n```' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 },
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const checkpoints = [];
  const result = await sdkProvider({
    connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1/`, model: 'local-qwen-fixture', apiKey: '' },
    ...request, signal: AbortSignal.timeout(10_000),
    onRecords: records => checkpoints.push(...records),
  });
  assert.equal(pathname, '/v1/chat/completions');
  assert.equal(authorization, undefined);
  assert.equal(requestBody.model, 'local-qwen-fixture');
  assert.equal(requestBody.stream, true);
  // Bounded output: an unbounded request is what lets reasoning tokens dominate the bill.
  const declaredCeiling = requestBody.max_tokens ?? requestBody.max_completion_tokens;
  assert.ok(Number.isInteger(declaredCeiling) && declaredCeiling > 0,
    `translation requests declare a positive output ceiling, got ${JSON.stringify({ max_tokens: requestBody.max_tokens, max_completion_tokens: requestBody.max_completion_tokens })}`);
  // `reasoning`/`reasoning_effort` are provider-specific fields: injecting them blindly makes an
  // otherwise working compatible host answer 400, so a non-OpenRouter endpoint receives neither.
  assert.equal(requestBody.reasoning, undefined);
  assert.equal(requestBody.reasoning_effort, undefined);
  assert.equal(requests, 1, 'a JSON-only response must be reused without a second request');
  assert.deepEqual(requestBody.messages.map(message => message.role), ['system', 'user']);
  assert.deepEqual(result.records, [{ id: 'u1', translation: '开始游戏', notes: '' }]);
  assert.deepEqual(checkpoints, result.records);
  assert.equal(result.requestId, 'neutral-json-request');
  assert.equal(result.transportRequests, 1);
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage.inputTokens, 8);
});

async function localEndpoint(t, respond) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    const input = JSON.parse(body); requests.push(input);
    try { await respond(response, input); }
    catch (error) { if (!response.destroyed) response.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'neutral-stream-model' }, requests };
}

test('draining an unsent request never buys a call or leaks an acquired model slot', async t => {
  const { connection, requests } = await localEndpoint(t, response => response.end());
  const queue = new AbortController();
  await assert.rejects(sdkProvider({ connection, ...request, signal: AbortSignal.timeout(3000), queueSignal: queue.signal,
    onTransport: event => { if (event.type === 'send') queue.abort(new Error('Stop unpaid admission')); },
  }), error => { assert.equal(error.transportRequests, 0); return /Stop unpaid admission/.test(error.message); });
  assert.equal(requests.length, 0);
  assert.equal(liveRequestSlots(), 0);
});

test('draining admission does not cancel an HTTP response that is already in flight', async t => {
  let received, release;
  const entered = new Promise(resolve => { received = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const { connection, requests } = await localEndpoint(t, async response => {
    received(); await hold;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 'drain-http', object: 'chat.completion', created: 1, model: connection.model,
      choices: [{ index: 0, message: { role: 'assistant', content: '{"text":[["u1","开始游戏",""]]}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  t.after(() => release());
  const queue = new AbortController(), user = new AbortController();
  const pending = sdkProvider({ connection, ...request, signal: user.signal, queueSignal: queue.signal });
  await entered;
  queue.abort(new Error('Stop new work, retain this response')); release();
  const result = await pending;
  assert.equal(user.signal.aborted, false);
  assert.equal(requests.length, 1);
  assert.deepEqual(result.records, [{ id: 'u1', translation: '开始游戏', notes: '' }]);
  assert.equal(liveRequestSlots(), 0);
});

test('an admission cancelled behind a full model slot never reaches HTTP', async t => {
  configureRequestSlots(1);
  const held = await acquireRequestSlot();
  t.after(() => { held(); configureRequestSlots(Infinity); });
  const { connection, requests } = await localEndpoint(t, response => response.end());
  const queue = new AbortController();
  const pending = sdkProvider({ connection, ...request, signal: AbortSignal.timeout(3000), queueSignal: queue.signal });
  await delay(30); queue.abort(new Error('Stop queued admission'));
  await assert.rejects(pending, error => error === queue.signal.reason || error.cause === queue.signal.reason);
  assert.equal(requests.length, 0);
  assert.equal(liveRequestSlots(), 1);
  held(); assert.equal(liveRequestSlots(), 0);
});

test('streaming text checkpoints independently and optional term choices attach only to final paid records', async t => {
  const termWire = createTextWire({ task: 'translation', units: [{ id: 'name-canonical', source: 'Alice enters the Guild.' }], referenceOnly: [], glossary: [] });
  const { connection, requests } = await localEndpoint(t, async response => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const parts = ['{"text":[["u1","爱丽丝走进公会。",""]]', ',"terms":[["u1","Alice","爱丽丝"],["u1","Guild","公会"],["unknown","Alice","爱丽丝"]]}'];
    for (const content of parts) response.write(`data: ${JSON.stringify({ id: 'neutral-terms', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ id: 'neutral-terms', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  const checkpoints = [];
  const result = await sdkProvider({ connection, system: 'Neutral first translation.', prompt: termWire.prompt, wire: termWire,
    onRecords: records => checkpoints.push(...records) });
  assert.equal(requests.length, 1, 'optional sidecars never need an additional model call');
  assert.deepEqual(checkpoints, [{ id: 'name-canonical', translation: '爱丽丝走进公会。', notes: '' }]);
  assert.deepEqual(result.records, [{ ...checkpoints[0], termChoices: [{ source: 'Alice', translation: '爱丽丝' }, { source: 'Guild', translation: '公会' }] }]);
  assert.equal(result.termWarnings[0].code, 'UNKNOWN_TERM_TARGET');
});

function startStream(response) {
  response.setHeader('content-type', 'text/event-stream');
  response.setHeader('x-request-id', 'neutral-stream-request');
}

function sendChunk(response, delta = {}, finishReason = null) {
  response.write(`data: ${JSON.stringify({ id: 'neutral-completion', object: 'chat.completion.chunk', created: 1, model: 'neutral-stream-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}

function finishStream(response, reason = 'stop') {
  sendChunk(response, {}, reason);
  response.end('data: [DONE]\n\n');
}

test('an actual temporary 402 response defers the next request outside the first-answer timeout without retrying the rejected request', async t => {
  let attempts = 0;
  const { connection, requests } = await localEndpoint(t, async response => {
    response.setHeader('content-type', 'application/json');
    if (++attempts === 1) {
      response.statusCode = 402;
      response.end(JSON.stringify({ error: { code: 402, message: 'In-flight reservation limit.',
        metadata: { reason: 'in_flight_budget_exhausted', headers: { 'Retry-After': '0.01' } } } }));
    } else response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"text":[]}' }, finish_reason: 'stop' }] }));
  });
  await assert.rejects(sdkProvider({ connection, ...request }), error => error.code === 'PROVIDER_CAPACITY'
    && error.statusCode === 402 && error.retryAfterMs === 10 && error.category === 'provider_capacity');
  assert.equal(requests.length, 1, 'the provider never adds a hidden retry loop');
  const started = Date.now();
  const result = await sdkProvider({ connection, ...request, timeout: { firstChunkMs: 100, chunkMs: 100, totalMs: 1000 } });
  assert.ok(Date.now() - started >= 350, 'the existing 500ms minimum cooldown actually exceeded the 100ms response deadline');
  assert.deepEqual(result.records, []);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].max_tokens, requests[1].max_tokens, 'capacity recovery does not cut output ability');
});

test('ordinary credit exhaustion remains an unretried HTTP failure rather than temporary provider capacity', async t => {
  const { connection, requests } = await localEndpoint(t, async response => {
    response.writeHead(402, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 402, message: 'Insufficient credits.' } }));
  });
  await assert.rejects(sdkProvider({ connection, ...request }), error => error.statusCode === 402 && error.code !== 'PROVIDER_CAPACITY');
  assert.equal(requests.length, 1);
});

test('JSON-only servers without an optional finish reason remain compatible without repeated requests', async t => {
  const { connection, requests } = await localEndpoint(t, async response => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"text":[]}' } }] }));
  });
  const result = await sdkProvider({ connection, ...request });
  assert.deepEqual(result.records, []); assert.equal(result.finishReason, 'other'); assert.equal(requests.length, 1);
});

test('without a user override thinking stays the model default on every host', async t => {
  const bodies = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body); bodies.push(input);
    response.setHeader('content-type', 'application/json');
    response.setHeader('x-request-id', 'neutral-thinking-default');
    response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '{"text":[]}' }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const connection = { baseUrl: `http://127.0.0.1:${server.address().port}/openrouter/v1`, model: 'neutral-router-model' };
  const result = await sdkProvider({ connection, ...request });
  assert.deepEqual(result.records, []);
  // Cost optimizations must not silently suppress reasoning; the default still belongs to the model.
  assert.equal(bodies[0].reasoning, undefined, 'no reasoning opt-out is sent');
  assert.equal(bodies[0].reasoning_effort, undefined, 'no blind effort hint is sent either');
  assert.ok(Number.isInteger(bodies[0].max_tokens) && bodies[0].max_tokens > 0, 'the output ceiling fuse still rides along');
  assert.equal(bodies.length, 1, 'nothing is sent for a host to reject, so there is no degradation retry');
});

for (const [status, message] of [[400, 'stream is not supported; use stream=false'], [422, 'Unknown parameter: "stream"']]) {
  test(`an explicit ${status} stream rejection falls back once with the same connection`, async t => {
    const output = { text: [['u1', 'Complete', '']] };
    const { connection, requests } = await localEndpoint(t, async (response, input) => {
      response.setHeader('content-type', 'application/json');
      if (input.stream) { response.statusCode = status; response.end(JSON.stringify({ error: { message } })); return; }
      response.setHeader('x-request-id', 'neutral-nonstream-fallback');
      response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }] }));
    });
    const checkpoints = [];
    const result = await sdkProvider({ connection, ...request, onRecords: records => checkpoints.push(...records) });
    assert.deepEqual(requests.map(input => input.stream), [true, false]);
    assert.equal(requests[0].model, requests[1].model);
    // The downgrade repeats the material only because the streaming attempt was rejected
    // before any output existed. Equal payloads are not a specification here: what matters is
    // that the retried material is the same request, and that nothing already produced is
    // charged or checkpointed twice.
    assert.deepEqual(requests[1].messages.map(message => message.role), requests[0].messages.map(message => message.role));
    const records = [{ id: 'u1', translation: 'Complete', notes: '' }];
    assert.deepEqual(checkpoints, records); assert.deepEqual(result.records, records);
    assert.equal(result.transportRequests, 2); assert.equal(result.requestId, 'neutral-nonstream-fallback');
  });
}

test('an unrelated HTTP 400 error mentioning stream is not retried as non-streaming', async t => {
  const { connection, requests } = await localEndpoint(t, async response => {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Unsupported model name; stream=true is valid.' } }));
  });
  await assert.rejects(sdkProvider({ connection, ...request }), error => {
    assert.equal(error.statusCode, 400); assert.equal(error.transportRequests, 1); return true;
  });
  assert.equal(requests.length, 1);
});

test('a 200 JSON error is not sent again even when its message mentions unsupported streaming', async t => {
  const { connection, requests } = await localEndpoint(t, async response => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: { message: 'stream is not supported' } }));
  });
  await assert.rejects(sdkProvider({ connection, ...request }), error => {
    assert.equal(error.transportRequests, 1); return true;
  });
  assert.equal(requests.length, 1);
});

for (const headers of [false, true]) {
  test(`first meaningful output timeout covers a stalled ${headers ? 'JSON response body' : 'HTTP response header'}`, async t => {
    const { connection, requests } = await localEndpoint(t, async response => {
      if (headers) { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"choices":['); }
    });
    await assert.rejects(sdkProvider({ connection, ...request, timeout: { firstChunkMs: 120, chunkMs: 120, totalMs: 2000 } }), error => {
      assert.equal(error.code, 'ETIMEDOUT'); assert.match(error.message, /First chunk timeout of 120ms/);
      assert.equal(error.transportRequests, 1); return true;
    });
    assert.equal(requests.length, 1);
  });
}

test('the non-streaming fallback shares the original total timeout rather than starting another deadline', async t => {
  const { connection, requests } = await localEndpoint(t, async (response, input) => {
    if (input.stream) {
      await delay(70); response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'stream is not supported' } })); return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"choices":[');
  });
  await assert.rejects(sdkProvider({ connection, ...request, timeout: { firstChunkMs: 2000, chunkMs: 2000, totalMs: 160 } }), error => {
    assert.equal(error.code, 'ETIMEDOUT'); assert.equal(error.transportRequests, 2);
    assert.doesNotMatch(error.message, /First chunk/); return true;
  });
  assert.deepEqual(requests.map(input => input.stream), [true, false]);
});

test('streamed complete records are checkpointed once before completion across escaped and nested JSON', async t => {
  const records = [
    { id: 'u1', translation: 'Quoted "{braces}" and \\ slash\nnext line', notes: '完整中文' },
    { id: 'u2', translation: 'Second record', notes: '' },
  ];
  let checkpoint;
  const firstCheckpoint = new Promise(resolve => { checkpoint = resolve; });
  t.after(() => checkpoint());
  let finished = false;
  const { connection } = await localEndpoint(t, async response => {
    startStream(response);
    sendChunk(response, { content: '```json\n{"te\\u0078t":[' });
    const first = JSON.stringify(['u1', records[0].translation, records[0].notes]);
    for (let index = 0; index < first.length; index += 3) sendChunk(response, { content: first.slice(index, index + 3) });
    await firstCheckpoint;
    sendChunk(response, { content: `,${JSON.stringify(['u2', records[1].translation, records[1].notes])}]}\n\`\`\`` });
    finished = true; finishStream(response);
  });
  const checkpoints = [];
  const result = await sdkProvider({ connection, ...request, signal: AbortSignal.timeout(2000), onRecords: batch => {
    if (!checkpoints.length) { assert.equal(finished, false); checkpoint(); }
    checkpoints.push(batch);
  } });
  assert.deepEqual(checkpoints, [[records[0]], [records[1]]]);
  assert.deepEqual(result.records, records);
  assert.equal(result.requestId, 'neutral-stream-request');
});

test('a truncated SSE response throws after retaining only its completed records', async t => {
  const { connection, requests } = await localEndpoint(t, async response => {
    startStream(response);
    sendChunk(response, { content: '{"text":[["u1","Complete",""],' });
    sendChunk(response, { content: '["u2","unfinished' });
    response.end();
  });
  const checkpoints = [];
  await assert.rejects(sdkProvider({ connection, ...request, onRecords: records => checkpoints.push(...records) }), error => {
    assert.match(error.message, /without a finish reason/);
    assert.equal(error.code, 'ECONNRESET'); assert.equal(error.category, 'transport');
    assert.equal(error.requestId, 'neutral-stream-request'); return true;
  });
  assert.deepEqual(checkpoints, [{ id: 'u1', translation: 'Complete', notes: '' }]);
  assert.equal(requests.length, 1);
});

test('an interrupted JSON document preserves closed records but never emits a partial translation', async t => {
  const { connection } = await localEndpoint(t, async response => {
    startStream(response);
    sendChunk(response, { content: '{"text":[["u1","Complete"],["u2","half' });
    finishStream(response, 'length');
  });
  const checkpoints = [];
  await assert.rejects(sdkProvider({ connection, ...request, onRecords: records => checkpoints.push(...records) }), { code: 'MODEL_OUTPUT_TRUNCATED' });
  assert.deepEqual(checkpoints, [{ id: 'u1', translation: 'Complete', notes: '' }]);
});

test('reasoning activity resets idle timeout without entering the returned records', async t => {
  const output = { text: [['u1', 'Complete', '']] };
  const { connection } = await localEndpoint(t, async response => {
    startStream(response);
    for (let index = 0; index < 8; index++) { sendChunk(response, { reasoning_content: 'neutral thinking ' }); await delay(30); }
    sendChunk(response, { content: JSON.stringify(output) }); finishStream(response);
  });
  const progress = [];
  const result = await sdkProvider({ connection, ...request, timeout: { firstChunkMs: 1000, chunkMs: 150, totalMs: 2000 }, onProgress: event => progress.push(event) });
  assert.deepEqual(result.records, [{ id: 'u1', translation: 'Complete', notes: '' }]);
  assert.equal(progress.at(-1).receivedCharacters, progress.at(-1).textCharacters + progress.at(-1).reasoningCharacters);
  assert.ok(progress.at(-1).reasoningCharacters > 0);
  assert.ok(progress.at(-1).textCharacters > 0);
});

test('SSE heartbeats do not postpone the first meaningful chunk timeout', async t => {
  const { connection, requests } = await localEndpoint(t, async response => {
    startStream(response); response.write(': heartbeat\n\n');
    const timer = setInterval(() => { if (!response.destroyed) response.write(': heartbeat\n\n'); }, 15);
    t.after(() => clearInterval(timer)); response.once('close', () => clearInterval(timer));
  });
  await assert.rejects(sdkProvider({ connection, ...request, timeout: { firstChunkMs: 100, chunkMs: 100, totalMs: 1000 } }), error => {
    assert.equal(error.code, 'ETIMEDOUT'); assert.match(error.message, /First chunk/); return true;
  });
  assert.equal(requests.length, 1);
});

// Retry policy: a 5xx, a 429 and a stalled stream are retried by the service.mjs attempts loop,
// never here. Retrying an idle timeout or a truncation would pay twice for tokens the failed
// attempt already generated, and two layers of retries multiply one logical failure into six.
test('idle timeout retains the completed candidate and reports a timeout', async t => {
  const { connection } = await localEndpoint(t, async response => {
    startStream(response);
    sendChunk(response, { content: '{"text":[["u1","Complete"],' });
  });
  const checkpoints = [];
  await assert.rejects(sdkProvider({ connection, ...request, timeout: { firstChunkMs: 1000, chunkMs: 100, totalMs: 2000 }, onRecords: records => checkpoints.push(...records) }), error => {
    assert.equal(error.code, 'ETIMEDOUT'); assert.match(error.message, /Chunk timeout/); return true;
  });
  assert.ok(checkpoints.some(record => record.id === 'u1'), 'the completed candidate survives the failed attempt');
});

test('the total timeout still caps a response that keeps generating', async t => {
  const { connection } = await localEndpoint(t, async response => {
    startStream(response); sendChunk(response, { reasoning_content: 'neutral thinking ' });
    const timer = setInterval(() => { if (!response.destroyed) sendChunk(response, { reasoning_content: 'more neutral thinking ' }); }, 20);
    t.after(() => clearInterval(timer)); response.once('close', () => clearInterval(timer));
  });
  await assert.rejects(sdkProvider({ connection, ...request, timeout: { firstChunkMs: 1000, chunkMs: 1000, totalMs: 150 } }), { code: 'ETIMEDOUT' });
});

test('user cancellation retains completed candidates and the original cancellation reason', async t => {
  const controller = new AbortController(), canceled = new Error('neutral user pause');
  const { connection, requests } = await localEndpoint(t, async response => {
    startStream(response); sendChunk(response, { content: '{"text":[["u1","Complete"],' });
  });
  const checkpoints = [];
  await assert.rejects(sdkProvider({ connection, ...request, signal: controller.signal, onRecords: records => { checkpoints.push(...records); controller.abort(canceled); } }), error => error === canceled);
  assert.deepEqual(checkpoints, [{ id: 'u1', translation: 'Complete', notes: '' }]);
  assert.equal(requests.length, 1);
});

test('duplicate short references are rejected before a second checkpoint can overwrite a result', async t => {
  const text = [['u1', 'First'], ['u1', 'Second']];
  const { connection } = await localEndpoint(t, async response => {
    startStream(response); sendChunk(response, { content: JSON.stringify({ text }) }); finishStream(response);
  });
  const checkpoints = [];
  await assert.rejects(sdkProvider({ connection, ...request, onRecords: batch => checkpoints.push(...batch) }), { code: 'INVALID_RESPONSE' });
  assert.ok(checkpoints.length <= 1); assert.ok(checkpoints.every(record => record.translation === 'First'));
});

test('HTTP failures preserve the request ID and status for the service layer to retry', async t => {
  const { connection } = await localEndpoint(t, async response => {
    response.writeHead(503, { 'content-type': 'application/json', 'x-request-id': 'neutral-failed-request' });
    response.end(JSON.stringify({ error: { message: 'neutral unavailable' } }));
  });
  await assert.rejects(sdkProvider({ connection, ...request }), error => {
    assert.equal(error.statusCode, 503); assert.equal(error.requestId, 'neutral-failed-request'); return true;
  });
});

test('Retry-After supports seconds and HTTP dates with invalid and past values handled explicitly', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(retryAfterMilliseconds('2', now), 2000);
  assert.equal(retryAfterMilliseconds('0.5', now), 500);
  assert.equal(retryAfterMilliseconds(new Date(now + 3000).toUTCString(), now), 3000);
  assert.equal(retryAfterMilliseconds(new Date(now - 3000).toUTCString(), now), 0);
  assert.equal(retryAfterMilliseconds('invalid', now), undefined);
  assert.equal(retryAfterMilliseconds('', now), undefined);
  assert.equal(retryAfterMilliseconds('-1', now), undefined);
  assert.equal(retryAfterMilliseconds('9'.repeat(400), now), undefined);
});

test('HTTP rate limits retain request identity, Retry-After and classification for the service layer', async t => {
  const { connection } = await localEndpoint(t, async response => {
    response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2', 'x-request-id': 'neutral-rate-limit' });
    response.end(JSON.stringify({ error: { message: 'temporary rate limit' } }));
  });
  await assert.rejects(sdkProvider({ connection, ...request }), error => {
    assert.equal(error.statusCode, 429); assert.equal(error.retryAfterMs, 2000); assert.equal(error.category, 'rate_limit');
    assert.equal(error.requestId, 'neutral-rate-limit'); return true;
  });
});

test('malformed terminal JSON preserves usage, finish reason and completed candidate IDs', async t => {
  const { connection } = await localEndpoint(t, async response => {
    startStream(response);
    sendChunk(response, { content: '{"text":[["u1","Complete"],["u2","unfinished' });
    response.write(`data: ${JSON.stringify({ id: 'neutral-truncated', choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 123, completion_tokens: 456, total_tokens: 579, prompt_tokens_details: { cached_tokens: 17 } } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await assert.rejects(sdkProvider({ connection, ...request }), error => {
    assert.equal(error.code, 'MODEL_OUTPUT_TRUNCATED'); assert.equal(error.finishReason, 'length'); assert.equal(error.category, 'output_truncated');
    assert.equal(error.usage.inputTokens, 123); assert.equal(error.usage.outputTokens, 456);
    assert.equal(error.rawUsage.prompt_tokens_details.cached_tokens, 17);
    assert.deepEqual(error.completedIds, ['u1']); return true;
  });
});

test('differential review envelopes stay distinct from streamed translation checkpoints', async t => {
  const review = { reviewed: ['u1'], changes: [], questions: [] };
  const { connection } = await localEndpoint(t, async response => {
    startStream(response); sendChunk(response, { content: JSON.stringify(review) }); finishStream(response);
  });
  const checkpointed = [];
  const result = await sdkProvider({ connection, ...reviewRequest, onRecords: records => checkpointed.push(...records) });
  assert.deepEqual(result.review, { protocol: REVIEW_PROTOCOL, reviewedIds: ['u1'], issues: [], edits: [] });
  assert.deepEqual(result.records, []); assert.deepEqual(checkpointed, []);
});

test('a differential request cannot checkpoint a legacy records envelope before review validation', async t => {
  const { connection } = await localEndpoint(t, async response => {
    startStream(response); sendChunk(response, { content: '{"records":[{"id":"u1","translation":"changed without review"}]}' }); finishStream(response);
  });
  const checkpointed = [];
  await assert.rejects(sdkProvider({ connection, ...reviewRequest, onRecords: records => checkpointed.push(...records) }), { code: 'INVALID_RESPONSE' });
  assert.deepEqual(checkpointed, []);
});

test('differential review can request indexed evidence before emitting its final review envelope', async t => {
  const lookup = { read: [{ text: 'Captain', reason: 'Resolve speaker identity' }], notes: 'u1: Captain is a rank, identity remains unknown.' };
  const { connection } = await localEndpoint(t, async response => {
    startStream(response); sendChunk(response, { content: JSON.stringify(lookup) }); finishStream(response);
  });
  const result = await sdkProvider({ connection, ...reviewRequest });
  assert.deepEqual(result.evidenceRequests, [{ query: { text: 'Captain' }, reason: 'Resolve speaker identity' }]);
  assert.deepEqual(result.records, []); assert.equal(result.readingNotes, lookup.notes);
});

test('ordinary responses retain optional scoped semantic decisions', async t => {
  const decisions = [{ entity: 'actor', sense: 'name', scope: { unitIds: ['u1'] }, evidenceIds: ['u1'] }];
  const { connection } = await localEndpoint(t, async response => {
    startStream(response); sendChunk(response, { content: JSON.stringify({ text: [['u1', '萝丝']], decisions }) }); finishStream(response);
  });
  const result = await sdkProvider({ connection, ...request });
  assert.deepEqual(result.semanticDecisions.map(({ id, expectedRevision, ...decision }) => decision), decisions);
  assert.match(result.semanticDecisions[0].id, /^meaning-[a-f0-9]{24}$/); assert.equal(result.semanticDecisions[0].expectedRevision, 0);
  assert.equal(result.records.length, 1);
});

for (const [name, message, finish, expectedCode, expectedCategory] of [
  ['truncated reasoning', { reasoning_content: 'Neutral reasoning.', content: '' }, 'length', 'MODEL_OUTPUT_TRUNCATED', 'output_truncated'],
  ['reasoning without final', { reasoning_content: 'Neutral reasoning.', content: '' }, 'stop', 'MODEL_REASONING_ONLY', 'reasoning_only'],
  ['empty final', { content: '' }, 'stop', 'MODEL_EMPTY_RESPONSE', 'empty_response'],
  ['explicit refusal', { content: '', refusal: 'Cannot fulfil.' }, 'stop', 'MODEL_REFUSAL', 'model_refusal'],
  ['wrong records field', { content: '{"units":[{"id":"u1","translation":"Welcome"}]}' }, 'stop', 'INVALID_RESPONSE', 'response_structure'],
]) {
  test(`actual compatible response distinguishes ${name}`, async t => {
    const { connection, requests } = await localEndpoint(t, async response => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }] }));
    });
    await assert.rejects(sdkProvider({ connection, ...request }), error => {
      assert.equal(error.code, expectedCode); assert.equal(error.category, expectedCategory); assert.equal(error.transportRequests, 1); return true;
    });
    assert.equal(requests.length, 1);
  });
}
