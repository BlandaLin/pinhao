import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function eventually(check) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await pause(10); }
  throw new Error('Progressive planning fixture timed out');
}

async function fixture(t, options = {}) {
  const testRoot = path.resolve('local/progressive-planning-tests');
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(path.join(testRoot, 'project-'));
  const dataDir = path.join(root, 'data'), gameDir = path.join(root, 'original');
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'original.txt'), 'neutral source');
  const units = options.units ?? Array.from({ length: 200 }, (_, index) => ({
    id: `line-${index}`, kind: 'message', source: `A complete neutral scene ${index}. ` + 'The traveler visits the quiet village. '.repeat(3),
    context: { file: `scene-${index}.json` }, tokens: [],
  }));
  const gate = deferred(), requests = [], observations = [], commands = [];
  let service, project, held = options.held !== false, live = 0, peak = 0;
  const worker = async (command, args) => {
    commands.push(command);
    if (command === 'catalog') return {};
    if (command === 'probe') return { engine: 'MV' };
    if (command === 'extract') { await mkdir(args.workspaceDir, { recursive: true }); return { units, workspaceDir: args.workspaceDir }; }
    if (['roundtrip', 'validate'].includes(command)) return {};
    if (command === 'build') { await mkdir(args.outputDir, { recursive: true }); return { buildDir: args.outputDir }; }
    if (command === 'assemble') {
      assert.equal(live, 0, 'A product must not build while any request is live');
      await mkdir(args.outputDir, { recursive: true }); return { outputDir: args.outputDir };
    }
    throw new Error(`Unexpected command ${command}`);
  };
  service = await createService({ dataDir, worker, scriptTools: null, onChanged: () => {
    if (project) void service.getProject({ projectId: project.id }).then(detail => {
      observations.push(detail);
      options.observe?.(detail, service);
    });
  }, provider: async args => {
    const payload = args.wire.payload;
    requests.push({ ids: payload.units.map(unit => unit.id), role: args.role,
      material: payload.units.map(({ id, revision, currentTranslation }) => ({ id, revision, currentTranslation })) });
    live++; peak = Math.max(peak, live);
    try {
      if (requests.length > 1 && held && (options.held !== 'one' || requests.length === 2)) {
        await Promise.race([gate.promise, new Promise(resolve => {
          if (args.signal.aborted) resolve(); else args.signal.addEventListener('abort', resolve, { once: true });
        })]);
        args.signal.throwIfAborted();
      }
      return args.role === 'proofreading'
        ? { review: { protocol: 'pinhao-review-1', reviewedIds: payload.units.map(unit => unit.id), edits: [], issues: [] } }
        : { records: payload.units.map(unit => ({ id: unit.id, translation: `中性译文 ${unit.source}` })) };
    } finally { live--; }
  } });
  await service.saveSettings({ ...defaultSettings(), connection: { baseUrl: 'http://localhost:1/v1', model: 'neutral-progressive',
    contextWindow: 8192, maxOutputTokens: 2048 }, concurrency: options.concurrency ?? 3, proofreading: false });
  project = await service.createProject({ gameDir });
  t.after(async () => {
    held = false; gate.resolve(); await service.close();
    assert.ok(path.resolve(root).startsWith(testRoot + path.sep));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  });
  return { service, project, requests, observations, commands, dataDir,
    release() { held = false; gate.resolve(); }, get peak() { return peak; } };
}

test('first ready batch dispatches before the window is planned and fills configured concurrency', async t => {
  const f = await fixture(t);
  await f.service.startProject({ projectId: f.project.id, mode: 'translation' });
  await eventually(() => f.requests.length >= 4);
  const firstAfterSample = f.observations.find(detail => detail.tasks.length > 1);
  assert.equal(firstAfterSample.tasks.length, 2, 'Publish the first new task before constructing the rest of the window');
  assert.equal(f.peak, 3, 'Independent batches use all configured slots');
  assert.equal(f.commands.includes('assemble'), false, 'Planning gaps cannot start a premature product build');
  const concurrentIds = f.requests.slice(1).flatMap(request => request.ids);
  assert.equal(new Set(concurrentIds).size, concurrentIds.length, 'Overlapping pump calls cannot dispatch an input twice');
  f.release();
  await eventually(async () => (await f.service.getProject({ projectId: f.project.id })).status === 'completed');
  const submitted = f.requests.flatMap(request => request.ids);
  assert.equal(submitted.length, 200);
  assert.equal(new Set(submitted).size, 200);
  assert.ok(f.requests.every(request => request.role === 'translation'));
});

test('pause during progressive admission leaves remaining tasks unpaid and resumes accepted inputs only once', async t => {
  let paused;
  const f = await fixture(t, { observe(detail, service) {
    if (detail.tasks.length > 1 && !paused) paused = service.pauseProject({ projectId: detail.id });
  } });
  await f.service.startProject({ projectId: f.project.id, mode: 'translation' });
  await eventually(() => paused);
  await paused;
  await eventually(async () => (await f.service.getProject({ projectId: f.project.id })).runtime.active === 0);
  const count = f.requests.length;
  await pause(30);
  assert.equal(f.requests.length, count, 'No more requests after the pause');
  const detail = await f.service.getProject({ projectId: f.project.id });
  assert.equal(detail.status, 'paused');
  assert.ok(detail.tasks.every(task => task.status !== 'queued'));
  const acceptedSampleId = f.requests[0].ids[0];
  f.release();
  await f.service.startProject({ projectId: f.project.id, mode: 'translation' });
  await eventually(async () => (await f.service.getProject({ projectId: f.project.id })).status === 'completed');
  assert.equal(f.requests.flatMap(request => request.ids).filter(id => id === acceptedSampleId).length, 1);
});

test('capacity failure found after dispatch drains a sent sibling and preserves its paid result', async t => {
  const ordinary = index => ({ id: `line-${index}`, kind: 'message', source: 'A complete neutral paragraph. '.repeat(4),
    context: { file: `scene-${index}.json` }, tokens: [] });
  const f = await fixture(t, { concurrency: 2, held: 'one', units: [...Array.from({ length: 200 }, (_, index) => ordinary(index)),
    { ...ordinary(200), source: 'An indivisible long paragraph. '.repeat(3000) }] });
  await f.service.startProject({ projectId: f.project.id, mode: 'translation' });
  await eventually(() => f.requests.length >= 2);
  await eventually(async () => (await f.service.getProject({ projectId: f.project.id })).stage === '正在保存其余任务结果');
  const count = f.requests.length;
  assert.ok(count >= 2);
  f.release();
  const detail = await eventually(async () => { const value = await f.service.getProject({ projectId: f.project.id }); return value.status === 'paused' && value; });
  assert.equal(f.requests.length, count, 'An oversized later group must not trigger unpaid siblings');
  assert.equal(detail.stage, '模型容量需要调整');
  const store = createStore(f.dataDir);
  try {
    assert.equal(store.one('projects', f.project.id).lastFailure.code, 'TEXT_GROUP_CAPACITY_EXCEEDED');
    const paid = f.requests.flatMap(request => request.ids);
    const translated = store.units(f.project.id).filter(unit => unit.status === 'translated');
    assert.deepEqual(new Set(translated.map(unit => unit.id)), new Set(paid));
    assert.ok(store.units(f.project.id).some(unit => unit.status === 'pending'));
  } finally { store.close(); }
});

test('closing during admission stops further planning without building a product', async t => {
  let closing;
  const f = await fixture(t, { observe(detail, service) {
    if (detail.tasks.length > 1 && !closing) closing = service.close();
  } });
  await f.service.startProject({ projectId: f.project.id, mode: 'translation' });
  await eventually(() => Boolean(closing));
  await closing;
  const count = f.requests.length;
  await pause(30);
  assert.equal(f.requests.length, count);
  assert.equal(f.commands.includes('assemble'), false);
});

test('a manual edit during review admission replans later scopes against the new snapshot', async t => {
  let target, edited = false, edit;
  const f = await fixture(t, { held: false, observe(detail, service) {
    if (!edited && detail.tasks.some(task => task.role === 'proofreading')) {
      edited = true;
      edit = service.saveText({ projectId: detail.id, unitId: target.id,
        expectedRevision: target.revision, translation: '人工修订后的完整译文。' });
    }
  } });
  const originals = (await f.service.listText({ projectId: f.project.id, limit: 500 })).units;
  for (const unit of originals) {
    const next = await f.service.saveText({ projectId: f.project.id, unitId: unit.id,
      expectedRevision: unit.revision, translation: `已完成初翻 ${unit.source}` });
    target = next;
  }
  await f.service.startProject({ projectId: f.project.id, mode: 'proofreading' });
  await eventually(() => Boolean(edit)); await edit;
  await eventually(async () => (await f.service.getProject({ projectId: f.project.id })).status === 'completed');
  const deliveries = f.requests.flatMap(request => request.material).filter(unit => unit.id === target.id);
  assert.ok(deliveries.length);
  assert.ok(deliveries.every(unit => unit.currentTranslation === '人工修订后的完整译文。'), 'Later scopes must not dispatch the old round material');
  const final = (await f.service.listText({ projectId: f.project.id, limit: 500 })).units.find(unit => unit.id === target.id);
  assert.equal(final.translation, '人工修订后的完整译文。');
  assert.equal(final.status, 'proofread');
});
