import { contentFault } from '../exchange/quality.mjs';

// 成品完整度清单：把文字单元状态、引擎位置和术语使用情况整理成一份人能读的清单。
// 纯函数模块：不读文件、不访问数据库、无副作用。
// 位置数值一律原样输出（提取器记录的就是引擎数组下标或行号），不做 ±1 的猜测性换算。

const DONE_STATUSES = new Set(['translated', 'proofread']);
const MAX_BLOCKER_SAMPLES = 20;
const MAX_SECTION_NAMES = 10;
const SOURCE_CLIP = 28;
const VALUE_CLIP = 40;
const LABEL_WIDTH = 12;

/** 阻塞项固定顺序：越是「还有日文」越靠前。 */
const BLOCK_ORDER = ['untranslated', 'empty', 'identical', 'image-untouched', 'skipped', 'blank-source', 'open-issue'];
const BLOCK_LABELS = { untranslated: '未翻译', empty: '译文为空', identical: '疑似漏译', 'image-untouched': '图片未处理', skipped: '已跳过', 'blank-source': '原文为空', 'open-issue': '未解决错误' };
const VERDICTS = { complete: 'complete', mostly: 'mostly-complete', partial: 'partial', unfinished: 'unfinished' };

/** 引擎位置字段与中文说法，顺序即拼接顺序（由外到内：地图 → 事件 → 页 → 公共事件 …）。 */
const LOCATION_FIELDS = [['map', '地图'], ['event', '事件'], ['page', '事件页'], ['common_event', '公共事件'], ['troop', '敌群'],
  ['scene', '场景'], ['label', '标签'], ['node', '节点'], ['object', '对象'], ['record', '记录']];
/** 数据库字段名的中文说法；未收录的字段按原字段名输出。 */
const FIELD_LABELS = { name: '名称', displayName: '显示名', nickname: '昵称', title: '标题', description: '说明', message: '消息', notes: '备注', note: '备注', profile: '简介', terms: '说明' };
const PLACEHOLDER_SPEAKER = /^(?:unknown|none|null|undefined)$/i;
// 与 glossary.mjs 的 termOffsets 同一边界规则，用于判断「译文中是否出现过该译名」。
const LATIN_WORD = /[A-Za-z0-9_]/u;
const KATAKANA = /[\u30a1-\u30fa\u30fc\u30fd-\u30ff]/u;

const text = value => typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
const clip = (value, max) => {
  const flat = text(value).replace(/\s+/gu, ' ').trim();
  return [...flat].length > max ? `${[...flat].slice(0, max - 1).join('')}…` : flat;
};
const statusOf = unit => text(unit?.status);
const kindOf = (unit, fallback = 'text') => { const kind = text(unit?.kind).trim(); return kind || fallback; };

function cleanPath(value) {
  return text(value).replace(/^res:\/\//u, '').replaceAll('\\', '/').replace(/^\.\//u, '').trim();
}

/** 位置字段可能缺失、可能是对象（如 region）；只接受可读标量。 */
function scalarLocation(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'string') return clip(value, VALUE_CLIP);
  return '';
}

/** 图片区域：images 包写入的是 { left, top, width, height }，也容忍 { x, y } 与 [x, y, w, h]。 */
function regionLocation(region) {
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  if (Array.isArray(region) && region.length === 4 && region.every(finite)) return `区域 ${region[0]},${region[1]} ${region[2]}×${region[3]}`;
  if (region && typeof region === 'object') {
    const left = region.left ?? region.x, top = region.top ?? region.y;
    if ([left, top, region.width, region.height].every(finite)) return `区域 ${left},${top} ${region.width}×${region.height}`;
  }
  return '';
}

/**
 * 人类可读位置：`data/CommonEvents.json · 事件 9 · 第 3 行`。
 * 缺字段就跳过该段；整条 context 为空时降级为单元编号，绝不输出 JSON pointer 这类技术定位。
 */
export function unitWhere(unit) {
  const context = unit?.context && typeof unit.context === 'object' && !Array.isArray(unit.context) ? unit.context : {};
  const parts = [];
  const file = cleanPath(context.file ?? unit?.file);
  if (file) parts.push(file);
  for (const [key, label] of LOCATION_FIELDS) {
    const value = scalarLocation(context[key]);
    // 地图名常与文件名重复（data/Map001.json + 地图 Map001），文件已在首位时不再重复。
    if (!value || (file && typeof context[key] === 'string' && file.includes(value))) continue;
    parts.push(`${label} ${value}`);
  }
  const field = cleanPath(context.field);
  if (field) parts.push(FIELD_LABELS[field] ?? `字段 ${clip(field, VALUE_CLIP)}`);
  const command = scalarLocation(context.command);
  if (command) parts.push(`命令 ${command}`);
  const line = scalarLocation(context.line);
  if (line) parts.push(`第 ${line} 行`);
  const region = regionLocation(context.region);
  if (region) parts.push(region);
  const speaker = clip(context.speaker, VALUE_CLIP);
  if (speaker && !PLACEHOLDER_SPEAKER.test(speaker)) parts.push(`说话人：${speaker}`);
  if (!parts.length) parts.push(text(unit?.id).trim() ? `编号 ${clip(unit.id, VALUE_CLIP)}` : '未标注位置');
  return parts.join(' · ');
}

/**
 * 每个单元只归入一类阻塞项（先命中先算），所以 blockers 的 count 之和等于「有问题条目数」。
 * 顺带说明：`identical` 与 `image-untouched` 也会命中有译文状态的条目，
 * 因此 blockers 的合计不一定等于 summary.untranslated，两者统计对象不同。
 */
function classify(unit, targetLanguage) {
  const source = text(unit?.source), translation = text(unit?.translation);
  const sourceText = source.trim(), translationText = translation.trim();
  const kind = kindOf(unit), status = statusOf(unit), done = DONE_STATUSES.has(status);
  if (status === 'skipped') return { blocker: 'skipped', kind, source };
  if (done && !sourceText) return { blocker: 'blank-source', kind, source };
  const missing = done && contentFault(unit, translation, { submitted: true, targetLanguage })?.kind === 'missing';
  if (kind === 'image_text' && missing) return { blocker: 'image-untouched', kind, source };
  if (!translationText) return { blocker: 'empty', kind, source };
  if (!done) return { blocker: 'untranslated', kind, source };
  if (missing) return { blocker: 'identical', kind, source };
  return { blocker: undefined, kind, source };
}

const percent = (done, total) => total ? Math.round(done / total * 1000) / 10 : 0;

function verdictOf(completeness) {
  if (completeness >= 100) return VERDICTS.complete;
  if (completeness >= 95) return VERDICTS.mostly;
  if (completeness >= 50) return VERDICTS.partial;
  return VERDICTS.unfinished;
}

/** 与 glossary.mjs 的 text() 同义：去掉保护标记并按 NFKC 归一，用于术语检索。 */
const searchable = value => text(value).replace(/\{\{LINE\d+\}\}/gu, '\n').replace(/\{\{[^}]+\}\}/gu, ' ').normalize('NFKC');

function termVisible(haystack, term) {
  if (!term || !haystack) return false;
  for (let offset = haystack.indexOf(term); offset >= 0; offset = haystack.indexOf(term, offset + 1)) {
    const before = haystack[offset - 1] ?? '', after = haystack[offset + term.length] ?? '';
    if ((LATIN_WORD.test(term[0]) && LATIN_WORD.test(before)) || (LATIN_WORD.test(term.at(-1)) && LATIN_WORD.test(after))) continue;
    if ((KATAKANA.test(term[0]) && KATAKANA.test(before)) || (KATAKANA.test(term.at(-1)) && KATAKANA.test(after))) continue;
    return true;
  }
  return false;
}

/**
 * 术语使用情况：只统计「真的换了文字」的条目（已译、非空、与原文字面不同），
 * 否则未译条目「译文等于原文」会让术语凭空算作出现过。
 * 一次都没出现的译名写进 missing，措辞只说明「未出现」——不能据此断定没遵守术语表。
 */
function glossaryUsageOf(glossary, units) {
  const entries = Array.isArray(glossary) ? glossary.filter(entry => entry && typeof entry === 'object') : [];
  const haystack = searchable(units
    .filter(unit => DONE_STATUSES.has(statusOf(unit)) && text(unit.translation).trim() && text(unit.translation).trim() !== text(unit.source).trim())
    .map(unit => unit.translation).join('\n'));
  const seen = new Map();
  const missing = [];
  for (const entry of entries) {
    const source = text(entry.source), translation = text(entry.translation).trim();
    if (!translation) { missing.push({ source, translation, category: text(entry.category) }); continue; }
    if (!seen.has(translation)) seen.set(translation, termVisible(haystack, searchable(translation)));
    if (!seen.get(translation)) missing.push({ source, translation, category: text(entry.category) });
  }
  return { entries: entries.length, missing };
}

/** 未解决的 error 级问题记录：这类问题本身就属于「不能发布」。 */
function openIssueBlocker(issues, units) {
  const open = (Array.isArray(issues) ? issues : []).filter(issue => issue && !issue.resolvedAt && issue.severity === 'error');
  if (!open.length) return undefined;
  const byId = new Map(units.map(unit => [unit.id, unit]));
  return {
    kind: 'open-issue',
    count: open.length,
    samples: open.slice(0, MAX_BLOCKER_SAMPLES).map(issue => {
      const unit = issue.unitId ? byId.get(issue.unitId) : undefined;
      return { id: text(issue.id), source: clip(issue.message, SOURCE_CLIP * 2), where: unit ? unitWhere(unit) : `问题记录 · ${clip(issue.category, VALUE_CLIP) || '未分类'}` };
    }),
  };
}

/**
 * 生成成品完整度清单。
 * @param {Array<{id: string, kind: string, source: string, translation: string, status?: string, context?: object}>} units
 * @param {{glossary?: Array, issues?: Array, builds?: Array}} options
 */
export function buildCompletionReport(units, { glossary = [], issues = [], builds = [], targetLanguage = 'zh-Hans' } = {}) {
  const list = (Array.isArray(units) ? units : []).filter(unit => unit && typeof unit === 'object');
  const translated = list.filter(unit => DONE_STATUSES.has(statusOf(unit))).length;
  const skipped = list.filter(unit => statusOf(unit) === 'skipped').length;
  const total = list.length;
  const completeness = percent(translated, total);

  const buckets = new Map();
  const sections = new Map();
  for (const unit of list) {
    const { blocker, kind, source } = classify(unit, targetLanguage);
    if (blocker) {
      const bucket = buckets.get(blocker) ?? { kind: blocker, count: 0, samples: [] };
      bucket.count += 1;
      if (bucket.samples.length < MAX_BLOCKER_SAMPLES) bucket.samples.push({ id: text(unit.id), source: clip(source, SOURCE_CLIP), where: unitWhere(unit) });
      buckets.set(blocker, bucket);
    }
    const section = sections.get(kind) ?? { kind, total: 0, untranslated: 0, names: [] };
    section.total += 1;
    if (!DONE_STATUSES.has(statusOf(unit)) && statusOf(unit) !== 'skipped') {
      section.untranslated += 1;
      if (section.names.length < MAX_SECTION_NAMES) section.names.push(unitWhere(unit));
    }
    sections.set(kind, section);
  }

  const blockers = BLOCK_ORDER.filter(kind => buckets.has(kind)).map(kind => buckets.get(kind));
  const issueBlocker = openIssueBlocker(issues, list);
  if (issueBlocker) blockers.push(issueBlocker);

  const latest = (Array.isArray(builds) ? builds : []).filter(build => build && typeof build === 'object').at(-1);

  return {
    summary: { total, translated, untranslated: total - translated - skipped, skipped, completeness, verdict: verdictOf(completeness) },
    blockers,
    sections: [...sections.values()].sort((left, right) => right.untranslated - left.untranslated || right.total - left.total || left.kind.localeCompare(right.kind)),
    glossaryUsage: glossaryUsageOf(glossary, list),
    latestBuild: latest ? { id: text(latest.id), createdAt: text(latest.createdAt), runtimeVerified: Boolean(latest.runtimeVerified), outputModified: Boolean(latest.outputModified),
      checks: (latest.checks ?? []).map(({ name, status, detail }) => ({ name, status, detail })) } : null,
  };
}

const groupDigits = (value) => {
  const number = Math.trunc(Number(value) || 0);
  return String(number).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
};
const displayWidth = value => [...text(value)].reduce((sum, character) => sum + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(character) ? 2 : 1), 0);
const padLabel = (label, target = LABEL_WIDTH) => label + ' '.repeat(Math.max(0, target - displayWidth(label)));

/** 分行的人读文本，直接贴进终端或对话即可。 */
export function completionReportText(report) {
  const summary = report?.summary ?? {};
  const total = summary.total ?? 0;
  const lines = [`已提取文字完整度 ${(Number(summary.completeness) || 0).toFixed(1)}%（${summary.verdict ?? VERDICTS.unfinished}）`];
  lines.push(`  已译 ${groupDigits(summary.translated)} / ${groupDigits(total)} · 未译 ${groupDigits(summary.untranslated)}${summary.skipped ? ` · 已跳过 ${groupDigits(summary.skipped)}` : ''}`);
  if (!total) lines.push('  未发现文字单元，请先完成文字提取');
  const blockers = (Array.isArray(report?.blockers) ? report.blockers : []).filter(blocker => (blocker?.count ?? 0) > 0);
  if (!blockers.length) lines.push(total ? '已提取的文字条目检查完成' : '文字检查：等待提取');
  else {
    lines.push('阻塞项：');
    for (const blocker of blockers) {
      const label = BLOCK_LABELS[blocker.kind] ?? text(blocker.kind);
      const sample = blocker.samples?.[0];
      const tail = sample ? `  例：${sample.where}${sample.source ? ` 「${sample.source}」` : ''}` : '';
      lines.push(`  ${padLabel(label)}${groupDigits(blocker.count)} 条${tail}`);
    }
  }
  const usage = report?.glossaryUsage ?? { entries: 0, missing: [] };
  const entries = usage.entries ?? 0, missing = usage.missing?.length ?? 0;
  if (!entries) lines.push('术语表：无');
  else if (!missing) lines.push(`术语表：${groupDigits(entries)} 条，均在译文中出现过`);
  else lines.push(`术语表：${groupDigits(entries)} 条，其中 ${groupDigits(missing)} 条在译文中未出现`);
  const build = report?.latestBuild;
  if (!build) lines.push('成品检查：生成独立成品后继续检查');
  else {
    if (build.outputModified) lines.push('成品文件已有变动，请重新核验');
    lines.push(build.runtimeVerified ? '实机游玩验证：已通过' : '实机游玩验证：待完成');
    for (const check of build.checks ?? []) if (check.status !== 'passed') lines.push(`${check.name}：${check.detail || '待检查'}`);
  }
  return lines.join('\n');
}
