import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { sha256 } from '../exchange/index.mjs';
import { createAdapterLab } from '../technical/adaptation/adapter-lab.mjs';
import { readJson as readAdapterRecord } from '../technical/adaptation/paths.mjs';
import { runAdaptation } from '../technical/adaptation.mjs';

const parent = path.resolve('local/build-repair-flow-tests');
await mkdir(parent, { recursive: true });
const file = 'data/custom.json';
const source = { lines: ['A first complete scene.', 'A second complete scene.'], logic: { switchId: 9, resource: 'keep.png' } };
const translations = ['第一条正式译文', '第二条正式译文'];

function adapter(repaired) {
  return {
    manifest: { schemaVersion: 1, id: 'neutral-build-writer', version: repaired ? '1.0.1' : '1.0.0', engine: 'Neutral JSON Game',
      scope: { files: [file] }, license: 'GPL-3.0-or-later', sources: [] },
    code: `({detect(host){return {matched:host.list('').some(item=>item.path==='${file}')}},
      extract(host){const data=JSON.parse(host.readText('${file}'));return {units:data.lines.map((source,i)=>({
        id:'neutral-line:'+i,source,kind:'message',context:{file:'${file}',scene:i},
        locator:{file:'${file}',pointer:'/lines/'+i}})),coverage:[{file:'${file}',status:'extracted'}]}},
      validate(){return {valid:true}},roundtrip(host){host.writeBytes('${file}',host.readBytes('${file}'));return {}},
      build(host,input){const data=JSON.parse(host.readText('${file}'));
        ${repaired ? '' : `if(Object.keys(input.translations).length>1&&Object.values(input.translations).includes('${translations[1]}'))throw new Error('Neutral final combination needs a writer repair');`}
        for(const unit of input.units)if(Object.hasOwn(input.translations,unit.id))data.lines[Number(unit.locator.pointer.split('/').pop())]=input.translations[unit.id];
        host.writeText('${file}',JSON.stringify(data));return {}},assemble(){return {complete:true}}})`,
  };
}

async function waitForCompletion(service, projectId) {
  let latest;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    latest = await service.getProject({ projectId });
    if (['completed', 'paused', 'failed'].includes(latest.status)) return latest;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Neutral build-repair flow timed out: ${JSON.stringify(latest)}`);
}

const repairCases = [false, true].flatMap(composite => [true, false].map(repairSucceeds => ({ composite, repairSucceeds })));
repairCases.push({ composite: false, repairSucceeds: true, repeatBinding: true });

for (const { composite, repairSucceeds, repeatBinding } of repairCases) test(repeatBinding
  ? 'a real repair reads repeated current binding journal records while preserving accepted text'
  : repairSucceeds
  ? `a real repair replaces the ${composite ? 'composite' : 'main'} writer binding while preserving accepted text`
  : `an incomplete ${composite ? 'composite' : 'main'} writer repair preserves its pending request without rerunning the failed writer`, { timeout: 45000 }, async t => {
  const root = await mkdtemp(path.join(parent, composite ? 'composite-' : 'main-'));
  const gameDir = path.join(root, 'original'), dataDir = path.join(root, 'profile');
  await mkdir(path.join(gameDir, 'data'), { recursive: true });
  await writeFile(path.join(gameDir, file), JSON.stringify(source));
  await writeFile(path.join(gameDir, 'Game.exe'), 'neutral executable marker');
  if (composite) await writeFile(path.join(gameDir, 'data/native.json'), JSON.stringify({ lines: ['A native whole scene.'], logic: { itemId: 4 } }));
  const original = await readFile(path.join(gameDir, file));
  const lab = await createAdapterLab({ dataDir: path.join(root, 'recipes') });
  let repeatedBinding = false;
  const extractRecipe = lab.extractRecipe.bind(lab);
  lab.extractRecipe = async args => {
    const extraction = await extractRecipe(args);
    if (repeatBinding && !repeatedBinding) {
      repeatedBinding = true;
      await extractRecipe(args);
      const journal = await readFile(path.join(args.workspaceDir, 'pinhao-adapter-binding.json'), 'utf8');
      const records = journal.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
      assert.equal(records.length, 2, 'The real Lab rebind appends two complete current-format records');
      assert.deepEqual(records[0], records[1]);
      assert.throws(() => JSON.parse(journal), SyntaxError, 'Repair must use the current journal reader, not whole-file JSON.parse');
    }
    return extraction;
  };
  const finalDispatches = [];
  const dispatch = lab.dispatch.bind(lab);
  lab.dispatch = async (command, args, signal) => {
    if (command === 'build' && args.translations?.length > 1 && args.translations.some(row => row.translation === translations[1])) {
      const binding = await readAdapterRecord(path.join(args.workspaceDir, 'pinhao-adapter-binding.json'));
      finalDispatches.push(binding.candidateId);
    }
    return dispatch(command, args, signal);
  };
  const repairSnapshots = [];
  const candidates = [];
  const requests = [];
  const readState = () => {
    const store = createStore(dataDir);
    try { return { project: store.one('projects', projectId), units: store.units(projectId) }; }
    finally { store.close(); }
  };
  let projectId;
  const worker = async (command, args) => {
    if (command === 'catalog') return {};
    if (command === 'assistInfo') return { supported: false, modes: [] };
    if (command === 'probe') {
      if (!composite) throw Object.assign(new Error('Unknown neutral JSON engine'), { code: 'UNKNOWN_ENGINE' });
      return { engine: 'RPG Maker MV', root: '.', capabilities: { extract: true, nativeBuild: true, assist: false } };
    }
    if (command === 'extract') {
      assert.equal(composite, true);
      await mkdir(args.workspaceDir, { recursive: true });
      await writeFile(path.join(args.workspaceDir, 'native-root.json'), JSON.stringify({ gameDir: args.gameDir }));
      await writeFile(path.join(args.workspaceDir, 'manifest.json'), JSON.stringify({ units: { 'native:0': { controls: {} } } }));
      return { workspaceDir: args.workspaceDir, sourceFingerprint: sha256('neutral-native-v1'),
        units: [{ id: 'native:0', source: 'A native whole scene.', kind: 'message', tokens: [], context: { file: 'data/native.json', scene: 'native' } }],
        coverage: { resources: [{ file: 'data/native.json', status: 'text_extracted', units: 1 }] } };
    }
    if (['roundtrip', 'validate'].includes(command)) return { valid: true };
    if (command === 'build') {
      assert.equal(composite, true, 'The main generated binding must dispatch through the real lab');
      assert.ok(args.translations.every(row => row.id === 'native:0'), 'Supplemental translations belong to their verified writer');
      await mkdir(path.join(args.outputDir, 'data'), { recursive: true });
      const originalRoot = JSON.parse(await readFile(path.join(args.workspaceDir, 'native-root.json'), 'utf8'));
      const native = JSON.parse(await readFile(path.join(originalRoot.gameDir, 'data/native.json'), 'utf8'));
      if (args.translations.length) native.lines[0] = args.translations[0].translation;
      await writeFile(path.join(args.outputDir, 'data/native.json'), JSON.stringify(native));
      return { buildDir: args.outputDir };
    }
    if (command === 'assemble') {
      assert.equal(composite, true);
      await cp(args.gameDir, args.outputDir, { recursive: true });
      await cp(args.buildDir, args.outputDir, { recursive: true });
      return { outputDir: args.outputDir, launchPath: path.join(args.outputDir, 'Game.exe') };
    }
    throw new Error(`Unexpected neutral command ${command}`);
  };
  const service = await createService({ dataDir, worker, adapterLab: lab, scriptTools: null, imageTools: null,
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral verified preparation' }),
    provider: async ({ wire }) => {
      const payload = wire.payload;
      requests.push(...payload.units.map(unit => unit.id));
      return { records: payload.units.map(unit => ({ id: unit.id,
        translation: unit.source.startsWith('A native') ? '保留原生译文' : translations[unit.source === source.lines[1] ? 1 : 0], notes: '保留已接受备注' })) };
    },
    adaptationProvider: args => runAdaptation({ ...args, generate: async ({ tools }) => {
      const context = await tools.inspect_context.execute({});
      const repairing = context.failure?.code === 'NATIVE_BUILD_FAILED';
      if (repairing) {
        const snapshot = readState(); repairSnapshots.push(snapshot);
        const failure = await tools.read_failure.execute({});
        assert.equal(failure.failure.repairBundle.phase, 'build');
        assert.match(failure.failure.repairBundle.error, /Neutral final combination/);
        assert.equal(snapshot.project.sampleValidation.nativeStructure, 'passed');
        assert.ok(snapshot.units.every(unit => unit.status === 'translated'));
        if (!repairSucceeds) throw new Error('Neutral repair needs more evidence');
      }
      const candidate = await tools.write_adapter.execute(adapter(repairing));
      const validation = await tools.validate_adapter.execute({ candidateId: candidate.candidateId });
      assert.equal(validation.passed, true, validation.error?.message);
      candidates.push(candidate.candidateId);
      await tools.submit_recipe.execute({ candidateId: candidate.candidateId, validationId: validation.validationId, metadata: { summary: 'Neutral writer repair' } });
    } }) });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  await service.saveSettings({ ...defaultSettings(), proofreading: false, concurrency: 1, connection: { baseUrl: 'http://localhost:1/v1', model: 'neutral' } });
  const created = await service.createProject({ gameDir }); projectId = created.id;
  await service.startProject({ projectId });
  const completed = await waitForCompletion(service, projectId);
  const current = readState();
  if (!repairSucceeds) {
    assert.equal(completed.status, 'paused', completed.lastError);
    assert.equal(repairSnapshots.length, 1);
    assert.equal(candidates.length, 1);
    assert.deepEqual(finalDispatches, [candidates[0]], 'The same failed final writer must wait for a verified repair');
    assert.equal(completed.builds.length, 0);
    assert.equal(current.project.adaptationRequest.kind, 'build-repair');
    assert.equal(current.project.buildRepair.attempts, 1);
    assert.ok(current.project.buildRepair.path);
    assert.deepEqual(current.units, repairSnapshots[0].units);
    assert.equal(new Set(requests).size, requests.length);
    assert.deepEqual(await readFile(path.join(gameDir, file)), original);
    return;
  }
  assert.equal(completed.status, 'completed', JSON.stringify({ stage: completed.stage, error: completed.lastError,
    repairs: repairSnapshots.length, candidates, tasks: completed.tasks, issues: completed.issues }));
  assert.equal(repairSnapshots.length, 1, 'The late failure must enter one actual repair model session');
  if (repeatBinding) assert.equal(repeatedBinding, true);
  assert.equal(candidates.length, 2); assert.notEqual(candidates[0], candidates[1]);
  assert.deepEqual(current.units, repairSnapshots[0].units, 'Repair changes the writer, not stable IDs, accepted translations, notes or revisions');
  assert.equal(new Set(requests).size, requests.length, 'A repaired writer must reuse the already accepted text');
  assert.equal(current.project.buildRepair.attempts, 1);
  const activeBinding = composite
    ? JSON.parse(await readFile(path.join(current.project.workbenchDir, current.project.publication.compositeManifestRef.file), 'utf8')).adapters[0].workspaceDir
    : current.project.workbenchDir;
  const binding = JSON.parse(await readFile(path.join(activeBinding, 'pinhao-adapter-binding.json'), 'utf8'));
  assert.equal(binding.candidateId, candidates[1], 'The final product must dispatch through the replacement candidate');
  assert.deepEqual(finalDispatches, candidates, 'The original final build fails once, then the replacement succeeds');
  const product = JSON.parse(await readFile(path.join(completed.builds.at(-1).path, file), 'utf8'));
  assert.deepEqual(product, { ...source, lines: translations });
  if (composite) assert.deepEqual(JSON.parse(await readFile(path.join(completed.builds.at(-1).path, 'data/native.json'), 'utf8')),
    { lines: ['保留原生译文'], logic: { itemId: 4 } });
  assert.deepEqual(await readFile(path.join(gameDir, file)), original);
});
