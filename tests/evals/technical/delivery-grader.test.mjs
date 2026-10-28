import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactRecord, canonical, digest } from './events.mjs';
import { gradeDeliveryPipeline } from './runtime-grader.mjs';

const artifact = record => { const text = JSON.stringify(record); return { path: 'raw-fixture.json', text, sha256: digest(text) }; };
const hash = value => digest(canonical(value));
const at = second => `2026-10-27T00:00:${String(second).padStart(2, '0')}.000Z`;
function sample() {
  const unit = { id: 'dialogue', source: 'Neutral display.', locator: { file: 'scene.json', pointer: '/body' } };
  const extraction = { binding: { recipeId: 'recipe' }, units: [unit], workspaceDir: 'accepted-workbench' };
  const payload = { schemaVersion: 1, projectId: 'project', adaptationRequestId: 'request', recipeId: 'recipe', extractionHash: hash(extraction) };
  const record = { id: hash(payload), payload, payloadHash: hash(payload) };
  const publicationManifest = artifact({ format: 'pinhao-composite-adapter-1', adapters: [{ recipeId: 'recipe' }] });
  return { initial: { publication: { generation: 0 } },
    artifacts: { acceptedReceipts: [artifact(record)], acceptedExtractions: [artifact(extraction)] },
    database: { projectId: 'project', publication: { generation: 1, workbenchDir: 'workbench' }, units: [{ ...unit, id: 'host-unit', legacyId: 'dialogue' }],
      acceptanceReceipts: [{ ...record, status: 'integrated', acceptedAt: at(1), integratedAt: at(2), result: { generation: 1, addedUnits: 1, registryChanged: true } }],
      tasks: [{ id: 'text-task', role: 'translation', productionInput: { generation: 1, workbenchDir: 'workbench' }, requestHistory: [{ id: 'text-request', status: 'received', startedAt: at(3), finishedAt: at(6) }] }] },
    productAccounting: { request: { attempts: { technical: { httpAttemptId: 'technical', fetchStarted: true, sendIntentAt: at(2), settledAt: at(8) } } } },
    publicationEvidence: [{ generation: 1, workbenchDir: 'workbench', compositeManifestRef: null, valid: true, artifact: publicationManifest,
      actualSha256: publicationManifest.sha256, expectedSha256: publicationManifest.sha256 }], states: [] };
}

test('10A independent producer receipt, extraction and raw SQLite publication prove one integration', () => {
  const evidence = sample(), grade = gradeDeliveryPipeline(evidence, { qualifiedRecipeIds: ['recipe'] });
  assert.equal(grade.status, 'checked'); assert.equal(grade.acceptedBatchCount, 1); assert.equal(grade.integratedBatchCount, 1);
  assert.equal(grade.firstAcceptedAt, at(1)); assert.equal(grade.firstIntegratedAt, at(2)); assert.equal(grade.integrationLags[0].elapsedMs, 1000);
  assert.equal(grade.textTechnicalOverlap, 'host-request-window-overlap'); assert.equal(grade.overlaps[0].overlapMs, 3000);
});

test('10A callbacks, counters and lane labels alone cannot invent accepted or integrated batches', () => {
  const evidence = sample(); evidence.artifacts = {}; evidence.database.acceptanceReceipts = [];
  evidence.terminal = { acceptance: { accepted: 99, integrated: 99 } };
  evidence.states = [{ project: { lanes: { adaptation: { status: 'running' }, text: { status: 'running' } } } }];
  const grade = gradeDeliveryPipeline(evidence, { qualifiedRecipeIds: ['recipe'] });
  assert.equal(grade.acceptedBatchCount, 0); assert.equal(grade.integratedBatchCount, 0); assert.equal(grade.textTechnicalOverlap, 'not-proven');
  assert.equal(grade.pollLaneHints, 1);
});

test('10A stale recipe, tampered producer and absent SQLite units never prove delivery', () => {
  for (const mutate of [value => { value.artifacts.acceptedReceipts[0].text += 'tampered'; },
    value => { value.database.units = []; }, value => { value.database.acceptanceReceipts[0].result.generation = 2; }]) {
    const evidence = sample(); mutate(evidence); const grade = gradeDeliveryPipeline(evidence, { qualifiedRecipeIds: ['recipe'] });
    assert.equal(grade.status, 'evidence-incomplete'); assert.equal(grade.integratedBatchCount, 0);
  }
  assert.equal(gradeDeliveryPipeline(sample(), { qualifiedRecipeIds: [] }).integratedBatchCount, 0);
});

test('10A duplicate receipt delivery cannot multiply integration or advance generation', () => {
  const evidence = sample(); evidence.database.acceptanceReceipts.push(structuredClone(evidence.database.acceptanceReceipts[0]));
  const grade = gradeDeliveryPipeline(evidence, { qualifiedRecipeIds: ['recipe'] });
  assert.equal(grade.integratedBatchCount, 1); assert.deepEqual(grade.integratedGenerations, [1]); assert.equal(grade.status, 'evidence-incomplete');
});

test('10A saved accepted results stay pending until their SQLite commit exists', () => {
  const evidence = sample(), row = evidence.database.acceptanceReceipts[0];
  row.status = 'pending'; delete row.result; delete row.integratedAt;
  const grade = gradeDeliveryPipeline(evidence, { qualifiedRecipeIds: ['recipe'] });
  assert.equal(grade.acceptedBatchCount, 1); assert.equal(grade.pendingIntegrationCount, 1); assert.equal(grade.integratedBatchCount, 0);
  assert.equal(grade.textTechnicalOverlap, 'not-proven');
});

test('10B wrong frozen input, future generation and false snapshot cannot prove overlap', () => {
  for (const mutate of [value => { value.database.tasks[0].productionInput.workbenchDir = 'other'; },
    value => { value.database.tasks[0].productionInput.generation = 2; },
    value => { value.publicationEvidence[0].artifact.text += 'tampered'; },
    value => { value.database.tasks[0].requestHistory[0].startedAt = at(1); },
    value => { value.productAccounting.request.attempts.technical.fetchStarted = false; }]) {
    const evidence = sample(); mutate(evidence);
    assert.equal(gradeDeliveryPipeline(evidence, { qualifiedRecipeIds: ['recipe'] }).textTechnicalOverlap, 'not-proven');
  }
});

test('10B nonoverlapping, cancelled and absent requests retain not-proven rather than fake concurrency', () => {
  for (const mutate of [value => { value.database.tasks[0].requestHistory[0].startedAt = at(9); value.database.tasks[0].requestHistory[0].finishedAt = at(10); },
    value => { value.database.tasks[0].requestHistory[0].status = 'cancelled'; }, value => { value.database.tasks = []; }]) {
    const evidence = sample(); mutate(evidence);
    assert.equal(gradeDeliveryPipeline(evidence, { qualifiedRecipeIds: ['recipe'] }).textTechnicalOverlap, 'not-proven');
  }
  assert.equal(gradeDeliveryPipeline({}).status, 'not-recorded');
});
