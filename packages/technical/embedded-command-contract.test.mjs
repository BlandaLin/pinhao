import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseEmbeddedCarrier, projectEmbeddedCommand, encodeEmbeddedTarget, verifyEmbeddedRewrite, qualifyEmbeddedContracts, assertEmbeddedContractsFresh } from './embedded-command-contract.mjs';

const fixture = async (t, expression = "args[0]", source = 'Hello') => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pinhao-real-carrier-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  await mkdir(path.join(dir, 'js/plugins'), { recursive: true });
  await writeFile(path.join(dir, 'js/rpg_objects.js'), `Game_Interpreter.prototype.command356 = function() { var args = this._params[0].split(' '); var command = args.shift(); this.pluginCommand(command,args); return true; };`);
  await writeFile(path.join(dir, 'js/plugins.js'), `var $plugins = [{name:'Notice',status:true}];`);
  await writeFile(path.join(dir, 'js/plugins/Notice.js'), `Game_Interpreter.prototype.pluginCommand=function(command,args){if(command==='NOTICE'){ $gameMessage.add(${expression}); }};`);
  const unit = { id: 'line', rawSource: source, locator: { file: 'data/CommonEvents.json', pointer: '/1/list/0/parameters/0', segment: { syntax: 'rpgmaker-plugin-command', prefix: 'NOTICE ', suffix: ' 32' } } };
  return { dir, unit, before: `NOTICE ${source} 32` };
};
test('ASCII-space carrier keeps empty arguments and does not invent shell quoting', () => {
  assert.deepEqual(parseEmbeddedCarrier('NOTICE a  b 32').args, ['a','','b','32']);
  assert.deepEqual(projectEmbeddedCommand(parseEmbeddedCarrier('NOTICE a  b 32'), { mode: 'joined-range-before-tail', argvStart: 0, tailArgumentCount: 1 }).display, 'a  b');
});
test('qualified one-argument rejects multiword target and preserves font argument', async t => {
  const { dir, unit, before } = await fixture(t), contracts = await qualifyEmbeddedContracts({ gameDir: dir, units: [unit] });
  const contract = contracts.line;
  assert.equal(encodeEmbeddedTarget({ before, source: 'Hello', target: '你好', contract }), 'NOTICE 你好 32');
  for (const target of ['Bonjour monde', '"Bonjour monde"']) assert.throws(() => encodeEmbeddedTarget({ before, source: 'Hello', target, contract }), { code: 'EMBEDDED_TEXT_UNREPRESENTABLE' });
  assert.throws(() => verifyEmbeddedRewrite({ before, after: 'NOTICE 你好 99', source: 'Hello', target: '你好', contract }), { code: 'EMBEDDED_TEXT_UNREPRESENTABLE' });
});
test('qualified joined range allows changed word counts and tailCount zero', async t => {
  const { dir, unit, before } = await fixture(t, "args.slice(0,-1).join(' ')", 'Complete menu text');
  const contract = (await qualifyEmbeddedContracts({ gameDir: dir, units: [unit] })).line;
  assert.equal(encodeEmbeddedTarget({ before, source: unit.rawSource, target: 'Bonjour monde', contract }), 'NOTICE Bonjour monde 32');
  assert.equal(encodeEmbeddedTarget({ before, source: unit.rawSource, target: '完整菜单', contract }), 'NOTICE 完整菜单 32');
  assert.equal(projectEmbeddedCommand(parseEmbeddedCarrier('NOTICE x  y'), { mode: 'joined-range-before-tail', argvStart: 0, tailArgumentCount: 0 }).display, 'x  y');
});
test('author hints, secondary syntax, loader changes and carrier overrides do not qualify', async t => {
  const { dir, unit } = await fixture(t, "args[0].split(',')[0]");
  await assert.rejects(qualifyEmbeddedContracts({ gameDir: dir, units: [unit] }), { code: 'EMBEDDED_REPRESENTATION_PENDING' });
  await writeFile(path.join(dir, 'js/plugins/Notice.js'), "Game_Interpreter.prototype.pluginCommand=function(command,args){if(command==='NOTICE')$gameMessage.add(args[0]);};");
  const contracts = await qualifyEmbeddedContracts({ gameDir: dir, units: [unit] });
  await writeFile(path.join(dir, 'js/plugins.js'), 'var $plugins=[];');
  await assert.rejects(assertEmbeddedContractsFresh(contracts, dir), { code: 'EMBEDDED_REPRESENTATION_PENDING' });
});
