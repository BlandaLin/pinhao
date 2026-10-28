import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createService } from './service.mjs';

const parent = path.resolve('local/service-startup-tests');
await mkdir(parent, { recursive: true });
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

async function fixture(t, deferCatalog) {
  const dataDir = await mkdtemp(path.join(parent, 'neutral-'));
  let service, release, aborted = false, changes = 0, started = false;
  let signalStarted;
  const catalogStarted = new Promise(resolve => { signalStarted = resolve; });
  const pending = createService({ dataDir, deferCatalog, scriptTools: null, imageTools: null,
    onChanged: () => { changes++; },
    worker: async (command, _args, { signal }) => {
      assert.equal(command, 'catalog');
      started = true;
      signalStarted();
      return new Promise((resolve, reject) => {
        release = resolve;
        signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
      });
    },
  }).then(value => { service = value; return value; });
  t.after(async () => {
    await Promise.race([catalogStarted, pending]);
    release?.({ engines: [] });
    await pending;
    await service.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
  });
  return { pending, catalogStarted, release: value => release(value), get service() { return service; },
    get changes() { return changes; }, get aborted() { return aborted; }, get started() { return started; } };
}

test('desktop deferred catalog permits snapshots but holds production until capabilities arrive', async t => {
  const f = await fixture(t, true);
  const service = await f.pending;
  assert.equal(f.started, true);
  assert.deepEqual((await service.snapshot()).projects, []);
  let settled = false;
  const production = assert.rejects(service.startProject({ projectId: 'missing' }), /重新选择项目/)
    .then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  const engines = [{ id: 'neutral', name: 'Neutral codec', extract: true, build: true }];
  f.release({ engines, nativeRevision: 'fixture-native-revision' });
  await production;
  assert.deepEqual((await service.snapshot()).engines, engines);
  assert.equal(f.changes, 1);
});

test('closing during deferred catalog aborts initialization and rejects held production without late writes', async t => {
  const f = await fixture(t, true), service = await f.pending;
  const held = assert.rejects(service.createProject({ gameDir: 'never-probed' }), /正在关闭/);
  await service.close();
  await held;
  assert.equal(f.aborted, true);
  assert.equal(f.changes, 0);
  await service.close();
});

test('default service initialization still waits for catalog and does not emit a new startup event', async t => {
  const f = await fixture(t, false);
  await f.catalogStarted;
  assert.equal(f.started, true);
  assert.equal(f.service, undefined);
  f.release({ engines: [] });
  await f.pending;
  assert.equal(f.changes, 0);
});

test('deferred catalog failure retains capability fallback and unblocks production', async t => {
  const dataDir = await mkdtemp(path.join(parent, 'failed-'));
  const service = await createService({ dataDir, deferCatalog: true, scriptTools: null, imageTools: null,
    worker: async () => { throw new Error('Neutral unavailable codec'); },
  });
  t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true, maxRetries: 3 }); });
  await assert.rejects(service.startProject({ projectId: 'missing' }), /重新选择项目/);
  assert.ok((await service.snapshot()).engines.length > 0);
});
