import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { isModelEndpoint, readCredential, readEvaluationDatabase } from './run-service.mjs';
import { compareTechnicalRuns } from './compare.mjs';
import { EVALUATION_SCHEMA } from './events.mjs';

test('configured provider origin and exact API path are observed, not one vendor hostname', () => {
  assert.equal(isModelEndpoint('https://provider.invalid/v1/chat/completions', { method: 'POST' }, 'https://provider.invalid/v1/'), true);
  assert.equal(isModelEndpoint('https://provider.invalid/v1/responses', { method: 'POST' }, 'https://provider.invalid/v1'), true);
  assert.equal(isModelEndpoint('https://other.invalid/v1/chat/completions', { method: 'POST' }, 'https://provider.invalid/v1'), false);
  assert.equal(isModelEndpoint('https://provider.invalid/other/chat/completions', { method: 'POST' }, 'https://provider.invalid/v1'), false);
  assert.equal(isModelEndpoint('https://provider.invalid/v1/models', { method: 'GET' }, 'https://provider.invalid/v1'), false);
});

test('missing or malformed private stdin credential fails instead of substituting fake success', async () => {
  for (const text of ['', '{}\n', 'bad json\n', '{"apiKey":" "}\n']) await assert.rejects(readCredential(Readable.from([text])));
  assert.equal(await readCredential(Readable.from(['{"apiKey":"neutral-placeholder"}\n'])), 'neutral-placeholder');
});

test('evaluation snapshot joins actual cold coverage and retains legacy hot-only databases', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-eval-cold-'));
  t.after(async () => { assert.equal(path.dirname(directory), os.tmpdir()); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); });
  for (const cold of [false, true]) {
    const file = path.join(directory, `${cold ? 'cold' : 'legacy'}.sqlite`), database = new DatabaseSync(file);
    database.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,body TEXT); CREATE TABLE units(project_id TEXT,position INTEGER,body TEXT); CREATE TABLE tasks(project_id TEXT,body TEXT); CREATE TABLE builds(project_id TEXT,body TEXT)');
    const project = { id: 'project', status: 'paused', adaptationRequest: { id: 'request' }, coverage: { sourceContextHash: 'legacy', summary: { unresolvedCandidates: 9 } } };
    database.prepare('INSERT INTO projects VALUES(?,?)').run(project.id, JSON.stringify(project));
    if (cold) {
      database.exec('CREATE TABLE project_resources(id TEXT PRIMARY KEY,body TEXT)');
      database.prepare('INSERT INTO project_resources VALUES(?,?)').run(project.id, JSON.stringify({
        inventory: { unitCount: 1 }, coverage: { sourceContextHash: 'current', stale: true, summary: { unresolvedCandidates: 2 } },
      }));
      database.exec('CREATE TABLE acceptance_receipts(id TEXT PRIMARY KEY,project_id TEXT,body TEXT)');
      database.prepare('INSERT INTO acceptance_receipts VALUES(?,?,?)').run('receipt', project.id, JSON.stringify({ id: 'receipt', status: 'pending' }));
    }
    database.prepare('INSERT INTO units VALUES(?,?,?)').run(project.id, 0, JSON.stringify({ id: 'unit', source: 'Neutral text' }));
    database.close();
    const before = await readFile(file), result = readEvaluationDatabase(file, project.id);
    assert.equal(result.project.coverage.sourceContextHash, cold ? 'current' : 'legacy');
    assert.equal(result.project.coverage.summary.unresolvedCandidates, cold ? 2 : 9);
    assert.equal(result.project.adaptationRequest.id, 'request');
    assert.equal(result.units.length, 1); assert.deepEqual(result.tasks, []); assert.deepEqual(result.builds, []);
    assert.deepEqual(result.acceptanceReceipts, cold ? [{ id: 'receipt', status: 'pending' }] : null);
    assert.deepEqual(await readFile(file), before, 'read-only evaluation never rewrites either source table');
  }
});

test('comparison keeps negative outcomes and labels earlier stop as no delivery gain', () => {
  const config = { baseUrl: 'https://provider.invalid/v1', model: 'model', reasoning: 'auto', concurrency: 3, mode: 'adaptation', limits: { maxHttp: 4, maxMinutes: 1 } };
  const base = { schema: EVALUATION_SCHEMA, pairId: 'pair', caseId: 'case', evidenceTier: 'autonomy', answerIsolation: 'unisolated-development', configuration: config,
    route: { service: 'createService', worker: 'productWorker', defaultDisplayVerifier: true, injectedComponents: [], preseededRecipes: false, focused: false },
    freeze: { sourceBefore: { 'source/package-lock.json': 'same', 'source/code': 'old' }, sourceAfter: { 'source/package-lock.json': 'same', 'source/code': 'old' }, originalBefore: { game: 'same' }, originalAfter: { game: 'same' } },
    artifacts: {}, attempts: [{ id: 'one', fetchStartedAt: 'now', settledAt: 'later', usage: { cost: 0.1 } }] };
  const before = { ...base, episodeDir: 'before' }, after = structuredClone({ ...base, episodeDir: 'after', attempts: [] });
  after.freeze.sourceBefore['source/code'] = 'new'; after.freeze.sourceAfter['source/code'] = 'new';
  const result = compareTechnicalRuns(before, after);
  assert.equal(result.comparable, true);
  assert.equal(result.before.autonomyStatus, 'not-achieved'); assert.equal(result.after.autonomyStatus, 'not-achieved');
  assert.equal(result.conclusion, 'lower-spend-or-earlier-stop-without-proven-delivery-gain');
  after.configuration.model = 'another-model';
  assert.equal(compareTechnicalRuns(before, after).comparable, false);
});
