import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeWorker } from '../../../apps/desktop/electron/host.mjs';
import { registerNativeFailure } from './native-failure.mjs';
import { adaptationTools } from '../adaptation.mjs';
import { inspectFilePage, readSlice } from './paths.mjs';

const sourceRoot = path.resolve(import.meta.dirname, '../../..');

test('actual bundled Python worker passes native failure evidence through desktop host into read_failure', async t => {
  const pythonPath = path.join(sourceRoot, 'local/runtime/python/python.exe');
  try { await access(pythonPath); } catch { t.skip('Bundled Windows Python is unavailable'); return; }
  const base = path.resolve('local/native-failure-host-tests');
  await mkdir(base, { recursive: true });
  const projectDir = await mkdtemp(path.join(base, 'case-')), gameDir = path.join(projectDir, 'original');
  await mkdir(path.join(gameDir, 'Fixture_Data'), { recursive: true });
  const originals = { 'UnityPlayer.dll': 'Neutral signature marker; never executed.',
    'Fixture_Data/first.bundle': 'UnityFS\0invalid-first', 'Fixture_Data/second.bundle': 'UnityFS\0invalid-second' };
  for (const [file, content] of Object.entries(originals)) await writeFile(path.join(gameDir, file), content);
  const worker = makeWorker({ pythonPath, workerPath: path.join(sourceRoot, 'adapters/python/worker.py'),
    toolkitPath: path.join(sourceRoot, 'kits/workbench-tutorial/toolkit'), dependencyDir: path.join(sourceRoot, 'local/dependencies'), timeoutMs: 30000 });
  t.after(async () => {
    await worker.closeExecution();
    assert.equal(path.dirname(projectDir), base);
    await rm(projectDir, { recursive: true, force: true, maxRetries: 3 });
  });
  const workspaceDir = path.join(projectDir, 'workbench');
  let caught;
  try { await worker('extract', { gameDir, workspaceDir, allowEmpty: true }); } catch (error) { caught = error; }
  assert.equal(caught?.code, 'NATIVE_TEXT_UNAVAILABLE');
  assert.equal(caught.diagnostic.engine, 'Unity');
  const failure = await registerNativeFailure({ error: caught, workspaceDir, projectDir });
  const session = adaptationTools({ project: { id: 'neutral-host' }, inventory: {}, failure, gameDir,
    workspaceDir: path.join(projectDir, 'task'), state: { attempts: 0, failures: {}, events: [] }, runtimePolicy: 'external',
    lab: { readResource: ({ gameDir, file, ...input }) => readSlice(gameDir, file, input),
      inspectFiles: ({ gameDir, limit }) => inspectFilePage(gameDir, { limit }) } });
  const summary = await session.tools.read_failure.execute({});
  assert.equal(JSON.stringify(summary).includes(projectDir), false);
  const page = await session.tools.read_failure.execute({ artifactId: caught.attemptId, file: 'attempt.json' });
  const attempt = JSON.parse(page.content);
  assert.equal(attempt.resources.length, 2);
  assert.ok(attempt.resources.every(item => item.status === 'failed' && item.error.message));
  await session.close();
  for (const [file, expected] of Object.entries(originals)) assert.equal(await readFile(path.join(gameDir, file), 'utf8'), expected);
});
