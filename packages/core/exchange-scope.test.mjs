import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPackage, writePackage, sha256 } from '../exchange/index.mjs';
import { buildStoryContext, storyReadingMarkdown } from '../exchange/story.mjs';

const unit = (id, context = {}) => ({ id, legacyId: id, source: `Complete source ${id}.`, sourceHash: sha256(id),
  translation: `Current text ${id}.`, notes: '', revision: 0, tokens: [], kind: 'dialogue', context: { file: 'neutral.json', event: 1, ...context } });
const project = { id: 'neutral-project', sourceFingerprint: sha256('neutral-source'), targetLanguage: 'zh-Hans' };
const load = async (directory, name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'));
const temporary = async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-exchange-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

for (const profile of ['json', 'text']) test(`0.2 ${profile} exports only closed targets while preserving full read-only context`, async t => {
  const directory = await temporary(t), units = [unit('a'), unit('b', { syncGroup: 'linked' }), unit('c', { syncGroup: 'linked' }), unit('d')];
  const manifest = await writePackage(directory, { project, units, targetUnitIds: ['b'], stage: 'proofreading', profile });
  assert.equal(manifest.version, '0.2'); assert.equal(manifest.taskStage, 'proofreading');
  assert.deepEqual(manifest.unitIds, ['b', 'c']); assert.deepEqual(manifest.referenceUnitIds, ['a', 'd']);
  for (const file of ['source/units.json', 'baseline/units.json']) assert.deepEqual((await load(directory, file)).map(row => row.id), ['b', 'c']);
  assert.deepEqual((await load(directory, 'context/reference-units.json')).map(row => row.id), ['a', 'd']);
  assert.equal((await load(directory, 'context/scenes.json')).length, 4);
  const story = await load(directory, 'context/story.json'); assert.deepEqual(story.scenes[0].scope.unitIds, ['a', 'b', 'c', 'd']);
  const reading = await readFile(path.join(directory, 'reading/scenes.md'), 'utf8');
  assert.ok(units.every(row => reading.includes(row.source)));
  const guide = await readFile(path.join(directory, 'START_HERE.md'), 'utf8');
  assert.match(guide, /目标条数：2/); assert.match(guide, /只读参考条数：2/); assert.match(guide, /本轮逐条校对/);
  assert.ok(!guide.includes('初翻先完成本次全部目标，再校对'));
  const result = await readPackage(directory, { project, units });
  assert.equal(result.taskStage, 'proofreading'); assert.deepEqual(result.prepared.map(row => row.unit.id), ['b', 'c']);
  assert.ok(!result.supplementalFiles.includes('context/reference-units.json'));
});

test('0.2 targets default to all units and translation stage does not claim proofreading', async t => {
  const directory = await temporary(t), units = [unit('a'), unit('b')];
  const manifest = await writePackage(directory, { project, units });
  assert.deepEqual(manifest.unitIds, ['a', 'b']); assert.deepEqual(manifest.referenceUnitIds, []);
  assert.equal(manifest.taskStage, 'translation');
  assert.match(await readFile(path.join(directory, 'START_HERE.md'), 'utf8'), /本轮只交付初翻，不宣称已完成校对/);
});

test('0.2 rejects unknown and duplicate targets instead of silently widening the editable scope', async t => {
  const directory = await temporary(t), units = [unit('a')];
  for (const targetUnitIds of [['missing'], ['a', 'a']]) await assert.rejects(writePackage(directory, { project, units, targetUnitIds }), /重复或未知/);
  await assert.rejects(writePackage(directory, { project, units, stage: 'repair' }), /明确的初翻或校对阶段/);
});

test('0.2 reference text is immutable and cannot be submitted as an editable target', async t => {
  const directory = await temporary(t), units = [unit('a'), unit('b')];
  await writePackage(directory, { project, units, targetUnitIds: ['a'] });
  const edit = await load(directory, 'editable/units.json'); edit.push({ id: 'b', translation: '额外文字', notes: '', intent: 'submit' });
  await writeFile(path.join(directory, 'editable/units.json'), JSON.stringify(edit));
  await assert.rejects(readPackage(directory, { project, units }), /完整回包的记录数量不匹配/);
  await writeFile(path.join(directory, 'editable/units.json'), JSON.stringify(edit.slice(0, 1)));
  const references = await load(directory, 'context/reference-units.json'); references[0].translation = '被修改的参考';
  await writeFile(path.join(directory, 'context/reference-units.json'), JSON.stringify(references));
  await assert.rejects(readPackage(directory, { project, units }), /只读材料已改变/);
});

test('legacy 0.1 complete packages remain readable with an explicitly unknown stage', async t => {
  const directory = await temporary(t), units = [unit('a')];
  const manifest = await writePackage(directory, { project, units });
  manifest.version = '0.1'; delete manifest.taskStage; delete manifest.referenceUnitIds;
  manifest.requiredCapabilities = ['three-way-merge', 'editable-json'];
  delete manifest.files['context/reference-units.json'];
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  const result = await readPackage(directory, { project, units });
  assert.equal(result.taskStage, 'unknown'); assert.equal(result.manifest.version, '0.1');
  assert.equal(Object.hasOwn(result.manifest, 'taskStage'), false); assert.equal(result.prepared.length, 1);
});

test('character reading indexes evidence and scene references without copying scene bodies', () => {
  const units = [unit('a', { actorId: 1, speaker: 'Mina' }), unit('b', { actorId: 2, speaker: 'Leo' })];
  const story = buildStoryContext(units), characters = storyReadingMarkdown(story, units, 'character');
  assert.match(characters, /身份依据/); assert.match(characters, /相关只读条目 ID/); assert.match(characters, /scenes\.md#/);
  assert.ok(story.characters.length >= 2);
  for (const row of units) { assert.ok(!characters.includes(row.source)); assert.ok(!characters.includes(row.translation)); }
  const scenes = storyReadingMarkdown(story, units);
  for (const row of units) assert.ok(scenes.includes(row.source));
});
