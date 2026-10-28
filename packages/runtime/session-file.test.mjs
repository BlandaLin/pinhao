import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeAssistSession, sessionFileName } from './session-file.mjs';

test('file runtimes get a launch-only configuration in root and www, removed after exit', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-launch-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'www'));
  await writeFile(path.join(root, 'www/index.html'), '<html>neutral</html>');
  const cleanup = await writeAssistSession(root, { PINHAO_ASSIST_DIR: 'neutral-session', PINHAO_ASSIST_TOKEN: 'neutral-token', PINHAO_ASSIST_BACKUP_DIR: 'neutral-backups' });
  for (const prefix of ['', 'www']) {
    const value = JSON.parse(await readFile(path.join(root, prefix, sessionFileName), 'utf8'));
    assert.equal(value.directory, 'neutral-session'); assert.equal(value.token, 'neutral-token');
    assert.equal(value.backupDir, 'neutral-backups');
  }
  await cleanup();
  await assert.rejects(access(path.join(root, sessionFileName)), { code: 'ENOENT' });
  await assert.rejects(access(path.join(root, 'www', sessionFileName)), { code: 'ENOENT' });
});

test('session cleanup preserves a newer launch file and installation preserves unrelated content', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-launch-preserve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, sessionFileName);
  const cleanup = await writeAssistSession(root, { PINHAO_ASSIST_DIR: 'neutral-session', PINHAO_ASSIST_TOKEN: 'one' });
  await writeFile(file, '{"schema":"pinhao-assist-session-v1","token":"newer"}');
  await cleanup();
  assert.equal(JSON.parse(await readFile(file, 'utf8')).token, 'newer');
  await writeFile(file, '{"user":"retained"}');
  await assert.rejects(writeAssistSession(root, { PINHAO_ASSIST_DIR: 'neutral-session', PINHAO_ASSIST_TOKEN: 'two' }), /重名/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).user, 'retained');
});

test('launch configuration keeps Unicode paths readable by legacy code-page readers', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-launch-unicode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = '测试/会话🌙', backupDir = '中性/备份';
  const cleanup = await writeAssistSession(root, { PINHAO_ASSIST_DIR: directory, PINHAO_ASSIST_TOKEN: 'neutral', PINHAO_ASSIST_BACKUP_DIR: backupDir });
  const bytes = await readFile(path.join(root, sessionFileName));
  assert.equal(bytes.every(byte => byte < 128), true);
  assert.equal(JSON.parse(bytes.toString('ascii')).directory, directory);
  assert.equal(JSON.parse(bytes.toString('ascii')).backupDir, backupDir);
  await cleanup();
});

test('a corrupt session is backed up outside the product before a new launch session is written', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-session-recover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'product'), backup = path.join(root, 'private-backups');
  await mkdir(output);
  const corrupt = Buffer.from('{"schema":"pinhao-assist-session-v1","token":"unfinished');
  await writeFile(path.join(output, sessionFileName), corrupt);
  const cleanup = await writeAssistSession(output, { PINHAO_ASSIST_DIR: backup, PINHAO_ASSIST_TOKEN: 'new-neutral-token', PINHAO_ASSIST_BACKUP_DIR: backup });
  const files = await readdir(backup);
  assert.equal(files.length, 1);
  assert.deepEqual(await readFile(path.join(backup, files[0])), corrupt);
  assert.equal(JSON.parse(await readFile(path.join(output, sessionFileName), 'utf8')).token, 'new-neutral-token');
  await cleanup();
  await assert.rejects(access(path.join(output, sessionFileName)), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(backup, files[0])), corrupt);
});

test('a corrupt session stays intact when the backup is inside the product or cannot be created', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-session-backup-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'product');
  await mkdir(output);
  const file = path.join(output, sessionFileName), corrupt = '{unfinished neutral session';
  await writeFile(file, corrupt);
  await assert.rejects(writeAssistSession(output, { PINHAO_ASSIST_DIR: path.join(output, 'backup'), PINHAO_ASSIST_TOKEN: 'neutral' }), /数据目录/);
  assert.equal(await readFile(file, 'utf8'), corrupt);
  const invalidBackup = path.join(root, 'not-a-directory');
  await writeFile(invalidBackup, 'retained unrelated file');
  await assert.rejects(writeAssistSession(output, { PINHAO_ASSIST_DIR: invalidBackup, PINHAO_ASSIST_TOKEN: 'neutral' }), { code: 'EEXIST' });
  assert.equal(await readFile(file, 'utf8'), corrupt);
  assert.equal(await readFile(invalidBackup, 'utf8'), 'retained unrelated file');
});
