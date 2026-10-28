// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';

export const STORY_SCHEMA = 'pinhao-story-1';
export const STORY_BUILDER_VERSION = 2;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = (prefix, value) => `${prefix}-${hash(value).slice(0, 24)}`;
const unique = values => [...new Set(values)];
const storyIndices = new WeakMap();
const readingIndices = new WeakMap();
const relationshipHashes = new WeakMap();
const contextOf = unit => unit.context ?? {};
const fileOf = unit => contextOf(unit).file ?? unit.file ?? '';
const syncOf = unit => unit.syncGroup ?? contextOf(unit).syncGroup ?? contextOf(unit).sync_group;

/** Every field that narrows one physical engine position: block identity, not inferred plot order. */
const blockFields = ['map', 'event', 'page', 'common_event', 'troop', 'scene', 'label', 'node', 'object', 'record',
  'field', 'recordId'];
/** Record columns and physical boxes further split a row; dialogue lines keep one scene block per position. */
const columnFields = ['actorId', 'actor_id', 'region'];
const scenePositionFields = ['map', 'event', 'page', 'common_event', 'troop', 'scene', 'label', 'node', 'object'];
const locationText = value => value && typeof value === 'object' ? JSON.stringify(value) : String(value);

export function storyBlockLocation(unit) {
  const c = contextOf(unit);
  const location = { file: fileOf(unit) };
  for (const key of blockFields) {
    if (c[key] !== undefined) location[key] = c[key];
  }
  if (!scenePositionFields.some(key => c[key] !== undefined)) for (const key of columnFields) {
    if (c[key] !== undefined) location[key] = c[key];
  }
  // A schema field or a physical object is a position block, not inferred plot order.
  if (Object.keys(location).length === 1 && !location.file) location.unit = unit.id;
  return location;
}

export function storyBlockReference(context, file = context?.file ?? '') {
  return id('block', storyBlockLocation({ context, file }));
}

/** Project per-line evidence without copying the complete block relationship graph. */
export function compactStoryContext(context, { file, keepLinks = false } = {}) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return context;
  if (!Object.hasOwn(context, 'storyLinks')) return context;
  const { storyLinks, ...result } = context;
  result.storyBlockRef = storyBlockReference(context, file);
  if (Array.isArray(storyLinks)) {
    let digest = relationshipHashes.get(storyLinks);
    if (!digest) { digest = hash(storyLinks); relationshipHashes.set(storyLinks, digest); }
    result.storyLinksHash = digest;
  }
  if (keepLinks && storyLinks?.length) result.storyLinks = storyLinks;
  return result;
}

/** Keep one complete relationship owner per block; unit identities and text remain unchanged. */
export function compactStoryUnits(units) {
  const groups = new Map();
  for (const unit of units) {
    const context = contextOf(unit), key = id('block', storyBlockLocation(unit));
    const group = groups.get(key) ?? { anchor: unit.id, links: new Map(), arrays: new WeakSet() };
    const links = context.storyLinks;
    if (Array.isArray(links) && !group.arrays.has(links)) {
      group.arrays.add(links);
      for (const link of links) group.links.set(JSON.stringify(link), link);
    }
    groups.set(key, group);
  }
  for (const group of groups.values()) if (group.links.size) {
    group.values = [...group.links.values()]; group.hash = hash(group.values);
  }
  return units.map(unit => {
    const context = contextOf(unit), key = id('block', storyBlockLocation(unit)), group = groups.get(key);
    if (!group.links.size) return unit;
    const { storyLinks: _links, ...compact } = context;
    compact.storyBlockRef = key; compact.storyLinksHash = group.hash;
    if (unit.id === group.anchor) compact.storyLinks = group.values;
    return { ...unit, context: compact };
  });
}

const materialIdentity = unit => [unit.id, unit.source, unit.translation, unit.notes ?? '', unit.revision ?? 0,
  unit.kind, unit.tokens ?? [], contextOf(unit)];
const evidence = (basis, evidenceIds, value) => ({ basis, state: 'confirmed', evidenceIds,
  evidenceHash: hash(value), revision: 1 });

/** Rebuild derived indices from the current immutable text snapshot; no name-based identity merging. */
export function buildStoryContext(units, { sourceRevision, previous } = {}) {
  units = compactStoryUnits(units);
  const byId = new Map(), blockMap = new Map(), unitBlocks = new Map(), unitVersions = new Map();
  for (const unit of units) {
    if (!unit || typeof unit.id !== 'string' || byId.has(unit.id)) throw new Error('Story materials require unique unit IDs');
    byId.set(unit.id, unit); unitVersions.set(unit.id, hash(materialIdentity(unit)));
    const location = storyBlockLocation(unit), key = id('block', location);
    const block = blockMap.get(key) ?? { id: key, location, unitIds: [], links: [], ...evidence('engine', [], location) };
    block.unitIds.push(unit.id); blockMap.set(key, block); unitBlocks.set(unit.id, key);
  }
  const blocks = [...blockMap.values()];
  const positionIndex = new Map();
  for (const block of blocks) for (const [key, value] of Object.entries(block.location)) {
    const indexKey = JSON.stringify([key, value]), matches = positionIndex.get(indexKey) ?? [];
    matches.push(block); positionIndex.set(indexKey, matches);
  }
  const links = [], linkIds = new Set();
  for (const block of blocks) {
    block.evidenceIds = [...block.unitIds];
    for (const unitId of block.unitIds) for (const input of contextOf(byId.get(unitId)).storyLinks ?? []) {
      const kind = input.kind ?? input.type ?? 'unknown';
      const target = input.target ?? null;
      const targetEntries = Object.entries(target ?? {});
      const targetCandidates = targetEntries.length ? targetEntries.map(([key, value]) => positionIndex.get(JSON.stringify([key, value])) ?? [])
        .sort((left, right) => left.length - right.length)[0] : [];
      const matches = target && input.state !== 'unknown' ? targetCandidates.filter(candidate =>
        targetEntries.every(([key, value]) => candidate.location[key] === value)) : [];
      const linkId = id('link', [block.id, kind, input.command, target]);
      if (linkIds.has(linkId)) continue;
      linkIds.add(linkId);
      const link = { id: linkId, kind, from: block.id, command: input.command ?? null,
        target, targetBlockIds: kind === 'conditional-branch' ? [block.id] : matches.map(item => item.id),
        ...(input.condition ? { condition: input.condition } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
        ...(input.coordinates ? { coordinates: input.coordinates } : {}),
        basis: 'engine', state: input.state === 'unknown' || !target ? 'unknown' : 'confirmed',
        evidenceIds: [unitId], evidenceHash: hash(input), revision: 1 };
      block.links.push(linkId); links.push(link);
    }
  }
  const staticCalls = new Map();
  for (const link of links) if (link.kind === 'common-event-call' && link.state === 'confirmed') {
    const targets = staticCalls.get(link.from) ?? []; targets.push(...link.targetBlockIds); staticCalls.set(link.from, targets);
  }
  const relatedBlocks = start => {
    const result = new Set([start]), pending = [start];
    while (pending.length) for (const next of staticCalls.get(pending.pop()) ?? []) if (!result.has(next)) { result.add(next); pending.push(next); }
    return [...result];
  };
  const scopeFor = (kind, key, targetUnitIds, readUnitIds) => ({ kind, id: key,
    version: hash(readUnitIds.map(unitId => [unitId, unitVersions.get(unitId)])),
    unitIds: [...readUnitIds], targetUnitIds: [...targetUnitIds] });
  const scenes = blocks.map(block => {
    const blockIds = relatedBlocks(block.id), unitIds = unique(blockIds.flatMap(key => blockMap.get(key).unitIds));
    const key = id('scene', block.id);
    return { id: key, blockIds: [block.id], relatedBlockIds: blockIds.slice(1),
      title: Object.entries(block.location).map(([name, value]) => `${name}: ${locationText(value)}`).join(' · '),
      relation: 'engine-position-block', plotRelation: 'unknown',
      ...evidence('engine', block.unitIds, block.location),
      scope: scopeFor('scene', key, block.unitIds, unitIds) };
  });
  const characterMap = new Map(), characterUnits = new Map(), characterBindings = new Map();
  const addCharacter = (key, fields, unit, relation) => {
    const entry = characterMap.get(key) ?? { id: key, names: [], aliases: [], unitIds: [], bindings: [],
      ...fields, basis: 'engine', state: 'confirmed', revision: 1 };
    if (fields.name && !entry.names.includes(fields.name)) entry.names.push(fields.name);
    if (fields.alias && !entry.aliases.includes(fields.alias)) entry.aliases.push(fields.alias);
    const ids = characterUnits.get(key) ?? new Set(), bindingIds = characterBindings.get(key) ?? new Set();
    if (!ids.has(unit.id)) { entry.unitIds.push(unit.id); ids.add(unit.id); }
    const bindingKey = JSON.stringify([unit.id, relation]);
    if (!bindingIds.has(bindingKey)) { entry.bindings.push({ unitId: unit.id, relation }); bindingIds.add(bindingKey); }
    characterUnits.set(key, ids); characterBindings.set(key, bindingIds);
    characterMap.set(key, entry);
  };
  for (const unit of units) {
    const c = contextOf(unit), actor = c.actorId ?? c.actor_id;
    const actorRecord = /(?:^|[/\\])Actors\./i.test(fileOf(unit)) || /^Actors:/i.test(unit.legacyId ?? unit.id);
    if (actorRecord && c.record !== undefined) addCharacter(`actor-${c.record}`, { actorId: c.record,
      ...(unit.kind === 'database_name' ? { name: unit.source } : {}) }, unit, 'actor-record');
    if (actor !== undefined) addCharacter(`actor-${actor}`, { actorId: actor,
      ...([320, 324].includes(c.code) ? { alias: unit.source } : {}) }, unit,
      c.code === 320 ? 'rename-command' : c.code === 324 ? 'nickname-command' : 'actor-field');
    const speaker = typeof c.speaker === 'string' ? c.speaker.trim() : '';
    if (speaker && speaker !== 'unknown') {
      const actorSpeaker = /^\\N\[(\d+)\]$/i.exec(speaker);
      if (actorSpeaker) addCharacter(`actor-${Number(actorSpeaker[1])}`, { actorId: Number(actorSpeaker[1]) }, unit, 'speaker-actor-control');
      else addCharacter(id('speaker', [unitBlocks.get(unit.id), speaker]), { name: speaker, identityScope: unitBlocks.get(unit.id) }, unit, 'explicit-speaker-field');
    }
    const controls = unit.controls ?? c.controlBindings ?? {};
    for (const value of Object.values(controls)) if (typeof value === 'string') for (const match of value.matchAll(/\\N\[(\d+)\]/gi)) {
      addCharacter(`actor-${Number(match[1])}`, { actorId: Number(match[1]) }, unit, 'actor-name-reference');
    }
  }
  const unitScenes = new Map();
  for (const scene of scenes) for (const unitId of scene.scope.unitIds) {
    const ids = unitScenes.get(unitId) ?? []; ids.push(scene.id); unitScenes.set(unitId, ids);
  }
  const characters = [...characterMap.values()].map(character => {
    const readBlockIds = unique(character.unitIds.map(unitId => unitBlocks.get(unitId)));
    return { ...character, evidenceIds: character.unitIds, evidenceHash: hash(character.bindings),
      sceneIds: unique(readBlockIds.flatMap(blockId => unitScenes.get(blockMap.get(blockId).unitIds[0]) ?? [])),
      scope: scopeFor('character', character.id, character.unitIds, unique(readBlockIds.flatMap(blockId => blockMap.get(blockId).unitIds))) };
  });
  // Human/AI semantic links are retained only while their precise evidence still matches.
  const previousJudgments = (previous?.judgments ?? []).map(judgment => ({ ...judgment,
    state: judgment.evidenceHash === hash((judgment.evidenceIds ?? []).map(unitId => byId.has(unitId) ? materialIdentity(byId.get(unitId)) : null))
      ? judgment.state : 'unknown' }));
  const result = { schema: STORY_SCHEMA, builderVersion: STORY_BUILDER_VERSION,
    sourceRevision: sourceRevision ?? hash(units.map(unit => [unit.id, unit.source])), blocks, links, scenes, characters,
    judgments: previousJudgments };
  return { ...result, version: hash([result.sourceRevision, scenes.map(scene => [scene.id, scene.scope.version]),
    characters.map(character => [character.id, character.scope.version]), previousJudgments]) };
}

function storyIndex(story) {
  let index = storyIndices.get(story);
  if (!index) {
    index = { byId: new Map(), byUnit: new Map(), relationships: new Map() };
    for (const entry of [...story.scenes, ...story.characters]) {
      index.byId.set(`${entry.scope.kind}:${entry.id}`, entry.scope);
      for (const unitId of entry.scope.targetUnitIds) {
        const scopes = index.byUnit.get(unitId) ?? []; scopes.push(entry.scope); index.byUnit.set(unitId, scopes);
      }
    }
    storyIndices.set(story, index);
  }
  return index;
}

export function storyScope(story, { kind, id: scopeId }) {
  const scope = storyIndex(story).byId.get(`${kind}:${scopeId}`);
  if (!scope) throw new Error('Unknown story material scope');
  return scope;
}

export function storyScopesForUnits(story, unitIds) {
  const selected = new Map(), index = storyIndex(story);
  for (const value of unitIds) for (const scope of index.byUnit.get(typeof value === 'string' ? value : value.id) ?? []) selected.set(`${scope.kind}:${scope.id}`, scope);
  return [...selected.values()];
}

export function storyMaterialEntrypoints(story, unitIds) {
  const supplied = new Set(unitIds.map(value => typeof value === 'string' ? value : value.id));
  return { schema: story.schema, version: story.version, scopes: storyScopesForUnits(story, unitIds).map(scope => ({
    kind: scope.kind, id: scope.id, version: scope.version, total: scope.unitIds.length,
    providedTextCount: scope.unitIds.filter(unitId => supplied.has(unitId)).length,
    targetCount: scope.targetUnitIds.length, query: { story: { kind: scope.kind, id: scope.id }, offset: 0, limit: 32 },
  })) };
}

export function readStoryRelationships(story, scopeInput, { offset = 0, limit = 32 } = {}) {
  const scope = storyScope(story, scopeInput), index = storyIndex(story);
  let material = index.relationships.get(scope);
  if (!material) {
    const included = new Set(scope.unitIds), blocks = story.blocks.filter(block => block.unitIds.some(unitId => included.has(unitId)));
    const byBlock = new Map(blocks.map(block => [block.id, block]));
    material = { byBlock, links: story.links.filter(link => byBlock.has(link.from)) };
    index.relationships.set(scope, material);
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > material.links.length || !Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error('Invalid story relationship page');
  const links = material.links.slice(offset, offset + limit);
  const blockIds = new Set(links.flatMap(link => [link.from, ...link.targetBlockIds]));
  const blocks = [...blockIds].map(blockId => material.byBlock.get(blockId)).filter(Boolean)
    .map(({ id, location, evidenceHash }) => ({ id, location, evidenceHash }));
  const nextOffset = offset + links.length;
  return { scopeId: scope.id, scopeVersion: scope.version, links, blocks, total: material.links.length,
    nextOffset, hasMore: nextOffset < material.links.length };
}

export function readStoryContext(story, units, { kind, id: scopeId, offset = 0, limit = 32 }) {
  const scope = storyScope(story, { kind, id: scopeId });
  if (!Number.isInteger(offset) || offset < 0 || offset > scope.unitIds.length || !Number.isInteger(limit) || limit < 1 || limit > 512) throw new Error('Invalid story material page');
  // Pages share the caller's unchanged round snapshot rather than indexing a whole game per page.
  let index = readingIndices.get(units);
  if (!index) { index = { byId: new Map(units.map(unit => [unit.id, unit])), validated: new WeakSet() }; readingIndices.set(units, index); }
  const { byId } = index;
  if (!index.validated.has(scope)) {
    if (scope.unitIds.some(unitId => !byId.has(unitId))) throw new Error('Story material unit is missing');
    index.validated.add(scope);
  }
  let end = Math.min(offset + limit, scope.unitIds.length);
  const groups = new Set(scope.unitIds.slice(offset, end).map(unitId => syncOf(byId.get(unitId))).filter(Boolean));
  for (let index = end; index < scope.unitIds.length; index++) if (groups.has(syncOf(byId.get(scope.unitIds[index])))) end = index + 1;
  const records = scope.unitIds.slice(offset, end).map(unitId => byId.get(unitId));
  const included = new Set(scope.unitIds), blocks = story.blocks.filter(block => block.unitIds.some(unitId => included.has(unitId)));
  const blockIds = new Set(blocks.map(block => block.id)), links = story.links.filter(link => blockIds.has(link.from));
  const receipt = { scopeId: scope.id, scopeKind: scope.kind, scopeVersion: scope.version,
    offset, nextOffset: end, unitIds: records.map(unit => unit.id) };
  return { scope, records, blocks, links, total: scope.unitIds.length, nextOffset: end, hasMore: end < scope.unitIds.length,
    receipt: { ...receipt, hash: hash(receipt) } };
}

export function verifyStoryReading(story, scopeInput, receipts = []) {
  const scope = storyScope(story, scopeInput), covered = new Set(); let stale = Boolean(scopeInput.version && scopeInput.version !== scope.version);
  for (const receipt of receipts) {
    if (receipt.scopeId !== scope.id || receipt.scopeKind !== scope.kind) continue;
    const { hash: digest, ...content } = receipt;
    if (receipt.scopeVersion !== scope.version || digest !== hash(content)
      || JSON.stringify(receipt.unitIds) !== JSON.stringify(scope.unitIds.slice(receipt.offset, receipt.nextOffset))) { stale = true; continue; }
    receipt.unitIds.forEach(unitId => covered.add(unitId));
  }
  const missingIds = scope.unitIds.filter(unitId => !covered.has(unitId));
  return { complete: missingIds.length === 0 && !stale, covered: covered.size, total: scope.unitIds.length, missingIds, stale };
}

export function storyReadingMarkdown(story, units, kind = 'scene') {
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const entries = kind === 'character' ? story.characters : story.scenes;
  const lines = [`# ${kind === 'character' ? '人物与出场材料' : '完整位置块与场景材料'}`, '',
    '材料来自引擎位置与显式人物依据。跨位置剧情关系保留已知与未知状态；清单顺序表示材料顺序。', ''];
  if (kind === 'character') lines.push('本页只列人物身份依据和出场索引；完整原文、现译和备注以 scenes.md 的场景正文为准，按条目 ID 查找。', '');
  for (const entry of entries) {
    lines.push(`## ${entry.id}`, '', entry.title ?? (entry.names.join(' / ') || entry.id), '',
      `范围版本：${entry.scope.version}`, `人物/场景入口：${kind === 'character' ? (entry.sceneIds ?? []).join(', ') : 'reading/characters.md'}`, '');
    if (kind === 'character') {
      lines.push(`身份依据：${JSON.stringify(entry.bindings ?? [])}`, `出场目标 ID：${JSON.stringify(entry.evidenceIds ?? [])}`, '',
        ...(entry.sceneIds ?? []).map(sceneId => `场景正文：[${sceneId}](scenes.md#${sceneId})`), '',
        `相关只读条目 ID：${JSON.stringify(entry.scope.unitIds)}`, '');
      continue;
    }
    for (const unitId of entry.scope.unitIds) {
      const unit = byId.get(unitId), c = contextOf(unit);
      lines.push(`### ${unit.id}`, '', `说话人：${c.speaker || 'unknown'}`, `分支：${JSON.stringify(c.branch_path ?? c.branch ?? [])}`,
        '', '原文：', '', unit.source, '', '当前译文：', '', unit.translation ?? unit.source, '', ...(unit.notes ? ['备注：', '', unit.notes, ''] : []));
    }
  }
  return `${lines.join('\n')}\n`;
}
