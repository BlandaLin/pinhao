const fail = (message, details = {}) => { throw Object.assign(new Error(message), { code: 'INVALID_RESPONSE', ...details }); };
const normalFinish = reason => reason === 'stop';
const auxiliaryKeys = new Set(['read', 'notes', 'remarks', 'decisions', 'terms', 'questions']);

/** One recognizer serves response parsing and source-marker collision negotiation. */
export function readTextBlockMarker(content, markerDepth = 1) {
  const left = '['.repeat(markerDepth), right = ']'.repeat(markerDepth);
  const line = content.replace(/^[ \t]+/, '');
  if (!line.startsWith(left)) return;
  const end = line.indexOf(right, left.length);
  if (end < 0) return;
  const marker = line.slice(left.length, end), tail = line.slice(end + right.length);
  if (!marker || /[\[\]]/.test(marker)) return;
  if (!tail || /^[ \t]+$/.test(tail)) return { marker };
  if (/^[ \t]/.test(tail) && (/^u[1-9]\d*$/.test(marker) || marker === '完成' || marker === '附加信息')) {
    return { marker, body: tail.slice(1) };
  }
}

function blockReader({ markerDepth = 1 } = {}) {
  if (!Number.isSafeInteger(markerDepth) || markerDepth < 1 || markerDepth > 32) fail('文字标记的括号层数需要是 1 至 32 的整数。');
  let pending = '', searched = 0, first = true, finished = false, current, body = [];
  let wrapper, wrapperClosed = false, started = false, completed = false, auxiliary = false, auxiliaryEnded = false;
  let auxiliaryDepth = 0, auxiliaryQuoted = false, auxiliaryEscaped = false;
  const seen = new Set(), auxiliaryParts = [];
  const errors = [], invalidated = new Set();
  let protocolStarted = false, competing = false, wrapperTail = false, unframedPrefix = false;
  const diagnose = (message, refs = []) => { errors.push(message); for (const ref of refs) invalidated.add(ref); };
  const appendAuxiliary = text => {
    auxiliaryParts.push(text);
    // Track JSON boundaries incrementally; tuple lines inside the object are data, not text tags.
    // JSON.parse below remains responsible for validating the complete optional object.
    for (const char of text) {
      if (auxiliaryQuoted) {
        if (auxiliaryEscaped) auxiliaryEscaped = false;
        else if (char === '\\') auxiliaryEscaped = true;
        else if (char === '"') auxiliaryQuoted = false;
      } else if (char === '"') auxiliaryQuoted = true;
      else if (char === '{' || char === '[') auxiliaryDepth++;
      else if (char === '}' || char === ']') auxiliaryDepth = Math.max(0, auxiliaryDepth - 1);
    }
  };
  const preserve = (error, rows) => {
    error.completedRows = rows.filter(row => !error.invalidatedRefs?.includes(row[0]));
    throw error;
  };
  const close = (rows, explicitBoundary = true) => {
    if (current === undefined) return;
    let text = body.join('');
    // Empty separator lines belong to an explicit frame, not the preceding translation.
    text = text.replace(explicitBoundary ? /\r?\n(?:[ \t]*\r?\n)*$/ : /\r?\n$/, '');
    rows.push([current, text]); current = undefined; body = [];
  };
  const line = (content, ending, rows) => {
    const trimmed = content.replace(/^[ \t]+|[ \t]+$/g, '');
    if (wrapperClosed) {
      if (!trimmed) return;
      // Continue scanning after the wrapper: a second delivery must never hide duplicates.
    }
    if (!started && !trimmed) return;
    if (!started) {
      started = true;
      const fence = /^(```|~~~)(?:text|plaintext)?$/i.exec(trimmed);
      if (fence) { wrapper = fence[1]; return; }
    }
    if (!protocolStarted && !wrapper && /^(```|~~~)(?:text|plaintext)?$/i.test(trimmed)) { wrapper = trimmed.slice(0, 3); return; }
    if (wrapper && trimmed === wrapper) { wrapperClosed = true; return; }
    const header = auxiliary && !auxiliaryEnded && (auxiliaryDepth || auxiliaryQuoted) ? undefined
      : readTextBlockMarker(content, markerDepth);
    const marker = header?.marker;
    if (marker !== undefined) {
      if (/^u[1-9]\d*$/.test(marker)) {
        protocolStarted = true;
        if (completed || auxiliary || wrapperClosed) {
          competing = true;
          diagnose('完成标记或附加信息之后不能再返回正文。');
        }
        if (seen.has(marker)) {
          close(rows);
          diagnose('同一文字标记不能重复返回；对应条目需要重新确认。', [marker]);
          current = marker;
          if (header.body !== undefined) body.push(header.body + ending);
          return;
        }
        close(rows);
        seen.add(marker); current = marker;
        if (header.body !== undefined) body.push(header.body + ending);
        return;
      }
      if (header.body !== undefined) {
        current = undefined; body = [];
        diagnose('完成标记和附加信息标记必须独占一行。'); return;
      }
      if (marker === '\u5b8c\u6210') {
        protocolStarted = true;
        if (completed) diagnose('完成标记不能重复返回。');
        close(rows); completed = true; auxiliaryEnded = auxiliary; return;
      }
      if (marker === '\u9644\u52a0\u4fe1\u606f') {
        protocolStarted = true;
        if (auxiliary) diagnose('附加信息只能返回一段。');
        close(rows); auxiliary = true; return;
      }
      current = undefined; body = [];
      diagnose('返回了未知的独立标记；请只使用本次材料提供的文字标记和协议分隔标记。');
      return;
    }
    if (wrapperClosed) { if (trimmed) wrapperTail = true; return; }
    if (auxiliary && !auxiliaryEnded) appendAuxiliary(content + ending);
    else if (current !== undefined) body.push(content + ending);
    else if (trimmed) {
      if (protocolStarted) diagnose('正文块之外不能附加说明文字；请按文字标记分块返回。');
      else unframedPrefix = true;
    }
  };
  const push = chunk => {
    if (finished) fail('文字接收已经结束，不能继续追加。');
    if (typeof chunk !== 'string') fail('文字块需要使用文本返回。');
    if (first && chunk.length) { first = false; chunk = chunk.replace(/^\uFEFF/, ''); }
    pending += chunk;
    const rows = [];
    let offset = 0, end;
    try {
      while ((end = pending.indexOf('\n', searched)) !== -1) {
        const crlf = end > offset && pending[end - 1] === '\r';
        line(pending.slice(offset, crlf ? end - 1 : end), crlf ? '\r\n' : '\n', rows);
        offset = end + 1; searched = offset;
      }
    } catch (error) { preserve(error, rows); }
    pending = pending.slice(offset); searched = pending.length;
    return rows;
  };
  const finish = ({ finishReason } = {}) => {
    if (finished) fail('文字接收已经结束，不能重复结束。');
    const rows = [];
    try {
      if (pending.length) line(pending, '', rows);
      pending = ''; finished = true;
      if (normalFinish(finishReason)) {
        if (wrapper && !wrapperClosed) diagnose('包裹正文的代码围栏尚未闭合。');
        // Bare EOF removes one EOL only; a normally closed wrapper is an explicit frame.
        close(rows, wrapperClosed);
      } else { current = undefined; body = []; }
      if (!protocolStarted && (started || errors.length)) diagnose('没有找到合法文字协议区。');
      if (competing) for (const ref of seen) invalidated.add(ref);
      if (errors.length) fail([...new Set(errors)].join(' '), { invalidatedRefs: [...invalidated] });
    } catch (error) { preserve(error, rows); }
    return rows;
  };
  return { push, finish, get completed() { return completed; }, get auxiliary() { return auxiliary; },
    get auxiliaryText() { return auxiliaryParts.join(''); }, get wrapperTail() { return wrapperTail; },
    get unframedPrefix() { return unframedPrefix; } };
}

/** Only a following protocol marker closes a streamed block before a normal final EOF. */
export function textBlockScanner(options = {}) {
  const reader = blockReader(options);
  const scan = chunk => reader.push(chunk);
  scan.final = options => reader.finish(options);
  return scan;
}

/** Parse plain short-tag blocks without interpreting text as JSON or guessing missing IDs. */
export function parseTextBlocks(raw, { finishReason, review = false, markerDepth = 1 } = {}) {
  const reader = blockReader({ markerDepth });
  const rows = [];
  let failure;
  try {
    rows.push(...reader.push(raw));
    rows.push(...reader.finish({ finishReason }));
  }
  catch (error) {
    error.completedRows = [...rows, ...(error.completedRows ?? [])].filter(row => !error.invalidatedRefs?.includes(row[0]));
    rows.splice(0, rows.length, ...error.completedRows);
    failure = error;
  }
  const result = review ? { complete: reader.completed && normalFinish(finishReason), changes: rows, questions: [] } : { text: rows };
  const warnings = [];
  const warn = message => { warnings.push(message); if (review) result.complete = false; };
  if (!normalFinish(finishReason)) warn('模型未正常结束；已保留完整条目，未接纳尚未闭合的最后一块。');
  if (review && (reader.unframedPrefix || reader.wrapperTail)) warn('校对回复含未编号内容，不能确认整批已审阅；已保留合法改文，请仅按目标标记交付修改或单独确认完成。');
  if (reader.auxiliary) {
    let auxiliary;
    try { auxiliary = JSON.parse(reader.auxiliaryText); }
    catch { warn('附加信息不是完整的 JSON 对象；有效正文已保留。'); }
    if (auxiliary !== undefined) {
      if (!auxiliary || typeof auxiliary !== 'object' || Array.isArray(auxiliary)) {
        warn('附加信息需要使用 JSON 对象；有效正文已保留。');
      } else {
        for (const [key, value] of Object.entries(auxiliary)) {
          if (!auxiliaryKeys.has(key)) { warn('已忽略不支持的附加字段，不将其作为正文或完成确认。'); continue; }
          if (key === 'questions') {
            if (!Array.isArray(value)) { warn('校对疑点需要使用列表，不能据此确认全批已审阅。'); continue; }
            const questions = value.filter(row => {
              const valid = Array.isArray(row) && row.length === 3 && typeof row[0] === 'string'
                && ['needs_evidence', 'source_ambiguity'].includes(row[1]) && typeof row[2] === 'string' && Boolean(row[2].trim());
              if (!valid) warn('校对疑点格式有误，不能确认全批已审阅。');
              return valid;
            });
            result.questions = questions;
          } else if (key === 'notes' && typeof value !== 'string'
            || ['read', 'decisions'].includes(key) && !Array.isArray(value)) {
            warn('格式有误的附加信息已忽略；有效正文已保留。');
          } else result[key] = value;
        }
      }
    }
  }
  if (review && !reader.completed) warn('校对需要独占一行的完成标记，才能确认全批已审阅。');
  if (warnings.length) result.responseRepair = { code: 'INVALID_RESPONSE', message: [...new Set(warnings)].join(' ') };
  if (reader.wrapperTail) result.responseWarnings = [{ code: 'RESPONSE_WRAPPER_TRAILING_PROSE', message: '正文围栏后另有说明文字；未将其作为译文。' }];
  if (failure) { failure.parsedResponse = result; throw failure; }
  return result;
}
