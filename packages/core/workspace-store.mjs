import path from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createStore as createDatabaseStore } from './store.mjs';
import { PROJECT_LAYOUT, readProjectWorkspace } from './project-layout.mjs';

const projectMethods = ['counts', 'hasUnits', 'unitVersion', 'unitChangesSince', 'taskByFingerprint', 'taskStats', 'diagnosticStats',
  'taskSummaries', 'buildSummaries', 'latestBuild', 'units', 'unitIndex', 'unitProgress', 'page', 'unit', 'revision'];
const emptyCounts = () => ({ total: 0, proofread: 0, translated: 0, skipped: 0, needsEvidence: 0 });
const catalogProject = value => Object.fromEntries(['id', 'name', 'gameDir', 'workspaceDir', 'engine', 'createdAt'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));

/** The application owns an index; each project owns all growing work and recovery data. */
export function createStore(dataDir) {
  const catalog = createDatabaseStore(dataDir, { fileName: 'catalog.sqlite' });
  const opened = new Map(), owners = new Map(), heads = new Map(), failures = new Map();
  let transactionId;
  const ids = () => catalog.ids('projects');
  const headFor = id => {
    const version = catalog.rowVersion('projects', id), cached = heads.get(id);
    if (cached?.version === version) return cached.value;
    const value = catalog.one('projects', id);
    heads.set(id, { version, value }); return value;
  };
  const get = (id, required = false) => {
    const head = headFor(id);
    if (!head) {
      if (required) throw new Error('工程未登记，请重新导入游戏');
      return undefined;
    }
    if (!existsSync(path.join(head.workspaceDir, 'pinhao.sqlite'))) {
      failures.delete(id);
      if (required) throw Object.assign(new Error(`工程目录无法访问，请重新连接磁盘：${head.workspaceDir}`), { code: 'PROJECT_LOCATION_UNAVAILABLE' });
      return undefined;
    }
    if (!opened.has(id)) {
      try {
        opened.set(id, createDatabaseStore(head.workspaceDir, { expectedProjectId: id }));
        failures.delete(id);
      } catch (error) {
        if (!error.code?.startsWith('ERR_SQLITE') && !['PROJECT_DATABASE_INVALID', 'EACCES', 'EPERM', 'EIO', 'ENOENT', 'ENOTDIR', 'EROFS'].includes(error.code)) throw error;
        failures.set(id, { code: error.code, message: error.message });
        if (required) throw Object.assign(new Error(`工程数据库无法读取，原文件已保留：${head.workspaceDir}；${error.message}`, { cause: error }), { code: 'PROJECT_DATABASE_UNAVAILABLE' });
        return undefined;
      }
    }
    return opened.get(id);
  };
  const writable = id => {
    if (transactionId && transactionId !== id) throw new Error('一个事务只能修改同一个工程');
    return get(id, true);
  };
  const remember = (table, projectId, value) => {
    if (value?.id) owners.set(`${table}:${value.id}`, projectId);
    return value;
  };
  const locate = (table, id) => {
    const known = owners.get(`${table}:${id}`), prior = known && get(known)?.one(table, id);
    if (prior) return { projectId: known, store: get(known), value: prior };
    for (const projectId of ids()) {
      const store = get(projectId), value = store?.one(table, id);
      if (value) { remember(table, projectId, value); return { projectId, store, value }; }
    }
    return undefined;
  };
  const unavailable = head => ({ ...head, status: 'paused', stage: failures.has(head.id) ? '工程数据库无法读取' : '工程目录无法访问', unavailable: true,
    lastError: failures.has(head.id) ? `工程数据库无法读取，原文件已保留：${head.workspaceDir}；${failures.get(head.id).message}` : `请重新连接工程所在磁盘：${head.workspaceDir}` });
  const api = {
    db: catalog.db,
    one(table, id) {
      if (table === 'settings') return catalog.one(table, id);
      if (table === 'projects') {
        const head = headFor(id);
        return head && (get(id)?.one(table, id) ?? unavailable(head));
      }
      return locate(table, id)?.value;
    },
    put(table, value, projectId) {
      if (table === 'settings') return catalog.put(table, value);
      if (table !== 'projects') {
        if (!projectId) throw new Error('工程记录必须指定所属工程');
        remember(table, projectId, value); return writable(projectId).put(table, value, projectId);
      }
      const head = headFor(value.id);
      if (head && path.resolve(head.workspaceDir) !== path.resolve(value.workspaceDir)) throw new Error('工程位置不能通过修改记录静默变更');
      if (!head) {
        if (!value.workspaceDir) throw new Error('新工程需要独立工作目录');
        const local = createDatabaseStore(value.workspaceDir);
        try {
          local.put('projects', value);
          catalog.put('projects', catalogProject(value));
          opened.set(value.id, local);
        } catch (error) { local.close(); throw error; }
        return;
      }
      return writable(value.id).put('projects', value);
    },
    async reconnectProject({ workspaceDir }) {
      const identity = await readProjectWorkspace(workspaceDir);
      const check = project => {
        if (project?.id !== identity.id || project.storageLayout !== PROJECT_LAYOUT) throw new Error('工程数据库身份或布局不符，只能重新连接当前版本创建的工程');
        if (path.resolve(project.workspaceDir ?? '') !== identity.workspaceDir) throw new Error('工程目录已移动，本轮不支持移动后继续制作，请将工程放回原路径后重新连接');
        if (path.resolve(project.gameDir ?? '') !== identity.gameDir) throw new Error('原游戏路径与工程记录不一致，请将原游戏放回原路径');
      };
      // Explicit reconnection is the only preflight read; normal project access uses one connection.
      const inspection = new DatabaseSync(path.join(identity.workspaceDir, 'pinhao.sqlite'), { readOnly: true });
      try { const row = inspection.prepare('SELECT body FROM projects WHERE id=?').get(identity.id); check(row && JSON.parse(row.body)); }
      finally { inspection.close(); }
      const head = headFor(identity.id);
      if (head && path.resolve(head.workspaceDir) !== identity.workspaceDir) throw new Error('已有同一身份的工程登记在其他位置，请先处理冲突，不能覆盖登记');
      if (opened.has(identity.id)) return get(identity.id).one('projects', identity.id);
      const local = createDatabaseStore(identity.workspaceDir, { expectedProjectId: identity.id });
      try {
        const project = local.one('projects', identity.id); check(project);
        if (!head) catalog.put('projects', catalogProject(project));
        opened.set(identity.id, local); failures.delete(identity.id); heads.delete(identity.id);
        return project;
      } catch (error) { local.close(); throw error; }
    },
    patchProject: (id, patch) => writable(id).patchProject(id, patch),
    rowVersion(table, id) {
      if (table === 'settings') return catalog.rowVersion(table, id);
      if (table === 'projects') {
        const local = get(id);
        return local ? `available:${local.rowVersion(table, id)}` : `unavailable:${catalog.rowVersion(table, id)}:${JSON.stringify(failures.get(id))}`;
      }
      return locate(table, id)?.store.rowVersion(table, id) ?? 0;
    },
    ids(table) { return table === 'projects' || table === 'settings' ? catalog.ids(table) : ids().flatMap(id => get(id)?.ids(table) ?? []); },
    all(table, projectId) {
      if (table === 'projects' || table === 'settings') return api.ids(table).map(id => api.one(table, id));
      const values = projectId ? get(projectId)?.all(table, projectId) ?? [] : ids().flatMap(id => get(id)?.all(table, id) ?? []);
      for (const value of values) if (projectId) remember(table, projectId, value);
      return values;
    },
    tasks(projectId, options) {
      const values = projectId ? get(projectId)?.tasks(projectId, options) ?? [] : ids().flatMap(id => get(id)?.tasks(id, options) ?? []);
      for (const value of values) remember('tasks', value.projectId ?? projectId, value);
      return values;
    },
    putUnit: (id, unit, position) => writable(id).putUnit(id, unit, position),
    addRevision: (id, unit) => writable(id).addRevision(id, unit),
    putTask(id, task) { remember('tasks', id, task); return writable(id).putTask(id, task); },
    taskOrder: id => locate('tasks', id)?.store.taskOrder(id),
    removeBuild: (id, buildId) => writable(id).removeBuild(id, buildId),
    transaction(id, action) {
      const local = get(id, true);
      return local.transaction(() => {
        transactionId = id;
        try { return action(); }
        finally { transactionId = undefined; }
      });
    },
    removeProject(id) {
      opened.get(id)?.close(); opened.delete(id);
      catalog.removeProject(id);
      heads.delete(id); failures.delete(id);
      for (const [key, owner] of owners) if (owner === id) owners.delete(key);
    },
    compact: ({ projectId, ...options } = {}) => projectId ? get(projectId, true).compact(options) : catalog.compact(options),
    close() { for (const local of opened.values()) local.close(); opened.clear(); owners.clear(); heads.clear(); failures.clear(); catalog.close(); },
  };
  for (const method of projectMethods) api[method] = (id, ...args) => {
    const local = get(id);
    if (local) return local[method](id, ...args);
    if (method === 'counts') return emptyCounts();
    if (method === 'unitVersion') return 0;
    if (method === 'hasUnits') return false;
    if (method === 'page') return { total: 0, units: [] };
    if (method === 'taskSummaries') return { total: 0, tasks: [] };
    if (method === 'taskStats') return { counts: { total: 0 }, timing: {}, lanes: { adaptation: {}, text: {} } };
    if (method === 'diagnosticStats') return { tasks: { total: 0 }, requests: { total: 0, byRole: {} }, failures: [], batchSize: { byRole: {} } };
    if (method === 'unitProgress') return args[0] === undefined ? [] : undefined;
    return ['units', 'unitIndex', 'buildSummaries'].includes(method) ? [] : undefined;
  };
  return api;
}
