import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createNativeTools } from './native-tools.mjs';

const parent = path.resolve('local/source-materialization-tests');
await mkdir(parent, { recursive: true });

test('ASAR source materialization reuses unchanged members without another worker call', async t => {
  const directory = await mkdtemp(path.join(parent, 'case-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gameDir = path.join(directory, 'game'), workspaceDir = path.join(directory, 'workbench');
  const sourceRoot = path.join(directory, 'workbench-native-source');
  await mkdir(path.join(gameDir, 'resources'), { recursive: true });
  await mkdir(path.join(workspaceDir, 'technical'), { recursive: true });
  await mkdir(path.join(sourceRoot, 'resources/app/data'), { recursive: true });
  const archive = path.join(gameDir, 'resources/app.asar'), relative = 'resources/app/data/Menu.png';
  await writeFile(archive, 'archive baseline');
  await writeFile(path.join(workspaceDir, 'technical/product-source.json'), JSON.stringify({ archiveFormat: 'asar',
    sourceFiles: { 'resources/app.asar': createHash('sha256').update('archive baseline').digest('hex') },
    root: 'resources/app', nativeSource: sourceRoot, archiveLayouts: { archive: 'resources/app.asar', members: [{ file: 'data/Menu.png', unpacked: false }] } }));
  let calls = 0;
  const tools = createNativeTools({ worker: async (command, input) => {
    calls++;
    assert.equal(command, 'materialize_source');
    assert.deepEqual(input.files, [relative]);
    if (await readFile(archive, 'utf8') !== 'archive baseline') throw Object.assign(new Error('changed original'), { code: 'SOURCE_CHANGED' });
    await writeFile(path.join(sourceRoot, relative), 'image bytes');
    return { sourceRoot, materialized: 1, archived: true };
  } });
  const input = { gameDir, workspaceDir, files: [relative] };
  await Promise.all([tools.materializeSource(input), tools.materializeSource(input)]);
  assert.equal(calls, 1);
  await tools.materializeSource(input);
  assert.equal(calls, 1);
  await rm(path.join(sourceRoot, relative));
  await tools.materializeSource(input);
  assert.equal(calls, 2);
  for (const file of ['../outside.png', 'resources/app/../outside.png', 'resources/app/unknown.png', 'data/Menu.png']) {
    await assert.rejects(tools.materializeSource({ ...input, files: [file] }));
  }
  assert.equal(calls, 2);
  await writeFile(archive, 'changed archive baseline');
  await assert.rejects(tools.materializeSource(input), { code: 'SOURCE_CHANGED' });
  assert.equal(calls, 2);
});

test('loose source engines do not spawn an archive worker', async t => {
  const directory = await mkdtemp(path.join(parent, 'case-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspaceDir = path.join(directory, 'workbench');
  await mkdir(path.join(workspaceDir, 'technical'), { recursive: true });
  await writeFile(path.join(workspaceDir, 'technical/product-source.json'), JSON.stringify({ packed: false }));
  const tools = createNativeTools({ worker: () => { throw new Error('unexpected worker'); } });
  assert.equal((await tools.materializeSource({ gameDir: directory, workspaceDir, files: ['img/Menu.png'] })).archived, false);
});
