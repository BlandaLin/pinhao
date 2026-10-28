import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';
import { verifyTextStructure } from './adaptation/literal-structure.mjs';

function literal(file, source, translation, prefix = '') {
  const before = `text = ${prefix}"${source}"\n`, byteStart = Buffer.byteLength(`text = ${prefix}"`);
  return { file, before, after: `text = ${prefix}"${translation}"\n`,
    units: [{ id: 'text:1', rawSource: source, locator: { file, byteStart, byteEnd: byteStart + Buffer.byteLength(source) } }], translations: { 'text:1': translation } };
}

test('quoted Godot Unicode escapes require four or six hexadecimal digits and paired surrogates', () => {
  for (const escape of ['\\u0021', '\\U01F600', '\\uD83D\\uDE00']) assert.equal(verifyTextStructure(literal('view.gd', `Hello${escape}`, `你好${escape}`)).valid, true);
  for (const escape of ['\\u文字', '\\u001', '\\U1F600', '\\U110000', '\\uD800', '\\uDC00', '\\uD800x', '\\x21', '\\123', '\\q']) {
    assert.throws(() => verifyTextStructure(literal('view.gd', 'Hello\\u0021', `你好${escape}`)), /代码结构|字符串边界/);
  }
});

test('Python and RenPy retain their own escape widths and raw literal semantics', () => {
  for (const file of ['view.py', 'view.rpy']) {
    for (const escape of ['\\u0021', '\\U0001F600', '\\x21', '\\123', '\\q']) assert.equal(verifyTextStructure(literal(file, `Hello${escape}`, `你好${escape}`)).valid, true);
    for (const escape of ['\\u文字', '\\U01F600', '\\U00110000', '\\xZ1', '\\x1']) assert.throws(() => verifyTextStructure(literal(file, 'Hello', escape)), /代码结构|字符串边界/);
    assert.equal(verifyTextStructure(literal(file, 'Hello\\u文字', '你好\\u文字', 'r')).valid, true);
  }
  assert.equal(verifyTextStructure(literal('view.gd', 'Hello\\u文字', '你好\\u文字', 'r')).valid, true);
});

test('real lab protects complete encoded script escapes as indivisible controls', async t => {
  const base = path.resolve('local', 'quoted-escape-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'fixture-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  for (const [index, [file, escape]] of [['view.gd', '\\u0021'], ['view.gd', '\\U01F600'], ['view.rpy', '\\U0001F600'], ['view.py', '\\x21'], ['view.py', '\\123']].entries()) {
    const gameDir = path.join(root, `source-${index}`); await mkdir(gameDir);
    const source = `text = "Hello${escape}"\n`;
    await writeFile(path.join(gameDir, file), source);
    const resource = JSON.stringify(file);
    const definition = { manifest: { schemaVersion: 1, id: `encoded-${index}`, version: '1.0.0', engine: 'Neutral', scope: { files: [file] }, license: 'GPL-3.0-or-later', sources: [] },
      code: `({detect(){return {matched:true}},extract(host){const text=host.readText(${resource});let size=0;for(const c of text){const n=c.codePointAt(0);size+=n<128?1:n<2048?2:n<65536?3:4}return {units:[{id:'encoded:1',source:text.slice(8,-2),locator:{file:${resource},byteStart:8,byteEnd:size-2}}]}},validate(){return {valid:true}},roundtrip(host){host.writeBytes(${resource},host.readBytes(${resource}));return {}},build(host,input){const text=host.readText(${resource});host.writeText(${resource},text.slice(0,8)+(input.translations['encoded:1']??text.slice(8,-2))+text.slice(-2));return {}},assemble(){return {}}})` };
    const lab = await createAdapterLab({ dataDir: path.join(root, `recipes-${index}`) });
    const candidate = await lab.writeAdapter(definition);
    const validation = await lab.validateAdapter({ ...candidate, gameDir });
    assert.equal(validation.passed, true, JSON.stringify(validation.error));
    const recipe = await lab.submitRecipe({ ...candidate, validationId: validation.validationId });
    const extraction = await lab.extractRecipe({ ...recipe, gameDir, workspaceDir: path.join(root, `work-${index}`) });
    const unit = extraction.units[0];
    assert.deepEqual(Object.values(unit.controls), [escape]);
    assert.equal(unit.source, 'Hello{{CTRL0001}}');
    const build = await lab.dispatch('build', { workspaceDir: extraction.workspaceDir, outputDir: path.join(root, `built-${index}`), translations: [{ id: unit.id, translation: '你好{{CTRL0001}}' }] });
    assert.equal(await readFile(path.join(build.buildDir, file), 'utf8'), `text = "你好${escape}"\n`);
    assert.equal(await readFile(path.join(gameDir, file), 'utf8'), source);
  }
});
