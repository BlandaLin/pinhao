import test from 'node:test';
import assert from 'node:assert/strict';
import { planAdaptationJobs, runAdaptationPool, scopeAdaptationCoverage, mergeAdaptationUnits } from './adaptation-pool.mjs';
import { configureRequestSlots, acquireRequestSlot, liveRequestSlots } from '../core/provider.mjs';

const files = ['data/a.json', 'data/b.json', 'scripts/c.gd'];
const coverage = {
  resources: files.map(file => ({ file, kind: 'display-text-candidate' })),
  dynamicCandidates: files.map(file => ({ file, source: 'Neutral display candidate.' })),
  triggers: ['suspected-omission'], summary: {}, needsAdaptation: true,
};
const extraction = file => ({ units: [{ id: file, source: 'A complete neutral scene.', locator: { file, pointer: '/text' } }], workspaceDir: `/neutral/${file}` });

test('a technical pool fills released host slots before its first resource finishes, without exceeding the shared limit', { timeout: 5000 }, async t => {
  configureRequestSlots(5);
  const releaseText = [];
  for (let index = 0; index < 4; index++) releaseText.push(await acquireRequestSlot({ key: `occupied-text-${index}`, limit: 5 }));
  const releaseParent = await acquireRequestSlot({ key: 'technical-parent', limit: 5 });
  const gate = Promise.withResolvers(), filled = Promise.withResolvers(), called = [];
  const jobFiles = Array.from({ length: 7 }, (_, index) => `data/neutral-${index}.json`);
  const jobCoverage = { ...coverage, resources: jobFiles.map(file => ({ file, kind: 'display-text-candidate' })), dynamicCandidates: [] };
  let peak = 0, finished = false;
  const pending = runAdaptationPool({ jobs: planAdaptationJobs(jobCoverage, { partition: true }), concurrency: 5, coverage: jobCoverage, workspaceDir: '/neutral/fill',
    acquireSlot: ({ worker, signal }) => worker === 0 ? Promise.resolve(() => {}) : acquireRequestSlot({ key: 'technical-worker', limit: 5, signal }),
    run: async ({ assignment }) => {
      called.push(assignment.files[0]); peak = Math.max(peak, liveRequestSlots());
      if (called.length === 5) filled.resolve();
      await gate.promise;
      return { status: 'resolved' };
    },
  }).finally(() => { finished = true; });
  t.after(async () => { gate.resolve(); for (const release of releaseText) release(); await pending.catch(() => {}); releaseParent(); configureRequestSlots(Infinity); });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(called.length, 1, 'four text slots are occupied, so only the existing parent slot may work');
  for (const release of releaseText) release();
  await filled.promise;
  assert.equal(finished, false, 'new independent resources start while the first resource is still running');
  assert.equal(peak, 5);
  gate.resolve(); await pending;
  assert.equal(called.length, jobFiles.length); assert.equal(new Set(called).size, jobFiles.length);
  assert.equal(liveRequestSlots(), 1, 'all extra resource slots are returned; only the caller-owned parent remains');
});

test('host failure cancels queued resource admission but still settles the active resource and returns its slot', { timeout: 3000 }, async t => {
  configureRequestSlots(1);
  const releaseParent = await acquireRequestSlot({ key: 'failure-parent', limit: 1 }), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const error = Object.assign(new Error('Neutral local checkpoint failed'), { code: 'EIO' });
  const called = [];
  const pending = runAdaptationPool({ jobs: planAdaptationJobs(coverage, { partition: true }), concurrency: 3, coverage, workspaceDir: '/neutral/failure',
    acquireSlot: ({ worker, signal }) => worker === 0 ? Promise.resolve(() => {}) : acquireRequestSlot({ key: 'waiting-worker', limit: 1, signal }),
    hostFailure: failure => failure.code === 'EIO',
    run: async ({ assignment }) => { called.push(assignment.files[0]); entered.resolve(); await gate.promise; throw error; },
  });
  t.after(() => { releaseParent(); configureRequestSlots(Infinity); });
  await entered.promise; gate.resolve();
  await assert.rejects(pending, failure => failure === error);
  assert.deepEqual(called, [files[0]]);
  assert.equal(liveRequestSlots(), 1);
});

test('user pause cancels waiting resource admissions and waits for the active resource to return', { timeout: 3000 }, async t => {
  configureRequestSlots(1);
  const releaseParent = await acquireRequestSlot({ key: 'pause-parent', limit: 1 }), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const controller = new AbortController(), reason = new Error('Neutral user pause');
  let settled = false, count = 0;
  const pending = runAdaptationPool({ jobs: planAdaptationJobs(coverage, { partition: true }), concurrency: 3, coverage, workspaceDir: '/neutral/pause', signal: controller.signal,
    acquireSlot: ({ worker, signal }) => worker === 0 ? Promise.resolve(() => {}) : acquireRequestSlot({ key: 'pause-waiter', limit: 1, signal }),
    run: async () => { count++; entered.resolve(); await gate.promise; return { status: 'resolved' }; },
  }).finally(() => { settled = true; });
  t.after(() => { releaseParent(); configureRequestSlots(Infinity); });
  await entered.promise; controller.abort(reason); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(settled, false); assert.equal(count, 1);
  gate.resolve(); await assert.rejects(pending, error => error === reason);
  assert.equal(liveRequestSlots(), 1);
});

test('no unassigned waiter remains after all jobs finish in the parent slot', { timeout: 3000 }, async t => {
  configureRequestSlots(1);
  const releaseParent = await acquireRequestSlot({ key: 'drain-parent', limit: 1 });
  t.after(() => { releaseParent(); configureRequestSlots(Infinity); });
  let count = 0;
  const result = await runAdaptationPool({ jobs: planAdaptationJobs(coverage, { partition: true }), concurrency: 3, coverage, workspaceDir: '/neutral/drain',
    acquireSlot: ({ worker, signal }) => worker === 0 ? Promise.resolve(() => {}) : acquireRequestSlot({ key: 'drain-waiter', limit: 1, signal }),
    run: async () => { count++; return { status: 'resolved' }; },
  });
  assert.equal(count, 3); assert.equal(result.resolvedJobs, 3); assert.equal(liveRequestSlots(), 1);
});

test('pool retains progress from later jobs and preserves distinct stable native structure locations', async () => {
  const result = await runAdaptationPool({ jobs: planAdaptationJobs(coverage, { partition: true }), concurrency: 3, coverage, workspaceDir: '/neutral/progress',
    run: async ({ assignment }) => ({ status: 'needs-review', retryable: true, continuationNeeded: true, progressMade: assignment.files[0] === files[1], progressFingerprint: assignment.files[0] }) });
  assert.equal(result.progressMade, true); assert.match(result.progressFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(mergeAdaptationUnits([{ units: [1, 2].map(index => ({ id: `binary:${index}`, locator: { file: 'story.bin', nativePath: ['records', index, 'text'] } })) }]).length, 2);
});

for (const failureAt of ['run', 'onResult']) test(`host storage failure at ${failureAt} stops new jobs and settles active siblings before rethrowing`, async () => {
  const controller = new AbortController(), called = [], saved = [];
  const failure = Object.assign(new Error('The checkpoint is locked by another local process.'), { code: 'EPERM' });
  let secondStarted, releaseSecond, finished = false;
  const entered = new Promise(resolve => { secondStarted = resolve; });
  const release = new Promise(resolve => { releaseSecond = resolve; });
  const pending = runAdaptationPool({ jobs: planAdaptationJobs(coverage, { partition: true }), concurrency: 2,
    workspaceDir: '/neutral/work', coverage, signal: controller.signal, hostFailure: error => error.code === 'EPERM',
    run: async ({ assignment }) => {
      const file = assignment.files[0]; called.push(file);
      if (file === files[0]) { await entered; if (failureAt === 'run') throw failure; }
      if (file === files[1]) { secondStarted(); await release; assert.equal(controller.signal.aborted, false); }
      return { status: 'verified', extraction: extraction(file) };
    },
    onResult: async (job, result) => {
      if (failureAt === 'onResult' && job.files[0] === files[0]) throw failure;
      saved.push(...result.extraction.units.map(unit => unit.id)); return { addedUnits: 1 };
    },
  }).finally(() => { finished = true; });
  await entered;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(finished, false, 'caller must wait for its still-active independent sibling');
  assert.deepEqual(called, files.slice(0, 2));
  releaseSecond();
  await assert.rejects(pending, error => error === failure);
  assert.deepEqual(called, files.slice(0, 2), 'pending third job must not start after the local storage failure');
  assert.deepEqual(saved, [files[1]], 'the active sibling still reaches the existing result commit');
});

test('ordinary uncaught model or adapter errors still use the resource repair path', async () => {
  const called = [];
  const result = await runAdaptationPool({ jobs: planAdaptationJobs(coverage, { partition: true }), concurrency: 1,
    workspaceDir: '/neutral/work', coverage, hostFailure: error => error.code === 'EPERM',
    run: async ({ assignment }) => {
      const file = assignment.files[0]; called.push(file);
      if (file === files[0]) throw Object.assign(new Error('The adapter needs a different field pointer.'), { code: 'ADAPTER_LOCATOR' });
      return { status: 'verified', extraction: extraction(file) };
    },
  });
  assert.deepEqual(called, files);
  assert.equal(result.status, 'needs-review');
  assert.equal(result.error.code, 'ADAPTER_LOCATOR');
  assert.equal(result.extractions.length, 2);
});

test('a returned top-level storage failure also stops dispatch but commits its verified partial batches', async () => {
  const called = [], saved = [];
  const error = { code: 'EBUSY', message: 'A checkpoint save remains busy.' };
  const partial = extraction(files[0]);
  await assert.rejects(runAdaptationPool({ jobs: planAdaptationJobs(coverage, { partition: true }), concurrency: 1,
    workspaceDir: '/neutral/work', coverage, hostFailure: failure => failure.code === 'EBUSY',
    run: async ({ assignment }) => { called.push(assignment.files[0]); return { status: 'failed', error, partialExtractions: [partial] }; },
    onResult: async (_job, result) => { saved.push(...result.partialExtractions); return { addedUnits: 1 }; },
  }), failure => failure instanceof Error && failure.code === error.code && failure.message === error.message);
  assert.deepEqual(called, [files[0]]);
  assert.deepEqual(saved, [partial]);
});

test('native schema carriers use independent slots and preserve joint-write scopes', () => {
  const nativeReviewIssues = [{ file: 'Game_Data/level0', kind: 'custom_schema_required', count: 400 },
    { file: 'Game_Data/level0', kind: 'other_schema_required', count: 30 }, { file: 'Game_Data/resources.assets', kind: 'custom_schema_required', count: 25 }];
  const input = { resources: [], dynamicCandidates: [], nativeReviewIssues, extractionIssues: [], summary: { nativeReviewObjects: 455 },
    presentationItems: [{ file: 'Game_Data/resources.assets', kind: 'font_required' }], needsAdaptation: true };
  const jobs = planAdaptationJobs(input, { partition: true });
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs, planAdaptationJobs(input, { partition: true }));
  const scoped = scopeAdaptationCoverage(input, ['Game_Data/level0']);
  assert.equal(scoped.nativeReviewIssues.length, 2);
  assert.equal(scoped.summary.nativeReviewObjects, 430);
  assert.equal(scoped.summary.nativeReviewResources, 1);
  assert.equal(scoped.summary.presentationItems, 0);
  assert.deepEqual(scoped.triggers, ['native-schema-review']);
  assert.equal(scopeAdaptationCoverage(input, ['unrelated.json']).needsAdaptation, false);
  assert.equal(planAdaptationJobs(input, { partition: true, scopeRequests: [{ files: ['Game_Data/level0', 'Game_Data/resources.assets'] }] }).length, 1);
  assert.deepEqual(planAdaptationJobs({ ...input, nativeReviewIssues: [{ kind: 'schema_required' }] }, { partition: true }), [{ id: 'coordinator', files: null }]);
  const located = { ...input, extractionIssues: [{ file: 'archive.arc', kind: 'archive_adapter_required' }] };
  assert.equal(planAdaptationJobs(located, { partition: true }).length, 3);
  assert.deepEqual(scopeAdaptationCoverage(located, ['archive.arc']).triggers, ['partial-extraction']);
});

test('one located extraction error does not collapse independent resources into one coordinator', () => {
  const files = Array.from({ length: 40 }, (_, index) => `Game_Data/level${index}`);
  const issue = { file: files[0], kind: 'typetree_adapter_required' };
  const input = { nativeReviewIssues: files.map(file => ({ file, kind: 'component_schema_required' })), extractionIssues: [issue], needsAdaptation: true };
  const jobs = planAdaptationJobs(input, { partition: true });
  assert.equal(jobs.length, 40);
  assert.ok(jobs.every(job => job.files.length === 1));
  assert.deepEqual(jobs, planAdaptationJobs(input, { partition: true }));
  const scoped = scopeAdaptationCoverage(input, [files[0]]);
  assert.deepEqual(scoped.extractionIssues, [issue]);
  assert.equal(scoped.needsAdaptation, true);
  assert.ok(scoped.triggers.includes('partial-extraction'));
  assert.equal(scopeAdaptationCoverage(input, [files[1]]).extractionIssues.length, 0);
  const joined = planAdaptationJobs(input, { partition: true, scopeRequests: [
    { files: [files[0], 'Game_Data/shared.index'] }, { files: ['Game_Data/shared.index', files[1]] },
  ] });
  assert.equal(joined.length, 39);
  assert.deepEqual(joined.find(job => job.files.includes(files[0])).files, [files[0], files[1], 'Game_Data/shared.index'].sort());
  for (const file of [undefined, '../outside.bin', 'C:/outside.bin', '/outside.bin']) {
    assert.deepEqual(planAdaptationJobs({ ...input, extractionIssues: [{ ...issue, file }] }, { partition: true }), [{ id: 'coordinator', files: null }]);
  }
  assert.deepEqual(planAdaptationJobs({ ...input, structuralRecoveryWarnings: 1 }, { partition: true }), [{ id: 'coordinator', files: null }]);
  const extra = planAdaptationJobs({ ...input, extractionIssues: [{ carrier: 'data/extra.bin', kind: 'parser_failed' }] }, { partition: true });
  assert.equal(extra.length, 41);
  assert.ok(extra.some(job => job.files[0] === 'data/extra.bin'));
});

test('located extraction failures run in the normal parallel pool and remain pending until verified', async () => {
  const files = Array.from({ length: 40 }, (_, index) => `data/scene-${index}.bin`), issue = { file: files[0], kind: 'parser_failed' };
  const input = { nativeReviewIssues: files.map(file => ({ file, kind: 'component_schema_required' })), extractionIssues: [issue], needsAdaptation: true };
  const called = new Set();
  let active = 0, peak = 0;
  const result = await runAdaptationPool({ jobs: planAdaptationJobs(input, { partition: true }), coverage: input, concurrency: 9, workspaceDir: '/neutral/work',
    verifyCoverage: async () => ({ ...input, nativeReviewIssues: [], extractionIssues: [issue], needsAdaptation: true }),
    run: async args => {
      const file = args.assignment.files[0]; called.add(file); active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      if (file === issue.file) {
        assert.deepEqual(args.coverage.extractionIssues, [issue]);
        assert.equal(args.coverage.needsAdaptation, true);
        return { status: 'failed', error: { code: 'NEUTRAL_PARSER', message: 'Located neutral parser failure.' } };
      }
      return { status: 'resolved' };
    },
  });
  assert.equal(peak, 9);
  assert.equal(called.size, 40);
  assert.equal(result.status, 'needs-review');
  assert.equal(result.pendingJobs, 1);
  assert.equal(result.resolvedJobs, 39);
  assert.deepEqual(result.coverage.extractionIssues, [issue]);
  assert.equal(result.coverage.needsAdaptation, true);
  assert.equal(result.error.code, 'NEUTRAL_PARSER');
});

test('native review validation reaches the host and accepted carriers disappear on resume', async () => {
  const files = ['Game_Data/level0', 'Game_Data/level1', 'Game_Data/resources.assets'];
  const input = { resources: [], nativeReviewIssues: files.map(file => ({ file, kind: 'component_schema_required', count: 7 })), needsAdaptation: true };
  const accepted = new Set(), receipts = [], calls = [];
  let active = 0, peak = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const result = await runAdaptationPool({ jobs: planAdaptationJobs(input, { partition: true }), concurrency: 3,
    workspaceDir: '/neutral/work', coverage: input,
    verifyCoverage: async request => {
      if (request.nativeReviews) { receipts.push(request.nativeReviews); accepted.add(request.scopeFiles[0]); }
      return { ...input, nativeReviewIssues: input.nativeReviewIssues.filter(issue => !accepted.has(issue.file)), needsAdaptation: accepted.size < files.length };
    },
    run: async args => {
      const file = args.assignment.files[0]; calls.push(file); active++; peak = Math.max(peak, active);
      if (active === files.length) release();
      await gate;
      const nativeReviews = [{ groupId: `group:${file}`, evidenceHash: 'neutral', disposition: 'non-display' }];
      assert.equal((await args.verifyCoverage({ units: [], nativeReviews })).needsAdaptation, false);
      active--;
      return { status: 'resolved', nativeReviews };
    },
  });
  assert.equal(peak, 3);
  assert.equal(receipts.length, 3);
  assert.equal(result.status, 'verified');
  assert.equal(result.units.length, 0);
  const resumedCoverage = { ...input, nativeReviewIssues: [], needsAdaptation: false };
  const resumed = await runAdaptationPool({ jobs: planAdaptationJobs(input, { partition: true }), workspaceDir: '/neutral/work', coverage: resumedCoverage,
    verifyCoverage: async () => resumedCoverage, run: async () => { throw new Error('Accepted native reviews must not run twice'); } });
  assert.equal(resumed.resolvedJobs, 3);
  assert.equal(resumed.reused, true);
  assert.equal(calls.length, 3);
});

test('resource assignments are stable, distinct and leave container recovery with a coordinator', () => {
  const jobs = planAdaptationJobs(coverage, { partition: true });
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.map(job => job.files[0]), files);
  assert.deepEqual(planAdaptationJobs(coverage, { partition: true }), jobs);
  assert.deepEqual(planAdaptationJobs(coverage), [{ id: 'coordinator', files: null }]);
  assert.equal(planAdaptationJobs({ ...coverage, extractionIssues: [{ kind: 'archive_failed' }] }, { partition: true })[0].files, null);
  const scoped = scopeAdaptationCoverage(coverage, [files[1]]);
  assert.equal(scoped.resources.length, 1);
  assert.equal(scoped.dynamicCandidates.length, 1);
});

test('located unknown fields remain independent while unsafe or global recovery stays coordinated', () => {
  const unknown = file => ({ file, status: 'unknown', proseLike: true });
  const input = { ...coverage, unknownClusters: [unknown('data/unknown.json'), unknown(files[0]), { ...unknown(files[1]), status: 'non-display' }],
    summary: { unreviewedClusters: 2 } };
  const jobs = planAdaptationJobs(input, { partition: true });
  assert.equal(jobs.length, 4);
  const scoped = scopeAdaptationCoverage(input, ['data/unknown.json']);
  assert.equal(scoped.summary.unreviewedClusters, 1);
  assert.equal(scoped.needsAdaptation, true);
  assert.deepEqual(scoped.triggers, ['unknown-text-clusters']);
  assert.equal(scopeAdaptationCoverage(input, [files[2]]).summary.unreviewedClusters, 0);
  for (const file of [undefined, '../outside.json', 'C:/outside.json']) {
    assert.deepEqual(planAdaptationJobs({ ...input, unknownClusters: [unknown(file)] }, { partition: true }), [{ id: 'coordinator', files: null }]);
  }
  for (const recovery of [{ structuralRecoveryWarnings: 1 }, { extractionIssues: [{ kind: 'archive_failed' }] }]) {
    assert.deepEqual(planAdaptationJobs({ ...input, ...recovery }, { partition: true }), [{ id: 'coordinator', files: null }]);
  }
  const joined = planAdaptationJobs(input, { partition: true, scopeRequests: [
    { files: ['data/unknown.json', 'index.json'] }, { files: ['index.json', files[0]] },
  ] });
  assert.equal(joined.length, 3);
  assert.deepEqual(joined.find(job => job.files.includes('data/unknown.json')).files, [files[0], 'data/unknown.json', 'index.json'].sort());
  assert.ok(joined.some(job => job.files.length === 1 && job.files[0] === files[1]));
  assert.ok(joined.some(job => job.files.length === 1 && job.files[0] === files[2]));
});

test('parallel resource jobs verify their own scope then require a complete merged coverage check', async () => {
  const jobs = planAdaptationJobs(coverage, { partition: true });
  let active = 0, maximum = 0;
  const states = new Set(), progress = [];
  const result = await runAdaptationPool({ jobs, concurrency: 2, gameDir: '/neutral/source', workspaceDir: '/neutral/work', statePath: '/neutral/progress.jsonl', coverage,
    onProgress: item => progress.push(item),
    verifyCoverage: async current => ({ ...coverage, resources: coverage.resources.filter(item => !current.units.some(unit => unit.locator.file === item.file)), dynamicCandidates: coverage.dynamicCandidates.filter(item => !current.units.some(unit => unit.locator.file === item.file)), needsAdaptation: current.units.length < files.length }),
    run: async args => {
      active++; maximum = Math.max(active, maximum); states.add(args.statePath);
      assert.equal(args.assignment.files.length, 1);
      assert.equal(args.coverage.resources.length, 1);
      const item = extraction(args.assignment.files[0]);
      await new Promise(resolve => setTimeout(resolve, 15));
      assert.equal((await args.verifyCoverage(item)).needsAdaptation, false);
      active--;
      return { status: 'verified', extraction: item, reused: true };
    },
  });
  assert.equal(result.status, 'verified');
  assert.equal(result.extractions.length, 3);
  assert.equal(result.units.length, 3);
  assert.equal(states.size, 3);
  assert.equal(maximum, 2);
  assert.equal(result.reused, true);
  assert.ok(progress.slice(0, -1).every(item => item.status === 'running'));
  assert.equal(progress.at(-1).status, 'verified');
  assert.equal(progress.at(-1).verifiedJobs, 3);
});

test('completed subsets retain a failing resource and surface its real error', async () => {
  const jobs = planAdaptationJobs(coverage, { partition: true });
  const result = await runAdaptationPool({ jobs, concurrency: 3, workspaceDir: '/neutral/work', coverage,
    verifyCoverage: async current => ({ ...coverage, needsAdaptation: current.units.length < 3 }),
    run: async args => args.assignment.files[0] === files[1] ? { status: 'failed', error: { message: 'Neutral parser failed.' } } : { status: 'verified', extraction: extraction(args.assignment.files[0]) },
  });
  assert.equal(result.status, 'needs-review');
  assert.equal(result.extractions.length, 2);
  assert.equal(result.reason, 'Neutral parser failed.');
  assert.equal(result.coverage.needsAdaptation, true);
  assert.throws(() => mergeAdaptationUnits([extraction(files[0]), extraction(files[0])]), /重复/);
  const first = extraction(files[0]);
  assert.throws(() => mergeAdaptationUnits([first, { units: [{ ...first.units[0], id: 'different-id', locator: { pointer: '/text', file: files[0] } }] }]), /重复/);
});

test('cancelling a pool waits for all active jobs before releasing its caller', async () => {
  const controller = new AbortController();
  let active = 0;
  const result = runAdaptationPool({ jobs: planAdaptationJobs(coverage, { partition: true }), concurrency: 3, workspaceDir: '/neutral/work', coverage, signal: controller.signal,
    run: async () => {
      active++;
      try { await new Promise(resolve => setTimeout(resolve, 15)); controller.signal.throwIfAborted(); }
      finally { active--; }
    },
  });
  controller.abort();
  await assert.rejects(result, error => error.name === 'AbortError');
  assert.equal(active, 0);
});

test('processed jobs count failures separately and commit each accepted result before finishing', async () => {
  const accepted = [], progress = [];
  const result = await runAdaptationPool({ jobs: planAdaptationJobs(coverage, { partition: true }), concurrency: 2, workspaceDir: '/neutral/work', coverage,
    onProgress: item => progress.push(item), onResult: async (job, item) => { accepted.push(job.id); return { addedUnits: item.status === 'verified' ? 1 : 0 }; },
    run: async args => args.assignment.files[0] === files[1] ? { status: 'needs-review', reason: 'A precise missing field.', stopReason: 'no-progress', retryable: false }
      : { status: 'verified', extraction: extraction(args.assignment.files[0]) },
  });
  assert.equal(accepted.length, 3);
  assert.equal(result.processedJobs, 3); assert.equal(result.verifiedJobs, 2); assert.equal(result.pendingJobs, 1);
  assert.equal(result.addedUnits, 2); assert.equal(result.retryable, false); assert.equal(result.stopReason, 'no-progress');
  assert.equal(progress.at(-1).status, 'needs-review');
  assert.equal(progress.at(-1).jobs.filter(job => job.status === 'needs-review')[0].reason, 'A precise missing field.');
});

test('outdated empty resource assignments finish locally without requesting an adapter', async () => {
  let calls = 0;
  const progress = [];
  const result = await runAdaptationPool({ jobs: planAdaptationJobs(coverage, { partition: true }), workspaceDir: '/neutral/work',
    coverage: { resources: [], dynamicCandidates: [], needsAdaptation: false },
    onProgress: item => progress.push(item), onResult: async () => { assert.equal(progress[0].resolvedJobs, 3); return {}; },
    verifyCoverage: async () => ({ resources: [], dynamicCandidates: [], needsAdaptation: false }),
    run: async () => { calls++; throw new Error('Empty scopes never reach a model'); },
  });
  assert.equal(calls, 0); assert.equal(result.status, 'verified'); assert.equal(result.resolvedJobs, 3); assert.equal(result.extractions.length, 0);
});

test('the first pool progress includes every already-covered job regardless of queue order', async () => {
  const jobs = planAdaptationJobs(coverage, { partition: true }), progress = [], committed = [];
  const input = { ...coverage, resources: coverage.resources.slice(0, 1), dynamicCandidates: coverage.dynamicCandidates.slice(0, 1) };
  const result = await runAdaptationPool({ jobs, coverage: input, workspaceDir: '/neutral/work', concurrency: 1,
    onProgress: item => progress.push(item), onResult: async job => { committed.push(job.id); return {}; },
    run: async ({ assignment }) => { assert.equal(assignment.id, jobs[0].id); return { status: 'needs-review' }; },
  });
  assert.equal(progress[0].resolvedJobs, 2); assert.equal(progress[0].pendingJobs, 1); assert.equal(progress[0].verifiedJobs, 0);
  assert.ok(progress[0].jobs.slice(1).every(job => job.status === 'resolved' && job.reused));
  assert.equal(result.resolvedJobs, 2); assert.equal(result.pendingJobs, 1);
  assert.deepEqual([...committed].sort(), jobs.map(job => job.id).sort());
});

test('persisting reused jobs cannot occupy the configured runnable slots', { timeout: 1000 }, async () => {
  const jobs = planAdaptationJobs(coverage, { partition: true }), committed = [];
  const input = { ...coverage, resources: coverage.resources.slice(1), dynamicCandidates: coverage.dynamicCandidates.slice(1) };
  let active = 0, peak = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const result = await runAdaptationPool({ jobs, coverage: input, concurrency: 2, workspaceDir: '/neutral/work',
    onResult: async (job, item) => { committed.push(job.id); if (item.reused) await gate; return {}; },
    run: async () => { active++; peak = Math.max(peak, active); if (active === 2) release(); await gate; active--; return { status: 'needs-review' }; },
  });
  assert.equal(peak, 2); assert.equal(result.resolvedJobs, 1); assert.equal(result.pendingJobs, 2);
  assert.deepEqual([...committed].sort(), jobs.map(job => job.id).sort());
});

test('reuse persistence failures and cancellation settle all active callbacks before returning', async () => {
  const jobs = planAdaptationJobs(coverage, { partition: true }).slice(0, 2);
  const input = { ...coverage, resources: coverage.resources.slice(1, 2), dynamicCandidates: coverage.dynamicCandidates.slice(1, 2) };
  const failure = new Error('Neutral reuse persistence failed.'), calls = [];
  let workerFinished = false;
  await assert.rejects(runAdaptationPool({ jobs, coverage: input, workspaceDir: '/neutral/work',
    onResult: async (job, item) => { calls.push(job.id); if (item.reused) throw failure; return {}; },
    run: async () => { await new Promise(setImmediate); workerFinished = true; return { status: 'needs-review' }; },
  }), error => error === failure);
  assert.equal(workerFinished, true); assert.deepEqual([...calls].sort(), jobs.map(job => job.id).sort());
  const controller = new AbortController();
  let release, persisted = false, returned = false;
  const gate = new Promise(resolve => { release = resolve; });
  const stopping = runAdaptationPool({ jobs, coverage: input, workspaceDir: '/neutral/work', signal: controller.signal,
    onResult: async (_job, item) => { if (item.reused) { await gate; persisted = true; } return {}; },
    run: async () => { await new Promise(setImmediate); controller.abort(); controller.signal.throwIfAborted(); },
  });
  const rejected = assert.rejects(stopping, error => error === controller.signal.reason);
  stopping.then(() => { returned = true; }, () => { returned = true; });
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(returned, false); assert.equal(persisted, false);
  release(); await rejected; assert.equal(persisted, true);
});

test('preclassification keeps adapter attempts, build repairs and coordinators runnable', async () => {
  const jobs = [{ id: 'adapter', files: [files[0]] }, { id: 'repair', kind: 'build-repair', files: [files[1]] },
    { id: 'coordinator', files: null }, { id: 'done', files: [files[2]] }];
  const called = [], progress = [];
  const result = await runAdaptationPool({ jobs, workspaceDir: '/neutral/work', concurrency: 3,
    coverage: { resources: [], classifiedCandidates: [{ file: files[0], classification: 'adapter_required' }], needsAdaptation: false },
    onProgress: item => progress.push(item),
    run: async ({ assignment }) => { called.push(assignment?.id ?? 'coordinator'); return { status: 'needs-review' }; },
  });
  assert.deepEqual(called.sort(), ['adapter', 'coordinator', 'repair']);
  assert.equal(progress[0].resolvedJobs, 1); assert.equal(progress[0].pendingJobs, 3);
  assert.equal(result.pendingJobs, 3); assert.equal(result.verifiedJobs, 0);
});

test('nine independent resource assignments can occupy the configured nine slots', async () => {
  const nine = Array.from({ length: 9 }, (_, index) => `data/resource-${index}.json`);
  const input = { resources: nine.map(file => ({ file, kind: 'display-text-candidate' })), dynamicCandidates: [], needsAdaptation: true };
  let active = 0, peak = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const result = await runAdaptationPool({ jobs: planAdaptationJobs(input, { partition: true }), concurrency: 9, workspaceDir: '/neutral/work', coverage: input,
    verifyCoverage: async () => ({ ...input, needsAdaptation: false }),
    run: async args => { active++; peak = Math.max(peak, active); if (active === 9) release(); await gate; active--; return { status: 'verified', extraction: extraction(args.assignment.files[0]) }; },
  });
  assert.equal(peak, 9); assert.equal(result.verifiedJobs, 9); assert.equal(result.status, 'verified');
});

test('unselected recipe previews stay isolated while same-resource accepted checks accumulate', async () => {
  const file = 'data/a.json', input = { resources: [{ file, kind: 'display-text-candidate' }], dynamicCandidates: [], needsAdaptation: true };
  const one = (id, pointer) => ({ units: [{ id, source: `Neutral ${id}.`, locator: { file, pointer } }], workspaceDir: `/neutral/${id}` });
  const checked = [];
  const result = await runAdaptationPool({ jobs: [{ id: 'one-file', files: [file] }], workspaceDir: '/neutral/work', coverage: input,
    verifyCoverage: async current => { checked.push(current.units.map(unit => unit.id)); return { ...input, resources: current.units.length < 2 ? input.resources : [], needsAdaptation: current.units.length < 2 }; },
    run: async args => {
      await args.verifyCoverage({ ...one('preview-only', '/unused'), preview: true });
      assert.equal((await args.verifyCoverage(one('first', '/a'))).needsAdaptation, true);
      assert.equal((await args.verifyCoverage(one('second', '/b'))).needsAdaptation, false);
      return { status: 'verified', extractions: [one('first', '/a'), one('second', '/b')] };
    },
  });
  assert.deepEqual(checked, [['preview-only'], ['first'], ['first', 'second'], ['first', 'second']]);
  assert.equal(result.status, 'verified');
  assert.equal(result.extractions.length, 2);
});

test('all incomplete jobs return every validated partial batch for host adoption', async () => {
  const result = await runAdaptationPool({ jobs: planAdaptationJobs(coverage, { partition: true }), workspaceDir: '/neutral/work', coverage,
    run: async args => ({ status: 'needs-review', reason: 'One remaining display field.', partialExtractions: [extraction(args.assignment.files[0])] }),
  });
  assert.equal(result.status, 'needs-review');
  assert.equal(result.extractions.length, 0);
  assert.equal(result.partialExtractions.length, 3);
});
