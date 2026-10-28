import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTranslation } from '../exchange/index.mjs';
import { materializeReviewResponse, materializePartialReviewResponse, REVIEW_PROTOCOL } from './review-contract.mjs';

const row = (id = 'a', patch = {}) => ({ id, source: 'Hello', sourceHash: 'hello', translation: '你好', notes: '', revision: 2, tokens: [], context: {}, ...patch });
const response = (patch = {}) => ({ protocol: REVIEW_PROTOCOL, reviewedIds: ['a'], issues: [], edits: [], ...patch });
const apply = (review, units = [row()], extra = {}) => materializeReviewResponse(review, { units, validate: validateTranslation, ...extra });

test('zero-edit review completes without a text revision change', () => {
  const plan = apply(response());
  assert.equal(plan.records[0].translation, '你好'); assert.equal(plan.records[0].expectedRevision, 2);
  assert.equal(plan.states[0].changed, false); assert.equal(plan.states[0].status, 'proofread');
});

test('focused correction produces a complete validated unit and issue ledger', () => {
  const plan = apply(response({ issues: [{ unitId: 'a', kind: 'correction', message: '补充招呼语气', resolution: 'fixed' }],
    edits: [{ id: 'a', expectedRevision: 2, translation: '你好呀', notes: '招呼' }] }));
  assert.equal(plan.states[0].changed, true); assert.equal(plan.issues[0].resolved, true); assert.equal(plan.records[0].translation, '你好呀');
});

for (const [kind, resolution, status] of [['needs_evidence', 'open', 'needs_evidence'], ['source_ambiguity', 'retained', 'proofread']]) {
  test(`${kind} keeps a distinct review outcome`, () => {
    const plan = apply(response({ issues: [{ unitId: 'a', kind, resolution, message: '指代待确认' }] }));
    assert.equal(plan.states[0].status, status); assert.equal(plan.records[0].translation, '你好');
    assert.equal(plan.issues[0].resolved, resolution !== 'open');
  });
}

test('native validator is mandatory and rejects introduced engine controls', () => {
  assert.throws(() => materializeReviewResponse(response(), { units: [row()] }), /原生/);
  assert.throws(() => apply(response({ issues: [{ unitId: 'a', kind: 'correction', resolution: 'fixed', message: '修改' }],
    edits: [{ id: 'a', expectedRevision: 2, translation: '你好\\V[2]' }] }), [row('a', { context: { protectedControlSyntax: 'rpgmaker-v1' } })]));
});

for (const patch of [{ reviewedIds: [] }, { reviewedIds: ['a', 'a'] }, { reviewedIds: ['unknown'] },
  { issues: [{ unitId: 'a', kind: 'correction', resolution: 'fixed', message: '缺少修改' }] },
  { issues: [{ unitId: 'a', kind: 'needs_evidence', resolution: 'fixed', message: '状态错误' }] },
  { edits: [{ id: 'a', expectedRevision: 1, translation: '旧回复' }] },
  { edits: [{ id: 'a', expectedRevision: 2, translation: '没有依据' }] }]) {
  test(`invalid review stays uncommitted: ${JSON.stringify(patch).slice(0, 65)}`, () => {
    const units = [row()], before = structuredClone(units);
    assert.throws(() => apply(response(patch), units), { code: 'INVALID_REVIEW' });
    assert.deepEqual(units, before);
  });
}

test('full linked-group membership and equal prospective translations are required', () => {
  const a = row('a', { context: { syncGroup: 'same' } }), b = row('b', { context: { syncGroup: 'same' } });
  assert.throws(() => apply(response(), [a], { allUnits: [a, b] }), /整组/);
  assert.throws(() => apply(response({ reviewedIds: ['a', 'b'] }), [a, { ...b, translation: '不同译文' }]), /一致/);
  assert.equal(apply(response({ reviewedIds: ['a', 'b'] }), [a, b]).states.length, 2);
});

test('manual locks preserve text while allowing unchanged review coverage', () => {
  assert.equal(apply(response(), [row('a', { locked: true })]).states[0].status, 'proofread');
  assert.throws(() => apply(response({ edits: [{ id: 'a', expectedRevision: 2, translation: '修改' }] }), [row('a', { locked: true })]), /锁定/);
});

test('replayed review is idempotent only against its exact accepted result', () => {
  const review = response({ issues: [{ unitId: 'a', kind: 'correction', message: '补充招呼', resolution: 'fixed' }],
    edits: [{ id: 'a', expectedRevision: 2, translation: '你好呀', notes: '' }] });
  const plan = apply(review);
  const applied = [row('a', { translation: '你好呀', revision: 3 })];
  assert.equal(apply(review, applied, { previousReview: JSON.parse(JSON.stringify(plan)) }).replay, true);
  assert.throws(() => apply(review, [row('a', { translation: '用户新译文', revision: 4 })], { previousReview: plan }), /更新/);
});

test('partial review keeps fifteen independently valid receipts and isolates a broken control', () => {
  const units = Array.from({ length: 16 }, (_, index) => row(`unit-${index}`, { source: 'Hello {{name}}', tokens: ['{{name}}'], translation: '你好 {{name}}' }));
  const bad = units.at(-1).id;
  const review = response({ reviewedIds: units.map(unit => unit.id),
    edits: [{ id: bad, expectedRevision: 2, translation: '坏改文' }],
    issues: [{ unitId: bad, kind: 'correction', resolution: 'fixed', message: '错误删除控制符' }] });
  assert.throws(() => apply(review, units), /保护标记/);
  const plan = materializePartialReviewResponse(review, { units, validate: validateTranslation });
  assert.equal(plan.records.length, 15); assert.equal(plan.reviewedIds.length, 15);
  assert.deepEqual(plan.remainingIds, [bad]); assert.equal(plan.partial, true);
  assert.ok(plan.errors[0].message.includes('保护标记')); assert.equal(plan.issues.length, 0);
  assert.deepEqual(units.map(unit => unit.revision), Array(16).fill(2));
});

test('partial review does not accept a linked group when one member is invalid or omitted', () => {
  const units = [row('a', { context: { syncGroup: 'linked' } }), row('b', { context: { syncGroup: 'linked' } }), row('c')];
  for (const patch of [{ reviewedIds: ['a', 'c'] }, { invalidEntries: [{ unitId: 'b', message: '修改条目格式错误' }] }]) {
    const plan = materializePartialReviewResponse(response({ reviewedIds: ['a', 'b', 'c'], ...patch }), { units, validate: validateTranslation });
    assert.deepEqual(plan.reviewedIds, ['c']); assert.deepEqual(plan.remainingIds, ['a', 'b']);
  }
  const plan = materializePartialReviewResponse(response({ reviewedIds: ['a', 'c'] }), { units: [units[0], units[2]], allUnits: units, validate: validateTranslation });
  assert.deepEqual(plan.reviewedIds, ['c']); assert.ok(plan.errors[0].message.includes('整组'));
});

test('partial review rejects ambiguous duplicate receipts but retains unrelated explicit receipts', () => {
  const units = [row('a'), row('b'), row('c')];
  for (const patch of [{ reviewedIds: ['a', 'a', 'b'] },
    { reviewedIds: ['a', 'b'], edits: [{ id: 'a', expectedRevision: 1, translation: '旧版本' }] },
    { reviewedIds: ['a', 'b'], issues: [{ unitId: 'a', kind: 'needs_evidence', resolution: 'fixed', message: '状态错误' }] }]) {
    const plan = materializePartialReviewResponse(response(patch), { units, validate: validateTranslation });
    assert.deepEqual(plan.reviewedIds, ['b']); assert.deepEqual(plan.remainingIds, ['a', 'c']);
  }
});

test('unidentifiable review entries still fail the whole envelope', () => {
  for (const patch of [{ reviewedIds: ['a', 'unknown'] }, { edits: [{ id: 'unknown' }] },
    { issues: [{ unitId: 'unknown' }] }, { invalidEntries: [{ message: '归属缺失' }] }]) {
    assert.throws(() => materializePartialReviewResponse(response(patch), { units: [row()], validate: validateTranslation }), { code: 'INVALID_REVIEW' });
  }
});

test('strict materialization never treats decoded invalid entries as completed work', () => {
  assert.throws(() => apply(response({ invalidEntries: [{ unitId: 'a', message: '坏条目' }] })), { code: 'INVALID_REVIEW' });
});
