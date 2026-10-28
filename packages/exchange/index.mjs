import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { buildStoryContext, compactStoryUnits, STORY_SCHEMA, storyReadingMarkdown } from './story.mjs';
import { contentFault } from './quality.mjs';

export const FORMAT = 'pinhao-text-package';
export const VERSION = '0.2';
export const sha256 = (value) => createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value)).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
// 工作包按 UTF-8 严格解码：记事本存成 GBK 时必须报错，而不是静默变成 U+FFFD 乱码入库；
// BOM 在解析前清除，否则"另存为 UTF-8"的包会让 JSON.parse 抛出看不懂的 token 错误。
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const readUtf8 = async (file, label) => {
  const bytes = await readFile(file);
  let text;
  try { text = utf8Strict.decode(bytes); }
  catch { throw new Error(`${label} 不是 UTF-8 编码，请用 UTF-8 保存后重试`); }
  return text.replace(/^\uFEFF/, '');
};
const permitted = new Set(['id', 'translation', 'notes', 'intent']);
const intents = new Set(['submit', 'keep', 'pending', 'clear']);
const tokenPattern = /\{\{[^{}]+\}\}/g;

export function validateTranslation(unit, translation, { submitted = false, targetLanguage, allowUnchanged = false, truncated = false } = {}) {
  if (typeof translation !== 'string') throw new Error(`译文必须是文字：${unit.id}`);
  if (translation.length > 200000) throw new Error(`译文过长：${unit.id}`);
  // 阻断规则只有 3 条：空 / 漏译 / 截断，判定实现唯一，位于 quality.mjs 的 contentFault。
  // 回读单元自身译文（种子化、完整性扫描）不算一次提交，只判空。
  const fault = contentFault(unit, translation, { submitted, targetLanguage, allowUnchanged, truncated });
  if (fault) throw new Error(`${fault.detail}：${unit.id}`);
  const tokens = translation.match(tokenPattern) ?? [];
  if (JSON.stringify(tokens) !== JSON.stringify(unit.tokens ?? [])) throw new Error(`保护标记数量或顺序改变：${unit.id}`);
  if (/\{\{|\}\}/.test(translation.replace(tokenPattern, ''))) throw new Error(`保护标记格式错误：${unit.id}`);
  if (unit.context?.protectedControlSyntax === 'rpgmaker-v1') {
    const plain = translation.replace(tokenPattern, '');
    if (/\\(?:[A-Za-z]+(?:\[(?:[^\[\]\r\n]|\[[^\]\r\n]*\])*\]|<[^>\r\n]*>)?|[^\r\n])|%[-+0-9.]*[dsf]|%[1-9]\d*|[\x00-\x1f]/.test(plain)) throw new Error(`请使用已有保护标记表示换行或引擎控制符：${unit.id}`);
  }
}

export function threeWay(baseline, current, returned) {
  if (returned === current || returned === baseline) return { value: current, changed: false };
  if (current === baseline) return { value: returned, changed: true };
  return { conflict: true, baseline, current, returned };
}

export function encodeText(records) {
  return '# PINHAO-TEXT 0.2; values are JSON strings\n\n' + records.map((r) =>
    `ID=${JSON.stringify(r.id)}\nTEXT=${JSON.stringify(r.translation)}\nNOTE=${JSON.stringify(r.notes ?? '')}\nINTENT=${JSON.stringify(r.intent ?? 'submit')}\n`,
  ).join('\n');
}

export function decodeText(text) {
  const records = [];
  let current;
  const mapping = { ID: 'id', TEXT: 'translation', NOTE: 'notes', INTENT: 'intent' };
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || line.startsWith('#')) continue;
    const match = /^(ID|TEXT|NOTE|INTENT)=(.*)$/s.exec(line);
    if (!match) throw new Error(`纯文字工作表第 ${index + 1} 行格式错误`);
    const [, key, value] = match;
    if (key === 'ID') {
      if (current) records.push(current);
      current = {};
    }
    if (!current || Object.hasOwn(current, mapping[key])) throw new Error(`纯文字工作表第 ${index + 1} 行重复或缺少 ID`);
    try { current[mapping[key]] = JSON.parse(value); }
    catch { throw new Error(`纯文字工作表第 ${index + 1} 行须使用 JSON 字符串编码`); }
  }
  if (current) records.push(current);
  return records;
}

// Engine contexts contain useful relative locators. Machine paths and credentials stay local.
export function portable(value) {
  if (typeof value === 'string') {
    if (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(value)) return '[local-path]';
    return value.replace(/\b[a-z]:[\\/][^"'\r\n<>|]*/ig, '[local-path]').replace(/\\\\[^\s\\]+\\[^"'\r\n<>|]*/g, '[local-path]');
  }
  if (Array.isArray(value)) return value.map(portable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !/api.?key|secret|password|access.?token/i.test(k)).map(([k, v]) => [k, portable(v)]));
}

const syncOf = unit => unit.syncGroup ?? unit.context?.syncGroup ?? unit.context?.sync_group;

export async function writePackage(directory, { project, units, targetUnitIds, profile = 'json', issues = [], glossary = [], extensions = {}, additionalFiles = {}, stage = 'translation' }) {
  if (!['json', 'text'].includes(profile)) throw new Error('未知的文字编辑模式');
  if (!['translation', 'proofreading'].includes(stage)) throw new Error('文字工作包需要明确的初翻或校对阶段');
  const byId = new Map(units.map(unit => [unit.id, unit]));
  if (byId.size !== units.length) throw new Error('文字工作包源文包含重复 ID');
  const requested = targetUnitIds ?? units.map(unit => unit.id);
  if (!Array.isArray(requested) || new Set(requested).size !== requested.length || requested.some(id => typeof id !== 'string' || !byId.has(id))) throw new Error('文字工作包目标包含重复或未知 ID');
  const selected = new Set(requested), groups = new Set(requested.map(id => syncOf(byId.get(id))).filter(value => value !== undefined));
  for (const unit of units) if (groups.has(syncOf(unit))) selected.add(unit.id);
  const allUnits = compactStoryUnits(units);
  units = allUnits.filter(unit => selected.has(unit.id));
  const references = allUnits.filter(unit => !selected.has(unit.id));
  await mkdir(directory, { recursive: true });
  const files = {};
  const put = async (name, value, mutable = false) => {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    const content = typeof value === 'string' ? value : json(value);
    await writeFile(path.join(directory, name), content, 'utf8');
    files[name] = { sha256: sha256(content), mutable };
  };
  const source = units.map(({ id, legacyId, kind, source, tokens, context, sourceHash }) => ({ id, legacyId, kind, source, tokens, context: portable(context), sourceHash }));
  const baseline = units.map(({ id, translation, notes, revision }) => ({ id, translation, notes, revision }));
  const editable = units.map(({ id, translation, notes }) => ({ id, translation, notes, intent: 'submit' }));
  await put('source/units.json', source);
  await put('baseline/units.json', baseline);
  await put('context/scenes.json', allUnits.map((unit, index) => ({ id: unit.id, order: index, context: portable(unit.context), provenance: 'engine-extracted' })));
  await put('context/reference-units.json', portable(references));
  const editPath = profile === 'json' ? 'editable/units.json' : 'editable/units.txt';
  await put(editPath, profile === 'json' ? editable : encodeText(editable), true);
  await put('issues.json', portable(issues));
  await put('glossary.json', portable(glossary));
  await put('style-guide.md', '# 文字约定\n\n准确传达原意，统一人名和术语，结合场景与说话人校对。保护标记保持原样。\n');
  const story = buildStoryContext(allUnits, { sourceRevision: project.sourceFingerprint });
  const storyContent = json(portable(story));
  await put('reading/scenes.md', storyReadingMarkdown(story, allUnits));
  const stageInstruction = stage === 'translation'
    ? '本轮只交付初翻，不宣称已完成校对；准确传达原文，保留疑点，后续校对单独安排。'
    : '本轮逐条校对当前目标，保留准确自然的现译，集中修正误译、漏译、称谓和口吻；submit 是外部已审阅声明，不是软件的独立质量证明。';
  await put('START_HERE.md', `# 拼好汉化文字工作包\n\n目标语言：${project.targetLanguage ?? 'zh-Hans'}\n本次阶段：${stage}\n目标范围：manifest.unitIds 中的 ${units.length} 项目标（已包含关联显示组），其他文字仅供只读参考\n目标条数：${units.length}\n只读参考条数：${references.length}\n\n## 阅读与职责\n\n先按目标 ID 定位 reading/scenes.md 的相关完整位置块和分支，再按 reading/characters.md 查看人物出场与依据；不要求无差别处理全项目。context/story.json 提供稳定范围、关联和材料版本，context/scenes.json 保留全项目逐条引擎位置。context/reference-units.json 和阅读视图中的非目标文字仅供参考，不得作为修改目标。跨位置剧情关系未确定时保持 unknown，结合实际证据判断。现有译文位于 baseline 与阅读材料，已确认译名位于 glossary.json。\n\n${stageInstruction}\n\n## 分工与统一收尾\n\n外部主 Agent 可以按完整场景分派子代理；每个目标 ID 由一名负责人修改，syncGroup 整组归同一负责人。公共事件使用同一组真实 ID，调用者共享阅读材料，由统一负责人汇总回写。长场景可以分页阅读，保留完整相关材料与证据入口后收束结论。\n\n已确认术语统一使用；未决术语由主 Agent 建立临时工作表并协调译名。临时工作表用于外部分工，原包 glossary.json 保持原样，最终译名落实到允许编辑的文字与备注。外部处理和回导可独立完成，无需配置本软件 API。\n\n## 填写与交付\n\n修改 ${editPath}，只填写 translation、notes、intent；ID、源文、baseline 和只读上下文保持原样。纯文字模式的 TEXT、NOTE 等值使用 JSON 字符串，例如 TEXT="第一行\\n第二行"。\n\nintent：submit 提交本阶段结果，keep 保留导出时的文字，pending 待确认且保留现译，clear 主动清空（须符合引擎字段规则）。不确定的人称、身份和语义写入 notes 并标 pending。只改备注不表示完成校对。\n\n主 Agent 汇总检查本轮目标覆盖、遗漏、名字/口吻、控制符、syncGroup、冲突和待查项；保留全部目标记录及保护标记，不能省略未改目标来暗示已审阅。交回完整目录并重新压缩为 ZIP。软件按 baseline、工程当前值和返回值三方合并，双方改文冲突会保留供处理。\n`);
  const supplemental = { ...additionalFiles, 'context/story.json': storyContent,
    'reading/characters.md': storyReadingMarkdown(story, allUnits, 'character') };
  for (const [name, content] of Object.entries(supplemental)) {
    if (Object.hasOwn(files, name) || name === 'manifest.json' || name.includes('\\') || path.isAbsolute(name) || name.split('/').some((part) => !part || part === '..') || /^[a-z]:/i.test(name)) throw new Error('扩展材料路径无效或与核心内容重叠');
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), content);
    files[name] = { sha256: sha256(content), mutable: false };
  }
  const manifest = { format: FORMAT, version: VERSION, packageId: randomUUID(), projectId: project.id, sourceRevision: project.sourceFingerprint, targetLanguage: project.targetLanguage ?? 'zh-Hans', profile, editable: editPath, mode: 'complete', taskStage: stage, unitIds: units.map((u) => u.id), referenceUnitIds: references.map(unit => unit.id), requiredCapabilities: ['three-way-merge', `editable-${profile}`, 'scoped-targets', 'task-stage'], extensions: portable({ ...extensions,
    'pinhao.story': { path: 'context/story.json', schema: STORY_SCHEMA, builderVersion: story.builderVersion, version: story.version } }), files };
  await writeFile(path.join(directory, 'manifest.json'), json(manifest), 'utf8');
  return manifest;
}

async function allFiles(directory, prefix = '') {
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`工作包包含符号链接：${name}`);
    if (entry.isDirectory()) result.push(...await allFiles(directory, name));
    else result.push(name);
  }
  return result;
}

export async function readPackage(directory, { project, units }) {
  let root = directory;
  const members = await allFiles(directory);
  if (!members.includes('manifest.json')) {
    const manifests = members.filter((p) => p.endsWith('/manifest.json'));
    if (manifests.length !== 1) throw new Error('工作包需要唯一的 manifest.json');
    root = path.join(directory, path.dirname(manifests[0]));
  }
  const manifest = JSON.parse(await readUtf8(path.join(root, 'manifest.json'), 'manifest.json'));
  if (manifest.format !== FORMAT || !['0.1', VERSION].includes(manifest.version)) throw new Error('不支持的文字工作包格式或版本');
  const taskStage = manifest.version === '0.1' ? 'unknown' : manifest.taskStage;
  if (manifest.version === VERSION && !['translation', 'proofreading'].includes(taskStage)) throw new Error('文字工作包任务阶段无效');
  if (manifest.projectId !== project.id || manifest.sourceRevision !== project.sourceFingerprint) throw new Error('工作包项目或源文版本不匹配');
  if (manifest.targetLanguage !== (project.targetLanguage ?? 'zh-Hans')) throw new Error('工作包目标语言与当前工程不匹配');
  const capabilities = new Set(['three-way-merge', 'editable-json', 'editable-text', 'scoped-targets', 'task-stage']);
  if ((manifest.requiredCapabilities ?? []).some((v) => !capabilities.has(v))) throw new Error('工作包要求尚未支持的能力');
  if (!['json', 'text'].includes(manifest.profile) || manifest.mode !== 'complete') throw new Error('当前需要完整的 JSON 或纯文字回包');
  const expectedEdit = manifest.profile === 'json' ? 'editable/units.json' : 'editable/units.txt';
  if (manifest.editable !== expectedEdit) throw new Error('工作包填写入口不匹配');
  for (const [name, info] of Object.entries(manifest.files ?? {})) {
    if (name.includes('\\') || name.split('/').some((p) => p === '..' || !p) || path.isAbsolute(name) || /^[a-z]:/i.test(name)) throw new Error('工作包路径非法');
    const data = await readFile(path.join(root, name));
    if (name !== expectedEdit && info.mutable) throw new Error(`工作包只读字段被声明为可编辑：${name}`);
    if (!info.mutable && sha256(data) !== info.sha256) throw new Error(`只读材料已改变：${name}`);
  }
  for (const required of ['source/units.json', 'baseline/units.json', 'context/scenes.json', expectedEdit]) if (!manifest.files?.[required]) throw new Error(`工作包缺少材料：${required}`);
  const source = JSON.parse(await readUtf8(path.join(root, 'source/units.json'), 'source/units.json'));
  const baseline = JSON.parse(await readUtf8(path.join(root, 'baseline/units.json'), 'baseline/units.json'));
  const editableData = await readUtf8(path.join(root, expectedEdit), expectedEdit);
  const records = manifest.profile === 'json' ? JSON.parse(editableData) : decodeText(editableData);
  if (![source, baseline, records, manifest.unitIds].every(Array.isArray)) throw new Error('工作包数据必须为记录清单');
  const index = (items, label) => {
    const out = new Map();
    for (const row of items) {
      if (!row || typeof row.id !== 'string' || out.has(row.id)) throw new Error(`${label} 包含重复或无效 ID`);
      out.set(row.id, row);
    }
    return out;
  };
  const current = index(units, '工程');
  const sources = index(source, 'source');
  const bases = index(baseline, 'baseline');
  const edits = index(records, 'editable');
  if (new Set(manifest.unitIds).size !== manifest.unitIds.length) throw new Error('manifest 包含重复 ID');
  if ([sources, bases, edits].some((m) => m.size !== manifest.unitIds.length)) throw new Error('完整回包的记录数量不匹配');
  if (manifest.version === VERSION) {
    if (!manifest.files?.['context/reference-units.json']) throw new Error('工作包缺少只读参考文字');
    const rows = JSON.parse(await readUtf8(path.join(root, 'context/reference-units.json'), 'context/reference-units.json'));
    if (!Array.isArray(rows) || !Array.isArray(manifest.referenceUnitIds)) throw new Error('工作包只读参考必须为记录清单');
    const references = index(rows, 'reference'), ids = new Set(manifest.unitIds);
    if (new Set(manifest.referenceUnitIds).size !== manifest.referenceUnitIds.length || references.size !== manifest.referenceUnitIds.length) throw new Error('工作包只读参考 ID 重复或数量不匹配');
    for (const id of manifest.referenceUnitIds) {
      const reference = references.get(id), unit = current.get(id);
      if (ids.has(id) || !reference || !unit) throw new Error(`工作包目标与只读参考重叠或未知：${id}`);
      if (reference.sourceHash !== unit.sourceHash || reference.source !== unit.source || JSON.stringify(reference.tokens) !== JSON.stringify(unit.tokens)) throw new Error(`只读参考源文身份不匹配：${id}`);
    }
    const linked = new Set(manifest.unitIds.map(id => current.get(id)).filter(Boolean).map(syncOf).filter(value => value !== undefined));
    if (units.some(unit => linked.has(syncOf(unit)) && !ids.has(unit.id))) throw new Error('工作包目标缺少关联显示组成员');
  }
  const prepared = [];
  for (const id of manifest.unitIds) {
    const unit = current.get(id), s = sources.get(id), b = bases.get(id), r = edits.get(id);
    if (!unit || !s || !b || !r) throw new Error(`未知或缺失 ID：${id}`);
    if (s.sourceHash !== unit.sourceHash || s.source !== unit.source || JSON.stringify(s.tokens) !== JSON.stringify(unit.tokens)) throw new Error(`源文身份不匹配：${id}`);
    if (Object.keys(r).some((k) => !permitted.has(k))) throw new Error(`填写区包含未允许字段：${id}`);
    if (typeof r.translation !== 'string' || typeof r.notes !== 'string' || !intents.has(r.intent)) throw new Error(`填写区字段或意图无效：${id}`);
    if (!Number.isInteger(b.revision) || typeof b.translation !== 'string' || typeof b.notes !== 'string') throw new Error(`基础版本格式错误：${id}`);
    const returned = r.intent === 'keep' || r.intent === 'pending' ? b.translation : r.intent === 'clear' ? '' : r.translation;
    // 与导出基线相同的译文不是一次新提交：三方合并不会改动任何文字，按"回读自身译文"处理，只判空。
    // 这样未改动的种子译文不会被漏译/截断误杀；baseline 由服务端修订库逐条校验，不能伪造。
    validateTranslation(unit, returned, { submitted: r.intent === 'submit' && returned !== b.translation,
      targetLanguage: manifest.targetLanguage });
    prepared.push({ unit, baseline: b, returned, notes: r.notes, intent: r.intent });
  }
  const coreFiles = new Set(['START_HERE.md', 'source/units.json', 'baseline/units.json', 'context/scenes.json', 'context/story.json', 'context/reference-units.json', 'editable/units.json', 'editable/units.txt', 'issues.json', 'glossary.json', 'style-guide.md', 'reading/scenes.md', 'reading/characters.md']);
  const supplementalFiles = Object.keys(manifest.files).filter((name) => !coreFiles.has(name));
  return { manifest, prepared, root, supplementalFiles, taskStage, contextStatus: manifest.files['context/story.json'] ? 'story-materials' : 'engine-position-only' };
}
