import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';

test('Unicode-ranked skill names reach accepted records and the standalone build without retries', async (t) => {
  const base = path.resolve('local', 'core-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'glossary-unicode-'));
  const gameDir = path.join(root, 'original');
  await mkdir(gameDir);
  const words = new Map([['カウンター', '计数'], ['マーカー', '标记'], ['レベル', '等级']]);
  const translate = (source) => {
    let result = source;
    for (const [word, translation] of words) result = result.replaceAll(word, translation);
    return result.replace(/III$/u, 'Ⅲ').replace(/II$/u, 'Ⅱ').replace(/I$/u, 'Ⅰ');
  };
  const units = [...words.keys()].flatMap((word) => ['Ⅰ', 'Ⅱ', 'Ⅲ'].map((tier) => ({
    id: `Skills:${word}-${tier}`, source: `${word}${tier}`, kind: 'database_name', tokens: [], context: { file: 'Skills.json' },
  })));
  const nativeBuilds = [], requests = [];
  const worker = async (command, args) => {
    if (command === 'probe') return { engine: 'MZ' };
    if (command === 'extract') {
      await mkdir(args.workspaceDir, { recursive: true });
      return { units, workspaceDir: args.workspaceDir, sourceFingerprint: 'neutral-ranked-skills' };
    }
    if (command === 'roundtrip' || command === 'validate') return { ok: true };
    if (command === 'build') {
      nativeBuilds.push(args.translations);
      await mkdir(args.outputDir, { recursive: true });
      return { buildDir: args.outputDir };
    }
    if (command === 'assemble') {
      await mkdir(args.outputDir, { recursive: true });
      await writeFile(path.join(args.outputDir, 'Game.exe'), 'neutral executable fixture');
      return { outputDir: args.outputDir, launchPath: path.join(args.outputDir, 'Game.exe') };
    }
    throw new Error(`Unexpected worker command: ${command}`);
  };
  const service = await createService({ dataDir: path.join(root, 'data'), worker, scriptTools: null,
    secrets: { encrypt: (value) => value, decrypt: (value) => value },
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral fixture', selectedCandidateIds: [] }),
    provider: async ({ wire }) => {
      const payload = wire.payload; requests.push(payload);
      return { records: payload.units.map((unit) => ({ id: unit.id, translation: translate(unit.source), notes: '' })) };
    },
  });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); });
  const settings = defaultSettings(); settings.connection.model = 'neutral-fixture'; settings.proofreading = false;
  await service.saveSettings(settings);
  const project = await service.createProject({ gameDir });
  await service.startProject({ projectId: project.id });
  let finished;
  for (let attempt = 0; attempt < 400; attempt++) {
    finished = await service.getProject({ projectId: project.id });
    if (finished.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.equal(finished.status, 'completed'); assert.equal(finished.skipped, 0);
  assert.ok(finished.tasks.every((task) => task.attempts === 1));
  assert.ok(requests.every((request) => request.repairInstruction === undefined));
  const accepted = (await service.listText({ projectId: project.id })).units;
  assert.deepEqual(accepted.map((unit) => unit.translation), units.map((unit) => translate(unit.source)));
  assert.deepEqual(nativeBuilds.at(-1).map((record) => record.translation), accepted.map((unit) => unit.translation));
  assert.equal(finished.builds.length, 1);
});
