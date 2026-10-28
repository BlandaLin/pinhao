import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';

const testRoot = path.resolve('local/project-storage-flow-tests');
await mkdir(testRoot, { recursive: true });
const units = [
  { id: 'opening:1', kind: 'message', source: 'Welcome to the inn.', tokens: [], context: { file: 'Map001.json', event: 1, page: 1 } },
  { id: 'opening:2', kind: 'message', source: 'Is there a room tonight?', tokens: [], context: { file: 'Map001.json', event: 1, page: 1 } },
  { id: 'opening:3', kind: 'message', source: 'One room is still available.', tokens: [], context: { file: 'Map001.json', event: 1, page: 1 } },
];

async function eventually(operation, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('Timed out waiting for the storage flow');
}

async function fixture(t, { provider, beforeAssemble } = {}) {
  const root = await mkdtemp(path.join(testRoot, 'project-'));
  const gameDir = path.join(root, '旅店冒险'), dataDir = path.join(root, 'portable-app', 'data');
  await mkdir(gameDir);
  await writeFile(path.join(gameDir, 'original.txt'), 'original game stays unchanged');
  const calls = [], services = [];
  const worker = async (command, input) => {
    calls.push({ command, input });
    if (command === 'catalog') return { engines: [] };
    if (command === 'probe') return { engine: 'MV' };
    if (command === 'extract') {
      await mkdir(input.workspaceDir, { recursive: true });
      return { units, workspaceDir: input.workspaceDir, sourceFingerprint: 'storage-flow-baseline' };
    }
    if (['roundtrip', 'validate'].includes(command)) return { ok: true };
    if (command === 'build') {
      await mkdir(input.outputDir, { recursive: true });
      await writeFile(path.join(input.outputDir, 'translated.json'), JSON.stringify(input.translations));
      return { buildDir: input.outputDir };
    }
    if (command === 'assemble') {
      // The real native worker refuses an existing target; keep that contract in this fixture.
      await beforeAssemble?.(input);
      try { await stat(input.outputDir); throw Object.assign(new Error('Choose a new output directory'), { code: 'OUTPUT_EXISTS' }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await mkdir(input.outputDir, { recursive: true });
      await writeFile(path.join(input.outputDir, 'Game.exe'), 'isolated non-executable fixture');
      await writeFile(path.join(input.outputDir, 'dialogue.json'), JSON.stringify(input.translations ?? []));
      return { outputDir: input.outputDir, launchPath: path.join(input.outputDir, 'Game.exe') };
    }
    throw new Error(`Unexpected storage flow command: ${command}`);
  };
  const open = async (catalogDir = dataDir) => {
    const service = await createService({ dataDir: catalogDir, worker, scriptTools: null, provider,
      technicalProvider: async () => ({ decision: 'native', summary: 'Isolated storage fixture uses the native adapter', selectedCandidateIds: [] }),
      secrets: { encrypt: text => `fixture:${text}`, decrypt: value => value.slice(8) } });
    services.push(service);
    return service;
  };
  t.after(async () => {
    for (const service of services) await service.close();
    assert.equal(path.dirname(root), testRoot);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  });
  return { root, gameDir, dataDir, calls, open, service: await open() };
}

async function translateManually(service, projectId, suffix = '') {
  const rows = (await service.listText({ projectId })).units;
  for (const [number, unit] of rows.entries()) await service.saveText({ projectId, unitId: unit.id,
    translation: `旅店对话第${number + 1}句${suffix}`, expectedRevision: unit.revision });
}

test('explicitly reopening a current-layout project preserves accepted text and pauses interrupted work without model requests', async t => {
  let requests = 0;
  const f = await fixture(t, { provider: async () => { requests++; throw new Error('Reopening must not request the model'); } });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  await translateManually(f.service, project.id);
  await f.service.close();
  const database = new DatabaseSync(path.join(project.workspaceDir, 'pinhao.sqlite'));
  try {
    const row = JSON.parse(database.prepare('SELECT body FROM projects WHERE id = ?').get(project.id).body);
    row.status = 'running';
    database.prepare('UPDATE projects SET body = ? WHERE id = ?').run(JSON.stringify(row), project.id);
  } finally { database.close(); }
  const reopened = await f.open(path.join(f.root, 'second-portable-app', 'data'));
  assert.equal((await reopened.snapshot()).projects.length, 0);
  const detail = await reopened.reconnectProject({ workspaceDir: project.workspaceDir });
  assert.equal(detail.id, project.id);
  assert.equal(detail.status, 'paused');
  assert.equal(detail.total, 3);
  assert.equal((await reopened.listText({ projectId: project.id })).units[0].translation, '旅店对话第1句');
  await reopened.reconnectProject({ workspaceDir: project.workspaceDir });
  assert.equal((await reopened.snapshot()).projects.length, 1);
  assert.equal(requests, 0);
  assert.equal(await readFile(path.join(f.gameDir, 'original.txt'), 'utf8'), 'original game stays unchanged');
});

function databaseRows(file, tables) {
  const database = new DatabaseSync(file, { readOnly: true });
  try { return Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count])); }
  finally { database.close(); }
}

test('new imports keep readable adjacent projects and all growing text state out of the portable catalog', async t => {
  let requested = 0;
  const f = await fixture(t, { provider: async ({ signal }) => {
    requested++;
    return new Promise((_resolve, reject) => {
      const stop = () => reject(Object.assign(new Error('paused storage test'), { name: 'AbortError' }));
      if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
    });
  } });
  const settings = defaultSettings();
  settings.connection = { ...settings.connection, model: 'local-fixture', apiKey: 'not-a-real-test-key' };
  settings.proofreading = false;
  await f.service.saveSettings(settings);
  const project = await f.service.createProject({ gameDir: f.gameDir });
  assert.equal(project.workspaceDir, path.join(f.root, '旅店冒险-拼好工程'));
  assert.equal(f.calls.find(call => call.command === 'extract').input.gameDir, f.gameDir);
  assert.equal(f.calls.find(call => call.command === 'extract').input.workspaceDir, path.join(project.workspaceDir, 'workbench'));
  const marker = JSON.parse(await readFile(path.join(project.workspaceDir, 'pinhao-project.json'), 'utf8'));
  assert.equal(marker.id, project.id);
  const first = (await f.service.listText({ projectId: project.id })).units[0];
  await f.service.saveText({ projectId: project.id, unitId: first.id, expectedRevision: first.revision, translation: '欢迎来到旅店。' });
  await f.service.startProject({ projectId: project.id, mode: 'translation' });
  let lastState;
  await eventually(async () => {
    if (requested > 0) return true;
    const current = await f.service.getProject({ projectId: project.id });
    lastState = { status: current.status, stage: current.stage, lastError: current.lastError, tasks: current.tasks, runtime: current.runtime };
    if (['paused', 'completed', 'failed'].includes(current.status)) throw new Error(JSON.stringify({ status: current.status, stage: current.stage, lastError: current.lastError, tasks: current.tasks }));
    return false;
  }).catch(error => { throw new Error(`${error.message}: ${JSON.stringify(lastState)}`); });
  await f.service.cancelProject({ projectId: project.id });
  const paused = await f.service.getProject({ projectId: project.id });
  assert.equal(paused.status, 'paused');
  assert(paused.tasks.some(task => task.status === 'paused'));
  await f.service.close();
  const local = databaseRows(path.join(project.workspaceDir, 'pinhao.sqlite'), ['units', 'tasks', 'revisions']);
  assert.equal(local.units, 3); assert(local.tasks > 0); assert(local.revisions > 0);
  assert.deepEqual(databaseRows(path.join(f.dataDir, 'catalog.sqlite'), ['units', 'tasks', 'revisions']), { units: 0, tasks: 0, revisions: 0 });
  const reopened = await f.open();
  assert.equal((await reopened.getProject({ projectId: project.id })).status, 'paused');
  assert.equal((await reopened.listText({ projectId: project.id })).units.find(unit => unit.id === first.id).translation, '欢迎来到旅店。');
  assert.equal(requested, 1);
  assert.equal(await readFile(path.join(f.gameDir, 'original.txt'), 'utf8'), 'original game stays unchanged');
});

test('same-name projects claim new folders without adopting existing directories or joining different games', async t => {
  const f = await fixture(t);
  const collision = path.join(f.root, '旅店冒险-拼好工程');
  await mkdir(collision); await writeFile(path.join(collision, 'keep.txt'), 'unrelated existing folder');
  const first = await f.service.createProject({ gameDir: f.gameDir });
  const second = await f.service.createProject({ gameDir: f.gameDir });
  assert.equal(first.workspaceDir, `${collision} (2)`);
  assert.equal(second.workspaceDir, `${collision} (3)`);
  const anotherGame = path.join(f.root, 'other-library', '旅店冒险');
  await mkdir(anotherGame, { recursive: true });
  await writeFile(path.join(anotherGame, 'original.txt'), 'different game with the same folder name');
  const other = await f.service.createProject({ gameDir: anotherGame });
  assert.equal(other.workspaceDir, path.join(path.dirname(anotherGame), '旅店冒险-拼好工程'));
  assert.equal(new Set([first.id, second.id, other.id]).size, 3);
  assert.equal(await readFile(path.join(collision, 'keep.txt'), 'utf8'), 'unrelated existing folder');
  assert.equal((await f.service.snapshot()).projects.length, 3);
});

test('a rejected workspace location can be retried explicitly without hidden application-directory fallback', async t => {
  const f = await fixture(t);
  const blocked = path.join(f.root, 'not-a-directory'); await writeFile(blocked, 'keep this file');
  await assert.rejects(f.service.createProject({ gameDir: f.gameDir, workspaceParent: blocked }), error => error.code === 'WORKSPACE_LOCATION_REQUIRED');
  assert.equal((await f.service.snapshot()).projects.length, 0);
  assert.equal(await readFile(blocked, 'utf8'), 'keep this file');
  const selected = path.join(f.root, 'selected-work-drive'); await mkdir(selected);
  const project = await f.service.createProject({ gameDir: f.gameDir, workspaceParent: selected });
  assert.equal(project.workspaceDir, path.join(selected, '旅店冒险-拼好工程'));
  await translateManually(f.service, project.id);
  assert.equal(path.dirname((await f.service.buildProject({ projectId: project.id })).path), selected);
  assert(!(await readdir(f.dataDir)).includes('projects'));
  await assert.rejects(f.service.createProject({ gameDir: f.gameDir, workspaceParent: f.gameDir }), error => error.code === 'WORKSPACE_LOCATION_REQUIRED');
});

test('successful builds replace only old safe managed products beside the game and honor explicit output', async t => {
  const f = await fixture(t), project = await f.service.createProject({ gameDir: f.gameDir });
  await translateManually(f.service, project.id, '初版');
  const first = await f.service.buildProject({ projectId: project.id });
  assert.equal(first.path, path.join(f.root, '旅店冒险-汉化版'));
  await translateManually(f.service, project.id, '新版');
  const second = await f.service.buildProject({ projectId: project.id });
  assert.equal(path.dirname(second.path), f.root);
  await assert.rejects(stat(first.path), { code: 'ENOENT' });
  assert.equal((await f.service.getProject({ projectId: project.id })).builds.length, 1);
  const explicit = path.join(f.root, 'chosen-product');
  const custom = await f.service.buildProject({ projectId: project.id, outputDir: explicit });
  assert.equal(custom.path, explicit);
  assert.equal(custom.managedOwner, undefined);
  assert.deepEqual((await readdir(f.root)).filter(name => name.endsWith('.pinhao-reservation')), []);
  assert.equal(await readFile(path.join(f.gameDir, 'original.txt'), 'utf8'), 'original game stays unchanged');
});

test('managed products with saves or user edits survive automatic pruning', async t => {
  const f = await fixture(t), project = await f.service.createProject({ gameDir: f.gameDir });
  await translateManually(f.service, project.id, '第一版');
  const saved = await f.service.buildProject({ projectId: project.id });
  await mkdir(path.join(saved.path, 'save')); await writeFile(path.join(saved.path, 'save', 'Save01.rpgsave'), 'private save');
  await translateManually(f.service, project.id, '第二版');
  const edited = await f.service.buildProject({ projectId: project.id });
  await writeFile(path.join(edited.path, 'my-notes.txt'), 'user supplied notes');
  await translateManually(f.service, project.id, '第三版');
  const latest = await f.service.buildProject({ projectId: project.id });
  assert.equal(await readFile(path.join(saved.path, 'save', 'Save01.rpgsave'), 'utf8'), 'private save');
  assert.equal(await readFile(path.join(edited.path, 'my-notes.txt'), 'utf8'), 'user supplied notes');
  assert((await stat(latest.launchPath)).isFile());
  assert.equal((await f.service.getProject({ projectId: project.id })).builds.length, 3);
});

test('unregistering keeps project data and removing a new workspace preserves originals and standalone products', async t => {
  const f = await fixture(t), first = await f.service.createProject({ gameDir: f.gameDir });
  const kept = await f.service.deleteProject({ projectId: first.id });
  assert(kept.retainedPaths.includes(first.workspaceDir));
  assert((await stat(path.join(first.workspaceDir, 'pinhao.sqlite'))).isFile());
  const project = await f.service.createProject({ gameDir: f.gameDir });
  await translateManually(f.service, project.id);
  const product = await f.service.buildProject({ projectId: project.id });
  await f.service.deleteProject({ projectId: project.id, removeWorkspace: true });
  await assert.rejects(stat(project.workspaceDir), { code: 'ENOENT' });
  assert((await stat(product.launchPath)).isFile());
  assert.equal(await readFile(path.join(f.gameDir, 'original.txt'), 'utf8'), 'original game stays unchanged');
  assert.equal((await f.service.snapshot()).projects.length, 0);
});

test('a new catalog ignores old single-database files instead of migrating or deleting them', async t => {
  const f = await fixture(t);
  const oldFile = path.join(f.dataDir, 'pinhao.sqlite');
  await writeFile(oldFile, 'old profile bytes must not be opened as the new catalog');
  await f.service.close();
  const reopened = await f.open();
  assert.equal((await reopened.snapshot()).projects.length, 0);
  await reopened.createProject({ gameDir: f.gameDir });
  assert.equal(await readFile(oldFile, 'utf8'), 'old profile bytes must not be opened as the new catalog');
});

test('an offline project never recreates its workspace and reconnects without a leaked preparation or lost text', async t => {
  let modelRequests = 0;
  const f = await fixture(t, { provider: async () => { modelRequests++; throw new Error('Offline recovery must not buy translations.'); } });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  await translateManually(f.service, project.id, '已接受');
  const accepted = (await f.service.listText({ projectId: project.id })).units;
  await f.service.close();
  const offline = `${project.workspaceDir}-disconnected`;
  await rename(project.workspaceDir, offline);
  const reopened = await f.open();
  const missing = await reopened.getProject({ projectId: project.id });
  assert.equal(missing.status, 'paused');
  assert.match(missing.stage, /工程目录无法访问/);
  for (const method of ['startProject', 'continueAvailableText', 'retryAdaptation', 'buildProject']) {
    await assert.rejects(reopened[method]({ projectId: project.id }), { code: 'PROJECT_LOCATION_UNAVAILABLE' });
  }
  await assert.rejects(stat(project.workspaceDir), { code: 'ENOENT' });
  await rename(offline, project.workspaceDir);
  assert.equal((await reopened.getProject({ projectId: project.id })).workspaceDir, project.workspaceDir);
  assert.deepEqual((await reopened.listText({ projectId: project.id })).units, accepted);
  const cancellation = await Promise.race([
    reopened.cancelProject({ projectId: project.id }).then(() => 'settled'),
    new Promise(resolve => { const timer = setTimeout(() => resolve('hung'), 1000); timer.unref(); }),
  ]);
  assert.equal(cancellation, 'settled');
  const product = await reopened.buildProject({ projectId: project.id });
  assert.ok((await stat(product.launchPath)).isFile());
  assert.deepEqual((await reopened.listText({ projectId: project.id })).units, accepted);
  assert.equal(modelRequests, 0);
  assert.equal(await readFile(path.join(f.gameDir, 'original.txt'), 'utf8'), 'original game stays unchanged');
});

test('choosing an existing output parent creates a child there instead of reusing a product on the previous drive', async t => {
  const f = await fixture(t), project = await f.service.createProject({ gameDir: f.gameDir });
  await translateManually(f.service, project.id, '初版');
  const previous = await f.service.buildProject({ projectId: project.id });
  const selected = path.join(f.root, 'selected-product-parent');
  await mkdir(selected); await writeFile(path.join(selected, 'user-notes.txt'), 'Unrelated existing files.');
  const located = await f.service.buildProject({ projectId: project.id, outputParent: selected });
  assert.notEqual(located.path, previous.path);
  assert.equal(path.dirname(located.path), selected);
  assert.equal(path.basename(located.path), '旅店冒险-汉化版');
  assert.equal(await readFile(path.join(selected, 'user-notes.txt'), 'utf8'), 'Unrelated existing files.');
  const assemblies = f.calls.filter(call => call.command === 'assemble').length;
  assert.equal((await f.service.buildProject({ projectId: project.id, outputParent: selected })).path, located.path);
  assert.equal(f.calls.filter(call => call.command === 'assemble').length, assemblies);
  await translateManually(f.service, project.id, '新版');
  const latest = await f.service.buildProject({ projectId: project.id, outputParent: selected });
  assert.equal(path.dirname(latest.path), selected);
  await assert.rejects(stat(located.path), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(selected, 'user-notes.txt'), 'utf8'), 'Unrelated existing files.');
});

test('an externally occupied reserved output stays in place and never becomes a repair artifact', async t => {
  let occupied;
  const f = await fixture(t, { beforeAssemble: async input => {
    occupied = input.outputDir;
    await mkdir(occupied);
    await writeFile(path.join(occupied, 'external.txt'), 'Created outside this build after its name was reserved.');
  } });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  await translateManually(f.service, project.id);
  await assert.rejects(f.service.buildProject({ projectId: project.id }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(path.join(occupied, 'external.txt'), 'utf8'), 'Created outside this build after its name was reserved.');
  assert.deepEqual((await readdir(f.root)).filter(name => name.endsWith('.pinhao-reservation')), []);
  await assert.rejects(stat(path.join(project.workspaceDir, 'technical', 'build-repairs')), { code: 'ENOENT' });
  const local = new DatabaseSync(path.join(project.workspaceDir, 'pinhao.sqlite'), { readOnly: true });
  try {
    const record = JSON.parse(local.prepare('SELECT body FROM projects WHERE id=?').get(project.id).body);
    assert.equal(record.buildRepair, undefined);
    assert.notEqual(record.adaptationRequest?.kind, 'build-repair');
  } finally { local.close(); }
});
