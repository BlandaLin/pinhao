import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createService, defaultSettings, groupUnits } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { encodeText, decodeText, threeWay, sha256 } from '../exchange/index.mjs';
import { sdkProvider } from './provider.mjs';
import { runDshAdaptation } from '../technical/dsh-runner.mjs';
import { ADAPTATION_PROMPT_VERSION } from '../technical/adaptation.mjs';

const testRoot = path.resolve('local', 'core-tests');
await mkdir(testRoot, { recursive: true });

const secrets = { encrypt: (text) => `cipher:${Buffer.from(text).toString('base64')}`, decrypt: (text) => Buffer.from(text.slice(7), 'base64').toString() };
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
async function eventually(fn, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await tick(); }
  throw new Error('Timed out waiting for service state');
}
// Seed translations differ from their source: `validateTranslation` rejects a translation that is
// byte-identical to the source as a missed translation, so a fixture that echoes the source can
// never commit and every downstream wait would stall on a rejected batch.
function workerFor(units = [{ id: 'map:1', source: 'Hello {{P1}}', translation: '你好 {{P1}}', tokens: ['{{P1}}'], kind: 'message', context: { file: 'Map001.json', event: 1, page: 1 } }]) {
  return async (command, args) => {
    if (command === 'probe') return { engine: 'MV' };
    if (command === 'extract') { await mkdir(args.workspaceDir, { recursive: true }); return { units, workspaceDir: args.workspaceDir, sourceFingerprint: sha256(units.map((u) => u.source)) }; }
    if (command === 'roundtrip' || command === 'validate') return { ok: true };
    if (command === 'build') { await mkdir(args.outputDir, { recursive: true }); return { buildDir: args.outputDir }; }
    if (command === 'assemble') { await mkdir(args.outputDir, { recursive: true }); await writeFile(path.join(args.outputDir, 'Game.exe'), 'neutral executable fixture'); return { outputDir: args.outputDir, launchPath: path.join(args.outputDir, 'Game.exe') }; }
    if (command === 'zip') { await cp(args.sourceDir, args.filePath, { recursive: true }); return { path: args.filePath }; }
    if (command === 'unzip') { await cp(args.filePath, args.outputDir, { recursive: true }); return { outputDir: args.outputDir }; }
    throw new Error(`Unknown command ${command}`);
  };
}
const provider = async ({ prompt, role, wire }) => {
  const payload = wire.payload;
  return { records: payload.units.map((u) => {
    let translation = role === 'translation' ? `译文 ${u.source}` : `${u.currentTranslation}。`;
    for (const entry of payload.glossary ?? []) translation = translation.replaceAll(entry.source, entry.translation);
    if (['database_name', 'database_nickname'].includes(u.kind)) translation = payload.glossary?.find((entry) => entry.source === u.source)?.translation ?? translation;
    return { id: u.id, translation, notes: '' };
  }) };
};
const technicalProvider = async () => ({ decision: 'native', summary: '中性配方检查通过', selectedCandidateIds: [] });
async function fixture(t, opts = {}) {
  const root = await mkdtemp(path.join(testRoot, 'pinhao-core-'));
  const gameDir = path.join(root, 'original');
  await mkdir(gameDir);
  await writeFile(path.join(gameDir, 'original.txt'), 'original');
  const service = await createService({ dataDir: path.join(root, 'data'), worker: workerFor(opts.units), secrets, provider, technicalProvider, scriptTools: null, ...opts });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); });
  const settings = defaultSettings(); settings.connection.model = 'neutral-test'; settings.connection.apiKey = 'private-unit-test-key';
  await service.saveSettings(settings);
  return { service, root, gameDir };
}

test('assistance follows the individual game and the installed output rather than another game in the same engine family', async t => {
  const base = workerFor();
  let probes = 0;
  const f = await fixture(t, { worker: async (command, input) => {
    if (command === 'catalog') return { engines: [{ id: 'unity', name: 'Unity', extract: true, build: true, assist: true, assistModes: ['live'], detail: 'Mono frame bridge' }] };
    if (command === 'probe') return { engine: 'Unity', capabilities: { extract: true, nativeBuild: true,
      assist: ++probes > 1, assistModes: probes > 1 ? ['live'] : [], assistDetail: probes > 1 ? 'Mono runtime' : 'IL2CPP runtime' } };
    const result = await base(command, input);
    if (command === 'assemble') result.assist = { supported: true, detail: 'Actual output bridge' };
    return result;
  } });
  const first = await f.service.createProject({ gameDir: f.gameDir });
  const second = await f.service.createProject({ gameDir: f.gameDir });
  assert.equal((await f.service.getProject({ projectId: first.id })).assistance.supported, false);
  assert.equal((await f.service.getProject({ projectId: second.id })).assistance.supported, true);
  assert.equal((await f.service.snapshot()).engines.find(engine => engine.id === 'unity').assist, true);
  await f.service.buildProject({ projectId: first.id });
  const rebuilt = await f.service.getProject({ projectId: first.id });
  assert.equal(rebuilt.assistance.supported, true);
  assert.deepEqual(rebuilt.assistance.modes, ['live']);
  assert.equal(rebuilt.assistance.detail, 'Actual output bridge');
});

test('an older project keeps its probe-derived assistance and reuses its cached build', async t => {
  const base = workerFor();
  let assembled = 0;
  const f = await fixture(t, { worker: async (command, input) => {
    if (command === 'probe') return { engine: 'WOLF', capabilities: { extract: true, nativeBuild: true, assist: false } };
    if (command === 'assemble') assembled++;
    return base(command, input);
  } });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  const built = await f.service.buildProject({ projectId: created.id });
  // No assembled assist bridge, so the probe capability is the whole answer: the detail is derived
  // from the project itself and needs no follow-up worker round-trip.
  const refreshed = await f.service.getProject({ projectId: created.id });
  assert.equal(refreshed.assistance.supported, false);
  assert.deepEqual(refreshed.assistance.modes, []);
  const reused = await f.service.buildProject({ projectId: created.id });
  assert.equal(reused.id, built.id);
  assert.equal(assembled, 1);
  assert.equal((await f.service.getProject({ projectId: created.id })).assistance.supported, false);
});

test('final construction delegates input validation to one build and never assembles a rejected build', async t => {
  const base = workerFor(), commands = [];
  let rejectBuild = false;
  const { service, gameDir } = await fixture(t, { worker: async (command, args) => {
    commands.push(command);
    if (command === 'build' && rejectBuild) throw new Error('Writer rejected invalid input');
    return base(command, args);
  } });
  const created = await service.createProject({ gameDir });
  commands.length = 0;
  rejectBuild = true;
  await assert.rejects(service.buildProject({ projectId: created.id }), /Writer rejected invalid input/);
  assert.deepEqual(commands.filter(command => ['validate', 'build', 'assemble'].includes(command)), ['build']);
  assert.equal((await service.getProject({ projectId: created.id })).builds.length, 0);
  rejectBuild = false;
  commands.length = 0;
  await service.buildProject({ projectId: created.id });
  assert.deepEqual(commands.filter(command => ['validate', 'build', 'assemble'].includes(command)), ['build', 'assemble']);
});

test('text profile preserves multiline, slashes, quotes, literal delimiters and intents', () => {
  const records = [{ id: 'u1', translation: 'a\nb\\c"d=TEXT=\n文字\u2028line separator\u2029paragraph separator', notes: '#\n\u2028\u2029', intent: 'pending' }];
  assert.deepEqual(decodeText(encodeText(records)), records);
  assert.throws(() => decodeText('ID="a"\nTEXT="x"\nTEXT="y"'));
});
test('three-way merge is idempotent and preserves concurrent candidates', () => {
  assert.deepEqual(threeWay('a', 'b', 'b'), { value: 'b', changed: false });
  assert.deepEqual(threeWay('a', 'b', 'a'), { value: 'b', changed: false });
  assert.deepEqual(threeWay('a', 'a', 'c'), { value: 'c', changed: true });
  assert.equal(threeWay('a', 'b', 'c').conflict, true);
});
test('scene batching preserves whole units and scene boundaries', () => {
  const units = Array.from({ length: 20 }, (_, i) => ({ source: 'sentence', translation: '', context: { file: i < 19 ? 'scene1' : 'scene2', event: 1 } }));
  assert.deepEqual(groupUnits(units).map((g) => g.length), [19, 1]);
});
test('encrypted BYOK persistence, scene translation, proofreading and standalone build', async (t) => {
  const { service, root, gameDir } = await fixture(t);
  const created = await service.createProject({ gameDir });
  assert.equal(created.status, 'ready');
  await service.startProject({ projectId: created.id });
  const finished = await eventually(async () => { const p = await service.getProject({ projectId: created.id }); return p.status === 'completed' && p; });
  assert.equal(finished.done, 1);
  assert.equal(finished.builds.length, 1);
  assert.equal(finished.tasks.filter((task) => task.status === 'succeeded').length, 2);
  assert.equal(finished.tasks.some(task => task.role === 'technical'), false, 'Native validation does not buy an unused technical-plan signature');
  assert.equal(finished.tasks.some(task => task.reviewStage === 'consistency'), false, 'Healthy scene review does not create a second full review');
  assert.equal(await readFile(path.join(gameDir, 'original.txt'), 'utf8'), 'original');
  assert.equal((await service.listText({ projectId: created.id })).units[0].translation, '译文 Hello {{P1}}。');
  const snapshot = JSON.stringify(await service.snapshot());
  assert(!snapshot.includes('private-unit-test-key'));
  assert(!snapshot.includes('cipher:'));
  await service.close();
  for (const database of [path.join(root, 'data', 'catalog.sqlite'), path.join(created.workspaceDir, 'pinhao.sqlite')]) {
    assert(!(await readFile(database)).includes(Buffer.from('private-unit-test-key')));
  }
});
test('text save uses revision compare-and-swap and validates control tokens', async (t) => {
  const { service, gameDir } = await fixture(t);
  const p = await service.createProject({ gameDir });
  const unit = (await service.listText({ projectId: p.id })).units[0];
  const changed = await service.saveText({ projectId: p.id, unitId: unit.id, translation: '你好呀 {{P1}}', expectedRevision: 0 });
  assert.equal(changed.revision, 1);
  await assert.rejects(service.saveText({ projectId: p.id, unitId: unit.id, translation: '其他 {{P1}}', expectedRevision: 0 }), /已更新/);
  await assert.rejects(service.saveText({ projectId: p.id, unitId: unit.id, translation: '缺少标记', expectedRevision: 1 }), /保护标记/);
});
test('JSON package imports, duplicate import stays idempotent, immutable materials are checked', async (t) => {
  const { service, root, gameDir } = await fixture(t);
  const p = await service.createProject({ gameDir });
  const filePath = path.join(root, 'handoff.zip');
  await service.exportPackage({ projectId: p.id, filePath });
  const editable = path.join(filePath, 'editable', 'units.json');
  const records = JSON.parse(await readFile(editable, 'utf8')); records[0].translation = '交付 {{P1}}';
  await writeFile(editable, JSON.stringify(records));
  assert.equal((await service.importPackage({ projectId: p.id, filePath })).accepted, 1);
  assert.equal((await service.importPackage({ projectId: p.id, filePath })).accepted, 0);
  const units = (await service.listText({ projectId: p.id })).units;
  assert.equal(units[0].revision, 1);
  await writeFile(path.join(filePath, 'source', 'units.json'), '[]');
  await assert.rejects(service.importPackage({ projectId: p.id, filePath }), /只读材料/);
});
test('package conflicts are atomic and notes participate in three-way merge', async (t) => {
  const units = [0, 1].map((i) => ({ id: `legacy-${i}`, source: `line ${i}`, translation: `line ${i}`, tokens: [] }));
  const { service, root, gameDir } = await fixture(t, { units });
  const p = await service.createProject({ gameDir });
  const filePath = path.join(root, 'handoff.zip');
  await service.exportPackage({ projectId: p.id, filePath });
  const current = (await service.listText({ projectId: p.id })).units;
  await service.saveText({ projectId: p.id, unitId: current[0].id, translation: '本机文字', expectedRevision: 0 });
  const editable = path.join(filePath, 'editable', 'units.json');
  const records = JSON.parse(await readFile(editable, 'utf8')); records[0].translation = '回包文字'; records[1].translation = '另一个改动';
  await writeFile(editable, JSON.stringify(records));
  const result = await service.importPackage({ projectId: p.id, filePath });
  assert.equal(result.accepted, 0); assert.equal(result.conflicts.length, 1);
  assert.equal((await service.listText({ projectId: p.id })).units[1].translation, 'line 1');
});
test('a returned package keeps linked display fields consistent and rejects the whole divergent handoff', async (t) => {
  const units = [0, 1].map(i => ({ id: `title-${i}`, source: 'Neutral title', tokens: [], context: { syncGroup: 'game-title' } }));
  units.push({ id: 'independent', source: 'Neutral message', tokens: [] });
  const { service, root, gameDir } = await fixture(t, { units });
  const p = await service.createProject({ gameDir });
  const before = (await service.listText({ projectId: p.id })).units;
  const filePath = path.join(root, 'linked-handoff.zip');
  await service.exportPackage({ projectId: p.id, filePath });
  const editable = path.join(filePath, 'editable/units.json');
  const records = JSON.parse(await readFile(editable, 'utf8'));
  records[0].translation = '统一标题'; records[1].translation = '另一标题'; records[2].translation = '独立文字改动';
  await writeFile(editable, JSON.stringify(records));
  await assert.rejects(service.importPackage({ projectId: p.id, filePath }), /关联显示字段/);
  assert.deepEqual((await service.listText({ projectId: p.id })).units, before);
  records[1].translation = '统一标题'; records[1].intent = 'pending';
  await writeFile(editable, JSON.stringify(records));
  await assert.rejects(service.importPackage({ projectId: p.id, filePath }), /关联显示字段/);
  assert.deepEqual((await service.listText({ projectId: p.id })).units, before);
  records[1].intent = 'submit';
  await writeFile(editable, JSON.stringify(records));
  assert.equal((await service.importPackage({ projectId: p.id, filePath })).accepted, 3);
  assert.deepEqual((await service.listText({ projectId: p.id })).units.map(unit => unit.translation), ['统一标题', '统一标题', '独立文字改动']);
});
test('linked package validation uses the merged current value rather than an unchanged returned baseline', async (t) => {
  const units = [0, 1].map(i => ({ id: `title-${i}`, source: 'Neutral title', tokens: [], context: { syncGroup: 'game-title' } }));
  units.push({ id: 'independent', source: 'Neutral message', tokens: [] });
  const { service, root, gameDir } = await fixture(t, { units });
  const p = await service.createProject({ gameDir });
  const filePath = path.join(root, 'linked-current.zip');
  await service.exportPackage({ projectId: p.id, filePath });
  const current = (await service.listText({ projectId: p.id })).units[0];
  await service.saveText({ projectId: p.id, unitId: current.id, translation: '本地核定标题', expectedRevision: current.revision });
  const editable = path.join(filePath, 'editable/units.json');
  const records = JSON.parse(await readFile(editable, 'utf8')); records[2].translation = '独立文字改动';
  await writeFile(editable, JSON.stringify(records));
  assert.equal((await service.importPackage({ projectId: p.id, filePath })).accepted, 1);
  assert.deepEqual((await service.listText({ projectId: p.id })).units.map(unit => unit.translation), ['本地核定标题', '本地核定标题', '独立文字改动']);
});
test('text profile handoff merges non-overlapping concurrent changes', async (t) => {
  const units = [0, 1].map((i) => ({ id: `legacy-${i}`, source: `line ${i}`, translation: `line ${i}`, tokens: [] }));
  const { service, root, gameDir } = await fixture(t, { units });
  const p = await service.createProject({ gameDir });
  const filePath = path.join(root, 'handoff.zip');
  await service.exportPackage({ projectId: p.id, filePath, profile: 'text' });
  const current = (await service.listText({ projectId: p.id })).units;
  await service.saveText({ projectId: p.id, unitId: current[0].id, translation: '本机更改', expectedRevision: 0 });
  const editable = path.join(filePath, 'editable', 'units.txt');
  const records = decodeText(await readFile(editable, 'utf8')); records[1].translation = '外部更改（第二项）';
  await writeFile(editable, encodeText(records));
  const result = await service.importPackage({ projectId: p.id, filePath });
  assert.equal(result.accepted, 1);
  assert.deepEqual((await service.listText({ projectId: p.id })).units.map((u) => u.translation), ['本机更改', '外部更改（第二项）']);
});
test('local malformed results are retried finitely, skipped and preserved in build', async (t) => {
  let calls = 0;
  const units = [0, 1].map((i) => ({ id: `unit-${i}`, source: `line ${i}`, translation: `line ${i}`, tokens: [], context: { file: `scene-${i}` } }));
  const { service, gameDir } = await fixture(t, { units, provider: async (args) => { if (args.wire.payload.units[0].source === 'line 1') return provider(args); calls++; return { records: [] }; } });
  const p = await service.createProject({ gameDir });
  await service.startProject({ projectId: p.id });
  const finished = await eventually(async () => { const detail = await service.getProject({ projectId: p.id }); return detail.status === 'completed' && detail; });
  assert.equal(calls, 3); assert.equal(finished.skipped, 1);
  assert.equal((await service.listText({ projectId: p.id })).units[0].translation, 'line 0');
});
const sameSceneUnits = (count) => Array.from({ length: count }, (_, i) => ({ id: `partial-${i}`, source: `neutral line ${i}`, translation: `neutral line ${i}`, tokens: [], kind: 'message', context: { file: 'OneScene.json' } }));
async function withoutProofreading(service) { const settings = (await service.snapshot()).settings; await service.saveSettings({ ...settings, proofreading: false }); }

test('partial model records repair only the missing ID with the accepted scene as reference', async (t) => {
  const requests = [];
  const { service, gameDir, root } = await fixture(t, { units: sameSceneUnits(16), provider: async (args) => {
    const payload = args.wire.payload; requests.push(payload);
    const result = await provider(args);
    if (requests.length === 1) result.records.pop();
    return { ...result, finishReason: 'stop' };
  } });
  await withoutProofreading(service);
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id });
  const done = await eventually(async () => { const value = await service.getProject({ projectId: p.id }); return value.status === 'completed' && value; });
  assert.equal(done.skipped, 0); assert.deepEqual(requests.map((p) => p.units.length), [16, 1]);
  assert.equal(requests[1].referenceOnly.length, 15);
  assert.match(requests[1].repairInstruction, /补齐 1 个 ID/);
  const store = createStore(path.join(root, 'data'));
  assert.equal(store.all('tasks', p.id).find((task) => task.role === 'translation').responseSummary.finishReason, 'stop'); store.close();
});

test('three partial responses preserve valid candidates and skip only the unresolved ID', async (t) => {
  const requests = [];
  const { service, gameDir } = await fixture(t, { units: sameSceneUnits(3), provider: async (args) => {
    requests.push(args.wire.payload.units.length);
    const result = await provider(args); result.records.pop(); return result;
  } });
  await withoutProofreading(service);
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id });
  const done = await eventually(async () => { const value = await service.getProject({ projectId: p.id }); return value.status === 'completed' && value; });
  assert.equal(done.skipped, 1); assert.deepEqual(requests, [3, 1, 1]);
  const units = (await service.listText({ projectId: p.id })).units;
  assert.deepEqual(units.map((u) => u.status), ['translated', 'translated', 'skipped']);
  assert.match(units[0].translation, /^译文/); assert.equal(units[2].translation, units[2].source);
  assert.equal(done.issues.filter((issue) => issue.category === 'local-skip' && !issue.resolvedAt).length, 1);
});
test('pause on partial failure preserves committed candidates and continues only the remaining ID', async (t) => {
  const requests = []; let omit = true;
  const { service, gameDir } = await fixture(t, { units: sameSceneUnits(3), provider: async (args) => {
    requests.push(args.wire.payload.units.length); const result = await provider(args);
    if (omit) result.records.pop();
    return result;
  } });
  const settings = (await service.snapshot()).settings;
  await service.saveSettings({ ...settings, proofreading: false, pauseOnLocalFailure: true });
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id });
  await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'paused');
  const before = (await service.listText({ projectId: p.id })).units;
  assert.deepEqual(before.map((u) => u.status), ['translated', 'translated', 'pending']);
  assert.deepEqual(before.map((u) => u.revision), [1, 1, 0]);
  assert.deepEqual(requests, [3, 1, 1]);
  omit = false; requests.length = 0; await service.startProject({ projectId: p.id });
  await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'completed');
  assert.deepEqual(requests, [1]);
  const after = (await service.listText({ projectId: p.id })).units;
  assert.deepEqual(after.map((u) => u.revision), [1, 1, 1]);
  assert.deepEqual(after.slice(0, 2).map((u) => u.translation), before.slice(0, 2).map((u) => u.translation));
});
test('a damaged protected record is repaired individually while valid records are retained', async (t) => {
  const units = sameSceneUnits(3); units[2] = { ...units[2], source: 'neutral {{P1}}', translation: 'neutral {{P1}}', tokens: ['{{P1}}'] };
  const requests = [];
  const { service, gameDir } = await fixture(t, { units, provider: async (args) => {
    requests.push(args.wire.payload.units.length); const result = await provider(args);
    if (requests.length === 1) result.records[2].translation = 'damaged marker';
    return result;
  } });
  await withoutProofreading(service);
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id });
  await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'completed');
  assert.deepEqual(requests, [3, 1]);
  assert.equal((await service.listText({ projectId: p.id })).units[2].translation, '译文 neutral {{P1}}');
});
test('a concurrent edit to a persisted candidate survives repair and compare-and-swap', async (t) => {
  const requests = [];
  const { service, gameDir } = await fixture(t, { units: sameSceneUnits(2), provider: async (args) => {
    requests.push(args.wire.payload.units.length);
    const result = await provider(args);
    if (requests.length === 1) result.records.pop();
    if (requests.length === 2) {
      const [project] = (await service.snapshot()).projects;
      const unit = (await service.listText({ projectId: project.id })).units[0];
      await service.saveText({ projectId: project.id, unitId: unit.id, translation: '保留人工选择', expectedRevision: unit.revision });
    }
    return result;
  } });
  await withoutProofreading(service);
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id });
  await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'completed');
  assert.equal(requests[0], 2); assert.ok(requests.slice(1).every(count => count === 1));
  const units = (await service.listText({ projectId: p.id })).units;
  assert.equal(units[0].translation, '保留人工选择'); assert.equal(units[0].revision, 1);
  assert.equal(units[1].status, 'translated');
});

for (const badIdentity of ['duplicate', 'unknown']) test(`a ${badIdentity} ID isolates ambiguous records while unique candidates survive`, async (t) => {
  let calls = 0;
  const { service, gameDir } = await fixture(t, { units: sameSceneUnits(3), provider: async (args) => {
    calls++; const result = await provider(args);
    if (calls === 1) return { records: result.records.slice(0, 1) };
    if (badIdentity === 'duplicate') return { records: [...result.records, result.records[0]] };
    return { records: [...result.records, { id: 'not-requested', translation: 'invalid identity' }] };
  } });
  await withoutProofreading(service);
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id });
  const done = await eventually(async () => { const value = await service.getProject({ projectId: p.id }); return value.status === 'completed' && value; });
  assert.equal(calls, badIdentity === 'duplicate' ? 3 : 2);
  assert.equal(done.skipped, badIdentity === 'duplicate' ? 1 : 0);
  assert.deepEqual((await service.listText({ projectId: p.id })).units.map((u) => u.status),
    ['translated', badIdentity === 'duplicate' ? 'skipped' : 'translated', 'translated']);
});

test('continue restores proofreading failures to proofreading instead of translating again', async (t) => {
  const calls = []; let fail = true;
  const { service, gameDir, root } = await fixture(t, { provider: async (args) => {
    calls.push(args.role);
    return fail && args.role === 'proofreading' ? { records: [] } : provider(args);
  } });
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id });
  await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'paused');
  const before = (await service.listText({ projectId: p.id })).units[0]; assert.equal(before.status, 'skipped');
  // Simulate the already shipped project format, which has no skipRole field.
  const store = createStore(path.join(root, 'data')); store.putUnit(p.id, { ...before, skipRole: undefined }); store.close();
  calls.length = 0; fail = false; await service.startProject({ projectId: p.id });
  await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'completed');
  assert.deepEqual(calls, ['proofreading']);
  const after = (await service.listText({ projectId: p.id })).units[0];
  assert.equal(after.status, 'proofread'); assert.equal(after.translation, `${before.translation}。`); assert.equal(after.skipRole, undefined);
});

test('accepted partial candidates persist through process close and resume without repeated translation', async (t) => {
  let calls = 0, entered = false;
  const { service, gameDir, root } = await fixture(t, { units: sameSceneUnits(3), provider: async (args) => {
    calls++;
    if (calls === 1) { const result = await provider(args); result.records.pop(); return result; }
    entered = true;
    await new Promise((_, reject) => args.signal.addEventListener('abort', () => reject(new Error('paused')), { once: true }));
  } });
  await withoutProofreading(service);
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id }); await eventually(() => entered);
  await service.close();
  const resumedRequests = [];
  const resumed = await createService({ dataDir: path.join(root, 'data'), worker: workerFor(sameSceneUnits(3)), secrets, technicalProvider, scriptTools: null, provider: async (args) => { resumedRequests.push(args.wire.payload.units.length); return provider(args); } });
  try {
    await resumed.startProject({ projectId: p.id });
    await eventually(async () => (await resumed.getProject({ projectId: p.id })).status === 'completed');
    assert.deepEqual(resumedRequests, [1]);
    assert.deepEqual((await resumed.listText({ projectId: p.id })).units.map((u) => u.revision), [1, 1, 1]);
  } finally { await resumed.close(); }
});

test('a prior prompt-version native sample candidate resumes without another model request', async (t) => {
  const worker = workerFor(); let fail = true, calls = 0;
  const { service, gameDir, root } = await fixture(t, { worker: async (command, args) => { if (command === 'build' && fail) throw new Error('sample dependency'); return worker(command, args); }, provider: async (args) => { calls++; return provider(args); } });
  await withoutProofreading(service);
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id });
  await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'paused');
  const store = createStore(path.join(root, 'data')); const candidate = store.all('tasks', p.id).find((task) => task.role === 'translation');
  store.putTask(p.id, { ...candidate, fingerprint: 'previous-prompt-fingerprint', promptVersion: 'pinhao-scenes-0.1' }); store.close();
  fail = false; await service.startProject({ projectId: p.id });
  await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'completed');
  assert.equal(calls, 1);
});
test('a confirmed database name is provided when mentioned beyond adjacent context', async (t) => {
  const units = sameSceneUnits(7); units[0] = { ...units[0], kind: 'database_name', source: 'NeutralName', translation: 'NeutralName' };
  units[6] = { ...units[6], source: 'Talk to NeutralName', translation: 'Talk to NeutralName' };
  const requests = [];
  const { service, gameDir } = await fixture(t, { units, provider: async (args) => { requests.push({ payload: args.wire.payload, system: args.system }); return provider(args); } });
  await withoutProofreading(service);
  const p = await service.createProject({ gameDir });
  for (const unit of (await service.listText({ projectId: p.id })).units.slice(0, 6)) await service.saveText({ projectId: p.id, unitId: unit.id, translation: unit.kind === 'database_name' ? '中性姓名' : unit.translation, expectedRevision: unit.revision });
  await service.startProject({ projectId: p.id }); await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'completed');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].payload.referenceOnly.find((unit) => unit.source === 'NeutralName').currentTranslation, '中性姓名');
  assert.match(requests[0].system, /统一译名/);
});
const neutralNames = { アルファ: '甲名', ベータ: '乙名', ガンマ: '丙名' };
const namedScene = () => [
  { id: 'Actors:00001', source: 'アルファ', translation: 'アルファ', kind: 'database_name', context: { file: 'data/Actors.json', field: 'name' }, tokens: [] },
  { id: 'line-1', source: '【{{CTRL0001}}ベータ{{CTRL0002}}】{{LINE0001}}「hello アルファ」', translation: '【{{CTRL0001}}ベータ{{CTRL0002}}】{{LINE0001}}「hello アルファ」', kind: 'dialogue', context: { file: 'Map001.json', speaker: 'unknown' }, tokens: ['{{CTRL0001}}', '{{CTRL0002}}', '{{LINE0001}}'] },
  { id: 'line-2', source: '「hello ガンマ」', translation: '「hello ガンマ」', kind: 'dialogue', context: { file: 'Map001.json', speaker: 'unknown' }, tokens: [] },
];
const namedProvider = async (args) => {
  const payload = args.wire.payload;
  assert.ok(['translation', 'proofreading'].includes(payload.task));
  const records = payload.units.map(unit => {
    let translation = args.role === 'proofreading' ? unit.currentTranslation : `译文 ${unit.source}`;
    const choices = [];
    for (const [source, fallback] of Object.entries(neutralNames)) {
      const entry = payload.glossary.find(entry => entry.source === source);
      const namedField = [...payload.units, ...payload.referenceOnly].find(row => row.kind === 'database_name' && row.source === source
        && row.currentTranslation && row.currentTranslation !== row.source);
      const chosen = entry?.translation ?? namedField?.currentTranslation ?? fallback;
      translation = translation.replaceAll(source, chosen);
      if (!translation.includes(chosen)) for (const alias of [fallback, ...(entry?.aliases ?? [])]) translation = translation.replaceAll(alias, chosen);
      if (unit.source.includes(source) && translation.includes(chosen)) choices.push({ source, translation: chosen });
    }
    if (['database_name', 'database_nickname'].includes(unit.kind)) translation = payload.glossary.find(entry => entry.source === unit.source)?.translation
      ?? (args.role === 'proofreading' ? unit.currentTranslation : neutralNames[unit.source]) ?? translation;
    return { id: unit.id, translation, notes: '中性译名测试', ...(args.role === 'translation' && choices.length ? { termChoices: choices } : {}) };
  });
  if (args.role !== 'proofreading') return { records };
  const edits = records.filter(record => record.translation !== payload.units.find(unit => unit.id === record.id).currentTranslation);
  return { review: { protocol: 'pinhao-review-1', reviewedIds: records.map(record => record.id), edits,
    issues: edits.map(edit => ({ unitId: edit.id, kind: 'correction', resolution: 'fixed', message: '按当前原文和统一译名校对。' })) } };
};
test('initial text supplies term choices and derives shared terminology without prerequisite model tasks', async (t) => {
  const requests = [];
  const { service, gameDir, root } = await fixture(t, { units: namedScene(), provider: async (args) => { requests.push({ role: args.role, payload: args.wire.payload }); return namedProvider(args); } });
  const p = await service.createProject({ gameDir });
  assert.equal(p.total, 3);
  const actor = (await service.listText({ projectId: p.id })).units[0];
  await service.saveText({ projectId: p.id, unitId: actor.id, translation: '甲名', expectedRevision: 0 });
  await service.startProject({ projectId: p.id });
  const done = await eventually(async () => { const value = await service.getProject({ projectId: p.id }); return value.status === 'completed' && value; });
  assert.equal(requests[0].payload.task, 'translation'); assert.equal(requests[0].payload.units.length, 2);
  const translation = requests.find((request) => request.payload.task === 'translation');
  const proof = requests.find((request) => request.payload.task === 'proofreading');
  assert.ok(translation.payload.glossary.some(entry => entry.source === 'アルファ' && entry.translation === '甲名'));
  assert.ok(proof.payload.glossary.some(entry => entry.source === 'アルファ' && entry.translation === '甲名'));
  assert.ok(requests.every(request => !['glossary', 'glossary-repair'].includes(request.payload.task)));
  assert.equal(done.total, 3); assert.equal(done.done, 3);
  const accepted = (await service.listText({ projectId: p.id })).units;
  assert.ok(accepted.slice(1).every(unit => unit.termChoices?.length));
  const filePath = path.join(root, 'glossary-package.zip'); await service.exportPackage({ projectId: p.id, filePath });
  const glossary = JSON.parse(await readFile(path.join(filePath, 'glossary.json'), 'utf8'));
  assert.deepEqual(glossary.map(entry => entry.source).sort(), Object.keys(neutralNames).sort());
  assert.ok(glossary.some(entry => entry.source === 'アルファ' && entry.translation === '甲名'));
  const imported = await service.importPackage({ projectId: p.id, filePath });
  assert.equal(imported.accepted, 0); assert.equal(imported.unchanged, 3);
});
test('continuing accepted dialogue without term alignment does not invent a replacement or buy a repair stage', async (t) => {
  const actor = namedScene()[0];
  const units = [actor, ...Array.from({ length: 32 }, (_, i) => ({ id: `old-${i}`, source: `【${Object.keys(neutralNames)[i % 3]}】{{LINE0001}}「hello」`, translation: `【${Object.keys(neutralNames)[i % 3]}】{{LINE0001}}现有句子${i}。`, kind: 'dialogue', context: { file: 'Map001.json', speaker: 'unknown' }, tokens: ['{{LINE0001}}'] })), ...Array.from({ length: 7 }, (_, i) => ({ id: `safe-${i}`, source: `neutral ${i}`, translation: `安全文字${i}`, kind: 'text', context: { file: 'Map002.json' }, tokens: [] }))];
  const requests = [];
  const { service, gameDir } = await fixture(t, { units, provider: async (args) => { requests.push(args.wire.payload); return namedProvider(args); } });
  await withoutProofreading(service);
  const p = await service.createProject({ gameDir });
  const original = (await service.listText({ projectId: p.id })).units;
  for (const unit of original) await service.saveText({ projectId: p.id, unitId: unit.id, translation: unit.kind === 'database_name' ? '甲名' : unit.translation, notes: '保留原文', expectedRevision: 0, action: 'confirm' });
  await service.startProject({ projectId: p.id });
  const done = await eventually(async () => { const value = await service.getProject({ projectId: p.id }); return value.status === 'completed' && value; });
  assert.equal(requests.length, 0);
  const after = (await service.listText({ projectId: p.id })).units;
  assert.deepEqual(after.map(unit => unit.revision), Array(units.length).fill(1));
  for (let i = 1; i < units.length; i++) assert.equal(after[i].translation, original[i].translation);
  assert.equal(done.total, units.length);
});
test('an untranslated full response still receives only the existing targeted content retry', async (t) => {
  const requests = []; let textCalls = 0;
  const { service, gameDir } = await fixture(t, { units: [namedScene()[1]], provider: async (args) => {
    const payload = args.wire.payload; requests.push(payload);
    if (payload.task === 'translation' && ++textCalls === 1) return { records: payload.units.map((unit) => ({ id: unit.id, translation: unit.source, notes: '保留名字' })) };
    return namedProvider(args);
  } });
  await withoutProofreading(service);
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id });
  await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'completed');
  assert.equal(textCalls, 2); assert.match(requests.find(request => request.repairInstruction)?.repairInstruction, /译文与原文相同/);
  assert.ok(requests.every(request => request.task === 'translation'));
  const [unit] = (await service.listText({ projectId: p.id })).units;
  assert.equal(unit.revision, 1); assert.equal(/ベータ|アルファ/u.test(unit.translation), false);
});
test('a post-translation terminology disagreement remains visible without buying an extra repair stage', async (t) => {
  let calls = 0;
  const units = ['Alice opens the door.', 'Alice waits outside.'].map((source, index) => ({ id: `line-${index}`, source, kind: 'dialogue', tokens: [],
    context: { file: 'OneScene.json', actorId: 1, speaker: 'Alice' } }));
  const { service, gameDir } = await fixture(t, { units, provider: async (args) => {
    const payload = args.wire.payload;
    calls++; assert.equal(payload.task, 'translation');
    return { records: payload.units.map(unit => { const translation = unit.source.includes('opens') ? '爱丽丝' : '艾莉丝';
      return { id: unit.id, translation: `${translation}的完整台词。`, termChoices: [{ source: 'Alice', translation }] }; }) };
  } });
  await withoutProofreading(service);
  const p = await service.createProject({ gameDir });
  await service.startProject({ projectId: p.id });
  const done = await eventually(async () => { const value = await service.getProject({ projectId: p.id }); return value.status === 'completed' && value; });
  assert.equal(calls, 1); assert.equal(done.skipped, 0);
  assert.equal(done.builds[0].checks.find((check) => check.name === '专名与术语一致性').status, 'pending');
  assert.match(done.builds[0].checks.find(check => check.name === '专名与术语一致性').detail, /术语待核对/);
  await service.buildProject({ projectId: p.id });
  assert.equal(calls, 1, 'Building never dispatches an extra terminology model pass');
});
test('ordinary name-bearing text checkpoints survive an API pause and refresh the saved key', async (t) => {
  const requests = []; let fail = true;
  const { service, gameDir } = await fixture(t, { units: [namedScene()[1], namedScene()[2]], provider: async (args) => {
    const payload = args.wire.payload;
    if (payload.task === 'translation') {
      requests.push({ count: payload.units.length, key: args.connection.apiKey });
      if (requests.length === 1) { const response = await namedProvider(args); response.records.pop(); return response; }
      if (fail) { const error = new Error('neutral authorization failure'); error.statusCode = 401; throw error; }
    }
    return namedProvider(args);
  } });
  await withoutProofreading(service);
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id });
  await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'paused');
  const settings = (await service.snapshot()).settings; settings.connection.apiKey = 'updated-neutral-key'; await service.saveSettings(settings);
  fail = false; await service.startProject({ projectId: p.id });
  await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'completed');
  assert.deepEqual(requests.map(request => request.count), [2, 1, 1]); assert.equal(requests.at(-1).key, 'updated-neutral-key');
});
test('a manual typed-name edit during initial translation remains authoritative under text CAS', async (t) => {
  let edited = false;
  const { service, gameDir } = await fixture(t, { units: namedScene(), provider: async (args) => {
    if (args.wire.payload.task === 'translation' && !edited) {
      edited = true; const project = (await service.snapshot()).projects[0];
      const actor = (await service.listText({ projectId: project.id })).units[0];
      await service.saveText({ projectId: project.id, unitId: actor.id, translation: '人工姓名', expectedRevision: actor.revision });
    }
    return namedProvider(args);
  } });
  await withoutProofreading(service);
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id });
  await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'completed');
  const actor = (await service.listText({ projectId: p.id })).units[0];
  assert.equal(actor.translation, '人工姓名'); assert.equal(actor.revision, 1);
});
test('hiragana names are translated alongside complete dialogue without a dedicated terminology call', async (t) => {
  const calls = [];
  const units = [{ id: 'nickname', source: 'はる', translation: 'はる', kind: 'database_nickname', tokens: [], context: { file: 'Actors.json' } }, { id: 'line', source: '【ひかり】{{LINE0001}}「hello はる」', translation: '【ひかり】{{LINE0001}}「hello はる」', kind: 'dialogue', tokens: ['{{LINE0001}}'], context: { file: 'Map001.json' } }];
  const { service, gameDir } = await fixture(t, { units, provider: async (args) => {
    const payload = args.wire.payload;
    assert.equal(payload.task, 'translation'); calls.push(...payload.units.map(unit => unit.id));
    return { records: payload.units.map(unit => {
      const choices = Object.entries({ はる: '晨名', ひかり: '光名' }).filter(([source]) => unit.source.includes(source));
      let translation = `译文 ${unit.source}`; for (const [source, target] of choices) translation = translation.replaceAll(source, target);
      if (unit.kind === 'database_nickname') translation = '晨名';
      return { id: unit.id, translation, termChoices: choices.map(([source, translation]) => ({ source, translation })) };
    }) };
  } });
  await withoutProofreading(service);
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id });
  const done = await eventually(async () => { const value = await service.getProject({ projectId: p.id }); return value.status === 'completed' && value; });
  assert.equal(calls.length, units.length); assert.equal(new Set(calls).size, units.length);
  assert.equal(done.skipped, 0);
  assert.equal((await service.listText({ projectId: p.id })).units.some((unit) => /[\u3041-\u3096]/u.test(unit.translation)), false);
});
test('name-bearing text candidates persist through process close and resume only the outstanding unit', async (t) => {
  let calls = 0, blocked = false;
  const units = [namedScene()[1], namedScene()[2]];
  const { service, gameDir, root } = await fixture(t, { units, provider: async (args) => {
    if (args.wire.payload.task === 'translation') {
      calls++;
      if (calls === 1) { const response = await namedProvider(args); response.records.pop(); return response; }
      blocked = true; await new Promise((_, reject) => args.signal.addEventListener('abort', () => reject(new Error('paused')), { once: true }));
    }
    return namedProvider(args);
  } });
  await withoutProofreading(service);
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id }); await eventually(() => blocked);
  await service.close();
  const resumedRequests = [];
  const resumed = await createService({ dataDir: path.join(root, 'data'), worker: workerFor(units), secrets, technicalProvider, scriptTools: null, provider: async args => {
    const payload = args.wire.payload; assert.equal(payload.task, 'translation'); resumedRequests.push(payload.units.length); return namedProvider(args); } });
  try {
    await resumed.startProject({ projectId: p.id });
    await eventually(async () => (await resumed.getProject({ projectId: p.id })).status === 'completed');
    assert.deepEqual(resumedRequests, [1]);
  } finally { await resumed.close(); }
});
test('an accepted external Actor rename becomes canonical and is not changed back on continue', async (t) => {
  const requests = [];
  const { service, gameDir, root } = await fixture(t, { units: namedScene(), provider: async (args) => { requests.push(args.wire.payload); return namedProvider(args); } });
  await withoutProofreading(service);
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id });
  await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'completed');
  const filePath = path.join(root, 'rename.zip'); await service.exportPackage({ projectId: p.id, filePath });
  const editPath = path.join(filePath, 'editable', 'units.json'); const records = JSON.parse(await readFile(editPath, 'utf8'));
  const actor = (await service.listText({ projectId: p.id })).units[0];
  records.find((record) => record.id === actor.id).translation = '新甲名'; await writeFile(editPath, JSON.stringify(records));
  assert.equal((await service.importPackage({ projectId: p.id, filePath })).accepted, 1);
  requests.length = 0; await service.startProject({ projectId: p.id });
  await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'completed');
  const after = (await service.listText({ projectId: p.id })).units;
  assert.equal(after[0].translation, '新甲名'); assert.ok(after[1].translation.includes('甲名'));
  assert.equal(requests.length, 0, 'A name edit does not buy a hidden global dialogue rewrite');
  await service.startProject({ projectId: p.id, mode: 'proofreading' });
  await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'completed');
  const reviewed = (await service.listText({ projectId: p.id })).units;
  assert.equal(reviewed[0].translation, '新甲名'); assert.ok(reviewed[1].translation.includes('新甲名'));
  assert.ok(requests.length > 0 && requests.every(request => request.task === 'proofreading'));
});
test('a typed-name edit during a scene retry refreshes both shared glossary and references', async (t) => {
  const requests = []; let edited = false;
  const units = namedScene();
  units[0].context.record = 1;
  units[1].context.controlBindings = { '{{CTRL0001}}': '\\N[1]', '{{CTRL0002}}': '\\C[0]', '{{LINE0001}}': '\n' };
  const { service, gameDir } = await fixture(t, { units, provider: async (args) => {
    const payload = args.wire.payload;
    if (payload.task === 'translation') {
      requests.push(payload);
      if (!edited) {
        edited = true; const project = (await service.snapshot()).projects[0]; const actor = (await service.listText({ projectId: project.id })).units[0];
        await service.saveText({ projectId: project.id, unitId: actor.id, translation: '人工新名', expectedRevision: actor.revision });
      }
    }
    return namedProvider(args);
  } });
  await withoutProofreading(service);
  const p = await service.createProject({ gameDir });
  const actor = (await service.listText({ projectId: p.id })).units[0]; await service.saveText({ projectId: p.id, unitId: actor.id, translation: '甲名', expectedRevision: 0 });
  await service.startProject({ projectId: p.id }); await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'completed');
  // Both targets consumed the original glossary/reference, so both need the refreshed evidence.
  assert.deepEqual(requests.map((payload) => payload.units.length), [2, 2]);
  assert.equal(requests[1].glossary.find((entry) => entry.source === 'アルファ').translation, '人工新名');
  assert.equal(requests[1].referenceOnly.find((entry) => entry.source === 'アルファ').currentTranslation, '人工新名');
  assert.ok((await service.listText({ projectId: p.id })).units[1].translation.includes('人工新名'));
});
test('a concurrent manual dialogue edit defeats an in-flight initial name translation without another repair job', async (t) => {
  let calls = 0;
  const { service, gameDir } = await fixture(t, { units: [namedScene()[1]], provider: async (args) => {
    if (args.wire.payload.task === 'translation' && ++calls === 1) {
      const project = (await service.snapshot()).projects[0]; const unit = (await service.listText({ projectId: project.id })).units[0];
      await service.saveText({ projectId: project.id, unitId: unit.id, translation: '【{{CTRL0001}}ベータ{{CTRL0002}}】{{LINE0001}}人工句子。', expectedRevision: unit.revision });
    }
    return namedProvider(args);
  } });
  await withoutProofreading(service);
  const p = await service.createProject({ gameDir }); const unit = (await service.listText({ projectId: p.id })).units[0];
  await service.startProject({ projectId: p.id }); await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'completed');
  const after = (await service.listText({ projectId: p.id })).units[0];
  assert.equal(calls, 1); assert.equal(after.revision, 1); assert.ok(after.translation.includes('人工句子。'));
  assert.ok(after.translation.includes('ベータ'), 'Manual text is not globally replaced by a guessed name alignment');
});
test('persistent provider refusal pauses core task, then model replacement resumes with a cumulative allowance', async (t) => {
  let refuse = true;
  const { service, gameDir } = await fixture(t, { provider: async (args) => { if (!refuse) return provider(args); const error = new Error('模型拒绝该文字'); error.code = 'MODEL_REFUSAL'; throw error; } });
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id });
  const paused = await eventually(async () => { const p2 = await service.getProject({ projectId: p.id }); return p2.status === 'paused' && p2; });
  const spent = paused.tasks.find((task) => task.role === 'translation').attempts;
  assert.equal(spent, 3);
  refuse = false; await service.startProject({ projectId: p.id });
  const completed = await eventually(async () => { const p2 = await service.getProject({ projectId: p.id }); return p2.status === 'completed' && p2; });
  // Resuming after a model replacement must not silently zero the consumed allowance, or a
  // permanently failing project would bill a fresh set of retries on every click.
  const finished = completed.tasks.find((task) => task.role === 'translation');
  assert.ok(finished.attempts >= spent, `attempts stay cumulative across a resume, observed ${finished.attempts} after ${spent}`);
});
test('pause propagates cancellation, preserves revisions and supports continue', async (t) => {
  let block = true, entered = false;
  const { service, gameDir } = await fixture(t, { provider: async (args) => {
    if (!block) return provider(args);
    entered = true;
    await new Promise((_, reject) => args.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id });
  await eventually(() => entered);
  await service.pauseProject({ projectId: p.id });
  await eventually(async () => (await service.getProject({ projectId: p.id })).tasks.find((task) => task.role === 'translation').status === 'paused');
  assert.equal((await service.listText({ projectId: p.id })).units[0].revision, 0);
  block = false; await service.startProject({ projectId: p.id });
  await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'completed');
});
test('all projects share the configured concurrency pool', async (t) => {
  let inFlight = 0, peak = 0;
  const units = Array.from({ length: 64 }, (_, i) => ({ id: `x-${i}`, source: `word ${i}`, translation: `word ${i}`, tokens: [], context: { file: `scene${i}` } }));
  const { service, gameDir } = await fixture(t, { units, provider: async (args) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((resolve) => setTimeout(resolve, 10)); try { return await provider(args); } finally { inFlight--; } } });
  const a = await service.createProject({ gameDir }); const b = await service.createProject({ gameDir });
  await service.startProject({ projectId: a.id }); await service.startProject({ projectId: b.id });
  await eventually(async () => (await service.snapshot()).projects.every((p) => p.status === 'completed'));
  assert.equal(peak, 3);
});

test('preparation failure retries the same project in a new workspace before model configuration', async (t) => {
  const originalWorker = workerFor();
  const attempts = [];
  let fail = true;
  const { service, gameDir } = await fixture(t, { worker: async (command, args) => {
    if (command === 'extract') { attempts.push(args.workspaceDir); if (fail) throw new Error('dependency not ready'); }
    return originalWorker(command, args);
  } });
  const settings = defaultSettings(); await service.saveSettings(settings);
  const p = await service.createProject({ gameDir });
  assert.equal(p.status, 'failed'); assert.equal(p.total, 0);
  fail = false;
  const retried = await service.startProject({ projectId: p.id });
  assert.equal(retried.id, p.id); assert.equal(retried.status, 'ready'); assert.equal(retried.total, 1);
  assert.notEqual(attempts[0], attempts[1]);
  assert.equal((await service.snapshot()).projects.length, 1);
});
test('failed native roundtrip never commits units or permits a build', async (t) => {
  const originalWorker = workerFor();
  const { service, gameDir } = await fixture(t, { worker: async (command, args) => {
    if (command === 'roundtrip') throw new Error('native bytes differ');
    return originalWorker(command, args);
  } });
  const p = await service.createProject({ gameDir });
  assert.equal(p.status, 'failed'); assert.equal(p.total, 0);
  await assert.rejects(service.buildProject({ projectId: p.id }), /完成文本提取与原样回写检查/);
});

test('a new preparation failure never renews its native retry allowance on repeat starts', async (t) => {
  const originalWorker = workerFor();
  let attempts = 0;
  const { service, gameDir } = await fixture(t, { worker: async (command, args) => {
    if (command === 'extract') { attempts++; throw new Error('Neutral dependency remains unavailable'); }
    return originalWorker(command, args);
  } });
  await service.saveSettings(defaultSettings());
  const project = await service.createProject({ gameDir });
  assert.equal(project.status, 'failed');
  assert.equal(attempts, 1);
  await assert.rejects(service.startProject({ projectId: project.id }), /模型|接口|配置|密钥/);
  const afterSecondStart = attempts;
  assert.ok(afterSecondStart >= 2 && afterSecondStart <= 3, `one explicit native retry per revision, observed ${afterSecondStart}`);
  await assert.rejects(service.startProject({ projectId: project.id }), /模型|接口|配置|密钥/);
  // A resumed start must not refill the allowance: the consumed retry stays consumed for this
  // pipeline revision instead of buying another attempt each time the user clicks 继续.
  assert.equal(attempts, afterSecondStart, 'repeated starts retain the consumed native retry for this revision');
  assert.ok(attempts <= 3, `the retry ceiling is never exceeded, observed ${attempts}`);
});
test('all malformed model batches pause instead of announcing a localized original', async (t) => {
  const { service, gameDir } = await fixture(t, { provider: async () => ({ records: [] }) });
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id });
  const stopped = await eventually(async () => { const d = await service.getProject({ projectId: p.id }); return d.status === 'paused' && d; });
  assert.equal(stopped.builds.length, 0); assert.equal(stopped.skipped, stopped.total);
  assert.match(stopped.lastError, /未取得有效译文/);
});
test('unknown optional extensions survive import and re-export byte-for-byte', async (t) => {
  const { service, root, gameDir } = await fixture(t);
  const p = await service.createProject({ gameDir });
  const filePath = path.join(root, 'handoff.zip');
  await service.exportPackage({ projectId: p.id, filePath });
  const content = Buffer.from([0, 1, 255, 4]);
  await mkdir(path.join(filePath, 'vendor')); await writeFile(path.join(filePath, 'vendor', 'reference.bin'), content);
  const manifestPath = path.join(filePath, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.extensions = { 'example.reference': { enabled: true } }; manifest.files['vendor/reference.bin'] = { sha256: sha256(content), mutable: false };
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal((await service.importPackage({ projectId: p.id, filePath })).conflicts.length, 0);
  const second = path.join(root, 'reexport.zip'); await service.exportPackage({ projectId: p.id, filePath: second });
  assert.deepEqual(await readFile(path.join(second, 'vendor', 'reference.bin')), content);
  const extensions = JSON.parse(await readFile(path.join(second, 'manifest.json'), 'utf8')).extensions;
  assert.deepEqual(extensions['example.reference'], manifest.extensions['example.reference']);
  assert.equal(extensions['pinhao.story'].schema, 'pinhao-story-1');
});
test('forged baseline revisions and duplicate returned IDs cannot alter current text', async (t) => {
  const { service, root, gameDir } = await fixture(t);
  const p = await service.createProject({ gameDir }); const filePath = path.join(root, 'handoff.zip');
  await service.exportPackage({ projectId: p.id, filePath });
  const baselinePath = path.join(filePath, 'baseline', 'units.json');
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8')); baseline[0].translation = 'forged';
  const content = JSON.stringify(baseline); await writeFile(baselinePath, content);
  const manifestPath = path.join(filePath, 'manifest.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files['baseline/units.json'].sha256 = sha256(content); await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(service.importPackage({ projectId: p.id, filePath }), /导出基础版本校验失败/);
  const editablePath = path.join(filePath, 'editable', 'units.json');
  const records = JSON.parse(await readFile(editablePath, 'utf8')); records.push(records[0]); await writeFile(editablePath, JSON.stringify(records));
  await assert.rejects(service.importPackage({ projectId: p.id, filePath }), /重复/);
  assert.equal((await service.listText({ projectId: p.id })).units[0].revision, 0);
});
test('restart recovers uncertain tasks as paused and reuses already accepted builds', async (t) => {
  const root = await mkdtemp(path.join(testRoot, 'pinhao-recovery-'));
  const gameDir = path.join(root, 'game'); await mkdir(gameDir);
  const dataDir = path.join(root, 'data');
  const first = await createService({ dataDir, worker: workerFor(), provider, secrets, technicalProvider, scriptTools: null });
  let second;
  t.after(async () => { await first.close(); await second?.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); });
  const settings = defaultSettings(); settings.connection.model = 'test'; await first.saveSettings(settings);
  const p = await first.createProject({ gameDir }); await first.startProject({ projectId: p.id });
  const complete = await eventually(async () => { const d = await first.getProject({ projectId: p.id }); return d.status === 'completed' && d; });
  await first.close();
  const store = createStore(dataDir);
  store.put('projects', { ...store.one('projects', p.id), status: 'running' });
  const task = store.all('tasks', p.id).at(-1); store.putTask(p.id, { ...task, status: 'running' }); store.close();
  let newRequests = 0;
  second = await createService({ dataDir, worker: workerFor(), provider: async () => { newRequests++; throw new Error('Should reuse accepted revisions'); }, secrets, technicalProvider, scriptTools: null });
  const recovered = await second.getProject({ projectId: p.id }); assert.equal(recovered.status, 'paused'); assert(recovered.tasks.some((task) => task.status === 'paused'));
  await second.startProject({ projectId: p.id });
  const done = await eventually(async () => { const d = await second.getProject({ projectId: p.id }); return d.status === 'completed' && d; });
  assert.equal(newRequests, 0); assert.equal(done.builds.at(-1).id, complete.builds.at(-1).id);
});
test('first scene native sample completes before the remaining model batches dispatch', async (t) => {
  const units = [0, 1, 2].map((i) => ({ id: `scene-${i}`, kind: 'message', source: `scene ${i}`, translation: `scene ${i}`, tokens: [], context: { file: `Map00${i}.json`, event: 1 } }));
  const baseWorker = workerFor(units);
  let sampleEntered = false, releaseSample, modelCalls = 0;
  const sampleGate = new Promise((resolve) => { releaseSample = resolve; });
  const { service, gameDir } = await fixture(t, { units, worker: async (command, args) => {
    if (command === 'build' && args.outputDir.includes(`${path.sep}samples${path.sep}`)) { sampleEntered = true; await sampleGate; }
    return baseWorker(command, args);
  }, provider: async (args) => { modelCalls++; return provider(args); } });
  const settings = (await service.snapshot()).settings; settings.proofreading = false; await service.saveSettings(settings);
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id });
  await eventually(() => sampleEntered); assert.equal(modelCalls, 1);
  releaseSample();
  const done = await eventually(async () => { const d = await service.getProject({ projectId: p.id }); return d.status === 'completed' && d; });
  assert.equal(modelCalls, 2); assert(done.issues.some((issue) => issue.category === 'native-sample'));
  assert.equal(done.translated, 3);
  assert.equal(done.builds.length, 1);
});
test('factory catalog reflects installed adapters before a game is imported', async (t) => {
  const expected = [{ id: 'wolf', name: 'WOLF', extract: true, build: true, assist: false, detail: 'Installed native codec' }];
  const base = workerFor();
  const { service } = await fixture(t, { worker: (command, args) => command === 'catalog' ? { engines: expected } : base(command, args) });
  assert.deepEqual((await service.snapshot()).engines, expected);
});

for (const failingRole of ['translation', 'proofreading']) test(`${failingRole} resumes a paused fingerprint with the newly saved API key`, async (t) => {
  const seen = [];
  const respond = async (role, args) => {
    if (role === failingRole) {
      seen.push(args.connection.apiKey);
      if (args.connection.apiKey === 'old-key') { const error = new Error('Invalid API key'); error.statusCode = 401; throw error; }
    }
    return role === 'technical' ? technicalProvider(args) : provider(args);
  };
  const { service, gameDir } = await fixture(t, { provider: (args) => respond(args.role, args), technicalProvider: (args) => respond('technical', args) });
  const initial = (await service.snapshot()).settings; initial.connection.apiKey = 'old-key'; await service.saveSettings(initial);
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id });
  await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'paused');
  const replacement = (await service.snapshot()).settings; replacement.connection.apiKey = 'new-key'; await service.saveSettings(replacement);
  await service.startProject({ projectId: p.id });
  await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'completed');
  assert.deepEqual(seen, ['old-key', 'new-key']);
});

test('verified native work does not require or call a separate technical model', async t => {
  const { service, gameDir } = await fixture(t);
  const settings = (await service.snapshot()).settings;
  settings.roles.technical = { useShared: false, connection: { baseUrl: 'http://127.0.0.1:1/v1', model: '' } };
  await service.saveSettings(settings);
  const p = await service.createProject({ gameDir });
  await service.startProject({ projectId: p.id });
  const done = await eventually(async () => { const d = await service.getProject({ projectId: p.id }); return d.status === 'completed' && d; });
  assert.equal(done.tasks.some(task => task.role === 'technical'), false);
  assert.equal(done.issues.some(issue => issue.category === 'technical-plan'), false);
  assert.equal(done.done, 1);
});
test('native sample failure pauses once and resumes the persisted valid candidate without another model call', async (t) => {
  const native = workerFor();
  let failSample = true, modelCalls = 0, sampleCalls = 0;
  const { service, gameDir } = await fixture(t, { worker: async (command, args) => {
    if (command === 'build' && args.outputDir.includes(`${path.sep}samples${path.sep}`)) { sampleCalls++; if (failSample) throw new Error('native codec unavailable'); }
    return native(command, args);
  }, provider: async (args) => { modelCalls++; return provider(args); } });
  const settings = (await service.snapshot()).settings; settings.proofreading = false; await service.saveSettings(settings);
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id });
  const paused = await eventually(async () => { const d = await service.getProject({ projectId: p.id }); return d.status === 'paused' && d; });
  assert.match(paused.stage, /原生回写/); assert.equal(modelCalls, 1); assert.equal(sampleCalls, 1);
  assert.equal((await service.listText({ projectId: p.id })).units[0].revision, 0);
  assert(paused.issues.some((issue) => issue.category === 'native-sample' && issue.severity === 'error' && !issue.resolvedAt));
  failSample = false; await service.startProject({ projectId: p.id });
  const done = await eventually(async () => { const d = await service.getProject({ projectId: p.id }); return d.status === 'completed' && d; });
  assert.equal(modelCalls, 1); assert.equal(sampleCalls, 2); assert.equal(done.done, 1);
  assert(done.issues.some((issue) => issue.category === 'native-sample' && issue.severity === 'error' && issue.resolvedAt));
});
test('a work package from the previous target language cannot overwrite a retargeted project', async (t) => {
  const { service, root, gameDir } = await fixture(t);
  const p = await service.createProject({ gameDir }); const filePath = path.join(root, 'zh-package.zip');
  await service.exportPackage({ projectId: p.id, filePath });
  const editPath = path.join(filePath, 'editable', 'units.json'); const records = JSON.parse(await readFile(editPath, 'utf8'));
  records[0].translation = '旧语言译文 {{P1}}'; await writeFile(editPath, JSON.stringify(records));
  const settings = (await service.snapshot()).settings; settings.targetLanguage = 'en'; await service.saveSettings(settings);
  await service.startProject({ projectId: p.id }); await service.pauseProject({ projectId: p.id });
  await assert.rejects(service.importPackage({ projectId: p.id, filePath }), /目标语言/);
  assert.equal((await service.listText({ projectId: p.id })).units[0].translation, '你好 {{P1}}');
});
test('queued jobs surviving a provider pause refresh their key on the next run without redoing accepted text', async (t) => {
  const seen = [];
  // Distinct large evidence preserves independent queued requests after shared encoding.
  const units = [0, 1, 2].map((i) => ({ id: `unit-${i}`, kind: 'message', source: `line ${i}`, translation: `line ${i}`, tokens: [], context: { file: `Map00${i}.json`, event: 1, summary: `neutral-${i} `.repeat(1100) } }));
  const { service, gameDir } = await fixture(t, { units, provider: async (args) => {
    const line = args.wire.payload.units[0].source; seen.push([line, args.connection.apiKey]);
    if (line === 'line 1' && args.connection.apiKey === 'old-key') { const error = new Error('Invalid key'); error.statusCode = 401; throw error; }
    return provider(args);
  } });
  const initial = (await service.snapshot()).settings; initial.concurrency = 1; initial.proofreading = false; initial.connection.apiKey = 'old-key'; await service.saveSettings(initial);
  const p = await service.createProject({ gameDir }); await service.startProject({ projectId: p.id });
  await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'paused');
  const replacement = (await service.snapshot()).settings; replacement.connection.apiKey = 'new-key'; await service.saveSettings(replacement);
  await service.startProject({ projectId: p.id }); await eventually(async () => (await service.getProject({ projectId: p.id })).status === 'completed');
  assert.deepEqual(seen, [['line 0', 'old-key'], ['line 1', 'old-key'], ['line 1', 'new-key'], ['line 2', 'new-key']]);
});

function python(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('python', ['-X', 'utf8', ...command], { cwd: path.resolve('.'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject); child.on('close', (code) => { if (code) reject(new Error(stderr || stdout)); else resolve(stdout); });
    child.stdin.end(args === undefined ? undefined : JSON.stringify(args));
  });
}
test('real Python native adapter + AI SDK local HTTP + release and exchange ZIP roundtrip', async (t) => {
  const root = await mkdtemp(path.join(testRoot, 'pinhao-integration-'));
  const gameDir = path.join(root, 'game');
  await python(['-c', `import sys;from pathlib import Path;sys.path.insert(0,'kits/workbench-tutorial/toolkit');from test_rpgmaker import json_game;json_game(Path(sys.argv[1]))`, gameDir]);
  await writeFile(path.join(gameDir, 'Game.exe'), 'test executable placeholder');
  await mkdir(path.join(gameDir, 'js', 'plugins'));
  await writeFile(path.join(gameDir, 'js', 'plugins', 'NeutralUI.js'), "function menu() { this.drawText('Start game', 0, 0); }\n");
  const requests = [], textMaterials = new Map();
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body); requests.push(parsed);
    let message, finishReason = 'stop';
    if (parsed.tools) {
      const available = new Set(parsed.tools.map(item => item.function.name));
      const toolReplies = parsed.messages.filter((item) => item.role === 'tool');
      const calls = new Map(parsed.messages.flatMap(item => item.tool_calls ?? []).map(call => [call.id, call.function.name]));
      const results = new Map(toolReplies.map(item => [calls.get(item.tool_call_id), JSON.parse(item.content)]));
      let name, args;
      if (available.has('inspect_game')) {
        name = toolReplies.length === 0 ? 'inspect_game' : toolReplies.length === 1 ? 'select_recipe' : undefined;
        args = name === 'inspect_game' ? {} : { decision: 'native-with-candidates', summary: '已检查原生配方和脚本候选', selectedCandidateIds: [] };
      } else {
        assert(available.has('inspect_context'), 'The local fixture only handles declared technical tool sets');
        const assignment = JSON.parse(parsed.messages.find(item => item.role === 'user').content).assignment;
        assert.equal(assignment.files.length, 1);
        const file = assignment.files[0];
        if (!toolReplies.length) { name = 'inspect_context'; args = {}; }
        else if (file === 'data/CustomPlugin.json') {
          const cluster = results.get('inspect_context').coverage.unknownClusters.find(item => item.proseLike);
          assert.equal(cluster.field, 'machineKey');
          if (toolReplies.length === 1) { name = 'read_resource'; args = { root:'source', file }; }
          else {
            assert.equal(toolReplies.length, 2);
            assert.equal(JSON.parse(results.get('read_resource').content).machineKey, 'Leave unchanged');
            name = 'record_coverage_decisions';
            args = { decisions: [{ id: cluster.id, evidenceHash: cluster.evidenceHash, disposition: 'non-display',
              reason: 'The neutral fixture declares machineKey as an internal parser key, not displayed text.' }] };
          }
        }
      }
      if (name) {
        assert(available.has(name), `Mock requested an unavailable tool: ${name}`);
        message = { role: 'assistant', content: null, tool_calls: [{ id: `call-${name}-${toolReplies.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
        finishReason = 'tool_calls';
      } else message = { role: 'assistant', content: 'Technical recipe committed.' };
    } else {
      const prompt = parsed.messages.at(-1).content, wire = textMaterials.get(prompt);
      assert.ok(wire, 'The actual SDK request uses its captured current-wire material');
      assert.ok(prompt.startsWith('【待处理文字】'));
      const references = new Map(wire.state.entries.map(([ref, id]) => [id, ref]));
      const text = wire.payload.units.map(unit => [references.get(unit.id), `译${unit.source}`, '']);
      message = { role: 'assistant', content: JSON.stringify({ text }) };
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 'fake-response', object: 'chat.completion', created: 1, model: parsed.model, choices: [{ index: 0, message, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const nativeWorker = async (command, args) => {
    const value = JSON.parse(await python(['adapters/python/worker.py', command], args));
    if (!value.ok) throw new Error(value.error.message);
    return value.result;
  };
  const service = await createService({ dataDir: path.join(root, 'data'), worker: nativeWorker, secrets,
    adaptationProvider: args => runDshAdaptation({ ...args, dsh: { sourceRoot: path.resolve(process.env.PINHAO_DSH_TEST_RUNTIME ?? 'local/dsh-runtime') } }),
    provider: async args => { textMaterials.set(args.prompt, args.wire); return sdkProvider(args); } });
  t.after(async () => { await service.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); });
  const settings = defaultSettings(); settings.connection = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-neutral', apiKey: 'local-provider-fixture' }; settings.proofreading = false;
  settings.pauseOnLocalFailure = true;
  await service.saveSettings(settings);
  const p = await service.createProject({ gameDir });
  assert.equal(p.status, 'ready', p.lastError);
  await service.startProject({ projectId: p.id });
  const done = await eventually(async () => { const d = await service.getProject({ projectId: p.id }); if (d.status === 'paused') throw new Error(d.lastError); return d.status === 'completed' && d; }, 30000);
  assert(requests.length > 0, JSON.stringify(done.issues));
  assert.equal(requests[0].model, 'local-neutral');
  assert(requests.some((request) => request.messages[0].content.includes(ADAPTATION_PROMPT_VERSION)), JSON.stringify({
    requests: requests.length, adaptation: done.adaptationPending,
    tasks: done.tasks.map(task => ({ role: task.role, kind: task.kind, status: task.status, lastError: task.lastError })),
    coverage: done.coverage.summary, clusters: done.coverage.unknownClusters,
  }));
  const technicalRequests = requests.filter(request => request.tools);
  assert.equal(technicalRequests.filter(request => request.tools.some(item => item.function.name === 'inspect_game')).length, 0, 'A verified adapter already supplies the technical plan');
  const resourceRequests = file => technicalRequests.filter(request => JSON.parse(request.messages.find(item => item.role === 'user').content).assignment.files[0] === file);
  assert.equal(resourceRequests('data/CustomPlugin.json').length, 3);
  // NeutralUI.js holds only a literal display call, so scripts.mjs extracts it natively and the byte
  // candidate binds to that unit: the file needs no adaptation job at all.
  assert.equal(resourceRequests('js/plugins/NeutralUI.js').length, 0);
  assert.equal(technicalRequests.length, 3);
  // The persisted coverage keeps its counters, not the bulky candidate arrays.
  assert.equal(done.coverage.summary.unresolvedCandidates, 0, 'a natively extracted literal leaves no pending adaptation candidate');
  assert.equal(done.coverage.summary.adapterCandidates, 0);
  assert.equal(done.coverage.classifiedCandidates.length, 0);
  const boundSite = done.coverage.displaySites.find(site => site.source === 'Start game');
  assert.equal(boundSite.status, 'bound', 'the plugin literal binds to its extracted unit instead of a pending candidate');
  assert.equal(boundSite.requiresAdapter, undefined);
  assert.equal(done.adaptationPending, false);
  assert.equal(done.coverage.unknownClusters.find(item => item.file === 'data/CustomPlugin.json').status, 'non-display');
  assert.equal(done.tasks.find((task) => task.role === 'technical').status, 'succeeded');
  assert.equal(done.builds.length, 1);
  assert((await readFile(path.join(done.builds[0].path, 'js', 'plugins', 'NeutralUI.js'), 'utf8')).includes('译Start game'));
  assert((await readFile(path.join(gameDir, 'js', 'plugins', 'NeutralUI.js'), 'utf8')).includes("'Start game'"));
  const packagePath = path.join(root, 'handoff.zip');
  await service.exportPackage({ projectId: p.id, filePath: packagePath, profile: 'text' });
  assert.equal((await service.importPackage({ projectId: p.id, filePath: packagePath })).accepted, 0);
  const release = path.join(root, 'release.zip');
  await service.exportRelease({ projectId: p.id, filePath: release });
  assert((await readFile(release)).length > 100);
});
