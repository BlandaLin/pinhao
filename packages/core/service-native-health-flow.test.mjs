import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { sha256 } from '../exchange/index.mjs';

const nativeUnits = [{ id: 'neutral-title', kind: 'dialogue', source: 'A complete neutral title.', tokens: [],
  context: { file: 'neutral.json', event: 1, page: 0 } }];

async function fixture(t, { missing = false, dependencyId = 'neutral', dependencyState = 'missing', allowTranslation = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-native-health-flow-'));
  const gameDir = path.join(root, 'neutral-original'), dataDir = path.join(root, 'data');
  await mkdir(gameDir); const original = path.join(gameDir, 'original.txt');
  await writeFile(original, 'Immutable neutral original.');
  const originalHash = sha256(await readFile(original));
  const calls = [], state = { missing, fingerprint: missing ? 'neutral-health-missing' : 'neutral-health-ready', providerCalls: 0,
    adaptationCalls: 0, catalogFailure: false };
  const privateArtifact = path.join(root, 'private-diagnostic-artifact.txt');
  const service = await createService({ dataDir, scriptTools: null,
    provider: async ({ role, wire }) => {
      state.providerCalls++;
      if (!allowTranslation) throw new Error('No model request belongs to this native flow.');
      assert.equal(role, 'translation');
      return { records: wire.payload.units.map(unit => ({ id: unit.id, translation: '完整的中性标题译文。', notes: '' })) };
    },
    adaptationProvider: async () => { state.adaptationCalls++; throw new Error('No adaptation model belongs to a dependency fault.'); },
    worker: async (command, args) => {
      calls.push({ command, args: structuredClone(args) });
      if (command === 'catalog') {
        if (state.catalogFailure) throw new Error('Neutral later catalog probe is unavailable.');
        return { nativeRevision: 'neutral-native-revision', dependencyHealth: { fingerprint: state.fingerprint },
          engines: [{ id: 'mz', name: 'RPG Maker MZ', extract: true, build: true, assist: true, assistModes: ['live'] }] };
      }
      if (command === 'probe') return { engine: 'MZ', capabilities: { extract: true, nativeBuild: true, assist: true, assistModes: ['live'] } };
      if (command === 'extract') {
        if (state.missing) return { ok: false, error: { code: dependencyState === 'invalid' ? 'NATIVE_DEPENDENCY_INVALID' : 'NATIVE_DEPENDENCY_MISSING',
          message: `Neutral native dependency is ${dependencyState}.`,
          diagnostic: { category: 'dependency', phase: 'extract', dependencyId, state: dependencyState, artifactPath: privateArtifact },
          absolutePath: privateArtifact } };
        await mkdir(args.workspaceDir, { recursive: true });
        return { units: nativeUnits, workspaceDir: args.workspaceDir, sourceFingerprint: sha256(nativeUnits) };
      }
      if (['roundtrip', 'validate'].includes(command)) return { ok: true };
      if (command === 'build') {
        await mkdir(args.outputDir, { recursive: true });
        await writeFile(path.join(args.outputDir, 'neutral-build.txt'), 'Neutral native data.');
        return { buildDir: args.outputDir };
      }
      if (command === 'assemble') {
        await mkdir(args.outputDir, { recursive: true });
        const launchPath = path.join(args.outputDir, 'Game.exe');
        await writeFile(launchPath, 'Neutral non-executed fixture.');
        if (args.assistEnabled) await writeFile(path.join(args.outputDir, 'neutral-assist-bridge.txt'), 'Neutral installed bridge.');
        return { outputDir: args.outputDir, launchPath, assist: args.assistEnabled
          ? { supported: true, status: 'installed', detail: 'Neutral bridge installed.' }
          : { supported: false, modes: [], status: 'disabled', detail: 'Neutral assistance explicitly disabled.' } };
      }
      throw new Error(`Unexpected neutral native command ${command}`);
    } });
  t.after(async () => {
    try {
      await service.close();
      assert.equal(state.adaptationCalls, 0);
      if (allowTranslation) assert.ok(state.providerCalls > 0);
      else assert.equal(state.providerCalls, 0);
      assert.equal(sha256(await readFile(original)), originalHash);
    } finally {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 30 });
    }
  });
  await service.saveSettings({ ...defaultSettings(), connection: { baseUrl: 'http://localhost:1/v1', model: 'neutral-no-network' } });
  const project = await service.createProject({ gameDir });
  return { service, project, state, calls, privateArtifact,
    commands: name => calls.filter(call => call.command === name),
    stored: () => { const db = createStore(dataDir); try { return db.one('projects', project.id); } finally { db.close(); } },
    detail: () => service.getProject({ projectId: project.id }) };
}

test('dependency failure pauses without adaptation, retries only after a fresh health fingerprint and keeps a project cache', async t => {
  const f = await fixture(t, { missing: true });
  let detail = await f.detail();
  assert.equal(detail.status, 'paused'); assert.equal(detail.adaptationRequest, undefined);
  assert.equal(detail.nativeDependencyFailure.code, 'NATIVE_DEPENDENCY_MISSING');
  assert.deepEqual(detail.nativeDependencyFailure.diagnostic, { category: 'dependency', phase: 'extract', dependencyId: 'neutral', state: 'missing' });
  assert.ok(!JSON.stringify(detail.nativeDependencyFailure).includes(f.privateArtifact));
  assert.equal(Object.hasOwn(detail.nativeDependencyFailure, 'artifacts'), false);
  assert.equal(f.commands('extract').length, 1); assert.equal(f.commands('roundtrip').length, 0);
  const context = await f.service.getProjectContext({ projectId: f.project.id });
  assert.equal(f.stored().adaptationRequest, undefined, 'The persisted project must not create an adaptation request for a missing tool');
  const first = f.commands('extract')[0].args;
  assert.equal(first.nativeRecoveryCacheDir, path.join(context.workspaceDir, 'technical', 'native-recovery-cache'));
  await assert.rejects(f.service.startProject({ projectId: f.project.id }), error => {
    assert.equal(error.code, 'NATIVE_DEPENDENCY_MISSING');
    assert.equal(error.diagnostic.dependencyId, 'neutral'); assert.equal(error.diagnostic.state, 'missing');
    return true;
  });
  assert.equal(f.commands('extract').length, 1, 'The same broken environment must not rerun native extraction or buy adaptation');
  assert.equal(f.state.providerCalls, 0);
  f.state.fingerprint = 'neutral-health-repaired'; f.state.missing = false;
  const restored = await f.service.startProject({ projectId: f.project.id });
  assert.equal(restored.status, 'ready'); detail = await f.detail();
  assert.equal(detail.nativeDependencyFailure, undefined); assert.equal(detail.adaptationRequest, undefined);
  assert.equal(f.stored().adaptationRequest, undefined);
  assert.equal(detail.total, 1); assert.equal(f.commands('extract').length, 2); assert.equal(f.commands('roundtrip').length, 1);
  const second = f.commands('extract')[1].args;
  assert.equal(second.projectId, first.projectId); assert.equal(second.nativeRecoveryCacheDir, first.nativeRecoveryCacheDir);
  assert.notEqual(second.workspaceDir, first.workspaceDir);
  assert.ok(second.workspaceDir.startsWith(path.join(context.workspaceDir, 'preparation') + path.sep));
  assert.ok(!second.nativeRecoveryCacheDir.startsWith(path.dirname(second.workspaceDir) + path.sep), 'The cache must not live inside a disposable retry attempt');
  assert.deepEqual(f.calls.slice(-4).map(call => call.command), ['catalog', 'probe', 'extract', 'roundtrip']);
  assert.equal(f.state.providerCalls, 0);
});

test('assist preference reaches assembly, disabled status survives and toggling invalidates a bridged build cache', async t => {
  const f = await fixture(t);
  assert.equal((await f.detail()).status, 'ready');
  const first = await f.service.buildProject({ projectId: f.project.id });
  assert.equal(f.commands('assemble').length, 1); assert.equal(f.commands('assemble')[0].args.assistEnabled, true);
  assert.equal(first.assistance.status, 'installed'); assert.equal(first.assistance.supported, true);
  await access(path.join(first.path, 'neutral-assist-bridge.txt'));
  const cachedFirst = await f.service.buildProject({ projectId: f.project.id });
  assert.equal(cachedFirst.id, first.id); assert.equal(f.commands('assemble').length, 1, 'Unchanged enabled output really is reusable');
  await f.service.setAssistEnabled({ projectId: f.project.id, enabled: false });
  const disabled = await f.service.buildProject({ projectId: f.project.id });
  assert.equal(f.commands('assemble').length, 2); assert.equal(f.commands('assemble')[1].args.assistEnabled, false);
  assert.notEqual(disabled.id, first.id); assert.notEqual(disabled.inputHash, first.inputHash);
  assert.deepEqual(disabled.assistance, { supported: true, modes: ['live'], detail: 'Neutral assistance explicitly disabled.', status: 'disabled' });
  assert.deepEqual((await f.detail()).assistance, disabled.assistance);
  await assert.rejects(access(path.join(disabled.path, 'neutral-assist-bridge.txt')), { code: 'ENOENT' });
  const cachedDisabled = await f.service.buildProject({ projectId: f.project.id });
  assert.equal(cachedDisabled.id, disabled.id); assert.equal(f.commands('assemble').length, 2);
  await f.service.setAssistEnabled({ projectId: f.project.id, enabled: true });
  const enabledAgain = await f.service.buildProject({ projectId: f.project.id });
  assert.equal(f.commands('assemble').length, 3); assert.equal(f.commands('assemble')[2].args.assistEnabled, true);
  assert.notEqual(enabledAgain.id, disabled.id); assert.notEqual(enabledAgain.inputHash, disabled.inputHash);
  assert.equal(enabledAgain.assistance.status, 'installed');
  await access(path.join(enabledAgain.path, 'neutral-assist-bridge.txt'));
});

for (const dependencyState of ['missing', 'invalid']) test(`python-runtime ${dependencyState} stays a bounded dependency diagnosis without model dispatch`, async t => {
  const f = await fixture(t, { missing: true, dependencyId: 'python-runtime', dependencyState });
  const detail = await f.detail(), code = dependencyState === 'invalid' ? 'NATIVE_DEPENDENCY_INVALID' : 'NATIVE_DEPENDENCY_MISSING';
  assert.equal(detail.status, 'paused'); assert.equal(detail.nativeDependencyFailure.code, code);
  assert.deepEqual(detail.nativeDependencyFailure.diagnostic, { category: 'dependency', phase: 'extract', dependencyId: 'python-runtime', state: dependencyState });
  assert.ok(!JSON.stringify(detail.nativeDependencyFailure).includes(f.privateArtifact));
  assert.equal(f.stored().adaptationRequest, undefined);
  await assert.rejects(f.service.startProject({ projectId: f.project.id }), error => error.code === code
    && error.diagnostic.dependencyId === 'python-runtime' && error.diagnostic.state === dependencyState);
  assert.equal(f.commands('extract').length, 1); assert.equal(f.state.providerCalls, 0); assert.equal(f.state.adaptationCalls, 0);
});

test('a prepared healthy project translates without a fresh catalog dependency when later catalog probes fail', async t => {
  const f = await fixture(t, { allowTranslation: true });
  assert.equal(f.stored().prepared, true);
  assert.equal((await f.detail()).nativeDependencyFailure, undefined);
  const catalogCalls = f.commands('catalog').length;
  assert.ok(catalogCalls > 0, 'The initial native health catalog must have succeeded');
  f.state.catalogFailure = true;
  await f.service.startProject({ projectId: f.project.id, mode: 'translation' });
  let completed;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const detail = await f.detail();
    assert.notEqual(detail.status, 'paused', detail.lastError ?? detail.stage);
    if (detail.status === 'completed') { completed = detail; break; }
    await delay(10);
  }
  assert.ok(completed, 'The prepared project must finish its isolated translation');
  assert.equal(f.commands('catalog').length, catalogCalls, 'Pure text continuation must not reprobe unrelated native dependencies');
  assert.equal(f.commands('extract').length, 1); assert.equal(f.state.providerCalls, 1); assert.equal(f.state.adaptationCalls, 0);
  const texts = (await f.service.listText({ projectId: f.project.id })).units;
  assert.equal(texts.length, 1); assert.equal(texts[0].status, 'translated'); assert.equal(texts[0].translation, '完整的中性标题译文。');
});
