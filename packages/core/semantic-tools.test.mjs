import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEvidenceRequests } from './semantic-tools.mjs';
import { createDependencySnapshot, dependenciesFresh } from './semantic-state.mjs';
import { buildStoryContext, compactStoryUnits } from '../exchange/story.mjs';

const row = (id, patch = {}) => ({ id: `u${id}`, source: `Room ${id}`, translation: `Room ${id}`, notes: '', revision: 0,
  context: { file: 'scene.json' }, kind: 'message', tokens: [], ...patch });

test('indexed source queries return exact evidence and negative answers with host receipts', () => {
  const units = [row(1), row(2, { source: 'Captain Rose' })];
  const result = resolveEvidenceRequests([{ query: { text: 'Captain' }, reason: 'speaker identity' }, { query: { text: 'Absent' } }], units);
  assert.deepEqual(result.answers.map(answer => answer.total), [1, 0]);
  assert.deepEqual(result.units.map(unit => unit.id), ['u2']);
  const snapshot = createDependencySnapshot({ units: [units[0]], receipts: result.receipts });
  assert.equal(dependenciesFresh(snapshot, { units }), true);
  assert.equal(dependenciesFresh(snapshot, { units: [...units, row(3, { source: 'Absent person' })] }), false);
});

test('query cursors reach sixty records exactly through final bounded pages', () => {
  const units = Array.from({ length: 60 }, (_, id) => row(id)), seen = [];
  let offset = 0;
  do {
    const result = resolveEvidenceRequests([{ query: { text: 'Room', offset, limit: 32 } }], units);
    seen.push(...result.answers[0].returnedIds); offset = result.answers[0].nextOffset;
  } while (offset !== null);
  assert.deepEqual(seen, units.map(unit => unit.id));
  assert.equal(new Set(seen).size, 60);
});

test('overlapping queries share their visible records while preserving both query receipts', () => {
  const units = Array.from({ length: 40 }, (_, id) => row(id));
  const result = resolveEvidenceRequests([{ query: { text: 'Room', limit: 32 } }, { query: { ids: ['u0', 'u1'] } }], units);
  assert.equal(result.units.length, 32); assert.deepEqual(result.answers[1].returnedIds, ['u0', 'u1']);
  assert.equal(result.receipts.filter(receipt => receipt.kind === 'query').length, 2);
});

test('evidence character limits preserve whole source units and an exact next offset', () => {
  const units = [row(1, { source: 'Complete source '.repeat(100) }), row(2)];
  const result = resolveEvidenceRequests([{ query: { kinds: ['message'] } }], units, { maxCharacters: 30 });
  assert.deepEqual(result.answers[0].returnedIds, ['u1']); assert.equal(result.units[0].source, units[0].source);
  assert.equal(result.answers[0].nextOffset, 1);
});

test('story pages share the evidence budget and their receipts cover only returned whole units', () => {
  const units = compactStoryUnits(Array.from({ length: 40 }, (_, id) => row(id, {
    source: `Complete paragraph ${id}. `.repeat(30), context: { file: 'scene.json', event: 1 },
  })));
  const story = buildStoryContext(units), scene = { kind: 'scene', id: story.scenes[0].id };
  const seen = [];
  let offset = 0;
  while (offset !== null) {
    const result = resolveEvidenceRequests([{ query: { story: scene, offset, limit: 32 } }], units,
      { story, maxCharacters: 1800 });
    assert.ok(result.units.length > 0 && result.units.length < 32);
    assert.deepEqual(result.storyReceipts[0].unitIds, result.answers[0].returnedIds);
    assert.equal(result.storyReceipts[0].offset, offset);
    assert.equal(result.storyReceipts[0].nextOffset, result.answers[0].nextOffset ?? units.length);
    seen.push(...result.answers[0].returnedIds);
    offset = result.answers[0].nextOffset;
  }
  assert.deepEqual(seen, units.map(unit => unit.id));
});

test('a linked story display group stays atomic when its full page exceeds the budget', () => {
  const units = compactStoryUnits([row(1, { context: { file: 'scene.json', event: 1, syncGroup: 'label' } }),
    row(2, { context: { file: 'scene.json', event: 1, syncGroup: 'label' } }), row(3)]);
  const story = buildStoryContext(units);
  const result = resolveEvidenceRequests([{ query: { story: { kind: 'scene', id: story.scenes[0].id }, limit: 32 } }], units,
    { story, maxCharacters: 10 });
  assert.deepEqual(result.units.map(unit => unit.id), ['u1', 'u2']);
  assert.equal(result.storyReceipts[0].nextOffset, 2);
  assert.equal(result.answers[0].nextOffset, null);
});

test('complete relationship materials use separate bounded pages without repeating graphs on every text page', () => {
  const links = Array.from({ length: 1000 }, (_, command) => ({ kind: 'conditional-branch', command,
    condition: [0, command, 0], state: 'confirmed', target: { event: 1 }, branch: 'then' }));
  const units = compactStoryUnits(Array.from({ length: 80 }, (_, id) => row(id, { context: { file: 'scene.json', event: 1, storyLinks: links } })));
  const story = buildStoryContext(units), scene = { kind: 'scene', id: story.scenes[0].id };
  const first = resolveEvidenceRequests([{ query: { story: scene, offset: 0, limit: 16 } }], units, { story });
  assert.equal(first.answers[0].relationships.length, 32); assert.equal(first.answers[0].relationshipTotal, 1000);
  assert.equal(first.answers[0].nextRelationshipOffset, 32); assert.equal(first.answers[0].blocks[0].unitIds, undefined);
  const next = resolveEvidenceRequests([{ query: { story: scene, offset: 16, limit: 16 } }], units, { story });
  assert.equal(next.answers[0].relationships, undefined); assert.equal(next.answers[0].relationshipTotal, 1000);
  const seen = first.answers[0].relationships.map(link => link.id);
  let cursor = first.answers[0].relationshipQuery;
  while (cursor) {
    const result = resolveEvidenceRequests([{ query: cursor }], units, { story });
    assert.equal(result.units.length, 0); assert.equal(result.storyReceipts.length, 1);
    assert.equal(result.storyReceipts[0].scopeKind, 'relationships');
    assert.equal(result.storyReceipts[0].offset, cursor.offset);
    assert.ok(result.answers[0].relationships.length <= 32);
    assert.equal(result.receipts.some(receipt => receipt.unitId === 'u0' || receipt.id === 'u0'), true);
    seen.push(...result.answers[0].relationships.map(link => link.id));
    cursor = result.answers[0].relationshipQuery;
  }
  assert.equal(new Set(seen).size, 1000);
  assert.equal(seen.length, 1000);
  const snapshot = createDependencySnapshot({ units: [], receipts: first.receipts });
  assert.equal(dependenciesFresh(snapshot, { units }), true);
  const changed = compactStoryUnits(units.map((unit, index) => index ? unit : { ...unit,
    context: { ...unit.context, storyLinks: [...links, { ...links[0], command: 1001 }] } }));
  assert.equal(dependenciesFresh(snapshot, { units: changed }), false);
});

for (const query of [{ path: 'secret' }, {}, { ids: 'u1' }, { text: 3 }, { text: 'Room', offset: -1 }, { text: 'Room', limit: 100 }]) {
  test(`malformed evidence queries fail inside the text capability: ${JSON.stringify(query)}`, () => {
    assert.throws(() => resolveEvidenceRequests([{ query }], [row(1)]), { code: 'INVALID_EVIDENCE_REQUEST' });
  });
}
