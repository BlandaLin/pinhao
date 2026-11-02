import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTableSelections } from './table-adapter.mjs';
import { createAdapterLab } from './adapter-lab.mjs';
import { readTable } from './table-format.mjs';

const selected = { file: 'dialogue.csv', keyColumn: 'key', sourceColumn: 'text', targetColumn: 'text', key: 'intro', reason: 'Observed display consumer reads text by unique key' };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-table-select-')); t.after(() => rm(root, { recursive: true, force: true }));
  const gameDir = path.join(root, 'game'); await mkdir(gameDir);
  await writeFile(path.join(gameDir, selected.file), '\ufeffkey,text,logic\r\nintro,Welcome,keep\r\nsecond,Other,id\r\n');
  return { root, gameDir };
}

test('host keyed selection generates stable six-method adapter, retains evidence and reaches Lab actual build', async t => {
  const { root, gameDir } = await fixture(t);
  const parameters = { selections: [selected], gameDir, engine: 'Neutral' };
  const generated = await createTableSelections(parameters), again = await createTableSelections(parameters);
  assert.equal(generated.code, again.code); assert.deepEqual(generated.manifest.scope.files, ['dialogue.csv']);
  assert.equal(generated.producerHints[0].hints[0].reason, selected.reason);
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab') });
  const candidate = await lab.writeAdapter(generated), validated = await lab.validateAdapter({ ...candidate, gameDir });
  assert.equal(validated.passed, true, JSON.stringify(validated.error));
  const unit = validated.extraction.units[0]; assert.match(unit.id, /^table:/); assert.equal(unit.context.reason, selected.reason);
  assert.equal(unit.locator.table.key, 'intro');
  const recipe = await lab.submitRecipe({ ...candidate, validationId: validated.validationId }), workspaceDir = path.join(root, 'workbench');
  await lab.extractRecipe({ recipeId: recipe.recipeId, gameDir, workspaceDir });
  const built = await lab.dispatch('build', { workspaceDir, outputDir: path.join(root, 'build'), translations: [{ id: unit.id, translation: 'Hello, "traveler"' }] });
  const view = readTable({ bytes: await readFile(path.join(built.buildDir, selected.file)), file: selected.file });
  assert.equal(view.rows[0][1].value, 'Hello, "traveler"'); assert.equal(view.rows[1][1].value, 'Other');
  await assert.rejects(createTableSelections({ ...parameters, existingUnits: [unit] }), /already owned/);
  const legacy = { context: { file: selected.file, adaptationLocator: { file: selected.file, byteStart: unit.locator.byteStart + 1, byteEnd: unit.locator.byteEnd } } };
  await assert.rejects(createTableSelections({ ...parameters, existingUnits: [legacy] }), /already owned/);
});

test('host table selection rejects missing/duplicate/wrong fields, scope and unproved reasons', async t => {
  const { gameDir } = await fixture(t), parameters = { selections: [selected], gameDir, engine: 'Neutral' };
  await assert.rejects(createTableSelections({ ...parameters, selections: [] }));
  await assert.rejects(createTableSelections({ ...parameters, selections: [selected, selected] }), /Duplicate/);
  await assert.rejects(createTableSelections({ ...parameters, assignment: { files: ['other.csv'] } }), /assignment/);
  for (const change of [{ reason: '' }, { targetColumn: 'key' }, { sourceColumn: 'key' }, { key: 'missing' }, { targetColumn: 'missing' }, { delimiter: '\t' }, { file: '../outside.csv' }]) {
    await assert.rejects(createTableSelections({ ...parameters, selections: [{ ...selected, ...change }] }));
  }
  await writeFile(path.join(gameDir, selected.file), 'key,text\nintro,Hello\nintro,Other\n');
  await assert.rejects(createTableSelections(parameters), /exactly one/);
  await writeFile(path.join(gameDir, selected.file), 'key,text\nintro,Hello\nother,Other\nother,Other\n');
  await assert.rejects(createTableSelections(parameters), /unique/);
});
