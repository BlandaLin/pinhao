import { setTimeout as delay } from 'node:timers/promises';

/** A temporary provider reservation limit is not an ordinary exhausted-credit response. */
export function providerCapacityFailure({ statusCode, body, responseHeaders } = {}) {
  if (statusCode !== 402) return;
  let parsed = body;
  try { if (typeof parsed === 'string') parsed = JSON.parse(parsed); } catch { return; }
  const detail = parsed?.error;
  if (detail?.metadata?.reason !== 'in_flight_budget_exhausted') return;
  const headers = new Headers(responseHeaders);
  const fallback = Object.entries(detail.metadata.headers ?? {}).find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
  if (!headers.has('retry-after') && fallback !== undefined) headers.set('retry-after', String(fallback));
  const timing = providerFailure({ responseHeaders: headers });
  return Object.assign(new Error('模型接口暂时达到在途请求预算；等待现有请求完成后可从已保存进度继续'), {
    code: 'PROVIDER_CAPACITY', category: 'provider_capacity', statusCode,
    providerReason: detail.metadata.reason, responseHeaders: headers,
    ...(timing.retryAfterMs !== undefined ? { retryAfterMs: timing.retryAfterMs } : {}),
  });
}

export function providerFailure(error, time = Date.now()) {
  const chain = [];
  for (let value = error; value && !chain.includes(value); value = value.cause) chain.push(value);
  const get = name => chain.find(value => value[name] !== undefined)?.[name];
  const headers = get('responseHeaders') ?? get('headers');
  const retry = headers?.get?.('retry-after') ?? Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
  const numeric = retry !== undefined && /^\s*\d+(?:\.\d+)?\s*$/.test(String(retry)) ? Number(retry) * 1000 : NaN;
  const retryAfterMs = get('retryAfterMs') ?? (Number.isFinite(numeric) ? numeric : Math.max(0, Date.parse(retry) - time));
  return {
    ...(get('code') ? { code: get('code') } : {}),
    ...(get('category') ? { category: get('category') } : {}),
    ...(get('providerReason') ? { providerReason: get('providerReason') } : {}),
    ...(get('finishReason') ? { finishReason: get('finishReason') } : {}),
    ...(get('usage') ? { usage: get('usage') } : {}),
    ...(get('rawUsage') ? { rawUsage: get('rawUsage') } : {}),
    ...(get('requestId') ? { requestId: String(get('requestId')).slice(0, 200) } : {}),
    ...(Number.isFinite(get('transportRequests')) ? { transportRequests: get('transportRequests') } : {}),
    ...(typeof get('fetchStarted') === 'boolean' ? { fetchStarted: get('fetchStarted') } : {}),
    ...(Number.isFinite(get('textCharacters')) ? { textCharacters: get('textCharacters') } : {}),
    ...(Number.isFinite(get('reasoningCharacters')) ? { reasoningCharacters: get('reasoningCharacters') } : {}),
    ...(Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
  };
}

/** Temporary delivery failures are not authentication, credit or local safety failures. */
export function isTransientRequestFailure(error) {
  const chain = [];
  for (let value = error; value && !chain.includes(value); value = value.cause) chain.push(value);
  const code = chain.find(value => value.code)?.code;
  const status = chain.find(value => value.statusCode ?? value.status);
  const statusCode = status?.statusCode ?? status?.status;
  if (code === 'PROVIDER_CAPACITY') return true;
  if (statusCode !== undefined) return statusCode === 408 || statusCode === 429 || statusCode >= 500 && statusCode < 600;
  if (['EACCES', 'EPERM', 'ENOSPC', 'EDQUOT', 'EROFS', 'ABORT_ERR', 'ERR_MODULE_NOT_FOUND',
    'INVALID_RESPONSE', 'INVALID_REVIEW', 'REVISION_CONFLICT', 'PRESEND_STALE', 'READ_NO_PROGRESS'].includes(code)
    || code?.startsWith?.('MODEL_')) return false;
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE',
    'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)
    || chain.some(value => value.name === 'TimeoutError'
      || /fetch failed|network|timed? ?out|timeout|terminated|response stream ended without a finish reason|cannot connect to API/i.test(value.message ?? ''));
}

export function createRequestCooldown({ clock = Date.now, sleep = delay } = {}) {
  const deadlines = new Map();
  return {
    remaining: key => Math.max(0, (deadlines.get(key) ?? 0) - clock()),
    defer(key, error, attempt = 0) {
      const { retryAfterMs } = providerFailure(error, clock());
      const milliseconds = Math.max(retryAfterMs ?? 0, Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)));
      deadlines.set(key, Math.max(deadlines.get(key) ?? 0, clock() + milliseconds));
      return milliseconds;
    },
    async wait(key, signal) {
      while ((deadlines.get(key) ?? 0) > clock()) {
        signal?.throwIfAborted();
        await sleep(Math.min(60_000, deadlines.get(key) - clock()), undefined, { signal });
      }
      signal?.throwIfAborted();
    },
  };
}
