import { taskPrompt, REQUEST_BATCH_LIMITS } from './provider.mjs';
import { buildStoryContext, storyMaterialEntrypoints } from '../exchange/story.mjs';
import { textRequestLimits, textRequestEstimate, textGroupCapacityError } from './text-capacity.mjs';

export { REQUEST_BATCH_LIMITS } from './provider.mjs';

export function requestPromptCharacters({ system, prompt }) {
  return system.length + prompt.length;
}

/** Reuse for one unchanged project snapshot; create a new selector after unit writes. */
export function createRequestReferenceSelector(allUnits, { story = buildStoryContext(allUnits) } = {}) {
  const byId = new Map(allUnits.map(unit => [unit.id, unit])), order = new Map(allUnits.map((unit, index) => [unit.id, index])), syncMembers = new Map();
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
  const scopeUnits = Math.max(2, Math.floor(REQUEST_BATCH_LIMITS.maxUnits / 2));
  const branchOf = unit => JSON.stringify(unit.context?.branch_path ?? unit.context?.branchPath ?? unit.context?.branch ?? null);
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
      const positions = new Map(scope.unitIds.map((id, index) => [id, index]));
      const anchors = units.filter(unit => positions.has(unit.id));
      const distance = unit => Math.min(...anchors.filter(anchor => branchOf(anchor) === branchOf(unit))
        .map(anchor => Math.abs(positions.get(anchor.id) - positions.get(unit.id))));
      const nearby = scope.unitIds.map(id => byId.get(id)).filter(Boolean)
        .filter(unit => !requested.has(unit.id)).map(unit => ({ unit, distance: distance(unit) }))
        .filter(item => Number.isFinite(item.distance))
        .sort((left, right) => left.distance - right.distance || positions.get(left.unit.id) - positions.get(right.unit.id));
      let count = 0;
      for (const { unit } of nearby) {
        if (count >= scopeUnits) break;
        if (references.has(unit.id)) continue;
        add(unit); count++;
      }
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

/** Logical groups stay intact; only the transport request combines neighboring groups. */
export function packRequestBatches(groups, {
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
  if (maxBatches <= 0) return [];
  story ??= referenceSelector?.story ?? buildStoryContext(allUnits);
  const selectReferences = referenceSelector ?? createRequestReferenceSelector(allUnits, { story });
  // Measure the same projection used to send: source sharing, scoped decisions and optional
  // previews all change the encoded size. Each candidate contains at most one bounded batch.
  const overBudget = units => {
    if (units.length > maxUnits) return true;
    const options = (typeof promptOptions === 'function' ? promptOptions(units) : promptOptions) ?? {};
    const prompt = taskPrompt(role, units, targetLanguage, selectReferences([units]), glossaryForUnits(units),
      { ...options, story: options.story ?? storyMaterialEntrypoints(story, units), maxCharacters });
    return requestPromptCharacters(prompt) > maxCharacters || limits && textRequestEstimate(prompt, units, limits).overLimit;
  };
  const checkSingle = units => {
    if (!limits) return;
    const options = (typeof promptOptions === 'function' ? promptOptions(units) : promptOptions) ?? {};
    const prompt = taskPrompt(role, units, targetLanguage, selectReferences([units]), glossaryForUnits(units),
      { ...options, story: options.story ?? storyMaterialEntrypoints(story, units), maxCharacters });
    const estimate = textRequestEstimate(prompt, units, limits);
    if (estimate.overLimit || requestPromptCharacters(prompt) > maxCharacters) throw textGroupCapacityError(units, estimate, limits);
  };
  const batches = [];
  let batch = [];
  for (const group of groups) {
    if (!group.length) continue;
    const candidate = [...batch, group];
    if (!batch.length) {
      batch = candidate;
      // A logical group is never split. A group that overflows on its own owns one request instead of
      // swallowing the budget of every following group.
      if (overBudget(candidate.flat())) {
        checkSingle(group);
        batches.push(batch.flat());
        if (batches.length >= maxBatches) return batches;
        batch = [];
      }
      continue;
    }
    if (!overBudget([...batch, group].flat())) { batch = candidate; continue; }
    batches.push(batch.flat());
    if (batches.length >= maxBatches) return batches;
    batch = [group];
    checkSingle(group);
  }
  if (batch.length) batches.push(batch.flat());
  return batches;
}
