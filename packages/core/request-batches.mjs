import { taskPrompt, REQUEST_BATCH_LIMITS } from './provider.mjs';
import { buildStoryContext, storyMaterialEntrypoints } from '../exchange/story.mjs';
import { textRequestLimits, textRequestEstimate, textGroupCapacityError, textOutputShape } from './text-capacity.mjs';

export { REQUEST_BATCH_LIMITS } from './provider.mjs';

export function requestPromptCharacters({ system, prompt }) {
  return system.length + prompt.length;
}

const nearestFirst = (left, right) => left.distance - right.distance || left.position - right.position;

// Retain only the nearest rows, with the original scope position breaking ties.
function nearestScopeRows(index, anchors, requested, existing, limit, branches) {
  const byBranch = new Map(), heap = [];
  for (const anchor of anchors) {
    const branch = branches.get(anchor.id), positions = byBranch.get(branch) ?? [];
    positions.push(index.positions.get(anchor.id)); byBranch.set(branch, positions);
  }
  const retain = item => {
    if (heap.length < limit) {
      let slot = heap.length; heap.push(item);
      while (slot) {
        const parent = (slot - 1) >> 1;
        if (nearestFirst(heap[parent], item) >= 0) break;
        heap[slot] = heap[parent]; slot = parent;
      }
      heap[slot] = item;
    } else if (nearestFirst(item, heap[0]) < 0) {
      let slot = 0;
      while (slot * 2 + 1 < heap.length) {
        let child = slot * 2 + 1;
        if (child + 1 < heap.length && nearestFirst(heap[child + 1], heap[child]) > 0) child++;
        if (nearestFirst(item, heap[child]) >= 0) break;
        heap[slot] = heap[child]; slot = child;
      }
      heap[slot] = item;
    }
  };
  for (const [branch, positions] of byBranch) {
    positions.sort((left, right) => left - right);
    let next = 0;
    for (const row of index.branches.get(branch) ?? []) {
      if (requested.has(row.unit.id) || existing.has(row.unit.id)) continue;
      while (next < positions.length && positions[next] < row.position) next++;
      const distance = Math.min(next < positions.length ? positions[next] - row.position : Infinity,
        next ? row.position - positions[next - 1] : Infinity);
      retain({ ...row, distance });
    }
  }
  return heap.sort(nearestFirst).map(item => item.unit);
}

/** Reuse for one unchanged project snapshot; create a new selector after unit writes. */
export function createRequestReferenceSelector(allUnits, { story = buildStoryContext(allUnits), referenceRowsPerTarget } = {}) {
  const byId = new Map(allUnits.map(unit => [unit.id, unit])), order = new Map(allUnits.map((unit, index) => [unit.id, index])), syncMembers = new Map();
  const branches = new Map(allUnits.map(unit => [unit.id,
    JSON.stringify(unit.context?.branch_path ?? unit.context?.branchPath ?? unit.context?.branch ?? null)]));
  const scopeIndexes = new WeakMap();
  const scopeIndex = scope => {
    let index = scopeIndexes.get(scope);
    if (index) return index;
    index = { positions: new Map(scope.unitIds.map((id, position) => [id, position])), branches: new Map() };
    for (const id of scope.unitIds) {
      const unit = byId.get(id); if (!unit) continue;
      const branch = branches.get(id), rows = index.branches.get(branch) ?? [];
      rows.push({ unit, position: index.positions.get(id) }); index.branches.set(branch, rows);
    }
    scopeIndexes.set(scope, index); return index;
  };
  for (const unit of allUnits) {
    const group = unit.syncGroup ?? unit.context?.syncGroup ?? unit.context?.sync_group;
    if (group) { const members = syncMembers.get(group) ?? []; members.push(unit); syncMembers.set(group, members); }
  }
  const scenesForUnit = new Map(), charactersForUnit = new Map();
  for (const scene of story.scenes) for (const unitId of scene.scope.targetUnitIds) scenesForUnit.set(unitId, scene.scope);
  for (const character of story.characters) for (const unitId of character.scope.targetUnitIds) {
    const scopes = charactersForUnit.get(unitId) ?? []; scopes.push(character.scope); charactersForUnit.set(unitId, scopes);
  }
  // Which units are *relevant* is this selector's job; how much of them fits is the prompt's job.
  // One scene must not donate its whole width to every request, though: a 100-line scene would push
  // every batch over budget and leave no room for the units being translated. The per-scene cap is
  // derived from the batch shape (two reference rows per requested row) rather than hardcoded.
  const select = groups => {
    const units = groups.flat();
    const requested = new Set(units.map(unit => unit.id));
    const references = new Map();
    const add = unit => { if (!requested.has(unit.id)) references.set(unit.id, unit); };
    const scopes = new Map();
    for (const unit of units) {
      const scene = scenesForUnit.get(unit.id); if (scene) scopes.set(scene.id, scene);
      for (const character of charactersForUnit.get(unit.id) ?? []) scopes.set(character.id, character);
    }
    for (const scope of scopes.values()) {
      const index = scopeIndex(scope);
      const anchors = units.filter(unit => index.positions.has(unit.id));
      const scopeUnits = referenceRowsPerTarget ? Math.max(2, anchors.length * referenceRowsPerTarget)
        : Math.max(2, Math.floor(REQUEST_BATCH_LIMITS.maxUnits / 2));
      for (const unit of nearestScopeRows(index, anchors, requested, references, scopeUnits, branches)) add(unit);
    }
    // Synchronized neighbors travel with their group so a linked display is never reviewed half-blind.
    const linked = new Set([...references.values()].map(unit => unit.syncGroup ?? unit.context?.syncGroup ?? unit.context?.sync_group).filter(Boolean));
    for (const group of linked) for (const unit of syncMembers.get(group) ?? []) {
      if (requested.has(unit.id) || references.has(unit.id)) continue;
      add(unit);
    }
    return [...references.values()].sort((left, right) => order.get(left.id) - order.get(right.id));
  };
  select.story = story;
  return select;
}

export function collectRequestReferences(allUnits, groups, selector = createRequestReferenceSelector(allUnits)) {
  return selector(groups);
}

const preparedBatches = new WeakMap();
export const preparedRequestBatch = batch => preparedBatches.get(batch);

/** Logical groups stay intact; produce each checked batch before planning the next. */
export function* iterateRequestBatches(groups, {
  role = 'translation',
  targetLanguage = 'zh-Hans',
  allUnits = groups.flat(),
  glossaryForUnits = () => [],
  promptOptions = {},
  referenceSelector,
  story,
  connection,
  limits = connection ? textRequestLimits(connection) : undefined,
  maxCharacters = limits?.maxCharacters ?? REQUEST_BATCH_LIMITS.maxCharacters,
  maxUnits = limits?.maxUnits ?? REQUEST_BATCH_LIMITS.maxUnits,
  maxBatches = Infinity,
} = {}) {
  if (maxBatches <= 0) return;
  story ??= referenceSelector?.story ?? buildStoryContext(allUnits);
  const selectReferences = referenceSelector ?? createRequestReferenceSelector(allUnits, { story });
  const prepare = units => {
    const options = (typeof promptOptions === 'function' ? promptOptions(units) : promptOptions) ?? {};
    const references = selectReferences([units]), glossary = glossaryForUnits(units);
    const fittedOptions = { ...options, story: options.story ?? storyMaterialEntrypoints(story, units), maxCharacters };
    const prompt = taskPrompt(role, units, targetLanguage, references, glossary, fittedOptions);
    const estimate = limits ? textRequestEstimate(prompt, units, limits, { role }) : undefined;
    return { prompt, references, glossary, promptOptions: fittedOptions, estimate,
      overLimit: units.length > maxUnits || (estimate ? estimate.overLimit : requestPromptCharacters(prompt) > maxCharacters) };
  };
  const outputBase = textOutputShape([], role).framing;
  const outputBudget = limits ? limits.maxOutputTokens - Math.max(256, Math.ceil(limits.maxOutputTokens / 4)) : Infinity;
  let cursor = 0, produced = 0;
  while (cursor < groups.length && produced < maxBatches) {
    while (cursor < groups.length && !groups[cursor].length) cursor++;
    if (cursor === groups.length) return;
    const start = cursor;
    let count = 0, output = outputBase;
    // Output work is additive. Count it once per complete group; only the finalized request
    // materializes references, shared context, decisions and the full wire projection.
    while (cursor < groups.length) {
      const group = groups[cursor];
      if (!group.length) { cursor++; continue; }
      const shape = textOutputShape(group, role, count);
      if (count && (count + group.length > maxUnits || output + shape.full - outputBase > outputBudget)) break;
      count += group.length; output += shape.full - outputBase; cursor++;
      if (count >= maxUnits || output >= outputBudget) break;
    }
    let end = cursor, batch = groups.slice(start, end).flat(), prepared = prepare(batch), reductions = 0;
    while (prepared.overLimit && end > start + 1) {
      // Optional context fitting need not be monotonic. Shrink complete groups and check each
      // actual message; do not binary-search for an assumed largest fitting target prefix.
      const ratio = limits ? Math.min((limits.contextWindow - limits.maxOutputTokens) / prepared.estimate.estimatedInputTokens,
        outputBudget / prepared.estimate.estimatedOutputTokens, maxUnits / batch.length)
        : Math.min(maxCharacters / requestPromptCharacters(prepared.prompt), maxUnits / batch.length);
      const width = end - start;
      const remove = reductions++ < 3 ? Math.max(1, Math.ceil(width * (1 - ratio))) : Math.ceil(width / 2);
      end = start + Math.max(1, width - remove);
      batch = groups.slice(start, end).flat(); prepared = prepare(batch);
    }
    if (limits && prepared.estimate.overLimit) throw textGroupCapacityError(batch, prepared.estimate, limits);
    cursor = end;
    preparedBatches.set(batch, prepared);
    produced++; yield batch;
  }
}

export const packRequestBatches = (groups, options) => [...iterateRequestBatches(groups, options)];
