import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createAdapterLab } from '../technical/adaptation/adapter-lab.mjs';
import { createDisplayVerifier } from '../technical/adaptation/display-review.mjs';
import { runAdaptation } from '../technical/adaptation.mjs';
import { createStore } from './workspace-store.mjs';

const gate = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const secrets = { encrypt: value => `test:${Buffer.from(value).toString('base64')}`, decrypt: value => Buffer.from(value.slice(5), 'base64').toString() };
const adapter = {
  manifest: { schemaVersion: 1, id: 'live-caption', version: '1.0.0', engine: 'RPG Maker MV', license: 'GPL-3.0-or-later', scope: { files: ['data/custom.json'] } },
  code: `({detect(){return true},extract(host){const data=JSON.parse(host.readText('data/custom.json'));return {units:[{id:'caption-a',source:data.lines[0],kind:'message',locator:{file:'data/custom.json',pointer:'/lines/0'},context:{file:'data/custom.json'}}]}},validate(){return {valid:true}},roundtrip(host){host.writeBytes('data/custom.json',host.readBytes('data/custom.json'));return {}},build(host,input){const data=JSON.parse(host.readText('data/custom.json'));if(Object.hasOwn(input.translations,'caption-a'))data.lines[0]=input.translations['caption-a'];host.writeText('data/custom.json',JSON.stringify(data));return {}},assemble(){return {complete:true}}})`,
};

async function waitFor(service, projectId, predicate, timeout = 12000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    last = await service.getProject({ projectId }); if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(`Publication wait timed out: ${JSON.stringify({ status: last?.status, stage: last?.stage, error: last?.lastError, publication: last?.publication })}`);
}

/** Deterministic service/lab integration fixture, not a claim of autonomous model delivery. */
async function fixture(t, { loseCallback = false, beforeDelivery, concurrency = 1 } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-live-publication-'));
  const gameDir = path.join(directory, 'game'), dataDir = path.join(directory, 'profile'), hold = gate(), submitted = gate();
  await mkdir(path.join(gameDir, 'data'), { recursive: true });
  await writeFile(path.join(gameDir, 'Game.exe'), 'neutral launcher');
  await writeFile(path.join(gameDir, 'data', 'native.json'), '{"text":"Native caption."}');
  await writeFile(path.join(gameDir, 'data', 'custom.json'), JSON.stringify({ lines: ['Hidden caption A.', 'Unresolved caption B.'], consumer: 'render(data.lines[index])', enabled: true }));
  const calls = { sessions: 0, returned: false, deliveries: 0, translation: 0, timeline: [] }, records = []; let redeliver;
  const worker = async (command, args) => {
    if (command === 'catalog') return { engines: [] };
    if (command === 'assistInfo') return { supported: false, modes: [] };
    if (command === 'probe') return { engine: 'RPG Maker MV', root: '.', capabilities: { extract: true, nativeBuild: true } };
    if (command === 'extract') {
      await mkdir(args.workspaceDir, { recursive: true });
      await writeFile(path.join(args.workspaceDir, 'manifest.json'), JSON.stringify({ units: { native: { controls: {} } } }));
      return { workspaceDir: args.workspaceDir, sourceFingerprint: 'native-source', units: [{ id: 'native', source: 'Native caption.', kind: 'message', tokens: [], context: { file: 'data/native.json' } }],
        coverage: { resources: [{ file: 'data/native.json', status: 'text_extracted', units: 1 }] } };
    }
    if (command === 'roundtrip' || command === 'validate') return { valid: true, passed: true };
    if (command === 'build') {
      await mkdir(path.join(args.outputDir, 'data'), { recursive: true });
      await writeFile(path.join(args.outputDir, 'data/native.json'), JSON.stringify({ text: args.translations.find(row => row.id === 'native')?.translation ?? 'Native caption.' }));
      return { buildDir: args.outputDir };
    }
    if (command === 'assemble') { await cp(gameDir, args.outputDir, { recursive: true }); await cp(args.buildDir, args.outputDir, { recursive: true }); return { outputDir: args.outputDir, launchPath: path.join(args.outputDir, 'Game.exe') }; }
    throw new Error(`Unexpected fixture worker command ${command}`);
  };
  const create = async () => {
    const displayVerifier = createDisplayVerifier({ connectionFor: () => ({ baseUrl: 'http://independent.invalid', model: 'fixture' }), generate: async ({ tools, prompt }) => {
      const source = await tools.read_resource.execute({ file: 'data/custom.json' });
      await tools.finish_review.execute({ decisions: JSON.parse(prompt).units.map(row => ({ ref: row.ref, status: 'display-supported', reason: 'Enabled inline fixture consumer reads these lines.', evidenceIds: [source.receiptId], consumerEvidenceIds: [source.receiptId] })) });
    } });
    const lab = await createAdapterLab({ dataDir: path.join(directory, 'recipes'), workspaceFor: ({ projectId }) => path.join(directory, 'project-labs', projectId), displayVerifier });
    return createService({ dataDir, secrets, worker, adapterLab: lab, scriptTools: null, imageTools: null,
      provider: async ({ wire, role }) => { if (role === 'translation') calls.translation++; calls.timeline.push(role); return { records: wire.payload.units.map(unit => ({ id: unit.id, translation: role === 'proofreading' ? unit.currentTranslation : `译文：${unit.source}`, notes: '' })) }; },
      technicalProvider: async () => ({ decision: 'native-standard', selectedCandidateIds: [] }),
      adaptationProvider: args => { redeliver = args.onAcceptedBatch; return runAdaptation({ ...args,
        onAcceptedBatch: async record => {
          calls.deliveries++; records.push(record); await beforeDelivery?.({ record, gameDir });
          if (loseCallback && calls.deliveries === 1) throw Object.assign(new Error('Lost host notification after durable producer receipt'), { code: 'ACCEPTANCE_STORAGE_FAILED', hostFailure: true });
          return args.onAcceptedBatch(record);
        }, generate: async ({ tools }) => {
          calls.sessions++;
          calls.timeline.push(`technical-${calls.sessions}`);
          if (calls.sessions > 1) return { finishReason: 'stop' };
          const candidate = await tools.write_adapter.execute(adapter); assert.ok(candidate.candidateId, JSON.stringify(candidate.error));
          const validation = await tools.validate_adapter.execute({ candidateId: candidate.candidateId }); assert.equal(validation.passed, true, JSON.stringify(validation));
          const result = await tools.submit_recipe.execute({ candidateId: candidate.candidateId, validationId: validation.validationId, metadata: {} });
          submitted.resolve(result);
          if (!loseCallback) { assert.equal(result.accepted, true, JSON.stringify(result)); await hold.promise; }
          calls.returned = true; return { finishReason: 'stop' };
        } }); },
    });
  };
  let service = await create();
  const settings = defaultSettings(); settings.connection.model = 'fixture'; settings.connection.apiKey = 'neutral-fixture'; settings.concurrency = concurrency; settings.pauseOnLocalFailure = false;
  await service.saveSettings(settings);
  t.after(async () => { hold.resolve(); await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); });
  return { gameDir, dataDir, calls, records, hold, submitted, redeliver: record => redeliver(record), get service() { return service; }, reopen: async () => { hold.resolve(); await service.close(); service = await create(); } };
}

test('same technical run commits accepted text to real SQLite before returning, without closing uncovered neighbours', { timeout: 25000 }, async t => {
  const f = await fixture(t), original = await readFile(path.join(f.gameDir, 'data/custom.json'));
  const project = await f.service.createProject({ gameDir: f.gameDir });
  await f.service.startProject({ projectId: project.id });
  const live = await waitFor(f.service, project.id, project => project.total === 2);
  assert.equal(f.calls.returned, false, 'the producing technical run is still active');
  assert.equal(live.publication.integrated, 1); assert.equal(live.publication.accepted, 1); assert.equal(live.publication.pendingIntegration, 0);
  assert.equal(live.adaptationPending, true, 'one delivered location is not full coverage');
  assert.equal((await f.service.listText({ projectId: project.id })).units.some(unit => unit.source === 'Hidden caption A.'), true);
  assert.deepEqual(await readFile(path.join(f.gameDir, 'data/custom.json')), original);
  const generation = live.publication.generation, units = (await f.service.listText({ projectId: project.id })).units.map(unit => [unit.id, unit.revision]);
  await f.redeliver(f.records[0]);
  const duplicate = await f.service.getProject({ projectId: project.id });
  assert.equal(duplicate.publication.generation, generation);
  assert.equal(duplicate.publication.integrated, 1);
  assert.deepEqual((await f.service.listText({ projectId: project.id })).units.map(unit => [unit.id, unit.revision]), units);
  await f.service.pauseProject({ projectId: project.id }); f.hold.resolve();
});

test('durable producer receipt recovers a lost live callback without another technical model session', { timeout: 30000 }, async t => {
  const f = await fixture(t, { loseCallback: true });
  const project = await f.service.createProject({ gameDir: f.gameDir }); await f.service.startProject({ projectId: project.id });
  await waitFor(f.service, project.id, project => project.status === 'paused');
  assert.equal(f.records.length, 1); const sessions = f.calls.sessions;
  await f.reopen();
  const restored = await waitFor(f.service, project.id, project => project.total === 2);
  assert.equal(f.calls.sessions, sessions, 'reconciliation must not buy a new technical investigation');
  assert.equal(restored.publication.integrated, 1);
});

test('a source changed after durable acceptance is not silently published from the stale extraction', { timeout: 25000 }, async t => {
  const f = await fixture(t, { beforeDelivery: async ({ gameDir }) => {
    const file = path.join(gameDir, 'data/custom.json'), data = JSON.parse(await readFile(file, 'utf8'));
    data.lines[0] = 'Source changed after independent validation.'; await writeFile(file, JSON.stringify(data));
  } });
  const project = await f.service.createProject({ gameDir: f.gameDir }); await f.service.startProject({ projectId: project.id });
  const outcome = await waitFor(f.service, project.id, project => project.status === 'paused' || project.total > 1);
  assert.equal(f.records.length, 1, 'source change must happen after actual durable acceptance, not an unrelated preparation failure');
  assert.equal(outcome.total, 1, 'stale accepted source must not enter current workbench');
  assert.notEqual(outcome.publication.integrated, 1);
  const inspect = createStore(f.dataDir);
  try {
    const delivery = inspect.one('acceptance_receipts', f.records[0].id);
    assert.ok(['INTEGRATION_SOURCE_STALE', 'ADAPTER_ACCEPTED_STALE'].includes(delivery.lastError?.code), JSON.stringify(delivery.lastError));
    assert.match(delivery.lastError.message, /原版资源在接受后已变化|来源、消费者或验证资格已经变化/);
  } finally { inspect.close(); }
  f.hold.resolve();
});

test('concurrency one hands its next safe admission to ready text rather than immediately rebuying technical windows', { timeout: 25000 }, async t => {
  const f = await fixture(t), project = await f.service.createProject({ gameDir: f.gameDir });
  await f.service.startProject({ projectId: project.id });
  await waitFor(f.service, project.id, project => project.total === 2);
  assert.equal(f.calls.translation, 0, 'no extra slot may bypass concurrency one while technical run is active');
  f.hold.resolve();
  await waitFor(f.service, project.id, () => f.calls.translation > 0);
  const translated = f.calls.timeline.indexOf('translation'), continued = f.calls.timeline.indexOf('technical-2');
  assert.ok(translated > 0 && (continued < 0 || translated < continued), JSON.stringify(f.calls.timeline));
  await f.service.pauseProject({ projectId: project.id });
});

test('a stale receipt is retained through restart and no longer prevents local revalidation on explicit retry', { timeout: 30000 }, async t => {
  let changed = false, original;
  const f = await fixture(t, { beforeDelivery: async ({ gameDir }) => {
    if (changed) return; changed = true;
    const file = path.join(gameDir, 'data/custom.json'); original = await readFile(file);
    const data = JSON.parse(original); data.lines[0] = 'Source changed after independent validation.';
    await writeFile(file, JSON.stringify(data));
  } });
  const project = await f.service.createProject({ gameDir: f.gameDir }); await f.service.startProject({ projectId: project.id });
  const paused = await waitFor(f.service, project.id, value => value.status === 'paused');
  assert.equal(paused.total, 1); assert.equal(paused.publication.stale, 1);
  assert.equal(paused.publication.pendingIntegration, 0, 'stale proof is not pending delivery');
  await writeFile(path.join(f.gameDir, 'data/custom.json'), original);
  const requestId = f.records[0].payload.adaptationRequestId;
  await f.reopen();
  const before = await f.service.getProject({ projectId: project.id }); assert.equal(before.total, 1);
  await f.service.startProject({ projectId: project.id });
  const recovered = await waitFor(f.service, project.id, value => value.total === 2);
  assert.equal(recovered.publication.integrated, 1); assert.equal(recovered.publication.stale, 0);
  assert.equal(f.records[0].payload.adaptationRequestId, requestId);
  assert.equal(f.calls.deliveries, 1, 'freshness recovery reuses the durable local receipt, not a new model delivery');
  await f.service.pauseProject({ projectId: project.id });
});

test('concurrency three allows ready text while its producer continues, under the shared project slot ceiling', { timeout: 25000 }, async t => {
  const f = await fixture(t, { concurrency: 3 }), project = await f.service.createProject({ gameDir: f.gameDir });
  await f.service.startProject({ projectId: project.id });
  let maximumActive = 0;
  const live = await waitFor(f.service, project.id, project => {
    maximumActive = Math.max(maximumActive, project.runtime?.active ?? 0);
    return project.total === 2 && f.calls.translation > 0;
  });
  assert.equal(f.calls.returned, false); assert.ok(maximumActive <= 3);
  assert.equal(live.publication.integrated, 1);
  await f.service.pauseProject({ projectId: project.id }); f.hold.resolve();
});
