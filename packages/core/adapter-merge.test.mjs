import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergeAdapterResource } from './adapter-merge.mjs';
import { selectEmbeddedText } from '../technical/embedded-text.mjs';
import { qualifyEmbeddedContracts } from '../technical/embedded-command-contract.mjs';

async function fixture(t, baseline, native, adapter, file = 'story.json') {
  const base = os.tmpdir(), root = await mkdtemp(path.join(base, 'pinhao-merge-'));
  t.after(async () => {
    const relative = path.relative(base, root);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  });
  for (const name of ['baseline', 'native', 'adapter', 'overlay']) await mkdir(path.join(root, name));
  const args = { baselineFile: path.join(root, 'baseline', file), nativeFile: path.join(root, 'native', file), adapterFile: path.join(root, 'adapter', file), outputFile: path.join(root, 'overlay', file) };
  await writeFile(args.baselineFile, baseline); await writeFile(args.nativeFile, native); await writeFile(args.adapterFile, adapter);
  return { ...args, root };
}

const jsonUnit = (id, pointer, source) => ({ id, source, rawSource: source, tokens: [], locator: { file: 'story.json', pointer } });
function span(id, text, value, occurrence = 0) {
  let start = -1;
  for (let index = 0; index <= occurrence; index++) start = text.indexOf(value, start + 1);
  assert.ok(start >= 0);
  return { id, source: value, rawSource: value, tokens: [], locator: { file: 'story.txt', byteStart: Buffer.byteLength(text.slice(0, start)), byteEnd: Buffer.byteLength(text.slice(0, start + value.length)) } };
}

test('JSON pointer merges keep native translations, formatting and resource references', async t => {
  const baseline = '{\n  "known": "Native dialogue",\n  "extra": "Hidden dialogue",\n  "resource": "sprites/hero.png", "switch": 19\n}\n';
  const native = baseline.replace('Native dialogue', '原生译文');
  const adapter = baseline.replace('Hidden dialogue', '补充译文');
  const f = await fixture(t, baseline, native, adapter);
  const result = await mergeAdapterResource({ ...f, units: [jsonUnit('extra', '/extra', 'Hidden dialogue')] });
  assert.equal(await readFile(f.outputFile, 'utf8'), native.replace('Hidden dialogue', '补充译文'));
  assert.equal(result.merged.kind, 'json-pointer'); assert.equal(result.merged.applied, 1);
  assert.deepEqual(result.files, ['story.json']);
  assert.equal(await readFile(f.baselineFile, 'utf8'), baseline);
  assert.equal(await readFile(f.nativeFile, 'utf8'), native);
  assert.equal(await readFile(f.adapterFile, 'utf8'), adapter);
});

test('unchanged JSON supplement returns native bytes exactly including BOM and whitespace', async t => {
  const baseline = '{"name":"Hero","resource":"hero.png"}';
  const native = '\uFEFF{\r\n\t"name" : "勇者", "resource":"hero.png"\r\n}\r\n';
  const f = await fixture(t, baseline, native, baseline);
  const result = await mergeAdapterResource({ ...f, units: [jsonUnit('name', '/name', 'Hero')] });
  assert.equal(await readFile(f.outputFile, 'utf8'), native);
  assert.equal(result.hashes.native, result.hashes.output); assert.equal(result.merged.applied, 0);
});

test('same JSON pointer accepts identical current text and rejects conflicting translations', async t => {
  const f = await fixture(t, '{"text":"Original"}', '{"text":"已接受的译文"}', '{"text":"另一种译文"}');
  const units = [jsonUnit('text', '/text', 'Original')];
  await assert.rejects(mergeAdapterResource({ ...f, units }), error => error.code === 'ADAPTER_MERGE_CONFLICT' && /同一字段/.test(error.message));
  await writeFile(f.adapterFile, '{"text":"已接受的译文"}');
  const result = await mergeAdapterResource({ ...f, units });
  assert.equal(result.merged.changes[0].status, 'already-present');
  assert.equal(await readFile(f.outputFile, 'utf8'), '{"text":"已接受的译文"}');
});

test('escaped JSON pointers and control bindings preserve unrelated native bytes', async t => {
  const source = 'Hello \\C[2]hero';
  const baseline = JSON.stringify({ 'a/b': { '~name': source }, reference: 'keep' });
  const native = '\uFEFF' + baseline.replace('"reference":"keep"', '"reference" : "native-resource"') + '\r\n';
  const adapter = JSON.stringify({ 'a/b': { '~name': '你好 \\C[2]勇者' }, reference: 'keep' });
  const f = await fixture(t, baseline, native, adapter);
  const unit = { id: 'name', source: 'Hello {{CTRL0001}}hero', rawSource: source, tokens: ['{{CTRL0001}}'], controls: { '{{CTRL0001}}': '\\C[2]' }, context: { protectedControlSyntax: 'rpgmaker-v1' }, locator: { file: 'story.json', pointer: '/a~1b/~0name' } };
  await mergeAdapterResource({ ...f, units: [unit], translations: [{ id: 'name', translation: '你好 {{CTRL0001}}勇者' }] });
  const result = await readFile(f.outputFile, 'utf8');
  assert.ok(result.startsWith('\uFEFF') && result.endsWith('\r\n'));
  assert.equal(JSON.parse(result.replace(/^\uFEFF/, ''))['a/b']['~name'], '你好 \\C[2]勇者');
  assert.ok(result.includes('"reference" : "native-resource"'));
});

test('JSON supplement changing a control or unrelated resource reference is rejected', async t => {
  const baseline = '{"text":"Hello","resource":"keep.png"}';
  const f = await fixture(t, baseline, baseline, '{"text":"你好","resource":"changed.png"}');
  await assert.rejects(mergeAdapterResource({ ...f, units: [jsonUnit('text', '/text', 'Hello')] }), /逻辑或资源引用/);
  await writeFile(f.baselineFile, '{"text":"Hello \\nWorld"}');
  await writeFile(f.nativeFile, '{"text":"Hello \\nWorld"}');
  await writeFile(f.adapterFile, '{"text":"你好 世界"}');
  await assert.rejects(mergeAdapterResource({ ...f, units: [jsonUnit('text', '/text', 'Hello \nWorld')] }), /控制符/);
});

test('command body supplements merge with native text without rewriting command arguments', async t => {
  const body = 'Welcome \\C[2]traveller', command = `D_TEXT ${body} 24`;
  const document = [null, { id: 1, name: 'Reception', list: [{ code: 356, indent: 0, parameters: [command] }] }];
  const baseline = JSON.stringify(document);
  const native = '\uFEFF' + baseline.replace('Reception', '原生场景名') + '\r\n';
  const adapter = baseline.replace('Welcome', '欢迎').replace('traveller', '旅人');
  const file = 'data/CommonEvents.json', pointer = '/1/list/0/parameters/0';
  const selected = selectEmbeddedText({ file, document, pointer, text: body, reason: 'Consumer draws this full command argument.' });
  const unit = { id: 'command-body', source: 'Welcome {{CTRL0001}}traveller', rawSource: body,
    tokens: ['{{CTRL0001}}'], controls: { '{{CTRL0001}}': '\\C[2]' }, context: { protectedControlSyntax: 'rpgmaker-v1' }, locator: selected };
  const f = await fixture(t, baseline, native, adapter);
  const gameDir = path.join(f.root, 'qualified-game');
  await mkdir(path.join(gameDir, 'js/plugins'), { recursive: true });
  await writeFile(path.join(gameDir, 'js/rpg_objects.js'), `Game_Interpreter.prototype.command356=function(){var args=this._params[0].split(' ');var command=args.shift();this.pluginCommand(command,args);return true;};`);
  await writeFile(path.join(gameDir, 'js/plugins.js'), `var $plugins=[{name:'Caption',status:true}];`);
  await writeFile(path.join(gameDir, 'js/plugins/Caption.js'), `Game_Interpreter.prototype.pluginCommand=function(command,args){if(command==='D_TEXT')$gameMessage.add(args.slice(0,-1).join(' '));};`);
  const representationContracts = await qualifyEmbeddedContracts({ gameDir, units: [unit] });
  await mergeAdapterResource({ ...f, units: [unit], representationContracts, translations: { 'command-body': '欢迎 {{CTRL0001}}旅人' } });
  const output = await readFile(f.outputFile, 'utf8');
  assert.equal(output, native.replace('Welcome', '欢迎').replace('traveller', '旅人'));
  assert.equal(JSON.parse(output.replace(/^\uFEFF/, ''))[1].list[0].parameters[0], 'D_TEXT 欢迎 \\C[2]旅人 24');
  await writeFile(f.adapterFile, adapter.replace('D_TEXT', 'OTHER_COMMAND'));
  await assert.rejects(mergeAdapterResource({ ...f, units: [unit], translations: { 'command-body': '欢迎 {{CTRL0001}}旅人' } }), /范围|命令|片段/);
});

test('UTF-8 adjacent spans preserve length-changing native edits before and after them', async t => {
  const baseline = 'PRE|AlphaBeta|POST';
  const native = '原生前缀|AlphaBeta|原生后缀';
  const adapter = 'PRE|甲乙|POST';
  const f = await fixture(t, baseline, native, adapter, 'story.txt');
  const units = [span('a', baseline, 'Alpha'), span('b', baseline, 'Beta')];
  const result = await mergeAdapterResource({ ...f, units, translations: [{ id: 'a', translation: '甲' }, { id: 'b', translation: '乙' }] });
  assert.equal(await readFile(f.outputFile, 'utf8'), '原生前缀|甲乙|原生后缀');
  assert.equal(result.merged.applied, 2); assert.ok(result.merged.nativeChanges > 0);
  assert.equal(await readFile(f.nativeFile, 'utf8'), native);
});

test('UTF-8 interleaved native and supplemental edits merge by original byte ranges', async t => {
  const baseline = '@@|First|<native>|Second|##';
  const native = '@@|First|<原生>|Second|##';
  const adapter = '@@|第一|<native>|第二|##';
  const f = await fixture(t, baseline, native, adapter, 'story.txt');
  await mergeAdapterResource({ ...f, units: [span('first', baseline, 'First'), span('second', baseline, 'Second')], translations: { first: '第一', second: '第二' } });
  assert.equal(await readFile(f.outputFile, 'utf8'), '@@|第一|<原生>|第二|##');
});

test('UTF-8 insertions exactly at span boundaries stay outside the supplemental text', async t => {
  const baseline = '[Alpha]', native = '[前Alpha后]', adapter = '[译文]';
  const f = await fixture(t, baseline, native, adapter, 'story.txt');
  await mergeAdapterResource({ ...f, units: [span('a', baseline, 'Alpha')], translations: { a: '译文' } });
  assert.equal(await readFile(f.outputFile, 'utf8'), '[前译文后]');
});

test('UTF-8 overlapping native text changes and ambiguous duplicate mappings fail explicitly', async t => {
  const baseline = '[Alpha]';
  const f = await fixture(t, baseline, '[原生译文]', '[补充译文]', 'story.txt');
  await assert.rejects(mergeAdapterResource({ ...f, units: [span('a', baseline, 'Alpha')], translations: { a: '补充译文' } }), error => ['ADAPTER_MERGE_CONFLICT', 'ADAPTER_MERGE_AMBIGUOUS'].includes(error.code));
  await writeFile(f.baselineFile, 'x|x'); await writeFile(f.nativeFile, 'x'); await writeFile(f.adapterFile, '译|x');
  await assert.rejects(mergeAdapterResource({ ...f, units: [span('x', 'x|x', 'x')], translations: { x: '译' } }), error => error.code === 'ADAPTER_MERGE_AMBIGUOUS');
});

test('UTF-8 merging requires precise current translations and preserves bytes outside bound spans', async t => {
  const baseline = 'HEADER|AlphaBeta|resource.png', adapter = 'HEADER|甲乙|resource.png';
  const f = await fixture(t, baseline, baseline, adapter, 'story.txt');
  const units = [span('a', baseline, 'Alpha'), span('b', baseline, 'Beta')];
  await assert.rejects(mergeAdapterResource({ ...f, units }), error => error.code === 'ADAPTER_MERGE_TRANSLATIONS');
  await writeFile(f.adapterFile, adapter.replace('resource.png', 'different.png'));
  await assert.rejects(mergeAdapterResource({ ...f, units, translations: { a: '甲', b: '乙' } }), /范围之外/);
});

test('unsupported locators and source-alias output paths are rejected', async t => {
  const f = await fixture(t, '{"text":"Hello"}', '{"text":"Hello"}', '{"text":"你好"}');
  await assert.rejects(mergeAdapterResource({ ...f, units: [{ id: 'x', source: 'Hello', locator: { file: 'story.json', record: 0 } }] }), error => error.code === 'ADAPTER_MERGE_LOCATOR');
  await assert.rejects(mergeAdapterResource({ ...f, units: [jsonUnit('x', '/text', 'Hello')], outputFile: f.baselineFile }), /原版分开/);
  await assert.rejects(mergeAdapterResource({ ...f, units: [jsonUnit('x', '/text', 'Hello')], outputFile: f.nativeFile }), /独立的覆盖文件/);
  assert.equal(await readFile(f.nativeFile, 'utf8'), '{"text":"Hello"}');
});

test('merge cancellation and diff complexity limits leave all source files unchanged', async t => {
  const baseline = 'a'.repeat(1000) + '|Target|';
  const native = 'b'.repeat(1000) + '|Target|';
  const adapter = 'a'.repeat(1000) + '|译文|';
  const f = await fixture(t, baseline, native, adapter, 'story.txt');
  const args = { ...f, units: [span('target', baseline, 'Target')], translations: { target: '译文' } };
  await assert.rejects(mergeAdapterResource({ ...args, maxEditLength: 1 }), error => error.code === 'ADAPTER_MERGE_DIFF_LIMIT');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(mergeAdapterResource({ ...args, signal: controller.signal }), error => error.name === 'AbortError');
  await assert.rejects(access(f.outputFile), error => error.code === 'ENOENT');
  assert.equal(await readFile(f.baselineFile, 'utf8'), baseline);
  assert.equal(await readFile(f.nativeFile, 'utf8'), native);
  assert.equal(await readFile(f.adapterFile, 'utf8'), adapter);
});
