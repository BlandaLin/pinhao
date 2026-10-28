import { normalizeUsage } from './usage.mjs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const SCHEMA = 'pinhao-adaptation-budget-1';
const copy = value => structuredClone(value);
const tokenKeys = ['promptTokens', 'completionTokens', 'reasoningTokens', 'totalTokens'];
const identity = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new Error(`Invalid ${name}`);
  return value;
};
const count = (value, name, zero = false) => {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new Error(`Invalid ${name}`);
  return value;
};
const fault = (code, message) => Object.assign(new Error(message), { code });
const limitFault = message => fault('ADAPTATION_BUDGET_EXHAUSTED', message);
const synchronous = value => {
  if (value && typeof value.then === 'function') throw new Error('Adaptation budget storage callbacks must be synchronous');
  return value;
};

/** One durable allowance per service request, shared by jobs, fallbacks and independent reviewers. */
export function createAdaptationBudget({ readProject, patchProject, transaction, clock = () => new Date().toISOString() } = {}) {
  if ([readProject, patchProject, transaction].some(fn => typeof fn !== 'function')) throw new Error('Adaptation budget needs synchronous project storage');
  const active = new Set();
  const forRequest = (projectId, adaptationRequestId, options = {}) => {
    identity(projectId, 'projectId'); identity(adaptationRequestId, 'adaptationRequestId');
    const enforceLimits = options.enforceLimits !== false;
    const optionalLimit = (value, name) => value == null ? null : count(value, name);
    const change = action => synchronous(transaction(projectId, () => {
      const project = synchronous(readProject(projectId));
      if (!project) throw new Error('Adaptation budget project does not exist');
      const accounting = { ...(project.adaptationAccounting ?? {}) };
      let state = accounting[adaptationRequestId];
      if (!state) {
        const limits = { maxHttpAttempts: optionalLimit(options.limits?.maxHttpAttempts, 'maxHttpAttempts'), maxWindows: optionalLimit(options.limits?.maxWindows, 'maxWindows') };
        const historyCoverage = options.historyCoverage === 'complete' ? 'complete' : 'partial';
        state = { schema: SCHEMA, projectId, adaptationRequestId, revision: 0, limits, historyCoverage,
          httpAllowance: limits.maxHttpAttempts == null || historyCoverage === 'complete' ? limits.maxHttpAttempts : 0,
          windowAllowance: limits.maxWindows == null || historyCoverage === 'complete' ? limits.maxWindows : 0,
          windows: [], attempts: {}, grants: [], createdAt: clock() };
      } else {
        if (state.schema !== SCHEMA || state.projectId !== projectId || state.adaptationRequestId !== adaptationRequestId) throw new Error('Unsupported or mismatched adaptation budget');
        state = copy(state);
      }
      const result = synchronous(action(state));
      state.revision += 1; state.updatedAt = clock(); accounting[adaptationRequestId] = state;
      synchronous(patchProject(projectId, { adaptationAccounting: accounting }));
      if (result && typeof result === 'object' && Object.hasOwn(result, 'revision')) result.revision = state.revision;
      return copy(result);
    }));
    // Initialize immediately, before a model/window can be dispatched. Existing limits never reset.
    change(() => undefined);
    const read = () => {
      const state = synchronous(readProject(projectId))?.adaptationAccounting?.[adaptationRequestId];
      if (state?.schema !== SCHEMA || state.projectId !== projectId || state.adaptationRequestId !== adaptationRequestId) throw new Error('Adaptation budget is unavailable');
      return state;
    };
    const snapshotOf = state => {
      const attempts = Object.values(state.attempts), charged = attempts.filter(item => item.outcome !== 'not-sent');
      const knownUsage = Object.fromEntries(tokenKeys.map(key => [key, null]));
      for (const key of tokenKeys) {
        const values = charged.map(item => item.usage?.[key]).filter(value => typeof value === 'number');
        if (values.length) knownUsage[key] = values.reduce((sum, value) => sum + value, 0);
      }
      const costs = charged.map(item => item.usage?.cost).filter(value => typeof value === 'number');
      const remainingHttpAttempts = !enforceLimits || state.httpAllowance == null ? null : Math.max(0, state.httpAllowance - charged.length);
      const remainingWindows = !enforceLimits || state.windowAllowance == null ? null : Math.max(0, state.windowAllowance - state.windows.length);
      return { projectId, adaptationRequestId, revision: state.revision,
        limits: enforceLimits ? copy(state.limits) : { maxHttpAttempts: null, maxWindows: null },
        ...(enforceLimits ? {} : { recordedLimits: copy(state.limits) }), limitsEnforced: enforceLimits,
        historyCoverage: state.historyCoverage,
        windowsUsed: state.windows.length, remainingWindows, httpUsed: charged.length,
        httpReserved: charged.filter(item => item.state === 'reserved').length,
        httpSentKnown: charged.filter(item => item.fetchStarted === true).length, remainingHttpAttempts,
        knownUsage, knownCost: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null,
        unknownCostAttempts: charged.length - costs.length,
        usageMissingAttempts: charged.filter(item => !item.usage).length,
        ...(state.closedAt ? { closedAt: state.closedAt, closedReason: state.closedReason } : {}),
        canReserveHttp: !state.closedAt && (remainingHttpAttempts == null || remainingHttpAttempts > 0),
        canOpenWindow: !state.closedAt && (remainingWindows == null || remainingWindows > 0) };
    };
    const attempt = (state, id) => {
      const value = state.attempts[identity(id, 'httpAttemptId')];
      if (!value) throw new Error('Unknown adaptation HTTP attempt');
      return value;
    };
    const settleIn = (state, id, receipt) => {
      const value = attempt(state, id);
      // Only the live sender can prove fetch was never invoked. A recovered send intent is unknown.
      if (receipt.fetchStarted === false && value.fetchStarted !== true) value.outcome = 'not-sent';
      else if (receipt.fetchStarted === true) { value.fetchStarted = true; value.outcome = receipt.outcome ?? (value.outcome === 'not-sent' ? 'unknown' : value.outcome) ?? 'unknown'; }
      else value.outcome ??= receipt.outcome ?? 'unknown';
      value.state = 'settled'; value.settledAt ??= clock();
      const usage = normalizeUsage(receipt.usage);
      if (usage) value.usage = Object.fromEntries([...tokenKeys, 'cost'].map(key => [key, value.usage?.[key] ?? usage[key]]));
      for (const key of ['statusCode', 'finishReason', 'artifact']) if (receipt[key] !== undefined && value[key] === undefined) value[key] = receipt[key];
      if (receipt.artifactFingerprint) value.artifactFingerprint = receipt.artifactFingerprint;
      if (receipt.error?.code && !value.errorCode) value.errorCode = String(receipt.error.code).slice(0, 256);
      return value;
    };
    return {
      snapshot: () => copy(snapshotOf(read())),
      recoveryAttempts: () => copy(Object.values(read().attempts).filter(value => value.outcome !== 'not-sent' && !active.has(value.httpAttemptId)
        && (value.state !== 'settled' || !value.usage || [...tokenKeys, 'cost'].some(key => value.usage[key] === null)))),
      openWindow({ windowId }) {
        identity(windowId, 'windowId');
        return change(state => {
          if (state.windows.includes(windowId)) return snapshotOf(state);
          if (state.closedAt || !snapshotOf(state).canOpenWindow) throw limitFault('技术适配累计执行窗口已用完，需要明确追加预算后继续');
          state.windows.push(windowId); return snapshotOf(state);
        });
      },
      reserve({ httpAttemptId, jobId, windowId, purpose = 'adaptation', retryOf, taskId, logicalStepId, artifactDirectory }) {
        identity(httpAttemptId, 'httpAttemptId'); identity(windowId, 'windowId');
        const result = change(state => {
          if (state.attempts[httpAttemptId]) throw new Error('Adaptation HTTP attempt is already reserved');
          if (!state.windows.includes(windowId)) throw new Error('Adaptation HTTP request needs a registered service window');
          if (state.closedAt || !snapshotOf(state).canReserveHttp) throw limitFault(state.historyCoverage === 'partial' && !state.httpAllowance
            ? '旧任务的累计请求历史不完整，不能自动按零消耗继续；请明确追加预算'
            : '技术适配累计请求预算已用完，已保存成果');
          const context = { projectId, adaptationRequestId, httpAttemptId, windowId, purpose: identity(purpose, 'purpose') };
          for (const [key, value] of Object.entries({ jobId, retryOf, taskId, logicalStepId })) if (value !== undefined) context[key] = identity(value, key);
          state.attempts[httpAttemptId] = { ...context, ...(artifactDirectory ? { artifactDirectory: path.resolve(artifactDirectory) } : {}), state: 'reserved', reservedAt: clock() };
          return context;
        });
        active.add(httpAttemptId); return result;
      },
      markSent(httpAttemptId) {
        return change(state => {
          const value = attempt(state, httpAttemptId);
          if (value.state !== 'reserved' && value.state !== 'send-intent') throw new Error('Adaptation HTTP attempt already settled');
          value.state = 'send-intent'; value.sendIntentAt ??= clock(); return value;
        });
      },
      settle(httpAttemptId, receipt = {}) {
        try { return change(state => settleIn(state, httpAttemptId, receipt)); }
        finally { active.delete(httpAttemptId); }
      },
      reconcile(receipts = []) {
        return change(state => {
          for (const receipt of receipts) {
            const id = identity(receipt.httpAttemptId, 'httpAttemptId');
            if (!state.attempts[id]) {
              if (receipt.adaptationRequestId !== adaptationRequestId || receipt.projectId !== projectId) throw new Error('Mismatched recovered HTTP receipt');
              state.attempts[id] = { httpAttemptId: id, projectId, adaptationRequestId, state: 'send-intent', reservedAt: receipt.reservedAt ?? clock() };
              for (const key of ['windowId', 'jobId', 'purpose', 'retryOf']) if (receipt[key] !== undefined) state.attempts[id][key] = identity(receipt[key], key);
              if (receipt.windowId && !state.windows.includes(receipt.windowId)) state.windows.push(receipt.windowId);
            }
            settleIn(state, id, receipt);
          }
          for (const value of Object.values(state.attempts)) if (!active.has(value.httpAttemptId) && value.state !== 'settled') {
            settleIn(state, value.httpAttemptId, value.state === 'reserved' ? { fetchStarted: false } : { outcome: 'unknown' });
          }
          return snapshotOf(state);
        });
      },
      close(reason = 'completed') { return change(state => { state.closedAt ??= clock(); state.closedReason ??= String(reason).slice(0, 256); return snapshotOf(state); }); },
      grantAdditional({ grantId, httpAttempts = 0, windows = 0, reason }) {
        identity(grantId, 'grantId'); identity(reason, 'reason'); count(httpAttempts, 'httpAttempts', true); count(windows, 'windows', true);
        if (!httpAttempts && !windows) throw new Error('Additional budget must add an explicit allowance');
        return change(state => {
          if (state.grants.some(value => value.grantId === grantId)) return snapshotOf(state);
          state.grants.push({ grantId, httpAttempts, windows, reason, at: clock() });
          state.httpAllowance = count(Math.max(state.httpAllowance, snapshotOf(state).httpUsed) + httpAttempts, 'httpAllowance', true);
          state.windowAllowance = count(Math.max(state.windowAllowance, state.windows.length) + windows, 'windowAllowance', true);
          delete state.closedAt; delete state.closedReason; return snapshotOf(state);
        });
      },
    };
  };
  return { forRequest };
}

const within = (root, file) => { const relative = path.relative(root, file); return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };
const fileIdentity = info => `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

/** Recover only the host-recorded request result pointers; no conversation/history directory scan. */
export async function recoverAdaptationBudget({ owner, directory, signal } = {}) {
  const snapshot = owner.snapshot(), attempts = owner.recoveryAttempts(), receipts = [], errors = [];
  let recovered = 0, unchanged = 0, unavailable = 0, root;
  try { root = await realpath(path.resolve(directory)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { recovered, unchanged, unavailable: attempts.length, errors: [], snapshot: owner.reconcile() }; }
  for (const attempt of attempts) {
    signal?.throwIfAborted();
    if (!attempt.artifactDirectory) { unavailable++; continue; }
    try {
      const planned = path.resolve(attempt.artifactDirectory);
      if (!within(path.resolve(directory), planned)) throw new Error('Recovered HTTP artifact escaped its technical request directory');
      const file = path.join(planned, 'result.json'), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || !within(root, await realpath(file))) throw new Error('Recovered HTTP artifact is not a regular request result');
      const artifactFingerprint = fileIdentity(info);
      if (artifactFingerprint === attempt.artifactFingerprint) { unchanged++; continue; }
      const result = JSON.parse(await readFile(file, 'utf8')), after = await lstat(file), context = result.requestContext;
      if (fileIdentity(after) !== artifactFingerprint) throw new Error('Recovered HTTP artifact changed during its read');
      if (result.id !== attempt.httpAttemptId || !['received', 'failed'].includes(result.status) || !result.finishedAt
        || context?.httpAttemptId !== attempt.httpAttemptId || context.projectId !== snapshot.projectId || context.adaptationRequestId !== snapshot.adaptationRequestId
        || ['jobId', 'windowId', 'purpose', 'retryOf'].some(key => attempt[key] !== undefined && context[key] !== attempt[key])) throw new Error('Recovered HTTP artifact does not match its budget owner and attempt');
      const fetchStarted = typeof result.summary?.fetchStarted === 'boolean' ? result.summary.fetchStarted
        : result.responseAt || typeof result.summary?.statusCode === 'number' ? true : undefined;
      receipts.push({ httpAttemptId: attempt.httpAttemptId, projectId: snapshot.projectId, adaptationRequestId: snapshot.adaptationRequestId,
        fetchStarted, outcome: fetchStarted === undefined ? 'unknown' : result.status === 'failed' || result.summary?.statusCode >= 400 ? 'failed' : 'succeeded',
        usage: result.summary?.usage, statusCode: result.summary?.statusCode, finishReason: result.summary?.finishReason,
        artifact: result.id, artifactFingerprint, error: result.error });
      recovered++;
    } catch (error) {
      unavailable++;
      errors.push({ httpAttemptId: attempt.httpAttemptId, code: error.code ?? 'BUDGET_RECOVERY_INVALID_ARTIFACT', message: error.message });
    }
  }
  return { recovered, unchanged, unavailable, errors, snapshot: owner.reconcile(receipts) };
}
