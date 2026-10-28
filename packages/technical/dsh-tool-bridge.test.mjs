import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDshToolBridge } from './dsh-tool-bridge.mjs';
import { adaptationTools, finishAdaptationBusinessResult } from './adaptation.mjs';

async function fixture(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-dsh-bridge-'));
  const gameDir = path.join(directory, 'game'), workspaceDir = path.join(directory, 'work');
  await mkdir(gameDir); await mkdir(workspaceDir);
  await writeFile(path.join(gameDir, 'story.json'), '{"text":"A test story."}');
  const options = { project: { id: 'p', engine: 'Godot', workspaceDir: path.join(directory, 'project') },
    binding: { projectId: 'p', adaptationRequestId: 'local', jobId: 'coordinator', jobExecutionId: 'e', sessionId: 's' },
    inventory: {}, coverage: { needsAdaptation: true }, gameDir, workspaceDir,
    state: { id: 'task', executionWindow: 1, events: [], failures: {}, attempts: 0 },
    lab: { runTool: async () => ({ status: 'complete' }) } };
  try { await fn(options); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); }
}

const call = (bridge, toolCallId = 'call-1', input = { tool: 'probe', args: [] }) => bridge.allocateCall({ toolCallId, toolName: 'run_tool', arguments: input });

test('DSH transport retries reuse one operation; equal arguments in a new call remain independent', () => fixture(async options => {
  let executions = 0;
  options.lab.runTool = async () => ({ invocation: ++executions });
  const bridge = await createDshToolBridge(options);
  try {
    const envelope = await call(bridge), retry = await call(bridge);
    assert.equal(envelope.operationId, retry.operationId);
    const [first, second] = await Promise.all([bridge.execute(envelope), bridge.execute(retry)]);
    assert.deepEqual(first, second);
    assert.deepEqual(await bridge.execute(retry), first);
    assert.equal(executions, 1);
    const independent = await call(bridge, 'call-2');
    assert.notEqual(independent.operationId, envelope.operationId);
    await bridge.execute(independent);
    assert.equal(executions, 2);
    const reusedProviderId = await bridge.allocateCall({ toolCallId: 'call-1', callScope: 'later-assistant-log-42',
      toolName: 'run_tool', arguments: { tool: 'probe', args: [] } });
    assert.notEqual(reusedProviderId.operationId, envelope.operationId);
    await bridge.execute(reusedProviderId);
    assert.equal(executions, 3, 'a new model step may reuse a provider tool-call id');
  } finally { await bridge.close(); }
}));

test('DSH bridge enforces the registered schemas and immutable job/call identity', () => fixture(async options => {
  const bridge = await createDshToolBridge(options);
  try {
    assert.ok(bridge.definitions().every(row => row.parameters.type === 'object'));
    assert.equal(bridge.definitions().find(row => row.name === 'read_resource').concurrencySafe, true);
    assert.equal(bridge.definitions().find(row => row.name === 'submit_recipe').concurrencySafe, false);
    await assert.rejects(call(bridge, 'bad', { tool: 'probe', args: 'not-an-array' }), { code: 'MODEL_TOOL_INPUT_INVALID' });
    const envelope = await call(bridge);
    await assert.rejects(call(bridge, 'call-1', { tool: 'another', args: [] }), { code: 'DSH_OPERATION_CONFLICT' });
    await assert.rejects(bridge.execute({ ...envelope, jobId: 'other' }), { code: 'DSH_BRIDGE_IDENTITY' });
    await assert.rejects(bridge.execute({ ...envelope, arguments: { tool: 'another', args: [] } }), { code: 'DSH_OPERATION_CONFLICT' });
    await assert.rejects(createDshToolBridge({ ...options, binding: { ...options.binding, sessionId: 'new' } }), { code: 'DSH_BRIDGE_IDENTITY' });
  } finally { await bridge.close(); }
}));

test('a read uses its durable business terminal receipt instead of four full snapshots', () => fixture(async options => {
  const snapshots = [];
  options.persist = async state => { snapshots.push(structuredClone(state)); };
  options.lab.readResource = async ({ file }) => {
    const content = await readFile(path.join(options.gameDir, file), 'utf8');
    return { content, offset: 0, returnedBytes: Buffer.byteLength(content), encoding: 'utf8', sourceIndex: 0 };
  };
  let bridge = await createDshToolBridge(options);
  const envelope = await bridge.allocateCall({ toolCallId: 'read-once', toolName: 'read_resource', arguments: { root: 'source', file: 'story.json' } });
  assert.equal(snapshots.length, 0, 'read allocation has no mutation intent to snapshot');
  await bridge.execute(envelope);
  assert.equal(snapshots.length, 1, 'business completion receipt owns the durable read state');
  await bridge.close();
  options.state = snapshots[0];
  bridge = await createDshToolBridge(options);
  try {
    const recovered = await bridge.reconcile(envelope.operationId);
    assert.equal(recovered.status, 'reconciled');
    assert.match(recovered.output.content, /A test story/);
  } finally { await bridge.close(); }
}));

test('a lost bridge completion is recovered from the original business terminal receipt', () => fixture(async options => {
  let executions = 0;
  options.lab.runTool = async () => ({ invocation: ++executions });
  let bridge = await createDshToolBridge(options);
  const envelope = await call(bridge);
  await bridge.execute(envelope); await bridge.close();
  const row = options.state.dshToolBridge.operations[envelope.operationId];
  row.status = 'executing'; delete row.outputEvidenceId;
  bridge = await createDshToolBridge(options);
  try {
    const recovered = await bridge.reconcile(envelope.operationId);
    assert.equal(recovered.status, 'reconciled');
    assert.equal(recovered.output.invocation, 1);
    assert.equal((await bridge.execute(envelope)).invocation, 1);
    assert.equal(executions, 1);
  } finally { await bridge.close(); }
}));

test('an interrupted mutation with no terminal proof is reported, not blindly repeated', () => fixture(async options => {
  let executions = 0;
  options.lab.runTool = async () => { executions++; return {}; };
  const bridge = await createDshToolBridge(options);
  try {
    const envelope = await call(bridge);
    options.state.dshToolBridge.operations[envelope.operationId].status = 'executing';
    const recovered = await bridge.reconcile(envelope.operationId);
    assert.equal(recovered.status, 'pending-reconciliation');
    await assert.rejects(bridge.execute(envelope), { code: 'DSH_OPERATION_RECONCILIATION' });
    assert.equal(executions, 0);
  } finally { await bridge.close(); }
}));

test('accepted data survive a lost integration callback and reconcile without resubmission', () => fixture(async options => {
  let submissions = 0, integrations = 0, available = false;
  const extraction = { workspaceDir: options.workspaceDir, units: [{ id: 'story-1', source: 'A test story.',
    kind: 'dialogue', context: { file: 'story.json' }, locator: { file: 'story.json', pointer: '/text' } }],
    binding: { recipeId: 'recipe-1' } };
  options.lab.submitRecipe = async () => { submissions++; return { recipeId: 'recipe-1' }; };
  options.lab.extractRecipe = async () => extraction;
  options.onAcceptedBatch = async () => { if (!available) throw Object.assign(new Error('Host unavailable'), { code: 'INTEGRATION_PENDING' }); integrations++; };
  let bridge = await createDshToolBridge(options);
  const envelope = await bridge.allocateCall({ toolCallId: 'submit', toolName: 'submit_recipe',
    arguments: { candidateId: 'candidate-1', validationId: 'proof-1', metadata: {} } });
  await assert.rejects(bridge.execute(envelope), { code: 'INTEGRATION_PENDING' });
  await bridge.close();
  available = true;
  bridge = await createDshToolBridge(options);
  try {
    const recovered = await bridge.reconcile(envelope.operationId);
    assert.equal(recovered.output.accepted, true);
    assert.equal(recovered.output.taskComplete, true);
    assert.equal(bridge.session.result().status, 'verified');
    assert.equal(bridge.session.partialExtractions()[0].units.length, 1);
    assert.equal(submissions, 1); assert.equal(integrations, 1);
  } finally { await bridge.close(); }
}));

test('external runtime ignores legacy stop clocks without relaxing business failures', () => fixture(async options => {
  options.state.windowStop = { message: 'Old window stopped' };
  options.lab.runTool = async () => { throw Object.assign(new Error('Actual tool failure'), { code: 'TOOL_REJECTED' }); };
  const session = adaptationTools({ ...options, runtimePolicy: 'external' });
  try {
    assert.equal(session.done(), false);
    for (let index = 0; index < 4; index++) {
      const output = await session.tools.run_tool.execute({ tool: 'probe', args: [] });
      assert.equal(output.error.code, 'TOOL_REJECTED');
      assert.equal(output.paused, false);
      assert.equal(output.mustChangeStrategy, undefined);
    }
    assert.equal(options.state.strategyDirective, undefined);
    const result = await finishAdaptationBusinessResult({ state: options.state, session,
      result: { status: 'needs-review', stopReason: 'runtime-idle' }, coverage: options.coverage });
    assert.equal(result.status, 'needs-review');
    assert.equal(result.continuation.action, 'pause');
    assert.equal(result.continuationNeeded, false);
  } finally { await session.close(); }
}));
