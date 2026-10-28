import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAdaptation } from './adaptation.mjs';
import { runAdaptationPool } from './adaptation-pool.mjs';
import { createEvidenceStore } from './adaptation/evidence.mjs';
import { createSessionControl } from './adaptation/session-control.mjs';

const policy = { materialReviewSteps: 1, acceptedReviewSteps: 1, recoverySteps: 1 };
const lab = {
  tryRecipes: async () => null, listRecipes: async () => [], listTools: async () => [],
  inspectFiles: async () => ({ files: [{ path: 'a.json', size: 10 }, { path: 'b.json', size: 10 }], truncated: false }),
};
const step = async (generate, number) => {
  await generate.onStepStart({ stepNumber: number });
  await generate.onStepEnd({ finishReason: 'tool-calls', content: [], toolCalls: [], response: { messages: [] } });
};

async function fixture(action) {
  const prefix = path.join(os.tmpdir(), 'pinhao-control-integration-');
  const directory = await mkdtemp(prefix), gameDir = path.join(directory, 'game');
  try {
    await mkdir(gameDir);
    await writeFile(path.join(gameDir, 'a.json'), '{"text":"a"}');
    await writeFile(path.join(gameDir, 'b.json'), '{"text":"b"}');
    const base = { project: { id: 'control-project', engine: 'unknown' }, lab, gameDir,
      workspaceDir: path.join(directory, 'work'), statePath: path.join(directory, 'progress.jsonl'),
      maxNoProgressSteps: 1, controlLimits: policy, inventory: {},
      coverage: { needsAdaptation: true, resources: ['a.json', 'b.json'].map(file => ({ file, kind: 'display-text-candidate' })) } };
    await action(base);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(prefix)));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
  }
}

async function stall(base, assignment) {
  const seeded = await runAdaptation({ ...base, assignment,
    workspaceDir: assignment ? path.join(base.workspaceDir, 'jobs', assignment.id) : base.workspaceDir,
    statePath: assignment ? path.join(path.dirname(base.statePath), 'jobs', assignment.id, 'progress.jsonl') : base.statePath,
    generate: async args => {
      await args.tools.inspect_context.execute({}); await step(args, 0);
      await args.tools.inspect_context.execute({}); await step(args, 1);
      return { finishReason: 'stop' };
    } });
  assert.equal(seeded.continuation.action, 'pause');
  assert.equal(seeded.continuation.reasonCode, 'STALLED');
  return seeded;
}

test('restored paused control suppresses generation before the first model request', () => fixture(async base => {
  const seeded = await stall(base);
  let generations = 0;
  const resumed = await runAdaptation({ ...base, generate: async () => { generations++; return { finishReason: 'stop' }; } });
  assert.equal(generations, 0, 'A restored pause must be checked before generation, not after buying one more step.');
  assert.equal(resumed.continuation.action, 'pause');
  assert.equal(resumed.continuation.reasonCode, 'STALLED');
  assert.equal(resumed.state.id, seeded.state.id);
  assert.equal(resumed.state.control.logicalSteps, seeded.state.control.logicalSteps);
}));

test('healthy sibling can continue without reopening the stalled sibling model loop', () => fixture(async base => {
  const paused = { id: 'paused', files: ['a.json'] }, healthy = { id: 'healthy', files: ['b.json'] };
  const seeded = await stall(base, paused), generations = [], outputs = new Map();
  const result = await runAdaptationPool({ ...base, jobs: [paused, healthy], concurrency: 2,
    run: args => runAdaptation({ ...args, generate: async context => {
      generations.push(args.assignment.id); await context.tools.inspect_context.execute({});
      await step(context, 0); return { finishReason: 'stop' };
    } }), onResult: (job, outcome) => { outputs.set(job.id, outcome); return {}; } });
  assert.deepEqual(generations, ['healthy']);
  assert.equal(outputs.get('paused').continuation.action, 'pause');
  assert.equal(outputs.get('paused').state.id, seeded.state.id);
  assert.equal(outputs.get('healthy').continuation.action, 'continue');
  assert.equal(result.continuation.action, 'continue');
  assert.equal(result.status, 'needs-review');
}));

test('restored running readers are closed locally while unknown writes require reconciliation', () => fixture(async base => {
  for (const pendingTool of ['read_resource', 'write_adapter']) {
    const workspaceDir = path.join(base.workspaceDir, pendingTool), evidence = createEvidenceStore(workspaceDir);
    const state = { id: pendingTool, events: [], executionWindow: 1 };
    const options = { project: base.project, readDir: base.gameDir, gameDir: base.gameDir, workspaceDir, evidence,
      persist: async () => {}, isReadOnly: name => ['read_resource', 'inspect_context'].includes(name) };
    const control = createSessionControl({ ...options, state });
    const operation = await control.begin(pendingTool, { file: 'a.json' }, { toolCallId: 'interrupted' });
    const sibling = await control.begin('inspect_context', {}, { toolCallId: 'finished' });
    await control.finish(sibling, {}, {}, (await evidence.save({})).evidenceId);
    const restoredState = structuredClone(state);
    assert.equal(restoredState.pendingOperations[operation.operationId].status, 'running');
    const restored = createSessionControl({ ...options, state: restoredState });
    await restored.restore();
    const decision = restored.decision();
    if (pendingTool === 'read_resource') {
      assert.equal(Object.keys(restoredState.pendingOperations).length, 0);
      assert.equal(decision.action, 'continue');
      const receipts = await evidence.readReceipts({ afterSeq: 0, limit: 100 });
      assert.equal(receipts.records.find(receipt => receipt.operationId === operation.operationId && receipt.phase === 'cancelled')?.tool, 'read_resource');
    } else {
      assert.equal(restoredState.pendingOperations[operation.operationId].status, 'pending-reconciliation');
      assert.equal(decision.action, 'pause');
      assert.equal(decision.reasonCode, 'PENDING_RECONCILIATION');
    }
  }
}));
