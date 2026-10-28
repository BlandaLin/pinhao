import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { sha256 } from '../exchange/index.mjs';

const units = [{ id: 'neutral-title', kind: 'dialogue', source: 'A complete neutral title.', tokens: [], context: { file: 'data/neutral.json' } }];
const coverage = { unitCount: 0, completeness: 'partial', needsAdaptation: true,
  summary: { extracted: 0, unresolvedCandidates: 1, 'display-text-candidate': 1 },
  resources: [{ file: 'data/neutral.json', kind: 'display-text-candidate', units: 0 }],
  dynamicCandidates: [{ id: 'neutral-unresolved', file: 'data/neutral.json', source: 'A complete neutral title.' }], triggers: ['suspected-omission'] };
async function until(read, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await read(); if (value) return value;
    await delay(10);
  }
  assert.fail(typeof message === 'function' ? message() : message);
}

async function fixture(t, scenario) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-native-dependency-transition-'));
  const dataDir = path.join(root, 'profile'), gameDir = path.join(root, 'neutral-original'), original = path.join(gameDir, 'data', 'neutral.json');
  await mkdir(path.dirname(original), { recursive: true });
  await writeFile(original, JSON.stringify({ text: units[0].source }));
  const originalHash = sha256(await readFile(original));
  const state = { missing: true, fingerprint: 'neutral-missing-health', extractionCalls: 0, roundtripCalls: 0, textCalls: 0, adaptations: [] };
  const service = await createService({ dataDir, scriptTools: null, imageTools: null,
    adapterLab: { dispatch: async () => null }, coverageScanner: async () => structuredClone(coverage),
    provider: async () => { state.textCalls++; assert.fail('This dependency transition does not buy text work'); },
    adaptationProvider: async args => {
      state.adaptations.push({ failure: structuredClone(args.failure), files: args.assignment?.files ?? null });
      return { status: 'needs-review', retryable: false, stopReasonCode: 'NEUTRAL_RECIPE_PENDING', reason: 'The neutral parser still needs a verified recipe.' };
    },
    worker: async (command, input) => {
      if (command === 'catalog') return { nativeRevision: 'neutral-native-code', dependencyHealth: { fingerprint: state.fingerprint },
        engines: [{ id: 'mz', name: 'RPG Maker MZ', extract: true, build: true, assist: false }] };
      if (command === 'probe') return { engine: 'MZ', root: '.', capabilities: { extract: true, nativeBuild: true, assist: false } };
      if (command === 'extract') {
        state.extractionCalls++;
        if (state.missing) return { ok: false, error: { code: 'NATIVE_DEPENDENCY_MISSING', message: 'Neutral native runtime is missing.',
          diagnostic: { category: 'dependency', phase: 'extract', dependencyId: 'neutral-runtime', state: 'missing' } } };
        if (scenario === 'format') return { ok: false, error: { code: 'FORMAT_UNSUPPORTED', message: 'The repaired runtime cannot decode this neutral format.' } };
        await mkdir(input.workspaceDir, { recursive: true });
        await writeFile(path.join(input.workspaceDir, 'manifest.json'), JSON.stringify({ engine: 'MZ',
          units: Object.fromEntries((scenario === 'zero' ? [] : units).map(unit => [unit.id, { controls: {} }])) }));
        return { units: scenario === 'zero' ? [] : units, workspaceDir: input.workspaceDir, sourceFingerprint: sha256(units) };
      }
      if (command === 'roundtrip') {
        state.roundtripCalls++;
        if (scenario === 'roundtrip') return { ok: false, error: { code: 'ROUNDTRIP_FAILED', message: 'The neutral no-change write did not preserve its source.' } };
        return { ok: true };
      }
      throw new Error(`Unexpected neutral transition worker command ${command}`);
    } });
  t.after(async () => {
    try { await service.close(); assert.equal(sha256(await readFile(original)), originalHash); assert.equal(state.textCalls, 0); }
    finally {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 30 });
    }
  });
  await service.saveSettings({ ...defaultSettings(), connection: { baseUrl: 'http://localhost:1/v1', model: 'neutral-no-network' } });
  const project = await service.createProject({ gameDir });
  return { service, state, projectId: project.id,
    start: () => service.startProject({ projectId: project.id }),
    detail: () => service.getProject({ projectId: project.id }),
    stored: () => { const db = createStore(dataDir); try { return db.one('projects', project.id); } finally { db.close(); } } };
}

for (const [scenario, code] of [['format', 'FORMAT_UNSUPPORTED'], ['zero', 'ZERO_TEXT_UNITS'], ['roundtrip', 'ROUNDTRIP_FAILED']]) {
  test(`repaired dependency transitions to ${scenario} diagnostics and the next start reaches technical adaptation`, async t => {
    const f = await fixture(t, scenario);
    const missing = f.stored();
    assert.equal(missing.nativeDependencyFailure.code, 'NATIVE_DEPENDENCY_MISSING');
    assert.equal(missing.adaptationRequest, undefined);
    await assert.rejects(f.start(), { code: 'NATIVE_DEPENDENCY_MISSING' });
    assert.equal(f.state.extractionCalls, 1); assert.equal(f.state.adaptations.length, 0);

    f.state.missing = false; f.state.fingerprint = 'neutral-repaired-health';
    const recovered = await f.start(), stored = f.stored();
    assert.equal(recovered.nativeDependencyFailure, undefined, 'The old missing-runtime diagnosis must not shadow a real new parser result');
    assert.equal(stored.nativeDependencyFailure, undefined, 'The dependency transition must be persisted, not only hidden by the UI');
    assert.equal(stored.adaptationRequest.failure.code, code);
    assert.notEqual(stored.nativeAttemptRevision, missing.nativeDependencyFailure.environmentFingerprint);
    assert.equal(f.state.extractionCalls, 2); assert.equal(f.state.adaptations.length, 0);

    await f.start();
    await until(() => f.state.adaptations.length > 0, () => `A repaired environment must leave preparation and enter technical adaptation: ${JSON.stringify({ state: f.state, project: f.stored() })}`);
    await until(async () => (await f.detail()).status === 'paused', 'The isolated technical diagnostic did not settle');
    assert.ok(f.state.adaptations.every(attempt => attempt.failure.code === code));
    assert.ok(f.state.extractionCalls <= 3, 'At most one existing bounded native retry may precede adaptation');
    const settled = { extract: f.state.extractionCalls, roundtrip: f.state.roundtripCalls };
    try { await f.start(); }
    catch (error) { assert.notEqual(error.code, 'NATIVE_DEPENDENCY_MISSING'); assert.notEqual(error.code, 'NATIVE_DEPENDENCY_INVALID'); }
    await until(async () => (await f.detail()).status === 'paused', 'A repeated start did not keep its technical checkpoint');
    assert.equal(f.state.extractionCalls, settled.extract, 'Repeated starts do not rerun the same healthy native extraction');
    assert.equal(f.state.roundtripCalls, settled.roundtrip, 'Repeated starts do not rerun the same failed native no-op write');
    assert.equal(f.stored().nativeDependencyFailure, undefined);
  });
}
