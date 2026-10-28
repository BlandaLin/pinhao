import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from './store.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-task-stats-'));
  const store = createStore(root);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const task = (index, status = 'queued', patch = {}) => ({ id: `task-${index}`, fingerprint: `fingerprint-${index}`,
    role: 'translation', status, unitIds: [`unit-${index}`], ...patch });
  return { root, store, task };
}

test('runtime counts cover the full queue while taskSummaries keeps its small page', async t => {
  const { store, task } = await fixture(t);
  for (let index = 0; index < 25; index++) store.putTask('project', task(index));
  assert.equal(store.taskSummaries('project').tasks.length, 8);
  const stats = store.taskStats('project');
  assert.equal(stats.counts.queued, 25);
  assert.equal(stats.counts.total, 25);
  assert.equal(store.taskStats('project'), stats);
  store.putTask('project', task(0, 'running', { startedAt: '2026-10-23T00:00:00.000Z' }));
  assert.equal(store.taskStats('project').counts.running, 1);
  assert.equal(store.taskStats('project').counts.queued, 24);
});

test('timing projection retains actual send intervals but no source or credential material', async t => {
  const { store, task } = await fixture(t);
  store.putTask('project', task(1, 'succeeded', { input: [{ source: 'PRIVATE_SOURCE' }], connection: { apiKey: 'PRIVATE_KEY' },
    requestHistory: [{ id: 'request', status: 'received', finishedAt: '2026-10-23T00:01:00.000Z',
      artifact: { sentAt: '2026-10-23T00:00:00.000Z' }, rawUsage: { privateData: 'PRIVATE_USAGE' } }] }));
  const stats = store.taskStats('project');
  assert.deepEqual(stats.timing.translation.unitIds, ['unit-1']);
  assert.deepEqual(stats.timing.translation.intervals, [[Date.parse('2026-10-23T00:00:00.000Z'), Date.parse('2026-10-23T00:01:00.000Z')]]);
  assert.doesNotMatch(JSON.stringify(stats), /PRIVATE_/);
  assert.doesNotMatch(JSON.stringify(store.diagnosticStats('project')), /PRIVATE_/);
});

test('diagnostics distinguish pre-send replanning, cancellation and failed sent requests', async t => {
  const { store, task } = await fixture(t);
  store.putTask('project', task(1, 'paused', { requestCount: 6, requestHistory: [
    { id: 'stale', status: 'failed', code: 'PRESEND_STALE', requested: 16 },
    { id: 'cancel', status: 'cancelled', requested: 3, transportRequests: 1 },
    { id: 'timeout', status: 'failed', code: 'ETIMEDOUT', category: 'timeout', requested: 2, transportRequests: 1 },
    { id: 'received', status: 'received', requested: 4, transportRequests: 1 },
  ] }));
  const result = store.diagnosticStats('project');
  assert.equal(result.requests.total, 6);
  assert.equal(result.requests.retained, 4);
  assert.equal(result.requests.historyLimited, true);
  assert.deepEqual(result.requests.byRole.translation, { total: 6, retained: 4, received: 1, failed: 1, cancelled: 1,
    presendStale: 1, sent: 3, timeout: 1, formatError: 0, truncated: 0, evidenceQueries: 0 });
  assert.equal(result.batchSize.byRole.translation.mean, 3);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].code, 'ETIMEDOUT');
});

test('rollback, external commits and deletion invalidate derived task statistics', async t => {
  const { root, store, task } = await fixture(t);
  store.putTask('project', task(1));
  assert.equal(store.taskStats('project').counts.queued, 1);
  assert.throws(() => store.transaction(() => { store.putTask('project', task(1, 'running')); throw new Error('rollback'); }), /rollback/);
  assert.equal(store.taskStats('project').counts.running, 0);
  const external = createStore(root);
  try { external.putTask('project', task(2, 'running')); } finally { external.close(); }
  assert.equal(store.taskStats('project').counts.running, 1);
  store.removeProject('project');
  assert.equal(store.taskStats('project').counts.total, 0);
});
