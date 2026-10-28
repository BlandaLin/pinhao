import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dshModelCapacity, runDshAdaptation, verifiedDshRuntime, DSH_BACKEND_VERSION } from './dsh-runner.mjs';
import { readAdaptationState } from './adaptation.mjs';
import { runAdaptationPool } from './adaptation-pool.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const cleanup = (t, root) => t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }));
async function runnerFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-dsh-contract-')); cleanup(t, root);
  const gameDir = path.join(root, 'game'), workspaceDir = path.join(root, 'work');
  await mkdir(gameDir); await mkdir(workspaceDir); await writeFile(path.join(gameDir, 'story.txt'), 'A complete sentence.');
  const launches = [], sessions = [];
  const session = id => ({ run: async () => ({ events: [{ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'FIXTURE_STOP', message: 'Stop this local contract fixture' } } } }] }) });
  const options = { project: { id: 'project', engine: 'KAG', sourceFingerprint: 'source-identity', workspaceDir: root },
    connection: { baseUrl: 'https://not-used.invalid/v1', model: 'model-a', apiKey: 'local-fixture-only' },
    gameDir, workspaceDir, statePath: path.join(workspaceDir, 'progress.jsonl'), coverage: { needsAdaptation: true },
    requestContext: { adaptationRequestId: 'request' }, lab: { listTools: async () => [], tryRecipes: async () => null },
    dsh: { relayFactory: undefined, harnessFactory: async launch => {
      launches.push(launch);
      return { start: async () => {}, close: async () => {},
        session: id => { sessions.push({ method: 'new', id }); return session(id); },
        resumeSession: async id => { sessions.push({ method: 'resume', id }); return session(id); } };
    }, relayFactory: async () => ({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'job-token', model: 'model-a', failure: () => null, close: async () => {} }) } };
  return { options, launches, sessions };
}

test('model capacity is explicit or labelled conservative, never an assumed one-million-token model', () => {
  assert.deepEqual(dshModelCapacity({}), { contextWindow: 32768, maxTokens: 4096,
    capacitySource: { contextWindow: 'conservative-default', maxOutputTokens: 'conservative-default' } });
  const configured = dshModelCapacity({ contextWindow: 1048576, maxOutputTokens: 65536 });
  assert.equal(configured.maxTokens, 65536); assert.equal(configured.contextWindow, 1048576);
  assert.equal(configured.capacitySource.maxOutputTokens, 'configured');
  assert.throws(() => dshModelCapacity({ contextWindow: 2048, maxOutputTokens: 4096 }), { code: 'TECHNICAL_CONFIGURATION_ERROR' });
});

test('same model resumes; changed model creates an explicit execution without losing candidate or accepted state', async t => {
  const f = await runnerFixture(t);
  await runDshAdaptation(f.options);
  let saved = await readAdaptationState(f.options.statePath);
  const first = saved.backend.sessionId;
  // A durable SDK session has actually begun in this saved business checkpoint.
  saved.backend.sessionStarted = true;
  saved.candidateId = 'candidate-retained'; saved.validationId = 'validation-retained';
  await writeFile(f.options.statePath, JSON.stringify(saved));
  await runDshAdaptation(f.options);
  assert.equal(f.sessions.at(-1).method, 'resume'); assert.equal(f.sessions.at(-1).id, first);
  const changed = await runDshAdaptation({ ...f.options, connection: { ...f.options.connection, model: 'model-b', contextWindow: 64000, maxOutputTokens: 12000 } });
  assert.equal(changed.stopReason, 'FIXTURE_STOP');
  saved = await readAdaptationState(f.options.statePath);
  assert.equal(f.sessions.at(-1).method, 'new'); assert.notEqual(saved.backend.sessionId, first);
  assert.equal(saved.candidateId, 'candidate-retained'); assert.equal(saved.validationId, 'validation-retained');
  assert.equal(saved.backend.transition.previousSessionId, first);
  assert.equal(JSON.parse(await readFile(saved.backend.transition.archive, 'utf8')).backend.sessionId, first);
  assert.equal(f.launches.at(-1).model, 'model-b'); assert.equal(f.launches.at(-1).maxTokens, 12000);
  assert.equal(f.launches.at(-1).env.PINHAO_DSH_CONTEXT_WINDOW, '64000');
  const patch = JSON.parse(await readFile(f.launches.at(-1).patches.at(-1), 'utf8'));
  assert.equal(patch.find(row => row.id === 'compaction-basic').config.maxTokens, 8192);
  const frozen = await readFile(f.options.statePath);
  await assert.rejects(runDshAdaptation({ ...f.options, project: { ...f.options.project, sourceFingerprint: 'different-source' } }), { code: 'DSH_SESSION_SOURCE_CHANGED' });
  assert.deepEqual(await readFile(f.options.statePath), frozen);
});

test('a legacy checkpoint migrates explicitly and keeps its old evidence rather than asking users to delete it', async t => {
  const f = await runnerFixture(t);
  const identity = hash(['project', 'request', f.options.gameDir, null]);
  await writeFile(f.options.statePath, JSON.stringify({ format: 'pinhao-adaptation-task-1', id: 'legacy-state', identity,
    createdAt: '2026-01-01T00:00:00Z', attempts: 2, executionWindow: 1, events: [], failures: {}, messages: [{ role: 'user', content: 'Old model history' }], candidateId: 'legacy-candidate' }));
  await runDshAdaptation(f.options);
  const saved = await readAdaptationState(f.options.statePath);
  assert.equal(saved.backend.name, 'dsh'); assert.equal(saved.backend.transition.reason, 'legacy-runtime-upgrade');
  assert.equal(saved.candidateId, 'legacy-candidate'); assert.equal(saved.messages, undefined);
  const old = JSON.parse(await readFile(saved.backend.transition.archive, 'utf8'));
  assert.equal(old.messages[0].content, 'Old model history');
  assert.equal(old.identity, identity);
});

test('a blocked non-first job preserves all host requirement identities in pool progress', async () => {
  const progress = [];
  const result = await runAdaptationPool({ jobs: [{ id: 'first', files: null }, { id: 'second', files: null }], concurrency: 2,
    coverage: { needsAdaptation: true }, onProgress: p => { progress.push(p); },
    run: async ({ requestContext }) => requestContext.jobId === 'first' ? { status: 'resolved' } : {
      status: 'needs-review', stopReason: 'HOST_VERIFICATION_BLOCKED', stopReasonCode: 'HOST_VERIFICATION_BLOCKED',
      candidateId: 'candidate-2', validationId: 'validation-2', blockedNeeds: [
        { requirementRef: 'requirement-2', kind: 'FORMAT_UNSUPPORTED', satisfiedBy: null },
        { requirementRef: 'prior-requirement', kind: 'FORMAT_UNSUPPORTED', satisfiedBy: null, candidateId: 'prior-candidate', validationId: 'prior-validation' },
      ] },
    requestContext: { adaptationRequestId: 'request' } });
  assert.equal(result.blockedNeeds[0].jobId, 'second'); assert.equal(result.blockedNeeds[0].candidateId, 'candidate-2');
  assert.equal(result.blockedNeeds[1].candidateId, 'prior-candidate'); assert.equal(result.blockedNeeds[1].validationId, 'prior-validation');
  assert.equal(progress.at(-1).stopReasonCode, 'HOST_VERIFICATION_BLOCKED');
  assert.equal(progress.at(-1).jobs.find(row => row.id === 'second').validationId, 'validation-2');
});

test('runtime lifecycle cache reuses unchanged identity and rechecks changed entry bytes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-runtime-identity-')); cleanup(t, root);
  await mkdir(path.join(root, 'node'));
  const files = { 'node/node.exe': 'fixture node bytes', 'sdk.js': 'export const sdk=1', 'runtime.js': 'export const runtime=1', 'provider.js': 'export const provider=1' };
  const node = { schema: 'pinhao-managed-node-1', platform: process.platform, arch: process.arch, sha256: hash(files['node/node.exe']) };
  files['node/provenance.json'] = JSON.stringify(node);
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(root, file), content);
  const provenance = { schema: 'pinhao-dsh-runtime-1', commit: DSH_BACKEND_VERSION, nodeExecutable: 'node/node.exe', nodeProvenance: 'node/provenance.json',
    sdkEntry: 'sdk.js', runtimeEntry: 'runtime.js', modelProviderEntry: 'provider.js', files: Object.entries(files).map(([file, value]) => ({ path: file, sha256: hash(value) })) };
  await writeFile(path.join(root, 'pinhao-runtime-provenance.json'), JSON.stringify(provenance));
  const first = await verifiedDshRuntime({ sourceRoot: root });
  assert.equal(await verifiedDshRuntime({ sourceRoot: root }), first);
  await writeFile(path.join(root, 'sdk.js'), 'export const sdk="changed longer bytes"');
  await assert.rejects(verifiedDshRuntime({ sourceRoot: root }), { code: 'DSH_RUNTIME_PROVENANCE' });
});
