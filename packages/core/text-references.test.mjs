import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingReferenceSelector } from './text-references.mjs';

test('320 to 3 to 2 and 349 to 1 select nearby candidate overlays, never the paid whole batch', () => {
  for (const count of [320, 349]) {
    const units = Array.from({ length: count }, (_, index) => ({ id: `unit-${index}`, source: `source ${index}`, translation: '',
      context: { file: 'story.ks', scene: 'scene', speaker: 'speaker', branch: 'main' } }));
    const candidates = new Map(units.map(unit => [unit.id, { translation: `accepted ${unit.id}` }]));
    const selector = createPendingReferenceSelector(units, { candidates });
    for (const remaining of [3, 2, 1]) {
      const targets = units.slice(-remaining), refs = selector([targets]);
      assert.ok(refs.length > 0 && refs.length < count / 4);
      assert.ok(refs.every(unit => unit.translation === `accepted ${unit.id}`));
      assert.ok(refs.every(unit => !targets.includes(unit)));
      assert.equal(candidates.size, count);
    }
  }
});

test('latest requested evidence survives alongside local scene selection', () => {
  const units = [{ id: 'a', source: 'a', context: { file: 'a' } }, { id: 'z', source: 'z', context: { file: 'z' } }];
  const select = createPendingReferenceSelector(units, { evidenceReferences: [units[1]], evidenceReplies: [{ returnedIds: ['z'] }] });
  assert.deepEqual(select([[units[0]]]).map(unit => unit.id), ['z']);
});
