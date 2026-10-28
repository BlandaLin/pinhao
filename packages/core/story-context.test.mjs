import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildStoryContext, compactStoryUnits, compactStoryContext, storyBlockReference, storyMaterialEntrypoints, readStoryContext, verifyStoryReading, storyReadingMarkdown } from '../exchange/story.mjs';
import { writePackage, readPackage, sha256 } from '../exchange/index.mjs';

const unit = (index, context = {}, patch = {}) => ({ id: `u-${index}`, source: `Complete sentence ${index}.`,
  translation: `Current sentence ${index}.`, notes: '', revision: 0, tokens: [], kind: 'dialogue',
  sourceHash: sha256(`Complete sentence ${index}.`), context: { file: 'data/Map001.json', map: 'Map001', event: 1, page: 0, ...context }, ...patch });

test('single-item material says its complete text is already supplied for string and unit inputs', () => {
  const item = unit(1), story = buildStoryContext([item]);
  for (const input of [[item.id], [item], [item, item.id]]) {
    const [scope] = storyMaterialEntrypoints(story, input).scopes;
    assert.equal(scope.total, 1); assert.equal(scope.providedTextCount, 1);
  }
});

test('partial material counts only supplied scope members without claiming complete scene text', () => {
  const items = [unit(1), unit(2), unit(3, { event: 2 })], story = buildStoryContext(items);
  const [scope] = storyMaterialEntrypoints(story, [items[0].id, items[2]]).scopes;
  assert.equal(scope.total, 2); assert.equal(scope.providedTextCount, 1);
  assert.equal(storyMaterialEntrypoints(story, items.slice(0, 2)).scopes[0].providedTextCount, 2);
});

for (const count of [40, 137]) test(`complete ${count}-unit scope survives transport pages and binds reading receipts`, () => {
  const units = Array.from({ length: count }, (_, index) => unit(index, { branch_path: index < 20 ? [] : [{ type: 'choice', index: 1 }] }));
  units[15].context.syncGroup = 'linked'; units[16].context.syncGroup = 'linked';
  units[18].source = 'A complete long sentence. '.repeat(3000);
  const story = buildStoryContext(units), scope = story.scenes[0].scope, receipts = [];
  assert.equal(story.scenes.length, 1); assert.equal(scope.unitIds.length, count);
  let offset = 0, first;
  while (offset < count) {
    const page = readStoryContext(story, units, { kind: 'scene', id: scope.id, offset, limit: 16 });
    first ??= page;
    assert.equal(page.scope.id, scope.id); assert.equal(page.scope.version, scope.version);
    receipts.push(page.receipt); offset = page.nextOffset;
  }
  assert.equal(first.records.length, 17); assert.equal(receipts.at(-1).unitIds.at(-1), `u-${count - 1}`);
  assert.equal(verifyStoryReading(story, scope, receipts).complete, true);
  assert.equal(verifyStoryReading(story, scope, receipts.slice(0, -1)).complete, false);
  assert.equal(readStoryContext(story, units, { ...scope, offset: 17 }).records[1].source, units[18].source);
  assert.match(storyReadingMarkdown(story, units), new RegExp(`u-${count - 1}`));
  const changed = buildStoryContext(units.map((entry, index) => index === count - 1 ? { ...entry, translation: 'A changed ending.', revision: 1 } : entry));
  assert.equal(verifyStoryReading(changed, changed.scenes[0].scope, receipts).stale, true);
});

test('static common-event calls share IDs, map transfers remain links, dynamic targets stay unknown', () => {
  const call = [{ kind: 'common-event-call', command: 1, target: { common_event: 7 }, state: 'confirmed' },
    { kind: 'map-transfer', command: 2, target: { map: 'Map002' }, state: 'confirmed' },
    { kind: 'map-transfer', command: 3, target: null, state: 'unknown' }];
  const units = [unit(1, { storyLinks: call }), unit(2, { event: 2, storyLinks: call }),
    unit(3, { file: 'data/CommonEvents.json', common_event: 7, map: undefined, event: undefined, page: undefined }),
    unit(4, { map: 'Map002', file: 'data/Map002.json' })];
  const story = buildStoryContext(units);
  assert.equal(story.blocks.length, 4);
  assert.deepEqual(story.scenes[0].scope.unitIds, ['u-1', 'u-3']);
  assert.deepEqual(story.scenes[1].scope.unitIds, ['u-2', 'u-3']);
  assert.equal(story.blocks.flatMap(block => block.unitIds).filter(id => id === 'u-3').length, 1);
  assert.ok(story.links.some(link => link.kind === 'map-transfer' && link.state === 'unknown'));
});

test('twenty thousand units retain one complete thousand-link block instead of a unit/link cross product', () => {
  const links = Array.from({ length: 1000 }, (_, index) => ({ kind: 'conditional-branch', command: index,
    target: { map: 'Map001', event: 1, page: 0 }, condition: [0, index, 0], branch: 'then', state: 'confirmed' }));
  const original = Array.from({ length: 20000 }, (_, index) => unit(index, { storyLinks: links, command: index,
    branch_path: [{ type: 'conditional', command: index, side: index % 2 ? 'then' : 'else' }] }));
  const compact = compactStoryUnits(original);
  assert.equal(compact.reduce((sum, entry) => sum + (entry.context.storyLinks?.length ?? 0), 0), 1000);
  assert.equal(new Set(compact.map(entry => entry.context.storyBlockRef)).size, 1);
  assert.equal(new Set(compact.map(entry => entry.context.storyLinksHash)).size, 1);
  assert.equal(compact[0].id, original[0].id); assert.equal(compact.at(-1).source, original.at(-1).source);
  assert.deepEqual(compact.at(-1).context.branch_path, original.at(-1).context.branch_path);
  assert.ok(JSON.stringify(compact).length < 15_000_000);
  assert.equal(original.at(-1).context.storyLinks.length, 1000);
  assert.deepEqual(compactStoryUnits(compact), compact);
  const story = buildStoryContext(compact), scope = story.scenes[0].scope;
  assert.equal(story.links.length, 1000); assert.equal(scope.unitIds.length, 20000);
  const page = readStoryContext(story, compact, { ...scope, offset: 19968, limit: 32 });
  assert.equal(page.records.length, 32); assert.equal(page.links.length, 1000);
  assert.equal(page.blocks[0].id, compact[0].context.storyBlockRef);
  const evidence = compactStoryContext(original[10].context);
  assert.ok(!Object.hasOwn(evidence, 'storyLinks')); assert.equal(evidence.storyLinksHash, compact[10].context.storyLinksHash);
  assert.equal(storyBlockReference(compact[0].context), story.blocks[0].id);
});

test('compaction unions legacy per-unit links, preserves dynamic uncertainty and invalidates affected scopes', () => {
  const first = [{ kind: 'common-event-call', command: 1, target: { common_event: 7 }, state: 'confirmed' }];
  const later = [{ kind: 'map-transfer', command: 2, target: null, state: 'unknown' }];
  const units = [unit(1, { storyLinks: first }), unit(2, { storyLinks: [...first, ...later] }),
    unit(3, { file: 'data/CommonEvents.json', common_event: 7, map: undefined, event: undefined, page: undefined })];
  const compact = compactStoryUnits(units), before = buildStoryContext(compact);
  assert.equal(compact[0].context.storyLinks.length, 2); assert.ok(!compact[1].context.storyLinks);
  assert.deepEqual(before.scenes[0].scope.unitIds, ['u-1', 'u-2', 'u-3']);
  assert.equal(before.links.find(link => link.command === 2).state, 'unknown');
  const changed = compactStoryUnits([unit(1, { storyLinks: [...first, { ...later[0], command: 4 }] }), ...units.slice(1)]);
  assert.notEqual(compact[1].context.storyLinksHash, changed[1].context.storyLinksHash);
  assert.notEqual(before.scenes[0].scope.version, buildStoryContext(changed).scenes[0].scope.version);
});

test('actor IDs, name controls and name fields carry evidence while faces and names do not imply identity', () => {
  const units = [unit(1, { file: 'data/Actors.json', record: 2, actor_id: 2 }, { kind: 'database_name', source: 'Lin' }),
    unit(2, { speaker: 'Lin', face: 'same-face' }), unit(3, { speaker: 'Lin', event: 2, face: 'same-face' }),
    unit(4, { speaker: 'unknown', face: 'same-face' }),
    unit(5, { speaker: '\\N[2]' }, { controls: { '{{CTRL1}}': '\\N[2]' } }),
    unit(6, { actor_id: 2, code: 320 }, { kind: 'actor_attribute', source: 'New name' })];
  const story = buildStoryContext(units), actor = story.characters.find(character => character.actorId === 2);
  assert.deepEqual(actor.unitIds, ['u-1', 'u-5', 'u-6']);
  assert.ok(actor.bindings.some(binding => binding.relation === 'rename-command'));
  assert.equal(story.characters.filter(character => character.names.includes('Lin')).length, 3);
  assert.equal(story.characters.some(character => character.unitIds.includes('u-4')), false);
  const other = unit(7, { event: 3 }); const old = buildStoryContext([...units, other]);
  const changed = buildStoryContext([...units, { ...other, translation: 'Only unrelated block changed', revision: 1 }]);
  assert.equal(old.scenes[0].scope.version, changed.scenes[0].scope.version);
});

test('new 0.2 package carries checksummed story and full handoff; position-only context remains readable', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-story-')); t.after(() => rm(root, { recursive: true, force: true }));
  const units = Array.from({ length: 107 }, (_, index) => unit(index));
  const project = { id: 'neutral-project', sourceFingerprint: 'neutral-baseline', targetLanguage: 'zh-Hans' };
  const manifest = await writePackage(root, { project, units });
  assert.equal(manifest.version, '0.2'); assert.ok(manifest.files['context/story.json']);
  assert.ok(!manifest.requiredCapabilities.some(capability => capability.includes('story')));
  assert.match(await readFile(path.join(root, 'reading/scenes.md'), 'utf8'), /u-106/);
  assert.match(await readFile(path.join(root, 'START_HERE.md'), 'utf8'), /子代理/);
  assert.match(await readFile(path.join(root, 'START_HERE.md'), 'utf8'), /无需配置本软件 API/);
  assert.equal((await readPackage(root, { project, units })).contextStatus, 'story-materials');
  const storyPath = path.join(root, 'context/story.json'), original = await readFile(storyPath);
  await writeFile(storyPath, '{}');
  await assert.rejects(readPackage(root, { project, units }), /只读材料已改变/);
  await writeFile(storyPath, original);
  delete manifest.files['context/story.json']; delete manifest.extensions['pinhao.story'];
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  assert.equal((await readPackage(root, { project, units })).contextStatus, 'engine-position-only');
});

test('external work package compacts legacy relation copies and keeps source identities and returned translations', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-legacy-story-')); t.after(() => rm(root, { recursive: true, force: true }));
  const links = [{ kind: 'map-transfer', command: 400, target: null, state: 'unknown' }];
  const units = Array.from({ length: 107 }, (_, index) => unit(index, { storyLinks: [...links] }));
  const project = { id: 'neutral-legacy-project', sourceFingerprint: 'neutral-legacy-baseline', targetLanguage: 'zh-Hans' };
  const manifest = await writePackage(root, { project, units, extensions: { 'neutral.extension': { enabled: true } } });
  const source = JSON.parse(await readFile(path.join(root, 'source/units.json'), 'utf8'));
  assert.equal(source.reduce((sum, entry) => sum + (entry.context.storyLinks?.length ?? 0), 0), 1);
  assert.deepEqual(source.map(entry => [entry.id, entry.source, entry.sourceHash, entry.tokens]), units.map(entry => [entry.id, entry.source, entry.sourceHash, entry.tokens]));
  assert.equal(manifest.extensions['neutral.extension'].enabled, true);
  const editablePath = path.join(root, 'editable/units.json'), editable = JSON.parse(await readFile(editablePath, 'utf8'));
  editable.at(-1).translation = 'The returned neutral ending.';
  await writeFile(editablePath, JSON.stringify(editable));
  const restored = await readPackage(root, { project, units });
  assert.equal(restored.prepared.at(-1).returned, 'The returned neutral ending.');
  assert.equal(units.at(-1).context.storyLinks.length, 1);
});
