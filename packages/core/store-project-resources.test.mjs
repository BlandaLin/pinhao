import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from './store.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-resources-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return directory;
}

test('progress updates touch only the small header while cold resources remain byte-identical', async t => {
  const directory = await fixture(t);
  let store = createStore(directory);
  try {
    const project = { id: 'project', status: 'ready', inventory: { files: 'source records'.repeat(100000) }, coverage: { resources: ['retained'] } };
    store.put('projects', project);
    const resources = store.db.prepare('SELECT body FROM project_resources WHERE id=?').get(project.id).body;
    store.db.exec("CREATE TRIGGER no_cold_update BEFORE UPDATE ON project_resources BEGIN SELECT RAISE(ABORT,'cold update in progress path'); END;");
    for (let index = 0; index < 32; index++) store.patchProject(project.id, { stage: `progress ${index}`, adaptationProgress: { index } });
    assert.equal(store.db.prepare('SELECT body FROM project_resources WHERE id=?').get(project.id).body, resources);
    assert.ok(store.db.prepare('SELECT length(body) AS bytes FROM projects WHERE id=?').get(project.id).bytes < 200);
    const expected = { ...project, stage: 'progress 31', adaptationProgress: { index: 31 } };
    assert.deepEqual(store.one('projects', project.id), expected);
    assert.deepEqual(store.all('projects'), [expected]);
    store.close(); store = createStore(directory);
    assert.deepEqual(store.one('projects', project.id), expected);
  } finally { store.close(); }
});

test('mixed project patches retain null, remove undefined and full put replaces both parts', async t => {
  const store = createStore(await fixture(t));
  try {
    store.put('projects', { id: 'project', stage: 'ready', inventory: { before: true }, coverage: { before: true } });
    assert.equal(store.patchProject('project', { stage: 'working', inventory: null, coverage: undefined }).changes, 1);
    assert.deepEqual(store.one('projects', 'project'), { id: 'project', stage: 'working', inventory: null });
    assert.equal(store.patchProject('project', { inventory: { after: true }, coverage: [] }).changes, 1);
    assert.deepEqual(store.one('projects', 'project'), { id: 'project', stage: 'working', inventory: { after: true }, coverage: [] });
    assert.equal(store.patchProject('missing', { inventory: {}, stage: 'missing' }).changes, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM project_resources WHERE id=?').get('missing').n, 0);
    store.put('projects', { id: 'project', stage: 'replaced' });
    assert.deepEqual(store.one('projects', 'project'), { id: 'project', stage: 'replaced' });
    store.removeProject('project');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM project_resources').get().n, 0);
  } finally { store.close(); }
});

test('resource writes and header writes roll back as one project and invalidate external versions', async t => {
  const directory = await fixture(t), store = createStore(directory), other = createStore(directory);
  try {
    const original = { id: 'project', stage: 'ready', inventory: { retained: true }, coverage: null };
    store.put('projects', original);
    const initial = other.rowVersion('projects', 'project');
    store.db.exec("CREATE TRIGGER fail_resources BEFORE UPDATE ON project_resources BEGIN SELECT RAISE(ABORT,'cold write failed'); END;");
    assert.throws(() => store.patchProject('project', { stage: 'wrong', inventory: {} }), /cold write failed/);
    assert.deepEqual(store.one('projects', 'project'), original);
    assert.deepEqual(other.one('projects', 'project'), original);
    store.transaction(() => {
      assert.throws(() => store.patchProject('project', { stage: 'caught-patch', inventory: {} }), /cold write failed/);
      assert.deepEqual(store.one('projects', 'project'), original);
      assert.throws(() => store.put('projects', { ...original, stage: 'caught-put', coverage: {} }), /cold write failed/);
      store.put('settings', { id: 'unrelated', committed: true });
    });
    assert.deepEqual(store.one('projects', 'project'), original);
    assert.equal(store.one('settings', 'unrelated').committed, true);
    store.db.exec('DROP TRIGGER fail_resources');
    assert.throws(() => store.transaction(() => {
      store.patchProject('project', { stage: 'uncommitted', coverage: { new: true } });
      assert.deepEqual(store.one('projects', 'project').coverage, { new: true });
      throw new Error('stop acceptance');
    }), /stop acceptance/);
    assert.deepEqual(store.one('projects', 'project'), original);
    const before = store.rowVersion('projects', 'project');
    other.patchProject('project', { coverage: { accepted: true } });
    assert.ok(other.rowVersion('projects', 'project') > initial);
    assert.ok(store.rowVersion('projects', 'project') > before);
    assert.deepEqual(store.one('projects', 'project').coverage, { accepted: true });
  } finally { store.close(); other.close(); }
});

test('opening an inline record partitions it once without altering tasks or accepted text', async t => {
  const directory = await fixture(t), database = new DatabaseSync(path.join(directory, 'pinhao.sqlite'));
  const project = { id: 'project', stage: 'paused', inventory: { files: ['a'] }, coverage: null, adaptationProgress: { completed: 12 } };
  database.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE settings(id TEXT PRIMARY KEY,body TEXT NOT NULL);');
  database.prepare('INSERT INTO projects VALUES(?,?)').run(project.id, JSON.stringify(project));
  database.prepare('INSERT INTO settings VALUES(?,?)').run('retained', '{"untouched":true}');
  database.close();
  let store = createStore(directory);
  try {
    assert.deepEqual(store.one('projects', project.id), project);
    assert.equal(JSON.parse(store.db.prepare('SELECT body FROM projects WHERE id=?').get(project.id).body).inventory, undefined);
    assert.deepEqual(store.one('settings', 'retained'), { untouched: true });
    store.putUnit(project.id, { id: 'accepted', status: 'proofread', translation: 'Accepted text.' });
    store.putTask(project.id, { id: 'paid', fingerprint: 'paid', status: 'paused', requestHistory: [{ id: 'response', usage: { totalTokens: 32 } }] });
    const units = store.db.prepare('SELECT * FROM units').all(), tasks = store.db.prepare('SELECT * FROM tasks').all();
    const resources = store.db.prepare('SELECT * FROM project_resources').all();
    store.close(); store = createStore(directory);
    assert.deepEqual(store.one('projects', project.id), project);
    assert.deepEqual(store.db.prepare('SELECT * FROM project_resources').all(), resources);
    assert.deepEqual(store.db.prepare('SELECT * FROM units').all(), units);
    assert.deepEqual(store.db.prepare('SELECT * FROM tasks').all(), tasks);
  } finally { store.close(); }
});
