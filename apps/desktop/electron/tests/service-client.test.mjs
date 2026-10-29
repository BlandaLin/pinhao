import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServiceClient } from '../service-client.mjs';
import { defaultSettings } from '../../../../packages/core/service.mjs';

const workerUrl = new URL('./fixtures/service-worker-fixture.mjs', import.meta.url);
async function fixture(t, options = {}) {
  const service = await createServiceClient({ workerUrl, ...options });
  t.after(() => service.close().catch(() => {}));
  return service;
}

test('domain CPU work leaves the host event loop responsive and forwards changes', async t => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const service = await fixture(t, { onChanged: started });
  let completed = false;
  const job = service.busy({ durationMs: 300 }).then(result => { completed = true; return result; });
  await entered;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(completed, false, 'the host timer runs while the service thread is CPU-bound');
  assert.equal(await job, 'finished');
});

test('generic async proxy forwards service and assist methods without becoming thenable', async t => {
  const service = await fixture(t);
  assert.equal(service.then, undefined);
  for (const method of ['snapshot', 'getProject', 'prepareRecollection', 'captureRecollection', 'getRecollectionBackup',
    'updateRecollectionBackup', 'recordRuntimeObservation']) {
    assert.deepEqual(await service[method]({ projectId: 'neutral' }), { method, args: [{ projectId: 'neutral' }] });
  }
  await assert.rejects(service.getProject({ callback() {} }), { name: 'DataCloneError' });
  assert.deepEqual(await service.snapshot(), { method: 'snapshot', args: [] });
});

test('credential operations stay in the host and errors retain their domain properties', async t => {
  const calls = [];
  const service = await fixture(t, { secrets: {
    async encrypt(text) { calls.push(text); return `sealed:${text}`; },
    async decrypt() { throw Object.assign(new Error('Fixture credential unavailable'), { code: 'FIXTURE_KEY' }); },
  } });
  assert.equal(await service.secret({ method: 'encrypt', text: 'neutral-fixture-value' }), 'sealed:neutral-fixture-value');
  assert.deepEqual(calls, ['neutral-fixture-value']);
  await assert.rejects(service.secret({ method: 'decrypt', text: 'sealed:value' }), { message: 'Fixture credential unavailable', code: 'FIXTURE_KEY' });
  await assert.rejects(service.fail(), { name: 'FixtureError', code: 'FIXTURE_REPAIR', repairQueued: true });
  await assert.rejects(service.secret({ method: 'unknown', text: 'value' }), /密钥存储服务/);
});

test('close is idempotent and waits for the worker to exit after its response', async t => {
  const exitFlag = new SharedArrayBuffer(4);
  const service = await fixture(t, { workerOptions: { exitFlag } });
  const closing = service.close();
  assert.equal(service.close(), closing);
  await closing;
  assert.equal(Atomics.load(new Int32Array(exitFlag), 0), 1);
  await assert.rejects(service.snapshot(), { code: 'SERVICE_WORKER_STOPPED' });
});

test('worker startup and fatal failure reject callers without replaying requests', async t => {
  await assert.rejects(createServiceClient({ workerUrl, workerOptions: { startupError: true } }), { code: 'FIXTURE_STARTUP' });
  const service = await fixture(t);
  const held = assert.rejects(service.hold(), { code: 'SERVICE_WORKER_STOPPED' });
  await assert.rejects(service.crash(), { code: 'SERVICE_WORKER_STOPPED' });
  await held;
  await assert.rejects(service.snapshot(), { code: 'SERVICE_WORKER_STOPPED' });
});

test('real service worker opens an isolated store and persists settings through host credentials', async t => {
  const parent = path.resolve('local/service-client-tests');
  await mkdir(parent, { recursive: true });
  const dataDir = await mkdtemp(path.join(parent, 'neutral-'));
  let service, changed = 0;
  t.after(async () => {
    await service?.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const calls = [];
  service = await createServiceClient({ dataDir, workerOptions: { pythonPath: path.join(dataDir, 'missing-codec'), workerPath: path.join(dataDir, 'missing-worker.py') },
    secrets: { encrypt: async text => { calls.push(text); return 'neutral-sealed-value'; }, decrypt: async () => 'neutral-fixture-key' },
    onChanged: () => { changed++; },
  });
  assert.deepEqual((await service.snapshot()).projects, []);
  const settings = defaultSettings();
  settings.connection.apiKey = 'neutral-fixture-key';
  const saved = await service.saveSettings(settings);
  assert.equal(saved.connection.hasKey, true);
  assert.equal(saved.connection.apiKey, undefined);
  assert.deepEqual(calls, ['neutral-fixture-key']);
  assert.ok(changed > 0);
  await assert.rejects(service.getProject({ projectId: 'missing' }), /重新选择项目/);
  await assert.rejects(service.constructor(), /后台操作/);
  await service.close();
  service = undefined;
});

test('the real worker receives the build target and preserves a language chosen before reopening', async t => {
  const parent = path.resolve('local/service-client-tests');
  await mkdir(parent, { recursive: true });
  const dataDir = await mkdtemp(path.join(parent, 'target-'));
  const workerOptions = { pythonPath: path.join(dataDir, 'missing-codec'), workerPath: path.join(dataDir, 'missing-worker.py') };
  let service;
  t.after(async () => {
    await service?.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  service = await createServiceClient({ dataDir, workerOptions, defaultTargetLanguage: 'en' });
  const settings = (await service.snapshot()).settings;
  assert.equal(settings.targetLanguage, 'en');
  assert.equal((await service.saveSettings({ ...settings, targetLanguage: '' })).targetLanguage, 'en');
  await service.saveSettings({ ...settings, targetLanguage: 'zh-Hans' });
  await service.close();
  service = await createServiceClient({ dataDir, workerOptions, defaultTargetLanguage: 'en' });
  assert.equal((await service.snapshot()).settings.targetLanguage, 'zh-Hans');
});
