import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';
import { runAdaptation } from './adaptation.mjs';

async function fixture(t, { complete = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-recipe-selection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gameDir = path.join(directory, 'game');
  await mkdir(gameDir);
  await writeFile(path.join(gameDir, 'story.json'), JSON.stringify({ lines: ['A neutral title.', 'A second menu item.', 'The final caption.'], logic: 'keep-id' }));
  const lab = await createAdapterLab({ dataDir: path.join(directory, 'lab'), workspaceFor: () => path.join(directory, 'work') });
  const save = async (count, id, version) => {
    const code = `({detect(){return true},extract(host){const data=JSON.parse(host.readText('story.json'));return {units:data.lines.slice(0,${count}).map((source,i)=>({id:'menu:'+i,source,context:{file:'story.json'},locator:{file:'story.json',pointer:'/lines/'+i}}))}},validate(){return {valid:true}},roundtrip(host){host.writeBytes('story.json',host.readBytes('story.json'));return {}},build(host,input){const data=JSON.parse(host.readText('story.json'));for(const unit of input.units){if(Object.hasOwn(input.translations,unit.id))data.lines[Number(unit.locator.pointer.split('/').pop())]=input.translations[unit.id]}host.writeText('story.json',JSON.stringify(data));return {}},assemble(){return {}}})`;
    const candidate = await lab.writeAdapter({ manifest: { schemaVersion: 1, id, version, engine: 'Neutral', scope: { files: ['story.json'] }, license: 'MIT', sources: [] }, code });
    const validation = await lab.validateAdapter({ ...candidate, gameDir });
    assert.equal(validation.passed, true, validation.error?.message);
    return lab.submitRecipe({ ...candidate, validationId: validation.validationId });
  };
  const partial = await save(1, 'neutral-newer-partial', '9.0.0');
  const full = complete ? await save(3, 'neutral-older-complete', '1.0.0') : undefined;
  return { directory, gameDir, lab, partial, full, save };
}

const checkCoverage = extraction => ({ needsAdaptation: extraction.units.length < 3, summary: { unresolvedCandidates: 3 - extraction.units.length }, dynamicCandidates: [] });

test('preferred complete recipes are revalidated before any smaller historical version', async t => {
  const { directory, gameDir, lab, partial, full } = await fixture(t);
  const checked = [];
  const extraction = await lab.tryRecipes({ gameDir, workspaceDir: path.join(directory, 'work'), engine: 'Neutral', preferredRecipeIds: [full.recipeId, partial.recipeId], evaluateCoverage: async item => { checked.push(item.recipeId); return checkCoverage(item); } });
  assert.deepEqual(checked, [full.recipeId]);
  assert.equal(extraction.units.length, 3);
  assert.equal(extraction.binding.recipeId, full.recipeId);
  const build = await lab.dispatch('build', { workspaceDir: extraction.workspaceDir, outputDir: path.join(directory, 'build'), translations: [{ id: 'menu:2', translation: 'A replacement final caption.' }] });
  assert.equal(JSON.parse(await readFile(path.join(build.buildDir, 'story.json'), 'utf8')).lines[2], 'A replacement final caption.');
});

test('true coverage supersedes a preferred partial recipe and an occupied older workbench', async t => {
  const { directory, gameDir, lab, partial, full } = await fixture(t);
  const workspaceDir = path.join(directory, 'work');
  await lab.extractRecipe({ recipeId: partial.recipeId, gameDir, workspaceDir });
  const checked = [];
  const extraction = await lab.tryRecipes({ gameDir, workspaceDir, engine: 'Neutral', preferredRecipeIds: [partial.recipeId], evaluateCoverage: async item => { checked.push(item.recipeId); return checkCoverage(item); } });
  assert.equal(checked[0], partial.recipeId);
  assert.equal(extraction.binding.recipeId, full.recipeId);
  assert.equal(extraction.checkedCoverage.needsAdaptation, false);
  assert.notEqual(extraction.workspaceDir, workspaceDir);
});

test('without a coverage callback recipe choice uses real stable locator coverage rather than version labels', async t => {
  const { directory, gameDir, lab, partial, full } = await fixture(t);
  const extraction = await lab.tryRecipes({ gameDir, workspaceDir: path.join(directory, 'work'), engine: 'Neutral', preferredRecipeIds: [partial.recipeId] });
  assert.equal(extraction.binding.recipeId, full.recipeId);
  assert.equal(extraction.units.length, 3);
});

test('host coverage errors remain visible during recipe selection', async t => {
  const { directory, gameDir, lab } = await fixture(t);
  await assert.rejects(lab.tryRecipes({ gameDir, workspaceDir: path.join(directory, 'work'), evaluateCoverage: async () => { throw new Error('Coverage fixture could not be read'); } }), /Coverage fixture/);
});

test('the best validated partial extraction survives an unfinished model round with its usable binding', async t => {
  const { directory, gameDir, lab, partial, save } = await fixture(t, { complete: false });
  const larger = await save(2, 'neutral-two-fields', '1.0.0');
  const result = await runAdaptation({ lab, project: { id: 'neutral-partial', name: 'Neutral menu', engine: 'Neutral' }, gameDir, workspaceDir: path.join(directory, 'work'),
    verifyCoverage: checkCoverage, generate: async () => ({ finishReason: 'stop' }) });
  assert.equal(result.status, 'needs-review');
  assert.equal(result.partialExtractions.length, 1);
  assert.equal(result.partialExtractions[0].binding.recipeId, larger.recipeId);
  assert.notEqual(result.partialExtractions[0].binding.recipeId, partial.recipeId);
  const built = await lab.dispatch('build', { projectId: 'neutral-partial', workspaceDir: result.partialExtractions[0].workspaceDir, outputDir: path.join(directory, 'build'), translations: [{ id: 'menu:1', translation: 'A changed second menu item.' }] });
  const content = JSON.parse(await readFile(path.join(built.buildDir, 'story.json'), 'utf8'));
  assert.equal(content.lines[1], 'A changed second menu item.');
  assert.equal(content.lines[2], 'The final caption.');
  assert.equal(content.logic, 'keep-id');
});
