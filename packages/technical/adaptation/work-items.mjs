import { createHash } from 'node:crypto';

const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const resourcePath = value => {
  const file = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!file || file.startsWith('/') || file.includes(':') || file.split('/').some(part => !part || part === '..')) throw new Error('Work item needs a relative resource path');
  return file;
};
const resourceOf = resource => {
  if (!resource?.originId || !resource.baselineHash) throw new Error('Work item needs a stable origin and source baseline');
  return { ...clone(resource), path: resourcePath(resource.path ?? resource.relativeFile), root: resource.root ?? 'source' };
};
const locatorOf = (locator, file) => {
  if (!locator || !Object.keys(locator).length) return null;
  const result = Object.fromEntries(['pointer', 'byteStart', 'byteEnd', 'nativePath', 'path', 'target', 'segment', 'formatPath'].filter(key => locator[key] !== undefined).map(key => [key, clone(locator[key])]));
  return Object.keys(result).length ? canonical({ ...result, file: resourcePath(locator.file ?? file) }) : null;
};
const referenceId = ref => typeof ref === 'string' ? ref : ref?.receiptId;
const unique = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
const closed = status => ['accepted', 'closed_non_display', 'stale'].includes(status);
const extend = item => ({ ...item,
  owner: item.owner ?? { ownerId: item.ownerJobId ?? null, assignmentRevision: item.ownerScopeRevision ?? 0 },
  readiness: item.readiness ?? { status: item.blockers?.length ? 'blocked' : item.status === 'ready_for_attempt' ? 'ready_for_attempt' : 'investigating', blockerIds: (item.blockers ?? []).map(value => value.code).filter(Boolean) },
  candidateRefs: item.candidateRefs ?? (item.artifacts?.candidateIds ?? []).map(candidateId => ({ candidateId, targetItemIds: [item.itemId], validationIds: [] })),
  acceptedBatchRefs: item.acceptedBatchRefs ?? [], integrationReceiptRefs: item.integrationReceiptRefs ?? [],
  scheduling: item.scheduling ?? { firstEligibleSeq: null, lastServedSeq: null, dirtyRevision: 0 } });

export function canonicalWorkItemKey({ projectId, resource, claimKind, locator }) {
  if (!projectId) throw new Error('Work item needs a project identity');
  const ref = resourceOf(resource), position = locatorOf(locator, ref.path);
  const identity = [projectId, ref.originId, ref.path, ref.baselineHash, position ? claimKind ?? 'display-text' : 'resource-investigation', position];
  if (ref.sourceViewKey || ref.containerRef) identity.push({ sourceViewKey: ref.sourceViewKey, containerRef: ref.containerRef });
  return `item-${digest(identity).slice(0, 40)}`;
}

export function normalizeFinding(finding, { projectId, sourceVerified = false, scopeAuthorized = false, validReceiptIds = [], owner, sequence, at = null } = {}) {
  for (const field of ['status', 'attempts', 'artifacts', 'accepted', 'proof']) if (Object.hasOwn(finding ?? {}, field)) throw new Error(`Finding cannot assign host field: ${field}`);
  const resource = resourceOf(finding?.resource ?? finding?.sourceRef), locator = locatorOf(finding.locator, resource.path);
  const claimKind = locator ? finding.claimKind ?? 'display-text' : 'resource-investigation';
  const allowed = new Set(validReceiptIds), sources = finding.sourceEvidenceRefs ?? [], consumers = finding.consumerEvidenceRefs ?? [];
  const sourceEvidenceRefs = sources.filter(ref => allowed.has(referenceId(ref))), consumerEvidenceRefs = consumers.filter(ref => allowed.has(referenceId(ref)));
  const unverifiedEvidenceRefs = [...sources, ...consumers].filter(ref => !allowed.has(referenceId(ref)));
  const ready = Boolean(locator && sourceVerified && scopeAuthorized && sourceEvidenceRefs.length && consumerEvidenceRefs.length);
  return extend({ schemaVersion: 1, itemId: canonicalWorkItemKey({ projectId, resource, claimKind, locator }), projectId, revision: 1,
    resource, locator, claimKind, sourceEpoch: finding.sourceEpoch ?? resource.baselineHash, parentItemId: finding.parentItemId,
    claim: String(finding.claim ?? ''), selection: clone(finding.selection), selectionRef: clone(finding.selectionRef),
    sourceEvidenceRefs: unique(sourceEvidenceRefs), consumerEvidenceRefs: unique(consumerEvidenceRefs), unverifiedEvidenceRefs: unique(unverifiedEvidenceRefs),
    dependencies: clone(finding.dependencies ?? []), blockers: clone(finding.blockers ?? []), proposedNextAction: finding.proposedNextAction,
    ownerJobId: owner?.ownerId ?? finding.ownerJobId, ownerScopeRevision: owner?.assignmentRevision ?? finding.ownerScopeRevision, owner: clone(owner),
    status: ready ? 'ready_for_attempt' : 'needs_evidence', attempts: { investigate: 0, writer: 0, validate: 0, submit: 0 },
    artifacts: { candidateIds: [], validationIds: [], recipeIds: [] }, scheduling: { firstEligibleSeq: ready ? sequence ?? null : null, lastServedSeq: null, dirtyRevision: 0 }, createdAt: at, updatedAt: at });
}

export function migrateWorkItems(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid work item state');
  const result = {};
  for (const [id, item] of Object.entries(raw)) {
    if (item.schemaVersion !== undefined && item.schemaVersion !== 1) throw new Error('Unsupported work item version');
    if (item.itemId !== id) throw new Error('Work item identity mismatch');
    result[id] = extend(item.schemaVersion === 1 ? clone(item) : { ...clone(item), schemaVersion: 1, status: 'needs_evidence', proof: undefined });
  }
  return result;
}

/** Events are host facts, never model-writable status patches. */
export function applyWorkItemEvent(items, event) {
  const result = { ...items };
  if (event.type === 'finding_recorded') {
    const next = extend(clone(event.finding)), previous = result[next.itemId] && extend(result[next.itemId]);
    if (event.expectedRevision !== undefined && event.expectedRevision !== (previous?.revision ?? 0)) throw new Error('Work item revision conflict');
    if (previous) {
      const dependenciesChanged = previous.dependencies.some(before => next.dependencies.some(after => after.originId === before.originId
        && after.path === before.path && after.baselineHash !== before.baselineHash));
      const preserve = !dependenciesChanged && ['candidate_saved', 'validated', 'accepted', 'closed_non_display'].includes(previous.status);
      result[next.itemId] = { ...previous, ...next, revision: previous.revision + 1, createdAt: previous.createdAt,
        sourceEvidenceRefs: unique([...previous.sourceEvidenceRefs, ...next.sourceEvidenceRefs]),
        consumerEvidenceRefs: unique([...previous.consumerEvidenceRefs, ...next.consumerEvidenceRefs]),
        dependencies: [...new Map([...previous.dependencies, ...next.dependencies].map(ref => [JSON.stringify([ref.originId, ref.path]), ref])).values()],
        attempts: previous.attempts, artifacts: previous.artifacts, candidateRefs: previous.candidateRefs,
        acceptedBatchRefs: previous.acceptedBatchRefs, integrationReceiptRefs: previous.integrationReceiptRefs,
        owner: previous.owner, ownerJobId: previous.ownerJobId, ownerScopeRevision: previous.ownerScopeRevision,
        scheduling: { ...previous.scheduling, firstEligibleSeq: previous.scheduling.firstEligibleSeq ?? next.scheduling.firstEligibleSeq,
          dirtyRevision: previous.scheduling.dirtyRevision + 1 },
        ...(preserve ? { status: previous.status, proof: previous.proof } : dependenciesChanged ? { status: 'needs_evidence', proof: undefined } : {}) };
    } else {
      const older = Object.values(result).find(item => item.status === 'stale' && item.resource.originId === next.resource.originId
        && item.resource.path === next.resource.path && item.claimKind === next.claimKind && digest(item.locator) === digest(next.locator));
      result[next.itemId] = { ...next, ...(older ? { supersedes: older.itemId } : {}) };
    }
    return result;
  }
  const previous = result[event.itemId];
  if (!previous || event.sourceEpoch !== undefined && event.sourceEpoch !== previous.sourceEpoch) return result;
  const item = extend(clone(previous)), artifacts = item.artifacts;
  item.revision++; item.updatedAt = event.at ?? item.updatedAt;
  item.lastAttempt = { type: event.type, receiptId: event.receiptId, at: event.at };
  if (event.type === 'candidate_written') {
    item.attempts.writer++; artifacts.candidateIds = unique([...artifacts.candidateIds, event.candidateId]);
    if (event.candidateId && !item.candidateRefs.some(value => value.candidateId === event.candidateId)) item.candidateRefs.push({ candidateId: event.candidateId, targetItemIds: unique(event.targetItemIds ?? [item.itemId]), validationIds: [] });
    if (!closed(item.status)) { item.status = 'candidate_saved'; item.proof = undefined; }
  } else if (event.type === 'validation_completed') {
    item.attempts.validate++;
    if (event.validationId) artifacts.validationIds = unique([...artifacts.validationIds, event.validationId]);
    const candidate = item.candidateRefs.find(value => value.candidateId === event.candidateId);
    if (candidate && event.validationId) candidate.validationIds = unique([...candidate.validationIds, event.validationId]);
    if (!closed(item.status) && event.passed === true && event.fresh !== false && artifacts.candidateIds.includes(event.candidateId) && event.receiptId) {
      item.status = 'validated'; item.proof = { candidateId: event.candidateId, validationId: event.validationId, receiptId: event.receiptId };
    } else if (!closed(item.status) && event.passed === false) {
      item.status = 'candidate_saved'; item.proof = undefined;
      item.blockers = clone(event.blockers ?? [{ code: 'validation-failed', validationId: event.validationId }]);
    }
  } else if (event.type === 'recipe_accepted' && event.receiptId && event.fresh !== false && event.passed !== false) {
    item.attempts.submit++; item.status = 'accepted';
    if (event.recipeId) artifacts.recipeIds = unique([...artifacts.recipeIds, event.recipeId]);
    if (event.acceptedBatchId) item.acceptedBatchRefs = unique([...item.acceptedBatchRefs, { acceptedBatchId: event.acceptedBatchId, recipeId: event.recipeId, extractionReceiptId: event.extractionReceiptId ?? event.receiptId }]);
    item.proof = { ...item.proof, receiptId: event.receiptId, recipeId: event.recipeId }; item.blockers = [];
  } else if (event.type === 'coverage_resolved' && event.receiptId && event.fresh !== false && event.passed !== false) {
    item.status = event.resolution === 'non-display' || event.resolution === 'non-linguistic' ? 'closed_non_display' : 'accepted';
    item.proof = { receiptId: event.receiptId, resolution: event.resolution }; item.blockers = [];
  } else if (event.type === 'work_item_transferred') {
    if (event.expectedRevision !== undefined && event.expectedRevision !== previous.revision) throw new Error('Work item transfer revision conflict');
    item.ownerJobId = event.ownerJobId; item.ownerScopeRevision = event.ownerScopeRevision;
    item.owner = { ownerId: event.ownerJobId, assignmentRevision: event.ownerScopeRevision ?? 0 };
  } else if (event.type === 'host_integrated' && event.integrationReceiptId && event.fresh !== false) {
    item.integrationReceiptRefs = unique([...item.integrationReceiptRefs, event.integrationReceiptId]);
  } else if (event.type === 'dependency_satisfied' && event.receiptId) {
    item.dependencies = item.dependencies.map(dependency => dependency.id === event.dependencyId ? { ...dependency, satisfiedBy: event.receiptId } : dependency);
    item.blockers = item.blockers.filter(blocker => blocker.id !== event.dependencyId);
    if (!closed(item.status) && !item.blockers.length) item.status = event.ready === true ? 'ready_for_attempt' : 'needs_evidence';
  } else if (event.type === 'owner_served' && Number.isSafeInteger(event.sequence)) {
    item.scheduling.lastServedSeq = Math.max(item.scheduling.lastServedSeq ?? -1, event.sequence);
  } else if (event.type === 'tool_failed') {
    item.blockers = unique([...item.blockers, event.failure]);
  }
  item.readiness = { status: item.blockers.length ? 'blocked' : item.status === 'ready_for_attempt' ? 'ready_for_attempt' : 'investigating', blockerIds: item.blockers.map(value => value.id ?? value.code).filter(Boolean) };
  result[event.itemId] = item;
  return result;
}

export function reconcileDependencies(items, currentResources = []) {
  const result = { ...items }, byKey = new Map(currentResources.map(ref => [JSON.stringify([ref.originId, resourcePath(ref.path)]), ref]));
  for (const previous of Object.values(items)) {
    const source = byKey.get(JSON.stringify([previous.resource.originId, previous.resource.path]));
    const missing = ref => ref?.missing === true || ref?.deleted === true || ref?.exists === false;
    const sourceChanged = source && (missing(source) || typeof source.baselineHash === 'string' && source.baselineHash !== previous.resource.baselineHash);
    let consumerMissing = false;
    const dependencyChanged = previous.dependencies.some(ref => {
      const current = byKey.get(JSON.stringify([ref.originId, ref.path]));
      if (missing(current)) { consumerMissing = true; return true; }
      return current && typeof current.baselineHash === 'string' && current.baselineHash !== ref.baselineHash;
    });
    const status = sourceChanged ? 'stale' : 'needs_evidence', code = sourceChanged ? missing(source) ? 'source-missing' : 'source-changed'
      : consumerMissing ? 'dependency-missing' : 'dependency-changed';
    if ((sourceChanged || dependencyChanged) && !(previous.status === status && !previous.proof && previous.blockers?.length === 1 && previous.blockers[0].code === code)) {
      result[previous.itemId] = { ...clone(previous), revision: previous.revision + 1, status, proof: undefined, blockers: [{ code }], readiness: { status: 'blocked', blockerIds: [code] } };
    }
  }
  return result;
}

export function projectWorkItems(items, { files, status, limit = 20, cursor } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid work item page size');
  const statuses = status === undefined ? null : new Set(Array.isArray(status) ? status : [status]);
  const rows = Object.values(items).filter(item => (!files || files.includes(item.resource.path))
    && (statuses ? statuses.has(item.status) : !closed(item.status))).sort((a, b) => a.itemId.localeCompare(b.itemId));
  const remaining = cursor ? rows.filter(item => item.itemId > cursor) : rows, page = remaining.slice(0, limit);
  const oldest = [...rows].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || a.itemId.localeCompare(b.itemId))[0];
  return { total: rows.length, items: clone(page), nextCursor: remaining.length > limit ? page.at(-1).itemId : null,
    readyItemIds: page.filter(item => item.status === 'ready_for_attempt').map(item => item.itemId), oldestUnacceptedId: oldest?.itemId ?? null };
}

/** Read navigation does not grant write scope; only a changed canonical write set requests transfer. */
export function normalizeScopeRequest(input, { assignment, items = {}, physicalWriteKey = file => file } = {}) {
  if (!assignment?.id || !Array.isArray(assignment.files)) throw new Error('A scope request needs the current host assignment');
  const requestedWriteFiles = unique((input.requestedWriteFiles ?? input.files ?? []).map(resourcePath)).sort();
  const readDependencyFiles = unique((input.readDependencyFiles ?? []).map(resourcePath)).sort();
  const affectedItemIds = unique(input.affectedItemIds ?? []).sort();
  if (affectedItemIds.some(id => !items[id] || !assignment.files.includes(items[id].resource.path))) throw new Error('Scope request contains an item outside the current assignment');
  const currentFiles = unique(assignment.files.map(resourcePath)), canonicalWriteSet = unique([...currentFiles, ...requestedWriteFiles]).sort();
  const domains = new Set(currentFiles.map(physicalWriteKey));
  const effectiveAssignmentChange = canonicalWriteSet.some(file => !currentFiles.includes(file) || !domains.has(physicalWriteKey(file)));
  const ownerId = assignment.ownerId ?? assignment.id, assignmentRevision = assignment.assignmentRevision ?? 0;
  const requestId = `scope-${digest([ownerId, assignmentRevision, canonicalWriteSet, readDependencyFiles, affectedItemIds]).slice(0, 40)}`;
  return { requestId, files: canonicalWriteSet, canonicalWriteSet, requestedWriteFiles, readDependencyFiles,
    affectedItemIds, evidenceIds: unique(input.evidenceIds ?? []), ownerId, originJobId: assignment.id, assignmentRevision,
    reason: String(input.reason ?? ''), effectiveAssignmentChange };
}
