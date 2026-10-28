import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { analyzeRecollection, applySelection, recollectionTools, scanRecollection } from './recollection.mjs';

const cmd = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
const page = (list, conditions = {}) => ({ conditions, list, trigger: 0 });
const event = (id, pages, name = '') => ({ id, name, x: 1, y: 2, pages });
const pluginSource = `var settings = {rec_cg_set: {1: {switch_id: 3, pictures: ['CG1']}, 2: {switch_id: 5, pictures: ['CG2']}}};
Window_RecList.prototype.get_global_variables = function() { this._global_variables = {}; this._global_variables['switches'] = {}; };
Window_RecList.prototype.is_valid_picture = function(index) { return this._global_variables['switches'][index]; };
Window_RecList.prototype.drawItem = function(index) { return this._global_variables['switches'][index]; };`;

async function fixture(t, { engine = 'MV', plugin = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-recollection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'data'));
  await mkdir(path.join(root, 'js/plugins'), { recursive: true });
  const put = (name, value) => writeFile(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value));
  await put('js/' + (engine === 'MZ' ? 'rmmz_core.js' : 'rpg_core.js'), 'neutral fixture');
  await put('data/System.json', { switches: Array.from({ length: 20 }, (_, id) => id ? 'Switch ' + id : ''), variables: Array.from({ length: 20 }, (_, id) => id ? 'Variable ' + id : '') });
  await put('data/MapInfos.json', [null, { id: 1, name: 'Recollection Room' }, { id: 2, name: 'Village' }]);
  await put('data/CommonEvents.json', [null, { id: 1, name: 'Shared CG', list: [cmd(111, [1, 7, 0, 3, 1]), cmd(231, [1, 'CG_shared'], 1), cmd(412)] }]);
  await put('data/Map001.json', { width: 20, height: 15, events: [null, event(1, [page([
    cmd(111, [0, 5, 0]), cmd(231, [1, 'CG_neutral'], 1), cmd(411), cmd(231, [1, 'locked_thumbnail'], 1), cmd(412), cmd(117, [1]),
  ], { switch1Valid: true, switch1Id: 3 })], 'CG Stand')] });
  await put('data/Map002.json', { width: 10, height: 10, events: [null, event(1, [page([cmd(231, [1, 'CG_battle'])], { switch1Valid: true, switch1Id: 9 })], 'Story')] });
  await put('js/plugins.js', 'var $plugins = ' + JSON.stringify(plugin ? [{ name: 'RecollectionMode', status: true, parameters: {} }] : []) + ';');
  if (plugin) await put('js/plugins/RecollectionMode.js', pluginSource);
  return { root, put };
}

test('recollection scans complete gallery guards and common-event picture paths without touching story flags', async t => {
  const { root } = await fixture(t);
  const scan = await scanRecollection({ gameDir: root, engine: 'MV' });
  assert.equal(scan.engine, 'MV');
  assert.equal(scan.maps.length, 2);
  assert.equal(scan.maps[0].width, 20);
  assert.equal(scan.recipes.length, 2);
  assert.ok(scan.recipes.every(recipe => recipe.confidence === 'confirmed' && recipe.fingerprint === scan.fingerprint));
  assert.deepEqual(scan.candidates.map(candidate => candidate.operation), [
    { type: 'switch', id: 3, value: true }, { type: 'switch', id: 5, value: true }, { type: 'variable', id: 7, value: 3, mode: 'min' },
  ]);
  assert.ok(scan.candidates.every(candidate => candidate.id.includes(scan.fingerprint.slice(0, 16))));
  assert.ok(scan.candidates.some(candidate => candidate.evidence.some(row => row.file === 'data/CommonEvents.json')));
  assert.equal(scan.candidates.some(candidate => candidate.operation.id === 9), false);
  const unchanged = JSON.parse(await readFile(path.join(root, 'data/System.json'), 'utf8'));
  assert.equal(unchanged.switches[3], 'Switch 3');
});

test('MZ page self switches and script switch conditions carry exact state operations', async t => {
  const { root, put } = await fixture(t, { engine: 'MZ' });
  await put('data/Map001.json', { events: [null, event(4, [page([cmd(111, [12, '!$gameSwitches.value(8)']), cmd(231, [1, 'CG_a'], 1), cmd(412)], { selfSwitchValid: true, selfSwitchCh: 'B' })])] });
  const scan = await scanRecollection({ gameDir: root, engine: 'MZ' });
  assert.deepEqual(scan.candidates.map(candidate => candidate.operation), [{ type: 'selfSwitch', mapId: 1, eventId: 4, key: 'B', value: true }, { type: 'switch', id: 8, value: false }]);
});

test('event exits and jumps do not confirm unreachable pictures', async t => {
  const { root, put } = await fixture(t);
  for (const list of [[cmd(115), cmd(231, [1, 'CG_unreachable'])],
    [cmd(119, ['end']), cmd(231, [1, 'CG_unreachable']), cmd(118, ['end'])]]) {
    await put('data/Map001.json', { events: [null, event(1, [page(list, { switch1Valid: true, switch1Id: 3 })])] });
    const scan = await scanRecollection({ gameDir: root });
    assert.equal(scan.recipes.some(recipe => recipe.confidence === 'confirmed'), false);
  }
});

test('branch exits preserve the surviving path and common-event exits return to the caller', async t => {
  const { root, put } = await fixture(t);
  await put('data/Map001.json', { events: [null, event(1, [page([
    cmd(111, [0, 5, 0]), cmd(115, [], 1), cmd(411), cmd(231, [1, 'CG_else'], 1), cmd(412), cmd(231, [1, 'CG_after']),
  ], { switch1Valid: true, switch1Id: 3 })])] });
  const branch = await scanRecollection({ gameDir: root });
  assert.equal(branch.recipes.length, 2);
  assert.ok(branch.recipes.every(recipe => recipe.confidence === 'confirmed'));
  assert.deepEqual(branch.candidates.map(candidate => candidate.operation), [
    { type: 'switch', id: 3, value: true }, { type: 'switch', id: 5, value: false },
  ]);
  await put('data/CommonEvents.json', [null, { id: 1, list: [cmd(115), cmd(231, [1, 'CG_child_unreachable'])] }]);
  await put('data/Map001.json', { events: [null, event(1, [page([cmd(117, [1]), cmd(231, [1, 'CG_parent'])], { switch1Valid: true, switch1Id: 3 })])] });
  const common = await scanRecollection({ gameDir: root });
  assert.equal(common.recipes.length, 1);
  assert.equal(common.recipes[0].confidence, 'confirmed');
  assert.ok(common.recipes[0].evidence.some(row => row.detail === '显示图片 CG_parent'));
  await put('data/Map001.json', { events: [null, event(1, [page([
    cmd(111, [0, 5, 0]), cmd(115, [], 1), cmd(412), cmd(231, [1, 'CG_surviving']),
  ], { switch1Valid: true, switch1Id: 3 })])] });
  const noElse = await scanRecollection({ gameDir: root });
  assert.equal(noElse.recipes[0].confidence, 'confirmed');
  assert.deepEqual(noElse.candidates.map(candidate => candidate.operation), [
    { type: 'switch', id: 3, value: true }, { type: 'switch', id: 5, value: false },
  ]);
  await put('data/Map001.json', { events: [null, event(1, [page([
    cmd(111, [0, 5, 0]), cmd(115, [], 1), cmd(411), cmd(115, [], 1), cmd(412), cmd(231, [1, 'CG_never']),
  ], { switch1Valid: true, switch1Id: 3 })])] });
  assert.equal((await scanRecollection({ gameDir: root })).recipes.length, 0);
});

test('unmodeled control flow blocks only affected paths and retains its evidence', async t => {
  const { root, put } = await fixture(t);
  for (const control of [cmd(119, ['unknown']), cmd(112), cmd(355, ['unknownFlow()']), cmd(102, [['a', 'b']])]) {
    await put('data/Map001.json', { events: [null,
      event(1, [page([control, cmd(231, [1, 'CG_uncertain'])], { switch1Valid: true, switch1Id: 3 })]),
      event(2, [page([cmd(231, [1, 'CG_simple'])], { switch1Valid: true, switch1Id: 5 })]),
    ] });
    const scan = await scanRecollection({ gameDir: root });
    assert.equal(scan.recipes.find(recipe => recipe.candidateIds.some(id => scan.candidates.find(candidate => candidate.id === id)?.operation.id === 3)).blocked, true);
    assert.equal(scan.recipes.find(recipe => recipe.candidateIds.some(id => scan.candidates.find(candidate => candidate.id === id)?.operation.id === 5)).confidence, 'confirmed');
    assert.ok(scan.issues.some(issue => issue.code === 'CONTROL_FLOW'));
  }
});

test('script guards require one complete expression rather than the first statement', async t => {
  const { root, put } = await fixture(t);
  for (const source of ['$gameSwitches.value(4); false', '$gameSwitches.value(4); unknownSideEffect()', 'var value = $gameSwitches.value(4); value']) {
    await put('data/Map001.json', { events: [null, event(1, [page([cmd(111, [12, source]), cmd(231, [1, 'CG_script_guard'], 1), cmd(412)], { switch1Valid: true, switch1Id: 3 })])] });
    const scan = await scanRecollection({ gameDir: root });
    assert.equal(scan.recipes[0].blocked, true);
    assert.equal(scan.recipes[0].confidence, 'review');
    assert.equal(scan.candidates.some(candidate => candidate.operation.id === 4), false);
    assert.equal(scan.candidates[0].selectable, false);
  }
  await put('data/Map001.json', { events: [null, event(1, [page([cmd(111, [12, '; $gameSwitches.value(4); ;']), cmd(231, [1, 'CG_script_guard'], 1), cmd(412)])])] });
  const single = await scanRecollection({ gameDir: root });
  assert.equal(single.recipes[0].confidence, 'confirmed');
  assert.deepEqual(single.candidates[0].operation, { type: 'switch', id: 4, value: true });
});

test('unknown guards remain blocked, and conflicts never become a partial unlock recipe', async t => {
  const { root, put } = await fixture(t);
  await put('data/Map001.json', { events: [null, event(1, [page([cmd(111, [12, 'someUnknownGuard()']), cmd(231, [1, 'CG_a'], 1), cmd(412)], { switch1Valid: true, switch1Id: 3 })]),
    event(2, [page([cmd(111, [0, 4, 1]), cmd(231, [1, 'CG_b'], 1), cmd(412)], { switch1Valid: true, switch1Id: 4 })])] });
  const scan = await scanRecollection({ gameDir: root });
  assert.equal(scan.recipes.length, 1);
  assert.equal(scan.recipes[0].blocked, true);
  assert.equal(scan.candidates[0].selectable, false);
  assert.ok(scan.issues.some(issue => issue.code === 'CONDITION_CONFLICT'));
  const session = recollectionTools({ scan });
  await assert.rejects(session.tools.select_candidates.execute({ selectedCandidateIds: [scan.candidates[0].id], summary: 'Unknown guard' }), /已完成证据确认/);
});

test('known RecollectionMode configuration produces a display-only adapter from static syntax', async t => {
  const { root } = await fixture(t, { plugin: true });
  const scan = await scanRecollection({ gameDir: root });
  const recipe = scan.recipes.find(recipe => recipe.kind === 'plugin-display');
  assert.equal(recipe.confidence, 'confirmed');
  const candidate = scan.candidates.find(candidate => candidate.id === recipe.candidateIds[0]);
  assert.deepEqual(candidate.operation, { type: 'recollectionMode', plugin: 'RecollectionMode', switchIds: [3, 5] });
  assert.equal(candidate.operation.type === 'switch', false);
  assert.match(candidate.evidence[0].location, /line/);
});

test('disabled or dynamic RecollectionMode plugins are never evaluated or treated as confirmed', async t => {
  const { root, put } = await fixture(t, { plugin: true });
  await put('js/plugins.js', 'var $plugins = [{name:"RecollectionMode",status:false,parameters:{}}];');
  assert.equal((await scanRecollection({ gameDir: root })).recipes.some(recipe => recipe.kind === 'plugin-display'), false);
  await put('js/plugins.js', 'var $plugins = [{name:"RecollectionMode",status:true,parameters:{}}];');
  await put('js/plugins/RecollectionMode.js', pluginSource.replace('switch_id: 3', 'switch_id: (() => { throw new Error("must not execute"); })()'));
  const dynamic = await scanRecollection({ gameDir: root });
  assert.equal(dynamic.recipes.some(recipe => recipe.kind === 'plugin-display'), false);
});

test('fingerprint tolerates generated assist scripts but binds real map and plugin changes', async t => {
  const { root, put } = await fixture(t, { plugin: true });
  const first = await scanRecollection({ gameDir: root });
  await put('js/plugins/PinhaoAssist.js', 'generated v2');
  await put('js/plugins/PinhaoLocalization.js', 'generated v3');
  await put('js/plugins.js', (await readFile(path.join(root, 'js/plugins.js'), 'utf8')) + '\n$plugins.push({name:"PinhaoAssist",status:true});');
  assert.equal((await scanRecollection({ gameDir: root })).fingerprint, first.fingerprint);
  await put('js/plugins/RecollectionMode.js', pluginSource + '\n// actual game plugin update');
  assert.notEqual((await scanRecollection({ gameDir: root })).fingerprint, first.fingerprint);
});

test('dynamic and unparseable plugin manifests remain part of the resource fingerprint', async t => {
  const { root, put } = await fixture(t, { plugin: true });
  await put('js/plugins.js', 'var $plugins = createPlugins(1);');
  const dynamic = await scanRecollection({ gameDir: root });
  await put('js/plugins.js', 'var $plugins = createPlugins(2);');
  assert.notEqual((await scanRecollection({ gameDir: root })).fingerprint, dynamic.fingerprint);
  await put('js/plugins.js', 'var $plugins = [;');
  const invalid = await scanRecollection({ gameDir: root });
  await put('js/plugins.js', 'var $plugins = [{;');
  assert.notEqual((await scanRecollection({ gameDir: root })).fingerprint, invalid.fingerprint);
});

test('technical selection is bound to existing candidate IDs and the resource fingerprint', async t => {
  const { root } = await fixture(t);
  const scan = await scanRecollection({ gameDir: root });
  const session = recollectionTools({ scan });
  await assert.rejects(session.tools.select_candidates.execute({ selectedCandidateIds: ['made-up-id'], summary: 'Guess' }), /已完成证据确认/);
  await assert.rejects(session.tools.select_candidates.execute({ selectedCandidateIds: [scan.candidates[0].id, scan.candidates[0].id], summary: '' }), /结构/);
  await session.tools.select_candidates.execute({ selectedCandidateIds: [], summary: 'Keep confirmed recipes' });
  assert.ok(applySelection(scan, session.result()).recipes.every(recipe => recipe.confidence === 'confirmed'));
  assert.throws(() => applySelection(scan, { fingerprint: 'wrong', selectedCandidateIds: [] }), /版本/);
  assert.throws(() => applySelection(scan, { fingerprint: scan.fingerprint, analysisRulesVersion: scan.analysisRulesVersion, selectedCandidateIds: ['fake'] }), /已完成证据确认/);
});

test('analyze uses tool-selected candidates and never accepts free-form model operations', async t => {
  const { root } = await fixture(t);
  const scan = await scanRecollection({ gameDir: root });
  scan.candidates = scan.candidates.map(candidate => ({ ...candidate, confidence: 'review' }));
  let submitted;
  const result = await analyzeRecollection({ scan, connection: { baseUrl: 'http://127.0.0.1:1/v1', model: 'mock-model' }, agentFactory: options => ({
    async generate() {
      assert.ok(options.instructions.includes('select_candidates'));
      const catalogue = await options.tools.inspect_recollection.execute({});
      assert.equal(catalogue.fingerprint, scan.fingerprint);
      const candidates = await options.tools.inspect_candidates.execute({});
      submitted = [candidates.candidates[0].id];
      await options.tools.select_candidates.execute({ selectedCandidateIds: submitted, summary: 'The guard and picture references agree.' });
      return { steps: [{ finishReason: 'tool-calls', toolCalls: [{ toolName: 'select_candidates' }] }] };
    },
  }) });
  assert.deepEqual(result.selectedCandidateIds, submitted);
  assert.equal(result.fingerprint, scan.fingerprint);
  assert.equal(applySelection(scan, result).candidates[0].selected, true);
});

test('direct analysis of a scan without reviewable candidates never initializes the model', async () => {
  const result = await analyzeRecollection({ scan: { fingerprint: 'neutral', analysisRulesVersion: 'neutral-rules', candidates: [] },
    agentFactory: () => { throw new Error('model must not be initialized'); } });
  assert.equal(result.skipped, true);
  assert.deepEqual(result.selectedCandidateIds, []);
});

test('RGSS catalogue delegates to the native worker with the requested engine', async () => {
  let called;
  const scan = await scanRecollection({ gameDir: 'neutral-game', engine: 'VX Ace', worker: async (command, args) => {
    called = { command, args };
    return { engine: 'VX Ace', maps: [], commonEvents: [], switches: [], variables: [], files: [], scripts: [], issues: [] };
  } });
  assert.deepEqual(called, { command: 'assistCatalog', args: { gameDir: 'neutral-game', engine: 'VX Ace' } });
  assert.equal(scan.engine, 'VX Ace');
});

test('state shared with story guards and automatic common events stays unselectable', async t => {
  const { root, put } = await fixture(t);
  await put('data/Map002.json', { events: [null, event(1, [page([cmd(111, [0, 3, 0]), cmd(412)])])] });
  const shared = await scanRecollection({ gameDir: root });
  assert.ok(shared.recipes.every(recipe => recipe.blocked));
  assert.ok(shared.candidates.every(candidate => candidate.selectable === false));
  assert.ok(shared.issues.some(issue => issue.code === 'SHARED_STATE'));
  assert.ok(shared.candidates[0].evidence.some(row => row.file === 'data/Map002.json'));
  await put('data/Map002.json', { events: [] });
  await put('data/CommonEvents.json', [null, { id: 1, name: 'Auto status', trigger: 2, switchId: 3, list: [cmd(122, [7, 7, 0, 0, 1])] }]);
  const automatic = await scanRecollection({ gameDir: root });
  assert.equal(automatic.candidates.find(candidate => candidate.operation.id === 3).selectable, false);
});

test('later event pages block lower-page recipes unless their conditions are contradicted', async t => {
  const { root, put } = await fixture(t);
  await put('data/Map001.json', { events: [null, event(1, [page([cmd(231, [1, 'CG_lower'])], { switch1Valid: true, switch1Id: 3 }), page([])])] });
  const shadowed = await scanRecollection({ gameDir: root });
  assert.equal(shadowed.recipes[0].blocked, true);
  assert.ok(shadowed.issues.some(issue => issue.code === 'PAGE_PRIORITY'));
  await put('data/Map001.json', { events: [null, event(1, [page([cmd(111, [0, 3, 1]), cmd(231, [1, 'CG_lower'], 1), cmd(412)]), page([], { switch1Valid: true, switch1Id: 3 })])] });
  assert.equal((await scanRecollection({ gameDir: root })).recipes[0].confidence, 'confirmed');
});

test('variable guard modes preserve already-higher progress and combine compatible thresholds', async t => {
  const { root, put } = await fixture(t);
  await put('data/Map001.json', { events: [null, event(1, [page([cmd(111, [1, 7, 0, 10, 1]), cmd(231, [1, 'CG_variable'], 1), cmd(412)], { variableValid: true, variableId: 7, variableValue: 3 })])] });
  const threshold = await scanRecollection({ gameDir: root });
  assert.deepEqual(threshold.candidates[0].operation, { type: 'variable', id: 7, value: 10, mode: 'min' });
  const current = 100, operation = threshold.candidates[0].operation;
  assert.equal(Math.max(current, operation.value), current);
  await put('data/Map001.json', { events: [null, event(1, [page([cmd(111, [1, 7, 0, 10, 0]), cmd(231, [1, 'CG_exact'], 1), cmd(412)])])] });
  assert.deepEqual((await scanRecollection({ gameDir: root })).candidates[0].operation, { type: 'variable', id: 7, value: 10, mode: 'set' });
});

test('invalid IDs and unsolved variable ranges do not yield partial confirmed recipes', async t => {
  const { root, put } = await fixture(t);
  await put('data/Map001.json', { events: [null, event(1, [page([cmd(111, [0, 999, 0]), cmd(231, [1, 'CG_invalid'], 1), cmd(412)], { switch1Valid: true, switch1Id: 3 })])] });
  assert.equal((await scanRecollection({ gameDir: root })).recipes.length, 0);
  await put('data/Map001.json', { events: [null, event(1, [page([cmd(111, [1, 7, 0, 10, 2]), cmd(231, [1, 'CG_range'], 1), cmd(412)], { variableValid: true, variableId: 7, variableValue: 3 })])] });
  const range = await scanRecollection({ gameDir: root });
  assert.equal(range.recipes.length, 0);
  assert.ok(range.issues.some(issue => issue.code === 'COMPLEX_VARIABLE_RANGE'));
});

test('simple plugin script display guards are reviewable while unrelated plugin uses block state writes', async t => {
  const { root, put } = await fixture(t);
  await put('js/plugins.js', 'var $plugins = [{name:"NeutralGallery",status:true,parameters:{}}];');
  await put('js/plugins/NeutralGallery.js', 'function gallery() { if ($gameSwitches.value(6)) { $gameScreen.showPicture(1,"CG_script",0,0,0,100,100,255,0); } }');
  const review = await scanRecollection({ gameDir: root });
  const candidate = review.candidates.find(candidate => candidate.operation.id === 6);
  assert.equal(candidate.confidence, 'review');
  assert.equal(candidate.selectable, true);
  await put('js/plugins/ChapterFlow.js', 'function story() { return $gameSwitches.value(6); }');
  const shared = await scanRecollection({ gameDir: root });
  assert.equal(shared.candidates.find(candidate => candidate.operation.id === 6).selectable, false);
  await put('js/plugins/NeutralGallery.js', 'function gallery() { if (unknownOuterGuard()) { if ($gameSwitches.value(6)) { $gameScreen.showPicture(1,"CG_script",0,0,0,100,100,255,0); } } }');
  assert.equal((await scanRecollection({ gameDir: root })).candidates.some(candidate => candidate.operation.id === 6), false);
});

test('locally prepared official RecollectionMode syntax matches the display adapter', async t => {
  let source;
  try { source = await readFile(new URL('../../local/assist-research/RecollectionMode.js', import.meta.url), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('Official research fixture is optional'); return; } throw error; }
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const scan = await scanRecollection({ gameDir: 'neutral', engine: 'MV', worker: async () => ({
    engine: 'MV', maps: [], commonEvents: [], variables: [], switches: Array(10000).fill('Neutral'),
    files: [{ file: 'js/plugins/RecollectionMode.js', sha256: sourceHash }],
    scripts: [{ name: 'RecollectionMode', file: 'js/plugins/RecollectionMode.js', source, sourceHash },
      { name: '$plugins', file: 'js/plugins.js', source: 'var $plugins = [{name:"RecollectionMode",status:true,parameters:{}}];' }], issues: [],
  }) });
  assert.equal(scan.recipes.length, 1);
  assert.equal(scan.recipes[0].kind, 'plugin-display');
  assert.equal(scan.recipes[0].confidence, 'confirmed');
  assert.ok(scan.candidates[0].operation.switchIds.length > 0);
  assert.equal(scan.issues.length, 0);
});
