import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { productWorker } from '../../apps/desktop/electron/host.mjs';
import { sha256, validateTranslation } from '../exchange/index.mjs';

const testRoot = path.resolve(process.env.PINHAO_TEST_ROOT ?? 'local/native-text-recovery-tests');
await mkdir(testRoot, { recursive: true });

async function eventually(read, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for neutral native-text fixture');
}

const rows = () => Array.from({ length: 3 }, (_, index) => ({ id: `line-${index}`,
  source: `Neutral line ${index}`, kind: 'message', tokens: [], context: { file: 'scene' } }));
const rejected = legacyId => Object.assign(new Error('Native text rejected'), {
  code: 'NATIVE_TEXT_REJECTED', rejectedTranslations: [{ legacyId, reason: 'New engine syntax is not permitted' }],
});

async function fixture(t, { raw = rows(), sample, translate, include } = {}) {
  const root = await mkdtemp(path.join(testRoot, 'neutral-'));
  const gameDir = path.join(root, 'game'), dataDir = path.join(root, 'data');
  await mkdir(gameDir);
  await writeFile(path.join(gameDir, 'original.txt'), 'neutral original');
  const requests = [], samples = [];
  const worker = async (command, args) => {
    if (command === 'probe') return { engine: 'MV' };
    if (command === 'extract') {
      await mkdir(args.workspaceDir, { recursive: true });
      return { units: raw, workspaceDir: args.workspaceDir, sourceFingerprint: sha256(raw) };
    }
    if (['roundtrip', 'validate'].includes(command)) return { ok: true };
    if (command === 'build') {
      if (args.outputDir.includes(`${path.sep}samples${path.sep}`)) {
        samples.push(structuredClone(args.translations));
        await sample?.(args.translations, samples.length);
      }
      await mkdir(args.outputDir, { recursive: true });
      return { buildDir: args.outputDir };
    }
    if (command === 'assemble') {
      await mkdir(args.outputDir, { recursive: true });
      await writeFile(path.join(args.outputDir, 'Game.exe'), 'neutral executable fixture');
      return { outputDir: args.outputDir, launchPath: path.join(args.outputDir, 'Game.exe') };
    }
    throw new Error(`Unsupported neutral fixture command: ${command}`);
  };
  const provider = async args => {
    const units = args.wire.payload.units;
    requests.push({ units: structuredClone(units), prompt: args.prompt, model: args.connection.model });
    const response = { records: units.filter(unit => include?.(unit, requests.length) !== false).map(unit => ({ id: unit.id,
      translation: translate?.(unit, requests.length) ?? `Translated ${unit.source}`, notes: '' })) };
    await args.onTransport?.({ type: 'text-delta', text: JSON.stringify(response) });
    await args.onTransport?.({ type: 'body-end' });
    return response;
  };
  const open = () => createService({ dataDir, worker, provider, scriptTools: null,
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral native fixture' }) });
  let service = await open();
  t.after(async () => {
    await service.close();
    const resolved = path.resolve(root), parent = `${path.resolve(testRoot)}${path.sep}`;
    assert.ok(resolved.startsWith(parent));
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  });
  await service.saveSettings({ ...defaultSettings(), connection: { baseUrl: 'http://127.0.0.1:1/v1', model: 'neutral' },
    concurrency: 1, proofreading: false });
  const project = await service.createProject({ gameDir });
  const tasks = () => {
    const store = createStore(dataDir);
    try { return store.tasks(project.id); } finally { store.close(); }
  };
  return { project, requests, samples, tasks, get service() { return service; },
    async reopen() { await service.close(); service = await open(); return service; } };
}

async function settled(f) {
  return eventually(async () => {
    const current = await f.service.getProject({ projectId: f.project.id });
    return ['completed', 'paused'].includes(current.status) && current;
  });
}

test('native content rejection retries only the rejected submitted ID and retains original response evidence', async t => {
  const f = await fixture(t, {
    translate: (unit, request) => `${request === 1 && unit.source.endsWith('0') ? '[bad]' : ''}Translated ${unit.source}`,
    sample: translations => { if (translations.some(row => row.translation.startsWith('[bad]'))) throw rejected('line-0'); },
  });
  await f.service.startProject({ projectId: f.project.id });
  const done = await settled(f);
  assert.equal(done.status, 'completed', done.lastError);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1].units.map(unit => unit.source), ['Neutral line 0']);
  for (const source of ['Neutral line 1', 'Neutral line 2']) {
    assert.equal(f.requests.flatMap(request => request.units).filter(unit => unit.source === source).length, 1);
  }
  assert.match(f.requests[1].prompt, /New engine syntax is not permitted/);
  const tasks = f.tasks(), failures = tasks.flatMap(task => task.nativeRejections ?? []);
  const failure = failures.find(row => row.legacyId === 'line-0');
  assert.ok(failure, 'The rejected candidate keeps a bounded task-level rejection record');
  assert.equal(failure.translationHash, sha256('[bad]Translated Neutral line 0'));
  assert.match(failure.reason, /engine syntax/);
  assert.ok(failure.unitId && failure.requestId && failure.at);
  const original = tasks.flatMap(task => task.requestHistory ?? []).find(request => request.id === failure.requestId);
  assert.ok(original?.artifact?.directory);
  assert.match(await readFile(path.join(original.artifact.directory, 'final.txt'), 'utf8'), /\[bad\]Translated Neutral line 0/);
  const result = JSON.parse(await readFile(path.join(original.artifact.directory, 'result.json'), 'utf8'));
  assert.equal(result.status, 'received');
  assert.equal(result.summary.records, 3);
  assert.equal((await f.service.listText({ projectId: f.project.id })).units.every(unit => unit.status === 'translated'), true);
});

test('a native rejection retries the complete linked display group, not just its reported member', async t => {
  const raw = [0, 1].map(index => ({ id: `title-${index}`, source: 'Neutral title', kind: 'message', tokens: [],
    context: { file: `title-${index}`, syncGroup: 'neutral-title' } }));
  const f = await fixture(t, { raw,
    translate: (unit, request) => `${request === 1 ? '[bad]' : ''}Translated ${unit.source}`,
    sample: translations => { if (translations.some(row => row.translation.startsWith('[bad]'))) throw rejected('title-0'); },
  });
  await f.service.startProject({ projectId: f.project.id });
  const done = await settled(f);
  assert.equal(done.status, 'completed', done.lastError);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].units.length, 2);
  assert.deepEqual(f.samples.map(sample => sample.length), [2, 2]);
  assert.deepEqual((await f.service.listText({ projectId: f.project.id })).units.map(unit => unit.translation),
    ['Translated Neutral title', 'Translated Neutral title']);
});

test('a persisted old generic-error candidate cache is corrected on one continue after reopen', async t => {
  let legacyWorker = true;
  const f = await fixture(t, {
    translate: (unit, request) => `${request === 1 && unit.source.endsWith('0') ? '[bad]' : ''}Translated ${unit.source}`,
    sample: translations => {
      if (translations.some(row => row.translation.startsWith('[bad]'))) {
        if (legacyWorker) throw new Error('New engine syntax is not permitted');
        throw rejected('line-0');
      }
    },
  });
  await f.service.startProject({ projectId: f.project.id });
  assert.equal((await settled(f)).status, 'paused');
  assert.equal(f.requests.length, 1);
  const oldTask = f.tasks().find(task => task.candidateRecords?.length);
  assert.equal(oldTask.candidateRecords.length, 3);
  assert.equal(oldTask.nativeRejections, undefined);
  const originalArtifact = oldTask.requestHistory[0].artifact.directory;
  const originalResult = await readFile(path.join(originalArtifact, 'result.json'));
  legacyWorker = false;
  await f.reopen();
  await f.service.startProject({ projectId: f.project.id });
  const done = await settled(f);
  assert.equal(done.status, 'completed', done.lastError);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1].units.map(unit => unit.source), ['Neutral line 0']);
  assert.deepEqual(await readFile(path.join(originalArtifact, 'result.json')), originalResult);
  assert.equal(f.tasks().flatMap(task => task.nativeRejections ?? []).some(row => row.legacyId === 'line-0'), true);
});

test('an environmental native sample failure reuses saved candidates after recovery without buying text again', async t => {
  let unavailable = true;
  const f = await fixture(t, { sample: () => { if (unavailable) throw new Error('Neutral native codec unavailable'); } });
  await f.service.startProject({ projectId: f.project.id });
  assert.equal((await settled(f)).status, 'paused');
  assert.equal(f.requests.length, 1);
  assert.equal(f.tasks().find(task => task.candidateRecords?.length).candidateRecords.length, 3);
  unavailable = false;
  await f.service.startProject({ projectId: f.project.id });
  assert.equal((await settled(f)).status, 'completed');
  assert.equal(f.requests.length, 1);
  assert.equal(f.samples.length, 2);
  assert.equal(f.tasks().flatMap(task => task.nativeRejections ?? []).length, 0);
});

test('a native rejection naming an unsubmitted ID fails closed and preserves unrelated candidates', async t => {
  const f = await fixture(t, { sample: () => { throw rejected('outside-this-submission'); } });
  await f.service.startProject({ projectId: f.project.id });
  assert.equal((await settled(f)).status, 'paused');
  assert.equal(f.requests.length, 1);
  const saved = f.tasks().find(task => task.candidateRecords?.length);
  assert.equal(saved.candidateRecords.length, 3);
  assert.deepEqual(saved.candidateRecords.map(record => record.translation).sort(),
    ['Translated Neutral line 0', 'Translated Neutral line 1', 'Translated Neutral line 2']);
  assert.equal((await f.service.listText({ projectId: f.project.id })).units.every(unit => unit.revision === 0 && unit.status === 'pending'), true);
});

test('persistent native content rejection stops at the existing finite text window', async t => {
  const f = await fixture(t, {
    translate: unit => `[bad]Translated ${unit.source}`,
    sample: () => { throw rejected('line-0'); },
  });
  await f.service.startProject({ projectId: f.project.id });
  assert.equal((await settled(f)).status, 'paused');
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.requests.slice(1).map(request => request.units.map(unit => unit.source)),
    [['Neutral line 0'], ['Neutral line 0']]);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.requests.length, 3, 'A rejected native candidate cannot create an unbounded repair loop');
  assert.equal((await f.service.listText({ projectId: f.project.id })).units.every(unit => unit.status === 'pending'), true);
});

test('a native repair with no saved candidates survives reopen and a model change', async t => {
  let correct = false;
  const f = await fixture(t, { raw: rows().slice(0, 1),
    translate: unit => `${correct ? '' : '[bad]'}Translated ${unit.source}`,
    sample: translations => { if (translations.some(row => row.translation.startsWith('[bad]'))) throw rejected('line-0'); },
  });
  await f.service.startProject({ projectId: f.project.id });
  assert.equal((await settled(f)).status, 'paused');
  assert.equal(f.requests.length, 3);
  const paused = f.tasks().find(task => task.nativeRepair);
  assert.ok(paused, 'The exhausted repair keeps its native correction reason');
  assert.equal(paused.candidateRecords?.length ?? 0, 0);
  await f.reopen();
  const settings = (await f.service.snapshot()).settings;
  settings.connection.model = 'neutral-corrected';
  await f.service.saveSettings(settings);
  correct = true;
  await f.service.startProject({ projectId: f.project.id });
  const done = await settled(f);
  assert.equal(done.status, 'completed', done.lastError);
  assert.equal(f.requests.length, 4);
  assert.equal(f.requests[3].model, 'neutral-corrected');
  assert.deepEqual(f.requests[3].units.map(unit => unit.source), ['Neutral line 0']);
  assert.match(f.requests[3].prompt, /New engine syntax is not permitted/);
});

test('a rejected candidate is attributed to its original reply rather than a later completion page', async t => {
  const f = await fixture(t, {
    include: (unit, request) => request !== 1 || unit.source !== 'Neutral line 2',
    translate: (unit, request) => `${request === 1 && unit.source === 'Neutral line 0' ? '[bad]' : ''}Translated ${unit.source}`,
    sample: translations => { if (translations.some(row => row.translation.startsWith('[bad]'))) throw rejected('line-0'); },
  });
  await f.service.startProject({ projectId: f.project.id });
  const done = await settled(f);
  assert.equal(done.status, 'completed', done.lastError);
  assert.deepEqual(f.requests.map(request => request.units.map(unit => unit.source)),
    [['Neutral line 0', 'Neutral line 1', 'Neutral line 2'], ['Neutral line 2'], ['Neutral line 0']]);
  const tasks = f.tasks(), histories = tasks.flatMap(task => task.requestHistory ?? []);
  const first = histories.find(request => request.requested === 3);
  assert.ok(first);
  const failure = tasks.flatMap(task => task.nativeRejections ?? []).find(row => row.legacyId === 'line-0');
  assert.ok(failure);
  assert.equal(failure.requestId, first.id);
  assert.notEqual(failure.requestId, histories.find(request => request.requested === 1)?.id);
  assert.match(await readFile(path.join(first.artifact.directory, 'final.txt'), 'utf8'), /\[bad\]Translated Neutral line 0/);
});

test('real Python worker rejection crosses the host and service and repairs only the rejected RenPy line', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(testRoot, 'real-native-'));
  const gameDir = path.join(root, 'game'), script = path.join(gameDir, 'game', 'script.rpy');
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(path.join(gameDir, 'Game.exe'), 'neutral executable fixture');
  await writeFile(script, 'label start:\n    "First neutral sentence."\n    "Second neutral sentence."\n    "Third neutral sentence."\n    return\n');
  const hashes = async (directory, relative = '') => {
    const result = {};
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) Object.assign(result, await hashes(directory, file));
      else result[file] = sha256(await readFile(path.join(directory, file)));
    }
    return result;
  };
  const original = await hashes(gameDir), requests = [], buildErrors = [], buildSuccesses = [];
  const bundledPython = path.resolve('local/runtime/python/python.exe');
  const pythonPath = await access(bundledPython).then(() => bundledPython, () => 'python');
  const native = productWorker({ pythonPath, workerPath: path.resolve('adapters/python/worker.py'),
    toolkitPath: path.resolve('kits/workbench-tutorial/toolkit'), dependencyDir: path.resolve('local/dependencies'), timeoutMs: 60000 });
  let service;
  t.after(async () => {
    await service?.close();
    await native.closeExecution();
    assert.ok(path.resolve(root).startsWith(`${path.resolve(testRoot)}${path.sep}`));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  });
  const worker = async (command, args, options) => {
    try {
      const result = await native(command, args, options);
      if (command === 'build') buildSuccesses.push(args.outputDir);
      return result;
    } catch (error) {
      if (command === 'build') buildErrors.push({ code: error.code,
        rejectedTranslations: structuredClone(error.rejectedTranslations), message: error.message });
      throw error;
    }
  };
  service = await createService({ dataDir: path.join(root, 'data'), worker, scriptTools: null,
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral real native fixture' }),
    provider: async args => {
      const units = args.wire.payload.units;
      requests.push(structuredClone(units));
      return { records: units.map(unit => ({ id: unit.id,
        translation: `${requests.length === 1 && unit.source === 'First neutral sentence.' ? '[bad]' : ''}Translated ${unit.source}`, notes: '' })) };
    } });
  await service.saveSettings({ ...defaultSettings(), connection: { baseUrl: 'http://127.0.0.1:1/v1', model: 'neutral' },
    concurrency: 1, proofreading: false });
  const project = await service.createProject({ gameDir });
  assert.equal(project.engine, "Ren'Py");
  assert.equal(project.status, 'ready', project.lastError);
  const baseline = (await service.listText({ projectId: project.id })).units;
  assert.equal(baseline.length, 3);
  const first = baseline.find(unit => unit.source === 'First neutral sentence.');
  assert.ok(first);
  await service.startProject({ projectId: project.id });
  const complete = await eventually(async () => {
    const detail = await service.getProject({ projectId: project.id });
    return ['completed', 'paused', 'failed'].includes(detail.status) && detail;
  }, 60000);
  assert.equal(complete.status, 'completed', `${complete.stage}: ${complete.lastError}`);
  assert.equal(buildErrors.length, 1);
  assert.equal(buildErrors[0].code, 'NATIVE_TEXT_REJECTED');
  assert.deepEqual(buildErrors[0].rejectedTranslations,
    [{ legacyId: first.legacyId, reason: 'New engine syntax is not permitted' }]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].length, 3);
  assert.deepEqual(requests[1].map(unit => unit.source), ['First neutral sentence.']);
  assert.ok(buildSuccesses.length >= 2, 'Both the corrected native sample and final native build pass');
  const units = (await service.listText({ projectId: project.id })).units;
  assert.ok(units.every(unit => unit.status === 'translated'));
  for (const unit of units) validateTranslation(unit, unit.translation);
  assert.equal(complete.builds.length, 1);
  const output = await readFile(path.join(complete.builds[0].path, 'game', 'script.rpy'), 'utf8');
  assert.ok(!output.includes('[bad]'));
  for (const unit of baseline) assert.ok(output.includes(`Translated ${unit.source}`));
  assert.deepEqual(await hashes(gameDir), original);
});
