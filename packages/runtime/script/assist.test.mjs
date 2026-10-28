import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { encodeAssistValue } from '../assist.mjs';

const templates = new URL('../../../adapters/python/templates/', import.meta.url);
const common = readFileSync(new URL('assist_script_common.js', templates), 'utf8');
const token = 'neutral-token';
function makeCommand(state, row, value, id = 'update') {
  const params = { scope: row.scope, store: row.store, name: row.name, gameSessionId: state.state.gameSessionId };
  return `${token}\n${[id, 'setNamedVariable', '', '', 'tagged', Buffer.from(encodeAssistValue({ value, params })).toString('hex')].join('\t')}`;
}
function files() {
  const entries = new Map([['commands.txt', token]]);
  return {
    entries,
    read: name => entries.get(name) || '',
    write: (name, value) => entries.set(name, value),
    snapshot: () => JSON.parse(entries.get('state.json')),
  };
}

test('Tyrano bridge executes f/sf writes, saves system values, and rejects stale sessions and type changes', () => {
  const io = files();
  let saved = 0, tick;
  const kag = { stat: { f: { score: 12.5, name: '中性名字', nested: { untouched: true } } }, variable: { sf: { gallery: false } }, saveSystemVariable: () => saved++ };
  const fs = {
    readFileSync: path => io.read(path),
    writeFileSync: (path, value) => io.write(path, value),
    renameSync: (old, name) => io.write(name, io.read(old)),
  };
  const context = vm.createContext({ window: { TYRANO: { kag } }, process: { env: { PINHAO_ASSIST_DIR: '.', PINHAO_ASSIST_TOKEN: token } },
    require: name => name === 'fs' ? fs : { join: (_directory, name) => name }, setInterval: value => { tick = value; } });
  vm.runInContext(`(function(){${common}\n${readFileSync(new URL('assist_tyrano.js', templates), 'utf8')} })()`, context);
  tick();
  let state = io.snapshot();
  assert.equal(state.state.engine, 'TyranoScript');
  assert.equal(state.state.namedVariables.length, 3);
  let row = state.state.namedVariables.find(item => item.name === 'name');
  io.write('commands.txt', makeCommand(state, row, '桥接中文🌙'));
  tick();
  assert.equal(kag.stat.f.name, '桥接中文🌙');
  assert.equal(io.snapshot().results[0].error, undefined);
  row = state.state.namedVariables.find(item => item.name === 'gallery');
  io.write('commands.txt', makeCommand(state, row, true, 'persistent'));
  tick(); tick();
  assert.equal(kag.variable.sf.gallery, true);
  assert.equal(saved, 1);
  io.write('commands.txt', makeCommand(state, row, 'wrong type', 'type'));
  tick();
  assert.match(io.snapshot().results[0].error, /type/);
  kag.stat.f = { score: 2 };
  io.write('commands.txt', makeCommand(state, row, false, 'old-session'));
  tick();
  assert.match(io.snapshot().results[0].error, /Refresh/);
});

test('PGMM official plugin interface updates existing common variable and switch objects', () => {
  const io = files(), values = new Map([[7, 12.5], [3, false]]);
  const variable = id => ({ getValue: () => values.get(id), setValue: value => values.set(id, value) });
  const fileUtils = {
    getStringFromFile: path => path.endsWith('PinHao-assist-session.json') ? JSON.stringify({ directory: '.', token }) : io.read(path.replace('./', '')),
    writeStringToFile: (value, path) => { io.write(path.replace('./', ''), value); return true; },
    renameFile: (source, destination) => { io.write(destination.replace('./', ''), io.read(source.replace('./', ''))); return true; },
    isFileExist: path => io.entries.has(path.replace('./', '')),
    removeFile: path => io.entries.delete(path.replace('./', '')),
  };
  const context = vm.createContext({ Agtk: { settings: { projectPath: 'data' }, sceneInstances: { getCurrent: () => ({ sceneId: 4 }) }, variables: { get: variable }, switches: { get: variable } }, jsb: { fileUtils } });
  const definitions = [{ id: 7, name: 'Score', store: 'variables' }, { id: 3, name: 'Gate', store: 'switches' }];
  const template = readFileSync(new URL('assist_pgmm.js', templates), 'utf8').replace('__PINHAO_DEFINITIONS__', JSON.stringify(definitions));
  const plugin = vm.runInContext(`(function(){${common}\n${template} })()`, context);
  for (const name of ['getInfo', 'initialize', 'finalize', 'call', 'setLocale', 'update']) assert.equal(typeof plugin[name], 'function');
  plugin.initialize(); plugin.update(1);
  let state = io.snapshot();
  const row = state.state.namedVariables.find(item => item.store === 'variables');
  io.write('commands.txt', makeCommand(state, row, 21.75));
  plugin.update(1);
  assert.equal(values.get(7), 21.75);
  assert.equal(io.snapshot().results[0].error, undefined);
  const gate = state.state.namedVariables.find(item => item.store === 'switches');
  io.write('commands.txt', makeCommand(state, gate, true, 'switch'));
  plugin.update(1);
  assert.equal(values.get(3), true);
  plugin.setInternal();
  io.write('commands.txt', makeCommand(state, gate, false, 'stale'));
  plugin.update(1);
  assert.match(io.snapshot().results[0].error, /Refresh/);
});

test('script bridge stays inactive without a workbench session', () => {
  let scheduled = false;
  const context = vm.createContext({ window: {}, require: () => { throw new Error('no transport'); }, setInterval: () => { scheduled = true; } });
  vm.runInContext(`(function(){${common}\n${readFileSync(new URL('assist_tyrano.js', templates), 'utf8')} })()`, context);
  assert.equal(scheduled, false);
});
