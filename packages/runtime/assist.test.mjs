import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { assistActions, assistPluginSource, createAssistBridge, encodeAssistValue, installAssistPlugin } from './assist.mjs';
import { outputManifest, verifyOutput } from '../core/output-manifest.mjs';

async function bundledPlugin() {
  const result = await build({ entryPoints: [fileURLToPath(new URL('./assist.mjs', import.meta.url))], platform: 'node', target: 'node24', format: 'esm', external: ['node:*'], bundle: true, write: false });
  const bundled = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
  return bundled.assistPluginSource;
}

test('independent game launch leaves assistance disconnected', () => {
  vm.runInNewContext(assistPluginSource, { process: { env: {} }, require: () => { throw new Error('should not connect'); }, setInterval: () => { throw new Error('should not poll'); } });
});

test('bundled optional assistance uses native state methods and reads actual results back', async t => {
  const bridge = createAssistBridge();
  t.after(() => bridge.close());
  const environment = await bridge.environment('neutral');
  const timers = [];
  let gold = 200, healed = 0;
  const item = { id: 1, name: 'Potion' }, counts = { 1: 2 }, switches = { 1: false }, variables = { 1: 5 };
  const scope = {
    process: { env: environment }, require: createRequire(import.meta.url), Buffer,
    setInterval: callback => { const timer = setInterval(callback, 80); timers.push(timer); return timer; },
    $gameSystem: {}, $dataItems: [null, item], $dataWeapons: [], $dataArmors: [],
    $dataSystem: { switches: ['', 'Door'], variables: ['', 'Counter'] },
    $gameSwitches: { value: id => switches[id], setValue: (id, value) => { switches[id] = value; } },
    $gameVariables: { value: id => variables[id], setValue: (id, value) => { variables[id] = value; } },
    $gameMap: { requestRefresh() {} },
    $gameParty: {
      gold: () => gold, gainGold: amount => { gold += amount; }, numItems: item => counts[item.id], gainItem: (item, amount) => { counts[item.id] += amount; },
      members: () => [{ actorId: () => 1, name: () => 'Hero', hp: 30, mp: 5, level: 2, recoverAll: () => { healed++; } }],
    },
  };
  scope.window = scope;
  t.after(() => timers.forEach(clearInterval));
  const source = await bundledPlugin();
  assert.doesNotMatch(source, /\b__require\b/);
  vm.runInNewContext(source, scope);
  for (let n = 0; n < 100 && !bridge.snapshot('neutral').connected; n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(bridge.snapshot('neutral').gold, 200);
  const params = { gameSessionId: bridge.snapshot('neutral').gameSessionId };
  const changed = await bridge.command({ projectId: 'neutral', action: 'setGold', value: 450, params });
  assert.equal(changed.gold, 450);
  await bridge.command({ projectId: 'neutral', action: 'setItem', type: 'item', id: 1, value: 8, params });
  assert.equal(counts[1], 8);
  await bridge.command({ projectId: 'neutral', action: 'setSwitch', id: 1, value: true, params });
  assert.equal(switches[1], true);
  await bridge.command({ projectId: 'neutral', action: 'setVariable', id: 1, value: 'ready', params });
  assert.equal(variables[1], 'ready');
  await bridge.command({ projectId: 'neutral', action: 'heal', params }); assert.equal(healed, 1);
  assert.throws(() => bridge.command({ projectId: 'neutral', action: 'setGold', value: -5 }), /非负整数/);
  const rejected = await fetch(`http://127.0.0.1:${environment.PINHAO_ASSIST_PORT}/state?token=wrong`, { method: 'POST', body: '{}' });
  assert.equal(rejected.status, 403);
});

test('NW loader fallback works and title screen waits for a loaded game', async t => {
  const bridge = createAssistBridge();
  t.after(() => bridge.close());
  const environment = await bridge.environment('title');
  const timers = [];
  function Scene_Title() {}
  const scope = { process: { env: environment }, nw: { require: createRequire(import.meta.url) }, Buffer,
    Scene_Title, SceneManager: { _scene: new Scene_Title() }, $gameParty: {}, $gameSystem: {}, $dataSystem: {},
    setInterval: callback => { const timer = setInterval(callback, 30); timers.push(timer); return timer; } };
  scope.window = scope;
  t.after(() => timers.forEach(clearInterval));
  vm.runInNewContext(await bundledPlugin(), scope);
  for (let n = 0; n < 100 && bridge.snapshot('title').ready === undefined; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(bridge.snapshot('title').ready, false);
  assert.equal(bridge.snapshot('title').connected, false);
});

test('MV/MZ exposes existing unnamed switches and variables for direct manual editing', async t => {
  const bridge = createAssistBridge(), timers = [];
  t.after(() => bridge.close());
  t.after(() => timers.forEach(clearInterval));
  for (const engine of ['MV', 'MZ']) {
    const environment = await bridge.environment('unnamed-' + engine);
    const switches = [false, false, true, false], variables = [0, 8, 'text', { internal: true }];
    const scope = {
      process: { env: environment }, require: createRequire(import.meta.url), Buffer,
      setInterval: callback => { const timer = setInterval(callback, 30); timers.push(timer); return timer; },
      Utils: { RPGMAKER_NAME: engine }, $gameSystem: {}, $dataItems: [], $dataWeapons: [], $dataArmors: [],
      $dataSystem: { switches: ['', '', '   ', 'Named'], variables: ['', '', 'Named', 'Internal'] },
      $gameSwitches: { value: id => switches[id], setValue: (id, value) => { switches[id] = value; } },
      $gameVariables: { value: id => variables[id], setValue: (id, value) => { variables[id] = value; } },
      $gameMap: { requestRefresh() {} }, $gameParty: { gold: () => 0, members: () => [] },
    };
    scope.window = scope;
    vm.runInNewContext(assistPluginSource, scope);
    const projectId = 'unnamed-' + engine;
    for (let n = 0; n < 100 && !bridge.snapshot(projectId).connected; n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(bridge.snapshot(projectId).switches.map(row => [row.id, row.name]), [[1, '开关 #1'], [2, '开关 #2'], [3, 'Named']]);
    assert.deepEqual(bridge.snapshot(projectId).variables.map(row => [row.id, row.name]), [[1, '变量 #1'], [2, 'Named']]);
    const params = { gameSessionId: bridge.snapshot(projectId).gameSessionId };
    await bridge.command({ projectId, action: 'setSwitch', id: 1, value: true, params });
    await bridge.command({ projectId, action: 'setVariable', id: 1, value: 'manual', params });
    assert.equal(switches[1], true);
    assert.equal(variables[1], 'manual');
    await assert.rejects(bridge.command({ projectId, action: 'setSwitch', id: 4, value: true, params }), /现有开关/);
    await assert.rejects(bridge.command({ projectId, action: 'setVariable', id: 4, value: 1, params }), /现有变量/);
    assert.equal(switches.length, 4);
    assert.equal(variables.length, 4);
  }
});

test('file bridge tracks authenticated rewrites rather than rereading an unchanged old snapshot', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const bridge = createAssistBridge();
  t.after(() => bridge.close());
  const environment = await bridge.environment('file-heartbeat', { transport: 'file' });
  const stateFile = path.join(environment.PINHAO_ASSIST_DIR, 'state.json');
  const payload = JSON.stringify({ token: environment.PINHAO_ASSIST_TOKEN, state: { ready: true, gameSessionId: 'stationary' }, results: [] });
  const rewrite = async (text, atomic = false) => {
    now += 1000;
    await writeFile(atomic ? stateFile + '.tmp' : stateFile, text);
    if (atomic) await rename(stateFile + '.tmp', stateFile);
    await new Promise(resolve => setTimeout(resolve, 300));
  };
  await rewrite(payload);
  assert.equal(bridge.snapshot('file-heartbeat').connected, true);
  for (let n = 0; n < 6; n++) await rewrite(payload, n % 2 === 1);
  assert.equal(bridge.snapshot('file-heartbeat').connected, true, 'identical authenticated writes are live heartbeats');
  now += 5000;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(bridge.snapshot('file-heartbeat').connected, false, 'rereading the last file is not a heartbeat');
  assert.throws(() => bridge.command({ projectId: 'file-heartbeat', action: 'heal' }), /启动成品/);
  await rewrite(payload.replace(environment.PINHAO_ASSIST_TOKEN, 'wrong-token'));
  assert.equal(bridge.snapshot('file-heartbeat').connected, false);
  await rewrite('{"token":');
  assert.equal(bridge.snapshot('file-heartbeat').connected, false);
  await rewrite(payload, true);
  assert.equal(bridge.snapshot('file-heartbeat').connected, true, 'a valid atomic replacement reconnects');
});

test('commands remain available until acknowledged and relaunch closes the previous session', async t => {
  const bridge = createAssistBridge();
  t.after(() => bridge.close());
  const [environment, second] = await Promise.all([bridge.environment('reliable'), bridge.environment('other')]);
  assert.equal(environment.PINHAO_ASSIST_PORT, second.PINHAO_ASSIST_PORT);
  const url = `http://127.0.0.1:${environment.PINHAO_ASSIST_PORT}/state?token=${environment.PINHAO_ASSIST_TOKEN}`;
  const post = async payload => (await fetch(url, { method: 'POST', body: JSON.stringify(payload) })).json();
  await post({ state: { ready: true, gold: 10, gameSessionId: 'reliable-save' } });
  const params = { gameSessionId: 'reliable-save' };
  const pending = bridge.command({ projectId: 'reliable', action: 'setGold', value: 25, params });
  const first = await post({ state: { ready: true, gold: 10 } });
  assert.equal(first.commands.length, 1);
  assert.deepEqual((await post({ state: { ready: true, gold: 10 } })).commands, first.commands);
  assert.equal((await post({ state: { ready: true, gold: 25, gameSessionId: 'reliable-save' }, results: [{ id: first.commands[0].id }] })).commands.length, 0);
  assert.equal((await pending).gold, 25);
  const interrupted = bridge.command({ projectId: 'reliable', action: 'heal', params });
  const rejection = assert.rejects(interrupted, /辅助连接已关闭/);
  await bridge.environment('reliable');
  await rejection;
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403);
});

test('duplicate delivery executes a native command once and retries a lost acknowledgement', async () => {
  let tick, healed = 0, failAck = true;
  const requests = [];
  const command = { id: 'one-command', action: 'heal' };
  const http = { request(_options, callback) {
    let onError;
    return { setTimeout() {}, on(name, handler) { if (name === 'error') onError = handler; }, end(body) {
      const payload = JSON.parse(body); requests.push(payload);
      if (payload.results.length && failAck) { failAck = false; onError(new Error('connection reset')); return; }
      const listeners = {};
      callback({ statusCode: 200, on(name, handler) { listeners[name] = handler; } });
      command.params = { gameSessionId: payload.state.gameSessionId };
      listeners.data(JSON.stringify({ commands: payload.results.length ? [] : [command] })); listeners.end();
    } };
  } };
  const scope = { process: { env: { PINHAO_ASSIST_PORT: '1234', PINHAO_ASSIST_TOKEN: 'test' } }, require: () => http, Buffer,
    setInterval: callback => { tick = callback; }, $gameSystem: {}, $dataItems: [], $dataWeapons: [], $dataArmors: [],
    $dataSystem: { switches: [], variables: [] }, $gameParty: { gold: () => 1, members: () => [{ actorId: () => 1, name: () => 'Hero', recoverAll: () => { healed++; } }] } };
  scope.window = scope;
  vm.runInNewContext(assistPluginSource, scope);
  tick(); tick(); tick(); tick();
  assert.equal(healed, 1);
  assert.deepEqual(requests[2].results, [{ id: 'one-command' }]);
  assert.equal(requests[3].results.length, 0);
});

test('ordinary commands bind their game session and retain action parameters', async t => {
  const bridge = createAssistBridge();
  t.after(() => bridge.close());
  const environment = await bridge.environment('session-command');
  const url = `http://127.0.0.1:${environment.PINHAO_ASSIST_PORT}/state?token=${environment.PINHAO_ASSIST_TOKEN}`;
  const post = async payload => (await fetch(url, { method: 'POST', body: JSON.stringify(payload) })).json();
  await post({ state: { ready: true, gameSessionId: 'save-A' } });
  assert.throws(() => bridge.command({ projectId: 'session-command', action: 'setGold', value: 20, params: { gameSessionId: 'old-save' } }), /当前存档/);
  assert.throws(() => bridge.command({ projectId: 'session-command', action: 'setGold', value: 20 }), /当前存档/);
  const pending = bridge.command({ projectId: 'session-command', action: 'jump', params: { dx: 1, dy: 2, gameSessionId: 'save-A' } });
  const { commands } = await post({ state: { ready: true, gameSessionId: 'save-A' } });
  assert.deepEqual(commands[0].params, { dx: 1, dy: 2, gameSessionId: 'save-A' });
  await post({ state: { ready: true, gameSessionId: 'save-A' }, results: [{ id: commands[0].id }] });
  await pending;
});

test('MV/MZ rejects a queued ordinary command after loading another save', () => {
  let tick, changed = false;
  let current = { gold: 5 };
  const http = { request(_options, callback) {
    return { setTimeout() {}, on() {}, end(body) {
      const payload = JSON.parse(body);
      const listeners = {};
      if (!changed) {
        changed = true;
        current = { gold: 700 };
        scope.$gameSystem = {};
      }
      callback({ statusCode: 200, on(name, handler) { listeners[name] = handler; } });
      listeners.data(JSON.stringify({ commands: [{ id: 'old-save-command', action: 'setGold', value: 20, params: { gameSessionId: payload.state.gameSessionId } }] }));
      listeners.end();
    } };
  } };
  const scope = { process: { env: { PINHAO_ASSIST_PORT: '1234', PINHAO_ASSIST_TOKEN: 'test' } }, require: () => http, Buffer,
    setInterval: callback => { tick = callback; }, $gameSystem: {}, $dataItems: [], $dataWeapons: [], $dataArmors: [],
    $dataSystem: { switches: [], variables: [] },
    $gameParty: { gold: () => current.gold, gainGold: amount => { current.gold += amount; }, members: () => [] } };
  scope.window = scope;
  vm.runInNewContext(assistPluginSource, scope);
  tick();
  assert.equal(current.gold, 700);
});

test('assistance plugin installs in copied MV game and preserves command symbols', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-assist-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'js/plugins'), { recursive: true }); await mkdir(path.join(root, 'data'));
  await writeFile(path.join(root, 'js/rpg_core.js'), ''); await writeFile(path.join(root, 'data/System.json'), '{}');
  await writeFile(path.join(root, 'js/plugins.js'), 'var $plugins = [{"name":"Existing","status":true,"parameters":{"id":"keep"}}];\n// PinHao localization runtime\n$plugins.push({name:"PinHaoLocalization",status:true});\n');
  assert.equal((await installAssistPlugin(root)).supported, true);
  const plugins = await readFile(path.join(root, 'js/plugins.js'), 'utf8');
  assert.match(plugins, /Existing/); assert.match(plugins, /PinhaoAssist/); assert.match(plugins, /keep/);
  assert.match(plugins, /PinHaoLocalization/);
  await writeFile(path.join(root, 'js/plugins.js'), plugins + '$plugins.push({name:"LaterPlugin",status:true});\n');
  await installAssistPlugin(root);
  const updated = await readFile(path.join(root, 'js/plugins.js'), 'utf8');
  assert.equal(updated.match(/"name": "PinhaoAssist"/g).length, 1);
  assert.match(updated, /LaterPlugin/);
});

test('MZ and www MV installs create a missing plugins directory', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-assist-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [directory, prefix, engine, core] of [['mz', '', 'MZ', 'rmmz_core.js'], ['mv', 'www', 'MV', 'rpg_core.js']]) {
    const game = path.join(root, directory), content = path.join(game, prefix);
    await mkdir(path.join(content, 'data'), { recursive: true });
    await mkdir(path.join(content, 'js'), { recursive: true });
    await writeFile(path.join(content, 'data/System.json'), '{}');
    await writeFile(path.join(content, 'js', core), '');
    await writeFile(path.join(content, 'js/plugins.js'), 'var $plugins = [];\n');
    assert.equal((await installAssistPlugin(game)).engine, engine);
    assert.equal(await readFile(path.join(content, 'js/plugins/PinhaoAssist.js'), 'utf8'), assistPluginSource);
  }
});

test('repeated launch installation preserves MV/MZ bytes, custom plugins and output proof', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-assist-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, prefix, core] of [['mv', '', 'rpg_core.js'], ['mz', '', 'rmmz_core.js'], ['www', 'www', 'rpg_core.js']]) {
    const game = path.join(root, name), content = path.join(game, prefix), pluginsFile = path.join(content, 'js/plugins.js');
    await mkdir(path.join(content, 'js'), { recursive: true }); await mkdir(path.join(content, 'data'));
    await writeFile(path.join(content, 'data/System.json'), '{}'); await writeFile(path.join(content, 'js', core), '');
    const original = 'var $plugins=[{"name":"Custom","status":true,"parameters":{"message":"keep"}}];\r\n\r\n// user configuration\r\n';
    await writeFile(pluginsFile, original);
    await installAssistPlugin(game);
    const installed = await readFile(pluginsFile), proof = await outputManifest(game);
    for (let launch = 0; launch < 3; launch++) {
      await installAssistPlugin(game);
      assert.deepEqual(await readFile(pluginsFile), installed);
      assert.equal((await verifyOutput(game, proof)).valid, true);
    }
    assert.ok(installed.toString('utf8').startsWith(original));
  }
});

test('file bridge accepts authenticated snapshots, acknowledges commands and cleans its session', async t => {
  const bridge = createAssistBridge();
  t.after(() => bridge.close());
  const environment = await bridge.environment('rgss', { transport: 'file' });
  const directory = environment.PINHAO_ASSIST_DIR;
  const stateFile = path.join(directory, 'state.json');
  const state = { ready: true, engine: 'XP', mode: 'live', gameSessionId: 'rgss-save', actions: assistActions, gold: 40, actors: [{ id: 1, name: '林', hp: 80, mp: 12, level: 3, exp: 20, maxHp: 100, maxMp: 15, maxLevel: 99 }] };
  await writeFile(stateFile, JSON.stringify({ token: 'incorrect', sequence: 1, state }));
  await new Promise(resolve => setTimeout(resolve, 230));
  assert.equal(bridge.snapshot('rgss').connected, false);
  await writeFile(stateFile, JSON.stringify({ token: environment.PINHAO_ASSIST_TOKEN, sequence: 2, state }));
  for (let n = 0; n < 50 && !bridge.snapshot('rgss').connected; n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(bridge.snapshot('rgss').actors[0].name, '林');
  const changed = bridge.command({ projectId: 'rgss', action: 'setLevel', id: 1, value: 8, params: { gameSessionId: 'rgss-save' } });
  let commands = '';
  for (let n = 0; n < 50 && !commands.includes('setLevel'); n++) { commands = await readFile(path.join(directory, 'commands.txt'), 'utf8'); await new Promise(resolve => setTimeout(resolve, 20)); }
  const [token, command] = commands.split('\n');
  const [id, action, target, type, valueType, hex] = command.split('\t');
  assert.equal(token, environment.PINHAO_ASSIST_TOKEN);
  assert.equal(action, 'setLevel'); assert.equal(target, '1'); assert.equal(type, ''); assert.equal(valueType, 'tagged'); assert.equal(Buffer.from(hex, 'hex').toString(), encodeAssistValue({ value: 8, params: { gameSessionId: 'rgss-save' } }));
  const updated = { ...state, actors: [{ ...state.actors[0], level: 8 }] };
  await writeFile(stateFile, JSON.stringify({ token, sequence: 3, state: updated, results: [{ id }] }));
  assert.equal((await changed).actors[0].level, 8);
  await bridge.close();
  await assert.rejects(readFile(path.join(directory, 'commands.txt')), { code: 'ENOENT' });
});

test('RGSS installer delegates only copied native script containers to the worker', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-assist-rgss-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'Data'));
  await writeFile(path.join(root, 'Data/Scripts.rvdata2'), 'native fixture');
  const calls = [];
  const installed = await installAssistPlugin(root, { worker: async (command, input) => { calls.push([command, input]); return { supported: true, engine: 'VX Ace', transport: 'file' }; } });
  assert.equal(installed.transport, 'file');
  assert.deepEqual(calls, [['assistInstall', { outputDir: root }]]);
});

test('file bridge reads KAG UTF-16LE and UTF-8 BOM snapshots with the same authenticated protocol', async t => {
  const bridge = createAssistBridge();
  t.after(() => bridge.close());
  const environment = await bridge.environment('kag-unicode', { transport: 'file' });
  const target = path.join(environment.PINHAO_ASSIST_DIR, 'state.json');
  for (const [encoding, value] of [['utf16le', 12], ['utf8', 13]]) {
    const raw = JSON.stringify({ token: environment.PINHAO_ASSIST_TOKEN,
      state: { ready: true, engine: 'KiriKiri/KAG', actions: [], namedVariables: [{ scope: 'store', store: 'f', name: '金钱', type: 'number', value }] } });
    await writeFile(target, Buffer.concat([Buffer.from(encoding === 'utf16le' ? [255, 254] : [239, 187, 191]), Buffer.from(raw, encoding)]));
    for (let n = 0; n < 60 && bridge.snapshot('kag-unicode').namedVariables?.[0]?.value !== value; n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(bridge.snapshot('kag-unicode').namedVariables[0].value, value);
    assert.equal(bridge.snapshot('kag-unicode').namedVariables[0].name, '金钱');
  }
});

test('MV/MZ actor operations call native methods and read back clamped values', async t => {
  const bridge = createAssistBridge();
  t.after(() => bridge.close());
  const environment = await bridge.environment('actors');
  const timers = [];
  const actor = { actorId: () => 1, name: () => 'Hero', hp: 20, mp: 4, level: 2, mhp: 100, mmp: 30, exp: 10,
    currentExp() { return this.exp; }, maxLevel: () => 99,
    changeLevel(value) { this.level = Math.min(99, value); }, changeExp(value) { this.exp = value; },
    setHp(value) { this.hp = Math.min(this.mhp, value); }, setMp(value) { this.mp = Math.min(this.mmp, value); } };
  const scope = { process: { env: environment }, require: createRequire(import.meta.url), Buffer,
    setInterval: callback => { const timer = setInterval(callback, 30); timers.push(timer); return timer; },
    $gameSystem: {}, $dataItems: [], $dataWeapons: [], $dataArmors: [], $dataSystem: { switches: [], variables: [] },
    $gameParty: { gold: () => 20, members: () => [actor] } };
  scope.window = scope;
  t.after(() => timers.forEach(clearInterval));
  vm.runInNewContext(assistPluginSource, scope);
  for (let n = 0; n < 100 && !bridge.snapshot('actors').connected; n++) await new Promise(resolve => setTimeout(resolve, 10));
  const params = { gameSessionId: bridge.snapshot('actors').gameSessionId };
  assert.equal((await bridge.command({ projectId: 'actors', action: 'setLevel', id: 1, value: 110, params })).actors[0].level, 99);
  assert.equal((await bridge.command({ projectId: 'actors', action: 'setExp', id: 1, value: 500, params })).actors[0].exp, 500);
  assert.equal((await bridge.command({ projectId: 'actors', action: 'setHp', id: 1, value: 999, params })).actors[0].hp, 100);
  assert.equal((await bridge.command({ projectId: 'actors', action: 'setMp', id: 1, value: 24, params })).actors[0].mp, 24);
  assert.throws(() => bridge.command({ projectId: 'actors', action: 'setLevel', id: 1, value: 0 }), /非负整数/);
});

async function liveMovementFixture(t) {
  const bridge = createAssistBridge();
  t.after(() => bridge.close());
  const environment = await bridge.environment('live');
  const timers = [], switches = { 1: false, 2: false }, variables = { 1: 3 }, selfSwitches = {};
  function Scene_Map() { this.children = []; }
  const scene = new Scene_Map();
  let mapId = 1, eventRunning = false;
  const player = { x: 3, y: 4, through: false, speed: 4, facing: 2, transferring: false,
    isThrough() { return this.through; }, setThrough(value) { this.through = value; }, moveSpeed() { return this.speed; }, setMoveSpeed(value) { this.speed = value; },
    direction() { return this.facing; }, isTransferring() { return this.transferring; }, makeEncounterCount() {},
    jump(dx, dy) { this.x += dx; this.y += dy; },
    reserveTransfer(target, x, y, direction) { this.transferring = true; setTimeout(() => { mapId = target; this.x = x; this.y = y; if (direction) this.facing = direction; this.transferring = false; }, 90); } };
  const scope = { process: { env: environment }, require: createRequire(import.meta.url), Buffer,
    setInterval: callback => { const timer = setInterval(callback, 30); timers.push(timer); return timer; },
    Scene_Map, SceneManager: { _scene: scene }, $gamePlayer: player,
    $gameSystem: { encounter: true, isEncounterEnabled() { return this.encounter; }, enableEncounter() { this.encounter = true; }, disableEncounter() { this.encounter = false; } },
    $gameMap: { mapId: () => mapId, isEventRunning: () => eventRunning, isValid: (x, y) => x >= 0 && y >= 0 && x < 20 && y < 20, requestRefresh() {} },
    $dataMap: { displayName: '林间村庄' }, $dataItems: [], $dataWeapons: [], $dataArmors: [], $dataSystem: { switches: ['', 'Gallery', 'Unused'], variables: ['', 'Progress'] },
    $gameParty: { gold: () => 20, members: () => [], inBattle: () => false },
    $gameSwitches: { value: id => switches[id] || false, setValue: (id, value) => { switches[id] = value; } },
    $gameVariables: { value: id => variables[id] || 0, setValue: (id, value) => { variables[id] = value; } },
    $gameSelfSwitches: { value: key => selfSwitches[key] || false, setValue: (key, value) => { selfSwitches[key] = value; } } };
  scope.window = scope;
  t.after(() => timers.forEach(clearInterval));
  vm.runInNewContext(await bundledPlugin(), scope);
  for (let n = 0; n < 100 && !bridge.snapshot('live').connected; n++) await new Promise(resolve => setTimeout(resolve, 10));
  return { bridge, scope, player, switches, variables, selfSwitches, scene, setEventRunning(value) { eventRunning = value; }, command: (action, input = {}) => bridge.command({ projectId: 'live', action, ...input, params: { gameSessionId: bridge.snapshot('live').gameSessionId, ...input.params } }) };
}

test('movement operations read native values, wait for transfer and restore only unchanged overrides', async t => {
  const fixture = await liveMovementFixture(t);
  const { bridge, player, scope, command } = fixture;
  const originalSession = bridge.snapshot('live').gameSessionId;
  assert.equal(bridge.snapshot('live').movement.mapName, '林间村庄');
  assert.equal((await command('setThrough', { value: true })).movement.through, true);
  await command('setMoveSpeed', { value: 6 });
  await command('setEncounter', { value: false });
  player.speed = 3;
  const restored = await command('restoreMovement');
  assert.equal(restored.movement.through, false);
  assert.equal(restored.movement.moveSpeed, 3);
  assert.equal(restored.movement.encounterEnabled, true);
  await command('jump', { params: { dx: 2, dy: -1 } });
  assert.equal(player.x, 5); assert.equal(player.y, 3);
  const transferred = await command('transfer', { params: { mapId: 2, x: 8, y: 9, direction: 6 } });
  assert.equal(transferred.movement.mapId, 2); assert.equal(transferred.movement.x, 8); assert.equal(transferred.movement.direction, 6);
  fixture.setEventRunning(true);
  await assert.rejects(command('jump', { params: { dx: 1, dy: 0 } }), /自由操作/);
  assert.throws(() => command('jump', { params: { dx: 0, dy: 0 } }), /至少移动/);
  assert.throws(() => command('setMoveSpeed', { value: 7 }), /1–6/);
  scope.$gameSystem = { ...scope.$gameSystem };
  for (let n = 0; n < 100 && bridge.snapshot('live').gameSessionId === originalSession; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.notEqual(bridge.snapshot('live').gameSessionId, originalSession);
  assert.equal(bridge.snapshot('live').movement.modified, false);
});

test('recollection recipes capture first, preflight atomically and retain later natural progress on restore', async t => {
  const { command, switches, variables, selfSwitches, scope } = await liveMovementFixture(t);
  const operations = [{ type: 'switch', id: 1, value: true }, { type: 'variable', id: 1, value: 9 }, { type: 'selfSwitch', mapId: 2, eventId: 3, key: 'A', value: true }];
  const captured = await command('captureRecollection', { params: { recipeId: 'gallery-room', operations } });
  assert.equal(switches[1], false); assert.equal(variables[1], 3);
  const backup = captured.recollectionBackup;
  assert.equal(backup.entries[0].original, false); assert.equal(backup.entries[1].original, 3);
  variables[1] = 4;
  await assert.rejects(command('applyRecollection', { params: { backup } }), /进度已变化/);
  assert.equal(switches[1], false);
  variables[1] = 3;
  await command('applyRecollection', { params: { backup } });
  assert.equal(switches[1], true); assert.equal(variables[1], 9); assert.equal(selfSwitches['2,3,A'], true);
  variables[1] = 12;
  const restored = await command('restoreRecollection', { params: { backup } });
  assert.equal(switches[1], false); assert.equal(variables[1], 12); assert.equal(selfSwitches['2,3,A'], false);
  assert.deepEqual({ restored: restored.recollectionResult.restored, skipped: restored.recollectionResult.skipped }, { restored: 2, skipped: 1 });
  scope.$gameSystem = { ...scope.$gameSystem };
  await assert.rejects(command('applyRecollection', { params: { backup } }), /当前存档/);
});

test('RecollectionMode adapter changes gallery visibility and preserves persistent progress', async t => {
  const { command, scope, scene, switches } = await liveMovementFixture(t);
  const persistent = { 1: false, 2: true };
  function Window_RecList() { this._global_variables = {}; this.refreshes = 0; }
  Window_RecList.prototype.get_global_variables = function() { this._global_variables = { switches: { ...persistent } }; };
  Window_RecList.prototype.refresh = function() { this.refreshes++; };
  const list = new Window_RecList(); list.get_global_variables(); scene.children.push(list);
  scope.Window_RecList = Window_RecList;
  const operation = { type: 'recollectionMode', plugin: 'RecollectionMode', switchIds: [1, 2] };
  const capture = await command('captureRecollection', { params: { recipeId: 'global-gallery', operations: [operation] } });
  await command('applyRecollection', { params: { backup: capture.recollectionBackup } });
  assert.equal(list._global_variables.switches[1], true); assert.equal(list.refreshes, 1);
  assert.equal(persistent[1], false); assert.equal(switches[1], false);
  persistent[1] = true;
  await command('restoreRecollection', { params: { backup: capture.recollectionBackup } });
  assert.equal(list._global_variables.switches[1], true); assert.equal(list._global_variables.switches[2], true);
  assert.equal(switches[1], false);
  delete scope.Window_RecList;
  await assert.rejects(command('captureRecollection', { params: { recipeId: 'missing-plugin', operations: [operation] } }), /当前游戏重新扫描/);
});

test('recollection variable thresholds preserve already-earned progress', async t => {
  const { command, variables } = await liveMovementFixture(t);
  variables[1] = 8;
  const capture = await command('captureRecollection', { params: { recipeId: 'threshold', operations: [{ type: 'variable', id: 1, value: 3, mode: 'min' }] } });
  assert.equal(capture.recollectionBackup.entries[0].applied, 8);
  await command('applyRecollection', { params: { backup: capture.recollectionBackup } });
  assert.equal(variables[1], 8);
  variables[1] = 9;
  const restored = await command('restoreRecollection', { params: { backup: capture.recollectionBackup } });
  assert.equal(variables[1], 9); assert.equal(restored.recollectionResult.skipped, 1);
});

test('tagged file parameters use byte counts and preserve arrays, booleans and decimal variables', () => {
  assert.equal(encodeAssistValue({ value: 2.5, params: { text: '中文\n', flags: [true, false, null] } }), 'o2:s5:valued2.5;s6:paramso2:s4:texts7:中文\ns5:flagsa3:tfn');
  assert.throws(() => encodeAssistValue(() => {}), /类型无效/);
});

test('RenPy installer delegates a copied runtime and propagates installation errors', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-renpy-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'game'));
  await mkdir(path.join(root, 'renpy'));
  const calls = [];
  const installed = await installAssistPlugin(root, { worker: async (command, args) => { calls.push([command, args]); return { supported: true, engine: "Ren'Py", transport: 'file' }; } });
  assert.deepEqual(installed, { supported: true, status: 'installed', engine: "Ren'Py", transport: 'file' });
  assert.deepEqual(calls, [['assistInstall', { outputDir: root }]]);
  await assert.rejects(installAssistPlugin(root, { worker: async () => { throw new Error('copy failed'); } }), /copy failed/);
});

test('named variable commands preserve scope, type and current game session', async t => {
  const bridge = createAssistBridge();
  t.after(() => bridge.close());
  const environment = await bridge.environment('renpy', { transport: 'file' });
  const file = path.join(environment.PINHAO_ASSIST_DIR, 'state.json');
  const namedVariables = [
    { scope: 'store', store: 'store.stats', name: 'coins', type: 'number', value: 2.5 },
    { scope: 'persistent', name: 'unlocked', type: 'boolean', value: false },
  ];
  const state = { ready: true, engine: "Ren'Py", gameSessionId: 'current', actions: ['setNamedVariable'], namedVariables };
  await writeFile(file, JSON.stringify({ token: environment.PINHAO_ASSIST_TOKEN, state }));
  for (let n = 0; n < 100 && !bridge.snapshot('renpy').connected; n++) await new Promise(resolve => setTimeout(resolve, 10));
  const params = { scope: 'store', store: 'store.stats', name: 'coins', gameSessionId: 'current' };
  assert.throws(() => bridge.command({ projectId: 'renpy', action: 'setNamedVariable', value: 'bad', params }), /原有类型/);
  assert.throws(() => bridge.command({ projectId: 'renpy', action: 'setNamedVariable', value: 3, params: { ...params, gameSessionId: 'old' } }), /当前存档/);
  assert.throws(() => bridge.command({ projectId: 'renpy', action: 'setNamedVariable', value: 3, params: { ...params, name: '__dict__' } }), /当前存档/);
  const response = bridge.command({ projectId: 'renpy', action: 'setNamedVariable', value: 4.25, params });
  let command;
  for (let n = 0; n < 100; n++) {
    const lines = (await readFile(path.join(environment.PINHAO_ASSIST_DIR, 'commands.txt'), 'ascii')).split('\n');
    if (lines[1]) { command = lines[1].split('\t'); break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(command[1], 'setNamedVariable');
  assert.equal(command[4], 'tagged');
  assert.equal(Buffer.from(command[5], 'hex').toString('utf8'), encodeAssistValue({ value: 4.25, params }));
  state.namedVariables[0].value = 4.25;
  await writeFile(file, JSON.stringify({ token: environment.PINHAO_ASSIST_TOKEN, state, results: [{ id: command[0] }] }));
  assert.equal((await response).namedVariables[0].value, 4.25);
});
