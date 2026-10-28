import { randomUUID } from 'node:crypto';
import { sha256 } from '../exchange/index.mjs';
import { buildStoryContext } from '../exchange/story.mjs';
import { relevantGlossary, glossaryHash, scanTerminology, terminologyUpdates, glossaryConflicts } from './glossary.mjs';
import { promptContext, glossaryPromptProjection, glossaryPromptRows, REQUEST_BATCH_LIMITS } from './provider.mjs';

export const REVIEW_ROUND_VERSION = 'pinhao-review-round-1';
const identity = unit => [unit.id, unit.revision, unit.sourceHash, unit.source, unit.translation, unit.notes ?? '', unit.locked, unit.manualLock,
  unit.kind, promptContext(unit.context), unit.tokens, unit.controls ?? unit.context?.controlBindings];
const identityVersions = new WeakMap();
const identityVersion = unit => { let version = identityVersions.get(unit); if (!version) { version = sha256(identity(unit)); identityVersions.set(unit, version); } return version; };
const changed = (record, unit) => record.translation !== unit.translation || (record.notes ?? '') !== (unit.notes ?? '');
const terminal = task => ['succeeded', 'skipped'].includes(task.status);
const scopeTransport = () => ({ maxUnits: REQUEST_BATCH_LIMITS.maxUnits, pinned: { scene: [], consistency: [] } });

export function createReviewRound({ projectId, units, targetIds, story, glossary, id = randomUUID() }) {
  const targets = new Set(targetIds);
  return { format: REVIEW_ROUND_VERSION, id, projectId, revision: 0, createdAt: new Date().toISOString(),
    targetIds: units.filter(unit => targets.has(unit.id)).map(unit => unit.id),
    units: structuredClone(units), story: structuredClone(story), glossary: structuredClone(glossary), stage: 'scene', scopeTransport: scopeTransport() };
}

/** Keep paid or partially completed scopes intact when enabling batching on an unfinished round. */
export function prepareReviewTransport(round, tasks = []) {
  if (round.scopeTransport) return round;
  const transport = scopeTransport();
  for (const stage of ['scene', 'consistency']) transport.pinned[stage] = [...new Set(currentReviewTasks(round, tasks, stage)
    .filter(task => terminal(task) || task.candidateRecords?.length || task.reviewCandidate?.records?.length
      || task.evidenceReplies?.length || task.storyReadingReceipts?.length || task.readingNotes
      || task.requestHistory?.some(request => request.transportRequests > 0 || request.artifact?.sentAt))
    .map(task => task.reviewScopeId))];
  return { ...round, revision: (round.revision ?? 0) + 1, scopeTransport: transport };
}

/** Manual changes replace only their frozen records; scope hashes invalidate the dependent tasks. */
export function refreshReviewRound(round, currentUnits, story = round.story, glossary = round.glossary) {
  const current = new Map(currentUnits.map(unit => [unit.id, unit]));
  const changedIds = round.units.filter(unit => current.has(unit.id) && identityVersion(unit) !== identityVersion(current.get(unit.id))).map(unit => unit.id);
  const ids = new Set(changedIds);
  const units = round.units.map(unit => ids.has(unit.id) ? structuredClone(current.get(unit.id)) : unit);
  let glossaryChanged = false;
  if (glossary !== round.glossary && (!glossary?.hash || glossary.hash !== round.glossary?.hash)) {
    const stamp = entry => sha256({ wire: glossaryPromptRows([entry])[0], id: entry.id,
      revision: entry.revision, evidenceHash: entry.evidenceHash, unitIds: entry.unitIds });
    const previous = new Map((round.glossary?.entries ?? []).map(entry => [entry.id, entry]));
    const entries = (glossary?.entries ?? []).map(entry => {
      const frozen = previous.get(entry.id);
      return frozen && stamp(frozen) === stamp(entry) ? frozen : entry;
    });
    glossary = { ...glossary, entries, hash: glossaryHash(entries) };
    const usedIds = new Set([...reviewScopes(round, 'scene'), ...reviewScopes(round, 'consistency')].flatMap(scope => [...scope.unitIds, ...scope.readIds]));
    const material = units.filter(unit => usedIds.has(unit.id));
    const projection = value => {
      const relevant = relevantGlossary(value, material);
      return { wireBasis: glossaryPromptProjection(relevant), decisions: relevant.map(({ id, revision, evidenceHash }) => ({ id, revision, evidenceHash })),
        associations: (value?.entries ?? []).filter(entry => entry.unitIds?.some(id => usedIds.has(id))).map(({ id, unitIds }) => ({ id, unitIds })) };
    };
    glossaryChanged = sha256(projection(round.glossary)) !== sha256(projection(glossary));
  }
  if (!changedIds.length && !glossaryChanged) return { round, changedIds, glossaryChanged };
  const nextStory = story === round.story ? buildStoryContext(units, { sourceRevision: round.story?.sourceRevision, previous: round.story }) : story;
  return { changedIds, glossaryChanged, round: { ...round, revision: round.revision + 1, stage: 'scene',
    units, story: structuredClone(nextStory), glossary: structuredClone(glossary) } };
}

function sceneScopes(round) {
  const targets = new Set(round.targetIds), assigned = new Set(), scopes = [];
  for (const scene of round.story?.scenes ?? []) {
    const reads = scene.scope?.unitIds ?? scene.unitIds ?? (scene.blockIds ?? []).flatMap(id => round.story.blocks.find(block => block.id === id)?.unitIds ?? []);
    const ids = (scene.scope?.targetUnitIds ?? reads).filter(id => targets.has(id) && !assigned.has(id));
    if (!ids.length) continue;
    ids.forEach(id => assigned.add(id));
    scopes.push({ id: scene.id, kind: 'scene', title: scene.title, unitIds: ids, readIds: [...reads] });
  }
  const remaining = new Map();
  for (const unit of round.units) if (targets.has(unit.id) && !assigned.has(unit.id)) {
    const c = unit.context ?? {}, key = JSON.stringify([c.file ?? c.map ?? '', c.event ?? '', c.page ?? '', c.scene ?? '']);
    const entry = remaining.get(key) ?? { id: `position-${sha256(key).slice(0, 20)}`, kind: 'position-block', unitIds: [], readIds: [] };
    entry.unitIds.push(unit.id); entry.readIds.push(unit.id); remaining.set(key, entry);
  }
  scopes.push(...remaining.values());
  const sync = new Map();
  for (const unit of round.units) if (unit.context?.syncGroup && targets.has(unit.id)) {
    const ids = sync.get(unit.context.syncGroup) ?? []; ids.push(unit.id); sync.set(unit.context.syncGroup, ids);
  }
  const ownerById = new Map(scopes.flatMap(scope => scope.unitIds.map(id => [id, scope]))), activeScopes = new Set(scopes);
  for (const ids of sync.values()) {
    const owners = [...new Set(ids.map(id => ownerById.get(id)).filter(Boolean))];
    if (owners.length < 2) continue;
    const merged = owners[0];
    merged.unitIds = [...new Set(owners.flatMap(scope => scope.unitIds))];
    merged.readIds = [...new Set(owners.flatMap(scope => scope.readIds))];
    for (const id of merged.unitIds) ownerById.set(id, merged);
    for (const owner of owners.slice(1)) activeScopes.delete(owner);
  }
  return [...activeScopes];
}

function transportScopes(round, scopes, stage) {
  if (!round.scopeTransport) return scopes;
  const { maxUnits, pinned } = round.scopeTransport, retained = new Set(pinned[stage]);
  const batches = [], members = [];
  let size = 0;
  const flush = () => {
    if (members.length === 1) batches.push(members[0]);
    else if (members.length) batches.push({ id: `${stage === 'scene' ? 'review' : 'targeted'}-batch-${sha256(members.map(scope => scope.id)).slice(0, 20)}`,
      kind: stage === 'scene' ? 'scene-batch' : 'scene-consistency', title: `${members.length} 个独立片段（分别校对）`,
      ...(stage === 'consistency' ? { reason: members.map(scope => scope.reason).filter(Boolean).join('；') } : {}),
      unitIds: [...new Set(members.flatMap(scope => scope.unitIds))], readIds: [...new Set(members.flatMap(scope => scope.readIds))] });
    members.length = 0; size = 0;
  };
  for (const scope of scopes) {
    if (retained.has(scope.id) || scope.unitIds.length > maxUnits) { flush(); batches.push(scope); continue; }
    if (size + scope.unitIds.length > maxUnits) flush();
    members.push(scope); size += scope.unitIds.length;
  }
  flush();
  return batches;
}

export function reviewScopes(round, stage = round.stage, tasks = []) {
  if (stage === 'scene') return transportScopes(round, sceneScopes(round), stage);
  const targets = new Set(round.targetIds), view = reviewView(round, tasks, 'consistency');
  const byId = new Map(view.units.map(unit => [unit.id, unit])), scopes = [], syncMembers = new Map();
  const glossary = scanTerminology(view.units, round.glossary ?? { entries: [] }, round.glossary?.targetLanguage);
  const paid = new Set(paidConsistencyTasks(round, tasks).flatMap(task => savedReviewIds(task, new Set(task.unitIds))
    .filter(id => !(task.reviewCandidate?.issues ?? []).some(issue => issue.unitId === id && issue.resolution === 'open'))));
  const add = (id, kind, unitIds, readIds, reason) => scopes.push({ id: `targeted-${id}`, kind, unitIds, readIds, reason });
  for (const entry of glossary.entries) if (entry.needsReview) {
    const ids = (entry.unitIds ?? []).filter(id => !entry.recommended || !entry.identityProven
      || glossaryConflicts(byId.get(id), byId.get(id)?.translation, glossary).some(value => value.id === entry.id));
    add(`term-${entry.id}`, 'terminology', ids, entry.unitIds, `核对仍有分歧的译名：${entry.source}`);
  }
  for (const task of currentReviewTasks(round, tasks, 'scene')) {
    const checked = new Set(savedReviewIds(task, new Set(task.unitIds)));
    for (const issue of task.reviewCandidate?.issues ?? []) if (issue.resolution === 'open' && checked.has(issue.unitId))
      add(`issue-${sha256([issue.unitId, issue.message]).slice(0, 20)}`, 'review-issue', [issue.unitId], [issue.unitId], issue.message);
  }
  for (const id of Object.keys(view.alternatives)) add(`conflict-${sha256(id).slice(0, 20)}`, 'candidate-conflict', [id], [id], '核对已有修改分歧');
  for (const unit of round.units) if (unit.context?.syncGroup && targets.has(unit.id)) {
    const ids = syncMembers.get(unit.context.syncGroup) ?? []; ids.push(unit.id); syncMembers.set(unit.context.syncGroup, ids);
  }
  for (const [group, ids] of syncMembers) if (new Set(ids.map(id => byId.get(id)?.translation)).size > 1)
    add(`sync-${sha256(group).slice(0, 20)}`, 'linked-display', ids, ids, '关联显示位置的译文不一致');
  const merged = [];
  for (const scope of scopes) {
    scope.unitIds = scope.unitIds.filter(id => targets.has(id) && byId.has(id) && !paid.has(id) && !byId.get(id).locked && !byId.get(id).manualLock);
    if (!scope.unitIds.length) continue;
    const groups = new Set(scope.unitIds.map(id => byId.get(id)?.context?.syncGroup).filter(Boolean));
    scope.unitIds = [...new Set([...scope.unitIds, ...[...groups].flatMap(group => syncMembers.get(group) ?? [])])];
    scope.readIds = [...new Set([...scope.readIds, ...scope.unitIds])];
    const related = merged.filter(value => value.unitIds.some(id => scope.unitIds.includes(id)));
    if (related.length) {
      scope.id = `targeted-joined-${sha256([...related.map(value => value.id), scope.id].sort()).slice(0, 20)}`;
      scope.unitIds = [...new Set([...related.flatMap(value => value.unitIds), ...scope.unitIds])];
      scope.readIds = [...new Set([...related.flatMap(value => value.readIds), ...scope.readIds])];
      scope.reason = [...new Set([...related.map(value => value.reason), scope.reason])].join('；');
      for (const value of related) merged.splice(merged.indexOf(value), 1);
    }
    merged.push(scope);
  }
  return transportScopes(round, merged, 'consistency');
}

function taskProposals(tasks, stage) {
  const values = new Map();
  for (const task of tasks.filter(task => task.reviewStage === stage && (terminal(task) || stage === 'consistency' && !task.reviewScopeId?.startsWith('targeted-')))) {
    const changedIds = new Set(task.reviewChangedIds ?? []);
    const ownedIds = new Set(task.unitIds ?? []);
    const checked = new Set(savedReviewIds(task, ownedIds));
    for (const record of task.candidateRecords ?? []) if (changedIds.has(record.id) && checked.has(record.id)) {
      const list = values.get(record.id) ?? [];
      if (!list.some(value => value.translation === record.translation && (value.notes ?? '') === (record.notes ?? ''))) list.push({ ...record, taskId: task.id });
      values.set(record.id, list);
    }
  }
  return values;
}

export function reviewView(round, tasks, stage = round.stage, normalize = true) {
  const view = new Map(round.units.map(unit => [unit.id, unit])), baseline = new Map(view), alternatives = {};
  for (const previous of stage === 'scene' ? [] : stage === 'consistency' ? ['scene'] : ['scene', 'consistency']) {
    for (const [id, proposals] of taskProposals(currentReviewTasks(round, tasks, previous), previous)) {
      if (proposals.length === 1) { const unit = view.get(id); if (unit) { view.set(id, { ...unit, translation: proposals[0].translation, notes: proposals[0].notes }); delete alternatives[id]; } }
      else { alternatives[id] = proposals; view.set(id, baseline.get(id)); }
    }
    if (previous === 'scene' && normalize) {
      const units = [...view.values()], glossary = scanTerminology(units, round.glossary ?? { entries: [] }, round.glossary?.targetLanguage);
      for (const patch of terminologyUpdates(units, glossary)) if (round.targetIds.includes(patch.id)) {
        const unit = view.get(patch.id), previous = unit.terminologyNormalization;
        view.set(patch.id, { ...unit, translation: patch.translation, terminologyNormalization: {
          sourceHash: unit.sourceHash, originalTranslation: previous?.sourceHash === unit.sourceHash && previous.appliedTranslation === unit.translation
            ? previous.originalTranslation : unit.translation, appliedTranslation: patch.translation } });
      }
    }
  }
  return { units: [...view.values()], alternatives };
}

export function reviewScopeVersion(round, scope, tasks, stage, byId) {
  byId ??= new Map(reviewView(round, tasks, stage).units.map(unit => [unit.id, unit]));
  const ids = [...new Set([...scope.unitIds, ...scope.readIds])], material = ids.map(id => byId.get(id)).filter(Boolean);
  return sha256([scope.id, stage, scope.alternatives ?? null,
    ids.map(id => byId.has(id) ? [id, identityVersion(byId.get(id))] : [id, 'missing']),
    glossaryPromptProjection(relevantGlossary(round.glossary, material))]);
}

export function currentReviewTasks(round, tasks, stage) {
  const scopes = stage === 'resolve' ? reviewResolutionScopes(round, tasks) : reviewScopes(round, stage, tasks);
  const byId = new Map(reviewView(round, tasks, stage).units.map(unit => [unit.id, unit]));
  const versions = new Map(scopes.map(scope => [scope.id, reviewScopeVersion(round, scope, tasks, stage, byId)]));
  const paid = new Set(stage === 'consistency' ? paidConsistencyTasks(round, tasks).map(task => task.id) : []);
  return tasks.filter(task => task.reviewRoundId === round.id && task.reviewStage === stage
    && (paid.has(task.id) || task.reviewScopeVersion === versions.get(task.reviewScopeId)));
}

/** Preserve validated paid work without retaining the obsolete full-review scheduler. */
export function paidConsistencyTasks(round, tasks) {
  const byId = new Map(reviewView(round, tasks, 'consistency', false).units.map(unit => [unit.id, unit]));
  return tasks.filter(task => task.reviewRoundId === round.id && task.reviewStage === 'consistency'
    && !task.reviewScopeId?.startsWith('targeted-') && savedReviewIds(task, new Set(task.unitIds ?? [])).length
    && task.reviewScopeVersion === reviewScopeVersion(round, { id: task.reviewScopeId, unitIds: task.unitIds,
      readIds: task.reviewReadIds ?? task.unitIds }, tasks, 'consistency', byId));
}

export function reviewGlossary(round, tasks) {
  return scanTerminology(reviewView(round, tasks, 'consistency').units, round.glossary ?? { entries: [] }, round.glossary?.targetLanguage);
}

function savedReviewIds(task, owned) {
  if (['stale', 'cancelled'].includes(task.status)) return [];
  const saved = new Set((task.candidateRecords ?? []).map(record => record.id));
  return (task.status === 'succeeded' ? [...owned]
    : (task.reviewedUnitIds ?? (task.status === 'skipped' ? [] : task.reviewCandidate?.reviewedIds) ?? []).filter(id => saved.has(id))).filter(id => owned.has(id));
}

/** A read-only scene result view uses the same validated page receipts as progress. */
export function savedSceneReviewUnits(round, tasks) {
  const scopes = new Map(reviewScopes(round, 'scene').map(scope => [scope.id, new Set(scope.unitIds)]));
  const records = new Map();
  for (const task of currentReviewTasks(round, tasks, 'scene')) {
    const owned = new Set((task.unitIds ?? []).filter(id => scopes.get(task.reviewScopeId)?.has(id)));
    const saved = new Map((task.candidateRecords ?? []).map(record => [record.id, record]));
    for (const id of savedReviewIds(task, owned)) records.set(id, saved.get(id));
  }
  return round.units.filter(unit => records.has(unit.id)).map(unit => {
    const record = records.get(unit.id);
    return { ...unit, ...(record ? { translation: record.translation, notes: record.notes ?? unit.notes } : {}) };
  });
}

/** Progress follows saved, validated review work, not the later D2 unit commit. */
export function reviewRoundProgress(round, tasks, stage = round.stage) {
  if (!['scene', 'consistency', 'resolve'].includes(stage)) return undefined;
  const scopes = stage === 'resolve' ? reviewResolutionScopes(round, tasks) : reviewScopes(round, stage, tasks);
  const targets = new Set(scopes.flatMap(scope => scope.unitIds));
  const scopeTargets = new Map(scopes.map(scope => [scope.id, new Set(scope.unitIds)]));
  const reviewed = new Map(), skipped = new Set();
  for (const task of currentReviewTasks(round, tasks, stage)) {
    if (['stale', 'cancelled'].includes(task.status)) continue;
    const owned = new Set((task.unitIds ?? []).filter(id => scopeTargets.get(task.reviewScopeId)?.has(id)));
    const ids = savedReviewIds(task, owned);
    if (task.status === 'skipped') { const saved = new Set(ids); owned.forEach(id => { if (!saved.has(id)) skipped.add(id); }); }
    const checked = reviewed.get(task.reviewScopeId) ?? new Set();
    for (const id of ids) if (owned.has(id)) checked.add(id);
    reviewed.set(task.reviewScopeId, checked);
  }
  // A text is complete only after all of its overlapping character/term checks are saved.
  const incomplete = new Set(skipped);
  for (const scope of scopes) for (const id of scope.unitIds) if (!reviewed.get(scope.id)?.has(id)) incomplete.add(id);
  return { total: targets.size, reviewed: targets.size - incomplete.size, skipped: skipped.size };
}

export function reviewStageComplete(round, tasks, stage) {
  const selected = currentReviewTasks(round, tasks, stage);
  return reviewScopes(round, stage, tasks).every(scope => selected.some(task => task.reviewScopeId === scope.id && terminal(task)));
}

export function reviewConflicts(round, tasks) {
  return [...taskProposals(currentReviewTasks(round, tasks, 'consistency'), 'consistency')].filter(([, records]) => records.length > 1)
    .map(([id, alternatives]) => ({ id, alternatives }));
}

export function reviewResolutionScopes(round, tasks) {
  const conflicted = reviewConflicts(round, tasks), byId = new Map(round.units.map(unit => [unit.id, unit]));
  const groups = new Map();
  for (const conflict of conflicted) {
    const group = byId.get(conflict.id)?.context?.syncGroup ?? conflict.id;
    if (groups.has(group)) continue;
    const unitIds = round.targetIds.filter(id => id === conflict.id || byId.get(id)?.context?.syncGroup && byId.get(id).context.syncGroup === group);
    groups.set(group, { id: `resolve-${sha256(group).slice(0, 20)}`, kind: 'candidate-conflict', unitIds, readIds: unitIds,
      alternatives: Object.fromEntries(conflicted.filter(item => unitIds.includes(item.id)).map(item => [item.id, item.alternatives])) });
  }
  return [...groups.values()];
}

export function reviewOutcome(round, tasks) {
  const scenes = currentReviewTasks(round, tasks, 'scene'), consistency = currentReviewTasks(round, tasks, 'consistency');
  const { units, alternatives } = reviewView(round, [...scenes, ...consistency], 'resolve');
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const unresolved = [], acceptedResolutions = [];
  for (const scope of reviewResolutionScopes(round, tasks)) {
    const version = reviewScopeVersion(round, scope, [...scenes, ...consistency], 'resolve');
    const task = tasks.findLast(task => task.reviewRoundId === round.id && task.reviewStage === 'resolve' && task.reviewScopeId === scope.id
      && task.reviewScopeVersion === version && terminal(task));
    if (!task) { unresolved.push(scope); continue; }
    acceptedResolutions.push(task);
    for (const id of scope.unitIds) {
      const record = task.candidateRecords?.find(record => record.id === id);
      if (record) byId.set(id, { ...byId.get(id), translation: record.translation, notes: record.notes });
    }
  }
  const valid = [...scenes, ...consistency, ...acceptedResolutions];
  const issues = [];
  for (const stage of [scenes, consistency, acceptedResolutions]) {
    const checked = new Set(stage.flatMap(task => savedReviewIds(task, new Set(task.unitIds))));
    for (let index = issues.length - 1; index >= 0; index--) if (issues[index].resolution === 'open' && checked.has(issues[index].unitId)) issues.splice(index, 1);
    issues.push(...stage.flatMap(task => {
      const saved = new Set(savedReviewIds(task, new Set(task.unitIds)));
      return (task.reviewCandidate?.issues ?? []).filter(issue => saved.has(issue.unitId));
    }));
  }
  return { units: round.targetIds.map(id => byId.get(id)).filter(Boolean), unresolved, alternatives,
    issues, skippedIds: [...new Set(valid.filter(task => task.status === 'skipped').flatMap(task => {
      const saved = new Set(savedReviewIds(task, new Set(task.unitIds)));
      return task.unitIds.filter(id => !saved.has(id));
    }))] };
}

export function changedReviewIds(records, inputUnits) {
  const byId = new Map(inputUnits.map(unit => [unit.id, unit]));
  return records.filter(record => byId.has(record.id) && changed(record, byId.get(record.id))).map(record => record.id);
}
