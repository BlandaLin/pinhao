import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { selectEmbeddedText, embeddedText, replaceEmbeddedText } from './embedded-text.mjs';
import { createJsonCoverage } from './coverage-json.mjs';
import { assertJsonFieldWritable } from './json-field-policy.mjs';
import { createEmbeddedSelections, createTextAdapter } from './adaptation/text-adapter.mjs';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';
import { qualifyEmbeddedContracts } from './embedded-command-contract.mjs';

const file = 'data/CommonEvents.json', pointer = '/1/list/0/parameters/0';
const events = () => [null, { id: 1, name: 'Internal event', list: [{ code: 356, indent: 0, parameters: ['NOTICE_PANEL Complete menu text 32'] }, { code: 0, parameters: [] }] }];
const selection = { file, pointer, text: 'Complete menu text', reason: 'The enabled plugin joins these arguments as the display text and keeps the final font size.' };
async function writeConsumers(gameDir) {
  await mkdir(path.join(gameDir, 'js/plugins'), { recursive: true });
  await writeFile(path.join(gameDir, 'js/rpg_objects.js'), `Game_Interpreter.prototype.command356 = function() { var args = this._params[0].split(' '); var command = args.shift(); this.pluginCommand(command, args); return true; };`);
  await writeFile(path.join(gameDir, 'js/plugins.js'), `var $plugins = [{name:'Notice',status:true,parameters:{}}];`);
  await writeFile(path.join(gameDir, 'js/plugins/Notice.js'), `Game_Interpreter.prototype.pluginCommand = function(command,args) { if(command==='NOTICE_PANEL') { $gameMessage.add(args.slice(0,-1).join(' ')); this.fontSize=Number(args[args.length-1]); } };`);
}

test('protected program fields remain protected while embedded command sources enter technical review', async () => {
  const document = events(), text = '\uFEFF' + JSON.stringify(document, null, 2);
  assert.throws(() => assertJsonFieldWritable({ file, document, pointer }));
  const scan = await createJsonCoverage({ units: [] });
  const result = scan.inspect(file, Buffer.from(text));
  assert.equal(result.embeddedExpressions.length, 1);
  const candidate = result.embeddedExpressions[0];
  assert.equal(candidate.embedded.command, 'NOTICE_PANEL');
  assert.equal(candidate.locator.pointer, pointer);
  assert.equal(result.exactlyAccounted, false);
  assert.equal(JSON.parse(Buffer.from(text).subarray(candidate.byteStart, candidate.byteEnd)), document[1].list[0].parameters[0]);
  const replay = scan.inspect(file, undefined, { profile: result.profile, hash: 'a'.repeat(64) });
  assert.equal(replay.embeddedExpressions.length, 1);
  assert.equal(replay.embeddedExpressions[0].id, candidate.id);
});

test('host-selected command segments need real consumer qualification before writing', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-command-contract-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  await writeConsumers(root);
  const document = events(), locator = selectEmbeddedText({ ...selection, document });
  assert.deepEqual(locator.segment, { syntax: 'rpgmaker-plugin-command', prefix: 'NOTICE_PANEL ', suffix: ' 32' });
  assert.equal(embeddedText(document[1].list[0].parameters[0], locator.segment), selection.text);
  assert.throws(() => replaceEmbeddedText({ file, document, locator, source: selection.text, translation: '完整菜单文字' }), { code: 'EMBEDDED_REPRESENTATION_PENDING' });
  const contracts = await qualifyEmbeddedContracts({ gameDir: root, units: [{ id: 'selected', rawSource: selection.text, locator }] });
  replaceEmbeddedText({ file, document, locator, source: selection.text, translation: '完整菜单文字', contract: contracts.selected });
  assert.equal(document[1].list[0].parameters[0], 'NOTICE_PANEL 完整菜单文字 32');
  assert.throws(() => replaceEmbeddedText({ file, document, locator, source: selection.text, translation: 'wrong baseline' }), /原文/);
  for (const text of ['NOTICE_PANEL', '32', 'menu tex', 'NOTICE_PANEL Complete menu text 32']) {
    assert.throws(() => selectEmbeddedText({ ...selection, text, document: events() }));
  }
  const script = events(); script[1].list[0].code = 355;
  assert.throws(() => selectEmbeddedText({ ...selection, document: script }), /容器/);
  assert.throws(() => replaceEmbeddedText({ file, document: events(), locator, source: selection.text, translation: 'line\nbreak' }), /换行/);
});

test('the ordinary adapter lab roundtrips and rebuilds only selected command text', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-command-text-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const gameDir = path.join(root, 'source'); await mkdir(path.join(gameDir, 'data'), { recursive: true });
  const original = JSON.stringify(events(), null, 2);
  await writeFile(path.join(gameDir, file), original);
  await writeConsumers(gameDir);
  const definition = await createEmbeddedSelections({ selections: [selection], gameDir, engine: 'MV', assignment: { files: [file] } });
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab') });
  const candidate = await lab.writeAdapter(definition);
  const validation = await lab.validateAdapter({ ...candidate, gameDir });
  assert.equal(validation.passed, true, validation.error?.message);
  const recipe = await lab.submitRecipe({ ...candidate, validationId: validation.validationId });
  const extracted = await lab.extractRecipe({ ...recipe, gameDir, workspaceDir: path.join(root, 'work') });
  assert.equal(extracted.units.length, 1);
  assert.equal(extracted.units[0].source, selection.text);
  assert.equal(extracted.units[0].locator.segment.suffix, ' 32');
  const built = await lab.dispatch('build', { workspaceDir: extracted.workspaceDir, outputDir: path.join(root, 'built'),
    translations: [{ id: extracted.units[0].id, translation: '菜单“文字”' }] });
  const expected = events(); expected[1].list[0].parameters[0] = 'NOTICE_PANEL 菜单“文字” 32';
  assert.deepEqual(JSON.parse(await readFile(path.join(built.buildDir, file), 'utf8')), expected);
  assert.equal(await readFile(path.join(gameDir, file), 'utf8'), original);
  await assert.rejects(createTextAdapter({ gameDir, candidates: [{ file, source: events()[1].list[0].parameters[0], locator: { file, pointer } }] }), /逻辑|程序|字段/);
  await assert.rejects(createEmbeddedSelections({ selections: [selection], gameDir, assignment: { files: ['data/Other.json'] } }), /分工/);
  await assert.rejects(createEmbeddedSelections({ selections: [selection, selection], gameDir }), /完整语义/);
});
