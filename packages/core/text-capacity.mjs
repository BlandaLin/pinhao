const positive = (value, fallback) => value === undefined || value === null || value === '' ? fallback
  : Number.isSafeInteger(value) && value > 0 ? value : NaN;

/** A planning estimate, not a tokenizer or a provider admission guarantee. */
export function estimateTextTokens(text = '') {
  let ascii = 0, other = 0;
  for (const character of String(text)) {
    if (character.codePointAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3 + other * 1.5);
}

export function textRequestLimits(connection = {}) {
  const contextWindow = positive(connection.contextWindow, 32768);
  const maxOutputTokens = positive(connection.maxOutputTokens, Math.min(4096, Math.floor(contextWindow / 4)));
  if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens >= contextWindow || maxOutputTokens < 1) {
    throw Object.assign(new Error('文字模型上下文和最大输出需要正整数，最大输出必须小于上下文容量。'), { code: 'MODEL_CAPACITY_CONFIGURATION' });
  }
  return { contextWindow, maxOutputTokens,
    // Optional preview assembly budget, not a second admission limit for required material.
    maxCharacters: Math.max(1, Math.floor((contextWindow - maxOutputTokens - 512) / 1.5)), maxUnits: Infinity,
    capacitySource: { contextWindow: connection.contextWindow == null || connection.contextWindow === '' ? 'conservative-default' : 'configured',
      maxOutputTokens: connection.maxOutputTokens == null || connection.maxOutputTokens === '' ? 'conservative-default' : 'configured' },
  };
}

function outputShape(units, role = 'translation') {
  const body = units.reduce((sum, unit) => sum + Math.ceil(Math.max(estimateTextTokens(unit.source),
    role === 'proofreading' ? estimateTextTokens(unit.translation ?? '') : 0) * 1.5), 0);
  const framing = units.reduce((sum, _, index) => sum + estimateTextTokens(`[u${index + 1}]\n`) + 2, 16);
  return { body, framing, full: body + framing };
}

function profileKey({ connection = {}, role = 'translation', targetLanguage = 'zh-Hans' }) {
  let endpoint;
  try {
    endpoint = new URL(connection.baseUrl ?? connection.url);
    if (!['http:', 'https:'].includes(endpoint.protocol) || !connection.model) return;
    endpoint.username = ''; endpoint.password = ''; endpoint.search = ''; endpoint.hash = '';
    endpoint.pathname = endpoint.pathname.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '');
  } catch { return; }
  const limits = textRequestLimits(connection);
  return JSON.stringify([endpoint.toString(), connection.model, connection.reasoning ?? 'auto', role, targetLanguage,
    limits.contextWindow, limits.maxOutputTokens]);
}

/** Ephemeral packing hints, never provider limits or evidence of translation/review quality. */
export function createTextCapacityPlanner({ maxProfiles = 64, maxSamples = 8, minSamples = 3 } = {}) {
  maxProfiles = Math.min(64, positive(maxProfiles, 64) || 64);
  minSamples = Math.max(3, Math.min(8, positive(minSamples, 3) || 3));
  maxSamples = Math.max(minSamples, Math.min(8, positive(maxSamples, 8) || 8));
  const profiles = new Map();
  const get = key => {
    const entry = profiles.get(key);
    if (entry) { profiles.delete(key); profiles.set(key, entry); }
    return entry;
  };
  return {
    observe({ connection, role = 'translation', targetLanguage, units = [], outputTokens, complete, validated, finishReason, truncated = false }) {
      const failed = truncated === true || finishReason === 'length';
      if (!failed && !(complete === true && validated === true && finishReason === 'stop'
          && Number.isSafeInteger(outputTokens) && outputTokens > 0 && units.length)) return false;
      const key = profileKey({ connection, role, targetLanguage });
      if (!key) return false;
      const entry = get(key) ?? { samples: [], boost: 1 };
      if (failed) {
        entry.boost *= Math.max(1, ...entry.samples) * 1.25;
        entry.samples = [];
      }
      else {
        entry.samples.push(outputTokens / Math.max(1, outputShape(units, role).full));
        if (entry.samples.length > maxSamples) entry.samples.shift();
      }
      profiles.set(key, entry);
      if (profiles.size > maxProfiles) profiles.delete(profiles.keys().next().value);
      return true;
    },
    estimate({ connection, role = 'translation', targetLanguage, units = [] }) {
      const shape = outputShape(units, role), key = profileKey({ connection, role, targetLanguage }), entry = key && get(key);
      if (!entry || entry.samples.length < minSamples) return Math.ceil(shape.full * (entry?.boost ?? 1) + (entry?.boost > 1 ? 32 : 0));
      const floor = shape.framing + shape.body * (role === 'proofreading' ? 0.5 : 0.75);
      const highWater = shape.full * Math.max(...entry.samples) * 1.25;
      return Math.ceil(Math.max(floor, highWater) * entry.boost + 32);
    },
  };
}

export function textRequestEstimate(prompt, units, limits, { role = 'translation', connection, targetLanguage, capacityPlanner, fullRevision = false } = {}) {
  const estimatedInputTokens = estimateTextRequestInput(prompt);
  const shape = outputShape(units, role);
  // Only the differential review protocol may use learned sparse-edit output sizes.
  const planner = role !== 'proofreading' || prompt.responseProtocol ? capacityPlanner : undefined;
  const planned = planner ? planner.estimate({ units, role, targetLanguage,
    connection: { ...connection, contextWindow: limits.contextWindow, maxOutputTokens: limits.maxOutputTokens } }) : shape.full;
  const estimatedOutputTokens = Math.max(fullRevision ? shape.full : 0, planned);
  const reasoningReserve = Math.max(256, Math.ceil(limits.maxOutputTokens / 4));
  return { estimatedInputTokens, estimatedOutputTokens, estimatedFullOutputTokens: shape.full, reasoningReserve,
    overLimit: estimatedInputTokens + limits.maxOutputTokens > limits.contextWindow
      || estimatedOutputTokens + reasoningReserve > limits.maxOutputTokens };
}

export function textGroupCapacityError(units, estimate, capacity) {
  return Object.assign(new Error('一个完整文字或同步显示组超出本次模型容量估算，尚未发送。请调整模型容量或为该组安排协调处理；软件不会拆碎正文。'), {
    code: 'TEXT_GROUP_CAPACITY_EXCEEDED', category: 'model_capacity', unitIds: units.map(unit => unit.id),
    estimatedInputTokens: estimate.estimatedInputTokens, estimatedOutputTokens: estimate.estimatedOutputTokens,
    reasons: [
      ...(estimate.estimatedInputTokens + capacity.maxOutputTokens > capacity.contextWindow ? ['input-context'] : []),
      ...(estimate.estimatedOutputTokens + estimate.reasoningReserve > capacity.maxOutputTokens ? ['complete-output'] : []),
    ],
    capacity: { contextWindow: capacity.contextWindow, maxOutputTokens: capacity.maxOutputTokens, source: capacity.capacitySource },
  });
}

function estimateTextRequestInput({ system = '', prompt = '', messages } = {}) {
  const projected = messages ?? [{ role: 'system', content: system }, { role: 'user', content: prompt }];
  return estimateTextTokens(JSON.stringify(projected)) + 128;
}

/** Check the final message projection, including required evidence and repair instructions. */
export function assertTextRequestCapacity({ connection, system = '', prompt = '', messages, unitIds = [] } = {}) {
  const capacity = textRequestLimits(connection);
  const estimatedInputTokens = estimateTextRequestInput({ system, prompt, messages });
  if (estimatedInputTokens + capacity.maxOutputTokens > capacity.contextWindow) {
    throw Object.assign(new Error('本次完整文字材料与必要证据超出模型容量估算，尚未发送。已保留上下文和成果，请调整容量或重新安排完整目标后继续。'), {
      code: 'TEXT_REQUEST_CAPACITY_EXCEEDED', category: 'model_capacity', fetchStarted: false, transportRequests: 0,
      estimatedInputTokens, contextWindow: capacity.contextWindow, maxOutputTokens: capacity.maxOutputTokens,
      capacitySource: capacity.capacitySource, unitIds: [...unitIds],
    });
  }
  return { estimatedInputTokens, ...capacity };
}
