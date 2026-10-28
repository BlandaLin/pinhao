import { createHash } from 'node:crypto';
import { toolModelMessageSchema } from 'ai';

// Pure projection limits use serialized UTF-16 code units, not token or financial budgets.
const MAX_OUTPUT = 96 * 1024; // per single model-visible tool result, in characters of serialized JSON
const MAX_CHECKPOINT = 24000; // persisted conversation checkpoints keep their previous ceiling
const RECEIPT_RESERVE = 800; // continuation/view added after the content projection
const MAX_STRING = 64 * 1024;
const MAX_ARRAY = 500;
const MAX_KEYS = 80;
const SIBLING_RESERVE = 4096; // keeps room for sibling fields behind one long string
const PAGED_FIELDS = new Set(['records', 'units', 'dynamicCandidates', 'nativeReviewIssues', 'unknownClusters', 'expressionCandidates', 'groups', 'items', 'files', 'fields']);
const NAVIGATION_FIELDS = new Set(['evidenceId', 'receiptId', 'occurrenceId', 'schema', 'file', 'pointer', 'directory', 'root', 'sourceIndex', 'sourceCount', 'query', 'matchMode', 'mode', 'route', 'relativePath',
  'offset', 'nextOffset', 'readResult', 'nextCall', 'nextPage', 'sourcePage', 'fieldCursors', 'fieldCounts', 'total', 'dynamicTotal', 'nativeReviewTotal', 'unknownTotal', 'expressionTotal', 'totalFields',
  'outputTruncated', 'checkpointTruncated', 'pageCandidateIds', 'resolvedLocation', 'readCall', 'corrections', 'sourceRef', 'workRef',
  'runId', 'stream', 'captureGeneration', 'captureStatus', 'sourcePage', 'view', 'status', 'exitCode', 'error', 'errorCode']);

const capacityError = (message, details) => Object.assign(new Error(message), { code: 'CONTEXT_CAPACITY_BLOCKED', details });
const pointerOnly = (original, summary) => {
  const result = { outputTruncated: true, projectionVersion: 2, summary,
    ...Object.fromEntries(['evidenceId', 'receiptId', 'occurrenceId', 'nativeResultId', 'acceptedNativeResultId', 'schema', 'status', 'exitCode',
      'error', 'errorCode', 'runId', 'stream', 'captureGeneration', 'captureStatus', 'resolvedLocation', 'sourceRef', 'workRef', 'sourcePage', 'corrections',
      'pointer', 'offset', 'offsetUnit', 'nextOffset', 'nextCall', 'readResult', 'view'].filter(key => original?.[key] !== undefined).map(key => [key, original[key]])) };
  if (original?.evidenceId) {
    result.readResult ??= { tool: 'read_evidence', input: { evidenceId: original.evidenceId,
      ...(original.receiptId || original.occurrenceId ? { occurrenceId: original.occurrenceId ?? original.receiptId } : {}) } };
    result.summary = summary ?? '完整工具结果已保存，可从本地证据继续读取。';
  } else result.summary = '此预览未包含完整正文；没有已保存证据时请重新读取原工具，不能视为已归档。';
  if (typeof original?.content === 'string' && original.evidenceId) { result.content = ''; projectContentNavigation(original, result, {}); }
  return result;
};

function projectContentNavigation(original, page, input) {
  if (typeof original?.content !== 'string' || typeof page?.content !== 'string' || !original.evidenceId) return;
  const isEvidencePage = original.offsetUnit === 'utf16', start = isEvidencePage ? original.offset ?? input.offset ?? 0 : original.view?.offset ?? 0;
  const total = original.totalCharacters ?? original.view?.totalCharacters ?? original.content.length;
  const end = start + page.content.length;
  if (end >= total && !original.outputTruncated) return;
  page.view = { pointer: isEvidencePage ? original.pointer ?? '/content' : '/content', offsetUnit: 'utf16', offset: start,
    returnedCharacters: page.content.length, totalCharacters: total };
  page.nextCall = { tool: 'read_evidence', input: { ...(original.readResult?.tool === 'read_evidence' ? original.readResult.input : {}), evidenceId: original.evidenceId,
    ...(original.receiptId || original.occurrenceId ? { occurrenceId: original.occurrenceId ?? original.receiptId } : {}),
    pointer: page.view.pointer, offset: end, length: 2000 } };
  if (original.schema === 'pinhao-process-log-page-2') {
    delete page.nextCursor; delete page.nextOffset; delete page.returnedBytes;
  } else if (isEvidencePage) page.nextOffset = end;
}

/** Keep the first identical result body; repeated history entries retain a resolvable local receipt. */
export function deduplicateToolMessages(messages) {
  const seen = new Map(), validations = new Map(), inputs = new Map();
  for (const message of messages) if (Array.isArray(message.content)) for (const part of message.content) {
    if (part.type === 'tool-call') inputs.set(part.toolCallId, part.input);
  }
  return messages.map(message => message.role !== 'tool' || !Array.isArray(message.content) ? message : { ...message, content: message.content.map(part => {
    const wrapped = part.output?.type === 'json';
    let value = wrapped ? part.output.value : part.output;
    if (part.type !== 'tool-result' || !/^evidence-[a-f0-9]{64}$/.test(value?.evidenceId ?? '')) return part;
    const readInput = part.toolName === 'read_evidence' ? { ...value.readResult?.input, ...inputs.get(part.toolCallId),
      evidenceId: value.evidenceId,
      pointer: inputs.get(part.toolCallId)?.pointer ?? value.pointer ?? value.readResult?.input?.pointer ?? '',
      offset: inputs.get(part.toolCallId)?.offset ?? value.offset ?? value.readResult?.input?.offset ?? 0 } : { evidenceId: value.evidenceId };
    if (value.resultRepeated) {
      if (part.toolName !== 'read_evidence') return part;
      const reference = { ...value, pointer: readInput.pointer, readResult: { tool: 'read_evidence', input: readInput } };
      return { ...part, output: wrapped ? { ...part.output, value: reference } : reference };
    }
    if (part.toolName === 'validate_adapter' && value.validationId) validations.set(value.validationId, value);
    if (part.toolName === 'submit_recipe' && value.validation) {
      const previous = validations.get(value.validation.validationId);
      if (previous && Object.entries(value.validation).every(([key, item]) => JSON.stringify(previous[key]) === JSON.stringify(item))) {
        const { sample, evidence, dependencies, ...conclusion } = value.validation;
        value = { ...value, validation: { ...conclusion, evidenceId: previous.evidenceId,
          readResult: { tool: 'read_evidence', input: { evidenceId: previous.evidenceId } } } };
        part = { ...part, output: wrapped ? { ...part.output, value } : value };
      }
    }
    // Occurrence identity differs per call; it is not part of the content-addressed result body.
    const { cached, receiptId, occurrenceId, ...body } = value;
    const key = createHash('sha256').update(JSON.stringify([part.toolName, body])).digest('hex');
    if (!seen.has(key)) { seen.set(key, part.toolCallId); return part; }
    const previous = seen.get(key);
    const reference = { evidenceId: value.evidenceId, ...(receiptId ? { receiptId } : {}), ...(occurrenceId ? { occurrenceId } : {}), resultRepeated: true, originalTool: part.toolName,
      sameResultAs: previous,
      ...(inputs.has(previous) && inputs.has(part.toolCallId) ? { sameInput: JSON.stringify(inputs.get(previous)) === JSON.stringify(inputs.get(part.toolCallId)) } : {}),
      notice: `工具输出内容相同，不代表查询或参数相同；本次请求身份保持不变，可复用原结果。${value.notice ?? ''}`,
      ...(typeof value.content === 'boolean' ? { content: value.content } : {}),
      ...Object.fromEntries(['query', 'matchMode', 'mode', 'route', 'relativePath', 'sourceIndex', 'pointer', 'directory', 'offset', 'nextOffset', 'nextCall', 'nextPage', 'sourcePage', 'view', 'runId', 'stream', 'captureGeneration', 'captureStatus', 'resolvedLocation', 'fieldCursors', 'partial', 'skipped']
        .filter(field => value[field] !== undefined).map(field => [field, value[field]])),
      readResult: { tool: 'read_evidence', input: readInput },
      ...(value.error ? { error: value.error } : {}), ...(value.nextAction ? { nextAction: value.nextAction } : {}) };
    return { ...part, output: wrapped ? { ...part.output, value: reference } : reference };
  }) });
}

/** Only archive observations that are not already fully represented in the retained tool history. */
export function supplementalObservations(observations, messages, indexInput = input => input) {
  const calls = new Map(), visible = new Map();
  for (const message of messages) if (Array.isArray(message.content)) for (const part of message.content) {
    if (part.type === 'tool-call') calls.set(part.toolCallId, part);
    const value = part.output?.type === 'json' ? part.output.value : part.output;
    const call = calls.get(part.toolCallId);
    const input = call?.input ?? {}, indexedInput = indexInput(input);
    const completeInput = input && typeof input === 'object' && !Array.isArray(input)
      && Object.values(input).every(item => item === null || ['string', 'number', 'boolean'].includes(typeof item))
      && JSON.stringify(indexedInput) === JSON.stringify(input);
    if (message.role === 'tool' && part.type === 'tool-result' && part.toolName !== 'read_evidence' && value?.evidenceId
        && call?.toolName === part.toolName && completeInput && !value.outputTruncated && !value.checkpointTruncated && !value.resultRepeated) {
      visible.set(`${part.toolName}:${value.evidenceId}`, JSON.stringify(indexedInput));
    }
  }
  return observations.filter(item => visible.get(`${item.tool}:${item.evidenceId}`) !== JSON.stringify(item.input ?? {}));
}

/** Apply the same boundary to live SDK results and persisted tool checkpoints. */
export function boundedToolOutput(output, options) {
  const { input = {}, maxCharacters } = options ?? {};
  const wrapped = ['json', 'error-json'].includes(output?.type);
  const original = wrapped ? output.value : output;
  const envelope = value => wrapped ? { ...output, value } : value;
  if (maxCharacters !== undefined && (!Number.isSafeInteger(maxCharacters) || maxCharacters < 0)) throw new RangeError('maxCharacters must be a non-negative integer in serialized UTF-16 code units');
  const budget = maxCharacters ?? (options === undefined ? MAX_CHECKPOINT : MAX_OUTPUT);
  if (budget === 0) {
    if (['text', 'error-text'].includes(output?.type)) return { ...output, value: '' };
    if (['content', 'execution-denied'].includes(output?.type)) return output;
    return envelope(pointerOnly(original));
  }
  if (original?.projectionVersion === 2 && JSON.stringify(output).length <= budget) return output;
  if (['text', 'error-text'].includes(output?.type) && typeof output.value === 'string') {
    const available = Math.max(0, budget - JSON.stringify({ ...output, value: '' }).length - 2);
    let low = 0, high = Math.min(MAX_STRING, output.value.length, available);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (JSON.stringify({ ...output, value: output.value.slice(0, middle) }).length <= budget) low = middle;
      else high = middle - 1;
    }
    let value = output.value.slice(0, low);
    if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
    return { ...output, value };
  }
  // Non-JSON SDK payloads may contain typed media/approval metadata, not arbitrary record previews.
  if (['content', 'execution-denied'].includes(output?.type)) return output;
  const wrapperSize = wrapped ? JSON.stringify({ ...output, value: null }).length : 0;
  // Navigation is a contract, not preview content: do not consume it after long result arrays.
  const navigation = Object.fromEntries(Object.entries(original ?? {}).filter(([key, value]) => NAVIGATION_FIELDS.has(key) || key === 'content' && typeof value === 'boolean'));
  const body = original && typeof original === 'object' && !Array.isArray(original)
    ? Object.fromEntries(Object.entries(original).filter(([key]) => !Object.hasOwn(navigation, key))) : original;
  const reserve = typeof original?.content === 'string' ? RECEIPT_RESERVE : Math.min(4000, Math.floor(budget / 2));
  let remaining = Math.max(0, budget - wrapperSize - reserve - JSON.stringify(navigation).length), truncated = false;
  const maxDepth = original?.schema === 'pinhao-native-field-review-v1' ? 9 : 6;
  const copy = (value, depth = 0, wholeItems = false) => {
    if (remaining <= 0 || depth > maxDepth) { truncated = true; return '[记录已省略，可分页读取]'; }
    if (typeof value === 'string') {
      const limit = Math.min(MAX_STRING, Math.max(0, remaining - Math.min(SIBLING_RESERVE, Math.floor(remaining / 8))));
      let text = value.slice(0, limit);
      if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
      remaining -= JSON.stringify(text).length;
      if (text.length < value.length) truncated = true;
      return text;
    }
    if (Array.isArray(value)) {
      const items = [];
      for (const item of value.slice(0, MAX_ARRAY)) {
        const candidate = wholeItems && (typeof item?.id === 'string' && (item.locator || item.target || item.path)
          || typeof item?.pointer === 'string' && item.read?.tool === 'read_evidence');
        if (remaining < 200 || candidate && JSON.stringify(item).length > remaining - 200) { truncated = true; break; }
        items.push(copy(item, depth + 1));
      }
      if (items.length < value.length) truncated = true;
      remaining -= 2 + items.length;
      return items;
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value), result = {};
      for (const [key, item] of entries.slice(0, MAX_KEYS)) {
        if (remaining < key.length + 100) { truncated = true; break; }
        remaining -= JSON.stringify(key).length + 2; result[key] = copy(item, depth + 1, depth === 0 && PAGED_FIELDS.has(key));
      }
      if (Object.keys(result).length < entries.length) truncated = true;
      return result;
    }
    remaining -= String(value).length;
    return value;
  };
  const copied = copy(body);
  const objectBody = original && typeof original === 'object' && !Array.isArray(original);
  const page = objectBody ? { ...(copied && typeof copied === 'object' && !Array.isArray(copied) ? copied : {}), ...navigation } : copied;
  if (objectBody && typeof original.content === 'string' && typeof page.content !== 'string') page.content = '';
  if (page && typeof page === 'object' && !Array.isArray(page)) {
    if (original?.route !== undefined) page.route = original.route;
    if (truncated) { page.outputTruncated = true; page.projectionVersion = 2; page.guidance = '使用 evidenceId 与 read_evidence 补读完整字段；原工具也可按最终返回的游标继续读取。'; }
    const arrayFields = Object.entries(original ?? {}).filter(([, value]) => Array.isArray(value));
    const counts = Object.fromEntries(arrayFields.filter(([key, value]) => value.length > (page[key]?.length ?? 0))
      .map(([key, value]) => [key, Math.max(value.length, original.fieldCounts?.[key] ?? 0)]));
    if (Object.keys(counts).length) page.fieldCounts = { ...original.fieldCounts, ...counts };
    const pagedArrays = arrayFields.filter(([key]) => PAGED_FIELDS.has(key));
    if (pagedArrays.length) {
      const sourceNavigation = ['content', 'path'].includes(original.mode) && typeof original.content === 'boolean';
      page.fieldCursors = { ...original.fieldCursors, ...Object.fromEntries(pagedArrays.map(([key, values]) => {
        const snapshotItems = sourceNavigation && key === 'items';
        const prior = original.fieldCursors?.[key];
        const offset = snapshotItems ? 0 : original.offset ?? prior?.offset ?? input.offset ?? 0, delivered = page[key]?.length ?? 0;
        const total = key === 'nativeReviewIssues' ? original.nativeReviewTotal : key === 'dynamicCandidates' ? original.dynamicTotal : key === 'unknownClusters' ? original.unknownTotal : key === 'expressionCandidates' ? original.expressionTotal : key === 'fields' ? original.totalFields : ['records', 'units', 'items', 'groups'].includes(key) ? original.total : undefined;
        const snapshotSize = Math.max(values.length, original.fieldCounts?.[key] ?? 0);
        const more = snapshotItems ? delivered < snapshotSize || prior?.nextOffset != null : Number.isSafeInteger(total) ? offset + delivered < total
          : delivered < snapshotSize || prior?.nextOffset != null || original.nextOffset != null;
        return [key, { offset, returned: delivered, nextOffset: more ? offset + delivered : null }];
      })) };
      const continuations = Object.values(page.fieldCursors).map(item => item.nextOffset).filter(item => item !== null);
      if (sourceNavigation) {
        page.nextOffset = original.nextOffset;
        if (original.nextCall) page.nextCall = original.nextCall;
      } else if (continuations.length) page.nextOffset = Math.min(...continuations);
      if (original.nextPage?.tool && original.nextPage?.input) page.nextPage = page.nextOffset === null ? null
        : { tool: original.nextPage.tool, input: { ...original.nextPage.input, offset: page.nextOffset } };
      if (Object.keys(counts).length) page.checkpointTruncated = true;
    }
    if (Array.isArray(original?.dynamicCandidates) && page.dynamicCandidates?.length < original.dynamicCandidates.length) page.pageCandidateIds = original.pageCandidateIds
      ?? original.dynamicCandidates.slice(0, 100).map(item => String(item.id ?? '').slice(0, 200)).filter(Boolean);
    if (!original.evidenceId && original.schema !== 'pinhao-process-log-page-2' && typeof original?.content === 'string' && typeof page.content === 'string' && page.content.length < original.content.length && original.offsetUnit !== 'utf16') {
      const bytes = original.encoding === 'base64' ? Math.floor(page.content.length / 4) * 3 : Buffer.byteLength(page.content);
      if (original.encoding === 'base64') page.content = page.content.slice(0, Math.floor(page.content.length / 4) * 4);
      page.nextOffset = (original.offset ?? input.offset ?? 0) + bytes;
      page.returnedBytes = bytes;
    }
    if (original.offsetUnit === 'utf16' && typeof page.content === 'string' && page.content.length < original.content.length) page.nextOffset = (original.offset ?? input.offset ?? 0) + page.content.length;
    const evidenceRead = original.readResult?.tool === 'read_evidence' ? original.readResult : original.nextCall;
    if (evidenceRead?.tool === 'read_evidence') page.nextCall = page.nextOffset == null ? null
      : { ...evidenceRead, input: { ...evidenceRead.input, offset: page.nextOffset } };
    projectContentNavigation(original, page, input);
    if (typeof original?.code === 'string' && typeof page.code === 'string' && page.code.length < original.code.length) {
      page.codeOffset = original.codeOffset ?? input.offset ?? 0;
      page.nextCodeOffset = page.codeOffset + page.code.length;
      page.totalCodeCharacters = original.totalCodeCharacters ?? original.code.length;
    }
  }
  // Bounds also cover unusual externally supplied property names and escaped strings.
  const result = envelope(page);
  if (JSON.stringify(result).length > budget) {
    const minimal = envelope(pointerOnly(original));
    if (JSON.stringify(minimal).length > budget) throw capacityError('工具结果的必要状态与续读信息超过显示容量', { budget, minimumCharacters: JSON.stringify(minimal).length });
    return minimal;
  }
  return result;
}

/** Allocate one complete SDK call/result group without clocks or cross-session state. */
export function projectToolResultGroup(messages, { maxCharacters = 200000 } = {}) {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 0) throw new RangeError('Group capacity must be a non-negative integer');
  const calls = new Map(), results = new Map();
  for (const message of messages) for (const part of Array.isArray(message.content) ? message.content : []) {
    if (part.type === 'tool-call') {
      if (calls.has(part.toolCallId)) throw capacityError('工具调用身份重复', { reason: 'duplicate-call' });
      calls.set(part.toolCallId, part);
    }
    if (part.type === 'tool-result') {
      if (results.has(part.toolCallId)) throw capacityError('工具结果身份重复', { reason: 'duplicate-result' });
      results.set(part.toolCallId, part);
    }
  }
  if (calls.size !== results.size || [...calls].some(([id, call]) => results.get(id)?.toolName !== call.toolName)) {
    throw capacityError('工具调用组尚未完整配对，不能丢弃或伪造结果', { reason: 'incomplete-group' });
  }
  const projected = new Map([...results].map(([id, part]) => {
    const minimal = boundedToolOutput(part.output, { maxCharacters: 0 });
    return [id, { ...part, output: JSON.stringify(part.output).length <= JSON.stringify(minimal).length ? part.output : minimal }];
  }));
  const materialize = () => messages.map(message => !Array.isArray(message.content) ? message : { ...message,
    content: message.content.map(part => part.type === 'tool-result' ? projected.get(part.toolCallId) : part) });
  let current = materialize(), available = maxCharacters - JSON.stringify(current).length;
  if (available < 0) throw capacityError('完整调用参数与必要结果状态超过模型消息容量', { reason: 'minimum-envelope', budget: maxCharacters, minimumCharacters: JSON.stringify(current).length });
  const remaining = [...calls.keys()];
  while (remaining.length && available > 0) {
    const share = Math.max(1, Math.floor(available / remaining.length));
    let advanced = false;
    for (const id of [...remaining]) {
      const part = results.get(id), previous = projected.get(id), base = JSON.stringify(previous.output).length;
      let next;
      try { next = boundedToolOutput(part.output, { maxCharacters: Math.min(MAX_OUTPUT, base + share) }); }
      catch (error) { if (error.code !== 'CONTEXT_CAPACITY_BLOCKED') throw error; next = previous.output; }
      const spent = JSON.stringify(next).length - base;
      if (spent !== 0 && spent <= available) { projected.set(id, { ...part, output: next }); available -= spent; advanced = true; }
      if (JSON.stringify(next) === JSON.stringify(part.output) || spent <= 0 || base + share >= MAX_OUTPUT) remaining.splice(remaining.indexOf(id), 1);
    }
    if (!advanced) break;
  }
  current = materialize();
  if (JSON.stringify(current).length > maxCharacters) throw capacityError('序列化后的消息组超过模型容量', { reason: 'serialized-overflow', budget: maxCharacters });
  return current;
}

/** Rebuild damaged tool-result projections only from their complete, content-addressed local evidence. */
export async function restoreToolCheckpoint(conversation, evidence) {
  const calls = new Map(), restored = [];
  for (const group of conversation ?? []) {
    const messages = [];
    for (const message of group) {
      if (!Array.isArray(message.content)) { messages.push(message); continue; }
      const content = [];
      for (const part of message.content) {
        if (part.type === 'tool-call') calls.set(part.toolCallId, part);
        const previousValue = part.output?.type === 'json' ? part.output.value : part.output;
        const legacyLog = message.role === 'tool' && part.type === 'tool-result' && ['read_run', 'wait_run'].includes(part.toolName)
          && previousValue?.schema !== 'pinhao-process-log-page-2';
        if (message.role !== 'tool' || part.type !== 'tool-result'
            || !legacyLog && toolModelMessageSchema.safeParse({ ...message, content: [part] }).success) { content.push(part); continue; }
        const call = calls.get(part.toolCallId), evidenceId = previousValue?.evidenceId;
        if (legacyLog && !/^evidence-[a-f0-9]{64}$/.test(evidenceId ?? '')) {
          const value = { ...previousValue, legacyLogCoordinates: 'unknown', notice: '旧日志预览未保存可靠坐标；请按原进程编号重新读取，不要由正文长度推算源字节位置。' };
          delete value.nextCursor; delete value.nextOffset;
          value.nextCall = call ? { tool: 'read_run', input: { ...call.input, cursor: call.input?.cursor ?? 0 } } : null;
          content.push({ ...part, output: { type: 'json', value } }); continue;
        }
        if (!call || call.toolName !== part.toolName || !/^evidence-[a-f0-9]{64}$/.test(evidenceId ?? '')) {
          throw Object.assign(new Error('技术检查点工具结果无有效本地证据，已保留候选与验证进度'), { code: 'TECHNICAL_CHECKPOINT_EVIDENCE' });
        }
        let value;
        try {
          if (part.toolName === 'read_evidence') value = await evidence.read({ ...call.input, evidenceId });
          else {
            const record = await evidence.load(evidenceId);
            if (record.metadata?.tool !== part.toolName) throw new Error('工具证据来源不一致');
            value = { ...(record.value && typeof record.value === 'object' && !Array.isArray(record.value) ? record.value : { value: record.value }), evidenceId };
          }
        } catch (cause) {
          throw Object.assign(new Error('技术检查点的完整工具证据无法读取，已保留候选与验证进度', { cause }), { code: 'TECHNICAL_CHECKPOINT_EVIDENCE' });
        }
        if (previousValue?.receiptId) value = { ...value, receiptId: previousValue.receiptId };
        if (legacyLog) {
          value = { ...value, legacyLogCoordinates: 'unknown', notice: '旧日志证据可补读；原始字节页关系未补造。' };
          delete value.nextCursor; delete value.nextOffset;
          value.nextCall = { tool: 'read_evidence', input: { evidenceId, pointer: '/content', offset: 0 } };
        }
        const rebuilt = { ...part, output: boundedToolOutput({ type: 'json', value }) };
        if (!toolModelMessageSchema.safeParse({ ...message, content: [rebuilt] }).success) throw Object.assign(new Error('技术检查点工具证据无法投影为合法模型消息，已保留候选与验证进度'), { code: 'TECHNICAL_CHECKPOINT_EVIDENCE' });
        content.push(rebuilt);
      }
      messages.push({ ...message, content });
    }
    restored.push(messages);
  }
  return restored;
}
