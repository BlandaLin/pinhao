import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { sha256 } from '../exchange/index.mjs';

const parent = path.resolve('local', 'available-text-tests');
await mkdir(parent, { recursive: true });
const nativeFile = 'data/native.json';
const unresolvedFiles = ['data/extra-a.json', 'data/extra-b.json'];
const lines = ['The lantern shines.', 'The door opens.'];
const secrets = { encrypt: value => `fixture:${value}`, decrypt: value => value.slice(8) };

async function settle(service, projectId, status = 'completed') {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const project = await service.getProject({ projectId });
    if (project.status === status) return project;
    if (['paused', 'failed'].includes(project.status) && status === 'completed') assert.fail(JSON.stringify(project));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Available text did not reach ${status}`);
}

async function fixture(t, { engine = 'RPG Maker MZ', strict = false, empty = false, rejectRoundtrip = false } = {}) {
  const directory = await mkdtemp(path.join(parent, 'case-'));
  const gameDir = path.join(directory, 'game'), dataDir = path.join(directory, 'profile');
  await mkdir(path.join(gameDir, 'data'), { recursive: true });
  await mkdir(path.join(gameDir, 'save'));
  await writeFile(path.join(gameDir, 'Game.exe'), 'neutral launcher marker');
  await writeFile(path.join(gameDir, nativeFile), JSON.stringify({ lines, logic: { switch: 3 } }));
  for (const file of unresolvedFiles) await writeFile(path.join(gameDir, file), JSON.stringify({ text: 'Retain this unresolved scene.', logic: { id: file } }));
  await writeFile(path.join(gameDir, 'save/current.dat'), 'retain private progress');
  const originals = new Map(await Promise.all([nativeFile, ...unresolvedFiles, 'save/current.dat'].map(async file => [file, await readFile(path.join(gameDir, file))])));
  const calls = { adaptations: [], translation: 0, proofreading: 0, roundtrip: 0, build: 0, assemble: 0 };
  let coveragePending = true, resolveAdaptation = false, roundtripFails = rejectRoundtrip;
  const coverage = () => ({
    unitCount: empty ? 0 : lines.length, completeness: coveragePending ? 'partial' : 'complete', needsAdaptation: coveragePending,
    summary: { extracted: empty ? 0 : 1, 'display-text-candidate': coveragePending ? unresolvedFiles.length : 0, unresolvedCandidates: coveragePending ? unresolvedFiles.length : 0 },
    resources: [{ file: nativeFile, kind: empty ? 'unclassified' : 'extracted', units: empty ? 0 : lines.length },
      ...(coveragePending ? unresolvedFiles.map(file => ({ file, kind: 'display-text-candidate', units: 0 })) : [])],
    dynamicCandidates: coveragePending ? unresolvedFiles.map((file, index) => ({ id: `candidate-${index}`, file, source: 'Retain this unresolved scene.' })) : [],
    triggers: coveragePending ? ['suspected-omission'] : [],
  });
  const worker = async (command, input) => {
    if (command === 'catalog') return { engines: [], nativeRevision: 'available-text-fixture-1' };
    if (command === 'assistInfo') return { supported: false, modes: [] };
    if (command === 'probe') return { engine, root: '.', capabilities: { extract: true, nativeBuild: true, assist: false, assistModes: [] } };
    if (command === 'extract') {
      const units = empty ? [] : lines.map((source, index) => ({ id: `native:${index}`, source, kind: 'message', tokens: [], context: { file: nativeFile } }));
      await mkdir(input.workspaceDir, { recursive: true });
      await writeFile(path.join(input.workspaceDir, 'manifest.json'), JSON.stringify({ engine, units: Object.fromEntries(units.map(unit => [unit.id, { controls: {} }])) }));
      return { workspaceDir: input.workspaceDir, units, sourceFingerprint: sha256(lines) };
    }
    if (command === 'roundtrip') {
      calls.roundtrip++;
      if (roundtripFails) throw new Error('Neutral native roundtrip failed');
      return { valid: true, passed: true };
    }
    if (command === 'validate') return { valid: true };
    if (command === 'build') {
      calls.build++;
      const content = JSON.parse(await readFile(path.join(gameDir, nativeFile), 'utf8'));
      for (const record of input.translations) content.lines[Number(record.id.split(':')[1])] = record.translation;
      await mkdir(path.join(input.outputDir, 'data'), { recursive: true });
      await writeFile(path.join(input.outputDir, nativeFile), JSON.stringify(content));
      return { buildDir: input.outputDir };
    }
    if (command === 'assemble') {
      calls.assemble++;
      await cp(gameDir, input.outputDir, { recursive: true });
      await cp(input.buildDir, input.outputDir, { recursive: true });
      return { outputDir: input.outputDir, launchPath: path.join(input.outputDir, 'Game.exe') };
    }
    throw new Error(`Unexpected fixture worker command ${command}`);
  };
  const create = () => createService({ dataDir, worker, secrets, scriptTools: null, imageTools: null,
    adapterLab: { dispatch: async () => null }, coverageScanner: async () => coverage(),
    technicalProvider: async () => ({ decision: 'native-standard', summary: 'Neutral native resources verified', selectedCandidateIds: [] }),
    provider: async ({ role, wire }) => {
      calls[role]++;
      return { records: wire.payload.units.map(unit => ({ id: unit.id,
        translation: role === 'proofreading' ? unit.currentTranslation : `译文：${unit.source}`, notes: unit.notes ?? '' })) };
    },
    adaptationProvider: async args => {
      calls.adaptations.push(args.assignment?.files ?? null);
      if (resolveAdaptation) { coveragePending = false; return { status: 'resolved', reason: 'Current remaining candidates were reviewed', reused: true }; }
      return { status: 'needs-review', reason: 'Neutral remaining resource validation is pending', retryable: true,
        continuation: { action: 'pause', reasonCode: 'FIXTURE_RESOURCE_PENDING' } };
    },
  });
  let service = await create();
  const settings = defaultSettings(); settings.pauseOnLocalFailure = strict; settings.connection.model = 'available-text-fixture'; settings.connection.apiKey = 'fixture-credential';
  await service.saveSettings(settings);
  t.after(async () => {
    await service.close();
    assert.equal(path.dirname(directory), parent);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
  });
  return { gameDir, calls, originals, get service() { return service; },
    reopen: async () => { await service.close(); service = await create(); },
    resolveRemaining: () => { resolveAdaptation = true; },
    failRoundtrip: () => { roundtripFails = true; },
  };
}

async function assertPreserved(f, project) {
  for (const [file, bytes] of f.originals) assert.deepEqual(await readFile(path.join(f.gameDir, file)), bytes, `Original ${file} remains unchanged`);
  for (const file of unresolvedFiles) assert.deepEqual(await readFile(path.join(project.builds.at(-1).path, file)), f.originals.get(file), `Unresolved ${file} remains original in the product`);
}

for (const engine of ['RPG Maker MZ', 'Godot']) test(`verified ${engine} text proceeds through translation, proofreading and build with remaining coverage debt`, async t => {
  const f = await fixture(t, { engine });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  assert.equal(created.adaptationPending, true); assert.equal(created.total, lines.length);
  await f.service.startProject({ projectId: created.id });
  const completed = await settle(f.service, created.id);
  assert.equal(completed.adaptationPending, false); assert.equal(completed.adaptationAvailable, true); assert.equal(completed.adaptationDeferred, true);
  assert.equal(completed.coverage.needsAdaptation, true); assert.equal(completed.coverage.summary.unresolvedCandidates, unresolvedFiles.length);
  assert.equal(completed.adaptation.pendingJobs, unresolvedFiles.length);
  assert.deepEqual(f.calls.adaptations.flat().sort(), unresolvedFiles, 'Known native engines split independent resources before deferring unresolved coverage');
  assert.ok(completed.issues.some(issue => issue.category === 'coverage-deferred' && !issue.resolvedAt));
  assert.ok(f.calls.translation > 0 && f.calls.proofreading > 0); assert.equal(f.calls.assemble, 1);
  const output = JSON.parse(await readFile(path.join(completed.builds[0].path, nativeFile), 'utf8'));
  assert.deepEqual(output, { lines: lines.map(line => `译文：${line}`), logic: { switch: 3 } });
  await assertPreserved(f, completed);
});

test('strict local-failure mode pauses and explicit available-text continuation overrides this project once', async t => {
  const f = await fixture(t, { strict: true });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  await f.service.startProject({ projectId: created.id });
  const paused = await settle(f.service, created.id, 'paused');
  assert.equal(paused.adaptationPending, true); assert.equal(paused.adaptationDeferred, false); assert.equal(paused.canContinueAvailableText, true);
  assert.equal(paused.builds.length, 0, 'strict technical failure must not automatically publish a final product; a pinned first sample is allowed');
  const beforeContinue = f.calls.translation;
  await f.service.continueAvailableText({ projectId: created.id });
  const completed = await settle(f.service, created.id);
  assert.equal(completed.adaptationAvailable, true); assert.equal(completed.adaptationPending, false);
  assert.equal((await f.service.snapshot()).settings.pauseOnLocalFailure, true, 'One project choice preserves the shared strict setting');
  assert.ok(f.calls.translation >= beforeContinue, 'already paid text work remains available after explicit continuation');
  await assertPreserved(f, completed);
});

test('deferred work survives restart without rerunning adaptation and explicit retry preserves accepted text', async t => {
  const f = await fixture(t);
  const created = await f.service.createProject({ gameDir: f.gameDir });
  await f.service.startProject({ projectId: created.id });
  await settle(f.service, created.id);
  const unit = (await f.service.listText({ projectId: created.id })).units[0];
  const accepted = await f.service.saveText({ projectId: created.id, unitId: unit.id, expectedRevision: unit.revision,
    translation: '保留人工校对文字。', notes: '保留人工备注' });
  const adaptationCount = f.calls.adaptations.length;
  await f.reopen();
  const restored = await f.service.getProject({ projectId: created.id });
  assert.equal(restored.adaptationDeferred, true); assert.equal(restored.adaptationAvailable, true);
  await f.service.startProject({ projectId: created.id });
  await settle(f.service, created.id);
  assert.equal(f.calls.adaptations.length, adaptationCount, 'Text continuation skips already deferred technical work');
  f.resolveRemaining();
  await f.service.grantAdaptationBudget({ projectId: created.id, grantId: 'explicit-remaining-resource-fixture', httpAttempts: 0, windows: 1,
    reason: 'Explicit fixture retry after new remaining-resource evidence became available' });
  await f.service.retryAdaptation({ projectId: created.id });
  const completed = await settle(f.service, created.id);
  assert.ok(f.calls.adaptations.length > adaptationCount, 'Explicit supplement resumes the remaining resource tasks');
  assert.equal(completed.adaptationPending, false); assert.equal(completed.adaptationAvailable, false); assert.equal(completed.adaptationDeferred, false);
  const current = (await f.service.listText({ projectId: created.id })).units.find(item => item.id === unit.id);
  assert.equal(current.translation, accepted.translation); assert.equal(current.notes, accepted.notes); assert.equal(current.revision, accepted.revision);
  assert.equal(JSON.parse(await readFile(path.join(completed.builds.at(-1).path, nativeFile), 'utf8')).lines[0], accepted.translation);
  await assertPreserved(f, completed);
});

for (const options of [{ empty: true }, { rejectRoundtrip: true }]) test(`${options.empty ? 'zero extracted text' : 'failed native roundtrip'} keeps continuation and build unavailable`, async t => {
  const f = await fixture(t, options);
  const created = await f.service.createProject({ gameDir: f.gameDir });
  assert.equal(created.status, 'failed'); assert.equal(created.total, 0); assert.equal(created.canContinueAvailableText, false);
  await assert.rejects(f.service.continueAvailableText({ projectId: created.id }), /提取|回写/);
  await assert.rejects(f.service.buildProject({ projectId: created.id }), /提取|回写/);
  assert.equal(f.calls.build, 0); assert.equal(f.calls.assemble, 0); assert.equal(f.calls.translation, 0);
});

test('a failed recheck of previously extracted text keeps available-text continuation paused', async t => {
  const f = await fixture(t, { strict: true });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  f.failRoundtrip();
  await assert.rejects(f.service.continueAvailableText({ projectId: created.id }), /roundtrip failed/);
  const current = await f.service.getProject({ projectId: created.id });
  assert.equal(current.adaptationDeferred, false); assert.equal(current.adaptationPending, true);
  await assert.rejects(f.service.buildProject({ projectId: created.id }), /回写|验证|检查|roundtrip/);
  assert.equal(f.calls.translation, 0); assert.equal(f.calls.build, 0);
});
