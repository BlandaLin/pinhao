import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRunSummaryMonitor, technicalRequestStats, writeRunSummary, __testing } from '../diagnostics.mjs';

async function fixture(t, enabled = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-diagnostics-'));
  if (enabled) await writeFile(path.join(root, 'diagnostics.on'), '');
  __testing.resetEnabled();
  t.after(async () => { __testing.resetEnabled(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  return root;
}

test('disabled diagnostics do not query project data or evaluate its file paths', async t => {
  const root = await fixture(t, false);
  let queried = 0;
  const monitor = createRunSummaryMonitor({ enabled: () => false, getHeads: async () => { queried++; return []; },
    getSnapshot: async () => { queried++; }, write: async () => { queried++; } });
  await monitor.prime(); monitor.changed(); await monitor.flush(); await monitor.close();
  await writeRunSummary(root, { get workspaceDir() { throw new Error('must not inspect project'); } });
  assert.equal(queried, 0);
});

test('automatic pauses write after in-flight work settles, without treating jobs as failures', async t => {
  await fixture(t);
  let now = 1000, head = { id: 'project', status: 'running' }, inFlight = 0;
  const written = [];
  const monitor = createRunSummaryMonitor({ enabled: () => true, delayMs: 60000, clock: () => now,
    getHeads: async () => [head], getSnapshot: async () => ({ ...head, inFlight, tasks: { running: 0 },
      requests: { total: 4 }, failures: [{ role: 'translation', code: 'ETIMEDOUT', count: 1 }] }),
    write: async snapshot => written.push(snapshot) });
  t.after(() => monitor.close());
  await monitor.prime();
  head = { ...head, status: 'paused' }; inFlight = 2; now = 2000;
  monitor.changed(); await monitor.flush();
  assert.equal(written.length, 0);
  inFlight = 0; now = 2500; await monitor.flush();
  assert.equal(written.length, 1);
  assert.equal(written[0].durationMs, 1500);
  assert.deepEqual(written[0].failures, [{ role: 'translation', code: 'ETIMEDOUT', count: 1 }]);
  await monitor.flush();
  assert.equal(written.length, 1);
});

test('the existing paused backlog is not rescanned when the application opens', async t => {
  await fixture(t);
  let queried = 0;
  const monitor = createRunSummaryMonitor({ enabled: () => true, getHeads: async () => [{ id: 'paused', status: 'paused' }],
    getSnapshot: async () => { queried++; }, write: async () => { queried++; } });
  await monitor.prime(); monitor.changed(); await monitor.flush(); await monitor.close();
  assert.equal(queried, 0);
});

test('deleting a paused project removes its pending diagnostic retry', async t => {
  await fixture(t);
  let heads = [{ id: 'project', status: 'running' }], reads = 0;
  const monitor = createRunSummaryMonitor({ enabled: () => true, delayMs: 60000, getHeads: async () => heads,
    getSnapshot: async () => { reads++; return { id: 'project', status: 'paused', inFlight: 1 }; },
    write: async () => assert.fail('the project was removed before its requests settled') });
  await monitor.prime();
  heads = [{ id: 'project', status: 'paused' }];
  monitor.changed(); await monitor.flush();
  assert.equal(reads, 1);
  heads = [];
  await monitor.flush(); await monitor.flush(); await monitor.close();
  assert.equal(reads, 1, 'a deleted project is not queried again');
});

test('technical artifact metadata distinguishes cancellation from failure without retaining payloads', async t => {
  const root = await fixture(t);
  const base = path.join(root, 'technical', 'run', 'adapter-workbench', 'jobs', 'resource', 'request-artifacts');
  for (const [id, result] of Object.entries({ success: { status: 'received', sentAt: '2026-10-23', parsedResult: { records: [{ source: 'PRIVATE_SOURCE' }] } },
    cancel: { status: 'failed', error: { name: 'AbortError', code: 20, message: 'PRIVATE_ERROR' } },
    timeout: { status: 'failed', error: { code: 'TECHNICAL_REQUEST_TIMEOUT' } } })) {
    await mkdir(path.join(base, id), { recursive: true });
    await writeFile(path.join(base, id, 'result.json'), JSON.stringify(result));
  }
  const stats = await technicalRequestStats(root);
  assert.equal(stats.total, 3); assert.equal(stats.received, 1); assert.equal(stats.cancelled, 1);
  assert.equal(stats.failed, 1); assert.equal(stats.timeout, 1);
  assert.doesNotMatch(JSON.stringify(stats), /PRIVATE_/);
  await writeRunSummary(root, { id: 'project', workspaceDir: root, status: 'paused', tasks: { total: 2 },
    requests: { total: 12, retained: 8, historyLimited: true, byRole: {} }, failures: [{ code: 'ETIMEDOUT', count: 1 }] });
  const summary = JSON.parse(await readFile(path.join(root, 'run-summary.json'), 'utf8'));
  assert.equal(summary.requests.total, 15);
  assert.equal(summary.requests.retained, 8);
  assert.equal(summary.requests.historyLimited, true);
  assert.equal(summary.durationBasis, 'unavailable');
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_|model_step|run_tool/);
});

test('technical summaries count coordinator and resource display-review attempts without payload or usage assumptions', async t => {
  const root = await fixture(t);
  const results = [
    ['request-artifacts/author', { status: 'received', sentAt: '2026-10-25' }],
    ['display-review/request-artifacts/coordinator', { status: 'received', sentAt: '2026-10-25', summary: { usage: null } }],
    ['adapter-workbench/display-review/request-artifacts/workbench', { status: 'failed', sentAt: '2026-10-25', error: { code: 'TECHNICAL_REQUEST_TIMEOUT' } }],
    ['adapter-workbench/jobs/resource/request-artifacts/resource-author', { status: 'received', sentAt: '2026-10-25' }],
    ['adapter-workbench/jobs/resource/display-review/request-artifacts/resource-reviewer', { status: 'failed', sentAt: '2026-10-25', error: { name: 'AbortError' } }],
  ];
  for (const [relative, result] of results) {
    const directory = path.join(root, 'technical', 'run', relative);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'result.json'), JSON.stringify({ ...result, request: 'PRIVATE_PROMPT', summary: { usage: null }, parsedResult: 'PRIVATE_RESPONSE' }));
  }
  const stats = await technicalRequestStats(root);
  assert.equal(stats.total, 5); assert.equal(stats.sent, 5); assert.equal(stats.received, 3);
  assert.equal(stats.failed, 1); assert.equal(stats.timeout, 1); assert.equal(stats.cancelled, 1);
  await writeRunSummary(root, { id: 'project', workspaceDir: root, status: 'paused', requests: { total: 2 } });
  const summary = JSON.parse(await readFile(path.join(root, 'run-summary.json'), 'utf8'));
  assert.equal(summary.requests.total, 7);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_|usage|cost/);
});
