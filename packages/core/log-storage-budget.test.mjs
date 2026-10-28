import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createStore } from './store.mjs';
import { createLogStorageBudget } from './log-storage-budget.mjs';

test('request log admission shares the last bytes across runs, settles known prefixes and recovers uncertain writes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-log-budget-'));
  let db = createStore(root);
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); });
  db.put('projects', { id: 'a', workspaceDir: root });
  const create = () => createLogStorageBudget({ readProject: id => db.one('projects', id), patchProject: db.patchProject,
    transaction: (_id, action) => db.transaction(action), maxRequestBytes: 32 });
  let budget = create();
  const a = { projectId: 'a', requestId: 'r', runId: 'run-a1', workDir: path.join(root, 'work'), bytes: 20 };
  const b = { ...a, runId: 'run-b2' };
  assert.equal(budget.reserve(a), 20);
  assert.equal(budget.reserve(b), 12);
  assert.equal(budget.reserve({ ...a, runId: 'run-c3' }), 0);
  budget.settle({ ...a, reservedBytes: 20, persistedBytes: 8 });
  budget.settle({ ...b, reservedBytes: 12, persistedBytes: 4, uncertain: true });
  assert.equal(db.one('projects', 'a').logStorage.requests.r.used, 20, 'unknown writes retain their full reservation');
  await mkdir(path.join(a.workDir, 'process-runs'), { recursive: true });
  for (const [runId, size] of [['run-a1', 8], ['run-b2', 7]]) {
    await writeFile(path.join(a.workDir, 'process-runs', `${runId}.stdout`), Buffer.alloc(size));
    await writeFile(path.join(a.workDir, 'process-runs', `${runId}.stderr`), Buffer.alloc(0));
  }
  db.close(); db = createStore(root); budget = create();
  await budget.reconcile('a');
  assert.equal(db.one('projects', 'a').logStorage.requests.r.used, 15);
  assert.equal(budget.reserve({ ...a, runId: 'run-d4', bytes: 100 }), 17);
  assert.throws(() => budget.reserve({ ...a, workDir: path.dirname(root) }), /belong/);
});
