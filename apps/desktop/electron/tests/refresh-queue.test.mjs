import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createRefreshQueue } from '../../src/refresh-queue.ts';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('progress notifications coalesce and retain the final change in a burst', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const calls = [];
  let state = 'running';
  const queue = createRefreshQueue(async force => { calls.push({ state, force }); });
  t.after(() => queue.dispose());
  queue.notify(); await setImmediate();
  for (let i = 0; i < 100; i++) queue.notify(true);
  state = 'completed'; queue.notify(true);
  t.mock.timers.tick(499); await setImmediate();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1); await setImmediate();
  assert.deepEqual(calls, [{ state: 'running', force: false }, { state: 'completed', force: true }]);
  t.mock.timers.tick(2000); await setImmediate();
  assert.equal(calls.length, 2);
});

test('an action during an in-flight read awaits the fresh trailing read with no overlap', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const first = deferred(), second = deferred(), calls = [];
  const queue = createRefreshQueue(async force => {
    calls.push(force);
    await (calls.length === 1 ? first : second).promise;
  });
  t.after(() => queue.dispose());
  queue.notify();
  let refreshed = false;
  const action = queue.request().then(() => { refreshed = true; });
  for (let i = 0; i < 20; i++) queue.notify(true);
  assert.deepEqual(calls, [false]);
  first.resolve(); await setImmediate();
  assert.equal(refreshed, false);
  t.mock.timers.tick(500); await setImmediate();
  assert.deepEqual(calls, [false, true]);
  assert.equal(refreshed, false);
  second.resolve(); await action;
  assert.equal(refreshed, true);
});

test('an explicit action refresh bypasses a queued polling delay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const calls = [];
  const queue = createRefreshQueue(async force => { calls.push(force); });
  t.after(() => queue.dispose());
  queue.notify(); await setImmediate();
  queue.notify();
  await queue.request();
  assert.deepEqual(calls, [false, true]);
  t.mock.timers.tick(1000); await setImmediate();
  assert.equal(calls.length, 2);
});

test('disposing a queue releases queued actions and cancels delayed refreshes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const first = deferred();
  let calls = 0;
  const queue = createRefreshQueue(async () => { calls++; await first.promise; });
  queue.notify();
  const waiting = queue.request();
  queue.dispose();
  await waiting;
  first.resolve(); await setImmediate();
  t.mock.timers.tick(2000); await setImmediate();
  assert.equal(calls, 1);
  await queue.request();
  assert.equal(calls, 1);
});
