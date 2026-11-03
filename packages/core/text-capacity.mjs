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

export function textOutputShape(units, role = 'translation', startIndex = 0) {
  const body = units.reduce((sum, unit) => sum + Math.ceil(Math.max(estimateTextTokens(unit.source),
    role === 'proofreading' ? estimateTextTokens(unit.translation ?? '') : 0) * 1.5), 0);
  const framing = units.reduce((sum, _, index) => sum + estimateTextTokens(`[u${startIndex + index + 1}]\n`) + 2, 16);
  return { body, framing, full: body + framing };
}

export function textRequestEstimate(prompt, units, limits, { role = 'translation' } = {}) {
  const estimatedInputTokens = estimateTextRequestInput(prompt);
  const shape = textOutputShape(units, role);
  // Total billed output includes reasoning and is not a per-unit text-size sample.
  const estimatedOutputTokens = shape.full;
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
