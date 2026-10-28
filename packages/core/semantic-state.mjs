import { sha256 } from '../exchange/index.mjs';
import { relevantGlossary } from './glossary.mjs';
import { promptContext, glossaryPromptProjection, preparationPromptProjection } from './provider.mjs';

export const SEMANTIC_VERSION = 'pinhao-semantic-1';
const clone = value => structuredClone(value);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])])) : value;
const digest = value => sha256(stable(value ?? null));
const fail = message => { const error = new Error(message); error.code = 'SEMANTIC_CONFLICT'; throw error; };

export function createReadReceipt(unit, { translation = true, notes = translation, projection = 'semantic-context-1' } = {}) {
  const value = { id: unit.id, source: unit.source, sourceHash: unit.sourceHash, kind: unit.kind,
    context: projection ? promptContext(unit.context) : unit.context, controls: unit.controls, tokens: unit.tokens, ...(notes ? { notes: unit.notes } : {}),
    ...(translation ? { revision: unit.revision, translation: unit.translation, locked: unit.locked, manualLock: unit.manualLock } : {}) };
  return { kind: 'unit', id: unit.id, translation, notes, ...(projection ? { projection } : {}), hash: digest(value) };
}

const candidateValue = (candidate, notes) => ({ translation: candidate.translation, ...(notes ? { notes: candidate.notes ?? '' } : {}) });
function candidateReadReceipt(unit, candidate) {
  const notes = Boolean(unit.notes);
  return { kind: 'candidate', id: unit.id, revision: unit.revision, locked: Boolean(unit.locked), manualLock: Boolean(unit.manualLock), notes,
    source: createReadReceipt(unit, { translation: false, notes: false }), hash: digest(candidateValue(candidate, notes)) };
}

function queryUnits(units, query) {
  return units.filter(unit => (!query.ids || query.ids.includes(unit.id)) && (!query.kinds || query.kinds.includes(unit.kind))
    && (!query.file || unit.context?.file === query.file)
    && (!query.text || `${unit.source}\n${query.translation ? unit.translation ?? '' : ''}`.includes(query.text)));
}

export function createQueryReceipt(units, query = {}) {
  const spec = Object.fromEntries(['text', 'ids', 'kinds', 'file', 'translation'].filter(key => query[key] !== undefined).map(key => [key, clone(query[key])]));
  return { kind: 'query', query: spec, results: queryUnits(units, spec).map(unit => createReadReceipt(unit, { translation: Boolean(spec.translation) })).sort((a, b) => a.id.localeCompare(b.id)) };
}

/** Share indexes and receipt hashes only within one unchanged project-unit snapshot. */
export function createSemanticContext(units) {
  let byId;
  const hashes = new Map(), queries = new Map();
  const unitById = id => {
    if (!byId) {
      byId = new Map();
      for (const unit of units) byId.set(unit.id, unit);
    }
    return byId.get(id);
  };
  const receiptFresh = receipt => {
    if (receipt.kind === 'unit') {
      const unit = unitById(receipt.id);
      if (!unit) return false;
      const key = JSON.stringify([receipt.id, receipt.translation, receipt.notes, receipt.projection]);
      if (!hashes.has(key)) hashes.set(key, createReadReceipt(unit, { translation: receipt.translation, notes: receipt.notes, projection: receipt.projection ?? null }).hash);
      return hashes.get(key) === receipt.hash;
    }
    if (receipt.kind === 'query') {
      const { purpose, ...queryReceipt } = receipt, key = digest(receipt.query);
      if (!queries.has(key)) queries.set(key, digest(createQueryReceipt(units, receipt.query)));
      return queries.get(key) === digest(queryReceipt);
    }
    return false;
  };
  return { units, unitById, receiptFresh };
}

const semanticContext = (units, context) => context?.units === units ? context : createSemanticContext(units);

const applies = (decision, ids) => decision.status === 'active' && decision.scope.unitIds.some(id => ids.has(id));
const decisionStamp = (decision, projection = 'prompt-1') => ({ id: decision.id, revision: decision.revision, unitIds: [...decision.scope.unitIds],
  ...(projection ? { projection } : {}), hash: digest(projection ? preparationPromptProjection([decision])[0] : decision) });
const glossaryKey = entry => digest([entry.id ?? null, entry.source, entry.category ?? null, entry.scope ?? null]);
const scopedGlossary = (glossary, units) => relevantGlossary(Array.isArray(glossary) ? { entries: glossary } : glossary, units);
const scopedGlossaryHash = (glossary, units) => !glossary ? null : digest(glossaryPromptProjection(scopedGlossary(glossary, units)));

export function createDependencySnapshot({ units = [], referenceUnits = [], glossary, preparation, receipts = [], promptVersion, targetLanguage, modelMaterial, candidateRecords = [] }) {
  const ids = new Set([...units, ...referenceUnits].map(unit => unit.id));
  const candidateById = new Map(candidateRecords.map(candidate => [candidate.id, candidate]));
  const reads = [...units.map(unit => ({ ...createReadReceipt(unit), purpose: 'target' })), ...referenceUnits.map(unit => {
    const candidate = candidateById.get(unit.id);
    const receipt = candidate && candidate.translation === unit.translation && (!unit.notes || unit.notes === candidate.notes)
      ? candidateReadReceipt(unit, candidate) : createReadReceipt(unit, { translation: typeof unit.translation === 'string' && unit.translation !== unit.source, notes: Boolean(unit.notes) });
    return { ...receipt, purpose: 'reference' };
  }),
  ...receipts.map(receipt => ({ ...receipt, purpose: 'evidence' }))];
  const unique = [...new Map(reads.map(receipt => [digest(receipt), receipt])).values()];
  return { version: SEMANTIC_VERSION, promptVersion, targetLanguage, targetIds: units.map(unit => unit.id), glossaryUnitIds: [...ids], receipts: unique,
    glossaryHash: modelMaterial ? digest(modelMaterial.glossary ?? []) : scopedGlossaryHash(glossary, [...units, ...referenceUnits]),
    ...(modelMaterial ? { glossarySelection: (modelMaterial.glossary ?? []).map(glossaryKey) } : {}),
    decisions: (modelMaterial?.preparation ?? (preparation?.decisions ?? []).filter(decision => applies(decision, ids))).map(decision => decisionStamp(decision)) };
}

export const dependencyHash = snapshot => digest(snapshot);

/** Drop only targets rejected by CAS; explicit evidence and reference reads stay bound. */
export function retainDependencySnapshot(snapshot, eligibleIds, initialTargetIds = snapshot?.targetIds ?? []) {
  if (!snapshot) return snapshot;
  const eligible = new Set(eligibleIds), initial = new Set(initialTargetIds), next = clone(snapshot);
  next.receipts = next.receipts.filter(receipt => !(receipt.kind === 'unit' && (receipt.purpose === 'target' || (!receipt.purpose && initial.has(receipt.id))) && !eligible.has(receipt.id)));
  next.targetIds = snapshot.targetIds.filter(id => eligible.has(id));
  const ids = new Set(next.receipts.filter(receipt => receipt.kind === 'unit' || receipt.kind === 'candidate').map(receipt => receipt.id));
  next.decisions = next.decisions.filter(stamp => !stamp.unitIds || stamp.unitIds.some(id => ids.has(id)));
  return next;
}

export function dependenciesFresh(snapshot, { units = [], context, glossary, preparation, promptVersion, targetLanguage, candidateRecords = [] } = {}) {
  if (!snapshot || snapshot.version !== SEMANTIC_VERSION) return false;
  if (promptVersion !== undefined && snapshot.promptVersion !== promptVersion) return false;
  if (targetLanguage !== undefined && snapshot.targetLanguage !== targetLanguage) return false;
  const current = semanticContext(units, context);
  const scopedIds = new Set(snapshot.glossaryUnitIds);
  const byGlossaryKey = snapshot.glossarySelection ? new Map((glossary?.entries ?? glossary ?? []).map(entry => [glossaryKey(entry), entry])) : undefined;
  const glossaryHash = snapshot.glossarySelection ? digest(glossaryPromptProjection(snapshot.glossarySelection.map(key => byGlossaryKey.get(key)).filter(Boolean)))
    : glossary ? scopedGlossaryHash(glossary, [...scopedIds].map(current.unitById).filter(Boolean)) : null;
  const candidates = new Map(candidateRecords.map(candidate => [candidate.id, candidate]));
  const receiptFresh = receipt => {
    if (receipt.kind !== 'candidate') return current.receiptFresh(receipt);
    const unit = current.unitById(receipt.id), candidate = candidates.get(receipt.id);
    return Boolean(unit && candidate && unit.revision === receipt.revision && Boolean(unit.locked) === receipt.locked && Boolean(unit.manualLock) === receipt.manualLock
      && current.receiptFresh(receipt.source) && digest(candidateValue(candidate, receipt.notes)) === receipt.hash);
  };
  if (snapshot.glossaryHash !== glossaryHash || !snapshot.receipts.every(receiptFresh)) return false;
  const ids = new Set(snapshot.receipts.filter(receipt => receipt.kind === 'unit' || receipt.kind === 'candidate').map(receipt => receipt.id));
  const currentDecisions = (preparation?.decisions ?? []).filter(decision => applies(decision, ids)).map(decision =>
    decisionStamp(decision, snapshot.decisions.find(stamp => stamp.id === decision.id)?.projection));
  if (digest(currentDecisions) !== digest(snapshot.decisions)) return false;
  for (const stamp of snapshot.decisions) {
    const decision = (preparation?.decisions ?? []).find(decision => decision.id === stamp.id);
    if (!decision || decision.status !== 'active' || digest(decisionStamp(decision, stamp.projection ?? null)) !== digest(stamp)
      || !decision.receipts.every(receiptFresh)) return false;
  }
  return true;
}

export function createSemanticState(previous) {
  if (previous && previous.version !== SEMANTIC_VERSION) fail('语义资料版本已更新，请重新确认相关决定。');
  return previous ? clone(previous) : { version: SEMANTIC_VERSION, revision: 0, decisions: [], history: [] };
}

export function freshSemanticPreparation(state, { units, context }) {
  const next = createSemanticState(state);
  const receiptFresh = semanticContext(units, context).receiptFresh;
  next.decisions = next.decisions.filter(decision => decision.status === 'active' && decision.receipts.every(receiptFresh));
  return next;
}

export function publishSemanticDecisions(state, decisions, { units, context, receipts = [], actor = 'agent' }) {
  const next = createSemanticState(state), current = semanticContext(units, context);
  const receiptFresh = current.receiptFresh;
  if (!Array.isArray(decisions)) fail('语义决定需要完整列表。');
  const ids = new Set();
  for (const raw of decisions) {
    if (!raw || typeof raw.id !== 'string' || !raw.id || ids.has(raw.id)) fail('语义决定 ID 需要唯一且完整。');
    ids.add(raw.id);
    const previous = next.decisions.find(decision => decision.id === raw.id);
    if (previous?.locked && actor !== 'manual') fail('此项语义决定已由用户锁定。');
    if ((raw.expectedRevision ?? 0) !== (previous?.revision ?? 0)) fail('语义决定已有更新，请使用最新证据。');
    const scope = raw.scope;
    if (!scope || !Array.isArray(scope.unitIds) || !scope.unitIds.length || scope.unitIds.some(id => !current.unitById(id))) fail('语义决定需要准确的适用文字 ID。');
    if (scope.unitIds.some(id => !receipts.some(receipt => receipt.kind === 'unit' && receipt.id === id))) fail('语义决定的适用文字需要已读证据。');
    if (typeof raw.entity !== 'string' || !raw.entity.trim() || typeof raw.sense !== 'string' || !raw.sense.trim()) fail('语义决定需要明确对象和义项。');
    if (!Array.isArray(raw.evidenceIds) || !raw.evidenceIds.length) fail('语义决定需要已读证据。');
    const evidenceReceipts = raw.evidenceIds.map(id => receipts.find(receipt => receipt.kind === 'unit' && receipt.id === id));
    if (evidenceReceipts.some(receipt => !receipt) || !receipts.every(receiptFresh)) fail('语义证据已变化，请重新读取。');
    if (raw.equivalence && (typeof raw.equivalence.fromUnitId !== 'string' || !scope.unitIds.includes(raw.equivalence.fromUnitId)
      || !Array.isArray(raw.equivalence.toUnitIds) || raw.equivalence.toUnitIds.some(id => !scope.unitIds.includes(id)))) fail('译文复用需要完整的来源与目标范围。');
    const decision = { id: raw.id, entity: raw.entity, sense: raw.sense, scope: clone(scope), translation: raw.translation,
      evidenceIds: [...new Set(raw.evidenceIds)], receipts: clone(receipts), revision: (previous?.revision ?? 0) + 1,
      status: raw.status === 'revoked' ? 'revoked' : 'active', actor, locked: actor === 'manual' && Boolean(raw.locked),
      ...(raw.equivalence ? { equivalence: clone(raw.equivalence), reuseInputs: raw.equivalence.toUnitIds.map(id => {
        const unit = current.unitById(id);
        return { id, revision: unit.revision, translationHash: digest(unit.translation), notesHash: digest(unit.notes) };
      }) } : {}) };
    if (previous) next.history.push(clone(previous));
    next.decisions = [...next.decisions.filter(item => item.id !== decision.id), decision];
  }
  if (decisions.length) next.revision++;
  return next;
}

export function semanticReuseRecords(decision, { units, context, validate }) {
  if (typeof validate !== 'function') fail('译文复用需要原生文字校验。');
  const current = semanticContext(units, context);
  if (!decision.equivalence || decision.status !== 'active' || !decision.receipts.every(current.receiptFresh)) fail('复用决定需要最新证据。');
  const source = current.unitById(decision.equivalence.fromUnitId);
  if (!source || !['translated', 'proofread'].includes(source.status)) fail('复用来源需要已接受译文。');
  return decision.equivalence.toUnitIds.map(id => {
    const target = current.unitById(id);
    const input = decision.reuseInputs?.find(input => input.id === id);
    if (!target || target.status !== 'pending' || target.locked || target.manualLock || !decision.scope.unitIds.includes(id)
      || !input || target.revision !== input.revision || digest(target.translation) !== input.translationHash || digest(target.notes) !== input.notesHash) fail('复用目标已有独立修改。');
    validate(target, source.translation);
    return { id, translation: source.translation, notes: target.notes ?? '', expectedRevision: target.revision, status: 'translated', semanticDecision: { id: decision.id, revision: decision.revision } };
  });
}
