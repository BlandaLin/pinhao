import { sha256, validateTranslation } from '../exchange/index.mjs';

export function adaptationLocationKey(locator, file = locator?.file, formatBinding) {
  file = String(file ?? '').replace(/^res:\/\//, '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!file) return undefined;
  if (typeof locator?.pointer === 'string') return JSON.stringify([file, 'json', locator.pointer,
    ...(locator.segment ? [[locator.segment.syntax, locator.segment.prefix, locator.segment.suffix]] : [])]);
  if (Number.isSafeInteger(locator?.byteStart) && Number.isSafeInteger(locator?.byteEnd)) return JSON.stringify([file, 'utf8', locator.byteStart, locator.byteEnd]);
  if (Array.isArray(locator?.nativePath) && locator.nativePath.length && locator.nativePath.every(part => typeof part === 'string' || Number.isSafeInteger(part))) return JSON.stringify([file, 'native', locator.nativePath]);
  if (formatBinding?.protocol === 'pinhao-format-binding-1' && typeof formatBinding.family === 'string' && typeof formatBinding.location === 'string' && /^[a-f0-9]{64}$/.test(formatBinding.capabilityRef ?? '')) return JSON.stringify([file, 'format', formatBinding.family, formatBinding.location]);
  return undefined;
}

/** A validated writer contributes only locations not already owned by another writer. */
export function selectSupplementalUnits({ projectId, incoming, existing, nativeLocations = [] }) {
  const ids = new Map(existing.map(unit => [unit.legacyId ?? unit.id, unit]));
  const positions = new Map(nativeLocations.map(item => [adaptationLocationKey(item), item.sourceHash]));
  const containers = new Map();
  const containerKey = locator => typeof locator?.pointer === 'string' ? adaptationLocationKey({ file: locator.file, pointer: locator.pointer }) : undefined;
  for (const locator of nativeLocations) if (containerKey(locator)) containers.set(containerKey(locator), adaptationLocationKey(locator));
  for (const unit of existing) {
    const locator = unit.locator ?? unit.context?.adaptationLocator;
    const key = adaptationLocationKey(locator, unit.context?.file ?? unit.locator?.file, unit.context?.formatBinding);
    if (key) positions.set(key, unit.context?.adaptationSourceHash ?? sha256(unit.rawSource ?? unit.source));
    if (containerKey(locator)) containers.set(containerKey(locator), key);
  }
  const rawUnits = [], units = [], seenIds = new Set(), seenPositions = new Set();
  for (const raw of incoming) {
    const legacyId = raw.legacyId ?? raw.id, key = adaptationLocationKey(raw.locator, raw.context?.file ?? raw.locator?.file, raw.context?.formatBinding);
    if (!key || seenIds.has(legacyId) || seenPositions.has(key)) throw new Error('补充文字存在重复或无效定位');
    seenIds.add(legacyId); seenPositions.add(key);
    const original = raw.rawSource ?? raw.source, sourceHash = sha256(original);
    const container = containerKey(raw.locator);
    if (container && containers.has(container) && containers.get(container) !== key) throw new Error('同一 JSON 容器已经由其他文字定位拥有，请联合修正该容器，不新增重叠片段或整字段写入');
    if (ids.has(legacyId)) {
      const previous = ids.get(legacyId);
      const nativeMatch = nativeLocations.some(item => item.unitId === legacyId && adaptationLocationKey(item) === key && item.sourceHash === sourceHash);
      const previousHash = previous.context?.adaptationSourceHash ?? sha256(previous.rawSource ?? previous.source);
      if (!nativeMatch && (previous.source !== raw.source || previousHash !== sourceHash || adaptationLocationKey(previous.context?.adaptationLocator ?? previous.locator, previous.context?.file ?? previous.locator?.file, previous.context?.formatBinding) !== key)) throw new Error('补充文字 ID 已绑定其他原文或位置');
      continue;
    }
    if (positions.has(key)) {
      if (positions.get(key) !== sourceHash) throw new Error('同一文字位置存在不一致原文');
      continue;
    }
    const unit = { id: `u-${sha256(`${projectId}:${legacyId}`).slice(0, 24)}`, legacyId, kind: raw.kind ?? 'text',
      source: raw.source, translation: raw.source, notes: '', tokens: raw.tokens ?? [], sourceHash: sha256(raw.source), revision: 0, status: 'pending',
      context: { ...raw.context, file: raw.locator.file, adaptationLocator: raw.locator, adaptationSourceHash: sourceHash,
        controlFingerprint: sha256(Object.fromEntries(Object.entries(raw.controls ?? {}).sort(([a], [b]) => a.localeCompare(b)))), protectedControlSyntax: 'rpgmaker-v1' } };
    validateTranslation(unit, unit.translation);
    rawUnits.push(raw); units.push(unit); positions.set(key, sourceHash);
    if (container) containers.set(container, key);
  }
  return { rawUnits, units };
}
