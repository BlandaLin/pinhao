import { Worker } from 'node:worker_threads';

const errorRecord = error => ({ ...error, name: error?.name || 'Error', message: error?.message || String(error), stack: error?.stack });
const restoreError = value => Object.assign(new Error(value.message), value);
const stoppedError = () => Object.assign(new Error('后台工作进程已结束，请重新打开工作台。项目与已保存成果继续保留。'), { code: 'SERVICE_WORKER_STOPPED' });

/** Keep domain work off the window thread; only platform credential operations return here. */
export async function createServiceClient({ dataDir, workerOptions, defaultFontPath, secrets, onChanged = () => {},
  workerUrl = new URL('./service-worker.mjs', import.meta.url) }) {
  const worker = new Worker(workerUrl, { workerData: { dataDir, workerOptions, defaultFontPath } });
  const pending = new Map(), methods = new Map();
  let nextId = 0, closing = false, closePromise, failure;
  let readyResolve, readyReject, exitResolve;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exited = new Promise(resolve => { exitResolve = resolve; });
  const fail = error => {
    failure ??= error;
    readyReject(failure);
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', code => {
    exitResolve();
    if (pending.size || !closing || code !== 0) fail(stoppedError());
  });
  worker.on('message', async message => {
    if (message.type === 'ready') readyResolve();
    else if (message.type === 'startup-error') fail(restoreError(message.error));
    else if (message.type === 'changed') onChanged();
    else if (message.type === 'result') {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      message.error ? request.reject(restoreError(message.error)) : request.resolve(message.result);
    } else if (message.type === 'secret') {
      const response = { type: 'secret-result', id: message.id };
      try {
        if (!['encrypt', 'decrypt'].includes(message.method) || typeof secrets?.[message.method] !== 'function') throw new Error('密钥存储服务暂不可用，请重新打开工作台。');
        response.result = await secrets[message.method](...message.args);
      } catch (error) { response.error = errorRecord(error); }
      try { worker.postMessage(response); }
      catch (error) { fail(error); }
    }
  });
  const call = (method, args) => {
    if (failure || (closing && method !== 'close')) return Promise.reject(failure || stoppedError());
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { worker.postMessage({ type: 'call', id, method, args }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  };
  const close = () => closePromise ??= (async () => {
    closing = true;
    try { await call('close', []); }
    finally { await exited; }
  })();
  await ready;
  return new Proxy({}, { get(_target, method) {
    if (method === 'then' || typeof method !== 'string') return undefined;
    if (method === 'close') return close;
    if (!methods.has(method)) methods.set(method, (...args) => call(method, args));
    return methods.get(method);
  } });
}
