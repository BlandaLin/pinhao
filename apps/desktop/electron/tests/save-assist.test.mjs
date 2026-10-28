import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createSaveAssist } from '../save-assist.mjs';
import { createGameSessions, productWorker } from '../host.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-save-host-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4 }));
  const filePath = path.join(root, 'Save01.lsd');
  await writeFile(filePath, 'neutral save');
  let state = { mode: 'save', connected: true, ready: true, actions: ['setGold'], gold: 20,
    saveFile: { path: filePath, sha256: createHash('sha256').update('neutral save').digest('hex') } };
  const calls = [];
  const service = { getProjectContext: async () => ({ id: 'project', engine: 'RPG Maker 2000/2003', gameDir: path.join(root, 'original'), workspaceDir: path.join(root, 'game-拼好工程'), builds: [{ id: 'build', path: path.join(root, 'build') }] }) };
  const worker = async (command, input) => {
    calls.push({ command, input });
    if (command === 'assistSaveWrite') {
      assert.equal(input.expectedSha256, state.saveFile.sha256);
      state = { ...state, gold: input.value, saveFile: { ...state.saveFile, sha256: '2'.repeat(64), backupPath: path.join(input.backupDir, 'before.lsd') } };
    }
    if (command === 'assistSaveBackups') return { saveFile: { ...state.saveFile }, backups: [{ id: 'a'.repeat(64), sha256: 'b'.repeat(64), createdAt: '2026-10-25T00:00:00Z', bytes: 12 }] };
    if (command === 'assistSaveRestore') {
      if (input.binding.buildId !== 'build') throw new Error('备份不属于当前成品，请重新选择');
      if (!input.expectedAbsent && input.expectedSha256 !== state.saveFile.sha256) throw new Error('存档版本已变化');
      state = { ...state, gold: 20, changed: true, backupCreated: !input.expectedAbsent,
        saveFile: { ...state.saveFile, sha256: '3'.repeat(64), backupPath: path.join(input.backupDir, 'before-restore.lsd') } };
    }
    return structuredClone(state);
  };
  const gameSessions = createGameSessions();
  const manager = createSaveAssist({ service, worker, gameSessions, dataDir: path.join(root, 'data') });
  return { root, manager, filePath, service, worker, gameSessions, calls };
}

test('save assistance binds the selected file and forwards the captured version with a private backup directory', async t => {
  const f = await fixture(t);
  assert.equal((await f.manager.snapshot({ projectId: 'project' })).connected, false);
  await f.manager.open({ projectId: 'project', filePath: f.filePath });
  const version = (await f.manager.snapshot({ projectId: 'project' })).saveFile.sha256;
  const result = await f.manager.command({ projectId: 'project', expectedSaveSha256: version, action: 'setGold', value: 50, filePath: 'ignored-unselected-file' });
  assert.equal(result.gold, 50);
  assert.equal(f.calls.at(-1).input.filePath, f.filePath);
  assert.equal(f.calls.at(-1).input.outputDir, path.join(f.root, 'build'));
  assert.equal(f.calls.at(-1).input.backupDir, path.join(f.root, 'game-拼好工程', 'assist-backups'));
  assert.deepEqual(f.calls.at(-1).input.binding, { projectId: 'project', buildId: 'build' });
  assert.equal(result.saveFile.backupDir, path.join(f.root, 'game-拼好工程', 'assist-backups'));
  assert.equal(result.mode, 'save');
  await assert.rejects(f.manager.command({ projectId: 'project', expectedSaveSha256: result.saveFile.sha256, action: 'transfer', value: 1 }), /当前存档/);
});

test('backup list and restore keep the selected binding, current version and closed-game lock', async t => {
  const f = await fixture(t);
  assert.equal((await f.manager.listBackups({ projectId: 'project' })).backups.length, 1);
  assert.equal(f.calls.at(-1).input.filePath, undefined);
  const opened = await f.manager.open({ projectId: 'project', filePath: f.filePath });
  const listed = await f.manager.listBackups({ projectId: 'project', filePath: 'ignored' });
  assert.equal(listed.backups.length, 1);
  const input = { projectId: 'project', backupId: listed.backups[0].id, expectedSaveSha256: opened.saveFile.sha256 };
  await assert.rejects(f.manager.restore({ ...input, backupId: '../arbitrary' }), /备份记录/);
  await assert.rejects(f.manager.restore({ ...input, expectedSaveSha256: '0'.repeat(64) }), /版本已变化/);
  const listeners = {};
  await f.gameSessions.launch('project', async () => ({ child: { once: (name, fn) => { listeners[name] = fn; }, exitCode: null, signalCode: null } }));
  const count = f.calls.length;
  await assert.rejects(f.manager.restore(input), /关闭/);
  await assert.rejects(f.manager.listBackups({ projectId: 'project' }), /关闭/);
  assert.equal(f.calls.length, count);
  listeners.exit();
  const restored = await f.manager.restore({ ...input, filePath: 'ignored', backupPath: 'ignored' });
  assert.equal(restored.gold, 20);
  assert.equal(f.calls.at(-1).input.filePath, undefined);
  assert.deepEqual(f.calls.at(-1).input.binding, { projectId: 'project', buildId: 'build' });
  assert.equal(restored.saveFile.backupDir, path.join(f.root, 'game-拼好工程', 'assist-backups'));
  f.service.getProjectContext = async () => ({ workspaceDir: f.root, builds: [{ id: 'new-build' }] });
  await assert.rejects(f.manager.restore({ ...input, expectedSaveSha256: restored.saveFile.sha256 }), /重新选择/);
});

test('opening and writing saves wait for a closed game and retain selection when launches block an edit', async t => {
  const f = await fixture(t);
  await f.manager.open({ projectId: 'project', filePath: f.filePath });
  const listeners = {};
  await f.gameSessions.launch('project', async () => ({ child: { once: (name, fn) => { listeners[name] = fn; }, exitCode: null, signalCode: null } }));
  const before = f.calls.length;
  assert.equal((await f.manager.snapshot({ projectId: 'project' })).ready, false);
  await assert.rejects(f.manager.command({ projectId: 'project', action: 'setGold', value: 5 }), /关闭/);
  await assert.rejects(f.manager.open({ projectId: 'project', filePath: f.filePath }), /关闭/);
  assert.equal(f.calls.length, before);
  listeners.exit();
  const version = (await f.manager.snapshot({ projectId: 'project' })).saveFile.sha256;
  assert.equal((await f.manager.command({ projectId: 'project', expectedSaveSha256: version, action: 'setGold', value: 6 })).gold, 6);
});

test('a new build invalidates the old save selection instead of using stale resource names', async t => {
  const f = await fixture(t);
  await f.manager.open({ projectId: 'project', filePath: f.filePath });
  f.service.getProjectContext = async () => ({ id: 'project', engine: 'RPG Maker 2000/2003', gameDir: f.root, builds: [{ id: 'new-build', path: f.root }] });
  const state = await f.manager.snapshot({ projectId: 'project' });
  assert.equal(state.connected, false);
  assert.match(state.detail, /重新选择/);
  await assert.rejects(f.manager.command({ projectId: 'project', action: 'setGold', value: 8 }), /重新选择/);
});

test('deleting a selected save returns an actionable waiting state and clears the stale selection', async t => {
  const f = await fixture(t);
  const loaded = await f.manager.open({ projectId: 'project', filePath: f.filePath });
  const before = f.calls.length;
  await rm(f.filePath);
  const state = await f.manager.snapshot({ projectId: 'project' });
  assert.equal(state.connected, false);
  assert.equal(state.ready, false);
  assert.match(state.detail, /移动或删除.*重新选择/);
  assert.equal(f.calls.length, before);
  assert.match((await f.manager.snapshot({ projectId: 'project' })).detail, /选择游戏存档/);
  await assert.rejects(f.manager.command({ projectId: 'project', expectedSaveSha256: loaded.saveFile.sha256, action: 'setGold', value: 8 }), /重新选择/);
  assert.equal((await f.manager.listBackups({ projectId: 'project' })).backups.length, 1);
  assert.equal((await f.manager.restore({ projectId: 'project', backupId: 'a'.repeat(64), expectedAbsent: true })).gold, 20);
  assert.equal(f.calls.at(-1).input.expectedAbsent, true);
  assert.equal(f.calls.at(-1).input.filePath, undefined);
  assert.equal(f.calls.at(-1).input.expectedSha256, undefined);
});

test('backup recovery after restart does not depend on a selected or decodable current save', async t => {
  const f = await fixture(t);
  const listed = await f.manager.listBackups({ projectId: 'project' });
  const version = listed.saveFile.sha256;
  const restored = await f.manager.restore({ projectId: 'project', backupId: listed.backups[0].id,
    expectedSaveSha256: version, filePath: 'ignored-renderer-target' });
  assert.equal(restored.gold, 20);
  assert.equal(restored.changed, true);
  assert.equal(f.calls.at(-1).input.filePath, undefined);
  await assert.rejects(f.manager.restore({ projectId: 'project', backupId: listed.backups[0].id }), /版本已变化/);
  await assert.rejects(f.manager.restore({ projectId: 'project', backupId: listed.backups[0].id,
    expectedAbsent: true, expectedSaveSha256: version }), /版本已变化/);
});

test('a save removed between stat and native read is treated as a missing selection', async t => {
  const f = await fixture(t);
  let removeDuringRead = false;
  const manager = createSaveAssist({ service: f.service, gameSessions: f.gameSessions, dataDir: f.root,
    worker: async (command, input) => {
      if (removeDuringRead && command === 'assistSaveRead') {
        await rm(f.filePath);
        throw Object.assign(new Error('native read failed'), { code: 'NATIVE_WORKER_ERROR' });
      }
      return f.worker(command, input);
    } });
  await manager.open({ projectId: 'project', filePath: f.filePath });
  removeDuringRead = true;
  const state = await manager.snapshot({ projectId: 'project' });
  assert.equal(state.connected, false);
  assert.match(state.detail, /移动或删除.*重新选择/);
});

test('worker conflicts retain the captured save instead of silently retrying an overwrite', async t => {
  const f = await fixture(t);
  const manager = createSaveAssist({ service: f.service, gameSessions: f.gameSessions, dataDir: f.root,
    worker: async (command, input) => {
      if (command === 'assistSaveWrite') throw new Error('存档已被游戏更新，请重新读取');
      return f.worker(command, input);
    } });
  const loaded = await manager.open({ projectId: 'project', filePath: f.filePath });
  await assert.rejects(manager.command({ projectId: 'project', expectedSaveSha256: loaded.saveFile.sha256, action: 'setGold', value: 70 }), /重新读取/);
  assert.equal((await manager.snapshot({ projectId: 'project' })).gold, 20);
});

test('a save deleted during a write clears selection and preserves the original error as its cause', async t => {
  const f = await fixture(t);
  const failure = Object.assign(new Error('native write failed'), { code: 'NATIVE_WORKER_ERROR' });
  let writes = 0;
  const manager = createSaveAssist({ service: f.service, gameSessions: f.gameSessions, dataDir: f.root,
    worker: async (command, input) => {
      if (command === 'assistSaveWrite') {
        writes++;
        await rm(f.filePath);
        throw failure;
      }
      return f.worker(command, input);
    } });
  const loaded = await manager.open({ projectId: 'project', filePath: f.filePath });
  await assert.rejects(manager.command({ projectId: 'project', expectedSaveSha256: loaded.saveFile.sha256, action: 'setGold', value: 70 }), error => {
    assert.match(error.message, /移动或删除.*重新选择/);
    assert.equal(error.cause, failure);
    return true;
  });
  assert.equal(writes, 1);
  assert.equal((await manager.snapshot({ projectId: 'project' })).connected, false);
  await assert.rejects(manager.command({ projectId: 'project', expectedSaveSha256: loaded.saveFile.sha256, action: 'setGold', value: 70 }), /重新选择/);
  assert.equal(writes, 1);
});

test('save host + real worker edits native LSD and keeps the exact original backup', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-native-save-host-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4 }));
  const pythonPath = process.env.PINHAO_PYTHON || await access(path.resolve('local/runtime/python/python.exe')).then(() => path.resolve('local/runtime/python/python.exe'), () => 'python');
  const filePath = path.join(root, 'Save01.lsd');
  await promisify(execFile)(pythonPath, ['-B', '-c', 'import sys;sys.path[:0]=["adapters/python","kits/workbench-tutorial/toolkit"];from pathlib import Path;from test_assist_legacy import lcf_fixture;Path(sys.argv[1]).write_bytes(lcf_fixture())', filePath], { windowsHide: true });
  const original = await readFile(filePath);
  const worker = productWorker({ pythonPath, workerPath: path.resolve('adapters/python/worker.py'), toolkitPath: path.resolve('kits/workbench-tutorial/toolkit'), dependencyDir: path.resolve('local/dependencies') });
  const service = { getProjectContext: async () => ({ engine: 'RPG Maker 2000/2003', gameDir: root, workspaceDir: path.join(root, 'game-拼好工程'), builds: [] }) };
  const manager = createSaveAssist({ service, worker, gameSessions: createGameSessions(), dataDir: path.join(root, 'data') });
  const loaded = await manager.open({ projectId: 'neutral', filePath });
  assert.equal(loaded.gold, 1234);
  assert.equal(loaded.editLimits.hp.max, 9999);
  const changed = await manager.command({ projectId: 'neutral', expectedSaveSha256: loaded.saveFile.sha256, action: 'setGold', value: 7654 });
  assert.equal(changed.gold, 7654);
  assert.deepEqual(await readFile(changed.saveFile.backupPath), original);
  assert.notDeepEqual(await readFile(filePath), original);
  const readback = await manager.snapshot({ projectId: 'neutral' });
  assert.equal(readback.gold, 7654);
  assert.equal(readback.saveFile.backupPath, changed.saveFile.backupPath);
  await assert.rejects(manager.command({ projectId: 'neutral', expectedSaveSha256: loaded.saveFile.sha256, action: 'setGold', value: 10 }), /版本已变化/);
  assert.equal((await manager.snapshot({ projectId: 'neutral' })).gold, 7654);
  const current = await readFile(filePath);
  const listed = await manager.listBackups({ projectId: 'neutral' });
  assert.equal(listed.backups.length, 1);
  const restored = await manager.restore({ projectId: 'neutral', backupId: listed.backups[0].id, expectedSaveSha256: changed.saveFile.sha256 });
  assert.equal(restored.gold, 1234);
  assert.deepEqual(await readFile(filePath), original);
  assert.deepEqual(await readFile(restored.saveFile.backupPath), current);
  assert.equal((await manager.listBackups({ projectId: 'neutral' })).backups.length, 2);

  const fresh = () => createSaveAssist({ service, worker, gameSessions: createGameSessions() });
  const damaged = Buffer.from('damaged current save');
  await writeFile(filePath, damaged);
  const restarted = fresh();
  const recoveryList = await restarted.listBackups({ projectId: 'neutral' });
  const originalSha = createHash('sha256').update(original).digest('hex');
  const healthy = recoveryList.backups.find(row => row.sha256 === originalSha);
  assert.equal(healthy.status, 'available');
  assert.equal(healthy.currentSha256, createHash('sha256').update(damaged).digest('hex'));
  const recovered = await restarted.restore({ projectId: 'neutral', backupId: healthy.id, expectedSaveSha256: healthy.currentSha256 });
  assert.deepEqual(await readFile(filePath), original);
  assert.deepEqual(await readFile(recovered.saveFile.backupPath), damaged);
  assert.equal(recovered.backupCreated, true);

  await rm(filePath);
  await writeFile(path.join(root, 'game-拼好工程', 'assist-backups', `${'f'.repeat(64)}.json`), '{broken');
  const missing = fresh();
  const missingList = await missing.listBackups({ projectId: 'neutral' });
  assert.equal(missingList.backups.filter(row => row.status === 'unavailable').length, 2);
  const absent = missingList.backups.find(row => row.sha256 === originalSha);
  assert.equal(absent.targetAbsent, true);
  const recreated = await missing.restore({ projectId: 'neutral', backupId: absent.id, expectedAbsent: true });
  assert.equal(recreated.backupCreated, false);
  assert.equal(recreated.changed, true);
  assert.deepEqual(await readFile(filePath), original);
});
