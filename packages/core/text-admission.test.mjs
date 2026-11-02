import test from 'node:test';
import assert from 'node:assert/strict';
import { taskPrompt } from './provider.mjs';
import { packRequestBatches } from './request-batches.mjs';
import { textRequestLimits, textRequestEstimate, assertTextRequestCapacity } from './text-capacity.mjs';

const unit = (notes = '') => ({ id: 'neutral-short', kind: 'message', source: 'Help', translation: '', tokens: [], context: {}, notes });

test('optional material character budget cannot veto a token-admissible complete target', () => {
  const connection = {}, limits = textRequestLimits(connection);
  const target = unit('Neutral complete required annotation. '.repeat(600));
  const prompt = taskPrompt('translation', [target], 'zh-Hans', [], [], { maxCharacters: limits.maxCharacters });
  assert.ok(prompt.system.length + prompt.prompt.length > limits.maxCharacters);
  assert.equal(textRequestEstimate(prompt, [target], limits).overLimit, false);
  assert.doesNotThrow(() => assertTextRequestCapacity({ connection, ...prompt }));
  assert.deepEqual(packRequestBatches([[target]], { connection, referenceSelector: () => [] }), [[target]]);
});

test('packing and final provider admission estimate identical encoded messages including escaping', () => {
  const connection = {}, limits = textRequestLimits(connection);
  const prompt = { system: 'Neutral system.', prompt: '\\"\n'.repeat(7000) };
  const planning = textRequestEstimate(prompt, [unit()], limits);
  const final = assertTextRequestCapacity({ connection, ...prompt });
  assert.equal(planning.estimatedInputTokens, final.estimatedInputTokens);
});

test('true input and complete-output overflows remain explicit and preserve group IDs', () => {
  const connection = {}, target = unit('Required evidence. '.repeat(10000));
  assert.throws(() => packRequestBatches([[target]], { connection, referenceSelector: () => [] }), error => {
    assert.equal(error.code, 'TEXT_GROUP_CAPACITY_EXCEEDED');
    assert.deepEqual(error.unitIds, [target.id]);
    assert.deepEqual(error.reasons, ['input-context']);
    return true;
  });
  const long = { ...unit(), source: 'Complete required sentence. '.repeat(2000) };
  assert.throws(() => packRequestBatches([[long]], { connection, referenceSelector: () => [] }), error => {
    assert.equal(error.code, 'TEXT_GROUP_CAPACITY_EXCEEDED');
    assert.ok(error.reasons.includes('complete-output'));
    return true;
  });
});
