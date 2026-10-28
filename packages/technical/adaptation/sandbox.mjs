import { Worker } from 'node:worker_threads';
import { independentRoot } from './paths.mjs';
import path from 'node:path';
import { realpath } from 'node:fs/promises';

// Sized for real game data, not for previews: parsing and re-emitting a 100MB+ resource needs
// wall time and heap, and a byte-exact roundtrip fails on guesses. 60s/512MB per run stays a
// sandbox (no Node, no network, source-rooted paths) rather than a cost knob.
const MEBIBYTE = 1024 * 1024;
export const DEFAULT_LIMITS = Object.freeze({ timeoutMs: 60000, memoryBytes: 512 * MEBIBYTE, maxFileBytes: 256 * MEBIBYTE, maxReadBytes: 512 * MEBIBYTE, maxWriteBytes: 512 * MEBIBYTE, maxResultBytes: 32 * MEBIBYTE, maxLogBytes: 4 * MEBIBYTE, maxFiles: 20000, maxOperations: 50000 });
const WORKER_HEAP_MB = 1536; // base64 of a 256MB file alone is ~341M characters in the worker
const PROGRESS_LOG_CHARACTERS = 200000; // guest logs replayed when a run times out

export async function runSandbox({ code, action, input = {}, sourceDir, outputDir, allowedFiles = [], signal, limits = {}, workerPath = new URL('./sandbox-worker.mjs', import.meta.url) }) {
  signal?.throwIfAborted();
  if (typeof code !== 'string' || Buffer.byteLength(code) > 512 * 1024) throw new Error('适配代码大小达到上限');
  if (!['detect', 'extract', 'validate', 'roundtrip', 'build', 'assemble'].includes(action)) throw new Error('未知适配步骤');
  sourceDir = await realpath(path.resolve(sourceDir));
  if (outputDir) outputDir = await independentRoot(sourceDir, outputDir);
  limits = { ...DEFAULT_LIMITS, ...limits };
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: { code, action, input, sourceDir, outputDir, allowedFiles, limits }, resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB, maxYoungGenerationSizeMb: 64 } });
    let finished = false;
    // Guest logs are streamed, so a timeout still shows what the adapter printed before it stopped.
    const progressLogs = [];
    let progressCharacters = 0;
    const noteProgress = log => {
      if (typeof log !== 'string' || progressCharacters + log.length > PROGRESS_LOG_CHARACTERS) return;
      progressCharacters += log.length; progressLogs.push(log);
    };
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      // Do not hand the output tree to host verification while the worker is
      // still tearing down its filesystem/runtime state.
      const settle = () => { if (error) reject(error); else resolve(value); };
      try { worker.terminate().then(settle, terminationError => reject(error ?? terminationError)); }
      catch (terminationError) { reject(error ?? terminationError); }
    };
    const abort = () => finish(signal.reason instanceof Error ? signal.reason : new DOMException('适配任务已取消', 'AbortError'));
    const timer = setTimeout(() => finish(Object.assign(new Error('适配器执行超时'), { code: 'ADAPTER_TIMEOUT', evidence: { logs: progressLogs, timeoutMs: limits.timeoutMs } })), limits.timeoutMs + 3000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!finished) finish(new Error(`适配执行进程提前结束：${code}`)); });
    worker.on('message', value => {
      if (value && typeof value === 'object' && value.progress) { noteProgress(value.progress.log); return; }
      if (finished) return;
      if (value?.ok) finish(null, value); else finish(Object.assign(new Error(value.error.message), { code: value.error.code, evidence: value }));
    });
    if (signal?.aborted) abort();
  });
}
