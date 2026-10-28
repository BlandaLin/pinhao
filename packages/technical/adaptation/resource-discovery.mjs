import { RESOURCE_ROUTES, isTextSearchResource } from '../resource-routing.mjs';

const defaults = { pathFiles: 2000, contentFiles: 80, maxFileBytes: 8 * 1024 * 1024,
  maxContentBytes: 8 * 1024 * 1024, scanBytes: 32 * 1024 * 1024, maxMatches: 100, maxMatchesPerFile: 8 };
const matcher = (query, matchMode) => {
  if (!['literal', 'regex'].includes(matchMode)) throw new Error('matchMode 请选择 literal 或 regex');
  let pattern;
  try { pattern = new RegExp(matchMode === 'literal' ? query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : query, 'iu'); }
  catch { throw Object.assign(new Error('正则表达式无效，请修正 query 或改用 matchMode:"literal" 按原文查找'),
    { code: 'INVALID_SEARCH_PATTERN', nextAction: '修正正则语法，或显式使用 matchMode:"literal" 检索原文字符。' }); }
  return text => pattern.exec(text);
};
const characterBoundary = (text, offset) => offset > 0 && offset < text.length
  && /[\uDC00-\uDFFF]/.test(text[offset]) && /[\uD800-\uDBFF]/.test(text[offset - 1]) ? offset - 1 : offset;
const checkRoute = route => {
  if (route !== undefined && !RESOURCE_ROUTES.includes(route)) throw Object.assign(new Error('请选择有效的资源 route；省略表示全部类型'), { code: 'INVALID_RESOURCE_ROUTE' });
};

/** Shared discovery only; callers retain their own read receipts and admission rules. */
export function createResourceDiscovery({ list: listFiles, read, signal, limits = {}, root }) {
  const bounds = { ...defaults, ...limits };
  const list = async ({ relativePath = '', recursive = false, offset = 0, limit = 2000, ...input } = {}) => {
    checkRoute(input.route);
    if (typeof recursive !== 'boolean') throw new Error('recursive 必须明确为 true 或 false');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new Error('资源清单分页范围无效');
    const value = await listFiles({ ...input, relativePath: relativePath === '.' || relativePath === './' ? '' : relativePath, recursive, offset, limit });
    const address = row => ({ ...(root ? { root } : {}), ...(Number.isSafeInteger(row.sourceIndex ?? input.sourceIndex) ? { sourceIndex: row.sourceIndex ?? input.sourceIndex } : {}) });
    return { ...value, ...(root ? { root } : {}), files: value.files.map(row => ({ ...row, kind: row.kind ?? 'file',
      resolvedLocation: { ...address(row), relativeFile: row.path },
      ...(row.kind === 'directory' ? { browseCall: { tool: 'list_files', input: { ...address(row), relativePath: row.path, recursive: false } } }
        : { readCall: { tool: 'read_resource', input: { ...address(row), file: row.path, offset: 0, length: 65536 } } }) })), relativePath, recursive,
      ...(value.nextOffset == null ? {} : { nextCall: { tool: 'list_files', input: { ...input, ...(root ? { root } : {}), relativePath, recursive, offset: value.nextOffset, limit } } }),
      ...(input.route === undefined ? {} : { route: input.route }) };
  };
  const search = async ({ query, matchMode = 'literal', content, relativePath = '', sourceIndex, route, offset = 0, limit = 40 } = {}) => {
    checkRoute(route);
    if (typeof content !== 'boolean') throw new Error('请显式指定 content:false 检索路径，或 content:true 检索正文');
    if (typeof query !== 'string' || !query.length || query.length > 400 || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('资源检索参数无效');
    relativePath = relativePath === '.' || relativePath === './' ? '' : relativePath;
    const matches = matcher(query, matchMode), items = [], partial = [], skipped = { binary: 0, oversized: 0, unreadable: 0 };
    const page = await listFiles({ relativePath, sourceIndex, route, offset, limit: content ? bounds.contentFiles : bounds.pathFiles, recursive: true, allowFile: true });
    const maxItems = Math.min(limit, bounds.maxMatches);
    let scanned = offset, inspected = 0, bytesScanned = 0;
    for (const file of page.files) {
      if (items.length >= maxItems || (content && bytesScanned >= bounds.scanBytes)) break;
      signal?.throwIfAborted();
      scanned++;
      const location = { file: file.path, ...(Number.isSafeInteger(file.sourceIndex ?? sourceIndex) ? { sourceIndex: file.sourceIndex ?? sourceIndex } : {}) };
      if (!content) { if (matches(file.path)) items.push({ ...location, route: file.route, match: 'path',
        nextRead: { tool: 'read_resource', input: { ...(root ? { root } : {}), ...location, offset: 0, length: 65536 } } }); continue; }
      if (!isTextSearchResource(file.path)) { skipped.binary++; continue; }
      if (file.size > bounds.maxFileBytes) { skipped.oversized++; continue; }
      inspected++;
      let position = 0, consumed = 0, line = 1, found = 0, totalBytes = file.size, reason, binary = false;
      const emit = text => {
        const match = matches(text);
        if (!match) return;
        const start = characterBoundary(text, Math.max(0, match.index - Math.floor((500 - Math.min(match[0].length, 500)) / 2)));
        const end = characterBoundary(text, Math.min(text.length, start + 500));
        const snippetStartOffset = consumed + Buffer.byteLength(text.slice(0, start));
        items.push({ ...location, route: file.route, match: 'content', line, snippet: text.slice(start, end), snippetStartOffset,
          matchOffset: consumed + Buffer.byteLength(text.slice(0, match.index)), matchLengthBytes: Buffer.byteLength(match[0]),
          nextRead: { tool: 'read_resource', input: { ...(root ? { root } : {}), ...location, offset: snippetStartOffset, length: 65536 } } }); found++;
      };
      try {
        let pending = '';
        while (true) {
          const length = Math.min(262144, bounds.maxContentBytes - position, bounds.scanBytes - bytesScanned);
          if (length <= 0) {
            if (pending) { emit(pending); consumed += Buffer.byteLength(pending); }
            reason = bytesScanned >= bounds.scanBytes ? 'scan-byte-limit' : 'file-byte-limit'; break;
          }
          const data = await read({ ...location, offset: position, length, encoding: 'utf8' });
          const text = typeof data.content === 'string' ? data.content : '';
          totalBytes = data.totalBytes ?? totalBytes;
          const returned = data.returnedBytes ?? Buffer.byteLength(text);
          bytesScanned += returned;
          if (text.includes('\0')) { binary = true; break; }
          const lines = (pending + text).split('\n'); pending = lines.pop() ?? '';
          for (const current of lines) {
            emit(current); consumed += Buffer.byteLength(current + '\n'); line++;
            if (found >= bounds.maxMatchesPerFile || items.length >= maxItems) break;
          }
          if (found >= bounds.maxMatchesPerFile || items.length >= maxItems) {
            reason = items.length >= maxItems ? 'match-limit' : 'file-match-limit'; break;
          }
          if (data.nextOffset === null || (!Number.isSafeInteger(data.nextOffset) && position + returned >= totalBytes)) {
            if (pending) { emit(pending); consumed += Buffer.byteLength(pending); }
            break;
          }
          const next = data.nextOffset;
          if (!Number.isSafeInteger(next) || next <= position) { reason = 'non-advancing-read'; break; }
          position = next;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        skipped.unreadable++; reason = 'unreadable';
      }
      if (binary) skipped.binary++;
      else if (reason && consumed < totalBytes) partial.push({ ...location, reason, nextContentOffset: consumed, totalBytes,
        nextRead: { tool: 'read_resource', input: { ...(root ? { root } : {}), ...location, offset: consumed, length: 65536 } } });
    }
    const nextOffset = scanned < offset + page.files.length ? scanned : page.nextOffset ?? null;
    return { query, matchMode, content, mode: content ? 'content' : 'path', ...(root ? { root } : {}), relativePath, ...(sourceIndex === undefined ? {} : { sourceIndex }),
      ...(route === undefined ? {} : { route }),
      offset, items, inspected, bytesScanned, skipped, partial, nextOffset, truncated: nextOffset !== null || partial.length > 0,
      ...(nextOffset === null ? {} : { nextCall: { tool: 'search_files', input: { query, matchMode, content, ...(root ? { root } : {}), relativePath, ...(sourceIndex === undefined ? {} : { sourceIndex }), ...(route === undefined ? {} : { route }), offset: nextOffset, limit } } }),
      notice: '搜索命中是线索；partial列出尚未检索的正文，用nextRead补读。跳过的二进制仍可用read_resource的base64读取。' };
  };
  return { list, search };
}
