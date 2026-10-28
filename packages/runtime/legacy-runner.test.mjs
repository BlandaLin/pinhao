import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installLegacyRunner } from './legacy-runner.mjs';

test('LCF runner is independent, preserves original player and fixes encoding in copied config', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-lcf-player-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, 'game'), dependencyDir = path.join(root, 'dependencies');
  await mkdir(outputDir); await mkdir(path.join(dependencyDir, 'easyrpg'), { recursive: true });
  await writeFile(path.join(outputDir, 'RPG_RT.ldb'), 'neutral fixture');
  await writeFile(path.join(outputDir, 'RPG_RT.exe'), 'original binary');
  await writeFile(path.join(outputDir, 'RPG_RT.ini'), '[RPG_RT]\r\nGameTitle=Original\r\n[EasyRPG]\r\nEncoding=932\r\n[Other]\r\nValue=keep\r\n');
  for (const file of ['Player.exe', 'COPYING', 'easyrpg-player-0.8.1.1.tar.gz', 'SOURCE.txt']) await writeFile(path.join(dependencyDir, 'easyrpg', file), 'neutral ' + file);
  const result = await installLegacyRunner({ outputDir, dependencyDir, encoding: '936' });
  assert.equal(await readFile(path.join(outputDir, 'RPG_RT.exe'), 'utf8'), 'original binary');
  assert.match(await readFile(path.join(outputDir, 'RPG_RT.ini'), 'utf8'), /Encoding=936/);
  assert.match(await readFile(path.join(outputDir, 'RPG_RT.ini'), 'utf8'), /Value=keep/);
  assert.equal(result.launchPath, path.join(outputDir, 'PinhaoPlayer.exe'));
  assert.deepEqual(result.launchArgs, ['--encoding', '936']);
  assert.match(await readFile(path.join(outputDir, 'PinhaoStart.cmd'), 'ascii'), /%~dp0PinhaoPlayer.exe/);
});
