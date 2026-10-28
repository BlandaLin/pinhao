import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createService, createRunScope, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { sha256 } from '../exchange/index.mjs';

function traceReads(t) {
  const reads = new Map();
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    const statement = prepare.call(this, sql);
    for (const method of ['get', 'all']) {
      const execute = statement[method];
      statement[method] = function (...args) {
        const key = `${method}:${sql}`;
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return execute.apply(this, args);
      };
    }
    return statement;
  });
  return {
    clear: () => reads.clear(),
    count: pattern => [...reads].filter(([sql]) => pattern.test(sql)).reduce((sum, [, count]) => sum + count, 0),
  };
}

function unit(index, status = 'pending') {
  const source = `Neutral scene line ${index}.`;
  return { id: `unit:${index}`, legacyId: `line:${index}`, source, translation: source, notes: '', kind: 'message',
    context: { file: 'data/Scene001.json', event: Math.floor(index / 16), page: 1 }, tokens: [], revision: 0, status, sourceHash: sha256(source) };
}

async function fixture(t, options = {}) {
  const count = options.count ?? 1500;
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-service-performance-'));
  const dataDir = path.join(root, 'data'), gameDir = path.join(root, 'original');
  await mkdir(gameDir);
  const seed = createStore(dataDir);
  seed.put('projects', { id: 'neutral-project', name: 'Neutral large project', gameDir, workspaceDir: path.join(root, 'workspace'),
      engine: 'MV', prepared: true, status: 'ready', stage: '文字工作台就绪', targetLanguage: 'zh-Hans',
      workbenchDir: path.join(root, 'workspace'), technicalPlan: { decision: 'native' }, sampleValidation: { nativeStructure: 'passed' },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      inventory: { capabilities: { assist: true, assistModes: ['live'] } },
      coverage: { format: 1, unitCount: count, summary: { extracted: count }, needsAdaptation: false, triggers: [], completeness: 'structural',
        unknownClusters: Array.from({ length: count }, (_, index) => ({ resource: `resource:${index}`, candidates: ['Neutral candidate.'] })),
        resources: [{ file: 'data/Scene001.json' }], reviewItems: [], dynamicCandidates: [], imageCandidates: [] } });
  seed.transaction('neutral-project', () => {
    for (let index = 0; index < count; index++) {
      const row = options.unit?.(index) ?? unit(index);
      seed.putUnit('neutral-project', row, index); seed.addRevision('neutral-project', row);
    }
    options.seed?.(seed);
  });
  seed.close();
  let modelCalls = 0;
  const service = await createService({ dataDir, worker: async command => {
    if (command === 'catalog') return { engines: [] };
    throw new Error(`Unexpected worker call: ${command}`);
  }, provider: async args => {
    modelCalls++;
    if (options.provider) return options.provider(args);
    throw new Error('This fixture uses no model requests');
  }, scriptTools: null, imageTools: null });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }); });
  return { dataDir, service, modelCalls: () => modelCalls };
}

function seedHistory(store, count) {
  for (let index = 0; index < count; index++) store.putTask('neutral-project', {
    id: `history:${index}`, projectId: 'neutral-project', fingerprint: `history:${index}`,
    role: 'translation', status: 'succeeded', unitIds: [`old:${index}`],
    input: [{ id: `old:${index}`, revision: 0, sourceHash: `hash:${index}` }],
    attempts: 1, requestHistory: [{ receivedCharacters: 4096, status: 'succeeded' }],
    candidateRecords: [{ id: `old:${index}`, translation: 'Retained neutral candidate.' }],
  });
}

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('run scopes build membership once and preserve empty, absent and sparse scope semantics', () => {
  const ids = Array.from({ length: 131609 }, (_, index) => `unit:${index}`);
  let iterations = 0;
  const iterate = ids[Symbol.iterator].bind(ids);
  ids[Symbol.iterator] = function () { iterations++; return iterate(); };
  ids.includes = () => { throw new Error('Linear membership must not be used'); };
  const inScope = createRunScope(ids);
  assert.equal(iterations, 1);
  for (let index = 0; index < ids.length; index++) assert.equal(inScope({ id: `unit:${index}` }), true);
  assert.equal(iterations, 1);
  assert.equal(inScope({ id: 'missing' }), false);
  assert.equal(createRunScope()({ id: 'any' }), true);
  assert.equal(createRunScope([])({ id: 'any' }), false);
  assert.deepEqual([unit(0), unit(1), unit(2)].filter(createRunScope(['unit:2', 'unit:0'])).map(row => row.id), ['unit:0', 'unit:2']);
});

test('compact summaries and host context retain full history on disk without loading it', async t => {
  const trace = traceReads(t);
  const manifest = { files: Array.from({ length: 100 }, (_, index) => ({ path: `resource:${index}`, sha256: `hash:${index}` })) };
  const f = await fixture(t, { count: 16, seed: store => {
    seedHistory(store, 1024);
    store.put('builds', { id: 'build:0', path: 'neutral-output', checks: [], outputManifest: manifest,
      assistance: { supported: true, modes: ['live'] } }, 'neutral-project');
  } });
  trace.clear();
  const compact = await f.service.getProject({ projectId: 'neutral-project', summaryOnly: true });
  assert.equal(compact.taskTotal, 1024);
  assert.deepEqual(compact.tasks.map(task => task.id), Array.from({ length: 8 }, (_, offset) => `history:${1016 + offset}`));
  assert.equal(Object.hasOwn(compact.builds[0], 'outputManifest'), false);
  assert.equal(trace.count(/SELECT body FROM tasks WHERE project_id=\? ORDER BY rowid/), 0);
  trace.clear();
  const context = await f.service.getProjectContext({ projectId: 'neutral-project' });
  assert.equal(context.builds[0].id, 'build:0');
  assert.equal(Object.hasOwn(context, 'tasks'), false);
  assert.equal(Object.hasOwn(context, 'coverage'), false);
  assert.equal(trace.count(/FROM tasks/), 0);
  await assert.rejects(f.service.getProjectContext({ projectId: 'missing' }), /重新选择项目/);
  const full = await f.service.getProject({ projectId: 'neutral-project' });
  assert.equal(full.tasks.length, 1024);
  assert.deepEqual(full.builds[0].outputManifest, manifest);
  const inspect = createStore(f.dataDir);
  try {
    assert.equal(inspect.one('tasks', 'history:0').candidateRecords[0].translation, 'Retained neutral candidate.');
    assert.deepEqual(inspect.one('builds', 'build:0').outputManifest, manifest);
  } finally { inspect.close(); }
});

for (const mode of ['translation', 'proofreading']) test(`${mode} fills transport concurrency across singleton scenes and resumes without duplicate tasks`, async t => {
  const trace = traceReads(t), inputs = [];
  const f = await fixture(t, { count: 640,
    unit: index => {
      const row = unit(index, mode === 'proofreading' && index < 320 ? 'translated' : 'pending');
      return { ...row, context: { ...row.context, scene: index } };
    },
    seed: store => seedHistory(store, 2048),
    provider: async ({ prompt, signal, wire }) => {
      inputs.push(wire.payload.units.map(row => row.id));
      return new Promise((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    },
  });
  const settings = defaultSettings();
  settings.connection.model = 'neutral-fixture'; settings.concurrency = 3; settings.proofreading = false;
  settings.connection.contextWindow = 32768; settings.connection.maxOutputTokens = 1360;
  await f.service.saveSettings(settings);
  await f.service.startProject({ projectId: 'neutral-project', mode });
  trace.clear();
  await waitUntil(() => inputs.length === 3, 'Three transport requests must be in flight together');
  assert.equal(trace.count(/SELECT body FROM tasks WHERE project_id=\? ORDER BY rowid/), 0);
  const inspect = createStore(f.dataDir);
  let originalIds;
  try {
    const tasks = inspect.tasks('neutral-project', { statuses: ['queued', 'running'] });
    assert.equal(tasks.length, 16);
    assert.equal(tasks.filter(task => task.status === 'running').length, 3);
    assert.ok(tasks.every(task => task.role === mode && task.unitIds.length === 16),
      'Transport batches keep density in both phases while the frozen story retains semantic scene ownership');
    const ids = tasks.flatMap(task => task.unitIds);
    assert.equal(new Set(ids).size, ids.length);
    if (mode === 'proofreading') assert.ok(ids.every(id => Number(id.split(':')[1]) < 320));
    originalIds = tasks.map(task => task.id);
    await f.service.cancelProject({ projectId: 'neutral-project' });
    assert.equal(inspect.tasks('neutral-project', { statuses: ['queued', 'running'] }).length, 0);
    await f.service.startProject({ projectId: 'neutral-project', mode });
    await waitUntil(() => inputs.length === 6, 'Resumed batches must fill concurrency');
    const resumed = inspect.tasks('neutral-project', { statuses: ['queued', 'running'] });
    assert.deepEqual(resumed.map(task => task.id), originalIds);
    assert.equal(inspect.tasks('neutral-project').length, 2048 + 16);
    assert.deepEqual(inputs.slice(3).map(ids => JSON.stringify(ids)).sort(), inputs.slice(0, 3).map(ids => JSON.stringify(ids)).sort(),
      'The same independent batches resume exactly once; asynchronous artifact writes may reorder their sends');
  } finally { await f.service.cancelProject({ projectId: 'neutral-project' }); inspect.close(); }
});

test('repeated desktop summaries reuse project and count snapshots without full text reads', async t => {
  const trace = traceReads(t), f = await fixture(t);
  const complete = await f.service.getProject({ projectId: 'neutral-project' });
  assert.equal(complete.coverage.unknownClusters.length, 1500);
  const compact = await f.service.getProject({ projectId: 'neutral-project', summaryOnly: true });
  assert.equal(Object.hasOwn(compact.coverage, 'unknownClusters'), false);
  assert.equal(Object.hasOwn(compact.coverage, 'resources'), false);
  assert.deepEqual(compact.coverage.summary, complete.coverage.summary);
  trace.clear();
  for (let index = 0; index < 40; index++) {
    const snapshot = await f.service.snapshot();
    const detail = await f.service.getProject({ projectId: 'neutral-project', summaryOnly: true });
    assert.equal(snapshot.projects[0].total, 1500);
    assert.equal(detail.pending, 1500);
    assert.equal(detail.canContinueAvailableText, true);
  }
  assert.equal(trace.count(/SUM\(CASE/), 0);
  assert.equal(trace.count(/SELECT (?:p\.)?body.* FROM projects.* WHERE (?:p\.)?id=/), 0);
  assert.equal(trace.count(/SELECT (?:p\.)?body.* FROM projects.* ORDER BY/), 0);
  assert.equal(trace.count(/SELECT body FROM units WHERE project_id=\? ORDER BY position/), 0);
  assert.equal(f.modelCalls(), 0);
});

test('cached service views reflect accepted edits, external commits, rollback and cancellation', async t => {
  const trace = traceReads(t), f = await fixture(t);
  const before = await f.service.getProject({ projectId: 'neutral-project', summaryOnly: true });
  const accepted = await f.service.saveText({ projectId: 'neutral-project', unitId: 'unit:0', translation: 'Translated neutral line.', expectedRevision: 0, action: 'confirm' });
  assert.equal(accepted.revision, 1);
  assert.equal((await f.service.snapshot()).projects[0].proofread, 1);
  const edited = (await f.service.snapshot()).projects[0];
  assert.notEqual(edited.textVersion, before.textVersion);
  const external = createStore(f.dataDir);
  try {
    external.transaction('neutral-project', () => {
      external.putUnit('neutral-project', unit(1, 'proofread'), 1);
      const project = external.one('projects', 'neutral-project');
      external.put('projects', { ...project, name: 'Updated neutral project' });
    });
    const updated = await f.service.getProject({ projectId: 'neutral-project', summaryOnly: true });
    assert.equal(updated.name, 'Updated neutral project');
    assert.equal(updated.proofread, 2);
    assert.notEqual(updated.textVersion, edited.textVersion);
    assert.throws(() => external.transaction('neutral-project', () => {
      external.putUnit('neutral-project', unit(2, 'proofread'), 2);
      external.put('projects', { ...external.one('projects', 'neutral-project'), name: 'Rolled-back name' });
      throw new Error('rollback fixture');
    }), /rollback fixture/);
    const retained = await f.service.snapshot();
    assert.equal(retained.projects[0].name, 'Updated neutral project');
    assert.equal(retained.projects[0].proofread, 2);
    assert.equal(retained.projects[0].textVersion, updated.textVersion);
  } finally { external.close(); }
  trace.clear();
  const beforeCancel = (await f.service.snapshot()).projects[0].textVersion;
  const cancelled = await f.service.cancelProject({ projectId: 'neutral-project' });
  assert.equal(cancelled.status, 'paused');
  assert.equal(cancelled.proofread, 2);
  assert.equal(cancelled.textVersion, beforeCancel);
  assert.equal((await f.service.snapshot()).projects[0].proofread, 2);
  assert.equal(trace.count(/SELECT body FROM units WHERE project_id=\? ORDER BY position/), 0);
  assert.equal((await f.service.listText({ projectId: 'neutral-project' })).units[0].translation, 'Translated neutral line.');
  assert.equal(f.modelCalls(), 0);
});

test('accepted text batches refresh only changed rows and cancellation preserves committed results', async t => {
  const trace = traceReads(t);
  let requests = 0, startedThird;
  const third = new Promise(resolve => { startedThird = resolve; });
  const f = await fixture(t, { provider: async ({ prompt, signal, wire }) => {
    requests++;
    if (requests === 1) trace.clear();
    if (requests === 3) {
      startedThird();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    const input = wire.payload;
    return { records: input.units.map(row => ({ id: row.id, translation: `Translated neutral ${row.id}.`, notes: '' })) };
  } });
  const settings = defaultSettings(); settings.connection.model = 'neutral-fixture'; settings.concurrency = 1; settings.proofreading = false;
  settings.connection.contextWindow = 32768; settings.connection.maxOutputTokens = 1360;
  await f.service.saveSettings(settings);
  await f.service.startProject({ projectId: 'neutral-project', mode: 'translation' });
  await Promise.race([third, new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('Third neutral batch was not dispatched')), 8000); timer.unref(); })]);
  assert.equal(trace.count(/SELECT body FROM units WHERE project_id=\? ORDER BY position/), 0);
  const stopped = await f.service.cancelProject({ projectId: 'neutral-project' });
  assert.equal(requests, 3);
  assert.equal(stopped.translated, 32);
  assert.equal(stopped.pending, 1468);
  const rows = await f.service.listText({ projectId: 'neutral-project', limit: 40 });
  assert.ok(rows.units.slice(0, 32).every(row => row.status === 'translated' && row.translation.startsWith('Translated neutral')));
  assert.ok(rows.units.slice(32).every(row => row.status === 'pending' && row.translation === row.source));
});

test('six ordinary text agents preserve name choices and disjoint commits on resume without terminology jobs', async t => {
  let release, active = 0, peak = 0;
  const gate = new Promise(resolve => { release = resolve; }), requests = [];
  const f = await fixture(t, { count: 112,
    unit: index => ({ ...unit(index), source: `Person${index}`, translation: `Person${index}`,
      sourceHash: sha256(`Person${index}`), kind: 'character_name' }),
    provider: async ({ prompt, signal, wire }) => {
      const input = wire.payload;
      assert.equal(input.task, 'translation');
      requests.push(input.units.map(row => row.id));
      assert.ok(input.units.every(row => row.kind === 'character_name' && row.context.file === 'data/Scene001.json'));
      const request = requests.length;
      active++; peak = Math.max(peak, active);
      try {
        if (request <= 6) await gate;
        else await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          if (signal.aborted) reject(signal.reason);
        });
        return { records: input.units.map(row => ({ id: row.id, translation: `姓名${row.source.slice(6)}`, notes: '',
          termChoices: [{ source: row.source, translation: `姓名${row.source.slice(6)}` }] })) };
      } finally { active--; }
    },
  });
  t.after(release);
  const settings = defaultSettings(); settings.connection.model = 'neutral-fixture'; settings.concurrency = 6; settings.proofreading = false;
  settings.connection.contextWindow = 32768; settings.connection.maxOutputTokens = 1168;
  await f.service.saveSettings(settings);
  await f.service.startProject({ projectId: 'neutral-project', mode: 'translation' });
  await waitUntil(() => requests.length === 6, 'Six normal text batches must overlap');
  assert.equal(active, 6);
  assert.equal(new Set(requests.flat()).size, 96);
  const inspect = createStore(f.dataDir);
  try {
    release();
    await waitUntil(() => inspect.units('neutral-project').filter(row => row.status === 'translated').length === 96,
      'Every disjoint text commit must survive');
    await waitUntil(() => requests.length === 7, 'Last pending normal text batch must begin');
    await f.service.cancelProject({ projectId: 'neutral-project' });
    const retained = inspect.units('neutral-project').filter(row => row.status === 'translated');
    assert.equal(retained.length, 96);
    assert.ok(retained.every(row => row.translation === `姓名${row.source.slice(6)}` && row.revision === 1
      && row.termChoices[0].translation === row.translation));
    await f.service.startProject({ projectId: 'neutral-project', mode: 'translation' });
    await waitUntil(() => requests.length === 8, 'Resume must dispatch only pending names');
    assert.deepEqual(requests[7], requests[6]);
    assert.equal(inspect.tasks('neutral-project').filter(task => task.role === 'translation').length, 7);
    assert.ok(inspect.tasks('neutral-project').every(task => !['glossary', 'glossary-repair'].includes(task.kind)));
    assert.equal(peak, 6);
  } finally { await f.service.cancelProject({ projectId: 'neutral-project' }); inspect.close(); }
});
