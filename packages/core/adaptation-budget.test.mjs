import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from './workspace-store.mjs';
import { createAdaptationBudget } from './adaptation-budget.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-adaptation-budget-'));
  let store = createStore(path.join(root, 'data'));
  for (const id of ['first', 'second']) store.put('projects', { id, name: id, engine: 'MZ', gameDir: path.join(root, id), workspaceDir: path.join(root, `${id}-work`) });
  const factory = () => createAdaptationBudget({ readProject: id => store.one('projects', id), patchProject: (id, value) => store.patchProject(id, value), transaction: (id, fn) => store.transaction(id, fn) });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }); });
  return { factory, read: id => store.one('projects', id), patch: (id, value) => store.patchProject(id, value),
    reopen() { store.close(); store = createStore(path.join(root, 'data')); return factory(); } };
}
const options = (http = 3, windows = 2) => ({ historyCoverage: 'complete', limits: { maxHttpAttempts: http, maxWindows: windows } });
const reserve = (owner, id, windowId = 'window-1') => owner.reserve({ httpAttemptId: id, jobId: `job-${id}`, windowId, purpose: 'adaptation' });

test('ordinary metering does not inherit an exhausted hidden allowance or erase unknown history', async t => {
  const db = await fixture(t), limited = db.factory().forRequest('first', 'request-1', options(1, 1));
  limited.openWindow({ windowId: 'window-1' }); reserve(limited, 'http-1'); limited.markSent('http-1');
  limited.settle('http-1', { fetchStarted: true, outcome: 'unknown' });
  assert.equal(limited.snapshot().canOpenWindow, false);
  const meter = db.reopen().forRequest('first', 'request-1', { enforceLimits: false });
  meter.openWindow({ windowId: 'window-2' }); reserve(meter, 'http-2', 'window-2');
  meter.settle('http-2', { fetchStarted: true, outcome: 'succeeded', usage: { total_tokens: 19, cost: 0.01 } });
  const s = meter.snapshot();
  assert.equal(s.limitsEnforced, false); assert.equal(s.httpUsed, 2); assert.equal(s.windowsUsed, 2);
  assert.equal(s.remainingHttpAttempts, null); assert.equal(s.remainingWindows, null);
  assert.equal(s.unknownCostAttempts, 1); assert.equal(s.knownCost, 0.01);
  assert.deepEqual(s.recordedLimits, { maxHttpAttempts: 1, maxWindows: 1 });
  assert.deepEqual(db.read('first').adaptationAccounting['request-1'].limits, { maxHttpAttempts: 1, maxWindows: 1 });
  const partial = db.factory().forRequest('first', 'unknown-history', { enforceLimits: false });
  assert.equal(partial.snapshot().historyCoverage, 'partial');
  assert.equal(partial.snapshot().canOpenWindow, true);
  partial.openWindow({ windowId: 'window-1' }); reserve(partial, 'partial-http');
});

test('one SQLite owner preserves limits, spent HTTP and windows across reopen and caller settings', async t => {
  const db = await fixture(t), owner = db.factory().forRequest('first', 'request-1', options(2, 1));
  owner.openWindow({ windowId: 'window-1' }); owner.openWindow({ windowId: 'window-1' });
  reserve(owner, 'http-1'); owner.markSent('http-1'); owner.settle('http-1', { fetchStarted: true, outcome: 'failed', usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.01 } });
  const resumed = db.reopen().forRequest('first', 'request-1', options(99, 99));
  assert.equal(resumed.snapshot().httpUsed, 1); assert.equal(resumed.snapshot().remainingHttpAttempts, 1);
  assert.equal(resumed.snapshot().remainingWindows, 0); assert.deepEqual(resumed.snapshot().limits, { maxHttpAttempts: 2, maxWindows: 1 });
  assert.throws(() => resumed.openWindow({ windowId: 'window-2' }), { code: 'ADAPTATION_BUDGET_EXHAUSTED' });
  reserve(resumed, 'http-2'); // The final allowed window can still finish its HTTP work.
  assert.throws(() => reserve(resumed, 'http-3'), { code: 'ADAPTATION_BUDGET_EXHAUSTED' });
  assert.equal(db.read('first').name, 'first');
});

test('three concurrent jobs compete atomically for the last HTTP allowance in real project SQLite', async t => {
  const db = await fixture(t), owners = [0, 1, 2].map(() => db.factory().forRequest('first', 'request-1', options(1)));
  owners[0].openWindow({ windowId: 'window-1' });
  const results = await Promise.allSettled(owners.map((owner, index) => Promise.resolve().then(() => reserve(owner, `http-${index}`))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.reason?.code === 'ADAPTATION_BUDGET_EXHAUSTED').length, 2);
  assert.equal(owners[0].snapshot().httpUsed, 1);
});

test('only provably not-started attempts release allowance; recovered send intents stay unknown', async t => {
  const db = await fixture(t), owner = db.factory().forRequest('first', 'request-1', options());
  owner.openWindow({ windowId: 'window-1' });
  reserve(owner, 'prepared'); reserve(owner, 'intent'); owner.markSent('intent');
  reserve(owner, 'active'); owner.markSent('active');
  owner.reconcile(); assert.equal(owner.snapshot().httpUsed, 3, 'live reservations are not crash recovery');
  const recovered = db.reopen().forRequest('first', 'request-1', options()); recovered.reconcile();
  assert.equal(recovered.snapshot().httpUsed, 2); assert.equal(recovered.snapshot().httpSentKnown, 0);
  assert.equal(recovered.snapshot().knownCost, null); assert.equal(recovered.snapshot().unknownCostAttempts, 2);
  assert.equal(recovered.snapshot().usageMissingAttempts, 2);
  recovered.settle('intent', { fetchStarted: true, outcome: 'failed', usage: { total_tokens: 10 } });
  assert.equal(recovered.snapshot().httpSentKnown, 1); assert.equal(recovered.snapshot().knownUsage.totalTokens, 10);
  assert.equal(recovered.snapshot().unknownCostAttempts, 2);
});

test('settlement is idempotent, enriches missing usage and remains possible after owner close', async t => {
  const db = await fixture(t), owner = db.factory().forRequest('first', 'request-1', options()); owner.openWindow({ windowId: 'window-1' });
  reserve(owner, 'http-1'); owner.markSent('http-1'); owner.close('paused-budget');
  assert.throws(() => reserve(owner, 'http-2'), { code: 'ADAPTATION_BUDGET_EXHAUSTED' });
  owner.settle('http-1', { fetchStarted: true, outcome: 'succeeded', usage: { total_tokens: 12 } });
  owner.settle('http-1', { fetchStarted: true, usage: { total_tokens: 12, cost: 0.02 } });
  owner.settle('http-1', { fetchStarted: false });
  assert.equal(owner.snapshot().httpUsed, 1); assert.equal(owner.snapshot().httpSentKnown, 1);
  assert.equal(owner.snapshot().knownUsage.totalTokens, 12); assert.equal(owner.snapshot().knownCost, 0.02);
  assert.equal(owner.snapshot().unknownCostAttempts, 0);
});

test('partial legacy history is never zero-consumption credit and explicit grants are idempotent', async t => {
  const db = await fixture(t), owner = db.factory().forRequest('first', 'legacy', { limits: options().limits });
  assert.equal(owner.snapshot().historyCoverage, 'partial'); assert.equal(owner.snapshot().canOpenWindow, false);
  assert.throws(() => owner.openWindow({ windowId: 'window-1' }), { code: 'ADAPTATION_BUDGET_EXHAUSTED' });
  owner.reconcile([{ projectId: 'first', adaptationRequestId: 'legacy', httpAttemptId: 'old-http', windowId: 'old-window', fetchStarted: true, outcome: 'unknown' }]);
  owner.grantAdditional({ grantId: 'human-approval-1', httpAttempts: 2, windows: 1, reason: 'Explicit additional test allowance' });
  owner.grantAdditional({ grantId: 'human-approval-1', httpAttempts: 2, windows: 1, reason: 'Explicit additional test allowance' });
  assert.equal(owner.snapshot().remainingHttpAttempts, 2); assert.equal(owner.snapshot().remainingWindows, 1);
  owner.openWindow({ windowId: 'window-1' }); reserve(owner, 'new-http');
  assert.equal(owner.snapshot().httpUsed, 2); assert.equal(owner.snapshot().historyCoverage, 'partial');
  const reopened = db.reopen().forRequest('first', 'legacy', options(999));
  assert.equal(reopened.snapshot().historyCoverage, 'partial'); assert.equal(reopened.snapshot().remainingHttpAttempts, 1);
});

test('project/request ownership and unknown future schemas cannot be silently overwritten', async t => {
  const db = await fixture(t), factory = db.factory(), first = factory.forRequest('first', 'same-request', options(1));
  const second = factory.forRequest('second', 'same-request', options(2));
  first.openWindow({ windowId: 'window-1' }); reserve(first, 'http-1');
  assert.equal(second.snapshot().httpUsed, 0);
  assert.throws(() => reserve(second, 'http-2'), /registered service window/);
  const before = db.read('first').adaptationAccounting;
  db.patch('first', { adaptationAccounting: { ...before, future: { schema: 'future-unsupported' } } });
  assert.throws(() => factory.forRequest('first', 'future', options()), /Unsupported/);
  assert.equal(db.read('first').adaptationAccounting.future.schema, 'future-unsupported');
});

test('storage failure denies admission and rolls back instead of fabricating budget success', () => {
  let row = { id: 'first' }, fail = false;
  const factory = createAdaptationBudget({ readProject: () => row, patchProject: (_id, value) => { if (fail) throw new Error('Disk unavailable'); row = { ...row, ...value }; },
    transaction: (_id, fn) => { const before = structuredClone(row); try { return fn(); } catch (error) { row = before; throw error; } } });
  const owner = factory.forRequest('first', 'request', options()); owner.openWindow({ windowId: 'window-1' }); fail = true;
  assert.throws(() => reserve(owner, 'http-1'), /Disk unavailable/); assert.equal(owner.snapshot().httpUsed, 0);
});
