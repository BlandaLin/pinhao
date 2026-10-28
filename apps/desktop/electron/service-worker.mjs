import { parentPort, workerData } from 'node:worker_threads';
import { createService } from '../../../packages/core/service.mjs';
import { productWorker } from './host.mjs';
import { configureSystemTrust } from './network.mjs';

const errorRecord = error => ({ ...error, name: error?.name || 'Error', message: error?.message || String(error), stack: error?.stack });
const secrets = new Map(), active = new Set();
let nextId = 0, service, closing = false;
const secretCall = (method, args) => new Promise((resolve, reject) => {
  const id = ++nextId;
  secrets.set(id, { resolve, reject });
  parentPort.postMessage({ type: 'secret', id, method, args });
});

parentPort.on('message', message => {
  if (message.type === 'secret-result') {
    const request = secrets.get(message.id);
    if (!request) return;
    secrets.delete(message.id);
    message.error ? request.reject(Object.assign(new Error(message.error.message), message.error)) : request.resolve(message.result);
    return;
  }
  if (message.type !== 'call') return;
  const respond = async () => {
    const response = { type: 'result', id: message.id };
    try {
      if (!service || closing || !Object.hasOwn(service, message.method) || typeof service[message.method] !== 'function') throw new Error('后台操作暂不可用，请重新打开工作台。');
      if (message.method === 'close') closing = true;
      response.result = await service[message.method](...message.args);
    } catch (error) { response.error = errorRecord(error); }
    if (message.method === 'close') await Promise.allSettled([...active]);
    parentPort.postMessage(response);
    if (message.method === 'close') parentPort.close();
  };
  const operation = respond();
  if (message.method !== 'close') {
    active.add(operation);
    operation.finally(() => active.delete(operation));
  }
});

try {
  configureSystemTrust();
  service = await createService({ dataDir: workerData.dataDir, defaultFontPath: workerData.defaultFontPath, deferCatalog: true,
    ...(workerData.workerOptions?.dshRuntimeRoot ? { adaptationProvider: async options => {
      const { runDshAdaptation } = await import('../../../packages/technical/dsh-runner.mjs');
      return runDshAdaptation({ ...options, dsh: { sourceRoot: workerData.workerOptions.dshRuntimeRoot } });
    } } : {}),
    worker: productWorker(workerData.workerOptions),
    secrets: { encrypt: (...args) => secretCall('encrypt', args), decrypt: (...args) => secretCall('decrypt', args) },
    onChanged: () => parentPort.postMessage({ type: 'changed' }),
  });
  parentPort.postMessage({ type: 'ready' });
} catch (error) {
  parentPort.postMessage({ type: 'startup-error', error: errorRecord(error) });
  parentPort.close();
}
