import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createTechnicalTransport } from './model-transport.mjs';
import { runAdaptation } from './adaptation.mjs';
import { createRequestArtifact, readRequestArtifact } from '../core/request-artifacts.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { configureRequestSlots, acquireRequestSlot, liveRequestSlots } from '../core/provider.mjs';

test('technical capacity cooldown waits outside response timers, exposes waiting and cancels without holding a slot', async () => {
  let calls = 0;
  const notices = [], controller = new AbortController();
  const transport = createTechnicalTransport({ requestTimeoutMs: 80, requestTotalTimeoutMs: 200, onWait: notice => notices.push(notice),
    fetchImpl: async () => {
      calls++;
      return calls === 1 ? new Response(JSON.stringify({ error: { code: 402, metadata: { reason: 'in_flight_budget_exhausted', headers: { 'Retry-After': '0.01' } } } }), { status: 402 })
        : new Response('{"choices":[{"message":{"content":"ready"},"finish_reason":"stop"}]}', { headers: { 'content-type': 'application/json' } });
    } });
  const url = 'https://capacity-neutral.invalid', input = { body: '{"model":"capacity"}' };
  const first = await transport.fetch(url, input); await first.text(); await transport.flush();
  assert.equal(transport.failure().code, 'PROVIDER_CAPACITY');
  assert.equal(transport.failure().retryAfterMs, 10);
  assert.equal(calls, 1, 'the transport does not secretly retry a capacity response');
  const cancelled = transport.fetch(url, { ...input, signal: controller.signal });
  await delay(30);
  assert.equal(liveRequestSlots(), 0);
  controller.abort(new Error('neutral capacity wait cancelled'));
  await assert.rejects(cancelled, error => error.message === 'neutral capacity wait cancelled' || error.cause?.message === 'neutral capacity wait cancelled');
  await transport.flush();
  assert.equal(calls, 1);
  const started = Date.now(), second = await transport.fetch(url, input);
  assert.match(await second.text(), /ready/); await transport.flush();
  assert.ok(Date.now() - started >= 300, 'cooldown exceeds both response timers without timing out an unsent request');
  assert.equal(calls, 2);
  assert.ok(notices.some(notice => notice.phase === 'waiting-provider' && notice.retryAfterMs > 0 && notice.until > Date.now() - 1000));
  assert.equal(notices.at(-1).phase, 'requesting');
  assert.equal(liveRequestSlots(), 0);
});

test('a recollection lane does not consume a second global HTTP slot at concurrency one', async t => {
  configureRequestSlots(1);
  t.after(() => configureRequestSlots(Infinity));
  const releaseLane = await acquireRequestSlot({ key: 'gallery-connection', limit: 1, laneOnly: true });
  t.after(releaseLane);
  const transport = createTechnicalTransport({ signal: AbortSignal.timeout(2000), fetchImpl: async () => {
    assert.equal(liveRequestSlots(), 1);
    return new Response('{"choices":[{"message":{"content":"done"},"finish_reason":"stop"}]}',
      { headers: { 'content-type': 'application/json' } });
  } });
  const response = await transport.fetch('https://neutral.invalid', { body: '{}' });
  await response.text();
  await transport.flush();
  assert.equal(liveRequestSlots(), 0);
});

test('technical model transport captures compact multi-step evidence and exact final text without credentials', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-technical-request-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }));
  let calls = 0;
  const transport = createTechnicalTransport({ directory, secrets: ['private-fixture-secret'], fetchImpl: async () => {
    calls++;
    return new Response(calls === 1 ? 'data: {"choices":[{"delta":{"reasoning_content":"inspect ","content":"done"},"finish_reason":"length"}]}\n\ndata: [DONE]\n' : JSON.stringify({ choices: [{ message: { content: 'accepted' }, finish_reason: 'stop' }] }), { headers: { 'content-type': calls === 1 ? 'text/event-stream' : 'application/json' } });
  } });
  const body = { model: 'neutral', messages: [{ role: 'user', content: 'private-fixture-secret neutral material' }] };
  const first = await transport.fetch('https://neutral.invalid/api?api_key=private-fixture-secret', { body: JSON.stringify(body) });
  await first.text();
  const second = await transport.fetch('https://neutral.invalid/api', { body: JSON.stringify({ ...body, messages: [...body.messages, { role: 'tool', content: 'real tool result' }] }) });
  await second.text();
  const records = await transport.flush();
  assert.equal(records.length, 2);
  assert.equal(records[0].reasoningCharacters, 8); assert.equal(records[0].textCharacters, 4);
  assert.equal(records[1].textCharacters, 8);
  const input = JSON.stringify(await readRequestArtifact(records[0]));
  assert.match(input, /REDACTED/); assert.equal(input.includes('private-fixture-secret'), false);
  assert.equal(records[0].files.includes('transport-1.txt'), false);
  assert.equal(records[0].files.includes('reasoning.txt'), false);
  assert.equal(await readFile(path.join(records[0].directory, 'final.txt'), 'utf8'), 'done');
  const result = JSON.parse(await readFile(path.join(records[0].directory, 'result.json'), 'utf8'));
  assert.equal(result.summary.finishReason, 'length');
});

test('compact technical evidence keeps split streamed tool calls once, including original arguments and IDs', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-technical-tool-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }));
  const calls = [
    [{ index: 0, id: 'call_original_1', type: 'function', function: { name: 'write_', arguments: '{"code":"' } }],
    [{ index: 1, id: 'call_original_2', type: 'function', function: { name: 'list_files', arguments: '{"path":"data"}' } },
      { index: 0, function: { name: 'adapter', arguments: 'return 你好;","secret":"private-tool-key"}' } }],
  ];
  const stream = calls.map(tool_calls => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls } }] })}\n\n`).join('')
    + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":9,"total_tokens":21}}\n\ndata: [DONE]\n\n';
  const transport = createTechnicalTransport({ directory, secrets: ['private-tool-key'], fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) });
  await (await transport.fetch('https://neutral.invalid', { body: '{"stream":true}' })).text();
  const [reference] = await transport.flush();
  assert.equal(reference.toolCalls, 2);
  assert.equal(reference.finalBodyCaptured, false);
  const stored = JSON.parse(await readFile(path.join(reference.directory, 'tool-calls.json'), 'utf8'));
  assert.equal(stored[0].id, 'call_original_1');
  assert.equal(stored[0].function.name, 'write_adapter');
  assert.equal(stored[0].function.arguments, '{"code":"return 你好;","secret":"[REDACTED]"}');
  assert.equal(stored[1].id, 'call_original_2');
  assert.equal(stored[1].function.arguments, '{"path":"data"}');
  const result = JSON.parse(await readFile(path.join(reference.directory, 'result.json'), 'utf8'));
  assert.equal(result.summary.usage.totalTokens, 21);
  assert.equal(result.summary.finishReason, 'tool_calls');
  assert.equal(result.toolCalls, 2);
  assert.equal(JSON.stringify(result).includes('return 你好'), false);
  assert.equal(reference.files.includes('transport-1.txt'), false);
});

test('different technical jobs share project evidence without changing any actual outgoing request bytes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-project-request-content-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }));
  const contentDirectory = path.join(root, 'request-content'), actual = [];
  const body = JSON.stringify({ model: 'neutral', max_tokens: 1024, tools: [{ type: 'function', function: { name: 'read_resource', parameters: { type: 'object' } } }],
    messages: [{ role: 'system', content: 'Shared exact instructions.' }, { role: 'user', content: 'Shared exact source.' }], stream: false });
  const refs = [];
  for (let index = 0; index < 2; index++) {
    const transport = createTechnicalTransport({ directory: path.join(root, `job-${index}`, 'requests'), contentDirectory,
      fetchImpl: async (_url, input) => { actual.push(input.body); return new Response('{"choices":[{"message":{"content":"ready"},"finish_reason":"stop"}]}', { headers: { 'content-type': 'application/json' } }); } });
    await (await transport.fetch('https://exact-content-neutral.invalid', { body })).text();
    refs.push(...await transport.flush());
  }
  assert.deepEqual(actual, [body, body]);
  assert.equal((await readdir(contentDirectory)).length, 3);
  for (const ref of refs) { assert.equal(ref.contentDirectory, contentDirectory); assert.equal(JSON.stringify((await readRequestArtifact(ref)).body), body); }
});

test('technical JSON tool-call response and explicit diagnostics retain their distinct evidence', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-technical-json-tools-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }));
  const response = { choices: [{ message: { content: 'Inspect first.', reasoning_content: 'Detailed thought.', tool_calls: [
    { id: 'call_json', type: 'function', function: { name: 'read_file', arguments: '{"path":"data/dialogue.json"}' } },
  ] }, finish_reason: 'tool_calls' }] };
  const transport = createTechnicalTransport({ directory, diagnostics: true, fetchImpl: async () => new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } }) });
  await (await transport.fetch('https://neutral.invalid', { body: '{}' })).text();
  const [reference] = await transport.flush();
  assert.equal(reference.diagnostics, true);
  assert.equal(reference.toolCalls, 1);
  assert.equal(await readFile(path.join(reference.directory, 'final.txt'), 'utf8'), 'Inspect first.');
  assert.equal(await readFile(path.join(reference.directory, 'reasoning.txt'), 'utf8'), 'Detailed thought.');
  assert.match(await readFile(path.join(reference.directory, 'transport-1.txt'), 'utf8'), /call_json/);
  const stored = JSON.parse(await readFile(path.join(reference.directory, 'tool-calls.json'), 'utf8'));
  assert.equal(stored[0].function.arguments, response.choices[0].message.tool_calls[0].function.arguments);
});

test('local artifact preparation and persistence do not spend the technical network idle budget', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-technical-timing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let fetchedAt;
  const startedAt = Date.now();
  const transport = createTechnicalTransport({ directory, requestTimeoutMs: 60, artifactFactory: async options => {
    await delay(100);
    const artifact = await createRequestArtifact(options);
    return { ...artifact, observe: async event => { await delay(100); return artifact.observe(event); } };
  }, fetchImpl: async () => {
    fetchedAt = Date.now(); await delay(10);
    return new Response('{"choices":[{"message":{"content":"ready"},"finish_reason":"stop"}]}', { headers: { 'content-type': 'application/json' } });
  } });
  const response = await transport.fetch('https://neutral.invalid', { body: '{}' });
  assert.match(await response.text(), /ready/);
  assert.ok(fetchedAt - startedAt >= 90, 'local preparation actually exceeded the idle budget');
  const [record] = await transport.flush();
  assert.ok(Math.abs(Date.parse(record.sentAt) - fetchedAt) < 30, 'send timestamp denotes fetch invocation, not queued evidence persistence');
  assert.ok(Date.parse(record.finishedAt) - Date.parse(record.bodyEndedAt) >= 70, 'evidence is fully flushed after body consumption');
  assert.ok(record.preparedAt <= record.sentAt && record.sentAt <= record.responseAt && record.responseAt <= record.firstBodyAt);
  assert.equal(record.textCharacters, 5);
});

function chunkedResponse(chunks, wait = 25, headers = { 'content-type': 'text/event-stream' }) {
  let index = 0;
  return new Response(new ReadableStream({
    async pull(controller) { await delay(wait); if (index < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[index++])); else controller.close(); },
  }), { headers });
}

const upstreamErrorStream = () => [
  { choices: [{ index: 0, delta: { role: 'assistant', reasoning: 'Neutral inspection reasoning.' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { role: 'assistant', content: '', reasoning: '' }, finish_reason: 'error' }] },
  { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'error' }],
    usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112, cost: 0, completion_tokens_details: { reasoning_tokens: 12 } } },
].map(part => `data: ${JSON.stringify(part)}\n\n`).join('') + 'data: [DONE]\n\n';

test('an upstream error finish retains final usage and is not reported as successful transport or reasoning-only output', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-upstream-finish-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }));
  const transport = createTechnicalTransport({ directory, fetchImpl: async () => new Response(upstreamErrorStream(), { headers: { 'content-type': 'text/event-stream' } }) });
  const response = await transport.fetch('https://neutral.invalid', { body: '{"stream":true}' });
  await assert.rejects(response.text(), error => error.code === 'MODEL_UPSTREAM_ERROR' && error.finishReason === 'error');
  const [record] = await transport.flush();
  assert.equal(transport.failure().code, 'MODEL_UPSTREAM_ERROR');
  const result = JSON.parse(await readFile(path.join(record.directory, 'result.json'), 'utf8'));
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'MODEL_UPSTREAM_ERROR');
  assert.equal(result.summary.usage.totalTokens, 112);
  assert.equal(result.summary.finishReason, 'error');
  assert.equal(record.files.includes('transport-1.txt'), false);
});

test('the actual technical SDK preserves an error finish diagnosis even when its only generated tokens were reasoning', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-upstream-sdk-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }));
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the neutral local request without storing it. */ }
    requests++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(upstreamErrorStream());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runAdaptation({ project: { id: 'neutral-upstream-error', engine: 'Unity' }, inventory: {}, gameDir: directory,
      workspaceDir: path.join(directory, 'work'), statePath: path.join(directory, 'progress.jsonl'),
      lab: { tryRecipes: async () => null, listTools: async () => [] },
      connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'neutral' } });
    assert.equal(requests, 1, 'diagnosis does not introduce another model request');
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'MODEL_UPSTREAM_ERROR');
    assert.doesNotMatch(result.error.message, /仅返回推理/);
    assert.equal(result.state.requestArtifacts.length, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('slow technical response progress refreshes idle timeout while the total request deadline stays finite', async () => {
  const chunks = Array.from({ length: 8 }, () => 'data: {"choices":[{"delta":{"reasoning_content":"inspect "}}]}\n\n');
  chunks.push('data: {"choices":[{"delta":{"content":"ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  const transport = createTechnicalTransport({ requestTimeoutMs: 100, requestTotalTimeoutMs: 1000, fetchImpl: async () => chunkedResponse(chunks) });
  const response = await transport.fetch('https://neutral.invalid', { body: '{"stream":true}' });
  assert.match(await response.text(), /ready/);
  assert.equal(transport.failure(), undefined);
  await transport.flush();
  const bounded = createTechnicalTransport({ requestTimeoutMs: 100, requestTotalTimeoutMs: 140, fetchImpl: async () => chunkedResponse(chunks) });
  const unfinished = await bounded.fetch('https://neutral.invalid', { body: '{"stream":true}' });
  await assert.rejects(unfinished.text(), error => error.code === 'TECHNICAL_REQUEST_TIMEOUT' && error.phase === 'total');
  await bounded.flush();
});

test('header wait, stalled body and explicit cancellation terminate even when a fetch implementation ignores abort', async () => {
  const beforeHeaders = createTechnicalTransport({ requestTimeoutMs: 35, fetchImpl: async () => { await delay(100); return new Response('late'); } });
  await assert.rejects(beforeHeaders.fetch('https://neutral.invalid'), error => error.code === 'TECHNICAL_REQUEST_TIMEOUT' && error.phase === 'headers');
  await beforeHeaders.flush();
  const bodyIdle = createTechnicalTransport({ requestTimeoutMs: 35, fetchImpl: async () => chunkedResponse(['late'], 100) });
  const stalled = await bodyIdle.fetch('https://neutral.invalid');
  await assert.rejects(stalled.text(), error => error.code === 'TECHNICAL_REQUEST_TIMEOUT' && error.phase === 'body-idle');
  await bodyIdle.flush();
  const controller = new AbortController();
  const cancelled = createTechnicalTransport({ signal: controller.signal, fetchImpl: async () => chunkedResponse(['late'], 100) });
  const pending = await cancelled.fetch('https://neutral.invalid');
  const reason = new Error('neutral pause'); controller.abort(reason);
  await assert.rejects(pending.text(), error => error === reason);
  await cancelled.flush();
});

test('technical streaming compatibility reuses successful JSON and retries only an explicit unsupported-stream rejection', async () => {
  const completion = { choices: [{ index: 0, message: { content: 'ready' }, finish_reason: 'stop' }] };
  const requests = [];
  const json = createTechnicalTransport({ fetchImpl: async (_url, input) => { requests.push(JSON.parse(input.body)); return new Response(JSON.stringify(completion), { headers: { 'content-type': 'application/json', 'content-length': '1' } }); } });
  const response = await json.fetch('https://neutral.invalid', { body: '{"stream":true}' });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(response.headers.get('content-length'), null);
  assert.match(await response.text(), /"delta":\{"content":"ready"\}/);
  assert.equal(requests.length, 1);
  const fallbacks = [];
  const unsupported = createTechnicalTransport({ fetchImpl: async (_url, input) => {
    const body = JSON.parse(input.body); fallbacks.push(body);
    return body.stream ? new Response('{"error":{"message":"Streaming is not supported"}}', { status: 422 }) : new Response(JSON.stringify(completion), { headers: { 'content-type': 'application/json' } });
  } });
  assert.match(await (await unsupported.fetch('https://neutral.invalid', { body: '{"stream":true,"stream_options":{"include_usage":true}}' })).text(), /ready/);
  // Exactly one compatibility downgrade, never a retry loop. The repeated material is not a
  // specification: the streaming attempt was rejected before it produced any output, so nothing
  // already billed may be re-requested as an independent generation.
  assert.equal(fallbacks.length, 2, 'one downgrade, not an unbounded retry loop');
  assert.equal(fallbacks[0].stream, true);
  assert.equal(fallbacks[1].stream, false); assert.equal(fallbacks[1].stream_options, undefined);
  let failedCalls = 0;
  const disconnected = createTechnicalTransport({ fetchImpl: async () => { failedCalls++; throw new Error('other side closed'); } });
  await assert.rejects(disconnected.fetch('https://neutral.invalid', { body: '{"stream":true}' }), /other side closed/);
  assert.equal(failedCalls, 1);
  let badCalls = 0;
  const invalid = createTechnicalTransport({ fetchImpl: async () => { badCalls++; return new Response('{"error":{"message":"Invalid tool schema"}}', { status: 400 }); } });
  assert.equal((await invalid.fetch('https://neutral.invalid', { body: '{"stream":true}' })).status, 400);
  assert.equal(badCalls, 1);
});
