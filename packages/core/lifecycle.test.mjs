import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { createStore as createDatabaseStore } from './store.mjs';

const testRoot = path.resolve('local/lifecycle-tests');
await mkdir(testRoot, { recursive: true });
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function eventually(check) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await tick(); }
  throw new Error('Lifecycle fixture timed out');
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(testRoot, 'project-'));
  const dataDir = path.join(root, 'data'), gameDir = path.join(root, 'original');
  await mkdir(gameDir);
  await writeFile(path.join(gameDir, 'original.txt'), 'original');
  const units = options.units ?? Array.from({ length: 3 }, (_, i) => ({ id: `line-${i}`, kind: 'message', source: `neutral line ${i}`, context: { file: `scene-${i}` }, tokens: [] }));
  const requests = [], commands = [];
  const worker = async (command, args, control) => {
    commands.push(command);
    const override = await options.worker?.(command, args, control);
    if (override !== undefined) return override;
    if (command === 'catalog') return {};
    if (command === 'probe') return { engine: 'MV' };
    if (command === 'extract') { await mkdir(args.workspaceDir, { recursive: true }); await writeFile(path.join(args.workspaceDir, 'baseline.txt'), 'frozen'); return { units, workspaceDir: args.workspaceDir }; }
    if (command === 'roundtrip' || command === 'validate') return {};
    if (command === 'build') { await mkdir(args.outputDir, { recursive: true }); return { buildDir: args.outputDir }; }
    if (command === 'assemble') { await mkdir(args.outputDir, { recursive: true }); await writeFile(path.join(args.outputDir, 'Game.exe'), 'neutral executable'); return { outputDir: args.outputDir, launchPath: path.join(args.outputDir, 'Game.exe') }; }
    throw new Error(`Unexpected fixture worker ${command}`);
  };
  const service = await createService({ dataDir, worker, scriptTools: null, technicalProvider: async () => ({ decision: 'native', summary: 'neutral technical fixture' }), provider: async (args) => {
    const payload = args.wire.payload; requests.push({ role: args.role, ...payload });
    if (options.provider) return options.provider(args, payload);
    if (args.role === 'proofreading') {
      const edits = payload.reviewScope?.stage === 'consistency' ? [] : payload.units.map(unit => ({ id: unit.id,
        expectedRevision: unit.revision, translation: `${unit.currentTranslation}。` }));
      return { review: { protocol: 'pinhao-review-1', reviewedIds: payload.units.map(unit => unit.id), edits,
        issues: edits.map(edit => ({ unitId: edit.id, kind: 'correction', resolution: 'fixed', message: '补齐中性句子的标点' })) } };
    }
    return { records: payload.units.map((unit) => ({ id: unit.id, translation: `译文 ${unit.source}` })) };
  } });
  await service.saveSettings({ ...defaultSettings(), connection: { baseUrl: 'http://localhost:1/v1', model: 'neutral-fixture', ...options.capacity }, concurrency: 1 });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  return { service, root, dataDir, gameDir, requests, commands };
}
async function complete(service, id) { return eventually(async () => { const project = await service.getProject({ projectId: id }); return project.status === 'completed' && project; }); }
async function accept(service, id, index, translation = '已有译文') { const unit = (await service.listText({ projectId: id })).units[index]; return service.saveText({ projectId: id, unitId: unit.id, translation, expectedRevision: unit.revision, action: 'confirm' }); }

test('beginProject publishes a cancellable preparation and createProject retains its await-ready contract', async (t) => {
  let block = true, aborted = false;
  const entered = deferred();
  const f = await fixture(t, { worker: async (command, args, { signal }) => {
    if (command === 'extract' && block) {
      entered.resolve();
      await new Promise((resolve) => signal.addEventListener('abort', () => { aborted = true; setTimeout(resolve, 30); }, { once: true }));
      return { workspaceDir: args.workspaceDir, units: [] };
    }
  } });
  const project = await f.service.beginProject({ gameDir: f.gameDir });
  assert.equal(project.status, 'preparing'); await entered.promise;
  const paused = await f.service.cancelProject({ projectId: project.id });
  assert.equal(aborted, true); assert.equal(paused.status, 'paused'); assert.equal(paused.stage, '准备已取消');
  assert.equal(paused.total, 0); assert.equal(f.commands.includes('roundtrip'), false);
  assert.equal(paused.issues.filter((issue) => issue.category === 'adapter').length, 0);
  block = false;
  assert.equal((await f.service.startProject({ projectId: project.id })).status, 'ready');
  assert.equal((await f.service.getProject({ projectId: project.id })).total, 3);
  const second = await f.service.createProject({ gameDir: f.gameDir });
  assert.equal(second.status, 'ready');
});

test('deleting during preparation waits for cancellation and removes all project records', async (t) => {
  const entered = deferred(); let workerSettled = false;
  const f = await fixture(t, { worker: async (command, args, { signal }) => {
    if (command === 'extract') {
      entered.resolve(); await new Promise((resolve) => signal.addEventListener('abort', () => setTimeout(resolve, 35), { once: true }));
      workerSettled = true; return { workspaceDir: args.workspaceDir, units: [] };
    }
  } });
  const project = await f.service.beginProject({ gameDir: f.gameDir }); await entered.promise;
  const deleted = await f.service.deleteProject({ projectId: project.id, removeWorkspace: true });
  assert.equal(workerSettled, true); assert.equal(deleted.deleted, true);
  assert.equal((await f.service.snapshot()).projects.length, 0);
  await assert.rejects(f.service.getProject({ projectId: project.id }), /项目列表重新选择/);
  await assert.rejects(stat(project.workspaceDir), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.gameDir, 'original.txt'), 'utf8'), 'original');
});

test('cancel waits for model cancellation and retains accepted revisions', async (t) => {
  const entered = deferred(); let settled = false;
  const f = await fixture(t, { provider: async ({ signal }) => {
    entered.resolve(); await new Promise((resolve) => signal.addEventListener('abort', () => setTimeout(resolve, 30), { once: true }));
    settled = true; throw new Error('aborted fixture');
  } });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  const accepted = await accept(f.service, project.id, 0);
  await f.service.startProject({ projectId: project.id, mode: 'translation' }); await entered.promise;
  assert.equal((await f.service.cancelProject({ projectId: project.id })).status, 'paused');
  assert.equal(settled, true);
  assert.deepEqual((await f.service.listText({ projectId: project.id })).units[0], accepted);
});

test('delete defaults to records only; workspace cleanup retains every game and save', async (t) => {
  const f = await fixture(t);
  const first = await f.service.createProject({ gameDir: f.gameDir });
  await accept(f.service, first.id, 0);
  const firstBuild = await f.service.buildProject({ projectId: first.id });
  const defaultDeletion = await f.service.deleteProject({ projectId: first.id });
  assert.ok(defaultDeletion.retainedPaths.includes(first.workspaceDir));
  assert.ok((await stat(firstBuild.launchPath)).isFile());
  assert.equal(await readFile(path.join(first.workspaceDir, 'workbench', 'baseline.txt'), 'utf8'), 'frozen');
  const second = await f.service.createProject({ gameDir: f.gameDir });
  const internal = await f.service.buildProject({ projectId: second.id });
  await mkdir(path.join(internal.path, 'save')); await writeFile(path.join(internal.path, 'save/file1.rmmzsave'), 'private progress');
  const external = await f.service.buildProject({ projectId: second.id, outputDir: path.join(f.root, 'external-game') });
  const saveCache = path.join(second.workspaceDir, 'samples', 'save');
  await mkdir(saveCache, { recursive: true }); await writeFile(path.join(saveCache, 'file1.rpgsave'), 'also progress');
  const deletion = await f.service.deleteProject({ projectId: second.id, removeWorkspace: true });
  assert.equal(deletion.deleted, true); assert.ok(deletion.retainedPaths.includes(internal.path)); assert.ok(deletion.retainedPaths.includes(external.path));
  assert.ok((await stat(internal.launchPath)).isFile()); assert.ok((await stat(external.launchPath)).isFile());
  assert.equal(await readFile(path.join(internal.path, 'save/file1.rmmzsave'), 'utf8'), 'private progress');
  assert.equal(await readFile(path.join(saveCache, 'file1.rpgsave'), 'utf8'), 'also progress');
  assert.ok(deletion.retainedPaths.includes(second.workspaceDir));
  assert.equal(await readFile(path.join(second.workspaceDir, 'workbench', 'baseline.txt'), 'utf8'), 'frozen');
  const store = createStore(f.dataDir);
  assert.equal(store.one('projects', second.id), undefined);
  for (const table of ['units', 'revisions', 'tasks', 'issues', 'builds', 'imports']) assert.equal(store.all(table, second.id).length, 0);
  assert.ok(store.one('settings', 'global')); store.close();
});

test('delete waits for a direct build to abort before deleting its library entry', async (t) => {
  const entered = deferred();
  const f = await fixture(t, { worker: async (command, args, { signal }) => {
    if (command === 'assemble') { entered.resolve(); await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); return { outputDir: args.outputDir }; }
  } });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  const build = f.service.buildProject({ projectId: project.id });
  const rejection = assert.rejects(build, /abort/i); await entered.promise;
  assert.equal((await f.service.deleteProject({ projectId: project.id })).deleted, true); await rejection;
  assert.equal((await f.service.snapshot()).projects.length, 0);
});

test('translation-only preserves accepted text and emits no proofreading requests', async (t) => {
  const f = await fixture(t), project = await f.service.createProject({ gameDir: f.gameDir });
  const accepted = await accept(f.service, project.id, 0);
  await f.service.startProject({ projectId: project.id, mode: 'translation' }); const result = await complete(f.service, project.id);
  assert.equal(result.runMode, 'translation'); assert.equal(result.done, 3); assert.equal(result.translated, 2); assert.equal(result.proofread, 1);
  assert.deepEqual(f.requests.map((request) => request.role), ['translation', 'translation']);
  assert.deepEqual((await f.service.listText({ projectId: project.id })).units[0], accepted);
  const count = f.requests.length; await f.service.startProject({ projectId: project.id, mode: 'translation' }); const repeated = await complete(f.service, project.id);
  assert.equal(f.requests.length, count); assert.equal(result.builds.at(-1).id, repeated.builds.at(-1).id);
});

test('proofreading-only works from current accepted translations and preserves pending originals', async (t) => {
  const f = await fixture(t), project = await f.service.createProject({ gameDir: f.gameDir });
  await accept(f.service, project.id, 0, '首份译文'); await accept(f.service, project.id, 1, '次份译文');
  const before = (await f.service.listText({ projectId: project.id })).units;
  await f.service.startProject({ projectId: project.id, mode: 'proofreading' }); const result = await complete(f.service, project.id);
  assert.equal(result.pending, 1); assert.equal(result.runMode, 'proofreading');
  assert.ok(f.requests.every((request) => request.role === 'proofreading'));
  const scenes = f.requests.filter(request => request.reviewScope?.stage === 'scene');
  const consistency = f.requests.filter(request => request.reviewScope?.stage === 'consistency');
  assert.deepEqual(scenes.flatMap((request) => request.units.map((unit) => unit.id)).sort(),
    before.slice(0, 2).map((unit) => unit.id).sort());
  assert.deepEqual(scenes.flatMap((request) => request.units.map((unit) => unit.currentTranslation)), ['首份译文', '次份译文']);
  assert.deepEqual(consistency, [], 'Healthy reviewed scenes do not buy a second whole-round review');
  assert.equal(result.proofread, 2);
  assert.equal(result.reviewRound.stage, 'committed');
  assert.deepEqual((await f.service.listText({ projectId: project.id })).units[2], before[2]);
  assert.equal((await f.service.listText({ projectId: project.id })).units[0].translation, '首份译文。');
});

test('paused proofreading resumes its persisted scope without proofreading accepted results twice', async (t) => {
  let calls = 0, fail = true;
  const f = await fixture(t, { capacity: { contextWindow: 32768, maxOutputTokens: 8192 }, units: Array.from({ length: 3 }, (_, i) => ({
    id: `line-${i}`, kind: 'message', source: `neutral line ${i}. ${'A complete neutral scene needs an uninterrupted review. '.repeat(150)}`, tokens: [],
    context: { file: `scene-${i}` },
  })), provider: async (args, payload) => {
    if (++calls === 2 && fail) { const error = new Error('fixture unauthorized'); error.status = 401; throw error; }
    const edits = payload.reviewScope?.stage === 'consistency' ? [] : payload.units.map(unit => ({ id: unit.id, translation: `${unit.currentTranslation}。` }));
    return { review: { protocol: 'pinhao-review-1', reviewedIds: payload.units.map(unit => unit.id), edits,
      issues: edits.map(edit => ({ unitId: edit.id, kind: 'correction', resolution: 'fixed', message: '补齐中性标点' })) } };
  } });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  await accept(f.service, project.id, 0); await accept(f.service, project.id, 1);
  await f.service.startProject({ projectId: project.id, mode: 'proofreading' });
  await eventually(async () => (await f.service.getProject({ projectId: project.id })).status === 'paused');
  await f.service.cancelProject({ projectId: project.id });
  const before = (await f.service.listText({ projectId: project.id })).units;
  const requestsBeforeResume = f.requests.length;
  fail = false; await f.service.startProject({ projectId: project.id }); await complete(f.service, project.id);
  assert.equal(calls, 3);
  const resumed = f.requests.slice(requestsBeforeResume);
  assert.deepEqual(resumed.filter(request => request.reviewScope?.stage === 'scene').flatMap(request => request.units.map(unit => unit.id)), [before[1].id]);
  assert.deepEqual(resumed.filter(request => request.reviewScope?.stage === 'consistency'), [], 'Saved healthy candidates need no extra consistency request');
  const after = (await f.service.listText({ projectId: project.id })).units;
  assert.equal(before[0].translation, '已有译文', 'The first scene candidate remains provisional before the whole review commits');
  assert.equal(after[0].translation, `${before[0].translation}。`); assert.equal(after[0].revision, before[0].revision + 1);
  assert.deepEqual((await f.service.listText({ projectId: project.id })).units[2], before[2]);
});

test('repeating an unchanged proofreading pass completes without stranding translated units', async (t) => {
  const f = await fixture(t, { provider: async (args, payload) => ({ records: payload.units.map(unit => ({ id: unit.id, translation: unit.currentTranslation })) }) });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  const accepted = await accept(f.service, project.id, 0, '准确的既有译文');
  for (let pass = 0; pass < 3; pass++) {
    await f.service.startProject({ projectId: project.id, mode: 'proofreading' });
    const result = await complete(f.service, project.id);
    assert.equal(result.proofread, 1);
    assert.equal(f.requests.length, pass + 1);
    assert.deepEqual(f.requests.slice(pass).map(request => request.reviewScope.stage), ['scene']);
    assert.equal(result.reviewRound.stage, 'committed');
    const current = (await f.service.listText({ projectId: project.id })).units[0];
    assert.equal(current.translation, accepted.translation);
    assert.equal(current.revision, accepted.revision);
  }
});

test('repair targets skipped records and leaves healthy accepted and never-attempted text intact', async (t) => {
  const f = await fixture(t), project = await f.service.createProject({ gameDir: f.gameDir });
  const accepted = await accept(f.service, project.id, 0);
  const store = createStore(f.dataDir), skipped = store.units(project.id)[1];
  store.putUnit(project.id, { ...skipped, status: 'skipped', skipRole: 'translation' }); store.close();
  const before = (await f.service.listText({ projectId: project.id })).units;
  await f.service.startProject({ projectId: project.id, mode: 'repair' }); const result = await complete(f.service, project.id);
  assert.equal(result.pending, 1); assert.equal(result.skipped, 0); assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests.map(request => request.reviewScope?.stage ?? request.role), ['translation', 'scene']);
  assert.ok(f.requests.every((request) => request.units.length === 1 && request.units[0].id === skipped.id));
  const after = (await f.service.listText({ projectId: project.id })).units;
  assert.deepEqual(after[0], accepted); assert.deepEqual(after[2], before[2]);
});

test('invalid modes and proofreading an empty baseline fail before dispatch', async (t) => {
  const f = await fixture(t), project = await f.service.createProject({ gameDir: f.gameDir });
  await assert.rejects(f.service.startProject({ projectId: project.id, mode: 'other' }), /阶段无效/);
  await assert.rejects(f.service.startProject({ projectId: project.id, mode: 'proofreading' }), /尚无可校对/);
  assert.equal(f.requests.length, 0); assert.equal((await f.service.getProject({ projectId: project.id })).status, 'ready');
});

test('proofreading reviews accepted scenes without a paid glossary prerequisite', async (t) => {
  const f = await fixture(t, { units: [
    { id: 'accepted', kind: 'message', source: 'アルファ ready', tokens: [], context: { file: 'accepted' } },
    { id: 'pending', kind: 'message', source: 'ベータ ready', tokens: [], context: { file: 'pending' } },
  ], provider: async (args, payload) => ({ records: payload.units.map((unit) => ({ id: unit.id, translation: payload.reviewScope?.stage === 'consistency' ? unit.currentTranslation : `${unit.currentTranslation}。` })) }) });
  const project = await f.service.createProject({ gameDir: f.gameDir }); await accept(f.service, project.id, 0, '已有译文');
  await f.service.startProject({ projectId: project.id, mode: 'proofreading' }); await complete(f.service, project.id);
  assert.equal(f.requests.length, 1); assert.ok(f.requests.every((request) => request.role === 'proofreading'));
  assert.deepEqual(f.requests.map(request => request.reviewScope?.stage), ['scene']);
  assert.deepEqual(f.requests[0].units.map((unit) => unit.source), ['アルファ ready']);
  assert.equal((await f.service.listText({ projectId: project.id })).units[1].revision, 0);
});

test('repair does not invent a paid name-rewrite job for healthy accepted scenes', async (t) => {
  const f = await fixture(t, { units: [
    { id: 'name', kind: 'database_name', source: 'アルファ', tokens: [] },
    { id: 'known-conflict', kind: 'message', source: 'アルファ ready', tokens: [], context: { file: 'conflict' } },
    { id: 'pending', kind: 'message', source: 'ベータ ready', tokens: [], context: { file: 'pending' } },
  ], provider: async (args, payload) => ({ records: payload.units.map((unit) => ({ id: unit.id, translation: unit.currentTranslation.replaceAll('アルファ', '甲名') })) }) });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  const name = await accept(f.service, project.id, 0, '甲名'); await accept(f.service, project.id, 1, 'アルファ standby');
  const pending = (await f.service.listText({ projectId: project.id })).units[2];
  await f.service.startProject({ projectId: project.id, mode: 'repair' }); await complete(f.service, project.id);
  assert.equal(f.requests.length, 0);
  const after = (await f.service.listText({ projectId: project.id })).units;
  assert.equal(after[1].translation, 'アルファ standby'); assert.deepEqual(after[0], name); assert.deepEqual(after[2], pending);
});

test('workspace cleanup rejects a changed ownership path and leaves its files and library entry intact', async (t) => {
  const f = await fixture(t), project = await f.service.createProject({ gameDir: f.gameDir });
  const store = createDatabaseStore(project.workspaceDir); store.put('projects', { ...store.one('projects', project.id), workspaceDir: f.gameDir }); store.close();
  await assert.rejects(f.service.deleteProject({ projectId: project.id, removeWorkspace: true }), /定位无效/);
  assert.equal((await f.service.snapshot()).projects.length, 1);
  assert.equal(await readFile(path.join(f.gameDir, 'original.txt'), 'utf8'), 'original');
});

const synchronizedUnits = () => [
  { id: 'title-a', kind: 'game_title', source: 'Neutral', tokens: [], context: { file: 'a.json', syncGroup: 'game-title' } },
  { id: 'title-b', kind: 'game_title', source: 'Neutral', tokens: [], context: { file: 'b.json', syncGroup: 'game-title' } },
  { id: 'healthy', kind: 'message', source: 'neutral line', tokens: [], context: { file: 'c.json' } },
];

test('manual shared-field editing commits all linked translations atomically and keeps individual notes', async (t) => {
  const f = await fixture(t, { units: synchronizedUnits() });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  const before = (await f.service.listText({ projectId: project.id })).units;
  const edited = await f.service.saveText({ projectId: project.id, unitId: before[0].id, translation: '统一标题', notes: '人工核定', expectedRevision: 0 });
  const after = (await f.service.listText({ projectId: project.id })).units;
  assert.equal(edited.revision, 1);
  assert.deepEqual(after.slice(0, 2).map(unit => [unit.translation, unit.status, unit.revision]), [['统一标题', 'translated', 1], ['统一标题', 'translated', 1]]);
  assert.equal(after[0].notes, '人工核定'); assert.equal(after[1].notes, before[1].notes);
  assert.deepEqual(after[2], before[2]);
  await assert.rejects(f.service.saveText({ projectId: project.id, unitId: before[1].id, translation: '过期修改', expectedRevision: 0 }), /已更新/);
  assert.deepEqual((await f.service.listText({ projectId: project.id })).units, after);
});

test('three partial responses keep a synchronized pair entirely on its unchanged baseline', async (t) => {
  let calls = 0;
  const f = await fixture(t, { units: synchronizedUnits(), provider: async (args, payload) => ({ records: ++calls === 1 ? [{ id: payload.units[0].id, translation: '统一标题' }] : [] }) });
  const project = await f.service.createProject({ gameDir: f.gameDir }); await accept(f.service, project.id, 2);
  await f.service.startProject({ projectId: project.id, mode: 'translation' }); const result = await complete(f.service, project.id);
  assert.deepEqual(f.requests.map((request) => request.units.length), [2, 1, 1]); assert.equal(result.skipped, 2);
  const units = (await f.service.listText({ projectId: project.id })).units;
  assert.deepEqual(units.slice(0, 2).map((unit) => [unit.translation, unit.revision, unit.status]), [['Neutral', 0, 'skipped'], ['Neutral', 0, 'skipped']]);
  assert.equal(units[2].translation, '已有译文');
});

test('contradictory synchronized translations retry the whole pair before committing either field', async (t) => {
  let calls = 0, projectId;
  const f = await fixture(t, { units: synchronizedUnits(), provider: async (args, payload) => {
    if (++calls === 1) return { records: payload.units.map((unit, index) => ({ id: unit.id, translation: index ? '另一标题' : '首份标题' })) };
    assert.deepEqual((await f.service.listText({ projectId })).units.slice(0, 2).map((unit) => unit.revision), [0, 0]);
    return { records: payload.units.map((unit) => ({ id: unit.id, translation: '统一标题' })) };
  } });
  const project = await f.service.createProject({ gameDir: f.gameDir }); projectId = project.id; await accept(f.service, project.id, 2);
  await f.service.startProject({ projectId: project.id, mode: 'translation' }); const result = await complete(f.service, project.id);
  assert.equal(result.skipped, 0); assert.deepEqual(f.requests.map((request) => request.units.length), [2, 2]);
  assert.deepEqual((await f.service.listText({ projectId })).units.slice(0, 2).map((unit) => [unit.translation, unit.revision]), [['统一标题', 1], ['统一标题', 1]]);
});
