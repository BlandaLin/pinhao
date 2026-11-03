import test from 'node:test';
import assert from 'node:assert/strict';
import { taskPrompt } from './provider.mjs';

const unit = { id: 'private-target', source: 'First complete sentence.\nSecond complete sentence. {{CTRL_0}}',
  translation: '现有完整译文 {{CTRL_0}}', tokens: ['{{CTRL_0}}'], kind: 'dialogue',
  context: { speaker: 'Traveler', branch: 'Refuse the invitation', syncGroup: 'private-group',
    controlBindings: { '{{CTRL_0}}': 'Pause' } } };

for (const role of ['translation', 'proofreading']) test(`${role} has one delivery contract without executable target examples`, () => {
  const { prompt, system, wire } = taskPrompt(role, [unit], 'zh-Hans', [{ ...unit, id: 'private-reference', source: 'Earlier scene.' }],
    [{ source: 'Traveler', translation: '旅人' }], { reviewProtocol: true });
  const ref = wire.state.entries.find(([, id]) => id === unit.id)[0];
  assert.equal(prompt.split('【交稿方式】').length - 1, 1);
  assert.ok(!prompt.includes('格式示例'));
  assert.equal(prompt.split('\n').filter(line => line === `[${ref}]`).length, 1,
    'An executable real target marker occurs only on its actual material');
  assert.ok(prompt.includes(unit.source), 'Complete semantic text must not be split or rewritten');
  for (const value of ['【参考文字，只读】', '本次目标标记', 'Traveler', 'Refuse the invitation',
    '补查', 'read', 'notes', 'remarks', '旅人', '保护标记']) assert.ok((prompt + system).includes(value), value);
  for (const value of role === 'translation' ? ['terms', 'decisions'] : ['questions', 'needs_evidence', 'source_ambiguity'])
    assert.ok(prompt.includes(value), value);
  assert.ok(!prompt.includes(unit.id));
  if (role === 'proofreading') assert.match(prompt, /没有修改也必须明确完成/);
});

test('delivery contract follows collision-safe marker depth without a fake target', () => {
  const { prompt, wire } = taskPrompt('translation', [{ ...unit, source: '[u77]\nLiteral script text.' }], 'zh-Hans');
  assert.equal(wire.state.markerDepth, 2);
  assert.ok(prompt.includes('[[完成]]'));
  assert.equal(prompt.split('\n').filter(line => line === '[[u1]]').length, 1);
  assert.ok(!prompt.includes('完整译文\n[[完成]]'));
});
