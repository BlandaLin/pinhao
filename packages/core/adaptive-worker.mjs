import { appendFile, copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createReadStream } from 'node:fs';
import { checkedPath, independentRoot, ensureRoot } from '../technical/adaptation/paths.mjs';
import { mergeAdapterResource } from './adapter-merge.mjs';
import { adaptationLocationKey } from './adaptation-results.mjs';
import { isPrivateGamePath } from './private-paths.mjs';
import { formatDigest, formatFailure } from '../technical/adaptation/format-capabilities.mjs';

const bindingName = 'pinhao-composite-adapter.json';
const relativeFile = (value) => {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.split(/[\\/]/).some(part => part === '..' || part.includes(':'))) throw new Error('适配资源需要有效的相对定位');
  return value.replaceAll('\\', '/');
};

async function copyRelative(source, destination, relative) {
  relative = relativeFile(relative);
  const original = await checkedPath(source, relative);
  await ensureRoot(destination);
  let target = await checkedPath(destination, relative, { write: true });
  await mkdir(path.dirname(target), { recursive: true });
  target = await checkedPath(destination, relative, { write: true });
  await copyFile(original, target);
}

export async function prepareSupplement(options) {
  return registerSupplement({ ...options, prepareOnly: true });
}

export async function readSupplementManifest(workspaceDir, ref) {
  const file = ref ? relativeFile(ref.file) : bindingName;
  const bytes = await readFile(await checkedPath(workspaceDir, file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (ref && (ref.format !== 'pinhao-composite-manifest-ref-1' || ref.sha256 !== sha256)) throw Object.assign(new Error('补充适配快照已变化；保留现有文件，请核对储存状态'), {code:'ADAPTER_MANIFEST_CORRUPT',storageFailure:true});
  const value = JSON.parse(bytes);
  if (value.format !== 'pinhao-composite-adapter-1' || !Array.isArray(value.adapters)) throw new Error('补充适配绑定格式有误');
  return value;
}

export async function registerSupplement({ workspaceDir, adapterWorkspaceDir, unitIds, units, files, baselineDir, sourceRoot, resourceRoot = '.', replaceVerified = false, prepareOnly = false, currentManifestRef, verificationPlan }) {
  const record = { workspaceDir: path.resolve(adapterWorkspaceDir), unitIds, units, files: [...new Set(files.map(relativeFile))], baselineDir: path.resolve(baselineDir ?? sourceRoot), sourceRoot: path.resolve(sourceRoot), resourceRoot };
  if (verificationPlan) record.verificationPlan = verificationPlan;
  for (const group of verificationPlan?.writeGroups ?? []) {
    if (group.integrationMode !== 'exclusive-resource-group' || group.unitIds.some(id => !unitIds.includes(id)) || group.writeSet.some(file => !record.files.includes(file))) throw formatFailure('FORMAT_SCOPE_CONFLICT', '补充接入必须保留已验证格式组的全部文字与派生写入文件，不能仅截取部分目标');
  }
  const hashes = async item => Object.fromEntries(await Promise.all(item.files.map(async file => [file, createHash('sha256').update(await readFile(await checkedPath(item.baselineDir, file))).digest('hex')])));
  record.baselineHashes = await hashes(record);
  await ensureRoot(workspaceDir);
  const target = await checkedPath(workspaceDir, bindingName, { write: true });
  let adapters = [];
  try {
    const previous = await readSupplementManifest(workspaceDir, currentManifestRef);
    if (previous.format !== 'pinhao-composite-adapter-1' || !Array.isArray(previous.adapters)) throw new Error('补充适配绑定格式有误');
    adapters = previous.adapters;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const identity = unit => unit && { location: adaptationLocationKey(unit.locator, unit.locator?.file, unit.context?.formatBinding), source: unit.source, rawSource: unit.rawSource ?? unit.source,
    controls: Object.fromEntries(Object.entries(unit.controls ?? {}).sort(([a], [b]) => a.localeCompare(b))), tokens: unit.tokens ?? [] };
  const incoming = new Map((units ?? []).map(unit => [unit.legacyId ?? unit.id, unit]));
  const overlappingIds = new Set();
  for (const previous of adapters) {
    const sharedFiles = previous.files.filter(file => Object.hasOwn(record.baselineHashes, file));
    if (sharedFiles.length) {
      const currentHashes = await hashes({ ...previous, files: sharedFiles });
      if (sharedFiles.some(file => currentHashes[file] !== record.baselineHashes[file] || previous.baselineHashes?.[file] && previous.baselineHashes[file] !== currentHashes[file])) throw new Error('补充适配资源基线已经改变');
    }
    const oldUnits = new Map((previous.units ?? []).map(unit => [unit.legacyId ?? unit.id, unit]));
    for (const id of unitIds.filter(id => previous.unitIds.includes(id))) {
      const before = identity(oldUnits.get(id)), after = identity(incoming.get(id));
      if (path.resolve(previous.sourceRoot) !== record.sourceRoot || previous.resourceRoot !== resourceRoot
          || !before?.location || !after?.location || !isDeepStrictEqual(before, after)) throw new Error('补充适配文字 ID 已绑定其他原文或位置');
      overlappingIds.add(id);
    }
  }
  if (replaceVerified) {
    const replaced = new Set(unitIds);
    adapters = adapters.map(item => ({ ...item, unitIds: item.unitIds.filter(id => !replaced.has(id)),
      ...(item.units ? { units: item.units.filter(unit => !replaced.has(unit.legacyId ?? unit.id)) } : {}) })).filter(item => item.unitIds.length);
    adapters.push(record);
  }
  const prior = !replaceVerified && adapters.find(item => item.workspaceDir === record.workspaceDir);
  const newIds = unitIds.filter(id => !overlappingIds.has(id));
  if (prior) {
    const retained = new Set(prior.unitIds);
    record.unitIds = [...prior.unitIds, ...newIds];
    record.units = [...(prior.units ?? []), ...(units ?? []).filter(unit => newIds.includes(unit.legacyId ?? unit.id) && !retained.has(unit.legacyId ?? unit.id))];
    record.files = [...new Set([...prior.files, ...record.files])];
    record.baselineHashes = { ...prior.baselineHashes, ...record.baselineHashes };
    adapters = adapters.map(item => item === prior ? record : item);
  } else if (!replaceVerified && newIds.length) {
    record.unitIds = newIds;
    record.units = units?.filter(unit => newIds.includes(unit.legacyId ?? unit.id));
    adapters.push(record);
  }
  const value = JSON.stringify({ format: 'pinhao-composite-adapter-1', adapters }, null, 2);
  if (prepareOnly) {
    const sha256 = createHash('sha256').update(value).digest('hex');
    const file = `composite-manifests/${sha256}.json`;
    const immutable = await checkedPath(workspaceDir, file, { write: true });
    await mkdir(path.dirname(immutable), { recursive: true });
    const temporary=`${immutable}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx');
      try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
      try { await link(temporary,immutable); } catch(error) { if(error.code !== 'EEXIST') throw error; }
    } finally { await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;}); }
    const ref = { format: 'pinhao-composite-manifest-ref-1', file, sha256 };
    await readSupplementManifest(workspaceDir, ref);
    const previous = await readSupplementManifest(workspaceDir, currentManifestRef).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    return { manifestRef: ref, registryChanged: !isDeepStrictEqual(previous, JSON.parse(value)), adapters };
  }
  // The binding precedes its DB transaction; exact repeats reconcile an interrupted commit.
  const temporary = await checkedPath(workspaceDir, `${bindingName}.${randomUUID()}.tmp`, { write: true });
  try {
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(value); await handle.sync(); }
    finally { await handle.close(); }
    await checkedPath(workspaceDir, bindingName, { write: true });
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function mergeResources(item, nativeRoot, outputRoot, signal, previous = new Map()) {
  const rows = [];
  await ensureRoot(outputRoot);
  const grouped = new Set();
  for (const group of item.verificationPlan?.writeGroups ?? []) {
    if (group.integrationMode !== 'exclusive-resource-group') throw formatFailure('FORMAT_INTEGRATION_UNSUPPORTED', '格式组尚无安全的混合资源合并方式');
    const receipt = item.groupReceipts?.find(value => value.groupId === group.groupId);
    if (!receipt || receipt.purpose !== 'build') throw formatFailure('FORMAT_QUALIFICATION_REQUIRED', '实际构建缺少当前目标的格式组证明；样例证明不能替代成品验证');
    const { receiptHash, ...body } = receipt;
    if (formatDigest(body) !== receiptHash) throw formatFailure('FORMAT_SOURCE_STALE', '格式组构建证明内容已经变化');
    const members = [];
    for (const file of group.writeSet) {
      signal?.throwIfAborted();
      if (!item.files.includes(file)) throw formatFailure('FORMAT_SCOPE_CONFLICT', '格式组派生文件未接入产品');
      const baseline = await readFile(await checkedPath(item.baselineDir, file));
      const adapter = await readFile(await checkedPath(item.buildDir, file));
      let nativeFile = previous.get(file)?.outputFile;
      if (!nativeFile) { try { nativeFile = await checkedPath(nativeRoot,file); } catch (error) { if (error.code !== 'ENOENT') throw error; nativeFile = await checkedPath(item.baselineDir,file); } }
      const native = await readFile(nativeFile);
      if (formatDigest(baseline) !== receipt.beforeHashes[file] || formatDigest(adapter) !== receipt.outputHashes[file] || item.baselineHashes[file] !== receipt.beforeHashes[file]) throw formatFailure('FORMAT_SOURCE_STALE', '格式组输入或已验证输出已变化');
      members.push({ file, baseline, adapter, native });
    }
    const allBaseline = members.every(member => member.native.equals(member.baseline)), allApplied = members.every(member => member.native.equals(member.adapter));
    if (!allBaseline && !allApplied) throw formatFailure('FORMAT_SCOPE_CONFLICT', '格式组存在其他写入或半新半旧状态；请协调共同基线，不能逐文件覆盖');
    for (const member of members) {
      const outputFile = await checkedPath(outputRoot, member.file, { write: true });
      await ensureRoot(path.dirname(outputFile)); await writeFile(outputFile, member.adapter);
      const row = { file: member.file, sha256: formatDigest(member.adapter), sourceHash: previous.get(member.file)?.sourceHash ?? formatDigest(member.native), outputFile, merge: { kind: 'exclusive-resource-group', groupId: group.groupId, preservedNative: true } };
      previous.set(member.file,row); rows.push(row); grouped.add(member.file);
    }
  }
  for (const file of item.files) {
    signal?.throwIfAborted();
    if (grouped.has(file)) continue;
    const baselineFile = await checkedPath(item.baselineDir, file);
    let nativeFile = previous.get(file)?.outputFile;
    if (!nativeFile) {
      try { nativeFile = await checkedPath(nativeRoot, file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; nativeFile = baselineFile; }
    }
    const units = item.units?.filter(unit => relativeFile(unit.locator.file) === file);
    const ids = new Set(units?.map(unit => unit.id));
    await ensureRoot(outputRoot);
    const outputFile = await checkedPath(outputRoot, file, { write: true });
    await ensureRoot(path.dirname(outputFile));
    if (units?.length && units.every(unit => Array.isArray(unit.locator.nativePath))) {
      const [baseline, native, adapter] = await Promise.all([readFile(baselineFile), readFile(nativeFile), readFile(await checkedPath(item.buildDir, file))]);
      const digest = bytes => createHash('sha256').update(bytes).digest('hex');
      if (!item.buildHashes?.[file] || digest(adapter) !== item.buildHashes[file]) throw new Error('原生补充产物已变化，请重新构建并验证');
      if (!baseline.equals(native) && !adapter.equals(native)) throw new Error('原生资源存在其他写入，请先协调联合适配范围');
      await writeFile(outputFile, adapter);
      const row = { file, sha256: digest(adapter), sourceHash: previous.get(file)?.sourceHash ?? digest(native), outputFile, merge: { kind: 'verified-native', preservedNative: true } };
      previous.set(file, row); rows.push(row); continue;
    }
    const merged = await mergeAdapterResource({ baselineFile, nativeFile, adapterFile: await checkedPath(item.buildDir, file), units,
      translations: item.translations?.filter(record => ids.has(record.id)), representationContracts: item.representationContracts, outputFile, signal });
    const initialHash = previous.get(file)?.sourceHash ?? merged.hashes.native;
    const row = { file, sha256: merged.hashes.output, sourceHash: initialHash, outputFile: merged.outputFile, merge: merged.merged };
    previous.set(file, row); rows.push(row);
  }
  return rows;
}

export async function applySupplementalText({ adapterBuilds = [], gameDir, buildDir, outputDir, signal }) {
  const loose = adapterBuilds.filter(item => path.resolve(item.sourceRoot) === path.resolve(gameDir, item.resourceRoot ?? '.'));
  for (const [index, item] of loose.entries()) {
    const target = path.resolve(outputDir, item.resourceRoot ?? '.');
    for (const file of item.files) await checkedPath(target, file, { write: true });
    const overlayRoot = path.join(path.dirname(buildDir), 'adaptive-loose-overlay', String(index));
    for (const row of await mergeResources(item, target, overlayRoot, signal)) await copyRelative(overlayRoot, target, row.file);
  }
}

/** Native containers keep their mature assembler; supplemental adapters contribute checked overlays. */
export function createAdaptiveWorker({ nativeWorker, getLab }) {
  const worker = async (command, args, control = {}) => {
    if (!args.workspaceDir || !['validate', 'roundtrip', 'build', 'assemble'].includes(command)) return nativeWorker(command, args, control);
    let composite;
    try { composite = await readSupplementManifest(args.workspaceDir, args.compositeManifestRef); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const lab = await getLab();
    if (!composite) return (await lab.dispatch(command, args, control.signal)) ?? nativeWorker(command, args, control);
    if (composite.format !== 'pinhao-composite-adapter-1' || !Array.isArray(composite.adapters)) throw new Error('补充适配绑定格式有误');
    const adapterIds = new Set(composite.adapters.flatMap(item => item.unitIds));
    const translations = args.translations ?? [];
    const nativeArgs = { ...args, translations: translations.filter(item => !adapterIds.has(item.id ?? item.legacyId)) };
    const baseWorker = async () => (await lab.dispatch(command, nativeArgs, control.signal)) ?? nativeWorker(command, nativeArgs, control);
    if (command === 'validate' || command === 'roundtrip') {
      const native = await baseWorker();
      if (native?.ok === false) return native;
      for (const item of composite.adapters) await lab.dispatch(command, { projectId: args.projectId, workspaceDir: item.workspaceDir, translations: translations.filter(record => item.unitIds.includes(record.id ?? record.legacyId)) }, control.signal);
      return native;
    }
    if (command === 'build') {
      const native = await baseWorker();
      if (native?.ok === false) return native;
      const wrapped = native?.ok === true && Object.hasOwn(native, 'result');
      const result = wrapped ? native.result : native;
      const adapterBuilds = [];
      for (let index = 0; index < composite.adapters.length; index++) {
        const item = composite.adapters[index];
        const selected = translations.filter(record => item.unitIds.includes(record.id ?? record.legacyId));
        const build = await lab.dispatch('build', { projectId: args.projectId, workspaceDir: item.workspaceDir, outputDir: path.join(path.dirname(args.outputDir), 'adapted', String(index)), translations: selected }, control.signal);
        adapterBuilds.push({ ...item, buildDir: build.buildDir, buildHashes: build.resourceHashes, buildReceiptId: build.buildReceiptId, representationContracts: build.representationContracts, verificationPlan: build.verificationPlan ?? item.verificationPlan, groupReceipts: build.groupReceipts, translations: selected });
      }
      return wrapped ? { ...native, result: { ...result, adapterBuilds } } : { ...result, adapterBuilds };
    }
    const builds = args.adapterBuilds ?? [];
    const packed = builds.filter(item => path.resolve(item.sourceRoot) !== path.resolve(args.gameDir, item.resourceRoot ?? '.'));
    if (packed.length) {
      const overlay = path.join(path.dirname(args.buildDir), 'adaptive-overlay');
      const merged = new Map();
      for (const [index, item] of packed.entries()) await mergeResources(item, args.buildDir, path.join(overlay, String(index)), control.signal, merged);
      const finalRoot = path.join(overlay, 'final');
      await ensureRoot(finalRoot);
      for (const row of merged.values()) {
        const target = await checkedPath(finalRoot, row.file, { write: true });
        await ensureRoot(path.dirname(target));
        await copyFile(row.outputFile, target);
      }
      nativeArgs.adapterOverlayDir = finalRoot;
      nativeArgs.adapterOverlayFiles = [...merged.values()].map(({ file, sha256, sourceHash }) => ({ file, sha256, sourceHash }));
    }
    const native = await baseWorker();
    if (native?.ok === false) return native;
    const wrapped = native?.ok === true && Object.hasOwn(native, 'result');
    const result = wrapped ? native.result : native;
    if (!args.deferSupplementalText) await applySupplementalText({ adapterBuilds: builds, gameDir: args.gameDir, buildDir: args.buildDir, outputDir: result.outputDir ?? args.outputDir, signal: control.signal });
    for (const item of builds.filter(item => item.buildReceiptId && path.resolve(item.sourceRoot) === path.resolve(args.gameDir,item.resourceRoot ?? '.'))) await lab.assertBuildOutputFresh({ projectId:args.projectId,workspaceDir:item.workspaceDir,buildDir:item.buildDir,buildReceiptId:item.buildReceiptId,unitIds:item.unitIds,outputDir:args.deferSupplementalText ? undefined : path.resolve(result.outputDir ?? args.outputDir,item.resourceRoot ?? '.'),signal:control.signal });
    return native;
  };
  worker.executionRuntime = nativeWorker.executionRuntime;
  worker.closeExecution = nativeWorker.closeExecution;
  return worker;
}

const sourceCopies = new Map();

/** Concurrent jobs share one independent snapshot, expanding it only for concrete tool inputs. */
export async function createAdaptationSource(options) {
  if (options.files?.some(item => typeof item === 'object' && item?.purpose !== undefined && !['source', 'dependency'].includes(item.purpose))) throw new Error('施工输入用途须为 source 或 dependency');
  if (options.files?.some(item => item?.purpose === 'dependency')) return materializeAdaptationDependencies(options);
  const resolved = path.resolve(options.outputDir), key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const previous = sourceCopies.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => copyAdaptationSource(options));
  sourceCopies.set(key, current);
  try { return await current; }
  finally { if (sourceCopies.get(key) === current) sourceCopies.delete(key); }
}

async function materializeAdaptationDependencies(options) {
  if (!options.dependencyWorkDir) throw new Error('依赖材料需要当前任务的宿主工作目录');
  const roots = [...new Set(await Promise.all([options.gameDir, ...(options.sourceRoots ?? [])].map(directory => realpath(directory))))];
  const workDir = path.resolve(options.dependencyWorkDir);
  for (const root of roots) await independentRoot(root, workDir);
  const sourceFiles = options.files.filter(item => item?.purpose !== 'dependency');
  const source = sourceFiles.length ? await createAdaptationSource({ ...options, files: sourceFiles, returnDetails: true })
    : { sourceDir: path.resolve(options.outputDir), sources: [] };
  const groups = new Map(), materializations = [];
  for (const entry of options.files.filter(item => item?.purpose === 'dependency')) {
    if (!Number.isSafeInteger(entry.sourceIndex) || entry.sourceIndex < 0 || entry.sourceIndex >= roots.length) throw new Error('依赖材料须指定有效来源编号');
    const file = relativeFile(entry.file), sourceIndex = entry.sourceIndex;
    const canonical = process.platform === 'win32' ? roots[sourceIndex].toLowerCase() : roots[sourceIndex];
    const sourceRootKey = createHash('sha256').update(canonical).digest('hex');
    const group = groups.get(sourceRootKey) ?? { sourceIndex, files: [] };
    group.files.push({ file, sourceIndex, expectedHash: entry.expectedHash, ...(entry.originId ? { originId: entry.originId } : {}) }); groups.set(sourceRootKey, group);
  }
  for (const [sourceRootKey, group] of groups) {
    const prefix = `dependencies/${sourceRootKey}`;
    const outputDir = await checkedPath(workDir, prefix, { write: true, directory: true });
    const copied = await createAdaptationSource({ ...options, outputDir, files: group.files, reuseSource: false, returnDetails: true });
    for (const requested of group.files) {
      const binding = copied.sources.find(row => row.file === requested.file && row.sourceIndex === requested.sourceIndex);
      if (!binding) throw new Error('依赖副本缺少所选来源绑定');
      const scriptRelative = `${prefix}/${binding.file}`;
      await checkedPath(workDir, scriptRelative);
      const body = { format: 'pinhao-dependency-materialization-1', purpose: 'dependency',
        workRef: { root: 'work', file: scriptRelative }, scriptRelative, sha256: binding.sha256,
        derivedFrom: { root: 'source', sourceIndex: binding.sourceIndex, file: binding.file, path: binding.file, sourceRootKey, baselineHash: binding.sha256,
          ...(requested.originId ? { originId: requested.originId } : {}) },
        proofScope: 'working-dependency-only' };
      materializations.push({ ...body, materializationReceiptId: createHash('sha256').update(JSON.stringify(body)).digest('hex') });
    }
  }
  return options.returnDetails ? { ...source, materializations } : source.sourceDir;
}

/** reuseSource is only for a host-owned native snapshot, never the original game. */
async function copyAdaptationSource({ gameDir, sourceRoots = [], outputDir, files: selectedFiles, reuseSource = false, signal, onProgress = () => {}, returnDetails = false }) {
  const checkOutputPath = async () => {
    let current = path.resolve(outputDir);
    while (true) {
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error('技术工作目录包含链接'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  };
  await checkOutputPath();
  const source = await realpath(gameDir);
  const roots = [...new Set(await Promise.all([source, ...sourceRoots].map(directory => realpath(directory))))];
  const target = await independentRoot(source, outputDir);
  for (const root of roots.slice(1)) await independentRoot(root, target);
  // Windows can canonicalize an ordinary 8.3 alias or path casing without a link.
  await checkOutputPath();
  const checkpoint = await checkedPath(path.dirname(target), `${path.basename(target)}.snapshot.json`, { write: true });
  const journal = await checkedPath(path.dirname(target), `${path.basename(target)}.snapshot-progress.jsonl`, { write: true });
  const previous = await readFile(checkpoint, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  const snapshot = previous && JSON.parse(previous);
  if (snapshot && snapshot.source !== source) throw new Error('技术副本已绑定其他资源目录');
  if (snapshot && JSON.stringify(snapshot.sourceRoots ?? [snapshot.source]) !== JSON.stringify(roots)) throw new Error('技术副本的资源来源已变化，请重新建立技术任务');
  if (selectedFiles !== undefined && (!Array.isArray(selectedFiles) || !selectedFiles.length)) throw new Error('按需复制需要明确的资源文件列表');
  const cache = new Map();
  try {
    const lines = (await readFile(journal, 'utf8')).split('\n');
    // A partial final line is left by an interrupted append and has no committed evidence.
    if (lines.at(-1)) lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.source !== source || !Array.isArray(record.files)) throw new Error('技术副本进度与当前资源不一致');
      if (JSON.stringify(record.sourceRoots ?? [record.source]) !== JSON.stringify(roots)) throw new Error('技术副本进度与当前资源来源不一致');
      for (const file of record.files) cache.set(file.relative, file);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const signature = async file => {
    const info = await lstat(file, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('技术资源须为普通文件');
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':');
  };
  let copied = 0, reused = 0, processed = 0, bytesCopied = 0, bytesReused = 0, hasExcluded = false;
  const pending = [];
  const flush = async () => {
    if (!pending.length) return;
    await appendFile(await checkedPath(path.dirname(target), path.basename(journal), { write: true }), `\n${JSON.stringify({ version: 1, source, ...(roots.length > 1 ? { sourceRoots: roots } : {}), files: pending })}\n`, { encoding: 'utf8', flush: true });
    pending.length = 0;
  };
  const files = [];
  const fingerprint = async file => {
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(file)) { signal?.throwIfAborted(); digest.update(chunk); }
    return digest.digest('hex');
  };
  const recordFile = async (relative, requestedIndex, expectedHash) => {
    relative = relativeFile(relative);
    if (isPrivateGamePath(relative)) throw new Error('技术资源不能包含存档或私人配置');
    let input, sourceIndex = requestedIndex ?? 0;
    if (requestedIndex !== undefined && (!Number.isSafeInteger(requestedIndex) || requestedIndex < 0 || requestedIndex >= roots.length)) throw new Error('技术资源来源编号无效');
    for (; sourceIndex < roots.length; sourceIndex++) {
      try { input = await checkedPath(roots[sourceIndex], relative); break; }
      catch (error) { if (requestedIndex !== undefined || error.code !== 'ENOENT' || sourceIndex === roots.length - 1) throw error; }
    }
    const stamp = await signature(input), saved = cache.get(relative);
    const sha256 = saved?.sourceStamp === stamp ? saved.sha256 : await fingerprint(input);
    if (expectedHash !== undefined && (!/^[a-f0-9]{64}$/.test(expectedHash) || expectedHash !== sha256)) throw Object.assign(new Error(`施工输入与已读取来源不一致：${relative}`),{code:'SOURCE_BASELINE_CHANGED'});
    if (await signature(input) !== stamp) throw new Error('检查期间原版资源发生变化，请重新检查游戏版本');
    if (!selectedFiles) for (let index = sourceIndex + 1; index < roots.length; index++) {
      let alternate;
      try { alternate = await checkedPath(roots[index], relative); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const before = await signature(alternate), otherHash = await fingerprint(alternate);
      if (await signature(alternate) !== before) throw new Error('检查期间原版资源发生变化，请重新检查游戏版本');
      if (otherHash !== sha256) throw new Error(`多个来源的同名资源内容不同，请按具体资源分工处理：${relative}`);
    }
    files.push({ relative, sha256, sourceIndex, sourceStamp: stamp, size: (await lstat(input)).size });
  };
  const fileKey = file => process.platform === 'win32' ? file.toLowerCase() : file;
  const discovered = new Map();
  const walk = async (root, relative = '') => {
    signal?.throwIfAborted();
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (entry.isSymbolicLink()) throw new Error('游戏包含目录链接，请使用完整本地副本');
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) { if (isPrivateGamePath(next, { directory: true })) hasExcluded = true; else await walk(root, next); }
      else if (entry.isFile() && !isPrivateGamePath(next)) {
        const relative = next.replaceAll('\\', '/');
        if (!discovered.has(fileKey(relative))) discovered.set(fileKey(relative), relative);
      } else if (entry.isFile()) hasExcluded = true;
    }
  };
  if (selectedFiles) {
    const required = new Map();
    for (const entry of [...(snapshot?.files ?? []).map(file => ({ file: file.relative, sourceIndex: file.sourceIndex ?? 0 })), ...selectedFiles]) {
      const relative = relativeFile(typeof entry === 'string' ? entry : entry?.file);
      const requestedIndex = typeof entry === 'string' ? undefined : entry.sourceIndex;
      const saved = required.get(fileKey(relative));
      if (saved?.sourceIndex !== undefined && requestedIndex !== undefined && saved.sourceIndex !== requestedIndex) throw new Error(`同名施工输入来自不同来源，请使用独立工作目录：${relative}`);
      if (!saved || requestedIndex !== undefined) required.set(fileKey(relative), { relative, sourceIndex: requestedIndex, expectedHash: typeof entry === 'string' ? undefined : entry.expectedHash });
    }
    for (const item of required.values()) { signal?.throwIfAborted(); await recordFile(item.relative, item.sourceIndex,item.expectedHash); }
  } else {
    for (const root of roots) await walk(root);
    for (const relative of discovered.values()) await recordFile(relative);
  }
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  const identity = JSON.stringify({ source, ...(roots.length > 1 ? { sourceRoots: roots } : {}), ...(selectedFiles ? { scope: 'selected' } : {}),
    files: files.map(({ relative, sha256, sourceIndex }) => ({ relative, sha256, ...(roots.length > 1 ? { sourceIndex } : {}) })) });
  const resourceHashes = new Map(files.map(file => [file.relative, file]));
  if (snapshot && (snapshot.files.some(file => resourceHashes.get(file.relative)?.sha256 !== file.sha256
        || resourceHashes.get(file.relative)?.sourceIndex !== (file.sourceIndex ?? 0))
      || !selectedFiles && snapshot.scope !== 'selected' && previous !== identity)) throw new Error('原版资源已更新，请接入新版以保留现有技术进度');
  if (!previous) await writeFile(checkpoint, identity, { flag: 'wx' });
  else if (previous !== identity) {
    const temporary = `${checkpoint}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, identity, { flag: 'wx' }); await rename(temporary, checkpoint); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  const reuseManaged = reuseSource && roots.length === 1 && !selectedFiles && !hasExcluded;
  try {
    for (const file of files) {
      signal?.throwIfAborted();
      const saved = cache.get(file.relative);
      let targetStamp;
      if (reuseManaged) {
        reused++; bytesReused += file.size;
      } else {
        const input = await checkedPath(roots[file.sourceIndex], file.relative);
        let output = await checkedPath(target, file.relative, { write: true });
        let matching = false;
        try {
          targetStamp = await signature(output);
          matching = saved?.sha256 === file.sha256 && saved.targetStamp === targetStamp;
          if (!matching) matching = await fingerprint(output) === file.sha256;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (matching) { reused++; bytesReused += file.size; }
        else {
          await mkdir(path.dirname(output), { recursive: true });
          output = await checkedPath(target, file.relative, { write: true });
          await copyFile(input, output);
          if (await fingerprint(output) !== file.sha256) throw new Error('复制期间原版资源发生变化，请重新检查游戏版本');
          targetStamp = await signature(output);
          copied++; bytesCopied += file.size;
        }
      }
      const evidence = { relative: file.relative, sha256: file.sha256, sourceStamp: file.sourceStamp, ...(roots.length > 1 ? { sourceIndex: file.sourceIndex } : {}), ...(targetStamp ? { targetStamp } : {}) };
      if (JSON.stringify(saved) !== JSON.stringify(evidence)) pending.push(evidence);
      if (++processed % 100 === 0) { await flush(); await onProgress({ copied, reused, processed, total: files.length, bytesCopied, bytesReused }); }
    }
    signal?.throwIfAborted();
    await flush();
    await onProgress({ copied, reused, processed, total: files.length, bytesCopied, bytesReused });
    signal?.throwIfAborted();
  } finally {
    await flush();
  }
  const sourceDir = reuseManaged ? source : target;
  return returnDetails ? { sourceDir, sources: files.map(({ relative: file, sha256, sourceIndex }) => ({ file, sha256, sourceIndex })) } : sourceDir;
}
