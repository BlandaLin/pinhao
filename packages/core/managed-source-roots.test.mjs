import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createService } from './service.mjs';

async function fixture(t, mode) {
  const base = os.tmpdir(), root = await mkdtemp(path.join(base, 'pinhao-managed-source-'));
  const gameDir = path.join(root, 'game');
  await mkdir(gameDir);
  await writeFile(path.join(gameDir, 'native.json'), '{"text":"A complete source."}');
  let view, scan;
  const worker = async (command, input) => {
    if (command === 'catalog') return { engines: [], nativeRevision: 'managed-source-test' };
    if (command === 'probe') return { engine: 'MZ', root: '.', capabilities: { extract: true, nativeBuild: true } };
    if (command === 'extract') {
      await mkdir(path.join(input.workspaceDir, 'technical'), { recursive: true });
      await writeFile(path.join(input.workspaceDir, 'manifest.json'), JSON.stringify({ engine: 'MZ', units: { 'native:1': { controls: {} } } }));
      view = mode === 'outside' ? path.join(root, 'outside') : path.join(path.dirname(input.workspaceDir), 'managed-text');
      if (mode !== 'missing') await mkdir(view, { recursive: true });
      await writeFile(path.join(input.workspaceDir, 'technical/product-source.json'), JSON.stringify({ additionalSourceRoots: [view] }));
      return { workspaceDir: input.workspaceDir, sourceFingerprint: 'managed-source', units: [
        { id: 'native:1', kind: 'message', source: 'A complete source.', tokens: [], context: { file: 'native.json' } },
      ] };
    }
    if (command === 'roundtrip') return { byteIdentical: true };
    throw new Error(`Unexpected native command: ${command}`);
  };
  const service = await createService({ dataDir: path.join(root, 'profile'), worker, scriptTools: null, imageTools: null,
    coverageScanner: async input => { scan = input; return { unitCount: 1, needsAdaptation: false,
      resources: [{ file: 'native.json', kind: 'extracted' }], summary: { extracted: 1, unresolvedCandidates: 0 } }; } });
  t.after(async () => {
    await service.close();
    const relative = path.relative(base, root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  return { service, gameDir, view: () => view, scan: () => scan };
}

test('native additional text roots join coverage without replacing the image root', async t => {
  const f = await fixture(t, 'owned');
  const project = await f.service.createProject({ gameDir: f.gameDir });
  assert.ok(project.total === 1, project.lastError);
  assert.equal(f.scan().rootDir, f.gameDir);
  assert.deepEqual(f.scan().sourceRoots, [f.view()]);
});

test('native additional source roots outside the managed project are rejected', async t => {
  const f = await fixture(t, 'outside');
  const project = await f.service.createProject({ gameDir: f.gameDir });
  assert.match(project.lastError, /技术源目录须位于当前工程内/);
  assert.equal(f.scan(), undefined);
});

test('a missing native additional source is not silently treated as no remaining scripts', async t => {
  const f = await fixture(t, 'missing');
  const project = await f.service.createProject({ gameDir: f.gameDir });
  assert.match(project.lastError, /技术源目录不可读取/);
  assert.equal(f.scan(), undefined);
});
