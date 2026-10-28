import test from 'node:test';
import assert from 'node:assert/strict';
import { scanTerminology, relevantGlossary, terminologyHints } from './glossary.mjs';

test('31,193 accepted scene units preserve actual decisions without candidate extraction or reference vote inflation', () => {
  const count = 31193;
  const units = Array.from({ length: count }, (_, index) => ({
    id: `scene-${index}`, kind: 'dialogue', status: 'translated', source: index % 2 ? `Ann enters scene ${index}.` : `Anna enters scene ${index}.`,
    translation: index % 2 ? `安进入场景${index}。` : `安娜进入场景${index}。`, context: { file: `maps/${Math.floor(index / 100)}.json` },
    ...(index % 2 ? { termChoices: [{ source: 'Ann', translation: '安' }] } : {}),
  }));
  units.unshift({ id: 'name', kind: 'character_name', source: 'Ann', translation: '安', status: 'translated', context: { actorId: 1 } });
  const glossary = scanTerminology(units, undefined, 'zh-Hans'), entry = glossary.entries[0];
  assert.equal(glossary.entries.length, 1); assert.equal(entry.status, 'confirmed');
  assert.equal(entry.votes[0].count, Math.floor(count / 2) + 1);
  assert.equal(entry.unitIds.includes('scene-0'), false, 'Ann does not match Anna');
  assert.equal(relevantGlossary(glossary, [units[1]]).length, 0);
  assert.equal(relevantGlossary(glossary, [units[2]]).length, 1);
  assert.deepEqual(terminologyHints(glossary, units.slice(0, 10)), []);
  assert.equal(scanTerminology(units, glossary, 'zh-Hans').hash, glossary.hash);
});

test('cached multi-pattern matching selects a small batch from thousands of accepted names', () => {
  const units = Array.from({ length: 5000 }, (_, index) => ({ id: `actor-${index}`, kind: 'character_name', source: `Actor${index}`,
    translation: `角色${index}`, status: 'translated', context: { actorId: index } }));
  const glossary = scanTerminology(units, undefined, 'zh-Hans');
  const batch = [{ id: 'line', source: 'Actor20 meets Actor4999. Actor2 is absent.', status: 'pending', translation: '' }];
  assert.deepEqual(relevantGlossary(glossary, batch).map(entry => entry.source).sort(), ['Actor2', 'Actor20', 'Actor4999']);
  assert.equal(relevantGlossary(glossary, batch).length, 3);
});
