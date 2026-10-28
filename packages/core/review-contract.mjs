import { sha256 } from '../exchange/index.mjs';

export const REVIEW_PROTOCOL = 'pinhao-review-1';
const fail = message => { const error = new Error(message); error.code = 'INVALID_REVIEW'; throw error; };

/** The caller commits this whole plan in one revision-aware store transaction. */
export function materializeReviewResponse(review, { units, allUnits = units, validate, previousReview } = {}) {
  if (typeof validate !== 'function') fail('校对提交需要原生文字校验。');
  if (!review || review.protocol !== REVIEW_PROTOCOL || !Array.isArray(review.reviewedIds) || !Array.isArray(review.issues) || !Array.isArray(review.edits)) fail('校对结果需要完整的审阅、问题和修改列表。');
  if (review.invalidEntries?.length) fail('校对结果仍有未通过校验的条目。');
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const reviewed = new Set(review.reviewedIds);
  if (reviewed.size !== review.reviewedIds.length || reviewed.size !== byId.size || [...reviewed].some(id => !byId.has(id))) fail('校对结果需要逐项覆盖本批文字。');
  const responseHash = sha256(review);
  if (previousReview?.responseHash === responseHash && previousReview.records?.every(record => {
    const unit = byId.get(record.id), state = previousReview.states.find(state => state.id === record.id);
    return unit && state && unit.sourceHash === record.sourceHash && sha256(unit.controls ?? unit.context?.controlBindings ?? {}) === record.controlHash
      && unit.translation === record.translation && (unit.notes ?? '') === record.notes
      && unit.revision === record.expectedRevision + (state.changed ? 1 : 0);
  })) return { ...structuredClone(previousReview), replay: true };
  const identity = sha256({ protocol: review.protocol, input: units.map(unit => [unit.id, unit.revision, unit.sourceHash, unit.translation]), review });
  const reviewId = `review-${identity}`;
  if (previousReview?.reviewId === reviewId) return { ...structuredClone(previousReview), replay: true };
  const edits = new Map();
  for (const edit of review.edits) {
    const unit = byId.get(edit?.id);
    if (!unit || edits.has(edit.id) || typeof edit.translation !== 'string') fail('校对修改需要唯一的本批文字 ID 与完整译文。');
    if (edit.expectedRevision !== unit.revision) fail('译文已有更新，请重新校对这项文字。');
    if (unit.locked || unit.manualLock) fail('用户锁定的译文继续保留。');
    edits.set(edit.id, edit);
  }
  const issues = review.issues.map((issue, index) => {
    if (!issue || !byId.has(issue.unitId) || typeof issue.message !== 'string' || !issue.message.trim()) fail('校对问题需要对应文字和明确说明。');
    const required = { correction: 'fixed', needs_evidence: 'open', source_ambiguity: 'retained' };
    if (!(issue.kind in required) || issue.resolution !== required[issue.kind]) fail('校对问题需要明确的解决状态。');
    if (issue.kind === 'correction' && !edits.has(issue.unitId)) fail('纠错问题需要对应的完整译文修改。');
    if (issue.kind === 'needs_evidence' && edits.has(issue.unitId)) fail('待补证据的文字保留当前译文。');
    return { ...structuredClone(issue), id: `${reviewId}-issue-${index + 1}`, reviewId, resolved: issue.kind !== 'needs_evidence' };
  });
  for (const edit of edits.values()) if (edit.translation !== byId.get(edit.id).translation && !issues.some(issue => issue.unitId === edit.id && issue.kind === 'correction')) fail('译文修改需要对应的纠错说明。');
  const records = units.map(unit => {
    const edit = edits.get(unit.id);
    const translation = edit?.translation ?? unit.translation;
    validate(unit, translation);
    return { id: unit.id, translation, notes: edit?.notes ?? unit.notes ?? '', expectedRevision: unit.revision,
      sourceHash: unit.sourceHash, controlHash: sha256(unit.controls ?? unit.context?.controlBindings ?? {}) };
  });
  const prospective = new Map(records.map(record => [record.id, record.translation]));
  const groups = new Set(units.map(unit => unit.context?.syncGroup).filter(Boolean));
  for (const group of groups) {
    const members = allUnits.filter(unit => unit.context?.syncGroup === group);
    if (members.some(unit => !reviewed.has(unit.id))) fail('关联显示文字需要整组校对。');
    if (new Set(members.map(unit => prospective.get(unit.id))).size !== 1) fail('关联显示文字需要一致译文。');
  }
  const states = units.map(unit => ({ id: unit.id, expectedRevision: unit.revision,
    status: issues.some(issue => issue.unitId === unit.id && !issue.resolved) ? 'needs_evidence' : 'proofread',
    changed: prospective.get(unit.id) !== unit.translation || records.find(record => record.id === unit.id).notes !== (unit.notes ?? ''), reviewId }));
  return { reviewId, responseHash, protocol: REVIEW_PROTOCOL, reviewedIds: [...reviewed], records, issues, states };
}

/** A failed item invalidates its linked display group, not independent, explicit review receipts. */
export function materializePartialReviewResponse(review, { units, allUnits = units, validate } = {}) {
  if (typeof validate !== 'function') fail('校对提交需要原生文字校验。');
  if (!review || review.protocol !== REVIEW_PROTOCOL || !Array.isArray(review.reviewedIds) || !Array.isArray(review.issues)
      || !Array.isArray(review.edits) || review.invalidEntries !== undefined && !Array.isArray(review.invalidEntries)) fail('校对结果需要完整的审阅、问题和修改列表。');
  const byId = new Map(units.map(unit => [unit.id, unit])), reviewed = new Set(), invalid = new Map();
  const reject = (id, message) => { if (!byId.has(id)) fail('无法确定错误条目所属的本批文字。'); invalid.set(id, message); };
  for (const id of review.reviewedIds) {
    if (!byId.has(id)) fail('校对审阅包含无法确定归属的文字。');
    if (reviewed.has(id)) reject(id, '校对审阅 ID 重复。');
    reviewed.add(id);
  }
  for (const entry of review.invalidEntries ?? []) {
    if (typeof entry?.message !== 'string' || !entry.message.trim()) fail('局部校对错误需要明确说明。');
    reject(entry.unitId, entry.message);
  }
  for (const edit of review.edits) if (!byId.has(edit?.id)) fail('校对修改包含无法确定归属的文字。');
  for (const issue of review.issues) if (!byId.has(issue?.unitId)) fail('校对问题包含无法确定归属的文字。');
  const groups = new Map();
  for (const unit of units) {
    const key = unit.context?.syncGroup ? `sync:${unit.context.syncGroup}` : `unit:${unit.id}`;
    const members = groups.get(key) ?? []; members.push(unit); groups.set(key, members);
  }
  const plans = [], errors = [];
  for (const members of groups.values()) {
    const ids = new Set(members.map(unit => unit.id));
    try {
      for (const unit of members) {
        if (invalid.has(unit.id)) fail(invalid.get(unit.id));
        if (!reviewed.has(unit.id)) fail('这项文字缺少明确的 reviewed 审阅声明。');
      }
      plans.push(materializeReviewResponse({ protocol: REVIEW_PROTOCOL, reviewedIds: [...ids],
        edits: review.edits.filter(edit => ids.has(edit.id)), issues: review.issues.filter(issue => ids.has(issue.unitId)) },
      { units: members, allUnits, validate }));
    } catch (error) {
      errors.push({ unitIds: [...ids], code: error.code ?? 'INVALID_REVIEW', message: error.message });
    }
  }
  const accepted = new Set(plans.flatMap(plan => plan.reviewedIds)), remainingIds = units.filter(unit => !accepted.has(unit.id)).map(unit => unit.id);
  const reviewId = `review-${sha256({ review, input: units.map(unit => [unit.id, unit.revision, unit.sourceHash, unit.translation]) })}`;
  return { reviewId, responseHash: sha256(review), protocol: REVIEW_PROTOCOL,
    reviewedIds: units.filter(unit => accepted.has(unit.id)).map(unit => unit.id), records: plans.flatMap(plan => plan.records),
    issues: plans.flatMap(plan => plan.issues).map((issue, index) => ({ ...issue, reviewId, id: `${reviewId}-issue-${index + 1}` })),
    states: plans.flatMap(plan => plan.states).map(state => ({ ...state, reviewId })), remainingIds, errors, partial: Boolean(remainingIds.length) };
}
