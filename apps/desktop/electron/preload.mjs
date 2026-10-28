import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { restoreCommandError } from '../../../packages/contracts/command-errors.js';

const methods = [
  'snapshot', 'createProject', 'beginProject', 'reconnectProject', 'getProject', 'listText', 'saveSettings',
  'testConnection', 'startProject', 'continueAvailableText', 'retryAdaptation', 'pauseProject', 'cancelProject', 'deleteProject', 'saveText', 'exportPackage',
  'importPackage', 'buildProject', 'completionReport', 'exportRelease', 'cleanupProject', 'chooseDirectory',
  'chooseFile', 'chooseSaveFile', 'openPath', 'revealPath', 'launchGame', 'assistSnapshot', 'assistCommand',
  'openAssistSave', 'listAssistSaveBackups', 'restoreAssistSave', 'configureAssist', 'setAppearance', 'setWorkspaceExecution',
  'getRecollection', 'scanRecollection', 'applyRecollection', 'restoreRecollection',
];
const api = Object.fromEntries(methods.map(method => [method, async input => {
  const response = await ipcRenderer.invoke('pinhao:command', method, input);
  if (!response.ok) throw restoreCommandError(response.error);
  return response.result;
}]));
api.resolveDroppedGame = async file => {
  const filePath = webUtils.getPathForFile(file);
  if (!filePath) throw new Error('请从文件管理器拖入游戏文件夹或启动程序');
  const response = await ipcRenderer.invoke('pinhao:command', 'resolveGameImport', { path: filePath });
  if (!response.ok) throw restoreCommandError(response.error);
  return response.result;
};
api.onChanged = callback => {
  const listener = () => callback();
  ipcRenderer.on('pinhao:changed', listener);
  return () => ipcRenderer.removeListener('pinhao:changed', listener);
};
contextBridge.exposeInMainWorld('pinhao', api);

// 渲染进程未捕获错误上报。主进程只在 diagnostics.on 存在时落盘，发行版没有那个文件时这些
// 消息被静默丢弃——注册两个监听器的开销可以忽略，不必为此做条件编译。
const report = payload => { try { ipcRenderer.send('pinhao:renderer-error', payload); } catch { /* 主进程已退出 */ } };
globalThis.addEventListener?.('error', event => report({
  kind: 'error',
  message: String(event?.message ?? ''),
  source: String(event?.filename ?? ''),
  line: Number(event?.lineno) || 0,
  column: Number(event?.colno) || 0,
  stack: String(event?.error?.stack ?? '').slice(0, 4000),
}));
globalThis.addEventListener?.('unhandledrejection', event => report({
  kind: 'unhandledrejection',
  message: String(event?.reason?.message ?? event?.reason ?? ''),
  stack: String(event?.reason?.stack ?? '').slice(0, 4000),
}));
