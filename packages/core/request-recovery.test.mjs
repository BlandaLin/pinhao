import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { sha256 } from '../exchange/index.mjs';
import { providerCapacityFailure, providerFailure } from './request-recovery.mjs';

const testRoot = path.resolve('local', 'core-tests');
await mkdir(testRoot, { recursive: true });

const secrets = {
  encrypt: value => `cipher:${Buffer.from(value).toString('base64')}`,
  decrypt: value => Buffer.from(value.slice(7), 'base64').toString(),
};
const defer = () => {
  let resolve;
  let settled = false;
  const promise = new Promise(done => { resolve = value => { settled = true; done(value); }; });
  return { promise, resolve, get settled() { return settled; } };
};
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function eventually(predicate, message, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await predicate();
    if (value) return value;
    await tick();
  }
  assert.fail(message);
}
const unit = (scene, index) => ({
  id: `${scene}:${index}`,
  source: `neutral ${scene} line ${index}`,
  translation: `neutral ${scene} line ${index}`,
  tokens: [],
  kind: 'message',
  context: { file: `${scene}.json`, event: 1, page: 1 },
});
const independentRequestUnit = (scene, index) => {
  const row = unit(scene, index);
  // Distinct scene evidence keeps these requests independent after prompt deduplication.
  return { ...row, context: { ...row.context, scene: `Neutral ${scene} scene evidence. `.repeat(1024) } };
};
const recordsFor = payload => payload.units.map(item => ({
  id: item.id, translation: `translated ${item.source}`, notes: '',
}));

test('provider failure projection preserves zero dispatches and false fetch state through wrapped causes', () => {
  const blocked = Object.assign(new Error('Complete evidence exceeds the declared model window'), {
    code: 'TEXT_REQUEST_CAPACITY_EXCEEDED', transportRequests: 0, fetchStarted: false,
  });
  const projected = providerFailure(new Error('SDK wrapper', { cause: blocked }));
  assert.equal(projected.transportRequests, 0); assert.equal(projected.fetchStarted, false);
  assert.equal(projected.code, 'TEXT_REQUEST_CAPACITY_EXCEEDED');
  assert.equal(providerFailure({ transportRequests: 2, fetchStarted: true }).transportRequests, 2);
  assert.equal(providerFailure({ transportRequests: NaN, fetchStarted: 'unknown' }).transportRequests, undefined);
  assert.equal(providerFailure({}).fetchStarted, undefined);
});
const waitForAbort = signal => new Promise((resolve, reject) => {
  const abort = () => reject(signal.reason ?? new Error('fixture request aborted'));
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
});

async function fixture(t, units, provider, concurrency = 2) {
  const root = await mkdtemp(path.join(testRoot, 'request-recovery-'));
  const dataDir = path.join(root, 'data');
  const gameDir = path.join(root, 'original');
  const releases = [];
  await mkdir(gameDir);
  await writeFile(path.join(gameDir, 'original.txt'), 'neutral original fixture');
  const worker = async (command, input) => {
    if (command === 'probe') return { engine: 'MV' };
    if (command === 'extract') {
      await mkdir(input.workspaceDir, { recursive: true });
      return { units, workspaceDir: input.workspaceDir, sourceFingerprint: sha256(units) };
    }
    if (command === 'roundtrip' || command === 'validate') return { ok: true };
    if (command === 'build') {
      await mkdir(input.outputDir, { recursive: true });
      return { buildDir: input.outputDir };
    }
    if (command === 'assemble') {
      await mkdir(input.outputDir, { recursive: true });
      const launchPath = path.join(input.outputDir, 'Game.exe');
      await writeFile(launchPath, 'neutral executable fixture');
      return { outputDir: input.outputDir, launchPath };
    }
    throw new Error(`Unsupported fixture worker command: ${command}`);
  };
  const service = await createService({
    dataDir, worker, secrets, provider, scriptTools: null,
    technicalProvider: async () => ({ decision: 'native', summary: 'fixture native plan', selectedCandidateIds: [] }),
  });
  t.after(async () => {
    for (const release of releases) release();
    await service.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  });
  const settings = defaultSettings();
  settings.connection.model = 'local-recovery-fixture';
  // Complete 32k scene references fit separately, but two cannot share this declared window.
  settings.connection.contextWindow = 65536;
  settings.connection.maxOutputTokens = 8192;
  settings.proofreading = false;
  settings.concurrency = concurrency;
  await service.saveSettings(settings);
  const project = await service.createProject({ gameDir });
  // These tests start after native preparation, so the first-sample gate cannot hide concurrency.
  const store = createStore(dataDir);
  try {
    const prepared = store.one('projects', project.id);
    store.put('projects', {
      ...prepared,
      technicalPlan: { decision: 'native', summary: 'fixture native plan', selectedCandidateIds: [] },
      sampleValidation: { unitIds: [], nativeStructure: 'passed', runtime: 'pending' },
    });
  } finally { store.close(); }
  return {
    service, projectId: project.id,
    releaseOnCleanup: release => releases.push(release),
    rows: async () => (await service.listText({ projectId: project.id })).units,
    tasks: () => {
      const reader = createStore(dataDir);
      try { return reader.all('tasks', project.id); }
      finally { reader.close(); }
    },
    completed: () => eventually(async () => {
      const detail = await service.getProject({ projectId: project.id });
      return detail.status === 'completed' && detail;
    }, 'the fixture project did not finish'),
  };
}

test('temporary provider capacity follows the existing bounded translation recovery without pausing the project', async t => {
  const requests = [], timestamps = [];
  const f = await fixture(t, [unit('capacity', 0)], async args => {
    const payload = args.wire.payload;
    requests.push(payload.units.map(item => item.id)); timestamps.push(Date.now());
    if (requests.length === 1) throw providerCapacityFailure({ statusCode: 402,
      body: { error: { metadata: { reason: 'in_flight_budget_exhausted', headers: { 'Retry-After': '0.01' } } } } });
    return { records: recordsFor(payload), finishReason: 'stop' };
  }, 1);
  await f.service.startProject({ projectId: f.projectId });
  await f.completed();
  assert.equal(requests.length, 2);
  assert.ok(timestamps[1] - timestamps[0] >= 450, 'the task loop honors the existing cooldown before its finite retry');
  assert.equal((await f.rows())[0].status, 'translated');
  assert.equal(f.tasks().filter(task => task.role === 'translation')[0].requestHistory[0].code, 'PROVIDER_CAPACITY');
});

test('persistent sibling timeouts drain a later complete response before pausing and resume does not resend its IDs', async t => {
  const slowEntered = defer();
  const releaseSlow = defer();
  const requests = [];
  let recovered = false;
  const f = await fixture(t, [independentRequestUnit('timeout', 0), independentRequestUnit('sibling', 0)], async args => {
    const payload = args.wire.payload;
    requests.push(payload.units.map(item => item.id));
    if (payload.units[0].source.includes('timeout') && !recovered) {
      await slowEntered.promise;
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }
    if (payload.units[0].source.includes('sibling') && !recovered) {
      slowEntered.resolve();
      // Keep the paid sibling response alive while the failing lane exhausts its finite window.
      await releaseSlow.promise;
    }
    return { records: recordsFor(payload), finishReason: 'stop' };
  });
  f.releaseOnCleanup(slowEntered.resolve);
  f.releaseOnCleanup(releaseSlow.resolve);
  const sibling = (await f.rows()).find(item => item.source.includes('sibling'));
  await f.service.startProject({ projectId: f.projectId });
  await eventually(() => slowEntered.settled, 'the independent sibling request did not start');
  await eventually(() => f.tasks().some(task => task.status === 'paused' && task.attempts === 3),
    'the persistent timeout did not stop after three attempts');
  const draining = await f.service.getProject({ projectId: f.projectId });
  assert.equal(draining.status, 'running', 'already sent independent work must finish before the project is paused');
  assert.match(draining.stage, /保存其余任务/);
  releaseSlow.resolve();
  await eventually(async () => (await f.service.getProject({ projectId: f.projectId })).status === 'paused'
    && f.tasks().every(task => task.status !== 'running'), 'the drained project did not settle into a finite pause');
  const savedBeforeResume = (await f.rows()).some(item => item.id === sibling.id && item.status === 'translated') ||
    f.tasks().some(task => task.candidateRecords?.some(record => record.id === sibling.id));
  recovered = true;
  await f.service.startProject({ projectId: f.projectId });
  await f.completed();
  assert.equal(savedBeforeResume, true, 'a complete response must be saved before resume');
  assert.equal(requests.flat().filter(id => id === sibling.id).length, 1,
    'resume must not resend an ID whose complete valid response already arrived');
  assert.equal((await f.rows()).find(item => item.id === sibling.id).translation, `translated ${sibling.source}`);
});

for (const malformed of ['unknown', 'duplicate']) {
  test(`${malformed} response IDs do not discard the other unique valid records`, async t => {
    const requests = [];
    const f = await fixture(t, Array.from({ length: 4 }, (_, index) => unit('records', index)), async args => {
      const payload = args.wire.payload;
      requests.push(payload.units.map(item => item.id));
      const records = recordsFor(payload);
      if (requests.length === 1) {
        assert.equal(records.length, 4);
        return { records: [records[0], records[2], ...(malformed === 'unknown'
          ? [{ id: 'unknown-fixture-id', translation: 'unrequested fixture text', notes: '' }]
          : [records[1], { ...records[1], translation: 'conflicting duplicate fixture text' }])], finishReason: 'stop' };
      }
      return { records, finishReason: 'stop' };
    }, 1);
    await f.service.startProject({ projectId: f.projectId });
    await f.completed();
    const first = requests[0];
    const remaining = new Set([first[1], first[3]]);
    assert(requests.length > 1, 'the omitted or ambiguous records require another request');
    assert(requests.slice(1).every(ids => ids.every(id => remaining.has(id))),
      'only omitted or ambiguous IDs may be sent again');
    for (const id of [first[0], first[2]]) {
      assert.equal(requests.flat().filter(item => item === id).length, 1,
        'a unique valid record must survive a malformed sibling ID');
    }
    assert((await f.rows()).every(item => item.translation === `translated ${item.source}`));
  });
}

test('an edit during a request preserves manual text without redispatching its other in-flight IDs', async t => {
  const heldEntered = defer();
  const triggerEntered = defer();
  const releaseHeld = defer();
  const releaseTrigger = defer();
  const requests = [];
  let heldIds;
  let heldReturned = false;
  const repeatedWhileHeld = [];
  const f = await fixture(t, [
    ...Array.from({ length: 4 }, (_, index) => independentRequestUnit('held', index)),
    independentRequestUnit('trigger', 0),
  ], async args => {
    const payload = args.wire.payload;
    const ids = payload.units.map(item => item.id);
    requests.push(ids);
    if (!heldIds && payload.units.some(item => item.source.includes('held'))) {
      heldIds = ids;
      heldEntered.resolve();
      await releaseHeld.promise;
      heldReturned = true;
    } else if (payload.units.some(item => item.source.includes('trigger'))) {
      triggerEntered.resolve();
      await releaseTrigger.promise;
    } else if (!heldReturned && ids.some(id => heldIds.includes(id))) repeatedWhileHeld.push(ids);
    return { records: recordsFor(payload), finishReason: 'stop' };
  });
  f.releaseOnCleanup(releaseHeld.resolve);
  f.releaseOnCleanup(releaseTrigger.resolve);
  await f.service.startProject({ projectId: f.projectId });
  await eventually(() => heldEntered.settled && triggerEntered.settled,
    'the two independent concurrent requests did not start');
  const manual = (await f.rows()).find(item => item.id === heldIds[0]);
  await f.service.saveText({ projectId: f.projectId, unitId: manual.id,
    translation: 'manual fixture translation', notes: 'manual fixture note', expectedRevision: manual.revision });
  releaseTrigger.resolve();
  await eventually(async () => (await f.rows()).some(item => item.source.includes('trigger') && item.status === 'translated'),
    'the sibling task did not finish and trigger replanning');
  for (let index = 0; index < 6; index++) await new Promise(resolve => setImmediate(resolve));
  releaseHeld.resolve();
  await f.completed();
  assert.deepEqual(repeatedWhileHeld, [], 'replanning must reserve IDs already being processed');
  for (const id of heldIds.filter(id => id !== manual.id)) {
    assert.equal(requests.flat().filter(item => item === id).length, 1,
      'a concurrent manual edit must not discard the other returned candidates');
  }
  const rows = await f.rows();
  const savedManual = rows.find(item => item.id === manual.id);
  assert.equal(savedManual.translation, 'manual fixture translation');
  assert.equal(savedManual.notes, 'manual fixture note');
  assert.equal(savedManual.revision, manual.revision + 1);
  assert(rows.filter(item => item.id !== manual.id).every(item => item.translation === `translated ${item.source}`));
});

test('onRecords candidates survive interruption before the provider returns its final response', async t => {
  const entered = defer();
  const requests = [];
  let recovered = false;
  let checkpointId;
  const f = await fixture(t, Array.from({ length: 3 }, (_, index) => unit('checkpoint', index)), async args => {
    const payload = args.wire.payload;
    requests.push(payload.units.map(item => item.id));
    const records = recordsFor(payload);
    if (!recovered) {
      checkpointId = records[0].id;
      await args.onRecords?.([records[0]]);
      entered.resolve();
      await waitForAbort(args.signal);
    }
    return { records, finishReason: 'stop' };
  }, 1);
  await f.service.startProject({ projectId: f.projectId });
  await eventually(() => entered.settled, 'the partial response fixture did not start');
  await f.service.pauseProject({ projectId: f.projectId });
  await eventually(() => f.tasks().every(task => task.status !== 'running'),
    'the interrupted streaming fixture did not settle');
  recovered = true;
  await f.service.startProject({ projectId: f.projectId });
  await f.completed();
  assert.equal(requests.flat().filter(id => id === checkpointId).length, 1,
    'a checkpointed record must not be sent again after interruption');
  assert((await f.rows()).every(item => item.translation === `translated ${item.source}`));
  const task = f.tasks().find(item => item.role === 'translation');
  assert.equal(task.requestCount, 2, 'resuming keeps the cumulative request count');
  assert.deepEqual(task.requestHistory.map(item => item.status), ['cancelled', 'received']);
  assert.equal(task.requestHistory[0].checkpointed, 1);
  assert.equal(task.requestHistory[1].requested, 2);
  assert(task.requestHistory.every(item => item.inputCharacters > 0));
  assert(!JSON.stringify(task.requestHistory).includes('translated neutral'), 'diagnostic history stores counts rather than translated text');
});
