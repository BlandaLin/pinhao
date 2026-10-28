import path from 'node:path';
import { stat } from 'node:fs/promises';

/** Disk admission is independent of HTTP billing and survives every model window. */
export function createLogStorageBudget({ readProject, patchProject, transaction, maxRequestBytes = 512 * 1024 * 1024 }) {
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) throw new RangeError('Invalid request log byte limit');
  const update = (input, action) => {
    if (!input.projectId || !Number.isSafeInteger(input.bytes ?? 0) || (input.bytes ?? 0) < 0) throw new Error('Log storage needs a host project and byte count');
    return transaction(input.projectId, () => {
      const project = readProject(input.projectId), workDir = path.resolve(input.workDir);
      const relative = path.relative(project.workspaceDir, workDir);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Log capture must belong to its project');
      const storage = structuredClone(project.logStorage ?? { version: 1, requests: {} });
      const requestId = input.requestId ?? project.adaptationRequest?.id ?? 'product';
      const request = storage.requests[requestId] ??= { limit: maxRequestBytes, used: 0, runs: {} };
      const run = request.runs[input.runId] ??= { workDir, reserved: 0, persisted: 0 };
      if (run.workDir !== workDir) throw new Error('A log capture ID cannot change its work directory');
      const result = action(request, run);
      patchProject(input.projectId, { logStorage: storage });
      return result;
    });
  };
  return {
    reserve: input => update(input, (request, run) => {
      const grant = Math.min(input.bytes, Math.max(0, request.limit - request.used));
      request.used += grant; run.reserved += grant;
      return grant;
    }),
    settle: input => update(input, (request, run) => {
      if (!Number.isSafeInteger(input.reservedBytes) || !Number.isSafeInteger(input.persistedBytes)
          || input.persistedBytes < 0 || input.persistedBytes > input.reservedBytes || input.reservedBytes > run.reserved) throw new Error('Invalid log persistence settlement');
      const refund = input.uncertain ? 0 : input.reservedBytes - input.persistedBytes;
      request.used -= refund; run.reserved -= refund; run.persisted += input.persistedBytes;
    }),
    async reconcile(projectId) {
      const project = readProject(projectId), storage = structuredClone(project.logStorage);
      if (!storage) return;
      for (const request of Object.values(storage.requests)) {
        for (const [runId, run] of Object.entries(request.runs)) {
          if (!/^run-[a-f0-9-]+$/.test(runId)) continue;
          const relative = path.relative(project.workspaceDir, run.workDir);
          if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
          try {
            const sizes = await Promise.all(['stdout', 'stderr'].map(key => stat(path.join(run.workDir, 'process-runs', `${runId}.${key}`))));
            run.reserved = run.persisted = sizes.reduce((sum, info) => sum + info.size, 0);
          } catch { /* Missing or inaccessible captures remain conservatively reserved. */ }
        }
        request.used = Object.values(request.runs).reduce((sum, run) => sum + run.reserved, 0);
      }
      patchProject(projectId, { logStorage: storage });
    },
  };
}
