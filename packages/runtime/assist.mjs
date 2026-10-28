import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, open, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { commitAssistFiles } from './assist-install.mjs';

export const assistActions = ['setGold', 'setItem', 'setSwitch', 'setVariable', 'setNamedVariable', 'heal', 'setLevel', 'setExp', 'setHp', 'setMp', 'setThrough', 'setMoveSpeed', 'setEncounter', 'jump', 'transfer', 'restoreMovement', 'captureRecollection', 'applyRecollection', 'restoreRecollection'];

export function encodeAssistValue(value, depth = 0) {
  if (depth > 10) throw new Error('辅助参数嵌套过深');
  if (value == null) return 'n';
  if (value === true) return 't';
  if (value === false) return 'f';
  if (typeof value === 'number' && Number.isFinite(value)) return 'd' + value + ';';
  if (typeof value === 'string') return 's' + Buffer.byteLength(value, 'utf8') + ':' + value;
  if (Array.isArray(value)) return 'a' + value.length + ':' + value.map(item => encodeAssistValue(item, depth + 1)).join('');
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    return 'o' + entries.length + ':' + entries.map(([key, item]) => encodeAssistValue(key, depth + 1) + encodeAssistValue(item, depth + 1)).join('');
  }
  throw new Error('辅助参数类型无效');
}

export function createAssistBridge() {
  const sessions = new Map(), tokens = new Map(), cleanups = new Set();
  let server, port, listening;
  const stateFor = session => ({ ...(session?.state ?? {}), connected: Boolean(session && session.state.ready !== false && Date.now() - session.updated < 4500) });
  function disconnect(projectId) {
    const session = sessions.get(projectId);
    if (!session) return;
    tokens.delete(session.token);
    sessions.delete(projectId);
    session.closed = true;
    clearInterval(session.poller);
    if (session.directory) {
      const cleanup = (session.io || Promise.resolve()).catch(() => {}).then(() => rm(session.directory, { recursive: true, force: true, maxRetries: 3 })).catch(() => {});
      cleanups.add(cleanup);
      cleanup.finally(() => cleanups.delete(cleanup));
    }
    for (const pending of session.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('辅助连接已关闭')); }
  }
  function accept(session, payload) {
    if (payload.state && typeof payload.state === 'object' && !Array.isArray(payload.state)) { session.state = payload.state; session.updated = Date.now(); }
    for (const result of payload.results ?? []) {
      const pending = session.pending.get(result.id);
      if (pending) { clearTimeout(pending.timer); session.pending.delete(result.id); session.commands = session.commands.filter(command => command.id !== result.id); result.error ? pending.reject(new Error(result.error)) : pending.resolve(stateFor(session)); }
    }
  }
  async function exchangeFiles(session) {
    if (session.closed || session.io) return;
    session.io = (async () => {
      try {
        const handle = await open(path.join(session.directory, 'state.json'), 'r');
        let bytes, writeIdentity;
        try {
          bytes = await handle.readFile();
          const status = await handle.stat({ bigint: true });
          writeIdentity = [status.dev, status.ino, status.size, status.mtimeNs, status.ctimeNs].join(':');
        } finally { await handle.close(); }
        const file = bytes[0] === 0xff && bytes[1] === 0xfe
          ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8').replace(/^\uFEFF/, '');
        if (file !== session.lastFile || writeIdentity !== session.lastWrite) {
          const payload = JSON.parse(file);
          if (payload.token === session.token) { accept(session, payload); session.lastFile = file; session.lastWrite = writeIdentity; }
        }
      } catch (error) { if (!['ENOENT', 'EBUSY', 'EPERM'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
      if (session.closed) return;
      const payload = [session.token, ...session.commands.map(command => {
        const tagged = command.params !== undefined;
        return [command.id, command.action, command.targetId || '', command.type || '', tagged ? 'tagged' : typeof command.value, Buffer.from(tagged ? encodeAssistValue({ value: command.value, params: command.params }) : String(command.value ?? ''), 'utf8').toString('hex')].join('\t');
      })].join('\n');
      const temporary = path.join(session.directory, 'commands.tmp');
      await writeFile(temporary, payload, 'ascii');
      await rename(temporary, path.join(session.directory, 'commands.txt'));
    })().catch(() => {}).finally(() => { session.io = undefined; });
    await session.io;
  }
  async function listen() {
    if (listening) return listening;
    listening = start();
    return listening;
  }
  async function start() {
    server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Cache-Control', 'no-store');
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        const session = tokens.get(url.searchParams.get('token'));
        if (!session || request.method !== 'POST' || url.pathname !== '/state') { response.writeHead(403); response.end('{}'); return; }
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('辅助状态过大'); chunks.push(chunk); }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        accept(session, payload);
        const commands = session.commands;
        response.end(JSON.stringify({ commands }));
      } catch { response.writeHead(400); response.end('{}'); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    port = server.address().port;
  }
  return {
    async environment(projectId, { transport = 'http', backupDir } = {}) {
      disconnect(projectId);
      const session = { token: randomBytes(32).toString('hex'), commands: [], pending: new Map(), state: {}, updated: 0 };
      sessions.set(projectId, session); tokens.set(session.token, session);
      if (transport === 'file') {
        if (backupDir) await mkdir(backupDir, { recursive: true });
        session.directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-assist-'));
        await exchangeFiles(session);
        session.poller = setInterval(() => exchangeFiles(session), 200);
        session.poller.unref();
        return { PINHAO_ASSIST_DIR: session.directory, PINHAO_ASSIST_TOKEN: session.token,
          ...(backupDir ? { PINHAO_ASSIST_BACKUP_DIR: backupDir } : {}) };
      }
      await listen();
      return { PINHAO_ASSIST_PORT: String(port), PINHAO_ASSIST_TOKEN: session.token };
    },
    disconnect,
    snapshot(projectId) { return stateFor(sessions.get(projectId)); },
    command({ projectId, action, id, type, value, params }) {
      const session = sessions.get(projectId);
      if (!stateFor(session).connected) throw new Error('请从工作台启动成品，再开始新游戏或读取存档。');
      if (!assistActions.includes(action) || session.state.actions && !session.state.actions.includes(action)) throw new Error('请选择当前游戏提供的辅助操作');
      if (['setItem', 'setSwitch', 'setVariable', 'setLevel', 'setExp', 'setHp', 'setMp'].includes(action) && (!Number.isSafeInteger(id) || id < 1)) throw new Error('请选择列表中的有效条目');
      if (['setGold', 'setItem', 'setLevel', 'setExp', 'setHp', 'setMp'].includes(action) && (!Number.isSafeInteger(value) || value < (action === 'setLevel' ? 1 : 0) || value > 99999999)) throw new Error('请输入有效的非负整数');
      if (action === 'setSwitch' && typeof value !== 'boolean') throw new Error('开关值需要为布尔值');
      if (action === 'setVariable' && (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)) || (typeof value === 'string' && value.length > 2000))) throw new Error('变量值需要为文字、数字或布尔值');
      if (action === 'setNamedVariable') {
        const variable = session.state.namedVariables?.find(item => item.scope === params?.scope && (item.store || 'store') === (params?.store || 'store') && item.name === params?.name);
        if (!variable || params?.gameSessionId !== session.state.gameSessionId) throw new Error('请刷新列表并选择当前存档中的变量');
        if (typeof value !== variable.type || typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) || typeof value === 'string' && value.length > 2000) throw new Error('请保持变量原有类型，文字长度上限为 2000');
      }
      if (action === 'setItem' && !['item', 'weapon', 'armor'].includes(type)) throw new Error('请选择物品、武器或防具');
      if (['setThrough', 'setEncounter'].includes(action) && typeof value !== 'boolean') throw new Error('开关值需要为布尔值');
      if (action === 'setMoveSpeed' && (!Number.isInteger(value) || value < 1 || value > 6)) throw new Error('移动速度范围为 1–6');
      if (action === 'jump' && (!params || !Number.isInteger(params.dx) || !Number.isInteger(params.dy) || Math.abs(params.dx) > 20 || Math.abs(params.dy) > 20 || params.dx === 0 && params.dy === 0)) throw new Error('跳跃偏移范围为 -20–20，至少移动一格');
      if (action === 'transfer' && (!params || !Number.isInteger(params.mapId) || params.mapId < 1 || !Number.isInteger(params.x) || !Number.isInteger(params.y) || params.x < 0 || params.y < 0 || ![0, 2, 4, 6, 8].includes(params.direction ?? 0))) throw new Error('请选择地图并填写地图内的整数坐标');
      if (params !== undefined && (!params || typeof params !== 'object' || Array.isArray(params) || Buffer.byteLength(encodeAssistValue(params), 'utf8') > 1024 * 1024)) throw new Error('请重新填写辅助参数后重试');
      if (!session.state.gameSessionId || params?.gameSessionId !== session.state.gameSessionId) throw new Error('请刷新列表并选择当前存档中的状态');
      const commandId = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { session.pending.delete(commandId); session.commands = session.commands.filter(command => command.id !== commandId); reject(new Error('游戏暂未响应，请确认游戏仍在运行')); }, action === 'transfer' ? 25000 : 6000);
        session.pending.set(commandId, { resolve, reject, timer });
        session.commands.push({ id: commandId, action, targetId: id, type, value, params });
      });
    },
    async close() {
      for (const projectId of sessions.keys()) disconnect(projectId);
      await Promise.all(cleanups);
      if (listening) await listening;
      if (server) { await new Promise(resolve => server.close(resolve)); server = undefined; listening = undefined; }
    },
  };
}

function gameBridge() {
  var root = typeof window === 'object' ? window : globalThis;
  // Property access keeps the game loader independent of the desktop bundler's helpers.
  var load = root['require'] || (root.nw && root.nw.require);
  if (typeof load !== 'function' || typeof process === 'undefined') return;
  var port = Number(process.env.PINHAO_ASSIST_PORT), token = process.env.PINHAO_ASSIST_TOKEN;
  if (!port || !token) return;
  var http = load('http'), results = [], completed = {}, completedOrder = [], busy = false;
  var gameIdentity, gameSessionId, movementOriginal, movementApplied = {}, recollectionBackup, recollectionResult, recollectionOverlay = {};
  function ensureSession() {
    if (gameIdentity !== window.$gameSystem) {
      gameIdentity = window.$gameSystem; gameSessionId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      movementOriginal = null; movementApplied = {}; recollectionBackup = null; recollectionResult = null; recollectionOverlay = {};
    }
  }
  function movement() {
    if (!window.$gamePlayer || !window.$gameMap || typeof $gameMap.mapId !== 'function') return undefined;
    var scene = window.SceneManager && SceneManager._scene;
    return { through: $gamePlayer.isThrough(), moveSpeed: $gamePlayer.moveSpeed(), encounterEnabled: $gameSystem.isEncounterEnabled(), mapId: $gameMap.mapId(),
      mapName: window.$dataMap && $dataMap.displayName || window.$dataMapInfos && $dataMapInfos[$gameMap.mapId()] && $dataMapInfos[$gameMap.mapId()].name || '',
      x: $gamePlayer.x, y: $gamePlayer.y, direction: $gamePlayer.direction(), canTransfer: Boolean(scene && window.Scene_Map && scene instanceof Scene_Map && !$gamePlayer.isTransferring() && !($gameParty.inBattle && $gameParty.inBattle()) && !($gameMap.isEventRunning && $gameMap.isEventRunning())), modified: Object.keys(movementApplied).length > 0 };
  }
  function setMovement(field, value, remember) {
    var current = movement();
    if (!current) throw new Error('请在地图中使用移动辅助');
    if (remember) { if (!movementOriginal) movementOriginal = {}; if (!Object.prototype.hasOwnProperty.call(movementOriginal, field)) movementOriginal[field] = current[field]; movementApplied[field] = value; }
    if (field === 'through') $gamePlayer.setThrough(value);
    if (field === 'moveSpeed') $gamePlayer.setMoveSpeed(value);
    if (field === 'encounterEnabled') { value ? $gameSystem.enableEncounter() : $gameSystem.disableEncounter(); $gamePlayer.makeEncounterCount(); }
  }
  function same(first, second) { return JSON.stringify(first) === JSON.stringify(second); }
  function validateOperation(operation) {
    if (!operation || typeof operation !== 'object') throw new Error('请重新扫描并选择有效的回想方案');
    if (operation.type === 'switch' && Number.isInteger(operation.id) && operation.id > 0 && operation.id < $dataSystem.switches.length && typeof operation.value === 'boolean') return;
    if (operation.type === 'variable' && Number.isInteger(operation.id) && operation.id > 0 && operation.id < $dataSystem.variables.length && typeof operation.value === 'number' && Number.isFinite(operation.value) && ['set', 'min', 'max'].indexOf(operation.mode || 'set') >= 0) return;
    if (operation.type === 'selfSwitch' && window.$gameSelfSwitches && Number.isInteger(operation.mapId) && operation.mapId > 0 && Number.isInteger(operation.eventId) && operation.eventId > 0 && ['A', 'B', 'C', 'D'].indexOf(operation.key) >= 0 && typeof operation.value === 'boolean') return;
    if (operation.type === 'recollectionMode' && operation.plugin === 'RecollectionMode' && Array.isArray(operation.switchIds) && operation.switchIds.length && operation.switchIds.every(function(id) { return Number.isInteger(id) && id > 0; }) && window.Window_RecList && typeof Window_RecList.prototype.get_global_variables === 'function') return;
    throw new Error('请为当前游戏重新扫描回想方案');
  }
  function readOperation(operation) {
    if (operation.type === 'switch') return $gameSwitches.value(operation.id);
    if (operation.type === 'variable') return $gameVariables.value(operation.id);
    if (operation.type === 'selfSwitch') return $gameSelfSwitches.value([operation.mapId, operation.eventId, operation.key]);
    return operation.switchIds.map(function(id) { return Boolean(recollectionOverlay[id]); });
  }
  function appliedValue(operation, original) {
    if (operation.type === 'recollectionMode') return operation.switchIds.map(function() { return true; });
    if (operation.type !== 'variable') return operation.value;
    if (typeof original !== 'number' || !Number.isFinite(original)) throw new Error('此回想条件需要数字变量，请重新扫描并确认方案');
    return operation.mode === 'min' ? Math.max(original, operation.value) : operation.mode === 'max' ? Math.min(original, operation.value) : operation.value;
  }
  function refreshRecollectionWindows() {
    var scene = window.SceneManager && SceneManager._scene, pending = scene ? [scene] : [], visited = [];
    while (pending.length && visited.length < 10000) {
      var item = pending.pop(); if (!item || visited.indexOf(item) >= 0) continue; visited.push(item);
      if (window.Window_RecList && item instanceof Window_RecList) { item.get_global_variables(); if (item.refresh) item.refresh(); }
      if (item.children) pending = pending.concat(item.children);
    }
  }
  function writeOperation(operation, value) {
    if (operation.type === 'switch') $gameSwitches.setValue(operation.id, value);
    else if (operation.type === 'variable') $gameVariables.setValue(operation.id, value);
    else if (operation.type === 'selfSwitch') $gameSelfSwitches.setValue([operation.mapId, operation.eventId, operation.key], value);
    else {
      var prototype = Window_RecList.prototype;
      if (!prototype.pinhao_assist_recollection_original) {
        prototype.pinhao_assist_recollection_original = prototype.get_global_variables;
        prototype.get_global_variables = function() {
          var result = prototype.pinhao_assist_recollection_original.apply(this, arguments);
          this._global_variables = this._global_variables || {}; this._global_variables.switches = this._global_variables.switches || {};
          Object.keys(recollectionOverlay).forEach(function(id) { if (recollectionOverlay[id]) this._global_variables.switches[id] = true; }, this);
          return result;
        };
      }
      operation.switchIds.forEach(function(id, index) { if (value[index]) recollectionOverlay[id] = true; else delete recollectionOverlay[id]; });
    }
  }
  function recollection(action, params) {
    ensureSession();
    if (action === 'captureRecollection') {
      if (!params || typeof params.recipeId !== 'string' || !Array.isArray(params.operations) || !params.operations.length || params.operations.length > 10000) throw new Error('请重新扫描并选择有效的回想方案');
      params.operations.forEach(validateOperation);
      recollectionBackup = { recipeId: params.recipeId, gameSessionId: gameSessionId, entries: params.operations.map(function(operation) { var original = readOperation(operation); return { operation: JSON.parse(JSON.stringify(operation)), original: original, applied: appliedValue(operation, original) }; }) };
      recollectionResult = { action: action, recipeId: params.recipeId, applied: 0, restored: 0, skipped: 0 }; return;
    }
    var backup = params && params.backup;
    if (!backup || backup.gameSessionId !== gameSessionId || !Array.isArray(backup.entries) || !backup.entries.length || backup.entries.length > 10000) throw new Error('请在当前游戏中重新扫描并选择解锁方案');
    backup.entries.forEach(function(entry) {
      validateOperation(entry.operation);
      if (entry.operation.type === 'recollectionMode') {
        if (!Array.isArray(entry.original) || !Array.isArray(entry.applied) || entry.original.length !== entry.operation.switchIds.length || entry.applied.length !== entry.original.length || entry.original.concat(entry.applied).some(function(value) { return typeof value !== 'boolean'; })) throw new Error('请从回想备份列表选择一份完整备份');
      } else if (typeof entry.original !== (entry.operation.type === 'variable' ? 'number' : 'boolean') || !same(entry.applied, appliedValue(entry.operation, entry.original))) throw new Error('请从回想备份列表选择一份完整备份');
      if (action === 'applyRecollection' && !same(readOperation(entry.operation), entry.original)) throw new Error('游戏进度已变化，请重新扫描并选择解锁方案');
    });
    var restored = 0, skipped = 0;
    backup.entries.forEach(function(entry) {
      if (action === 'applyRecollection') writeOperation(entry.operation, entry.applied);
      else if (same(readOperation(entry.operation), entry.applied)) { writeOperation(entry.operation, entry.original); restored++; }
      else skipped++;
    });
    recollectionBackup = action === 'applyRecollection' ? backup : null;
    recollectionResult = { action: action, recipeId: backup.recipeId, applied: action === 'applyRecollection' ? backup.entries.length : 0, restored: restored, skipped: skipped };
    refreshRecollectionWindows();
  }
  function state() {
    ensureSession();
    if (!window.$gameParty || !window.$gameSystem || !window.$dataSystem) return { ready: false };
    var scene = window.SceneManager && window.SceneManager._scene;
    if (scene && [window.Scene_Boot, window.Scene_Title, window.Scene_Load].some(function(type) { return typeof type === 'function' && scene instanceof type; })) return { ready: false };
    var items = [], variables = [], switches = [];
    [['item', window.$dataItems], ['weapon', window.$dataWeapons], ['armor', window.$dataArmors]].forEach(function(group) {
      (group[1] || []).forEach(function(item) { if (item && item.name) items.push({ id: item.id, type: group[0], name: item.name, count: $gameParty.numItems(item) }); });
    });
    ($dataSystem.switches || []).forEach(function(name, id) { if (id) switches.push({ id: id, name: String(name || '').trim() ? name : '开关 #' + id, value: $gameSwitches.value(id) }); });
    ($dataSystem.variables || []).forEach(function(name, id) { if (id) { var value = $gameVariables.value(id); if (['string', 'number', 'boolean'].indexOf(typeof value) >= 0) variables.push({ id: id, name: String(name || '').trim() ? name : '变量 #' + id, value: value }); } });
    var actions = ['setGold', 'setItem', 'setSwitch', 'setVariable', 'heal', 'setLevel', 'setExp', 'setHp', 'setMp', 'captureRecollection', 'applyRecollection', 'restoreRecollection'];
    var currentMovement = movement(); if (currentMovement) actions = actions.concat(['setThrough', 'setMoveSpeed', 'setEncounter', 'jump', 'transfer', 'restoreMovement']);
    return { ready: true, mode: 'live', gameSessionId: gameSessionId, recollectionBackup: recollectionBackup, recollectionResult: recollectionResult, movement: currentMovement, engine: window.Utils && Utils.RPGMAKER_NAME || 'MV/MZ', actions: actions, gold: $gameParty.gold(), items: items, switches: switches, variables: variables, actors: $gameParty.members().map(function(actor) { return { id: actor.actorId(), name: actor.name(), hp: actor.hp, mp: actor.mp, level: actor.level, maxHp: actor.mhp, maxMp: actor.mmp, exp: actor.currentExp ? actor.currentExp() : undefined, maxLevel: actor.maxLevel ? actor.maxLevel() : undefined }; }) };
  }
  function execute(command) {
    if (!window.$gameParty || !window.$gameSystem) throw new Error('请先开始或读取游戏');
    var id = command.targetId, value = command.value, item, actor, params = command.params || {}, current;
    ensureSession();
    if (params.gameSessionId !== gameSessionId) throw new Error('请刷新列表并选择当前存档中的状态');
    switch (command.action) {
      case 'setGold': if (!Number.isSafeInteger(value) || value < 0) throw new Error('请输入非负整数的金钱数值'); $gameParty.gainGold(value - $gameParty.gold()); break;
      case 'setItem':
        item = { item: window.$dataItems, weapon: window.$dataWeapons, armor: window.$dataArmors }[command.type];
        item = item && item[id]; if (!item || !Number.isSafeInteger(value) || value < 0) throw new Error('请选择现有物品并填写非负整数数量');
        $gameParty.gainItem(item, value - $gameParty.numItems(item), false); break;
      case 'setSwitch': if (!id || id >= $dataSystem.switches.length || typeof value !== 'boolean') throw new Error('请选择现有开关并设置开启或关闭'); $gameSwitches.setValue(id, value); break;
      case 'setVariable': if (!id || id >= $dataSystem.variables.length || ['string', 'number', 'boolean'].indexOf(typeof value) < 0) throw new Error('请选择现有变量并填写文字、数字或开关值'); $gameVariables.setValue(id, value); break;
      case 'heal': $gameParty.members().forEach(function(actor) { actor.recoverAll(); }); break;
      case 'setThrough': setMovement('through', value, true); break;
      case 'setMoveSpeed': setMovement('moveSpeed', value, true); break;
      case 'setEncounter': setMovement('encounterEnabled', value, true); break;
      case 'restoreMovement':
        current = movement();
        if (movementOriginal && current) Object.keys(movementApplied).forEach(function(field) { if (current[field] === movementApplied[field]) setMovement(field, movementOriginal[field], false); });
        movementOriginal = null; movementApplied = {}; break;
      case 'jump':
        current = movement(); if (!current || !current.canTransfer) throw new Error('请在可自由操作的地图中跳跃');
        if ($gameMap.isValid && !$gameMap.isValid($gamePlayer.x + params.dx, $gamePlayer.y + params.dy)) throw new Error('请选择地图范围内的跳跃目标');
        $gamePlayer.jump(params.dx, params.dy); break;
      case 'transfer':
        current = movement(); if (!current || !current.canTransfer) throw new Error('请在可自由操作的地图中传送');
        $gamePlayer.reserveTransfer(params.mapId, params.x, params.y, params.direction || 0, 2);
        break;
      case 'captureRecollection': case 'applyRecollection': case 'restoreRecollection': recollection(command.action, params); break;
      case 'setLevel': case 'setExp': case 'setHp': case 'setMp':
        actor = $gameParty.members().filter(function(member) { return member.actorId() === id; })[0];
        if (!actor || !Number.isSafeInteger(value) || value < (command.action === 'setLevel' ? 1 : 0)) throw new Error('请选择队伍角色并填写有效的整数数值');
        if (command.action === 'setLevel') actor.changeLevel(value, false);
        if (command.action === 'setExp') actor.changeExp(value, false);
        if (command.action === 'setHp') actor.setHp(value);
        if (command.action === 'setMp') actor.setMp(value);
        break;
      default: throw new Error('请选择当前游戏提供的辅助操作');
    }
    if (window.$gameMap) $gameMap.requestRefresh();
  }
  setInterval(function() {
    if (busy) return;
    busy = true;
    var current;
    try { current = state(); } catch (_) { busy = false; return; }
    Object.keys(completed).forEach(function(id) {
      var result = completed[id];
      if (!result.waitTransfer) return;
      var target = result.waitTransfer, arrived = window.$gameMap && $gameMap.mapId() === target.mapId && $gamePlayer.x === target.x && $gamePlayer.y === target.y && !$gamePlayer.isTransferring();
      if (arrived || Date.now() > result.deadline) { delete result.waitTransfer; delete result.deadline; if (!arrived) result.error = '地图传送超时，请返回地图后重试'; results.push(result); }
    });
    var sending = results; results = [];
    var payload = JSON.stringify({ state: current, results: sending });
    var settled = false;
    function finish(success) { if (settled) return; settled = true; if (!success) results = sending.concat(results); busy = false; }
    var request = http.request({ hostname: '127.0.0.1', port: port, path: '/state?token=' + token, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, function(response) {
      var data = '';
      response.on('data', function(chunk) { data += chunk; });
      response.on('error', function() { finish(false); });
      response.on('aborted', function() { finish(false); });
      response.on('end', function() {
        try {
          if (response.statusCode !== 200) { finish(false); return; }
          (JSON.parse(data).commands || []).forEach(function(command) {
            var result = completed[command.id];
            if (!result) {
              result = { id: command.id };
              try { execute(command); if (command.action === 'transfer') { result.waitTransfer = command.params; result.deadline = Date.now() + 20000; } } catch (error) { result.error = error.message; }
              completed[command.id] = result; completedOrder.push(command.id);
              if (completedOrder.length > 100) delete completed[completedOrder.shift()];
            }
            if (!result.waitTransfer) results.push(result);
          });
          finish(true);
        } catch (_) { finish(false); }
      });
    });
    request.setTimeout(3000, function() { request.destroy(); });
    request.on('error', function() { finish(false); });
    request.end(payload);
  }, 1000);
}

export const assistPluginSource = `/* Pinhao optional play assistance; no connection when launched independently. */\n(${gameBridge.toString()})();\n`;

export async function installAssistPlugin(outputDir, { worker } = {}) {
  const normalize = result => ({ ...result, status: result.status ?? (result.supported ? 'installed' : 'unsupported') });
  for (const prefix of ['', 'www']) {
    const root = path.join(outputDir, prefix);
    try { await access(path.join(root, 'data/System.json')); await access(path.join(root, 'js/plugins.js')); } catch { continue; }
    let engine;
    for (const [name, core] of [['MV', 'rpg_core.js'], ['MZ', 'rmmz_core.js']]) {
      try { await access(path.join(root, 'js', core)); engine = name; } catch {}
    }
    if (!engine) continue;
    const file = path.join(root, 'js/plugins.js');
    const original = await readFile(file);
    let source = original.toString('utf8');
    if (!source.includes('$plugins')) return { supported: false, status: 'unsupported', detail: '插件入口需专项适配' };
    const marker = '// PinHao optional assistance registration';
    source = source.replace(/\n?\/\/ PinHao optional assistance registration\r?\n\$plugins = \$plugins\.filter\(function\(plugin\) \{ return plugin\.name !== "PinhaoAssist"; \}\);\r?\n\$plugins\.push\(\{[\s\S]*?\r?\n\}\);\r?\n(?:\/\/ PinHao optional assistance end\r?\n)?/g, '');
    const descriptor = JSON.stringify({ name: 'PinhaoAssist', status: true, description: '拼好汉化可选游玩辅助', parameters: {} }, null, 2);
    const registration = `\n${marker}\n$plugins = $plugins.filter(function(plugin) { return plugin.name !== "PinhaoAssist"; });\n$plugins.push(${descriptor});\n// PinHao optional assistance end\n`;
    const result = await commitAssistFiles([
      { file: path.join(root, 'js/plugins/PinhaoAssist.js'), content: Buffer.from(assistPluginSource) },
      { file, content: Buffer.from(source + registration), expected: original },
    ]);
    return result.status === 'installed' ? { supported: true, status: 'installed', engine, transport: 'http' } : result;
  }
  if (worker) {
    let renpy = false;
    try {
      await access(path.join(outputDir, 'game'));
      await access(path.join(outputDir, 'renpy'));
      renpy = true;
    } catch {}
    if (renpy) return normalize(await worker('assistInstall', { outputDir }));
    for (const extension of ['rvdata2', 'rvdata', 'rxdata']) {
      try { await access(path.join(outputDir, 'Data', 'Scripts.' + extension)); } catch { continue; }
      return normalize(await worker('assistInstall', { outputDir }));
    }
    return normalize(await worker('assistInstall', { outputDir }));
  }
  return { supported: false, status: 'unsupported' };
}
