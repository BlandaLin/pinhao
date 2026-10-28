import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { sha256 } from '../exchange/index.mjs';

const rows = count => Array.from({ length: count }, (_, index) => ({ id: `neutral-${index}`, kind: 'dialogue',
  source: `Alice waits for neutral event ${index}.`, tokens: [], context: { file: 'neutral-scene.json', event: 1, page: 0 } }));
const records = payload => payload.units.map(unit => ({ id: unit.id, translation: `爱丽丝的中性译文 ${unit.source}`, notes: '' }));
async function until(read, message) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(10); }
  assert.fail(message);
}
async function fixture(t, { units = rows(8), provider, seed, connection = { contextWindow: 32768, maxOutputTokens: 4096 } } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-text-capacity-flow-'));
  const gameDir = path.join(root, 'neutral-original'), dataDir = path.join(root, 'data');
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'neutral.txt'), 'Immutable neutral fixture.');
  const service = await createService({ dataDir, scriptTools: null, provider,
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral native fixture', selectedCandidateIds: [] }),
    worker: async (command, input) => {
      if (command === 'probe') return { engine: 'MZ' };
      if (command === 'extract') { await mkdir(input.workspaceDir, { recursive: true }); return { units, workspaceDir: input.workspaceDir, sourceFingerprint: sha256(units) }; }
      if (['roundtrip', 'validate'].includes(command)) return { ok: true };
      if (command === 'build') { await mkdir(input.outputDir, { recursive: true }); return { buildDir: input.outputDir }; }
      if (command === 'assemble') {
        await mkdir(input.outputDir, { recursive: true }); const launchPath = path.join(input.outputDir, 'Game.exe');
        await writeFile(launchPath, 'Neutral fixture executable.'); return { outputDir: input.outputDir, launchPath };
      }
      throw new Error(`Unexpected neutral worker command ${command}`);
    } });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 30 }); });
  await service.saveSettings({ ...defaultSettings(), concurrency: 1, proofreading: false,
    connection: { baseUrl: 'http://localhost:1/v1', model: 'neutral-selected-model', ...connection } });
  const project = await service.createProject({ gameDir });
  const store = createStore(dataDir);
  try {
    if (seed) store.units(project.id).forEach((unit, index) => store.putUnit(project.id, { ...unit, ...seed(unit, index) }, index));
    store.patchProject(project.id, { sampleValidation: { nativeStructure: 'passed' } });
  } finally { store.close(); }
  return { service, projectId: project.id, start: () => service.startProject({ projectId: project.id, mode: 'translation' }),
    detail: () => service.getProject({ projectId: project.id }), texts: async () => (await service.listText({ projectId: project.id, limit: 200 })).units,
    tasks: () => { const db = createStore(dataDir); try { return db.tasks(project.id); } finally { db.close(); } } };
}
async function complete(f) {
  return until(async () => { const detail = await f.detail();
    if (detail.status === 'paused') assert.fail(detail.lastError ?? detail.stage);
    return detail.status === 'completed' && detail;
  }, 'The isolated text capacity run did not complete');
}

test('saved model capacity reaches service text planning for mixed complete long and short units', async t => {
  const units = rows(45);
  for (const index of [20, 22, 24, 26]) units[index].source = `Complete long neutral ${index}. `.repeat(50);
  const calls = [];
  const f = await fixture(t, { units, connection: { contextWindow: 32768, maxOutputTokens: 1800 }, provider: async args => {
    calls.push({ units: args.wire.payload.units, capacity: args.connection, budget: args.budget });
    return { records: records(args.wire.payload), transportRequests: 1 };
  } });
  await f.start(); await complete(f);
  assert.ok(calls.length > 2); assert.ok(calls.every(call => call.capacity.maxOutputTokens === 1800 && call.capacity.contextWindow === 32768));
  const shortSizes = calls.filter(call => call.units.every(unit => !unit.source.startsWith('Complete long'))).map(call => call.units.length);
  const longSizes = calls.filter(call => call.units.some(unit => unit.source.startsWith('Complete long'))).map(call => call.units.length);
  assert.ok(Math.max(...shortSizes) > Math.max(...longSizes), JSON.stringify(calls.map(call => call.units.length)));
  assert.equal(new Set(calls.flatMap(call => call.units.map(unit => unit.id))).size, units.length);
  assert.ok(calls.every(call => !call.budget.overLimit));
  assert.ok((await f.texts()).every(unit => unit.status === 'translated'));
});

test('an oversized complete synchronized display group pauses explicitly before provider dispatch', async t => {
  const units = rows(2); units.forEach(unit => { unit.source = 'Complete unbroken neutral paragraph. '.repeat(1500); unit.context.syncGroup = 'complete-display'; });
  let requests = 0;
  const f = await fixture(t, { units, provider: async args => { requests++; return { records: records(args.wire.payload) }; } });
  await f.start();
  const stopped = await until(async () => { const detail = await f.detail(); return detail.status === 'paused' && detail; }, 'The large group did not pause');
  assert.equal(requests, 0); assert.match(stopped.lastError ?? stopped.stage, /完整|容量/);
  assert.ok(stopped.issues.some(issue => issue.kind === 'text-capacity' || issue.category === 'text-capacity'));
  assert.ok((await f.texts()).every(unit => unit.status === 'pending' && unit.source.length > 10000));
});

test('truncated translation keeps completed records and shrinks only remaining independent groups without changing model', async t => {
  const calls = [], kept = [];
  const f = await fixture(t, { provider: async args => {
    const payload = args.wire.payload; calls.push({ ids: payload.units.map(unit => unit.id), model: args.connection.model });
    if (calls.length === 1) {
      const complete = records(payload).slice(0, 2); kept.push(...complete.map(record => record.id));
      await args.onRecords(complete);
      throw Object.assign(new Error('Deterministic incomplete response.'), { code: 'MODEL_OUTPUT_TRUNCATED', transportRequests: 1 });
    }
    return { records: records(payload), transportRequests: 1 };
  } });
  await f.start(); await complete(f);
  assert.equal(calls[0].ids.length, 8); assert.ok(calls[1].ids.length <= 3);
  assert.ok(calls.slice(1).every(call => call.ids.every(id => !kept.includes(id))));
  assert.ok(calls.every(call => call.model === 'neutral-selected-model'));
  assert.equal(new Set(calls.slice(1).flatMap(call => call.ids)).size, 6);
  assert.ok((await f.texts()).every(unit => unit.status === 'translated'));
});

test('later text requests receive earlier accepted terminology as advisory context before final terminology collection', async t => {
  const calls = [];
  const f = await fixture(t, { units: rows(70), provider: async args => {
    const payload = args.wire.payload; calls.push({ candidates: payload.terminologyCandidates, prompt: args.prompt });
    return { records: records(payload).map(record => ({ ...record, termChoices: [{ source: 'Alice', translation: '爱丽丝' }] })), transportRequests: 1 };
  } });
  await f.start(); await complete(f);
  assert.ok(calls.length > 1); assert.equal(calls[0].candidates, undefined);
  const later = calls.slice(1).find(call => call.candidates?.some(candidate => candidate.source === 'Alice'));
  assert.ok(later); assert.match(later.prompt, /只读.*非确认规则/);
  assert.ok(later.candidates.some(candidate => candidate.variants.some(variant => variant.translation === '爱丽丝' && variant.evidenceIds.length)));
});

test('service preserves a billed evidence response but never dispatches its oversized required-evidence continuation', async t => {
  const units = rows(2), usage = { inputTokens: 12, outputTokens: 2, totalTokens: 14 };
  const rawUsage = { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14, cost: 0.0004 };
  units[1].source = 'Required neutral evidence. '.repeat(7000);
  let evidenceId, dispatches = 0;
  const f = await fixture(t, { units, seed: (_unit, index) => index === 1 ? { status: 'proofread', translation: '既有中性参考，保留完整原文证据。' } : {},
    provider: async () => {
      dispatches++;
      assert.equal(dispatches, 1, 'The over-capacity evidence continuation must never reach the provider');
      return { evidenceRequests: [{ query: { ids: [evidenceId], limit: 1 }, reason: 'Read complete neutral evidence before translation' }],
        usage, rawUsage, transportRequests: 1, requestId: 'neutral-billed-evidence' };
    } });
  evidenceId = (await f.texts())[1].id;
  await f.start();
  const stopped = await until(async () => { const detail = await f.detail(); return detail.status === 'paused' && detail; }, 'The oversized evidence continuation did not pause');
  assert.equal(dispatches, 1); assert.match(stopped.lastError, /容量/);
  const task = f.tasks().find(task => task.role === 'translation');
  assert.equal(task.status, 'paused'); assert.equal(task.requestCount, 2); assert.equal(task.requestHistory.length, 2);
  const [billed, blocked] = task.requestHistory;
  assert.equal(billed.status, 'received'); assert.deepEqual(billed.usage, usage); assert.deepEqual(billed.rawUsage, rawUsage);
  assert.equal(blocked.code, 'TEXT_REQUEST_CAPACITY_EXCEEDED');
  assert.equal(blocked.transportRequests, 0); assert.equal(blocked.fetchStarted, false);
  const paid = JSON.parse(await readFile(path.join(billed.artifact.directory, 'result.json'), 'utf8'));
  const failed = JSON.parse(await readFile(path.join(blocked.artifact.directory, 'result.json'), 'utf8'));
  const captured = JSON.parse(await readFile(path.join(blocked.artifact.directory, 'request.json'), 'utf8'));
  assert.equal(paid.summary.usage.cost, 0.0004); assert.equal(paid.summary.transportRequests, 1);
  assert.equal(failed.summary.fetchStarted, false); assert.equal(failed.summary.transportRequests, 0);
  assert.ok(captured.prompt.includes(units[1].source), 'The complete required evidence remains in the failed request artifact');
  assert.ok(task.evidenceReferences.some(unit => unit.id === evidenceId && unit.source === units[1].source));
  assert.equal((await f.texts())[0].status, 'pending');
});
