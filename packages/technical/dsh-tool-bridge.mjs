import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fromJSONSchema } from 'zod';
import { adaptationTools } from './adaptation.mjs';
import { createEvidenceStore } from './adaptation/evidence.mjs';
import { boundedToolOutput } from './adaptation/tool-output.mjs';
import { discoverAcceptedBatches, readAcceptedBatch } from '../core/accepted-batches.mjs';

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, item[key]])) : item);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const fault = (code, message, details) => Object.assign(new Error(message), { code, details });
const identityFields = ['projectId', 'adaptationRequestId', 'jobId', 'jobExecutionId', 'sessionId'];
const readOnlyTools = new Set(['inspect_context', 'inspect_coverage', 'inspect_units', 'list_files', 'search_files',
  'read_resource', 'read_adapter', 'read_evidence', 'read_failure', 'list_recipes', 'search_public', 'read_public', 'read_run', 'wait_run']);
export const isDshReadOnlyTool = name => readOnlyTools.has(name);

/** The host owns operation identities. DSH is only a caller of the existing business tools. */
export async function createDshToolBridge(options) {
  const { binding, state, workspaceDir, persist = async () => {} } = options;
  if (identityFields.some(key => typeof binding?.[key] !== 'string' || !binding[key])) throw fault('DSH_BRIDGE_IDENTITY', 'Incomplete runtime binding');
  if (binding.projectId !== options.project.id || binding.jobId !== (options.assignment?.id ?? options.requestContext?.jobId ?? 'coordinator')
      || binding.adaptationRequestId !== (options.requestContext?.adaptationRequestId ?? 'local')) throw fault('DSH_BRIDGE_IDENTITY', 'Runtime binding does not match the host assignment');
  const identity = Object.fromEntries(identityFields.map(key => [key, binding[key]]));
  if (state.dshToolBridge && digest(state.dshToolBridge.binding) !== digest(identity)) throw fault('DSH_BRIDGE_IDENTITY', 'Saved operation journal belongs to another runtime execution');
  const journal = state.dshToolBridge ??= { version: 1, binding: identity, calls: {}, operations: {} };
  const session = adaptationTools({ ...options, runtimePolicy: 'external' });
  const evidence = createEvidenceStore(workspaceDir), inFlight = new Map(), validators = new Map();
  let queue = Promise.resolve(), closed = false;
  const commit = fn => { const action = queue.then(fn); queue = action.catch(() => {}); return action; };
  const definitions = Object.entries(session.tools).map(([name, tool]) => ({ name, description: tool.description, concurrencySafe: readOnlyTools.has(name),
    parameters: structuredClone(tool.inputSchema.jsonSchema) }));
  for (const definition of definitions) validators.set(definition.name, fromJSONSchema(definition.parameters));
  const argumentsFor = async row => (await evidence.load(row.inputEvidenceId)).value;
  const envelopeFor = async row => ({ ...identity, operationId: row.operationId, toolCallId: row.toolCallId,
    rootToolCallId: row.rootToolCallId, callScope: row.callScope, toolName: row.toolName, arguments: await argumentsFor(row) });
  const check = envelope => {
    if (identityFields.some(key => envelope?.[key] !== identity[key])) throw fault('DSH_BRIDGE_IDENTITY', 'Tool call belongs to another job or session');
    const row = journal.operations[envelope.operationId];
    if (!row || row.toolCallId !== envelope.toolCallId || row.rootToolCallId !== envelope.rootToolCallId || row.callScope !== envelope.callScope
        || row.toolName !== envelope.toolName || row.argumentsHash !== digest(envelope.arguments)) throw fault('DSH_OPERATION_CONFLICT', 'Operation identity or arguments changed');
    return row;
  };
  const saveResult = async (row, value, status = 'completed') => {
    const reference = await evidence.save(value, { source: 'dsh-operation-result', operationId: row.operationId });
    await commit(async () => {
      row.status = status; row.outputEvidenceId = reference.evidenceId; row.finishedAt = new Date().toISOString();
      // Read completion is already durable in the business terminal receipt.
      if (!readOnlyTools.has(row.toolName)) await persist(state);
    });
    return value;
  };
  const receiptsFor = async operationId => {
    const rows = []; let afterSeq = 0;
    for (;;) {
      const page = await evidence.readReceipts({ afterSeq, limit: 1000 });
      rows.push(...page.records.filter(row => row.operationId === operationId));
      if (!page.nextSeq) return rows;
      afterSeq = page.nextSeq;
    }
  };
  const reconcile = async operationId => {
    const row = journal.operations[operationId];
    if (!row) throw fault('DSH_OPERATION_MISSING', 'Unknown operation');
    if (row.outputEvidenceId) return { status: row.status, output: (await evidence.load(row.outputEvidenceId)).value };
    if (inFlight.has(operationId)) return { status: 'running' };
    const receipts = await receiptsFor(operationId), terminal = receipts.find(item => item.phase !== 'started');
    if (row.toolName === 'submit_recipe') {
      const directory = path.join(options.project.workspaceDir ?? workspaceDir, 'technical', binding.adaptationRequestId, 'accepted-receipts');
      const accepted = (await discoverAcceptedBatches(directory)).filter(record => record.payload.operationId === operationId);
      if (accepted.length > 1) throw fault('DSH_ACCEPTANCE_CONFLICT', 'One operation has conflicting accepted receipts');
      if (accepted.length) {
        const extraction = await readAcceptedBatch({ directory, record: accepted[0] });
        const output = await session.recoverAcceptedBatch(accepted[0], extraction);
        const started = receipts.find(item => item.phase === 'started');
        if (started && !terminal) {
          const input = (await evidence.load(started.inputEvidenceId)).value;
          const saved = await evidence.save(output, { source: 'dsh-accepted-reconciliation' });
          await session.control.finish({ operationId, tool: started.tool, toolCallId: started.toolCallId,
            inputEvidenceId: started.inputEvidenceId }, input, output, saved.evidenceId);
        }
        await saveResult(row, output, 'reconciled');
        return { status: 'reconciled', output };
      }
    }
    if (terminal?.outputEvidenceId) {
      const value = (await evidence.load(terminal.outputEvidenceId)).value;
      const output = boundedToolOutput({ ...value, evidenceId: terminal.outputEvidenceId, receiptId: terminal.receiptId, recovered: true });
      await saveResult(row, output, 'reconciled');
      return { status: 'reconciled', output };
    }
    if (!receipts.length && row.status === 'allocated') return { status: 'allocated' };
    // A terminal receipt is required before any interrupted mutation may be repeated.
    return { status: 'pending-reconciliation', operationId, toolName: row.toolName,
      readOnly: readOnlyTools.has(row.toolName), receipts: receipts.map(({ receiptId, phase, run }) => ({ receiptId, phase, run })),
      nextAction: 'Read existing candidate, process and acceptance receipts. Do not repeat an operation with an unknown side effect.' };
  };
  return {
    session, state, binding: structuredClone(identity),
    definitions: () => structuredClone(definitions),
    allocateCall: input => commit(async () => {
      if (closed) throw fault('DSH_BRIDGE_CLOSED', 'Runtime bridge is closed');
      if (typeof input?.toolCallId !== 'string' || !input.toolCallId || input.rootToolCallId != null && typeof input.rootToolCallId !== 'string'
          || input.callScope != null && (typeof input.callScope !== 'string' || !input.callScope)) throw fault('DSH_TOOL_CALL_ID', 'A durable model tool-call identity is required');
      const validator = validators.get(input.toolName);
      if (!validator) throw fault('MODEL_TOOL_NOT_AVAILABLE', 'Use an exact registered tool name');
      const parsed = validator.safeParse(input.arguments);
      if (!parsed.success) throw fault('MODEL_TOOL_INPUT_INVALID', 'Tool arguments do not match the registered schema', parsed.error.issues);
      const key = digest([input.callScope ?? null, input.toolCallId, input.rootToolCallId ?? null]);
      const previous = journal.operations[journal.calls[key]], argumentsHash = digest(input.arguments);
      if (previous) {
        if (previous.toolName !== input.toolName || previous.argumentsHash !== argumentsHash) throw fault('DSH_OPERATION_CONFLICT', 'The same model call identity has different arguments');
        return envelopeFor(previous);
      }
      const inputReceipt = await evidence.save(input.arguments, { source: 'dsh-operation-input' });
      const row = { operationId: `dsh-operation-${randomUUID()}`, toolCallId: input.toolCallId, rootToolCallId: input.rootToolCallId ?? null,
        callScope: input.callScope ?? null,
        toolName: input.toolName, inputEvidenceId: inputReceipt.evidenceId, argumentsHash, status: 'allocated', createdAt: new Date().toISOString() };
      journal.calls[key] = row.operationId; journal.operations[row.operationId] = row;
      if (!readOnlyTools.has(row.toolName)) await persist(state);
      return envelopeFor(row);
    }),
    async execute(envelope) {
      const row = check(envelope);
      if (closed) throw fault('DSH_BRIDGE_CLOSED', 'Runtime bridge is closed');
      if (inFlight.has(row.operationId)) return inFlight.get(row.operationId);
      const action = (async () => {
        if (row.status !== 'allocated') {
          const recovered = await reconcile(row.operationId);
          if (recovered.output !== undefined) return recovered.output;
          throw fault('DSH_OPERATION_RECONCILIATION', 'Interrupted operation requires reconciliation before retry', recovered);
        }
        options.signal?.throwIfAborted();
        await commit(async () => { row.status = 'executing'; if (!readOnlyTools.has(row.toolName)) await persist(state); });
        try {
          const output = await session.tools[row.toolName].execute(await argumentsFor(row), {
            toolCallId: row.toolCallId, operationId: row.operationId, abortSignal: options.signal });
          return await saveResult(row, output);
        } catch (error) {
          await commit(async () => { row.status = 'pending-reconciliation'; row.error = { code: error.code, message: String(error.message) }; await persist(state); });
          throw error;
        }
      })();
      inFlight.set(row.operationId, action);
      try { return await action; } finally { inFlight.delete(row.operationId); }
    },
    reconcile,
    async flush() { await Promise.allSettled([...inFlight.values()]); await queue; await session.flush(); },
    async close() { closed = true; await Promise.allSettled([...inFlight.values()]); await queue; await session.close(); },
  };
}
