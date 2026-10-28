import { sha256 } from '../exchange/index.mjs';

export const GLOSSARY_VERSION = 'pinhao-terminology-1';
const indices = new WeakMap();
const incrementalCandidates = new WeakMap();
const accepted = unit => ['translated', 'proofread'].includes(unit.status);
const locked = value => Boolean(value.locked || value.manualLock);
const text = value => String(value ?? '').replace(/\{\{LINE\d+\}\}/g, '\n').replace(/\{\{[^}]+\}\}/g, ' ').normalize('NFKC');
const plain = value => text(value).trim();
const validTerm = value => typeof value === 'string' && Boolean(value.trim()) && !/[\r\n{}]/u.test(value);
const katakana = /[\u30a1-\u30fa\u30fc\u30fd-\u30ff]/u;
const word = /[A-Za-z0-9_]/u;
const fieldKinds = new Set(['nickname', 'database_nickname', 'speaker', 'speaker_name', 'character_name', 'display_name']);
export const isNameField = unit => fieldKinds.has(unit.kind) || (unit.kind === 'database_name' && (/^Actors:/i.test(unit.legacyId ?? '') || /(?:^|[/\\])Actors\./i.test(unit.context?.file ?? '')));
const isTermField = unit => isNameField(unit) || unit.kind === 'database_name';

function boundary(value, term, offset) {
  const before = value[offset - 1] ?? '', after = value[offset + term.length] ?? '';
  return !((word.test(term[0]) && word.test(before)) || (word.test(term.at(-1)) && word.test(after))
    || (katakana.test(term[0]) && katakana.test(before)) || (katakana.test(term.at(-1)) && katakana.test(after)));
}

export function containsTerm(value, term) {
  value = text(value); term = text(term);
  if (!term) return false;
  for (let offset = value.indexOf(term); offset >= 0; offset = value.indexOf(term, offset + 1)) if (boundary(value, term, offset)) return true;
  return false;
}

export function glossaryHash(entries) {
  return sha256(entries.map(({ id, source, translation, aliases, status, category, scope, unitIds, notes, revision, votes, recommended, locked, manualLock, needsReview }) =>
    ({ id, source, translation, aliases, status, category, scope, unitIds, notes, revision, votes, recommended, locked, manualLock, needsReview })));
}

export const terminologyReviewStamp = entry => sha256([entry.id, entry.source, entry.scope,
  (entry.votes ?? []).map(vote => vote.translation).sort()]);

function reviewedTerm(unit, entry, translation = unit.translation) {
  const review = unit.terminologyReview;
  return unit.status === 'proofread' && review?.sourceHash === unit.sourceHash
    && review.translation === translation && review.decisions?.includes(terminologyReviewStamp(entry));
}

function explicitIdentity(unit, source, ambiguousSource = false) {
  const c = unit.context ?? {};
  const scope = c.semanticScope !== undefined ? { semanticScope: c.semanticScope } : {};
  const identity = value => ({ ...scope, identity: c.semanticScope !== undefined ? `scope:${JSON.stringify(c.semanticScope)}:${value}` : value });
  // A speaker ID identifies the named speaker, not every person mentioned in that speaker's sentence.
  if (isTermField(unit) || (!ambiguousSource && plain(c.speaker) === source)) {
    const actor = c.actorId ?? c.actor_id;
    if (actor !== undefined) return identity(`actor:${actor}`);
    if (c.speakerId !== undefined) return identity(`speaker:${c.speakerId}`);
  }
  if (isNameField(unit)) {
    const actor = /^Actors:(\d+)/i.exec(unit.legacyId ?? '')?.[1]
      ?? (/(?:^|[/\\])Actors\./i.test(c.file ?? '') ? c.record ?? c.recordId : undefined);
    if (actor !== undefined) return identity(`actor:${Number(actor)}`);
  }
  if (c.semanticScope !== undefined) return { ...scope, identity: `scope:${JSON.stringify(c.semanticScope)}` };
  return undefined;
}

const sourcePosition = unit => {
  if (unit.locator && typeof unit.locator === 'object') return `locator:${JSON.stringify(unit.locator)}`;
  const c = unit.context ?? {}, fields = ['file', 'map', 'event', 'page', 'common_event', 'troop', 'scene', 'label', 'node', 'object', 'record', 'recordId', 'command', 'index', 'offset', 'field', 'pointer'];
  const values = fields.filter(key => c[key] !== undefined).map(key => [key, c[key]]);
  return values.some(([key]) => !['file', 'scene', 'label', 'map', 'event', 'page'].includes(key)) ? JSON.stringify(values) : undefined;
};

function independentOrigins(units) {
  const parents = new Map(units.map(unit => [unit.id, unit.id])), keys = new Map();
  const find = id => {
    if (!parents.has(id)) parents.set(id, id);
    let root = id;
    while (parents.get(root) !== root) root = parents.get(root);
    while (parents.get(id) !== id) { const next = parents.get(id); parents.set(id, root); id = next; }
    return root;
  };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parents.set(a, b); };
  for (const unit of units) {
    const c = unit.context ?? {}, sync = unit.syncGroup ?? c.syncGroup ?? c.sync_group, position = sourcePosition(unit);
    for (const key of [`source:${plain(unit.source)}`, ...(sync !== undefined ? [`sync:${sync}`] : []), ...(position ? [`position:${position}`] : [])]) {
      if (keys.has(key)) join(unit.id, keys.get(key)); else keys.set(key, unit.id);
    }
    const origin = unit.translationSourceUnitId ?? c.translationSourceUnitId;
    if (origin) join(unit.id, origin);
  }
  return new Map(units.map(unit => [unit.id, find(unit.id)]));
}

function anchorIndex(units) {
  const result = new Map();
  for (const unit of units) {
    if (!isTermField(unit) || !validTerm(plain(unit.source))) continue;
    const source = plain(unit.source), category = isNameField(unit) ? 'name' : 'term';
    const scope = explicitIdentity(unit, source) ?? { identity: `field:${sourcePosition(unit) ?? unit.legacyId ?? unit.id}` };
    const anchors = result.get(source) ?? new Map();
    anchors.set(JSON.stringify([category, scope.identity]), { category, scope }); result.set(source, anchors);
  }
  return result;
}

function termScope(unit, source, anchors) {
  const category = isTermField(unit) && plain(unit.source) === source ? (isNameField(unit) ? 'name' : 'term') : undefined;
  const candidates = [...(anchors.get(source)?.values() ?? [])], explicit = explicitIdentity(unit, source, candidates.length > 1);
  if (explicit) return { category: category ?? candidates.find(value => value.scope.identity === explicit.identity)?.category ?? 'name', scope: explicit, proven: true };
  if (category) return { category, scope: { identity: `field:${sourcePosition(unit) ?? unit.legacyId ?? unit.id}` }, proven: true };
  const related = category ? candidates.filter(value => value.category === category) : candidates;
  if (related.length === 1) return { ...related[0], proven: true };
  return { category: category ?? (candidates.length && candidates.every(value => value.category === 'name') ? 'name' : 'term'), scope: {}, proven: false };
}

function voteTranslation(unit) {
  const marker = unit.terminologyNormalization;
  return marker && marker.sourceHash === unit.sourceHash && marker.appliedTranslation === unit.translation && typeof marker.originalTranslation === 'string'
    ? marker.originalTranslation : unit.translation;
}

/** Derive terminology from accepted language work only; this never creates billable prerequisite tasks. */
export function scanTerminology(units, previous, targetLanguage) {
  const anchors = anchorIndex(units), origins = independentOrigins(units), groups = new Map();
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const oldEntries = previous?.targetLanguage === targetLanguage ? previous.entries ?? [] : [];
  const oldById = new Map(oldEntries.map(entry => [entry.id, entry]));
  for (const unit of units) {
    if (!accepted(unit)) continue;
    const originalTranslation = voteTranslation(unit), choices = [...(Array.isArray(unit.termChoices) ? unit.termChoices : [])];
    if (isTermField(unit)) choices.push({ source: plain(unit.source), translation: plain(originalTranslation) });
    for (const choice of choices) {
      if (!validTerm(choice?.source) || !validTerm(choice?.translation) || !containsTerm(unit.source, choice.source) || !containsTerm(originalTranslation, choice.translation)) continue;
      const source = plain(choice.source), translation = plain(choice.translation), relation = termScope(unit, source, anchors);
      const key = JSON.stringify([source, relation.category, relation.scope.identity ?? null]), id = `g-${sha256(key).slice(0, 24)}`;
      let group = groups.get(id);
      if (!group) { group = { id, source, category: relation.category, scope: { category: relation.category, ...relation.scope }, identityProven: relation.proven, choices: new Map(), unitIds: new Set(), lockedTranslations: new Set() }; groups.set(id, group); }
      group.unitIds.add(unit.id);
      const origin = origins.get(unit.id), votes = group.choices.get(origin) ?? new Map(), ids = votes.get(translation) ?? new Set();
      ids.add(unit.id); votes.set(translation, ids); group.choices.set(origin, votes);
      if (locked(unit)) group.lockedTranslations.add(translation);
    }
  }
  const entries = [];
  for (const group of groups.values()) {
    const variants = new Map();
    for (const votes of group.choices.values()) for (const [translation, ids] of votes) {
      const value = variants.get(translation) ?? { translation, count: 0, unitIds: new Set() };
      // Conflicting copies of one source are evidence of disagreement, not independent votes.
      if (votes.size === 1) value.count++;
      for (const id of ids) value.unitIds.add(id);
      variants.set(translation, value);
    }
    const votes = [...variants.values()].map(value => ({ ...value, unitIds: [...value.unitIds].sort() })).sort((a, b) => b.count - a.count || a.translation.localeCompare(b.translation));
    const old = oldById.get(group.id), manuallySet = old && locked(old) && validTerm(old.translation) ? old.translation : undefined;
    const choices = [...group.lockedTranslations], manual = manuallySet ?? (choices.length === 1 ? choices[0] : undefined);
    const majority = votes[0]?.count > votes.reduce((sum, value) => sum + value.count, 0) / 2 ? votes[0].translation : undefined;
    const recommended = manual ?? majority, status = choices.length > 1 ? 'disputed' : recommended && (group.identityProven || manuallySet) ? 'confirmed' : votes.length > 1 ? 'disputed' : 'unresolved';
    const needsReview = votes.length > 1 || choices.length > 1 || Boolean(manuallySet && votes.some(value => value.translation !== manuallySet));
    const entry = { id: group.id, source: group.source, category: group.category, scope: group.scope, identityProven: group.identityProven, needsReview,
      translation: status === 'confirmed' ? recommended : group.source, status, votes, unitIds: [...group.unitIds].sort(), aliases: votes.map(value => value.translation).filter(value => value !== recommended),
      ...(recommended ? { recommended } : {}), ...(manuallySet ? { locked: true } : {}), notes: old?.notes ?? '', revision: old?.revision ?? 0 };
    if (entry.needsReview && entry.unitIds.every(id => {
      const unit = byId.get(id);
      if (locked(unit)) return plain(unit.translation) === entry.recommended;
      return reviewedTerm(unit, entry);
    })) entry.needsReview = false;
    if (old && glossaryHash([{ ...old, revision: 0 }]) !== glossaryHash([{ ...entry, revision: 0 }])) entry.revision++;
    entries.push(entry);
  }
  // Explicit user decisions survive rescans; old generated pending/confirmed candidates do not.
  for (const entry of oldEntries) if (locked(entry) && validTerm(entry.translation) && !groups.has(entry.id)) entries.push({ ...entry, status: 'confirmed', votes: [], unitIds: entry.unitIds ?? [], identityProven: true });
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { version: GLOSSARY_VERSION, targetLanguage, entries, prepared: true, hash: glossaryHash(entries) };
}

// Cached multi-pattern matching avoids the old all-terms x all-project-units scan.
function terminologyIndex(glossary) {
  if (indices.has(glossary)) return indices.get(glossary);
  const root = { next: new Map(), values: [] }, direct = new Map(), sources = new Map(); root.fail = root;
  for (const entry of glossary.entries ?? []) {
    let node = root; const source = plain(entry.source);
    if (!source) continue;
    for (const char of source.split('')) { if (!node.next.has(char)) node.next.set(char, { next: new Map(), values: [] }); node = node.next.get(char); }
    node.values.push({ source, entry });
    const identities = sources.get(source) ?? new Set(); identities.add(entry.id); sources.set(source, identities);
    for (const id of entry.unitIds ?? []) { const values = direct.get(id) ?? new Set(); values.add(entry); direct.set(id, values); }
  }
  const queue = [...root.next.values()]; for (const node of queue) node.fail = root;
  for (let index = 0; index < queue.length; index++) for (const [char, child] of queue[index].next) {
    let fallback = queue[index].fail;
    while (fallback !== root && !fallback.next.has(char)) fallback = fallback.fail;
    child.fail = fallback.next.get(char) ?? root; child.values = [...child.values, ...child.fail.values]; queue.push(child);
  }
  const result = { root, direct, sources }; indices.set(glossary, result); return result;
}

function matchingEntries(glossary, units, matches) {
  if (!glossary) return [];
  const { root, direct, sources } = terminologyIndex(glossary), found = new Set();
  for (const unit of units) {
    const add = entry => { found.add(entry); if (matches) { const ids = matches.get(entry) ?? new Set(); ids.add(unit.id); matches.set(entry, ids); } };
    const own = direct.get(unit.id) ?? new Set();
    const value = text(unit.source); let node = root;
    for (let end = 0; end < value.length; end++) {
      while (node !== root && !node.next.has(value[end])) node = node.fail;
      node = node.next.get(value[end]) ?? root;
      for (const { source, entry } of node.values) {
        if (!boundary(value, source, end - source.length + 1)) continue;
        const identity = explicitIdentity(unit, source, sources.get(source).size > 1);
        if (entry.scope?.semanticScope !== undefined && JSON.stringify(unit.context?.semanticScope) !== JSON.stringify(entry.scope.semanticScope)) continue;
        if (identity && entry.scope?.identity && identity.identity !== entry.scope.identity) continue;
        if (isTermField(unit) && plain(unit.source) === source && entry.category !== (isNameField(unit) ? 'name' : 'term')) continue;
        if (sources.get(source).size > 1 && !own.has(entry)
            && (!identity || !entry.scope?.identity || identity.identity !== entry.scope.identity)) continue;
        add(entry);
      }
    }
  }
  return [...found];
}

export const relevantGlossary = (glossary, units) => matchingEntries(glossary, units).filter(entry => entry.status === 'confirmed');

/** Advisory observations only; never publish these as canonical rules or normalization patches. */
export function incrementalTerminologyCandidates(allUnits, targets, glossary, targetLanguage) {
  let languages = incrementalCandidates.get(allUnits);
  if (!languages) incrementalCandidates.set(allUnits, languages = new Map());
  let observations = languages.get(targetLanguage);
  if (!observations) {
    // A prior normalization vote can differ from the accepted text visible now.
    const current = allUnits.map(unit => unit.terminologyNormalization ? { ...unit, terminologyNormalization: undefined } : unit);
    observations = scanTerminology(current, undefined, targetLanguage);
    languages.set(targetLanguage, observations);
  }
  const matches = new Map(), fixed = new Map(relevantGlossary(glossary, targets).map(entry => [entry.id, entry.translation]));
  return matchingEntries(observations, targets, matches).flatMap(entry => {
    const variants = entry.votes.map(({ translation, count, unitIds }) => ({ translation, count, evidenceIds: [...unitIds] }));
    if (!variants.length || fixed.has(entry.id) && variants.every(variant => variant.translation === fixed.get(entry.id))) return [];
    return [{ source: entry.source, category: entry.category, scope: { ...entry.scope },
      unitIds: [...matches.get(entry)], evidenceIds: [...entry.unitIds], variants }];
  });
}

export function terminologyHints(glossary, units) {
  const matches = new Map();
  return matchingEntries(glossary, units, matches).filter(entry => entry.needsReview).map(entry => ({
    source: entry.source, ...(entry.recommended ? { recommendation: entry.recommended } : {}),
    variants: (entry.votes ?? []).map(({ translation, count }) => ({ translation, count })),
    unitIds: [...matches.get(entry)],
  }));
}

export function terminologyUpdates(units, glossary) {
  const proposed = new Map(), byId = new Map(units.map(unit => [unit.id, unit]));
  for (const entry of glossary?.entries ?? []) {
    if (entry.status !== 'confirmed' || (!entry.identityProven && !locked(entry))) continue;
    for (const id of entry.unitIds ?? []) {
      const unit = byId.get(id);
      if (!unit || !accepted(unit) || !isTermField(unit) || locked(unit) || plain(unit.source) !== plain(entry.source) || plain(unit.translation) === plain(entry.translation) || (unit.tokens?.length ?? 0) || /\{\{/u.test(unit.source)) continue;
      const old = proposed.get(id);
      proposed.set(id, proposed.has(id) && old !== entry.translation ? null : entry.translation);
    }
  }
  const sync = new Map();
  for (const unit of units) {
    const key = unit.syncGroup ?? unit.context?.syncGroup ?? unit.context?.sync_group;
    if (key === undefined) continue;
    const group = sync.get(key) ?? []; group.push(unit); sync.set(key, group);
  }
  for (const group of sync.values()) {
    const values = new Set(group.filter(unit => proposed.get(unit.id)).map(unit => proposed.get(unit.id)));
    if (values.size > 1 || (values.size && group.some(unit => !proposed.has(unit.id) && plain(unit.translation) !== plain([...values][0])))) for (const unit of group) proposed.delete(unit.id);
  }
  return [...proposed].filter(([, translation]) => translation).map(([id, translation]) => ({ id, translation }));
}

/** Informational consistency evidence only: never guess a name's alignment from a Chinese substring. */
export function glossaryConflicts(unit, translation, glossary) {
  return relevantGlossary(glossary, [unit]).filter(entry => {
    if (reviewedTerm(unit, entry, translation)) return false;
    if (isTermField(unit) && plain(unit.source) === plain(entry.source)) return plain(translation) !== plain(entry.translation);
    return (unit.termChoices ?? []).some(choice => plain(choice.source) === plain(entry.source) && containsTerm(unit.source, choice.source)
      && containsTerm(translation, choice.translation) && plain(choice.translation) !== plain(entry.translation));
  });
}
