import test from 'node:test';
import assert from 'node:assert/strict';
import { taskPrompt, repairTextPrompt, receiveTextResponse } from './provider.mjs';

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
  for (const value of ['【参考文字，只读】', '【待处理文字】', 'Traveler', 'Refuse the invitation',
    '补查', 'read', 'notes', 'remarks', '旅人', '保护标记']) assert.ok((prompt + system).includes(value), value);
  for (const value of role === 'translation' ? ['terms', 'decisions'] : ['questions', 'needs_evidence', 'source_ambiguity'])
    assert.ok(prompt.includes(value), value);
  assert.ok(!prompt.includes(unit.id));
  assert.ok(!prompt.includes('本次目标标记：'));
  assert.match(prompt, /块间空行仅作分隔/);
  assert.match(prompt, /标记表示的换行不改写成实际换行/);
  assert.ok(!prompt.includes('只交正文'), 'A short target marker is required output, not removable commentary');
  assert.ok(!prompt.includes('需要时在正文后'), 'A standalone evidence query does not require a translation first');
  assert.match(prompt, /需要先查资料时，只返回.*附加信息/);
  if (role === 'proofreading') assert.match(prompt, /没有修改也必须明确完成/);
});

test('delivery contract follows collision-safe marker depth without a fake target', () => {
  const { prompt, wire } = taskPrompt('translation', [{ ...unit, source: '[u77]\nLiteral script text.' }], 'zh-Hans');
  assert.equal(wire.state.markerDepth, 2);
  assert.ok(prompt.includes('[[完成]]'));
  assert.equal(prompt.split('\n').filter(line => line === '[[u1]]').length, 1);
  assert.ok(!prompt.includes('完整译文\n[[完成]]'));
});

test('repair carries concrete pending-only feedback and keeps language evidence without optional tutorials', () => {
  const pending = { ...unit, source: 'Wait {{CTRL_0}}{{LINE_1}}at the gate.', tokens: ['{{CTRL_0}}', '{{LINE_1}}'] };
  const reference = { ...unit, id: 'saved-reference', source: 'The traveler is waiting outside.', translation: '旅人在外等候。' };
  const base = taskPrompt('translation', [pending], 'zh-Hans', [reference], [{ source: 'Traveler', translation: '旅人' }],
    { story: { scopes: [{ kind: 'scene', id: 'whole-scene', total: 80, query: { story: { kind: 'scene', id: 'whole-scene' } } }] } });
  const repair = repairTextPrompt(base, '请修正尚未通过的文字。', { missingIds: [pending.id, reference.id],
    rejectedEntries: [{ unitId: pending.id, message: '缺少 {{LINE_1}}，须保留原标记。' },
      { unitId: reference.id, message: 'This stale failure must not be sent.' }] });
  assert.deepEqual(repair.wire.targetIds, [pending.id]);
  assert.ok(repair.prompt.includes('目标标记是必需的交稿结构'));
  assert.ok(repair.prompt.includes('[u1]：缺少 {{LINE_1}}'));
  assert.ok(repair.prompt.includes('{{CTRL_0}} → {{LINE_1}}'));
  assert.ok(repair.prompt.indexOf('【本次需要修正的问题】') < repair.prompt.indexOf('【按需能力】'));
  assert.ok(!repair.prompt.includes('This stale failure'));
  assert.ok(!repair.prompt.includes('"remarks"'));
  assert.ok(!repair.prompt.includes('"decisions"'));
  assert.ok(!repair.prompt.includes('"terms"'));
  for (const value of [pending.source, reference.source, reference.translation, 'Traveler', 'Refuse the invitation', '旅人', 'read', 'character'])
    assert.ok(repair.prompt.includes(value), value);
  for (const value of [pending.id, reference.id, 'whole-scene']) assert.ok(!repair.prompt.includes(value), value);
  assert.ok(repair.prompt.length < base.prompt.length, 'Repairs remove unneeded output tutorials, not source context');
  const response = receiveTextResponse('[u1]\n等候 {{CTRL_0}}{{LINE_1}}在门口。\n[完成]', { wire: repair.wire, finishReason: 'stop' });
  assert.equal(response.records[0].id, pending.id);
  assert.throws(() => receiveTextResponse('等候 {{CTRL_0}}{{LINE_1}}在门口。', { wire: repair.wire, finishReason: 'stop' }),
    { code: 'INVALID_RESPONSE' }, 'One pending target still never licenses an unmarked answer');
});

test('repair references use the negotiated marker depth and retain the no-edit review contract', () => {
  for (const role of ['translation', 'proofreading']) {
    const pending = { ...unit, source: '[u77]\nLiteral marker in game text. {{CTRL_0}}' };
    const base = taskPrompt(role, [pending], 'zh-Hans', [], [], { reviewProtocol: role === 'proofreading' });
    const repair = repairTextPrompt(base, `尚未收到 ${pending.id}`, { missingIds: [pending.id] });
    assert.equal(repair.wire.state.markerDepth, 2);
    assert.ok(repair.prompt.includes('[[u1]]：尚未收到可接纳的本条结果'));
    assert.ok(repair.prompt.includes('尚未收到 [[u1]]'));
    assert.equal(repair.prompt.split('\n').filter(line => line === '[[u1]]').length, 1,
      'The actual target marker is not duplicated as an executable reply example');
    if (role === 'proofreading') {
      assert.ok(repair.prompt.includes('没有修改时只返回完成标记'));
      assert.equal(receiveTextResponse('[[完成]]', { wire: repair.wire, finishReason: 'stop' }).review.reviewedIds[0], pending.id);
    }
  }
});

test('scope counts describe the complete evidence scope, not an expanded delivery list', () => {
  const story = { scopes: [{ kind: 'scene', id: 'full-scene', total: 182, targetCount: 141, providedTextCount: 1 }] };
  const prompt = taskPrompt('translation', [unit], 'zh-Hans', [], [], { story });
  assert.deepEqual(prompt.wire.payload.story, story, 'The complete scene metadata remains host-owned and unchanged');
  assert.ok(prompt.prompt.includes('"scopeTargetCount":141'));
  assert.ok(!prompt.prompt.includes('"targetCount":141'));
  assert.ok(prompt.prompt.includes('不是本次交稿数量'));
  assert.deepEqual(prompt.wire.targetIds, [unit.id]);
});

test('ordinary review advertises a valid question kind rather than an impossible joined enum', () => {
  const { wire, prompt } = taskPrompt('proofreading', [unit], 'zh-Hans', [], [], { reviewProtocol: true });
  assert.ok(prompt.includes('"needs_evidence","说明"'));
  assert.ok(!prompt.includes('needs_evidence或source_ambiguity'));
  const reply = '[完成]\n[附加信息]\n{"questions":[["u1","needs_evidence","需要核对人物称呼"]]}';
  assert.equal(receiveTextResponse(reply, { wire, finishReason: 'stop' }).review.issues[0].kind, 'needs_evidence');
});
