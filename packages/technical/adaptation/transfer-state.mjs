import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { migrateControl, reduceControl } from './control-state.mjs';
import { migrateWorkItems, applyWorkItemEvent } from './work-items.mjs';
import { createEvidenceStore } from './evidence.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const union = (left = [], right = []) => [...new Map([...left, ...right].map(value => [JSON.stringify(value), value])).values()];
const error = (code, message) => Object.assign(new Error(message), { code });
async function readSource(statePath) {
  let failure;
  for (const file of [statePath, `${statePath}.previous`]) {
    try {
      const raw = await readFile(file, 'utf8'); let value;
      try { value = JSON.parse(raw); } catch { throw error('TRANSFER_STATE_CORRUPT', 'Invalid transfer checkpoint JSON'); }
      if (value?.format !== 'pinhao-adaptation-task-1' || !value.id) throw error('TRANSFER_STATE_VERSION', 'Unsupported transfer checkpoint');
      return { value, recoveredPrevious: file !== statePath };
    } catch (cause) {
      if (cause.code === 'TRANSFER_STATE_VERSION') throw cause;
      failure ??= cause;
    }
  }
  throw error(failure?.code === 'ENOENT' ? 'TRANSFER_STATE_MISSING' : 'TRANSFER_STATE_CORRUPT', 'No valid source checkpoint for transfer');
}
function ranges(left = [], right = []) {
  const result = [];
  for (const row of [...left, ...right].sort((a, b) => a[0] - b[0])) {
    if (result.length && row[0] <= result.at(-1)[1]) result.at(-1)[1] = Math.max(result.at(-1)[1], row[1]);
    else result.push([...row]);
  }
  return result;
}
async function replaySource(source, workspaceDir) {
  try { await stat(path.join(workspaceDir, 'evidence-receipts')); }
  catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
  await stat(path.join(workspaceDir, 'evidence-receipts', 'namespace.json'));
  const evidence = createEvidenceStore(workspaceDir), head = await evidence.readReceipts({ limit: 1 });
  source.appliedReceiptPositions ??= {}; source.pendingOperations ??= {};
  let afterSeq = source.appliedReceiptPositions[head.namespaceId] ?? 0;
  for (;;) {
    const page = await evidence.readReceipts({ afterSeq });
    for (const receipt of page.records) {
      for (const event of receipt.hostEventPayload?.events ?? []) {
        const fact = { ...event, receiptId: receipt.receiptId, at: receipt.occurredAt };
        source.control = reduceControl(source.control, fact); source.workItems = applyWorkItemEvent(source.workItems, fact);
      }
      if (receipt.phase === 'started') source.pendingOperations[receipt.operationId] = { status: 'pending-reconciliation', tool: receipt.tool,
        receiptId: receipt.receiptId, namespaceId: receipt.namespaceId };
      else delete source.pendingOperations[receipt.operationId];
      source.appliedReceiptPositions[receipt.namespaceId] = afterSeq = receipt.seq;
    }
    if (!page.nextSeq) break;
  }
}

/** Called only after the source owners are settled; this does not move a live conversation. */
export async function inheritAdaptationStates(state, { projectId, assignment, transfers = [] }) {
  if (!projectId || !assignment?.id || !Array.isArray(assignment.files)) throw error('TRANSFER_SCOPE', 'Transfer needs a target scope');
  const draft = clone(state), files = new Set(assignment.files), report = { transferred: 0, unchanged: 0, recoveredPrevious: [] };
  draft.control = migrateControl(draft.control, { legacy: !draft.control });
  draft.workItems = migrateWorkItems(draft.workItems); draft.inheritedTransfers ??= {};
  draft.appliedReceiptPositions ??= {}; draft.inheritedNamespaces ??= {};
  for (const transfer of transfers) {
    if (!transfer.transferId || !transfer.statePath || !transfer.workspaceDir || !Array.isArray(transfer.files)
        || !transfer.files.some(file => files.has(file))) throw error('TRANSFER_SCOPE', 'Source transfer does not match the target scope');
    const { value: source, recoveredPrevious } = await readSource(transfer.statePath);
    if (source.assignment?.id && source.assignment.id !== transfer.jobId) throw error('TRANSFER_OWNER', 'Source owner does not match the settled job');
    source.workItems = migrateWorkItems(source.workItems); source.control = migrateControl(source.control, { legacy: !source.control });
    await replaySource(source, transfer.workspaceDir);
    const items = source.workItems, control = source.control;
    if (Object.values(items).some(item => item.projectId !== projectId)) throw error('TRANSFER_PROJECT', 'Work items belong to another project');
    const fingerprint = hash([source.id, control, items, source.appliedReceiptPositions, source.acceptedBatches]);
    const prior = draft.inheritedTransfers[transfer.transferId];
    if (prior?.sourceId && prior.sourceId !== source.id) throw error('TRANSFER_ID_CONFLICT', 'Transfer identity was reused for another state');
    if (prior?.fingerprint === fingerprint) { report.unchanged++; continue; }
    if (recoveredPrevious) report.recoveredPrevious.push(transfer.transferId);
    const entire = transfer.files.every(file => files.has(file)), moved = Object.values(items).filter(item => files.has(item.resource.path));
    const receipts = new Set(moved.map(item => item.proof?.receiptId).filter(Boolean));
    for (const [namespaceId, seq] of Object.entries(source.appliedReceiptPositions ?? {})) {
      draft.appliedReceiptPositions[namespaceId] = Math.max(draft.appliedReceiptPositions[namespaceId] ?? 0, seq);
      draft.inheritedNamespaces[namespaceId] = clone(source.inheritedNamespaces?.[namespaceId] ?? { workspaceDir: transfer.workspaceDir, jobId: transfer.jobId });
    }
    for (const item of moved) {
      const previous = draft.workItems[item.itemId], incoming = previous?.revision > item.revision ? previous : item;
      draft.workItems[item.itemId] = { ...clone(incoming), ownerJobId: assignment.id,
        ownerScopeRevision: assignment.assignmentRevision ?? 0, owner: { ownerId: assignment.ownerId ?? assignment.id, assignmentRevision: assignment.assignmentRevision ?? 0 },
        artifactNamespaces: union(union(previous?.artifactNamespaces, incoming.artifactNamespaces), [{ workspaceDir: transfer.workspaceDir, jobId: transfer.jobId, referenceOnly: true,
          namespaceIds: Object.keys(source.appliedReceiptPositions ?? {}), artifacts: item.artifacts }]) };
      draft.candidateItems ??= {};
      for (const candidateId of incoming.artifacts?.candidateIds ?? []) draft.candidateItems[candidateId] = union(draft.candidateItems[candidateId], [item.itemId]);
    }
    for (const [key, value] of Object.entries(control.failuresByCause)) {
      if (value.resourceRef?.path && !files.has(value.resourceRef.path)) continue;
      const old = draft.control.failuresByCause[key];
      const latest = old && String(old.lastSeen ?? '') > String(value.lastSeen ?? '') ? old : value;
      draft.control.failuresByCause[key] = { ...clone(latest), occurrences: Math.max(old?.occurrences ?? 0, value.occurrences),
        attemptsBySignature: Object.fromEntries(union(Object.keys(old?.attemptsBySignature ?? {}), Object.keys(value.attemptsBySignature ?? {}))
          .map(signature => [signature, Math.max(old?.attemptsBySignature?.[signature] ?? 0, value.attemptsBySignature?.[signature] ?? 0)])) };
    }
    for (const ledger of ['acceptedByKey', 'resolutionsByKey']) for (const [key, receipt] of Object.entries(control[ledger])) {
      if (entire || receipts.has(receipt)) draft.control[ledger][key] ??= receipt;
    }
    for (const [key, milestone] of Object.entries(control.milestonesByItem)) {
      let id; try { [id] = JSON.parse(key); } catch { continue; }
      if (!entire && !moved.some(item => item.itemId === id)) continue;
      const old = draft.control.milestonesByItem[key];
      draft.control.milestonesByItem[key] = { candidate: Boolean(old?.candidate || milestone.candidate), gates: { ...milestone.gates, ...old?.gates } };
    }
    draft.control.materialFacts = { ...control.materialFacts, ...draft.control.materialFacts };
    for (const [key, value] of Object.entries(control.readRanges)) draft.control.readRanges[key] = ranges(draft.control.readRanges[key], value);
    for (const [key, value] of Object.entries(control.viewRanges)) draft.control.viewRanges[key] = ranges(draft.control.viewRanges[key], value);
    const steps = Math.max(draft.control.logicalSteps, control.logicalSteps), watch = draft.control.watch, incoming = control.watch;
    const oldAge = watch.recovery ? draft.control.logicalSteps - watch.recovery.startedAtStep : -1;
    const incomingAge = incoming.recovery ? control.logicalSteps - incoming.recovery.startedAtStep : -1;
    const recovery = incomingAge > oldAge ? incoming.recovery : watch.recovery, age = Math.max(oldAge, incomingAge);
    watch.stepsSinceMaterial = Math.max(watch.stepsSinceMaterial, incoming.stepsSinceMaterial);
    watch.stepsSinceAcceptedOrResolved = Math.max(watch.stepsSinceAcceptedOrResolved, incoming.stepsSinceAcceptedOrResolved);
    watch.materialAtStep = steps - watch.stepsSinceMaterial; watch.acceptedAtStep = steps - watch.stepsSinceAcceptedOrResolved;
    watch.lastNudgeByCause = { ...incoming.lastNudgeByCause, ...watch.lastNudgeByCause };
    watch.recovery = recovery ? { ...clone(recovery), startedAtStep: steps - age } : null;
    draft.control.logicalSteps = steps; draft.control.materialSerial = Math.max(draft.control.materialSerial, control.materialSerial);
    draft.control.revision = Math.max(draft.control.revision, control.revision);
    draft.control.activity = Math.max(draft.control.activity, control.activity);
    draft.control.acceptedSerial = Object.keys(draft.control.acceptedByKey).length + Object.keys(draft.control.resolutionsByKey).length;
    if (control.historyCoverage !== 'complete' || !entire) draft.control.historyCoverage = 'partial';
    if (entire) {
      draft.acceptedBatches = [...new Map([...(draft.acceptedBatches ?? []), ...(source.acceptedBatches ?? [])].map(batch => [batch.recipeId, clone(batch)])).values()];
      draft.pendingOperations = { ...clone(source.pendingOperations ?? {}), ...draft.pendingOperations };
      for (const pending of Object.values(draft.pendingOperations)) pending.status = 'pending-reconciliation';
    }
    draft.inheritedTransfers[transfer.transferId] = { sourceId: source.id, fingerprint };
    report.transferred++;
  }
  Object.assign(state, draft);
  return report;
}
