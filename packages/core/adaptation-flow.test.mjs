import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { sha256 } from '../exchange/index.mjs';
import { createAdapterLab } from '../technical/adaptation/adapter-lab.mjs';
import { runAdaptation } from '../technical/adaptation.mjs';

const root = path.resolve('local', 'adaptation-flow-tests');
await mkdir(root, { recursive: true });
const secrets = { encrypt: value => `test:${Buffer.from(value).toString('base64')}`, decrypt: value => Buffer.from(value.slice(5), 'base64').toString() };
const provider = async ({ wire, role }) => {
  const input = wire.payload;
  return { records: input.units.map(unit => ({ id: unit.id, translation: role === 'proofreading' ? unit.currentTranslation : `译文：${unit.source}`, notes: '' })) };
};
const technicalProvider = async () => ({ decision: 'native-standard', summary: '中性配方检查完成', selectedCandidateIds: [] });

async function until(service, projectId, predicate = project => project.status === 'completed', timeout = 20000) {
  const end = Date.now() + timeout;
  let latest;
  while (Date.now() < end) {
    latest = await service.getProject({ projectId });
    if (predicate(latest)) return latest;
    if (latest.status === 'paused' && predicate !== undefined && latest.lastError) throw new Error(`制作暂停：${latest.lastError}`);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(`等待项目超时：${JSON.stringify(latest)}`);
}

function adapter(file, id = 'extra-scene') {
  const manifest = { schemaVersion: 1, id, version: '1.0.0', engine: 'Neutral Custom Resource', scope: { files: [file] }, license: 'GPL-3.0-or-later', sources: [] };
  const resource = JSON.stringify(file);
  const code = `({detect(host){return {matched:host.list('').some(item=>item.path===${resource})}},extract(host){const data=JSON.parse(host.readText(${resource}));return {units:data.lines.map((source,i)=>({id:'${id}:'+i,source,kind:'message',context:{file:${resource},scene:'neutral'},locator:{file:${resource},pointer:'/lines/'+i}})),coverage:[{file:${resource},status:'extracted'}]}},validate(){return {valid:true}},roundtrip(host){host.writeBytes(${resource},host.readBytes(${resource}));return {}},build(host,input){const data=JSON.parse(host.readText(${resource}));for(const unit of input.units)if(Object.hasOwn(input.translations,unit.id))data.lines[Number(unit.locator.pointer.split('/').pop())]=input.translations[unit.id];host.writeText(${resource},JSON.stringify(data));return {}},assemble(){return {complete:true}}})`;
  return { manifest, code };
}

function nativeWorker({ unknown = false } = {}) {
  return async (command, args) => {
    if (command === 'catalog') return { engines: [] };
    if (command === 'assistInfo') return { supported: false, modes: [] };
    if (command === 'probe') {
      if (unknown) throw Object.assign(new Error('Unknown neutral engine header'), { code: 'UNKNOWN_ENGINE' });
      return { engine: 'RPG Maker MV', root: '.', capabilities: { extract: true, nativeBuild: true, assist: false } };
    }
    if (command === 'extract') {
      const value = JSON.parse(await readFile(path.join(args.gameDir, 'data', 'native.json'), 'utf8'));
      await mkdir(args.workspaceDir, { recursive: true });
      await writeFile(path.join(args.workspaceDir, 'fixture-native-source.json'), JSON.stringify({ gameDir: args.gameDir }));
      const units = value.lines.map((source, index) => ({ id: `native:${index}`, source, kind: 'message', tokens: [], context: { file: 'data/native.json', scene: 'neutral-native' } }));
      await writeFile(path.join(args.workspaceDir, 'manifest.json'), JSON.stringify({ units: Object.fromEntries(units.map(unit => [unit.id, { controls: {} }])) }));
      return { workspaceDir: args.workspaceDir, units, sourceFingerprint: sha256(value), coverage: { resources: [{ file: 'data/native.json', status: 'text_extracted', units: units.length }] } };
    }
    if (command === 'roundtrip' || command === 'validate') return { valid: true, passed: true };
    if (command === 'build') {
      assert.equal(unknown, false, 'unknown engine uses the verified lab build route');
      const source = JSON.parse(await readFile(path.join(args.workspaceDir, 'fixture-native-source.json'), 'utf8'));
      const data = JSON.parse(await readFile(path.join(source.gameDir, 'data', 'native.json'), 'utf8'));
      for (const translation of args.translations) {
        assert.match(translation.id, /^native:/, 'supplemental records stay out of the mature native writer');
        data.lines[Number(translation.id.split(':')[1])] = translation.translation;
      }
      await mkdir(path.join(args.outputDir, 'data'), { recursive: true });
      await writeFile(path.join(args.outputDir, 'data', 'native.json'), JSON.stringify(data));
      return { buildDir: args.outputDir };
    }
    if (command === 'assemble') {
      assert.equal(unknown, false, 'unknown engine uses the verified lab assembler');
      await cp(args.gameDir, args.outputDir, { recursive: true });
      await cp(args.buildDir, args.outputDir, { recursive: true });
      return { outputDir: args.outputDir, launchPath: path.join(args.outputDir, 'Game.exe') };
    }
    throw new Error(`Unexpected native command ${command}`);
  };
}

async function fixture(t, { unknown = false, strict = false, adaptationProvider } = {}) {
  const directory = await mkdtemp(path.join(root, 'flow-'));
  const gameDir = path.join(directory, 'game'), dataDir = path.join(directory, 'app-data'), labDir = path.join(directory, 'recipes');
  await mkdir(path.join(gameDir, 'data'), { recursive: true });
  await mkdir(path.join(gameDir, 'save'));
  await writeFile(path.join(gameDir, 'save', 'private-save.rpgsave'), 'keep-save');
  await writeFile(path.join(gameDir, 'Game.exe'), 'neutral executable marker');
  if (!unknown) await writeFile(path.join(gameDir, 'data', 'native.json'), '{"lines":["A known whole scene."],"logic":{"switch":9}}');
  await writeFile(path.join(gameDir, 'data', 'custom.json'), '{"lines":["A hidden whole scene."],"logic":{"id":"keep"}}');
  const worker = nativeWorker({ unknown });
  const projectFor = ({ projectId }) => {
    const store = createStore(dataDir);
    try { return store.one('projects', projectId); }
    finally { store.close(); }
  };
  const workspaceFor = input => projectFor(input).workspaceDir;
  const create = async () => createService({ dataDir, worker, secrets, provider, technicalProvider, scriptTools: null, imageTools: null, adapterLab: await createAdapterLab({ dataDir: labDir, workspaceFor }), adaptationProvider });
  let service = await create();
  const settings = defaultSettings(); settings.pauseOnLocalFailure = strict; settings.connection.model = 'neutral-fixture'; settings.connection.apiKey = 'host-fixture-key';
  await service.saveSettings(settings);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); });
  return { directory, gameDir, projectFor, get service() { return service; }, reopen: async () => { await service.close(); service = await create(); return service; } };
}

test('unknown engine enters the shared technical queue, repairs an adapter and reuses it after service restart', async t => {
  let modelSessions = 0;
  const selected = adapter('data/custom.json', 'unknown-scene');
  const f = await fixture(t, { unknown: true, adaptationProvider: args => runAdaptation({ ...args, generate: async ({ tools }) => {
    modelSessions++;
    const broken = await tools.write_adapter.execute({ ...selected, code: selected.code.replace("JSON.parse(host.readText", "JSON.parseBROKEN(host.readText") });
    assert.equal((await tools.validate_adapter.execute({ candidateId: broken.candidateId })).passed, false);
    const repaired = await tools.write_adapter.execute(selected);
    const validation = await tools.validate_adapter.execute({ candidateId: repaired.candidateId });
    assert.equal(validation.passed, true, validation.error?.message);
    await tools.submit_recipe.execute({ candidateId: repaired.candidateId, validationId: validation.validationId, metadata: { summary: 'Unknown neutral game text' } });
  } }) });
  const before = await readFile(path.join(f.gameDir, 'data', 'custom.json'));
  const created = await f.service.createProject({ gameDir: f.gameDir });
  assert.equal(created.status, 'failed');
  assert.match(created.lastError, /Unknown neutral engine/);
  await f.service.startProject({ projectId: created.id });
  const completed = await until(f.service, created.id);
  assert.equal(modelSessions, 1);
  assert.equal(completed.total, 1);
  assert.equal(completed.builds.length, 1);
  assert.ok(completed.tasks.some(task => task.role === 'technical' && task.status === 'succeeded'));
  const product = JSON.parse(await readFile(path.join(completed.builds[0].path, 'data', 'custom.json'), 'utf8'));
  assert.deepEqual(product.lines, ['译文：A hidden whole scene.']);
  assert.equal(product.logic.id, 'keep');
  assert.deepEqual(await readFile(path.join(f.gameDir, 'data', 'custom.json')), before);
  assert.equal(await readFile(path.join(f.gameDir, 'save', 'private-save.rpgsave'), 'utf8'), 'keep-save');
  await f.reopen();
  const second = await f.service.createProject({ gameDir: f.gameDir });
  await f.service.startProject({ projectId: second.id });
  const reused = await until(f.service, second.id);
  assert.equal(reused.adaptation.reused, true);
  assert.equal(reused.total, 1);
  assert.equal(modelSessions, 1, 'second import reuses a persisted recipe without another model session');
  const project = f.projectFor({ projectId: second.id }), workDir = project.workspaceDir;
  const binding = JSON.parse(await readFile(path.join(project.workbenchDir, 'pinhao-adapter-binding.json'), 'utf8').then(text => text.trim().split('\n').at(-1)));
  const validation = JSON.parse(await readFile(path.join(workDir, 'technical-lab', 'validations', `${binding.validationId}.json`), 'utf8').then(text => text.trim().split('\n').at(-1)));
  assert.equal(validation.passed, true);
  assert.ok(validation.sample.path.startsWith(path.join(workDir, 'technical-lab', 'runs') + path.sep));
});

test('coverage gaps add a checked supplemental overlay while preserving the mature native writer', async t => {
  const selected = adapter('data/custom.json', 'supplement-scene');
  const f = await fixture(t, { adaptationProvider: args => runAdaptation({ ...args, generate: async ({ tools }) => {
    const context = await tools.inspect_context.execute({});
    assert.ok(context.coverage.triggers.includes('suspected-omission'));
    const candidate = await tools.write_adapter.execute(selected);
    const validation = await tools.validate_adapter.execute({ candidateId: candidate.candidateId });
    await tools.submit_recipe.execute({ candidateId: candidate.candidateId, validationId: validation.validationId, metadata: {} });
  } }) });
  const beforeNative = await readFile(path.join(f.gameDir, 'data', 'native.json'));
  const beforeCustom = await readFile(path.join(f.gameDir, 'data', 'custom.json'));
  const created = await f.service.createProject({ gameDir: f.gameDir });
  assert.equal(created.status, 'ready');
  assert.equal(created.total, 1);
  assert.equal(created.coverage.needsAdaptation, true);
  await f.service.startProject({ projectId: created.id });
  const completed = await until(f.service, created.id);
  assert.equal(completed.engine, 'RPG Maker MV');
  assert.equal(completed.total, 2);
  const productDir = completed.builds[0].path;
  assert.deepEqual(JSON.parse(await readFile(path.join(productDir, 'data', 'native.json'), 'utf8')), { lines: ['译文：A known whole scene.'], logic: { switch: 9 } });
  const custom = JSON.parse(await readFile(path.join(productDir, 'data', 'custom.json'), 'utf8'));
  assert.deepEqual(custom.lines, ['译文：A hidden whole scene.']);
  assert.equal(custom.logic.id, 'keep');
  assert.deepEqual(await readFile(path.join(f.gameDir, 'data', 'native.json')), beforeNative);
  assert.deepEqual(await readFile(path.join(f.gameDir, 'data', 'custom.json')), beforeCustom);
});

test('cancelling adaptation and restarting the service resumes the candidate and retains existing translations', async t => {
  let enter, entered = new Promise(resolve => { enter = resolve; }), sessions = 0;
  const selected = adapter('data/custom.json', 'resume-scene');
  const f = await fixture(t, { adaptationProvider: args => runAdaptation({ ...args, generate: async ({ tools, signal }) => {
    if (++sessions === 1) {
      await tools.write_adapter.execute(selected); enter();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } else {
      const context = await tools.inspect_context.execute({});
      assert.equal(context.progress.attempts, 1);
      const candidateId = context.progress.candidateId;
      assert.equal((await tools.read_adapter.execute({ candidateId })).code, selected.code);
      const validation = await tools.validate_adapter.execute({ candidateId });
      await tools.submit_recipe.execute({ candidateId, validationId: validation.validationId, metadata: {} });
    }
  } }) });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  const native = (await f.service.listText({ projectId: created.id })).units[0];
  await f.service.saveText({ projectId: created.id, unitId: native.id, expectedRevision: native.revision, translation: '已有人工校对成果。', notes: '保留这份成果', action: 'confirm' });
  await f.service.startProject({ projectId: created.id });
  await entered;
  await f.service.cancelProject({ projectId: created.id });
  assert.equal((await f.service.getProject({ projectId: created.id })).status, 'paused');
  await f.reopen();
  const preserved = (await f.service.listText({ projectId: created.id })).units[0];
  assert.equal(preserved.translation, '已有人工校对成果。');
  assert.equal(preserved.notes, '保留这份成果');
  await f.service.startProject({ projectId: created.id });
  const completed = await until(f.service, created.id);
  assert.equal(sessions, 2, JSON.stringify({ adaptation: completed.adaptation, total: completed.total, deferred: completed.adaptationDeferred,
    request: f.projectFor({ projectId: created.id }).adaptationRequest }));
  assert.equal(completed.total, 2);
  const texts = (await f.service.listText({ projectId: created.id })).units;
  assert.equal(texts.find(unit => unit.legacyId === 'native:0').translation, '已有人工校对成果。');
  assert.equal(await readFile(path.join(f.gameDir, 'save', 'private-save.rpgsave'), 'utf8'), 'keep-save');
  const nativeOutput = JSON.parse(await readFile(path.join(completed.builds[0].path, 'data', 'native.json'), 'utf8'));
  assert.deepEqual(nativeOutput.lines, ['已有人工校对成果。']);
});

for (const unknown of [true, false]) test(`remaining uncovered resources keep ${unknown ? 'full' : 'supplemental'} adaptation paused after a valid single-scope recipe`, async t => {
  const selected = adapter('data/custom.json', unknown ? 'partial-full-scene' : 'partial-extra-scene');
  const f = await fixture(t, { unknown, strict: true, adaptationProvider: args => runAdaptation({ ...args, generate: async ({ tools }) => {
    const candidate = await tools.write_adapter.execute(selected);
    const validation = await tools.validate_adapter.execute({ candidateId: candidate.candidateId });
    assert.equal(validation.passed, true, validation.error?.message);
    await tools.submit_recipe.execute({ candidateId: candidate.candidateId, validationId: validation.validationId, metadata: { summary: 'Only the first extra resource is covered' } });
  } }) });
  const missingFile = path.join(f.gameDir, 'data', 'missing.json');
  await writeFile(missingFile, '{"dialogue":["A second uncovered whole scene."],"logic":{"target":"keep-second"}}');
  const beforeMissing = await readFile(missingFile);
  const created = await f.service.createProject({ gameDir: f.gameDir });
  if (!unknown) {
    assert.equal(created.coverage.needsAdaptation, true);
    const native = (await f.service.listText({ projectId: created.id })).units[0];
    await f.service.saveText({ projectId: created.id, unitId: native.id, expectedRevision: native.revision, translation: '已有准确译文。', notes: '保留原有成果', action: 'confirm' });
  }
  await f.service.startProject({ projectId: created.id });
  const terminal = await until(f.service, created.id, project => ['paused', 'failed', 'completed'].includes(project.status));
  assert.equal(terminal.status, 'paused', 'a verified partial recipe cannot mark unresolved resource coverage as completed');
  assert.equal(terminal.coverage.needsAdaptation, true, 'remaining extraction evidence stays attached to the project');
  assert.equal(terminal.builds.length, 0, 'a partial extraction stays in the technical stage');
  assert.deepEqual(await readFile(missingFile), beforeMissing);
  assert.equal(await readFile(path.join(f.gameDir, 'save', 'private-save.rpgsave'), 'utf8'), 'keep-save');
  if (!unknown) assert.equal((await f.service.listText({ projectId: created.id })).units.find(unit => unit.legacyId === 'native:0').translation, '已有准确译文。');
});
