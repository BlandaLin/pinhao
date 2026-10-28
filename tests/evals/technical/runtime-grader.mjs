import { artifactRecord, canonical, digest, locationKey } from './events.mjs';

// This protocol observes an original fixture consumer, never a full game engine.
export function gradeFixtureRuntime(evidence, expectations) {
  if (!evidence) return { status: 'not-run', reason: 'No consumer execution evidence.' };
  if (evidence.kind !== 'fixture-consumer' || evidence.exitCode !== 0 || evidence.signal
    || typeof evidence.stdout !== 'string' || digest(evidence.stdout) !== evidence.stdoutSha256
    || !evidence.productManifestSha256 || evidence.productManifestSha256 !== expectations?.productManifestSha256) {
    return { status: 'failed', reason: 'Missing execution boundary, output integrity or exact product binding.' };
  }
  const lines = evidence.stdout.split(/\r?\n/), observations = [], completed = [];
  try {
    for (const line of lines) {
      if (line.startsWith('PINHAO_EVAL_DISPLAY=')) observations.push(JSON.parse(line.slice('PINHAO_EVAL_DISPLAY='.length)));
      if (line.startsWith('PINHAO_EVAL_RUNTIME_COMPLETE=')) completed.push(JSON.parse(line.slice('PINHAO_EVAL_RUNTIME_COMPLETE='.length)));
    }
  } catch { return { status: 'failed', reason: 'Malformed consumer output.' }; }
  const targets = expectations?.observations;
  if (!Array.isArray(targets) || !targets.length || completed.length !== 1 || completed[0].count !== observations.length
    || observations.length !== targets.length || new Set(observations.map(item => item.id)).size !== observations.length) {
    return { status: 'failed', reason: 'Empty, skipped, duplicate or incomplete consumer observations.' };
  }
  const actual = new Map(observations.map(item => [item.id, item]));
  const passed = targets.every(target => canonical(actual.get(target.id)) === canonical(target));
  return { status: passed ? 'passed' : 'failed', observed: observations.length,
    reason: passed ? 'Exact displayed values and control parameters matched.' : 'Consumer value or parameter mismatch.' };
}

const time = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const hashObject = value => digest(canonical(value));

/** Delivery state is checked against producer files and raw SQLite, never UI counters. */
export function gradeDeliveryPipeline(evidence, { qualifiedRecipeIds } = {}) {
  const database = evidence?.database, rows = database?.acceptanceReceipts;
  if (!Array.isArray(rows)) return { status: 'not-recorded', acceptedBatchCount: null, integratedBatchCount: null,
    textTechnicalOverlap: 'not-proven', reason: 'No raw acceptance table was collected.' };
  const artifacts = evidence.artifacts ?? {}, rawReceipts = new Map(), rawExtractions = new Map(), invalid = [];
  for (const artifact of artifacts.acceptedReceipts ?? []) {
    const record = artifactRecord(artifact);
    if (record?.id && record.id === hashObject(record.payload) && record.payloadHash === record.id) rawReceipts.set(record.id, record);
    else invalid.push('producer-receipt-integrity');
  }
  for (const artifact of artifacts.acceptedExtractions ?? []) {
    const record = artifactRecord(artifact);
    if (record) rawExtractions.set(hashObject(record), record);
    else invalid.push('producer-extraction-integrity');
  }
  const allowed = qualifiedRecipeIds ? new Set(qualifiedRecipeIds) : null, accepted = [], integrated = [], seen = new Set();
  const currentGeneration = database.publication?.generation;
  for (const row of rows) {
    if (seen.has(row.id)) { invalid.push('duplicate-ledger-receipt'); continue; } seen.add(row.id);
    const record = rawReceipts.get(row.id), extraction = rawExtractions.get(row.payload?.extractionHash);
    if (!record || !extraction || canonical(record.payload) !== canonical(row.payload) || record.payloadHash !== row.payloadHash
      || record.payload.projectId !== database.projectId || !record.payload.adaptationRequestId
      || extraction.binding?.recipeId !== record.payload.recipeId || allowed && !allowed.has(record.payload.recipeId)) {
      invalid.push('unmatched-or-unqualified-acceptance'); continue;
    }
    accepted.push(row);
    if (row.status !== 'integrated') continue;
    const result = row.result, generation = result?.generation;
    if (!Number.isSafeInteger(generation) || generation < 0 || !Number.isSafeInteger(currentGeneration) || generation > currentGeneration
      || !Number.isSafeInteger(result.addedUnits) || result.addedUnits < 0 || !Array.isArray(extraction.units)) {
      invalid.push('invalid-integration-generation'); continue;
    }
    const present = extraction.units.filter(unit => (database.units ?? []).some(saved =>
      (saved.legacyId ?? saved.id) === (unit.legacyId ?? unit.id) && saved.source === unit.source && locationKey(saved) === locationKey(unit)));
    if (result.addedUnits > present.length) { invalid.push('integrated-units-not-in-database'); continue; }
    integrated.push(row);
  }
  const text = (database.tasks ?? []).filter(task => ['translation', 'proofreading'].includes(task.role));
  const textRequests = text.flatMap(task => (task.requestHistory ?? []).filter(request => request.status === 'received'
    && time(request.startedAt) !== null && time(request.finishedAt) !== null && time(request.finishedAt) >= time(request.startedAt))
    .map(request => ({ ...request, taskId: task.id, role: task.role, productionInput: task.productionInput })));
  const technical = Object.values(evidence.productAccounting ?? {}).flatMap(ledger => Object.values(ledger.attempts ?? {}))
    .filter(attempt => attempt.fetchStarted === true && time(attempt.sendIntentAt) !== null && time(attempt.settledAt) !== null)
    .map(attempt => ({ id: attempt.httpAttemptId, start: time(attempt.sendIntentAt), end: time(attempt.settledAt) }));
  const overlaps = [];
  for (const request of textRequests) {
    const input = request.productionInput;
    const publishedBeforeStart = input && Number.isSafeInteger(input.generation) && input.generation <= currentGeneration
      && (input.generation === (evidence.initial?.publication?.generation ?? 0)
        || integrated.some(row => row.result.generation === input.generation && time(row.integratedAt) !== null && time(row.integratedAt) <= time(request.startedAt)));
    if (!publishedBeforeStart) continue;
    const snapshot = (evidence.publicationEvidence ?? []).find(row => row.generation === input?.generation
      && row.workbenchDir === input?.workbenchDir && canonical(row.compositeManifestRef) === canonical(input?.compositeManifestRef ?? null)
      && row.valid === true && artifactRecord(row.artifact) && row.actualSha256 === row.expectedSha256
      && row.actualSha256 === row.artifact.sha256);
    if (!snapshot) continue;
    for (const attempt of technical) {
      const start = Math.max(time(request.startedAt), attempt.start), end = Math.min(time(request.finishedAt), attempt.end);
      if (end > start) overlaps.push({ taskId: request.taskId, requestId: request.id, technicalHttpAttemptId: attempt.id,
        generation: input.generation, startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(), overlapMs: end - start });
    }
  }
  const earliest = values => values.filter(value => time(value) !== null).sort((a, b) => time(a) - time(b))[0] ?? null;
  const acceptedAt = earliest(accepted.map(row => row.acceptedAt)), integratedAt = earliest(integrated.map(row => row.integratedAt));
  const integrationLags = integrated.filter(row => time(row.acceptedAt) !== null && time(row.integratedAt) !== null)
    .map(row => ({ acceptedBatchId: row.id, elapsedMs: time(row.integratedAt) - time(row.acceptedAt) }));
  if (integrationLags.some(row => row.elapsedMs < 0)) invalid.push('integration-before-acceptance');
  return { status: invalid.length ? 'evidence-incomplete' : 'checked', acceptedBatchCount: accepted.length, integratedBatchCount: integrated.length,
    pendingIntegrationCount: accepted.length - integrated.length, rawLedgerCount: rows.length, invalidReasons: [...new Set(invalid)],
    currentGeneration: Number.isSafeInteger(currentGeneration) ? currentGeneration : null,
    integratedGenerations: [...new Set(integrated.map(row => row.result.generation))].sort((a, b) => a - b),
    firstAcceptedAt: acceptedAt, firstIntegratedAt: integratedAt, integrationLags,
    timingScope: 'SQLite enqueue-to-commit timestamps; producer receipts without event timestamps do not prove submit-to-enqueue latency.',
    textRequestCount: textRequests.length, textTechnicalOverlap: overlaps.length ? 'host-request-window-overlap' : 'not-proven', overlaps,
    scope: 'Receipt delivery and frozen-input task/known-sent technical send-intent-to-settlement windows; not exact fetch overlap, simultaneous text HTTP proof or full-game completion.',
    pollLaneHints: (evidence.states ?? []).filter(row => row.project?.lanes?.adaptation?.status === 'running' && row.project?.lanes?.text?.status === 'running').length,
    pollLaneHintScope: 'UI/service projections only; never used to prove overlap.' };
}
