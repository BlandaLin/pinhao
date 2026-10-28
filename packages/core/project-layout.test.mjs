import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectWorkspace, ownsProjectWorkspace, createProductDirectory, releaseProductDirectory, PROJECT_LAYOUT } from './project-layout.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-project-layout-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const gameDir = path.join(root, 'Neutral Game');
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'original.dat'), 'Original game stays unchanged.');
  return { root, gameDir };
}

test('new projects claim readable sibling directories without adopting collisions or changing the original', async t => {
  const { root, gameDir } = await fixture(t), collision = path.join(root, 'Neutral Game-拼好工程');
  await mkdir(collision); await writeFile(path.join(collision, 'private.txt'), 'Existing unrelated directory.');
  const workspaceDir = await createProjectWorkspace({ id: 'new-project', gameDir });
  assert.equal(workspaceDir, `${collision} (2)`);
  const marker = JSON.parse(await readFile(path.join(workspaceDir, 'pinhao-project.json'), 'utf8'));
  assert.equal(marker.format, PROJECT_LAYOUT); assert.equal(marker.id, 'new-project');
  assert.equal(await ownsProjectWorkspace({ id: 'new-project', gameDir, workspaceDir }), true);
  assert.equal(await ownsProjectWorkspace({ id: 'other-project', gameDir, workspaceDir }), false);
  assert.equal(await ownsProjectWorkspace({ id: 'new-project', gameDir, workspaceDir: collision }), false);
  assert.equal(await readFile(path.join(collision, 'private.txt'), 'utf8'), 'Existing unrelated directory.');
  assert.deepEqual(await readdir(gameDir), ['original.dat']);
  assert.equal(await readFile(path.join(gameDir, 'original.dat'), 'utf8'), 'Original game stays unchanged.');
});

test('explicit writable parent is used, while missing parents and original-overlap fail without fallback', async t => {
  const { root, gameDir } = await fixture(t), alternate = path.join(root, 'alternate-work-drive');
  await mkdir(alternate);
  const workspace = await createProjectWorkspace({ id: 'alternate', gameDir, workspaceParent: alternate });
  assert.equal(path.dirname(workspace), alternate);
  await assert.rejects(createProjectWorkspace({ id: 'missing', gameDir, workspaceParent: path.join(root, 'does-not-exist') }), { code: 'WORKSPACE_LOCATION_REQUIRED' });
  await assert.rejects(createProjectWorkspace({ id: 'original-overlap', gameDir, workspaceParent: gameDir }), { code: 'WORKSPACE_LOCATION_REQUIRED' });
  assert.deepEqual(await readdir(gameDir), ['original.dat']);
  await assert.rejects(access(path.join(root, 'Neutral Game-拼好工程')), { code: 'ENOENT' });
});

test('concurrent output claims reserve fresh names without creating output or taking over an existing game', async t => {
  const { root, gameDir } = await fixture(t), workspaceDir = await createProjectWorkspace({ id: 'project', gameDir });
  const project = { id: 'project', name: 'Neutral Game', gameDir, workspaceDir };
  const old = path.join(root, 'Neutral Game-汉化版');
  await mkdir(old); await writeFile(path.join(old, 'save.dat'), 'User save.');
  const [first, second] = await Promise.all([createProductDirectory(project), createProductDirectory(project)]);
  assert.notEqual(first, second);
  assert.deepEqual([first, second].sort(), [`${old} (2)`, `${old} (3)`]);
  for (const directory of [first, second]) {
    await assert.rejects(access(directory), { code: 'ENOENT' });
    const reservation = path.join(path.dirname(directory), `.${path.basename(directory)}.pinhao-reservation`);
    assert.equal(await readFile(reservation, 'utf8'), project.id);
    await releaseProductDirectory(directory, 'wrong-project');
    await access(reservation);
    await releaseProductDirectory(directory, project.id);
    await assert.rejects(access(reservation), { code: 'ENOENT' });
  }
  assert.equal(await readFile(path.join(old, 'save.dat'), 'utf8'), 'User save.');
  await assert.rejects(createProductDirectory(project, gameDir), /原游戏目录之外/);
});

