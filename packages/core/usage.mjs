// One usage shape for every model channel. The three transports report billing in three different
// dialects (AI SDK camelCase, OpenAI snake_case, and per-step agent aggregates), so this module is the
// only place allowed to translate them. It normalises, it records, it aggregates: it never decides
// whether a request is retried, degraded or rejected, and it imports nothing.

export const USAGE_ROLES = ['glossary', 'translation', 'proofreading', 'technical', 'recollection'];
const MAX_ENTRIES = 5000;
const TOKEN_KEYS = ['promptTokens', 'completionTokens', 'reasoningTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens'];

const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const record = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : undefined);

// A missing number stays `null` instead of becoming zero: an unreported cost must never read as free.
function known(value) {
  return finite(value) ?? null;
}

/**
 * Normalise any supported usage dialect into `{promptTokens, completionTokens, reasoningTokens, totalTokens, cost}`.
 * Accepts AI SDK (`inputTokens`/`outputTokens`), OpenAI-compatible (`prompt_tokens`/`completion_tokens`)
 * and already normalised objects; every key of the result is always present.
 */
export function normalizeUsage(source, { cost } = {}) {
  const value = record(source);
  if (!value) return undefined;
  const prompt = record(value.prompt_tokens_details) ?? record(value.inputTokenDetails);
  const completion = record(value.completion_tokens_details) ?? record(value.outputTokenDetails);
  const promptTokens = finite(value.promptTokens) ?? finite(value.inputTokens) ?? finite(value.prompt_tokens);
  const completionTokens = finite(value.completionTokens) ?? finite(value.outputTokens) ?? finite(value.completion_tokens);
  const reasoningTokens = finite(value.reasoningTokens) ?? finite(value.reasoning_tokens)
    ?? finite(completion?.reasoning_tokens) ?? finite(completion?.reasoningTokens) ?? finite(prompt?.reasoning_tokens);
  const stated = finite(value.totalTokens) ?? finite(value.total_tokens);
  const totalTokens = stated ?? (promptTokens === undefined && completionTokens === undefined ? undefined : (promptTokens ?? 0) + (completionTokens ?? 0));
  const cacheReadTokens = finite(value.cacheReadTokens) ?? finite(value.cachedInputTokens) ?? finite(value.prompt_cache_hit_tokens)
    ?? finite(value.cache_read_input_tokens) ?? finite(prompt?.cached_tokens) ?? finite(prompt?.cacheReadTokens);
  const cacheWriteTokens = finite(value.cacheWriteTokens) ?? finite(value.cache_creation_input_tokens)
    ?? finite(prompt?.cacheWriteTokens);
  const normalized = {
    promptTokens: known(promptTokens), completionTokens: known(completionTokens), reasoningTokens: known(reasoningTokens),
    totalTokens: known(totalTokens),
    cacheReadTokens: known(cacheReadTokens), cacheWriteTokens: known(cacheWriteTokens),
    cost: known(finite(cost) ?? finite(value.cost) ?? finite(value.totalCost) ?? finite(value.total_cost)),
  };
  return TOKEN_KEYS.every(key => normalized[key] === null) && normalized.cost === null ? undefined : normalized;
}

const emptyTotals = () => ({ requests: 0, ...Object.fromEntries(TOKEN_KEYS.map(key => [key, 0])), cacheReadTokens: null,
  cacheWriteTokens: null, cost: 0, costedRequests: 0 });

function add(into, usage) {
  into.requests += 1;
  for (const key of TOKEN_KEYS) if (usage[key] !== null) into[key] = (into[key] ?? 0) + usage[key];
  if (usage.cost !== null) { into.cost += usage.cost; into.costedRequests += 1; }
  return into;
}

const ledger = { entries: [], roles: new Map(), total: emptyTotals() };

/**
 * Record one finished model request. `role` is the channel that paid for it, so the same translation
 * batch can later be told apart from a recollection run. Returns the stored entry, or undefined when
 * the transport reported no billing at all.
 */
export function recordUsage({ role = 'unknown', model, usage, cost, outcome = 'succeeded', at = new Date().toISOString() } = {}) {
  const normalized = normalizeUsage(usage, { cost });
  if (!normalized) return undefined;
  const entry = { role, model: model ?? null, outcome, at, usage: normalized };
  ledger.entries.push(entry);
  if (ledger.entries.length > MAX_ENTRIES) ledger.entries.splice(0, ledger.entries.length - MAX_ENTRIES);
  add(ledger.total, normalized);
  if (!ledger.roles.has(role)) ledger.roles.set(role, emptyTotals());
  add(ledger.roles.get(role), normalized);
  return entry;
}

const snapshot = totals => ({ requests: totals.requests, promptTokens: totals.promptTokens, completionTokens: totals.completionTokens,
  reasoningTokens: totals.reasoningTokens, totalTokens: totals.totalTokens, cacheReadTokens: totals.cacheReadTokens,
  cacheWriteTokens: totals.cacheWriteTokens, cost: totals.costedRequests ? totals.cost : null,
  costedRequests: totals.costedRequests });

/** Recorded requests in order, optionally narrowed to one channel. */
export function usageEntries({ role } = {}) {
  return role ? ledger.entries.filter(entry => entry.role === role) : [...ledger.entries];
}

/** Aggregate usage and cost by channel plus the whole-session total. This is the UI entry point. */
export function usageSummary() {
  return { total: snapshot(ledger.total), byRole: Object.fromEntries([...ledger.roles].map(([role, totals]) => [role, snapshot(totals)])) };
}

export function resetUsage() {
  ledger.entries.length = 0;
  ledger.roles.clear();
  Object.assign(ledger.total, emptyTotals());
}

/** Rebuild observations from saved request artifacts; receiving text is not accepting a translation. */
export function summarizeRequestArtifacts(artifacts = []) {
  const empty = () => ({ requests: 0, httpAttempts: 0, receivedRequests: 0, failedRequests: 0, cancelledRequests: 0,
    uncertainDispatchAttempts: 0, incompleteRequests: 0, evidenceRequests: 0, unknownCostAttempts: 0, unknownUsageAttempts: 0,
    unknownCostRequests: 0, unknownUsageRequests: 0, knownCost: null,
    ...Object.fromEntries(TOKEN_KEYS.map(key => [key, null])) });
  const total = empty(), byProject = {}, byTask = {}, seen = new Set();
  for (const artifact of artifacts) {
    const { request = {}, result = {}, events = [] } = artifact;
    const context = request.requestContext ?? result.requestContext ?? {};
    const projectId = context.projectId ?? 'unknown', taskId = context.taskId ?? context.jobId ?? 'unknown';
    const id = result.id ?? artifact.id ?? request.requestId;
    if (typeof id !== 'string') throw new Error('持久用量汇总需要请求工件身份');
    const identity = JSON.stringify([projectId, id]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const summary = result.summary ?? {};
    const sends = new Set(events.filter(event => event.type === 'send').map(event => event.index ?? 1));
    const headers = new Set(events.filter(event => event.type === 'headers').map(event => event.index ?? 1));
    const declaredAttempts = finite(summary.transportRequests) ?? (typeof summary.fetchStarted === 'boolean' ? Number(summary.fetchStarted) : undefined);
    const attempts = declaredAttempts ?? headers.size;
    const uncertain = declaredAttempts === undefined ? Math.max(0, sends.size - attempts) : 0;
    const exposed = attempts + uncertain;
    const usage = normalizeUsage(summary.usage ?? summary.rawUsage);
    const groups = [total, byProject[projectId] ??= empty(), byTask[JSON.stringify([projectId, taskId])] ??= empty()];
    for (const group of groups) {
      group.requests++; group.httpAttempts += attempts;
      group.uncertainDispatchAttempts += uncertain;
      if (result.status === 'received') group.receivedRequests++;
      if (result.status === 'failed') group.failedRequests++;
      if (!result.status) group.incompleteRequests++;
      if (result.error?.category === 'cancelled' || result.status === 'cancelled') group.cancelledRequests++;
      if (summary.evidenceRequests > 0) group.evidenceRequests++;
      // A compatible retry has its own send, but terminal usage describes only the reported response.
      const reported = exposed > 0 && usage ? 1 : 0;
      const unknownUsage = exposed - (reported && TOKEN_KEYS.some(key => usage[key] !== null) ? 1 : 0);
      const unknownCost = exposed - (reported && usage.cost !== null ? 1 : 0);
      group.unknownUsageAttempts += unknownUsage; group.unknownCostAttempts += unknownCost;
      if (unknownUsage) group.unknownUsageRequests++;
      if (unknownCost) group.unknownCostRequests++;
      if (!reported) continue;
      if (usage.cost !== null) group.knownCost = (group.knownCost ?? 0) + usage.cost;
      for (const key of TOKEN_KEYS) if (usage[key] !== null) group[key] = (group[key] ?? 0) + usage[key];
    }
  }
  return { basis: 'persistent-request-artifacts', total, byProject, byTask };
}
