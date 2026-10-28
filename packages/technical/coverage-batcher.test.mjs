import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoverageBatcher } from './coverage-batcher.mjs';

const unit = (id, file, source = 'A complete scene.') => ({ id, source, locator: { file, pointer: '/text' } });
const request = (jobId, units, coverageDecisions = []) => ({ jobId, scopeFiles: [units.at(-1).locator.file], units, coverageDecisions });

test('independent checks share one scan and retain compatible duplicate evidence once', async () => {
  const calls = [], result = { needsAdaptation: false }, common = unit('common', 'common.json');
  const decision = { id: 'classification', evidenceHash: 'same-evidence' };
  const verify = createCoverageBatcher(async input => { calls.push(input); return result; });
  const outputs = await Promise.all([
    verify(request('first', [common, unit('first', 'first.json')], [decision])),
    verify(request('second', [structuredClone(common), unit('second', 'second.json')], [structuredClone(decision)])),
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].units.map(item => item.id), ['common', 'first', 'second']);
  assert.deepEqual(calls[0].coverageDecisions, [decision]);
  assert.ok(outputs.every(output => output === result));
});

test('same-job previews and overlapping Windows file scopes run separate scans', async () => {
  const calls = [], verify = createCoverageBatcher(async input => { calls.push(input); return input; });
  await Promise.all([
    verify(request('same-job', [unit('first', 'first.json')])),
    verify(request('same-job', [unit('second', 'second.json')])),
    verify(request('other-job', [unit('alias', 'FIRST.json')])),
  ]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => !call.units.some(item => item.id === 'first') || !call.units.some(item => item.id === 'alias')));
  assert.ok(calls.every(call => !call.units.some(item => item.id === 'first') || !call.units.some(item => item.id === 'second')));
});

test('conflicting unit identities or positions fall back to individual scans', async () => {
  for (const conflict of ['identity', 'position']) {
    const calls = [], verify = createCoverageBatcher(async input => { calls.push(input); return input; });
    const first = unit('common', 'common.json');
    const second = conflict === 'identity' ? unit('common', 'other.json', 'Changed scene.') : unit('other-id', 'common.json');
    await Promise.all([
      verify(request('first', [first, unit('a', 'a.json')])),
      verify(request('second', [second, unit('b', 'b.json')])),
    ]);
    assert.equal(calls.length, 2);
  }
});

test('conflicting decisions and conflicts within one request preserve original records', async () => {
  const calls = [], verify = createCoverageBatcher(async input => { calls.push(input); return input; });
  const first = { id: 'decision', evidenceHash: 'first' }, second = { id: 'decision', evidenceHash: 'second' };
  await Promise.all([
    verify(request('first', [unit('a', 'a.json')], [first])),
    verify(request('second', [unit('b', 'b.json')], [second])),
    verify(request('conflicting', [unit('same', 'same.json'), unit('same', 'same.json', 'Another scene.')], [first, second])),
  ]);
  assert.equal(calls.length, 3);
  const original = calls.find(call => call.units.length === 2);
  assert.equal(original.units.length, 2);
  assert.deepEqual(original.coverageDecisions, [first, second]);
});

test('coordinator and final checks perform fresh scans outside resource batches', async () => {
  const calls = [], verify = createCoverageBatcher(async input => { const result = { generation: calls.length }; calls.push(input); return result; });
  const preview = verify(request('first', [unit('first', 'first.json')]));
  const coordinator = await verify({ units: [unit('coordinator', 'all.json')], scopeFiles: null, jobId: 'coordinator' });
  await preview;
  const final = await verify({ units: [unit('first', 'first.json')] });
  assert.equal(calls.length, 3);
  assert.notEqual(final.generation, coordinator.generation);
  assert.deepEqual(calls.at(-1).units.map(item => item.id), ['first']);
  assert.equal(Object.hasOwn(calls.at(-1), 'coverageDecisions'), false);
});

test('batched scan errors reach every waiter and later scans can continue', async () => {
  const failure = new Error('resource unavailable');
  let calls = 0;
  const verify = createCoverageBatcher(async () => { if (!calls++) throw failure; return { passed: true }; });
  const outcomes = await Promise.allSettled([
    verify(request('a', [unit('a', 'a.json')])), verify(request('b', [unit('b', 'b.json')])),
  ]);
  assert.ok(outcomes.every(outcome => outcome.status === 'rejected' && outcome.reason === failure));
  assert.equal((await verify({ units: [] })).passed, true);
});

test('cancellation before a queued scan reaches all resource checks', async () => {
  const controller = new AbortController();
  const verify = createCoverageBatcher(async () => { controller.signal.throwIfAborted(); });
  const first = verify(request('a', [unit('a', 'a.json')]));
  const second = verify(request('b', [unit('b', 'b.json')]));
  controller.abort();
  const outcomes = await Promise.allSettled([first, second]);
  assert.ok(outcomes.every(outcome => outcome.status === 'rejected' && outcome.reason.name === 'AbortError'));
});
