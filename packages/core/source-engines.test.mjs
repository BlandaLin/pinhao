import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createService, defaultSettings, groupUnits } from './service.mjs';
import { productWorker } from '../../apps/desktop/electron/host.mjs';
import { sha256, validateTranslation } from '../exchange/index.mjs';

const testRoot = path.resolve('local/source-engine-core-tests');
await mkdir(testRoot, { recursive: true });
const bundledPython = path.resolve('local/runtime/python/python.exe');
const pythonPath = await access(bundledPython).then(() => bundledPython, () => 'python');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = promisify(execFile);
async function pythonFixture(code, args) {
  await run(pythonPath, ['-B', '-c', `import sys;sys.path[:0]=['adapters/python','kits/workbench-tutorial/toolkit'];${code}`, ...args], { windowsHide: true });
}
async function hashes(directory, relative = '') {
  const entries = {};
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const file = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(entries, await hashes(directory, file));
    else entries[file] = sha256(await readFile(path.join(directory, file)));
  }
  return entries;
}
async function fixture(t, files) {
  const root = await mkdtemp(path.join(testRoot, 'native-'));
  const gameDir = path.join(root, 'original');
  for (const [name, content] of Object.entries({ 'Game.exe': 'neutral executable fixture', 'save/file1.save': 'private fixture', ...files })) {
    const file = path.join(gameDir, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content);
  }
  const requests = [], nativeCalls = [];
  const native = productWorker({ pythonPath, workerPath: path.resolve('adapters/python/worker.py'), toolkitPath: path.resolve('kits/workbench-tutorial/toolkit'), dependencyDir: path.resolve('local/dependencies'), timeoutMs: 60000 });
  const worker = async (command, args, options) => { nativeCalls.push(command); return native(command, args, options); };
  const service = await createService({ dataDir: path.join(root, 'data'), worker, scriptTools: null, technicalProvider: async () => ({ decision: 'native', summary: 'Neutral native recipe fixture' }), provider: async ({ role, wire }) => {
    const payload = wire.payload; requests.push({ role, payload });
    const records = payload.units.map((unit) => {
      let translation;
      if (['display_name', 'speaker_name', 'database_name', 'database_nickname'].includes(unit.kind)) translation = payload.glossary.find((entry) => entry.source === unit.source)?.translation ?? '林';
      else translation = role === 'proofreading' ? unit.currentTranslation : `译文 ${unit.source}`;
      for (const entry of payload.glossary ?? []) translation = translation.replaceAll(entry.source, entry.translation);
      return { id: unit.id, translation, notes: '' };
    });
    return { records };
  } });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  await service.saveSettings({ ...defaultSettings(), connection: { baseUrl: 'http://localhost:1/v1', model: 'injected-neutral-provider' } });
  return { root, gameDir, requests, nativeCalls, service };
}
async function pipeline(f) {
  const before = await hashes(f.gameDir);
  const project = await f.service.createProject({ gameDir: f.gameDir });
  assert.equal(project.status, 'ready', project.lastError);
  const baseline = (await f.service.listText({ projectId: project.id })).units;
  baseline.forEach((unit) => validateTranslation(unit, unit.translation));
  await f.service.startProject({ projectId: project.id });
  const deadline = Date.now() + 60000;
  let complete;
  while (Date.now() < deadline) {
    const detail = await f.service.getProject({ projectId: project.id });
    if (['paused', 'failed'].includes(detail.status)) throw new Error(`${detail.stage}: ${detail.lastError}`);
    if (detail.status === 'completed') { complete = detail; break; }
    await wait(15);
  }
  assert.ok(complete, 'Native source fixture did not complete');
  assert.equal(complete.skipped, 0, JSON.stringify(complete.issues));
  const units = (await f.service.listText({ projectId: project.id })).units;
  assert.ok(units.every((unit) => unit.status === 'proofread'));
  for (const unit of units) {
    validateTranslation(unit, unit.translation);
    assert.deepEqual(unit.translation.match(/\{\{[^{}]+\}\}/g) ?? [], unit.tokens);
    assert.equal(unit.sourceHash, baseline.find((old) => old.id === unit.id).sourceHash);
  }
  assert.equal(complete.builds.length, 1);
  assert.ok(f.nativeCalls.includes('roundtrip')); assert.ok(f.nativeCalls.includes('assemble'));
  assert.ok(f.nativeCalls.filter((command) => command === 'build').length >= 2, 'Includes first-scene native build and final build');
  assert.ok(f.requests.some((request) => request.role === 'translation')); assert.ok(f.requests.some((request) => request.role === 'proofreading'));
  const output = complete.builds[0].path;
  await assert.rejects(access(path.join(output, 'save/file1.save')), { code: 'ENOENT' });
  assert.deepEqual(await hashes(f.gameDir), before);
  const handoff = path.join(f.root, 'handoff.zip');
  await f.service.exportPackage({ projectId: project.id, filePath: handoff, profile: 'text' });
  assert.equal((await f.service.importPackage({ projectId: project.id, filePath: handoff })).accepted, 0);
  return { project, baseline, units, output, complete };
}

test('shared display groups stay atomic across files without losing neighboring scene units', () => {
  const make = (id, file, syncGroup) => ({ id, source: `neutral ${id}`, translation: '', context: { file, ...(syncGroup ? { syncGroup } : {}) } });
  const units = [make('title-info', 'info.json', 'title'), make('scene-a', 'project.json'), make('scene-b', 'other.json'), make('title-project', 'project.json', 'title'), make('scene-c', 'other.json')];
  const groups = groupUnits(units);
  const titles = groups.find((group) => group.some((unit) => unit.id === 'title-info'));
  assert.ok(titles.some((unit) => unit.id === 'title-project'));
  assert.equal(groups.filter((group) => group.some((unit) => unit.context.syncGroup === 'title')).length, 1);
  assert.deepEqual(groups.flat().map((unit) => unit.id).sort(), units.map((unit) => unit.id).sort());
  for (const group of groups.filter((group) => !group.some((unit) => unit.context.syncGroup))) assert.equal(new Set(group.map((unit) => unit.context.file)).size, 1);
});

test('shared display groups remain indivisible when they exceed the normal batch size', () => {
  const units = Array.from({ length: 19 }, (_, index) => ({ id: `linked-${index}`, source: 'neutral', translation: '', context: { file: `file-${index}`, syncGroup: 'linked-display' } }));
  assert.deepEqual(groupUnits(units).map((group) => group.length), [19]);
});

test('core + productWorker builds Tyrano jname, complete paragraphs and native controls', async (t) => {
  const source = '*start\n[chara_new name="lin" jname="Lin" storage="lin.png"]\n#lin:happy\nFirst line\nSecond line[r]Done[p]\n[glink text="Continue" target="*next"]\n[iscript]\nf.label="internal";\n[endscript]\n';
  const f = await fixture(t, { 'tyrano/tyrano.js': '// neutral marker', 'index.html': '<html><head></head><body></body></html>', 'data/scenario/first.ks': source, 'data/fgimage/lin.png': 'neutral asset bytes' });
  const result = await pipeline(f);
  assert.equal(result.project.engine, 'TyranoScript');
  assert.ok(result.baseline.some((unit) => unit.kind === 'display_name' && unit.source === 'Lin'));
  assert.ok(result.baseline.some((unit) => unit.source.startsWith('First line{{CTRL') && unit.source.includes('Second line')));
  const output = await readFile(path.join(result.output, 'data/scenario/first.ks'), 'utf8');
  assert.match(output, /name="lin" jname="林" storage="lin\.png"/);
  assert.ok(output.includes('#lin:happy')); assert.ok(output.includes('target="*next"')); assert.ok(output.includes('f.label="internal";'));
  assert.ok(output.includes('译文 First line\nSecond line[r]Done[p]'));
  assert.ok(output.includes('text="译文 Continue"'));
  assert.equal(await readFile(path.join(result.output, 'data/fgimage/lin.png'), 'utf8'), 'neutral asset bytes');
  assert.equal(f.requests.filter((request) => request.payload.task === 'glossary').length, 0);
  const nameTargets = f.requests.filter(request => request.role === 'translation').flatMap(request => request.payload.units)
    .filter(unit => unit.kind === 'display_name' && unit.source === 'Lin');
  assert.deepEqual(nameTargets.map(unit => unit.id), [result.baseline.find(unit => unit.kind === 'display_name' && unit.source === 'Lin').id]);
});

test('core + productWorker builds RenPy variables, markup and menu while preserving code and asset paths', async (t) => {
  const source = 'define lin = Character("Lin")\nimage bg = "images/back.png"\ninit python:\n    internal = "private-key-name"\nlabel start:\n    lin "Hello [player]. {b}Welcome{/b}"\n    menu:\n        "Enter" if ready:\n            jump house\nscreen controls():\n    textbutton _("Continue") action Return()\n    imagebutton:\n        idle "gui/start_idle.png"\n        hover "gui/start_hover.png"\n';
  const f = await fixture(t, { 'game/script.rpy': source, 'game/script.rpyc': 'obsolete compiled fixture', 'game/images/back.png': 'neutral background', 'game/gui/start_idle.png': 'neutral button', 'game/tl/other/script.rpy': 'translate other start:\n    "Other language"\n' });
  const result = await pipeline(f);
  assert.equal(result.project.engine, "Ren'Py");
  assert.ok(result.baseline.some((unit) => unit.kind === 'speaker_name' && unit.source === 'Lin'));
  assert.ok(result.baseline.some((unit) => unit.kind === 'dialogue' && unit.tokens.length === 3));
  assert.ok(!result.baseline.some((unit) => /private-key-name|images\/|gui\/|Other language/.test(unit.source)));
  const output = await readFile(path.join(result.output, 'game/script.rpy'), 'utf8');
  assert.ok(output.includes('Character("林")')); assert.ok(output.includes('译文 Hello [player]. {b}Welcome{/b}'));
  assert.ok(output.includes('"译文 Enter" if ready:')); assert.ok(output.includes('jump house')); assert.ok(output.includes('action Return()'));
  assert.ok(output.includes('internal = "private-key-name"')); assert.ok(output.includes('idle "gui/start_idle.png"'));
  assert.equal(await readFile(path.join(result.output, 'game/images/back.png'), 'utf8'), 'neutral background');
  await assert.rejects(access(path.join(result.output, 'game/script.rpyc')), { code: 'ENOENT' });
});

test('core + productWorker retains translated Godot source work when its matching runtime is absent', async (t) => {
  if (!(await access(path.resolve('local/dependencies/gdre/gdre_tools.exe')).then(() => true, () => false))) return t.skip('Prepare the fixed GDRETools dependency first');
  const source = '[gd_scene format=3]\n[ext_resource path="res://script.gd" id="1"]\n[node name="Menu" type="Control"]\ntext = "Continue"\nresource_name = "internal-id"\n[node name="Story" type="RichTextLabel"]\ntext = "Welcome [b]friend[/b]"\n';
  const f = await fixture(t, { 'project.godot': 'config_version=5\n', 'menu.tscn': source, 'script.gd': 'extends Control\n' });
  const before = await hashes(f.gameDir);
  const project = await f.service.createProject({ gameDir: f.gameDir });
  assert.equal(project.engine, 'Godot'); assert.equal(project.status, 'ready', project.lastError);
  await f.service.startProject({ projectId: project.id });
  let detail;
  const deadline = Date.now() + 60_000;
  do {
    detail = await f.service.getProject({ projectId: project.id });
    if (['paused', 'failed', 'completed'].includes(detail.status)) break;
    await wait(20);
  } while (Date.now() < deadline);
  assert.equal(detail.status, 'paused', JSON.stringify(detail));
  assert.match(detail.lastError, /matching Godot runtime/);
  assert.equal(detail.builds.length, 0);
  const units = (await f.service.listText({ projectId: project.id })).units;
  assert.equal(units.length, 2);
  assert.ok(units.every(unit => unit.status === 'proofread'));
  for (const unit of units) validateTranslation(unit, unit.translation);
  assert.deepEqual(await hashes(f.gameDir), before);
});

test('core + productWorker rebuilds an XP3 into its original native carrier', async t => {
  const f = await fixture(t, { 'fixture.ks': '*start\nWelcome[r]friend[p]\n', 'asset.bin': 'neutral asset' });
  await pythonFixture('from pathlib import Path;import xp3_archive as x;p=Path(sys.argv[1]);x.pack(p/"data.xp3",[("scenario/first.ks",p/"fixture.ks"),("image/asset.bin",p/"asset.bin")]);(p/"fixture.ks").unlink();(p/"asset.bin").unlink()', [f.gameDir]);
  const result = await pipeline(f);
  assert.equal(result.project.engine, 'KiriKiri/KAG');
  const readback = path.join(f.root, 'readback');
  await pythonFixture('from pathlib import Path;import xp3_archive as x;import worker;x.unpack(Path(sys.argv[1]),Path(sys.argv[2]),worker)', [path.join(result.output, 'data.xp3'), readback]);
  assert.ok((await readFile(path.join(readback, 'scenario/first.ks'), 'utf16le')).includes('译文 Welcome[r]friend[p]'));
  assert.equal(await readFile(path.join(readback, 'image/asset.bin'), 'utf8'), 'neutral asset');
});

test('core + productWorker recovers RPYC-only scripts before translation and standalone assembly', async t => {
  const f = await fixture(t, { 'game/placeholder.txt': 'neutral' });
  await pythonFixture('from pathlib import Path;from test_renpy_native import compiled_fixture;Path(sys.argv[1],"game/script.rpyc").write_bytes(compiled_fixture())', [f.gameDir]);
  const result = await pipeline(f);
  assert.equal(result.project.engine, "Ren'Py");
  assert.equal(result.baseline.length, 1);
  assert.ok((await readFile(path.join(result.output, 'game/script.rpy'), 'utf8')).includes('译文 Welcome [player_name].'));
  await assert.rejects(access(path.join(result.output, 'game/script.rpyc')), { code: 'ENOENT' });
});

test('core + productWorker builds PGMM synchronized titles and text without changing scene or resource IDs', async (t) => {
  const source = { textList: [{ id: 8, name: 'InternalLabel', folder: false, text: { ja_JP: 'Welcome' } }], gameInformation: { title: 'Neutral' }, sceneList: [{ id: 1 }] };
  const f = await fixture(t, { 'project.json': JSON.stringify(source), 'info.json': '{"title":"Neutral"}' });
  const result = await pipeline(f);
  assert.equal(result.project.engine, 'Pixel Game Maker MV');
  const output = JSON.parse(await readFile(path.join(result.output, 'project.json'), 'utf8'));
  assert.equal(output.textList[0].text.ja_JP, '译文 Welcome'); assert.equal(output.gameInformation.title, '译文 Neutral');
  assert.equal(JSON.parse(await readFile(path.join(result.output, 'info.json'), 'utf8')).title, output.gameInformation.title);
  assert.equal(output.textList[0].id, 8); assert.equal(output.textList[0].name, 'InternalLabel'); assert.deepEqual(output.sceneList, source.sceneList);
});

test('core + productWorker exports a completed MV build as JoiPlay RGA', async t => {
  const f = await fixture(t, {});
  await pythonFixture('from pathlib import Path;from test_rpgmaker import json_game;p=json_game(Path(sys.argv[1]));(p/"index.html").write_text("<html>neutral entry</html>",encoding="utf-8")', [f.gameDir]);
  const result = await pipeline(f);
  const filePath = path.join(f.root, 'neutral-game-JoiPlay.rga');
  const exported = await f.service.exportRelease({ projectId: result.project.id, filePath, target: 'joiplay' });
  assert.equal(exported.path, filePath);
  assert.deepEqual(exported.warnings, []);
  assert.ok(f.nativeCalls.includes('mobileZip'));
  await pythonFixture('import zipfile,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;assert "execFile=index.html" in z.read("game.cfg").decode();assert "type=html" in z.read("game.cfg").decode();assert "Game.exe" not in z.namelist();assert "save/file1.save" not in z.namelist();assert json.loads(z.read("PinHao-mobile-report.json"))["phoneRuntimeVerified"] is False', [filePath]);
});

for (const bundle of [false, true]) test(`core + productWorker rebuilds Unity ${bundle ? 'UnityFS' : 'SerializedFile'} text into its native carrier`, async t => {
  if (!(await access(path.resolve('local/dependencies/unitypy/UnityPy/__init__.py')).then(() => true, () => false))) return t.skip('Prepare the fixed UnityPy dependency first');
  const f = await fixture(t, {});
  await pythonFixture(`from pathlib import Path;from test_unity_native import unity_game;unity_game(Path(sys.argv[1]),bundle=${bundle ? 'True' : 'False'})`, [f.root]);
  f.gameDir = path.join(f.root, 'game');
  const result = await pipeline(f);
  assert.equal(result.project.engine, 'Unity');
  assert.equal(result.units.length, 9);
  assert.ok(result.baseline.some(unit => unit.source.includes('Welcome') && unit.tokens.length === 3));
  assert.ok(!result.baseline.some(unit => /INTERNAL|@goto/.test(unit.source)));
  const carrier = path.join(result.output, 'Fixture_Data', bundle ? 'text.bundle' : 'resources.assets');
  await pythonFixture('import unity_native as a,json;from pathlib import Path;_,top=a.load_carrier(Path(sys.argv[1]));trees={obj.path_id:obj.parse_as_dict() for obj in a.objects(top).values()};assert trees[7]["m_Text"]=="译文 Start adventure";assert trees[9]["m_Text"]=="INTERNAL_LOGIC_TEXT";assert json.loads(trees[1]["m_Script"])["id"]=="welcome_event";assert json.loads(trees[1]["m_Script"])["lines"][0]["message"]=="译文 Take your time.";assert "voice01.ogg" in trees[2]["m_Script"]', [carrier]);
  await assert.rejects(access(path.join(result.output, 'save01.sav')), { code: 'ENOENT' });
  await assert.rejects(f.service.exportRelease({ projectId: result.project.id, filePath: path.join(f.root, 'unsupported.rga'), target: 'joiplay' }), /MV.*MZ/);
});
