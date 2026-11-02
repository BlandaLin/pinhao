import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { inspectPlugins } from '../runtime/rpgmaker-plugins.mjs';
import { finalizeRpgMakerNameIdentity } from './rpgmaker-name-build.mjs';

// Real native extraction/build/assembly with neutral resources; no JoiPlay/device acceptance.
const repository = fileURLToPath(new URL('../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const preparation = String.raw`
import json, pathlib, sys
import worker
from test_rpgmaker import json_game, save
root, engine, custom = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3] == 'true'
game, work, built, output = [root / name for name in ('source', 'work', 'built', 'output')]
runtime = json_game(game, engine, engine == 'MZ')
(game / 'Game.exe').write_bytes(b'neutral non-executable fixture')
objects = """function Game_Battler() {}
function Game_Enemy(enemyId) { this._enemyId = enemyId; this._plural = true; this._letter = ' A'; }
Game_Enemy.prototype = Object.create(Game_Battler.prototype);
Game_Enemy.prototype.constructor = Game_Enemy;
Game_Enemy.prototype.name = function() { return this.originalName() + (this._plural ? this._letter : ''); };
Game_Enemy.prototype.originalName = function() { return this.enemy().name; };
Game_Enemy.prototype.enemy = function() { return $dataEnemies[this._enemyId]; };
Game_Enemy.prototype.enemyId = function() { return this._enemyId; };
function Game_Actor(actorId, name) { this._actorId = actorId; this._name = name; }
Game_Actor.prototype.actorId = function() { return this._actorId; };
Game_Actor.prototype.actor = function() { return $dataActors[this._actorId]; };
Game_Actor.prototype.name = function() { return this._name; };
"""
prefix = 'rmmz' if engine == 'MZ' else 'rpg'
for part in ('core', 'managers', 'objects', 'scenes', 'sprites', 'windows'):
    (runtime / 'js' / (prefix + '_' + part + '.js')).write_text(objects if part == 'objects' else '', encoding='utf-8')
(runtime / 'index.html').write_text('\n'.join('<script src="js/' + prefix + '_' + part + '.js"></script>' for part in ('core', 'managers', 'objects', 'scenes', 'sprites', 'windows')), encoding='utf-8')
for table, values in {'Skills': ['Recharge'], 'States': ['Distant', 'Barrier'], 'Items': ['Barrier'], 'Enemies': ['Neutral Enemy']}.items():
    save(runtime / 'data' / (table + '.json'), [None] + [{'id': index, 'name': value, 'description': '', 'note': ''} for index, value in enumerate(values, 1)])
system = json.loads((runtime / 'data/System.json').read_text(encoding='utf-8'))
system['skillTypes'] = ['', 'Projectile']
save(runtime / 'data/System.json', system)
plugins = runtime / 'js/plugins'
plugins.mkdir()
logic = """const state = $dataStates[1];
const match = state.name === 'Distant';
const skillId = $dataSkills.find(skill => skill && skill.name === 'Recharge').id;
const linked = $dataStates.find(state => state && state.name === $dataItems[1].name).id;
const typeId = $dataSystem.skillTypes.indexOf('Projectile');
Game_Enemy.prototype.resourcePortrait = function() { ImageManager.loadEnemy(this.name()); };
drawText(state.name);
drawText($dataItems[1].name);
globalThis.logicResult = { match, skillId, linked, typeId };
"""
(plugins / 'NeutralLogic.js').write_text(logic, encoding='utf-8')
rows = [{'name': 'NeutralLogic', 'status': True, 'parameters': {'keep': '\\V[1]', 'nested': '{"x":1}'}}]
if custom:
    (plugins / 'LateOverrides.js').write_text("Game_Enemy.prototype.name = function() { return 'Custom Enemy'; };\nGame_Actor.prototype.name = function() { return 'PlayerChosen'; };\nImageManager.loadPicture($gameActors.actor(1).name());\n", encoding='utf-8')
    rows.append({'name': 'LateOverrides', 'status': True, 'parameters': {}})
(runtime / 'js/plugins.js').write_bytes(('\ufeffvar $plugins = ' + json.dumps(rows) + ';\r\n// keep manifest tail\r\n').encode('utf-8'))
extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
targets = {'Skills': {'Recharge': '\u88c5\u586b'}, 'States': {'Distant': '\u8fdc\u5904', 'Barrier': '\u5c4f\u969c'}, 'Items': {'Barrier': '\u62a4\u76fe'}, 'Enemies': {'Neutral Enemy': '\u4e2d\u6027\u654c\u4eba'}, 'System': {'Projectile': '\u8fdc\u7a0b'}}
translations = []
for unit in extracted['units']:
    value = targets.get(pathlib.Path(unit['file']).stem, {}).get(unit['source'])
    if value is not None:
        translations.append({'id': unit['id'], 'translation': value})
worker.build({'workspaceDir': str(work), 'outputDir': str(built), 'translations': translations})
worker.assemble({'gameDir': str(game), 'workspaceDir': str(work), 'buildDir': str(built), 'outputDir': str(output)})
print(json.dumps({'source': str(game), 'output': str(output), 'resourceRoot': 'www' if engine == 'MZ' else '.', 'prefix': prefix}))
`;

async function fixture(t, engine, custom = false) {
  const parent = path.join(repository, 'local/native-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'name-build-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const process = spawnSync('python', ['-B', '-c', preparation, root, engine, String(custom)], {
    cwd: path.join(repository, 'adapters/python'), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(process.status, 0, process.stderr);
  const result = JSON.parse(process.stdout.trim());
  return { ...result, engine, game: path.join(result.output, result.resourceRoot), original: path.join(result.source, result.resourceRoot) };
}

async function snapshot(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) for (const [relative, digest] of Object.entries(await snapshot(file))) result[`${entry.name}/${relative}`] = digest;
    else result[entry.name] = hash(await readFile(file));
  }
  return result;
}

async function runProduct(product, entryInline = '') {
  const scope = { displays: [], enemies: [], pictures: [] };
  scope.drawText = value => scope.displays.push(value);
  scope.ImageManager = { loadEnemy: value => scope.enemies.push(value), loadPicture: value => scope.pictures.push(value) };
  for (const table of ['Actors', 'States', 'Skills', 'Items', 'Enemies', 'System']) scope[`$data${table}`] = JSON.parse(await readFile(path.join(product.game, `data/${table}.json`), 'utf8'));
  vm.createContext(scope);
  for (const part of ['core', 'managers', 'objects', 'scenes', 'sprites', 'windows']) vm.runInContext(await readFile(path.join(product.game, `js/${product.prefix}_${part}.js`), 'utf8'), scope);
  if (entryInline) vm.runInContext(entryInline, scope);
  vm.runInContext("globalThis.subject = new Game_Enemy(1); globalThis.actor = new Game_Actor(1, 'PlayerCustom'); globalThis.$gameActors = {actor: function() {return actor;}};", scope);
  const manifest = inspectPlugins(await readFile(path.join(product.game, 'js/plugins.js'), 'utf8'));
  assert.deepEqual(manifest.unresolved, []);
  assert.equal(manifest.plugins[0].name, 'PinHaoNameIdentity');
  for (const row of manifest.plugins.filter(row => row.status)) vm.runInContext(await readFile(path.join(product.game, `js/plugins/${row.name}.js`), 'utf8'), scope);
  vm.runInContext('subject.resourcePortrait();', scope);
  return scope;
}

test('native MV and nested MZ products finalize real files and run generated identity APIs idempotently', async t => {
  for (const engine of ['MV', 'MZ']) {
    const product = await fixture(t, engine), sourceBefore = await snapshot(product.source), databaseBefore = await snapshot(path.join(product.game, 'data'));
    const original = path.join(product.original, 'js/plugins/NeutralLogic.js'), transformed = path.join(product.game, 'js/plugins/NeutralLogic.js');
    await unlink(transformed); await link(original, transformed);
    assert.equal((await lstat(original)).nlink, 2);
    const originalHash = hash(await readFile(original));
    const result = await finalizeRpgMakerNameIdentity({ outputDir: product.output, engine });
    assert.ok(result.changed > 0);
    assert.equal(result.reportFile, 'pinhao-name-identity-report.json');
    const reportFile = path.join(product.output, result.reportFile), reportBytes = await readFile(reportFile), report = JSON.parse(reportBytes);
    assert.equal(report.runtimeVerified, false);
    assert.equal(report.enemyGetter.verified, true);
    assert.equal(report.enemyGetter.pluginOverride, false);
    const transformedHash = hash(await readFile(transformed));
    assert.ok(report.files.some(file => file.file === 'js/plugins/NeutralLogic.js' && file.before === originalHash && file.after === transformedHash));
    assert.ok(report.files.every(file => !path.isAbsolute(file.file) && !file.file.includes('..')));
    assert.ok(!reportBytes.toString('utf8').includes(product.output));
    assert.equal(hash(await readFile(original)), originalHash);
    assert.equal((await lstat(original)).nlink, 1);
    assert.equal((await lstat(transformed)).nlink, 1);
    const scope = await runProduct(product);
    assert.deepEqual(JSON.parse(JSON.stringify(scope.logicResult)), { match: true, skillId: 1, linked: 2, typeId: 1 });
    assert.deepEqual(scope.displays, ['\u8fdc\u5904', '\u62a4\u76fe']);
    assert.deepEqual(scope.enemies, ['Neutral Enemy A']);
    assert.deepEqual(await snapshot(path.join(product.game, 'data')), databaseBefore);
    assert.deepEqual(await snapshot(product.source), sourceBefore);
    const scriptBytes = await readFile(transformed);
    const again = await finalizeRpgMakerNameIdentity({ outputDir: product.output, engine });
    assert.equal(again.changedThisRun, 0);
    assert.equal(again.changed, result.changed);
    assert.deepEqual(await readFile(transformed), scriptBytes);
    assert.deepEqual(await readFile(reportFile), reportBytes);
  }
});

test('a later enabled custom enemy or actor getter is not blindly rewritten by an earlier resource caller', async t => {
  const product = await fixture(t, 'MV', true), sourceBefore = await snapshot(product.source), dataBefore = await snapshot(path.join(product.game, 'data'));
  const late = path.join(product.game, 'js/plugins/LateOverrides.js'), lateBefore = await readFile(late);
  const result = await finalizeRpgMakerNameIdentity({ outputDir: product.output, engine: 'MV' });
  const report = JSON.parse(await readFile(path.join(product.output, result.reportFile), 'utf8'));
  assert.equal(report.runtimeVerified, false);
  assert.equal(report.enemyGetter.pluginOverride, true);
  assert.ok(report.warnings.some(warning => warning.code === 'custom-enemy-getter'));
  assert.match(await readFile(path.join(product.game, 'js/plugins/NeutralLogic.js'), 'utf8'), /ImageManager\.loadEnemy\(this\.name\(\)\)/);
  assert.deepEqual(await readFile(late), lateBefore);
  const scope = await runProduct(product);
  assert.deepEqual(JSON.parse(JSON.stringify(scope.logicResult)), { match: true, skillId: 1, linked: 2, typeId: 1 });
  assert.deepEqual(scope.displays, ['\u8fdc\u5904', '\u62a4\u76fe']);
  assert.deepEqual(scope.enemies, ['Custom Enemy']);
  assert.deepEqual(scope.pictures, ['PlayerChosen']);
  assert.deepEqual(await snapshot(path.join(product.game, 'data')), dataBefore);
  assert.deepEqual(await snapshot(product.source), sourceBefore);
});

test('an inline entry override participates in preflight and does not duplicate a custom getter', async t => {
  const product = await fixture(t, 'MV'), sourceBefore = await snapshot(product.source);
  const htmlFile = path.join(product.game, 'index.html');
  const inline = 'Game_Enemy.prototype.enemy = function() { this.calls = (this.calls || 0) + 1; return $dataEnemies[this._enemyId]; };';
  await writeFile(htmlFile, `${await readFile(htmlFile, 'utf8')}\n<script>${inline}</script>`);
  const result = await finalizeRpgMakerNameIdentity({ outputDir: product.output, engine: 'MV' });
  const report = JSON.parse(await readFile(path.join(product.output, result.reportFile), 'utf8'));
  assert.equal(report.enemyGetter.pluginOverride, true);
  assert.ok(report.warnings.some(item => item.code === 'custom-enemy-getter'));
  assert.match(await readFile(path.join(product.game, 'js/plugins/NeutralLogic.js'), 'utf8'), /ImageManager\.loadEnemy\(this\.name\(\)\)/);
  const scope = await runProduct(product, inline);
  assert.equal(scope.subject.calls, 1);
  assert.deepEqual(await snapshot(product.source), sourceBefore);
});

test('a plugin also loaded directly by the entry keeps its early-executed bytes and reports unresolved timing', async t => {
  const product = await fixture(t, 'MZ'), sourceBefore = await snapshot(product.source);
  const relative = 'js/plugins/DirectEarly.js', entryRelative = 'js/./plugins/DirectEarly.js', directFile = path.join(product.game, relative);
  const direct = "globalThis.earlyVerdict = $dataStates[1].name === 'Distant';\r\n";
  await writeFile(directFile, direct);
  const htmlFile = path.join(product.game, 'index.html');
  await writeFile(htmlFile, `${await readFile(htmlFile, 'utf8')}\n<script src="${entryRelative}"></script>`);
  const manifestFile = path.join(product.game, 'js/plugins.js');
  const manifest = inspectPlugins(await readFile(manifestFile, 'utf8'));
  manifest.plugins.push({ name: 'DirectEarly', status: true, parameters: {} });
  await writeFile(manifestFile, `var $plugins = ${JSON.stringify(manifest.plugins)};`);
  const result = await finalizeRpgMakerNameIdentity({ outputDir: product.output, engine: 'MZ' });
  const report = JSON.parse(await readFile(path.join(product.output, result.reportFile), 'utf8'));
  assert.deepEqual(await readFile(directFile), Buffer.from(direct));
  assert.ok(report.warnings.some(item => [relative, entryRelative].includes(item.file)));
  assert.ok(!report.files.some(item => item.file === relative));
  const beforePluginApi = { $dataStates: [null, { id: 1, name: '\u8fdc\u5904' }] };
  assert.doesNotThrow(() => vm.runInNewContext(direct, beforePluginApi));
  assert.equal(beforePluginApi.earlyVerdict, false);
  assert.equal(beforePluginApi.PinHaoNameIdentity, undefined);
  assert.deepEqual(await snapshot(product.source), sourceBefore);
});
