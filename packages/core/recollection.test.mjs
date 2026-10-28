import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRecollectionManager } from './recollection.mjs';

async function fixture(t, { diagnostics = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-recollection-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const project = { id: 'p', engine: 'MV', workspaceDir: root, gameDir: path.join(root, 'original'), builds: [{ id: 'b', path: path.join(root, 'build') }] };
  await mkdir(project.gameDir); await mkdir(project.builds[0].path);
  let fingerprint = 'version-one', calls = 0, analyzed = 0, analysisFails = false;
  const operation = { type: 'switch', id: 4, value: true };
  const scan = () => ({ schemaVersion: 1, analysisRulesVersion: 'fixture-rules-1', fingerprint, engine: 'MV', scannedAt: 'now', maps: [{ id: 2, name: 'Gallery', width: 10, height: 8 }], candidates: [{ id: 'c', confidence: 'confirmed', operation }, { id: 'pending', confidence: 'review', operation: { type: 'switch', id: 9, value: true } }], recipes: [{ id: 'r', label: 'Gallery', confidence: 'confirmed', candidateIds: ['c'] }, { id: 'review', label: 'Uncertain', confidence: 'review', candidateIds: ['pending'] }], issues: [] });
  const manager = createRecollectionManager({ diagnostics, projectFor: id => { assert.equal(id, 'p'); return project; }, worker: () => {}, onChanged: () => {}, connectionFor: async () => { calls++; return { model: 'local-fixture' }; }, tools: {
    scanRecollection: async ({ gameDir, signal }) => { signal?.throwIfAborted(); assert.equal(gameDir, project.builds.at(-1).path); return scan(); },
    analyzeRecollection: async ({ scan: input, connection, diagnostics: enabled }) => { analyzed++; assert.equal(connection.model, 'local-fixture'); assert.equal(enabled, diagnostics); if (analysisFails) throw new Error('model unavailable'); return { fingerprint: input.fingerprint, selectedCandidateIds: ['c'] }; },
    applySelection: (input, analysis) => ({ ...input, analysis }),
  } });
  return { manager, project, operation, root, changeVersion: () => { fingerprint = 'version-two'; }, failAnalysis: () => { analysisFails = true; }, calls: () => ({ calls, analyzed }) };
}

test('recollection scan is local by default; explicit analysis uses the technical connection', async t => {
  const f = await fixture(t);
  assert.equal((await f.manager.get({ projectId: 'p' })).scan, null);
  await f.manager.scan({ projectId: 'p' });
  assert.deepEqual(f.calls(), { calls: 0, analyzed: 0 });
  assert.equal((await f.manager.get({ projectId: 'p' })).scan.fingerprint, 'version-one');
  const analyzed = await f.manager.scan({ projectId: 'p', analyze: true });
  assert.deepEqual(analyzed.analysis.selectedCandidateIds, ['c']);
  assert.deepEqual(f.calls(), { calls: 1, analyzed: 1 });
});

test('recollection manager forwards explicitly enabled diagnostics without changing local scan behavior', async t => {
  const f = await fixture(t, { diagnostics: true });
  await f.manager.scan({ projectId: 'p' });
  assert.deepEqual(f.calls(), { calls: 0, analyzed: 0 });
  await f.manager.scan({ projectId: 'p', analyze: true });
  assert.deepEqual(f.calls(), { calls: 1, analyzed: 1 });
});

test('recollection selection rejects unknown, uncertain, duplicate, changed-version and wrong-build recipes', async t => {
  const f = await fixture(t);
  await f.manager.scan({ projectId: 'p' });
  for (const recipeIds of [['unknown'], ['review'], ['r', 'r'], []]) await assert.rejects(f.manager.selection({ projectId: 'p', recipeIds, buildId: 'b' }));
  await assert.rejects(f.manager.selection({ projectId: 'p', recipeIds: ['r'], buildId: 'old' }), /最新成品/);
  const selected = await f.manager.selection({ projectId: 'p', recipeIds: ['r'], buildId: 'b' });
  assert.deepEqual(selected.operations, [f.operation]);
  f.changeVersion();
  await assert.rejects(f.manager.selection({ projectId: 'p', recipeIds: ['r'], buildId: 'b' }), /资源已变化/);
});

test('a failed technical analysis retains the completed local scan', async t => {
  const f = await fixture(t);
  await f.manager.scan({ projectId: 'p' });
  f.changeVersion();
  f.failAnalysis();
  await assert.rejects(f.manager.scan({ projectId: 'p', analyze: true }), /model unavailable/);
  const { scan } = await f.manager.get({ projectId: 'p' });
  assert.equal(scan.fingerprint, 'version-two');
  assert.equal(scan.analysis, undefined);
  assert.equal((await f.manager.selection({ projectId: 'p', recipeIds: ['r'], buildId: 'b' })).fingerprint, 'version-two');
});

test('Ruby hash key order does not change captured operation identity', async t => {
  const f = await fixture(t);
  await f.manager.scan({ projectId: 'p' });
  const selection = await f.manager.selection({ projectId: 'p', recipeIds: ['r'], buildId: 'b' });
  const capture = { recipeId: selection.recipeId, gameSessionId: 'ruby-game', entries: [{ operation: { value: true, id: 4, type: 'switch' }, original: false, applied: true }] };
  const backup = await f.manager.capture({ projectId: 'p', selection, capture });
  assert.equal(backup.capture.gameSessionId, 'ruby-game');
  await assert.rejects(f.manager.capture({ projectId: 'p', selection, capture: { ...capture, entries: [{ ...capture.entries[0], operation: { value: true, id: 5, type: 'switch' } }] } }), /不一致/);
});

test('recollection backups retain exact original values and survive manager reload', async t => {
  const f = await fixture(t);
  await f.manager.scan({ projectId: 'p' });
  const selection = await f.manager.selection({ projectId: 'p', recipeIds: ['r'], buildId: 'b' });
  const capture = { recipeId: selection.recipeId, gameSessionId: 'game-one', entries: [{ operation: f.operation, original: false, applied: true }] };
  await assert.rejects(f.manager.capture({ projectId: 'p', selection, capture: { ...capture, recipeId: 'forged' } }), /不一致/);
  const backup = await f.manager.capture({ projectId: 'p', selection, capture });
  assert.equal(backup.status, 'captured');
  const onDisk = JSON.parse(await readFile(path.join(f.root, 'assist/backups.json'), 'utf8'));
  assert.equal(onDisk[0].capture.entries[0].original, false);
  await f.manager.update({ projectId: 'p', backupId: backup.id, status: 'applied' });
  assert.equal((await f.manager.backup({ projectId: 'p', backupId: backup.id, verify: true })).status, 'applied');
  f.changeVersion();
  await assert.rejects(f.manager.backup({ projectId: 'p', backupId: backup.id, verify: true }), /版本已变化/);
});
