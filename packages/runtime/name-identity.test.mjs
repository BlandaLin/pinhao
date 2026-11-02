import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { inspectPlugins, registerPlugin } from './rpgmaker-plugins.mjs';

const template = await readFile(new URL('../../adapters/python/templates/name_identity.js', import.meta.url), 'utf8');
const localization = await readFile(new URL('../../adapters/python/templates/localization.js', import.meta.url), 'utf8');
const config = { schema: 'pinhao-name-identity-1', enemyNativeVerified: false,
  tables: { Actors: { 17: { source: 'ActorOriginal\\C[1]', target: 'ActorTarget\\C[1]' } },
    Enemies: { 9: { source: 'SlimeOriginal', target: 'SlimeTarget' } } },
  types: { elements: { 1: { source: 'ElementOriginal', target: 'ElementTarget' }, 2: { source: 'Old', target: 'Target' } } } };
function runtime(overrides = {}, scope = {}) {
  vm.runInNewContext(template.replace('__PINHAO_IDENTITY_CONFIG__', JSON.stringify({ ...config, ...overrides })), scope);
  return scope.PinHaoNameIdentity;
}

test('data names preserve original control text, dynamic edits, getter counts and native errors', () => {
  const api = runtime(); let reads = 0;
  const record = { id: 17, get name() { reads++; return 'ActorTarget\\C[1]'; } };
  assert.equal(api.dataName('Actors', record), 'ActorOriginal\\C[1]');
  assert.equal(reads, 1);
  assert.equal(api.dataName('Actors', { id: 17, name: 'Custom' }), 'Custom');
  assert.equal(api.dataName('Actors', { id: 17, name: 'ActorOriginal\\C[1]' }), 'ActorOriginal\\C[1]');
  assert.equal(api.dataName('Actors', { id: 1, name: 'ActorTarget\\C[1]' }), 'ActorTarget\\C[1]');
  assert.throws(() => api.dataName('Actors', null), { name: 'TypeError' });
  assert.throws(() => api.dataName('Actors', { get name() { throw new Error('native getter failure'); } }), /native getter failure/);
});

test('actorId array indexing keeps old default-name display and custom actor getters unchanged', () => {
  const dataActors = [null, { id: 17, name: 'ActorTarget\\C[1]' }];
  function GameActor(name) { this._actorId = 1; this._name = name; }
  GameActor.prototype.actorId = function () { return this._actorId; };
  GameActor.prototype.actor = function () { return dataActors[this._actorId]; };
  GameActor.prototype.name = function () { return this._name; };
  const scope = { Game_Actor: GameActor };
  const api = runtime({}, scope);
  vm.runInNewContext(localization.replace('__PINHAO_CONFIG__', JSON.stringify({ font: null, wrapMessages: false,
    names: { 1: { name: config.tables.Actors[17] } } })), scope);
  const oldDefault = new GameActor('ActorOriginal\\C[1]'), custom = new GameActor('PlayerChosen');
  assert.equal(oldDefault.name(), 'ActorTarget\\C[1]');
  assert.equal(custom.name(), 'PlayerChosen');
  assert.equal(api.dataName('Actors', oldDefault.actor()), 'ActorOriginal\\C[1]');
  assert.equal(api.battlerName('Actors', custom), 'PlayerChosen');
  let calls = 0;
  assert.equal(api.battlerName('Actors', { name() { calls++; return 'Custom getter result'; } }), 'Custom getter result');
  assert.equal(calls, 1);
});

test('verified enemy names preserve native plural letters and call name once; unverified keeps current', () => {
  const record = { id: 9, name: 'SlimeTarget' };
  for (const plural of [false, true]) {
    let calls = 0;
    const enemy = { _plural: plural, _letter: ' B', enemy: () => record,
      name() { calls++; return record.name + (this._plural ? this._letter : ''); } };
    assert.equal(runtime({ enemyNativeVerified: true }).battlerName('Enemies', enemy), 'SlimeOriginal' + (plural ? ' B' : ''));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const unverified = { name() { calls++; return 'CustomSlime B'; }, enemy() { throw new Error('must not inspect an unverified getter'); } };
  assert.equal(runtime().battlerName('Enemies', unverified), 'CustomSlime B');
  assert.equal(calls, 1);
  assert.equal(runtime({ enemyNativeVerified: true }).battlerName('Enemies', { ...unverified, enemy: () => record }), 'CustomSlime B');
  assert.throws(() => runtime().battlerName('Enemies', null), { name: 'TypeError' });
});

test('type identity returns a copy and does not modify custom values or the original database array', () => {
  const current = Object.freeze(['', 'ElementTarget', 'PlayerCustom', null]);
  const actual = runtime().typeNames('elements', current);
  assert.deepEqual(Array.from(actual), ['', 'ElementOriginal', 'PlayerCustom', null]);
  assert.deepEqual(current, ['', 'ElementTarget', 'PlayerCustom', null]);
  assert.notEqual(actual, current);
  assert.throws(() => runtime().typeNames('elements', null), { name: 'TypeError' });
});

test('early identity and late localization plus assistance preserve original manifest order and parameters', () => {
  const originals = [{ name: 'Alpha', status: true, parameters: { keep: '\\V[1]', nested: '{"x":1}' } }, { name: 'Disabled', status: false, parameters: {} }];
  let source = '\ufeffvar $plugins = ' + JSON.stringify(originals) + ';\r\nconst untouched = 17;\r\n';
  source = registerPlugin(source, { name: 'PinHaoLocalization', status: true, parameters: {} });
  source = registerPlugin(source, { name: 'PinHaoNameIdentity', status: true, parameters: {} }, { first: true });
  source = registerPlugin(source, { name: 'PinhaoAssist', status: true, parameters: {} });
  const parsed = inspectPlugins(source);
  assert.deepEqual(parsed.unresolved, []);
  assert.deepEqual(parsed.plugins.map(row => row.name), ['PinHaoNameIdentity', 'Alpha', 'Disabled', 'PinHaoLocalization', 'PinhaoAssist']);
  assert.deepEqual(parsed.plugins.slice(1, 3), originals);
  assert.ok(source.startsWith('\ufeff'));
  assert.ok(source.endsWith('\r\nconst untouched = 17;\r\n'));
});
