import { spawn } from 'node:child_process';
import { access, cp, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { installAssistPlugin } from '../../../packages/runtime/assist.mjs';
import { installLegacyRunner } from '../../../packages/runtime/legacy-runner.mjs';
import { copyFontLicense } from './fonts.mjs';
import { launchManagedProcess, processEnvironment } from '../../../packages/core/managed-process.mjs';
import { nativeWorkerError } from '../../../packages/technical/adaptation/native-failure.mjs';
export { seedDefaultFont } from './fonts.mjs';

export const serviceMethods = new Set([
  'snapshot', 'createProject', 'beginProject', 'reconnectProject', 'getProject', 'listText', 'saveSettings',
  'testConnection', 'startProject', 'continueAvailableText', 'retryAdaptation', 'pauseProject', 'cancelProject', 'deleteProject', 'saveText',
  'exportPackage', 'importPackage', 'buildProject', 'completionReport', 'exportRelease', 'cleanupProject',
  'getRecollection', 'scanRecollection', 'setWorkspaceExecution',
]);

export function makeWorker({ pythonPath, workerPath, toolkitPath, dependencyDir, timeoutMs = 900_000, spawnProcess = spawn }) {
  const processes = new Set();
  let closing = false, closeOperation;
  const startupError = error => {
    if (['ENOENT', 'ENOEXEC'].includes(error.code) && (!error.path || error.path === pythonPath) &&
        (!error.syscall || String(error.syscall).startsWith('spawn'))) {
      const missing = error.code === 'ENOENT';
      return Object.assign(nativeWorkerError({ code: missing ? 'NATIVE_DEPENDENCY_MISSING' : 'NATIVE_DEPENDENCY_INVALID',
        message: `引擎运行环境启动失败，Python运行组件${missing ? '缺失' : '无效'}，请检查程序资源是否完整`,
        diagnostic: { category: 'dependency', phase: 'spawn', engine: 'runtime', dependencyId: 'python-runtime', state: missing ? 'missing' : 'invalid' } }), { cause: error });
    }
    return error;
  };
  const worker = (command, input = {}, options = {}) => new Promise((resolve, reject) => {
    if (closing) { reject(Object.assign(new Error('程序正在关闭，引擎进度已保存'), { code: 'WORKSPACE_EXECUTION_CLOSED' })); return; }
    const stdout = [], stderr = [];
    let size = 0, running;
    try { running = launchManagedProcess({ program: pythonPath, args: ['-B', '-u', workerPath, command], spawnProcess, signal: options.signal, timeoutMs,
      env: processEnvironment({ APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, PYTHONIOENCODING: 'utf-8', PINHAO_TOOLKIT: toolkitPath,
        ...(dependencyDir ? { PINHAO_WOLFTL: path.join(dependencyDir, 'wolftl', 'WolfTL.exe'),
          PINHAO_LCF2XML: path.join(dependencyDir, 'lcf', 'lcf2xml.exe'),
          PINHAO_UBERWOLF: path.join(dependencyDir, 'uberwolf', 'UberWolfCli.exe'),
          PINHAO_GDRE: path.join(dependencyDir, 'gdre', 'gdre_tools.exe'),
          PINHAO_PGMM_CODEC: path.join(dependencyDir, 'pgmm'),
          PINHAO_UNITYPY: path.join(dependencyDir, 'unitypy'),
          PINHAO_UNITY_SCHEMA: path.join(dependencyDir, 'unity-schema', 'Pinhao.UnitySchema.exe'),
          PINHAO_MANAGED_TOOLS: path.join(dependencyDir, 'managed'),
          PINHAO_WOLFSAVE: path.join(dependencyDir, 'wolfsave', 'WolfSave.exe'),
          PINHAO_KAG_ADDFONT: path.join(dependencyDir, 'kirikiri', 'addFont.dll') } : {}) }), input: JSON.stringify(input),
      onStdout: chunk => {
      size += chunk.length;
      if (size > 256 * 1024 * 1024) {
        running.stop(new Error('引擎输出超出协议限制'));
      } else stdout.push(chunk);
      }, onStderr: chunk => { if (stderr.length < 100) stderr.push(chunk); } }); }
    catch (error) { reject(startupError(error)); return; }
    processes.add(running);
    running.completion.then(({ exitCode: code }) => {
      try {
        const response = JSON.parse(Buffer.concat(stdout).toString('utf8'));
        if (!response.ok) {
          reject(nativeWorkerError(response.error));
        } else if (code !== 0) reject(new Error(`引擎进程退出：${code}`));
        else resolve(response.result);
      } catch (error) {
        const detail = Buffer.concat(stderr).toString('utf8').slice(-1500);
        reject(new Error(`引擎协议错误：${error.message}${detail ? '\n' + detail : ''}`));
      }
    }, error => {
      const mapped = startupError(error);
      reject(mapped !== error ? mapped : Object.assign(new Error(error.code === 'PROCESS_TIMEOUT' ? `引擎任务超时：${command}` : error.name === 'AbortError' ? error.message : `引擎运行环境启动失败，请检查程序资源是否完整：${error.message}`), { code: error.code, name: error.name }));
    }).finally(() => processes.delete(running));
  });
  worker.closeExecution = () => {
    closeOperation ??= (async () => {
      closing = true;
      const active = [...processes];
      for (const running of active) running.stop(Object.assign(new Error('程序正在关闭'), { name: 'AbortError', code: 'PROCESS_CANCELLED' }));
      await Promise.allSettled(active.map(running => running.completion));
    })();
    return closeOperation;
  };
  return worker;
}

export async function nativePipelineRevision({ workerPath, toolkitPath, toolVersionsPath }) {
  const digest = createHash('sha256');
  const visit = async (directory, prefix) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error('原生解析器资源包含链接');
      if (entry.name === '__pycache__' || entry.name === 'tests' || entry.name.startsWith('test_')) continue;
      const file = path.join(directory, entry.name), relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(file, relative);
      else if (entry.isFile() && /\.(?:py|rb|cs|gd|tjs|js|json)$/i.test(entry.name)) {
        digest.update(relative); digest.update('\0'); digest.update(await readFile(file)); digest.update('\0');
      }
    }
  };
  await visit(path.dirname(workerPath), 'adapters');
  if (toolkitPath) await visit(toolkitPath, 'toolkit');
  if (toolVersionsPath) { digest.update('tool-versions\0'); digest.update(await readFile(toolVersionsPath)); }
  return digest.digest('hex');
}

export function productWorker(options) {
  const worker = makeWorker(options);
  let revision;
  const product = async (command, input, requestOptions) => {
    const result = await worker(command, input, requestOptions);
    if (command === 'catalog') result.nativeRevision = createHash('sha256').update(await (revision ??= nativePipelineRevision(options))).update(JSON.stringify(result.engines)).update(result.dependencyHealth?.fingerprint ?? '').digest('hex');
    if (command === 'assemble' && result.outputDir) {
      let assist;
      try {
        assist = input.assistEnabled === false
          ? { supported: false, status: 'disabled', detail: '实时辅助已关闭，未安装辅助插件' }
          : await (options.assistInstaller ?? installAssistPlugin)(result.outputDir, { worker });
        if (assist.status === 'install_failed' && assist.restored !== true) throw Object.assign(new Error('辅助安装未完成且无法确认原文件已恢复，请先处理安装恢复记录'), { code: 'ASSIST_INSTALL_RECOVERY_REQUIRED' });
      } catch (error) {
        error.hostFailure = true;
        throw error;
      }
      result.assist = assist;
      if (options.dependencyDir) {
        const legacy = await installLegacyRunner({ outputDir: result.outputDir, dependencyDir: options.dependencyDir, fontPath: input.fontPath, encoding: result.encoding });
        if (legacy) Object.assign(result, legacy);
      }
      if (options.fonts) await copyFontLicense(options.fonts, input.fontPath, result.outputDir);
      else if (options.defaultFontPath && input.fontPath === options.defaultFontPath && options.fontLicensePath) {
        await cp(options.fontLicensePath, path.join(result.outputDir, 'LXGWWenKai-OFL.txt'));
      }
    }
    return result;
  };
  product.executionRuntime = { pythonPath: options.pythonPath, programs: {} };
  product.closeExecution = worker.closeExecution;
  return product;
}

export async function existingPathWithin(target, roots) {
  const canonical = await realpath(target);
  for (const root of roots) {
    let base;
    try { base = await realpath(root); } catch { continue; }
    const relative = path.relative(base, canonical);
    if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) return canonical;
  }
  throw new Error('请选择当前项目或成品中的文件');
}

export async function revealExportedFile(target, exportedPaths, showItemInFolder) {
  const resolved = path.resolve(target);
  if (!exportedPaths.has(resolved)) throw new Error('请先导出分享包或文字工作包');
  const canonical = await realpath(resolved);
  if (!(await stat(canonical)).isFile()) throw new Error('请选择已导出的 ZIP 文件，或重新导出');
  showItemInFolder(canonical);
}

export async function gameExecutable(service, { projectId, buildId }) {
  const project = await service.getProjectContext({ projectId });
  const build = buildId ? project.builds.find(value => value.id === buildId) : project.builds.at(-1);
  if (!build) throw new Error('请先生成成品');
  if (!build.launchPath) throw new Error('请打开成品目录，选择游戏启动程序');
  const executable = await existingPathWithin(build.launchPath, [build.path]);
  if (path.extname(executable).toLowerCase() !== '.exe') throw new Error('请选择游戏可执行文件');
  await access(executable);
  if (!(await stat(executable)).isFile()) throw new Error('请选择成品目录中的游戏启动程序');
  return executable;
}

export function startGame(executable, environment = {}, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: path.dirname(executable), detached: true, stdio: 'ignore', env: { ...process.env, ...environment } });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(child); });
  });
}

export function createGameSessions() {
  const running = new Map();
  const cleaning = new Set();
  return {
    current(projectId) { return [...running.values()].find(entry => entry.projectId === projectId); },
    async launch(projectId, prepare) {
      if (cleaning.has(projectId)) throw new Error('项目文件正在处理中，请稍后启动游戏');
      if ([...running.values()].some(entry => entry.projectId === projectId)) throw new Error('此项目的游戏已经启动，请切换到现有游戏窗口');
      const key = Symbol();
      const entry = { projectId };
      running.set(key, entry);
      try {
        const { child, buildId, executable } = await prepare();
        Object.assign(entry, { child, buildId, executable });
        child.once('exit', () => running.delete(key));
        if (child.exitCode != null || child.signalCode != null) running.delete(key);
        return child;
      } catch (error) { running.delete(key); throw error; }
    },
    async cleanup(projectId, operation) {
      if ([...running.values()].some(entry => entry.projectId === projectId)) throw new Error('请先关闭此项目正在运行的游戏，再操作项目文件');
      if (cleaning.has(projectId)) throw new Error('项目文件正在处理中，请稍后继续');
      cleaning.add(projectId);
      try { return await operation(); }
      finally { cleaning.delete(projectId); }
    },
  };
}
