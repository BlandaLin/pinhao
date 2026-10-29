export function createRecollectionHost({ service, assist, gameSessions }) {
  const working = new Set();
  async function exclusive(projectId, operation) {
    if (working.has(projectId)) throw new Error('正在应用此项目的回想方案');
    working.add(projectId);
    try { return await operation(); }
    finally { working.delete(projectId); }
  }
  return {
    async command(input) {
      if (['captureRecollection', 'applyRecollection', 'restoreRecollection'].includes(input.action)) throw new Error('请在回想与图鉴中选择已确认方案');
      await service.getProjectContext(input);
      if (input.action === 'transfer') {
        const { scan } = await service.getRecollection(input);
        const map = scan?.maps.find(map => map.id === input.params?.mapId);
        if (!map) throw new Error('请先扫描地图，并选择目标地图');
        const { x, y } = input.params;
        if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= map.width || y >= map.height) throw new Error('目标坐标超出地图范围');
      }
      return assist.command(input);
    },
    async apply({ projectId, recipeIds, gameSessionId }) {
      return exclusive(projectId, async () => {
        const active = gameSessions.current(projectId);
        if (!active?.buildId || !assist.snapshot(projectId).connected) throw new Error('请从工作台启动最新成品，再开始新游戏或读取存档。');
        const sessionId = assist.snapshot(projectId).gameSessionId;
        if (!gameSessionId || gameSessionId !== sessionId) throw new Error('游戏进度已变化，请在当前进度重新选择方案');
        const selection = await service.prepareRecollection({ projectId, recipeIds, buildId: active.buildId });
        const captured = await assist.command({ projectId, action: 'captureRecollection', params: { gameSessionId, recipeId: selection.recipeId, operations: selection.operations } });
        const backup = await service.captureRecollection({ projectId, selection, capture: captured.recollectionBackup });
        try {
          const state = await assist.command({ projectId, action: 'applyRecollection', params: { gameSessionId: backup.capture.gameSessionId, backup: backup.capture } });
          return { state, backup: await service.updateRecollectionBackup({ projectId, backupId: backup.id, status: 'applied' }) };
        } catch (error) {
          await service.updateRecollectionBackup({ projectId, backupId: backup.id, status: 'failed', error: error.message });
          throw error;
        }
      });
    },
    async restore({ projectId, backupId }) {
      return exclusive(projectId, async () => {
        const backup = await service.getRecollectionBackup({ projectId, backupId, verify: true });
        const snapshot = assist.snapshot(projectId);
        if (!snapshot.connected || snapshot.gameSessionId !== backup.capture.gameSessionId) throw new Error('请连接创建备份时的那次游玩。读档、新游戏或重启后，旧记录无法恢复当前游玩。');
        if (backup.status === 'restored') throw new Error('此备份已经恢复');
        const state = await assist.command({ projectId, action: 'restoreRecollection', params: { gameSessionId: backup.capture.gameSessionId, backup: backup.capture } });
        return { state, backup: await service.updateRecollectionBackup({ projectId, backupId, status: 'restored' }) };
      });
    },
  };
}
