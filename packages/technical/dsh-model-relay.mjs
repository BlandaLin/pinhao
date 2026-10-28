import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createTechnicalTransport } from './model-transport.mjs';

const fault = (code, message) => Object.assign(new Error(message), { code });
const contextOverflow = text => /context[_ -]?(?:length[_ -]?)?(?:exceed|overflow|limit)|maximum context|too many (?:input )?tokens|prompt (?:is )?too long|input (?:is )?too long|exceeds? (?:the )?(?:model['’]s? )?(?:context|token)|上下文.{0,16}(?:超|限制)/i.test(text);

/** A job-local model endpoint. Provider credentials never enter the runtime process. */
export async function createDshModelRelay({ connection, requestContext, directory, contentDirectory, signal,
  onWait, onModelPresented, onFailure, diagnostics = false, fetchImpl = fetch, requestTimeoutMs,
  requestTotalTimeoutMs, maxRequestBytes = 32 * 1024 * 1024 } = {}) {
  if (!connection?.baseUrl || !connection?.model || !connection?.apiKey) throw fault('TECHNICAL_CONNECTION_REQUIRED', 'DSH needs a configured technical model connection');
  const upstream = new URL(`${connection.baseUrl.replace(/\/+$/, '')}/chat/completions`);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password) throw fault('TECHNICAL_CONFIGURATION_ERROR', 'Invalid model endpoint');
  const token = randomBytes(32).toString('hex'), controller = new AbortController();
  const lifetime = AbortSignal.any([controller.signal, signal].filter(Boolean));
  const active = new Set(), requests = [], sockets = new Set();
  let lastFailure, closed = false;
  const presentationContext = new AsyncLocalStorage();
  const transport = createTechnicalTransport({ connection, requestContext, directory, contentDirectory,
    secrets: [connection.apiKey, token], diagnostics, signal: lifetime, fetchImpl,
    onWait, onModelPresented: details => { presentationContext.getStore()?.push(details); }, requestTimeoutMs, requestTotalTimeoutMs });
  const safeError = error => String(error?.message ?? error).split(connection.apiKey).join('[redacted]').split(token).join('[redacted]');
  const respondError = (output, error, status = 502) => {
    if (output.destroyed) return;
    if (output.headersSent) { output.destroy(error); return; }
    output.writeHead(status, { 'content-type': 'application/json' });
    output.end(JSON.stringify({ error: { message: safeError(error), type: 'pinhao_runtime_error', code: error.code ?? 'DSH_MODEL_RELAY' } }));
  };
  const handle = async (input, output) => {
    let body, response;
    const startedAt = new Date().toISOString(), call = new AbortController();
    // SDKs can release the HTTP reader at SSE [DONE], before host evidence finishes saving.
    const abort = () => { if (!output.writableEnded && !transport.responseComplete(response)) call.abort(fault('DSH_MODEL_CLIENT_CANCELLED', 'Runtime stopped receiving the model response')); };
    output.on('close', abort);
    try {
      lifetime.throwIfAborted();
      if (input.headers.authorization !== `Bearer ${token}`) return respondError(output, fault('DSH_RELAY_UNAUTHORIZED', 'Invalid job model token'), 401);
      if (input.method !== 'POST' || input.url?.split('?')[0] !== '/v1/chat/completions') return respondError(output, fault('DSH_RELAY_ROUTE', 'Only the configured chat route is available'), 404);
      const chunks = []; let size = 0;
      for await (const chunk of input) {
        size += chunk.length;
        if (size > maxRequestBytes) throw fault('DSH_REQUEST_TOO_LARGE', 'Model request exceeds the local transport limit');
        chunks.push(chunk);
      }
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return respondError(output, fault('DSH_RELAY_JSON', 'Model request must be JSON'), 400); }
      if (body.model !== connection.model || !Array.isArray(body.messages)) return respondError(output, fault('DSH_RELAY_MODEL', 'Runtime model does not match its host connection'), 400);
      // Include usage on streams while preserving the provider's original completion shape.
      if (body.stream) body.stream_options = { ...body.stream_options, include_usage: true };
      const event = { preparedAt: startedAt, model: body.model, streaming: Boolean(body.stream), messages: body.messages.length };
      requests.push(event);
      const presentations = [];
      response = await presentationContext.run(presentations, () => transport.fetch(upstream, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: `Bearer ${connection.apiKey}`,
      }, body: JSON.stringify(body), signal: AbortSignal.any([lifetime, call.signal]) }));
      event.responseAt = new Date().toISOString(); event.statusCode = response.status;
      const overflow = [400, 413, 422].includes(response.status) && contextOverflow(await response.clone().text());
      if (overflow) event.recovery = 'sdk-context-compaction';
      // A host cost gate can reject fetch before the real upstream dispatch.
      // Only an accepted upstream response credits material as model-visible.
      if (response.ok) {
        const present = presentations.at(-1);
        if (present) {
          try { await onModelPresented?.(present); }
          catch (error) { await response.body?.cancel(error); throw error; }
        }
      }
      const headers = {};
      for (const name of ['content-type', 'cache-control', 'x-request-id']) if (response.headers.has(name)) headers[name] = response.headers.get(name);
      output.writeHead(response.status, headers);
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (output.destroyed) {
              if (!transport.responseComplete(response)) { await reader.cancel(call.signal.reason); break; }
              continue;
            }
            if (!output.write(value)) await once(output, 'drain', { signal: AbortSignal.any([lifetime, call.signal]) });
          }
        } finally { reader.releaseLock(); }
      }
      output.end(); event.finishedAt = new Date().toISOString();
      if (!overflow && [400, 401, 402, 403, 404, 405, 413, 422].includes(response.status)) {
        lastFailure = transport.failure() ?? Object.assign(fault('TECHNICAL_CONFIGURATION_ERROR',
          `Technical model connection returned HTTP ${response.status}; the response was saved`), { statusCode: response.status });
        await onFailure?.(lastFailure);
      }
    } catch (error) {
      // Keep the typed host failure so the runner stops rather than buying SDK retries forever.
      lastFailure = error;
      respondError(output, error, error.code === 'ADAPTATION_BUDGET_EXHAUSTED' ? 429 : 502);
      await onFailure?.(error);
    } finally { output.removeListener('close', abort); }
  };
  const server = createServer((input, output) => {
    const pending = handle(input, output); active.add(pending);
    pending.finally(() => active.delete(pending));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const stop = () => { controller.abort(signal?.reason ?? fault('DSH_RELAY_CLOSED', 'Model relay closed')); server.close(); server.closeIdleConnections(); };
  signal?.addEventListener('abort', stop, { once: true });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: token, model: connection.model,
    failure: () => lastFailure ?? transport.failure(), requests: () => structuredClone(requests),
    flush: () => transport.flush(),
    async close() {
      if (closed) return;
      closed = true; signal?.removeEventListener('abort', stop); stop();
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled([...active]);
      return transport.flush();
    },
  };
}
