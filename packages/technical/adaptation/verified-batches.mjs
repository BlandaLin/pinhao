import { adaptationLocationKey } from '../../core/adaptation-results.mjs';
const fileOf = unit => String(unit.locator?.file ?? unit.context?.adaptationLocator?.file ?? unit.file ?? unit.context?.file ?? '').replace(/^res:\/\//, '').replaceAll('\\', '/').replace(/^\.\//, '');
const sourceOf = unit => unit.rawSource ?? unit.source;

function position(unit) {
  const locator = unit.locator ?? unit.context?.adaptationLocator;
  const key = adaptationLocationKey(locator, fileOf(unit));
  if (!key) throw new Error('已验证文字需要精确的回写定位');
  return key;
}

/** Combine validated batches without losing earlier fields from the same file. */
export function accumulateVerifiedExtractions(previous, incoming) {
  const records = [...previous];
  for (const extraction of incoming) {
    if (!extraction?.units?.length) continue;
    const byId = new Map(), byPosition = new Map();
    for (const record of records) for (const unit of record.units) {
      byId.set(unit.legacyId ?? unit.id, unit); byPosition.set(position(unit), unit);
    }
    const seenIds = new Set(), seenPositions = new Set(), additions = [];
    for (const unit of extraction.units) {
      const id = unit.legacyId ?? unit.id, location = position(unit);
      if (typeof id !== 'string' || seenIds.has(id) || seenPositions.has(location)) throw new Error('技术批次返回了重复文字或回写定位');
      seenIds.add(id); seenPositions.add(location);
      const oldId = byId.get(id), oldPosition = byPosition.get(location);
      if ((oldId && (position(oldId) !== location || sourceOf(oldId) !== sourceOf(unit)))
        || (oldPosition && ((oldPosition.legacyId ?? oldPosition.id) !== id || sourceOf(oldPosition) !== sourceOf(unit)))) throw new Error('技术批次文字 ID、原文或回写定位发生冲突');
      if (!oldId && !oldPosition) additions.push(unit);
    }
    // A complete newer binding can replace smaller historical bindings on the same baseline.
    const superseded = records.filter(record => record.units.every(unit => seenIds.has(unit.legacyId ?? unit.id)));
    if (superseded.length) {
      for (const record of superseded) records.splice(records.indexOf(record), 1);
      const retained = new Set(records.flatMap(record => record.units.map(unit => unit.legacyId ?? unit.id)));
      const units = extraction.units.filter(unit => !retained.has(unit.legacyId ?? unit.id));
      if (units.length) records.push({ ...extraction, units });
    } else if (additions.length) records.push({ ...extraction, units: additions });
  }
  return records;
}
