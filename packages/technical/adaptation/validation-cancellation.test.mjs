import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAdapterLab } from './adapter-lab.mjs';
import { createDshToolBridge } from '../dsh-tool-bridge.mjs';

const manifest = { schemaVersion: 1, id: 'validation-cancellation', version: '1.0.0', engine: 'Fixture',
  license: 'GPL-3.0-or-later', scope: { files: ['story.json'] } };
const code = `({detect(){return true},extract(host){return {units:[{id:'caption',source:JSON.parse(host.readText('story.json')).text,locator:{file:'story.json',pointer:'/text'}}]}},validate(){return true},roundtrip(host){host.writeBytes('story.json',host.readBytes('story.json'));return {}},build(host,input){const value=JSON.parse(host.readText('story.json'));value.text=input.translations.caption??value.text;host.writeText('story.json',JSON.stringify(value));return {}},assemble(){return {}}})`;

for (const scenario of ['dom-abort', 'numeric-provider-code']) test(`validation persists the original ${scenario} after real sample execution`, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-validation-cancellation-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  const gameDir = path.join(directory, 'game'), workspaceDir = path.join(directory, 'work'), dataDir = path.join(directory, 'lab');
  await mkdir(gameDir); await mkdir(workspaceDir);
  const original = '{"text":"A complete neutral caption.","identity":"keep"}';
  await writeFile(path.join(gameDir, 'story.json'), original);
  const controller = new AbortController();
  let thrown, reviews = 0;
  const displayVerifier = Object.assign(async () => {
    reviews++;
    if (scenario === 'dom-abort') {
      controller.abort();
      thrown = controller.signal.reason;
      controller.signal.throwIfAborted();
    }
    thrown = Object.assign(new Error('Provider stopped this review'), { code: 503 });
    throw thrown;
  }, { isFresh: async () => false });
  const lab = await createAdapterLab({ dataDir, displayVerifier });
  const candidate = await lab.writeAdapter({ manifest, code });
  const validation = await lab.validateAdapter({ candidateId: candidate.candidateId, gameDir, workspaceDir,
    signal: controller.signal });
  assert.equal(reviews, 1);
  assert.equal(validation.passed, false);
  const cancelled = scenario === 'dom-abort';
  assert.equal(validation.error.code, cancelled ? 'ADAPTER_CANCELLED' : 'DISPLAY_REVIEW_UNAVAILABLE');
  assert.equal(validation.error.category, cancelled ? 'cancelled' : 'reviewer_unavailable');
  assert.equal(validation.reviewFailure.kind, cancelled ? 'cancelled' : 'reviewer-unavailable');
  assert.equal(validation.reviewFailure.candidateId, candidate.candidateId);
  assert.equal(validation.reviewFailure.validationId, validation.validationId);
  assert.equal(validation.reviewFailure.cause.code, thrown.code);
  assert.equal(validation.reviewFailure.cause.name, thrown.name);
  assert.equal(validation.reviewFailure.cause.message, thrown.message);
  assert.deepEqual(validation.error.evidence.cause, validation.reviewFailure.cause);
  assert.equal(validation.reviewFailure.retryable, !cancelled);
  if (!cancelled) {
    assert.equal(validation.error.statusCode, 503);
    assert.equal(validation.reviewFailure.cause.statusCode, 503);
  }
  assert.equal(validation.checks.stableIds, 'passed');
  assert.equal(validation.checks.roundtrip, 'passed');
  assert.equal(validation.checks.sample, 'passed');
  assert.notEqual(validation.checks.display, 'passed');
  assert.ok(validation.finishedAt);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'validations', `${validation.validationId}.json`), 'utf8')), validation);
  assert.equal(await readFile(path.join(gameDir, 'story.json'), 'utf8'), original);
  await assert.rejects(lab.submitRecipe({ candidateId: candidate.candidateId, validationId: validation.validationId }), /配方晋升/);
  if (scenario === 'dom-abort') {
    assert.ok(thrown instanceof DOMException);
    assert.equal(thrown.code, 20);
    assert.throws(() => controller.signal.throwIfAborted(), error => error === thrown);
  }
});

test('a cancelled real validation reconciles its terminal receipt without rerunning review or accepting a recipe', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-validation-reconciliation-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  const gameDir = path.join(directory, 'game'), workspaceDir = path.join(directory, 'work');
  await mkdir(gameDir); await mkdir(workspaceDir);
  await writeFile(path.join(gameDir, 'story.json'), '{"text":"A complete neutral caption."}');
  const controller = new AbortController(); let reviews = 0, saved;
  const displayVerifier = Object.assign(async () => {
    reviews++; controller.abort(); controller.signal.throwIfAborted();
  }, { isFresh: async () => false });
  const lab = await createAdapterLab({ dataDir: path.join(directory, 'lab'), displayVerifier });
  const candidate = await lab.writeAdapter({ manifest, code, projectId: 'neutral', workDir: workspaceDir });
  const options = { lab, gameDir, workspaceDir, project: { id: 'neutral', engine: 'Fixture', workspaceDir },
    requestContext: { adaptationRequestId: 'request' }, coverage: { needsAdaptation: true }, inventory: { existingUnits: [] },
    binding: { projectId: 'neutral', adaptationRequestId: 'request', jobId: 'coordinator', jobExecutionId: 'execution', sessionId: 'session' },
    state: { format: 'pinhao-adaptation-task-1', id: 'neutral', events: [], failures: {}, attempts: 0 },
    signal: controller.signal, persist: async state => { saved = structuredClone(state); } };
  let bridge = await createDshToolBridge(options);
  const operation = await bridge.allocateCall({ toolCallId: 'validate-once', toolName: 'validate_adapter', arguments: { candidateId: candidate.candidateId } });
  await assert.rejects(bridge.execute(operation), error => error === controller.signal.reason);
  await bridge.close();
  assert.equal(saved.dshToolBridge.operations[operation.operationId].status, 'pending-reconciliation');
  bridge = await createDshToolBridge({ ...options, state: saved, signal: new AbortController().signal });
  try {
    const recovered = await bridge.reconcile(operation.operationId);
    assert.equal(recovered.status, 'reconciled');
    assert.equal(recovered.output.error.code, 'CANCELLED');
    assert.equal(reviews, 1, 'reconciliation reads existing terminal evidence rather than buying or replaying review');
    assert.equal(bridge.session.partialExtractions().length, 0);
    assert.equal(saved.acceptedReceiptRefs?.length ?? 0, 0);
  } finally { await bridge.close(); }
});
