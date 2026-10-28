import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { checkedPath, ensureRoot, relativeFile, listFiles } from './paths.mjs';
import { launchManagedProcess, processEnvironment } from '../../core/managed-process.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const installer = String.raw`import json,sys,zipfile,pathlib,sysconfig
request=json.load(sys.stdin)
root=pathlib.Path(request['target'])
for wheel in request['wheels']:
 name=pathlib.Path(wheel).name
 tags=name[:-4].rsplit('-',3)[-3:]
 impl,abi,platform=tags
 expected='cp'+str(sys.version_info.major)+str(sys.version_info.minor)
 if not (platform=='any' and abi=='none' and any(t in impl.split('.') for t in ('py3',expected)) or platform==sysconfig.get_platform().replace('-','_').replace('.','_') and impl==expected and abi in (expected,'abi3')):
  raise ValueError('DEPENDENCY_WHEEL_INCOMPATIBLE: '+name)
 with zipfile.ZipFile(wheel) as archive:
  for item in archive.infolist():
   parts=pathlib.PurePosixPath(item.filename).parts
   if not parts or '..' in parts or item.filename.startswith(('/','\\')) or any(':' in p for p in parts) or item.external_attr>>16&0o170000==0o120000:
    raise ValueError('DEPENDENCY_WHEEL_PATH: '+item.filename)
   if parts[0].endswith('.data'):
    if len(parts)<3 or parts[1] not in ('purelib','platlib'): continue
    parts=parts[2:]
   target=root.joinpath(*parts)
   if item.is_dir(): target.mkdir(parents=True,exist_ok=True)
   else:
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_bytes(archive.read(item))
print(json.dumps({'python':sys.version,'implementation':sys.implementation.cache_tag,'platform':sysconfig.get_platform()}))`;

export async function prepareProjectDependencies({ root, pythonPath, wheels = [], signal, fetchImpl = fetch }) {
  if (!pythonPath) throw Object.assign(new Error('项目缺少 Python 运行时'), { code: 'WORKSPACE_RUNTIME_MISSING' });
  if (!Array.isArray(wheels) || wheels.length > 80) throw new Error('请提供依赖 wheel 锁定清单');
  for (const item of wheels) {
    if (!item || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '') || !item.name || !item.version || !item.license || !item.source) throw new Error('依赖须记录名称、版本、许可证、来源和 SHA256');
    if (!/\.whl$/i.test(item.file ?? '')) throw Object.assign(new Error('请提供纯 Python 包或匹配的预编译 wheel'), { code: 'DEPENDENCY_WHEEL_REQUIRED' });
    relativeFile(item.file);
  }
  const runtimeHash = digest(await readFile(pythonPath));
  const lockHash = digest(JSON.stringify({ pythonPath, runtimeHash, installer: 'stdlib-wheel-1', wheels })), dependencyRoot = await ensureRoot(path.join(root, 'dependencies'));
  const target = path.join(dependencyRoot, lockHash), marker = path.join(target, 'pinhao-lock.json');
  try {
    const lock = JSON.parse(await readFile(marker, 'utf8'));
    if (lock.lockHash === lockHash && lock.files) {
      for (const [file, expected] of Object.entries(lock.files)) if (digest(await readFile(await checkedPath(target, file))) !== expected) throw Object.assign(new Error('项目依赖文件已变化，请重新准备'), { code: 'DEPENDENCY_ENVIRONMENT_CHANGED' });
      return { ...lock, path: target, reused: true };
    }
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const cache = await ensureRoot(path.join(dependencyRoot, 'wheel-cache'));
  const prepared = [];
  for (const item of wheels) {
    signal?.throwIfAborted();
    const cached = path.join(cache, `${item.sha256}-${path.basename(item.file)}`);
    let bytes;
    try { bytes = await readFile(cached); if (digest(bytes) !== item.sha256) bytes = undefined; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!bytes) {
      try {
        if (item.url) {
          const url = new URL(item.url);
          if (url.protocol !== 'https:' || url.username || url.password) throw new Error('依赖下载须使用无凭据 HTTPS 地址');
          const response = await fetchImpl(url, { signal, redirect: 'error' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          bytes = Buffer.from(await response.arrayBuffer());
        } else bytes = await readFile(await checkedPath(root, item.file));
      } catch (error) { if (signal?.aborted) throw error; throw Object.assign(new Error(`依赖准备未完成：${item.name}；${error.message}`), { code: 'DEPENDENCY_UNAVAILABLE' }); }
      if (digest(bytes) !== item.sha256) throw Object.assign(new Error(`依赖摘要不匹配：${item.name}`), { code: 'DEPENDENCY_HASH_MISMATCH' });
      const temporary = `${cached}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx');
      try { await handle.writeFile(bytes); } finally { await handle.close(); }
      await rename(temporary, cached);
    }
    const wheelDir = await ensureRoot(path.join(cache, item.sha256));
    const wheel = path.join(wheelDir, path.basename(item.file)); await copyFile(cached, wheel); prepared.push(wheel);
  }
  const stage = await ensureRoot(`${target}.${randomUUID()}.tmp`), output = [];
  const process = launchManagedProcess({ program: pythonPath, args: ['-B', '-u', '-c', installer], env: processEnvironment({ PYTHONIOENCODING: 'utf-8' }), signal,
    input: JSON.stringify({ target: stage, wheels: prepared }), onStdout: chunk => output.push(chunk), onStderr: chunk => output.push(chunk) });
  const result = await process.completion;
  if (result.exitCode !== 0) throw Object.assign(new Error(`依赖 wheel 与运行时不兼容：${Buffer.concat(output).toString('utf8').slice(-2000)}`), { code: 'DEPENDENCY_WHEEL_INCOMPATIBLE' });
  const runtime = JSON.parse(Buffer.concat(output).toString('utf8').trim());
  const files = {};
  for (const file of (await listFiles(stage)).files) files[file.path] = digest(await readFile(await checkedPath(stage, file.path)));
  const lock = { schema: 'pinhao-project-dependencies-1', lockHash, wheels, runtime, runtimeHash, files, installer: 'stdlib-wheel-1' };
  const file = await open(path.join(stage, 'pinhao-lock.json'), 'wx');
  try { await file.writeFile(JSON.stringify(lock)); } finally { await file.close(); }
  try { await rename(stage, target); } catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error; await readFile(marker); }
  return { ...lock, path: target, reused: false };
}
