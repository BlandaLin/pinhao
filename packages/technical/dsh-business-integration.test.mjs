import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDshToolBridge } from './dsh-tool-bridge.mjs';
import { createAdaptationStateWriter, readAdaptationState } from './adaptation.mjs';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';
import { createTextAdapter } from './adaptation/text-adapter.mjs';
import { scanCoverage } from './coverage.mjs';
import { createStore } from '../core/store.mjs';
import { createAcceptanceLedger, readAcceptedBatch } from '../core/accepted-batches.mjs';

async function actualFixture(fn, { partial = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-dsh-business-'));
  const gameDir = path.join(root, 'game'), workspaceDir = path.join(root, 'work'), statePath = path.join(workspaceDir, 'state.json');
  await mkdir(gameDir); await mkdir(workspaceDir);
  const original = JSON.stringify({ text: 'A complete shown sentence.', ...(partial ? { moreText: 'Another shown sentence.' } : {}), logic: { key: 'unchanged' } });
  await writeFile(path.join(gameDir, 'story.json'), original);
  const candidates = [{ file: 'story.json', source: 'A complete shown sentence.', classification: 'display_unresolved', locator: { file: 'story.json', pointer: '/text' } }];
  if (partial) candidates.push({ file: 'story.json', source: 'Another shown sentence.', classification: 'display_unresolved', locator: { file: 'story.json', pointer: '/moreText' } });
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab') });
  const options = { project: { id: 'p', engine: 'Godot', workspaceDir: path.join(root, 'project') },
    assignment: { id: 'story-job', files: ['story.json'] },
    binding: { projectId: 'p', adaptationRequestId: 'request-1', jobId: 'story-job', jobExecutionId: 'execution-1', sessionId: 'session-1' },
    requestContext: { adaptationRequestId: 'request-1' },
    inventory: { existingUnits: [] }, coverage: { needsAdaptation: true, dynamicCandidates: candidates }, gameDir, workspaceDir,
    state: { format: 'pinhao-adaptation-task-1', id: 'state-1', executionWindow: 1, status: 'running', events: [], failures: {}, attempts: 0 },
    persist: createAdaptationStateWriter(statePath), lab,
    verifyCoverage: extraction => scanCoverage({ rootDir: gameDir, units: extraction.units ?? [], inventory: { dynamicCandidates: candidates } }) };
  const databaseRoot = path.join(root, 'db'); let store = createStore(databaseRoot), bridge;
  const ledger = () => createAcceptanceLedger({ store: { ...store, transaction: (_id, action) => store.transaction(action) }, projectId: 'p', adaptationRequestId: 'request-1' });
  const tools = {
    root, candidates, options, ledger,
    store: () => store,
    reopen: () => { store.close(); store = createStore(databaseRoot); },
    bridge: async more => bridge = await createDshToolBridge({ ...options, ...more }),
    readSaved: () => readAdaptationState(statePath),
  };
  try { await fn(tools); assert.equal(await readFile(path.join(gameDir, 'story.json'), 'utf8'), original); }
  finally { await bridge?.close(); store.close(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); }
}

async function invoke(bridge, toolName, args, toolCallId = `${toolName}-1`) {
  const envelope = await bridge.allocateCall({ toolCallId, toolName, arguments: args });
  return { envelope, output: await bridge.execute(envelope) };
}

test('T10: real lab accepted receipt resumes after SQLite commit, lost callback, reopen and lost ACK', () => actualFixture(async fixture => {
  let loseCallback = true, publications = 0;
  const onAcceptedBatch = async record => {
    const ledger = fixture.ledger(); ledger.enqueue(record);
    const result = ledger.commit(record.id, () => {
      publications++;
      fixture.store().putUnit('p', { id: 'accepted-1', source: 'A complete shown sentence.', generation: 1 });
      return { generation: 1, addedUnits: 1 };
    });
    if (loseCallback) throw Object.assign(new Error('Simulated process loss after real database COMMIT'), { code: 'INTEGRATION_PENDING' });
    return result;
  };
  let bridge = await fixture.bridge({ onAcceptedBatch });
  const page = (await invoke(bridge, 'inspect_coverage', {})).output;
  const written = (await invoke(bridge, 'write_text_adapter', { candidateIds: [page.dynamicCandidates[0].id], id: 'dsh-real-json' })).output;
  assert.ok(written.candidateId, JSON.stringify(written));
  const validation = (await invoke(bridge, 'validate_adapter', { candidateId: written.candidateId })).output;
  assert.equal(validation.passed, true, JSON.stringify(validation));
  const submit = await bridge.allocateCall({ toolCallId: 'submit', toolName: 'submit_recipe', arguments: {
    candidateId: written.candidateId, validationId: validation.validationId, metadata: { summary: 'Real JSON writeback, isolated local fixture' } } });
  await assert.rejects(bridge.execute(submit), { code: 'INTEGRATION_PENDING' });
  assert.equal(fixture.store().all('units', 'p').length, 1);
  await bridge.close(); fixture.reopen();
  loseCallback = false;
  bridge = await fixture.bridge({ state: await fixture.readSaved(), onAcceptedBatch });
  await bridge.session.control.restore();
  const recovered = await bridge.reconcile(submit.operationId);
  assert.equal(recovered.status, 'reconciled');
  assert.equal(recovered.output.accepted, true);
  assert.equal(recovered.output.taskComplete, true);
  assert.equal(bridge.session.result().status, 'verified');
  assert.equal(fixture.store().all('units', 'p').length, 1);
  assert.equal(publications, 1);
  assert.deepEqual(fixture.ledger().summary(), { accepted: 1, integrated: 1, pendingIntegration: 0, stale: 0 });
  assert.equal((await bridge.execute(submit)).accepted, true);
  assert.equal(publications, 1, 'losing an acknowledgement must not publish again');
}));

test('T13: real lab rejects a candidate that changes a non-target JSON field and never integrates it', () => actualFixture(async fixture => {
  const bridge = await fixture.bridge({ onAcceptedBatch: () => assert.fail('Invalid writeback must never reach acceptance') });
  const generated = await createTextAdapter({ candidates: fixture.candidates, gameDir: fixture.options.gameDir,
    engine: 'Godot', assignment: fixture.options.assignment, id: 'dsh-wrong-write' });
  const needle = 'text = JSON.stringify(document);';
  assert.equal(generated.code.split(needle).length, 2);
  const corrupted = generated.code.replace(needle, 'document.logic.key = "corrupted"; text = JSON.stringify(document);');
  const written = (await invoke(bridge, 'write_adapter', { manifest: generated.manifest, code: corrupted })).output;
  assert.ok(written.candidateId, JSON.stringify(written));
  const validation = (await invoke(bridge, 'validate_adapter', { candidateId: written.candidateId })).output;
  assert.equal(validation.passed, false);
  assert.notEqual(validation.checks.structure, 'passed');
  const submitted = (await invoke(bridge, 'submit_recipe', { candidateId: written.candidateId,
    validationId: validation.validationId, metadata: {} })).output;
  assert.ok(submitted.error, JSON.stringify(submitted));
  assert.equal(bridge.session.result(), undefined);
  assert.equal(bridge.session.partialExtractions().length, 0);
  assert.equal(fixture.store().all('units', 'p').length, 0);
  assert.deepEqual(fixture.ledger().summary(), { accepted: 0, integrated: 0, pendingIntegration: 0, stale: 0 });
}));

test('T13: real partial acceptance integrates only its selected unit without completing the assignment', () => actualFixture(async fixture => {
  const bridge = await fixture.bridge({ onAcceptedBatch: record => {
    const ledger = fixture.ledger(); ledger.enqueue(record);
    return ledger.commit(record.id, () => {
      fixture.store().putUnit('p', { id: 'partial-1', source: 'A complete shown sentence.' });
      return { generation: 1, addedUnits: 1 };
    });
  } });
  const page = (await invoke(bridge, 'inspect_coverage', {})).output;
  assert.equal(page.dynamicCandidates.length, 2);
  const written = (await invoke(bridge, 'write_text_adapter', {
    candidateIds: [page.dynamicCandidates.find(item => item.source === 'A complete shown sentence.').id], id: 'dsh-partial-json' })).output;
  const validation = (await invoke(bridge, 'validate_adapter', { candidateId: written.candidateId })).output;
  assert.equal(validation.passed, true, JSON.stringify(validation));
  const submitted = (await invoke(bridge, 'submit_recipe', { candidateId: written.candidateId,
    validationId: validation.validationId, metadata: {} })).output;
  assert.equal(submitted.accepted, true);
  assert.equal(submitted.taskComplete, false);
  assert.equal(bridge.session.done(), false);
  assert.equal(bridge.session.result(), undefined);
  assert.equal(bridge.session.partialExtractions().flatMap(item => item.units).length, 1);
  assert.equal(fixture.store().all('units', 'p').length, 1);
  assert.deepEqual(fixture.ledger().summary(), { accepted: 1, integrated: 1, pendingIntegration: 0, stale: 0 });
}, { partial: true }));

test('T14: a correctly bound different job cannot validate or submit another write scope candidate', () => actualFixture(async fixture => {
  const owner = await fixture.bridge({ onAcceptedBatch: () => assert.fail('This ownership probe must not accept anything') });
  const page = (await invoke(owner, 'inspect_coverage', {})).output;
  const written = (await invoke(owner, 'write_text_adapter', { candidateIds: [page.dynamicCandidates[0].id], id: 'dsh-owned-json' })).output;
  const valid = (await invoke(owner, 'validate_adapter', { candidateId: written.candidateId })).output;
  assert.equal(valid.passed, true, JSON.stringify(valid));
  await owner.close();
  await writeFile(path.join(fixture.options.gameDir, 'other.json'), '{"text":"An unrelated assigned file."}');
  const other = await fixture.bridge({ assignment: { id: 'other-job', files: ['other.json'] },
    binding: { ...fixture.options.binding, jobId: 'other-job', jobExecutionId: 'execution-2', sessionId: 'session-2' },
    state: { format: 'pinhao-adaptation-task-1', id: 'state-2', executionWindow: 1, status: 'running', events: [], failures: {}, attempts: 0 },
    persist: createAdaptationStateWriter(path.join(fixture.root, 'other-state.json')),
    onAcceptedBatch: () => assert.fail('Foreign candidate must not reach acceptance') });
  const validation = (await invoke(other, 'validate_adapter', { candidateId: written.candidateId })).output;
  assert.match(validation.error?.message ?? '', /其他资源任务/);
  const submitted = (await invoke(other, 'submit_recipe', { candidateId: written.candidateId,
    validationId: valid.validationId, metadata: {} })).output;
  assert.match(submitted.error?.message ?? '', /其他资源任务/);
  assert.equal(other.session.result(), undefined);
  assert.equal(fixture.store().all('units', 'p').length, 0);
  assert.deepEqual(fixture.ledger().summary(), { accepted: 0, integrated: 0, pendingIntegration: 0, stale: 0 });
}));

test('small safe delivery returns actionable feedback and expands through existing receipts without replacing the first unit', () => actualFixture(async fixture => {
  let generation = 0, sequence = 0;
  const bridge = await fixture.bridge({ getExistingUnits: () => fixture.store().all('units', 'p'), onAcceptedBatch: async record => {
    const extraction = await readAcceptedBatch({ directory: path.dirname(record.receiptFile), record });
    const ledger = fixture.ledger(); ledger.enqueue(record);
    return ledger.commit(record.id, () => {
      const previous = new Set(fixture.store().all('units', 'p').map(unit => unit.id));
      const added = extraction.units.filter(unit => !previous.has(unit.id));
      for (const unit of added) fixture.store().putUnit('p', unit);
      return { generation: ++generation, addedUnits: added.length };
    });
  } });
  const call = async (name, args) => (await invoke(bridge, name, args, `closure-${++sequence}`)).output;
  const page = await call('inspect_coverage', {});
  const first = await call('write_text_adapter', { candidateIds: [page.dynamicCandidates[0].id], id: 'first-closure' });
  assert.equal(first.nextCall.tool, 'validate_adapter');
  const validated = await call(first.nextCall.tool, first.nextCall.input);
  assert.equal(validated.passed, true, JSON.stringify(validated));
  assert.equal(validated.nextCall.tool, 'submit_recipe');
  const accepted = await call(validated.nextCall.tool, validated.nextCall.input);
  assert.equal(accepted.accepted, true); assert.equal(accepted.taskComplete, false);
  assert.equal(accepted.nextCall.tool, 'inspect_units');
  const current = await call(accepted.nextCall.tool, accepted.nextCall.input);
  assert.equal(current.total, 1);
  const firstStored = fixture.store().all('units', 'p')[0];
  assert.equal(current.units[0].id, firstStored.id);
  const refreshed = await call('inspect_coverage', {});
  const remaining = refreshed.dynamicCandidates.find(item => item.source !== firstStored.source);
  assert.ok(remaining);
  const second = await call('write_text_adapter', { candidateIds: [remaining.id], id: 'expanded-closure' });
  const validSecond = await call(second.nextCall.tool, second.nextCall.input);
  assert.equal(validSecond.passed, true, JSON.stringify(validSecond));
  const acceptedSecond = await call(validSecond.nextCall.tool, validSecond.nextCall.input);
  assert.equal(acceptedSecond.accepted, true);
  assert.equal(acceptedSecond.taskComplete, true);
  const stored = fixture.store().all('units', 'p');
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.find(unit => unit.id === firstStored.id), firstStored);
  assert.equal(new Set(stored.map(unit => unit.id)).size, 2);
  assert.deepEqual(fixture.ledger().summary(), { accepted: 2, integrated: 2, pendingIntegration: 0, stale: 0 });
}, { partial: true }));
