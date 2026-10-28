import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { sha256 } from '../exchange/index.mjs';

const testRoot = path.resolve('local/request-sync-recovery-tests');
await mkdir(testRoot, { recursive: true });
async function eventually(read) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for neutral request fixture');
}

test('a notes-only edit invalidates every queued member of its original sync group', async t => {
  const root = await mkdtemp(path.join(testRoot, 'queued-'));
  const gameDir = path.join(root, 'game');
  await mkdir(gameDir);
  await writeFile(path.join(gameDir, 'original.txt'), 'neutral original');
  const raw = [
    { id: 'sample', kind: 'message', source: 'Sample', tokens: [], context: { file: 'sample' } },
    ...Array.from({ length: 16 }, (_, index) => ({ id: `block-${index}`, kind: 'message', source: `Block ${index}`, tokens: [], context: { file: 'block' } })),
    ...Array.from({ length: 2 }, (_, index) => ({ id: `title-${index}`, kind: 'game_title', source: 'Neutral title', tokens: [], context: { file: `title-${index}`, syncGroup: 'title' } })),
  ];
  let release, blocked = false;
  const gate = new Promise(resolve => { release = resolve; });
  const requests = [];
  const worker = async (command, args) => {
    if (command === 'probe') return { engine: 'MV' };
    if (command === 'extract') {
      await mkdir(args.workspaceDir, { recursive: true });
      return { units: raw, workspaceDir: args.workspaceDir, sourceFingerprint: sha256(raw) };
    }
    if (['roundtrip', 'validate'].includes(command)) return { ok: true };
    if (command === 'build') { await mkdir(args.outputDir, { recursive: true }); return { buildDir: args.outputDir }; }
    if (command === 'assemble') { await mkdir(args.outputDir, { recursive: true }); return { outputDir: args.outputDir }; }
    throw new Error(`Unsupported neutral fixture command: ${command}`);
  };
  const service = await createService({ dataDir: path.join(root, 'data'), worker, scriptTools: null,
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral fixture' }),
    provider: async ({ prompt, signal, wire }) => {
      const payload = wire.payload;
      requests.push(payload.units);
      if (payload.units.some(unit => unit.source === 'Block 0')) {
        blocked = true;
        await Promise.race([gate, new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Paused neutral fixture')), { once: true }))]);
      }
      return { records: payload.units.map(unit => ({ id: unit.id, translation: `Translated ${unit.source}`, notes: '' })) };
    } });
  t.after(async () => {
    release();
    await service.close();
    assert.ok(path.resolve(root).startsWith(`${testRoot}${path.sep}`));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  await service.saveSettings({ ...defaultSettings(), connection: { baseUrl: 'http://localhost:1/v1', model: 'neutral' }, concurrency: 1, proofreading: false });
  const project = await service.createProject({ gameDir });
  await service.startProject({ projectId: project.id });
  await eventually(() => blocked);
  const title = (await service.listText({ projectId: project.id })).units.find(unit => unit.legacyId === 'title-0');
  await service.saveText({ projectId: project.id, unitId: title.id, translation: title.translation, notes: 'Only this note changes', expectedRevision: title.revision });
  release();
  const finished = await eventually(async () => { const current = await service.getProject({ projectId: project.id }); return ['completed', 'paused'].includes(current.status) && current; });
  assert.equal(finished.status, 'completed', finished.lastError);
  const titles = (await service.listText({ projectId: project.id })).units.filter(unit => unit.context.syncGroup === 'title');
  assert.deepEqual(titles.map(unit => unit.translation), ['Translated Neutral title', 'Translated Neutral title']);
  assert.equal(titles.find(unit => unit.id === title.id).notes, 'Only this note changes');
  assert.ok(requests.every(units => units.filter(unit => unit.context?.syncGroup === 'title').length !== 1), 'A queued sync group must never turn into a one-member model request');
});

for (const modelNote of ['', 'Model explanation']) test(`a first-sample retry retains unchanged candidates after one manual notes edit with ${modelNote ? 'nonempty' : 'empty'} model notes`, async t => {
  const root = await mkdtemp(path.join(testRoot, 'sample-'));
  const gameDir = path.join(root, 'game');
  await mkdir(gameDir);
  await writeFile(path.join(gameDir, 'original.txt'), 'neutral original');
  const raw = Array.from({ length: 3 }, (_, index) => ({ id: `line-${index}`, kind: 'message', source: `Line ${index}`, tokens: [], context: { file: 'scene' } }));
  const requests = [];
  let failSample = true;
  const worker = async (command, args) => {
    if (command === 'probe') return { engine: 'MV' };
    if (command === 'extract') {
      await mkdir(args.workspaceDir, { recursive: true });
      return { units: raw, workspaceDir: args.workspaceDir, sourceFingerprint: sha256(raw) };
    }
    if (['roundtrip', 'validate'].includes(command)) return { ok: true };
    if (command === 'build') {
      if (failSample) throw new Error('Neutral sample dependency');
      await mkdir(args.outputDir, { recursive: true });
      return { buildDir: args.outputDir };
    }
    if (command === 'assemble') { await mkdir(args.outputDir, { recursive: true }); return { outputDir: args.outputDir }; }
    throw new Error(`Unsupported neutral fixture command: ${command}`);
  };
  const service = await createService({ dataDir: path.join(root, 'data'), worker, scriptTools: null,
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral fixture' }),
    provider: async ({ prompt, wire }) => {
      const payload = wire.payload;
      requests.push(payload.units);
      return { records: payload.units.map(unit => ({ id: unit.id, translation: `Translated ${unit.source}`, notes: modelNote })) };
    } });
  t.after(async () => {
    await service.close();
    assert.ok(path.resolve(root).startsWith(`${testRoot}${path.sep}`));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  await service.saveSettings({ ...defaultSettings(), connection: { baseUrl: 'http://localhost:1/v1', model: 'neutral' }, concurrency: 1, proofreading: false });
  const project = await service.createProject({ gameDir });
  await service.startProject({ projectId: project.id });
  await eventually(async () => (await service.getProject({ projectId: project.id })).status === 'paused');
  assert.equal(requests.length, 1);
  const edited = (await service.listText({ projectId: project.id })).units[0];
  await service.saveText({ projectId: project.id, unitId: edited.id, translation: edited.translation, notes: 'Manual note', expectedRevision: edited.revision });
  failSample = false;
  await service.startProject({ projectId: project.id });
  await eventually(async () => (await service.getProject({ projectId: project.id })).status === 'completed');
  assert.equal(requests.length, 2, 'Only the changed pending item needs a fresh request; its note is not an approval');
  assert.deepEqual(requests[1].map(unit => unit.id), [edited.id]);
  for (const unit of raw.slice(1)) assert.equal(requests.flat().filter(record => record.source === unit.source).length, 1, 'Unchanged native-sample candidates are not requested again');
  const after = (await service.listText({ projectId: project.id })).units;
  assert.equal(after[0].translation, `Translated ${edited.source}`);
  assert.equal(after[0].notes, 'Manual note');
  assert.equal(after[0].notesOrigin, 'human');
  assert.ok(after.every(unit => unit.status === 'translated'), 'Changing a note is not a proofreading approval');
  assert.deepEqual(after.slice(1).map(unit => unit.translation), ['Translated Line 1', 'Translated Line 2']);
});

test('manual name confirmation preserves in-flight text candidates without regrouping duplicate requests', async t => {
  const root = await mkdtemp(path.join(testRoot, 'glossary-'));
  const gameDir = path.join(root, 'game');
  await mkdir(gameDir);
  await writeFile(path.join(gameDir, 'original.txt'), 'neutral original');
  const raw = Array.from({ length: 9 }, (_, index) => ({ id: `Actors:${index}:name`, kind: 'database_name', source: `Name${index}`, tokens: [], context: { file: 'Actors.json' } }));
  let release, blocked = false;
  const gate = new Promise(resolve => { release = resolve; });
  const textRequests = [];
  const worker = async (command, args) => {
    if (command === 'probe') return { engine: 'MV' };
    if (command === 'extract') {
      await mkdir(args.workspaceDir, { recursive: true });
      return { units: raw, workspaceDir: args.workspaceDir, sourceFingerprint: sha256(raw) };
    }
    if (['roundtrip', 'validate'].includes(command)) return { ok: true };
    if (command === 'build') { await mkdir(args.outputDir, { recursive: true }); return { buildDir: args.outputDir }; }
    if (command === 'assemble') { await mkdir(args.outputDir, { recursive: true }); return { outputDir: args.outputDir }; }
    throw new Error(`Unsupported neutral fixture command: ${command}`);
  };
  const service = await createService({ dataDir: path.join(root, 'data'), worker, scriptTools: null,
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral fixture' }),
    provider: async ({ prompt, signal, wire }) => {
      const payload = wire.payload;
      if (payload.task === 'translation') {
        textRequests.push(payload.units.map(unit => unit.source));
        if (!blocked) {
          blocked = true;
          await Promise.race([gate, new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Paused neutral fixture')), { once: true }))]);
        }
      }
      return { records: payload.units.map(unit => ({ id: unit.id,
        translation: `译名${unit.source.slice(4)}`, notes: '', termChoices: [{ source: unit.source, translation: `译名${unit.source.slice(4)}` }] })) };
    } });
  t.after(async () => {
    release();
    await service.close();
    assert.ok(path.resolve(root).startsWith(`${testRoot}${path.sep}`));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  await service.saveSettings({ ...defaultSettings(), connection: { baseUrl: 'http://localhost:1/v1', model: 'neutral' }, concurrency: 1, proofreading: false });
  const project = await service.createProject({ gameDir });
  await service.startProject({ projectId: project.id });
  await eventually(() => blocked);
  const edited = (await service.listText({ projectId: project.id })).units.find(unit => unit.source === 'Name0');
  await service.saveText({ projectId: project.id, unitId: edited.id, translation: '人工译名0', expectedRevision: edited.revision });
  await new Promise(resolve => setImmediate(resolve));
  release();
  const finished = await eventually(async () => { const current = await service.getProject({ projectId: project.id }); return ['completed', 'paused'].includes(current.status) && current; });
  assert.equal(finished.status, 'completed', finished.lastError);
  for (const unit of raw) assert.equal(textRequests.flat().filter(source => source === unit.source).length, 1, `${unit.source} must be requested once; accepted candidates from the original text batch stay reusable`);
  assert.equal((await service.listText({ projectId: project.id })).units.find(unit => unit.id === edited.id).translation, '人工译名0');
});
