import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { createAdapterLab } from '../technical/adaptation/adapter-lab.mjs';
import { createService } from './service.mjs';
import { productWorker } from '../../apps/desktop/electron/host.mjs';

const pythonPath = path.resolve(process.env.PINHAO_TEST_PYTHON ?? 'local/runtime/python/python.exe');
async function fixture(t, spawnProcess, nativeWorker) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-service-exit-')), gameDir = path.join(root, 'game');
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'scene.txt'), 'A complete neutral scene.');
  const worker = async (command, input) => {
    if (command === 'catalog') return { engines: [] };
    if (command === 'assistInfo') return { supported: false, modes: [] };
    if (command === 'probe') return { engine: 'Neutral', root: '.', capabilities: { extract: true, nativeBuild: true } };
    if (command === 'extract') {
      await mkdir(input.workspaceDir, { recursive: true });
      await writeFile(path.join(input.workspaceDir, 'manifest.json'), JSON.stringify({ units: { 'line:1': { controls: {} } } }));
      return { workspaceDir: input.workspaceDir, units: [{ id: 'line:1', source: 'A complete neutral scene.', kind: 'message', tokens: [], context: { file: 'scene.txt' } }], sourceFingerprint: 'neutral-exit-stable' };
    }
    if (command === 'roundtrip' || command === 'validate') return { valid: true, passed: true };
    throw new Error(`Unexpected neutral command ${command}`);
  };
  worker.closeExecution = nativeWorker?.closeExecution;
  let service;
  const lab = await createAdapterLab({ dataDir: path.join(root, 'recipes'), execution: { pythonPath, spawnProcess, programs: { fixture: process.execPath },
    authorize: async ({ projectId }) => Boolean(projectId && (await service.getProject({ projectId })).workspaceExecution.granted) } });
  service = await createService({ dataDir: path.join(root, 'profile'), worker, adapterLab: lab, scriptTools: null, imageTools: null,
    secrets: { encrypt: value => value, decrypt: value => value },
    coverageScanner: async () => ({ resources: [], dynamicCandidates: [], triggers: [], needsAdaptation: false, summary: {} }) });
  const project = await service.createProject({ gameDir });
  await service.setWorkspaceExecution({ projectId: project.id, granted: true });
  const workDir = path.join(root, 'project-script');
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { root, gameDir, workDir, projectId: project.id, lab, service };
}

test('A13 service close waits beyond its transport deadline for a managed process left by a finished technical window', { timeout: 15000 }, async t => {
  let exited = false, stops = 0;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { stops++; setTimeout(() => { exited = true; this.stdout.end(); this.stderr.end(); this.emit('close', null); }, 5300); } });
  const f = await fixture(t, () => child);
  const run = await f.lab.runWorkspace({ ...f, program: 'fixture', args: [] });
  // No active service task owns this run: it represents a prior saved execution window.
  const before = Date.now(), closing = f.service.close();
  await new Promise(resolve => setTimeout(resolve, 5100));
  assert.equal(exited, false);
  assert.equal((await f.service.getProject({ projectId: f.projectId })).total, 1, 'SQLite remains open until the process actually exits');
  await closing;
  assert.ok(Date.now() - before >= 5250); assert.equal(exited, true); assert.equal(stops, 1);
  const record = JSON.parse(await readFile(path.join(f.workDir, 'process-runs', `${run.runId}.json`), 'utf8'));
  assert.equal(record.status, 'cancelled'); assert.ok(record.finishedAt);
  await assert.rejects(f.lab.runWorkspace({ ...f, program: 'fixture', args: [] }), { code: 'WORKSPACE_EXECUTION_CLOSED' });
});

test('A13 full service close stops actual Python descendants and releases their exclusive Windows files', { skip: process.platform !== 'win32' || !existsSync(pythonPath), timeout: 15000 }, async t => {
  const f = await fixture(t);
  const child = "import ctypes,time,os;from ctypes import wintypes;f=ctypes.windll.kernel32.CreateFileW;f.restype=wintypes.HANDLE;f.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,wintypes.DWORD,wintypes.LPVOID,wintypes.DWORD,wintypes.DWORD,wintypes.HANDLE];h=f('child-locked.dat',0xC0000000,0,None,4,0x80,None);assert h not in (None,ctypes.c_void_p(-1).value);print('child-ready='+str(os.getpid()),flush=True);time.sleep(100)";
  const script = `import subprocess,sys,time\np=subprocess.Popen([sys.executable,'-u','-c',${JSON.stringify(child)}])\nprint('parent-ready',flush=True)\nwhile True:time.sleep(1)\n`;
  await f.lab.writeWorkspaceFile({ ...f, file: 'tree.py', content: script });
  const run = await f.lab.runWorkspace({ ...f, program: 'python', args: ['tree.py'] });
  let state;
  for (let i = 0; i < 80; i++) { state = await f.lab.readRun({ ...f, runId: run.runId }); if (state.content.includes('child-ready=')) break; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.match(state.content, /parent-ready/); assert.match(state.content, /child-ready=/);
  const pid = Number(/child-ready=(\d+)/.exec(state.content)[1]);
  const locked = path.join(f.workDir, 'child-locked.dat');
  await assert.rejects(rm(locked), error => ['EBUSY', 'EPERM', 'EACCES'].includes(error.code));
  await f.service.close();
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await writeFile(locked, 'tree exited before service close returned');
  const record = JSON.parse(await readFile(path.join(f.workDir, 'process-runs', `${run.runId}.json`), 'utf8'));
  assert.equal(record.status, 'cancelled'); assert.ok(record.finishedAt);
});

test('A13 full service close also waits for a delayed native codec beyond five seconds', { timeout: 15000 }, async t => {
  let exited = false;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {
    setTimeout(() => { exited = true; this.stdout.end(); this.stderr.end(); this.emit('close', null); }, 5300);
  } });
  const native = productWorker({ pythonPath: 'neutral-fixture', workerPath: 'worker.py', toolkitPath: '.', spawnProcess: () => child });
  const f = await fixture(t, undefined, native);
  const stopped = assert.rejects(native('build', {}), { name: 'AbortError' });
  const started = Date.now(), closing = f.service.close();
  await new Promise(resolve => setTimeout(resolve, 5100));
  assert.equal(exited, false); assert.equal((await f.service.getProject({ projectId: f.projectId })).total, 1);
  await closing; await stopped;
  assert.equal(exited, true); assert.ok(Date.now() - started >= 5250);
});
