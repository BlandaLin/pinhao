import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { sha256 } from '../exchange/index.mjs';

const testRoot = path.resolve('local', 'image-flow-tests');
await mkdir(testRoot, { recursive: true });
const wait = () => new Promise((resolve) => setTimeout(resolve, 10));
async function eventually(fn) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await wait(); }
  throw new Error('Image flow timed out');
}
async function setup(t, { enabled = true, imageCount = 1, overridePrepare, failApply = false, engine = 'MV' } = {}) {
  const root = await mkdtemp(path.join(testRoot, 'flow-'));
  const firstGame = path.join(root, 'first');
  await mkdir(path.join(firstGame, 'www', 'img', 'system'), { recursive: true });
  for (let i = 0; i < imageCount; i++) await writeFile(path.join(firstGame, 'www', 'img', 'system', `button${i}.png`), 'neutral-image-original');
  const calls = [], applications = [], nativeStages = [];
  const images = Array.from({ length: imageCount }, (_, i) => ({ file: `img/system/button${i}.png` }));
  const worker = async (command, args) => {
    if (command === 'catalog') return {};
    if (command === 'probe') return { engine, root: 'www' };
    if (command === 'extract') { await mkdir(args.workspaceDir, { recursive: true }); return { workspaceDir: args.workspaceDir, sourceFingerprint: sha256(args.gameDir), units: [{ id: 'Map001:00001', kind: 'dialogue', source: 'Hello', translation: 'Hello', tokens: [], file: 'data/Map001.json', context: { map: 'Map001', event: 1, page: 0, speaker: 'Lin', branch_path: [] } }], images }; }
    if (['roundtrip', 'validate'].includes(command)) { for (const row of args.translations ?? []) assert(!row.id.startsWith('image:')); return {}; }
    if (command === 'build') { for (const row of args.translations) assert(!row.id.startsWith('image:')); await mkdir(args.outputDir, { recursive: true }); return { buildDir: args.outputDir }; }
    if (command === 'assemble') {
      nativeStages.push('assemble');
      await cp(args.gameDir, args.outputDir, { recursive: true });
      for (const file of args.assetOverlayFiles ?? []) {
        const source = await readFile(path.join(args.assetOverlayDir, file.file));
        assert.equal(sha256(source), file.sha256);
        await writeFile(path.join(args.outputDir, 'www', file.file), source);
      }
      return { outputDir: args.outputDir };
    }
    throw new Error(`Unexpected ${command}`);
  };
  const prepare = async (args) => {
    calls.push({ offset: args.offset, gameDir: args.gameDir });
    if (overridePrepare) await overridePrepare(args);
    const i = args.offset;
    const file = `img/system/button${i}.png`, id = `image:button${i}`;
    const region = { left: 1, top: 1, width: 20, height: 20 };
    const source = i === 0 ? 'Start\nGame' : `Button ${i}`;
    return { units: [{ id, kind: 'image_text', source, tokens: [], context: { file, imageSourceHash: sha256('neutral-image-original'), region } }], binding: { format: 'pinhao-images-1', files: [{ relative: file, sourceHash: sha256('neutral-image-original'), regions: [{ id, source, box: region }] }] }, issues: [], nextOffset: i + 1, done: i + 1 >= imageCount };
  };
  const service = await createService({ dataDir: path.join(root, 'data'), worker, scriptTools: null, technicalProvider: async () => ({ decision: 'native', summary: 'Native fixture checked', selectedCandidateIds: [] }),
    secrets: { encrypt: (text) => Buffer.from(text).toString('base64'), decrypt: (text) => Buffer.from(text, 'base64').toString() },
    provider: async ({ wire, role }) => ({ records: wire.payload.units.map((unit) => ({ id: unit.id, translation: role === 'translation' ? `译${unit.source}` : unit.currentTranslation, notes: '' })) }),
    imageTools: { prepareImages: prepare, stageImageText: async args => {
      nativeStages.push('images');
      await mkdir(args.outputDir);
      const files = [];
      for (const file of args.binding.files) {
        const text = args.translations.find(row => row.id === file.regions[0].id).translation;
        const target = path.join(args.outputDir, file.relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, text);
        files.push({ file: file.relative, sha256: sha256(Buffer.from(text)) });
      }
      return { files, issues: [] };
    }, applyImageText: async (args) => {
      applications.push(args);
      if (failApply) throw new Error('optional redraw failed');
      for (const file of args.binding.files) {
        const record = args.translations.find((row) => row.id === file.regions[0].id);
        await writeFile(path.join(args.outputDir, file.relative), record.translation);
      }
      return { changed: args.binding.files.length, files: args.binding.files, issues: [] };
    } },
  });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); });
  const settings = defaultSettings(); settings.connection.model = 'neutral-model'; settings.processImages = enabled; await service.saveSettings(settings);
  return { root, firstGame, service, calls, applications, nativeStages };
}
async function finish(service, projectId) {
  return eventually(async () => { const detail = await service.getProject({ projectId }); if (detail.status === 'paused') throw new Error(detail.lastError); return detail.status === 'completed' && detail; });
}

test('image opt-out runs native flow without calling OCR or redraw', async (t) => {
  const { service, firstGame, calls, applications } = await setup(t, { enabled: false });
  const p = await service.createProject({ gameDir: firstGame }); await service.startProject({ projectId: p.id });
  const done = await finish(service, p.id);
  assert.equal(done.total, 1); assert.equal(calls.length, 0); assert.equal(applications.length, 0);
});

test('archive engines receive image overlays before their native container is assembled', async t => {
  const f = await setup(t, { engine: 'KiriKiri/KAG' });
  const p = await f.service.createProject({ gameDir: f.firstGame });
  await f.service.startProject({ projectId: p.id });
  const done = await finish(f.service, p.id);
  assert.deepEqual(f.nativeStages, ['images', 'assemble']);
  assert.equal(f.applications.length, 0);
  assert.equal(await readFile(path.join(done.builds[0].path, 'www/img/system/button0.png'), 'utf8'), '译Start\nGame');
  assert.equal(await readFile(path.join(f.firstGame, 'www/img/system/button0.png'), 'utf8'), 'neutral-image-original');
});
test('enabled images enter the shared text workflow after start and patch the nested resource root only', async (t) => {
  const { service, firstGame, calls, applications } = await setup(t);
  const p = await service.createProject({ gameDir: firstGame });
  assert.equal(calls.length, 0); assert.equal(p.total, 1);
  await service.startProject({ projectId: p.id }); const done = await finish(service, p.id);
  assert.equal(calls.length, 1); assert.equal(calls[0].gameDir, path.join(firstGame, 'www'));
  assert.equal(done.total, 2); assert.equal(done.done, 2);
  assert.equal(applications[0].outputDir, path.join(done.builds[0].path, 'www'));
  assert(applications[0].translations.every((row) => row.id.startsWith('image:')));
  assert.equal(await readFile(path.join(firstGame, 'www', 'img/system/button0.png'), 'utf8'), 'neutral-image-original');
  assert.equal(await readFile(path.join(done.builds[0].path, 'www', 'img/system/button0.png'), 'utf8'), '译Start\nGame');
});
test('optional OCR failure preserves original pictures and continues the native game', async (t) => {
  const { service, firstGame } = await setup(t, { overridePrepare: async () => { throw new Error('vision input unsupported'); } });
  const p = await service.createProject({ gameDir: firstGame }); await service.startProject({ projectId: p.id }); const done = await finish(service, p.id);
  assert.equal(done.total, 1); assert(done.issues.some((issue) => issue.category === 'image-text' && issue.message.includes('保留原图')));
  assert.equal(await readFile(path.join(done.builds[0].path, 'www', 'img/system/button0.png'), 'utf8'), 'neutral-image-original');
});
test('image cancellation resumes at the next committed file instead of repeating prior OCR', async (t) => {
  let block = true, entered = false;
  const { service, firstGame, calls } = await setup(t, { imageCount: 2, overridePrepare: async ({ offset, signal }) => {
    if (offset !== 1 || !block) return;
    entered = true;
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  const p = await service.createProject({ gameDir: firstGame }); await service.startProject({ projectId: p.id }); await eventually(() => entered);
  await service.pauseProject({ projectId: p.id }); await eventually(async () => (await service.getProject({ projectId: p.id })).tasks.some((task) => task.status === 'paused'));
  assert.equal((await service.listText({ projectId: p.id })).units.filter((unit) => unit.kind === 'image_text').length, 1);
  block = false; await service.startProject({ projectId: p.id }); const done = await finish(service, p.id);
  assert.equal(done.total, 3); assert.equal(calls.filter((call) => call.offset === 0).length, 1); assert.deepEqual(calls.map((call) => call.offset), [0, 1, 1]);
});
test('optional redraw failure records an issue while retaining the assembled originals', async (t) => {
  const { service, firstGame } = await setup(t, { failApply: true });
  const p = await service.createProject({ gameDir: firstGame }); await service.startProject({ projectId: p.id }); const done = await finish(service, p.id);
  assert(done.issues.some((issue) => issue.category === 'image-redraw'));
  assert.equal(await readFile(path.join(done.builds[0].path, 'www', 'img/system/button0.png'), 'utf8'), 'neutral-image-original');
});
test('a paused image task takes the replacement API key while retaining its committed file checkpoint', async (t) => {
  let block = true, entered = false;
  const seen = [];
  const { service, firstGame, calls } = await setup(t, { imageCount: 2, overridePrepare: async ({ offset, connection, signal }) => {
    seen.push([offset, connection.apiKey]);
    if (offset !== 1 || !block) return;
    entered = true;
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  const initial = (await service.snapshot()).settings; initial.connection.apiKey = 'old-image-key'; await service.saveSettings(initial);
  const p = await service.createProject({ gameDir: firstGame }); await service.startProject({ projectId: p.id }); await eventually(() => entered);
  await service.pauseProject({ projectId: p.id }); await eventually(async () => (await service.getProject({ projectId: p.id })).tasks.some((task) => task.status === 'paused'));
  const replacement = (await service.snapshot()).settings; replacement.connection.apiKey = 'new-image-key'; await service.saveSettings(replacement);
  block = false; await service.startProject({ projectId: p.id }); await finish(service, p.id);
  assert.deepEqual(seen, [[0, 'old-image-key'], [1, 'old-image-key'], [1, 'new-image-key']]);
  assert.equal(calls.filter((call) => call.offset === 0).length, 1);
});
