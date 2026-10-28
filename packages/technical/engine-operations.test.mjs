import test from 'node:test';
import assert from 'node:assert/strict';
import { engineOperations, engineOperationsReference, renderEngineOperations } from './engine-operations.mjs';

test('Unity guidance distinguishes native group identities from coverage decisions and evidence handles', () => {
  const guide = engineOperations('Unity', ['native_extract', 'native_review', 'native_review_decide', 'native_unpack']);
  const text = renderEngineOperations(guide);
  assert.equal(guide.family, 'unity');
  assert.equal(guide.version, 'pinhao-engine-operations-17');
  assert.match(text, /groups\[\]\.groupRef/);
  assert.match(text, /unknownClusters/);
  assert.match(text, /evidenceId/);
  assert.match(text, /JSON/);
  assert.match(text, /50/);
  assert.match(text, /native_review\(\{file\?,groupRef\?,offset\?,limit\?\}\)/);
  assert.match(text, /decisions是结构化数组/);
  assert.match(text, /prefiltered标记的已结算/);
  assert.match(text, /status:no-text.*必须提交non-display/);
  assert.match(text, /run_tool不再转发/);
  assert.match(text, /首次调用native_review\(\{\}\)/);
  assert.match(text, /diagnosticId.*scriptIdentity/);
  assert.match(text, /显式file仍可读取关联资源/);
  assert.doesNotMatch(text, /旧通用入口仍可用/);
  assert.match(text, /displaySites:\[siteRef\]/);
  assert.match(text, /mixed-use.*保留原值/);
  assert.match(text, /write_workspace_file.*run_workspace/);
  assert.match(text, /序列化实例没有正文.*不代表运行时没有对白/);
  assert.match(text, /完整句.*Length\/Substring/);
  assert.match(text, /presentation-slice.*同一字段path.*displaySites\/siteRef/);
  assert.match(text, /保留原Substring参数异常、原Length与计时逻辑/);
  assert.match(text, /拼接片段不得拆成独立对白/);
});

test('guide references omit the system document and return only an explicitly requested section', () => {
  const guide = engineOperations('Unity', ['native_review']);
  const index = engineOperationsReference(guide);
  assert.equal(index.source, 'system-instructions');
  assert.ok(index.sections.every(section => !('text' in section)));
  assert.deepEqual(index.readSection, { tool: 'inspect_context', parameter: 'guideSection' });
  const selected = engineOperationsReference(guide, 'unity-display-binding');
  assert.equal(selected.section.id, 'unity-display-binding');
  assert.match(selected.section.text, /逻辑/);
  assert.throws(() => engineOperationsReference(guide, 'invented'), /章节编号/);
  assert.ok(guide.sections.every(section => section.text), 'the canonical full guide remains intact');
});

test('guides follow the recognized engine and the registered native capabilities', () => {
  assert.equal(engineOperations('RPG Maker MZ').family, 'rpgmaker');
  assert.equal(engineOperations('MV').family, 'rpgmaker');
  assert.equal(engineOperations('VX Ace').family, 'rgss');
  assert.match(renderEngineOperations(engineOperations('Godot', ['native_extract'])), /PCK/);
  assert.equal(engineOperations('Unity', []).sections.some(section => section.id === 'unity-native-review'), false);
  assert.equal(engineOperations('Unity', []).sections.some(section => section.id === 'archives'), false);
  assert.match(renderEngineOperations(engineOperations('Unknown', [])), /实际缺口/);
});

test('workbench locations are distinguished from physical source resources for every engine', () => {
  for (const engine of ['Unity', 'Godot', 'MV', 'Unknown']) {
    const text = renderEngineOperations(engineOperations(engine));
    assert.match(text, /虚拟回写定位/);
    assert.match(text, /context\.carrier/);
    assert.match(text, /不反复用 read_resource/);
    assert.match(text, /PINHAO_SOURCE_DIR\/PINHAO_WORK_DIR/);
    assert.match(text, /executionContext/);
  }
});

test('native identity and literal-selection guidance address actual RPG failure modes', () => {
  const normalize = value => value.replaceAll('`', '').replace(/\s+/g, '');
  const rpg = normalize(renderEngineOperations(engineOperations('RPG Maker MV')));
  assert.match(rpg, /Map事件name.*(?:不是|不等于)Actors角色显示名/);
  assert.match(rpg, /自开关名、按键名、图片文件名/);
  assert.match(rpg, /整个parameters字符串(?:不能当一句话翻译|不是一句话)/);
  assert.match(rpg, /未知note(?:和|或)插件参数须核对实际消费者/);
  const rgss = normalize(renderEngineOperations(engineOperations('VX')));
  assert.match(rgss, /不同text各自计数.*唯一匹配不填occurrence/);
  assert.match(rgss, /原文字句不带源码外层引号/);
  assert.match(rgss, /JSON字段使用已有display-id或精确pointer/);
  assert.match(rgss, /复杂Ruby句式.*write_adapter.*受管脚本/);
});

test('command-body guidance connects evidence to the safe writer without opening whole commands', () => {
  const mv = renderEngineOperations(engineOperations('RPG Maker MV'));
  const mz = renderEngineOperations(engineOperations('RPG Maker MZ'));
  for (const text of [mv, mz]) {
    assert.match(text, /expressionCandidates/);
    assert.match(text, /write_embedded_text_adapter/);
    assert.match(text, /selections:\[\{file,pointer,text,reason\}\]/);
    assert.match(text, /validate_adapter/);
    assert.match(text, /submit_recipe/);
  }
  assert.match(mv, /外侧字节保留不代表参数含义必然不变/);
  assert.match(mv, /单参数正文不能随意加入空格/);
  assert.match(mv, /每次构建、合并仍重验/);
  assert.match(mz, /不适用于 357/);
});

test('all engine guides distinguish coverage review from new player-text extraction', () => {
  for (const engine of ['RPG Maker MV', 'RPG Maker VX Ace', 'Unity', 'Godot', 'Bakin', 'WOLF', 'Unknown']) {
    const text = renderEngineOperations(engineOperations(engine));
    assert.match(text, /玩家运行游戏时可见/);
    assert.match(text, /不是编辑器、制作工具说明/);
    assert.match(text, /reviewKind:resource-file/);
    assert.match(text, /nonDisplayAllowed/);
    assert.match(text, /boundReferenceAllowed/);
    assert.match(text, /不传unitIds，主机绑定当前定位集合/);
    assert.match(text, /分类出口不用创建空提取器/);
    assert.match(text, /少量定位也不代表整份文件覆盖/);
    assert.doesNotMatch(text, /所有候选同样经/);
  }
});

const editions = [
  ['RPG Maker MV', 'rpgmaker-mv', 'MV'], ['RPG Maker MZ', 'rpgmaker-mz', 'MZ'],
  ['RPG Maker XP', 'rpgmaker-xp', 'XP'], ['RPG Maker VX', 'rpgmaker-vx', 'VX'],
  ['RPG Maker VX Ace', 'rpgmaker-vx-ace', 'VX Ace'],
  ['RPG Maker 2000', 'rpgmaker-2000', '2000'], ['RPG Maker 2003', 'rpgmaker-2003', '2003'],
  ['WOLF', 'wolf', 'WOLF RPG Editor'], ["Ren'Py", 'renpy', 'Ren’Py'],
  ['KiriKiri/KAG', 'kag', 'KAG'], ['TyranoScript', 'tyrano', 'Tyrano'],
  ['Unity', 'unity', 'Unity'], ['Godot', 'godot', 'Godot'],
  ['Pixel Game Maker MV', 'pgmm', 'PGMM'], ['SMILE GAME BUILDER', 'sgb', 'SGB'],
  ['RPG Developer Bakin', 'bakin', 'Bakin'],
];

test('sixteen independent manuals select one engine and preserve that selection through references', () => {
  const ids = editions.map(([, id]) => id);
  assert.equal(new Set(ids).size, 16);
  for (const [engine, id, alias] of editions) {
    const guide = engineOperations(engine);
    assert.equal(guide.manualId, id, engine);
    assert.equal(engineOperations(alias).manualId, id, alias);
    const selected = guide.sections.filter(section => ids.includes(section.id));
    assert.deepEqual(selected.map(section => section.id), [id], engine);
    assert.ok(selected[0].text.length > 400, `${engine} has operational content, not a label`);
    assert.equal(engineOperationsReference(guide).manualId, id);
    assert.equal(engineOperationsReference(guide, id).section.text, selected[0].text);
    assert.deepEqual(engineOperations(engine), guide, 'assembly does not mutate shared manuals');
    assert.match(renderEngineOperations(guide), /不是固定流程或权限白名单/);
    assert.match(renderEngineOperations(guide), /read_evidence.limit至多12/);
    assert.match(renderEngineOperations(guide), /search_files.limit至多100/);
    assert.match(renderEngineOperations(guide), /省略cwd就是工作根/);
  }
});

test('a combined LCF label and an unknown engine do not pretend an exact edition is known', () => {
  const combined = engineOperations('RPG Maker 2000/2003');
  assert.equal(combined.manualId, 'lcf-unconfirmed');
  assert.equal(combined.family, 'lcf');
  assert.match(renderEngineOperations(combined), /lcfEngine只是当前codec配置/);
  assert.match(renderEngineOperations(combined), /sourceIndex/);
  assert.match(renderEngineOperations(combined), /原生语义重导出/);
  assert.match(renderEngineOperations(combined), /缺省932.*缺省936/);
  assert.equal(combined.sections.some(section => ['rpgmaker-2000', 'rpgmaker-2003'].includes(section.id)), false);
  assert.equal(engineOperations('unknown').manualId, 'unrecognized-engine');
});

test('dedicated operational text excludes private paths, credential-like tokens and unrelated engine books', () => {
  for (const [engine, id] of editions) {
    const guide = engineOperations(engine);
    const text = guide.sections.filter(section => section.id === id || section.id.startsWith(`${id}-`)).map(section => section.text).join('\n');
    assert.doesNotMatch(text, /\b[A-Z]{2}\d{6,}\b|sk-[A-Za-z0-9_-]{16,}|[A-Z]:[\\/]|\/(?:Users|home)\/[^/]+\//, engine);
    assert.doesNotMatch(text, /已保证全部游戏|保证所有游戏|全部引擎已通过/, engine);
  }
  assert.doesNotMatch(renderEngineOperations(engineOperations('MV')), /Unity 组件字段审阅|Godot 操作手册/);
  assert.doesNotMatch(renderEngineOperations(engineOperations('Godot')), /RGSS 归档与工作台|Unity 组件字段审阅/);
});
