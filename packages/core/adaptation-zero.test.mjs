import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createStore } from './workspace-store.mjs';
import { createService, defaultSettings } from './service.mjs';
import { createAdapterLab } from '../technical/adaptation/adapter-lab.mjs';
import { runAdaptation } from '../technical/adaptation.mjs';
import { sha256 } from '../exchange/index.mjs';

const secrets = { encrypt: value => `test:${Buffer.from(value).toString('base64')}`, decrypt: value => Buffer.from(value.slice(5), 'base64').toString() };
const sourceText = JSON.stringify({ lines: ['A complete hidden scene.'], resource: 'keep.png' });
const file = 'data/story.json';
const manifest = { schemaVersion: 1, id: 'zero-native-json', version: '1.0.0', engine: 'Godot', scope: { files: [file] }, license: 'GPL-3.0-or-later', sources: [] };
const code = `({
detect(host){return {matched:host.list('data').some(item=>item.path==='data/story.json')}},
extract(host){const data=JSON.parse(host.readText('data/story.json'));return {units:data.lines.map((source,index)=>({id:'extra-line:'+index,source,kind:'message',context:{file:'data/story.json'},locator:{file:'data/story.json',pointer:'/lines/'+index}}))}},
validate(){return {valid:true}},roundtrip(host){host.writeBytes('data/story.json',host.readBytes('data/story.json'));return {}},
build(host,input){const data=JSON.parse(host.readText('data/story.json'));for(const unit of input.units)if(Object.hasOwn(input.translations,unit.id))data.lines[Number(unit.id.split(':')[1])]=input.translations[unit.id];host.writeText('data/story.json',JSON.stringify(data));return {}},assemble(){return {}}
})`;

function projectRecord(dataDir, projectId) {
  const db = createStore(dataDir);
  try { return db.one('projects', projectId); }
  finally { db.close(); }
}

async function fixture(t, { rejectRoundtrip = false } = {}) {
  const base = os.tmpdir(), root = await mkdtemp(path.join(base, 'pinhao-zero-native-'));
  const gameDir = path.join(root, 'packed-game'), dataDir = path.join(root, 'app-data');
  await mkdir(path.join(gameDir, 'save'), { recursive: true });
  await writeFile(path.join(gameDir, 'Game.exe'), 'neutral launcher marker');
  await writeFile(path.join(gameDir, 'game.pck'), 'neutral original pack');
  await writeFile(path.join(gameDir, 'save/current.rpgsave'), 'private-save');
  const calls = { extract: 0, roundtrip: 0, build: 0, assemble: 0, model: 0, extractPaths: [] };
  const worker = async (command, args) => {
    if (command === 'catalog') return { engines: [] };
    if (command === 'assistInfo') return { supported: false, modes: [] };
    if (command === 'probe') return { engine: 'Godot', root: '.', capabilities: { extract: true, nativeBuild: true, assist: false, assistModes: [] } };
    if (command === 'extract') {
      calls.extract++; calls.extractPaths.push(args.workspaceDir); assert.equal(args.allowEmpty, true);
      const nativeSource = path.join(args.workspaceDir, 'native-source');
      await mkdir(path.join(nativeSource, 'data'), { recursive: true }); await mkdir(path.join(args.workspaceDir, 'technical'));
      await writeFile(path.join(nativeSource, file), sourceText);
      await writeFile(path.join(args.workspaceDir, 'manifest.json'), JSON.stringify({ units: {}, engine: 'Godot' }));
      await writeFile(path.join(args.workspaceDir, 'technical/product-source.json'), JSON.stringify({ nativeSource }));
      return { ok: true, result: { workspaceDir: args.workspaceDir, units: [], sourceFingerprint: sha256(sourceText), coverage: { resources: [{ file, status: 'unclassified', units: 0 }] } } };
    }
    if (command === 'roundtrip') {
      calls.roundtrip++;
      if (rejectRoundtrip) throw new Error('neutral native roundtrip failed');
      assert.deepEqual(JSON.parse(await readFile(path.join(args.workspaceDir, 'manifest.json'), 'utf8')).units, {});
      return { ok: true, result: { passed: true } };
    }
    if (command === 'validate') { assert.deepEqual(args.translations, []); return { ok: true, result: { valid: true } }; }
    if (command === 'build') {
      calls.build++; assert.deepEqual(args.translations, []);
      await mkdir(path.join(args.outputDir, 'data'), { recursive: true }); await writeFile(path.join(args.outputDir, file), sourceText);
      return { ok: true, result: { buildDir: args.outputDir } };
    }
    if (command === 'assemble') {
      calls.assemble++;
      assert.equal(args.gameDir, gameDir, 'the mature assembler receives the original packed game');
      const overlay = args.adapterOverlayFiles.find(row => row.file === file);
      assert.equal(overlay.sourceHash, sha256(sourceText));
      const translated = await readFile(path.join(args.adapterOverlayDir, file)); assert.equal(overlay.sha256, sha256(translated));
      assert.deepEqual(JSON.parse(translated), { lines: ['译文：A complete hidden scene.'], resource: 'keep.png' });
      await cp(gameDir, args.outputDir, { recursive: true }); await writeFile(path.join(args.outputDir, 'game.pck'), Buffer.concat([Buffer.from('NEUTRAL-PACK\n'), translated]));
      return { ok: true, result: { outputDir: args.outputDir, launchPath: path.join(args.outputDir, 'Game.exe') } };
    }
    throw new Error(`Unexpected native command ${command}`);
  };
  const provider = async ({ role, wire }) => ({ records: wire.payload.units.map(unit => ({ id: unit.id, translation: role === 'proofreading' ? unit.currentTranslation : `译文：${unit.source}`, notes: '' })) });
  const lab = await createAdapterLab({ dataDir: path.join(root, 'recipes'), workspaceFor: ({ projectId }) => projectRecord(dataDir, projectId).workspaceDir });
  const service = await createService({ dataDir, worker, secrets, provider, scriptTools: null, imageTools: null, adapterLab: lab,
    adaptationProvider: args => runAdaptation({ ...args, generate: async ({ tools }) => {
      calls.model++;
      const inventory = await tools.list_files.execute({ root: 'source', recursive: true });
      assert.ok(inventory.files.some(item => item.path === file && item.sourceIndex === 0), 'the primary read source is the mature unpacked resource tree');
      assert.ok(inventory.files.some(item => item.path === 'game.pck' && item.sourceIndex === 1), 'the original pack remains separately discoverable');
      assert.ok(!inventory.files.some(item => item.path.startsWith('save/')), 'original saves remain outside the resource tools');
      const archive = await tools.read_resource.execute({ file: 'game.pck', sourceIndex: 1 });
      assert.equal(archive.content, 'neutral original pack');
      await assert.rejects(access(path.join(args.gameDir, 'game.pck')), { code: 'ENOENT' }, 'the working input contains only the carrier the adapter needs');
      const candidate = await tools.write_adapter.execute({ manifest, code });
      const validation = await tools.validate_adapter.execute({ candidateId: candidate.candidateId }); assert.equal(validation.passed, true, JSON.stringify(validation.error));
      const submitted = await tools.submit_recipe.execute({ candidateId: candidate.candidateId, validationId: validation.validationId, metadata: {} });
      assert.equal(submitted.taskComplete, true, JSON.stringify(submitted));
    } }),
  });
  const settings = defaultSettings(); settings.connection.model = 'neutral-zero-fixture'; settings.connection.apiKey = 'host-test-value'; await service.saveSettings(settings);
  t.after(async () => {
    await service.close();
    const relative = path.relative(base, root);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { root, gameDir, dataDir, service, calls };
}

test('zero-unit native packs keep mature assembly and text but an unverifiable mock container remains pending', async t => {
  const f = await fixture(t);
  const created = await f.service.createProject({ gameDir: f.gameDir });
  assert.equal(created.status, 'failed'); assert.equal(created.total, 0);
  assert.equal(created.adaptationPending, true);
  const prepared = projectRecord(f.dataDir, created.id);
  assert.equal(prepared.prepared, false); assert.equal(prepared.nativePrepared, true);
  assert.ok(path.relative(prepared.workspaceDir, prepared.imageReadRoot) && !path.relative(prepared.workspaceDir, prepared.imageReadRoot).startsWith('..'));
  await f.service.startProject({ projectId: created.id });
  const deadline = Date.now() + 30000;
  let result;
  while (Date.now() < deadline) {
    result = await f.service.getProject({ projectId: created.id });
    if (result.status==='completed'||result.status==='paused'&&result.lanes.build.status==='idle') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(result.status, 'paused', JSON.stringify(result));
  assert.match(result.lastError,/最终成员|可信.*回读/);
  assert.equal(result.builds.length,0,'NEUTRAL-PACK is not an actual verified Godot container');
  assert.equal(result.total, 1); assert.equal(f.calls.extract, 1, 'the current native revision is extracted once'); assert.equal(f.calls.model, 1);
  assert.equal(new Set(f.calls.extractPaths).size, 1);
  for (const extracted of f.calls.extractPaths) {
    const relative = path.relative(prepared.workspaceDir, extracted);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  }
  assert.equal(f.calls.assemble, 1, 'mature pack assembly is used instead of exporting unpacked resources');
  const retained=result.issues.find(issue=>issue.category==='build-validation-artifacts');
  assert.equal(retained.code,'FORMAT_FINAL_VIEW_REQUIRED');
  const product = retained.artifacts.find(artifact=>artifact.id==='output').path;
  assert.match(await readFile(path.join(product, 'game.pck'), 'utf8'), /NEUTRAL-PACK\n.*译文：A complete hidden scene\./s);
  await assert.rejects(access(path.join(product, file)), error => error.code === 'ENOENT');
  assert.equal(await readFile(path.join(f.gameDir, 'game.pck'), 'utf8'), 'neutral original pack');
  assert.equal(await readFile(path.join(f.gameDir, 'save/current.rpgsave'), 'utf8'), 'private-save');
});

test('zero-unit native roundtrip failure keeps the native preparation flag unset', async t => {
  const f = await fixture(t, { rejectRoundtrip: true });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  assert.equal(created.status, 'failed'); assert.match(created.lastError, /native roundtrip failed/);
  const record = projectRecord(f.dataDir, created.id);
  assert.equal(record.prepared, false); assert.notEqual(record.nativePrepared, true);
  assert.equal(f.calls.model, 0); assert.equal(f.calls.assemble, 0);
  assert.equal(await readFile(path.join(f.gameDir, 'game.pck'), 'utf8'), 'neutral original pack');
});
