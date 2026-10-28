import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from './store.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-store-test-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return directory;
}

const unit = (id, status = 'pending', changed = false) => ({ id, source: `Neutral scene ${id}.`, translation: changed ? `Translated scene ${id}.` : `Neutral scene ${id}.`, notes: '', status, revision: 0, sourceHash: `hash-${id}` });

test('scene result task projection leaves request histories out and preserves receipt data without writes', async t => {
  const store = createStore(await fixture(t));
  try {
    const task = { id: 'scene-task', projectId: 'project', fingerprint: 'scene-task', status: 'paused', reviewRoundId: 'round', reviewStage: 'scene',
      reviewScopeId: 'scene', reviewScopeVersion: 'version', unitIds: ['one', 'two'], reviewedUnitIds: ['one'],
      candidateRecords: [{ id: 'one', translation: 'Saved result', notes: 'Saved note' }],
      reviewCandidate: { reviewedIds: ['one'], issues: [{ message: 'Excluded diagnostic issue' }] },
      requestHistory: [{ messages: 'Excluded request material'.repeat(10000) }], readingNotes: 'Excluded reading history' };
    store.putTask('project', task);
    store.putTask('project', { ...task, id: 'consistency-task', fingerprint: 'consistency-task', reviewStage: 'consistency' });
    store.putTask('project', { ...task, id: 'old-scene', fingerprint: 'old-scene', reviewRoundId: 'old' });
    const before = store.db.prepare('SELECT * FROM tasks ORDER BY rowid').all();
    const [projected] = store.tasks('project', { reviewRoundId: 'round', sceneResultsOnly: true });
    assert.deepEqual(projected, Object.fromEntries(['id', 'projectId', 'status', 'reviewRoundId', 'reviewStage', 'reviewScopeId', 'reviewScopeVersion',
      'unitIds', 'candidateRecords', 'reviewedUnitIds'].map(key => [key, task[key]]).concat([['reviewCandidate', { reviewedIds: ['one'] }]])));
    assert.equal(store.tasks('project', { reviewRoundId: 'round', sceneResultsOnly: true }).length, 1);
    assert.equal(store.tasks('project', { reviewRoundId: 'round', sceneResultsOnly: true, statuses: ['succeeded'] }).length, 0);
    assert.equal(JSON.stringify(projected).includes('Excluded'), false);
    assert.deepEqual(store.db.prepare('SELECT * FROM tasks ORDER BY rowid').all(), before);
    assert.deepEqual(store.tasks('project', { reviewRoundId: 'round' })[0], task, 'Normal task reads retain their complete contract');
  } finally { store.close(); }
});

test('project patches replace top-level values, retain null and remove undefined without recursive merging', async t => {
  const store = createStore(await fixture(t));
  try {
    store.put('projects', { id: 'project', untouched: { evidence: ['Original scene material.'] }, nested: { before: true, keep: 1 },
      array: [1, 2], old: 'remove', nullable: 'replace' });
    assert.equal(store.patchProject('project', { nested: { after: true }, array: [], old: undefined, nullable: null, flag: false, number: 0, text: '' }).changes, 1);
    assert.deepEqual(store.one('projects', 'project'), { id: 'project', untouched: { evidence: ['Original scene material.'] }, nested: { after: true },
      array: [], nullable: null, flag: false, number: 0, text: '' });
    assert.equal(store.patchProject('missing', { status: 'ready' }).changes, 0);
    assert.equal(store.one('projects', 'missing'), undefined);
    assert.equal(store.patchProject('project', {}).changes, 0);
  } finally { store.close(); }
});

test('project patch paths address literal keys including punctuation, quotes and escapes', async t => {
  const store = createStore(await fixture(t));
  try {
    store.put('projects', { id: 'project', nested: { untouched: true } });
    const keys = ['a.b', '[0]', 'a"b', 'a\\b', 'quote".nested', '__proto__', 'key\u0000with-null', "'); DROP TABLE projects; --"];
    store.patchProject('project', Object.fromEntries(keys.map((key, index) => [key, { index }])));
    const value = store.one('projects', 'project');
    for (const [index, key] of keys.entries()) assert.deepEqual(value[key], { index });
    assert.deepEqual(value.nested, { untouched: true });
    store.patchProject('project', Object.fromEntries(keys.map(key => [key, undefined])));
    assert.deepEqual(store.one('projects', 'project'), { id: 'project', nested: { untouched: true } });
  } finally { store.close(); }
});

test('project patch generations and rollback preserve committed data and invalidate in-flight snapshots', async t => {
  const directory = await fixture(t), store = createStore(directory), external = createStore(directory);
  try {
    store.put('projects', { id: 'project', stage: 'ready', evidence: { retained: true } });
    const initial = store.rowVersion('projects', 'project');
    store.patchProject('project', { stage: 'working' });
    const committed = store.rowVersion('projects', 'project');
    assert.ok(committed > initial);
    let rolledBack;
    assert.throws(() => store.transaction(() => {
      store.patchProject('project', { stage: 'temporary', evidence: undefined });
      rolledBack = store.rowVersion('projects', 'project');
      throw new Error('rollback project patch');
    }), /rollback project patch/);
    assert.ok(store.rowVersion('projects', 'project') > rolledBack && rolledBack > committed);
    assert.deepEqual(store.one('projects', 'project'), { id: 'project', stage: 'working', evidence: { retained: true } });
    const beforeExternal = store.rowVersion('projects', 'project');
    external.patchProject('project', { stage: 'external' });
    assert.ok(store.rowVersion('projects', 'project') > beforeExternal);
    assert.equal(store.one('projects', 'project').stage, 'external');
  } finally { store.close(); external.close(); }
});

test('small progress patches never deserialize or stringify unchanged large project fields', async t => {
  const store = createStore(await fixture(t)), originalStringify = JSON.stringify, originalParse = JSON.parse;
  try {
    const evidence = 'Retained neutral scene evidence.\n'.repeat(100000);
    store.put('projects', { id: 'project', evidence, stage: 'ready' });
    JSON.stringify = (value, ...args) => {
      if (value?.evidence || typeof value === 'string' && value.length > 1000000) throw new Error('Unexpected serialization of unchanged evidence');
      return originalStringify(value, ...args);
    };
    JSON.parse = (value, ...args) => {
      if (value.length > 1000000) throw new Error('Unexpected full project deserialization');
      return originalParse(value, ...args);
    };
    for (let index = 0; index < 8; index++) store.patchProject('project', { stage: `Progress ${index}`, progress: index });
    const actual = store.db.prepare("SELECT json_extract(body,'$.stage') AS stage,json_extract(body,'$.progress') AS progress,length(json_extract(body,'$.evidence')) AS length FROM projects WHERE id=?").get('project');
    assert.deepEqual({ ...actual }, { stage: 'Progress 7', progress: 7, length: evidence.length });
  } finally { JSON.stringify = originalStringify; JSON.parse = originalParse; store.close(); }
});

test('existing SQLite unit rows receive a sorting index with their bytes, positions and revisions intact', async t => {
  const directory = await fixture(t), file = path.join(directory, 'pinhao.sqlite');
  const previous = new DatabaseSync(file);
  previous.exec('CREATE TABLE units (project_id TEXT NOT NULL,id TEXT NOT NULL,position INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,id)); CREATE TABLE revisions(project_id TEXT NOT NULL,unit_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,unit_id,revision));');
  for (const [id, position] of [['z', 9], ['a', 3], ['m', 6]]) previous.prepare('INSERT INTO units VALUES(?,?,?,?)').run('project', id, position, JSON.stringify(unit(id)));
  previous.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run('project', 'z', 0, '{"translation":"Neutral scene z.","notes":"accepted"}');
  const rows = previous.prepare('SELECT * FROM units ORDER BY id').all(), revisions = previous.prepare('SELECT * FROM revisions').all();
  previous.close();
  const store = createStore(directory);
  try {
    assert.deepEqual(store.db.prepare('SELECT * FROM units ORDER BY id').all(), rows);
    assert.deepEqual(store.db.prepare('SELECT * FROM revisions').all(), revisions);
    assert.deepEqual(store.units('project').map(item => item.id), ['a', 'm', 'z']);
    for (const query of ['SELECT body FROM units WHERE project_id=? ORDER BY position', 'SELECT body FROM units WHERE project_id=? ORDER BY position LIMIT 100 OFFSET 0']) {
      const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all('project').map(item => item.detail).join('\n');
      assert.match(plan, /units_project_position/);
      assert.doesNotMatch(plan, /TEMP B-TREE/);
    }
    store.putUnit('project', { ...unit('z'), translation: 'Accepted changed line.', revision: 1 });
    store.addRevision('project', store.unit('project', 'z'));
    assert.equal(store.db.prepare('SELECT position FROM units WHERE project_id=? AND id=?').get('project', 'z').position, 9);
    assert.equal(store.revision('project', 'z', 0).notes, 'accepted');
    assert.equal(store.revision('project', 'z', 1).translation, 'Accepted changed line.');
  } finally { store.close(); }
  const reopened = createStore(directory);
  try { assert.equal(reopened.units('project').at(-1).id, 'z'); assert.equal(reopened.revision('project', 'z', 1).translation, 'Accepted changed line.'); }
  finally { reopened.close(); }
});

test('indexed pages retain ordering, project boundaries, search, filters and counts', async t => {
  const store = createStore(await fixture(t));
  try {
    store.transaction(() => {
      store.putUnit('project', unit('z', 'proofread', true), 30);
      store.putUnit('project', { ...unit('m', 'skipped'), notes: 'A searchable note.' }, 20);
      store.putUnit('project', unit('a', 'pending'), 10);
      store.putUnit('project', unit('n', 'translated', true), 25);
      store.putUnit('other', unit('other'), 0);
    });
    const page = options => store.page('project', { offset: 0, limit: 100, search: '', filter: '', ...options });
    assert.deepEqual(page({ offset: 1, limit: 2 }).units.map(item => item.id), ['m', 'n']);
    assert.equal(page({ offset: 1, limit: 2 }).total, 4);
    assert.deepEqual(page({ search: 'SEARCHABLE' }).units.map(item => item.id), ['m']);
    assert.deepEqual(page({ search: 'translated' }).units.map(item => item.id), ['n', 'z']);
    assert.deepEqual(page({ filter: 'changed' }).units.map(item => item.id), ['n', 'z']);
    assert.deepEqual(page({ filter: 'untranslated' }).units.map(item => item.id), ['a', 'm']);
    assert.deepEqual(page({ filter: 'proofread' }).units.map(item => item.id), ['z']);
    assert.deepEqual(store.counts('project'), { total: 4, proofread: 1, translated: 1, skipped: 1, needsEvidence: 0 });
    assert.deepEqual(store.counts('missing'), { total: 0, proofread: 0, translated: 0, skipped: 0, needsEvidence: 0 });
    assert.throws(() => store.transaction(() => { store.putUnit('project', unit('rolled-back'), 0); throw new Error('rollback fixture'); }), /rollback/);
    assert.equal(store.unit('project', 'rolled-back'), undefined);
  } finally { store.close(); }
});

test('frequent writes and reads reuse SQL statements while keeping changed arguments current', async t => {
  const store = createStore(await fixture(t)), originalPrepare = store.db.prepare.bind(store.db), prepared = new Map();
  store.db.prepare = sql => { prepared.set(sql, (prepared.get(sql) ?? 0) + 1); return originalPrepare(sql); };
  try {
    store.transaction(() => { for (let index = 0; index < 100; index++) store.putUnit('project', unit(String(index)), index); });
    for (const id of ['1', '2', '3']) assert.equal(store.unit('project', id).id, id);
    for (const id of ['project', 'missing', 'project']) store.counts(id);
    for (const search of ['scene 1.', 'scene 2.', 'scene 3.']) assert.equal(store.page('project', { offset: 0, limit: 100, search, filter: '' }).total, 1);
    assert.ok(prepared.size >= 5);
    assert.ok([...prepared.values()].every(count => count === 1));
  } finally { store.close(); }
});

test('cached project counts follow insertions, replacements and rollback without repeated aggregate scans', async t => {
  const store = createStore(await fixture(t));
  const originalPrepare = store.db.prepare.bind(store.db);
  let scans = 0;
  store.db.prepare = sql => {
    const statement = originalPrepare(sql);
    if (!sql.includes('SUM(CASE')) return statement;
    const get = statement.get.bind(statement);
    statement.get = (...args) => { scans++; return get(...args); };
    return statement;
  };
  try {
    store.putUnit('project', unit('a'), 0);
    assert.equal(store.hasUnits('project'), true);
    const first = store.counts('project'); first.total = 99;
    assert.equal(store.counts('project').total, 1);
    store.putUnit('project', unit('a', 'translated'), 0);
    store.putUnit('project', unit('b', 'proofread'), 1);
    store.putUnit('project', unit('a', 'skipped'), 0);
    assert.deepEqual(store.counts('project'), { total: 2, proofread: 1, translated: 0, skipped: 1, needsEvidence: 0 });
    assert.equal(scans, 1);
    const before = store.unitVersion('project');
    let rolledBackVersion;
    assert.throws(() => store.transaction(() => {
      store.putUnit('project', unit('a', 'proofread'));
      store.putUnit('project', unit('c', 'translated'), 2);
      assert.equal(store.counts('project').total, 3);
      rolledBackVersion = store.unitVersion('project');
      throw new Error('rollback fixture');
    }), /rollback/);
    assert.ok(store.unitVersion('project') > rolledBackVersion && rolledBackVersion > before);
    assert.deepEqual(store.counts('project'), { total: 2, proofread: 1, translated: 0, skipped: 1, needsEvidence: 0 });
    assert.equal(scans, 2);
    store.transaction(() => store.putUnit('project', unit('a', 'translated')));
    assert.deepEqual(store.counts('project'), { total: 2, proofread: 1, translated: 1, skipped: 0, needsEvidence: 0 });
    assert.equal(scans, 2);
  } finally { store.close(); }
});

test('project removal and rollback invalidate row and unit generations while preserving fresh counts', async t => {
  const store = createStore(await fixture(t));
  try {
    store.put('projects', { id: 'project', name: 'Neutral project' });
    store.putUnit('project', unit('a', 'translated'));
    store.counts('project');
    assert.deepEqual(store.ids('projects'), ['project']);
    const before = store.rowVersion('projects', 'project');
    let removedVersion;
    assert.throws(() => store.transaction(() => {
      store.removeProject('project');
      assert.equal(store.hasUnits('project'), false);
      assert.equal(store.counts('project').total, 0);
      removedVersion = store.rowVersion('projects', 'project');
      throw new Error('rollback fixture');
    }), /rollback/);
    assert.ok(store.rowVersion('projects', 'project') > removedVersion && removedVersion > before);
    assert.equal(store.one('projects', 'project').name, 'Neutral project');
    assert.equal(store.counts('project').translated, 1);
    const version = store.unitVersion('project');
    store.transaction(() => store.removeProject('project'));
    assert.ok(store.unitVersion('project') > version);
    assert.equal(store.hasUnits('project'), false);
    assert.deepEqual(store.counts('project'), { total: 0, proofread: 0, translated: 0, skipped: 0, needsEvidence: 0 });
    store.putUnit('project', unit('new', 'proofread'));
    assert.deepEqual(store.counts('project'), { total: 1, proofread: 1, translated: 0, skipped: 0, needsEvidence: 0 });
  } finally { store.close(); }
});

test('another connection invalidates cached counters and row generations only after committed changes', async t => {
  const directory = await fixture(t), first = createStore(directory), second = createStore(directory);
  try {
    first.put('projects', { id: 'project', name: 'Neutral project' });
    first.putUnit('project', unit('a'));
    assert.equal(first.counts('project').total, 1);
    const unitVersion = first.unitVersion('project'), projectVersion = first.rowVersion('projects', 'project');
    second.transaction(() => {
      second.putUnit('project', unit('a', 'proofread'));
      second.putUnit('project', unit('b', 'translated'), 1);
      second.put('projects', { id: 'project', name: 'Updated neutral project' });
    });
    assert.ok(first.unitVersion('project') > unitVersion);
    assert.ok(first.rowVersion('projects', 'project') > projectVersion);
    assert.deepEqual(first.counts('project'), { total: 2, proofread: 1, translated: 1, skipped: 0, needsEvidence: 0 });
    const committed = first.unitVersion('project');
    assert.throws(() => second.transaction(() => {
      second.putUnit('project', unit('rolled-back', 'proofread'), 2);
      throw new Error('rollback fixture');
    }), /rollback/);
    assert.equal(first.unitVersion('project'), committed);
    assert.equal(first.counts('project').total, 2);
    second.removeProject('project');
    assert.equal(first.hasUnits('project'), false);
    assert.equal(first.counts('project').total, 0);
    assert.ok(first.unitVersion('project') > committed);
  } finally { first.close(); second.close(); }
});

test('unit change journals track distinct updated IDs and bound the retained history', async t => {
  const store = createStore(await fixture(t));
  try {
    store.putUnit('project', unit('a'), 0);
    store.putUnit('project', unit('b'), 1);
    const baseline = store.unitVersion('project');
    assert.deepEqual(store.unitChangesSince('project', baseline), []);
    store.putUnit('project', unit('a', 'translated'));
    store.putUnit('project', unit('b', 'proofread'));
    store.putUnit('project', unit('a', 'proofread'));
    assert.deepEqual(new Set(store.unitChangesSince('project', baseline)), new Set(['a', 'b']));
    const detached = store.unitChangesSince('project', baseline); detached.length = 0;
    assert.equal(store.unitChangesSince('project', baseline).length, 2);
    const beforeOverflow = store.unitVersion('project');
    store.transaction(() => { for (let index = 0; index < 4097; index++) store.putUnit('project', unit(`new:${index}`), index + 2); });
    assert.equal(store.unitChangesSince('project', beforeOverflow), null);
    const recent = store.unitVersion('project');
    store.putUnit('project', unit('new:4096', 'translated'));
    assert.deepEqual(store.unitChangesSince('project', recent), ['new:4096']);
  } finally { store.close(); }
});

test('unit journals require a fresh snapshot after rollback, removal and external commits', async t => {
  const directory = await fixture(t), store = createStore(directory), external = createStore(directory);
  try {
    store.putUnit('project', unit('a'));
    const baseline = store.unitVersion('project');
    assert.throws(() => store.transaction(() => {
      store.putUnit('project', unit('a', 'translated'));
      assert.deepEqual(store.unitChangesSince('project', baseline), ['a']);
      throw new Error('rollback fixture');
    }), /rollback/);
    assert.equal(store.unitChangesSince('project', baseline), null);
    const rolledBack = store.unitVersion('project');
    store.putUnit('project', unit('a', 'proofread'));
    assert.deepEqual(store.unitChangesSince('project', rolledBack), ['a']);
    const beforeExternal = store.unitVersion('project');
    external.putUnit('project', unit('b'), 1);
    assert.equal(store.unitChangesSince('project', beforeExternal), null);
    const externalBaseline = store.unitVersion('project');
    store.putUnit('project', unit('b', 'translated'));
    assert.deepEqual(store.unitChangesSince('project', externalBaseline), ['b']);
    const beforeRemove = store.unitVersion('project');
    store.removeProject('project');
    assert.equal(store.unitChangesSince('project', beforeRemove), null);
    assert.deepEqual(store.unitChangesSince('project', store.unitVersion('project')), []);
  } finally { store.close(); external.close(); }
});

test('existing task rows receive narrow-query indexes without changing recovery bytes or insertion order', async t => {
  const directory = await fixture(t), previous = new DatabaseSync(path.join(directory, 'pinhao.sqlite'));
  previous.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL);');
  for (const [index, status] of ['completed', 'paused', 'queued', 'running'].entries()) previous.prepare('INSERT INTO tasks VALUES(?,?,?,?)')
    .run(`task:${index}`, 'project', `fp:${index}`, JSON.stringify({ id: `task:${index}`, status, unitIds: ['neutral'], input: [{ id: 'neutral', revision: 2 }], candidateRecords: [{ id: 'neutral', translation: 'Accepted checkpoint.' }] }));
  const rows = previous.prepare('SELECT rowid,* FROM tasks ORDER BY rowid').all();
  previous.close();
  const store = createStore(directory), external = createStore(directory);
  try {
    assert.deepEqual(store.db.prepare('SELECT rowid,* FROM tasks ORDER BY rowid').all(), rows);
    assert.deepEqual(store.tasks('project', { statuses: ['queued', 'running'] }).map(row => row.id), ['task:2', 'task:3']);
    const paused = store.taskByFingerprint('project', 'fp:1');
    external.putTask('project', { ...paused, fingerprint: 'fp:1', status: 'queued' });
    assert.deepEqual(store.tasks('project', { statuses: ['queued', 'running'] }).map(row => row.id), ['task:1', 'task:2', 'task:3']);
    assert.deepEqual(store.taskByFingerprint('project', 'fp:1').candidateRecords, paused.candidateRecords);
    assert.equal(store.taskOrder('task:1'), rows[1].rowid);
    assert.throws(() => external.transaction(() => {
      external.putTask('project', { ...paused, fingerprint: 'fp:1', status: 'completed' });
      throw new Error('rollback fixture');
    }), /rollback/);
    assert.equal(store.taskByFingerprint('project', 'fp:1').status, 'queued');
  } finally { store.close(); external.close(); }
});

test('task queries narrow active rows and preserve project, global and resumed insertion order', async t => {
  const directory = await fixture(t), store = createStore(directory);
  const task = (id, status, projectId = 'project') => ({ id, projectId, fingerprint: `fp:${id}`, status, role: 'translation', unitIds: [id], input: [{ id, source: 'Complete neutral sentence.' }], attempts: 1 });
  const originalPrepare = store.db.prepare.bind(store.db), selected = [];
  store.db.prepare = sql => {
    const statement = originalPrepare(sql);
    if (!sql.startsWith('SELECT body FROM tasks')) return statement;
    const all = statement.all.bind(statement);
    statement.all = (...args) => { const rows = all(...args); selected.push({ sql, count: rows.length }); return rows; };
    return statement;
  };
  try {
    store.transaction(() => {
      for (let index = 0; index < 1000; index++) store.putTask('project', task(`completed:${index}`, 'completed'));
      for (const [id, status, projectId] of [['a', 'queued', 'project'], ['other', 'running', 'other'], ['b', 'running', 'project'], ['c', 'paused', 'project']]) store.putTask(projectId, task(id, status, projectId));
    });
    assert.deepEqual(store.tasks('project', { statuses: ['running', 'queued'] }).map(row => row.id), ['a', 'b']);
    assert.equal(selected.at(-1).count, 2);
    assert.deepEqual(store.tasks(undefined, { statuses: ['running', 'queued'] }).map(row => row.id), ['b', 'other', 'a']);
    assert.equal(selected.at(-1).count, 3);
    assert.deepEqual(store.tasks('project', { statuses: [] }), []);
    assert.deepEqual(store.tasks('missing', { statuses: ['running'] }), []);
    assert.deepEqual(store.tasks('project'), store.all('tasks', 'project'));
    assert.deepEqual(store.tasks(), store.all('tasks'));
    assert.deepEqual(store.taskByFingerprint('project', 'fp:a'), task('a', 'queued'));
    assert.equal(store.taskByFingerprint('other', 'fp:a'), undefined);
    assert.equal(store.taskOrder('missing'), undefined);
    const originalOrder = store.taskOrder('completed:0');
    store.putTask('project', task('completed:0', 'queued'));
    assert.equal(store.taskOrder('completed:0'), originalOrder);
    assert.deepEqual(store.tasks('project', { statuses: ['queued'] }).map(row => row.id), ['completed:0', 'a']);
    const previous = store.tasks('project', { statuses: ['queued'] });
    assert.throws(() => store.transaction(() => { store.putTask('project', task('a', 'completed')); throw new Error('rollback fixture'); }), /rollback/);
    assert.deepEqual(store.tasks('project', { statuses: ['queued'] }), previous);
    for (const [query, args, index] of [
      ["SELECT body FROM tasks INDEXED BY tasks_status_project WHERE project_id=? AND json_extract(body,'$.status') IN (?,?) ORDER BY rowid", ['project', 'running', 'queued'], 'tasks_status_project'],
      ["SELECT body FROM tasks INDEXED BY tasks_status_project WHERE json_extract(body,'$.status') IN (?,?) ORDER BY rowid DESC", ['running', 'queued'], 'tasks_status_project'],
      ['SELECT body FROM tasks WHERE project_id=? AND fingerprint=?', ['project', 'fp:a'], 'tasks_fingerprint'],
      ['SELECT body FROM tasks WHERE project_id=? ORDER BY rowid DESC LIMIT 8', ['project'], 'tasks_project'],
    ]) assert.match(store.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...args).map(row => row.detail).join('\n'), new RegExp(index));
  } finally { store.close(); }
});

test('task summaries project only recent display fields while preserving progress and the full history', async t => {
  const store = createStore(await fixture(t)), originalPrepare = store.db.prepare.bind(store.db), selected = [];
  store.db.prepare = sql => {
    const statement = originalPrepare(sql), all = statement.all.bind(statement);
    if (sql.includes('AS body') && sql.includes('FROM tasks')) statement.all = (...args) => {
      const rows = all(...args); selected.push(rows); return rows;
    };
    return statement;
  };
  try {
    store.transaction(() => {
      for (let index = 0; index < 24; index++) store.putTask('project', {
        id: `task:${index}`, fingerprint: `fp:${index}`, role: 'translation', status: index === 22 ? 'running' : index === 23 ? 'paused' : 'completed',
        unitIds: index === 23 ? [] : [`unit:${index}`], input: [{ id: `unit:${index}`, source: 'Full semantic unit.', opaque: 'x'.repeat(1024) }],
        attempts: 2, error: index === 23 ? 'Saved recoverable failure' : '',
        requestHistory: [{ receivedCharacters: 10 }, index === 23 ? {} : { receivedCharacters: 20, opaque: 'y'.repeat(1024) }],
        candidateRecords: [{ id: `unit:${index}` }], evidenceReplies: ['z'.repeat(1024)],
      });
      store.putTask('other', { id: 'other', fingerprint: 'fp:other', role: 'technical', status: 'running', unitIds: [], input: [], attempts: 1 });
    });
    const full = store.all('tasks', 'project'), bytes = store.db.prepare('SELECT body FROM tasks ORDER BY rowid').all();
    const expected = full.map(({ id, role, kind, status, unitIds, input, attempts, error, requestHistory, candidateRecords }) => ({ id, role, kind: kind ?? null, status, unitIds, attempts,
      ...(['running', 'paused'].includes(status) && requestHistory?.length ? { progress: { receivedCharacters: requestHistory.at(-1).receivedCharacters ?? 0,
        checkpointed: candidateRecords?.length ?? 0, requested: unitIds.length || input.length } } : {}), ...(error ? { error } : {}) }));
    assert.deepEqual(store.taskSummaries('project'), { total: 24, tasks: expected.slice(-8) });
    assert.equal(selected.at(-1).length, 8);
    assert.ok(selected.at(-1).every(row => row.body.length < 400 && !row.body.includes('opaque') && !row.body.includes('evidenceReplies')));
    assert.deepEqual(store.taskSummaries('project', { limit: 2 }), { total: 24, tasks: expected.slice(-2) });
    assert.deepEqual(store.taskSummaries('project', { limit: 0 }), { total: 24, tasks: [] });
    assert.deepEqual(store.taskSummaries('missing'), { total: 0, tasks: [] });
    assert.deepEqual(store.db.prepare('SELECT body FROM tasks ORDER BY rowid').all(), bytes);
    assert.deepEqual(store.all('tasks', 'project'), full);
  } finally { store.close(); }
});

test('lane statistics retain old in-flight tasks outside the recent display page', async t => {
  const store = createStore(await fixture(t));
  try {
    store.putTask('project', { id: 'old-technical', fingerprint: 'old-technical', role: 'technical', kind: 'adaptation', status: 'running' });
    store.putTask('project', { id: 'old-text', fingerprint: 'old-text', role: 'translation', status: 'running' });
    for (let i = 0; i < 12; i++) store.putTask('project', { id: `new-${i}`, fingerprint: `new-${i}`, role: 'proofreading', status: 'succeeded' });
    assert.equal(store.taskSummaries('project').tasks.some(task => task.status === 'running'), false);
    assert.equal(store.taskStats('project').lanes.adaptation.running, 1);
    assert.equal(store.taskStats('project').lanes.text.running, 1);
    store.putTask('project', { id: 'old-text', fingerprint: 'old-text', role: 'translation', status: 'queued' });
    assert.equal(store.taskStats('project').lanes.text.running, 0);
    assert.equal(store.taskStats('project').lanes.text.queued, 1);
  } finally { store.close(); }
});

test('build summaries omit manifests without changing complete latest-build recovery data', async t => {
  const store = createStore(await fixture(t));
  try {
    const first = { id: 'first', path: 'first-output', createdAt: '2026-01-01', changed: 1, checks: [{ name: 'roundtrip', status: 'passed' }], outputManifest: { files: ['x'.repeat(10000)] } };
    const latest = { ...first, id: 'latest', path: 'latest-output', launchPath: 'game.exe', launchArgs: ['--neutral'], assistance: { supported: true, modes: ['live'], detail: 'Available' } };
    store.put('builds', first, 'project');
    store.put('builds', latest, 'project');
    store.put('builds', { ...latest, id: 'other' }, 'other');
    const { outputManifest, ...firstSummary } = first, { outputManifest: latestManifest, ...latestSummary } = latest;
    assert.deepEqual(store.buildSummaries('project'), [firstSummary, latestSummary]);
    assert.deepEqual(store.latestBuild('project'), latest);
    assert.deepEqual(store.latestBuild('project', { summaryOnly: true }), latestSummary);
    assert.equal(store.latestBuild('missing'), undefined);
    assert.deepEqual(store.buildSummaries('missing'), []);
    assert.deepEqual(store.all('builds', 'project'), [first, latest]);
    store.removeBuild('project', 'latest');
    assert.deepEqual(store.latestBuild('project'), first);
  } finally { store.close(); }
});

test('unsearched page counts reuse cached exact states through writes, rollback and external commits', async t => {
  const directory = await fixture(t), store = createStore(directory), external = createStore(directory);
  const originalPrepare = store.db.prepare.bind(store.db);
  let aggregates = 0, filteredCounts = 0;
  store.db.prepare = sql => {
    const statement = originalPrepare(sql);
    if (!sql.includes('COUNT(*)') || !sql.includes('FROM units')) return statement;
    const get = statement.get.bind(statement);
    statement.get = (...args) => { if (sql.includes('SUM(CASE')) aggregates++; else filteredCounts++; return get(...args); };
    return statement;
  };
  const page = (filter, search = '') => store.page('project', { offset: 0, limit: 100, filter, search });
  const assertCounts = expected => {
    for (const [filter, total] of Object.entries(expected)) {
      const result = page(filter);
      assert.equal(result.total, total, filter);
      assert.equal(result.units.length, total, filter);
    }
  };
  try {
    store.transaction(() => {
      for (const [index, status] of ['pending', 'translated', 'proofread', 'skipped', 'unknown'].entries()) store.putUnit('project', unit(status, status, status === 'translated'), index);
      store.putUnit('project', { ...unit('unset'), status: undefined }, 5);
    });
    assertCounts({ all: 6, pending: 1, translated: 1, proofread: 1, skipped: 1, untranslated: 2 });
    assert.deepEqual(store.counts('project'), { total: 6, translated: 1, proofread: 1, skipped: 1, needsEvidence: 0 });
    assert.equal(aggregates, 1); assert.equal(filteredCounts, 0);
    store.putUnit('project', unit('pending', 'proofread'), 0);
    store.putUnit('project', unit('new'), 6);
    assertCounts({ all: 7, pending: 1, translated: 1, proofread: 2, skipped: 1, untranslated: 2 });
    assert.equal(aggregates, 1); assert.equal(filteredCounts, 0);
    assert.equal(page('unknown').total, 1);
    assert.equal(page('changed').total, 1);
    assert.equal(page('all', 'scene').total, 7);
    assert.equal(filteredCounts, 3);
    assert.throws(() => store.transaction(() => {
      store.putUnit('project', unit('new', 'skipped'));
      store.putUnit('project', unit('rolled-back'), 7);
      assert.equal(page('untranslated').total, 3);
      throw new Error('rollback fixture');
    }), /rollback/);
    assertCounts({ all: 7, pending: 1, untranslated: 2 });
    assert.equal(aggregates, 2);
    external.transaction(() => {
      external.putUnit('project', unit('new', 'translated'));
      external.putUnit('project', unit('external'), 7);
    });
    assertCounts({ all: 8, pending: 1, translated: 2, untranslated: 2 });
    assert.equal(aggregates, 3);
    external.removeProject('project');
    assertCounts({ all: 0, pending: 0, translated: 0, proofread: 0, skipped: 0, untranslated: 0 });
    assert.deepEqual(store.counts('project'), { total: 0, translated: 0, proofread: 0, skipped: 0, needsEvidence: 0 });
    assert.equal(aggregates, 4);
  } finally { store.close(); external.close(); }
});
