import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createRequestArtifact } from '../core/request-artifacts.mjs';
import { rejectsStream, rejectsCeiling, fieldRejected, markFieldRejected, modelCompatibilityKey, modelConnectionKey, sharedCooldown, acquireModelRequestSlot } from '../core/provider.mjs';
import { providerCapacityFailure } from '../core/request-recovery.mjs';
import { recordUsage } from '../core/usage.mjs';
import { applyModelReasoning } from '../core/model-reasoning.mjs';

const stamp = () => new Date().toISOString();
const isJson = response => /^application\/(?:[^;]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '');

// A fuse, not a cost knob: adapter code inside tool-call arguments makes step length unpredictable,
// so this only stops a step stuck generating forever and never shapes a real one. Hosts that refuse
// the field are remembered per endpoint/model, shared with the translation path.
const OUTPUT_TOKEN_LIMIT = 65536;
const BACKOFF_STATUS = [429, 500, 502, 503, 504];

// Chat requests get an explicit fuse; other bodies (and callers that already declared one) pass through.
// Only an explicit user choice changes reasoning; default requests retain the model's behavior.
function withOutputCeiling(input, host, connection) {
  const plain = { input, ceiling: false };
  if (typeof input?.body !== 'string') return plain;
  let body;
  try { body = JSON.parse(input.body); } catch { return plain; }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.messages)) return plain;
  const next = applyModelReasoning({ ...body }, connection);
  let ceiling = false;
  if (next.max_tokens === undefined && next.max_completion_tokens === undefined && !fieldRejected(host, 'ceiling')) {
    next.max_tokens = OUTPUT_TOKEN_LIMIT; ceiling = true;
  }
  if (!ceiling && next.reasoning === body.reasoning && next.thinking === body.thinking) return plain;
  return { input: { ...input, body: JSON.stringify(next) }, ceiling };
}

async function abortable(operation, signal) {
  signal.throwIfAborted();
  let aborted;
  try {
    // A fetch implementation can abort synchronously before returning its rejected
    // promise. Install both consumers before creating the fetch/read operation.
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), new Promise((_, reject) => {
      aborted = () => reject(signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', aborted); }
}

/** Capture HTTP evidence without charging local persistence time to the network deadline. */
// Observed technical requests need ~130s of silence-tolerant waiting; a 120s idle window killed them
// just before they answered. The idle window is the deadlock guard, the total caps one stream.
export function createTechnicalTransport({ directory, contentDirectory, connection, requestContext, secrets = [], diagnostics = false, signal: signalForCall, fetchImpl = fetch,
  role = 'technical', model, onWait, onModelPresented, requestTimeoutMs = 300000, requestTotalTimeoutMs = 900000, artifactFactory = createRequestArtifact } = {}) {
  for (const value of [requestTimeoutMs, requestTotalTimeoutMs]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('技术模型请求超时需要有效的毫秒数');
  const pending = new Set(), records = [], responseCompletions = new WeakMap();
  let lastFailure, persistenceError;
  const send = async (url, input, key, retryOf) => {
    if (persistenceError) throw persistenceError;
    const preparationStartedAt = stamp(), completion = Promise.withResolvers();
    pending.add(completion.promise);
    let material = input.body, artifact, reader, idleTimer, totalTimer, releaseSlot, settled = false, captureError, headersReceived = false;
    let receivedBytes = 0, tail = '', finishReason, streaming = false, statusCode, wireUsage, upstreamFailure, firstToolAt;
    const httpAttemptId = `technical-${randomUUID()}`, responseCompletion = { complete: false };
    let context, reservation, fetchStarted = false;
    const decoder = new TextDecoder(), controller = new AbortController(), writes = new Set(), toolCalls = new Map();
    const callerSignal = typeof signalForCall === 'function' ? signalForCall() : signalForCall;
    const signal = AbortSignal.any([controller.signal, input.signal, callerSignal].filter(Boolean));
    try { if (typeof material === 'string') material = JSON.parse(material); } catch {}
    const observe = event => {
      // Timestamp at the event, before queued disk writes or unrelated progress callbacks.
      const write = artifact?.observe({ at: stamp(), ...event });
      if (write) { writes.add(write); write.then(() => writes.delete(write), error => { captureError ??= error; writes.delete(write); }); }
    };
    const cleanup = () => { clearTimeout(idleTimer); clearTimeout(totalTimer); signal.removeEventListener('abort', onAbort); };
    const complete = async error => {
      if (settled) return completion.promise;
      settled = true; cleanup();
      // Billing is recorded once per send, in the shared shape every channel uses. A failed attempt
      // already paid for its prompt, so its usage is kept too.
      if (wireUsage) recordUsage({ role, model: material?.model ?? model, usage: wireUsage, outcome: error ? 'failed' : 'succeeded' });
      let reference;
      try {
        if (toolCalls.size) observe({ type: 'tool-calls', at: firstToolAt, calls: [...toolCalls.values()] });
        await Promise.allSettled([...writes]);
        const metadata = { statusCode, finishReason, receivedBytes, fetchStarted, ...(wireUsage ? { usage: wireUsage } : {}) };
        const failure = error ?? captureError;
        if (artifact) {
          reference = failure ? await artifact.fail({ name: failure.name, message: failure.message, code: failure.code, category: failure.category, phase: failure.phase, ...metadata }) : await artifact.finish(metadata);
          records.push(reference);
        }
      } catch (error) { persistenceError ??= error; }
      finally {
        try {
          if (reservation) context.owner.settle(httpAttemptId, { fetchStarted,
            outcome: error || captureError || statusCode >= 400 ? 'failed' : 'succeeded',
            usage: wireUsage, statusCode, finishReason, artifact: reference?.id, error: error ?? captureError });
        } catch (error) { persistenceError ??= error; }
        releaseSlot?.(); pending.delete(completion.promise); completion.resolve();
      }
    };
    const onAbort = () => {
      if (controller.signal.aborted) lastFailure = upstreamFailure ?? controller.signal.reason;
      reader?.cancel(signal.reason).catch(() => {});
      void complete(signal.reason);
    };
    const expire = phase => {
      const error = Object.assign(new Error(phase === 'total' ? '技术模型单次请求达到总时限，已保存进度' : '技术模型响应等待超时，已保存进度'),
        { code: 'TECHNICAL_REQUEST_TIMEOUT', phase, requestTimeoutMs, requestTotalTimeoutMs });
      controller.abort(error);
    };
    const refreshIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => expire(headersReceived ? 'body-idle' : 'headers'), requestTimeoutMs);
      idleTimer.unref?.();
    };
    const observeFinish = (choice, response) => {
      finishReason = choice?.finish_reason ?? finishReason;
      if (choice?.finish_reason !== 'error' || upstreamFailure) return;
      const detail = response.error ?? choice.error;
      upstreamFailure = Object.assign(new Error(`技术模型接口返回错误，未完成本次响应，已保存进度${detail?.message ? `：${detail.message}` : ''}`),
        { code: 'MODEL_UPSTREAM_ERROR', finishReason: 'error', statusCode, ...(detail ? { providerError: detail } : {}) });
      lastFailure = upstreamFailure;
      observe({ type: 'upstream-error', error: { code: upstreamFailure.code, message: upstreamFailure.message, finishReason: 'error', ...(detail ? { providerError: detail } : {}) } });
    };
    const consumeToolCalls = calls => {
      for (const [position, part] of (calls ?? []).entries()) {
        firstToolAt ??= stamp();
        const index = part.index ?? position;
        const call = toolCalls.get(index) ?? { index, function: { name: '', arguments: '' } };
        if (part.id) call.id = part.id;
        if (part.type) call.type = part.type;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
        toolCalls.set(index, call);
      }
    };
    const consumeLine = line => {
      if (line.trim() === 'data: [DONE]') { responseCompletion.complete = true; return; }
      if (!line.startsWith('data:')) return;
      try {
        const event = JSON.parse(line.slice(5)), choice = event.choices?.[0];
        if (event.usage) wireUsage = event.usage;
        if (choice?.delta?.content) observe({ type: 'text-delta', text: choice.delta.content });
        if (choice?.delta?.reasoning_content) observe({ type: 'reasoning-delta', text: choice.delta.reasoning_content });
        consumeToolCalls(choice?.delta?.tool_calls);
        observeFinish(choice, event);
      } catch { /* The SDK reports malformed response data. */ }
    };
    const capture = (text, final = false) => {
      // Billing and finish reason are read even without an artifact directory: usage accounting must
      // not depend on whether request evidence was persisted for this call.
      if (text) observe({ type: 'raw-chunk', index: 1, text });
      tail += text;
      if (streaming) {
        let end;
        while ((end = tail.indexOf('\n')) >= 0) { consumeLine(tail.slice(0, end)); tail = tail.slice(end + 1); }
        if (final && tail) consumeLine(tail);
      } else if (final) {
        try {
          const completion = JSON.parse(tail), choice = completion.choices?.[0];
          if (completion.usage) wireUsage = completion.usage;
          if (choice?.message?.content) observe({ type: 'text-delta', text: choice.message.content });
          if (choice?.message?.reasoning_content) observe({ type: 'reasoning-delta', text: choice.message.reasoning_content });
          consumeToolCalls(choice?.message?.tool_calls);
          observeFinish(choice, completion);
        } catch { /* The SDK reports malformed response data. */ }
      }
    };
    try {
      signal.throwIfAborted();
      let waited = false;
      releaseSlot = await acquireModelRequestSlot({ key, signal, onWait: notice => { waited = true; return onWait?.({ phase: 'waiting-provider', ...notice }); } });
      if (waited) await onWait?.({ phase: 'requesting', retryAfterMs: 0 });
      context = typeof requestContext === 'function' ? requestContext() : requestContext;
      if (context?.owner) {
        const identity = context.owner.snapshot();
        if (context.projectId !== undefined && context.projectId !== identity.projectId
            || context.adaptationRequestId !== undefined && context.adaptationRequestId !== identity.adaptationRequestId) throw new Error('Technical HTTP budget owner does not match the host request');
        reservation = context.owner.reserve({ ...context, httpAttemptId, retryOf: retryOf ?? context.retryOf,
          artifactDirectory: directory ? path.join(directory, httpAttemptId) : undefined });
      }
      artifact = directory ? await artifactFactory({ directory, contentDirectory, requestId: httpAttemptId, requestContext: reservation,
        request: { preparationStartedAt, url: String(url), body: material }, secrets, diagnostics }) : null;
      signal.throwIfAborted();
      observe({ type: 'prepared' });
      signal.addEventListener('abort', onAbort, { once: true });
      lastFailure = undefined;
      observe({ type: 'send', index: 1, url: String(url), body: material });
      refreshIdle();
      totalTimer = setTimeout(() => expire('total'), requestTotalTimeoutMs); totalTimer.unref?.();
      if (reservation) context.owner.markSent(httpAttemptId);
      let response = await abortable(async () => {
        fetchStarted = true;
        const sent = fetchImpl(url, { ...input, signal });
        const presented = onModelPresented?.({ modelRequestId: httpAttemptId, messages: material?.messages ?? [] });
        return (await Promise.all([sent, presented]))[0];
      }, signal);
      statusCode = response.status;
      headersReceived = true; refreshIdle();
      observe({ type: 'headers', statusCode: response.status, requestId: response.headers.get('x-request-id') });
      streaming = response.headers.get('content-type')?.includes('text/event-stream');
      if (!response.body) { responseCompletion.complete = true; observe({ type: 'body-end', receivedBytes }); await complete(); return { response, httpAttemptId, responseCompletion }; }
      reader = response.body.getReader();
      const body = new ReadableStream({
        async pull(output) {
          try {
            const { value, done } = await abortable(() => reader.read(), signal);
            if (done) {
              capture(decoder.decode(), true); responseCompletion.complete = true; observe({ type: 'body-end', receivedBytes });
              await complete(upstreamFailure);
              if (upstreamFailure) output.error(upstreamFailure); else output.close();
              return;
            }
            if (value.byteLength) {
              if (!receivedBytes) observe({ type: 'body-start' });
              receivedBytes += value.byteLength; refreshIdle();
            }
            capture(decoder.decode(value, { stream: true }));
            output.enqueue(value);
          } catch (error) { await complete(error); output.error(error); }
        },
        cancel(reason) { const error = upstreamFailure ?? (reason instanceof Error ? reason : new Error('技术模型请求已取消')); controller.abort(error); return reader.cancel(reason).catch(() => {}); },
      });
      response = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      return { response, httpAttemptId, responseCompletion };
    } catch (error) { await complete(error); throw error; }
  };
  const request = async (url, input = {}) => {
    let material; try { material = JSON.parse(input.body); } catch {}
    const host = modelCompatibilityKey({ baseUrl: connection?.baseUrl ?? url, model: material?.model ?? connection?.model ?? model });
    const key = modelConnectionKey({ url, model: material?.model ?? model, apiKey: secrets[0] });
    // The same backoff the translation channel obeys: a technical or recollection request waits
    // behind a 429 that any channel on this connection already recorded.
    let prepared = withOutputCeiling(input, host, connection);
    let sent = await send(url, prepared.input, key), response = sent.response;
    // An endpoint/model may refuse the fuse: drop it, remember that identity, and retry
    // exactly as provider.mjs does.
    for (let removed = 0; removed < 1 && [400, 422].includes(response.status); removed++) {
      const text = await response.clone().text();
      const rejected = prepared.ceiling && rejectsCeiling(text) ? 'ceiling' : undefined;
      if (!rejected) break;
      markFieldRejected(host, rejected);
      prepared = withOutputCeiling(input, host, connection);
      sent = await send(url, prepared.input, key, sent.httpAttemptId); response = sent.response;
    }
    if (response.status === 402) {
      const failure = providerCapacityFailure({ statusCode: response.status, responseHeaders: response.headers, body: await response.clone().text() });
      if (failure) { lastFailure = failure; sharedCooldown.defer(key, failure); }
    }
    if (BACKOFF_STATUS.includes(response.status)) sharedCooldown.defer(key, { responseHeaders: new Headers(response.headers) });
    if (material?.stream && [400, 422].includes(response.status)) {
      const text = await response.text();
      if (rejectsStream(text)) {
        const fallback = { ...material, stream: false }; delete fallback.stream_options;
        sent = await send(url, withOutputCeiling({ ...input, body: JSON.stringify(fallback) }, host, connection).input, key, sent.httpAttemptId); response = sent.response;
      } else response = new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    // A compatible server may return its successful JSON completion despite stream:true.
    // Reuse that response rather than issuing the model request a second time.
    if (material?.stream && response.ok && isJson(response)) {
      const completion = await response.json();
      const chunk = { ...completion, object: 'chat.completion.chunk', choices: completion.choices?.map(({ message, ...choice }) => ({ ...choice, delta: message ?? {}, finish_reason: choice.finish_reason ?? 'unknown' })) };
      const headers = new Headers(response.headers);
      headers.set('content-type', 'text/event-stream'); headers.delete('content-length'); headers.delete('content-encoding');
      response = new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: response.status, headers });
    }
    responseCompletions.set(response, sent.responseCompletion);
    return response;
  };
  return { fetch: request, responseComplete: response => responseCompletions.get(response)?.complete === true,
    failure: () => lastFailure, flush: async () => { await Promise.all([...pending]); if (persistenceError) throw persistenceError; return [...records]; } };
}
