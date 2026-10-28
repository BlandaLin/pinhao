import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveGameImport } from '../game-import.mjs';

test('drag import accepts folders, executables and RPG Maker resources without executing them', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-drop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '游戏 folder');
  await mkdir(directory);
  assert.deepEqual(await resolveGameImport(directory), { gameDir: directory });
  for (const name of ['Game.EXE', 'Game.rgss3a', 'Game.rmmzproject', 'RPG_RT.ldb']) {
    const file = path.join(directory, name);
    await writeFile(file, 'neutral fixture');
    assert.deepEqual(await resolveGameImport(file), { gameDir: directory });
  }
});

test('drag import resolves Windows shortcuts and explains compressed or unrelated files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-drop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['game.lnk', 'Game.exe', 'game.zip', 'notes.txt']) await writeFile(path.join(root, name), 'fixture');
  const shortcut = path.join(root, 'game.lnk');
  assert.deepEqual(await resolveGameImport(shortcut, () => ({ target: path.join(root, 'Game.exe') })), { gameDir: root });
  await assert.rejects(resolveGameImport(shortcut, () => ({ target: '' })), /快捷方式/);
  await assert.rejects(resolveGameImport(path.join(root, 'game.zip')), /先解压/);
  await assert.rejects(resolveGameImport(path.join(root, 'notes.txt')), /启动程序/);
  await assert.rejects(resolveGameImport(''), /拖入/);
});
