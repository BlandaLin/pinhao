import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { createService, defaultSettings } from './service.mjs';
import { sdkProvider } from './provider.mjs';
import { createStore } from './workspace-store.mjs';
import { providerCapacityFailure } from './request-recovery.mjs';
import { sha256 } from '../exchange/index.mjs';

const parent = path.resolve('local/core-tests');
await mkdir(parent, { recursive: true });
const defer = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function until(read, message, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(10);
  }
  assert.fail(message);
}
const scenes = count => Array.from({ length: count * 16 }, (_, index) => {
  const scene = ['alpha', 'beta', 'gamma', 'delta'][Math.floor(index / 16)];
  return { id: `${scene}:${index}`, kind: 'dialogue', source: `Neutral ${scene} line ${String(index).padStart(3, '0')}. A complete neutral sentence accompanies this line without extra state.`, tokens: [],
    context: { file: `${scene}.json`, event: 1, page: 0 } };
});
const recordsFor = payload => payload.units.map(unit => ({ id: unit.id, translation: `中性译文 ${unit.source}`, notes: '' }));
const reviewFor = payload => ({ review: { protocol: 'pinhao-review-1', reviewedIds: payload.units.map(unit => unit.id), edits: [], issues: [] } });
const stageFor = args => args.role === 'proofreading' ? args.wire.payload.reviewScope?.stage : 'translation';
const sceneFor = payload => ['alpha', 'beta', 'gamma', 'delta'].find(scene => payload.units[0].source.includes(` ${scene} `));
const transientErrors = {
  socket: () => Object.assign(new Error('Cannot connect to API: other side closed'), { code: 'UND_ERR_SOCKET' }),
  timeout: () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' }),
  rateLimit: () => Object.assign(new Error('Temporary rate limit'), { statusCode: 429, responseHeaders: { 'retry-after': '0.01' } }),
  unavailable: () => Object.assign(new Error('Temporary upstream unavailability'), { statusCode: 503, responseHeaders: { 'retry-after': '0.01' } }),
  capacity: () => providerCapacityFailure({ statusCode: 402,
    body: { error: { metadata: { reason: 'in_flight_budget_exhausted', headers: { 'Retry-After': '0.01' } } } } }),
};

async function fixture(t, { phase, provider, count = 3, sampleReady = true, failNative = false, baseUrl = 'http://localhost:1/v1' } = {}) {
  const root = await mkdtemp(path.join(parent, 'transient-pause-'));
  const dataDir = path.join(root, 'data'), gameDir = path.join(root, 'original'), cleanups = [];
  const units = scenes(count);
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'original.txt'), 'Immutable neutral original.');
  const service = await createService({ dataDir, provider, scriptTools: null,
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral verified native route', selectedCandidateIds: [] }),
    worker: async (command, input) => {
      if (command === 'probe') return { engine: 'MV' };
      if (command === 'extract') { await mkdir(input.workspaceDir, { recursive: true }); return { units, workspaceDir: input.workspaceDir, sourceFingerprint: sha256(units) }; }
      if (['roundtrip', 'validate'].includes(command)) return { ok: true };
      if (command === 'build') {
        if (failNative) throw Object.assign(new Error('Neutral native write validation failed'), { code: 'NATIVE_WRITE_FAILED' });
        await mkdir(input.outputDir, { recursive: true }); return { buildDir: input.outputDir };
      }
      if (command === 'assemble') {
        await mkdir(input.outputDir, { recursive: true });
        const launchPath = path.join(input.outputDir, 'Game.exe'); await writeFile(launchPath, 'Neutral executable fixture.');
        return { outputDir: input.outputDir, launchPath };
      }
      throw new Error(`Unsupported neutral worker command ${command}`);
    } });
  t.after(async () => {
    for (const release of cleanups) release();
    await service.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 });
  });
  await service.saveSettings({ ...defaultSettings(), concurrency: 3, proofreading: phase === 'proofreading', pauseOnLocalFailure: false,
    // These complete 94-character lines fill one scene per declared output window.
    connection: { baseUrl, model: 'neutral-transient-fixture', contextWindow: 32768, maxOutputTokens: 2112 } });
  const project = await service.createProject({ gameDir });
  if (sampleReady) {
    const store = createStore(dataDir);
    try { store.put('projects', { ...store.one('projects', project.id), sampleValidation: { nativeStructure: 'passed' } }); }
    finally { store.close(); }
  }
  if (phase === 'proofreading') {
    for (const unit of (await service.listText({ projectId: project.id, limit: 100 })).units) {
      await service.saveText({ projectId: project.id, unitId: unit.id, translation: `已有中性译文 ${unit.source}`, expectedRevision: unit.revision });
    }
  }
  return {
    service, projectId: project.id,
    start: () => service.startProject({ projectId: project.id, mode: phase }),
    detail: () => service.getProject({ projectId: project.id }),
    rows: async () => (await service.listText({ projectId: project.id, limit: 100 })).units,
    tasks: () => { const db = createStore(dataDir); try { return db.tasks(project.id); } finally { db.close(); } },
    cleanup: release => cleanups.push(release),
  };
}

test('a complete paid review retains its returned bill when local evidence validation rejects it', async t => {
  let rejected = false;
  const usage = { inputTokens: 123, outputTokens: 45, totalTokens: 168 };
  const rawUsage = { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168, cost: 0.0123 };
  const f = await fixture(t, { phase: 'proofreading', count: 1, provider: async args => {
    const result = reviewFor(args.wire.payload);
    if (!rejected && stageFor(args) === 'scene') {
      rejected = true;
      const id = args.wire.payload.units[0].id;
      result.review.edits = [{ id, translation: '新的中性译文', expectedRevision: args.wire.payload.units[0].revision }];
      result.review.issues = [{ unitId: id, kind: 'needs_evidence', message: 'Evidence is still missing', resolution: 'open' }];
    }
    return { ...result, usage, rawUsage, requestId: 'neutral-paid-local-rejection', finishReason: 'stop', transportRequests: 1 };
  } });
  await f.start();
  await until(async () => (await f.detail()).status === 'completed', 'Review did not complete after its one rejected response');
  const task = f.tasks().find(task => task.reviewStage === 'scene');
  const received = task.requestHistory.find(request => request.status === 'received');
  assert.ok(received, 'A complete transport retains its bill even when one local review item is rejected');
  assert.deepEqual(received.usage, usage);
  assert.deepEqual(received.rawUsage, rawUsage);
  assert.equal(received.transportRequests, 1);
  assert.deepEqual(task.requestHistory.map(request => request.requested), [16, 1], 'Fifteen valid receipts survive; only the rejected item is reviewed again');
  const artifact = JSON.parse(await readFile(path.join(received.artifact.directory, 'result.json'), 'utf8'));
  assert.equal(artifact.status, 'received');
  assert.deepEqual(artifact.summary.usage, { promptTokens: 123, completionTokens: 45, reasoningTokens: null, totalTokens: 168,
    cacheReadTokens: null, cacheWriteTokens: null, cost: 0.0123 });
  assert.equal(artifact.summary.transportRequests, 1);
});

for (const phase of ['translation', 'proofreading']) test(`${phase}: format repair does not consume the independent bounded network recovery allowance`, async t => {
  let calls = 0;
  const f = await fixture(t, { phase, count: 1, provider: async args => {
    const targetStage = phase === 'proofreading' ? 'scene' : 'translation';
    if (stageFor(args) === targetStage) {
      calls++;
      if (calls <= 2) throw Object.assign(new Error('Neutral malformed response'), { code: 'INVALID_RESPONSE', category: 'response_structure' });
      if (calls === 3) throw transientErrors.socket();
    }
    return phase === 'proofreading' ? reviewFor(args.wire.payload) : { records: recordsFor(args.wire.payload) };
  } });
  await f.start();
  const done = await until(async () => {
    const detail = await f.detail();
    assert.notEqual(detail.status, 'paused', detail.lastError);
    return detail.status === 'completed' && detail;
  }, 'Mixed format and network failures did not recover');
  assert.equal(calls, 4);
  assert.equal(phase === 'proofreading' ? done.proofread : done.translated, 16);
  assert.equal(done.skipped, 0);
});

for (const phase of ['translation', 'proofreading']) for (const [kind, errorFor] of Object.entries(transientErrors)) {
  test(`${phase}: one temporary ${kind} failure retries locally without aborting either in-flight sibling`, async t => {
    const entered = defer(), calls = [];
    const first = new Set();
    let initial = 0, siblingReturned = 0;
    const targetStage = phase === 'proofreading' ? 'scene' : 'translation';
    const f = await fixture(t, { phase, provider: async args => {
      const payload = args.wire.payload, stage = stageFor(args), scene = sceneFor(payload);
      const call = { stage, scene, ids: payload.units.map(unit => unit.id), aborted: false };
      calls.push(call);
      args.signal.addEventListener('abort', () => { call.aborted = true; }, { once: true });
      await args.onTransport?.({ type: 'send' });
      if (stage === targetStage && !first.has(scene)) {
        first.add(scene);
        if (++initial === 3) entered.resolve();
        await entered.promise;
        if (scene === 'alpha') throw errorFor();
        await delay(80, undefined, { signal: args.signal });
        siblingReturned++;
      }
      return phase === 'proofreading' ? reviewFor(payload) : { records: recordsFor(payload), finishReason: 'stop' };
    } });
    f.cleanup(entered.resolve);
    await f.start();
    const done = await until(async () => {
      const detail = await f.detail();
      if (detail.status === 'paused') assert.fail(`A recoverable ${kind} paused the entire ${phase} project: ${detail.lastError}`);
      return detail.status === 'completed' && detail;
    }, `The ${phase} recovery did not finish`);
    const targeted = calls.filter(call => call.stage === targetStage);
    assert.equal(initial, 3, 'All three independent lanes must actually enter the provider');
    assert.equal(siblingReturned, 2, 'Both already-sent siblings return successfully');
    assert.equal(targeted.filter(call => call.scene === 'alpha').length, 2, 'Only the failed lane needs a second call');
    assert.equal(targeted.filter(call => call.scene === 'beta').length, 1);
    assert.equal(targeted.filter(call => call.scene === 'gamma').length, 1);
    assert.ok(targeted.every(call => !call.aborted), 'Temporary recovery must not abort sent requests');
    assert.equal(done.skipped, 0);
    assert.equal(phase === 'proofreading' ? done.proofread : done.translated, 48);
    assert.equal(f.tasks().flatMap(task => task.requestHistory ?? []).filter(request => request.status === 'cancelled').length, 0);
  });
}

for (const phase of ['translation', 'proofreading']) {
  test(`${phase}: exhausted temporary failure drains siblings, stops new dispatch and resumes without rebuying saved text`, async t => {
    const entered = defer(), releaseSiblings = defer(), calls = [];
    let initial = 0, alphaAttempts = 0, recovered = false, checkpointId;
    const targetStage = phase === 'proofreading' ? 'scene' : 'translation';
    const first = new Set();
    const f = await fixture(t, { phase, count: 4, provider: async args => {
      const payload = args.wire.payload, stage = stageFor(args), scene = sceneFor(payload);
      const call = { stage, scene, ids: payload.units.map(unit => unit.id), aborted: false };
      calls.push(call); args.signal.addEventListener('abort', () => { call.aborted = true; }, { once: true });
      await args.onTransport?.({ type: 'send' });
      if (stage === targetStage && !recovered) {
        if (!first.has(scene)) { first.add(scene); if (++initial === 3) entered.resolve(); }
        await entered.promise;
        if (scene === 'alpha') {
          alphaAttempts++;
          if (phase === 'translation' && alphaAttempts === 1) {
            checkpointId = payload.units[0].id;
            await args.onRecords?.([recordsFor(payload)[0]]);
          }
          throw transientErrors.socket();
        }
        if (scene !== 'delta') { await releaseSiblings.promise; args.signal.throwIfAborted(); }
      }
      return phase === 'proofreading' ? reviewFor(payload) : { records: recordsFor(payload), finishReason: 'stop' };
    } });
    f.cleanup(entered.resolve); f.cleanup(releaseSiblings.resolve);
    await f.start();
    await until(() => alphaAttempts === 3, 'Temporary failure did not reach its finite three-attempt limit');
    await delay(50);
    assert.equal((await f.detail()).status, 'running', 'The project waits for sent siblings instead of cancelling them');
    assert.equal(calls.filter(call => call.stage === targetStage && call.scene === 'delta').length, 0,
      'After exhaustion the spare lane must not buy new queued work');
    assert.ok(calls.filter(call => call.stage === targetStage && ['beta', 'gamma'].includes(call.scene)).every(call => !call.aborted));
    releaseSiblings.resolve();
    const paused = await until(async () => { const detail = await f.detail(); return detail.status === 'paused' && detail; }, 'The exhausted run did not settle after draining');
    assert.equal(paused.builds.length, 0, 'An unresolved transport failure cannot become a completed product');
    assert.equal(alphaAttempts, 3, 'The execution window cannot buy an unbounded number of retries');
    assert.equal(paused.skipped, 0, 'Transport failures are not translated or skipped text');
    const saved = f.tasks().filter(task => task.role === phase);
    if (phase === 'proofreading') {
      assert.equal(paused.proofread, 0, 'D2 still keeps successful scene pages provisional');
      assert.equal(saved.filter(task => task.reviewStage === 'scene' && task.status === 'succeeded')
        .reduce((sum, task) => sum + (task.candidateRecords?.length ?? 0), 0), 32);
    } else {
      const current = await f.rows();
      assert.equal(current.filter(unit => / (beta|gamma) /.test(unit.source) && unit.status === 'translated').length, 32);
      assert.ok(current.some(unit => unit.id === checkpointId && unit.status === 'translated') ||
        saved.some(task => task.candidateRecords?.some(record => record.id === checkpointId)),
      'The validated partial reply is retained either as accepted text or a saved candidate');
    }
    recovered = true;
    await f.start();
    const done = await until(async () => {
      const detail = await f.detail();
      if (detail.status === 'paused') assert.fail(detail.lastError);
      return detail.status === 'completed' && detail;
    }, 'The drained project did not resume');
    const targeted = calls.filter(call => call.stage === targetStage);
    assert.equal(targeted.filter(call => call.scene === 'beta').length, 1, 'A saved sibling must not be bought again');
    assert.equal(targeted.filter(call => call.scene === 'gamma').length, 1, 'A saved sibling must not be bought again');
    if (checkpointId) assert.equal(targeted.flatMap(call => call.ids).filter(id => id === checkpointId).length, 1,
      'A validated streamed translation checkpoint survives transport recovery');
    assert.equal(phase === 'proofreading' ? done.proofread : done.translated, 64);
    assert.equal(done.skipped, 0);
  });
}

for (const phase of ['translation', 'proofreading']) for (const statusCode of [401, 402, 403]) {
  test(`${phase}: permanent provider status ${statusCode} still pauses instead of automatically rebuying requests`, async t => {
    let failingCalls = 0;
    const f = await fixture(t, { phase, count: 1, provider: async args => {
      await args.onTransport?.({ type: 'send' }); failingCalls++;
      throw Object.assign(new Error(statusCode === 402 ? 'Insufficient provider credit' : 'Provider authentication rejected'), { statusCode });
    } });
    await f.start();
    const paused = await until(async () => { const detail = await f.detail(); return detail.status === 'paused' && detail; }, 'A permanent provider failure did not stop');
    assert.equal(failingCalls, 1);
    assert.equal(paused.builds.length, 0);
    assert.equal(paused.skipped, 0);
  });
}

for (const phase of ['translation', 'proofreading']) {
  test(`${phase}: user pause interrupts a long provider cooldown without a new transport call`, async t => {
    let calls = 0;
    const f = await fixture(t, { phase, count: 1, provider: async args => {
      await args.onTransport?.({ type: 'send' }); calls++;
      throw Object.assign(new Error('Temporary provider throttle'), { statusCode: 429, retryAfterMs: 30000 });
    } });
    await f.start();
    await until(() => f.tasks().some(task => task.requestHistory?.some(request => request.status === 'failed')), 'The first throttle was not recorded');
    const started = Date.now();
    await f.service.pauseProject({ projectId: f.projectId });
    await until(() => f.tasks().every(task => task.status !== 'running'), 'The cooldown did not respond to user pause', 1500);
    assert.ok(Date.now() - started < 1500, 'A user pause must not wait for the Retry-After deadline');
    await delay(60);
    assert.equal(calls, 1, 'No queued retry is sent after user pause');
    assert.equal((await f.detail()).status, 'paused');
  });
}

test('native sample write failure retains the safety pause before a translated record is accepted', async t => {
  const f = await fixture(t, { phase: 'translation', count: 1, sampleReady: false, failNative: true,
    provider: async args => ({ records: recordsFor(args.wire.payload), finishReason: 'stop' }) });
  await f.start();
  const paused = await until(async () => { const detail = await f.detail(); return detail.status === 'paused' && detail; }, 'A failed native sample did not pause');
  assert.match(paused.stage, /回写|构建|磁盘/);
  assert.equal(paused.builds.length, 0);
  assert.equal((await f.rows()).filter(unit => unit.status === 'translated').length, 0,
    'Successful model output does not bypass native write validation');
});

for (const phase of ['translation', 'proofreading']) {
  test(`${phase}: actual SDK recovers a localhost socket destruction while other HTTP requests finish once`, async t => {
    const entered = defer(), prepared = new Map(), calls = [], first = new Set(), serverErrors = [];
    const targetStage = phase === 'proofreading' ? 'scene' : 'translation';
    let initial = 0, dropped = false;
    const server = createServer((request, response) => {
      void (async () => {
        let body = ''; for await (const chunk of request) body += chunk;
        const parsed = JSON.parse(body), content = parsed.messages.at(-1).content;
        const prompt = typeof content === 'string' ? content : content.map(part => part.text ?? '').join('');
        const args = prepared.get(prompt);
        assert.ok(args, 'The actual HTTP request must match a prepared product prompt');
        const payload = args.wire.payload, stage = stageFor(args), scene = sceneFor(payload);
        const call = { stage, scene, ids: payload.units.map(unit => unit.id), dropped: false, cancelled: false };
        calls.push(call);
        response.on('close', () => { if (!response.writableEnded && !call.dropped) call.cancelled = true; });
        if (stage === targetStage && !first.has(scene)) {
          first.add(scene); if (++initial === 3) entered.resolve();
          await entered.promise;
          if (scene === 'alpha' && !dropped) {
            dropped = call.dropped = true;
            request.socket.destroy();
            return;
          }
          await delay(100);
        }
        const refs = new Map(args.wire.state.entries.map(([ref, id]) => [id, ref]));
        const reply = phase === 'proofreading'
          ? { reviewed: payload.units.map(unit => refs.get(unit.id)), changes: [], questions: [] }
          : { text: payload.units.map(unit => [refs.get(unit.id), `中性译文 ${unit.source}`]) };
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ id: `local-transient-${calls.length}`, object: 'chat.completion', created: 1,
          model: parsed.model, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(reply) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
      })().catch(error => {
        serverErrors.push(error.message);
        if (!response.destroyed) { response.writeHead(500); response.end(JSON.stringify({ error: { message: 'Neutral HTTP fixture failed' } })); }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const f = await fixture(t, { phase, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, provider: args => {
      prepared.set(args.prompt, args);
      return sdkProvider(args);
    } });
    f.cleanup(entered.resolve);
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    await f.start();
    const done = await until(async () => {
      const detail = await f.detail();
      if (detail.status === 'paused') assert.fail(`The actual SDK socket failure paused the project: ${detail.lastError}`);
      return detail.status === 'completed' && detail;
    }, 'The actual HTTP socket recovery did not finish', 20000);
    assert.deepEqual(serverErrors, []);
    const main = calls.filter(call => call.stage === targetStage);
    assert.equal(initial, 3, 'Three separate HTTP requests reached localhost before disconnecting one');
    assert.equal(main.length, 4, 'The failed stage must make exactly four real HTTP requests');
    assert.equal(main.filter(call => call.scene === 'alpha').length, 2);
    assert.equal(main.filter(call => call.scene === 'beta').length, 1);
    assert.equal(main.filter(call => call.scene === 'gamma').length, 1);
    assert.equal(calls.filter(call => call.dropped).length, 1);
    assert.equal(calls.filter(call => call.cancelled).length, 0, 'No sibling HTTP response is cancelled');
    const history = f.tasks().flatMap(task => task.requestHistory ?? []);
    assert.equal(history.filter(request => request.status === 'cancelled').length, 0);
    assert.ok(history.some(request => request.status === 'failed' && ['UND_ERR_SOCKET', 'ECONNRESET'].includes(request.code)),
      'The real fetch/SDK failure must be recorded as a socket/connection failure');
    assert.equal(phase === 'proofreading' ? done.proofread : done.translated, 48);
    assert.equal(done.skipped, 0);
    assert.equal(calls.length, 4, 'A completed no-disagreement scene review needs no extra consistency HTTP requests');
    assert.ok(calls.every(call => call.stage === targetStage), 'Local final checks must not turn into a second full model review');
    t.diagnostic(JSON.stringify({ phase, mainStageHttpRequests: main.length, totalHttpRequests: calls.length,
      droppedSockets: 1, cancelledSiblingResponses: 0, formallySavedText: 48 }));
  });
}
