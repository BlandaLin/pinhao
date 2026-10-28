// 质量规则分两层：validateTranslation 里的阻断规则永远只有 3 条（漏译/空/截断），因为它们是确定性错误；
// 其余一切质量问题只进本文件的报告层，永不参与流程判断。新增规则只能加在这里，不许加进阻断层。
//
// 本文件是纯数据层：无副作用、不写库、不抛异常、不读环境。确定性判定只有一处实现
// （contentFault），validateTranslation 只负责把它的结果转成 throw，两层因此不会各自漂移。

/** 保护标记、引擎控制符、占位符与空白：只在"原文还剩多少可译内容"的判断里剔除。 */
const MACHINERY = /\{\{[^{}]+\}\}|<[A-Za-z_$][\w$.-]*:\s*[+-]?\d+(?:\.\d+)?(?:\s*,\s*[+-]?\d+(?:\.\d+)?)*\s*>|\\[A-Za-z]+(?:\[[^\]\r\n]*\]|<[^>\r\n]*>)?|%[-+0-9.]*[dsf]|%[1-9]\d*|\s/g;
const LETTER = /\p{L}/u;
/** 短标签：半角或全角 ASCII、无空白、不超过 8 码点。菜单缩写与专名照抄是合理保留。 */
const LABEL = /^[\x21-\x7e\uFF01-\uFF5E]{1,8}$/;
const NUMERIC_LABEL = /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?[A-Z]{1,4}$/;

/** 阻断层规则条数：漏译 / 空 / 截断。这是结构约束，不是配置项。 */
export const BLOCKING_RULE_COUNT = 3;

/** 统计异常的最小样本量：少于此数时四分位不稳，报告层只给 hardIssues。 */
const MIN_SAMPLE = 4;

/** 按码点计长，避免中文按 UTF-16 双计。 */
export const codepoints = (value) => Array.from(typeof value === 'string' ? value : '').length;

/** 原文是否还有可翻译内容（剔除保护标记、引擎控制符、占位符、空白后仍含字母/假名/汉字）。 */
export function hasTranslatableContent(source) {
  return typeof source === 'string' && LETTER.test(source.replace(MACHINERY, ''));
}

/** 原文是否为短标签（ATK / ＹＥＳ / OK）：照抄不构成漏译，也不计入密度统计。 */
export const isLabelSource = (source) => typeof source === 'string' && (LABEL.test(source.trim()) || NUMERIC_LABEL.test(source.trim().normalize('NFKC')));

/**
 * 确定性三规则，两层共用。
 * @returns {{kind: 'empty'|'missing'|'truncated', detail: string} | null}
 * @param {object} unit 至少含 { id, source }；submitted=false 表示回读单元自身译文（种子化、完整性扫描），
 *   此时只判空，不判漏译与截断——状态回读不是一次翻译提交。
 */
export function contentFault(unit, translation, { submitted = true, targetLanguage = 'zh-Hans', allowUnchanged = false, truncated = false } = {}) {
  const source = typeof unit?.source === 'string' ? unit.source.trim() : '';
  const text = typeof translation === 'string' ? translation.trim() : '';
  if (source && !text) return { kind: 'empty', detail: '此显示字段需要文字' };
  if (!submitted || !source) return null;
  if (truncated) return { kind: 'truncated', detail: '本条文字接收尚未完整' };
  if (!hasTranslatableContent(source) || isLabelSource(source)) return null;
  const plain = source.replace(MACHINERY, '');
  const name = ['character_name', 'speaker_name', 'speaker', 'display_name'].includes(unit?.kind)
    || unit?.kind === 'database_name' && (/^Actors:/i.test(unit.legacyId ?? '') || /(?:^|[/\\])Actors\./i.test(unit.context?.file ?? ''));
  const retainedName = name && !/[\u3040-\u30ff]/u.test(plain) && /^[\p{L}\p{N}'’.-]+$/u.test(plain);
  const normalized = plain.normalize('NFKC');
  const codes = normalized.match(/[A-Za-z]+/g) ?? [];
  const chineseWithCodes = /\p{Script=Han}/u.test(normalized) && codes.every(code => /^[A-Z]{1,4}$/.test(code))
    && /^[\p{Script=Han}A-Z\p{N}\p{P}\p{S}]*$/u.test(normalized);
  const alreadyChinese = /^zh(?:-|$)/i.test(targetLanguage)
    && (/^[\p{Script=Han}\p{N}\p{P}\p{S}]*$/u.test(plain) || chineseWithCodes);
  if (text === source && !allowUnchanged && !retainedName && !alreadyChinese) return { kind: 'missing', detail: '译文与原文相同，疑似漏译' };
  return null;
}

const round = (value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null);

/** 线性插值分位数（与 Excel PERCENTILE / R 的 type 7 一致），排序后的数组入参。 */
const quantile = (sorted, p) => {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
};

const DONE = new Set(['translated', 'proofread']);
const TODO = new Set(['pending', 'skipped']);

/** 已译判定：状态优先；无状态时以"译文是否真的变了"为据（标签类原文除外）。 */
const isTranslated = (status, source, text) => {
  if (!text) return false;
  if (DONE.has(status)) return true;
  if (TODO.has(status)) return false;
  return !hasTranslatableContent(source) || text !== source.trim();
};

/**
 * 翻译质量报告。纯函数：只读入参、只返回数据，不阻断任何流程。
 *
 * 统计口径：对每条已译且原文有可译内容的单元算 ratio = 译文码点数 / 原文码点数，
 * 取全体的中位数与四分位，把 ratio < P25×0.5 或 ratio > P75×2.5 视为可疑。
 * 阈值全部来自本包自身分布：不同作品、不同语向的密度差异巨大，固定阈值必然误伤。
 *
 * @param {Array<{id: string, source: string, translation: string, status?: string}>} units
 * @param {{targetLanguage?: string}} [options]
 * @returns {{targetLanguage: string, total: number, translated: number, untranslated: number,
 *   hardIssues: Array<{id: string, kind: string, detail: string}>,
 *   suspicious: Array<{id: string, kind: string, ratio: number|null, detail: string}>,
 *   stats: object}}
 */
export function translationQuality(units, { targetLanguage = 'zh-Hans' } = {}) {
  const rows = Array.isArray(units) ? units : [];
  const hardIssues = [];
  const samples = [];
  let translated = 0;
  for (const [index, raw] of rows.entries()) {
    const unit = raw && typeof raw === 'object' ? raw : {};
    const id = typeof unit.id === 'string' ? unit.id : `#${index}`;
    const source = typeof unit.source === 'string' ? unit.source : '';
    const translation = typeof unit.translation === 'string' ? unit.translation : '';
    const fault = contentFault(unit, translation, { submitted: !TODO.has(unit.status), targetLanguage });
    if (fault) hardIssues.push({ id, kind: fault.kind, detail: fault.detail });
    if (!isTranslated(unit.status, source, translation.trim())) continue;
    translated += 1;
    if (!hasTranslatableContent(source) || isLabelSource(source)) continue;
    samples.push({ id, ratio: codepoints(translation.trim()) / codepoints(source.trim()) });
  }
  const ratios = samples.map((sample) => sample.ratio).sort((a, b) => a - b);
  const ratioP25 = quantile(ratios, 0.25);
  const ratioP75 = quantile(ratios, 0.75);
  const enough = ratios.length >= MIN_SAMPLE;
  const lowerBound = enough ? ratioP25 * 0.5 : null;
  const upperBound = enough ? ratioP75 * 2.5 : null;
  const suspicious = [];
  const flagged = new Set(hardIssues.map((issue) => issue.id));
  for (const { id, ratio } of samples) if (!flagged.has(id) && ratio < 0.15) {
    suspicious.push({ id, kind: 'ratio-low', ratio: round(ratio), detail: '译文长度明显偏短，请结合原文复核' }); flagged.add(id);
  }
  if (enough) {
    for (const { id, ratio } of samples) {
      if (flagged.has(id)) continue;
      if (ratio < lowerBound) suspicious.push({ id, kind: 'ratio-low', ratio: round(ratio), detail: `译文明显偏短：比例 ${round(ratio)}，本包下界 ${round(lowerBound)}` });
      else if (ratio > upperBound) suspicious.push({ id, kind: 'ratio-high', ratio: round(ratio), detail: `译文明显偏长：比例 ${round(ratio)}，本包上界 ${round(upperBound)}` });
    }
  }
  return {
    targetLanguage,
    total: rows.length,
    translated,
    untranslated: rows.length - translated,
    hardIssues,
    suspicious,
    stats: {
      sampleSize: ratios.length,
      ratioMin: round(ratios.at(0) ?? null),
      ratioP25: round(ratioP25),
      ratioMedian: round(quantile(ratios, 0.5)),
      ratioP75: round(ratioP75),
      ratioMax: round(ratios.at(-1) ?? null),
      lowerBound: round(lowerBound),
      upperBound: round(upperBound),
      minSample: MIN_SAMPLE,
      blockingRuleCount: BLOCKING_RULE_COUNT,
    },
  };
}
