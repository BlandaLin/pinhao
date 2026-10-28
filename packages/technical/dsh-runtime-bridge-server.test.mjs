import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createDshRuntimeBridgeServer } from './dsh-runtime-bridge-server.mjs';
import { apply } from './dsh-tools-plugin/index.mjs';

const definitions = [{ name: 'inspect_units', description: 'Inspect local units',
  parameters: { type: 'object', properties: {} }, concurrencySafe: true }];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function bounded(promise, ms = 2000) {
  const controller = new AbortController();
  try {
    return await Promise.race([promise, delay(ms, undefined, { signal: controller.signal }).then(() => {
      throw new Error(`Local transport did not settle within ${ms}ms`);
    })]);
  } finally { controller.abort(); }
}

async function fixture(execute, sessionId = 'local-transport') {
  const controller = new AbortController();
  let operations = 0;
  const bridge = { binding: { sessionId }, definitions: () => definitions,
    session: { done: () => false }, allocateCall: async body => ({ ...body, operationId: `${sessionId}-${body.toolCallId}` }),
    async execute(envelope) { operations++; return execute(envelope, controller.signal); } };
  const server = await createDshRuntimeBridgeServer({ bridge, state: { backend: {} },
    signal: controller.signal, persist: async () => {}, heartbeatMs: 10 });
  return { ...server, controller, operations: () => operations,
    async dispose() { controller.abort(); await server.close(); } };
}

// Register the shipped plugin and invoke its actual tool, without a model or SDK substitute.
async function nativePlugin(server, sessionId = 'local-transport') {
  const tools = new Map(), handlers = new Map(), disposers = [], previous = {};
  for (const [name, value] of Object.entries({ PINHAO_DSH_TOOL_URL: server.url, PINHAO_DSH_TOOL_TOKEN: server.token,
    PINHAO_DSH_SESSION_ID: sessionId, PINHAO_DSH_MODEL: 'local-transport-only', PINHAO_DSH_MAX_TOKENS: '65536' })) {
    previous[name] = process.env[name]; process.env[name] = value;
  }
  try {
    await apply({ tools: { register: value => tools.set(value.name, value) },
      llm: { listProviders: () => [{ id: 'pinhao-relay' }], resolveCallConfig: async value => value },
      on(name, handler) { const set = handlers.get(name) ?? new Set(); set.add(handler); handlers.set(name, set); return () => set.delete(handler); },
      effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose); }, systemPrompt: { section() {} },
      provide() {}, loader: { entries: () => [] }, pluginPackages: {} });
  } finally {
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
  let seq = 1;
  return { invoke: (args, signal) => tools.get('inspect_units').execute(args, {
    callId: `call-${seq}`, rootCallId: null, agent: { id: sessionId, session: { seq: seq++ } }, signal }),
  dispose() { for (const fn of disposers.reverse()) fn(); } };
}

test('local execute sends headers and JSON whitespace before the single host operation completes', async () => {
  const started = deferred(), finish = deferred();
  const server = await fixture(async () => { started.resolve(); return finish.promise; });
  try {
    const response = await bounded(fetch(`${server.url}/execute`, { method: 'POST',
      headers: { authorization: `Bearer ${server.token}` }, body: '{}' }));
    assert.equal(response.status, 200);
    await bounded(started.promise);
    const reader = response.body.getReader(), chunks = [];
    const first = await bounded(reader.read());
    assert.equal(first.done, false);
    assert.match(Buffer.from(first.value).toString(), /^\s+$/);
    chunks.push(first.value);
    assert.equal(server.operations(), 1);
    finish.resolve({ passed: true, validationId: 'same-operation' });
    for (;;) { const row = await bounded(reader.read()); if (row.done) break; chunks.push(row.value); }
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { ok: true,
      result: { passed: true, validationId: 'same-operation' } });
    assert.equal(server.operations(), 1);
  } finally { finish.resolve({ cancelled: true }); await server.dispose(); }
});

test('native plugin distinguishes failed business validation from a late local transport error', async () => {
  const failure = { passed: false, error: { code: 'ADAPTER_VALIDATION_FAILED', message: 'Logic changed' } };
  const server = await fixture(async envelope => {
    await delay(30);
    if (envelope.arguments.lateError) throw Object.assign(new Error('Late host persistence failure'), { code: 'LOCAL_TRANSPORT_LATE' });
    return failure;
  });
  const plugin = await nativePlugin(server);
  try {
    assert.deepEqual(await plugin.invoke({}), failure);
    await assert.rejects(plugin.invoke({ lateError: true }), { code: 'LOCAL_TRANSPORT_LATE', message: 'Late host persistence failure' });
    assert.equal(server.operations(), 2);
  } finally { plugin.dispose(); await server.dispose(); }
});

test('invalid local requests never start a host operation or adopt the execute envelope', async () => {
  const server = await fixture(async () => ({ unexpected: true }));
  try {
    for (const [route, token, body, status, code] of [
      ['/execute', 'wrong-token', '{}', 401, 'DSH_BRIDGE_UNAUTHORIZED'],
      ['/execute', server.token, '{', 400, 'DSH_BRIDGE_ERROR'],
      ['/unknown', server.token, '{}', 400, 'DSH_BRIDGE_ROUTE'],
    ]) {
      const response = await fetch(`${server.url}${route}`, { method: 'POST',
        headers: { authorization: `Bearer ${token}` }, body });
      assert.equal(response.status, status);
      const result = await response.json();
      assert.equal(result.error.code, code);
      assert.equal(Object.hasOwn(result, 'ok'), false);
    }
    assert.equal(server.operations(), 0);
  } finally { await server.dispose(); }
});

test('native plugin rejects the old bare execute response instead of accepting a false transport success', async () => {
  const sockets = new Set();
  const server = createServer((input, output) => {
    input.resume(); input.once('end', () => {
      const value = input.url === '/definitions' ? definitions : input.url === '/status' ? { done: false } :
        input.url === '/allocate' ? { toolName: 'inspect_units' } : { passed: true };
      output.writeHead(200, { 'content-type': 'application/json' }); output.end(JSON.stringify(value));
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const plugin = await nativePlugin({ url: `http://127.0.0.1:${server.address().port}`, token: 'local-only' });
  try { await assert.rejects(plugin.invoke({}), /Host execute response failed/); }
  finally {
    plugin.dispose(); const closed = new Promise(resolve => server.close(resolve));
    for (const socket of sockets) socket.destroy(); await bounded(closed);
  }
});

test('job abort and transport close settle the active operation without cancelling a sibling', async () => {
  const started = deferred(); let active = 0;
  const server = await fixture(async (_envelope, signal) => {
    active++; started.resolve();
    try { await delay(30_000, undefined, { signal }); return { unexpected: true }; }
    finally { active--; }
  });
  const sibling = await fixture(async () => ({ sibling: true }), 'sibling');
  const plugin = await nativePlugin(server), other = await nativePlugin(sibling, 'sibling');
  try {
    const pending = plugin.invoke({}, server.controller.signal);
    const rejected = assert.rejects(pending);
    await bounded(started.promise);
    assert.equal(active, 1);
    server.controller.abort(new Error('Job cancelled'));
    await bounded(Promise.all([rejected, server.close()]));
    assert.equal(active, 0);
    assert.deepEqual(await other.invoke({}), { sibling: true });
    assert.equal(sibling.operations(), 1);
  } finally { plugin.dispose(); other.dispose(); await server.dispose(); await sibling.dispose(); }
});
