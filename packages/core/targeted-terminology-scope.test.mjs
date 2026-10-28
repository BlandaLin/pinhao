import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { sha256 } from '../exchange/index.mjs';

test('targeted evidence review never normalizes an out-of-scope name while full-project terminology stays readable', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-targeted-terminology-'));
  const gameDir = path.join(root, 'neutral-original'), dataDir = path.join(root, 'data');
  await mkdir(gameDir); const original = path.join(gameDir, 'original.txt');
  await writeFile(original, 'Immutable neutral original.'); const originalHash = sha256(await readFile(original));
  const units = [
    { id: 'question', source: 'Mina opens the door.', kind: 'dialogue' },
    { id: 'name', source: 'Mina', kind: 'character_name' },
    { id: 'vote-a', source: 'Mina answers the first question.', kind: 'dialogue' },
    { id: 'vote-b', source: 'Mina answers the second question.', kind: 'dialogue' },
  ].map((unit, index) => ({ ...unit, tokens: [], context: { file: 'neutral.json', event: index, actorId: 1,
    ...(unit.kind === 'dialogue' ? { speaker: 'Mina' } : {}) } }));
  const calls = [];
  const service = await createService({ dataDir, scriptTools: null,
    provider: async ({ role, wire }) => {
      assert.equal(role, 'proofreading');
      const payload = wire.payload; calls.push(payload);
      assert.ok(payload.glossary.some(entry => entry.source === 'Mina' && entry.translation === '米娜'),
        'Out-of-scope accepted decisions remain available as read-only terminology');
      return { review: { protocol: 'pinhao-review-1', reviewedIds: payload.units.map(unit => unit.id), edits: [], issues: [] } };
    },
    adaptationProvider: async () => { assert.fail('Native fixture must not invoke a technical model'); },
    worker: async (command, args) => {
      if (command === 'catalog') return { engines: [{ id: 'mz', name: 'RPG Maker MZ', extract: true, build: true }] };
      if (command === 'probe') return { engine: 'MZ' };
      if (command === 'extract') {
        await mkdir(args.workspaceDir, { recursive: true });
        return { units, workspaceDir: args.workspaceDir, sourceFingerprint: sha256(units) };
      }
      if (['roundtrip', 'validate'].includes(command)) return { ok: true };
      if (command === 'build') { await mkdir(args.outputDir, { recursive: true }); return { buildDir: args.outputDir }; }
      if (command === 'assemble') {
        await mkdir(args.outputDir, { recursive: true }); const launchPath = path.join(args.outputDir, 'Game.exe');
        await writeFile(launchPath, 'Neutral non-executed fixture.'); return { outputDir: args.outputDir, launchPath };
      }
      throw new Error(`Unexpected isolated worker command ${command}`);
    } });
  t.after(async () => {
    try { await service.close(); assert.equal(sha256(await readFile(original)), originalHash); }
    finally {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 30 });
    }
  });
  await service.saveSettings({ ...defaultSettings(), concurrency: 1,
    connection: { baseUrl: 'http://localhost:1/v1', model: 'neutral-in-memory-review' } });
  const project = await service.createProject({ gameDir });
  const db = createStore(dataDir);
  try {
    const translations = ['米娜开门了。', '美娜', '米娜回应了第一个问题。', '米娜回应了第二个问题。'];
    db.transaction(project.id, () => {
      db.units(project.id).forEach((unit, index) => {
        const next = { ...unit, status: 'proofread', translation: translations[index], revision: unit.revision + 1,
          ...(index >= 2 ? { termChoices: [{ source: 'Mina', translation: '米娜' }] } : {}),
          ...(index === 0 ? { review: { reviewId: 'prior-question', status: 'needs_evidence',
            issues: [{ unitId: unit.id, kind: 'needs_evidence', resolution: 'open', message: 'Neutral identity evidence needs review.' }] } } : {}) };
        db.putUnit(project.id, next, index); db.addRevision(project.id, next);
      });
      db.patchProject(project.id, { sampleValidation: { nativeStructure: 'passed' } });
    });
  } finally { db.close(); }
  const before = (await service.listText({ projectId: project.id, limit: 100 })).units;
  await service.startProject({ projectId: project.id, mode: 'review-issues' });
  let completed;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const detail = await service.getProject({ projectId: project.id });
    assert.notEqual(detail.status, 'paused', detail.lastError ?? detail.stage);
    if (detail.status === 'completed') { completed = detail; break; }
    await delay(10);
  }
  assert.ok(completed, 'The isolated targeted review must finish'); assert.ok(calls.length > 0);
  assert.deepEqual([...new Set(calls.flatMap(payload => payload.units.map(unit => unit.id)))], [before[0].id]);
  const after = (await service.listText({ projectId: project.id, limit: 100 })).units;
  for (const outside of before.slice(1)) assert.deepEqual(after.find(unit => unit.id === outside.id), outside,
    'Read-only terminology evidence must not become an implicit normalization target');
  assert.equal(after[0].review.status, 'proofread');
});
