import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalWorkItemKey, normalizeFinding, applyWorkItemEvent, reconcileDependencies, projectWorkItems, migrateWorkItems, normalizeScopeRequest } from './work-items.mjs';

const resource = { originId: 'origin', path: 'data/scene.json', baselineHash: 'a'.repeat(64), root: 'source', sourceIndex: 0 };
const finding = (extra = {}, context = {}) => normalizeFinding({ resource, locator: { pointer: '/lines/0' }, claim: 'A possible caption',
  sourceEvidenceRefs: ['source'], consumerEvidenceRefs: ['consumer'], ...extra },
{ projectId: 'project', validReceiptIds: ['source', 'consumer'], sourceVerified: true, scopeAuthorized: true, ...context });
const apply = (items, item, event) => applyWorkItemEvent(items, { itemId: item.itemId, sourceEpoch: item.sourceEpoch, ...event });

test('identity excludes wording, job, window and sourceIndex, while source baselines remain distinct', () => {
  const first = finding(), other = finding({ claim: 'Changed title', ownerJobId: 'other', resource: { ...resource, sourceIndex: 8 } });
  assert.equal(first.itemId, other.itemId);
  assert.notEqual(first.itemId, finding({ resource: { ...resource, baselineHash: 'b'.repeat(64) } }).itemId);
  assert.equal(canonicalWorkItemKey({ projectId: 'project', resource, claimKind: 'a' }), canonicalWorkItemKey({ projectId: 'project', resource, claimKind: 'b' }));
  assert.throws(() => finding({ status: 'accepted' }), /host field/);
});

test('readiness verifies references and positions but is not an added writer gate', () => {
  const unbound = finding({}, { validReceiptIds: [], sourceVerified: false });
  assert.equal(unbound.status, 'needs_evidence'); assert.equal(unbound.unverifiedEvidenceRefs.length, 2);
  let items = applyWorkItemEvent({}, { type: 'finding_recorded', finding: unbound });
  items = apply(items, unbound, { type: 'candidate_written', candidateId: 'content-hash-candidate' });
  assert.equal(items[unbound.itemId].status, 'candidate_saved');
  items = applyWorkItemEvent(items, { type: 'finding_recorded', finding: unbound });
  assert.equal(items[unbound.itemId].status, 'candidate_saved', 'new explanation does not erase a saved host milestone');
  assert.equal(finding().status, 'ready_for_attempt');
});

test('different candidate checks cannot combine into validation and accepted work remains separately identified', () => {
  const item = finding(); let items = applyWorkItemEvent({}, { type: 'finding_recorded', finding: item });
  for (const candidateId of ['a', 'b']) {
    items = apply(items, item, { type: 'candidate_written', candidateId });
    items = apply(items, item, { type: 'validation_completed', candidateId, validationId: `validation-${candidateId}`, passed: false, checks: { structure: 'passed' }, receiptId: 'negative' });
  }
  assert.equal(items[item.itemId].status, 'candidate_saved');
  items = apply(items, item, { type: 'validation_completed', candidateId: 'b', validationId: 'valid', passed: true, fresh: true, receiptId: 'proof' });
  assert.equal(items[item.itemId].status, 'validated');
  items = apply(items, item, { type: 'recipe_accepted', candidateId: 'b', recipeId: 'recipe', receiptId: 'accepted' });
  assert.equal(items[item.itemId].status, 'accepted'); assert.equal(items[item.itemId].attempts.writer, 2);
  assert.equal(Object.hasOwn(items[item.itemId], 'integrated'), false);
});

test('consumer changes retain item identity and attempts, source changes stale the old item and link its replacement', () => {
  const dependency = { originId: 'origin', path: 'ui.js', baselineHash: 'b'.repeat(64) }, item = finding({ dependencies: [dependency] });
  let items = applyWorkItemEvent({}, { type: 'finding_recorded', finding: item });
  items = apply(items, item, { type: 'candidate_written', candidateId: 'candidate' });
  const changed = reconcileDependencies(items, [{ ...dependency, baselineHash: 'c'.repeat(64) }]);
  assert.equal(changed[item.itemId].status, 'needs_evidence'); assert.equal(changed[item.itemId].attempts.writer, 1);
  assert.equal(changed[item.itemId].itemId, item.itemId);
  items = reconcileDependencies(changed, [{ ...resource, baselineHash: 'd'.repeat(64) }]);
  assert.equal(items[item.itemId].status, 'stale');
  const next = finding({ resource: { ...resource, baselineHash: 'd'.repeat(64) } });
  items = applyWorkItemEvent(items, { type: 'finding_recorded', finding: next });
  assert.equal(items[next.itemId].supersedes, item.itemId);
});

test('work items survive history-sized unrelated activity and stable pages retain all references', () => {
  let items = {};
  for (let index = 0; index < 35; index++) items = applyWorkItemEvent(items, { type: 'finding_recorded', finding: finding({ locator: { pointer: `/lines/${index}` } }) });
  const restored = migrateWorkItems(JSON.parse(JSON.stringify(items))), seen = [];
  let cursor;
  do { const page = projectWorkItems(restored, { limit: 7, cursor }); seen.push(...page.items); cursor = page.nextCursor; } while (cursor);
  assert.equal(new Set(seen.map(item => item.itemId)).size, 35);
  assert.ok(seen.every(item => item.sourceEvidenceRefs.includes('source') && item.consumerEvidenceRefs.includes('consumer')));
  const first = seen[0], moved = apply(restored, first, { type: 'work_item_transferred', expectedRevision: first.revision, ownerJobId: 'merged', ownerScopeRevision: 2 });
  assert.equal(moved[first.itemId].ownerJobId, 'merged');
  assert.throws(() => apply(moved, first, { type: 'work_item_transferred', expectedRevision: first.revision, ownerJobId: 'again' }), /revision conflict/);
  assert.throws(() => migrateWorkItems({ [first.itemId]: { ...first, schemaVersion: 9 } }), /Unsupported/);
});

test('explicit missing resources revoke proof without treating an incomplete resource listing as deletion', () => {
  const consumer = { originId: 'origin', path: 'consumer.js', baselineHash: 'c'.repeat(64) }, item = finding({ dependencies: [consumer] });
  let items = applyWorkItemEvent({}, { type: 'finding_recorded', finding: item });
  items = apply(items, item, { type: 'recipe_accepted', recipeId: 'recipe', receiptId: 'accepted' });
  assert.equal(reconcileDependencies(items, [])[item.itemId].status, 'accepted');
  const missingConsumer = reconcileDependencies(items, [{ ...consumer, missing: true }]);
  assert.equal(missingConsumer[item.itemId].status, 'needs_evidence');
  assert.equal(missingConsumer[item.itemId].blockers[0].code, 'dependency-missing');
  assert.deepEqual(reconcileDependencies(missingConsumer, [{ ...consumer, missing: true }]), missingConsumer);
  const deletedSource = reconcileDependencies(items, [{ ...resource, exists: false }]);
  assert.equal(deletedSource[item.itemId].status, 'stale'); assert.equal(deletedSource[item.itemId].proof, undefined);
});

test('saving a candidate explanation cannot erase the previously verified consumer dependency', () => {
  const consumer = { originId: 'origin', path: 'consumer.js', baselineHash: 'c'.repeat(64) }, item = finding({ dependencies: [consumer] });
  let items = applyWorkItemEvent({}, { type: 'finding_recorded', finding: item });
  items = apply(items, item, { type: 'candidate_written', candidateId: 'candidate' });
  items = applyWorkItemEvent(items, { type: 'finding_recorded', finding: finding({ claim: 'Saved writer explanation' }) });
  assert.deepEqual(items[item.itemId].dependencies, [consumer]);
  assert.equal(reconcileDependencies(items, [{ ...consumer, baselineHash: 'd'.repeat(64) }])[item.itemId].status, 'needs_evidence');
});

test('one owner retains a hundred positions and multiple candidates, while blocked positions stay independently pending', () => {
  let items = {};
  const rows = Array.from({ length: 100 }, (_, index) => finding({ locator: { pointer: `/caption/${index}` } },
    { owner: { ownerId: 'file-owner', assignmentRevision: 2 }, sequence: index }));
  for (const item of rows) items = applyWorkItemEvent(items, { type: 'finding_recorded', finding: item });
  assert.equal(new Set(Object.values(items).map(item => item.owner.ownerId)).size, 1);
  const [a, b, c] = rows;
  for (const [item, candidateId] of [[a, 'candidate-a'], [a, 'candidate-a-repair'], [b, 'candidate-b']]) {
    items = apply(items, item, { type: 'candidate_written', candidateId, targetItemIds: [item.itemId] });
    items = apply(items, item, { type: 'validation_completed', candidateId, validationId: `validation-${candidateId}`, passed: true, receiptId: `proof-${candidateId}` });
  }
  items = apply(items, a, { type: 'recipe_accepted', recipeId: 'recipe-a', acceptedBatchId: 'batch-a', receiptId: 'accepted-a' });
  items = apply(items, c, { type: 'tool_failed', failure: { code: 'UNKNOWN_EXPRESSION' } });
  const restored = migrateWorkItems(JSON.parse(JSON.stringify(items)));
  assert.deepEqual(restored[a.itemId].candidateRefs.map(ref => [ref.candidateId, ref.validationIds]),
    [['candidate-a', ['validation-candidate-a']], ['candidate-a-repair', ['validation-candidate-a-repair']]]);
  assert.equal(restored[a.itemId].acceptedBatchRefs[0].acceptedBatchId, 'batch-a');
  assert.equal(restored[b.itemId].status, 'validated'); assert.equal(restored[c.itemId].readiness.status, 'blocked');
  assert.equal(restored[a.itemId].scheduling.firstEligibleSeq, 0);
});

test('read-only consumers do not acquire write ownership; real requests include the current write set and stable no-op identity', () => {
  const assignment = { id: 'owner-a', ownerId: 'stable-owner', assignmentRevision: 4, files: ['a.json'] };
  const read = normalizeScopeRequest({ readDependencyFiles: ['consumer.js'], reason: 'follow display' }, { assignment });
  assert.equal(read.effectiveAssignmentChange, false); assert.deepEqual(read.canonicalWriteSet, ['a.json']);
  const write = normalizeScopeRequest({ files: ['b.json'], reason: 'joint write' }, { assignment });
  assert.equal(write.effectiveAssignmentChange, true); assert.deepEqual(write.canonicalWriteSet, ['a.json', 'b.json']);
  assert.equal(write.ownerId, 'stable-owner'); assert.equal(write.assignmentRevision, 4);
  const repeated = normalizeScopeRequest({ requestedWriteFiles: ['b.json'], reason: 'different prose' }, { assignment });
  assert.equal(repeated.requestId, write.requestId);
  assert.throws(() => normalizeScopeRequest({ affectedItemIds: ['unowned'] }, { assignment }), /outside/);
});
