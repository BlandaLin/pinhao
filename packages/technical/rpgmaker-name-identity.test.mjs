import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { analyzeRpgMakerNameIdentity, detectRpgMakerNameOverrides, proveRpgMakerEnemyNameMethods, rewriteRpgMakerNameIdentity } from './rpgmaker-name-identity.mjs';

const rewrite = (source, options = {}) => rewriteRpgMakerNameIdentity({ file: 'js/plugins/neutral.js', source, ...options });
const core = `Game_Enemy.prototype.name = function() { return this.originalName() + (this._plural ? this._letter : ''); };
Game_Enemy.prototype.originalName = function() { return this.enemy().name; };
Game_Enemy.prototype.enemy = function() { return $dataEnemies[this._enemyId]; };
Game_Enemy.prototype.enemyId = function() { return this._enemyId; };`;

test('database name identity comparisons change only name leaves, never displayed names', () => {
  const source = `const skill = $dataSkills[1];
const selected = skill.name === 'Recharge';
window.drawText(skill.name);
window.drawText($dataActors[1].name);
const actorId = $dataActors[1].name !== 'Neutral Hero';`;
  const result = rewrite(source);
  assert.equal(result.changed, 2);
  assert.match(result.source, /dataName\("Skills", skill\) === 'Recharge'/);
  assert.match(result.source, /dataName\("Actors", \$dataActors\[1\]\) !== 'Neutral Hero'/);
  assert.ok(result.source.includes('window.drawText(skill.name);'));
  assert.ok(result.source.includes('window.drawText($dataActors[1].name);'));
  assert.deepEqual(result.requirements.dataTables, ['Skills', 'Actors']);
  assert.deepEqual(result.warnings, []);
});

test('typed callbacks, immutable aliases and cross-table comparisons keep identity', () => {
  const source = `const items = $dataItems;
const chosen = items.find(item => $dataStates.some(state => state.name === item.name));
const selected = $dataSkills.filter(skill => skill.name != 'Recharge').find(skill => skill.name === 'Strike');
const ids = $dataStates.map(state => state.name).indexOf($dataItems[1].name);
const types = $dataSystem.skillTypes;
const ranged = types.indexOf('Projectile');
drawText($dataSystem.skillTypes[1]);`;
  const result = rewrite(source);
  assert.equal(result.changed, 7);
  assert.match(result.source, /dataName\("States", state\) === PinHaoNameIdentity.dataName\("Items", item\)/);
  assert.match(result.source, /map\(state => PinHaoNameIdentity.dataName\("States", state\)\)/);
  assert.match(result.source, /typeNames\("skillTypes", types\).indexOf/);
  assert.ok(result.source.endsWith('drawText($dataSystem.skillTypes[1]);'));
});

test('native enemy sources reach filename sinks including concat, template and loop', () => {
  const source = `const enemy = $gameTroop.members()[next()];
ImageManager.loadPicture('Portrait_' + enemy.name());
$gameTroop.members().forEach(function(subject) { $gameScreen.showPicture(1, \`Portrait_\${subject.name()}\`); });
Game_Enemy.prototype.renderPortrait = function() { ImageManager.loadEnemy(this.name()); };
for (const opponent of $gameTroop.members()) ImageManager.loadSvEnemy(opponent.name());
drawText(enemy.name());`;
  const result = rewrite(source);
  assert.equal(result.changed, 4);
  assert.equal(result.requirements.enemyBattler, true);
  assert.equal(result.warnings.length, 0);
  assert.ok(result.source.endsWith('drawText(enemy.name());'));
});

test('native battler database collections have typed record callbacks', () => {
  const result = rewrite(`Game_Enemy.prototype.hasDistance = function() { return this.states().some(state => state.name === 'Distant'); };
const actor = $gameActors.actor(1);
const skill = actor.skills().find(skill => skill.name === 'Recharge');
const weapon = actor.weapons().find(weapon => weapon.name === 'Neutral blade');`);
  assert.equal(result.changed, 3);
  assert.deepEqual(result.requirements.dataTables, ['States', 'Skills', 'Weapons']);
});

test('actor runtime names remain custom-name aware and require explicit evidence', () => {
  const source = `const actor = $gameActors.actor(1);
if (actor.name() === 'Neutral Hero') play();
$gameParty.members().forEach(member => ImageManager.loadPicture(member.name()));
Game_Actor.prototype.logic = function() { return this.name() === 'Neutral Hero'; };`;
  const result = rewrite(source);
  assert.equal(result.source, source);
  assert.equal(result.changed, 0);
  assert.equal(result.warnings.length, 3);
  assert.ok(result.warnings.every(item => item.code === 'actor-runtime-name-may-be-custom'));
});

test('variable spelling does not prove a receiver and a half-proven comparison is not changed', () => {
  const source = `function choose(enemy, skill) {
ImageManager.loadPicture(enemy.name());
return $dataStates[1].name === skill.name;
}`;
  const result = rewrite(source);
  assert.equal(result.source, source);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.every(item => item.code === 'unproven-name-origin'));
});

test('lexical, parameter and var-hoisted shadowing prevent native-global guesses', () => {
  const source = `function local($dataSkills) { return $dataSkills[1].name === 'Recharge'; }
function hoisted() { if (yes) { var $dataStates = localStates; } return $dataStates[1].name === 'Distant'; }
{ const $gameTroop = otherTroop; ImageManager.loadPicture($gameTroop.members()[0].name()); }
{ const PinHaoNameIdentity = otherApi; if ($dataItems[1].name === 'Barrier') use(); }
{ const ImageManager = custom; ImageManager.loadPicture($dataEnemies[1].name); }`;
  const result = rewrite(source);
  assert.equal(result.changed, 0);
  assert.equal(result.warnings.filter(item => item.code === 'unproven-name-origin').length, 3);
  assert.ok(result.warnings.some(item => item.code === 'shadowed-identity-api'));
});

test('scalar name aliases, mutable aliases and unknown string comparisons are not guessed', () => {
  const source = `let state = $dataStates[1];
const title = $dataItems[1].name;
if (state.name === 'Distant') use();
if (title === 'Barrier') use();
if ($dataSkills[1].name === dynamicName) use();
ImageManager.loadPicture($dataEnemies[1].name.toLowerCase());`;
  const result = rewrite(source);
  assert.equal(result.changed, 0);
  assert.ok(result.warnings.some(item => item.code === 'unproven-name-origin'));
  assert.ok(result.warnings.some(item => item.code === 'dynamic-name-comparison'));
  assert.ok(result.warnings.some(item => item.code === 'unsupported-name-expression'));
});

test('reassigned callback parameters and their derived callbacks lose their native evidence', () => {
  const source = `$dataSkills.forEach(skill => { skill = other; if (skill.name === 'Recharge') use(); });
$gameTroop.members().forEach(enemy => { const states = enemy.states(); enemy = other; states.some(state => state.name === 'Distant'); });`;
  const result = rewrite(source);
  assert.equal(result.changed, 0);
  assert.equal(result.warnings.filter(item => item.code === 'unproven-name-origin').length, 2);
});

test('all four enemy getter overrides disable enemy rewriting in their file or via aggregate flag', () => {
  for (const method of ['name', 'originalName', 'enemy', 'enemyId']) {
    for (const override of [
      `Game_Enemy.prototype.${method} = function() { return custom(); };`,
      `Object.defineProperty(Game_Enemy.prototype, '${method}', { value: function() { return custom(); } });`,
      `Object.defineProperties(Game_Enemy.prototype, { ${method}: { value: function() { return custom(); } } });`,
    ]) {
      const source = `${override}\nImageManager.loadPicture($gameTroop.members()[0].name());`;
      assert.equal(detectRpgMakerNameOverrides({ source }).enemyBattler, true, override);
      assert.equal(rewrite(source).changed, 0, override);
    }
  }
  const result = rewrite('ImageManager.loadPicture($gameTroop.members()[0].name());', { allowEnemyBattler: false });
  assert.equal(result.changed, 0);
  assert.equal(result.warnings[0].code, 'enemy-name-override');
  assert.equal(rewrite("ImageManager.loadPicture($gameTroop.members()[0].enemy().name);", { allowEnemyBattler: false }).changed, 0);
  for (const source of [
    'const proto = Game_Enemy.prototype; proto.enemyId = custom;',
    'Object.assign(Game_Enemy.prototype, { name: custom });',
    'Object.assign(Game_Enemy.prototype, dynamicMethods);',
    'Game_Enemy.prototype[dynamicKey] = custom;',
    'Reflect.defineProperty(Game_Enemy.prototype, "enemy", { value: custom });',
    'Game_Enemy.prototype = replacement;',
  ]) assert.equal(detectRpgMakerNameOverrides({ source }).enemyBattler, true, source);
});

test('known data accessors block their table while unrelated unknown accessors are warnings', () => {
  const source = `const item = $dataItems[1];
Object.defineProperty(item, 'name', { get: function() { return compute(); } });
if (item.name === 'Barrier') use();
if ($dataStates[1].name === 'Distant') use();`;
  const result = rewrite(source);
  assert.deepEqual(result.overrides.dataTables, ['Items']);
  assert.equal(result.changed, 1);
  assert.equal(result.warnings[0].code, 'name-accessor-override');
  const unknown = rewrite(`const dynamic = { get name() { return compute(); } };\n${source}`);
  assert.equal(unknown.overrides.unknownDataAccessor, false);
  assert.equal(unknown.changed, 1);
  assert.ok(unknown.warnings.some(item => item.code === 'unproven-name-accessor-target'));
  assert.equal(rewrite("if ($dataStates[1].name === 'Distant') use();", { blockedDataTables: ['States'] }).changed, 0);
  const assigned = rewrite("$dataItems[1] = { id: 1, get name() { return compute(); } }; if ($dataItems[1].name === 'Barrier') use();");
  assert.deepEqual(assigned.overrides.dataTables, ['Items']);
  assert.equal(assigned.changed, 0);
});

test('generic defineProperty helpers do not become proven database name accessors', () => {
  const source = `function define(target, key, descriptor) { Object.defineProperty(target, key, descriptor); }
Object.defineProperty(widget, 'text', { get: function() { return caption; } });
Object.defineProperty(widget, 'name', { get: function() { return caption; } });
if ($dataStates[1].name === 'Distant') use();`;
  const result = rewrite(source);
  assert.equal(result.changed, 1);
  assert.equal(result.overrides.unknownDataAccessor, false);
  assert.deepEqual(result.overrides.dataTables, []);
  assert.equal(result.warnings.filter(item => item.code === 'unproven-name-accessor-target').length, 2);
});

test('unparsed source is preserved and exposes conservative aggregate guard facts', () => {
  const source = 'function broken( {';
  assert.equal(rewrite(source).source, source);
  assert.equal(rewrite(source).warnings[0].code, 'unparsed-source');
  assert.equal(detectRpgMakerNameOverrides({ source }).unknownDataAccessor, true);
});

test('default enemy getter proof requires exact four top-level method bodies', () => {
  assert.equal(proveRpgMakerEnemyNameMethods({ source: core }).verified, true);
  assert.equal(proveRpgMakerEnemyNameMethods({ source: core.replace('return this.enemy().name;', 'record(); return this.enemy().name;') }).verified, false);
  assert.equal(proveRpgMakerEnemyNameMethods({ source: core.replace('this._enemyId]', 'otherId]') }).verified, false);
  assert.equal(proveRpgMakerEnemyNameMethods({ source: `if (enabled) { ${core} }` }).verified, false);
  assert.equal(proveRpgMakerEnemyNameMethods({ source: `${core}\nGame_Enemy.prototype.name = custom;` }).verified, false);
  assert.equal(proveRpgMakerEnemyNameMethods({ source: `${core}\nObject.defineProperty(Game_Enemy.prototype, 'name', { value: custom });` }).verified, false);
  assert.equal(proveRpgMakerEnemyNameMethods({ source: `${core}\nGame_Enemy.prototype[method] = custom;` }).verified, false);
});

test('engine-style prototype initialization is permitted only once before the four getters', () => {
  const initialization = 'Game_Enemy.prototype = Object.create(Game_Battler.prototype);';
  const engineStyle = `function Game_Enemy() {}\n${initialization}\nGame_Enemy.prototype.constructor = Game_Enemy;\n${core}`;
  assert.equal(proveRpgMakerEnemyNameMethods({ source: engineStyle }).verified, true);
  assert.equal(proveRpgMakerEnemyNameMethods({ source: `${core}\n${initialization}` }).verified, false);
  assert.equal(proveRpgMakerEnemyNameMethods({ source: `${initialization}\n${engineStyle}` }).verified, false);
  assert.equal(proveRpgMakerEnemyNameMethods({ source: engineStyle.replace('Object.create(Game_Battler.prototype)', 'replacement') }).verified, false);
  assert.equal(proveRpgMakerEnemyNameMethods({ source: `if (enabled) { ${initialization} }\n${core}` }).verified, false);
});

test('neutral VM preserves identity, translated display and source evaluation counts', () => {
  const source = `const state = $dataStates[nextState()];
const match = state.name === 'Distant';
const skillId = $dataSkills.find(skill => skill && skill.name === 'Recharge').id;
const linked = $dataStates.find(state => state && state.name === $dataItems[1].name).id;
const typeId = $dataSystem.skillTypes.indexOf('Projectile');
ImageManager.loadPicture('Portrait_' + $gameTroop.members()[nextEnemy()].name());
drawText(state.name);
drawText($gameTroop.members()[0].name());
globalThis.result = {match,skillId,linked,typeId};`;
  const rewritten = rewrite(source);
  const originalNames = { States: { 1: 'Distant', 2: 'Barrier' }, Skills: { 1: 'Recharge' }, Items: { 1: 'Barrier' } };
  const enemy = { name() { context.getterCalls++; return '\u4e2d\u6027\u654c\u4eba A'; } };
  const context = {
    $dataStates: [null, { id: 1, name: '\u8fdc\u5904' }, { id: 2, name: '\u5c4f\u969c' }],
    $dataSkills: [null, { id: 1, name: '\u88c5\u586b' }], $dataItems: [null, { id: 1, name: '\u62a4\u76fe' }],
    $dataSystem: { skillTypes: ['', '\u8fdc\u7a0b'] }, $gameTroop: { members: () => [enemy] },
    stateCalls: 0, enemyCalls: 0, getterCalls: 0, displays: [], pictures: [],
    nextState() { context.stateCalls++; return 1; }, nextEnemy() { context.enemyCalls++; return 0; },
    drawText(value) { context.displays.push(value); }, ImageManager: { loadPicture(value) { context.pictures.push(value); } },
    PinHaoNameIdentity: {
      dataName(table, record) { const current = record.name; return originalNames[table]?.[record.id] ?? current; },
      battlerName(table, subject) { return subject.name().replace('\u4e2d\u6027\u654c\u4eba', 'Neutral Enemy'); },
      typeNames(field, current) { return field === 'skillTypes' ? ['', 'Projectile'] : current; },
    },
  };
  vm.runInNewContext(rewritten.source, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.result)), { match: true, skillId: 1, linked: 2, typeId: 1 });
  assert.deepEqual(context.displays, ['\u8fdc\u5904', '\u4e2d\u6027\u654c\u4eba A']);
  assert.deepEqual(context.pictures, ['Portrait_Neutral Enemy A']);
  assert.equal(context.stateCalls, 1);
  assert.equal(context.enemyCalls, 1);
  assert.equal(context.getterCalls, 2);
  assert.throws(() => vm.runInNewContext(rewrite("$dataStates[1].name === 'Distant'").source, {
    $dataStates: [null, null], PinHaoNameIdentity: context.PinHaoNameIdentity,
  }), /name/);
});

test('analysis ranges leave all bytes outside selected name leaves unchanged', () => {
  const source = `// preserve comments and quotes\r\nif ( $dataItems[ 1 ].name === "Barrier" ) use();\r\n`;
  const result = analyzeRpgMakerNameIdentity({ source });
  assert.equal(result.edits.length, 1);
  const edit = result.edits[0];
  assert.equal(source.slice(edit.start, edit.end), '$dataItems[ 1 ].name');
  assert.equal(rewrite(source).source, source.slice(0, edit.start) + edit.replacement + source.slice(edit.end));
});
