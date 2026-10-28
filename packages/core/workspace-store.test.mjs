import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from './workspace-store.mjs';
import { createService, defaultSettings } from './service.mjs';
import { createProjectWorkspace, PROJECT_LAYOUT } from './project-layout.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-workspace-store-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const dataDir = path.join(root, 'portable-data');
  await mkdir(dataDir);
  return { root, dataDir };
}

const project = (root, id, extra = {}) => ({ id, name: `Neutral ${id}`, engine: 'MZ', status: 'ready',
  gameDir: path.join(root, `game-${id}`), workspaceDir: path.join(root, `game-${id}-workspace`),
  createdAt: '2026-10-24T00:00:00.000Z', ...extra });
const unit = (id, translation = 'Accepted translation.') => ({ id, source: 'Complete neutral source.', translation,
  status: 'translated', revision: 1, sourceHash: 'neutral-hash', notes: '' });

test('new catalog ignores an invalid old database and keeps growing project data beside its game', async t => {
  const { root, dataDir } = await fixture(t), sentinel = 'Old database must not be opened, migrated or deleted.';
  const oldDatabase = path.join(dataDir, 'pinhao.sqlite');
  await writeFile(oldDatabase, sentinel);
  const store = createStore(dataDir), row = project(root, 'first', { privateEvidence: 'Private material.'.repeat(10000) });
  try {
    assert.deepEqual(store.ids('projects'), []);
    store.put('settings', { id: 'global', concurrency: 9 });
    store.put('projects', row);
    store.putUnit(row.id, unit('shared'), 0);
    store.addRevision(row.id, unit('shared'));
    store.putTask(row.id, { id: 'task-first', projectId: row.id, fingerprint: 'first-task', status: 'paused', candidateRecords: [{ id: 'shared', translation: 'Saved paid result.' }] });
    assert.equal(store.one('projects', row.id).privateEvidence.length, row.privateEvidence.length);
    const head = JSON.parse(store.db.prepare('SELECT body FROM projects WHERE id=?').get(row.id).body);
    assert.deepEqual(Object.keys(head).sort(), ['createdAt', 'engine', 'gameDir', 'id', 'name', 'workspaceDir']);
    for (const table of ['units', 'revisions', 'tasks', 'builds', 'issues', 'imports']) assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
    assert.equal(store.one('settings', 'global').concurrency, 9);
    await access(path.join(row.workspaceDir, 'pinhao.sqlite'));
  } finally { store.close(); }
  assert.equal(await readFile(oldDatabase, 'utf8'), sentinel);
  const reopened = createStore(dataDir);
  try {
    assert.equal(reopened.unit(row.id, 'shared').translation, 'Accepted translation.');
    assert.equal(reopened.revision(row.id, 'shared', 1).translation, 'Accepted translation.');
    assert.equal(reopened.one('tasks', 'task-first').candidateRecords[0].translation, 'Saved paid result.');
  } finally { reopened.close(); }
});

test('scoped duplicate unit IDs and task lookups remain separate after reopening the catalog', async t => {
  const { root, dataDir } = await fixture(t);
  let store = createStore(dataDir);
  try {
    for (const id of ['first', 'second']) {
      store.put('projects', project(root, id));
      store.putUnit(id, unit('shared-unit', `${id} translation.`), 0);
      store.putTask(id, { id: `task-${id}`, projectId: id, fingerprint: `fingerprint-${id}`, status: 'paused' });
    }
  } finally { store.close(); }
  store = createStore(dataDir);
  try {
    assert.equal(store.unit('first', 'shared-unit').translation, 'first translation.');
    assert.equal(store.unit('second', 'shared-unit').translation, 'second translation.');
    assert.equal(store.one('tasks', 'task-second').projectId, 'second');
    assert.equal(store.one('tasks', 'task-first').projectId, 'first');
    assert.equal(store.taskByFingerprint('second', 'fingerprint-second').id, 'task-second');
    assert.deepEqual(store.tasks('first').map(row => row.id), ['task-first']);
  } finally { store.close(); }
});

test('project transactions roll back text, revisions, tasks and project changes together', async t => {
  const { root, dataDir } = await fixture(t), store = createStore(dataDir);
  try {
    store.put('projects', project(root, 'first'));
    store.put('projects', project(root, 'second'));
    assert.throws(() => store.transaction('first', () => {
      store.putUnit('first', unit('rollback'), 0);
      store.addRevision('first', unit('rollback'));
      store.putTask('first', { id: 'rollback-task', fingerprint: 'rollback-task', status: 'running' });
      store.patchProject('first', { name: 'Uncommitted name' });
      throw new Error('Rollback all project changes.');
    }), /Rollback all project changes/);
    assert.equal(store.unit('first', 'rollback'), undefined);
    assert.equal(store.revision('first', 'rollback', 1), undefined);
    assert.equal(store.one('tasks', 'rollback-task'), undefined);
    assert.equal(store.one('projects', 'first').name, 'Neutral first');
    assert.throws(() => store.transaction('first', () => store.putUnit('second', unit('wrong-owner'), 0)), /同一个工程/);
    assert.equal(store.unit('second', 'wrong-owner'), undefined);
  } finally { store.close(); }
});

test('external commits invalidate project, unit and catalog caches without replacing retained data', async t => {
  const { root, dataDir } = await fixture(t), first = createStore(dataDir), second = createStore(dataDir);
  try {
    first.put('projects', project(root, 'first'));
    first.putUnit('first', unit('line'), 0);
    const version = first.rowVersion('projects', 'first');
    assert.equal(first.one('projects', 'first').name, 'Neutral first');
    second.patchProject('first', { name: 'External accepted name' });
    second.putUnit('first', { ...unit('line', 'External accepted text.'), revision: 2 }, 0);
    assert.notEqual(first.rowVersion('projects', 'first'), version);
    assert.equal(first.one('projects', 'first').name, 'External accepted name');
    assert.equal(first.unit('first', 'line').translation, 'External accepted text.');
    assert.equal(first.one('projects', 'second'), undefined);
    second.put('projects', project(root, 'second'));
    assert.equal(first.one('projects', 'second').name, 'Neutral second');
    second.removeProject('second');
    assert.equal(first.one('projects', 'second'), undefined);
  } finally { second.close(); first.close(); }
});

test('unregistering a project keeps its local accepted text and database intact', async t => {
  const { root, dataDir } = await fixture(t), row = project(root, 'first'), store = createStore(dataDir);
  try {
    store.put('projects', row);
    store.putUnit(row.id, unit('accepted'), 0);
    store.removeProject(row.id);
    assert.deepEqual(store.ids('projects'), []);
    assert.equal(store.one('projects', row.id), undefined);
    await access(path.join(row.workspaceDir, 'pinhao.sqlite'));
    const local = new DatabaseSync(path.join(row.workspaceDir, 'pinhao.sqlite'), { readOnly: true });
    try { assert.equal(JSON.parse(local.prepare('SELECT body FROM units WHERE project_id=? AND id=?').get(row.id, 'accepted').body).translation, 'Accepted translation.'); }
    finally { local.close(); }
  } finally { store.close(); }
});

test('an offline project is not recreated and its availability version changes when reconnected', async t => {
  const { root, dataDir } = await fixture(t), row = project(root, 'first');
  let store = createStore(dataDir);
  store.put('projects', row); store.putUnit(row.id, unit('accepted'), 0);
  const availableVersion = store.rowVersion('projects', row.id);
  store.close();
  const offline = `${row.workspaceDir}-offline`;
  await rename(row.workspaceDir, offline).catch(error => { error.message += `; close/rename state: ${JSON.stringify({ catalogOpen: store.db.isOpen, sourceExists: existsSync(row.workspaceDir), databaseExists: existsSync(path.join(row.workspaceDir, 'pinhao.sqlite')), targetExists: existsSync(offline) })}`; throw error; });
  store = createStore(dataDir);
  try {
    const missing = store.one('projects', row.id);
    assert.equal(missing.unavailable, true);
    assert.equal(missing.status, 'paused');
    assert.notEqual(store.rowVersion('projects', row.id), availableVersion);
    assert.deepEqual(store.units(row.id), []);
    assert.throws(() => store.putUnit(row.id, unit('must-not-create'), 0), { code: 'PROJECT_LOCATION_UNAVAILABLE' });
    await assert.rejects(access(row.workspaceDir), { code: 'ENOENT' });
    const missingVersion = store.rowVersion('projects', row.id);
    await rename(offline, row.workspaceDir);
    assert.notEqual(store.rowVersion('projects', row.id), missingVersion);
    assert.equal(store.one('projects', row.id).unavailable, undefined);
    assert.equal(store.unit(row.id, 'accepted').translation, 'Accepted translation.');
  } finally { store.close(); }
});

for (const kind of ['invalid-header', 'empty', 'wrong-project', 'bad-project-json', 'bad-resource-json']) {
  test(`one ${kind} project stays isolated and retries unchanged accepted work after file repair`, async t => {
    const { root, dataDir } = await fixture(t), healthy = project(root, 'healthy'), damaged = project(root, 'damaged');
    let store = createStore(dataDir), service;
    store.put('settings', { ...defaultSettings(), id: 'global', concurrency: 7 });
    for (const row of [healthy, damaged]) {
      store.put('projects', row); store.putUnit(row.id, unit('accepted'), 0); store.addRevision(row.id, unit('accepted'));
      store.putTask(row.id, { id: row.id + '-task', projectId: row.id, fingerprint: row.id + '-paid', status: 'paused', candidateRecords: [{ id: 'accepted', translation: 'Retained paid candidate.' }] });
    }
    store.close(); store = undefined;
    const file = path.join(damaged.workspaceDir, 'pinhao.sqlite'), original = await readFile(file);
    if (kind === 'invalid-header' || kind === 'empty') await writeFile(file, kind === 'empty' ? '' : 'Invalid private fixture database.');
    else {
      const db = new DatabaseSync(file);
      try {
        if (kind === 'bad-resource-json') db.prepare('UPDATE project_resources SET body=? WHERE id=?').run('{invalid-json', damaged.id);
        else db.prepare('UPDATE projects SET body=? WHERE id=?').run(kind === 'wrong-project' ? JSON.stringify({ ...damaged, id: 'another-project' }) : '{invalid-json', damaged.id);
      }
      finally { db.close(); }
    }
    const bad = await readFile(file);
    try {
      service = await createService({ dataDir, deferCatalog: true, scriptTools: null, worker: async () => ({ engines: [] }) });
      const snapshot = await service.snapshot();
      assert.equal(snapshot.settings.concurrency, 7);
      assert.equal(snapshot.projects.find(row => row.id === healthy.id).total, 1);
      assert.match(snapshot.projects.find(row => row.id === damaged.id).lastError, /数据库/);
      assert.equal((await service.listText({ projectId: healthy.id })).units[0].translation, 'Accepted translation.');
      await assert.rejects(service.listText({ projectId: damaged.id }), { code: 'PROJECT_LOCATION_UNAVAILABLE' });
      await assert.rejects(service.exportPackage({ projectId: damaged.id, filePath: path.join(root, 'must-not-export.zip') }), { code: 'PROJECT_LOCATION_UNAVAILABLE' });
      await assert.rejects(access(path.join(root, 'must-not-export.zip')), { code: 'ENOENT' });
      await assert.rejects(service.buildProject({ projectId: damaged.id }), { code: 'PROJECT_LOCATION_UNAVAILABLE' });
      assert.deepEqual(await readFile(file), bad);
      await writeFile(file, original);
      assert.equal((await service.listText({ projectId: damaged.id })).units[0].translation, 'Accepted translation.');
      store = createStore(dataDir);
      assert.equal(store.revision(damaged.id, 'accepted', 1).translation, 'Accepted translation.');
      assert.equal(store.one('tasks', 'damaged-task').candidateRecords[0].translation, 'Retained paid candidate.');
    } finally { store?.close(); await service?.close(); }
  });
}

test('a corrupt portable catalog remains a global error instead of an empty replacement', async t => {
  const { dataDir } = await fixture(t), file = path.join(dataDir, 'catalog.sqlite');
  const raw = Buffer.from('Invalid private global catalog fixture.');
  await writeFile(file, raw);
  assert.throws(() => createStore(dataDir), /database/i);
  assert.deepEqual(await readFile(file), raw);
});

async function currentProject(root, dataDir, id = 'retained') {
  const gameDir = path.join(root, `original-${id}`); await mkdir(gameDir);
  await writeFile(path.join(gameDir, 'original.dat'), 'Original game remains untouched.');
  const workspaceDir = await createProjectWorkspace({ id, gameDir });
  const row = project(root, id, { gameDir, workspaceDir, storageLayout: PROJECT_LAYOUT, inventory: { retained: true } });
  const store = createStore(dataDir);
  try {
    store.put('projects', row); store.putUnit(id, unit('accepted'), 0); store.addRevision(id, unit('accepted'));
    store.putTask(id, { id: `${id}-task`, projectId: id, fingerprint: `${id}-paid`, status: 'running',
      candidateRecords: [{ id: 'accepted', translation: 'Paid candidate not discarded.' }], requestArtifacts: [{ path: path.join(workspaceDir, 'requests', 'retained.json') }] });
  } finally { store.close(); }
  return row;
}

test('explicit same-path reconnection registers current work in a fresh catalog without changing paid data', async t => {
  const { root, dataDir } = await fixture(t), row = await currentProject(root, dataDir);
  const file = path.join(row.workspaceDir, 'pinhao.sqlite'), before = await readFile(file);
  const other = createStore(path.join(root, 'fresh-catalog'));
  try {
    assert.deepEqual(other.ids('projects'), []);
    const reopened = await other.reconnectProject({ workspaceDir: row.workspaceDir });
    assert.equal(reopened.id, row.id); assert.equal(reopened.inventory.retained, true);
    assert.equal((await other.reconnectProject({ workspaceDir: row.workspaceDir })).workspaceDir, row.workspaceDir);
    assert.equal(other.unit(row.id, 'accepted').translation, 'Accepted translation.');
    assert.equal(other.revision(row.id, 'accepted', 1).translation, 'Accepted translation.');
    assert.equal(other.one('tasks', `${row.id}-task`).status, 'running');
    assert.equal(other.one('tasks', `${row.id}-task`).candidateRecords[0].translation, 'Paid candidate not discarded.');
    assert.equal(other.one('tasks', `${row.id}-task`).requestArtifacts[0].path, path.join(row.workspaceDir, 'requests', 'retained.json'));
    assert.deepEqual(other.ids('projects'), [row.id]);
  } finally { other.close(); }
  assert.deepEqual(await readFile(file), before);
  assert.equal(await readFile(path.join(row.gameDir, 'original.dat'), 'utf8'), 'Original game remains untouched.');
});

for (const kind of ['moved-workspace', 'old-layout', 'wrong-marker', 'missing-original']) {
  test(`reconnection rejects ${kind} without rewriting retained data or registering it`, async t => {
    const { root, dataDir } = await fixture(t), row = await currentProject(root, dataDir);
    let workspaceDir = row.workspaceDir;
    if (kind === 'moved-workspace') { workspaceDir += '-moved'; await rename(row.workspaceDir, workspaceDir); }
    if (kind === 'missing-original') await rename(row.gameDir, `${row.gameDir}-offline`);
    if (kind === 'wrong-marker') await writeFile(path.join(workspaceDir, 'pinhao-project.json'), JSON.stringify({ format: PROJECT_LAYOUT, id: 'wrong-id', gameDir: row.gameDir }));
    if (kind === 'old-layout') {
      const existing = createStore(dataDir);
      try { existing.patchProject(row.id, { storageLayout: 'older-layout' }); } finally { existing.close(); }
    }
    const file = path.join(workspaceDir, 'pinhao.sqlite'), before = await readFile(file), other = createStore(path.join(root, 'fresh-catalog'));
    try {
      await assert.rejects(other.reconnectProject({ workspaceDir }));
      assert.deepEqual(other.ids('projects'), []);
    } finally { other.close(); }
    assert.deepEqual(await readFile(file), before);
    if (kind === 'moved-workspace') await assert.rejects(access(row.workspaceDir), { code: 'ENOENT' });
  });
}

test('reconnection refuses a same-ID different-path conflict instead of replacing an existing binding', async t => {
  const { root, dataDir } = await fixture(t), row = await currentProject(root, dataDir), secondRoot = path.join(root, 'second');
  await mkdir(secondRoot);
  const otherRow = await currentProject(secondRoot, path.join(root, 'other-catalog'), row.id), store = createStore(dataDir);
  const file = path.join(otherRow.workspaceDir, 'pinhao.sqlite'), before = await readFile(file);
  try {
    await assert.rejects(store.reconnectProject({ workspaceDir: otherRow.workspaceDir }), /其他位置/);
    assert.equal(store.one('projects', row.id).workspaceDir, row.workspaceDir);
    assert.equal(store.unit(row.id, 'accepted').translation, 'Accepted translation.');
  } finally { store.close(); }
  assert.deepEqual(await readFile(file), before);
});
