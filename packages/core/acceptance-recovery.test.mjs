import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { reconcileCandidates } from './result-acceptance.mjs';
import { providerFailure, createRequestCooldown, isTransientRequestFailure } from './request-recovery.mjs';
import { outputManifest, verifyOutput } from './output-manifest.mjs';

test('candidate recovery uses linked-field equality and preserves unrelated records', () => {
  const units = ['a', 'b', 'c'].map(id => ({ id, translation: 'source', context: id === 'c' ? {} : { syncGroup: 'linked' } }));
  const candidates = new Map([['a', { translation: '甲' }], ['b', { translation: '乙' }], ['c', { translation: '丙' }]]);
  const result = reconcileCandidates({ units, candidates, validate() {} });
  assert.deepEqual(result.accepted.map(unit => unit.id), ['c']);
  assert.equal(result.errors.length, 1);
  candidates.set('a', { translation: '甲' }); candidates.set('b', { translation: '甲' });
  assert.equal(reconcileCandidates({ units, candidates, validate() {} }).accepted.length, 3);
});

test('linked recovery checks existing group members and isolates incomplete candidates', () => {
  const a = { id: 'a', translation: '原文', context: { syncGroup: 'g' } };
  const b = { id: 'b', translation: '现译', context: { syncGroup: 'g' } };
  assert.equal(reconcileCandidates({ units: [a], allUnits: [a, b], candidates: new Map([['a', { translation: '冲突' }]]), validate() {} }).accepted.length, 0);
  assert.equal(reconcileCandidates({ units: [a, b], candidates: new Map([['a', { translation: '现译' }]]), validate() {} }).accepted.length, 0);
});

test('provider failure retains truncation metadata and parses Retry-After without real waiting', async () => {
  let time = 1000;
  const waits = [];
  const error = Object.assign(new Error('truncated'), { finishReason: 'length', usage: { inputTokens: 12 }, cause: { responseHeaders: { 'Retry-After': '2' } } });
  assert.deepEqual(providerFailure(error, time), { finishReason: 'length', usage: { inputTokens: 12 }, retryAfterMs: 2000 });
  const cooldown = createRequestCooldown({ clock: () => time, sleep: async ms => { waits.push(ms); time += ms; } });
  cooldown.defer('connection', error); await cooldown.wait('connection');
  assert.deepEqual(waits, [2000]);
  assert.equal(providerFailure({ headers: { 'retry-after': new Date(7000).toUTCString() } }, 1000).retryAfterMs, 6000);
});

test('shared cooldown can be interrupted and its future deadline remains valid', async () => {
  const cooldown = createRequestCooldown();
  cooldown.defer('connection', { headers: { 'retry-after': '20' } });
  const controller = new AbortController();
  const pending = cooldown.wait('connection', controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('transient recovery distinguishes real connection failures from authentication, credit and safety errors', () => {
  for (const error of [
    { code: 'UND_ERR_SOCKET' }, { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } },
    { name: 'TimeoutError', message: 'The operation was aborted due to timeout' },
    { statusCode: 408 }, { statusCode: 429 }, { cause: { statusCode: 503 } },
    { code: 'PROVIDER_CAPACITY', statusCode: 402 }, { message: 'Cannot connect to API: other side closed' },
  ]) assert.equal(isTransientRequestFailure(error), true, JSON.stringify(error));
  for (const error of [
    { statusCode: 401, message: 'network authentication failed' }, { statusCode: 403 }, { statusCode: 402 },
    { code: 'EACCES', message: 'network access denied' }, { code: 'ENOSPC' }, { code: 'ERR_MODULE_NOT_FOUND' },
    { code: 'MODEL_OUTPUT_TRUNCATED' }, { code: 'MODEL_REASONING_ONLY' }, { code: 'READ_NO_PROGRESS' },
    { code: 'INVALID_REVIEW' }, { code: 'INVALID_RESPONSE', message: 'network is a term in this malformed reply' },
    { message: 'API key is missing' }, { message: 'model was not found' },
  ]) assert.equal(isTransientRequestFailure(error), false, JSON.stringify(error));
});

test('output proof detects changed managed resources and ignores player saves and logs', async t => {
  const base = path.resolve('local/acceptance-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'Game.exe'), 'fixture');
  await writeFile(path.join(root, 'Map001.json'), '中文');
  const proof = await outputManifest(root);
  await mkdir(path.join(root, 'save')); await writeFile(path.join(root, 'save/file1.rmmzsave'), 'player');
  await writeFile(path.join(root, 'game.log'), 'runtime');
  assert.equal((await verifyOutput(root, proof)).valid, true);
  await writeFile(path.join(root, 'Map001.json'), 'English');
  assert.equal((await verifyOutput(root, proof)).valid, false);
});
