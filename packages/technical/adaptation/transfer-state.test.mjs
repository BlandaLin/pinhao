import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { migrateControl, reduceControl } from './control-state.mjs';
import { normalizeFinding, applyWorkItemEvent } from './work-items.mjs';
import { inheritAdaptationStates } from './transfer-state.mjs';

test('quiet scope joins preserve accepted recipes, independent namespaces and cause maxima without moving old candidate ownership', async t => {
  const root = await mkdtemp(path.join(process.env.PINHAO_TEST_TMP ?? os.tmpdir(), 'pinhao-transfer-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const resource = { originId: 'origin', path: 'a.json', baselineHash: 'a'.repeat(64) };
  const item = normalizeFinding({ resource, locator: { pointer: '/caption' } }, { projectId: 'project' });
  let control = reduceControl(migrateControl(), { type: 'recipe_accepted', itemId: item.itemId, key: 'binding', receiptId: 'receipt-a' });
  control.failuresByCause.cause = { occurrences: 3, attemptsBySignature: { attempt: 3 }, resourceRef: resource };
  for (let index = 0; index < 15; index++) control = reduceControl(control, { type: 'step_completed' });
  const workItems = applyWorkItemEvent({ [item.itemId]: item }, { type: 'recipe_accepted', itemId: item.itemId, receiptId: 'receipt-a', recipeId: 'recipe-a' });
  const source = { format: 'pinhao-adaptation-task-1', id: 'source', assignment: { id: 'old', files: ['a.json'] }, control, workItems,
    conversation: [{ private: 'must not move' }], candidateId: 'old-candidate', validationId: 'old-proof', candidateItems: { 'old-candidate': [item.itemId] },
    acceptedBatches: [{ recipeId: 'recipe-a', workspaceDir: 'old-output', unitCount: 1 }], appliedReceiptPositions: { 'namespace-old': 200 },
    inheritedNamespaces: { 'namespace-old': { workspaceDir: 'original-namespace-directory', jobId: 'original-owner' } } };
  const file = path.join(root, 'progress.jsonl'); await writeFile(file, JSON.stringify(source));
  const transfer = { statePath: file, workspaceDir: root, jobId: 'old', files: ['a.json'], transferId: 'join-old-new' };
  const state = { id: 'new', control: migrateControl(), appliedReceiptPositions: { 'namespace-new': 4 }, candidateItems: {} };
  const args = { projectId: 'project', assignment: { id: 'joined', files: ['a.json', 'b.json'] }, transfers: [transfer] };
  assert.equal((await inheritAdaptationStates(state, args)).transferred, 1);
  assert.equal(state.workItems[item.itemId].status, 'accepted'); assert.equal(state.workItems[item.itemId].ownerJobId, 'joined');
  assert.equal(state.control.failuresByCause.cause.occurrences, 3); assert.equal(state.control.watch.stepsSinceAcceptedOrResolved, 14);
  assert.deepEqual(state.appliedReceiptPositions, { 'namespace-new': 4, 'namespace-old': 200 });
  assert.equal(state.inheritedNamespaces['namespace-old'].workspaceDir, 'original-namespace-directory');
  assert.equal(state.acceptedBatches[0].recipeId, 'recipe-a'); assert.equal(state.candidateId, undefined); assert.deepEqual(state.candidateItems, {});
  assert.equal(state.conversation, undefined);
  const snapshot = structuredClone(state);
  assert.equal((await inheritAdaptationStates(state, args)).unchanged, 1); assert.deepEqual(state, snapshot);
  source.control.failuresByCause.cause.occurrences = 4; source.control.failuresByCause.cause.attemptsBySignature.attempt = 4;
  await writeFile(file, JSON.stringify(source)); await inheritAdaptationStates(state, args);
  assert.equal(state.control.failuresByCause.cause.occurrences, 4); assert.equal(state.control.acceptedSerial, 1);
});

test('bad/future transfer states fail explicitly and a valid previous is reported without partial mutation', async t => {
  const root = await mkdtemp(path.join(process.env.PINHAO_TEST_TMP ?? os.tmpdir(), 'pinhao-transfer-bad-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const state = { id: 'target' }, file = path.join(root, 'progress.jsonl'), transfer = { statePath: file, workspaceDir: root, jobId: 'old', files: ['a'], transferId: 'transfer' };
  const args = { projectId: 'project', assignment: { id: 'new', files: ['a'] }, transfers: [transfer] };
  await writeFile(file, '{"format":"future-version"}');
  await assert.rejects(inheritAdaptationStates(state, args), error => error.code === 'TRANSFER_STATE_VERSION'); assert.deepEqual(state, { id: 'target' });
  await writeFile(file, 'broken'); await writeFile(file + '.previous', JSON.stringify({ format: 'pinhao-adaptation-task-1', id: 'old', assignment: { id: 'old' } }));
  assert.deepEqual((await inheritAdaptationStates(state, args)).recoveredPrevious, ['transfer']);
});
