import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { sha256 } from '../exchange/index.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(10); }
  throw new Error(message);
}
async function waitGate(gate, signal) {
  let cancel;
  try {
    await Promise.race([gate.promise, new Promise((_, reject) => {
      cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    })]);
  } finally { signal.removeEventListener('abort', cancel); }
}

for (const stop of ['pause', 'close']) test(`actual service fills released text slots and returns technical admissions on ${stop}`, { timeout: 35000 }, async t => {
  const base = path.resolve('local/service-pool-admission-tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'admission-')), dataDir = path.join(directory, 'profile');
  const textGate = Promise.withResolvers(), technicalGate = Promise.withResolvers(), lateGate = Promise.withResolvers(), textReady = Promise.withResolvers(), firstTechnical = Promise.withResolvers();
  const technicalFiles = Array.from({ length: 7 }, (_, index) => `data/extra-${index}.json`);
  const clear = { format: 1, completeness: 'complete', summary: {}, resources: [], reviewItems: [], dynamicCandidates: [], imageCandidates: [], triggers: [], needsAdaptation: false };
  const technicalCoverage = { ...clear, completeness: 'structural', resources: technicalFiles.map(file => ({ file, kind: 'display-text-candidate' })), triggers: ['suspected-omission'], needsAdaptation: true };
  const store = createStore(dataDir);
  for (const id of ['text', 'technical', 'late-text']) {
    const gameDir = path.join(directory, id, 'game'), workspaceDir = path.join(directory, id, 'project');
    await mkdir(path.join(gameDir, 'data'), { recursive: true }); await mkdir(workspaceDir, { recursive: true });
    for (const file of id === 'technical' ? technicalFiles : ['data/native.json']) await writeFile(path.join(gameDir, file), JSON.stringify({ text: `Neutral ${file}` }));
    const units = Array.from({ length: id === 'text' ? 64 : 1 }, (_, index) => ({ id: `${id}:${index}`, legacyId: `${id}:${index}`, source: `Neutral line ${index}.`,
      sourceHash: sha256(`Neutral line ${index}.`), kind: 'message', tokens: [], notes: '', revision: 0, status: 'pending',
      context: { file: 'data/native.json', event: Math.floor(index / 16) + 1, page: 0 } }));
    store.put('projects', { id, name: id, gameDir, workspaceDir, workbenchDir: workspaceDir, engine: 'MV', prepared: true,
      status: 'ready', stage: 'Ready', targetLanguage: 'zh-Hans', inventory: {}, technicalPlan: { decision: 'native' },
      sourceFingerprint: sha256(units), coverage: id === 'technical' ? technicalCoverage : clear,
      sampleValidation: { nativeStructure: 'passed' }, ...(id === 'technical' ? { adaptationRequest: { id: 'neutral-resource-run' } } : {}),
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    store.transaction(id, () => { units.forEach((unit, index) => { store.putUnit(id, unit, index); store.addRevision(id, unit); }); });
  }
  store.close();
  let textRequests = 0, lateRequests = 0; const started = [];
  const service = await createService({ dataDir, secrets: { encrypt: value => `neutral:${value}`, decrypt: value => value.slice(8) }, scriptTools: null, imageTools: null,
    coverageScanner: async ({ rootDir }) => rootDir.includes(`${path.sep}technical${path.sep}`) ? technicalCoverage : clear,
    provider: async ({ wire, signal }) => {
      if (wire.payload.units[0].id.startsWith('late-text:')) { lateRequests++; await waitGate(lateGate, signal); }
      else { textRequests++; if (textRequests === 4) textReady.resolve(); await waitGate(textGate, signal); }
      return { records: wire.payload.units.map(unit => ({ id: unit.id, translation: `中性译文${unit.id}`, notes: '' })) };
    },
    adaptationProvider: async ({ assignment, signal }) => {
      started.push(assignment.files[0]); firstTechnical.resolve();
      await waitGate(technicalGate, signal);
      signal.throwIfAborted();
      return { status: 'needs-review', retryable: false, continuationNeeded: false, reason: 'Controlled admission fixture finished' };
    },
    technicalProvider: async () => ({ decision: 'native', selectedCandidateIds: [] }),
    worker: async (command, args) => {
      if (command === 'catalog') return { engines: [] };
      if (command === 'build' || command === 'assemble') { await mkdir(args.outputDir, { recursive: true }); await writeFile(path.join(args.outputDir, 'neutral.txt'), 'Neutral output'); return command === 'build' ? { buildDir: args.outputDir } : { outputDir: args.outputDir, runtimeVerified: false }; }
      if (command === 'validate' || command === 'roundtrip') return { valid: true, passed: true };
      throw new Error(`Unexpected isolated worker command ${command}`);
    },
  });
  t.after(async () => { textGate.resolve(); lateGate.resolve(); technicalGate.resolve(); await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); });
  const settings = defaultSettings(); settings.concurrency = 5; settings.proofreading = false;
  settings.connection.contextWindow = 32768; settings.connection.maxOutputTokens = 1248;
  settings.connection.model = 'neutral-admission'; await service.saveSettings(settings);
  await service.grantAdaptationBudget({ projectId: 'technical', grantId: 'explicit-admission-fixture', httpAttempts: 20, windows: 1,
    reason: 'Explicit isolated allowance for the manually seeded existing technical request' });
  await service.startProject({ projectId: 'text' });
  await until(() => textRequests === 4, `Expected four occupied text slots, got ${textRequests}`);
  await textReady.promise;
  await service.startProject({ projectId: 'technical' });
  await until(() => started.length === 1, 'Technical parent did not start in the remaining slot'); await firstTechnical.promise;
  assert.equal((await service.getProject({ projectId: 'technical' })).runtime.active, 5);
  if (stop === 'close') {
    await service.close();
    assert.equal(started.length, 1, 'closing with four occupied text slots never dispatches waiting technical children');
    const inspection = createStore(dataDir);
    try { assert.equal(inspection.one('projects', 'technical').status, 'paused'); } finally { inspection.close(); }
    return;
  }
  await service.startProject({ projectId: 'late-text' });
  textGate.resolve();
  await until(() => lateRequests === 1 && started.length >= 4, 'Ordinary queued text did not obtain a released slot alongside technical work');
  assert.equal(started.length, 4, 'the still-running ordinary text request keeps one of the five host slots');
  assert.equal((await service.getProject({ projectId: 'technical' })).runtime.active, 5);
  lateGate.resolve();
  await until(() => started.length >= 5, `Released text slots did not fill independent resources; started=${started.length}`);
  const running = await service.getProject({ projectId: 'technical' });
  assert.equal(started.length, 5); assert.equal(running.runtime.active, 5); assert.equal(running.runtime.limit, 5);
  await service.pauseProject({ projectId: 'technical' });
  await until(async () => (await service.getProject({ projectId: 'technical' })).runtime.active === 0, 'Paused technical children did not return their slots');
  assert.equal(started.length, 5, 'queued resources never start after the pause');
});
