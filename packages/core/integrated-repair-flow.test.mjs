import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { sdkProvider } from './provider.mjs';
import { sha256 } from '../exchange/index.mjs';

const root = path.resolve('local/integrated-repair-flow-tests');
const rows = count => Array.from({ length: count }, (_, index) => ({ id: `entry-${index}`, kind: 'message',
  source: `A neutral line number ${index}.`, tokens: [], context: { scene: 'A neutral room.', file: 'story.json', event: 1, index } }));

async function until(read, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await read(); if (value) return value;
    await delay(10);
  }
  assert.fail(message);
}

async function fixture(t, { units, connection = {}, reply } = {}) {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'service-'));
  const gameDir = path.join(directory, 'game'), dataDir = path.join(directory, 'data');
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'original.txt'), 'Neutral original, unchanged.');
  const calls = [], wireRequests = [], errors = [];
  let current;
  const server = http.createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) text += chunk;
      wireRequests.push(JSON.parse(text));
      const payload = current.wire.payload;
      const selected = reply ? reply(payload, calls.length) : payload.units;
      const content = selected.map(unit => {
        const tag = current.wire.state.entries.find(([, id]) => id === unit.id)?.[0];
        assert.ok(tag, 'The live request must retain the exact short-tag identity');
        return `[${tag}]\n中性译文 ${unit.source}`;
      }).join('\n') + '\n[完成]';
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'neutral-local-repair', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ id: 'neutral-local-repair', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { errors.push(error); response.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let service;
  t.after(async () => {
    await service?.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 30 });
    assert.deepEqual(errors, [], 'The local endpoint must not hide fixture assertion errors');
  });
  service = await createService({ dataDir, scriptTools: null,
    provider: async args => {
      current = args;
      calls.push({ payload: structuredClone(args.wire.payload), prompt: args.prompt, system: args.system, budget: args.budget });
      return sdkProvider(args);
    },
    worker: async (command, args) => {
      if (command === 'probe') return { engine: 'MZ' };
      if (command === 'extract') { await mkdir(args.workspaceDir, { recursive: true }); return { units, workspaceDir: args.workspaceDir, sourceFingerprint: sha256(units) }; }
      if (['roundtrip', 'validate'].includes(command)) return { valid: true, passed: true };
      if (command === 'build') { await mkdir(args.outputDir, { recursive: true }); return { buildDir: args.outputDir }; }
      if (command === 'assemble') {
        await mkdir(args.outputDir, { recursive: true }); const launchPath = path.join(args.outputDir, 'Game.exe');
        await writeFile(launchPath, 'Neutral marker, not a playable game.'); return { outputDir: args.outputDir, launchPath };
      }
      throw new Error(`Unexpected isolated command ${command}`);
    } });
  await service.saveSettings({ ...defaultSettings(), concurrency: 1, proofreading: false,
    connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'neutral-local-repair', ...connection } });
  const project = await service.createProject({ gameDir });
  const withStore = action => { const store = createStore(dataDir); try { return action(store); } finally { store.close(); } };
  withStore(store => store.patchProject(project.id, { sampleValidation: { nativeStructure: 'passed' } }));
  return { service, calls, wireRequests, project, withStore,
    start: () => service.startProject({ projectId: project.id, mode: 'translation' }),
    detail: () => service.getProject({ projectId: project.id }),
    texts: async () => (await service.listText({ projectId: project.id, limit: 200 })).units };
}

test('normal service sends small display text without inline engineering fan-out and keeps the complete local evidence', async t => {
  const units = rows(1); units[0].source = 'Name';
  units[0].context.references = Array.from({ length: 561 }, (_, index) => ({ kind: 'script-command', index,
    path: `private/source/consumer-${index}.script`, field: 'localization-key', command: 'show-localized-name',
    evidence: { path: `private/source/consumer-${index}.script`, index, description: 'A physical location, not an inferred dialogue order.' } }));
  const original = structuredClone(units[0].context);
  const f = await fixture(t, { units }); await f.start();
  await until(async () => {
    const value = await f.detail(); assert.notEqual(value.status, 'paused', JSON.stringify({ lastError: value.lastError,
      failures: f.withStore(store => store.tasks(f.project.id)).map(task => ({ error: task.error, lastFailure: task.lastFailure })) }));
    return value.status === 'completed';
  }, 'Small text with large engineering evidence did not complete');
  assert.equal(f.calls.length, 1); assert.equal(f.wireRequests.length, 1);
  assert.ok(f.calls[0].prompt.length < 15000, 'A default text request must not include 561 physical source locations');
  assert.ok(!f.calls[0].prompt.includes('consumer-560.script'));
  t.diagnostic(JSON.stringify({ case: 'small-source-engineering-fanout', rawReferences: 561,
    requests: f.wireRequests.length, promptCharacters: f.calls[0].prompt.length }));
  const stored = (await f.texts())[0];
  assert.equal(stored.status, 'translated'); assert.deepEqual(stored.context.references, original.references);
});

test('normal SDK partial return repurchases only the missing target and relevant context, not all saved candidates', async t => {
  const f = await fixture(t, { units: rows(120), connection: { contextWindow: 666666, maxOutputTokens: 80966 },
    reply: (payload, request) => request === 1 ? payload.units.slice(0, -1) : payload.units });
  await f.start();
  await until(async () => {
    const value = await f.detail(); assert.notEqual(value.status, 'paused', JSON.stringify({ lastError: value.lastError,
      failures: f.withStore(store => store.tasks(f.project.id)).map(task => ({ error: task.error, lastFailure: task.lastFailure })) }));
    return value.status === 'completed';
  }, 'The normal SDK partial return did not recover');
  assert.ok(f.calls[0].payload.units.length >= 40, 'The fixture must exercise a broad initial batch, not a single-item workaround');
  const missing = f.calls[0].payload.units.at(-1).id;
  assert.deepEqual(f.calls[1].payload.units.map(unit => unit.id), [missing]);
  assert.ok((f.calls[1].payload.referenceOnly?.length ?? 0) < f.calls[0].payload.units.length / 2,
    'A one-target repair must not send every saved candidate as reference');
  t.diagnostic(JSON.stringify({ case: 'partial-return-material', requests: f.calls.map(call => ({
    targets: call.payload.units.length, references: call.payload.referenceOnly?.length ?? 0,
    promptCharacters: call.prompt.length })) }));
  assert.ok((await f.texts()).every(unit => unit.status === 'translated'));
  const tasks = f.withStore(store => store.tasks(f.project.id));
  assert.ok(tasks.some(task => task.role === 'translation' && task.requestHistory?.length >= 2));
});

test('genuine capacity rejection preserves structured unsent evidence and refreshes a legacy issue without reclassifying it', async t => {
  const units = rows(1); units[0].source = 'One complete neutral paragraph. '.repeat(4500);
  const f = await fixture(t, { units }); await f.start();
  let stopped = await until(async () => { const detail = await f.detail(); return detail.status === 'paused' && detail; }, 'Genuine large text did not stop before dispatch');
  assert.equal(f.calls.length, 0); assert.equal(f.wireRequests.length, 0);
  let issue = stopped.issues.find(item => item.category === 'text-capacity');
  assert.ok(issue?.capacityFailure); assert.equal(issue.capacityFailure.code, 'TEXT_GROUP_CAPACITY_EXCEEDED');
  assert.equal(issue.capacityFailure.fetchStarted, false); assert.equal(issue.capacityFailure.transportRequests, 0);
  assert.equal(issue.capacityFailure.capacity.contextWindow, 32768);
  assert.ok(issue.capacityFailure.estimatedInputTokens > 0);
  assert.deepEqual(f.withStore(store => store.one('projects', f.project.id)).lastFailure.capacityFailure, issue.capacityFailure);
  const issueId = issue.id;
  f.withStore(store => {
    const previous = store.all('issues', f.project.id).find(item => item.id === issueId);
    const { capacityFailure, ...legacy } = previous; store.put('issues', legacy, f.project.id);
  });
  await f.start();
  stopped = await until(async () => {
    const detail = await f.detail(); return detail.status === 'paused' && detail.issues.some(item => item.id === issueId && item.capacityFailure) && detail;
  }, 'Legacy capacity issue did not acquire its new structured evidence');
  issue = stopped.issues.find(item => item.id === issueId);
  assert.equal(issue.category, 'text-capacity'); assert.equal(f.calls.length, 0);
  assert.equal((await f.texts())[0].status, 'pending');
});
