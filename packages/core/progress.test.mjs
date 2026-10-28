import test from 'node:test';
import assert from 'node:assert/strict';
import { activeMilliseconds, estimateProgress, progressLine } from './progress.mjs';

const units = (count, status, start = 0) => Array.from({ length: count }, (_, index) => ({ id: `unit-${start + index}`, status }));

test('translation coverage stays separate from the unfinished review round', () => {
  const progress = estimateProgress(units(20, 'translated'), [{ role: 'proofreading', status: 'running' }],
    { projectStatus: 'running', phase: 'scene' });
  assert.equal(progress.percent, 100);
  assert.equal(progress.coverageComplete, true);
  assert.equal(progress.finished, false);
  assert.match(progress.phaseLabel, /场景/);
  assert.doesNotMatch(progressLine(progress), /全部完成|本轮制作完成/);
  assert.equal(estimateProgress(units(20, 'proofread'), [], { projectStatus: 'completed' }).finished, true);
});

test('ETA uses concurrent request intervals without queueing or overnight pauses', () => {
  const completed = units(40, 'translated'), pending = units(40, 'pending', 40);
  const taskStats = { counts: { succeeded: 2, queued: 2 }, timing: { translation: {
    unitIds: completed.map(unit => unit.id), intervals: [[300000, 360000], [300000, 360000]],
  } } };
  const progress = estimateProgress([...completed, ...pending], [], { now: 360000, taskStats, projectStatus: 'running' });
  assert.equal(progress.throughput, 40);
  assert.equal(progress.etaMs, 60000);
  assert.equal(activeMilliseconds([[0, 60000], [86400000, 86460000]]), 120000);
  assert.equal(activeMilliseconds([[0, 10], [5, 20], [20, 30], [60, 80]]), 50);
});

test('pause detection is not defeated by successful historical tasks', () => {
  const completed = units(20, 'translated'), pending = units(20, 'pending', 20);
  const tasks = [{ status: 'succeeded', role: 'translation', unitIds: completed.map(unit => unit.id), startedAt: 0, finishedAt: 60000 },
    { status: 'paused', role: 'translation', unitIds: pending.map(unit => unit.id) }];
  const progress = estimateProgress([...completed, ...pending], tasks, { now: 120000, projectStatus: 'paused' });
  assert.equal(progress.paused, true);
  assert.equal(progress.etaAt, null);
  assert.equal(progress.etaMs, 60000);
});

test('imported translations without a timing sample do not fabricate a confident ETA', () => {
  const progress = estimateProgress([...units(1000, 'translated'), ...units(100, 'pending', 1000)], [], { projectStatus: 'running' });
  assert.equal(progress.confidence, 'none');
  assert.equal(progress.etaMs, null);
  assert.equal(progress.throughput, null);
});
