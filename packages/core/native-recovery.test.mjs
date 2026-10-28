import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from './workspace-store.mjs';
import { createService, defaultSettings } from './service.mjs';
import { sha256 } from '../exchange/index.mjs';

const source = 'A complete neutral scene.';
const secrets = { encrypt: value => `fixture:${value}`, decrypt: value => value.slice(8) };
const remaining = ['data/hidden-a.json', 'data/hidden-b.json'];
const coverage = needsAdaptation => ({
  unitCount: 1, completeness: needsAdaptation ? 'partial' : 'complete', needsAdaptation,
  summary: { extracted: 1, 'display-text-candidate': needsAdaptation ? 2 : 0, unresolvedCandidates: needsAdaptation ? 2 : 0 },
  resources: [{ file: 'data/native.json', kind: 'extracted', units: 1 }, ...(needsAdaptation ? remaining.map(file => ({ file, kind: 'display-text-candidate', units: 0 })) : [])],
  dynamicCandidates: needsAdaptation ? remaining.map((file, index) => ({ id: `neutral-candidate-${index}`, file, source: `Neutral hidden scene ${index}.` })) : [],
  triggers: needsAdaptation ? ['suspected-omission'] : [],
});

async function waitForPaused(service, id) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await service.getProject({ projectId: id });
    if (value.status === 'paused') return value;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail('Neutral recovery did not reach its pending-resource checkpoint');
}

async function fixture(t, { engine = 'MZ', extractionFails = false, needsAdaptation = false, strict = false } = {}) {
  const base = os.tmpdir(), root = await mkdtemp(path.join(base, 'pinhao-native-recovery-'));
  const gameDir = path.join(root, 'game'), dataDir = path.join(root, 'profile'), id = 'neutral-recovery';
  const workspaceDir = path.join(dataDir, 'projects', id);
  await mkdir(path.join(gameDir, 'data'), { recursive: true });
  await mkdir(path.join(gameDir, 'save'));
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(path.join(gameDir, 'data', 'native.json'), JSON.stringify({ text: source }));
  for (const file of remaining) await writeFile(path.join(gameDir, file), JSON.stringify({ text: 'A complete hidden scene.' }));
  await writeFile(path.join(gameDir, 'save', 'private.dat'), 'neutral saved progress');
  const store = createStore(dataDir);
  store.put('projects', {
    id, name: 'Neutral recovery fixture', gameDir, workspaceDir, engine, prepared: false, nativeRetried: true,
    nativeAttemptRevision: 'neutral-native-old', status: 'paused', stage: '技术适配就绪', targetLanguage: 'zh-Hans',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    adaptationRequest: { id: 'old-adaptation-request', nativeRevision: 'neutral-native-old', jobs: [{ id: 'coordinator', files: null }], failure: { code: 'OLD_NATIVE_FAILURE', message: 'Neutral old parser failure' } },
  });
  const unitId = `u-${sha256(`${id}:native:0`).slice(0, 24)}`;
  const accepted = { id: unitId, legacyId: 'native:0', kind: 'message', source, sourceHash: sha256(source), translation: '保留已经校对的中性文字。', notes: '已接受的校对成果', revision: 3, status: 'proofread', tokens: [], context: { file: 'data/native.json' } };
  store.putUnit(id, accepted); store.addRevision(id, accepted); store.close();
  const calls = { extract: 0, roundtrip: 0, adaptations: [] };
  const worker = async (command, input) => {
    if (command === 'catalog') return { engines: [], nativeRevision: 'neutral-native-new' };
    if (command === 'probe') return { engine, root: '.', capabilities: { extract: true, nativeBuild: true, assist: false, assistModes: [] } };
    if (command === 'extract') {
      calls.extract++;
      if (extractionFails) throw new Error('Neutral current parser still needs adaptation');
      await mkdir(input.workspaceDir, { recursive: true });
      await writeFile(path.join(input.workspaceDir, 'manifest.json'), JSON.stringify({ units: { 'native:0': { controls: {} } }, engine }));
      return { workspaceDir: input.workspaceDir, sourceFingerprint: 'neutral-current-baseline', units: [{ id: 'native:0', kind: 'message', source, tokens: [], context: { file: 'data/native.json' } }] };
    }
    if (command === 'roundtrip') { calls.roundtrip++; return { passed: true }; }
    throw new Error(`Unexpected neutral worker command: ${command}`);
  };
  const service = await createService({
    dataDir, worker, secrets, scriptTools: null, imageTools: null, adapterLab: { dispatch: async () => null },
    coverageScanner: async () => coverage(needsAdaptation || extractionFails),
    technicalProvider: async () => ({ decision: 'native-standard', summary: 'Neutral parser verified', selectedCandidateIds: [] }),
    provider: async () => assert.fail('Native recovery should not call a translation model'),
    adaptationProvider: async args => {
      calls.adaptations.push(args.assignment?.files ?? null);
      return { status: 'needs-review', reason: 'Neutral resource validation is pending', retryable: true };
    },
  });
  const settings = defaultSettings(); settings.connection.model = 'neutral-fixture-model'; settings.connection.apiKey = 'neutral-fixture-credential';
  settings.pauseOnLocalFailure = strict;
  await service.saveSettings(settings);
  await service.grantAdaptationBudget({ projectId: id, grantId: 'explicit-native-recovery-fixture', httpAttempts: 20, windows: 4,
    reason: 'Explicit isolated recovery allowance for this pre-existing request' });
  const record = () => {
    const reader = createStore(dataDir);
    try { return reader.one('projects', id); } finally { reader.close(); }
  };
  t.after(async () => {
    await service.close();
    const relative = path.relative(base, root);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { service, id, calls, record, gameDir, accepted };
}

for (const engine of ['MZ', 'Godot']) test(`a ${engine} project retries an upgraded native pipeline before any technical model`, async t => {
  const f = await fixture(t, { engine });
  const result = await f.service.startProject({ projectId: f.id });
  assert.equal(result.status, 'ready', JSON.stringify({ result, calls: f.calls, record: f.record() })); assert.equal(result.total, 1); assert.equal(result.adaptationPending, false);
  assert.equal(f.calls.extract, 1); assert.equal(f.calls.roundtrip, 1); assert.deepEqual(f.calls.adaptations, []);
  assert.equal(f.record().nativeAttemptRevision, 'neutral-native-new');
  assert.equal(f.record().nativeRetryRevision, 'neutral-native-new');
  const unit = (await f.service.listText({ projectId: f.id })).units[0];
  assert.equal(unit.translation, f.accepted.translation); assert.equal(unit.notes, f.accepted.notes); assert.equal(unit.revision, 3); assert.equal(unit.status, 'proofread');
  assert.equal(await readFile(path.join(f.gameDir, 'save', 'private.dat'), 'utf8'), 'neutral saved progress');
});

test('a failed current native revision is attempted once across repeated starts', async t => {
  const f = await fixture(t, { extractionFails: true });
  await f.service.startProject({ projectId: f.id });
  await waitForPaused(f.service, f.id);
  assert.equal(f.calls.extract, 1);
  assert.equal(f.record().adaptationRequest.nativeRevision, 'neutral-native-new');
  assert.equal(f.record().nativeRetryRevision, 'neutral-native-new', 'the upgraded pipeline attempt consumes this revision retry');
  assert.equal(f.record().adaptationAccounting['old-adaptation-request'].historyCoverage, 'partial', 'a fixture grant does not fabricate complete legacy history');
  await f.service.retryAdaptation({ projectId: f.id });
  await waitForPaused(f.service, f.id);
  assert.equal(f.calls.extract, 1, 'the same source and parser revision must not trigger another native extraction');
  assert.ok(f.calls.adaptations.length >= 1, JSON.stringify({ calls: f.calls, record: f.record() }));
});

test('new native coverage replaces an obsolete coordinator plan with resource assignments', async t => {
  const f = await fixture(t, { needsAdaptation: true, strict: true });
  const prepared = await f.service.startProject({ projectId: f.id });
  assert.equal(prepared.status, 'ready', JSON.stringify({ prepared, calls: f.calls, record: f.record() })); assert.equal(prepared.adaptationPending, true);
  assert.equal(f.record().adaptationRequest.jobs, undefined, 'the old failure coordinator must not survive a successful native re-extraction');
  assert.equal(f.record().adaptationRequest.failure.code, 'EXTRACTION_COVERAGE');
  assert.deepEqual(f.calls.adaptations, []);
  await f.service.startProject({ projectId: f.id });
  await waitForPaused(f.service, f.id);
  assert.deepEqual(f.calls.adaptations.flat().sort(), [...remaining].sort());
  assert.ok(f.record().adaptationRequest.jobs.every(job => job.id !== 'coordinator' && job.files.length === 1));
  assert.equal(f.calls.extract, 1);
});
