import test from 'node:test';
import assert from 'node:assert/strict';
import { taskPrompt, parseModelResponse, compactEvidenceHistory, REVIEW_PROTOCOL } from './provider.mjs';
import { packRequestBatches, requestPromptCharacters } from './request-batches.mjs';
import { buildStoryContext, storyMaterialEntrypoints } from '../exchange/story.mjs';
import { TEXT_WIRE_VERSION } from './text-wire.mjs';

const unit = (index, extra = {}) => ({ id: `u${index}`, kind: 'dialogue', source: `Complete neutral sentence ${index}.`,
  translation: `完整中性译文 ${index}。`, tokens: [], revision: 1, context: { file: `scene-${index}.json`, event: index }, ...extra });

test('packing counts the exact scoped story once and preserves a fitting sixteen-row review', () => {
  const all = Array.from({ length: 20 }, (_, index) => unit(index, { context: { file: `scene-${index}.json`, event: index, actorId: 1 } }));
  const story = buildStoryContext(all), targets = all.slice(0, 16);
  const options = { reviewProtocol: true, story: storyMaterialEntrypoints(story, all.map(row => row.id)) };
  const actual = taskPrompt('proofreading', targets, 'zh-Hans', [], [], options);
  assert.ok(requestPromptCharacters(actual) < 14000);
  assert.deepEqual(packRequestBatches(targets.map(row => [row]), { role: 'proofreading', allUnits: all,
    promptOptions: options, referenceSelector: () => [] }).map(batch => batch.length), [16]);
});

test('packing retains complete repeated text and batch-specific decisions from the actual prompt path', () => {
  const all = Array.from({ length: 16 }, (_, index) => unit(index, { source: 'A complete shared source sentence. '.repeat(55), translation: '', context: {} }));
  const options = batch => ({ story: {}, preparation: { decisions: [{ id: 'shared-label', status: 'active',
    entity: 'label', sense: 'the same label in this declared scope', translation: '共享文字',
    scope: { unitIds: batch.map(row => row.id) }, evidenceIds: batch.map(row => row.id), revision: 1 }] } });
  const budget = requestPromptCharacters(taskPrompt('translation', all, 'zh-Hans', [], [], { ...options(all), maxCharacters: Infinity }));
  const batches = packRequestBatches(all.map(row => [row]), { allUnits: all, promptOptions: options,
    referenceSelector: () => [], maxCharacters: budget });
  assert.deepEqual(batches.map(batch => batch.length), [16]);
  const prompt = taskPrompt('translation', batches[0], 'zh-Hans', [], [], { ...options(batches[0]), maxCharacters: budget });
  assert.equal(requestPromptCharacters(prompt), budget);
  assert.equal(prompt.wire.payload.units.filter(row => row.source === all[0].source).length, 16);
  assert.equal(prompt.prompt.split(all[0].source).length - 1, 16);
  assert.equal(prompt.wire.payload.preparation[0].scope.unitIds.length, 16);
});

test('large scoped decisions are included before buying a batch', () => {
  const all = Array.from({ length: 16 }, (_, index) => unit(index, { source: 'A complete paragraph. '.repeat(20), context: {} }));
  const options = batch => ({ preparation: { decisions: [{ id: 'large-scoped-decision', status: 'active',
    entity: 'N'.repeat(3000), sense: 'Neutral declared distinction', scope: { unitIds: batch.map(row => row.id) }, evidenceIds: [], revision: 1 }] } });
  const batches = packRequestBatches(all.map(row => [row]), { allUnits: all, promptOptions: options,
    referenceSelector: () => [], maxCharacters: 7500 });
  assert.ok(batches.length > 1);
  for (const batch of batches) assert.ok(requestPromptCharacters(taskPrompt('translation', batch, 'zh-Hans', [], [],
    { ...options(batch), maxCharacters: 7500 })) <= 7500);
  assert.deepEqual(batches.flat(), all);
});

test('initial translation packing counts exact references and scoped terminology disagreements together', () => {
  const entries = Array.from({ length: 4 }, (_, index) => unit(index, { source: `Neutral source name ${index}. `.repeat(15),
    translation: '', context: {} }));
  const reference = unit('accepted-name', { source: 'Complete accepted name evidence. '.repeat(80), context: {} });
  const options = { story: {}, evidenceResults: [{ query: { ids: [reference.id] }, total: 1,
    returnedIds: [reference.id], nextOffset: null }], terminologyHints: entries.map(entry => ({ source: entry.source,
      recommendation: '名称', variants: [{ translation: '名称', count: 2 }], unitIds: [entry.id] })) };
  const budget = requestPromptCharacters(taskPrompt('translation', entries, 'zh-Hans', [reference], [],
    { ...options, maxCharacters: Infinity })) - 1;
  const batches = packRequestBatches(entries.map(entry => [entry]), { referenceSelector: () => [reference],
    promptOptions: options, maxCharacters: budget });
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), entries);
  for (const batch of batches) {
    const prompt = taskPrompt('translation', batch, 'zh-Hans', [reference], [], { ...options, maxCharacters: budget });
    assert.ok(requestPromptCharacters(prompt) <= budget);
    assert.deepEqual(prompt.material.referenceIds, [reference.id]);
    assert.deepEqual(prompt.wire.payload.terminologyHints.flatMap(hint => hint.unitIds), batch.map(entry => entry.id));
  }
});

test('newly requested evidence and its linked display survive optional preview trimming', () => {
  const target = unit(0, { context: {} });
  const references = [unit(1, { source: 'Optional preview. '.repeat(500), context: {} }),
    unit(2, { source: 'New complete evidence. '.repeat(30), context: { syncGroup: 'new-page' } }),
    unit(3, { source: 'Linked complete evidence. '.repeat(30), context: { syncGroup: 'new-page' } })];
  const old = Array.from({ length: 4 }, (_, offset) => ({ query: { story: { kind: 'scene', id: 'scene' }, offset, limit: 1 },
    total: 6, returnedIds: [`old-${offset}`], nextOffset: offset + 1, relationships: [{ text: 'Historical relation. '.repeat(100) }] }));
  const current = [{ query: { ids: ['u2'], offset: 0, limit: 1 }, total: 1, returnedIds: ['u2'], nextOffset: null },
    { query: { ids: ['u3'], offset: 0, limit: 1 }, total: 1, returnedIds: ['u3'], nextOffset: null }];
  const prompt = taskPrompt('proofreading', [target], 'zh-Hans', references, [],
    { reviewProtocol: true, evidenceResults: [...old, ...current], maxCharacters: 6500 });
  const payload = prompt.wire.payload;
  assert.deepEqual(payload.referenceOnly.map(row => row.id), ['u2', 'u3']);
  assert.deepEqual(payload.evidenceResults, current);
  assert.deepEqual(payload.evidenceHistory[0].readRanges, [[0, 4]]);
  assert.equal(payload.evidenceHistory[0].readCount, 4);
  assert.equal(payload.evidenceHistory[0].archived, true);
  assert.deepEqual(prompt.material.referenceIds, ['u2', 'u3']);
  assert.equal(payload.referenceOnly.some(row => row.source === references[0].source), false);
  assert.equal(prompt.budget.overLimit, false);
});

test('long same-scope reading keeps full current pages without growing a list of historic IDs', () => {
  const replies = Array.from({ length: 137 }, (_, page) => ({ query: { story: { kind: 'scene', id: 'complete-scene' }, offset: page * 16, limit: 16 },
    scopeVersion: 'fixed-scope', total: 2192, returnedIds: Array.from({ length: 16 }, (_, index) => `read-${page * 16 + index}`),
    nextOffset: page === 136 ? null : (page + 1) * 16 }));
  const history = compactEvidenceHistory(replies);
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].readRanges, [[0, 2192]]);
  assert.equal(history[0].readCount, 2192);
  assert.equal(history[0].cursor, null);
  assert.ok(JSON.stringify(history).length < 300);
  const prompt = taskPrompt('proofreading', [unit(0)], 'zh-Hans', [], [], { reviewProtocol: true,
    evidenceResults: replies, readingNotes: 'Neutral accumulated meaning, speaker relations and evidence IDs.' });
  const payload = prompt.wire.payload;
  assert.deepEqual(payload.evidenceResults, replies.slice(-2));
  assert.deepEqual(payload.evidenceHistory[0].readRanges, [[0, 2160]]);
  assert.equal(prompt.budget.overLimit, false);
  const base = taskPrompt('proofreading', [unit(0)], 'zh-Hans', [], [], {
    reviewProtocol: true, evidenceHistory: history }).wire.payload;
  assert.deepEqual(base.evidenceHistory, history);
  assert.equal(base.evidenceResults, undefined);
});

test('an oversized requested complete unit is retained with an honest budget diagnostic', () => {
  const target = unit(0, { source: 'One complete semantic paragraph. '.repeat(1000) });
  const prompt = taskPrompt('translation', [target], 'zh-Hans');
  assert.equal(prompt.wire.payload.units[0].source, target.source);
  assert.equal(prompt.budget.overLimit, true);
  assert.equal(prompt.budget.characters, requestPromptCharacters(prompt));
});

test('malformed text tuples recover only independently valid complete JSON arrays', () => {
  const raw = '{"text":[["u1","完整译文"],["u2","口号中"夺回"的对象"],["u3","另一条完整译文"]]}';
  const parsed = parseModelResponse(raw, { finishReason: 'stop', responseProtocol: TEXT_WIRE_VERSION });
  assert.deepEqual(parsed.text.map(row => row[0]), ['u1', 'u3']);
  assert.equal(parsed.responseRepair.code, 'INVALID_RESPONSE');
  assert.throws(() => parseModelResponse(raw, { finishReason: 'length' }), { code: 'MODEL_OUTPUT_TRUNCATED' });
  assert.throws(() => parseModelResponse(raw, { finishReason: 'stop', responseProtocol: REVIEW_PROTOCOL }), { code: 'INVALID_RESPONSE' });
  assert.throws(() => parseModelResponse('{"text":[["u1","unfinished', { finishReason: 'stop', responseProtocol: TEXT_WIRE_VERSION }), { code: 'INVALID_RESPONSE' });
});
