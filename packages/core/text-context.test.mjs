import test from 'node:test';
import assert from 'node:assert/strict';
import { languageContext as promptContext, legacyPromptContext } from './text-context.mjs';

test('a character identity with a provenance path is not an engineering position', () => {
  const description = 'A is B sister; address B as elder brother';
  for (const extra of [{}, { index: 0 }, { index: 0, kind: 'custom-entity' }]) {
    const result = promptContext({ evidence: [{ kind: 'character', id: 'A', path: 'characters/a.json', description, ...extra }] });
    assert.equal(result.evidence[0].description, description);
    assert.equal(result.evidence[0].id, 'A');
    assert.equal(result.evidence[0].kind, extra.kind ?? 'character');
  }
});

test('engineering-only evidence is not mandatory language context', () => {
  const context = { speaker: 'keeper', branch: { condition: 'has key' }, references: Array.from({ length: 561 }, (_, index) => ({
    kind: 'consumer', path: 'assets/scripts/fragment', index, scene: `fragment-${index}`, condition: null,
    evidence: { kind: 'consumer-location', path: 'assets/scripts/fragment', index, description: 'Extraction provenance' },
  })) };
  const value = promptContext(context);
  assert.ok(JSON.stringify(value).length < 1000);
  assert.equal(value.speaker, 'keeper');
  assert.deepEqual(value.branch, context.branch);
});

test('mixed semantic evidence retains complete conditions, people and controls', () => {
  const context = { references: [
    { path: 'script', index: 1, scene: 'night', description: 'Only addresses her sister when the key is held.', condition: { left: { field: 'variable', index: 4 }, operator: '==', right: 1 },
      context: { speaker: 'keeper', relationship: 'older sister', pronoun: 'she' } },
    { path: 'script', index: 2, source: 'Do not alter {{control}}.', controls: { '{{control}}': 'hero' } },
  ], reading: { path: 'material', index: 1, kind: 'location', description: 'Extraction explanation' },
  evidence: { description: 'The speaker addresses her sister.', source: 'Sister!' } };
  const before = structuredClone(context), value = promptContext(context, { unitId: 'unit' });
  assert.deepEqual(value.references[0].condition, context.references[0].condition);
  assert.deepEqual(value.references[0].context, context.references[0].context);
  assert.equal(value.references[0].scene, 'night');
  assert.equal(value.references[0].description, context.references[0].description);
  assert.equal(value.references[1].source, context.references[1].source);
  assert.deepEqual(value.references[1].controls, context.references[1].controls);
  assert.deepEqual(value.evidence, context.evidence);
  assert.equal(value.reading, undefined);
  assert.equal(value.evidenceAccess.find(item => item.section === 'references').total, 2);
  assert.deepEqual(value.evidenceAccess[0].query.evidence.unitId, 'unit');
  assert.deepEqual(context, before);
  assert.deepEqual(promptContext(context, { detail: true }), legacyPromptContext(context));
});

test('a path alone does not make a natural-language explanation engineering metadata', () => {
  const value = promptContext({ evidence: { path: 'notes', description: 'She addresses the older sister.' } });
  assert.equal(value.evidence.description, 'She addresses the older sister.');
  assert.equal(value.evidence.path, undefined);
});

test('native speaker keys are language context without changing legacy receipts', () => {
  const context = { speaker_key: 'speaker-7', speaker_name: 'Keeper', protectedControlSyntax: '#name#' };
  assert.deepEqual(promptContext(context), { speaker_key: 'speaker-7', speaker_name: 'Keeper' });
  assert.deepEqual(legacyPromptContext(context), {});
});

test('different locator copies of the same language fact are losslessly shared', () => {
  const context = { evidence: Array.from({ length: 74 }, (_, index) => ({ path: 'script', index,
    source: 'Whole sentence.', context: { speaker: 'keeper' } })) };
  assert.equal(promptContext(context).evidence.length, 1);
  assert.equal(context.evidence.length, 74);
});
