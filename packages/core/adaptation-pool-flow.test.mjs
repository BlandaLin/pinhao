import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { sha256 } from '../exchange/index.mjs';
import { createAdapterLab } from '../technical/adaptation/adapter-lab.mjs';
import { runAdaptation } from '../technical/adaptation.mjs';
import { scanCoverage } from '../technical/coverage.mjs';
import { createStore } from './workspace-store.mjs';

const root = path.resolve('local', 'adaptation-pool-flow-tests');
await mkdir(root, { recursive: true });
const files = ['data/extra-a.json', 'data/extra-b.json', 'data/extra-c.json'];
const secrets = { encrypt: value => `fixture:${Buffer.from(value).toString('base64')}`, decrypt: value => Buffer.from(value.slice(8), 'base64').toString() };
const provider = async ({ wire, role }) => ({ records: wire.payload.units.map(unit => ({ id: unit.id, translation: role === 'proofreading' ? unit.currentTranslation : `译文：${unit.source}`, notes: '' })) });
const technicalProvider = async () => ({ decision: 'native-standard', summary: '中性资源检查完成', selectedCandidateIds: [] });
const deferred = () => {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
};
async function deadline(promise, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 15000); })]); }
  finally { clearTimeout(timer); }
}

async function waitFor(service, projectId, predicate = project => project.status === 'completed') {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const project = await service.getProject({ projectId });
    if (predicate(project)) return project;
    if (['paused', 'failed'].includes(project.status)) assert.fail(JSON.stringify({ stage: project.stage, error: project.lastError, coverage: project.coverage?.summary, pending: project.coverage?.resources?.filter(item => item.kind === 'display-text-candidate') }));
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail('Neutral pooled adaptation did not finish within 40 seconds');
}

function adapter(file) {
  const id = path.basename(file, '.json');
  const resource = JSON.stringify(file);
  return {
    manifest: { schemaVersion: 1, id, version: '1.0.0', engine: 'RPG Maker MV', scope: { files: [file] }, license: 'GPL-3.0-or-later', sources: [] },
    code: `({detect(host){return {matched:host.list('data').some(item=>item.path===${resource})}},
extract(host){const data=JSON.parse(host.readText(${resource}));return {units:data.lines.map((source,i)=>({id:'${id}:'+i,source,kind:'message',context:{file:${resource}},locator:{file:${resource},pointer:'/lines/'+i}})),coverage:[{file:${resource},status:'extracted'}]}},
validate(){return {valid:true}},roundtrip(host){host.writeBytes(${resource},host.readBytes(${resource}));return {}},
build(host,input){const data=JSON.parse(host.readText(${resource}));for(const unit of input.units)if(Object.hasOwn(input.translations,unit.id))data.lines[Number(unit.locator.pointer.split('/').pop())]=input.translations[unit.id];host.writeText(${resource},JSON.stringify(data));return {}},assemble(){return {complete:true}}})`,
  };
}

async function submit(tools, file) {
  const candidate = await tools.write_adapter.execute(adapter(file));
  const validation = await tools.validate_adapter.execute({ candidateId: candidate.candidateId });
  assert.equal(validation.passed, true, JSON.stringify(validation.error));
  const result = await tools.submit_recipe.execute({ candidateId: candidate.candidateId, validationId: validation.validationId, metadata: {} });
  assert.equal(result.taskComplete, true, JSON.stringify(result));
}

async function fixture(t, { concurrency, generate, resourceCount = 3, strict = false, coverageScanner, adaptationFault, textProvider = provider }) {
  const files = Array.from({ length: resourceCount }, (_, index) => `data/extra-${String.fromCharCode(97 + index)}.json`);
  const directory = await mkdtemp(path.join(root, 'flow-'));
  const gameDir = path.join(directory, 'game'), dataDir = path.join(directory, 'profile');
  await mkdir(path.join(gameDir, 'data'), { recursive: true });
  await mkdir(path.join(gameDir, 'save'));
  await writeFile(path.join(gameDir, 'save', 'private.rpgsave'), 'retain private save');
  await writeFile(path.join(gameDir, 'Game.exe'), 'neutral launcher marker');
  await writeFile(path.join(gameDir, 'data', 'native.json'), JSON.stringify({ lines: ['A complete native scene.'], logic: { switch: 9 } }));
  for (const [index, file] of files.entries()) await writeFile(path.join(gameDir, file), JSON.stringify({ lines: [`A complete hidden scene ${index + 1}.`], logic: { id: `keep-${index}` } }));
  const before = new Map(await Promise.all(['data/native.json', ...files, 'save/private.rpgsave'].map(async file => [file, await readFile(path.join(gameDir, file))])));
  const calls = { build: 0, assemble: 0, adaptations: [] };
  let workbenchDir;
  const worker = async (command, args) => {
    if (command === 'catalog') return { engines: [] };
    if (command === 'assistInfo') return { supported: false, modes: [] };
    if (command === 'probe') return { engine: 'RPG Maker MV', root: '.', capabilities: { extract: true, nativeBuild: true, assist: false } };
    if (command === 'extract') {
      workbenchDir = args.workspaceDir;
      const value = JSON.parse(await readFile(path.join(gameDir, 'data', 'native.json'), 'utf8'));
      const units = value.lines.map((source, index) => ({ id: `native:${index}`, source, kind: 'message', tokens: [], context: { file: 'data/native.json' } }));
      await mkdir(args.workspaceDir, { recursive: true });
      await writeFile(path.join(args.workspaceDir, 'manifest.json'), JSON.stringify({ units: Object.fromEntries(units.map(unit => [unit.id, { controls: {} }])) }));
      return { workspaceDir: args.workspaceDir, units, sourceFingerprint: sha256(value), coverage: { resources: [{ file: 'data/native.json', status: 'text_extracted', units: units.length }] } };
    }
    if (command === 'roundtrip' || command === 'validate') return { valid: true, passed: true };
    if (command === 'build') {
      calls.build++;
      const data = JSON.parse(await readFile(path.join(gameDir, 'data', 'native.json'), 'utf8'));
      for (const row of args.translations) {
        assert.match(row.id, /^native:/, 'supplemental text uses its own writer');
        data.lines[Number(row.id.split(':')[1])] = row.translation;
      }
      await mkdir(path.join(args.outputDir, 'data'), { recursive: true });
      await writeFile(path.join(args.outputDir, 'data', 'native.json'), JSON.stringify(data));
      return { buildDir: args.outputDir };
    }
    if (command === 'assemble') {
      calls.assemble++;
      await cp(gameDir, args.outputDir, { recursive: true });
      await cp(args.buildDir, args.outputDir, { recursive: true });
      return { outputDir: args.outputDir, launchPath: path.join(args.outputDir, 'Game.exe') };
    }
    throw new Error(`Unexpected neutral worker command: ${command}`);
  };
  const create = async () => createService({ dataDir, worker, secrets, provider: textProvider, technicalProvider, coverageScanner, scriptTools: null, imageTools: null,
    adapterLab: await createAdapterLab({ dataDir: path.join(directory, 'recipes') }),
    adaptationProvider: async args => {
      const fault = await adaptationFault?.(args);
      if (fault) return fault;
      const result = await runAdaptation({ ...args, generate: input => generate({ ...input, assignment: args.assignment }) });
      calls.adaptations.push({ files: args.assignment?.files, status: result.status, reused: result.reused, reason: result.reason, error: result.error, stopReason: result.stopReason,
        ...(result.status !== 'verified' ? { events: result.state?.events?.slice(-8), continuation: result.continuation,
          executionWindow: result.state?.executionWindow, windowStop: result.state?.windowStop } : {}) });
      return result;
    },
  });
  let service = await create(), preserveEvidence = false;
  const settings = defaultSettings(); settings.pauseOnLocalFailure = strict; settings.concurrency = concurrency; settings.connection.model = 'neutral-pool-fixture'; settings.connection.apiKey = 'fixture-host-value';
  await service.saveSettings(settings);
  t.after(async () => { await service.close(); if (!preserveEvidence) await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); });
  return { directory, dataDir, gameDir, files, calls, before, preserveEvidence: () => { preserveEvidence = true; return directory; }, get workbenchDir() { return workbenchDir; }, get service() { return service; }, reopen: async () => { await service.close(); service = await create(); } };
}

async function saveNativeTranslation(service, projectId) {
  const native = (await service.listText({ projectId })).units[0];
  await service.saveText({ projectId, unitId: native.id, expectedRevision: native.revision, translation: '保留人工校对成果。', notes: '人工成果', action: 'confirm' });
}

async function checkProduct(f, project) {
  assert.equal(project.total, 1 + f.files.length);
  assert.equal(project.builds.length, 1);
  const product = project.builds[0].path;
  assert.deepEqual(JSON.parse(await readFile(path.join(product, 'data', 'native.json'), 'utf8')), { lines: ['保留人工校对成果。'], logic: { switch: 9 } });
  for (const [index, file] of f.files.entries()) assert.deepEqual(JSON.parse(await readFile(path.join(product, file), 'utf8')), { lines: [`译文：A complete hidden scene ${index + 1}.`], logic: { id: `keep-${index}` } });
  for (const [file, original] of f.before) assert.deepEqual(await readFile(path.join(f.gameDir, file)), original, `original ${file} remains unchanged`);
  assert.ok(f.calls.build >= 1); assert.equal(f.calls.assemble, 1);
  const text = (await f.service.listText({ projectId: project.id })).units;
  assert.equal(text.find(unit => unit.legacyId === 'native:0').notes, '人工成果');
}

for (const failureMode of ['throw', 'return']) test(`host storage errors (${failureMode}) pause the original adaptation instead of buying another round and manual retry retains siblings`, { timeout: 65000 }, async t => {
  const siblingEntered = deferred(), starts = new Map(), generated = new Map();
  let locked = true;
  const f = await fixture(t, { concurrency: 2,
    adaptationFault: async ({ assignment }) => {
      const file = assignment.files[0]; starts.set(file, (starts.get(file) ?? 0) + 1);
      if (file === files[1]) siblingEntered.resolve();
      if (locked && file === files[0]) {
        await deadline(siblingEntered.promise, 'the independent sibling did not enter the existing second lane');
        const error = Object.assign(new Error('A local progress file remains busy.'), { code: 'EBUSY' });
        if (failureMode === 'return') return { status: 'failed', error: { code: error.code, message: error.message } };
        throw error;
      }
    },
    generate: async ({ tools, assignment }) => {
      const file = assignment.files[0]; generated.set(file, (generated.get(file) ?? 0) + 1);
      await submit(tools, file);
    },
  });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  const initialState = createStore(f.dataDir);
  let originalRequestId;
  try { originalRequestId = initialState.one('projects', created.id).adaptationRequest.id; } finally { initialState.close(); }
  await saveNativeTranslation(f.service, created.id);
  await f.service.startProject({ projectId: created.id });
  const paused = await waitFor(f.service, created.id, project => project.status === 'paused');
  const diagnostic = () => JSON.stringify({ failureMode, starts: [...starts], generated: [...generated], outcomes: f.calls.adaptations, paused: { total: paused.total, adaptation: paused.adaptation } });
  assert.equal(paused.stage, '工作文件或磁盘需要处理');
  assert.match(paused.lastError, /文件被占用.*已保存的成果/);
  assert.equal(paused.adaptation.continuationNeeded, false);
  assert.equal(paused.adaptation.blocked, false);
  assert.equal(paused.adaptation.retryable, true);
  assert.equal(paused.total, 2, `already-running sibling result is committed before the storage pause: ${diagnostic()}`);
  assert.equal(paused.adaptation.integratedUnits, 1);
  assert.deepEqual(Object.fromEntries(starts), { [files[0]]: 1, [files[1]]: 1 });
  const state = createStore(f.dataDir);
  let requestId;
  try { requestId = state.one('projects', created.id).adaptationRequest.id; } finally { state.close(); }
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(starts.get(files[0]), 1, `no automatic second round or continuation window: ${diagnostic()}`);
  locked = false;
  await f.reopen();
  await f.service.retryAdaptation({ projectId: created.id });
  const completed = await waitFor(f.service, created.id);
  assert.equal(generated.get(files[1]), 1, `manual retry must reuse the committed sibling instead of buying it again: ${diagnostic()}`);
  assert.equal(starts.get(files[0]), 2, diagnostic());
  assert.equal(generated.get(files[0]), 1);
  assert.equal(generated.get(files[2]), 1, diagnostic());
  assert.equal(requestId, originalRequestId, 'the paused project kept its original adaptation request');
  await checkProduct(f, completed);
});

test('a host-created validation root failure pauses the actual service without another model repair window', { timeout: 30000 }, async t => {
  let generated = 0, sampleRoot;
  const f = await fixture(t, { concurrency: 1, resourceCount: 1, strict: true,
    generate: async ({ tools, assignment }) => { generated++; await submit(tools, assignment.files[0]); } });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  await saveNativeTranslation(f.service, created.id);
  const original = fs.promises.lstat;
  fs.promises.lstat = async (file, ...args) => {
    const resource = String(file);
    if (!sampleRoot && resource.startsWith(f.directory + path.sep) && path.basename(resource) === 'sample'
        && fs.existsSync(path.join(resource, 'data/extra-a.json'))) {
      sampleRoot = resource;
      throw Object.assign(new Error('Injected output-root inspection failure after real QuickJS write'), { code: 'ENOENT', syscall: 'lstat', path: path.resolve(resource) });
    }
    return original(file, ...args);
  };
  syncBuiltinESMExports();
  let paused;
  try {
    await f.service.startProject({ projectId: created.id });
    paused = await waitFor(f.service, created.id, project => project.status === 'paused');
  } finally { fs.promises.lstat = original; syncBuiltinESMExports(); }
  assert.ok(sampleRoot); assert.equal(generated, 1); assert.equal(paused.total, 1);
  assert.match(paused.lastError, /临时工作目录无法读取/);
  const validationId = path.basename(path.dirname(sampleRoot));
  const validationFile = path.join(path.dirname(path.dirname(path.dirname(sampleRoot))), 'validations', `${validationId}.json`);
  const validation = JSON.parse(await readFile(validationFile, 'utf8'));
  assert.equal(validation.error.code, 'HOST_VALIDATION_OUTPUT_UNAVAILABLE'); assert.equal(validation.error.hostFailure, true);
  assert.equal(validation.error.evidence.confirmation.kind, 'directory-present');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(generated, 1, 'a retained candidate is not automatically repurchased after a host error');
  assert.deepEqual(await readFile(path.join(f.gameDir, f.files[0])), f.before.get(f.files[0]));
});

for (const concurrency of [1, 2, 3, 9]) test(`independent resource adapters obey global concurrency ${concurrency} and merge with native output`, { timeout: 90000 }, async t => {
  let active = 0, peak = 0;
  const entered = [], firstWave = deferred(), release = deferred();
  const f = await fixture(t, { concurrency, resourceCount: Math.max(3, concurrency), generate: async ({ tools, assignment, signal }) => {
    assert.equal(assignment.files.length, 1);
    const file = assignment.files[0]; assert.ok(f.files.includes(file));
    active++; peak = Math.max(peak, active); entered.push(file);
    if (entered.length === concurrency) firstWave.resolve();
    try {
      await Promise.race([release.promise, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
      const context = await tools.inspect_context.execute({});
      assert.deepEqual(context.assignment.files, [file]);
      assert.ok(context.coverage.resources.every(item => item.file === file));
      const inventory = await tools.list_files.execute({ root: 'source', recursive: true });
      assert.ok(inventory.files.some(item => item.path === file));
      assert.ok(inventory.files.some(item => item.path !== file), 'read discovery spans the game copy while writes retain resource ownership');
      const foreign = f.files.find(item => item !== file);
      assert.match((await tools.write_adapter.execute(adapter(foreign))).error.message, /assignment.files/);
      await submit(tools, file);
    } finally { active--; }
  } });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  assert.equal(created.total, 1); assert.equal(created.coverage.needsAdaptation, true);
  await saveNativeTranslation(f.service, created.id);
  await f.service.startProject({ projectId: created.id });
  await deadline(firstWave.promise, 'parallel resource jobs did not enter');
  assert.equal(active, concurrency, 'first wave actually overlaps before being released');
  const connectionTest = await f.service.testConnection();
  assert.equal(connectionTest.ok, false);
  assert.match(connectionTest.message, /任务池正在处理模型请求/, 'technical children reserve the shared pool slots used by other model operations');
  release.resolve();
  const completed = await waitFor(f.service, created.id);
  const saved = createStore(f.dataDir);
  let published, admission;
  try {
    const current = saved.one('projects', created.id); published = current.publication;
    admission = { request: current.adaptationRequest, progress: current.adaptationProgress, tasks: saved.tasks(created.id).filter(task => task.kind === 'adaptation')
      .map(({ id, status, attempts, admissionWindowId, admissionPass, admissionCompletedJobs, error }) => ({ id, status, attempts, admissionWindowId, admissionPass, admissionCompletedJobs, error })) };
  } finally { saved.close(); }
  try {
    assert.equal(peak, concurrency); assert.deepEqual([...entered].sort(), f.files,
      JSON.stringify({ adaptations: f.calls.adaptations, admission, coverage: completed.coverage, stage: completed.stage }));
  } catch (error) {
    error.message += `\nPreserved neutral failure evidence: ${f.preserveEvidence()}`;
    throw error;
  }
  const binding = JSON.parse(await readFile(path.join(published.workbenchDir, published.compositeManifestRef.file), 'utf8'));
  assert.equal(binding.adapters.length, f.files.length);
  assert.deepEqual(binding.adapters.flatMap(item => item.files).sort(), f.files);
  await checkProduct(f, completed);
});

test('an active resource agent can inspect a sibling newly accepted location without acquiring its write scope', { timeout: 55000 }, async t => {
  const firstRead = deferred(), hostIntegrated = deferred(), firstSubmitted = deferred(), secondRead = deferred(), finishSibling = deferred();
  let active = 0, peak = 0, observed, firstError;
  const f = await fixture(t, { concurrency: 2, resourceCount: 2, strict: true,
    generate: async ({ tools, assignment }) => {
      active++; peak = Math.max(peak, active);
      try {
        if (assignment.files[0] === files[0]) {
          await deadline(firstRead.promise, 'the sibling did not read the initial location snapshot');
          try { await submit(tools, files[0]); }
          catch (error) { firstError = error; throw error; }
          finally { firstSubmitted.resolve(); }
          return;
        }
        const before = await tools.inspect_units.execute({ file: files[0] });
        assert.equal(before.total, 0, 'no supplemental location exists before the sibling submits');
        firstRead.resolve();
        await deadline(hostIntegrated.promise, 'the host did not formally integrate the sibling result');
        observed = await tools.inspect_units.execute({ file: files[0] });
        secondRead.resolve();
        await deadline(finishSibling.promise, 'the live-location assertion did not finish');
        assert.match((await tools.write_adapter.execute(adapter(files[0]))).error.message, /assignment.files/,
          'read access to the accepted location does not grant the sibling write scope');
        await submit(tools, files[1]);
      } finally { active--; }
    },
  });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  await saveNativeTranslation(f.service, created.id);
  await f.service.startProject({ projectId: created.id });
  try {
    await deadline(firstRead.promise, 'the two resource agents did not overlap');
    await deadline(firstSubmitted.promise, 'the sibling did not finish adapter validation and submission');
    assert.ifError(firstError);
    const integrated = await deadline(waitFor(f.service, created.id, project => project.total === 2),
      'the sibling adapter did not reach the host units table');
    assert.equal(integrated.total, 2);
    const rows = (await f.service.listText({ projectId: created.id })).units;
    assert.ok(rows.some(unit => unit.legacyId === 'extra-a:0'), 'wait for accepted host data, not a staged candidate');
    assert.equal(peak, 2);
    hostIntegrated.resolve();
    await deadline(secondRead.promise, 'the active sibling did not query the newly accepted location');
    assert.equal(observed.total, 1, 'an already active agent must see a sibling formally accepted location');
    assert.equal(observed.units[0].id, 'extra-a:0');
    assert.equal(observed.units[0].source, 'A complete hidden scene 1.');
    assert.equal(observed.units[0].locator.file, files[0]);
    assert.equal(observed.units[0].locator.pointer, '/lines/0');
  } finally { hostIntegrated.resolve(); finishSibling.resolve(); }
  const completed = await waitFor(f.service, created.id);
  assert.equal(observed.total, 1);
  await checkProduct(f, completed);
});

test('a coordinator recovery round expands to six independent lanes without restarting the project', { timeout: 90000 }, async t => {
  const firstWave = deferred(), release = deferred();
  let active = 0, peak = 0, coordinatorCalls = 0;
  const f = await fixture(t, { concurrency: 6, resourceCount: 7,
    coverageScanner: async args => {
      const coverage = await scanCoverage(args);
      return { ...coverage, structuralRecoveryWarnings: args.units.length === 1 ? 1 : 0 };
    },
    generate: async ({ tools, assignment }) => {
      if (!assignment?.files) {
        coordinatorCalls++;
        const candidate = await tools.write_adapter.execute(adapter(f.files[0]));
        const validation = await tools.validate_adapter.execute({ candidateId: candidate.candidateId });
        assert.equal(validation.passed, true, JSON.stringify(validation));
        await tools.submit_recipe.execute({ candidateId: candidate.candidateId, validationId: validation.validationId, metadata: {} });
        return;
      }
      active++; peak = Math.max(peak, active);
      if (active === 6) firstWave.resolve();
      try { await release.promise; await submit(tools, assignment.files[0]); }
      finally { active--; }
    },
  });
  t.after(() => release.resolve());
  const created = await f.service.createProject({ gameDir: f.gameDir });
  await saveNativeTranslation(f.service, created.id);
  await f.service.startProject({ projectId: created.id });
  try {
    await deadline(firstWave.promise, 'second round retained the first coordinator width instead of using six free slots');
    assert.equal(active, 6);
    assert.equal((await f.service.testConnection()).ok, false);
  } catch (error) {
    const state = await f.service.getProject({ projectId: created.id });
    throw new Error(`${error.message}: ${JSON.stringify({ coordinatorCalls, active, adaptations: f.calls.adaptations, status: state.status, error: state.lastError, adaptation: state.adaptation })}`);
  } finally { release.resolve(); }
  const completed = await waitFor(f.service, created.id);
  assert.equal(peak, 6);
  assert.equal(coordinatorCalls, 1);
  await checkProduct(f, completed);
});

test('resuming an unfinished joint resource job never schedules overlapping single-file writers', { timeout: 55000 }, async t => {
  const seen = [], entered = deferred();
  const f = await fixture(t, { concurrency: 6, strict: true, generate: async ({ assignment, signal }) => {
    seen.push(assignment.files);
    if (seen.length === 2) entered.resolve();
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  const seed = createStore(f.dataDir);
  try {
    const project = seed.one('projects', created.id);
    seed.put('projects', { ...project, adaptationRequest: { ...project.adaptationRequest,
      scopeRequests: [], jobs: [{ id: 'previous-joint-job', files: f.files.slice(0, 2) }, { id: 'previous-independent-job', files: [f.files[2]] }],
    } });
  } finally { seed.close(); }
  await f.reopen();
  await f.service.startProject({ projectId: created.id });
  try {
    await deadline(entered.promise, 'joint and independent resource jobs did not enter together');
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.deepEqual([...seen].sort((a, b) => a[0].localeCompare(b[0])), [f.files.slice(0, 2), [f.files[2]]]);
    assert.equal(new Set(seen.flat()).size, seen.flat().length);
  } finally { await f.service.cancelProject({ projectId: created.id }); }
});

test('cancelled resource pool reuses a completed recipe and preserves native edits after restart', { timeout: 55000 }, async t => {
  const enteredSecond = deferred();
  const sessions = new Map();
  let firstRun = true;
  const f = await fixture(t, { concurrency: 1, generate: async ({ tools, assignment, signal }) => {
    const file = assignment.files[0]; sessions.set(file, (sessions.get(file) ?? 0) + 1);
    if (firstRun && file === files[1]) {
      enteredSecond.resolve();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return;
    }
    await submit(tools, file);
  } });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  await saveNativeTranslation(f.service, created.id);
  await f.service.startProject({ projectId: created.id });
  await deadline(enteredSecond.promise, 'second resource did not start');
  await f.service.cancelProject({ projectId: created.id });
  const paused = await f.service.getProject({ projectId: created.id });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.total, 2, 'verified resource text was already committed before cancellation');
  assert.equal(paused.adaptation.integratedUnits, 1);
  assert.ok(paused.coverage.stale || paused.coverage.unitCount === paused.total, 'a fresh scan must include live-integrated text');
  assert.equal(paused.coverage.addedUnitsSinceScan, paused.coverage.stale ? 1 : 0);
  assert.equal((await f.service.getProject({ projectId: created.id, summaryOnly: true })).coverage.stale, paused.coverage.stale);
  firstRun = false;
  await f.reopen();
  await f.service.startProject({ projectId: created.id });
  const completed = await waitFor(f.service, created.id);
  assert.equal(completed.coverage.stale, false, 'the normal resume scan replaces the stale snapshot');
  assert.equal(completed.coverage.addedUnitsSinceScan, 0);
  assert.deepEqual(Object.fromEntries(sessions), { [files[0]]: 1, [files[1]]: 2, [files[2]]: 1 });
  assert.equal(f.calls.adaptations.filter(item => item.files[0] === files[0]).length, 1, 'committed resource never re-enters the model runner');
  await checkProduct(f, completed);
});

test('partial verified resources enter the workbench and only unresolved work resumes', { timeout: 65000 }, async t => {
  let repaired = false;
  const entries = [];
  const f = await fixture(t, { concurrency: 3, strict: true, generate: async ({ tools, assignment }) => {
    const file = assignment.files[0]; entries.push(file);
    if (!repaired && file === files[1]) return;
    await submit(tools, file);
  } });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  await saveNativeTranslation(f.service, created.id);
  await f.service.startProject({ projectId: created.id });
  const paused = await waitFor(f.service, created.id, project => project.status === 'paused');
  assert.equal(paused.total, 3); assert.equal(paused.adaptationPending, true);
  assert.equal(paused.adaptation.addedUnits, 2, JSON.stringify(paused.adaptation)); assert.equal(paused.adaptation.integratedUnits, 2);
  assert.ok(paused.adaptation.jobs.some(job => job.reason));
  const text = (await f.service.listText({ projectId: created.id })).units;
  const accepted = text.find(unit => unit.context.file === files[0]);
  await f.service.saveText({ projectId: created.id, unitId: accepted.id, expectedRevision: accepted.revision, translation: '保留补充人工成果。', notes: '补充人工备注', action: 'confirm' });
  repaired = true;
  await f.reopen();
  await f.service.grantAdaptationBudget({ projectId: created.id, grantId: 'explicit-repaired-resource-fixture', httpAttempts: 0, windows: 2,
    reason: 'Explicit retry after repairing the isolated unresolved fixture resource' });
  await f.service.startProject({ projectId: created.id });
  const completed = await waitFor(f.service, created.id);
  assert.equal(completed.total, 4); assert.equal(completed.adaptation.integratedUnits, 3);
  assert.equal(entries.filter(file => file === files[0]).length, 1); assert.equal(entries.filter(file => file === files[2]).length, 1);
  const current = (await f.service.listText({ projectId: created.id })).units.find(unit => unit.id === accepted.id);
  assert.equal(current.translation, '保留补充人工成果。'); assert.equal(current.notes, '补充人工备注');
  assert.equal(JSON.parse(await readFile(path.join(completed.builds[0].path, files[0]), 'utf8')).lines[0], '保留补充人工成果。');
});

test('empty model work pauses without automatic retries and model changes preserve usage accounting', { timeout: 50000 }, async t => {
  let calls = 0;
  const f = await fixture(t, { concurrency: 3, strict: true, generate: async () => { calls++; } });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  await f.service.startProject({ projectId: created.id });
  await waitFor(f.service, created.id, project => project.status === 'paused');
  const blocked = await f.service.getProject({ projectId: created.id });
  assert.equal(blocked.adaptation.blocked, false, JSON.stringify(blocked.adaptation)); assert.equal(blocked.adaptation.retryable, true);
  const before = calls;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(calls, before);
  const settings = (await f.service.snapshot()).settings; settings.connection.model = 'changed-neutral-model';
  await f.service.saveSettings(settings);
  const ready = await f.service.getProject({ projectId: created.id });
  assert.equal(ready.adaptation.blocked, false);
  assert.equal(ready.adaptation.reason, blocked.adaptation.reason, 'A new retry context preserves the actual previous stop reason');
  assert.equal(ready.adaptation.stopReason, blocked.adaptation.stopReason);
  await f.service.retryAdaptation({ projectId: created.id });
  await waitFor(f.service, created.id, project => project.status === 'paused');
  const retained = (await f.service.getProject({ projectId: created.id })).adaptation.accounting;
  assert.ok(calls > before, 'the new model can use a still-authorized window');
  assert.equal(retained.windowsUsed, blocked.adaptation.accounting.windowsUsed + 1);
  assert.equal(retained.remainingWindows, null, 'ordinary production meters windows without imposing a hidden allowance');
  assert.equal(retained.limitsEnforced, false);
  assert.deepEqual(retained.limits, blocked.adaptation.accounting.limits);
  assert.equal(retained.httpUsed, blocked.adaptation.accounting.httpUsed, 'the injected generator makes no real HTTP request');
});

for (const concurrency of [1, 3]) test(`published text gets a real slot before remaining adaptation at concurrency ${concurrency}`, { timeout: 65000 }, async t => {
  const events = [];
  let active = 0, peak = 0;
  const enter = () => { active++; peak = Math.max(peak, active); };
  const f = await fixture(t, { concurrency, resourceCount: 6,
    generate: async ({ tools, assignment }) => {
      enter(); events.push({ lane: 'technical', file: assignment.files[0] });
      try { await submit(tools, assignment.files[0]); } finally { active--; }
    },
    textProvider: async input => {
      enter(); events.push({ lane: 'text', ids: input.wire.payload.units.map(unit => unit.id) });
      try { await new Promise(resolve => setTimeout(resolve, 20)); return provider(input); } finally { active--; }
    },
  });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  await saveNativeTranslation(f.service, created.id);
  await f.service.startProject({ projectId: created.id });
  const completed = await waitFor(f.service, created.id);
  const firstText = events.findIndex(event => event.lane === 'text');
  const lastTechnical = events.findLastIndex(event => event.lane === 'technical');
  assert.ok(firstText !== -1 && firstText < lastTechnical, JSON.stringify(events));
  assert.ok(peak <= concurrency, `shared active work ${peak} exceeded ${concurrency}`);
  const saved = createStore(f.dataDir);
  try {
    const project = saved.one('projects', created.id);
    const accounting = Object.values(project.adaptationAccounting).at(-1);
    assert.equal(accounting.windows.length, 1, 'natural-boundary slot handoff must retain the same service admission window');
    assert.equal(saved.all('acceptance_receipts', created.id).filter(row => row.status === 'integrated').length, 6);
    assert.equal(project.publication.generation, 6);
  } finally { saved.close(); }
  await checkProduct(f, completed);
});
