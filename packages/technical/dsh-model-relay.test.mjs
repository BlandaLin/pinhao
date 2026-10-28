import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDshModelRelay } from './dsh-model-relay.mjs';
import { createAdaptationBudget } from '../core/adaptation-budget.mjs';

const model = 'pinhao-fixture', connection = { baseUrl: 'https://relay-fixture.invalid/v1', model, apiKey: 'neutral-test-credential' };
function owner(maxHttpAttempts = 2) {
  let project = { id: 'project' };
  const budget = createAdaptationBudget({ readProject: () => project, patchProject: (_id, patch) => { project = { ...project, ...patch }; }, transaction: (_id, action) => action() });
  const owner = budget.forRequest('project', 'request', { limits: { maxHttpAttempts, maxWindows: 1 }, historyCoverage: 'complete' });
  owner.openWindow({ windowId: 'window' });
  return { owner, windowId: 'window', jobId: 'job', purpose: 'adaptation' };
}
const response = () => new Response(JSON.stringify({ id: 'completion', model, choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.001 } }), { headers: { 'content-type': 'application/json' } });
const send = (relay, body = {}, token = relay.apiKey) => fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Investigate the source.' }], stream: false, ...body }) });

test('actual loopback route preserves completion and host budget without exposing provider credentials', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-dsh-relay-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 }));
  const context = owner(); let actual = 0, presented = 0;
  const relay = await createDshModelRelay({ connection, directory, requestContext: context,
    onModelPresented: ({ messages }) => { presented++; assert.equal(messages[0].content, 'Investigate the source.'); },
    fetchImpl: async (url, input) => { actual++; assert.equal(String(url), `${connection.baseUrl}/chat/completions`);
      assert.equal(input.headers.authorization, `Bearer ${connection.apiKey}`); assert.notEqual(input.headers.authorization, `Bearer ${relay.apiKey}`); return response(); } });
  t.after(() => relay.close());
  assert.equal((await (await send(relay)).json()).choices[0].message.content, 'done');
  const records = await relay.flush();
  assert.equal(actual, 1); assert.equal(presented, 1); assert.equal(context.owner.snapshot().knownCost, 0.001);
  assert.equal(context.owner.snapshot().httpSentKnown, 1);
  const stored = await readFile(path.join(records[0].directory, 'request.json'), 'utf8');
  assert.equal(stored.includes(connection.apiKey), false); assert.equal(stored.includes(relay.apiKey), false);
});

test('summary and SDK retries share the same cumulative owner and cannot send beyond cap', async t => {
  const context = owner(2); let actual = 0;
  const relay = await createDshModelRelay({ connection, requestContext: context, fetchImpl: async () => { actual++; return response(); } });
  t.after(() => relay.close());
  await (await send(relay)).text();
  await (await send(relay, { messages: [{ role: 'user', content: 'Summarize this session.' }] })).text();
  const denied = await send(relay); await denied.text();
  assert.equal(denied.status, 429); assert.equal(relay.failure().code, 'ADAPTATION_BUDGET_EXHAUSTED');
  await relay.flush(); assert.equal(actual, 2); assert.equal(context.owner.snapshot().httpUsed, 2);
});

test('wrong job token, alternate endpoint and different model never reach upstream', async t => {
  let actual = 0;
  const relay = await createDshModelRelay({ connection, requestContext: owner(), fetchImpl: async () => { actual++; return response(); } });
  t.after(() => relay.close());
  assert.equal((await send(relay, {}, 'wrong')).status, 401);
  assert.equal((await send(relay, { model: 'different' })).status, 400);
  assert.equal((await fetch(`${relay.baseUrl}/responses`, { headers: { authorization: `Bearer ${relay.apiKey}` } })).status, 404);
  assert.equal(actual, 0);
});

test('JSON completion for stream request uses actual paid response instead of another fetch', async t => {
  const context = owner(1); let actual = 0;
  const relay = await createDshModelRelay({ connection, requestContext: context, fetchImpl: async (_url, input) => {
    actual++; assert.equal(JSON.parse(input.body).stream_options.include_usage, true); return response(); } });
  t.after(() => relay.close());
  const result = await send(relay, { stream: true });
  assert.match(result.headers.get('content-type'), /text\/event-stream/);
  assert.match(await result.text(), /\[DONE\]/);
  await relay.flush(); assert.equal(actual, 1); assert.equal(context.owner.snapshot().knownCost, 0.001);
});

test('permanent connection rejection stops the owner runtime instead of buying empty continuations', async t => {
  const context = owner(4); let actual = 0, failure;
  const relay = await createDshModelRelay({ connection, requestContext: context, onFailure: error => { failure = error; },
    fetchImpl: async () => { actual++; return new Response('{"error":{"message":"Unauthorized"}}', { status: 401 }); } });
  t.after(() => relay.close());
  const result = await send(relay); assert.equal(result.status, 401); await result.text();
  await relay.flush();
  assert.equal(actual, 1); assert.equal(failure.code, 'TECHNICAL_CONFIGURATION_ERROR');
  assert.equal(relay.failure().statusCode, 401); assert.equal(context.owner.snapshot().httpUsed, 1);
});

test('a semantic context overflow stays available to SDK compaction while a real configuration error still stops', async t => {
  for (const status of [400, 413, 422]) {
    let failure;
    const relay = await createDshModelRelay({ connection, requestContext: owner(2), onFailure: error => { failure = error; },
      fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'Maximum context length exceeded' } }), { status }) });
    try {
      assert.equal((await send(relay)).status, status);
      await relay.flush();
      assert.equal(failure, undefined); assert.equal(relay.failure(), undefined);
      assert.equal(relay.requests()[0].recovery, 'sdk-context-compaction');
    } finally { await relay.close(); }
  }
  let failure;
  const relay = await createDshModelRelay({ connection, requestContext: owner(), onFailure: error => { failure = error; },
    fetchImpl: async () => new Response('{"error":{"message":"Unsupported model name"}}', { status: 400 }) });
  t.after(() => relay.close());
  await (await send(relay)).text(); await relay.flush();
  assert.equal(failure.code, 'TECHNICAL_CONFIGURATION_ERROR');
});

test('a pre-dispatch external cost gate does not credit queued tool results as model-visible', async t => {
  let presented = 0;
  const relay = await createDshModelRelay({ connection, requestContext: owner(), onModelPresented: () => { presented++; },
    fetchImpl: async () => { throw Object.assign(new Error('External dollar exposure reached'), { code: 'ADAPTATION_BUDGET_EXHAUSTED' }); } });
  t.after(() => relay.close());
  const denied = await send(relay); await denied.text();
  assert.equal(denied.status, 429); assert.equal(presented, 0);
});

test('concurrent identical prompts keep their own admitted request identity', async t => {
  const seen = [], context = owner(2);
  const relay = await createDshModelRelay({ connection, requestContext: context,
    onModelPresented: event => { seen.push(event.modelRequestId); }, fetchImpl: async () => response() });
  t.after(() => relay.close());
  await Promise.all([send(relay).then(result => result.text()), send(relay).then(result => result.text())]);
  await relay.flush(); assert.equal(seen.length, 2); assert.equal(new Set(seen).size, 2);
});
