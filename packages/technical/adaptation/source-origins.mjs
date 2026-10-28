import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { checkedPath, inspectReadSources } from './paths.mjs';
import { isPrivateGamePath } from '../../core/private-paths.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rootKey = root => process.platform === 'win32' ? root.toLowerCase() : root;
const stale = message => Object.assign(new Error(message), { code: 'DISPLAY_SOURCE_STALE', hostFailure: true });
const relative = file => typeof file === 'string' && file.length && !path.isAbsolute(file)
  && !file.split(/[\\/]/).some(part => !part || part === '..' || part.includes(':'));

/** Only the host's registered source-copy receipt can alias a work view to an original. */
export async function createDisplaySourceResolver({ projectId, roots, sourceCopyPath, allowedSourceRoots = [] }) {
  if (!projectId) throw new Error('Display source origins require an explicit project');
  const views = await Promise.all(roots.map(root => realpath(root)));
  const allowed = [...new Set(await Promise.all(allowedSourceRoots.map(root => realpath(root))))];
  const originId = root => hash([projectId, rootKey(root)]);
  const copy = sourceCopyPath && await realpath(sourceCopyPath).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  const copyIndex = copy ? views.findIndex(root => rootKey(root) === rootKey(copy)) : -1;
  let sourceRoots = [], entries = new Map();
  if (copyIndex >= 0) {
    const snapshot = JSON.parse(await readFile(`${sourceCopyPath}.snapshot.json`, 'utf8'));
    if (!Array.isArray(snapshot.files)) throw stale('技术副本缺少宿主来源清单');
    sourceRoots = await Promise.all((snapshot.sourceRoots ?? [snapshot.source]).map(root => realpath(root)));
    if (!sourceRoots.length || sourceRoots.some(root => !allowed.some(item => rootKey(item) === rootKey(root)))) throw stale('技术副本包含未授权来源');
    entries = new Map(snapshot.files.map(row => {
      if (!relative(row.relative) || !/^[a-f0-9]{64}$/.test(row.sha256 ?? '') || !sourceRoots[row.sourceIndex ?? 0]) throw stale('技术副本来源记录无效');
      return [row.relative.replaceAll('\\', '/'), row];
    }));
    if (entries.size !== snapshot.files.length) throw stale('技术副本来源记录重复');
  }
  const rootKeys = views.map((root, index) => index === copyIndex ? hash(['host-source-copy-1', sourceRoots.map(originId)]) : originId(root));
  const resolve = async ({ file, sourceIndex }) => {
    const view = views[sourceIndex];
    if (!view || !relative(file) || isPrivateGamePath(file)) throw stale('显示来源不在当前授权读取范围');
    let original = view, expected;
    if (sourceIndex === copyIndex) {
      const entry = entries.get(file.replaceAll('\\', '/'));
      if (!entry) throw stale('显示来源未登记在宿主副本清单');
      original = sourceRoots[entry.sourceIndex ?? 0]; expected = entry.sha256;
    }
    const bytes = await readFile(await checkedPath(original, file));
    const sourceHash = createHash('sha256').update(bytes).digest('hex');
    if (expected && sourceHash !== expected) throw stale('显示用途依赖的原资源已经变化');
    return { originId: originId(original), file, hash: sourceHash };
  };
  const listingHash = async parameters => {
    const indexes = parameters.sourceIndex === undefined ? views.map((_, index) => index) : [parameters.sourceIndex];
    const selected = [];
    for (const index of indexes) {
      if (!views[index]) throw stale('列表来源索引已变化');
      for (const root of index === copyIndex ? sourceRoots : [views[index]]) if (!selected.some(item => rootKey(item) === rootKey(root))) selected.push(root);
    }
    const { sourceIndex: _index, ...options } = parameters;
    try {
      const value = await inspectReadSources(selected[0], { ...options, sourceRoots: selected.slice(1), excludePath: isPrivateGamePath });
      return hash({ origins: selected.map(originId), value: { ...value, sourceRootKeys: selected.map(originId) } });
    } catch (error) {
      if (error.code === 'ENOENT') return hash({ origins: selected.map(originId), missing: true });
      throw error;
    }
  };
  const resolveRoot = async ({ files, sourceIndex = 0 }) => {
    if (!Array.isArray(files) || !files.length || !views[sourceIndex]) throw stale('表示验证需要明确的宿主来源文件');
    let selected;
    for (const file of new Set(files)) {
      const origin = await resolve({ file, sourceIndex });
      const original = sourceIndex === copyIndex ? sourceRoots[entries.get(file.replaceAll('\\', '/')).sourceIndex ?? 0] : views[sourceIndex];
      if (selected && rootKey(selected) !== rootKey(original)) throw Object.assign(new Error('命令正文来自不同原始资源根，尚不能共用一个消费者表示契约'), { code: 'EMBEDDED_REPRESENTATION_PENDING' });
      const bytes = await readFile(await checkedPath(views[sourceIndex], file));
      if (createHash('sha256').update(bytes).digest('hex') !== origin.hash) throw stale('表示验证的施工副本与原始来源不一致');
      selected = original;
    }
    return selected;
  };
  return { rootKeys, resolve, listingHash, resolveRoot };
}
