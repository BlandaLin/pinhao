import { createHash } from 'node:crypto';

/**
 * 项目级教训库 —— 跨作业共享的「结论」层，不是对话记忆。
 *
 * 为什么需要这一层：技术适配把一个项目拆成几十个作业并行跑，每个作业一个独立状态文件
 * （adaptation-pool.mjs 里 jobs/<id>/progress.jsonl），42 个作业就是 42 条互不相通的记忆。
 * 同一个工具参数错误被 40 个作业各犯一次，每次都烧掉一整个模型步——失败没有沉淀成学习。
 *
 * 为什么不能把 42 份 state 合成一份：state.conversation 是「24 组 / 200K 字符」的对话窗口，
 * 合并之后互相冲掉，连单个作业的近期上下文都保不住。所以要共享的是提炼后的结论：几十行，
 * 确定性、可复用、可直接执行，而不是 200K 的对话历史。
 *
 * 分工（不要混）：
 * - 对话记忆：adaptation.mjs 的 rememberStep / state.conversation，作用域是单个作业，负责「刚才做过什么」。
 * - 结论记忆：本模块的 Lesson，作用域是整个项目，负责「这个项目里什么是真的」。
 * 本模块不读写任何文件、不 import 适配流程的任何模块，读写与注入 prompt 都由调用方决定。
 *
 * 提炼原则：只记录被验证过的确定事实（主机拒绝了这个参数、这个类的字段数就是 0、这个资源就是这么多对象），
 * 不记录猜测（模型觉得自己应该怎么做）、不记录一次性状态（这次超时了）、不把 jobId/时间戳写进 fact。
 *
 * 证据级别 factLevel（决定同一个 id 的新说法能不能推翻旧说法）：
 * - direct：错误文本或工具输出直接点名了事实主体与内容（「不认识参数 --offset；可用的是 …」、
 *   「未注册的工具 native_xxx」、工具回报的 fieldCount=0、预筛回报的 units=0）。
 * - inferred：内容正确但由多个信号推出来（整句拒绝 + 调用记录里有 offset；verified + texts=0）。
 * 覆盖规则（缺了它，教训库会永久冻结在第 1 次——也就是最模糊——的表述上，41 次验证反而让它更权威地错着）：
 *   direct   覆盖 inferred   允许（精确度提升，confidence 提到 max(当前, 0.85)）
 *   direct   覆盖 direct     允许，但只在 fact 文本确实不同时（避免同级别来回抖动）
 *   inferred 覆盖 direct     禁止
 *   inferred 覆盖 inferred   禁止（保持首次表述）
 * 覆盖时旧 fact 追加进 evidence，留下「曾经这么认为」的痕迹，不做静默改写。
 */

export const LESSON_KINDS = Object.freeze(['tool-arg', 'tool-name', 'class-no-text', 'resource-shape', 'prefilter', 'other']);

// 证据级别只用于「新说法能不能推翻旧说法」和同分时的排序，不进入 prompt。
export const FACT_LEVELS = Object.freeze(['inferred', 'direct']);
const LEVEL_RANK = new Map(FACT_LEVELS.map((level, index) => [level, index]));
const levelOf = value => (LEVEL_RANK.has(value) ? value : 'inferred');

export const LESSON_DEFAULTS = Object.freeze({
  max: 40,
  maxCharacters: 1200,
  confidence: 0.5,
  gain: 0.15,
  ceiling: 0.95,
  // direct 事实的置信度下限：它来自点名证据，不该和「推断」共用 0.5 的起点。
  directConfidence: 0.85,
  protectedConfidence: 0.8,
  evidence: 3,
  evidenceCharacters: 200,
  subjectCharacters: 80,
  factCharacters: 200,
  // 30 天没被复用、且只出现过 1 次的结论算陈旧：它可能描述的是一个已经修掉的坑。
  staleAfterMs: 30 * 24 * 60 * 60 * 1000,
  staleHits: 2,
});

const HEADER = '已核对事实（按当前资源版本复用）：';
const NATIVE_REVIEW_PROTOCOL_FACT = 'native_review_decide用native_review的groupRef，displaySites用同字段siteRef；主机绑定快照，不填写groupId/evidenceHash。record_coverage_decisions用unknownClusters或expressionCandidates的id/evidenceHash，需读取来源。evidenceId读工件。';
const KIND_ORDER = new Map(LESSON_KINDS.map((kind, index) => [kind, index]));
// 只把「分页类」参数单独识别出来：主机只回一句「请使用已注册的可信工具及参数」时，
// 我们不敢断言哪个参数被拒，但可以准确说出「被拒的那次调用里带了分页参数」。
const PAGING = new Set(['--offset', '--limit', '--page', '--pagesize', '--skip', '--start', '--take', '--count']);
const FLAG = /--[a-z][a-z0-9-]{0,40}/gi;
const PAGING_TOKEN = /(?:offset|limit|page|pagesize|skip|start|take|count)/gi;

/* ------------------------------------------------------------------ 基础工具 */

const asText = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const clip = (value, limit) => (value.length > limit ? value.slice(0, limit) : value);
const numberOr = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const number = Number(value.trim());
  return Number.isFinite(number) ? number : undefined;
};
const flagNames = flags => flags.map(flag => flag.replace(/^--/, '')).join('/');

/** id 只由 kind + subject 决定：同一句事实无论从哪个作业、哪一次运行提炼出来，都必须落到同一个 id 上。 */
export function lessonId(kind, subject) {
  const family = LESSON_KINDS.includes(kind) ? kind : 'other';
  return createHash('sha256').update(`${family}:${asText(String(subject ?? ''))}`).digest('hex').slice(0, 16);
}

const confidenceOf = value => {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : LESSON_DEFAULTS.confidence;
  return Math.min(LESSON_DEFAULTS.ceiling, Math.max(0, number));
};
const hitsOf = value => (Number.isSafeInteger(value) && value > 0 ? value : 1);
const value = lesson => lesson.confidence * lesson.hits;
const toolFact = lesson => ['tool-arg', 'tool-name'].includes(lesson.kind);
const evictableLessons = lessons => lessons.filter(lesson => !toolFact(lesson) || lesson.confidence < LESSON_DEFAULTS.protectedConfidence)
  .sort((left, right) => Number(toolFact(left)) - Number(toolFact(right)) || value(left) - value(right));

/** 证据只保留最新若干条原始片段：fact 是提炼过的结论文本，原始错误进证据，两者不能互相污染。 */
function evidenceOf(values) {
  const kept = [];
  for (const raw of values ?? []) {
    const text = clip(asText(typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')), LESSON_DEFAULTS.evidenceCharacters);
    if (!text || kept.includes(text)) continue;
    kept.push(text);
  }
  while (kept.length > LESSON_DEFAULTS.evidence) kept.shift();
  return kept;
}

function normalizeLesson(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = LESSON_KINDS.includes(raw.kind) ? raw.kind : 'other';
  const subject = clip(asText(raw.subject), LESSON_DEFAULTS.subjectCharacters);
  const fact = kind === 'tool-arg' && subject === 'native-review-decisions'
    ? NATIVE_REVIEW_PROTOCOL_FACT : clip(asText(raw.fact), LESSON_DEFAULTS.factCharacters);
  if (!subject || !fact) return null;
  const firstSeen = Number.isFinite(raw.firstSeen) ? raw.firstSeen : Number.isFinite(raw.lastSeen) ? raw.lastSeen : 0;
  return {
    id: lessonId(kind, subject),
    kind,
    subject,
    fact,
    factLevel: levelOf(raw.factLevel),
    confidence: confidenceOf(raw.confidence),
    hits: hitsOf(raw.hits),
    firstSeen,
    lastSeen: Number.isFinite(raw.lastSeen) ? raw.lastSeen : firstSeen,
    evidence: evidenceOf(Array.isArray(raw.evidence) ? raw.evidence : []),
    ...(typeof raw.evidenceFingerprint === 'string' && raw.evidenceFingerprint ? { evidenceFingerprint: raw.evidenceFingerprint } : {}),
  };
}

/** 同一 id 在入参里出现两次时合成一条：教训集里不允许同一个事实有两份互相矛盾的置信度。 */
function normalizeLessons(lessons) {
  const byId = new Map();
  for (const raw of Array.isArray(lessons) ? lessons : []) {
    const lesson = normalizeLesson(raw);
    if (!lesson) continue;
    const previous = byId.get(lesson.id);
    if (!previous) {
      byId.set(lesson.id, lesson);
      continue;
    }
    // 同一 id 出现两条时保留证据级别更高的那条表述，与 mergeLessons 的覆盖规则保持一致。
    const winner = LEVEL_RANK.get(lesson.factLevel) > LEVEL_RANK.get(previous.factLevel) ? lesson : previous;
    byId.set(lesson.id, {
      ...winner,
      factLevel: winner.factLevel,
      confidence: Math.max(previous.confidence, lesson.confidence),
      hits: Math.max(previous.hits, lesson.hits),
      firstSeen: Math.min(previous.firstSeen || lesson.firstSeen, lesson.firstSeen || previous.firstSeen),
      lastSeen: Math.max(previous.lastSeen, lesson.lastSeen),
      evidence: evidenceOf([...previous.evidence, ...lesson.evidence]),
    });
  }
  return [...byId.values()];
}

/** 工具协议纠偏优先，再按已验证价值和证据等级排序。 */
function rankLessons(lessons) {
  return [...lessons].sort((left, right) => Number(toolFact(right)) - Number(toolFact(left)) || value(right) - value(left)
    || right.confidence - left.confidence
    || LEVEL_RANK.get(right.factLevel) - LEVEL_RANK.get(left.factLevel)
    || right.hits - left.hits
    || (KIND_ORDER.get(left.kind) ?? 99) - (KIND_ORDER.get(right.kind) ?? 99)
    || right.lastSeen - left.lastSeen
    || left.id.localeCompare(right.id));
}

/* ------------------------------------------------------------------ 提炼上下文 */

function normalizeError(error) {
  if (!error) return { message: '', code: '', nextAction: '', tool: '' };
  if (typeof error === 'string') return { message: asText(error), code: '', nextAction: '', tool: '' };
  return {
    message: asText(error.message ?? error.error ?? error.reason ?? ''),
    code: asText(error.code ?? ''),
    nextAction: asText(error.nextAction ?? error.hint ?? ''),
    tool: typeof (error.tool ?? error.toolName) === 'string' ? (error.tool ?? error.toolName) : asText(error.tool ?? error.toolName ?? ''),
  };
}

function callFlags(raw) {
  const flags = new Set();
  const args = raw.args ?? raw.arguments ?? raw.input;
  if (Array.isArray(args)) {
    for (const arg of args) if (typeof arg === 'string' && /^--[a-z][a-z0-9-]*$/i.test(arg)) flags.add(arg.toLowerCase());
  } else if (args && typeof args === 'object') {
    // 命名参数形式（native_review({group, offset, limit})）等价于 --group/--offset/--limit
    for (const key of Object.keys(args)) if (/^[a-z][a-z0-9]*$/i.test(key)) flags.add(`--${key.toLowerCase()}`);
  }
  return [...flags];
}

function normalizeCalls(toolCalls) {
  const calls = [];
  for (const raw of Array.isArray(toolCalls) ? toolCalls : []) {
    if (!raw || typeof raw !== 'object') continue;
    const tool = asText(raw.tool ?? raw.name ?? raw.toolName ?? '').toLowerCase();
    if (!tool) continue;
    const failure = raw.error ? asText(raw.error.message ?? raw.error) : '';
    calls.push({
      tool,
      flags: callFlags(raw),
      failed: raw.ok === false || raw.failed === true || Boolean(raw.error),
      failure,
    });
  }
  return calls;
}

function contextOf(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    jobId: asText(source.jobId),
    outcome: asText(source.outcome).toLowerCase(),
    error: normalizeError(source.error),
    calls: normalizeCalls(source.toolCalls),
    resource: source.resource && typeof source.resource === 'object' ? source.resource : undefined,
    classes: Array.isArray(source.classes) ? source.classes : [],
    at: Number.isFinite(source.at) ? source.at : Date.now(),
  };
}

/* ------------------------------------------------------------------ 提炼规则表 */

// 表驱动：每条规则只做一件事——从上下文里取出「确定性事实」。加规则就加一行，不改主流程。
const RULES = [
  { id: 'native-review-protocol', kind: 'tool-arg', level: 'direct', extract: nativeReviewProtocol },
  { id: 'tool-arg-explicit', kind: 'tool-arg', level: 'direct', extract: toolArgExplicit },
  { id: 'tool-arg-rejected-call', kind: 'tool-arg', level: 'inferred', extract: toolArgFromCalls },
  { id: 'tool-name-unregistered', kind: 'tool-name', level: 'direct', extract: toolNameUnregistered },
  // 类无文本 / 预筛的级别由数据决定：工具回报的 fieldCount=0、units=0 是 direct，
  // 只由 verified+texts=0 推出来的才是 inferred，所以这两个规则在返回的 part 上带 level。
  { id: 'class-no-text', kind: 'class-no-text', level: 'inferred', extract: classesWithoutText },
  { id: 'resource-shape', kind: 'resource-shape', level: 'inferred', extract: resourceShape },
  { id: 'resource-prefilter', kind: 'prefilter', level: 'inferred', extract: resourcePrefilter },
];

// 错误文本里点明了被拒参数的说法（宿主校验器已经把「可用参数」写进错误时优先命中这些）。
const REJECTED_PATTERNS = [
  /不认识参数\s*((?:--[a-z][a-z0-9-]{0,40}[、,，\s]*)+)/i,
  /(?:不接受|不识别|无法识别|未注册)\s*(?:参数\s*)?((?:--[a-z][a-z0-9-]{0,40}|offset|limit|page|pagesize|skip|start|take)(?:\s*[\/、,，]\s*(?:--[a-z][a-z0-9-]{0,40}|offset|limit|page|pagesize|skip|start|take))*)/i,
  /(?:unknown|unexpected|unsupported|rejected)\s+(?:argument|flag|option)s?\s*[：:]?\s*((?:--[a-z][a-z0-9-]{0,40}[、,，\s]*)+)/i,
];
const ALLOWED_PATTERN = /(?:允许的参数是|可用的是|可用参数)[：:]?\s*([^。；\n]+)/;
const PAGER_PATTERN = /分页(?:请|应|改用|用|走)\s*([a-z][a-z0-9_]{2,40})/i;
const OPAQUE_PATTERN = /请使用已注册的可信工具及参数|参数被主机校验拒绝|工具参数未通过校验/;
const UNREGISTERED_TOOL_PATTERN = /(?:未知|不存在|未注册|未登记)的?工具\s*[：:]?\s*([a-z][a-z0-9_]{2,40})|工具\s*([a-z][a-z0-9_]{2,40})\s*(?:未注册|未登记|不存在|未知)/i;

function rejectedFlags(text) {
  const flags = new Set();
  for (const pattern of REJECTED_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const captured = String(match[1] ?? '');
    for (const flag of captured.match(FLAG) ?? []) flags.add(flag.toLowerCase());
    if (!(captured.match(FLAG) ?? []).length) for (const token of captured.match(PAGING_TOKEN) ?? []) flags.add(`--${token.toLowerCase()}`);
  }
  return [...flags];
}

const TOOL_NAME_PATTERNS = [
  /^([a-z][a-z0-9_]{2,40})\s*的(?:参数|调用|工具)/i,
  /^([a-z][a-z0-9_]{2,40})\s*(?:参数|调用|工具)/i,
  /工具\s*[:：]?\s*([a-z][a-z0-9_]{2,40})/i,
];

function toolNameOf(ctx) {
  if (ctx.error.tool) return ctx.error.tool;
  // subject 必须是工具名，认不出工具就整条放弃：用「其他」当 subject 会让所有未知工具的教训挤成一条。
  for (const pattern of TOOL_NAME_PATTERNS) {
    const named = pattern.exec(ctx.error.message);
    if (named) return named[1].toLowerCase();
  }
  const flagged = ctx.calls.filter(call => call.flags.length);
  return flagged.length ? flagged[flagged.length - 1].tool : '';
}

/** 规则 1a：错误文本点名了参数，才敢断言「不接受某参数」——这是 direct 级别，允许覆盖 1b 推出来的 inferred。 */
function toolArgExplicit(ctx) {
  const haystack = `${ctx.error.message} ${ctx.error.nextAction}`;
  let rejected = rejectedFlags(haystack);
  if (!rejected.length) return [];
  const tool = toolNameOf(ctx);
  if (!tool) return [];
  // 保留宿主给出的可用参数原文（含「--limit 上限 12」这类范围），只裁掉后面的分页说明。
  const raw = (ALLOWED_PATTERN.exec(haystack)?.[1] ?? '').split(/[,，]\s*(?:分页|续页)/)[0].trim();
  const allowedFlags = (raw.match(FLAG) ?? []).map(flag => flag.toLowerCase());
  rejected = rejected.filter(flag => !allowedFlags.includes(flag));
  if (!rejected.length) return [];
  // 宿主自己一边说「不认识 --offset」一边又说「可用的是 --offset」时不能照抄，否则这句事实自相矛盾。
  const allowed = /无参数|没有任何参数/.test(raw) ? '无参数' : clip(raw, 100);
  const pagerTool = PAGER_PATTERN.exec(haystack)?.[1] ?? '';
  const paging = pagerTool ? `分页用 ${pagerTool}`
    : /nextOffset|续页/.test(haystack) ? '分页用返回的 nextOffset'
    : '续页用返回的 nextOffset，不要自己构造分页参数';
  const fact = [`不接受 ${flagNames(rejected)}`];
  if (allowed) fact.push(`可用的是 ${allowed}`);
  fact.push(paging);
  return [{ subject: tool, fact: fact.join('；'), level: 'direct', evidence: [ctx.error.message || haystack, `toolCalls: ${tool}`] }];
}

/**
 * 规则 1b：主机只回一句「请使用已注册的可信工具及参数」时，错误里看不出是哪个参数。
 * 此时只陈述可验证的部分——「被拒的那次调用带了 offset/limit」，绝不写成「工具不接受 offset/limit」：
 * 万一真正被拒的是别的参数，这条教训会让后面 40 个作业一起走错方向。
 * 只有当同一工具的另一次调用成功过（成功集合能反证哪些参数是被接受的），才升级成断言。
 */
function toolArgFromCalls(ctx) {
  if (!OPAQUE_PATTERN.test(ctx.error.message)) return [];
  const withFlags = ctx.calls.filter(call => call.flags.length);
  if (!withFlags.length) return [];
  const byTool = new Map();
  for (const call of withFlags) byTool.set(call.tool, [...(byTool.get(call.tool) ?? []), call]);
  const [tool, bucket] = [...byTool].sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))[0];
  const failed = bucket.filter(call => call.failed);
  const scope = failed.length ? failed : bucket;
  const suspects = new Set(scope.flatMap(call => call.flags));
  const proven = new Set(bucket.filter(call => !call.failed).flatMap(call => call.flags));
  for (const flag of proven) suspects.delete(flag);
  const list = [...suspects];
  if (!list.length) return [];
  const attempted = scope.at(-1).flags.join(' ');
  // 没被反证时，把分页参数和「一起带上的选择性参数」分开写：否则后续作业很容易连 --group 一起删掉。
  const paging = list.filter(flag => PAGING.has(flag));
  const others = list.filter(flag => !PAGING.has(flag));
  const named = paging.length ? `${flagNames(paging)}${others.length ? `（另带 ${flagNames(others)}）` : ''}` : flagNames(list);
  const fact = `参数被主机整句拒绝（未说明具体参数）；被拒的调用含 ${named}，按登记的参数表核对参数名、取值和JSON结构后再调用`;
  return [{ subject: tool, fact, evidence: [ctx.error.message, `toolCalls: ${tool}(${clip(attempted, 120)})`] }];
}

function nativeReviewProtocol(ctx) {
  if (ctx.error.code !== 'NATIVE_REVIEW_PROTOCOL') return [];
  return [{ subject: 'native-review-decisions', fact: NATIVE_REVIEW_PROTOCOL_FACT, evidence: [ctx.error.message] }];
}

/** 规则 2：工具名本身不在可信工具表里，这是确定的注册事实，不是猜测。 */
function toolNameUnregistered(ctx) {
  if (ctx.error.code === 'MODEL_TOOL_NOT_AVAILABLE' && ctx.error.tool) return [{ subject: JSON.stringify(ctx.error.tool),
    fact: '该精确工具名未发布；逐字使用本轮已发布工具，不构造前缀或组合名。', evidence: [ctx.error.message] }];
  if (ctx.error.code === 'TOOL_NOT_REGISTERED' && ctx.error.tool) return [{ subject: JSON.stringify(ctx.error.tool),
    fact: `该精确工具名未登记；run_tool.tool必须逐字使用登记名称，不添加额外引号。${ctx.error.nextAction}`,
    evidence: [ctx.error.message] }];
  const match = UNREGISTERED_TOOL_PATTERN.exec(ctx.error.message);
  if (!match) return [];
  const tool = (match[1] ?? match[2] ?? '').toLowerCase();
  if (!tool) return [];
  return [{ subject: tool, fact: '工具未在可信工具表内登记，改用 inspect_context 列出的工具，不要重复调用', evidence: [ctx.error.message] }];
}

/**
 * 规则 3：类无文本。
 * 只在作业裁决通过（outcome === 'verified'）且该类确实 0 文本时提炼——被跳过的东西如果没被真正裁决过，
 * 记下来就是把「没看」伪装成「不用看」。
 */
function classesWithoutText(ctx) {
  if (ctx.outcome !== 'verified') return [];
  const parts = [];
  for (const raw of ctx.classes) {
    if (!raw || typeof raw !== 'object') continue;
    const className = asText(raw.name ?? raw.class ?? raw.className ?? raw.type ?? '');
    const name = raw.file ? `${asText(raw.file)}#${className}` : className;
    if (!name) continue;
    const texts = numberOr(raw.textGroups ?? raw.displayGroups ?? raw.textCount ?? raw.texts);
    const fields = numberOr(raw.fieldCount ?? raw.fields);
    const groups = numberOr(raw.groups ?? raw.groupCount ?? raw.total ?? raw.objects);
    const disposition = asText(raw.disposition ?? raw.status ?? raw.verdict ?? '').toLowerCase();
    const declared = ['no-text', 'notext', 'no_text', 'no-text-group', 'non-display', 'nondisplay', 'prefiltered'].includes(disposition);
    const zeroText = texts === 0 || fields === 0 || declared;
    // 自相矛盾（声明无文本但统计出文本组）时宁可不记：错误事实比没有事实更贵。
    if (!zeroText || (Number.isFinite(texts) && texts > 0)) continue;
    const detail = [Number.isFinite(groups) ? `${groups} 组` : '', Number.isFinite(fields) ? `fieldCount=${fields}` : '', disposition || ''].filter(Boolean).join('、');
    parts.push({
      subject: name,
      fact: fields === 0 ? `当前资源中该组已检查${Number.isFinite(groups) ? groups : ''}个对象，未发现可提取字符串字段，继续其他组`
        : '当前资源中该组已按用途确认为非显示内容，继续其他组',
      // 工具直接回报 fieldCount=0 是 direct；只凭 verified + texts=0 推出来的只能算 inferred。
      level: Number.isFinite(fields) && fields === 0 ? 'direct' : 'inferred',
      evidence: [ctx.error.message || `${name}${detail ? `：${detail}` : ''}`, `作业 ${ctx.jobId} 裁决通过${detail ? `（${detail}）` : ''}`],
    });
  }
  return parts;
}

/** 规则 4：资源形状。没有具体数字就不是事实，只是印象，因此必须带可复核的分子分母。 */
function resourceShape(ctx) {
  const resource = ctx.resource;
  if (!resource) return [];
  const file = asText(resource.file ?? resource.relative ?? resource.path ?? '');
  if (!file) return [];
  const total = numberOr(resource.total ?? resource.totalObjects ?? resource.objects ?? resource.count);
  const composition = Array.isArray(resource.composition) ? resource.composition
    : Array.isArray(resource.counts) ? resource.counts
    : Array.isArray(resource.classes) ? resource.classes : [];
  let dominant;
  for (const item of composition) {
    if (!item || typeof item !== 'object') continue;
    const name = asText(item.name ?? item.class ?? item.kind ?? '');
    const count = numberOr(item.count ?? item.objects ?? item.total);
    if (!name || !Number.isFinite(count) || count <= 0) continue;
    if (!dominant || count > dominant.count) dominant = { name, count };
  }
  // 少于 10 个对象时比例没有统计意义，超过才值得让后续作业直接按结论走。
  if (!dominant || !Number.isFinite(total) || total < 10 || dominant.count < total * 0.6) return [];
  const share = Math.round((dominant.count / total) * 100);
  return [{
    subject: file,
    fact: `${share}% 的对象（${dominant.count}/${total}）是 ${dominant.name}；继续核对其余类型`,
    evidence: [`${file}: ${composition.map(item => `${asText(item?.name ?? item?.class ?? '')}=${numberOr(item?.count ?? item?.objects ?? item?.total) ?? '?'}`).join(', ')}`],
  }];
}

/** 规则 5：预筛。17 个待检查对象、0 个可提取单元——两边都有数字才是事实；只有 "0" 可能只是这次没跑完。 */
function resourcePrefilter(ctx) {
  const resource = ctx.resource;
  if (!resource) return [];
  const file = asText(resource.file ?? resource.relative ?? resource.path ?? '');
  if (!file) return [];
  const objects = numberOr(resource.objects ?? resource.reviewObjects ?? resource.total ?? resource.groups);
  const units = numberOr(resource.units ?? resource.textUnits ?? resource.addedUnits ?? resource.extractable ?? resource.found);
  const prefiltered = resource.prefiltered === true || /no-text|prefilter/i.test(asText(resource.prefiltered));
  if (units !== 0 || !Number.isFinite(objects) || objects < 1) return [];
  // 没有裁决通过也没有预筛标记时，「0 个单元」可能只是作业中途超时，不能当成结构结论。
  if (ctx.outcome !== 'verified' && !prefiltered) return [];
  return [{
    subject: file,
    fact: `${objects} 个待检查对象、0 个可提取单元，已确认无显示文本`,
    // 两个数字都是工具回报的原始计数，不是我的推算，所以是 direct。
    level: 'direct',
    evidence: [`${file}: objects=${objects}, units=0${prefiltered ? ', prefiltered' : ''}`],
  }];
}

/* ------------------------------------------------------------------ 对外 API */

/** 提炼一次作业里所有值得记的教训（同一 id 只保留一条）。 */
export function distillLessons(input) {
  const ctx = contextOf(input);
  const byId = new Map();
  for (const rule of RULES) {
    let parts = [];
    // 单条规则抛错不能连累整个作业收尾：教训库是旁路，坏了就少一条结论。
    try {
      parts = rule.extract(ctx) ?? [];
    } catch {
      parts = [];
    }
    for (const part of parts) {
      const subject = clip(asText(part?.subject), LESSON_DEFAULTS.subjectCharacters);
      const fact = clip(asText(part?.fact), LESSON_DEFAULTS.factCharacters);
      if (!subject || !fact) continue;
      const id = lessonId(rule.kind, subject);
      const factLevel = levelOf(part?.level ?? rule.level);
      const lesson = {
        id,
        kind: rule.kind,
        subject,
        fact,
        factLevel,
        // direct 事实从 0.85 起步：它是点名证据，不该和推断共用 0.5 的起点。
        confidence: factLevel === 'direct' ? Math.max(LESSON_DEFAULTS.confidence, LESSON_DEFAULTS.directConfidence) : LESSON_DEFAULTS.confidence,
        hits: 1,
        firstSeen: ctx.at,
        lastSeen: ctx.at,
        evidence: evidenceOf(part?.evidence ?? []),
      };
      const previous = byId.get(id);
      if (!previous) byId.set(id, lesson);
      else if (LEVEL_RANK.get(factLevel) > LEVEL_RANK.get(previous.factLevel)) byId.set(id, { ...lesson, evidence: evidenceOf([...previous.evidence, ...lesson.evidence]) });
      else byId.set(id, { ...previous, evidence: evidenceOf([...previous.evidence, ...lesson.evidence]) });
    }
  }
  return [...byId.values()];
}

/** 提炼单条教训：按规则优先级取最高价值的一条，不值得记就返回 null。 */
export function distillLesson(input) {
  const lessons = distillLessons(input);
  if (!lessons.length) return null;
  return rankLessons(lessons)[0];
}

/**
 * 合并进已有教训集。
 * - 同 id：hits++、lastSeen 更新、evidence 追加（最新 3 条）；
 *   fact 是否被新说法替换，取决于 factLevel（见文件头的覆盖表）——
 *   direct 可以推翻 inferred（精确度提升），inferred 永远推不翻已定型的表述（避免抖动）。
 * - 覆盖时 confidence 不重置：direct 覆盖后取 max(当前, 0.85)，其余沿用旧值。
 * - 超量：工具协议纠偏优先，当前资源结论按价值替换，保留已确认的工具协议。
 */
export function mergeLessons(lessons, lesson, { at = Date.now(), max = LESSON_DEFAULTS.max } = {}) {
  const list = normalizeLessons(lessons);
  const incoming = normalizeLesson(lesson);
  if (!incoming) return { lessons: list, changed: false };
  const timestamp = Number.isFinite(at) ? at : Date.now();
  const limit = Number.isSafeInteger(max) && max > 0 ? max : LESSON_DEFAULTS.max;
  const index = list.findIndex(item => item.id === incoming.id);
  if (index >= 0) {
    const previous = list[index];
    const overrides = LEVEL_RANK.get(incoming.factLevel) > LEVEL_RANK.get(previous.factLevel)
      || (incoming.factLevel === 'direct' && previous.factLevel === 'direct' && incoming.fact !== previous.fact);
    const winner = overrides ? incoming : previous;
    list[index] = {
      ...previous,
      fact: winner.fact,
      factLevel: winner.factLevel,
      // 旧说法进证据，保留「曾经这么认为」的痕迹；覆盖提升精确度，但不重置已经积累的置信度。
      evidence: evidenceOf(overrides ? [...previous.evidence, previous.fact, ...incoming.evidence] : [...previous.evidence, ...incoming.evidence]),
      confidence: overrides
        ? (incoming.factLevel === 'direct'
          ? Math.min(LESSON_DEFAULTS.ceiling, Math.max(previous.confidence, LESSON_DEFAULTS.directConfidence))
          : previous.confidence)
        : Math.min(LESSON_DEFAULTS.ceiling, previous.confidence + LESSON_DEFAULTS.gain),
      hits: previous.hits + 1,
      firstSeen: previous.firstSeen || incoming.firstSeen || timestamp,
      lastSeen: timestamp,
    };
    return { lessons: trim(list, limit), changed: true };
  }
  if (list.length < limit) {
    return { lessons: trim([...list, { ...incoming, firstSeen: incoming.firstSeen || timestamp, lastSeen: timestamp }], limit), changed: true };
  }
  // 满了：只有严格比最弱可淘汰条目更有价值的新事实才允许挤进去。
  // 打平时保留原有事实：同一个项目里旧结论的稳定性和新结论的价值一样重要，不该被同分条目反复顶掉。
  const evictable = evictableLessons(list);
  if (!evictable.length || !(toolFact(incoming) && !toolFact(evictable[0])) && value(incoming) <= value(evictable[0])) return { lessons: list, changed: false };
  const weakest = evictable[0];
  const next = list.filter(item => item.id !== weakest.id);
  next.push({ ...incoming, firstSeen: incoming.firstSeen || timestamp, lastSeen: timestamp });
  return { lessons: trim(next, limit), changed: true };
}

function trim(list, limit) {
  if (list.length <= limit) return list;
  const trimmed = [...list];
  while (trimmed.length > limit) {
    const evictable = evictableLessons(trimmed);
    if (!evictable.length) break;
    trimmed.splice(trimmed.findIndex(item => item.id === evictable[0].id), 1);
  }
  return trimmed;
}

/** 记录「这条教训被用过并且成功了」：复用一次就提升一档置信度，未知 id 原样返回。 */
export function creditLesson(lessons, id, { at = Date.now() } = {}) {
  const list = normalizeLessons(lessons);
  const key = asText(String(id ?? ''));
  const index = list.findIndex(item => item.id === key);
  if (index < 0) return { lessons: list, changed: false };
  const timestamp = Number.isFinite(at) ? at : Date.now();
  list[index] = {
    ...list[index],
    confidence: Math.min(LESSON_DEFAULTS.ceiling, list[index].confidence + LESSON_DEFAULTS.gain),
    hits: list[index].hits + 1,
    lastSeen: timestamp,
  };
  return { lessons: list, changed: true };
}

/**
 * 教训集健康度：上层据此判断「这些结论还新鲜吗」。
 * stale = 超过 30 天没被复用、且只出现过 1 次——它描述的很可能是已经修掉的坑。
 */
export function lessonStats(lessons, { now = Date.now(), staleAfterMs = LESSON_DEFAULTS.staleAfterMs } = {}) {
  const list = normalizeLessons(lessons);
  const reference = Number.isFinite(now) ? now : Date.now();
  const window = Number.isFinite(staleAfterMs) && staleAfterMs >= 0 ? staleAfterMs : LESSON_DEFAULTS.staleAfterMs;
  return {
    direct: list.filter(item => item.factLevel === 'direct').length,
    inferred: list.filter(item => item.factLevel === 'inferred').length,
    stale: list.filter(item => reference - item.lastSeen > window && item.hits < LESSON_DEFAULTS.staleHits).length,
  };
}

/** Resource facts are tied to the inspected source; registered-tool facts survive a new import. */
export function lessonsForSource(lessons, evidenceFingerprint) {
  return normalizeLessons(lessons).filter(lesson => ['tool-arg', 'tool-name'].includes(lesson.kind)
    || Boolean(evidenceFingerprint && lesson.evidenceFingerprint === evidenceFingerprint));
}

/**
 * 渲染成能塞进 system prompt 的紧凑文本。
 * - 按 confidence × hits 排序（同分时 direct 在前），只取前 max 条；
 * - 同一 fact 的不同 subject 合成一行（Cubism 四个类一行），避免占满预算；
 * - 整行超预算就整行丢弃，绝不截半句——半句话进 prompt 比没有更糟；
 * - 不输出 confidence/hits/factLevel，模型不需要看见内部评分；
 * - 没有教训返回 ''，让调用方可以直接判断「要不要加这一段」。
 */
export function renderLessons(lessons, { max = LESSON_DEFAULTS.max, maxCharacters = LESSON_DEFAULTS.maxCharacters } = {}) {
  const limit = Number.isSafeInteger(max) && max >= 0 ? max : LESSON_DEFAULTS.max;
  const budget = (Number.isSafeInteger(maxCharacters) && maxCharacters > 0 ? maxCharacters : LESSON_DEFAULTS.maxCharacters) - HEADER.length - 1;
  if (limit === 0 || budget <= 0) return '';
  const normalized = normalizeLessons(lessons);
  if (!normalized.length) return '';
  const ranked = rankLessons(normalized);
  const chosen = new Set(ranked.slice(0, limit).map(lesson => lesson.id));
  const position = new Map(ranked.map((lesson, index) => [lesson.id, index]));
  // 分组顺序取组内最高排名；subject 顺序按入参原始顺序，避免渲染出来的类名顺序每次都变。
  const groups = new Map();
  for (const lesson of normalized) {
    if (!chosen.has(lesson.id)) continue;
    const key = `${lesson.kind}\u0000${lesson.fact}`;
    const group = groups.get(key) ?? { subjects: [], fact: lesson.fact, best: position.get(lesson.id) };
    if (!group.subjects.includes(lesson.subject)) group.subjects.push(lesson.subject);
    group.best = Math.min(group.best, position.get(lesson.id));
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((left, right) => left.best - right.best);
  const lines = [];
  let used = 0;
  for (const group of ordered) {
    const line = `- ${group.subjects.join(' / ')}：${group.fact}`;
    const cost = line.length + 1;
    if (used + cost <= budget) {
      lines.push(line);
      used += cost;
      continue;
    }
    // Keep the whole fact and whole listed scopes; an omitted subject never implies another resource.
    const named = [];
    let compacted;
    for (const subject of group.subjects) {
      const candidate = [...named, subject], omitted = group.subjects.length - candidate.length;
      const scope = `${candidate.join(' / ')}${omitted ? `（另${omitted}个主体未展开，不外推其他资源）` : ''}`;
      const candidateLine = `- ${scope}：${group.fact}`;
      if (used + candidateLine.length + 1 > budget) break;
      named.push(subject);
      compacted = candidateLine;
    }
    if (compacted) { lines.push(compacted); used += compacted.length + 1; }
  }
  if (!lines.length) return '';
  return [HEADER, ...lines].join('\n');
}
