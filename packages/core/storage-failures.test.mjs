import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { makeWorker } from '../../apps/desktop/electron/host.mjs';

async function fixture(t, { phase, failure } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-storage-failure-'));
  const gameDir = path.join(root, 'original'), dataDir = path.join(root, 'portable-data');
  await mkdir(path.join(gameDir, 'js'), { recursive: true });
  await mkdir(path.join(gameDir, 'data'));
  await writeFile(path.join(gameDir, 'Game.exe'), 'Neutral fixture is never launched.');
  await writeFile(path.join(gameDir, 'js', 'rmmz_core.js'), "var Utils = { RPGMAKER_VERSION: '1.0' };\n");
  await writeFile(path.join(gameDir, 'js', 'plugins.js'), 'var $plugins = [];\n');
  await writeFile(path.join(gameDir, 'data', 'System.json'), JSON.stringify({ gameTitle: 'Neutral storage game', currencyUnit: 'Coin', elements: ['', 'Fire'], terms: { basic: ['Level'] } }));
  const original = JSON.stringify({ displayName: 'Neutral inn', events: [null, { x: 0, y: 0, pages: [{ list: [
    { code: 101, indent: 0, parameters: ['', 0, 0, 2, 'Guide'] }, { code: 401, indent: 0, parameters: ['A complete neutral sentence.'] }, { code: 0, indent: 0, parameters: [] },
  ] }] }] });
  await writeFile(path.join(gameDir, 'data', 'Map001.json'), original);
  const native = makeWorker({ pythonPath: 'python', workerPath: path.resolve('adapters/python/worker.py'), toolkitPath: path.resolve('kits/workbench-tutorial/toolkit') });
  const calls = { model: 0, technical: 0, adaptation: 0, faults: 0 };
  let enabled = true;
  const worker = async (command, input, options) => {
    if (enabled && command === phase) { calls.faults++; await failure(command, input, native); }
    return native(command, input, options);
  };
  worker.closeExecution = native.closeExecution;
  const service = await createService({ dataDir, worker, scriptTools: null, imageTools: null,
    provider: async () => { calls.model++; throw new Error('Storage handling must not buy a text request.'); },
    technicalProvider: async () => { calls.technical++; throw new Error('Native preparation needs no technical request.'); },
    adaptationProvider: async () => { calls.adaptation++; return { status: 'needs-review', reason: 'Unexpected paid repair path', retryable: false }; } });
  await service.saveSettings({ ...defaultSettings(), proofreading: false, connection: { baseUrl: 'http://localhost:1/v1', model: 'storage-fixture' } });
  t.after(async () => { await service.close(); assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { root, gameDir, dataDir, service, calls, enable: value => { enabled = value; },
    originalIntact: async () => assert.equal(await readFile(path.join(gameDir, 'data', 'Map001.json'), 'utf8'), original),
    raw: projectId => { const store = createStore(dataDir); try { return store.one('projects', projectId); } finally { store.close(); } } };
}

async function acceptAll(service, projectId) {
  for (const [index, row] of (await service.listText({ projectId })).units.entries()) {
    await service.saveText({ projectId, unitId: row.id, expectedRevision: row.revision, translation: `中性存储测试文字${index}` });
  }
  return (await service.listText({ projectId })).units;
}

async function paused(service, projectId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const project = await service.getProject({ projectId });
    if (['paused', 'failed', 'completed'].includes(project.status)) return project;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Storage failure did not settle.');
}

function assertNoPaidRepair(f, projectId) {
  const project = f.raw(projectId);
  assert.equal(project.buildRepair, undefined);
  assert.notEqual(project.adaptationRequest?.kind, 'build-repair');
  assert.match(project.lastError, /工作磁盘/);
  assert.deepEqual({ model: f.calls.model, technical: f.calls.technical, adaptation: f.calls.adaptation }, { model: 0, technical: 0, adaptation: 0 });
}

for (const phase of ['build', 'assemble']) for (const code of ['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM']) {
  test(`a fault-injected host ${code} during real native ${phase} pauses without a model repair`, { timeout: 30000 }, async t => {
    const f = await fixture(t, { phase, failure: async () => { throw Object.assign(new Error(`Host operation failed: ${code}`), { code }); } });
    const project = await f.service.createProject({ gameDir: f.gameDir });
    const accepted = await acceptAll(f.service, project.id);
    await assert.rejects(f.service.buildProject({ projectId: project.id }), { code });
    assertNoPaidRepair(f, project.id);
    assert.deepEqual((await f.service.listText({ projectId: project.id })).units, accepted);
    await f.originalIntact();
  });
}

for (const code of ['ENOSPC', 'EACCES']) test(`native extraction host ${code} stays resumable without technical adaptation`, { timeout: 30000 }, async t => {
  const f = await fixture(t, { phase: 'extract', failure: async () => { throw Object.assign(new Error(`Host extraction failed: ${code}`), { code }); } });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  assert.equal(project.status, 'paused');
  assert.equal(f.raw(project.id).adaptationRequest, undefined);
  assertNoPaidRepair(f, project.id);
  f.enable(false);
  const recovered = await f.service.startProject({ projectId: project.id });
  assert.equal(recovered.status, 'ready');
  assert.ok(recovered.total > 0);
  assert.deepEqual({ model: f.calls.model, technical: f.calls.technical, adaptation: f.calls.adaptation }, { model: 0, technical: 0, adaptation: 0 });
  await f.originalIntact();
});

async function writeReadonly(file) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'Host-owned readonly sentinel.');
  await chmod(file, 0o444);
  try { await writeFile(file, 'This write should be denied by the real filesystem.'); }
  finally { await chmod(file, 0o666); }
}

test('an actual readonly-file write during automatic native build never dispatches an adaptation Agent', { timeout: 30000 }, async t => {
  let actualCode;
  const f = await fixture(t, { phase: 'build', failure: async (_command, input) => {
    try { await writeReadonly(path.join(input.outputDir, 'readonly-host-file')); }
    catch (error) { actualCode = error.code; throw error; }
  } });
  let denied;
  try { await writeReadonly(path.join(f.root, 'readonly-check')); } catch (error) { denied = error; }
  if (!denied) { t.skip('The current filesystem/user does not enforce readonly-file writes.'); return; }
  assert.ok(['EPERM', 'EACCES', 'EROFS'].includes(denied.code), denied.code);
  const project = await f.service.createProject({ gameDir: f.gameDir });
  const accepted = await acceptAll(f.service, project.id);
  // Start after native plan selection; this case isolates the automatic build's host-error path.
  const store = createStore(f.dataDir);
  try { store.patchProject(project.id, { technicalPlan: { decision: 'native-standard', selectedCandidateIds: [] } }); }
  finally { store.close(); }
  await f.service.startProject({ projectId: project.id });
  const stopped = await paused(f.service, project.id);
  assert.equal(stopped.status, 'paused');
  assert.equal(actualCode, denied.code);
  assertNoPaidRepair(f, project.id);
  assert.deepEqual((await f.service.listText({ projectId: project.id })).units, accepted);
  await f.originalIntact();
  t.diagnostic(JSON.stringify({ host: 'node-filesystem', actualCode, acceptedUnits: accepted.length, ...f.calls }));
});

test('an actual readonly write crosses the current Python worker error boundary without buying a repair', { timeout: 30000 }, async t => {
  let actualCode;
  const f = await fixture(t, { phase: 'build', failure: async () => {
    const probe = path.join(f.root, 'readonly-worker-probe'), target = path.join(probe, 'readonly-target.json');
    const driver = path.join(probe, 'readonly-worker.py'), sentinel = 'Host-owned readonly sentinel.';
    await mkdir(probe);
    // Exercise current non-optional writer/serializer without using an optional installer's safe failure result.
    await writeFile(driver, [
      'import sys', 'from pathlib import Path',
      `sys.path.insert(0, ${JSON.stringify(path.resolve('adapters/python'))})`, 'import worker',
      'def readonly_fixture_write(args):',
      '    worker.json_write(Path(args["filePath"]), {"text": "This actual filesystem write must be denied."})',
      'worker.COMMANDS["readonlyFixtureWrite"] = readonly_fixture_write', 'sys.exit(worker.main())', '',
    ].join('\n'));
    await writeFile(target, sentinel); await chmod(target, 0o444);
    const readonlyWorker = makeWorker({ pythonPath: 'python', workerPath: driver, toolkitPath: path.resolve('kits/workbench-tutorial/toolkit') });
    try { await readonlyWorker('readonlyFixtureWrite', { filePath: target }); }
    catch (error) { actualCode = error.code; throw error; }
    finally {
      await readonlyWorker.closeExecution();
      await chmod(target, 0o666);
      assert.equal(await readFile(target, 'utf8'), sentinel);
    }
  } });
  let denied;
  try { await writeReadonly(path.join(f.root, 'readonly-check')); } catch (error) { denied = error; }
  if (!denied) { t.skip('The current filesystem/user does not enforce readonly-file writes.'); return; }
  const project = await f.service.createProject({ gameDir: f.gameDir });
  const accepted = await acceptAll(f.service, project.id);
  await assert.rejects(f.service.buildProject({ projectId: project.id }), error => error.code === 'EACCES' || error.code === 'EPERM');
  assert.ok(['EACCES', 'EPERM'].includes(actualCode), actualCode);
  assertNoPaidRepair(f, project.id);
  assert.deepEqual((await f.service.listText({ projectId: project.id })).units, accepted);
  await f.originalIntact();
  t.diagnostic(JSON.stringify({ host: 'current-worker-json-write-and-main-via-test-command', actualCode, acceptedUnits: accepted.length, ...f.calls }));
});
