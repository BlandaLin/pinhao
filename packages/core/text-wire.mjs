import { createHash } from 'node:crypto';
import { estimateTextTokens } from './text-capacity.mjs';
import { readTextBlockMarker } from './text-blocks.mjs';

export const TEXT_WIRE_VERSION = 'pinhao-text-blocks-3';
export { textBlockScanner as textWireScanner } from './text-blocks.mjs';
const unitLists = new Set(['ids', 'unitIds', 'targetIds', 'targetUnitIds', 'evidenceIds', 'returnedIds', 'toUnitIds', 'reviewedIds']);
const unitRefs = new Set(['unitId', 'targetId', 'fromUnitId']);
const identities = new Set(['id', 'sceneId', 'characterId', 'characterIds', 'speakerId', 'actorId', 'blockId', 'storyBlockRef', 'syncGroup']);
const engineering = new Set(['schema', 'version', 'revision', 'expectedRevision', 'sourceRevision', 'scopeVersion', 'sourceHash', 'hash', 'storyLinksHash',
  'locator', 'nativePath', 'byteStart', 'byteEnd', 'pointer', 'recordId', 'mapId', 'eventId', 'page', 'command', 'code', 'indent', 'line_count']);
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_RESPONSE' }); };
const literal = value => typeof value === 'string' ? value : JSON.stringify(value);
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

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
  // Full ledgers stay local; one accepted example per variant remains directly queryable.
  const terminologyCandidates = payload.terminologyCandidates?.map(entry => ({ source: entry.source, category: entry.category,
    scope: entry.scope, unitIds: (entry.unitIds ?? []).filter(id => targets.has(id)),
    variants: (entry.variants ?? []).map(({ translation, count, evidenceIds }) => ({ translation, count,
      ...(evidenceIds?.length ? { query: { ids: [evidenceIds[0]] } } : {}) })), query: { term: entry.source } }));
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
  collect({ ...payload, terminologyCandidates });
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
    // Only an explicit paged evidence read exposes the original engineering payload.
    if (key === 'rawEvidence') return value;
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
  const commonContextHeader = '【共用条目语境，只读】\n每条语境由所引共用字段与本条字段完整组成；不推断不同条目同义。标记不是文字目标，不得交稿。\n';
  const contextRows = new Map(), repeatedFields = new Map(), commonContexts = new Map();
  for (const [index, unit] of [...payload.units, ...payload.referenceOnly].entries()) {
    const context = contextFor(unit.context);
    if (!context || typeof context !== 'object' || Array.isArray(context)) continue;
    const row = { index, context: { ...context }, shared: [] }; contextRows.set(unit, row);
    for (const [name, value] of Object.entries(context)) {
      if (value === undefined) continue;
      const key = canonical([name, value]), field = repeatedFields.get(key) ?? { name, value, rows: [] };
      field.rows.push(row); repeatedFields.set(key, field);
    }
  }
  // Factor equal fields losslessly; different speakers, branches and evidence stay on each row.
  for (const field of repeatedFields.values()) {
    if (field.rows.length < 2) continue;
    const key = field.rows.map(row => row.index).join(','), item = commonContexts.get(key) ?? { context: {}, rows: field.rows };
    item.context[field.name] = field.value; commonContexts.set(key, item);
  }
  for (const [key, item] of commonContexts) {
    const body = JSON.stringify(encode(item.context)), ref = `u${entries.length + 1}`;
    const label = `共用 [${ref}]；本条 `, definition = `[${ref}]\n${body}\n`;
    const inline = item.rows.length * Math.max(0, body.length - 2);
    const shared = definition.length + item.rows.length * label.length + commonContextHeader.length;
    const inlineTokens = item.rows.length * estimateTextTokens(body.slice(1, -1));
    const sharedTokens = estimateTextTokens(definition + commonContextHeader) + item.rows.length * estimateTextTokens(label);
    if (shared >= inline || sharedTokens >= inlineTokens) { commonContexts.delete(key); continue; }
    item.ref = register(`context-block-${createHash('sha256').update(canonical(item.context)).digest('hex')}`);
    for (const row of item.rows) {
      row.shared.push(item.ref);
      for (const name of Object.keys(item.context)) delete row.context[name];
    }
  }
  const block = unit => {
    const parts = [`[${register(unit.id, true)}]\n原文：\n${unit.source}`];
    if (unit.kind) parts.push(`文字用途：${unit.kind}`);
    if (unit.translationState) parts.push(`现译状态：${unit.translationState}`);
    if (unit.currentTranslation !== undefined) parts.push(`现译：\n${unit.currentTranslation}`);
    if (unit.notes) parts.push(`参考备注（非正文）：\n${unit.notes}`);
    const projected = contextRows.get(unit), context = encode(projected?.context ?? contextFor(unit.context));
    if (projected?.shared.length) parts.push(`语境：共用 ${projected.shared.map(ref => `[${ref}]`).join('、')}${Object.keys(context).length ? `；本条 ${JSON.stringify(context)}` : ''}`);
    else if (context && Object.keys(context).length) parts.push(`语境：${JSON.stringify(context)}`);
    if (unit.controls && Object.keys(unit.controls).length) parts.push(`保护标记原义：${JSON.stringify(unit.controls)}`);
    return parts.join('\n');
  };
  const visible = new Set([...payload.units, ...payload.referenceOnly].map(unit => unit.id));
  const preparation = payload.preparation?.map(item => ({ ...item, scope: { ...item.scope,
    unitIds: (item.scope?.unitIds ?? []).filter(id => visible.has(id)) }, evidenceIds: item.evidenceIds?.filter(id => visible.has(id)) }));
  const scopePreview = scope => {
    const { unitIds, targetUnitIds, targetCount, ...preview } = scope;
    return { ...preview, ...(preview.total === undefined && unitIds ? { total: unitIds.length } : {}),
      ...(targetCount !== undefined || targetUnitIds ? { scopeTargetCount: targetCount ?? targetUnitIds.length } : {}) };
  };
  const story = payload.story?.scopes ? { ...payload.story, scopes: payload.story.scopes.map(scopePreview) }
    : payload.story?.scenes ? { scopes: [...payload.story.scenes.map(scene => ({ ...scopePreview(scene.scope), kind: 'scene', title: scene.title ?? scene.name,
      query: { story: { kind: 'scene', id: scene.id } } })), ...(payload.story.characters ?? []).map(character => ({ ...scopePreview(character.scope), kind: 'character',
      name: character.name, query: { story: { kind: 'character', id: character.id } } }))], relationships: payload.story.links } : payload.story;
  const bodies = [...payload.units, ...payload.referenceOnly].flatMap(unit => [unit.source, unit.currentTranslation, unit.notes]).filter(value => typeof value === 'string');
  let markerDepth = previous.markerDepth ?? 1;
  for (; markerDepth <= 32; markerDepth++) {
    if (!bodies.some(text => text.split(/\r?\n/).some(line => readTextBlockMarker(line, markerDepth)))) break;
  }
  if (!Number.isSafeInteger(markerDepth) || markerDepth < 1 || markerDepth > 32) fail('正文与所有可用分段标记冲突，不能安全对齐。');
  const marker = value => '['.repeat(markerDepth) + value + ']'.repeat(markerDepth);
  const review = payload.task === 'proofreading' && Boolean(payload.responseProtocol);
  const repair = payload.repairInstruction;
  const repairText = repair && (() => {
    const mapped = text => entries.reduce((value, [ref, id]) => value.replaceAll(id, marker(ref)), String(text ?? ''));
    const details = typeof repair === 'string' ? { message: repair } : repair;
    const rejected = new Map((details.rejectedEntries ?? []).map(entry => [entry.unitId, entry.message]));
    const affected = new Set([...(details.missingIds ?? []), ...rejected.keys()]);
    const rows = payload.units.filter(unit => affected.has(unit.id));
    return [review ? '仅重新审阅下列未通过条目；其他已保存的审阅结果不重复交付。' : '仅补交下列未通过条目；其他已保存的译文不重复交付。',
      review ? '返回修改时，目标标记是必需的交稿结构：先写该条目标记，再写完整改文；没有修改时只写完成标记。'
        : '目标标记是必需的交稿结构，不是可省略的说明。即使上一回复已写译文，本次仍须先写该条目标记，再写完整正文。',
      details.message ? `上次未通过原因：${mapped(details.message)}` : '',
      ...rows.map(unit => `${marker(register(unit.id, true))}：${rejected.has(unit.id) ? mapped(rejected.get(unit.id)) : '尚未收到可接纳的本条结果。请按本条标记重新交付。'}`
        + `${unit.tokens?.length ? ` 必须原样保留的保护标记及顺序：${unit.tokens.join(' → ')}。` : ''}`),
      review ? `逐条审完后写 ${marker('完成')}；无须修改的条目不抄写现译，但仍须明确完成。` : `以上每条各交一次，最后独占一行写 ${marker('完成')}。`].filter(Boolean).join('\n');
  })();
  const format = review
    ? `逐条审阅本次目标，只交需修改项：照抄该项独立标记行，下一行起写完整改文，每项一次。本批审完后独占一行写 ${marker('完成')}；没有修改也必须明确完成，未审完不得声称完成。`
    : `逐项交付本次目标：照抄该项独立标记行，下一行起写完整译文，每项一次；最后独占一行写 ${marker('完成')}。`;
  const framing = review ? '需修改项必须包含目标标记与完整改文；没有修改时只返回完成标记。'
    : '目标标记、正文与完成标记共同组成交稿，不能只返回译文而省略标记。';
  const prompt = [`【交稿方式】\n${format}\n${framing}不写前言、解释或第二份交稿。块间空行仅作分隔，不属于译文。保留完整语义、正文内段落及{{...}}保护标记；标记表示的换行不改写成实际换行。正文不用 JSON、代码围栏或包裹引号，不填空备注。只读参考和材料入口不交稿。`,
    repairText ? `【本次需要修正的问题】\n${repairText}` : '',
    payload.capabilities ? `【按需能力】\n交稿与补查二选一：需要先查资料时，只返回 ${marker('附加信息')} 和下一行的 JSON 对象，不交正文或完成标记；正常交稿如有可选说明，则在完成标记后返回同样的附加信息区。不含 text、changes、reviewed 或 complete。示例中的“目标标记”须换成本次实际短标记。\n${payload.capabilities.replaceAll('$target', '目标标记')}` : '',
    section('统一译名', payload.glossary), section('已接纳译名候选，只读（非确认规则）', terminologyCandidates?.length ? {
      guidance: '已接纳文字中的实际译法，按人物与义项参考，不替代确认规则，不因多数票强制统一。译法内 query 查一处已接纳依据；条目 query 查所有原文用法，用 read 按游标续读。',
      entries: terminologyCandidates } : undefined),
    section('译名分歧', payload.terminologyHints), section('已确认含义', preparation),
    story ? `【场景与人物】\n以下为整个资料范围；total、scopeTargetCount 不是本次交稿数量。本次仅处理“待处理文字”，可按 query 分页查阅完整场景或人物。\n${literal(encode(story))}\n` : '',
    sharedContext.size ? `【共用语境原文，只读】\nreadOnlyText 引用以下完整原文；这些标记不是待处理文字或单元 ID。\n${[...sharedContext.values()].map(item => `[${item.ref}]\n${item.source}`).join('\n\n')}` : '',
    commonContexts.size ? commonContextHeader + [...commonContexts.values()].map(item => `[${item.ref}]\n${JSON.stringify(encode(item.context))}`).join('\n\n') : '',
    section('本轮校对范围', payload.reviewScope), section('本次补充材料', payload.evidenceResults),
    section('已读页面收据', payload.evidenceHistory), section('累计阅读笔记', payload.readingNotes),
    payload.referenceOnly.length ? `【参考文字，只读】\n${payload.referenceOnly.map(block).join('\n\n')}` : '',
    `【待处理文字】\n${payload.units.map(unit => block(unit).replace(`[${register(unit.id, true)}]\n`, `${marker(register(unit.id, true))}\n`)).join('\n\n')}`].filter(Boolean).join('\n');
  return { version: TEXT_WIRE_VERSION, prompt, state: { entries, unitIds: [...unitIds], markerDepth }, targetIds: [...targets], review, payload };
}

export function textWireRecords(records, wire, seen = new Set()) {
  const table = new Map(wire.state.entries), targets = new Set(wire.targetIds);
  if (!Array.isArray(records)) fail('未收到可定位的文字块；每项先写本次目标标记，再写完整正文，最后写完成标记。');
  const result = [], validRows = [], current = new Set(), revoked = new Set();
  let failure;
  for (const row of records) {
    try {
      if (!Array.isArray(row) || row.length < 2 || row.length > 3 || typeof row[0] !== 'string' || typeof row[1] !== 'string'
          || row[2] != null && typeof row[2] !== 'string') fail('文字块不完整；每项先写本次目标标记，下一行起写完整正文，不用 JSON 包装正文。');
      const id = table.get(row[0]);
      if (targets.has(id) && (seen.has(id) || current.has(id))) throw Object.assign(new Error('文字短标记重复，本条结果需要重新确认。'), { code: 'INVALID_RESPONSE', invalidatedIds: [id] });
      if (!targets.has(id)) fail('文字短标记未知或指向只读参考；只返回本批待处理文字。');
      current.add(id); validRows.push(row); result.push({ id, translation: row[1], notes: row[2] ?? '' });
    } catch (error) {
      failure ??= error;
      for (const id of error.invalidatedIds ?? []) revoked.add(id);
    }
  }
  if (failure) {
    failure.invalidatedIds = [...revoked];
    failure.completedRows = validRows.filter(row => !revoked.has(table.get(row[0])));
    throw failure;
  }
  // Do not mark a batch delivered until all of its records have been decoded.
  for (const id of current) seen.add(id);
  return result;
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
    if (target && !targets.has(canonical)) fail(`短标记 ${JSON.stringify(ref)} 是只读参考，不是本次目标；只交付“待处理文字”中的目标块，不返回参考文字。`);
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('未收到本次要求的交稿；请使用目标标记、完整正文与完成标记，不返回整包 JSON。');
  if (Object.keys(value).some(key => !['text', 'complete', 'reviewed', 'changes', 'questions', 'read', 'notes', 'remarks', 'decisions', 'terms', 'responseRepair'].includes(key))) fail('只按目标标记交付正文；可选资料单独放在附加信息区，不返回工程记录。');
  const primary = !wire.review && Array.isArray(value.text) ? textWireRecords(value.text, wire) : undefined;
  const result = { ...(primary ? { records: primary } : {}), ...(value.responseRepair ? { responseRepair: value.responseRepair } : {}) };
  let reviewAuxiliaryFailed = false;
  const auxiliary = action => {
    try { action(); }
    catch (error) {
      if (!primary?.length && !(wire.review && (value.complete === true || value.changes?.length || value.questions?.length || value.reviewed?.length))) throw error;
      reviewAuxiliaryFailed = wire.review;
      result.responseRepair = { code: 'INVALID_RESPONSE', message: [result.responseRepair?.message, `正文已保留，附加资料未采用：${error.message}`].filter(Boolean).join(' ') };
    }
  };
  const remarks = new Map();
  if (value.remarks !== undefined) auxiliary(() => {
    if (!Array.isArray(value.remarks)) fail('逐条备注需要使用 [短标记,备注] 列表。');
    const rows = new Map(), delivered = new Set((wire.review ? value.changes ?? [] : value.text ?? []).map(row => row?.[0]));
    for (const row of value.remarks) {
      if (!Array.isArray(row) || row.length !== 2 || row.some(item => typeof item !== 'string' || !item.trim())) fail('每项备注需要短标记和非空说明。');
      const unitId = id(row[0], true);
      if (!delivered.has(row[0]) || rows.has(unitId)) fail('备注只附给本次实际交付的正文，每项一次。');
      rows.set(unitId, row[1]);
    }
    for (const [unitId, note] of rows) remarks.set(unitId, note);
    for (const record of primary ?? []) if (remarks.has(record.id)) record.notes = remarks.get(record.id);
  });
  if (value.notes !== undefined) auxiliary(() => {
    if (typeof value.notes !== 'string') fail('累计阅读笔记需要文字。');
    result.readingNotes = value.notes;
  });
  if (value.read !== undefined) auxiliary(() => {
    if (!Array.isArray(value.read)) fail('read 需要查询列表。');
    result.evidenceRequests = value.read.map(query => {
      if (!query || typeof query !== 'object' || Array.isArray(query)) fail('查询需要原文或场景入口。');
      const { reason = '', ...spec } = query;
      return { query: decode(spec), reason };
    });
  });
  if (value.decisions !== undefined) auxiliary(() => {
    if (!Array.isArray(value.decisions)) fail('语义决定需要列表。');
    result.semanticDecisions = value.decisions.map(decision => {
      if (!decision || typeof decision !== 'object' || Object.keys(decision).some(key => !['ref', 'entity', 'sense', 'scope', 'translation', 'evidenceIds', 'equivalence', 'status'].includes(key))) fail('语义决定只包含含义、适用文字和证据；工程身份由软件保存。');
      const { ref, ...body } = decision, decoded = decode(body), previous = (wire.payload.preparation ?? []).find(item => table.get(ref) === item.id);
      if (ref !== undefined && !previous) fail('要修订的语义决定短标记不存在。');
      return { ...decoded, id: previous?.id ?? `meaning-${createHash('sha256').update(JSON.stringify([decoded.entity, decoded.sense, decoded.scope])).digest('hex').slice(0, 24)}`,
        expectedRevision: previous?.revision ?? 0 };
    });
  });
  if (wire.review && !result.evidenceRequests?.length) {
    const changes = value.changes === undefined ? [] : value.changes;
    const questions = value.questions === undefined ? [] : value.questions;
    if (!Array.isArray(changes) || !Array.isArray(questions)) fail('校对修改和疑点需要可定位的列表。');
    const explicit = value.complete === true && !value.responseRepair && !reviewAuxiliaryFailed;
    const reviewedRefs = explicit ? wire.state.entries.filter(([, key]) => targets.has(key)).map(([ref]) => ref)
      : Array.isArray(value.reviewed) ? value.reviewed : [...new Set([...changes, ...questions].map(row => row?.[0]))];
    if (!explicit && !Array.isArray(value.reviewed) && !reviewedRefs.length) fail('校对尚未明确完成，请在审完本批后独占一行返回完成标记。');
    const reviewedIds = reviewedRefs.map(ref => id(ref, true));
    if (!explicit && !Array.isArray(value.reviewed)) result.responseRepair ??= { code: 'INVALID_RESPONSE', message: '本批尚未明确审完，仅保留已明确处理的条目，其余文字未确认。' };
    if (Array.isArray(value.reviewed) && !allowPartialReview && (new Set(reviewedIds).size !== reviewedIds.length || reviewedIds.length !== targets.size)) fail('校对需要恰好覆盖本批全部文字。');
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
      if (!Array.isArray(row) || row.length < 2 || row.length > 4 || row.slice(0, 2).some(item => typeof item !== 'string')
          || row[2] !== undefined && (typeof row[2] !== 'string' || !row[2].trim())
          || row[3] != null && typeof row[3] !== 'string') fail('校对修改需要短标记和完整改文；说明与备注可以省略。');
      if (changed.has(unitId)) fail('同一文字不能重复修改。'); changed.add(unitId);
      issues.push({ unitId, kind: 'correction', message: row[2] ?? '校对已修改本条译文，模型未附修改说明。', resolution: 'fixed' });
      return { id: unitId, translation: row[1], ...(remarks.has(unitId) ? { notes: remarks.get(unitId) } : row[3] != null ? { notes: row[3] } : {}) };
    })).filter(Boolean);
    for (const row of questions) entry(row, unitId => {
      if (!Array.isArray(row) || row.length !== 3 || !['needs_evidence', 'source_ambiguity'].includes(row[1]) || typeof row[2] !== 'string') fail('疑点使用 [短标记,needs_evidence或source_ambiguity,说明]。');
      issues.push({ unitId, kind: row[1], message: row[2], resolution: row[1] === 'needs_evidence' ? 'open' : 'retained' });
    });
    result.records = []; result.review = { protocol: 'pinhao-review-1', reviewedIds, edits, issues,
      ...(invalidEntries.length ? { invalidEntries } : {}) };
  } else result.records ??= textWireRecords(value.text ?? (result.evidenceRequests?.length ? [] : undefined), wire);
  attachTermChoices(value.terms, result, wire);
  return result;
}
