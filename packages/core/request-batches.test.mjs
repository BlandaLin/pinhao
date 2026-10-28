import test from 'node:test';
import assert from 'node:assert/strict';
import { taskPrompt } from './provider.mjs';
import { decodeTextResponse } from './text-wire.mjs';
import { buildStoryContext } from '../exchange/story.mjs';
import {
  collectRequestReferences,
  createRequestReferenceSelector,
  packRequestBatches,
  requestPromptCharacters,
  REQUEST_BATCH_LIMITS,
} from './request-batches.mjs';

const makeUnit = (index, patch = {}) => ({
  id: `unit-${index}`, kind: 'message', source: `Complete neutral paragraph ${index}.`,
  translation: '', notes: '', tokens: [], context: { file: `scene-${index}.json`, event: index }, ...patch,
});

test('small logical scenes share requests without changing units, order or context', () => {
  const groups = Array.from({ length: 35 }, (_, index) => [makeUnit(index)]);
  const before = structuredClone(groups);
  const batches = packRequestBatches(groups);
  assert.deepEqual(batches.map(batch => batch.length), [16, 16, 3]);
  assert.deepEqual(batches.flat(), groups.flat());
  assert.deepEqual(groups, before);
  for (const batch of batches) {
    const references = collectRequestReferences(groups.flat(), batch.map(unit => [unit]));
    assert.ok(requestPromptCharacters(taskPrompt('translation', batch, 'zh-Hans', references)) <= REQUEST_BATCH_LIMITS.maxCharacters);
  }
  assert.deepEqual(packRequestBatches([]), []);
});

test('bounded planning counts transport batches rather than logical scenes', () => {
  const groups = Array.from({ length: 1000 }, (_, index) => [makeUnit(index)]);
  let inspected = 0;
  // `referenceSelector` replaced the old `referencesForUnits` hook: the packer now asks the
  // selector for the candidate batch instead of pre-computing references per unit.
  const selector = (() => { inspected++; return []; });
  const batches = packRequestBatches(groups, { maxBatches: 16, referenceSelector: selector });
  assert.equal(batches.length, 16);
  assert.ok(batches.every(batch => batch.length === 16));
  assert.deepEqual(batches.flat(), groups.slice(0, 256).flat());
  assert.equal(new Set(batches.flat().map(unit => unit.id)).size, 256);
  assert.ok(inspected <= 257, 'Stop after the bounded prefix, not the entire project');
  assert.deepEqual(packRequestBatches(groups, { maxBatches: 0 }), []);
});

test('batch windows retain synchronized groups without splitting and trim references before splitting', () => {
  const linked = Array.from({ length: 19 }, (_, index) => makeUnit(index, { context: { syncGroup: 'linked' } }));
  const groups = [linked, [makeUnit(20)], [makeUnit(21)]];
  assert.deepEqual(packRequestBatches(groups, { maxBatches: 1 }), [linked]);
  // An over-budget window must shed reference context and re-measure instead of splitting a
  // logical group or shipping the request unbudgeted.
  const scene = { file: 'shared.json', event: 1 };
  const evidence = [{ source: 'Reference scene evidence. '.repeat(40) }];
  const allUnits = Array.from({ length: 12 }, (_, index) => makeUnit(index,
    { source: 'Complete neutral paragraph.', context: { ...scene, evidence } }));
  const references = collectRequestReferences(allUnits, [[allUnits[0]]]);
  assert.ok(references.length > 0, 'the scene provides reference context at the normal budget');
  // The batch budget covers story material too, so the baseline must be measured the same way the
  // packer measures it — otherwise the midpoint lands just under a limit the packer already exceeds.
  const size = (units, refs) => requestPromptCharacters(taskPrompt('translation', units, 'zh-Hans', refs, [],
    { story: buildStoryContext(allUnits) }));
  const withReferences = size([allUnits[0]], references);
  const withoutReferences = size([allUnits[0]], []);
  const maxCharacters = Math.floor((withReferences + withoutReferences) / 2);
  const trimmed = packRequestBatches([[allUnits[0]], [allUnits[1]]], { allUnits, maxCharacters });
  assert.deepEqual(trimmed.map(batch => batch.map(unit => unit.id)), [['unit-0', 'unit-1']],
    'reference context is trimmed to the budget, so the two groups still share one request');
});

test('request limits measure system, semantic context, nearby references and glossary together', () => {
  const allUnits = Array.from({ length: 17 }, (_, index) => makeUnit(index, { source: 'reference '.repeat(50) }));
  allUnits[3] = makeUnit(3, { context: { file: 'first.json', scene: 'context '.repeat(100) } });
  allUnits[13] = makeUnit(13, { context: { file: 'last.json', scene: 'context '.repeat(100) } });
  const groups = [[allUnits[3]], [allUnits[13]]];
  const glossary = [{ source: 'term', translation: 'translation '.repeat(100), category: 'term', aliases: [] }];
  const size = logical => requestPromptCharacters(taskPrompt('proofreading', logical.flat(), 'zh-Hans', collectRequestReferences(allUnits, logical), glossary));
  const maxCharacters = Math.max(...groups.map(group => size([group])));
  assert.ok(size(groups) > maxCharacters);
  const batches = packRequestBatches(groups, { role: 'proofreading', allUnits, glossaryForUnits: () => glossary, maxCharacters });
  assert.deepEqual(batches.map(batch => batch.map(unit => unit.id)), [['unit-3'], ['unit-13']]);
  assert.ok(batches.every(batch => size([batch]) <= maxCharacters));
  assert.deepEqual(packRequestBatches(groups, { allUnits: [], maxCharacters: 1 }).map(batch => batch.length), [1, 1]);
  assert.equal(requestPromptCharacters({ system: 'system', prompt: 'payload' }), 13);
});

test('an existing oversized logical group is isolated rather than split or merged', () => {
  const linked = Array.from({ length: 19 }, (_, index) => makeUnit(index, { context: { syncGroup: 'shared-title', file: `file-${index}` } }));
  const large = [makeUnit(20, { source: 'complete paragraph '.repeat(1000) })];
  const last = [makeUnit(21)];
  const batches = packRequestBatches([[makeUnit(-1)], linked, large, last], { allUnits: [] });
  assert.deepEqual(batches.map(batch => batch.length), [1, 19, 1, 1]);
  assert.deepEqual(batches[1], linked);
  assert.deepEqual(batches[2], large, 'an over-budget group never absorbs its neighbours');
  // This unit exceeds the budget on its own, so isolation is the only correct outcome; the
  // budget must not be "paid" by leaving reference context attached to it.
  assert.ok(requestPromptCharacters(taskPrompt('translation', large, 'zh-Hans', [])) > REQUEST_BATCH_LIMITS.maxCharacters);
  assert.equal(batches[3][0].id, last[0].id);
});

test('unrelated extraction neighbors are excluded from scene references', () => {
  const allUnits = Array.from({ length: 20 }, (_, index) => makeUnit(index));
  const groups = [[allUnits[3]], [allUnits[16]]];
  assert.deepEqual(collectRequestReferences(allUnits, groups), []);
  const linked = [[allUnits[3], allUnits[16]]];
  assert.deepEqual(collectRequestReferences(allUnits, linked), []);
});

test('one snapshot selector serves collection and batching without rebuilding project indexes', () => {
  let kindReads = 0;
  const allUnits = Array.from({ length: 2000 }, (_, index) => {
    const unit = makeUnit(index);
    Object.defineProperty(unit, 'kind', { enumerable: true, get() { kindReads++; return 'message'; } });
    return unit;
  });
  const groups = [[allUnits[20]], [allUnits[30]], [allUnits[40]]];
  const selector = createRequestReferenceSelector(allUnits);
  const expected = collectRequestReferences(allUnits, groups);
  kindReads = 0;
  assert.deepEqual(collectRequestReferences(allUnits, groups, selector), expected);
  assert.deepEqual(selector(groups), expected);
  assert.equal(kindReads, 0);
  assert.deepEqual(packRequestBatches(groups, { allUnits, referenceSelector: selector }),
    packRequestBatches(groups, { allUnits }));
});

test('a rebuilt snapshot selector observes accepted names and actor binding changes', () => {
  const allUnits = Array.from({ length: 20 }, (_, index) => makeUnit(index));
  allUnits[0] = makeUnit(0, { kind: 'database_name', source: 'Lin', translation: 'Lin', status: 'pending',
    legacyId: 'Actors:00001', context: { file: 'Actors.json', record: 1 } });
  allUnits[19] = makeUnit(19, { source: 'Lin arrives.' });
  const selector = createRequestReferenceSelector(allUnits);
  assert.equal(selector([[allUnits[19]]]).some(unit => unit.id === 'unit-0'), false);
  allUnits[0] = { ...allUnits[0], translation: '林', status: 'translated' };
  const current = createRequestReferenceSelector(allUnits);
  assert.equal(current([[allUnits[19]]]).some(unit => unit.id === 'unit-0'), false, 'A literal substring does not establish actor identity');
  allUnits[19] = { ...allUnits[19], source: '{{CTRL1}} arrives.', controls: { '{{CTRL1}}': '\\N[1]' } };
  assert.equal(createRequestReferenceSelector(allUnits)([[allUnits[19]]]).find(unit => unit.id === 'unit-0').translation, '林');
});

test('complete related block references are deduplicated and requested IDs stay excluded', () => {
  const allUnits = Array.from({ length: 12 }, (_, index) => makeUnit(index, { context: { file: 'one-scene.json', event: 1 } }));
  allUnits[0] = makeUnit(0, { kind: 'database_name', source: 'Lin', translation: 'accepted name', status: 'proofread' });
  allUnits[2] = makeUnit(2, { kind: 'nickname', source: 'Lin', translation: 'accepted nickname', status: 'translated' });
  allUnits[4] = makeUnit(4, { source: 'Talk to Lin.' });
  const references = collectRequestReferences(allUnits, [[allUnits[4]], [allUnits[6]]]);
  assert.deepEqual(references.map(unit => unit.id), [1, 3, 5, 7, 8, 9, 10, 11].map(index => `unit-${index}`));
  assert.equal(new Set(references.map(unit => unit.id)).size, references.length);
});

test('prompt projection keeps declared scene fields and removes unknown internal objects', () => {
  const context = Object.freeze({
    file: 'scene.json', event: 7, page: 2, scene: 'neutral scene', speaker: 'Lin', syncGroup: 'linked',
    controlFingerprint: 'host-only-hash', protectedControlSyntax: 'rpgmaker-v1',
    nested: { controlFingerprint: 'retained nested scene evidence' },
  });
  const unit = makeUnit(1, { source: 'Keep {{P1}} intact.', translation: 'Current {{P1}} text.', tokens: ['{{P1}}'], context });
  const reference = makeUnit(2, { context });
  const payload = taskPrompt('translation', [unit], 'zh-Hans', [reference]).wire.payload;
  const expected = { ...context };
  delete expected.controlFingerprint;
  delete expected.protectedControlSyntax;
  delete expected.nested;
  assert.deepEqual(payload.units[0].context, expected);
  assert.deepEqual(payload.referenceOnly[0].context, expected);
  assert.equal(payload.units[0].id, unit.id);
  assert.equal(payload.units[0].source, unit.source);
  assert.equal(payload.units[0].currentTranslation, unit.translation);
  assert.deepEqual(payload.units[0].tokens, unit.tokens);
  assert.equal(context.controlFingerprint, 'host-only-hash');
  assert.equal(context.protectedControlSyntax, 'rpgmaker-v1');
});

test('sparse same-scene targets retain interior evidence without filling gaps between unrelated scenes', () => {
  const allUnits = Array.from({ length: 10 }, (_, index) => makeUnit(index, { context: { file: 'same.json', event: 1, page: 0 } }));
  const references = collectRequestReferences(allUnits, [[allUnits[0], allUnits[9]]]);
  assert.deepEqual(references.map(unit => unit.id), allUnits.slice(1, 9).map(unit => unit.id));
});

test('transport preview keeps complete linked references while the full large scope stays separately readable', () => {
  const allUnits = Array.from({ length: 103 }, (_, index) => makeUnit(index, { context: { file: 'large.json', event: 1 } }));
  allUnits[1].context.syncGroup = 'linked-reference'; allUnits[80].context.syncGroup = 'linked-reference';
  const references = collectRequestReferences(allUnits, [[allUnits[0]]]);
  assert.ok(references.some(unit => unit.id === 'unit-80'));
  assert.ok(!references.some(unit => unit.id === 'unit-102'), 'Last-page material is read by scope tool, not inserted into every request');
});

test('late targets receive nearby complete dialogue in reading order without crossing unrelated branches', () => {
  const allUnits = Array.from({ length: 100 }, (_, index) => makeUnit(index, { context: { file: 'long.json', event: 1,
    branch_path: index === 79 ? [{ side: 'else' }] : [] } }));
  const references = collectRequestReferences(allUnits, [[allUnits[80]]]);
  assert.ok(references.some(unit => unit.id === 'unit-81'));
  assert.ok(references.some(unit => unit.id === 'unit-78'));
  assert.ok(!references.some(unit => unit.id === 'unit-0'));
  assert.ok(!references.some(unit => unit.id === 'unit-79'));
  assert.deepEqual(references.map(unit => Number(unit.id.slice(5))), references.map(unit => Number(unit.id.slice(5))).sort((a, b) => a - b));
});

test('shared scene evidence stays readable once while real translations, notes and control meaning remain distinct', () => {
  const scene = 'A complete scene with neutral context. '.repeat(100);
  const units = Array.from({ length: 8 }, (_, index) => makeUnit(index, { source: 'Same complete source.', translation: 'Same complete source.',
    notes: `note ${index}`, controls: { '{{CTRL1}}': `\\N[${index}]` }, context: { evidence: [{ source: scene }] } }));
  units[2].translation = '人工保留现译';
  const projection = taskPrompt('translation', units, 'zh-Hans');
  const payload = projection.wire.payload;
  assert.equal(projection.prompt.split(scene).length - 1, 1);
  assert.ok(projection.prompt.length < scene.length * 2);
  assert.equal(payload.units[0].currentTranslation, undefined);
  assert.equal(payload.units[2].currentTranslation, '人工保留现译');
  assert.equal(payload.units[2].notes, 'note 2');
  assert.notDeepEqual(payload.units[0].controls, payload.units[1].controls);
  assert.equal(taskPrompt('proofreading', units, 'zh-Hans').wire.payload.units[0].currentTranslation, units[0].translation);
});

test('complete source occurrences keep independent host identities and short references', () => {
  const units = [makeUnit(1, { source: 'Shared wording', context: { speaker: 'Actor' } }), makeUnit(2, { source: 'Shared wording', context: { speaker: 'Item' } })];
  const prompt = taskPrompt('translation', units, 'zh-Hans'), payload = prompt.wire.payload;
  assert.equal(prompt.prompt.split('Shared wording').length - 1, 2);
  assert.equal(payload.units[0].source, payload.units[1].source);
  const references = new Map(prompt.wire.state.entries.map(([ref, id]) => [id, ref]));
  assert.notEqual(references.get(units[0].id), references.get(units[1].id));
  assert.notEqual(payload.units[0].id, payload.units[1].id);
  assert.notDeepEqual(payload.units[0].context, payload.units[1].context);
});

test('actor-name control bindings resolve to their database evidence beyond adjacent references', () => {
  const allUnits = Array.from({ length: 12 }, (_, index) => makeUnit(index));
  allUnits[0] = makeUnit(0, { kind: 'database_name', source: 'Alice', translation: '爱丽丝', legacyId: 'Actors:00001', context: { file: 'Actors.json', record: 7 } });
  allUnits[11] = makeUnit(11, { source: '{{CTRL1}} arrives.', controls: { '{{CTRL1}}': '\\N[7]' } });
  assert.ok(collectRequestReferences(allUnits, [[allUnits[11]]]).some(unit => unit.id === allUnits[0].id));
});

test('differential proofreading and scoped preparation use explicit internal protocols', () => {
  const units = [makeUnit(1)], preparation = { decisions: [
    { id: 'visible', status: 'active', entity: 'actor', sense: 'person', scope: { unitIds: ['unit-1'] }, evidenceIds: ['unit-1'], revision: 1, receipts: [{ host: 'private' }] },
    { id: 'unrelated', status: 'active', scope: { unitIds: ['other'] } },
  ] };
  const prompt = taskPrompt('proofreading', units, 'zh-Hans', [], [], { reviewProtocol: true, preparation });
  const payload = prompt.wire.payload;
  assert.equal(prompt.responseProtocol, 'pinhao-review-1'); assert.equal(payload.responseProtocol, prompt.responseProtocol);
  assert.deepEqual(payload.preparation.map(decision => decision.id), ['visible']);
  assert.equal(payload.preparation[0].receipts, undefined);
  const ref = prompt.wire.state.entries.find(([, id]) => id === units[0].id)[0];
  assert.deepEqual(decodeTextResponse({ reviewed: [ref] }, prompt.wire).review.edits, []);
  assert.match(taskPrompt('translation', units, 'zh-Hans').system, /equivalence.*fromUnitId.*toUnitIds/);
  assert.doesNotMatch(prompt.system, /初翻时可顺手附 terms/);
});

test('initial translation keeps names in ordinary batches and normalizes optional choices with the same text response', () => {
  const units = Array.from({ length: 18 }, (_, index) => makeUnit(index, { kind: index ? 'message' : 'character_name',
    source: index ? `Alice enters room ${index}.` : 'Alice', translation: index ? `Alice enters room ${index}.` : 'Alice' }));
  const batches = packRequestBatches(units.map(unit => [unit]), { referenceSelector: () => [] });
  assert.deepEqual(batches.map(batch => batch.length), [16, 2], 'ordinary batching has no separate eight-term stage');
  assert.deepEqual(batches.flat(), units);
  for (const batch of batches) {
    const prompt = taskPrompt('translation', batch, 'zh-Hans');
    assert.equal(prompt.wire.payload.task, 'translation');
    assert.deepEqual(prompt.wire.payload.units.map(unit => unit.id), batch.map(unit => unit.id));
    assert.match(prompt.system, /初翻时可顺手附 terms/);
    assert.doesNotMatch(prompt.system, /专名编辑|收录规则/);
    const refs = new Map(prompt.wire.state.entries.map(([ref, id]) => [id, ref]));
    const response = decodeTextResponse({ text: batch.map(unit => [refs.get(unit.id), '爱丽丝来了。']),
      terms: batch.map(unit => [refs.get(unit.id), 'Alice', '爱丽丝']) }, prompt.wire);
    assert.deepEqual(response.records.map(record => record.id), batch.map(unit => unit.id));
    assert.ok(response.records.every(record => record.termChoices[0].translation === '爱丽丝'));
    assert.equal(response.termWarnings, undefined);
  }
});
