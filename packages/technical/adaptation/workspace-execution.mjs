import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { checkedPath, ensureRoot, independentRoot, readSlice, relativeFile } from './paths.mjs';
import { launchManagedProcess, processEnvironment } from '../../core/managed-process.mjs';
import { prepareProjectDependencies } from './project-dependencies.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const atomic = async (file, value) => {
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx');
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
};
const terminal = status => ['completed', 'failed', 'cancelled', 'timed-out', 'interrupted'].includes(status);

export function createWorkspaceExecution({ pythonPath, programs = {}, authorize = async () => false, spawnProcess,
  maxLogBytesPerRun = 128 * 1024 * 1024, reserveLogBytes, settleLogBytes, openLog = open } = {}) {
  if (!Number.isSafeInteger(maxLogBytesPerRun) || maxLogBytesPerRun < 1) throw new RangeError('maxLogBytesPerRun must be a positive byte count');
  const runs = new Map(), initialized = new Map();
  const starting = new Set(), controllers = new Set();
  let closing = false, closeOperation;
  async function context({ projectId, gameDir, workDir }) {
    if (!await authorize({ projectId, gameDir, workDir })) throw Object.assign(new Error('请先允许此项目运行本地技术脚本'), { code: 'WORKSPACE_EXECUTION_AUTH_REQUIRED' });
    const root = await independentRoot(gameDir, workDir);
    const logs = await ensureRoot(path.join(root, 'process-runs'));
    if (!initialized.has(logs)) initialized.set(logs, (async () => {
      for (const file of await readdir(logs)) {
        if (!/^run-[a-f0-9-]+\.json$/.test(file)) continue;
        const target = await checkedPath(logs, file), saved = JSON.parse(await readFile(target, 'utf8'));
        if (!terminal(saved.status) && !runs.has(saved.runId)) {
          saved.status = 'interrupted'; saved.finishedAt = new Date().toISOString(); saved.outputFinalized = true; saved.captureComplete = false;
          saved.reason = '应用已重启，请检查保留的输出与产物后决定下一步';
          await atomic(target, JSON.stringify(saved));
        }
      }
    })());
    await initialized.get(logs);
    return { root, logs };
  }
  async function load(input) {
    const ctx = await context(input);
    if (!/^run-[a-f0-9-]+$/.test(input.runId ?? '')) throw new Error('进程记录编号无效');
    const active = runs.get(input.runId);
    if (active?.root === ctx.root && active.publicationError) throw active.publicationError;
    const record = JSON.parse(await readFile(await checkedPath(ctx.logs, `${input.runId}.json`), 'utf8'));
    return { ...ctx, record };
  }
  const api = {
    async prepareDependencies(input) {
      const { root } = await context(input);
      return prepareProjectDependencies({ ...input, root, pythonPath });
    },
    async writeFile(input) {
      const { root } = await context(input), file = relativeFile(input.file);
      if (file.startsWith('process-runs/') || file.startsWith('dependencies/')) throw new Error('此目录由主程序管理');
      const target = await checkedPath(root, file, { write: true });
      let current = null;
      try { current = hash(await readFile(target)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (input.expectedHash !== undefined && input.expectedHash !== current) throw Object.assign(new Error('文件已变化，请重新读取后修改'), { code: 'WORKSPACE_FILE_CONFLICT', actualHash: current });
      if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 2 * 1024 * 1024) throw new Error('请保存有效的脚本或笔记正文');
      await mkdir(path.dirname(target), { recursive: true });
      await checkedPath(root, file, { write: true });
      await atomic(target, input.content);
      return { file, sha256: hash(input.content), bytes: Buffer.byteLength(input.content) };
    },
    async run(input) {
      const { root, logs } = await context(input);
      if (!Array.isArray(input.args) || input.args.length > 200 || input.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('进程参数须为字符串数组');
      let program = input.program === 'python' ? pythonPath : programs[input.program];
      if (!program) program = await checkedPath(root, relativeFile(input.program));
      if (!program) throw Object.assign(new Error('项目缺少可用运行时'), { code: 'WORKSPACE_RUNTIME_MISSING' });
      const cwd = input.cwd ? await checkedPath(root, relativeFile(input.cwd, { directory: true }), { directory: true }) : root;
      if (!(await stat(cwd)).isDirectory()) throw new Error('进程工作目录须为文件夹');
      if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1)) throw new Error('进程时限须为有效毫秒数');
      let args = input.args;
      if (input.program === 'python') {
        const dependency = await api.prepareDependencies({ ...input, wheels: input.wheels ?? [] });
        const bootstrap = "import sys,runpy,json; cfg=json.loads(sys.argv[1]); sys.path.insert(0,cfg['path']); args=cfg['args']; sys.argv=args[1:] if args[0] in ('-c','-m') else args; exec(args[1],{'__name__':'__main__'}) if args[0]=='-c' else runpy.run_module(args[1],run_name='__main__',alter_sys=True) if args[0]=='-m' else runpy.run_path(args[0],run_name='__main__')";
        if (!args.length) throw new Error('请指定 Python 脚本、-c 或 -m');
        args = ['-B', '-u', '-c', bootstrap, JSON.stringify({ path: dependency.path, args })];
      }
      let codeHash = hash(JSON.stringify([input.program, input.args]));
      if (input.program === 'python' && input.args[0] && !input.args[0].startsWith('-')) {
        try { codeHash = hash(await readFile(await checkedPath(cwd, input.args[0]))); } catch {}
      }
      const runId = `run-${randomUUID()}`, record = { runId, captureGeneration: randomUUID(), program: input.program, args: input.args, codeHash, cwd: input.cwd ?? '',
        cwdRef: { root: 'work', relativeFile: input.cwd ?? '' }, inputView: input.inputView ?? null, materializationRefs: input.materializationRefs ?? [],
        status: 'running', outputFinalized: false, captureComplete: false, startedAt: new Date().toISOString(), stdoutBytes: 0, stderrBytes: 0,
        stdoutObservedBytes: 0, stderrObservedBytes: 0 };
      const file = path.join(logs, `${runId}.json`);
      const stdout = await openLog(path.join(logs, `${runId}.stdout`), 'wx');
      let stderr;
      try { stderr = await openLog(path.join(logs, `${runId}.stderr`), 'wx'); await atomic(file, JSON.stringify(record)); }
      catch (error) { await Promise.allSettled([stdout.close(), stderr?.close()]); throw error; }
      let writes = Promise.resolve(), captureError;
      const append = (key, handle) => chunk => {
        const bytes = Buffer.from(chunk); record[`${key}ObservedBytes`] += bytes.length;
        writes = writes.then(async () => {
          if (captureError) throw captureError;
          let allowed = Math.min(bytes.length, Math.max(0, maxLogBytesPerRun - record.stdoutBytes - record.stderrBytes));
          let reserved = false, offset = 0, uncertain = false;
          if (reserveLogBytes) {
            const grant = await reserveLogBytes({ projectId: input.projectId, requestId: input.requestId, workDir: input.workDir, runId, bytes: allowed });
            if (!Number.isSafeInteger(grant) || grant < 0) throw Object.assign(new Error('日志存储额度返回无效字节数'), { code: 'LOG_QUOTA_INVALID', runId });
            allowed = Math.min(allowed, grant);
            reserved = true;
          }
          try {
            while (offset < allowed) {
              let result;
              try { result = await handle.write(bytes, offset, allowed - offset); }
              catch (error) { uncertain = true; throw error; }
              const { bytesWritten } = result;
              if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) throw Object.assign(new Error('日志无法继续写入，已保留成功写入的部分'), { code: 'LOG_WRITE_FAILED', runId });
              offset += bytesWritten; record[`${key}Bytes`] += bytesWritten;
            }
            if (allowed < bytes.length) throw Object.assign(new Error('脚本日志达到存储限额，进程已停止，现有输出保留'), { code: 'OUTPUT_LIMIT', runId });
          } finally {
            if (reserved && settleLogBytes) await settleLogBytes({ projectId: input.projectId, requestId: input.requestId, workDir: input.workDir, runId,
              reservedBytes: allowed, persistedBytes: offset, uncertain });
          }
        }).catch(error => { captureError ??= error; throw error; });
        return writes;
      };
      let process;
      try {
        process = launchManagedProcess({ program, args, cwd, env: processEnvironment({ PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', TEMP: root, TMP: root,
          PINHAO_SOURCE_DIR: path.resolve(input.gameDir), PINHAO_WORK_DIR: root }), input: input.stdin,
          timeoutMs: input.timeoutMs ?? 900000, signal: input.signal, spawnProcess, onStdout: append('stdout', stdout), onStderr: append('stderr', stderr) });
      } catch (error) { await stdout.close(); await stderr.close(); record.status = 'failed'; record.error = error.message; await atomic(file, JSON.stringify(record)); throw error; }
      let finalStatus;
      const active = { process, record, root, publicationError: null, finish: null };
      const finish = process.completion.then(result => { Object.assign(record, result); record.processExitCode = result.exitCode; finalStatus = result.exitCode === 0 ? 'completed' : 'failed'; }, error => {
        finalStatus = error.code === 'PROCESS_CANCELLED' ? 'cancelled' : error.code === 'PROCESS_TIMEOUT' ? 'timed-out' : 'failed'; record.error = error.message; record.errorCode = error.code;
      }).then(async () => {
        let synced = false;
        try { await writes; }
        catch (error) { captureError ??= error; }
        finally {
          try { await stdout.sync(); await stderr.sync(); synced = true; } catch (error) { captureError ??= error; }
          const closed = await Promise.allSettled([stdout.close(), stderr.close()]);
          captureError ??= closed.find(result => result.status === 'rejected')?.reason;
          record.status = finalStatus ?? 'failed';
          record.outputFinalized = true; record.captureComplete = !captureError;
          record.retainedBytes = record.stdoutBytes + record.stderrBytes;
          record.committedBytes = { stdout: synced ? record.stdoutBytes : 0, stderr: synced ? record.stderrBytes : 0 };
          if (captureError) { record.status = 'failed'; record.errorCode = captureError.code ?? 'LOG_WRITE_FAILED'; record.error = captureError.message; record.captureComplete = false;
            record.storageFailure = !['OUTPUT_LIMIT', 'LOG_QUOTA_INVALID'].includes(record.errorCode); }
          record.finishedAt = new Date().toISOString();
          try { await atomic(file, JSON.stringify(record)); }
          catch (error) {
            active.publicationError = Object.assign(new Error('脚本已结束，但无法保存运行记录；输出已保留，请检查磁盘空间或文件占用', { cause: error }),
              { code: error.code ?? 'WORKSPACE_RUN_FINALIZATION_FAILED', runId, hostFailure: true });
            throw active.publicationError;
          }
          runs.delete(runId);
        }
      });
      active.finish = finish;
      // A failed publication stays observable even when no caller is currently waiting.
      finish.catch(() => {});
      runs.set(runId, active);
      return { ...record, permissionMode: 'current-user-managed' };
    },
    async read(input) {
      const { logs, record } = await load(input), active = runs.get(input.runId);
      if (active?.publicationError) throw active.publicationError;
      // A terminal state is public only after both streams and its record are committed.
      const current = active ? { ...active.record, status: 'running', outputFinalized: false, captureComplete: false } : record;
      const stream = input.stream ?? 'stdout';
      if (!['stdout', 'stderr'].includes(stream)) throw new Error('请选择 stdout 或 stderr');
      if (input.expectedCaptureGeneration !== undefined && input.expectedCaptureGeneration !== current.captureGeneration) throw Object.assign(new Error('日志代次已变化，请核对保留的进程记录'), { code: 'LOG_CHANGED', runId: input.runId, captureGeneration: current.captureGeneration });
      const finalized = current.outputFinalized ?? terminal(current.status);
      const output = await readSlice(logs, `${input.runId}.${stream}`, { offset: input.cursor ?? 0, length: input.length ?? 8192, encoding: input.encoding ?? 'utf8', complete: finalized, strictCursor: true });
      const endByte = output.offset + output.returnedBytes, nextInput = { runId: input.runId, stream, cursor: endByte,
        length: input.length ?? 8192, encoding: input.encoding ?? 'utf8', ...(current.captureGeneration ? { expectedCaptureGeneration: current.captureGeneration } : {}) };
      const nextCall = finalized && endByte === output.totalBytes ? null : { tool: output.pendingBytes ? 'wait_run' : 'read_run', input: nextInput };
      return { ...current, schema: 'pinhao-process-log-page-2', stream, cursor: output.offset, nextCursor: endByte,
        encoding: output.encoding, content: output.content, totalBytes: output.totalBytes, returnedBytes: output.returnedBytes,
        captureStatus: finalized ? current.captureComplete === false ? 'failed' : 'closed' : 'open', atAvailableEnd: endByte === output.totalBytes,
        ...(output.pendingBytes ? { pendingBytes: output.pendingBytes } : {}),
        sourcePage: { startByte: output.offset, endByte, snapshotBytes: output.totalBytes, nextCall, scope: 'one captured raw-byte page' },
        view: { pointer: '/content', offsetUnit: 'utf16', offset: 0, returnedCharacters: output.content.length, totalCharacters: output.content.length }, nextCall,
        streams: Object.fromEntries(['stdout', 'stderr'].map(name => [name, { retainedBytes: current[`${name}Bytes`], readCall: { tool: 'read_run', input: { runId: input.runId, stream: name, cursor: 0,
          ...(current.captureGeneration ? { expectedCaptureGeneration: current.captureGeneration } : {}) } } }])) };
    },
    async wait(input) {
      await load(input);
      const active = runs.get(input.runId), waitMs = Math.min(Math.max(input.waitMs ?? 1000, 0), 30000);
      if (active) {
        let timer;
        try { await Promise.race([active.finish, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]); }
        finally { clearTimeout(timer); }
      }
      return api.read(input);
    },
    async stop(input) {
      await load(input);
      const active = runs.get(input.runId);
      if (active) { active.process.stop(Object.assign(new Error('任务已暂停'), { code: 'PROCESS_CANCELLED' })); await active.finish; }
      return api.read(input);
    },
    async settle({ workDir, cancelled = false }) {
      const active = [...runs.values()].filter(item => path.resolve(item.root) === path.resolve(workDir));
      if (cancelled) for (const item of active) item.process.stop(Object.assign(new Error('任务已暂停'), { code: 'PROCESS_CANCELLED' }));
      await Promise.all(active.map(item => item.finish));
    },
    close() {
      closeOperation ??= (async () => {
        closing = true;
        for (const controller of controllers) controller.abort();
        const cancel = () => {
          const active = [...runs.values()];
          for (const item of active) item.process.stop(Object.assign(new Error('程序正在关闭'), { code: 'PROCESS_CANCELLED' }));
          return active.map(item => item.finish);
        };
        const finishing = cancel();
        await Promise.allSettled([...starting]);
        await Promise.all([...finishing, ...cancel()]);
      })();
      return closeOperation;
    },
  };
  for (const name of ['run', 'prepareDependencies']) {
    const execute = api[name];
    api[name] = input => {
      if (closing) return Promise.reject(Object.assign(new Error('程序正在关闭，执行进度已保存'), { code: 'WORKSPACE_EXECUTION_CLOSED' }));
      const controller = new AbortController();
      controllers.add(controller);
      const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal;
      const pending = execute({ ...input, signal });
      starting.add(pending);
      return pending.finally(() => { starting.delete(pending); controllers.delete(controller); });
    };
  }
  return api;
}
