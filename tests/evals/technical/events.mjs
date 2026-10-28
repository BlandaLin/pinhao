import { createHash } from 'node:crypto';

export const EVALUATION_SCHEMA = 'pinhao-technical-eval-1';
export const EVIDENCE_TIERS = ['contract', 'autonomy', 'product-integration'];
export const REQUIRED_GATES = ['stableIds', 'roundtrip', 'sample', 'structure', 'display'];
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const locationKey = unit => canonical(unit?.context?.adaptationLocator ?? unit?.locator ?? null);

export function artifactRecord(artifact) {
  if (!artifact || typeof artifact.text !== 'string' || digest(artifact.text) !== artifact.sha256) return undefined;
  try { return JSON.parse(artifact.text); }
  catch {
    const lines = artifact.text.split(/\r?\n/).filter(line => line.trim());
    try { return JSON.parse(lines.at(-1)); } catch { return undefined; }
  }
}

export function summarizeAttempts(attempts = []) {
  const byId = new Map();
  for (const attempt of attempts) {
    if (!attempt.id || byId.has(attempt.id)) throw new Error('HTTP attempts require unique stable IDs.');
    byId.set(attempt.id, attempt);
  }
  const sent = [...byId.values()].filter(attempt => attempt.fetchStartedAt || attempt.sendUncertain);
  const known = sent.filter(attempt => Number.isFinite(attempt.usage?.cost));
  const keys = ['promptTokens', 'completionTokens', 'reasoningTokens', 'totalTokens'];
  return {
    reservedAttempts: attempts.length, actualOrUncertainHttpAttempts: sent.length,
    knownCostTotal: known.length ? known.reduce((sum, attempt) => sum + attempt.usage.cost, 0) : null,
    unknownCostRequests: sent.length - known.length,
    usageMissingRequests: sent.filter(attempt => keys.every(key => !Number.isFinite(attempt.usage?.[key]))).length,
    inflightReservations: attempts.filter(attempt => !attempt.settledAt && !attempt.notSentAt).length,
    knownTokenSubtotals: Object.fromEntries(keys.map(key => [key, sent.reduce((sum, attempt) => sum + (Number.isFinite(attempt.usage?.[key]) ? attempt.usage[key] : 0), 0)])),
    purposeCounts: Object.fromEntries([...new Set(sent.map(attempt => attempt.purpose ?? 'unattributed'))].sort()
      .map(purpose => [purpose, sent.filter(attempt => (attempt.purpose ?? 'unattributed') === purpose).length])),
  };
}

export function uniqueToolCalls(wires = [], checkpoints = []) {
  const calls = new Map();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'tool-call' && value.toolCallId) calls.set(value.toolCallId, { id: value.toolCallId, name: value.toolName, input: value.input });
    for (const call of value.tool_calls ?? []) if (call.id) {
      let input; try { input = JSON.parse(call.function?.arguments); } catch { input = { malformed: true }; }
      calls.set(call.id, { id: call.id, name: call.function?.name, input });
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') {
      if (Array.isArray(child)) child.forEach(visit); else visit(child);
    }
  };
  [...wires, ...checkpoints].forEach(visit);
  return [...calls.values()];
}
