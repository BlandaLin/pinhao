import { createHash } from 'node:crypto';

export const TEXT_WIRE_VERSION = 'pinhao-text-1';
const unitLists = new Set(['ids', 'unitIds', 'targetIds', 'targetUnitIds', 'evidenceIds', 'returnedIds', 'toUnitIds', 'reviewedIds']);
const unitRefs = new Set(['unitId', 'targetId', 'fromUnitId']);
const identities = new Set(['id', 'sceneId', 'characterId', 'characterIds', 'speakerId', 'actorId', 'blockId', 'storyBlockRef', 'syncGroup']);
const engineering = new Set(['schema', 'version', 'revision', 'expectedRevision', 'sourceRevision', 'scopeVersion', 'sourceHash', 'hash', 'storyLinksHash',
  'locator', 'nativePath', 'byteStart', 'byteEnd', 'pointer', 'recordId', 'mapId', 'eventId', 'page', 'command', 'code', 'indent', 'line_count']);
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_RESPONSE' }); };
const literal = value => typeof value === 'string' ? value : JSON.stringify(value);

/** This table is host-owned and persisted with one task, never sent as a canonical-ID dictionary. */
export function createTextWire(payload, previous = {}) {
  const entries = (previous.entries ?? []).map(entry => [...entry]);
  const byId = new Map(entries.map(([ref, id]) => [id, ref]));
  const unitIds = new Set(previous.unitIds ?? []);
  const targets = new Set(payload.units.map(unit => unit.id));
  const register = (id, unit = false) => {
    if (typeof id !== 'string') return id;
    if (unit) unitIds.add(id);
    if (!byId.has(id)) { const ref = `u${entries.length + 1}`; entries.push([ref, id]); byId.set(id, ref); }
    return byId.get(id);
  };
  for (const unit of [...payload.units, ...payload.referenceOnly]) register(unit.id, true);
  const collect = (value, key = '') => {
    if (unitLists.has(key) && Array.isArray(value)) { value.forEach(id => register(id, true)); return; }
    if (unitRefs.has(key)) { register(value, true); return; }
    if (identities.has(key) && Array.isArray(value)) { value.forEach(id => register(id)); return; }
    if (identities.has(key) && typeof value === 'string') { register(value); return; }
    if (key === 'file' && typeof value === 'string') { register(value); return; }
    if (Array.isArray(value)) value.forEach(item => collect(item));
    else if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) {
      if (name === 'alternatives' && item && typeof item === 'object') for (const id of Object.keys(item)) register(id, true);
      collect(item, name);
    }
  };
  collect(payload);
  const semanticEvidence = value => Array.isArray(value) ? value.map(semanticEvidence)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => !engineering.has(key)).map(key => [key, semanticEvidence(value[key])])) : value;
  const evidenceKey = evidence => JSON.stringify(semanticEvidence(evidence));
  const sharedContext = new Map();
  for (const unit of [...payload.units, ...payload.referenceOnly]) for (const evidence of Array.isArray(unit.context?.evidence) ? unit.context.evidence : []) {
    if (typeof evidence?.source !== 'string') continue;
    const key = evidenceKey(evidence), item = sharedContext.get(key) ?? { source: evidence.source, count: 0 };
    item.count++; sharedContext.set(key, item);
  }
  for (const [key, item] of sharedContext) {
    if (item.count < 2) sharedContext.delete(key);
    else item.ref = register(`context-text-${createHash('sha256').update(key).digest('hex')}`);
  }
  const contextFor = context => !Array.isArray(context?.evidence) ? context : { ...context, evidence: context.evidence.map(evidence => {
    const shared = typeof evidence?.source === 'string' && sharedContext.get(evidenceKey(evidence));
    return shared ? { ...evidence, source: { readOnlyText: shared.ref } } : evidence;
  }) };
  const encode = (value, key = '') => {
    if (unitLists.has(key) && Array.isArray(value)) return value.map(id => register(id, true));
    if (unitRefs.has(key)) return register(value, true);
    if (identities.has(key) && Array.isArray(value)) return value.map(id => register(id));
    if ((identities.has(key) || key === 'file') && typeof value === 'string') return register(value);
    if (Array.isArray(value)) return value.map(item => encode(item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([name]) => !engineering.has(name)).map(([name, item]) => [name,
      name === 'alternatives' && item && typeof item === 'object'
        ? Object.fromEntries(Object.entries(item).map(([id, alternatives]) => [register(id, true), encode(alternatives)])) : encode(item, name)]));
  };
  const section = (name, value) => value === undefined || Array.isArray(value) && !value.length ? '' : `【${name}】\n${literal(encode(value))}\n`;
  const block = unit => {
    const parts = [`[${register(unit.id, true)}]\n原文：\n${unit.source}`];
    if (unit.kind) parts.push(`文字用途：${unit.kind}`);
    if (unit.translationState) parts.push(`现译状态：${unit.translationState}`);
    if (unit.currentTranslation !== undefined) parts.push(`现译：\n${unit.currentTranslation}`);
    if (unit.notes) parts.push(`参考备注（非正文）：\n${unit.notes}`);
    const context = encode(contextFor(unit.context));
    if (context && Object.keys(context).length) parts.push(`语境：${JSON.stringify(context)}`);
    if (unit.controls && Object.keys(unit.controls).length) parts.push(`保护标记原义：${JSON.stringify(unit.controls)}`);
    return parts.join('\n');
  };
  const visible = new Set([...payload.units, ...payload.referenceOnly].map(unit => unit.id));
  const preparation = payload.preparation?.map(item => ({ ...item, scope: { ...item.scope,
    unitIds: (item.scope?.unitIds ?? []).filter(id => visible.has(id)) }, evidenceIds: item.evidenceIds?.filter(id => visible.has(id)) }));
  const scopePreview = scope => {
    const { unitIds, targetUnitIds, ...preview } = scope;
    return { ...preview, ...(preview.total === undefined && unitIds ? { total: unitIds.length } : {}),
      ...(preview.targetCount === undefined && targetUnitIds ? { targetCount: targetUnitIds.length } : {}) };
  };
  const story = payload.story?.scopes ? { ...payload.story, scopes: payload.story.scopes.map(scopePreview) }
    : payload.story?.scenes ? { scopes: [...payload.story.scenes.map(scene => ({ ...scopePreview(scene.scope), kind: 'scene', title: scene.title ?? scene.name,
      query: { story: { kind: 'scene', id: scene.id } } })), ...(payload.story.characters ?? []).map(character => ({ ...scopePreview(character.scope), kind: 'character',
      name: character.name, query: { story: { kind: 'character', id: character.id } } }))], relationships: payload.story.links } : payload.story;
  const repair = typeof payload.repairInstruction === 'string' ? entries.reduce((text, [ref, id]) => text.replaceAll(id, `[${ref}]`), payload.repairInstruction) : undefined;
  const targetRefs = payload.units.map(unit => register(unit.id, true));
  const prompt = [`【待处理文字】\n本次目标标记：${JSON.stringify(targetRefs)}。只对这些标记交付结果；后面的只读参考与材料入口不是目标。\n${payload.units.map(block).join('\n\n')}`,
    payload.referenceOnly.length ? `【参考文字，只读】\n${payload.referenceOnly.map(block).join('\n\n')}` : '',
    sharedContext.size ? `【共用语境原文，只读】\nreadOnlyText 引用以下完整原文；这些标记不是待处理文字或单元 ID。\n${[...sharedContext.values()].map(item => `[${item.ref}]\n${item.source}`).join('\n\n')}` : '',
    section('统一译名', payload.glossary), section('已接纳译名候选，只读（非确认规则）', payload.terminologyCandidates?.length ? {
      guidance: '以下是已接纳文字中实际采用的译法，按人物与义项作用域参考，不替代已确认或人工固定术语；来源不足或冲突可保留疑点，不因多数票强制统一。',
      entries: payload.terminologyCandidates } : undefined),
    section('译名分歧', payload.terminologyHints), section('已确认含义', preparation), section('场景与人物', story),
    section('本轮校对范围', payload.reviewScope), section('本次补充材料', payload.evidenceResults),
    section('已读页面收据', payload.evidenceHistory), section('累计阅读笔记', payload.readingNotes), section('本次需要修正的问题', repair)].filter(Boolean).join('\n');
  return { version: TEXT_WIRE_VERSION, prompt, state: { entries, unitIds: [...unitIds] }, targetIds: [...targets],
    review: payload.task === 'proofreading' && Boolean(payload.responseProtocol), payload };
}

export function textWireRecords(records, wire, seen = new Set()) {
  const table = new Map(wire.state.entries), targets = new Set(wire.targetIds);
  if (!Array.isArray(records)) fail('文字结果需要使用 text 二维列表。');
  return records.map(row => {
    if (!Array.isArray(row) || row.length < 2 || row.length > 3 || typeof row[0] !== 'string' || typeof row[1] !== 'string'
        || row[2] != null && typeof row[2] !== 'string') fail('每项文字使用 [短标记,完整译文,可选备注]。');
    const id = table.get(row[0]);
    if (!targets.has(id) || seen.has(id)) fail('文字短标记未知、重复或指向只读参考；只返回本批待处理文字。');
    seen.add(id); return { id, translation: row[1], notes: row[2] ?? '' };
  });
}

export function termChoiceMatches(source, translation, choice) {
  if (!choice || typeof choice.source !== 'string' || !choice.source.trim()
      || typeof choice.translation !== 'string' || !choice.translation.trim()) return false;
  const contains = (body, value) => !/\{\{[^}]*\}\}/u.test(value)
    && String(body).normalize('NFKC').split(/\{\{[^}]*\}\}/gu).some(part => part.includes(value.normalize('NFKC')));
  return contains(source, choice.source) && contains(translation, choice.translation);
}

function attachTermChoices(terms, result, wire) {
  if (terms === undefined) return;
  const warnings = [], warn = (index, code, message, id) => warnings.push({ index, code, message, ...(id ? { id } : {}) });
  if (wire.review) {
    if (!Array.isArray(terms) || terms.length) warn(-1, 'REVIEW_TERMS_IGNORED', '校对不采集译名选择，已保留校对结果。');
  } else if (!Array.isArray(terms)) warn(-1, 'INVALID_TERMS', 'terms 需要使用译名选择列表，已保留正文。');
  else {
    const table = new Map(wire.state.entries), targets = new Set(wire.targetIds);
    const units = new Map((wire.payload.units ?? []).map(unit => [unit.id, unit]));
    const records = new Map(result.records.map(record => [record.id, record])), seen = new Set();
    for (const [index, row] of terms.entries()) {
      if (!Array.isArray(row) || row.length !== 3 || row.some(item => typeof item !== 'string' || !item.trim())) {
        warn(index, 'INVALID_TERM', '译名选择使用 [短标记,原词,本次译名]。'); continue;
      }
      const id = table.get(row[0]), record = records.get(id), unit = units.get(id);
      if (!targets.has(id) || !record || !unit) { warn(index, 'UNKNOWN_TERM_TARGET', '译名选择没有对应的本批正文。'); continue; }
      if (!termChoiceMatches(unit.source, record.translation, { source: row[1], translation: row[2] })) {
        warn(index, 'TERM_TEXT_MISMATCH', '原词或译名未出现在对应正文中。', id); continue;
      }
      const key = JSON.stringify([id, row[1].normalize('NFKC'), row[2]]);
      if (seen.has(key)) { warn(index, 'DUPLICATE_TERM', '重复译名选择只保留一次。', id); continue; }
      seen.add(key);
      (record.termChoices ??= []).push({ source: row[1], translation: row[2] });
    }
  }
  if (warnings.length) result.termWarnings = warnings;
}

export function decodeTextResponse(value, wire, { allowPartialReview = false } = {}) {
  const table = new Map(wire.state.entries), targets = new Set(wire.targetIds), units = new Set(wire.state.unitIds);
  const id = (ref, target = false, unit = true) => {
    const canonical = table.get(ref);
    if (!canonical) fail(`短标记 ${JSON.stringify(ref)} 不存在；只使用本次材料提供的标记，不生成新编号。`);
    if (unit && !units.has(canonical)) fail(`短标记 ${JSON.stringify(ref)} 是材料入口而非文字；查场景/人物使用 read.story，不放入 ids 或文字结果。`);
    if (target && !targets.has(canonical)) fail(`短标记 ${JSON.stringify(ref)} 是只读参考，不是本次目标；reviewed、changes、questions 只能使用 ${JSON.stringify([...targets].map(value => wire.state.entries.find(([, id]) => id === value)?.[0]))}。`);
    return canonical;
  };
  const decode = (item, key = '') => {
    if (unitLists.has(key) && Array.isArray(item)) return item.map(ref => id(ref));
    if (unitRefs.has(key)) return id(item);
    if (identities.has(key) && Array.isArray(item)) return item.map(ref => id(ref, false, false));
    if ((identities.has(key) || key === 'file') && typeof item === 'string') return id(item, false, false);
    if (Array.isArray(item)) return item.map(entry => decode(entry));
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, decode(entry, name)]));
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('文字回包需要使用本阶段对象协议。');
  if (Object.keys(value).some(key => !['text', 'reviewed', 'changes', 'questions', 'read', 'notes', 'decisions', 'terms', 'responseRepair'].includes(key))) fail('请只使用当前文字协议字段，不返回工程记录或旧版字段。');
  if (value.notes !== undefined && typeof value.notes !== 'string') fail('累计阅读笔记需要文字。');
  const result = { ...(value.notes !== undefined ? { readingNotes: value.notes } : {}), ...(value.responseRepair ? { responseRepair: value.responseRepair } : {}) };
  if (value.read !== undefined) {
    if (!Array.isArray(value.read)) fail('read 需要查询列表。');
    result.evidenceRequests = value.read.map(query => {
      if (!query || typeof query !== 'object' || Array.isArray(query)) fail('查询需要原文或场景入口。');
      const { reason = '', ...spec } = query;
      return { query: decode(spec), reason };
    });
  }
  if (value.decisions !== undefined) {
    if (!Array.isArray(value.decisions)) fail('语义决定需要列表。');
    result.semanticDecisions = value.decisions.map(decision => {
      if (!decision || typeof decision !== 'object' || Object.keys(decision).some(key => !['ref', 'entity', 'sense', 'scope', 'translation', 'evidenceIds', 'equivalence', 'status'].includes(key))) fail('语义决定只包含含义、适用文字和证据；工程身份由软件保存。');
      const { ref, ...body } = decision, decoded = decode(body), previous = (wire.payload.preparation ?? []).find(item => table.get(ref) === item.id);
      if (ref !== undefined && !previous) fail('要修订的语义决定短标记不存在。');
      return { ...decoded, id: previous?.id ?? `meaning-${createHash('sha256').update(JSON.stringify([decoded.entity, decoded.sense, decoded.scope])).digest('hex').slice(0, 24)}`,
        expectedRevision: previous?.revision ?? 0 };
    });
  }
  if (wire.review && !result.evidenceRequests?.length) {
    const changes = value.changes === undefined ? [] : value.changes;
    const questions = value.questions === undefined ? [] : value.questions;
    if (!Array.isArray(value.reviewed) || !Array.isArray(changes) || !Array.isArray(questions)) fail('校对需要 reviewed 列表；changes 和 questions 可省略，但提供时必须是列表。');
    const reviewedIds = value.reviewed.map(ref => id(ref, true));
    if (!allowPartialReview && (new Set(reviewedIds).size !== reviewedIds.length || reviewedIds.length !== targets.size)) fail('校对需要恰好覆盖本批全部文字。');
    const changed = new Set(), issues = [], invalidEntries = [];
    const entry = (row, parse) => {
      // An unidentifiable row cannot safely be assigned to one failed target.
      if (!Array.isArray(row)) fail('校对条目需要包含可定位的本批文字标记。');
      const unitId = id(row[0], true);
      try { return parse(unitId); }
      catch (error) {
        if (!allowPartialReview) throw error;
        invalidEntries.push({ unitId, message: error.message });
      }
    };
    const edits = changes.map(row => entry(row, unitId => {
      if (!Array.isArray(row) || row.length < 3 || row.length > 4 || row.slice(0, 3).some(item => typeof item !== 'string')
          || row[3] != null && typeof row[3] !== 'string' || !row[2].trim()) fail('校对修改使用 [短标记,完整改文,修改依据,可选备注]；前三项必须是文字，没有备注时省略第四项。');
      if (changed.has(unitId)) fail('同一文字不能重复修改。'); changed.add(unitId);
      issues.push({ unitId, kind: 'correction', message: row[2], resolution: 'fixed' });
      return { id: unitId, translation: row[1], ...(row[3] != null ? { notes: row[3] } : {}) };
    })).filter(Boolean);
    for (const row of questions) entry(row, unitId => {
      if (!Array.isArray(row) || row.length !== 3 || !['needs_evidence', 'source_ambiguity'].includes(row[1]) || typeof row[2] !== 'string') fail('疑点使用 [短标记,needs_evidence或source_ambiguity,说明]。');
      issues.push({ unitId, kind: row[1], message: row[2], resolution: row[1] === 'needs_evidence' ? 'open' : 'retained' });
    });
    result.records = []; result.review = { protocol: 'pinhao-review-1', reviewedIds, edits, issues,
      ...(invalidEntries.length ? { invalidEntries } : {}) };
  } else result.records = textWireRecords(value.text ?? (result.evidenceRequests?.length ? [] : undefined), wire);
  attachTermChoices(value.terms, result, wire);
  return result;
}

/** Stream only complete tuples in the root text array; quoted delimiters never close a tuple. */
export function textWireScanner() {
  let buffer = '', offset = 0, quoted = false, escaped = false, stringStart = 0;
  let rootKey = false, expectKey = true, keyState = '', textDepth = 0, tupleStart = -1, finished = false;
  const stack = [];
  return chunk => {
    buffer += chunk; const rows = [];
    for (; offset < buffer.length && !finished; offset++) {
      const char = buffer[offset];
      if (!stack.length) { if (char === '{') stack.push(char); continue; }
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') {
          quoted = false;
          if (rootKey) { try { keyState = JSON.parse(buffer.slice(stringStart, offset + 1)) === 'text' ? 'colon' : ''; } catch { finished = true; } }
        }
        continue;
      }
      if (/\s/.test(char)) continue;
      if (char === '"') { quoted = true; stringStart = offset; rootKey = stack.length === 1 && expectKey; if (rootKey) expectKey = false; continue; }
      if (stack.length === 1 && keyState) {
        if (keyState === 'colon' && char === ':') keyState = 'array';
        else if (keyState === 'array' && char === '[') { textDepth = stack.length + 1; keyState = ''; }
        else keyState = '';
      }
      if (char === '{' || char === '[') { if (textDepth && stack.length === textDepth && char === '[') tupleStart = offset; stack.push(char); }
      else if (char === '}' || char === ']') {
        const opening = stack.pop();
        if (char === '}' && opening !== '{' || char === ']' && opening !== '[') { finished = true; continue; }
        if (textDepth && stack.length === textDepth && char === ']' && tupleStart >= 0) {
          try { rows.push(JSON.parse(buffer.slice(tupleStart, offset + 1))); } catch {} tupleStart = -1;
        }
        if (textDepth && stack.length < textDepth || !stack.length) finished = true;
      } else if (char === ',' && stack.length === 1) expectKey = true;
    }
    return rows;
  };
}
