import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { migrateControl, normalizeObservation, normalizeFailure, reduceControl, decideContinuation } from './control-state.mjs';

const ref = { originId: 'input-a', path: 'one.txt', baselineHash: 'a'.repeat(64), root: 'source' };
const read = (input = {}, output = {}) => ({ type: 'observation_recorded', observation: normalizeObservation({ tool: 'read_resource',
  input: { file: 'one.txt', ...input }, output: { returnedBytes: 1, totalBytes: 1, ...output }, resourceRefs: [ref] }) });
const step = state => reduceControl(state, { type: 'step_completed' });

test('requested length and forgotten old input variations cannot renew source progress', () => {
  let state = migrateControl();
  for (let length = 1; length <= 120; length++) state = step(reduceControl(state, read({ length })));
  assert.equal(state.materialSerial, 1);
  assert.equal(state.watch.stepsSinceAcceptedOrResolved, 120);
  const previous = state.materialSerial;
  state = reduceControl(state, read({ length: 1, root: 'source', encoding: 'base64' }));
  assert.equal(state.materialSerial, previous);
  assert.equal(decideContinuation(state).action, 'replan');
});

test('actual read ranges merge while repeated EOF offsets yield only one boundary fact', () => {
  let state = migrateControl();
  for (const [offset, returnedBytes] of [[0, 10], [5, 10], [0, 15]]) state = reduceControl(state, read({ offset }, { returnedBytes }));
  assert.equal(state.materialSerial, 2);
  assert.deepEqual(Object.values(state.readRanges), [[[0, 15]]]);
  for (const offset of [15, 30, 50]) state = reduceControl(state, read({ offset }, { returnedBytes: 0, totalBytes: undefined }));
  assert.equal(state.materialSerial, 3);
});

test('script outputs and evidence restoration are activity, not new material or accepted work', () => {
  let state = migrateControl();
  for (const tool of ['read_evidence', 'wait_run', 'read_run']) for (let index = 0; index < 10; index++) state = reduceControl(state,
    { type: 'observation_recorded', observation: normalizeObservation({ tool, input: { pointer: `/old/${index}` }, output: { status: 'completed', exitCode: 0, content: String(index) } }) });
  assert.equal(state.activity, 30); assert.equal(state.materialSerial, 0); assert.equal(state.acceptedSerial, 0);
});

test('a host-ready locator is material once per stable item and epoch, not once per claim wording', () => {
  const finding = { itemId: 'stable-locator', sourceEpoch: 'source-v1', locator: { pointer: '/text' }, status: 'ready_for_attempt', claim: 'A caption' };
  let state = step(step(migrateControl()));
  state = reduceControl(state, { type: 'finding_recorded', finding });
  state = reduceControl(state, { type: 'finding_recorded', finding: { ...finding, claim: 'Reworded explanation' } });
  assert.equal(state.materialSerial, 1); assert.equal(state.acceptedSerial, 0);
  assert.equal(state.watch.stepsSinceAcceptedOrResolved, 2);
  state = reduceControl(state, { type: 'finding_recorded', finding: { ...finding, itemId: 'unverified', status: 'needs_evidence' } });
  assert.equal(state.materialSerial, 1);
  state = reduceControl(state, { type: 'finding_recorded', finding: { ...finding, itemId: 'different-locator', locator: { pointer: '/other' } } });
  assert.equal(state.materialSerial, 2); assert.equal(state.acceptedSerial, 0);
});

test('candidate IDs are content hashes, not UUIDs, and code variants do not mint new item milestones', () => {
  const id = code => `candidate-${createHash('sha256').update(JSON.stringify({ manifest: { id: 'neutral' }, code })).digest('hex').slice(0, 40)}`;
  assert.equal(id('same'), id('same')); assert.notEqual(id('same'), id('same // comment'));
  let state = migrateControl();
  for (let index = 0; index < 100; index++) state = reduceControl(state, { type: 'candidate_written', itemId: 'stable-item', sourceEpoch: 'same-source', candidateId: id(`code ${index}`) });
  assert.equal(state.materialSerial, 1); assert.equal(state.acceptedSerial, 0);
});

test('gate improvements are finite and do not combine into an accepted proof', () => {
  let state = migrateControl();
  for (const [candidateId, checks] of [['a', { structure: true, sample: false }], ['a', { structure: 'failed' }], ['b', { structure: 'passed', sample: true }], ['c', { sample: 'passed' }]]) {
    state = reduceControl(state, { type: 'validation_completed', itemId: 'item', sourceEpoch: 'epoch', candidateId, checks, passed: false });
  }
  assert.equal(state.materialSerial, 2); assert.equal(state.acceptedSerial, 0);
});

test('fresh accepted and legal zero-new-text resolutions refresh only their own outcome clock', () => {
  let state = step(step(migrateControl()));
  const event = { type: 'coverage_resolved', key: 'source:position:non-display', itemId: 'item', sourceEpoch: 'epoch', receiptId: 'receipt-actual', fresh: true, passed: true };
  state = step(reduceControl(state, event));
  assert.equal(state.watch.stepsSinceAcceptedOrResolved, 0); assert.equal(state.acceptedSerial, 1);
  state = step(reduceControl(state, { ...event, receiptId: 'receipt-other' }));
  assert.equal(state.acceptedSerial, 1); assert.equal(state.watch.stepsSinceAcceptedOrResolved, 1);
  state = reduceControl(state, { type: 'recipe_accepted', key: 'fake', fresh: true });
  assert.equal(state.acceptedSerial, 1);
});

test('bounded recovery stops unchanged investigation but does not force a writer during genuine long reads', () => {
  let state = migrateControl();
  for (let n = 0; n < 12; n++) state = step(state);
  const decision = decideContinuation(state);
  state = reduceControl(state, { type: 'control_reviewed', ...decision });
  for (let n = 0; n < 8; n++) state = step(state);
  assert.equal(decideContinuation(state).reasonCode, 'STALLED');
  state = migrateControl();
  for (let n = 0; n < 40; n++) {
    state = step(reduceControl(state, read({ offset: n }, { returnedBytes: 1, totalBytes: 100 })));
    const next = decideContinuation(state);
    if (next.action === 'replan') state = reduceControl(state, { type: 'control_reviewed', ...next });
    else assert.equal(next.action, 'continue');
  }
  assert.equal(state.acceptedSerial, 0);
  assert.equal(decideContinuation(state, { budget: { allowed: false } }).reasonCode, 'BUDGET_EXHAUSTED');
  assert.equal(decideContinuation(state, { pendingOperations: { one: { status: 'running' } } }).action, 'wait');
  assert.equal(decideContinuation(state, { pendingOperations: { one: { status: 'pending-reconciliation' } } }).action, 'pause');
});

test('unrelated reads and windows do not resolve deterministic causes or infer the cause of EPERM', () => {
  let state = migrateControl();
  const a = normalizeFailure({ tool: 'read_resource', input: { file: 'missing' }, error: { code: 'ENOENT', message: 'missing' } });
  const b = normalizeFailure({ tool: 'read_resource', input: { root: 'source', file: './missing' }, error: { code: 'ENOENT', message: 'missing' } });
  assert.equal(a.causeKey, b.causeKey);
  assert.deepEqual(a.target, { root: 'source', path: 'missing', sourceIndex: null });
  assert.notEqual(a.causeKey, normalizeFailure({ tool: 'read_resource', input: { file: 'missing', sourceIndex: 1 }, error: { code: 'ENOENT' } }).causeKey);
  for (let n = 0; n < 3; n++) state = reduceControl(reduceControl(state, { type: 'tool_failed', failure: a }), read());
  state = migrateControl(JSON.parse(JSON.stringify(state)), { legacy: true });
  assert.equal(state.failuresByCause[a.causeKey].occurrences, 3);
  assert.equal(state.failuresByCause[a.causeKey].resolvedByReceiptId, undefined);
  assert.equal(normalizeFailure({ tool: 'rename', error: { code: 'EPERM' } }).transient, false);
  assert.throws(() => migrateControl({ version: 99 }), /Unsupported/);
});

test('one cause gets one recovery allowance and unchanged failure cannot be laundered by unrelated material', () => {
  const failure = normalizeFailure({ tool: 'read_resource', input: { file: 'missing' }, itemId: 'item', sourceEpoch: 'epoch', checkId: 'read', error: { code: 'ENOENT' } });
  let state = migrateControl();
  for (let index = 0; index < 3; index++) state = reduceControl(state, { type: 'tool_failed', failure });
  const decision = decideContinuation(state);
  assert.equal(decision.reasonCode, 'REPEATED_FAILURE'); assert.equal(decision.causeKey, failure.causeKey);
  state = reduceControl(state, { type: 'control_reviewed', ...decision });
  state = reduceControl(reduceControl(state, read()), { type: 'tool_failed', failure });
  for (let index = 0; index < 8; index++) state = step(state);
  assert.equal(decideContinuation(state).reasonCode, 'REPEATED_FAILURE_STALLED');
  assert.equal(decideContinuation(migrateControl(JSON.parse(JSON.stringify(state)))).action, 'pause');
  assert.notEqual(failure.causeKey, normalizeFailure({ tool: 'read_resource', input: { file: 'missing' }, itemId: 'other', sourceEpoch: 'epoch', checkId: 'read', error: { code: 'ENOENT' } }).causeKey);
});
