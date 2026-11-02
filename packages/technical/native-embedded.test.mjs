import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { discoverNativeEmbedded } from './native-embedded.mjs';
import { productWorker } from '../../apps/desktop/electron/host.mjs';

const base = path.resolve('local/native-embedded-tests');
await mkdir(base, { recursive: true });
const bundled = path.resolve('local/runtime/python/python.exe');
const pythonPath = await access(bundled).then(() => bundled, () => 'python');
async function fixture(t, { expression = "args.slice(0,-1).join(' ')", extra = '', www = false, enabled = true } = {}) {
  const dir = await mkdtemp(path.join(base, 'case-')), gameDir = path.join(dir, 'original'), root = path.join(gameDir, www ? 'www' : '');
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  const files = {
    'js/rpg_core.js': '// Neutral MV engine marker',
    'js/rpg_objects.js': "Game_Interpreter.prototype.command356=function(){var args=this._params[0].split(' ');var command=args.shift();this.pluginCommand(command,args);return true;};Game_Message.prototype.add=function(text){this._texts.push(text);};",
    'js/plugins.js': `var $plugins=${JSON.stringify([{ name: 'Message', status: enabled, parameters: {} }])};`,
    'js/plugins/Message.js': `Game_Interpreter.prototype.pluginCommand=function(command,args){if(command==='NOTICE'){$gameMessage.add(${expression});${extra}}};`,
    'data/System.json': JSON.stringify({ gameTitle: 'Test', currencyUnit: 'Gold', switches: [''], variables: [''], terms: {} }),
    'data/CommonEvents.json': JSON.stringify([null, { id: 1, name: 'editor identity', list: [
      { code: 356, indent: 0, parameters: ['NOTICE Whole source text 32'] }, { code: 0, indent: 0, parameters: [] }
    ] }])
  };
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return { dir, gameDir, root, files };
}
test('native discovery selects complete proven message arguments, not the command or numeric tail', async t => {
  const f = await fixture(t), result = await discoverNativeEmbedded({ gameDir: f.gameDir });
  assert.equal(result.selections.length, 1);
  assert.equal(result.selections[0].source, 'Whole source text');
  assert.deepEqual(result.selections[0].segment, { syntax: 'rpgmaker-plugin-command', prefix: 'NOTICE ', suffix: ' 32' });
  assert.equal(result.selections[0].pointer, '/1/list/0/parameters/0');
});
test('unknown, disabled, mixed-use and secondary parsing keep the existing Agent review route', async t => {
  for (const options of [{ enabled: false }, { extra: 'loadScene(args[0]);' }, { extra: 'window.saved=arguments[1][0];' }, { expression: "args[0].split(',')[0]" }]) {
    const f = await fixture(t, options);
    assert.equal(await discoverNativeEmbedded({ gameDir: f.gameDir }), undefined);
  }
});
test('dead consumers, dynamic activation and replaced message stores are not automatically translated', async t => {
  for (const change of ['dead', 'activation', 'override', 'alias', 'shift', 'split']) {
    const f = await fixture(t);
    const file = path.join(f.root, change === 'activation' ? 'js/plugins.js' : 'js/plugins/Message.js');
    const original = await readFile(file, 'utf8');
    await writeFile(file, change === 'dead' ? original.replace('$gameMessage.add', 'if(false)$gameMessage.add')
      : original + ({ activation: '\n$plugins[0].status=false;', override: '\nGame_Message.prototype.add=function(value){window.saved=value;};',
        alias: '\nvar holder=Game_Message.prototype;holder.add=function(value){window.saved=value;};',
        shift: '\nArray.prototype.shift=function(){return this.pop();};', split: '\nString.prototype.split=function(){return [];};' }[change]));
    assert.equal(await discoverNativeEmbedded({ gameDir: f.gameDir }), undefined, change);
  }
});
test('unused MV scripts do not authorize an MZ command stream', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'js/rmmz_core.js'), '// Neutral MZ marker with unused MV assets');
  assert.equal(await discoverNativeEmbedded({ gameDir: f.gameDir }), undefined);
});
for (const www of [false, true]) test(`normal product native extraction and writeback use proven command text (www=${www})`, async t => {
  const f = await fixture(t, { www }), worker = productWorker({ pythonPath,
    workerPath: path.resolve('adapters/python/worker.py'), toolkitPath: path.resolve('kits/workbench-tutorial/toolkit') });
  t.after(() => worker.closeExecution());
  const workspaceDir = path.join(f.dir, 'work');
  const before = await readFile(path.join(f.root, 'data/CommonEvents.json'));
  const extracted = await worker('extract', { gameDir: f.gameDir, workspaceDir });
  const unit = extracted.units.find(item => item.kind === 'plugin_message');
  assert.equal(unit.source, 'Whole source text');
  assert.ok(unit.context.displayConsumer);
  assert.equal((await worker('roundtrip', { workspaceDir })).byteIdentical, true);
  const outputDir = path.join(f.dir, 'build');
  await worker('build', { workspaceDir, outputDir, translations: [{ id: unit.id, translation: '完整的译文，保留尾部参数' }] });
  const output = JSON.parse(await readFile(path.join(outputDir, 'data/CommonEvents.json'), 'utf8'));
  assert.equal(output[1].list[0].parameters[0], 'NOTICE 完整的译文，保留尾部参数 32');
  assert.equal(output[1].name, 'editor identity');
  assert.equal(await readFile(path.join(outputDir, 'js/plugins/Message.js'), 'utf8'), f.files['js/plugins/Message.js']);
  assert.deepEqual(await readFile(path.join(f.root, 'data/CommonEvents.json')), before);
});
test('native single-argument consumers reject targets that split protected command parameters', async t => {
  const f = await fixture(t, { expression: 'args[0]' }), worker = productWorker({ pythonPath,
    workerPath: path.resolve('adapters/python/worker.py'), toolkitPath: path.resolve('kits/workbench-tutorial/toolkit') });
  t.after(() => worker.closeExecution());
  const workspaceDir = path.join(f.dir, 'work'), extracted = await worker('extract', { gameDir: f.gameDir, workspaceDir });
  const unit = extracted.units.find(item => item.kind === 'plugin_message');
  assert.equal(unit.source, 'Whole');
  await assert.rejects(worker('build', { workspaceDir, outputDir: path.join(f.dir, 'bad'),
    translations: [{ id: unit.id, translation: 'Two words' }] }), /single command argument/);
});
