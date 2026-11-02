import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tableCells, readTable, verifyTable, tableAdapterCode, renderTableCell } from './table-format.mjs';
import { createAdapterLab } from './adapter-lab.mjs';
import { createFormatCapabilities } from './format-capabilities.mjs';
import { verifyFormatGroups } from './format-verification.mjs';
import { verifyTextStructure } from './literal-structure.mjs';

const schema = (key = 'intro', delimiter = ',') => ({ delimiter, keyColumn: 'key', sourceColumn: 'text', targetColumn: 'text', key });
const selection = (file = 'dialogue.csv', table = schema()) => ({ id: 'intro', file, table });
function unitFor(bytes, table = schema(), file = 'dialogue.csv') {
  const view = readTable({ bytes, file });
  const row = view.rows.find(cells => cells[view.header.indexOf(table.keyColumn)].value === table.key);
  const cell = row[view.header.indexOf(table.targetColumn)], source = row[view.header.indexOf(table.sourceColumn)].value;
  return { id: 'intro', rawSource: cell.value || source, source: cell.value || source,
    locator: { file, format: 'table-cell', encoding: 'utf-8', table, byteStart: cell.byteStart, byteEnd: cell.byteEnd } };
}
function patch(bytes, unit, value) {
  return Buffer.concat([bytes.subarray(0, unit.locator.byteStart), Buffer.from(renderTableCell(value)), bytes.subarray(unit.locator.byteEnd)]);
}

test('CSV/TSV lexical fields retain multiline, escaped quotes, empty/trailing fields and BOM byte offsets', () => {
  for (const delimiter of [',', '\t']) {
    const file = delimiter === ',' ? 'a.csv' : 'a.tsv';
    const bytes = Buffer.from('\ufeffkey' + delimiter + 'text' + delimiter + 'other\r\nintro' + delimiter + '"one\r\ntwo ""quoted"""' + delimiter + '\r\n');
    const view = readTable({ bytes, file }), unit = unitFor(bytes, schema('intro', delimiter), file);
    assert.equal(view.bom, true);
    assert.equal(view.rows[0][1].value, 'one\r\ntwo "quoted"');
    assert.equal(view.rows[0][2].value, '');
    assert.equal(bytes.subarray(unit.locator.byteStart, unit.locator.byteEnd).toString(), '"one\r\ntwo ""quoted"""');
    const value = '中文,\t"新行"\n下行';
    assert.equal(verifyTable({ before: bytes, after: patch(bytes, unit, value), units: [unit], translations: { intro: value } }).status, 'passed');
    assert.equal(verifyTable({ before: bytes, after: bytes, units: [unit], translations: {} }).status, 'passed');
  }
  assert.deepEqual(tableCells('key,text\na,', ',').rows[1].map(cell => cell.value), ['a', '']);
});

test('table oracle rejects old flat-span exploit, malformed structure, wrong schema/encoding/keys/spans and non-target changes', () => {
  const before = Buffer.from('key,text,logic\nintro,Welcome,keep\nother,Other,id\n'), unit = unitFor(before);
  const after = Buffer.from('key,text,logic\nintro,Hello, traveler,keep\nother,Other,id\n');
  assert.throws(() => verifyTextStructure({ file: 'dialogue.csv', before, after, units: [{ ...unit, locator: { file: 'dialogue.csv', byteStart: 26, byteEnd: 33 } }], translations: { intro: 'Hello, traveler' } }), { code: 'FORMAT_TABLE_SCHEMA_REQUIRED' });
  assert.throws(() => verifyTable({ before, after, units: [unit], translations: { intro: 'Hello, traveler' } }), /column count/);
  for (const changed of [
    'key,text,logic\nintro,"Hello, traveler",changed\nother,Other,id\n',
    'key,text,logic\nintro,"Hello, traveler",keep\nother,Other,changed\n',
    'key,text,logic\nintro,"Hello, traveler",keep\n',
  ]) assert.throws(() => verifyTable({ before, after: Buffer.from(changed), units: [unit], translations: { intro: 'Hello, traveler' } }));
  for (const malformed of ['key,text\na,"unclosed', 'key,text\na,un"quoted', 'key,key\na,b', 'key,text\na,b,c']) assert.throws(() => readTable({ bytes: Buffer.from(malformed), file: 'a.csv' }));
  for (const table of [{ ...schema(), targetColumn: 'key' }, { ...schema(), key: 'missing' }, { ...schema(), sourceColumn: 'missing' }]) assert.throws(() => verifyTable({ before, after: before, units: [{ ...unit, locator: { ...unit.locator, table } }] }));
  assert.throws(() => verifyTable({ before, after: before, units: [{ ...unit, locator: { ...unit.locator, encoding: 'cp932' } }] }));
  assert.throws(() => verifyTable({ before, after: before, units: [unit, { ...unit, id: 'duplicate' }] }));
  const duplicate = Buffer.from('key,text\nintro,Welcome\nintro,Welcome\n');
  assert.throws(() => verifyTable({ before: duplicate, after: duplicate, units: [unitFor(duplicate)] }), /unique/);
  assert.throws(() => verifyTable({ before, after: before, units: [{ ...unit, locator: { ...unit.locator, byteEnd: unit.locator.byteEnd + 1 } }] }), /span/);
  assert.throws(() => readTable({ bytes: Buffer.from([0xff, 0xfe, 0]), file: 'a.csv' }), /UTF-8/);
});

test('explicit empty target/source columns keep source and untouched target bytes', () => {
  const before = Buffer.from('key,en,zh,asset\nintro,Welcome,,img/id\n');
  const table = { delimiter: ',', keyColumn: 'key', sourceColumn: 'en', targetColumn: 'zh', key: 'intro' };
  const unit = unitFor(before, table);
  assert.equal(unit.rawSource, 'Welcome');
  assert.equal(verifyTable({ before, after: before, units: [unit], translations: {} }).status, 'passed');
  assert.equal(verifyTable({ before, after: patch(before, unit, '欢迎,"你"\n下一行'), units: [unit], translations: { intro: '欢迎,"你"\n下一行' } }).status, 'passed');
});

test('catalog claims table schema not plain span, and parsed resource view yields trustworthy raw field offsets', async t => {
  const catalog = await createFormatCapabilities();
  assert.equal(catalog.describe().find(item => item.capabilityId === 'builtin-utf8-span').limits.extensions.includes('.csv'), false);
  await assert.rejects(catalog.plan({ units: [{ id: 'u', source: 'Welcome', locator: { file: 'a.csv', byteStart: 0, byteEnd: 7 } }], manifest: { scope: { files: ['a.csv'] } } }), { code: 'FORMAT_UNSUPPORTED' });
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-table-reader-')); t.after(() => rm(root, { recursive: true, force: true }));
  const gameDir = path.join(root, 'game'); await mkdir(gameDir); await writeFile(path.join(gameDir, 'a.csv'), '\ufeffkey,text\nintro,"Welcome"\n');
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab') });
  const view = await lab.readFormatView({ gameDir, file: 'a.csv', capabilityId: 'builtin-table-cells' });
  assert.equal(view.content.rows[0][1].value, 'Welcome'); assert.equal(view.proofScope[0], 'host-decoded-source-only');
  const unit = unitFor(await readFile(path.join(gameDir, 'a.csv')), schema(), 'a.csv');
  const plan = await catalog.plan({ units: [unit], manifest: { scope: { files: ['a.csv'] } } });
  assert.equal(plan.writeGroups[0].integrationMode, 'exclusive-resource-group');
});

test('explicit qualified custom grammar may own a CSV suffix without standard table profile claiming it', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-table-custom-')); t.after(() => rm(root, { recursive: true, force: true }));
  const before = path.join(root, 'before'), after = path.join(root, 'after'); await mkdir(before); await mkdir(after);
  const prefix = 'identity,caption,', file = 'custom.csv';
  await writeFile(path.join(before, file), prefix + 'Hello, traveler');
  await writeFile(path.join(after, file), prefix + '欢迎,朋友');
  const profile = { capabilityId: 'fixture-custom-tail', profileFamily: 'custom-tail', qualificationRef: 'host-fixture-custom-tail',
    contentRef: { implementationDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64), dependencyLockDigest: 'c'.repeat(64) },
    claims: ['structure', 'targets', 'preservation', 'derivedFields'], integrationModes: ['independent', 'exclusive-resource-group'], isQualified: () => true,
    match: ({ units }) => units.every(unit => unit.locator.format === 'custom-first-two-commas-tail') ? { writeSet: [file], unitIds: units.map(unit => unit.id) } : null,
    identity: locator => JSON.stringify([locator.file, locator.format, locator.recordKey]),
    verify: ({ before, after, translations }) => ({ status: before[file].toString() === prefix + 'Hello, traveler' && after[file].toString() === prefix + translations.caption ? 'passed' : 'failed',
      claims: { structure: 'passed', targets: 'passed', preservation: 'passed', derivedFields: 'passed' } }) };
  const catalog = await createFormatCapabilities({ profiles: [profile] });
  const unit = { id: 'caption', source: 'Hello, traveler', rawSource: 'Hello, traveler', locator: { file, format: 'custom-first-two-commas-tail', recordKey: 'identity' } };
  const manifest = { scope: { files: [file] } }, plan = await catalog.plan({ units: [unit], manifest });
  assert.deepEqual(plan.capabilityRefs.map(ref => ref.capabilityId), ['fixture-custom-tail']);
  const receipts = await verifyFormatGroups({ catalog, plan, candidate: { candidateId: 'fixture-custom', codeHash: 'd'.repeat(64) }, gameDir: before, outputDir: after, units: [unit], translations: { caption: '欢迎,朋友' }, purpose: 'build' });
  assert.equal(receipts[0].claims.preservation, 'passed');
  await assert.rejects(catalog.plan({ units: [{ ...unit, locator: { file, byteStart: prefix.length, byteEnd: prefix.length + unit.source.length } }], manifest }), { code: 'FORMAT_UNSUPPORTED' });
  await assert.rejects(catalog.plan({ units: [{ ...unit, locator: { file, format: 'table-cell' } }], manifest }), { code: 'FORMAT_TABLE_SCHEMA_REQUIRED' });
});

test('real Lab validate/submit/reopen/build verifies every actual CSV/TSV translation, not just the safe sample', async t => {
  for (const file of ['dialogue.csv', 'dialogue.tsv']) {
    const delimiter = file.endsWith('tsv') ? '\t' : ',';
    const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-table-lab-')); t.after(() => rm(root, { recursive: true, force: true }));
    const gameDir = path.join(root, 'game'); await mkdir(gameDir);
    const before = Buffer.from('\ufeffkey' + delimiter + 'text' + delimiter + 'logic\r\nintro' + delimiter + 'Welcome' + delimiter + 'keep\r\nother' + delimiter + 'Unchanged' + delimiter + 'id\r\n');
    await writeFile(path.join(gameDir, file), before);
    const dataDir = path.join(root, 'lab'), lab = await createAdapterLab({ dataDir });
    const candidate = await lab.writeAdapter({ manifest: { schemaVersion: 1, id: 'table-fixture', version: '1.0.0', engine: 'Neutral', scope: { files: [file] }, license: 'GPL-3.0-or-later', sources: [] }, code: tableAdapterCode([selection(file, schema('intro', delimiter))]) });
    const validation = await lab.validateAdapter({ ...candidate, gameDir });
    assert.equal(validation.passed, true, JSON.stringify(validation.error));
    const recipe = await lab.submitRecipe({ ...candidate, validationId: validation.validationId });
    const reopened = await createAdapterLab({ dataDir }), workspaceDir = path.join(root, 'workbench');
    await reopened.extractRecipe({ recipeId: recipe.recipeId, gameDir, workspaceDir });
    for (const [index, translation] of ['Hello, traveler', '你好,"朋友"'].entries()) {
      const built = await reopened.dispatch('build', { workspaceDir, outputDir: path.join(root, 'build-' + index), translations: [{ id: 'intro', translation }] });
      assert.equal(built.checks.structure, 'passed');
      const actual = await readFile(path.join(built.buildDir, file)), readback = readTable({ bytes: actual, file });
      assert.equal(readback.rows[0][1].value, translation); assert.equal(readback.rows[1][1].value, 'Unchanged');
      assert.equal(built.groupReceipts[0].purpose, 'build');
      assert.deepEqual(await readFile(path.join(gameDir, file)), before);
    }
  }
});

test('Lab rejects the actual unescaped comma even after a safe sample was accepted', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-table-negative-')); t.after(() => rm(root, { recursive: true, force: true }));
  const gameDir = path.join(root, 'game'); await mkdir(gameDir); await writeFile(path.join(gameDir, 'dialogue.csv'), 'key,text\nintro,Welcome\n');
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab') });
  const code = tableAdapterCode([selection()]).replace(': render(value)', ': (value.includes(",") ? value : render(value))');
  assert.notEqual(code, tableAdapterCode([selection()]));
  const candidate = await lab.writeAdapter({ manifest: { schemaVersion: 1, id: 'negative-table', version: '1.0.0', engine: 'Neutral', scope: { files: ['dialogue.csv'] }, license: 'GPL-3.0-or-later', sources: [] }, code });
  const validated = await lab.validateAdapter({ ...candidate, gameDir });
  assert.equal(validated.passed, true, JSON.stringify(validated.error));
  const recipe = await lab.submitRecipe({ ...candidate, validationId: validated.validationId }), workspaceDir = path.join(root, 'workbench');
  await lab.extractRecipe({ recipeId: recipe.recipeId, gameDir, workspaceDir });
  await assert.rejects(lab.dispatch('build', { workspaceDir, outputDir: path.join(root, 'invalid-build'), translations: [{ id: 'intro', translation: 'Hello, traveler' }] }), /column count/);
});

test('Lab keeps existing multiline controls and supports an explicitly separate empty target column', async t => {
  for (const separate of [false, true]) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-table-columns-')); t.after(() => rm(root, { recursive: true, force: true }));
    const gameDir = path.join(root, 'game'); await mkdir(gameDir);
    const before = separate ? 'key,en,zh,logic\nintro,"Welcome\nhero",,keep\n' : 'key,text,logic\nintro,"Welcome\nhero",keep\n';
    await writeFile(path.join(gameDir, 'dialogue.csv'), before);
    const table = separate ? { delimiter: ',', keyColumn: 'key', sourceColumn: 'en', targetColumn: 'zh', key: 'intro' } : schema();
    const lab = await createAdapterLab({ dataDir: path.join(root, 'lab') });
    const candidate = await lab.writeAdapter({ manifest: { schemaVersion: 1, id: 'multiline-table', version: '1.0.0', engine: 'Neutral', scope: { files: ['dialogue.csv'] }, license: 'GPL-3.0-or-later', sources: [] }, code: tableAdapterCode([selection('dialogue.csv', table)]) });
    const validation = await lab.validateAdapter({ ...candidate, gameDir });
    assert.equal(validation.passed, true, JSON.stringify(validation.error));
    assert.match(validation.extraction.units[0].source, /\{\{CTRL0001\}\}/);
    const recipe = await lab.submitRecipe({ ...candidate, validationId: validation.validationId }), workspaceDir = path.join(root, 'workbench');
    await lab.extractRecipe({ recipeId: recipe.recipeId, gameDir, workspaceDir });
    const unchanged = await lab.dispatch('build', { workspaceDir, outputDir: path.join(root, 'no-change'), translations: [] });
    assert.equal(await readFile(path.join(unchanged.buildDir, 'dialogue.csv'), 'utf8'), before);
    const built = await lab.dispatch('build', { workspaceDir, outputDir: path.join(root, 'built'), translations: [{ id: 'intro', translation: '你好,"朋友"{{CTRL0001}}下一行' }] });
    const rows = readTable({ bytes: await readFile(path.join(built.buildDir, 'dialogue.csv')), file: 'dialogue.csv' }).rows;
    assert.equal(rows[0][separate ? 2 : 1].value, '你好,"朋友"\n下一行');
    if (separate) assert.equal(rows[0][1].value, 'Welcome\nhero');
  }
});
