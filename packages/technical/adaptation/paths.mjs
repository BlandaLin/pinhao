import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, open, readFile } from 'node:fs/promises';
import { RESOURCE_ROUTES, resourceRoute } from '../resource-routing.mjs';

export function relativeFile(value, { directory = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\') || value.includes(':') || path.isAbsolute(value)) throw new Error('资源路径须使用项目内的相对路径');
  const parts = value.split('/');
  if ((!directory && !value) || parts.some(part => part === '..' || part === '.' || (!part && value !== '') || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('资源路径包含无效片段');
  return value;
}

export const inside = (root, file) => {
  const relative = path.relative(root, file);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

/** Every path component is checked: junctions and symlinks never become guest capabilities. */
export async function checkedPath(root, relative, { write = false, directory = false } = {}) {
  relativeFile(relative, { directory });
  root = path.resolve(root);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('适配目录须为普通文件夹');
  const canonical = await realpath(root);
  let current = root;
  for (const [index, part] of relative.split('/').filter(Boolean).entries()) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !inside(canonical, await realpath(current))) throw new Error('适配路径包含链接或越界定位');
      if (index < relative.split('/').length - 1 && !info.isDirectory()) throw new Error('资源父路径须为文件夹');
      if (write && info.isFile() && info.nlink > 1) throw new Error('适配输出须为独立文件');
    } catch (error) {
      if (error.code !== 'ENOENT' || !write) throw error;
    }
  }
  return current;
}

export async function ensureRoot(directory) {
  directory = path.resolve(directory);
  const parent = path.dirname(directory);
  if (parent !== directory) {
    try {
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('工作目录须为普通文件夹');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await ensureRoot(parent);
      try { await mkdir(directory); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  }
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('工作目录须为普通文件夹');
  return directory;
}

export async function independentRoot(source, output) {
  source = await realpath(path.resolve(source));
  output = path.resolve(output);
  const missing = [];
  let ancestor = output;
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  const prospective = path.join(ancestor, ...missing);
  if (inside(source, prospective) || inside(prospective, source)) throw new Error('适配输出目录须与游戏原版分开');
  await ensureRoot(output);
  const canonical = await realpath(output);
  if (inside(source, canonical) || inside(canonical, source)) throw new Error('适配输出目录须与游戏原版分开');
  return canonical;
}

export async function listFiles(root, relative = '', maxFiles = 20000, { excludePrefixes = [], excludePath = () => false, recursive = true, allowFile = false, route } = {}) {
  if (route !== undefined && !RESOURCE_ROUTES.includes(route)) throw Object.assign(new Error('请选择有效的资源 route；省略表示全部类型'), { code: 'INVALID_RESOURCE_ROUTE' });
  const selected = await checkedPath(root, relative, { directory: true }), selectedInfo = await lstat(selected);
  if (excludePath(relative, { directory: selectedInfo.isDirectory() })
    || excludePrefixes.some(excluded => relative === excluded || relative.startsWith(`${excluded}/`))) return { files: [], truncated: false };
  if (selectedInfo.isFile()) {
    if (allowFile) return { files: route !== undefined && resourceRoute(relative) !== route ? []
      : [{ path: relative, kind: 'file', size: selectedInfo.size }], truncated: false };
    const parent = path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative);
    throw Object.assign(new Error('当前路径是文件，不是文件夹；文件内容与原生对象可继续检查'), {
      code: 'ENOTDIR', resource: { kind: 'file', relativePath: relative, parent, size: selectedInfo.size },
      nextAction: `使用 read_resource 读取文件片段；支持原生对象检查时使用 native_review。列出同级文件请用 list_files(relativePath:${JSON.stringify(parent)})，不要再次把当前文件作为文件夹。`,
    });
  }
  const files = [];
  let truncated = false;
  async function visit(prefix) {
    const directory = await checkedPath(root, prefix, { directory: true });
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) { truncated = true; return; }
      const file = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (excludePath(file, { directory: entry.isDirectory() })) continue;
      if (excludePrefixes.some(excluded => file === excluded || file.startsWith(`${excluded}/`))) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (recursive) await visit(file);
        else files.push({ path: file, kind: 'directory' });
      }
      else if (entry.isFile()) {
        const fileRoute = resourceRoute(file);
        if (route !== undefined && fileRoute !== route) continue;
        const info = await lstat(await checkedPath(root, file));
        files.push({ path: file, size: info.size, ...(!recursive ? { kind: 'file' } : {}) });
      }
    }
  }
  await visit(relative);
  return { files, truncated };
}

export async function readSlice(root, file, { offset = 0, length = 65536, encoding = 'utf8', complete = true, strictCursor = false } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 1024 * 1024 || !['utf8', 'base64'].includes(encoding)) throw new Error('资源读取范围或编码无效');
  const target = await checkedPath(root, file);
  const info = await lstat(target);
  if (!info.isFile()) throw Object.assign(new Error('读取目标须为普通文件'), { code: 'EISDIR', resource: { kind: 'directory', relativePath: file } });
  if (strictCursor && offset > info.size) throw Object.assign(new Error('读取位置超过当前日志长度，请核对来源或日志代次'), { code: 'LOG_TRUNCATED', actualBytes: info.size, requestedOffset: offset });
  const handle = await open(target, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(length, Math.max(0, info.size - offset)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    let returnedBytes = bytesRead;
    if (encoding === 'utf8' && bytesRead && (buffer[0] & 0xc0) === 0x80) throw Object.assign(new Error('UTF-8 游标落在字符中间，请使用此前返回的续读位置或 base64'), { code: 'INVALID_UTF8_CURSOR', offset });
    if (encoding === 'utf8' && (offset + bytesRead < info.size || !complete)) {
      // Continue on a complete UTF-8 boundary rather than replacing a split character.
      while (returnedBytes > 0 && (buffer[returnedBytes - 1] & 0xc0) === 0x80) returnedBytes--;
      if (returnedBytes > 0 && buffer[returnedBytes - 1] >= 0xc0) {
        const leading = buffer[returnedBytes - 1], width = leading < 0xe0 ? 2 : leading < 0xf0 ? 3 : 4;
        returnedBytes = bytesRead - returnedBytes + 1 < width ? returnedBytes - 1 : bytesRead;
      } else returnedBytes = bytesRead;
      if (!returnedBytes && bytesRead && (complete || offset + bytesRead < info.size)) throw Object.assign(new Error('UTF-8 片段长度需要容纳一个完整字符，请增加 length 或使用 base64'), { code: 'READ_LENGTH_TOO_SMALL', minimumLength: 4 });
    }
    return { file, offset, totalBytes: info.size, encoding, content: buffer.subarray(0, returnedBytes).toString(encoding), returnedBytes,
      nextOffset: offset + returnedBytes < info.size || !complete ? offset + returnedBytes : null,
      ...(!complete && returnedBytes < bytesRead ? { pendingBytes: bytesRead - returnedBytes } : {}) };
  } finally { await handle.close(); }
}

const describeResource = row => row.kind === 'directory' ? row : { ...row, route: resourceRoute(row.path) };

export async function inspectFilePage(root, { relativePath = '', offset = 0, limit = 20000, excludePrefixes = [], excludePath, recursive = true, allowFile = false, route } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20000 || !Number.isSafeInteger(offset) || offset < 0 || offset + limit > 200000) throw new Error('资源清单分页范围无效，请按子目录继续');
  const result = await listFiles(root, relativePath, offset + limit + 1, { excludePrefixes, excludePath, recursive, allowFile, route });
  const files = result.files.slice(offset, offset + limit).map(describeResource), more = result.truncated || result.files.length > offset + limit;
  return { files, offset, nextOffset: more ? offset + files.length : null, truncated: more, ...(route === undefined ? {} : { route }) };
}

const compareResourcePaths = (left, right) => {
  const a = left.split('/'), b = right.split('/');
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const order = a[index].localeCompare(b[index]);
    if (order) return order;
  }
  return a.length - b.length;
};
const sourceRootKey = directory => createHash('sha256').update(process.platform === 'win32' ? path.resolve(directory).toLowerCase() : path.resolve(directory)).digest('hex');

async function readRootsFor(root, sourceRoots, sourceIndex) {
  const roots = [];
  for (const directory of [root, ...sourceRoots]) {
    const resolved = path.resolve(directory), info = await lstat(resolved);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('适配目录须为普通文件夹');
    const canonical = await realpath(resolved);
    if (!roots.includes(canonical)) roots.push(canonical);
  }
  if (sourceIndex !== undefined && (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= roots.length)) throw new Error('请选择资源清单中的有效 sourceIndex');
  return { roots, indexes: sourceIndex === undefined ? roots.map((_, index) => index) : [sourceIndex] };
}

export async function describeReadSources(root, sourceRoots = []) {
  return (await readRootsFor(root, sourceRoots)).roots.map((directory, sourceIndex) => ({ sourceIndex, directory, sourceRootKey: sourceRootKey(directory), access: 'read-only' }));
}

/** The same ordered source view is used for investigation and evidence replay. */
export async function inspectReadSources(root, { sourceRoots = [], sourceIndex, relativePath = '', offset = 0, limit = 20000, excludePrefixes = [], excludePath, recursive = true, allowFile = false, route } = {}) {
  const { roots, indexes } = await readRootsFor(root, sourceRoots, sourceIndex);
  const options = { excludePrefixes, excludePath, recursive, allowFile, route };
  if (roots.length === 1) return { ...await inspectFilePage(root, { relativePath, offset, limit, ...options }), sourceIndex: 0, sourceCount: 1, sourceRootKeys: roots.map(sourceRootKey) };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20000 || !Number.isSafeInteger(offset) || offset < 0 || offset + limit > 200000) throw new Error('资源清单分页范围无效，请按子目录继续');
  const files = new Map();
  let truncated = false, found = false, missing;
  for (const index of indexes) {
    let listing;
    try { listing = await listFiles(roots[index], relativePath, offset + limit + 1, options); found = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; missing = error; continue; }
    truncated ||= listing.truncated;
    for (const row of listing.files) {
      const key = process.platform === 'win32' ? row.path.toLowerCase() : row.path;
      const record = files.get(key);
      if (record) record.origins.push({ sourceIndex: index, size: row.size });
      else files.set(key, { ...row, sourceIndex: index, origins: [{ sourceIndex: index, size: row.size }] });
    }
  }
  if (!found) throw missing;
  const ordered = [...files.values()].sort((a, b) => compareResourcePaths(a.path, b.path));
  const page = ordered.slice(offset, offset + limit).map(describeResource), more = truncated || ordered.length > offset + limit;
  return { files: page, offset, nextOffset: more ? offset + page.length : null, truncated: more,
    sourceCount: roots.length, sourceRootKeys: roots.map(sourceRootKey), ...(sourceIndex === undefined ? {} : { sourceIndex }), ...(route === undefined ? {} : { route }) };
}

export async function readSourceSlice(root, file, { sourceRoots = [], sourceIndex, ...options } = {}) {
  const { roots, indexes } = await readRootsFor(root, sourceRoots, sourceIndex);
  for (const index of indexes) {
    try {
      const result = await readSlice(roots[index], file, options);
      const input = { root: 'source', sourceIndex: index, file, offset: result.offset, length: options.length ?? 65536, encoding: result.encoding };
      return { ...result, sourceIndex: index, sourceCount: roots.length, sourceRootKey: sourceRootKey(roots[index]),
        resolvedLocation: { root: 'source', sourceIndex: index, relativeFile: file },
        readCall: { tool: 'read_resource', input },
        nextCall: result.nextOffset === null ? null : { tool: 'read_resource', input: { ...input, offset: result.nextOffset } } };
    } catch (error) {
      if (error.code !== 'ENOENT' || index === indexes.at(-1)) {
        error.resolvedLocation = { root: 'source', ...(sourceIndex === undefined ? {} : { sourceIndex }), relativeFile: file };
        error.attemptedSourceIndexes = indexes.slice(0, indexes.indexOf(index) + 1);
        error.corrections = [{ reason: '检查同一来源中的实际目录', call: { tool: 'list_files', input: { root: 'source', sourceIndex: index, relativePath: path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file), recursive: false } } }];
        throw error;
      }
    }
  }
}

export async function readJson(file) {
  const text = await readFile(file, 'utf8');
  try { return JSON.parse(text); } catch (error) {
    // Completed journal lines survive process interruption; a final partial write is ignored.
    const records = text.split('\n');
    if (records.at(-1)) records.pop();
    for (let index = records.length - 1; index >= 0; index--) {
      if (!records[index].trim()) continue;
      try { return JSON.parse(records[index]); } catch {}
    }
    throw error;
  }
}
