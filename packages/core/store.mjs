import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

// 这些表达式文本必须与 units_projection 索引定义逐字一致，SQLite 才能把它们当作索引列求值
// （表达式索引按 SQL 文本匹配），从而把状态筛选、计数和轻量投影变成只读索引的覆盖扫描。
const JSON_STATUS = "json_extract(body,'$.status')";
const JSON_KIND = "json_extract(body,'$.kind')";
const JSON_REVISION = "json_extract(body,'$.revision')";
const JSON_SOURCE_HASH = "json_extract(body,'$.sourceHash')";
const JSON_REVIEW_STATUS = "json_extract(body,'$.review.status')";
const countProjection = ({ status, reviewStatus } = {}) => ({
  proofread: Number(status === 'proofread' && reviewStatus !== 'needs_evidence'),
  translated: Number(status === 'translated' || status === 'proofread' && reviewStatus === 'needs_evidence'),
  skipped: Number(status === 'skipped'), pending: Number(status === 'pending'), needsEvidence: Number(reviewStatus === 'needs_evidence'),
});

const taskProjection = task => ({ id: task.id, role: task.role, kind: task.kind, status: task.status,
  unitIds: task.unitIds ?? [], startedAt: task.startedAt, finishedAt: task.finishedAt,
  requestCount: task.requestCount ?? task.requestHistory?.length ?? 0,
  requests: (task.requestHistory ?? []).map(request => ({ id: request.id, status: request.status, code: request.code,
    category: request.category, requested: request.requested, evidenceQuery: request.evidenceQuery,
    finishReason: request.finishReason,
    transportRequests: request.transportRequests, startedAt: request.startedAt, finishedAt: request.finishedAt,
    sentAt: request.artifact?.sentAt, responseAt: request.artifact?.responseAt })) });
const taskCounts = rows => {
  const counts = { total: 0, queued: 0, running: 0, paused: 0, succeeded: 0, skipped: 0, cancelled: 0 };
  for (const row of rows) { counts.total++; counts[row.status] = (counts[row.status] ?? 0) + 1; }
  return counts;
};
const epoch = value => typeof value === 'number' ? value : Date.parse(value);
const resourceKeys = new Set(['inventory', 'coverage']);
const projectParts = value => [false, true].map(resources => Object.fromEntries(
  Object.entries(value).filter(([key]) => resourceKeys.has(key) === resources)));
const projectSelect = 'SELECT p.body,r.body AS resources FROM projects p LEFT JOIN project_resources r ON r.id=p.id';
const projectRecord = row => row && ({ ...JSON.parse(row.body), ...JSON.parse(row.resources ?? '{}') });

function runtimeStats(rows) {
  const timing = { translation: { unitIds: [], intervals: [] }, proofreading: { unitIds: [], intervals: [] } };
  let latestRunningAt;
  for (const row of rows) {
    if (row.status === 'running' && Number.isFinite(epoch(row.startedAt))) latestRunningAt = Math.max(latestRunningAt ?? 0, epoch(row.startedAt));
    const target = row.kind === 'glossary' ? undefined : timing[row.role];
    if (!target) continue;
    if (row.status === 'succeeded') target.unitIds.push(...row.unitIds);
    for (const request of row.requests) {
      const start = epoch(request.sentAt), end = epoch(request.finishedAt);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) target.intervals.push([start, end]);
    }
  }
  for (const value of Object.values(timing)) value.unitIds = [...new Set(value.unitIds)];
  return { counts: taskCounts(rows), timing, latestRunningAt, lanes: {
    adaptation: taskCounts(rows.filter(row => row.kind === 'adaptation')),
    text: taskCounts(rows.filter(row => ['translation', 'proofreading'].includes(row.role))),
  } };
}

function diagnosticStats(rows) {
  const byRole = {}, failures = new Map(), batches = {};
  for (const row of rows) {
    const role = row.kind === 'glossary' ? 'glossary' : row.role;
    const group = byRole[role] ??= { total: 0, retained: 0, received: 0, failed: 0, cancelled: 0,
      presendStale: 0, sent: 0, timeout: 0, formatError: 0, truncated: 0, evidenceQueries: 0 };
    group.total += row.requestCount;
    for (const request of row.requests) {
      group.retained++;
      if (request.status === 'received') group.received++;
      else if (request.status === 'cancelled') group.cancelled++;
      else if (request.status === 'failed' && request.code !== 'PRESEND_STALE') group.failed++;
      if (request.code === 'PRESEND_STALE') group.presendStale++;
      if (request.sentAt || request.transportRequests > 0) {
        group.sent++;
        if (Number.isFinite(request.requested) && request.requested > 0) (batches[role] ??= []).push(request.requested);
      }
      if (request.category === 'timeout' || ['ETIMEDOUT', 'TECHNICAL_REQUEST_TIMEOUT'].includes(request.code)) group.timeout++;
      if (request.category === 'response_structure' || ['INVALID_RESPONSE', 'INVALID_REVIEW'].includes(request.code)) group.formatError++;
      if (request.category === 'output_truncated' || request.finishReason === 'length') group.truncated++;
      if (request.evidenceQuery) group.evidenceQueries++;
      if (request.status === 'failed' && request.code !== 'PRESEND_STALE') {
        const item = { role, kind: row.kind ?? null, code: request.code ?? null, category: request.category ?? null };
        const key = JSON.stringify(item), previous = failures.get(key);
        failures.set(key, { ...item, count: (previous?.count ?? 0) + 1 });
      }
    }
  }
  const distributions = Object.fromEntries(Object.entries(batches).map(([role, sizes]) => {
    const sorted = sizes.sort((a, b) => a - b), distribution = {};
    for (const size of sorted) distribution[size] = (distribution[size] ?? 0) + 1;
    return [role, { n: sorted.length, mean: Number((sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(2)),
      median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1), distribution }];
  }));
  const total = Object.values(byRole).reduce((sum, value) => sum + value.total, 0);
  const retained = Object.values(byRole).reduce((sum, value) => sum + value.retained, 0);
  return { tasks: taskCounts(rows), requests: { total, retained, historyLimited: retained < total, byRole },
    failures: [...failures.values()], batchSize: { basis: 'sent-targets-retained-history', byRole: distributions } };
}

export function createStore(dataDir, { fileName = 'pinhao.sqlite', expectedProjectId } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, fileName));
  try {
  // Registered work must prove its identity before schema setup can alter an existing file.
  if (expectedProjectId !== undefined) {
    try {
      const row = db.prepare('SELECT body FROM projects WHERE id=?').get(expectedProjectId);
      if (!row || JSON.parse(row.body).id !== expectedProjectId) throw new Error('工程身份与登记记录不一致');
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_resources'").get()) {
        const resources = db.prepare('SELECT body FROM project_resources WHERE id=?').get(expectedProjectId);
        if (resources) JSON.parse(resources.body);
      }
    } catch (cause) { throw Object.assign(new Error(`工程数据库无法读取或身份不符：${cause.message}`, { cause }), { code: 'PROJECT_DATABASE_INVALID' }); }
  }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS units (project_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(project_id,id));
    CREATE INDEX IF NOT EXISTS units_project_position ON units(project_id,position);
    CREATE TABLE IF NOT EXISTS revisions (project_id TEXT NOT NULL, unit_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(project_id,unit_id,revision));
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS tasks_fingerprint ON tasks(project_id,fingerprint);
    CREATE INDEX IF NOT EXISTS tasks_status_project ON tasks(json_extract(body,'$.status'),project_id);
    CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS tasks_project_review_round ON tasks(project_id,json_extract(body,'$.reviewRoundId'));
    CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS builds (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS acceptance_receipts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS acceptance_pending ON acceptance_receipts(project_id,json_extract(body,'$.status'));
  `);
  // Cold extraction facts have one owner in the same database; progress never rewrites them.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_resources'").get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('CREATE TABLE IF NOT EXISTS project_resources(id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,body TEXT NOT NULL)');
      for (const row of db.prepare('SELECT id,body FROM projects').all()) {
        const [header, resources] = projectParts(JSON.parse(row.body));
        if (!Object.keys(resources).length) continue;
        db.prepare('INSERT INTO project_resources(id,body) VALUES(?,?)').run(row.id, JSON.stringify(resources));
        db.prepare('UPDATE projects SET body=? WHERE id=?').run(JSON.stringify(header), row.id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  // 覆盖索引即迁移：状态/kind/修订/原文哈希从 body 抽成索引键，不需要新表、回填或触发器，
  // 旧库打开后自动建一次（21243 行约 70 ms），派生数据不会与实际行漂移。
  // 建索引失败（磁盘不足、库被占）时只是退回旧执行计划：查询与结果完全一致，仅速度变慢，下次打开重试。
  let projectionReady;
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS units_projection ON units(project_id,${JSON_STATUS},position,${JSON_KIND},${JSON_REVISION},${JSON_SOURCE_HASH},id)`);
    projectionReady = true;
  } catch { projectionReady = undefined; /* 派生索引缺失不影响正确性，首次查询时再探测一次 */ }
  const statements = new Map();
  const prepare = sql => {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
  };
  const parse = (rows) => rows.map((r) => JSON.parse(r.body));
  // 索引是否可用只探测一次：缺失时 unitIndex 不带 INDEXED BY，退回旧计划但结果一致。
  const haveProjection = () => {
    projectionReady ??= Boolean(prepare("SELECT 1 AS found FROM sqlite_master WHERE type='index' AND name='units_projection'").get());
    return projectionReady;
  };
  const buildProjection = `json_patch('{}',json_object(
    'id',id,'path',json_extract(body,'$.path'),'createdAt',json_extract(body,'$.createdAt'),
    'changed',json_extract(body,'$.changed'),'checks',json_extract(body,'$.checks'),
    'launchPath',json_extract(body,'$.launchPath'),'launchArgs',json_extract(body,'$.launchArgs'),
    'assistance',json_extract(body,'$.assistance')))`;
  const countCache = new Map(), versions = new Map(), unitChanges = new Map(), taskViews = new Map();
  const unitChangeFloor = 4096, unitChangeCeiling = 65536;
  // 变更日志上限随项目规模缩放（约两个整轮）。21k 单元的整轮改动不再溢出成
  // unitChangesSince()=null，调用方因此不必回落全量 store.units()（22 MB / 约 160 ms 一次）。
  // 只读计数缓存、不额外查库：缓存未建立时退回 4096，与旧行为一致，不会引入新的 COUNT 查询。
  const journalLimit = id => Math.min(unitChangeCeiling, Math.max(unitChangeFloor, (countCache.get(id)?.total ?? 0) * 2));
  let serial = 0, externalEpoch = 0;
  let dataVersion = prepare('PRAGMA data_version').get().data_version;
  let transactionChanges;
  const versionKey = (table, id) => JSON.stringify([table, id]);
  const syncExternal = () => {
    const next = prepare('PRAGMA data_version').get().data_version;
    if (next !== dataVersion) {
      dataVersion = next; externalEpoch = ++serial;
      countCache.clear(); versions.clear(); unitChanges.clear(); taskViews.clear();
    }
  };
  const touch = (table, id) => {
    const key = versionKey(table, id);
    versions.set(key, ++serial);
    transactionChanges?.add(key);
  };
  const counts = id => {
    syncExternal();
    if (!countCache.has(id)) {
      // Review questions affect the display projection only; persisted task states still own scheduling.
      const row = prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN ${JSON_STATUS}='proofread' AND COALESCE(${JSON_REVIEW_STATUS},'')<>'needs_evidence' THEN 1 ELSE 0 END) AS proofread,
        SUM(CASE WHEN ${JSON_STATUS}='translated' OR (${JSON_STATUS}='proofread' AND ${JSON_REVIEW_STATUS}='needs_evidence') THEN 1 ELSE 0 END) AS translated,
        SUM(CASE WHEN ${JSON_STATUS}='skipped' THEN 1 ELSE 0 END) AS skipped,
        SUM(CASE WHEN ${JSON_STATUS}='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN ${JSON_REVIEW_STATUS}='needs_evidence' THEN 1 ELSE 0 END) AS needsEvidence
        FROM units WHERE project_id=?`).get(id);
      countCache.set(id, { total: row.total, proofread: row.proofread ?? 0, translated: row.translated ?? 0, skipped: row.skipped ?? 0,
        pending: row.pending ?? 0, needsEvidence: row.needsEvidence ?? 0 });
    }
    const { pending, ...result } = countCache.get(id);
    return result;
  };
  const one = (table, id) => {
    if (table === 'projects') return projectRecord(prepare(`${projectSelect} WHERE p.id=?`).get(id));
    const row = prepare(`SELECT body FROM ${table} WHERE id=?`).get(id);
    return row ? JSON.parse(row.body) : undefined;
  };
  const projectWrite = action => {
    const nested = db.isTransaction;
    db.exec(nested ? 'SAVEPOINT project_write' : 'BEGIN IMMEDIATE');
    try { const result = action(); db.exec(nested ? 'RELEASE project_write' : 'COMMIT'); return result; }
    catch (error) {
      db.exec(nested ? 'ROLLBACK TO project_write; RELEASE project_write' : 'ROLLBACK');
      throw error;
    }
  };
  const put = (table, value, projectId) => {
    if (table === 'projects') projectWrite(() => {
      const [header, resources] = projectParts(value);
      prepare('INSERT INTO projects(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(value.id, JSON.stringify(header));
      prepare('INSERT INTO project_resources(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(value.id, JSON.stringify(resources));
    });
    else if (projectId) prepare(`INSERT INTO ${table}(id,project_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(value.id, projectId, JSON.stringify(value));
    else prepare(`INSERT INTO ${table}(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(value.id, JSON.stringify(value));
    touch(table, value.id);
    if (table === 'tasks') taskViews.clear();
  };
  const patchBody = (table, id, patch) => {
    const set = [], remove = [];
    for (const [key, value] of Object.entries(patch)) {
      const pointer = '$.' + JSON.stringify(key), encoded = JSON.stringify(value);
      if (encoded === undefined) remove.push(pointer);
      else set.push(pointer, encoded);
    }
    if (!set.length && !remove.length) return { changes: 0 };
    let body = set.length ? `json_set(body,${Array.from({ length: set.length / 2 }, () => '?,json(?)').join(',')})` : 'body';
    if (remove.length) body = `json_remove(${body},${remove.map(() => '?').join(',')})`;
    return prepare(`UPDATE ${table} SET body=${body} WHERE id=?`).run(...set, ...remove, id);
  };
  const patchProject = (id, patch) => {
    syncExternal();
    const [header, resources] = projectParts(patch);
    if (!Object.keys(resources).length) {
      const result = patchBody('projects', id, header);
      if (result.changes) touch('projects', id);
      return result;
    }
    const result = projectWrite(() => {
      if (!prepare('SELECT 1 FROM projects WHERE id=?').get(id)) return { changes: 0 };
      patchBody('projects', id, header);
      prepare("INSERT INTO project_resources(id,body) VALUES(?,'{}') ON CONFLICT(id) DO NOTHING").run(id);
      return patchBody('project_resources', id, resources);
    });
    if (result.changes) touch('projects', id);
    return result;
  };
  const projectedTasks = projectId => {
    syncExternal();
    if (!taskViews.has(projectId)) {
      const rows = parse(prepare(`SELECT json_object('id',id,'role',json_extract(body,'$.role'),
        'kind',json_extract(body,'$.kind'),'status',json_extract(body,'$.status'),
        'unitIds',json_extract(body,'$.unitIds'),'startedAt',json_extract(body,'$.startedAt'),
        'finishedAt',json_extract(body,'$.finishedAt'),'requestCount',json_extract(body,'$.requestCount'),
        'requestHistory',json(COALESCE((SELECT json_group_array(json_object(
          'id',json_extract(r.value,'$.id'),'status',json_extract(r.value,'$.status'),'code',json_extract(r.value,'$.code'),
          'category',json_extract(r.value,'$.category'),'requested',json_extract(r.value,'$.requested'),
          'evidenceQuery',json_extract(r.value,'$.evidenceQuery'),'transportRequests',json_extract(r.value,'$.transportRequests'),
          'finishReason',json_extract(r.value,'$.finishReason'),
          'startedAt',json_extract(r.value,'$.startedAt'),'finishedAt',json_extract(r.value,'$.finishedAt'),
          'artifact',json_object('sentAt',json_extract(r.value,'$.artifact.sentAt'),'responseAt',json_extract(r.value,'$.artifact.responseAt'))))
          FROM json_each(tasks.body,'$.requestHistory') r),'[]'))) AS body
        FROM tasks WHERE project_id=? ORDER BY rowid`).all(projectId));
      taskViews.set(projectId, { rows: new Map(rows.map(row => [row.id, taskProjection(row)])) });
    }
    return taskViews.get(projectId);
  };
  return {
    db, one, put, patchProject, counts,
    rowVersion: (table, id) => { syncExternal(); return versions.get(versionKey(table, id)) ?? externalEpoch; },
    unitVersion: id => { syncExternal(); return versions.get(versionKey('units', id)) ?? externalEpoch; },
    unitChangesSince: (id, version) => {
      syncExternal();
      const current = versions.get(versionKey('units', id)) ?? externalEpoch;
      if (version === current) return [];
      const journal = unitChanges.get(id);
      if (!journal || version < journal.floor || version > current) return null;
      return [...journal.changed].filter(([, updated]) => updated > version).map(([unitId]) => unitId);
    },
    hasUnits: id => { syncExternal(); return countCache.has(id) ? countCache.get(id).total > 0 : Boolean(prepare('SELECT 1 FROM units WHERE project_id=? LIMIT 1').get(id)); },
    ids: table => prepare(`SELECT id FROM ${table} ORDER BY rowid DESC`).all().map(row => row.id),
    removeProject: (projectId) => {
      syncExternal();
      for (const table of ['units', 'revisions', 'tasks', 'issues', 'builds', 'imports', 'acceptance_receipts']) prepare(`DELETE FROM ${table} WHERE project_id=?`).run(projectId);
      prepare('DELETE FROM projects WHERE id=?').run(projectId);
      countCache.delete(projectId);
      unitChanges.delete(projectId);
      taskViews.delete(projectId);
      touch('units', projectId); touch('projects', projectId);
    },
    removeBuild: (projectId, id) => prepare('DELETE FROM builds WHERE project_id=? AND id=?').run(projectId, id),
    all: (table, projectId) => table === 'projects' ? prepare(`${projectSelect} ORDER BY p.rowid DESC`).all().map(projectRecord)
      : parse(projectId ? prepare(`SELECT body FROM ${table} WHERE project_id=? ORDER BY rowid`).all(projectId) : prepare(`SELECT body FROM ${table} ORDER BY rowid DESC`).all()),
    tasks: (projectId, { statuses, reviewRoundId, sceneResultsOnly = false } = {}) => {
      if (statuses?.length === 0) return [];
      const clauses = [], args = [];
      if (projectId) { clauses.push('project_id=?'); args.push(projectId); }
      if (reviewRoundId) { clauses.push("json_extract(body,'$.reviewRoundId')=?"); args.push(reviewRoundId); }
      if (sceneResultsOnly) clauses.push("json_extract(body,'$.reviewStage')='scene'");
      if (statuses) { clauses.push(`json_extract(body,'$.status') IN (${statuses.map(() => '?').join(',')})`); args.push(...statuses); }
      const projection = sceneResultsOnly ? `json_object('id',id,'projectId',project_id,'status',json_extract(body,'$.status'),
        'reviewRoundId',json_extract(body,'$.reviewRoundId'),'reviewStage',json_extract(body,'$.reviewStage'),
        'reviewScopeId',json_extract(body,'$.reviewScopeId'),'reviewScopeVersion',json_extract(body,'$.reviewScopeVersion'),
        'unitIds',json_extract(body,'$.unitIds'),'candidateRecords',json_extract(body,'$.candidateRecords'),
        'reviewedUnitIds',json_extract(body,'$.reviewedUnitIds'),
        'reviewCandidate',json_object('reviewedIds',json_extract(body,'$.reviewCandidate.reviewedIds'))) AS body` : 'body';
      return parse(prepare(`SELECT ${projection} FROM tasks${reviewRoundId ? ' INDEXED BY tasks_project_review_round' : statuses ? ' INDEXED BY tasks_status_project' : ''}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY rowid${projectId ? '' : ' DESC'}`).all(...args));
    },
    taskByFingerprint: (projectId, fingerprint) => {
      const row = prepare('SELECT body FROM tasks WHERE project_id=? AND fingerprint=?').get(projectId, fingerprint);
      return row ? JSON.parse(row.body) : undefined;
    },
    taskOrder: id => prepare('SELECT rowid FROM tasks WHERE id=?').get(id)?.rowid,
    taskStats: projectId => {
      const cached = projectedTasks(projectId);
      return cached.runtime ??= runtimeStats([...cached.rows.values()]);
    },
    diagnosticStats: projectId => {
      const cached = projectedTasks(projectId);
      return cached.diagnostic ??= diagnosticStats([...cached.rows.values()]);
    },
    taskSummaries: (projectId, { limit = 8 } = {}) => ({
      total: prepare('SELECT COUNT(*) AS total FROM tasks WHERE project_id=?').get(projectId).total,
      tasks: parse(prepare(`SELECT json_patch(json_object(
        'id',id,'role',json_extract(body,'$.role'),'kind',json_extract(body,'$.kind'),'status',json_extract(body,'$.status'),
        'unitIds',json_extract(body,'$.unitIds'),'attempts',json_extract(body,'$.attempts')),
        json_patch(CASE WHEN COALESCE(json_extract(body,'$.error'),'')<>'' THEN json_object('error',json_extract(body,'$.error')) ELSE '{}' END,
        CASE WHEN json_extract(body,'$.status') IN ('running','paused') AND json_array_length(body,'$.requestHistory')>0
          THEN json_object('progress',json_object(
            'receivedCharacters',COALESCE(json_extract(body,'$.requestHistory[#-1].receivedCharacters'),0),
            'textCharacters',json_extract(body,'$.requestHistory[#-1].textCharacters'),
            'reasoningCharacters',json_extract(body,'$.requestHistory[#-1].reasoningCharacters'),
            'checkpointed',COALESCE(json_array_length(body,'$.candidateRecords'),0),
            'requested',COALESCE(NULLIF(json_array_length(body,'$.unitIds'),0),json_array_length(body,'$.input'))))
          ELSE '{}' END)) AS body
        FROM tasks WHERE project_id=? ORDER BY rowid DESC LIMIT ?`).all(projectId, limit)).reverse(),
    }),
    buildSummaries: projectId => parse(prepare(`SELECT ${buildProjection} AS body FROM builds WHERE project_id=? ORDER BY rowid`).all(projectId)),
    latestBuild: (projectId, { summaryOnly = false } = {}) => {
      const row = prepare(`SELECT ${summaryOnly ? `${buildProjection} AS body` : 'body'} FROM builds WHERE project_id=? ORDER BY rowid DESC LIMIT 1`).get(projectId);
      return row ? JSON.parse(row.body) : undefined;
    },
    units: (id) => parse(prepare('SELECT body FROM units WHERE project_id=? ORDER BY position').all(id)),
    unitProgress: (projectId, unitId) => {
      const sql = `SELECT id,CASE WHEN ${JSON_STATUS}='proofread' AND ${JSON_REVIEW_STATUS}='needs_evidence'
        THEN 'translated' ELSE ${JSON_STATUS} END AS status FROM units WHERE project_id=?`;
      const project = row => row && ({ id: row.id, status: row.status ?? undefined });
      return unitId === undefined ? prepare(`${sql} ORDER BY position`).all(projectId).map(project)
        : project(prepare(`${sql} AND id=?`).get(projectId, unitId));
    },
    // 轻量投影：只从 units_projection 覆盖索引取规划所需字段，完全不读 body（unit body 中 context 占 67.8%）。
    // 返回 [{ id, status, kind, revision, sourceHash, position }]，按 position 升序，缺失字段按 JSON.parse 口径为 undefined。
    // statuses 传字符串或数组；空数组返回 []；limit 传负数表示不限制。
    // 强制 INDEXED BY：不加时规划器为省排序会改用 units_project_position 并整行回表（同数据 41 ms → 9.9 ms）。
    unitIndex: (projectId, { statuses, limit = -1, offset = 0 } = {}) => {
      syncExternal();
      const wanted = typeof statuses === 'string' ? [statuses] : statuses;
      if (wanted && !wanted.length) return [];
      const clauses = ['project_id=?'], args = [projectId];
      if (wanted?.length) { clauses.push(`${JSON_STATUS} IN (${wanted.map(() => '?').join(',')})`); args.push(...wanted); }
      return prepare(`SELECT id,${JSON_STATUS} AS status,${JSON_KIND} AS kind,${JSON_REVISION} AS revision,${JSON_SOURCE_HASH} AS sourceHash,position
        FROM units${haveProjection() ? ' INDEXED BY units_projection' : ''} WHERE ${clauses.join(' AND ')} ORDER BY position LIMIT ? OFFSET ?`).all(...args, limit, offset)
        .map(row => ({ id: row.id, status: row.status ?? undefined, kind: row.kind ?? undefined, revision: row.revision ?? undefined, sourceHash: row.sourceHash ?? undefined, position: row.position }));
    },
    page: (id, { offset, limit, search, filter }) => {
      const clauses = ['project_id=?'];
      const args = [id];
      if (search) { clauses.push(`(instr(lower(json_extract(body,'$.source')),lower(?))>0 OR instr(lower(json_extract(body,'$.translation')),lower(?))>0 OR instr(lower(json_extract(body,'$.notes')),lower(?))>0 OR instr(id,?)>0)`); args.push(search, search, search, search); }
      if (filter && filter !== 'all') {
        if (filter === 'changed') clauses.push(`json_extract(body,'$.translation')<>json_extract(body,'$.source')`);
        else if (filter === 'untranslated') clauses.push(`json_extract(body,'$.status') IN ('pending','skipped')`);
        else if (filter === 'needs_evidence') clauses.push(`${JSON_REVIEW_STATUS}='needs_evidence'`);
        else if (filter === 'proofread') clauses.push(`${JSON_STATUS}='proofread' AND COALESCE(${JSON_REVIEW_STATUS},'')<>'needs_evidence'`);
        else if (filter === 'translated') clauses.push(`(${JSON_STATUS}='translated' OR (${JSON_STATUS}='proofread' AND ${JSON_REVIEW_STATUS}='needs_evidence'))`);
        else { clauses.push(`json_extract(body,'$.status')=?`); args.push(filter); }
      }
      const where = clauses.join(' AND ');
      let total;
      if (!search && (!filter || ['all', 'pending', 'translated', 'proofread', 'skipped', 'untranslated', 'needs_evidence'].includes(filter))) {
        counts(id);
        const current = countCache.get(id);
        total = filter === 'untranslated' ? current.pending + current.skipped : current[!filter || filter === 'all' ? 'total' : filter === 'needs_evidence' ? 'needsEvidence' : filter];
      } else total = prepare(`SELECT COUNT(*) AS total FROM units WHERE ${where}`).get(...args).total;
      return { total, units: parse(prepare(`SELECT body FROM units WHERE ${where} ORDER BY position LIMIT ? OFFSET ?`).all(...args, limit, offset)) };
    },
    unit: (projectId, id) => { const row = prepare('SELECT body FROM units WHERE project_id=? AND id=?').get(projectId, id); return row ? JSON.parse(row.body) : undefined; },
    putUnit: (projectId, unit, position = 0) => {
      syncExternal();
      const previousVersion = versions.get(versionKey('units', projectId)) ?? externalEpoch;
      const cached = countCache.get(projectId);
      const previous = cached ? prepare(`SELECT ${JSON_STATUS} AS status,${JSON_REVIEW_STATUS} AS reviewStatus FROM units WHERE project_id=? AND id=?`).get(projectId, unit.id) : undefined;
      const result = prepare('INSERT INTO units(project_id,id,position,body) VALUES(?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET body=excluded.body').run(projectId, unit.id, position, JSON.stringify(unit));
      if (cached) {
        if (!previous) cached.total++;
        const before = countProjection(previous), after = countProjection({ status: unit.status, reviewStatus: unit.review?.status });
        for (const key of Object.keys(after)) cached[key] += after[key] - before[key];
      }
      touch('units', projectId);
      let journal = unitChanges.get(projectId);
      if (!journal) { journal = { floor: previousVersion, changed: new Map() }; unitChanges.set(projectId, journal); }
      journal.changed.delete(unit.id);
      journal.changed.set(unit.id, serial);
      if (journal.changed.size > journalLimit(projectId)) {
        const [oldestId, oldestVersion] = journal.changed.entries().next().value;
        journal.changed.delete(oldestId); journal.floor = oldestVersion;
      }
      return result;
    },
    revision: (projectId, id, revision) => { const row = prepare('SELECT body FROM revisions WHERE project_id=? AND unit_id=? AND revision=?').get(projectId, id, revision); return row ? JSON.parse(row.body) : undefined; },
    addRevision: (projectId, unit) => prepare('INSERT INTO revisions(project_id,unit_id,revision,body) VALUES(?,?,?,?)').run(projectId, unit.id, unit.revision, JSON.stringify({ translation: unit.translation, notes: unit.notes, sourceHash: unit.sourceHash })),
    putTask: (projectId, task) => {
      syncExternal();
      const result = prepare('INSERT INTO tasks(id,project_id,fingerprint,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,body=excluded.body').run(task.id, projectId, task.fingerprint, JSON.stringify(task));
      const cached = taskViews.get(projectId);
      if (cached) {
        const projected = taskProjection(task);
        if (JSON.stringify(cached.rows.get(task.id)) !== JSON.stringify(projected)) {
          cached.rows.set(task.id, projected); cached.runtime = undefined; cached.diagnostic = undefined;
        }
      }
      return result;
    },
    transaction: (fn) => {
      db.exec('BEGIN IMMEDIATE'); transactionChanges = new Set();
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) {
        db.exec('ROLLBACK'); countCache.clear(); taskViews.clear();
        for (const key of transactionChanges) {
          versions.set(key, ++serial);
          const [table, id] = JSON.parse(key);
          if (table === 'units') unitChanges.delete(id);
        }
        throw error;
      } finally { transactionChanges = undefined; }
    },
    // 维护入口，不在热路径调用：删除项目只做 DELETE，612 MB 空洞要靠这里回收。
    // mode='full' 执行 VACUUM（整库重写，需与库同量级的临时空间，必须由调用方在空闲时、库外无事务时触发）；
    compact: ({ mode = 'full' } = {}) => {
      syncExternal();
      if (transactionChanges) throw new Error('compact() 不能在事务中执行');
      try { prepare('PRAGMA wal_checkpoint(PASSIVE)').get(); } catch { /* 有读者时退化为不检查点，不影响压缩本身 */ }
      const freelist = () => prepare('PRAGMA freelist_count').get().freelist_count;
      const before = freelist();
      if (mode === 'full') db.exec('VACUUM');
      else throw new Error(`未知的压缩模式：${mode}`);
      countCache.clear();
      return { mode, freelistBefore: before, freelistAfter: freelist() };
    },
    close: () => { countCache.clear(); versions.clear(); unitChanges.clear(); taskViews.clear(); statements.clear(); db.close(); },
  };
  } catch (error) { if (db.isOpen) db.close(); throw error; }
}
