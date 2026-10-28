import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createTechnicalTransport } from '../technical/model-transport.mjs';

// Contract verification only: the service and transport run, but the model response is local.
// These tests make zero external API calls and do not establish autonomous Agent delivery.
for (const exhausted of ['windows', 'http']) test(`contract: exhausted technical ${exhausted} pauses all production despite prepared native text and default partial-work setting`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-budget-service-')), gameDir = path.join(root, 'game');
  await mkdir(path.join(gameDir, 'data'), { recursive: true });
  const originals = { 'data/native.json': JSON.stringify({ lines: ['Keep the accepted scene.', 'A pending complete scene.'], logic: 7 }),
    'data/hidden.json': JSON.stringify({ text: 'Unresolved complete scene.', identity: 'keep-id' }) };
  for (const [file, text] of Object.entries(originals)) await writeFile(path.join(gameDir, file), text);
  const calls = { text: 0, adaptation: 0, fetch: 0, build: 0 };
  const coverage = { completeness: 'partial', unitCount: 2, needsAdaptation: true,
    summary: { extracted: 1, unresolvedCandidates: 1 },
    resources: [{ file: 'data/native.json', kind: 'extracted', units: 2 }, { file: 'data/hidden.json', kind: 'display-text-candidate', units: 0 }],
    dynamicCandidates: [{ id: 'hidden-candidate', file: 'data/hidden.json', source: 'Unresolved complete scene.' }], triggers: ['suspected-omission'] };
  const service = await createService({ dataDir: path.join(root, 'profile'),
    adaptationLimits: { maxHttpAttempts: exhausted === 'http' ? 1 : 8, maxWindows: exhausted === 'windows' ? 1 : 4 },
    scriptTools: null, imageTools: null, adapterLab: { dispatch: async () => null }, coverageScanner: async () => coverage,
    technicalProvider: async () => ({ decision: 'native', summary: 'Contract native plan' }),
    provider: async () => { calls.text++; assert.fail('No translation or proofreading request may follow exhausted technical allowance'); },
    adaptationProvider: async args => {
      calls.adaptation++;
      assert.equal(args.requestContext.owner.snapshot().historyCoverage, 'complete');
      if (exhausted === 'http') {
        const transport = createTechnicalTransport({ requestContext: args.requestContext, fetchImpl: async () => {
          calls.fetch++; return new Response('{"choices":[{"message":{"content":"Local contract response"},"finish_reason":"stop"}]}', { headers: { 'content-type': 'application/json' } });
        } });
        await (await transport.fetch('https://budget-contract.invalid/v1/chat/completions', { method: 'POST', body: '{"model":"contract","messages":[]}' })).text();
        await transport.flush();
      }
      return { status: 'needs-review', retryable: true, reason: 'Contract resource remains unresolved',
        continuation: { action: 'continue', reasonCode: 'CONTRACT_PENDING' } };
    },
    worker: async (command, input) => {
      if (command === 'catalog') return { engines: [], nativeRevision: 'budget-contract-native' };
      if (command === 'probe') return { engine: 'RPG Maker MV', root: '.', capabilities: { extract: true, nativeBuild: true, assist: false } };
      if (command === 'assistInfo') return { supported: false, modes: [] };
      if (command === 'extract') {
        const units = ['Keep the accepted scene.', 'A pending complete scene.'].map((source, index) => ({ id: `native:${index}`, source, kind: 'message', tokens: [], context: { file: 'data/native.json' } }));
        await mkdir(input.workspaceDir, { recursive: true });
        await writeFile(path.join(input.workspaceDir, 'manifest.json'), JSON.stringify({ units: Object.fromEntries(units.map(unit => [unit.id, { controls: {} }])) }));
        return { workspaceDir: input.workspaceDir, sourceFingerprint: 'budget-contract-source', units };
      }
      if (command === 'roundtrip' || command === 'validate') return { passed: true, valid: true };
      if (command === 'build' || command === 'assemble') { calls.build++; assert.fail('An exhausted technical allowance must not build a partial product automatically'); }
      throw new Error(`Unexpected contract worker command: ${command}`);
    } });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 }); });
  const settings = defaultSettings(); settings.pauseOnLocalFailure = false; settings.proofreading = false;
  settings.concurrency = 1;
  settings.connection.model = 'budget-contract'; await service.saveSettings(settings);
  const project = await service.createProject({ gameDir }); assert.equal(project.status, 'ready'); assert.equal(project.total, 2);
  const first = (await service.listText({ projectId: project.id })).units[0];
  const accepted = await service.saveText({ projectId: project.id, unitId: first.id, expectedRevision: first.revision,
    translation: '保留已经接受的场景。', notes: '保留既有成果' });
  await service.startProject({ projectId: project.id });
  let paused;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const current = await service.getProject({ projectId: project.id });
    if (current.status === 'paused') { paused = current; break; }
    assert.notEqual(current.status, 'failed', current.lastError); await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(paused, 'Budget exhaustion must reach a saved paused state');
  assert.equal(paused.stage, '技术适配累计预算已用完'); assert.match(paused.lastError, /预算/);
  assert.equal(paused.adaptationDeferred, false); assert.equal(paused.adaptation.blocked, true); assert.equal(paused.adaptation.continuationNeeded, false);
  assert.equal(paused.adaptation.accounting.windowsUsed, 1);
  assert.equal(paused.adaptation.accounting.remainingWindows, exhausted === 'windows' ? 0 : 3);
  assert.equal(paused.adaptation.accounting.httpUsed, exhausted === 'http' ? 1 : 0);
  assert.equal(calls.adaptation, 1); assert.equal(calls.fetch, exhausted === 'http' ? 1 : 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(calls.text, 0); assert.equal(calls.build, 0); assert.equal(calls.adaptation, 1, 'The exhausted task cannot automatically reopen');
  try { await service.startProject({ projectId: project.id }); }
  catch (error) { assert.match(error.message, /预算|Contract resource remains unresolved/); }
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(calls.text, 0, 'Ordinary resume must not implicitly defer budget-exhausted resources and buy text work');
  assert.equal(calls.build, 0);
  assert.equal((await service.getProject({ projectId: project.id })).status, 'paused');
  const rows = (await service.listText({ projectId: project.id })).units, retained = rows.find(unit => unit.id === first.id);
  assert.equal(retained.translation, accepted.translation); assert.equal(retained.notes, accepted.notes); assert.equal(retained.revision, accepted.revision);
  assert.equal(rows.filter(unit => unit.status === 'pending').length, 1);
  for (const [file, text] of Object.entries(originals)) assert.equal(await readFile(path.join(gameDir, file), 'utf8'), text);
});
