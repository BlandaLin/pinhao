import { installAssistPlugin } from '../../../packages/runtime/assist.mjs';
import { clearAssistSession } from '../../../packages/runtime/session-file.mjs';

export function createLiveAssist({ service, assist, worker, gameSessions, install = installAssistPlugin }) {
  const installations = new Map();
  return {
    async install(project, build) {
      if (project.assistEnabled === false) {
        await clearAssistSession(build.path);
        return { supported: false, status: 'disabled', detail: '实时辅助已关闭，未安装辅助插件' };
      }
      const result = await install(build.path, { worker });
      if (result.status === 'install_failed' && result.restored !== true) throw Object.assign(new Error('辅助安装未完成且无法确认原文件已恢复，请先处理安装恢复记录'), { code: 'ASSIST_INSTALL_RECOVERY_REQUIRED' });
      installations.set(project.id, result);
      return result;
    },
    async configure({ projectId, enabled }) {
      if (typeof enabled !== 'boolean') throw new Error('请选择开启或关闭实时辅助');
      return gameSessions.cleanup(projectId, async () => {
        const project = await service.getProjectContext({ projectId });
        const build = project.builds.at(-1);
        const engine = project.engine.toLowerCase().replace(/rpg maker|[\s_\/-]/g, '');
        if (!enabled && build) await clearAssistSession(build.path);
        if (!enabled && build && ['xp', 'vx', 'vxa', 'vxace'].includes(engine)) {
          await worker('assistUninstall', { outputDir: build.path });
        }
        const detail = await service.setAssistEnabled({ projectId, enabled });
        assist.disconnect(projectId);
        return detail;
      });
    },
    async snapshot({ projectId }) {
      const project = await service.getProjectContext({ projectId });
      const installation = installations.get(projectId);
      if (project.assistEnabled !== false && installation?.status === 'install_failed') return { connected: false, detail: installation.detail || '辅助安装失败且已恢复原文件，当前按普通模式游玩' };
      return project.assistEnabled === false
        ? { connected: false, detail: '实时辅助已关闭。可重新开启，或直接启动成品游玩。' }
        : assist.snapshot(projectId);
    },
    async requireEnabled({ projectId }) {
      const project = await service.getProjectContext({ projectId });
      if (project.assistEnabled === false) throw new Error('实时辅助已关闭，请先开启再连接游戏');
    },
  };
}
