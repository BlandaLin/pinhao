import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderLessons } from './lessons.mjs';

const fault = (code, message) => Object.assign(new Error(message), { code });
const terminal = status => !['running', 'starting', 'queued'].includes(status);

/** Job-local transport; all writes and receipts remain in the business bridge. */
export async function createDshRuntimeBridgeServer({ bridge, state, signal, persist, lab, project,
  gameDir, workspaceDir, getLessons = () => [], onFatal = () => {}, initialWaitMs = 1000, heartbeatMs = 15000 }) {
  const token = randomBytes(32).toString('hex'), sockets = new Set(), active = new Set();
  const pendingRuns = state.backend.pendingRuns ??= {};
  let closed = false;
  const rememberPage = async (row, result, input = {}) => {
    if ((input.cursor ?? 0) === (row.cursor ?? 0) && Number.isSafeInteger(result.nextCursor)) row.cursor = result.nextCursor;
    row.captureGeneration = result.captureGeneration ?? row.captureGeneration;
    row.previousOutput = { evidenceId: result.evidenceId, receiptId: result.receiptId,
      ...(result.nextCall ? { nextCall: result.nextCall } : {}) };
    if (terminal(result.status)) row.completionEvidence = { evidenceId: result.evidenceId, receiptId: result.receiptId };
    await persist(state);
  };
  const execute = async envelope => {
    const result = await bridge.execute(envelope);
    if (result.hostFailure || ['ADAPTATION_BUDGET_EXHAUSTED', 'WORKSPACE_EXECUTION_AUTH_REQUIRED',
      'TECHNICAL_CONNECTION_REQUIRED', 'TECHNICAL_CONFIGURATION_ERROR'].includes(result.error?.code)) {
      onFatal(Object.assign(fault(result.error?.code ?? 'DSH_HOST_FAILURE', result.error?.message ?? 'The host cannot continue this operation'),
        { hostFailure: Boolean(result.hostFailure) }));
    }
    if (['read_run', 'wait_run'].includes(envelope.toolName) && pendingRuns[result.runId]) await rememberPage(pendingRuns[result.runId], result, envelope.arguments);
    if (envelope.toolName !== 'run_workspace' || !result.runId || terminal(result.status)) return result;
    const wait = await bridge.allocateCall({ toolCallId: `${envelope.toolCallId}:initial-wait`,
      rootToolCallId: envelope.rootToolCallId, callScope: envelope.callScope, toolName: 'wait_run',
      arguments: { runId: result.runId, waitMs: initialWaitMs } });
    const observed = await bridge.execute(wait);
    if (!terminal(observed.status)) {
      pendingRuns[result.runId] ??= { runId: result.runId, toolCallId: envelope.toolCallId, callScope: envelope.callScope, createdAt: new Date().toISOString() };
      await rememberPage(pendingRuns[result.runId], observed);
    }
    return { ...observed, hostInitialWait: true };
  };
  const handle = async (input, output) => {
    let heartbeat, streamingExecute = false;
    const stopHeartbeat = () => { if (heartbeat) clearInterval(heartbeat); heartbeat = undefined; };
    try {
      signal?.throwIfAborted();
      if (closed || input.headers.authorization !== `Bearer ${token}`) throw fault('DSH_BRIDGE_UNAUTHORIZED', 'Invalid runtime tool token');
      let body;
      if (input.method === 'POST') {
        const chunks = []; let length = 0;
        for await (const chunk of input) { length += chunk.length; if (length > 2 * 1024 * 1024) throw fault('DSH_BRIDGE_REQUEST_SIZE', 'Tool request exceeds protocol limit'); chunks.push(chunk); }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
      let value;
      if (input.url === '/definitions' && input.method === 'GET') value = bridge.definitions();
      else if (input.url === '/status' && input.method === 'GET') value = { done: bridge.session.done(), lessons: renderLessons(getLessons()) };
      else if (input.url === '/restored' && input.method === 'POST') {
        if (body.sessionId !== bridge.binding.sessionId || !['startup', 'resume'].includes(body.source)) throw fault('DSH_BRIDGE_IDENTITY', 'Unexpected restored session');
        state.backend.restoredSession = { ...body, observedAt: new Date().toISOString() };
        await persist(state); value = { recorded: true };
      }
      else if (input.url === '/runtime-manifest' && input.method === 'POST') {
        if (body.sessionId !== bridge.binding.sessionId || !Array.isArray(body.modules)) throw fault('DSH_BRIDGE_IDENTITY', 'Invalid runtime inventory');
        const file = path.join(state.backend.runtimeHome, `runtime-manifest-${state.executionWindow}.json`);
        const bytes = JSON.stringify(body, null, 2);
        await writeFile(file, bytes);
        state.backend.runtimeManifest = { path: file, sha256: createHash('sha256').update(bytes).digest('hex'),
          moduleCount: body.modules.length, toolCount: body.registeredTools.length, observedAt: new Date().toISOString() };
        await persist(state); value = { recorded: true };
      }
      else if (input.url === '/allocate' && input.method === 'POST') {
        if (body.sessionId !== bridge.binding.sessionId) throw fault('DSH_BRIDGE_IDENTITY', 'Wrong runtime session');
        value = await bridge.allocateCall(body);
      } else if (input.url === '/execute' && input.method === 'POST') {
        // JSON whitespace keeps the local fetch alive without becoming a tool result.
        streamingExecute = true; output.writeHead(200, { 'content-type': 'application/json' }); output.flushHeaders();
        heartbeat = setInterval(() => { if (!output.destroyed && !output.writableEnded) output.write(' '); }, heartbeatMs);
        heartbeat.unref(); output.once('close', stopHeartbeat);
        value = await execute(body);
      }
      else throw fault('DSH_BRIDGE_ROUTE', 'Unknown business bridge route');
      if (!output.headersSent) output.writeHead(200, { 'content-type': 'application/json' });
      if (!output.destroyed) output.end(JSON.stringify(streamingExecute ? { ok: true, result: value } : value));
    } catch (error) {
      if (error.hostFailure || ['ADAPTATION_BUDGET_EXHAUSTED', 'WORKSPACE_EXECUTION_AUTH_REQUIRED'].includes(error.code)) onFatal(error);
      if (!output.destroyed) {
        if (!output.headersSent) output.writeHead(error.code === 'DSH_BRIDGE_UNAUTHORIZED' ? 401 : 400, { 'content-type': 'application/json' });
        const failure = { code: error.code ?? 'DSH_BRIDGE_ERROR', message: String(error.message), ...(error.details ? { details: error.details } : {}) };
        output.end(JSON.stringify(streamingExecute ? { ok: false, error: failure } : { error: failure }));
      }
    } finally {
      stopHeartbeat(); output.removeListener('close', stopHeartbeat);
    }
  };
  const server = createServer((input, output) => { const task = handle(input, output); active.add(task); task.finally(() => active.delete(task)); });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  return {
    url: `http://127.0.0.1:${server.address().port}`, token,
    async completedRuns({ wait = false } = {}) {
      const results = [];
      for (const row of Object.values(pendingRuns)) {
        signal?.throwIfAborted();
        if (row.delivered) continue;
        // Poll the same owned process. Only its final observation enters the
        // durable tool journal; waiting never restarts the script.
        const view = await lab.waitRun({ projectId: project.id, gameDir, workDir: workspaceDir,
          runId: row.runId, waitMs: wait ? 1000 : 0, signal });
        if (!terminal(view.status)) continue;
        row.completionRead ??= { runId: row.runId, cursor: row.cursor ?? 0,
          ...(row.captureGeneration ? { expectedCaptureGeneration: row.captureGeneration } : {}) };
        const envelope = await bridge.allocateCall({ toolCallId: `${row.toolCallId}:completion`, rootToolCallId: null,
          callScope: row.callScope, toolName: 'read_run', arguments: row.completionRead });
        const result = await bridge.execute(envelope);
        row.completionEvidence = { evidenceId: result.evidenceId, receiptId: result.receiptId };
        await persist(state);
        results.push({ notificationId: `process-${row.runId}`, runId: row.runId,
          ...(row.previousOutput ? { previousOutput: row.previousOutput } : {}), result });
      }
      return results;
    },
    hasPendingRuns: () => Object.values(pendingRuns).some(row => !row.delivered),
    async modelPresented({ modelRequestId, messages }) {
      const wireMessages = messages.map(message => ({ role: message.role, content: JSON.stringify(message.content) }));
      let changed = false;
      for (const row of Object.values(pendingRuns)) {
        const evidence = row.completionEvidence;
        if (!row.delivered && evidence?.evidenceId && evidence?.receiptId && wireMessages.some(wire =>
          (wire.role === 'tool' || wire.content.includes(`process-${row.runId}`))
            && wire.content.includes(evidence.evidenceId) && wire.content.includes(evidence.receiptId))) {
          row.delivered = true; row.delivery = 'terminal-evidence-reference-dispatched';
          row.modelRequestId = modelRequestId; row.dispatchedAt = new Date().toISOString(); changed = true;
        }
      }
      if (changed) await persist(state);
    },
    async close() {
      if (closed) return; closed = true;
      server.close(); server.closeIdleConnections();
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled([...active]);
    },
  };
}
