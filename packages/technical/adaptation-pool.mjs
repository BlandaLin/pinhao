import { createHash } from 'node:crypto';
import path from 'node:path';
import { accumulateVerifiedExtractions } from './adaptation/verified-batches.mjs';
import { summarizeReviewDiagnostics } from './review-diagnostics.mjs';
import { adaptationLocationKey } from '../core/adaptation-results.mjs';
import { distillLessons, mergeLessons, lessonsForSource } from './lessons.mjs';
import { resourceRouteSummary } from './resource-routing.mjs';

const normalize = value => typeof value === 'string' ? value.replace(/^res:\/\//, '').replaceAll('\\', '/').replace(/^\.\//, '') : '';
const fileOf = item => normalize(item.file ?? item.carrier ?? item.locator?.file ?? item.context?.file);
const validFile = file => file && !path.isAbsolute(file) && !file.split('/').some(part => !part || part === '..' || part.includes(':'));
const idFor = files => `resource-${createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 20)}`;
// Indirect display sites share the resource queue, but can finish through a reviewed source reference.
const adapterRequiredFiles = coverage => new Set((coverage?.classifiedCandidates ?? [])
  .filter(item => item?.classification === 'adapter_required').map(fileOf).filter(validFile));

/** Independent resources share the existing technical queue's execution slots. */
// Prefiltered class families stay in coverage as auditable records instead of review work; the count
// separates them from genuinely unreviewed groups so a skipped family can never look like a decision.
const prefilteredOf = coverage => [...(coverage?.informationalItems ?? []), ...(coverage?.nonTextReviewItems ?? [])]
  .filter(item => typeof item?.prefiltered === 'string');

export function prefilteredSummary(coverage) {
  const items = prefilteredOf(coverage);
  const reasons = {};
  for (const item of items) reasons[item.prefiltered] = (reasons[item.prefiltered] ?? 0) + 1;
  return { prefilteredGroups: items.length,
    prefilteredObjects: items.reduce((total, item) => total + (Number.isSafeInteger(item.count) ? item.count : 1), 0),
    prefiltered: reasons };
}

export function planAdaptationJobs(coverage, { partition = false, scopeRequests = [] } = {}) {
  const unknown = (coverage?.unknownClusters ?? []).filter(item => item.status === 'unknown' && item.proseLike);
  if (!partition || coverage?.structuralRecoveryWarnings
      || coverage?.extractionIssues?.some(item => !validFile(fileOf(item)))
      || unknown.some(item => !validFile(fileOf(item)))
      || coverage?.nativeReviewIssues?.some(item => !validFile(fileOf(item)))) return [{ id: 'coordinator', files: null }];
  const files = new Set();
  for (const item of coverage?.resources ?? []) if (item.kind === 'display-text-candidate' && validFile(fileOf(item))) files.add(fileOf(item));
  for (const item of coverage?.dynamicCandidates ?? []) if (validFile(fileOf(item))) files.add(fileOf(item));
  for (const file of adapterRequiredFiles(coverage)) files.add(file);
  for (const item of unknown) files.add(fileOf(item));
  for (const item of coverage?.nativeReviewIssues ?? []) files.add(fileOf(item));
  for (const item of coverage?.extractionIssues ?? []) files.add(fileOf(item));
  if (!files.size) return [{ id: 'coordinator', files: null }];
  const groups = [...files].sort().map(file => new Set([file]));
  for (const request of scopeRequests) {
    if (!Array.isArray(request.files) || !request.files.length || request.files.some(file => !validFile(file))) continue;
    const merged = new Set(request.files);
    for (let index = groups.length - 1; index >= 0; index--) if ([...groups[index]].some(file => merged.has(file))) {
      for (const file of groups[index]) merged.add(file);
      groups.splice(index, 1);
    }
    groups.push(merged);
  }
  return groups.map(group => [...group].sort()).map(files => ({ id: idFor(files), files, summary: `补充资源显示文字：${files.join('、')}` }));
}

export function scopeAdaptationCoverage(coverage, files) {
  if (!files) return coverage ? { ...coverage, summary: { ...coverage.summary, ...prefilteredSummary(coverage) } } : coverage;
  const owned = new Set(files);
  const resources = (coverage?.resources ?? []).filter(item => owned.has(fileOf(item)));
  const dynamicCandidates = (coverage?.dynamicCandidates ?? []).filter(item => owned.has(fileOf(item)));
  const extractionIssues = (coverage?.extractionIssues ?? []).filter(item => owned.has(fileOf(item)));
  const unknownClusters = (coverage?.unknownClusters ?? []).filter(item => owned.has(fileOf(item)));
  const nativeReviewIssues = (coverage?.nativeReviewIssues ?? []).filter(item => owned.has(fileOf(item)));
  const classifiedCandidates = (coverage?.classifiedCandidates ?? []).filter(item => owned.has(fileOf(item)));
  const presentationItems = (coverage?.presentationItems ?? []).filter(item => owned.has(fileOf(item)));
  const nonTextReviewItems = (coverage?.nonTextReviewItems ?? []).filter(item => owned.has(fileOf(item)));
  const informationalItems = (coverage?.informationalItems ?? []).filter(item => owned.has(fileOf(item)));
  const unreviewedClusters = unknownClusters.filter(item => item.status === 'unknown' && item.proseLike).length;
  const adapterCandidates = classifiedCandidates.filter(item => item.classification === 'adapter_required').length;
  const expressions = classifiedCandidates.filter(item => item.kind === 'script_display_expression_candidate' && item.id);
  const unresolvedExpressions = expressions.filter(item => item.status !== 'resolved').length;
  const triggers = [...(resources.some(item => item.kind === 'display-text-candidate') || dynamicCandidates.length ? ['suspected-omission'] : []), ...(extractionIssues.length ? ['partial-extraction'] : [])];
  if (unreviewedClusters) triggers.push('unknown-text-clusters');
  if (nativeReviewIssues.length) triggers.push('native-schema-review');
  if (unresolvedExpressions) triggers.push('unresolved-display-expressions');
  return { ...coverage, resources, dynamicCandidates, classifiedCandidates, extractionIssues, unknownClusters, nativeReviewIssues, presentationItems, nonTextReviewItems, informationalItems,
    displaySites: (coverage?.displaySites ?? []).filter(item => owned.has(fileOf(item))),
    reviewItems: (coverage?.reviewItems ?? []).filter(item => owned.has(fileOf(item))),
    summary: { ...coverage?.summary, resourceRoutes: resourceRouteSummary(resources), 'display-text-candidate': resources.filter(item => item.kind === 'display-text-candidate').length, unresolvedCandidates: dynamicCandidates.length, adapterCandidates, unreviewedClusters, unresolvedExpressions, resolvedExpressions: expressions.length - unresolvedExpressions,
      ...summarizeReviewDiagnostics({ nativeReviewIssues, presentationItems, nonTextReviewItems, informationalItems }),
      ...prefilteredSummary({ informationalItems, nonTextReviewItems }) },
    needsAdaptation: triggers.length > 0, triggers };
}

export function mergeAdaptationUnits(extractions) {
  const units = [], ids = new Set(), locations = new Set();
  for (const extraction of extractions) for (const unit of extraction.units ?? []) {
    const id = unit.legacyId ?? unit.id;
    const locator = unit.locator ?? unit.context?.adaptationLocator;
    const location = adaptationLocationKey(locator, fileOf(unit));
    if (!location) throw new Error('技术子任务需要稳定回写定位');
    if (ids.has(id) || locations.has(location)) throw new Error('技术子任务返回了重复文字或回写定位');
    ids.add(id); locations.add(location); units.push(unit);
  }
  return units;
}

export async function runAdaptationPool({ run, jobs, concurrency = 1, acquireSlot = async () => () => {}, onProgress = () => {}, onResult = async () => ({}), onAcceptedBatch, shouldYield = () => false, onLessons = async () => {}, verifyCoverage, hostFailure = () => false, ...args }) {
  if (typeof run !== 'function' || !Array.isArray(jobs) || !jobs.length) throw new Error('技术任务需要执行器和资源分工');
  const width = Math.min(jobs.length, Math.max(1, Math.floor(concurrency)));
  const admissionController = new AbortController();
  const admissionSignal = AbortSignal.any([admissionController.signal, args.signal].filter(Boolean));
  // Facts learned by finished jobs carry into the ones that start later. Without this each job
  // re-guessed the same rejected tool argument: 42 jobs, 41 identical failures, one lesson.
  const evidenceFingerprint = args.project?.sourceFingerprint ?? args.coverage?.sourceContextHash;
  let sharedLessons = lessonsForSource(args.lessons, evidenceFingerprint), lessonWrites = Promise.resolve();
  const publishedJobs = new Set();
  const shareLessons = (incoming, jobId) => {
    if (!incoming?.length) return lessonWrites;
    publishedJobs.add(jobId);
    for (const lesson of incoming) sharedLessons = mergeLessons(sharedLessons, lesson).lessons;
    const snapshot = structuredClone(sharedLessons);
    lessonWrites = lessonWrites.then(() => onLessons(snapshot));
    return lessonWrites;
  };
  const results = new Map(), checked = new Map(), states = new Map(jobs.map(job => [job.id, { id: job.id, files: job.files, resource: job.files?.join('、'), status: 'queued' }]));
  let cursor = 0, hostError;
  const failHost = error => { hostError ??= error; admissionController.abort(hostError); };
  const snapshot = (status = 'running') => ({ status, processedJobs: results.size, completedJobs: results.size, totalJobs: jobs.length,
    verifiedJobs: [...results.values()].filter(item => item.status === 'verified').length,
    resolvedJobs: [...results.values()].filter(item => item.status === 'resolved').length,
    pendingJobs: jobs.length - [...results.values()].filter(item => ['verified', 'resolved'].includes(item.status)).length,
    workers: [...states.values()].filter(item => item.status === 'running').length,
    addedUnits: [...results.values()].reduce((total, item) => total + (item.addedUnits ?? 0), 0), jobs: [...states.values()] });
  const report = (job, progress) => {
    states.set(job.id, { ...states.get(job.id), ...progress });
    return onProgress({ ...progress, ...snapshot(), resource: job.files?.join('、') });
  };
  const adapterFiles = adapterRequiredFiles(args.coverage);
  const runnable = [], reused = [];
  for (const job of jobs) {
    const jobCoverage = scopeAdaptationCoverage(args.coverage, job.files);
    // Classify existing coverage before any progress event, not when the queue cursor reaches it.
    // Unresolved expressions, adapter attempts and coordinated repairs still require an executor.
    if (job.files && job.kind !== 'build-repair' && !jobCoverage?.needsAdaptation && !jobCoverage?.summary?.adapterCandidates && !job.files.some(file => adapterFiles.has(file))) {
      const result = { status: 'resolved', reused: true, reason: '当前资源已具有完整提取定位' };
      results.set(job.id, result);
      states.set(job.id, { ...states.get(job.id), status: 'resolved', phase: 'finished', reason: result.reason, reused: true });
      reused.push(job);
    } else runnable.push({ job, jobCoverage });
  }
  if (reused.length) await onProgress(snapshot());
  const workers = Array.from({ length: Math.min(width, runnable.length) }, async (_, worker) => {
    try {
    while (cursor < runnable.length && !hostError && !(results.size > reused.length && shouldYield())) {
      args.signal?.throwIfAborted();
      let release;
      try { release = await acquireSlot({ worker, signal: admissionSignal }); }
      catch (error) {
        if (args.signal?.aborted) throw args.signal.reason;
        if (hostError || cursor >= runnable.length && !args.signal?.aborted) return;
        failHost(error);
        throw error;
      }
      if (typeof release !== 'function') {
        const error = new Error('技术资源任务名额必须返回释放函数'); failHost(error); throw error;
      }
      try {
      args.signal?.throwIfAborted();
      if (hostError || cursor >= runnable.length || results.size > reused.length && shouldYield()) return;
      const { job, jobCoverage } = runnable[cursor++];
      // Only queued admissions stop here; already-running independent jobs keep their original signal.
      if (cursor >= runnable.length) admissionController.abort(new Error('本轮资源任务已全部派发'));
      await report(job, { status: 'running', phase: 'starting' });
      let result;
      try {
        result = await run({ ...args, getLessons: () => sharedLessons,
          ...(onAcceptedBatch ? { onAcceptedBatch: record => onAcceptedBatch(job, record) } : {}),
          inheritStates: args.inheritStatesByJob?.[job.id] ?? [],
          ...(args.requestContext ? { requestContext: { ...args.requestContext, jobId: job.id } } : {}),
          onLessons: lessons => shareLessons(lessons, job.id), assignment: job.files ? job : undefined,
          coverage: jobCoverage,
          workspaceDir: job.files ? path.join(args.workspaceDir, 'jobs', job.id) : args.workspaceDir,
          statePath: job.files ? path.join(args.statePath ? path.dirname(args.statePath) : args.workspaceDir, 'jobs', job.id, 'progress.jsonl') : args.statePath,
          onProgress: progress => report(job, progress),
          verifyCoverage: verifyCoverage ? async extraction => {
            const current = accumulateVerifiedExtractions(checked.get(job.id) ?? [], [extraction]);
            if (!extraction.preview) checked.set(job.id, current);
            const all = [...checked.entries()].flatMap(([id, items]) => id === job.id ? [] : items);
            const units = mergeAdaptationUnits([...all, ...current]);
            return scopeAdaptationCoverage(await verifyCoverage({ units, coverageDecisions: extraction.coverageDecisions, scopeFiles: job.files, jobId: job.id, preview: extraction.preview,
              ...(extraction.nativeReviews === undefined ? {} : { nativeReviews: extraction.nativeReviews }) }), job.files);
          } : undefined,
        });
      } catch (error) {
        if (args.signal?.aborted || error.name === 'AbortError') throw error;
        if (hostFailure(error)) throw error;
        result = { status: 'needs-review', reason: error.message, error: { code: error.code, message: error.message } };
      }
      if (result.status === 'failed' && result.error && hostFailure(result.error)) {
        failHost(result.error instanceof Error ? result.error : Object.assign(new Error(result.error.message), result.error));
      }
      const saved = await onResult(job, result);
      Object.assign(result, saved);
      results.set(job.id, result);
      if (!publishedJobs.has(job.id)) {
        const facts = result.state?.lessons?.length ? lessonsForSource(result.state.lessons, evidenceFingerprint) : distillLessons({
          jobId: job.id, outcome: result.status, error: result.error,
          toolCalls: result.state?.rejectedCalls, resource: result.resource, classes: result.classes,
        });
        await shareLessons(facts, job.id);
      }
      if (result.status === 'verified' && !result.nativeExtraction) checked.set(job.id, result.extractions ?? (result.extraction ? [result.extraction] : []));
      await report(job, { status: result.status, phase: 'finished', reason: result.reason ?? result.error?.message,
        stopReason: result.stopReason, retryable: result.retryable, continuationNeeded: result.continuationNeeded,
        stopReasonCode: result.stopReasonCode ?? result.error?.code ?? result.stopReason,
        blockedNeeds: result.blockedNeeds ?? [], candidateId: result.candidateId, validationId: result.validationId,
        unitCount: result.unitCount ?? result.extraction?.units?.length ?? 0, reused: result.reused });
      } finally {
        try { await release(); } catch (error) { failHost(error); throw error; }
      }
    }
    } catch (error) {
      if (hostFailure(error)) failHost(error);
      throw error;
    }
  });
  const reuseWrites = (async () => {
    try {
    for (const job of reused) {
      if (hostError) break;
      args.signal?.throwIfAborted();
      const result = results.get(job.id);
      Object.assign(result, await onResult(job, result));
      await report(job, { status: 'resolved', phase: 'finished', reason: result.reason, reused: true });
    }
    } catch (error) {
      if (hostFailure(error)) failHost(error);
      throw error;
    }
  })();
  const settled = await Promise.allSettled([...workers, reuseWrites]);
  try { await lessonWrites; } catch (error) { if (!hostError) throw error; }
  const failure = hostError ?? settled.find(item => item.status === 'rejected')?.reason;
  if (failure) { await onProgress(snapshot(hostError ? 'needs-review' : 'cancelled')); throw failure; }
  const yielded = cursor < runnable.length;
  const ordered = jobs.map(job => results.get(job.id) ?? { status: 'queued', reason: '已在安全边界交还名额，尚未领取的任务保留',
    continuation: { action: 'continue', reasonCode: 'OWNER_FAIR_YIELD' }, retryable: true });
  const extractions = ordered.filter(item => item?.status === 'verified').flatMap(item => item.extractions ?? (item.extraction ? [item.extraction] : []));
  const partialExtractions = ordered.filter(item => item?.status !== 'verified').flatMap(item => item?.partialExtractions ?? []);
  const units = mergeAdaptationUnits(extractions);
  const coverageDecisions = [...new Map(ordered.flatMap(item => item?.coverageDecisions ?? item?.state?.coverageDecisions ?? []).map(item => [item.id, item])).values()];
  const merged = verifyCoverage ? await verifyCoverage({ units, coverageDecisions }) : args.coverage;
  // The host summary counts review work only; prefiltered families are reported alongside it so the
  // final record shows what the deterministic prefilter settled without asking the model.
  const coverage = merged ? { ...merged, summary: { ...merged.summary, ...prefilteredSummary(merged) } } : merged;
  const native = ordered.find(item => item?.nativeExtraction);
  const complete = Boolean(native) || (ordered.every(item => ['verified', 'resolved'].includes(item?.status)) && !coverage?.needsAdaptation);
  const first = ordered[0];
  const pending = ordered.filter(item => !['verified', 'resolved'].includes(item?.status));
  const reason = complete ? undefined : pending.find(item => item?.reason)?.reason ?? pending.find(item => item?.error?.message)?.error.message ?? '继续处理剩余资源';
  const stopReason = complete ? 'verified' : pending.find(item => item?.retryable === false)?.stopReason ?? pending.find(item => item?.stopReason)?.stopReason ?? 'pending-resources';
  const blockedNeeds = jobs.flatMap((job, index) => (ordered[index]?.blockedNeeds ?? []).map(need => ({ ...need, jobId: job.id,
    candidateId: need.candidateId ?? ordered[index].candidateId, validationId: need.validationId ?? ordered[index].validationId })));
  const stopReasonCode = complete ? 'verified' : pending.find(item => item?.stopReasonCode)?.stopReasonCode ?? stopReason;
  const outcome = { ...first, yielded, ...(native ? { nativeExtraction: native.nativeExtraction, nativeProbe: native.nativeProbe, kind: 'native' } : {}), ...snapshot(complete ? 'verified' : 'needs-review'), extractions, partialExtractions, units, coverage, lessons: sharedLessons,
    continuation: complete ? { action: 'complete', reasonCode: 'ALL_RESOURCES_RESOLVED' }
      : yielded ? { action: 'continue', reasonCode: 'OWNER_FAIR_YIELD' }
      : pending.find(item => ['continue', 'replan', 'wait'].includes(item?.continuation?.action))?.continuation
        ?? pending.find(item => item?.continuation)?.continuation ?? { action: 'pause', reasonCode: 'NO_HOST_CONTINUATION_DECISION' },
    scopeRequests: ordered.map(item => item?.state?.scopeRequest).filter(Boolean),
    coverageDecisions,
    extraction: extractions.length === 1 ? extractions[0] : undefined,
    reused: ordered.every(item => item?.reused),
    reason, stopReason, stopReasonCode, blockedNeeds, retryable: !complete && (!pending.length || pending.some(item => item?.retryable !== false)),
    continuationNeeded: !complete && (!pending.length || pending.some(item => item?.continuationNeeded)),
    progressMade: ordered.some(item => item?.progressMade),
    progressFingerprint: createHash('sha256').update(JSON.stringify(jobs.map((job, index) => [job.id, ordered[index]?.progressFingerprint ?? null]))).digest('hex'),
  };
  await onProgress({ ...snapshot(outcome.status), reason, stopReason, retryable: outcome.retryable, continuationNeeded: outcome.continuationNeeded,
    stopReasonCode, blockedNeeds,
    remainingCandidates: coverage?.summary?.unresolvedCandidates ?? coverage?.dynamicCandidates?.length ?? 0 });
  return outcome;
}
