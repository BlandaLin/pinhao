import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { sha256 } from '../exchange/index.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function until(read, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(10);
  }
  assert.fail(message);
}
const rows = (count, perScene = count) => Array.from({ length: count }, (_, index) => ({ id: `neutral-${index}`, kind: 'dialogue',
  source: `Neutral line ${index} {{name}}.`, tokens: ['{{name}}'], context: { file: `scene-${Math.floor(index / perScene)}.json`, event: 1, page: 0 } }));
const review = (payload, edits = []) => ({ review: { protocol: 'pinhao-review-1', reviewedIds: payload.units.map(unit => unit.id), edits,
  issues: edits.map(edit => ({ unitId: edit.id, kind: 'correction', resolution: 'fixed', message: 'Neutral complete correction.' })) }, transportRequests: 1 });

async function fixture(t, { units = rows(16), concurrency = 1, provider, seed } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-review-repair-'));
  const gameDir = path.join(root, 'neutral-original'), dataDir = path.join(root, 'data'), releases = [];
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'original.txt'), 'Immutable neutral fixture.');
  const service = await createService({ dataDir, scriptTools: null, provider,
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral native route', selectedCandidateIds: [] }),
    worker: async (command, input) => {
      if (command === 'probe') return { engine: 'MZ' };
      if (command === 'extract') { await mkdir(input.workspaceDir, { recursive: true }); return { units, workspaceDir: input.workspaceDir, sourceFingerprint: sha256(units) }; }
      if (['roundtrip', 'validate'].includes(command)) return { ok: true };
      if (command === 'build') { await mkdir(input.outputDir, { recursive: true }); return { buildDir: input.outputDir }; }
      if (command === 'assemble') {
        await mkdir(input.outputDir, { recursive: true });
        const launchPath = path.join(input.outputDir, 'Game.exe'); await writeFile(launchPath, 'Neutral fixture executable.');
        return { outputDir: input.outputDir, launchPath };
      }
      throw new Error(`Unexpected neutral worker command ${command}`);
    } });
  t.after(async () => {
    releases.forEach(release => release());
    await service.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 30 });
  });
  await service.saveSettings({ ...defaultSettings(), concurrency, proofreading: true,
    connection: { baseUrl: 'http://localhost:1/v1', model: 'neutral-in-memory-review' } });
  const project = await service.createProject({ gameDir });
  // Seed only this disposable project, without treating saveText as an approval operation.
  const db = createStore(dataDir);
  try {
    const stored = db.units(project.id);
    stored.forEach((unit, position) => db.putUnit(project.id, { ...unit, status: 'translated', translation: `初译 ${position} {{name}}`, notes: '',
      ...(seed?.(unit, position) ?? {}) }, position));
    db.patchProject(project.id, { sampleValidation: { nativeStructure: 'passed' } });
  } finally { db.close(); }
  return { service, projectId: project.id,
    start: mode => service.startProject({ projectId: project.id, mode: mode ?? 'proofreading' }),
    detail: () => service.getProject({ projectId: project.id }),
    texts: async () => (await service.listText({ projectId: project.id, limit: 100 })).units,
    tasks: () => { const stored = createStore(dataDir); try { return stored.tasks(project.id); } finally { stored.close(); } },
    cleanup: release => releases.push(release) };
}

async function completed(f) {
  return until(async () => {
    const state = await f.detail();
    if (state.status === 'paused') assert.fail(state.lastError ?? state.stage);
    return state.status === 'completed' && state;
  }, 'The isolated review did not complete');
}

test('service keeps fifteen good review receipts and only buys the single invalid target again', async t => {
  const calls = [];
  const f = await fixture(t, { provider: async ({ role, wire }) => {
    assert.equal(role, 'proofreading');
    const payload = wire.payload;
    calls.push(payload.units.map(unit => unit.id));
    return review(payload, calls.length === 1 ? [{ id: payload.units.at(-1).id, translation: '错误移除保护符' }] : []);
  } });
  const initial = await f.texts(), bad = initial.at(-1).id;
  await f.start(); await completed(f);
  assert.equal(calls[0].length, 16); assert.deepEqual(calls.slice(1), [[bad]]);
  const final = await f.texts();
  assert.ok(final.every(unit => unit.status === 'proofread' && unit.translation.includes('{{name}}')));
  const task = f.tasks().find(task => task.reviewStage === 'scene');
  assert.equal(task.reviewedUnitIds.length, 16); assert.equal(task.candidateRecords.length, 16);
  assert.ok(task.candidateRecords.every(record => record.translation.includes('{{name}}')));
});

test('service does not acknowledge either linked display member until its whole group validates', async t => {
  const units = rows(4);
  for (const unit of units.slice(1, 3)) unit.context.syncGroup = 'linked-neutral-display';
  const calls = [];
  const f = await fixture(t, { units, seed: unit => unit.context?.syncGroup ? { translation: '同一显示 {{name}}' } : {},
    provider: async ({ wire }) => {
      const payload = wire.payload; calls.push(payload.units.map(unit => unit.id));
      return review(payload, calls.length === 1 ? [{ id: payload.units.find(unit => unit.context?.syncGroup).id, translation: '错误移除保护符' }] : []);
    } });
  const initial = await f.texts(), linked = initial.filter(unit => unit.context?.syncGroup).map(unit => unit.id);
  await f.start(); await completed(f);
  assert.deepEqual(calls.slice(1), [linked]);
  const final = await f.texts();
  assert.ok(final.every(unit => unit.status === 'proofread'));
  assert.equal(new Set(final.filter(unit => unit.context?.syncGroup).map(unit => unit.translation)).size, 1);
});

test('reasoning-only review drains a delayed sibling and resumes without rebuying its saved receipts', async t => {
  const entered = deferred(), failure = deferred(), releaseSibling = deferred(), calls = [];
  let firstCalls = 0, recovered = false;
  const f = await fixture(t, { units: rows(32, 16), concurrency: 2, provider: async args => {
    const payload = args.wire.payload, isAlpha = payload.units[0].source.includes('line 0 ');
    const call = { ids: payload.units.map(unit => unit.id), isAlpha, aborted: false };
    calls.push(call); args.signal.addEventListener('abort', () => { call.aborted = true; }, { once: true });
    await args.onTransport?.({ type: 'send' });
    if (!recovered) {
      if (++firstCalls === 2) entered.resolve();
      await entered.promise;
      if (isAlpha) { failure.resolve(); throw Object.assign(new Error('Neutral reasoning without a final review'), { code: 'MODEL_REASONING_ONLY' }); }
      await releaseSibling.promise; args.signal.throwIfAborted();
    }
    return review(payload);
  } });
  f.cleanup(entered.resolve); f.cleanup(releaseSibling.resolve);
  await f.start(); await failure.promise; await delay(40);
  assert.equal(calls.filter(call => !call.isAlpha).length, 1);
  assert.ok(calls.every(call => !call.aborted), 'Local page failure must not cancel an already dispatched sibling');
  assert.equal((await f.detail()).status, 'running', 'Pause waits for the sent sibling to settle');
  releaseSibling.resolve();
  await until(async () => (await f.detail()).status === 'paused', 'The failed review did not drain to a pause');
  const saved = f.tasks().filter(task => task.reviewStage === 'scene' && task.status === 'succeeded');
  assert.equal(saved.reduce((sum, task) => sum + task.reviewedUnitIds.length, 0), 16);
  assert.equal((await f.detail()).proofread, 0, 'Scene receipts remain provisional until final checks');
  recovered = true; await f.start(); await completed(f);
  assert.equal(calls.filter(call => !call.isAlpha).length, 1, 'The saved sibling is never dispatched a second time');
  assert.equal((await f.texts()).filter(unit => unit.status === 'proofread').length, 32);
});

test('explicit user cancel immediately aborts sent review signals without waiting for replies', async t => {
  const entered = deferred(), release = deferred(), calls = [];
  const f = await fixture(t, { units: rows(32, 16), concurrency: 2, provider: async args => {
    const call = { aborted: false }; calls.push(call);
    args.signal.addEventListener('abort', () => { call.aborted = true; }, { once: true });
    await args.onTransport?.({ type: 'send' });
    if (calls.length === 2) entered.resolve();
    await release.promise; args.signal.throwIfAborted();
    return review(args.wire.payload);
  } });
  f.cleanup(entered.resolve); f.cleanup(release.resolve);
  await f.start(); await entered.promise;
  const cancelling = f.service.cancelProject({ projectId: f.projectId });
  await until(() => calls.every(call => call.aborted), 'Cancel did not abort sent signals before waiting for replies', 1000);
  assert.equal((await f.detail()).status, 'paused');
  release.resolve();
  await cancelling;
  assert.equal((await f.texts()).filter(unit => unit.status === 'proofread').length, 0);
});

test('review-issues targets only saved needs-evidence text plus linked closure and retains prior questions', async t => {
  const units = rows(5);
  for (const unit of units.slice(1, 3)) unit.context.syncGroup = 'linked-issue-display';
  const question = 'Neutral saved identity question requires a new source.';
  const calls = [];
  const f = await fixture(t, { units, seed: (_unit, index) => ({ status: 'proofread',
    ...([1, 2].includes(index) ? { translation: '同一显示 {{name}}' } : {}),
    review: { reviewId: `previous-${index}`, reviewedAt: '2026-10-28T00:00:00.000Z', status: index < 2 ? 'needs_evidence' : 'proofread',
      issues: index < 2 ? [{ unitId: _unit.id, kind: 'needs_evidence', resolution: 'open', resolved: false, message: question }] : [] } }),
    provider: async args => {
      calls.push({ ids: args.wire.payload.units.map(unit => unit.id), prompt: args.prompt });
      return review(args.wire.payload);
    } });
  const initial = await f.texts(), expected = initial.slice(0, 3).map(unit => unit.id);
  await f.start('review-issues'); await completed(f);
  assert.deepEqual([...new Set(calls.flatMap(call => call.ids))].sort(), [...expected].sort());
  assert.ok(calls.every(call => call.prompt.includes(question)), 'Previous unresolved questions must accompany the targeted review');
  const final = await f.texts();
  for (const unit of final.slice(3)) assert.deepEqual(unit, initial.find(previous => previous.id === unit.id), 'Unrelated reviewed text remains unchanged');
  assert.ok(final.slice(0, 3).every(unit => unit.review?.status === 'proofread'));
});
