import { parentPort, workerData } from 'node:worker_threads';

const pending = new Map();
let nextId = 0;
parentPort.on('message', async message => {
  if (message.type === 'secret-result') {
    const request = pending.get(message.id);
    pending.delete(message.id);
    message.error ? request.reject(message.error) : request.resolve(message.result);
    return;
  }
  if (message.type !== 'call') return;
  const response = { type: 'result', id: message.id };
  try {
    if (message.method === 'busy') {
      parentPort.postMessage({ type: 'changed' });
      const until = performance.now() + message.args[0].durationMs;
      while (performance.now() < until) { /* CPU-bound domain-work fixture. */ }
      response.result = 'finished';
    } else if (message.method === 'secret') {
      response.result = await new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        parentPort.postMessage({ type: 'secret', id, method: message.args[0].method, args: [message.args[0].text] });
      });
    } else if (message.method === 'fail') {
      throw { name: 'FixtureError', message: 'Fixture repair is queued', code: 'FIXTURE_REPAIR', repairQueued: true };
    } else if (message.method === 'hold') return;
    else if (message.method === 'crash') process.exit(3);
    else if (message.method === 'close') {
      parentPort.postMessage(response);
      setTimeout(() => {
        if (workerData.workerOptions?.exitFlag) Atomics.store(new Int32Array(workerData.workerOptions.exitFlag), 0, 1);
        parentPort.close();
      }, 30);
      return;
    } else response.result = { method: message.method, args: message.args };
  } catch (error) { response.error = { ...error, name: error.name, message: error.message }; }
  parentPort.postMessage(response);
});
if (workerData.workerOptions?.startupError) {
  parentPort.postMessage({ type: 'startup-error', error: { name: 'FixtureError', message: 'Fixture startup failed', code: 'FIXTURE_STARTUP' } });
  parentPort.close();
} else parentPort.postMessage({ type: 'ready' });
