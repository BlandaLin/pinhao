import { stat } from 'node:fs/promises';
import path from 'node:path';

/** Bind a user-selected save to its project and serialize edits against game launches. */
export function createSaveAssist({ service, worker, gameSessions }) {
  const selected = new Map();
  const working = new Set();
  async function locked(projectId, operation) {
    if (working.has(projectId)) throw new Error('存档正在处理中，请稍后继续');
    working.add(projectId);
    try { return await gameSessions.cleanup(projectId, operation); }
    finally { working.delete(projectId); }
  }
  async function context(projectId) {
    const project = await service.getProjectContext({ projectId });
    const build = project.builds.at(-1);
    return { project, outputDir: build?.path || project.gameDir, buildId: build?.id };
  }
  function projectEntry(projectId, { project, outputDir, buildId }) {
    return { projectId, outputDir, buildId, engine: project.engine,
      backupDir: path.join(project.workspaceDir, 'assist-backups') };
  }
  function request(entry) {
    return { outputDir: entry.outputDir, ...(entry.filePath ? { filePath: entry.filePath } : {}), engine: entry.engine,
      backupDir: entry.backupDir, binding: { projectId: entry.projectId, buildId: entry.buildId ?? null } };
  }
  function capture(entry, state) {
    if (state.saveFile?.path !== entry.filePath || !/^[a-f0-9]{64}$/.test(state.saveFile.sha256)) throw new Error('未能校验这份存档，请重新选择。');
    entry.state = { ...state, mode: 'save', connected: true, ready: true };
    return entry.state;
  }
  return {
    forget(projectId) { selected.delete(projectId); },
    async open({ projectId, filePath }) {
      return locked(projectId, async () => {
        const { project, outputDir, buildId } = await context(projectId);
        const entry = { projectId, filePath: path.resolve(filePath), outputDir, buildId, engine: project.engine,
          backupDir: path.join(project.workspaceDir, 'assist-backups') };
        const result = await worker('assistSaveRead', request(entry));
        capture(entry, result);
        selected.set(projectId, entry);
        return entry.state;
      });
    },
    async snapshot({ projectId }) {
      const { project, buildId } = await context(projectId);
      const entry = selected.get(projectId);
      const waiting = { engine: project.engine, mode: 'save', connected: false, ready: false, actions: [], detail: '选择游戏存档，读取数值、开关与变量。' };
      if (!entry) return waiting;
      if (entry.buildId !== buildId) { selected.delete(projectId); return { ...waiting, detail: '成品已更新，请重新选择存档。' }; }
      if (gameSessions.current(projectId)) return { ...entry.state, connected: false, ready: false, detail: '关闭游戏后读取和修改存档。' };
      if (working.has(projectId)) return entry.state;
      return locked(projectId, async () => {
        try {
          const info = await stat(entry.filePath);
          const stamp = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
          if (entry.stamp === stamp) return entry.state;
          const result = await worker('assistSaveRead', request(entry));
          entry.stamp = stamp;
          return capture(entry, { ...result, saveFile: { ...result.saveFile, ...(entry.state.saveFile.backupPath ? { backupPath: entry.state.saveFile.backupPath } : {}), backupDir: entry.state.saveFile.backupDir } });
        } catch (error) {
          if (error.code !== 'ENOENT' && !await stat(entry.filePath).then(() => false, failure => failure.code === 'ENOENT')) throw error;
          selected.delete(projectId);
          return { ...waiting, detail: '此存档已移动或删除，请重新选择存档。' };
        }
      });
    },
    async command({ projectId, action, id, type, value, params, expectedSaveSha256 }) {
      return locked(projectId, async () => {
        const { buildId } = await context(projectId);
        const entry = selected.get(projectId);
        if (!entry || entry.buildId !== buildId) throw new Error('请重新选择当前成品的存档');
        if (expectedSaveSha256 !== entry.state.saveFile.sha256) throw new Error('存档版本已变化，请重新选择待修改项');
        if (!entry.state.actions.includes(action)) throw new Error('请选择当前存档提供的辅助操作');
        let result;
        try {
          result = await worker('assistSaveWrite', { ...request(entry), expectedSha256: expectedSaveSha256,
            action, id, type, value, params });
        } catch (error) {
          if (await stat(entry.filePath).then(() => false, failure => failure.code === 'ENOENT')) {
            selected.delete(projectId);
            throw new Error('此存档已移动或删除，请重新选择存档。', { cause: error });
          }
          throw error;
        }
        delete entry.stamp;
        return capture(entry, { ...result, saveFile: { ...result.saveFile, backupDir: request(entry).backupDir } });
      });
    },
    async listBackups({ projectId }) {
      return locked(projectId, async () => {
        const entry = projectEntry(projectId, await context(projectId));
        return worker('assistSaveBackups', request(entry));
      });
    },
    async restore({ projectId, backupId, expectedSaveSha256, expectedAbsent }) {
      return locked(projectId, async () => {
        const entry = projectEntry(projectId, await context(projectId));
        if (expectedAbsent === true ? expectedSaveSha256 !== undefined : !/^[a-f0-9]{64}$/.test(expectedSaveSha256 || '')) {
          throw new Error('存档版本已变化，请重新查看待恢复项');
        }
        if (typeof backupId !== 'string' || !/^[a-f0-9]{64}$/.test(backupId)) throw new Error('请选择当前存档提供的备份记录');
        const result = await worker('assistSaveRestore', { ...request(entry), backupId,
          ...(expectedAbsent === true ? { expectedAbsent: true } : { expectedSha256: expectedSaveSha256 }) });
        if (!result.saveFile?.path || !path.isAbsolute(result.saveFile.path)) throw new Error('恢复结果缺少存档路径，请保留备份并重新读取');
        entry.filePath = path.resolve(result.saveFile.path);
        const state = capture(entry, { ...result, saveFile: { ...result.saveFile, backupDir: entry.backupDir } });
        selected.set(projectId, entry);
        return state;
      });
    },
  };
}
