import { spawn } from 'node:child_process';
import path from 'node:path';

export function processEnvironment(extra = {}) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT'].includes(key.toUpperCase()))), ...extra };
}

/** Cancellation settles only after close and the Windows tree-termination command finish. */
export function launchManagedProcess({ program, args = [], cwd, env = processEnvironment(), input,
  timeoutMs, signal, spawnProcess = spawn, onStdout = () => {}, onStderr = () => {}, detached = process.platform !== 'win32' }) {
  signal?.throwIfAborted();
  const launchCwd = process.platform === 'win32' && cwd?.length >= 240 ? path.toNamespacedPath(cwd) : cwd;
  const child = spawnProcess(program, args, { cwd: launchCwd, env, windowsHide: true, shell: false, detached, stdio: ['pipe', 'pipe', 'pipe'] });
  let stopError, timer, ceiling, killing = Promise.resolve(), settled = false;
  // Idle timeout: any output from the worker restarts the window, so a long but progressing
  // command (assemble over thousands of files) is no longer killed at the total-time mark.
  const armIdle = () => {
    if (!timeoutMs || settled) return;
    clearTimeout(timer);
    timer = setTimeout(() => stop(Object.assign(new Error('进程执行超时'), { code: 'PROCESS_TIMEOUT' })), timeoutMs);
    timer.unref?.();
  };
  const stop = reason => {
    if (stopError || settled) return;
    stopError = reason;
    if (process.platform === 'win32' && child.pid) {
      killing = new Promise(resolve => {
        const killer = spawnProcess('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { child.kill(); resolve(); });
        killer.once('exit', code => { if (code !== 0) child.kill(); resolve(); });
      });
    } else {
      try { if (detached && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch { child.kill(); }
    }
  };
  const abort = () => stop(Object.assign(new Error('任务已暂停'), { name: 'AbortError', code: 'PROCESS_CANCELLED' }));
  const completion = new Promise((resolve, reject) => {
    const finish = async (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(ceiling); signal?.removeEventListener('abort', abort);
      await killing;
      error ? reject(error) : resolve(result);
    };
    child.once('error', error => finish(stopError ?? error));
    child.once('close', (code, exitSignal) => finish(stopError, { exitCode: code, signal: exitSignal }));
    const consume = (stream, callback) => stream.on('data', chunk => {
      try {
        const pending = callback(chunk);
        if (pending?.then) { stream.pause(); pending.then(() => stream.resume(), error => stop(error)); }
        armIdle();
      } catch (error) { stop(error); }
    });
    consume(child.stdout, onStdout); consume(child.stderr, onStderr);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (timeoutMs) {
      armIdle();
      // A hard ceiling keeps a process that chatters forever from outliving every idle window.
      ceiling = setTimeout(() => stop(Object.assign(new Error('进程执行超时'), { code: 'PROCESS_TIMEOUT' })), timeoutMs * 4);
      ceiling.unref?.();
    }
  });
  return { child, completion, stop };
}
