import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { sha256 } from '../exchange/index.mjs';
import { sdkProvider } from './provider.mjs';
import { resolveRequestMaterial } from './request-artifacts.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const secrets = { encrypt: value => `neutral:${value}`, decrypt: value => value.slice(8) };

function neutralUnits(concurrency) {
  const names = concurrency * 16, scenes = concurrency === 20 ? 352 : 64;
  return Array.from({ length: names + scenes }, (_, index) => {
    const name = index < names, number = String(index).padStart(4, '0');
    const source = name ? `Person${number}` : `Neutral scene line ${number}.`;
    return { id: `neutral:${number}`, legacyId: name ? `Actors:${index + 1}:name` : `scene:${number}`,
      kind: name ? 'database_name' : 'message', source, translation: source, notes: '', tokens: [], revision: 0,
      sourceHash: sha256(source), status: 'pending', context: name
        ? { file: 'data/Actors.json', record: index + 1, field: 'name', actor_id: index + 1 }
        : { file: 'data/Map001.json', event: Math.floor((index - names) / 16) + 1, page: 0 } };
  });
}

function firstWave(size, phase) {
  let arrivals = 0, release;
  const ready = new Promise(resolve => { release = resolve; });
  return { release, async enter() {
    arrivals++;
    if (arrivals === size) release();
    if (arrivals <= size) {
      let timer;
      try { await Promise.race([ready, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${phase} dispatched ${arrivals}/${size} simultaneous HTTP requests`)), 30000);
      })]); } finally { clearTimeout(timer); }
    }
  } };
}

async function until(check, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(10);
  }
  throw new Error('The neutral HTTP-backed staged round did not finish');
}

for (const concurrency of [3, 20]) test(`SDK HTTP sends fill ${concurrency} body and review slots without glossary prerequisites`, { timeout: 210000 }, async t => {
  const units = neutralUnits(concurrency), phases = ['translation', 'proofreading'];
  const active = Object.fromEntries(phases.map(phase => [phase, 0]));
  const peak = { ...active }, waves = Object.fromEntries(phases.map(phase => [phase, firstWave(concurrency, phase)]));
  const arrived = [], finishedBody = new Set(), receivedBody = new Map(), errors = [], textMaterials = new Map();
  let activeTotal = 0, peakTotal = 0, reviewBeforeBodyFinished = false;
  const server = createServer(async (request, response) => {
    let phase, record;
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body), prompt = input.messages.find(message => message.role === 'user').content, wire = textMaterials.get(prompt);
      assert.ok(wire, 'The actual HTTP body matches captured current-wire material');
      assert.ok(prompt.startsWith('【待处理文字】'));
      const payload = wire.payload, references = new Map(wire.state.entries.map(([ref, id]) => [id, ref]));
      assert.ok(phases.includes(payload.task), 'Only body translation and its review buy requests');
      phase = payload.task;
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(input.stream, true);
      // Every real HTTP request, in every phase, must bound its own output.
      const ceiling = input.max_tokens ?? input.max_completion_tokens;
      assert.ok(Number.isInteger(ceiling) && ceiling > 0,
        `${phase} requests declare a positive output ceiling, got ${String(ceiling)}`);
      active[phase]++;
      peak[phase] = Math.max(peak[phase], active[phase]);
      activeTotal++;
      peakTotal = Math.max(peakTotal, activeTotal);
      record = { phase, stage: payload.reviewScope?.stage, arrivedAt: performance.now(), arrivedWallAt: Date.now(),
        bodyHash: sha256(input), ids: payload.units.map(unit => unit.id), requestIndex: arrived.length + 1 };
      arrived.push(record);
      if (phase === 'proofreading' && finishedBody.size !== units.length) reviewBeforeBodyFinished = true;
      if (phase === 'translation') for (const unit of payload.units) receivedBody.set(unit.id, (receivedBody.get(unit.id) ?? 0) + 1);
      await waves[phase].enter();
      const output = phase === 'proofreading'
        ? { reviewed: record.ids.map(id => references.get(id)), changes: [], questions: [] }
        : { text: payload.units.map(unit => {
          const source = unit.source;
          return [references.get(unit.id), source.startsWith('Person') ? `人物${source.slice(6)}` : `中性译文${source.match(/\d+/)[0]}`, ''];
        }) };
      if (phase === 'translation') record.ids.forEach(id => finishedBody.add(id));
      record.respondedAt = performance.now();
      response.setHeader('content-type', 'application/json');
      response.setHeader('x-request-id', `neutral-${record.requestIndex}`);
      response.end(JSON.stringify({ id: `neutral-${record.requestIndex}`, object: 'chat.completion', created: 1, model: input.model,
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    } catch (error) {
      errors.push(error.message);
      response.statusCode = 500;
      response.end(JSON.stringify({ error: { message: error.message } }));
    } finally {
      if (record) { active[phase]--; activeTotal--; }
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const rootPath = path.resolve('local/core-tests');
  await mkdir(rootPath, { recursive: true });
  const root = await mkdtemp(path.join(rootPath, 'http-concurrency-')), dataDir = path.join(root, 'data'), gameDir = path.join(root, 'original');
  await mkdir(gameDir);
  const store = createStore(dataDir);
  store.put('projects', { id: 'neutral-http', name: 'Neutral HTTP concurrency', gameDir, engine: 'MZ', prepared: true,
      status: 'ready', stage: '文字工作台就绪', targetLanguage: 'zh-Hans', workspaceDir: path.join(root, 'workspace'),
      workbenchDir: path.join(root, 'workspace'), technicalPlan: { decision: 'native' }, sampleValidation: { nativeStructure: 'passed' },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', sourceFingerprint: sha256(units),
      inventory: {}, coverage: { format: 1, unitCount: units.length, summary: { extracted: units.length }, needsAdaptation: false,
        completeness: 'structural', triggers: [], resources: [], reviewItems: [], dynamicCandidates: [], imageCandidates: [] } });
  store.transaction('neutral-http', () => {
    units.forEach((unit, index) => { store.putUnit('neutral-http', unit, index); store.addRevision('neutral-http', unit); });
  });
  store.close();
  // This audit compares the actual HTTP body with the socket arrival, so opt into detailed evidence.
  await writeFile(path.join(dataDir, 'diagnostics.on'), '');
  const service = await createService({ dataDir, secrets, scriptTools: null, imageTools: null,
    provider: async args => { textMaterials.set(args.prompt, args.wire); return sdkProvider(args); },
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral native route', selectedCandidateIds: [] }),
    worker: async (command, args) => {
      if (command === 'catalog') return { engines: [] };
      if (['validate', 'roundtrip'].includes(command)) return { ok: true };
      if (command === 'build' || command === 'assemble') {
        await mkdir(args.outputDir, { recursive: true });
        await writeFile(path.join(args.outputDir, 'neutral.txt'), 'Neutral fixture output.');
        return command === 'build' ? { buildDir: args.outputDir } : { outputDir: args.outputDir, runtimeVerified: false };
      }
      throw new Error(`Unexpected neutral fixture worker command ${command}`);
    } });
  t.after(async () => {
    for (const wave of Object.values(waves)) wave.release();
    await service.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });
  const settings = defaultSettings();
  settings.concurrency = concurrency;
  settings.connection = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'neutral-http-model', apiKey: '',
    contextWindow: 32768, maxOutputTokens: 1200 };
  await service.saveSettings(settings);
  await service.startProject({ projectId: 'neutral-http' });
  const done = await until(async () => {
    const project = await service.getProject({ projectId: 'neutral-http' });
    if (project.status === 'paused') throw new Error(`Neutral HTTP round paused: ${project.lastError}; server: ${errors.join('; ')}`);
    return project.status === 'completed' && project;
  });
  assert.deepEqual(errors, []);
  assert.equal(done.proofread, units.length);
  assert.equal(finishedBody.size, units.length);
  assert.ok([...receivedBody.values()].every(count => count === 1), 'Every initial translation target is sent once');
  assert.deepEqual(peak, { translation: concurrency, proofreading: concurrency });
  assert.equal(peakTotal, concurrency, 'The shared task pool bounds total live HTTP requests');
  assert.equal(reviewBeforeBodyFinished, false, 'No review request reaches the socket before the complete translation round finishes');
  const bodyRequests = arrived.filter(record => record.phase === 'translation');
  assert.ok(bodyRequests.length >= concurrency, 'Body batching must leave enough independent HTTP work to fill every slot');
  const reviews = arrived.filter(record => record.phase === 'proofreading');
  assert.ok(reviews.length >= concurrency, 'Scene review leaves enough independent HTTP work to fill every slot');
  assert.ok(reviews.every(record => record.stage === 'scene'), 'Healthy scenes do not buy a second consistency pass');
  assert.equal(reviews.flatMap(record => record.ids).length, units.length);
  assert.equal(new Set(reviews.flatMap(record => record.ids)).size, units.length, 'Every scene target is reviewed once');
  const inspect = createStore(dataDir);
  let artifacts;
  try { artifacts = inspect.tasks('neutral-http').flatMap(task => task.requestHistory ?? []).map(request => request.artifact); }
  finally { inspect.close(); }
  assert.equal(artifacts.length, arrived.length, 'Every actual HTTP request has a persisted request artifact');
  const byBody = new Map(arrived.map(record => [record.bodyHash, record]));
  const sent = [];
  for (const artifact of artifacts) {
    assert.ok(artifact?.sentAt && artifact.finalBodyCaptured, 'Actual send time and raw final response are captured');
    const events = (await readFile(path.join(artifact.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const sends = events.filter(event => event.type === 'send');
    assert.equal(sends.length, 1, 'The neutral success path issues one transport request per artifact');
    const event = await resolveRequestMaterial(sends[0], { contentDirectory: artifact.contentDirectory });
    const incoming = byBody.get(sha256(event.body));
    assert.ok(incoming, 'The captured actual HTTP body matches a socket arrival');
    assert.equal(event.at, artifact.sentAt);
    assert.ok(Date.parse(event.at) <= incoming.arrivedWallAt, 'The persisted send event precedes its HTTP arrival');
    sent.push({ phase: incoming.phase, sentAt: event.at, arrivedAt: incoming.arrivedAt });
  }
  t.diagnostic(JSON.stringify({ concurrency, units: units.length, peak, peakTotal,
    actualSendArtifacts: sent.length,
    requests: Object.fromEntries(phases.map(phase => [phase, arrived.filter(record => record.phase === phase).length])),
    firstWave: Object.fromEntries(phases.map(phase => [phase, arrived.filter(record => record.phase === phase).slice(0, concurrency)
      .map(({ arrivedAt, respondedAt }) => ({ sentAt: sent.find(item => item.arrivedAt === arrivedAt).sentAt, arrivedAt, respondedAt }))])),
    lastBodyResponseAt: Math.max(...bodyRequests.map(record => record.respondedAt)),
    firstReviewArrivalAt: arrived.find(record => record.phase === 'proofreading').arrivedAt }));
});
