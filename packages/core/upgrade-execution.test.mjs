import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { createStore as createDatabaseStore } from './store.mjs';

const parent = path.resolve('local/upgrade-execution-tests');
await mkdir(parent, { recursive: true });

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(parent, 'flow-'));
  const gameDir = path.join(root, 'original'), dataDir = path.join(root, 'profile');
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'original.txt'), 'preserved original');
  const raw = options.units ?? [0, 1].map(id => ({ id: `line-${id}`, source: `A quiet room ${id}.`, kind: 'message', tokens: [], context: { file: 'scene.json' } }));
  const calls = [];
  const service = await createService({ dataDir, scriptTools: null, imageTools: null,
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral verification' }),
    provider: async args => { const payload = args.wire.payload; calls.push({ role: args.role, payload }); return options.provider?.(args, payload) ?? { records: payload.units.map(unit => ({ id: unit.id, translation: unit.currentTranslation ?? `中文 ${unit.source}` })) }; },
    worker: async (command, args) => {
      if (command === 'catalog') return {};
      if (command === 'probe') return { engine: 'MV' };
      if (command === 'extract') { await mkdir(args.workspaceDir, { recursive: true }); return { workspaceDir: args.workspaceDir, units: raw }; }
      if (['validate', 'roundtrip'].includes(command)) return {};
      if (command === 'build') { await mkdir(args.outputDir, { recursive: true }); await writeFile(path.join(args.outputDir, 'text.json'), JSON.stringify(args.translations)); return { buildDir: args.outputDir }; }
      if (command === 'assemble') { await mkdir(args.outputDir, { recursive: true }); await writeFile(path.join(args.outputDir, 'Game.exe'), 'neutral launcher'); await writeFile(path.join(args.outputDir, 'text.json'), await readFile(path.join(args.buildDir, 'text.json'))); return { outputDir: args.outputDir, launchPath: path.join(args.outputDir, 'Game.exe') }; }
      throw new Error(`Unexpected neutral command ${command}`);
    }, ...options.service });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  await service.saveSettings({ ...defaultSettings(), proofreading: false, concurrency: 1, connection: { baseUrl: 'http://localhost:1/v1', model: 'neutral' }, ...options.settings });
  const project = await service.createProject({ gameDir });
  return { root, dataDir, gameDir, service, project, calls };
}

async function finish(service, projectId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const project = await service.getProject({ projectId });
    if (['completed', 'paused', 'failed'].includes(project.status)) return project;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Neutral service verification timed out');
}

test('exception recovery isolates divergent linked candidates and retains unrelated completed records', async t => {
  const raw = ['a', 'b', 'c'].map(id => ({ id, source: id === 'c' ? 'Unrelated.' : 'Shared title', tokens: [], kind: 'message', context: { file: 'scene.json', ...(id !== 'c' ? { syncGroup: 'title' } : {}) } }));
  const f = await fixture(t, { units: raw, provider: async ({ onRecords }, payload) => {
    onRecords(payload.units.map((unit, index) => ({ id: unit.id, translation: `分歧${index}` })));
    throw Object.assign(new Error('Incomplete trailing JSON'), { code: 'INVALID_RESPONSE' });
  } });
  await f.service.startProject({ projectId: f.project.id });
  const done = await finish(f.service, f.project.id);
  const units = (await f.service.listText({ projectId: f.project.id })).units;
  assert.equal(units.filter(unit => unit.context.syncGroup).every(unit => unit.translation === 'Shared title'), true);
  assert.equal(units.find(unit => unit.legacyId === 'c').status, 'translated');
  assert.equal(done.status, 'completed');
  assert.equal(await readFile(path.join(f.gameDir, 'original.txt'), 'utf8'), 'preserved original');
});

test('zero-edit review records evidence issues without rewriting accepted translations', async t => {
  const f = await fixture(t, { settings: { proofreading: true }, provider: async ({ role }, payload) => role === 'proofreading'
    ? { review: { protocol: 'pinhao-review-1', reviewedIds: payload.units.map(unit => unit.id), edits: [],
      issues: [{ unitId: payload.units[0].id, kind: 'needs_evidence', resolution: 'open', message: '保留当前称呼，后续场景可补充身份依据' }] } }
    : { records: payload.units.map(unit => ({ id: unit.id, translation: `安静的房间 ${unit.source}` })) } });
  await f.service.startProject({ projectId: f.project.id });
  const done = await finish(f.service, f.project.id);
  assert.equal(done.status, 'completed', done.lastError);
  const units = (await f.service.listText({ projectId: f.project.id })).units;
  assert.equal(units.every(unit => unit.revision === 1 && unit.status === 'proofread'), true);
  assert.equal(done.issues.some(issue => issue.category === 'review-evidence'), true);
  assert.deepEqual(f.calls.filter(call => call.role === 'proofreading').map(call => call.payload.reviewScope?.stage), ['scene', 'consistency']);
});

test('explicit semantic equivalence reuses an accepted source for a pending occurrence', async t => {
  // The duplicate line carries a different term scope, so host-side fan-out deliberately skips it
  // (fanOutKeyFor includes semanticScope) and this exercises the model-declared equivalence path.
  const raw = Array.from({ length: 18 }, (_, i) => ({ id: `line-${i}`, source: i === 16 ? 'A quiet room 0.' : `A quiet room ${i}.`, kind: 'message', tokens: [], context: { file: 'scene.json', ...(i === 16 ? { semanticScope: 'room-label' } : {}) } }));
  let sharedTarget, evidenceQueries = 0;
  const f = await fixture(t, { units: raw,
    // This case needs a separate target batch even when the chosen model can combine over 16 short rows.
    settings: { connection: { baseUrl: 'http://localhost:1/v1', model: 'neutral', contextWindow: 32768, maxOutputTokens: 1024 } },
    provider: async (_args, payload) => {
    const records = payload.units.map(unit => ({ id: unit.id, translation: `中文 ${unit.source}` }));
    if (payload.units[0].source === 'A quiet room 0.') {
      const source = payload.units[0];
      if (!payload.evidenceResults?.some(answer => answer.query?.text === source.source)) {
        evidenceQueries++;
        return { evidenceRequests: [{ query: { text: source.source, offset: 0, limit: 32 }, reason: 'Find the separately scoped duplicate location label.' }] };
      }
      const target = payload.referenceOnly.find(unit => unit.id !== source.id && unit.source === source.source);
      assert.ok(target); sharedTarget = target.id;
      assert.ok(payload.units.every(unit => unit.id !== target.id), 'The separately scoped occurrence must still be a pending read-only reuse target');
      assert.ok(payload.evidenceResults.some(answer => answer.returnedIds.includes(target.id)), 'The host must actually supply the queried occurrence before it becomes equivalence evidence');
      return { records, semanticDecisions: [{ id: 'quiet-room-label', entity: 'room-label', sense: 'same authored location label',
        scope: { unitIds: [source.id, target.id] }, evidenceIds: [source.id, target.id], expectedRevision: 0,
        equivalence: { fromUnitId: source.id, toUnitIds: [target.id] } }] };
    }
    return { records };
  } });
  await f.service.startProject({ projectId: f.project.id });
  const done = await finish(f.service, f.project.id);
  assert.equal(done.status, 'completed', done.lastError);
  const target = (await f.service.listText({ projectId: f.project.id })).units.find(unit => unit.id === sharedTarget);
  assert.equal(evidenceQueries, 1);
  assert.equal(target.semanticDecision.id, 'quiet-room-label');
  assert.equal(f.calls.some(call => call.payload.units.some(unit => unit.id === sharedTarget)), false);
});

test('modified managed output is retained and gets a fresh build instead of stale acceptance', async t => {
  const f = await fixture(t);
  await f.service.startProject({ projectId: f.project.id });
  const done = await finish(f.service, f.project.id);
  const first = done.builds.at(-1);
  await writeFile(path.join(first.path, 'text.json'), 'external edit');
  await assert.rejects(f.service.exportRelease({ projectId: f.project.id, filePath: path.join(f.root, 'share.zip') }), /重新生成/);
  const next = await f.service.buildProject({ projectId: f.project.id });
  assert.notEqual(first.id, next.id);
  assert.equal(await readFile(path.join(first.path, 'text.json'), 'utf8'), 'external edit');
  await f.service.cleanupProject({ projectId: f.project.id });
  assert.equal(await readFile(path.join(first.path, 'text.json'), 'utf8'), 'external edit');
});

test('task SQL fingerprint follows its body when a resumable identity is updated', async t => {
  const root = await mkdtemp(path.join(parent, 'store-')); const store = createDatabaseStore(root);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.putTask('project', { id: 'task', fingerprint: 'before' });
  store.putTask('project', { id: 'task', fingerprint: 'after' });
  assert.equal(store.db.prepare('SELECT fingerprint FROM tasks WHERE id=?').get('task').fingerprint, 'after');
  store.putTask('project', { id: 'other', fingerprint: 'before' });
});

test('cleanup checks old output again after a later text edit changed the build identity', async t => {
  const f = await fixture(t);
  await f.service.startProject({ projectId: f.project.id });
  const first = (await finish(f.service, f.project.id)).builds.at(-1);
  await writeFile(path.join(first.path, 'text.json'), 'user edited product');
  const unit = (await f.service.listText({ projectId: f.project.id })).units[0];
  await f.service.saveText({ projectId: f.project.id, unitId: unit.id, translation: '后来修订的译文', expectedRevision: unit.revision });
  const second = await f.service.buildProject({ projectId: f.project.id });
  assert.notEqual(first.id, second.id);
  const cleaned = await f.service.cleanupProject({ projectId: f.project.id });
  assert.equal(cleaned.retained, 1);
  assert.equal(await readFile(path.join(first.path, 'text.json'), 'utf8'), 'user edited product');
});
