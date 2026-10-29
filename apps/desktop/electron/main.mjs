import { tr, uiLanguage, uiMessage } from "../shared/ui-language.js";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, protocol, safeStorage, shell } from 'electron';
import { commandErrorRecord } from '../../../packages/contracts/command-errors.js';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';
import { createServiceClient } from './service-client.mjs';
import { createGameSessions, existingPathWithin, gameExecutable, productWorker, revealExportedFile, seedDefaultFont, serviceMethods, startGame } from './host.mjs';
import { createAssistBridge } from '../../../packages/runtime/assist.mjs';
import { runDesktopSmoke } from './smoke.mjs';
import { configureSystemTrust } from './network.mjs';
import { resolveGameImport } from './game-import.mjs';
import { fontCatalog, fontPreview } from './fonts.mjs';
import { createRecollectionHost } from './recollection-host.mjs';
import { createSaveAssist } from './save-assist.mjs';
import { createLiveAssist } from './live-assist.mjs';
import { writeAssistSession } from '../../../packages/runtime/session-file.mjs';
import { createSecrets } from './secrets.mjs';
import { createAppearance } from './appearance.mjs';
import { diagnosticsEnabled, writeCrashLog, appendRendererError, createCommandLog, writeRunSummary, createRunSummaryMonitor } from './diagnostics.mjs';
import { configureDesktopStorage, desktopDataDirectory, importWithWorkspaceSelection } from './storage.mjs';

const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
if (uiLanguage === 'en') app.commandLine.appendSwitch('lang', 'en-US');
const dataDir = desktopDataDirectory({ packaged: app.isPackaged, execPath: process.execPath, sourceRoot,
  override: process.env.PINHAO_DATA_DIR, smoke: process.env.PINHAO_SMOKE === '1' });
let storageFailure;
try { configureDesktopStorage(app, dataDir); } catch (error) { storageFailure = error; }
protocol.registerSchemesAsPrivileged([{ scheme: 'pinhao-font', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setAppUserModelId('org.pinhao.workbench');
let window, service;
const exportedPaths = new Set();
const gameSessions = createGameSessions();
const assist = createAssistBridge();
const smokeLog = message => {
  if (process.env.PINHAO_SMOKE !== '1' || storageFailure) return;
  appendFileSync(path.join(dataDir, 'desktop-smoke.log'), new Date().toISOString() + ' ' + message + '\n');
  console.log(message);
};
smokeLog('Main module loaded');

if (storageFailure) {
  console.error(storageFailure);
  if (process.env.PINHAO_SMOKE !== '1') dialog.showErrorBox(tr("无法打开数据文件夹"), tr`无法写入数据文件夹：${dataDir}\n请检查该位置的写入权限和磁盘空间后重新打开。`);
  app.exit(1);
} else if (!app.requestSingleInstanceLock()) app.quit();
else {
  // Relaunching while the previous process is still winding down fires this on a window whose
  // BrowserWindow object survives but is already destroyed; `?.` does not cover that case.
  app.on('second-instance', () => {
    if (!window || window.isDestroyed()) return;
    try { window.restore(); window.focus(); } catch { /* Already gone. */ }
  });
  app.whenReady().then(async () => {
  smokeLog('Electron ready');
  Menu.setApplicationMenu(null);
  const trust = configureSystemTrust();
  smokeLog(`Network trust ready: ${trust.system} system roots, ${trust.total} total roots`);
  const resourceRoot = app.isPackaged ? path.join(app.getAppPath(), 'resources') : sourceRoot;
  const pythonPath = app.isPackaged
    ? path.join(resourceRoot, 'python', 'python.exe')
    : process.env.PINHAO_PYTHON || path.join(sourceRoot, 'local', 'runtime', 'python', 'python.exe');
  // 诊断只在 dataDir 下存在 diagnostics.on 标记文件时启用；发行版没有这个文件，这些注册全部跳过。
  const commandLog = createCommandLog();
  const diagnostics = diagnosticsEnabled(dataDir);
  let summaryMonitor;
  if (diagnostics) {
    const describe = () => ({ packaged: app.isPackaged, window: window ? { destroyed: window.isDestroyed() } : null });
    process.on('uncaughtException', error => {
      writeCrashLog(dataDir, { kind: 'uncaughtException', error, extra: describe(), recentCommands: commandLog.snapshot() });
      process.exitCode = 1;
    });
    process.on('unhandledRejection', error => {
      writeCrashLog(dataDir, { kind: 'unhandledRejection', error, extra: describe(), recentCommands: commandLog.snapshot() });
    });
    ipcMain.on('pinhao:renderer-error', (_event, payload) => appendRendererError(dataDir, payload));
  }
  const appearance = await createAppearance({ directory: dataDir, nativeTheme, onChanged: color => {
    try { if (window && !window.isDestroyed()) window.setBackgroundColor(color); } catch { /* Window already gone. */ }
  } });
  const defaultFont = await seedDefaultFont({ dataDir, bundledFontDir: app.isPackaged ? path.join(resourceRoot, 'fonts') : path.join(sourceRoot, 'local/runtime/fonts') });
  protocol.handle('pinhao-font', request => {
    const url = new URL(request.url);
    if (url.hostname !== 'builtin' || !['GET', 'HEAD'].includes(request.method)) return new Response('Font not found', { status: 404 });
    return fontPreview(defaultFont.fonts, url.pathname.slice(1));
  });
  const secrets = createSecrets(safeStorage);
  const workerOptions = {
      pythonPath,
      dshRuntimeRoot: app.isPackaged ? path.join(resourceRoot, 'dsh') : path.join(sourceRoot, 'local/dsh-runtime'),
      workerPath: app.isPackaged ? path.join(resourceRoot, 'adapters', 'worker.py') : path.join(sourceRoot, 'adapters', 'python', 'worker.py'),
      toolkitPath: app.isPackaged ? path.join(resourceRoot, 'toolkit') : path.join(sourceRoot, 'kits', 'workbench-tutorial', 'toolkit'),
      dependencyDir: app.isPackaged ? path.join(resourceRoot, 'dependencies') : path.join(sourceRoot, 'local', 'dependencies'),
      toolVersionsPath: app.isPackaged ? path.join(resourceRoot, 'tool-versions.json') : path.join(sourceRoot, 'local/runtime/tool-versions.json'),
      defaultFontPath: defaultFont.fontPath, fontLicensePath: defaultFont.licensePath, fonts: defaultFont.fonts,
    };
  const engineWorker = productWorker(workerOptions);
  service = await createServiceClient({
    dataDir, secrets, defaultFontPath: defaultFont.fontPath,
    defaultTargetLanguage: uiLanguage === 'en' ? 'en' : 'zh-Hans',
    workerOptions,
    // Quitting races with in-flight work (a delete plus a running translation still emits
    // `changed`): the BrowserWindow can outlive its webContents, so both are checked and any
    // late notification is dropped instead of crashing the main process.
    onChanged: () => {
      try {
        if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('pinhao:changed');
      } catch { /* No receiver is left while the app closes. */ }
      summaryMonitor?.changed();
    },
  });
  if (diagnostics) {
    summaryMonitor = createRunSummaryMonitor({ enabled: () => diagnostics,
      getHeads: () => service.diagnosticSnapshot(),
      getSnapshot: projectId => service.diagnosticSnapshot({ projectId }),
      write: snapshot => writeRunSummary(dataDir, snapshot) });
    await summaryMonitor.prime();
  }
  smokeLog('Domain service ready');
  const recollection = createRecollectionHost({ service, assist, gameSessions });
  const saveAssist = createSaveAssist({ service, worker: engineWorker, gameSessions });
  const liveAssist = createLiveAssist({ service, assist, worker: engineWorker, gameSessions });
  const uiPath = app.isPackaged ? path.join(app.getAppPath(), 'ui', 'index.html') : path.join(sourceRoot, 'apps', 'desktop', 'dist', 'index.html');
  const windowIcon = nativeImage.createFromPath(path.join(path.dirname(uiPath), 'pinhao-app-icon.png'));
  const preload = app.isPackaged ? path.join(app.getAppPath(), 'preload.cjs') : path.join(sourceRoot, 'apps', 'desktop', 'dist-host', 'preload.cjs');
  const uiUrl = pathToFileURL(uiPath).href;
  ipcMain.handle('pinhao:command', async (event, method, input) => {
    if (diagnostics) commandLog.record(method, input);
    try {
      if (event.sender !== window?.webContents || event.senderFrame?.url !== uiUrl) throw new Error(tr("请求来源无效，请重新打开工作台。"));
      if (serviceMethods.has(method)) {
        const result = ['cleanupProject', 'deleteProject'].includes(method)
          ? await gameSessions.cleanup(input.projectId, () => service[method](input))
          : ['createProject', 'beginProject'].includes(method)
          ? await importWithWorkspaceSelection(value => service[method](value), input, async error => {
            const confirmation = await dialog.showMessageBox(window, { type: 'warning', title: tr("请选择工程位置"),
              message: tr("无法在此位置创建工程"), detail: tr`${uiMessage(error.message)}\n请选择可写且空间充足的文件夹。`,
              buttons: [tr("选择其他位置"), tr("取消")], defaultId: 0, cancelId: 1, noLink: true });
            if (confirmation.response !== 0) return null;
            const selection = await dialog.showOpenDialog(window, { title: tr("选择拼好工程保存位置"), properties: ['openDirectory', 'createDirectory'] });
            return selection.canceled ? null : selection.filePaths[0];
          })
          : await service[method](input);
        if (method === 'deleteProject') { assist.disconnect(input.projectId); saveAssist.forget(input.projectId); }
        if (method === 'snapshot') result.fonts = fontCatalog(defaultFont.fonts);
        if (['exportRelease', 'exportPackage'].includes(method) && result?.path) {
          exportedPaths.add(path.resolve(result.path));
          if (method === 'exportRelease') shell.showItemInFolder(path.resolve(result.path));
        }
        return { ok: true, result };
      }
      let result;
      switch (method) {
        case 'setAppearance': result = await appearance.setTheme(input?.theme); break;
        case 'resolveGameImport': result = await resolveGameImport(input?.path, file => shell.readShortcutLink(file)); break;
        case 'chooseDirectory': {
          const selection = await dialog.showOpenDialog(window, { title: input?.title || tr("选择游戏目录"), properties: ['openDirectory'] });
          result = selection.canceled ? null : selection.filePaths[0]; break;
        }
        case 'chooseFile': {
          const filters = input?.kind === 'font'
            ? [{ name: tr("字体"), extensions: ['ttf', 'otf'] }]
            : [{ name: tr("文字工作包"), extensions: ['zip'] }];
          const selection = await dialog.showOpenDialog(window, { title: input?.title || tr("选择文件"), properties: ['openFile'], filters });
          result = selection.canceled ? null : selection.filePaths[0]; break;
        }
        case 'chooseSaveFile': {
          const filters = input?.kind === 'rga' ? [{ name: tr("JoiPlay 游戏包"), extensions: ['rga'] }] : [{ name: tr("ZIP 压缩包"), extensions: ['zip'] }];
          const selection = await dialog.showSaveDialog(window, { title: input?.title || tr("导出"), defaultPath: input?.defaultPath, filters });
          result = selection.canceled ? null : selection.filePath; break;
        }
        case 'openPath': {
          const snapshot = await service.snapshot();
          const roots = [dataDir, ...snapshot.projects.flatMap(project => [project.workspaceDir, project.gameDir])];
          for (const project of snapshot.projects) {
            const detail = await service.getProjectContext({ projectId: project.id });
            roots.push(...detail.builds.map(build => build.path));
          }
          const target = await existingPathWithin(input.path, roots);
          const error = await shell.openPath(target);
          if (error) throw new Error(error);
          break;
        }
        case 'revealPath': await revealExportedFile(input.path, exportedPaths, target => shell.showItemInFolder(target)); break;
        case 'launchGame': {
          await gameSessions.launch(input.projectId, async () => {
            const project = await service.getProjectContext(input);
            const build = input.buildId ? project.builds.find(build => build.id === input.buildId) : project.builds.at(-1);
            const executable = await gameExecutable(service, { projectId: input.projectId, buildId: build?.id });
            const installation = await liveAssist.install(project, build);
            let child;
            let cleanSession = async () => {};
            try {
              const environment = installation.supported ? await assist.environment(input.projectId, { transport: installation.transport,
                backupDir: path.join(project.workspaceDir, 'assist-backups') }) : {};
              cleanSession = await writeAssistSession(build.path, environment);
              child = await startGame(executable, environment, build?.launchArgs || []);
              child.once('exit', (code) => {
                assist.disconnect(input.projectId); void cleanSession();
                void service.recordRuntimeObservation({ projectId: input.projectId, buildId: build.id, kind: 'process-exit',
                  status: code === 0 ? 'passed' : 'pending', detail: code === 0 ? tr("游戏已正常退出") : tr`游戏已退出（${code ?? tr("信号结束")}），请查看游戏日志。` }).catch(() => {});
              });
              await service.recordRuntimeObservation({ projectId: input.projectId, buildId: build.id, kind: 'launch', status: 'passed',
                detail: installation.status === 'install_failed' ? tr`${installation.detail || tr("辅助安装失败，原文件已恢复")}；游戏已启动，本次未启用辅助。`
                  : tr("游戏已启动。请检查对白、选项、字体和存读档。") }).catch(() => {});
            }
            catch (error) { assist.disconnect(input.projectId); await cleanSession(); throw error; }
            return { child, executable, buildId: build?.id };
          });
          break;
        }
        case 'assistSnapshot':
          if (input.mode === 'save') result = await saveAssist.snapshot(input);
          else result = await liveAssist.snapshot(input);
          break;
        case 'assistCommand':
          if (input.mode === 'save') result = await saveAssist.command(input);
          else { await liveAssist.requireEnabled(input); result = await recollection.command(input); }
          break;
        case 'configureAssist': result = await liveAssist.configure(input); break;
        case 'listAssistSaveBackups': result = await saveAssist.listBackups(input); break;
        case 'restoreAssistSave': result = await saveAssist.restore(input); break;
        case 'openAssistSave': {
          const project = await service.getProjectContext(input);
          if (gameSessions.current(input.projectId)) throw new Error(tr("请先关闭游戏，再读取存档"));
          const selection = await dialog.showOpenDialog(window, { title: tr("选择游戏存档"),
            defaultPath: project.builds.at(-1)?.path || project.gameDir, properties: ['openFile'],
            filters: [{ name: tr("可编辑的游戏存档"), extensions: ['lsd', 'sav'] }] });
          result = selection.canceled ? null : await saveAssist.open({ projectId: input.projectId, filePath: selection.filePaths[0] });
          break;
        }
        case 'applyRecollection': result = await recollection.apply(input); break;
        case 'restoreRecollection': result = await recollection.restore(input); break;
        default: throw new Error(tr("未知操作"));
      }
      return { ok: true, result };
    } catch (error) { return { ok: false, error: commandErrorRecord(error) }; }
  });
  window = new BrowserWindow({
    width: 1366, height: 900, minWidth: 900, minHeight: 620,
    title: tr("拼好汉化"), backgroundColor: appearance.backgroundColor, show: false,
    icon: windowIcon,
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  smokeLog('Window created');
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => { if (target !== uiUrl) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.once('ready-to-show', () => window.show());
  await window.loadFile(uiPath);
  smokeLog('Renderer loaded');
  if (process.env.PINHAO_SMOKE === '1') {
    console.log(JSON.stringify(await runDesktopSmoke({ service, window, windowIcon, secrets, dataDir, gameDir: process.env.PINHAO_SMOKE_GAME })));
    setTimeout(() => app.quit(), 1500);
  }
  app.on('window-all-closed', () => app.quit());
  let closing = false;
  app.on('before-quit', event => {
    if (closing) return;
    event.preventDefault(); closing = true;
    // Deleting a project while a translation is in flight can keep close() busy for a long time.
    // The window is already gone at this point, so waiting indefinitely looks like a hang: give
    // cleanup a bounded window, then quit anyway. Work is checkpointed per unit, so an abrupt
    // exit loses at most the batch that was in flight.
    const cleanup = Promise.allSettled([service.close?.(), assist.close(), engineWorker.closeExecution?.(), summaryMonitor?.close()]);
    const deadline = new Promise(resolve => setTimeout(resolve, 8000));
    Promise.race([cleanup, deadline]).finally(() => app.quit());
  });
  }).catch(error => {
    smokeLog(`Startup failed: ${error.stack || error.message}`);
    console.error(error);
    if (process.env.PINHAO_SMOKE !== '1') dialog.showErrorBox(tr("工作台启动失败"), error.message);
    app.exit(1);
  });
}
