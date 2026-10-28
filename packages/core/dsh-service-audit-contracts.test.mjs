import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';

// Host wiring tests only. No external API, real game or installed profile is used.
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-dsh-service-audit-'));
  const gameDir = path.join(root, 'original'), calls = { adaptation: 0, text: 0, nativePlan: 0 };
  await mkdir(path.join(gameDir, 'data'), { recursive: true });
  await writeFile(path.join(gameDir, 'data', 'native.json'), '{"text":"One complete scene.","identity":"keep-id"}');
  await writeFile(path.join(gameDir, 'data', 'hidden.json'), '{"text":"An unresolved complete scene."}');
  const coverage = { completeness: 'partial', unitCount: 1, needsAdaptation: true,
    summary: { extracted: 1, unresolvedCandidates: 1 },
    resources: [{ file: 'data/native.json', kind: 'extracted', units: 1 }, { file: 'data/hidden.json', kind: 'display-text-candidate', units: 0 }],
    dynamicCandidates: [{ id: 'hidden-candidate', file: 'data/hidden.json', source: 'An unresolved complete scene.' }], triggers: ['suspected-omission'] };
  const service = await createService({ dataDir: path.join(root, 'profile'), scriptTools: null, imageTools: null,
    adapterLab: { dispatch: async () => null, describeVerificationCapabilities: async () => ({ fingerprint: options.fingerprint?.() ?? 'cap-one' }) },
    coverageScanner: async () => coverage, adaptationLimits: options.adaptationLimits,
    technicalProvider: async () => { calls.nativePlan++; assert.fail('Native extraction must not purchase the removed plan signature'); },
    adaptationProvider: async args => { calls.adaptation++; return options.adapt(args, calls.adaptation); },
    secrets: { encrypt: value => `fixture:${value}`, decrypt: value => value.slice(8) },
    provider: async ({ wire }) => { calls.text++; return { records: wire.payload.units.map(unit => ({ id: unit.id, translation: '一段完整场景。', notes: '' })) }; },
    worker: async (command, input) => {
      if (command === 'catalog') return { engines: [], nativeRevision: 'audit-fixture-native' };
      if (command === 'probe') return { engine: 'RPG Maker MV', root: '.', capabilities: { extract: true, nativeBuild: true, assist: false } };
      if (command === 'assistInfo') return { supported: false, modes: [] };
      if (command === 'extract') {
        await mkdir(input.workspaceDir, { recursive: true });
        await writeFile(path.join(input.workspaceDir, 'manifest.json'), '{"units":{"native:1":{"controls":{}}}}');
        return { workspaceDir: input.workspaceDir, sourceFingerprint: 'audit-fixture-source', units: [
          { id: 'native:1', source: 'One complete scene.', kind: 'message', tokens: [], context: { file: 'data/native.json' } } ] };
      }
      if (command === 'roundtrip' || command === 'validate') return { ok: true, valid: true, passed: true };
      if (command === 'build') { await mkdir(input.outputDir, { recursive: true }); return { buildDir: input.outputDir }; }
      throw new Error(`Unexpected audit fixture command: ${command}`);
    } });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }); });
  const settings = defaultSettings(); settings.proofreading = false; settings.concurrency = 1;
  settings.pauseOnLocalFailure = true; settings.connection.model = 'audit-fixture'; settings.connection.apiKey = 'fixture-key';
  await service.saveSettings(settings);
  const project = await service.createProject({ gameDir });
  assert.equal(project.total, 1);
  return { service, projectId: project.id, gameDir, calls };
}

async function waitPaused(f) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const detail = await f.service.getProject({ projectId: f.projectId });
    if (detail.status === 'paused') return detail;
    assert.notEqual(detail.status, 'failed', detail.lastError);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected a durable paused state');
}

test('ordinary product can pass four technical windows without hidden caps while keeping usage history', async t => {
  const f = await fixture(t, { adapt: async (args, call) => {
    const meter = args.requestContext.owner.snapshot();
    assert.equal(meter.limitsEnforced, false);
    assert.deepEqual(meter.limits, { maxHttpAttempts: null, maxWindows: null });
    assert.equal(meter.remainingWindows, null); assert.equal(meter.remainingHttpAttempts, null);
    return { status: 'needs-review', retryable: true, reason: 'Recorded local investigation.',
      continuation: { action: call < 5 ? 'continue' : 'pause', reasonCode: 'AUDIT_MANUAL_PAUSE' } };
  } });
  await f.service.startProject({ projectId: f.projectId, mode: 'translation' });
  const paused = await waitPaused(f);
  assert.equal(f.calls.adaptation, 5, JSON.stringify({ stage: paused.stage, lastError: paused.lastError, tasks: paused.tasks, adaptation: paused.adaptation }));
  assert.equal(paused.adaptation.accounting.windowsUsed, 5);
  assert.equal(paused.adaptation.blocked, false);
  assert.equal(paused.adaptation.retryable, true);
  assert.equal(paused.adaptation.continuationNeeded, false);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(f.calls.adaptation, 5, 'Manual pause must not schedule a sixth window');
  assert.equal(f.calls.nativePlan, 0);
});

test('manual pause remains retryable without automatic continuation or a new request identity', async t => {
  const owners = [];
  const f = await fixture(t, { adapt: async args => {
    owners.push(args.requestContext.owner.snapshot().adaptationRequestId);
    return { status: 'needs-review', retryable: true, reason: 'Need explicit resume.',
      continuation: { action: 'pause', reasonCode: 'AUDIT_PAUSE' } };
  } });
  await f.service.startProject({ projectId: f.projectId, mode: 'translation' });
  const first = await waitPaused(f);
  assert.equal(first.adaptation.blocked, false); assert.equal(first.adaptation.continuationNeeded, false);
  await f.service.retryAdaptation({ projectId: f.projectId });
  const second = await waitPaused(f);
  assert.equal(f.calls.adaptation, 2, JSON.stringify(second.adaptation)); assert.equal(second.adaptation.accounting.windowsUsed, 2);
  assert.equal(owners[0], owners[1]);
});

test('explicitly limited evaluation can defer remaining resources without requesting more technical allowance', async t => {
  const f = await fixture(t, { adaptationLimits: { maxWindows: 1, maxHttpAttempts: 1 }, adapt: async () => ({
    status: 'needs-review', retryable: true, reason: 'Evaluation window complete.', continuation: { action: 'continue', reasonCode: 'AUDIT_PENDING' },
  }) });
  await f.service.startProject({ projectId: f.projectId, mode: 'translation' });
  const paused = await waitPaused(f);
  assert.equal(paused.adaptation.accounting.remainingWindows, 0);
  await f.service.continueAvailableText({ projectId: f.projectId, mode: 'translation' });
  const end = Date.now() + 12000;
  while (Date.now() < end && (await f.service.listText({ projectId: f.projectId })).units[0].translation !== '一段完整场景。') await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.calls.text, 1); assert.equal(f.calls.adaptation, 1);
  const text = await f.service.listText({ projectId: f.projectId });
  assert.equal(text.units[0].translation, '一段完整场景。', JSON.stringify(await f.service.getProject({ projectId: f.projectId })));
  assert.equal(await readFile(path.join(f.gameDir, 'data', 'native.json'), 'utf8'), '{"text":"One complete scene.","identity":"keep-id"}');
});

test('host-blocked work remains stopped until verification capability refresh changes the retry context', async t => {
  let fingerprint = 'cap-one';
  const needs = [{ code: 'FORMAT_PROFILE_UNSUPPORTED', profileId: 'missing-profile' }];
  const f = await fixture(t, { fingerprint: () => fingerprint, adapt: async () => ({
    status: 'needs-review', retryable: false, reason: 'A host verifier is missing.', stopReasonCode: 'HOST_VERIFICATION_BLOCKED',
    blockedNeeds: needs, candidateId: 'candidate-kept', validationId: 'validation-kept',
    continuation: { action: 'pause', reasonCode: 'HOST_VERIFICATION_BLOCKED' },
  }) });
  await f.service.startProject({ projectId: f.projectId, mode: 'translation' });
  const paused = await waitPaused(f);
  assert.equal(paused.adaptation.blocked, true);
  assert.equal(paused.adaptation.blockedNeeds[0].code, needs[0].code);
  assert.equal(paused.adaptation.blockedNeeds[0].profileId, needs[0].profileId);
  assert.equal(paused.adaptation.blockedNeeds[0].candidateId, 'candidate-kept');
  assert.equal(paused.adaptation.candidateId, 'candidate-kept'); assert.equal(paused.adaptation.validationId, 'validation-kept');
  await assert.rejects(f.service.retryAdaptation({ projectId: f.projectId }), { code: 'HOST_VERIFICATION_BLOCKED' });
  assert.equal(f.calls.adaptation, 1);
  fingerprint = 'cap-two';
  await f.service.retryAdaptation({ projectId: f.projectId });
  await waitPaused(f);
  assert.equal(f.calls.adaptation, 2, 'Capability refresh must run before the saved blocked-context gate');
});

test('damaged project detail keeps empty lane statistics without crashing the other projects', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-dsh-detail-audit-'));
  const dataDir = path.join(root, 'profile'), workspaceDir = path.join(root, 'damaged-workspace');
  let service;
  const store = createStore(dataDir);
  try {
    store.put('projects', { id: 'damaged', name: 'Damaged local fixture', engine: 'MZ', status: 'ready',
      gameDir: path.join(root, 'original'), workspaceDir, createdAt: '2026-10-28T00:00:00.000Z' });
  } finally { store.close(); }
  await writeFile(path.join(workspaceDir, 'pinhao.sqlite'), 'Invalid local fixture database, do not replace.');
  t.after(async () => { await service?.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }); });
  service = await createService({ dataDir, deferCatalog: true, scriptTools: null, worker: async () => ({ engines: [] }) });
  const detail = await service.getProject({ projectId: 'damaged' });
  assert.equal(detail.status, 'paused'); assert.match(detail.lastError, /数据库/);
  assert.equal(detail.lanes.adaptation.status, 'idle'); assert.equal(detail.lanes.text.status, 'idle');
  assert.equal(await readFile(path.join(workspaceDir, 'pinhao.sqlite'), 'utf8'), 'Invalid local fixture database, do not replace.');
});
