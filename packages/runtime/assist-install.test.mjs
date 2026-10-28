import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { commitAssistFiles } from './assist-install.mjs';

test('rollback directory preparation failure has an empty verified write set', async () => {
  const result = await commitAssistFiles([{ file: 'unused', content: Buffer.from('never written') }], {
    createDirectory: async () => { throw Object.assign(new Error('neutral no space'), { code: 'ENOSPC' }); },
  });
  assert.equal(result.status, 'install_failed');
  assert.equal(result.restored, true);
  assert.deepEqual(result.recovery.files, []);
});

test('second optional install file failure restores every touched file', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-assist-transaction-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plugin = path.join(directory, 'plugin.js'), entry = path.join(directory, 'plugins.js');
  await writeFile(entry, 'original plugin list');
  const result = await commitAssistFiles([{ file: plugin, content: Buffer.from('new plugin') },
    { file: entry, content: Buffer.from('new list') }], { replace: async (source, target) => {
    if (target === entry) throw new Error('neutral second-file fault');
    return rename(source, target);
  } });
  assert.equal(result.status, 'install_failed');
  assert.equal(result.restored, true);
  assert.equal(await readFile(entry, 'utf8'), 'original plugin list');
  await assert.rejects(readFile(plugin), { code: 'ENOENT' });
  assert.equal(result.recovery.files.length, 2);
});

test('rollback preserves an unexpected external edit and blocks plain launch', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-assist-conflict-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plugin = path.join(directory, 'plugin.js'), entry = path.join(directory, 'plugins.js');
  await assert.rejects(commitAssistFiles([{ file: plugin, content: Buffer.from('new plugin') },
    { file: entry, content: Buffer.from('new list') }], { replace: async (source, target) => {
    if (target === entry) { await writeFile(plugin, 'external user edit'); throw new Error('fault'); }
    return rename(source, target);
  } }), { code: 'ASSIST_INSTALL_RECOVERY_REQUIRED', hostFailure: true });
  assert.equal(await readFile(plugin, 'utf8'), 'external user edit');
});
