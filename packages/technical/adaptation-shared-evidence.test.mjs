import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAdaptationPool, mergeAdaptationUnits } from './adaptation-pool.mjs';
import { createEvidenceStore } from './adaptation/evidence.mjs';
import { persistAcceptedBatch } from '../core/accepted-batches.mjs';
import { createDshToolBridge } from './dsh-tool-bridge.mjs';

test('later independent jobs can read actual accepted evidence without inheriting ownership', { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-shared-evidence-'));
  try {
    const jobs = [{ id: 'one', files: ['a.json'] }, { id: 'two', files: ['b.json'] }];
    const published = Promise.withResolvers(), finishedReading = Promise.withResolvers();
    let expected, firstReceipt, lookup, consumed;
    await runAdaptationPool({ jobs, concurrency: 2, workspaceDir: root, hostFailure: () => true,
      project: { id: 'neutral', sourceFingerprint: 'baseline-one' }, requestContext: { adaptationRequestId: 'request' },
      coverage: { needsAdaptation: true, resources: jobs.flatMap(job => job.files.map(file => ({ file, kind: 'display-text-candidate' }))) },
      run: async ({ assignment, workspaceDir, getSharedEvidence, onAcceptedBatch }) => {
        assert.equal(typeof getSharedEvidence, 'function');
        if (assignment.id === 'one') {
          assert.deepEqual(getSharedEvidence(), []);
          const evidence = createEvidenceStore(workspaceDir);
          const input = await evidence.save({ file: 'a.json' });
          const output = await evidence.save({ content: 'Actual neutral consumer evidence.' });
          await evidence.recordReceipt({ operationId: 'read', phase: 'started', tool: 'read_resource', inputEvidenceId: input.evidenceId });
          firstReceipt = await evidence.recordReceipt({ operationId: 'read', phase: 'completed', tool: 'read_resource', inputEvidenceId: input.evidenceId, outputEvidenceId: output.evidenceId });
          const extraction = { workspaceDir, binding: { recipeId: 'recipe-one' }, units: [{ id: 'unit', source: 'Hello', locator: { file: 'a.json', pointer: '/caption' } }] };
          expected = await persistAcceptedBatch({ directory: path.join(root, 'accepted'), projectId: 'neutral', adaptationRequestId: 'request', assignment, extraction, candidateId: 'candidate', validationId: 'validation' });
          await onAcceptedBatch(expected);
          published.resolve();
          await finishedReading.promise;
          return { status: 'needs-review', partialExtractions: [extraction] };
        }
        await published.promise;
        try {
        lookup = getSharedEvidence();
        assert.equal(lookup.length, 1);
        assert.equal(lookup[0].namespaceId, firstReceipt.namespaceId);
        assert.equal(lookup[0].referenceOnly, true);
        assert.equal(lookup[0].evidenceFingerprint, 'baseline-one');
        assert.equal(lookup[0].accepted[0].acceptedBatchId, expected.id);
        assert.equal(lookup[0].accepted[0].recipeId, 'recipe-one');
        assert.equal(lookup[0].owner, undefined);
        const stored = await createEvidenceStore(lookup[0].workspaceDir).resolveReceipt(firstReceipt.receiptId);
        const body = await createEvidenceStore(lookup[0].workspaceDir).load(stored.outputEvidenceId);
        assert.equal(body.value.content, 'Actual neutral consumer evidence.');
        let stale = false;
        const bridge = await createDshToolBridge({ project: { id: 'neutral', engine: 'Godot', sourceFingerprint: 'baseline-one' },
          assignment, getSharedEvidence: () => getSharedEvidence().map(item => stale ? { ...item, evidenceFingerprint: 'other-baseline' } : item),
          workspaceDir, gameDir: root, inventory: {}, lab: { inspectAdapter: async () => ({ manifest: { scope: { files: ['a.json'] } } }) },
          requestContext: { adaptationRequestId: 'request', jobId: assignment.id },
          state: { id: 'second-task', events: [], failures: {}, attempts: 0 },
          binding: { projectId: 'neutral', adaptationRequestId: 'request', jobId: assignment.id, jobExecutionId: 'second-execution', sessionId: 'second-session' } });
        try {
          const context = await bridge.execute(await bridge.allocateCall({ toolCallId: 'context', toolName: 'inspect_context', arguments: {} }));
          assert.equal(context.sharedWork[0].workspaceDir, undefined);
          assert.equal(context.sharedWork[0].accepted[0].recipeId, 'recipe-one');
          consumed = await bridge.execute(await bridge.allocateCall({ toolCallId: 'evidence', toolName: 'read_evidence',
            arguments: { namespaceId: firstReceipt.namespaceId, evidenceId: stored.outputEvidenceId, receiptId: firstReceipt.receiptId, pointer: '/content' } }));
          assert.equal(consumed.content, 'Actual neutral consumer evidence.');
          const invoke = async (id, name, input) => bridge.execute(await bridge.allocateCall({ toolCallId: id, toolName: name, arguments: input }));
          const unrelated = await invoke('unrelated', 'read_evidence', { namespaceId: 'namespace-unrelated', evidenceId: stored.outputEvidenceId });
          assert.match(unrelated.error.message, /namespace/);
          stale = true;
          const staleRead = await invoke('stale', 'read_evidence', { namespaceId: firstReceipt.namespaceId, evidenceId: stored.outputEvidenceId });
          assert.match(staleRead.error.message, /namespace/);
          const staleContext = await invoke('stale-context', 'inspect_context', {});
          assert.deepEqual(staleContext.sharedWork, []);
          stale = false;
          const readCandidate = await invoke('owned-read', 'read_adapter', { candidateId: 'candidate' });
          assert.match(readCandidate.error.message, /其他资源任务/);
          const submit = await invoke('owned-submit', 'submit_recipe', { candidateId: 'candidate', validationId: 'validation', metadata: {} });
          assert.match(submit.error.message, /其他资源任务/);
        } finally { await bridge.close(); }
        lookup[0].accepted.length = 0;
        assert.equal(getSharedEvidence()[0].accepted.length, 1, 'consumer cannot mutate shared registry');
        return { status: 'resolved' };
        } finally { finishedReading.resolve(); }
      },
    });
    assert.ok(lookup?.length, 'second job consumed the first job saved evidence');
    assert.equal(consumed?.content, 'Actual neutral consumer evidence.', 'real DSH bridge resolves shared namespace');
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }); }
});

test('a pool without a source fingerprint never advertises shared evidence', async () => {
  let consumed = 0;
  await runAdaptationPool({ jobs: [{ id: 'one', files: ['a'] }, { id: 'two', files: ['b'] }],
    workspaceDir: '/neutral/not-created', hostFailure: () => true,
    coverage: { resources: [{ file: 'a', kind: 'display-text-candidate' }, { file: 'b', kind: 'display-text-candidate' }] },
    run: async ({ getSharedEvidence }) => { assert.deepEqual(getSharedEvidence(), []); consumed++; return { status: 'resolved' }; } });
  assert.equal(consumed, 2);
});

test('pool merge retains qualified format locations', () => {
  const unit = member => ({ id: member, source: 'Hello', locator: { file: 'data.xp3', member, byteStart: 2, byteEnd: 6, encoding: 'utf-16le' },
    context: { formatBinding: { protocol: 'pinhao-format-binding-1', family: 'xp3-text', location: member, capabilityRef: 'a'.repeat(64) } } });
  assert.equal(mergeAdaptationUnits([{ units: [unit('a.ks'), unit('b.ks')] }]).length, 2);
  const member = carrier => ({ id: carrier, source: 'Hello', locator: { file: 'story.json', pointer: '/caption' }, context: { carrier } });
  assert.equal(mergeAdaptationUnits([{ units: [member('a.zip'), member('b.zip')] }]).length, 2);
});
