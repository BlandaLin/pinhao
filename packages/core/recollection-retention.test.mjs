import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRecollectionManager } from './recollection.mjs';
import { applySelection } from '../technical/recollection.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-recollection-retention-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const project = { id: 'p', engine: 'MV', workspaceDir: root, builds: [{ id: 'b', path: root }] };
  let calls = 0, connections = 0, fail = false, analyze;
  const observation = { schemaVersion: 1, analysisRulesVersion: 'fixture-rules-1', fingerprint: 'same-resource', engine: 'MV', maps: [], issues: [],
    candidates: [{ id: 'c', confidence: 'review', selectable: true, operation: { type: 'switch', id: 3, value: true }, evidence: [] }],
    recipes: [{ id: 'r', confidence: 'review', candidateIds: ['c'], blocked: false, evidence: [] }] };
  const tools = { scanRecollection: async () => structuredClone(observation), applySelection,
    analyzeRecollection: async ({ scan, signal }) => {
      calls++;
      if (fail) throw new Error('analysis failed');
      if (analyze) return analyze({ scan, signal });
      return { fingerprint: scan.fingerprint, analysisRulesVersion: scan.analysisRulesVersion, selectedCandidateIds: ['c'], summary: 'neutral fixture' };
    } };
  const manager = createRecollectionManager({ projectFor: () => project, worker: () => {}, connectionFor: () => { connections++; return {}; }, onChanged: () => {}, tools });
  return { root, observation, manager, calls: () => calls, connections: () => connections, fail: () => { fail = true; }, analyze: handler => { analyze = handler; }, record: async () => JSON.parse(await readFile(path.join(root, 'assist/scan.json'), 'utf8')) };
}

test('no selectable pending candidates means no model call, including already confirmed scans', async t => {
  for (const mode of ['empty', 'blocked', 'confirmed']) {
    const f = await fixture(t);
    if (mode === 'empty') { f.observation.candidates = []; f.observation.recipes = []; }
    if (mode === 'blocked') f.observation.candidates[0].selectable = false;
    if (mode === 'confirmed') f.observation.candidates[0].confidence = 'confirmed';
    const scan = await f.manager.scan({ projectId: 'p', analyze: true });
    assert.equal(f.calls(), 0);
    assert.equal(f.connections(), 0);
    assert.match(scan.analysisNotice, /分析.*条件|条件.*分析/);
  }
});

test('compatible successful confirmation survives rescan and a failed new analysis', async t => {
  const f = await fixture(t);
  await f.manager.scan({ projectId: 'p', analyze: true });
  assert.equal((await f.manager.scan({ projectId: 'p' })).recipes[0].confidence, 'confirmed');
  f.observation.candidates.push({ id: 'd', confidence: 'review', selectable: true, operation: { type: 'switch', id: 4, value: true }, evidence: [] });
  f.observation.recipes.push({ id: 's', confidence: 'review', candidateIds: ['d'], blocked: false, evidence: [] });
  // The new catalogue is intentionally incompatible; the successful record remains history.
  f.fail();
  await assert.rejects(f.manager.scan({ projectId: 'p', analyze: true }), /analysis failed/);
  assert.equal((await f.record()).confirmation.scan.recipes[0].confidence, 'confirmed');
  assert.equal((await f.record()).scan.recipes[0].confidence, 'review');
});

test('failed reanalysis preserves a compatible confirmation with other pending candidates', async t => {
  const f = await fixture(t);
  f.observation.candidates.push({ id: 'd', confidence: 'review', selectable: true, operation: { type: 'switch', id: 4, value: true }, evidence: [] });
  f.observation.recipes.push({ id: 's', confidence: 'review', candidateIds: ['d'], blocked: false, evidence: [] });
  await f.manager.scan({ projectId: 'p', analyze: true });
  f.fail();
  await assert.rejects(f.manager.scan({ projectId: 'p', analyze: true }), /analysis failed/);
  const record = await f.record();
  assert.equal(record.scan.recipes[0].confidence, 'confirmed');
  assert.equal(record.scan.recipes[1].confidence, 'review');
  assert.equal(record.confirmation.scan.recipes[0].confidence, 'confirmed');
});

test('rule and selection constraint changes invalidate old confirmations without deleting history', async t => {
  for (const change of [scan => { scan.analysisRulesVersion = 'fixture-rules-2'; }, scan => { scan.candidates[0].selectable = false; }]) {
    const f = await fixture(t);
    await f.manager.scan({ projectId: 'p', analyze: true });
    change(f.observation);
    await assert.rejects(f.manager.selection({ projectId: 'p', recipeIds: ['r'], buildId: 'b' }), /规则|条件/);
    const fresh = await f.manager.scan({ projectId: 'p' });
    assert.equal(fresh.recipes[0].confidence, 'review');
    assert.equal((await f.record()).confirmation.scan.recipes[0].confidence, 'confirmed');
  }
});

test('legacy resource-only confirmations cannot be applied under new rules', async t => {
  const f = await fixture(t);
  const legacy = structuredClone(f.observation);
  delete legacy.analysisRulesVersion;
  legacy.candidates[0].confidence = legacy.recipes[0].confidence = 'confirmed';
  await mkdir(path.join(f.root, 'assist'));
  await writeFile(path.join(f.root, 'assist/scan.json'), JSON.stringify({ rootDir: f.root, buildId: 'b', scan: legacy }));
  await assert.rejects(f.manager.selection({ projectId: 'p', recipeIds: ['r'], buildId: 'b' }), /规则|条件/);
});

test('cancelling new analysis keeps the prior compatible confirmation', async t => {
  const f = await fixture(t);
  f.observation.candidates.push({ id: 'd', confidence: 'review', selectable: true, operation: { type: 'switch', id: 4, value: true }, evidence: [] });
  f.observation.recipes.push({ id: 's', confidence: 'review', candidateIds: ['d'], blocked: false, evidence: [] });
  await f.manager.scan({ projectId: 'p', analyze: true });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.analyze(({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    entered();
  }));
  const pending = f.manager.scan({ projectId: 'p', analyze: true });
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  await ready;
  f.manager.cancel('p');
  await rejected;
  assert.equal((await f.manager.get({ projectId: 'p' })).scan.recipes[0].confidence, 'confirmed');
  assert.equal((await f.record()).confirmation.scan.analysis.summary, 'neutral fixture');
});

test('successive confirmations accumulate and survive manager reload', async t => {
  const f = await fixture(t);
  f.observation.candidates.push({ id: 'd', confidence: 'review', selectable: true, operation: { type: 'switch', id: 4, value: true }, evidence: [] });
  f.observation.recipes.push({ id: 's', confidence: 'review', candidateIds: ['d'], blocked: false, evidence: [] });
  await f.manager.scan({ projectId: 'p', analyze: true });
  f.analyze(({ scan }) => ({ fingerprint: scan.fingerprint, analysisRulesVersion: scan.analysisRulesVersion, selectedCandidateIds: ['d'], summary: 'second fixture' }));
  await f.manager.scan({ projectId: 'p', analyze: true });
  await f.manager.scan({ projectId: 'p' });
  const record = await f.record();
  assert.ok(record.scan.recipes.every(recipe => recipe.confidence === 'confirmed'));
  assert.deepEqual(record.confirmation.scan.analysis.selectedCandidateIds, ['c', 'd']);
  const reloaded = createRecollectionManager({ projectFor: () => ({ workspaceDir: f.root }), onChanged: () => {} });
  assert.deepEqual((await reloaded.get({ projectId: 'p' })).scan, record.scan);
});
