import test from 'node:test';
import assert from 'node:assert/strict';
import { activeMilliseconds, estimateProgress, progressLine, translationTaskCredit } from './progress.mjs';

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
  const tasks = [{ status: 'succeeded', role: 'translation', unitIds: completed.map(unit => unit.id),
    commitSummary: { committed: 20, remaining: 0 }, startedAt: 0, finishedAt: 60000 },
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

test('formal partial deliveries count once regardless of final task status', () => {
  const completed = units(60, 'translated'), skipped = units(10, 'skipped', 60), pending = units(60, 'pending', 70);
  const tasks = ['skipped', 'paused'].map(status => ({ role: 'translation', status,
    unitIds: [...completed, ...skipped].map(unit => unit.id),
    commitSummary: { committed: 30, remaining: 40, unitIds: [...completed, ...skipped].map(unit => unit.id) },
    requestHistory: [{ artifact: { sentAt: 0 }, finishedAt: 60000 }] }));
  const value = estimateProgress([...completed, ...skipped, ...pending], tasks, { projectStatus: 'running' });
  assert.equal(value.done, 60);
  assert.equal(value.phases.skipped, 10);
  assert.equal(value.throughput, 60, 'duplicate receipts and skipped unit statuses add no output');
  assert.equal(value.etaMs, 60000, 'parallel intervals share one active minute');
});

test('candidates, imported results and unrelated task IDs do not become formal throughput', () => {
  const completed = units(30, 'translated'), pending = units(30, 'pending', 30);
  const tasks = [{ role: 'translation', status: 'paused', unitIds: completed.map(unit => unit.id),
    candidateRecords: completed.map(unit => ({ id: unit.id, translation: 'Unsubmitted candidate' })),
    requestHistory: [{ artifact: { sentAt: 0 }, finishedAt: 60000 }] }];
  const value = estimateProgress([...completed, ...pending], tasks);
  assert.equal(value.throughput, null);
  assert.equal(value.etaMs, null);
  assert.deepEqual(translationTaskCredit({ ...tasks[0], commitSummary: { committed: 1, remaining: 29, unitIds: ['outside'] } }),
    { unitIds: [], incomplete: true });
});

test('unknown legacy partial receipts suppress a false ETA instead of guessing accepted IDs', () => {
  const completed = units(100, 'translated'), pending = units(100, 'pending', 100);
  const tasks = [{ role: 'translation', status: 'succeeded', unitIds: completed.slice(0, 40).map(unit => unit.id),
    commitSummary: { committed: 40, remaining: 0 }, startedAt: 0, finishedAt: 60000 },
  { role: 'translation', status: 'skipped', unitIds: [...completed.slice(40), ...pending.slice(0, 5)].map(unit => unit.id),
    commitSummary: { committed: 60, remaining: 5 }, startedAt: 0, finishedAt: 60000 }];
  const value = estimateProgress([...completed, ...pending], tasks);
  assert.equal(value.done, 100);
  assert.equal(value.throughput, null);
  assert.equal(value.confidence, 'none');
  assert.equal(value.etaMs, null);
  assert.equal(translationTaskCredit({ ...tasks[1], commitSummary: { committed: 1, remaining: 4,
    unitIds: ['unit-40'], creditIncomplete: true } }).incomplete, true);
});
