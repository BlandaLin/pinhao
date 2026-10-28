import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const pathOf = value => String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
const resourceKey = ref => ref?.originId && ref?.baselineHash && ref.root !== 'work'
  ? JSON.stringify([ref.originId, pathOf(ref.path), ref.baselineHash]) : null;
const defaults = { materialReviewSteps: 12, acceptedReviewSteps: 24, recoverySteps: 8, sameFailureThreshold: 3 };

export function migrateControl(raw, { legacy = false } = {}) {
  if (raw?.version !== undefined && raw.version !== 1) throw new Error('Unsupported technical control version');
  return { version: 1, revision: 0, historyCoverage: legacy ? 'partial' : 'complete', activity: 0, logicalSteps: 0,
    materialSerial: 0, acceptedSerial: 0, materialFacts: {}, readRanges: {}, viewRanges: {}, milestonesByItem: {}, acceptedByKey: {}, resolutionsByKey: {}, failuresByCause: {},
    watch: { stepsSinceMaterial: 0, stepsSinceAcceptedOrResolved: 0, materialAtStep: 0, acceptedAtStep: 0, lastReviewStep: 0, lastNudgeByCause: {}, recovery: null },
    ...clone(raw ?? {}), watch: { stepsSinceMaterial: 0, stepsSinceAcceptedOrResolved: 0, materialAtStep: 0, acceptedAtStep: 0, lastReviewStep: 0,
      lastNudgeByCause: {}, recovery: null, ...clone(raw?.watch ?? {}) } };
}

export function normalizeObservation({ tool, input = {}, output = {}, resourceRefs = [], itemIds = [] }) {
  const observation = { tool, itemIds, facts: [] };
  if (tool === 'read_evidence' || input.root === 'work' || output?.error || output?.passed === false) return observation;
  if (tool === 'read_resource') {
    const ref = resourceRefs.find(item => pathOf(item.path) === pathOf(input.file));
    const key = resourceKey(ref), start = output.offset ?? input.offset ?? 0, length = output.returnedBytes;
    if (key && Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(length) && length >= 0) {
      observation.facts.push(length ? { kind: 'read-range', key, start, end: start + length }
        : { kind: 'boundary', key: digest([key, 'eof']) });
    }
  } else if (['list_files', 'search_files'].includes(tool)) {
    for (const row of output.files ?? output.items ?? []) {
      const file = pathOf(row.file ?? row.path), ref = resourceRefs.find(item => pathOf(item.path) === file), key = resourceKey(ref);
      if (key) observation.facts.push({ kind: 'location', key: digest([key, tool === 'list_files' ? 'file' : row.locator ?? [row.byteStart, row.byteEnd, row.line]]) });
    }
  }
  return observation;
}

export function normalizeFailure({ tool, input = {}, error, output, itemId, sourceEpoch, resourceRef, checkId, affectedLocator }) {
  const detail = error ?? output?.error ?? {}, code = detail.code ?? output?.errorCode ?? (output?.passed === false ? 'VALIDATION_FAILED' : 'TOOL_FAILED');
  const resource = resourceRef ? [resourceRef.originId, pathOf(resourceRef.path), resourceRef.baselineHash, resourceRef.root ?? 'source']
    : [input.root ?? 'source', input.sourceIndex ?? 0, pathOf(input.file ?? input.relativePath)];
  const check = checkId ?? detail.checkId ?? output?.checkId, locator = affectedLocator ?? detail.locator ?? detail.pointer ?? input.locator ?? input.pointer;
  return { causeKey: digest([sourceEpoch, itemId, tool === 'read_run' || tool === 'wait_run' ? 'workspace-process' : tool, resource, code, check, locator,
    code === 'TOOL_FAILED' ? detail.message : undefined]),
    attemptSignature: digest([tool, input, output?.codeHash]), code, tool,
    target: { root: input.root ?? 'source', path: pathOf(input.file ?? input.relativePath), sourceIndex: input.sourceIndex ?? null },
    resourceRef: resourceRef ?? (input.file || input.relativePath ? { root: input.root ?? 'source', sourceIndex: input.sourceIndex ?? 0, path: pathOf(input.file ?? input.relativePath) } : undefined), itemId, sourceEpoch, checkId,
    message: String(detail.message ?? error ?? output?.stderr ?? code), transient: ['ETIMEDOUT', 'ECONNRESET', '429'].includes(String(code)) };
}

function mergeRange(ranges, start, end) {
  const rows = [...ranges, [start, end]].sort((a, b) => a[0] - b[0]), merged = [];
  for (const row of rows) {
    if (merged.length && row[0] <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(row[1], merged.at(-1)[1]);
    else merged.push([...row]);
  }
  return merged;
}
const bytes = ranges => ranges.reduce((n, [start, end]) => n + end - start, 0);

/** The caller deduplicates receipt positions and commits both reducers in one queue. */
export function reduceControl(raw, event) {
  const state = migrateControl(raw), watch = state.watch;
  state.revision++;
  let material = false, accepted = false;
  const itemKey = JSON.stringify([event.itemId ?? 'unassigned', event.sourceEpoch ?? null]);
  if (event.type === 'observation_recorded' || event.type === 'model_presented') {
    if (event.type === 'observation_recorded') state.activity++;
    for (const fact of event.observation?.facts ?? []) {
      if (['read-range', 'presented-view-range'].includes(fact.kind) && fact.end > fact.start) {
        const ledger = fact.kind === 'read-range' ? state.readRanges : state.viewRanges;
        const previous = ledger[fact.key] ?? [], next = mergeRange(previous, fact.start, fact.end);
        material ||= bytes(next) > bytes(previous); ledger[fact.key] = next;
      } else if (fact.key && !state.materialFacts[fact.key]) { state.materialFacts[fact.key] = true; material = true; }
    }
  } else if (event.type === 'finding_recorded' && event.finding?.status === 'ready_for_attempt' && event.finding.locator && event.finding.itemId) {
    const key = `finding:${event.finding.itemId}:${event.finding.sourceEpoch ?? event.finding.resource?.baselineHash}`;
    if (!state.materialFacts[key]) { state.materialFacts[key] = true; material = true; }
  } else if (event.type === 'candidate_written') {
    const milestone = state.milestonesByItem[itemKey] ??= { candidate: false, gates: {} };
    if (!milestone.candidate) { milestone.candidate = true; material = true; }
  } else if (event.type === 'validation_completed') {
    const milestone = state.milestonesByItem[itemKey] ??= { candidate: false, gates: {} };
    if (event.fresh !== false) for (const [gate, status] of Object.entries(event.checks ?? {})) if ((status === true || status === 'passed') && !milestone.gates[gate]) {
      milestone.gates[gate] = true; material = true;
    }
  } else if (['recipe_accepted', 'coverage_resolved'].includes(event.type) && event.receiptId && event.fresh !== false && event.passed !== false) {
    const ledger = event.type === 'recipe_accepted' ? state.acceptedByKey : state.resolutionsByKey, key = event.key ?? itemKey;
    if (!ledger[key]) { ledger[key] = event.receiptId; accepted = true; material = true; state.acceptedSerial++; }
  } else if (event.type === 'tool_failed' && event.failure?.causeKey) {
    const failure = event.failure, previous = state.failuresByCause[failure.causeKey];
    const value = { ...failure, firstSeen: previous?.firstSeen ?? event.at, lastSeen: event.at,
      occurrences: (previous?.occurrences ?? 0) + 1, attemptsBySignature: { ...previous?.attemptsBySignature }, resolvedByReceiptId: undefined,
      lastAttemptSignature: failure.attemptSignature };
    value.attemptsBySignature[failure.attemptSignature] = (value.attemptsBySignature[failure.attemptSignature] ?? 0) + 1;
    state.failuresByCause[failure.causeKey] = value;
  } else if (event.type === 'failure_resolved' && event.receiptId) {
    for (const key of event.causeKeys ?? []) if (state.failuresByCause[key]) state.failuresByCause[key].resolvedByReceiptId = event.receiptId;
    if (event.causeKeys?.includes(watch.recovery?.causeKey)) watch.recovery = null;
  } else if (event.type === 'control_reviewed') {
    watch.lastReviewStep = state.logicalSteps;
    watch.lastNudgeByCause[event.causeKey ?? event.reasonCode ?? 'NO_MATERIAL_REVIEW'] = event.receiptId ?? event.recoveryAllowanceId;
    const failure = state.failuresByCause[event.causeKey];
    watch.recovery = { id: event.recoveryAllowanceId, startedAtStep: state.logicalSteps, materialSerial: state.materialSerial,
      causeKey: event.causeKey, failureOccurrences: failure?.occurrences, attemptSignature: failure?.lastAttemptSignature };
  } else if (event.type === 'step_completed') {
    state.logicalSteps++;
    watch.stepsSinceMaterial = Math.max(0, state.logicalSteps - watch.materialAtStep);
    watch.stepsSinceAcceptedOrResolved = Math.max(0, state.logicalSteps - watch.acceptedAtStep);
  }
  if (material) { state.materialSerial++; watch.materialAtStep = state.logicalSteps + 1; watch.stepsSinceMaterial = 0; }
  if (accepted) { watch.acceptedAtStep = state.logicalSteps + 1; watch.stepsSinceAcceptedOrResolved = 0; watch.recovery = null; }
  return state;
}

export function decideContinuation(raw, { budget, limits = {}, pendingOperations = {}, readyItemIds = [], blockerRefs = [], cancelled = false, complete = false } = {}) {
  const state = migrateControl(raw), policy = { ...defaults, ...limits }, watch = state.watch;
  for (const key of Object.keys(defaults)) if (!Number.isSafeInteger(policy[key]) || policy[key] < 1) throw new Error(`Invalid control limit: ${key}`);
  const result = (action, reasonCode, extra = {}) => ({ action, reasonCode, itemIds: readyItemIds, blockerRefs, ...extra });
  if (complete) return result('complete', 'VERIFIED');
  if (cancelled) return result('pause', 'CANCELLED');
  if (budget?.allowed === false || budget?.remainingHttp === 0) return result('pause', budget?.reasonCode ?? 'BUDGET_EXHAUSTED');
  const pending = Object.values(pendingOperations);
  if (pending.some(operation => operation.status === 'pending-reconciliation')) return result('pause', 'PENDING_RECONCILIATION');
  if (pending.length) return result('wait', 'OPERATION_PENDING');
  if (watch.recovery) {
    if (state.logicalSteps - watch.recovery.startedAtStep < policy.recoverySteps) return result('continue', 'RECOVERY_WINDOW');
    const failure = state.failuresByCause[watch.recovery.causeKey];
    if (failure && !failure.resolvedByReceiptId && failure.occurrences > watch.recovery.failureOccurrences
        && failure.lastAttemptSignature === watch.recovery.attemptSignature) return result('pause', 'REPEATED_FAILURE_STALLED');
    if (state.materialSerial > watch.recovery.materialSerial && watch.stepsSinceMaterial < policy.materialReviewSteps) return result('continue', 'MATERIAL_PROGRESS_WITHOUT_ACCEPTED');
    return result('pause', 'STALLED');
  }
  const repeated = Object.entries(state.failuresByCause).find(([key, failure]) => !failure.resolvedByReceiptId && !failure.transient
    && failure.occurrences >= policy.sameFailureThreshold && !watch.lastNudgeByCause[key]);
  if (repeated) return result('replan', 'REPEATED_FAILURE', { causeKey: repeated[0],
    recoveryAllowanceId: `recovery-${digest([repeated[0], repeated[1].occurrences]).slice(0, 24)}` });
  const reason = watch.stepsSinceMaterial >= policy.materialReviewSteps ? 'NO_MATERIAL_REVIEW'
    : watch.stepsSinceAcceptedOrResolved >= policy.acceptedReviewSteps ? 'NO_ACCEPTED_REVIEW' : null;
  return reason ? result('replan', reason, { recoveryAllowanceId: `recovery-${digest([state.logicalSteps, reason]).slice(0, 24)}` }) : result('continue', 'WITHIN_LIMITS');
}
