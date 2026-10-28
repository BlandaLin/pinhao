import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createDshModelRelay } from './dsh-model-relay.mjs';
import { createAdaptationBudget } from '../core/adaptation-budget.mjs';

const model = 'pinhao-independent-relay-check';
const clock = () => new Date().toISOString();
async function upstream(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/v1`;
}
function context(maxHttpAttempts = 2, id = 'job') {
  let project = { id: `project-${id}` };
  const budget = createAdaptationBudget({ readProject: () => project, patchProject: (_id, patch) => { project = { ...project, ...patch }; }, transaction: (_id, action) => action() });
  const owner = budget.forRequest(project.id, 'request', { limits: { maxHttpAttempts, maxWindows: 1 }, historyCoverage: 'complete' });
  owner.openWindow({ windowId: 'window' });
  return { owner, windowId: 'window', jobId: id, purpose: 'adaptation' };
}
async function relayFor(t, baseUrl, options = {}) {
  const requestContext = options.requestContext ?? context();
  const relay = await createDshModelRelay({ connection: { baseUrl, model, apiKey: 'neutral-upstream-only-key' }, requestContext, ...options });
  t.after(() => relay.close());
  return { relay, requestContext };
}
function request(relay, { signal, messages, ...extra } = {}) {
  return fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', signal,
    headers: { authorization: `Bearer ${relay.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: messages ?? [{ role: 'user', content: 'A complete fixture task.' }], stream: true, ...extra }) });
}
function sse(output, { content = 'done', usage = true } = {}) {
  output.writeHead(200, { 'content-type': 'text/event-stream' });
  output.write(`data: ${JSON.stringify({ id: 'fixture', model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
  output.end(`data: ${JSON.stringify({ id: 'fixture', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...(usage ? { usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13, cost: 0.002 } } : {}) })}\n\ndata: [DONE]\n\n`);
}

test('independent: cancelling one real streamed request stops upstream, preserves charge and sibling job', async t => {
  let cancelled = false, begun;
  const started = new Promise(resolve => { begun = resolve; });
  const baseUrl = await upstream(t, async (input, output) => {
    const chunks = []; for await (const part of input) chunks.push(part);
    const body = JSON.parse(Buffer.concat(chunks));
    if (body.messages[0].content === 'sibling') return sse(output);
    output.on('close', () => { cancelled = true; });
    output.writeHead(200, { 'content-type': 'text/event-stream' });
    output.write(`data: ${JSON.stringify({ id: 'slow', choices: [{ delta: { content: 'partial' }, finish_reason: null }] })}\n\n`);
    begun();
  });
  const one = await relayFor(t, baseUrl, { requestContext: context(2, 'one') });
  const two = await relayFor(t, baseUrl, { requestContext: context(2, 'two') });
  const abort = new AbortController();
  const response = await request(one.relay, { signal: abort.signal });
  await started;
  const reader = response.body.getReader();
  await reader.read();
  abort.abort(new Error('fixture cancellation'));
  await assert.rejects(reader.read());
  for (let i = 0; i < 100 && !cancelled; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cancelled, true, 'upstream stream must close');
  await one.relay.flush();
  assert.equal(one.requestContext.owner.snapshot().httpSentKnown, 1);
  assert.equal(one.requestContext.owner.snapshot().unknownCostAttempts, 1);
  const sibling = await request(two.relay, { messages: [{ role: 'user', content: 'sibling' }] });
  assert.match(await sibling.text(), /\[DONE\]/);
  await two.relay.flush();
  assert.equal(two.requestContext.owner.snapshot().knownCost, 0.002);
});

test('independent: timeout before actual headers remains typed and uses one budget reservation', async t => {
  let sends = 0;
  const baseUrl = await upstream(t, async input => { for await (const _ of input) { /* drain */ } sends++; });
  const { relay, requestContext } = await relayFor(t, baseUrl, { requestTimeoutMs: 80, requestTotalTimeoutMs: 200 });
  const output = await request(relay);
  assert.equal(output.status, 502);
  assert.equal((await output.json()).error.code, 'TECHNICAL_REQUEST_TIMEOUT');
  await relay.flush();
  assert.equal(relay.failure().code, 'TECHNICAL_REQUEST_TIMEOUT');
  assert.equal(sends, 1);
  assert.equal(requestContext.owner.snapshot().httpSentKnown, 1);
  assert.equal(requestContext.owner.snapshot().unknownCostAttempts, 1);
});

test('independent: actual SDK-style summary and retry sends cannot escape shared cap', async t => {
  const bodies = [];
  const baseUrl = await upstream(t, async (input, output) => {
    const chunks = []; for await (const part of input) chunks.push(part);
    bodies.push(JSON.parse(Buffer.concat(chunks)));
    sse(output);
  });
  const { relay, requestContext } = await relayFor(t, baseUrl);
  await (await request(relay)).text();
  await (await request(relay, { messages: [{ role: 'user', content: 'Compact the complete conversation.' }], temperature: 0, max_tokens: 1200 })).text();
  const denied = await request(relay);
  assert.equal(denied.status, 429);
  assert.equal((await denied.json()).error.code, 'ADAPTATION_BUDGET_EXHAUSTED');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].max_tokens, 1200);
  assert.equal(bodies[1].temperature, 0);
  await relay.flush();
  assert.equal(requestContext.owner.snapshot().httpUsed, 2);
  assert.equal(requestContext.owner.snapshot().knownCost, 0.004);
  assert.equal(relay.requests().filter(row => row.responseAt).length, 2);
});

test('independent: close during active stream completes bounded and leaves endpoint closed', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const baseUrl = await upstream(t, async (input, output) => {
    for await (const _ of input) { /* drain */ }
    output.writeHead(200, { 'content-type': 'text/event-stream' });
    output.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    started();
  });
  const { relay } = await relayFor(t, baseUrl);
  const response = await request(relay); const body = response.text().catch(error => error);
  await ready;
  const start = Date.now(); await relay.close();
  assert.ok(Date.now() - start < 1000);
  await body;
  await assert.rejects(request(relay));
});
