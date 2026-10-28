import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTextAdapter } from './adaptation/text-adapter.mjs';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-text-scaffold-'));
  const gameDir = path.join(root, 'game'); await mkdir(gameDir);
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  return { root, gameDir };
}
const quoted = (file, text, literal, source) => {
  const index = text.indexOf(literal);
  return { file, source, classification: 'display_unresolved', target: { start: Array.from(text.slice(0, index)).length, end: Array.from(text.slice(0, index + literal.length)).length, render: 'quoted' } };
};

test('host scaffold validates JSON pointers and multiple changing Unicode quoted spans through the real lab', async t => {
  const { root, gameDir } = await fixture(t);
  const script = '# Unicode prefix: 中文😀\nextends Node\nvar first = "First scene."\nvar second = \'Second scene.\'\nvar resource = "res://keep.png"\n';
  const data = JSON.stringify({ text: 'Same scene.', other: { 'a/b~': 'Same scene.' }, logic: { id: 7 } });
  await writeFile(path.join(gameDir, 'dialogue.gd'), script); await writeFile(path.join(gameDir, 'story.json'), data);
  const candidates = [quoted('dialogue.gd', script, '"First scene."', 'First scene.'), quoted('dialogue.gd', script, "'Second scene.'", 'Second scene.'),
    { file: 'story.json', source: 'Same scene.', path: ['text'] }, { file: 'story.json', source: 'Same scene.', path: ['other', 'a/b~'] }];
  const definition = await createTextAdapter({ gameDir, candidates, engine: 'Neutral text fixture' });
  const lab = await createAdapterLab({ dataDir: path.join(root, 'recipes') });
  const candidate = await lab.writeAdapter(definition);
  const validation = await lab.validateAdapter({ ...candidate, gameDir });
  assert.equal(validation.passed, true, validation.error?.message);
  const recipe = await lab.submitRecipe({ ...candidate, validationId: validation.validationId });
  const extraction = await lab.extractRecipe({ ...recipe, gameDir, workspaceDir: path.join(root, 'work') });
  const translations = extraction.units.map((unit, index) => ({ id: unit.id, translation: `第${index + 1}段更长的中文。` }));
  const built = await lab.dispatch('build', { workspaceDir: extraction.workspaceDir, outputDir: path.join(root, 'built'), translations });
  const actual = await readFile(path.join(built.buildDir, 'dialogue.gd'), 'utf8');
  assert.match(actual, /var first = "第1段更长的中文。"/);
  assert.match(actual, /var second = '第2段更长的中文。'/);
  assert.match(actual, /var resource = "res:\/\/keep.png"/);
  assert.equal(JSON.parse(await readFile(path.join(built.buildDir, 'story.json'), 'utf8')).logic.id, 7);
  assert.equal(await readFile(path.join(gameDir, 'dialogue.gd'), 'utf8'), script);
  assert.equal(await readFile(path.join(gameDir, 'story.json'), 'utf8'), data);
});

test('text scaffold rejects stale, duplicate, already owned and out-of-assignment targets', async t => {
  const { gameDir } = await fixture(t);
  await writeFile(path.join(gameDir, 'story.json'), '{"text":"A neutral scene.","id":"keep"}');
  const item = { file: 'story.json', source: 'A neutral scene.', path: ['text'] };
  const base = { gameDir, engine: 'Neutral', candidates: [item] };
  await assert.rejects(createTextAdapter({ ...base, candidates: [{ ...item, source: 'Old text.' }] }), /不一致/);
  await assert.rejects(createTextAdapter({ ...base, candidates: [item, item] }), /重复定位/);
  await assert.rejects(createTextAdapter({ ...base, assignment: { files: ['other.json'] } }), /分工/);
  await assert.rejects(createTextAdapter({ ...base, existingUnits: [{ locator: { file: 'story.json', pointer: '/text' } }] }), /已经/);
  await assert.rejects(createTextAdapter({ ...base, existingUnits: [{ locator: { pointer: '/text', file: 'story.json' } }] }), /已经/);
  await assert.rejects(createTextAdapter({ ...base, candidates: [{ ...item, classification: 'logic_identity' }] }), /逻辑/);
  await assert.rejects(createTextAdapter({ ...base, candidates: [{ ...item, file: '../outside.json' }] }), /路径/);
});

test('host-generated quoted adapter still rejects quote-closing code injection', async t => {
  const { root, gameDir } = await fixture(t);
  const text = 'extends Node\nvar label = "Neutral label."\n';
  await writeFile(path.join(gameDir, 'view.gd'), text);
  const definition = await createTextAdapter({ gameDir, engine: 'Neutral', candidates: [quoted('view.gd', text, '"Neutral label."', 'Neutral label.')] });
  const lab = await createAdapterLab({ dataDir: path.join(root, 'recipes') });
  const candidate = await lab.writeAdapter(definition);
  const validation = await lab.validateAdapter({ ...candidate, gameDir });
  assert.equal(validation.passed, true, validation.error?.message);
  const recipe = await lab.submitRecipe({ ...candidate, validationId: validation.validationId });
  const extraction = await lab.extractRecipe({ ...recipe, gameDir, workspaceDir: path.join(root, 'work') });
  await assert.rejects(lab.dispatch('build', { workspaceDir: extraction.workspaceDir, outputDir: path.join(root, 'built'), translations: [{ id: extraction.units[0].id, translation: 'close"; quit(); #' }] }), /结构|边界/);
  assert.equal(await readFile(path.join(gameDir, 'view.gd'), 'utf8'), text);
});
