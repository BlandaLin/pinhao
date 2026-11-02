import { createRequestReferenceSelector } from './request-batches.mjs';

/** Re-select for each pending page; saved candidates are overlays, not an obligatory full batch. */
export function createPendingReferenceSelector(allUnits, { story, candidates = new Map(), evidenceReferences = [], evidenceReplies = [] } = {}) {
  const select = createRequestReferenceSelector(allUnits, { ...(story ? { story } : {}), referenceRowsPerTarget: 2 });
  const evidenceById = new Map(evidenceReferences.map(unit => [unit.id, unit]));
  const explicit = new Set(evidenceReplies.slice(-2).flatMap(reply => reply.returnedIds ?? []));
  const overlay = unit => {
    const candidate = candidates.get(unit.id);
    return candidate ? { ...unit, translation: candidate.translation, notes: candidate.notes ?? unit.notes } : unit;
  };
  const result = groups => {
    const targets = new Set(groups.flat().map(unit => unit.id));
    const selected = new Map(select(groups).map(unit => [unit.id, overlay(unit)]));
    for (const id of explicit) {
      const unit = evidenceById.get(id);
      if (unit && !targets.has(id)) selected.set(id, overlay(unit));
    }
    return [...selected.values()];
  };
  result.story = select.story;
  return result;
}
