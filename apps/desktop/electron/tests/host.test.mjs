import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createGameSessions, existingPathWithin, gameExecutable, makeWorker, revealExportedFile, serviceMethods } from '../host.mjs';

test('host opens registered artifacts and rejects paths outside project', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pinhao-host-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'project'));
  await writeFile(path.join(dir, 'project', 'file.txt'), 'artifact');
  await writeFile(path.join(dir, 'outside.txt'), 'private');
  assert.equal(await existingPathWithin(path.join(dir, 'project', 'file.txt'), [path.join(dir, 'project')]), path.join(dir, 'project', 'file.txt'));
  await assert.rejects(existingPathWithin(path.join(dir, 'outside.txt'), [path.join(dir, 'project')]), /请选择/);
});

test('host validates a build executable before launching', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pinhao-launch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'Game.exe');
  await writeFile(executable, 'neutral fixture, never executed');
  const service = { getProjectContext: async () => ({ builds: [{ id: 'one', path: dir, launchPath: executable }] }) };
  assert.equal(await gameExecutable(service, { projectId: 'project' }), executable);
  await assert.rejects(gameExecutable({ getProjectContext: async () => ({ builds: [] }) }, { projectId: 'p' }), /先生成/);
});

test('worker reports missing executable as an actionable error', async () => {
  const worker = makeWorker({ pythonPath: 'pinhao-missing-python-executable', workerPath: 'worker.py', toolkitPath: '.', timeoutMs: 1000 });
  await assert.rejects(worker('probe', {}), error => {
    assert.match(error.message, /运行环境启动失败.*资源是否完整/);
    assert.equal(error.code, 'NATIVE_DEPENDENCY_MISSING');
    assert.equal(error.hostFailure, true);
    assert.deepEqual(error.diagnostic, { category: 'dependency', phase: 'spawn', engine: 'runtime', dependencyId: 'python-runtime', state: 'missing' });
    return true;
  });
});

test('native tools receive Windows data locations while unrelated secrets stay in the host', async () => {
  const previous = process.env.APPDATA;
  process.env.APPDATA = 'neutral-appdata';
  process.env.PINHAO_TEST_SECRET = 'neutral-private-value';
  try {
    let environment;
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    const worker = makeWorker({ pythonPath: 'fixture', workerPath: 'worker.py', toolkitPath: '.', dependencyDir: 'neutral-dependencies',
      spawnProcess: (_file, _args, options) => { environment = options.env; return child; } });
    const running = worker('catalog', {});
    child.stdout.write('{"ok":true,"result":{}}'); child.emit('close', 0);
    await running;
    assert.equal(environment.APPDATA, 'neutral-appdata');
    assert.equal(environment.PINHAO_UNITY_SCHEMA, path.join('neutral-dependencies', 'unity-schema', 'Pinhao.UnitySchema.exe'));
    assert.equal(environment.PINHAO_TEST_SECRET, undefined);
  } finally {
    if (previous === undefined) delete process.env.APPDATA; else process.env.APPDATA = previous;
    delete process.env.PINHAO_TEST_SECRET;
  }
});

test('worker cancellation settles only after the process closes', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { this.killed = true; },
  });
  const controller = new AbortController();
  const worker = makeWorker({ pythonPath: 'fixture', workerPath: 'worker.py', toolkitPath: '.', spawnProcess: () => child });
  let settled = false;
  const running = worker('extract', {}, { signal: controller.signal });
  const result = assert.rejects(running, { name: 'AbortError' }).then(() => { settled = true; });
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(child.killed, true);
  assert.equal(settled, false);
  child.emit('close', null);
  await result;
});

test('native worker close drains every started codec and rejects later work', async () => {
  const children = [];
  const worker = makeWorker({ pythonPath: 'fixture', workerPath: 'worker.py', toolkitPath: '.', spawnProcess: () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { this.killed = true; } });
    children.push(child); return child;
  } });
  const first = assert.rejects(worker('extract'), { name: 'AbortError' });
  const second = assert.rejects(worker('build'), { name: 'AbortError' });
  let closed = false;
  const closing = worker.closeExecution().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(children.every(child => child.killed)); assert.equal(closed, false);
  children[0].emit('close', null); await first;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  children[1].emit('close', null); await second; await closing;
  assert.equal(closed, true);
  await assert.rejects(worker('extract'), { code: 'WORKSPACE_EXECUTION_CLOSED' });
});

test('host reveals the exact exported ZIP, including destinations outside the project', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pinhao-export-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = path.join(dir, 'game-release.zip');
  const other = path.join(dir, 'other.zip');
  await writeFile(archive, 'exported fixture');
  await writeFile(other, 'unregistered fixture');
  const exported = new Set([path.resolve(archive)]);
  const shown = [];
  await revealExportedFile(archive, exported, target => shown.push(target));
  assert.deepEqual(shown, [archive]);
  await assert.rejects(revealExportedFile(other, exported, target => shown.push(target)), /先导出/);
  await rm(archive);
  await assert.rejects(revealExportedFile(archive, exported, target => shown.push(target)), /ENOENT/);
  assert.deepEqual(shown, [archive]);
  assert.equal(serviceMethods.has('cleanupProject'), true);
  assert.equal(serviceMethods.has('continueAvailableText'), true);
  assert.equal(serviceMethods.has('retryAdaptation'), true);
});

const fakeGame = () => Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });

test('game sessions reserve launch before spawning and retain the guard until exit', async () => {
  const sessions = createGameSessions();
  const child = fakeGame();
  let ready;
  const launched = sessions.launch('project', () => new Promise(resolve => { ready = resolve; }));
  let cleanups = 0;
  const clean = () => { cleanups++; return 'cleaned'; };
  await assert.rejects(sessions.cleanup('project', clean), /先关闭/);
  ready({ child, buildId: 'old-build', executable: 'Game.exe' });
  assert.equal(await launched, child);
  await assert.rejects(sessions.cleanup('project', clean), /先关闭/);
  assert.equal(await sessions.cleanup('other-project', clean), 'cleaned');
  child.emit('exit', 0);
  assert.equal(await sessions.cleanup('project', clean), 'cleaned');
  assert.equal(cleanups, 2);
});

test('game sessions release failed launches and exclude launches during cleanup', async () => {
  const sessions = createGameSessions();
  await assert.rejects(sessions.launch('project', async () => { throw new Error('spawn failed'); }), /spawn failed/);
  let finish;
  const cleaned = sessions.cleanup('project', () => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(sessions.launch('project', async () => ({ child: fakeGame() })), /项目文件正在处理中/);
  await assert.rejects(sessions.cleanup('project', () => {}), /项目文件正在处理中/);
  finish('done');
  assert.equal(await cleaned, 'done');
  await assert.rejects(sessions.cleanup('project', async () => { throw new Error('cleanup failed'); }), /cleanup failed/);
  assert.equal(await sessions.cleanup('project', () => 'retry'), 'retry');
});

test('game sessions prevent duplicate launches and handle exit before spawn return', async () => {
  const sessions = createGameSessions();
  const first = fakeGame();
  const second = fakeGame();
  await sessions.launch('project', async () => ({ child: first, buildId: 'first', executable: 'First.exe' }));
  await assert.rejects(sessions.launch('project', async () => ({ child: second })), /已经启动/);
  await sessions.launch('other-project', async () => ({ child: second, buildId: 'second', executable: 'Second.exe' }));
  first.emit('exit', 0);
  assert.equal(await sessions.cleanup('project', () => 'done'), 'done');
  await assert.rejects(sessions.cleanup('other-project', () => {}), /先关闭/);
  second.emit('exit', 0);
  const exited = fakeGame();
  exited.exitCode = 0;
  await sessions.launch('project', async () => ({ child: exited }));
  assert.equal(await sessions.cleanup('project', () => 'done'), 'done');
});
