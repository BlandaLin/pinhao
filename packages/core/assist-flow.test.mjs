import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { createService } from './service.mjs';
import { productWorker } from '../../apps/desktop/electron/host.mjs';
import { createRecollectionHost } from '../../apps/desktop/electron/recollection-host.mjs';
import { createAssistBridge, assistPluginSource, installAssistPlugin } from '../runtime/assist.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
test('native project builds, scans gallery conditions, applies a persisted backup and restores through the live bridge', async t => {
  const parent = path.join(root, 'local/assist-flow-tests');
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(path.join(parent, 'flow-'));
  const game = path.join(temporary, '原版');
  const put = async (name, content) => {
    const file = path.join(game, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  };
  await put('Game.exe', 'Neutral fixture, never executed');
  await put('js/rpg_core.js', 'neutral core fixture');
  await put('js/plugins.js', 'var $plugins = [];');
  await put('data/System.json', { gameTitle: 'Neutral Gallery', switches: ['', 'Gallery unlocked', 'Story chapter'], variables: [''] });
  await put('data/MapInfos.json', [null, { id: 1, name: 'Recollection Room' }]);
  await put('data/CommonEvents.json', [null]);
  await put('data/Actors.json', [null]);
  await put('data/Map001.json', { width: 10, height: 10, displayName: 'Gallery', events: [null, { id: 1, name: 'Gallery Stand', x: 2, y: 2, pages: [{ trigger: 0, conditions: { switch1Valid: true, switch1Id: 1 }, list: [{ code: 231, indent: 0, parameters: [1, 'CG_neutral', 0, 0, 0, 0, 100, 100, 255, 0] }, { code: 0, indent: 0, parameters: [] }] }] }] });
  const bundledPython = path.join(root, 'local/runtime/python/python.exe');
  const pythonPath = process.env.PINHAO_PYTHON || await access(bundledPython).then(() => bundledPython, () => 'python');
  let installations = 0;
  const worker = productWorker({ pythonPath, workerPath: path.join(root, 'adapters/python/worker.py'), toolkitPath: path.join(root, 'kits/workbench-tutorial/toolkit'),
    assistInstaller: async (...args) => { installations++; return installAssistPlugin(...args); } });
  const service = await createService({ dataDir: path.join(temporary, 'data'), worker });
  const bridge = createAssistBridge(), timers = [];
  t.after(async () => { timers.forEach(clearInterval); await bridge.close(); await service.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 3 }); });
  const project = await service.createProject({ gameDir: game });
  assert.equal(project.status, 'ready', project.lastError);
  const build = await service.buildProject({ projectId: project.id });
  const scan = await service.scanRecollection({ projectId: project.id });
  assert.equal(scan.recipes.filter(recipe => recipe.confidence === 'confirmed').length, 1);
  const switches = { 1: false, 2: false };
  const environment = await bridge.environment(project.id);
  const scope = { process: { env: environment }, require: createRequire(import.meta.url), Buffer,
    setInterval(callback) { const timer = setInterval(callback, 30); timers.push(timer); return timer; },
    $gameSystem: {}, $gameMap: { requestRefresh() {} }, $dataSystem: { switches: ['', 'Gallery unlocked', 'Story chapter'], variables: [''] },
    $dataItems: [], $dataWeapons: [], $dataArmors: [], $gameParty: { gold: () => 0, members: () => [] },
    $gameSwitches: { value: id => switches[id] || false, setValue: (id, value) => { switches[id] = value; } },
  };
  scope.window = scope;
  vm.runInNewContext(assistPluginSource, scope);
  for (let attempt = 0; attempt < 100 && !bridge.snapshot(project.id).connected; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(bridge.snapshot(project.id).connected, true);
  const host = createRecollectionHost({ service, assist: bridge, gameSessions: { current: () => ({ buildId: build.id }) } });
  const applied = await host.apply({ projectId: project.id, recipeIds: [scan.recipes[0].id], gameSessionId: bridge.snapshot(project.id).gameSessionId });
  assert.equal(switches[1], true); assert.equal(switches[2], false);
  const journal = await service.getRecollection({ projectId: project.id });
  assert.equal(journal.backups[0].status, 'applied');
  assert.equal(journal.backups[0].capture.entries[0].original, false);
  await host.restore({ projectId: project.id, backupId: applied.backup.id });
  assert.equal(switches[1], false); assert.equal(switches[2], false);
  assert.equal((await service.getRecollection({ projectId: project.id })).backups[0].status, 'restored');
  assert.equal(JSON.parse(await readFile(path.join(game, 'data/System.json'), 'utf8')).switches[1], 'Gallery unlocked');
  const enabledInstallations = installations;
  assert.ok(enabledInstallations > 0);
  await service.setAssistEnabled({ projectId: project.id, enabled: false });
  const disabled = await service.buildProject({ projectId: project.id });
  assert.equal(installations, enabledInstallations);
  assert.equal(disabled.assistance.status, 'disabled');
});
