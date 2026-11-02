const fail = (message, details = {}) => { throw Object.assign(new Error(message), { code: 'INVALID_RESPONSE', ...details }); };
const normalFinish = reason => reason === 'stop';
const auxiliaryKeys = new Set(['read', 'notes', 'remarks', 'decisions', 'terms', 'questions']);

function blockReader({ markerDepth = 1 } = {}) {
  if (!Number.isSafeInteger(markerDepth) || markerDepth < 1 || markerDepth > 32) fail('文字标记的括号层数需要是 1 至 32 的整数。');
  const left = '['.repeat(markerDepth), right = ']'.repeat(markerDepth);
  let pending = '', searched = 0, first = true, finished = false, current, body = [];
  let wrapper, wrapperClosed = false, started = false, completed = false, auxiliary = false, auxiliaryEnded = false;
  const seen = new Set(), auxiliaryParts = [];
  const preserve = (error, rows) => {
    error.completedRows = rows.filter(row => !error.invalidatedRefs?.includes(row[0]));
    throw error;
  };
  const close = (rows, boundary = true) => {
    if (current === undefined) return;
    let text = body.join('');
    if (boundary) text = text.replace(/\r?\n$/, '');
    rows.push([current, text]); current = undefined; body = [];
  };
  const line = (content, ending, rows) => {
    const trimmed = content.replace(/^[ \t]+|[ \t]+$/g, '');
    if (wrapperClosed) {
      if (trimmed) fail('正文代码围栏结束后不能附加说明文字。');
      return;
    }
    if (!started && !trimmed) return;
    if (!started) {
      started = true;
      const fence = /^(```|~~~)(?:text|plaintext)?$/i.exec(trimmed);
      if (fence) { wrapper = fence[1]; return; }
    }
    if (wrapper && trimmed === wrapper) { wrapperClosed = true; return; }
    let marker;
    if (trimmed.startsWith(left) && trimmed.endsWith(right)) {
      const inner = trimmed.slice(left.length, -right.length);
      if (inner && !/[\[\]]/.test(inner)) marker = inner;
    }
    if (marker !== undefined) {
      if (/^u[1-9]\d*$/.test(marker)) {
        if (seen.has(marker)) {
          close(rows);
          fail('同一文字标记不能重复返回；对应条目需要重新确认。', { invalidatedRefs: [marker] });
        }
        if (completed || auxiliary) fail('完成标记或附加信息之后不能再返回正文。');
        close(rows);
        seen.add(marker); current = marker; return;
      }
      if (marker === '\u5b8c\u6210') {
        if (completed) fail('完成标记不能重复返回。');
        close(rows); completed = true; auxiliaryEnded = auxiliary; return;
      }
      if (marker === '\u9644\u52a0\u4fe1\u606f') {
        if (auxiliary) fail('附加信息只能返回一段。');
        close(rows); auxiliary = true; return;
      }
      fail('返回了未知的独立标记；请只使用本次材料提供的文字标记和协议分隔标记。');
    }
    if (auxiliary && !auxiliaryEnded) auxiliaryParts.push(content + ending);
    else if (current !== undefined) body.push(content + ending);
    else if (trimmed) fail('正文块之外不能附加说明文字；请按文字标记分块返回。');
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
        if (wrapper && !wrapperClosed) fail('包裹正文的代码围栏尚未闭合。');
        // One terminal EOL is framing, including at a clean bare EOF; extra EOLs remain text.
        close(rows);
      } else { current = undefined; body = []; }
    } catch (error) { preserve(error, rows); }
    return rows;
  };
  return { push, finish, get completed() { return completed; }, get auxiliary() { return auxiliary; },
    get auxiliaryText() { return auxiliaryParts.join(''); } };
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
  try {
    rows.push(...reader.push(raw));
    rows.push(...reader.finish({ finishReason }));
  }
  catch (error) {
    error.completedRows = [...rows, ...(error.completedRows ?? [])].filter(row => !error.invalidatedRefs?.includes(row[0]));
    throw error;
  }
  const result = review ? { complete: reader.completed && normalFinish(finishReason), changes: rows, questions: [] } : { text: rows };
  const warnings = [];
  const warn = message => { warnings.push(message); if (review) result.complete = false; };
  if (!normalFinish(finishReason)) warn('模型未正常结束；已保留完整条目，未接纳尚未闭合的最后一块。');
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
  return result;
}
