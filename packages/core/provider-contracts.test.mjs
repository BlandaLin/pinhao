import test from 'node:test';
import assert from 'node:assert/strict';
import { taskPrompt, promptContext, parseModelResponse } from './provider.mjs';
import { createDependencySnapshot, dependenciesFresh } from './semantic-state.mjs';
import { relevantGlossary, scanTerminology } from './glossary.mjs';
import { compactStoryContext } from '../exchange/story.mjs';

const unit = (id, source, patch = {}) => ({ id, source, translation: source, revision: 0, notes: '', status: 'pending', context: { file: 'scene.json', speaker: 'Lin' }, ...patch });

test('native control meanings are sent from their stored context bindings', () => {
  const controls = { '{{ACTOR}}': '\\N[1]', '{{COLOR}}': '\\C[0]' };
  const prompt = taskPrompt('translation', [unit('native', '{{ACTOR}} hello', { tokens: ['{{ACTOR}}'],
    context: { file: 'Actors.json', field: 'name', record: 1, controlBindings: controls, controlFingerprint: 'local-only' } })], 'zh-Hans');
  const row = prompt.wire.payload.units[0];
  assert.deepEqual(row.controls, controls);
  assert.equal(row.context.record, 1); assert.equal(row.context.field, 'name');
  assert.equal(row.context.controlFingerprint, undefined);
});

test('semantic context projects scene, branch, speaker and constraints while host internals stay local', () => {
  const context = { file: 'Map001.json', scene: { id: 'scene-1', title: 'Evening', summary: 'Two friends meet.' }, speaker: 'Lin',
    branch_path: [{ type: 'conditional', command: 2, side: 'else', condition: { left: 1, operator: 'equals', right: 0 } }],
    actor_id: 1, speaker_basis: 'explicit-name-field', syncGroup: 'heading', constraints: { gender: 'unknown', tone: 'formal' },
    storyLinks: [{ kind: 'map-transfer', command: 3, state: 'confirmed', target: { map: 'Map002' }, coordinates: [4, 5] },
      { kind: 'common-event-call', command: 4, state: 'confirmed', target: { common_event: 2 } }],
    evidence: [{ unitId: 'earlier', source: 'Earlier scene.', context: { speaker: 'Mei' }, sourceHash: 'hidden' }],
    adaptationLocator: { writer: 'private-writer', path: ['hidden'] }, adaptationSourceHash: 'hidden', upgrade: { previous: 'hidden' },
    sourceHash: 'hidden', controlFingerprint: 'hidden', nested: { opaque: 'hidden' } };
  const projected = promptContext(context);
  assert.equal(projected.scene.summary, context.scene.summary);
  assert.deepEqual(projected.branch_path, context.branch_path);
  assert.equal(projected.actor_id, 1); assert.equal(projected.speaker_basis, 'explicit-name-field');
  assert.equal(projected.storyLinks, undefined);
  assert.equal(projected.storyBlockRef, compactStoryContext(context).storyBlockRef);
  assert.equal(projected.storyLinksHash, compactStoryContext(context).storyLinksHash);
  assert.equal(context.storyLinks.length, 2);
  assert.deepEqual(projected.constraints, context.constraints);
  assert.equal(projected.evidence[0].context.speaker, 'Mei');
  assert.equal(JSON.stringify(projected).includes('hidden'), false);
  assert.equal(context.adaptationLocator.writer, 'private-writer');
});

test('ordinary translation retains real accepted names without creating terminology from pending placeholders', () => {
  const units = [unit('g1', 'Rose', { kind: 'character_name' }),
    unit('g2', 'Moon', { kind: 'character_name', status: 'translated', translation: '月亮' }),
    unit('g3', 'River', { kind: 'character_name', translation: '河流' })];
  const glossary = scanTerminology(units, undefined, 'zh-Hans');
  assert.deepEqual(glossary.entries.map(entry => [entry.source, entry.translation, entry.status]), [['Moon', '月亮', 'confirmed']]);
  const prompt = taskPrompt('translation', units, 'zh-Hans', [], relevantGlossary(glossary, units));
  const rows = prompt.wire.payload.units;
  assert.equal(rows[0].currentTranslation, undefined); assert.equal(rows[1].currentTranslation, '月亮');
  assert.equal(rows[2].currentTranslation, '河流');
  assert.match(prompt.system, /初翻时可顺手附 terms/);
  assert.doesNotMatch(prompt.system, /专名编辑|收录规则/);
});

test('all text phases retain the unique short-reference text or differential protocol with frozen review scope', () => {
  const translation = taskPrompt('translation', [unit('u1', 'A')], 'zh-Hans');
  assert.match(translation.system, /"text"/); assert.doesNotMatch(translation.system, /"records"/);
  const result = taskPrompt('proofreading', [unit('u1', 'A')], 'zh-Hans', [], [], {
    reviewProtocol: true, reviewScope: { id: 'round:scene', stage: 'consistency', unitIds: ['u1'] },
    story: { revision: 1, scenes: [{ id: 's1', title: 'Evening', scope: { unitIds: ['u1'] } }] }, readingNotes: 'u0: Earlier scene establishes a formal address.' });
  const payload = result.wire.payload;
  assert.equal(payload.responseProtocol, 'pinhao-review-1'); assert.equal(payload.reviewScope.stage, 'consistency');
  assert.equal(payload.story.scenes[0].id, 's1'); assert.match(result.system, /story/);
  assert.ok(result.prompt.includes('Evening'));
  assert.equal(payload.readingNotes, 'u0: Earlier scene establishes a formal address.');
  assert.match(result.system, /needs_evidence[\s\S]*不得同时放入 changes[\s\S]*保留当前译文/);
});

test('actual prompt glossary selection controls dependencies, including word boundaries and homonym scope', () => {
  const units = [unit('actor', 'Rose'), unit('item', 'Rose', { kind: 'database_name', context: { file: 'Items.json' } })];
  const glossary = { entries: [
    { id: 'actor-name', source: 'Rose', translation: '萝丝', status: 'confirmed', unitIds: ['actor'], category: 'name' },
    { id: 'item-name', source: 'Rose', translation: '玫瑰', status: 'confirmed', unitIds: ['item'], category: 'term' },
    { id: 'short', source: 'Ros', translation: '短名', status: 'confirmed' },
    { id: 'pending', source: 'A', translation: 'A', status: 'pending' },
  ] };
  const selected = relevantGlossary(glossary, [units[0]]);
  assert.deepEqual(selected.map(entry => entry.id), ['actor-name']);
  const prompt = taskPrompt('translation', [units[0]], 'zh-Hans', [], selected);
  const snapshot = createDependencySnapshot({ units: [units[0]], glossary, modelMaterial: prompt.material });
  const changed = structuredClone(glossary); changed.entries[1].translation = '别的道具'; changed.entries[2].translation = '不同短名';
  assert.equal(dependenciesFresh(snapshot, { units, glossary: changed }), true);
  changed.entries[0].translation = '新人物名'; assert.equal(dependenciesFresh(snapshot, { units, glossary: changed }), false);
  const boundaryGlossary = { entries: [{ id: 'letter', source: 'A', translation: '甲', status: 'confirmed', category: 'term' }] };
  assert.equal(relevantGlossary(boundaryGlossary, [unit('x', 'A simple sentence')]).length, 1);
  assert.equal(relevantGlossary(boundaryGlossary, [unit('x', 'Another sentence')]).length, 0);
});

test('technical metadata changes leave semantic dependencies fresh while scene changes invalidate them', () => {
  const current = unit('u1', 'Rose', { context: { speaker: 'Lin', adaptationSourceHash: 'one', sourceHash: 'one' } });
  const snapshot = createDependencySnapshot({ units: [current] });
  assert.equal(dependenciesFresh(snapshot, { units: [{ ...current, context: { ...current.context, adaptationSourceHash: 'two', sourceHash: 'two' } }] }), true);
  assert.equal(dependenciesFresh(snapshot, { units: [{ ...current, context: { ...current.context, speaker: 'Mei' } }] }), false);
});

test('dependencies bind selected semantic conclusions instead of unpublished host bookkeeping', () => {
  const current = unit('u1', 'Rose');
  const decision = { id: 'person', entity: 'Rose', sense: 'name', scope: { unitIds: ['u1'] }, translation: '萝丝', evidenceIds: ['u1'], revision: 1, status: 'active', receipts: [] };
  const preparation = { decisions: [decision] };
  const prompt = taskPrompt('translation', [current], 'zh-Hans', [], [], { preparation });
  const snapshot = createDependencySnapshot({ units: [current], preparation, modelMaterial: prompt.material });
  assert.equal(dependenciesFresh(snapshot, { units: [current], preparation: { decisions: [{ ...decision, actor: 'host-metadata' }] } }), true);
  assert.equal(dependenciesFresh(snapshot, { units: [current], preparation: { decisions: [{ ...decision, translation: '另一译法' }] } }), false);
});

test('prospective references bind saved candidates and the original source revision without inventing a committed translation', () => {
  const target = unit('target', 'Welcome, Rose.'), reference = unit('name', 'Rose');
  const candidate = { id: 'name', translation: '萝丝', notes: '统一人名' };
  const virtual = { ...reference, translation: candidate.translation, notes: candidate.notes };
  const prompt = taskPrompt('translation', [target], 'zh-Hans', [virtual]);
  const snapshot = createDependencySnapshot({ units: [target], referenceUnits: [virtual], modelMaterial: prompt.material, candidateRecords: [candidate] });
  assert.equal(snapshot.receipts.find(receipt => receipt.id === reference.id).kind, 'candidate');
  const options = { units: [target, reference], candidateRecords: [candidate] };
  assert.equal(dependenciesFresh(snapshot, options), true);
  assert.equal(dependenciesFresh(JSON.parse(JSON.stringify(snapshot)), options), true, 'pause and restart retain candidate references');
  assert.equal(reference.translation, 'Rose');
  assert.equal(dependenciesFresh(snapshot, { ...options, candidateRecords: [] }), false);
  assert.equal(dependenciesFresh(snapshot, { ...options, candidateRecords: [{ ...candidate, translation: '改名' }] }), false);
  assert.equal(dependenciesFresh(snapshot, { ...options, units: [target, { ...reference, translation: '人工译名', revision: 1 }] }), false);
  assert.equal(dependenciesFresh(snapshot, { ...options, units: [target, { ...reference, manualLock: true }] }), false);
  assert.equal(dependenciesFresh(snapshot, { ...options, units: [target, { ...reference, context: { ...reference.context, adaptationLocator: { file: 'changed-writer' } } }] }), true);
});

test('response classes distinguish truncation, refusal, reasoning, empty final and protocol errors', () => {
  for (const [raw, metadata, code] of [
    ['', { finishReason: 'length', reasoningCharacters: 100 }, 'MODEL_OUTPUT_TRUNCATED'],
    ['{"text":[', { finishReason: 'length' }, 'MODEL_OUTPUT_TRUNCATED'],
    ['', { explicitRefusal: true }, 'MODEL_REFUSAL'],
    ['I cannot provide this translation.', {}, 'MODEL_REFUSAL'],
    ['', { reasoningCharacters: 10 }, 'MODEL_REASONING_ONLY'],
    ['', {}, 'MODEL_EMPTY_RESPONSE'],
    ['{"bad":"unfinished', {}, 'INVALID_RESPONSE'],
    ['[]', {}, 'INVALID_RESPONSE'],
    ['The character says sorry.', {}, 'INVALID_RESPONSE'],
  ]) assert.throws(() => parseModelResponse(raw, metadata), { code });
  assert.deepEqual(parseModelResponse('{"text":[]}', { finishReason: 'length' }), { text: [] });
});
