const resumable = new Set(['paused', 'queued', 'running']);
const dependencyKey = task => task.dependencyHash ?? (task.dependencies ? JSON.stringify(task.dependencies) : null);
const inputKey = task => JSON.stringify([task.role, task.kind ?? null, task.targetLanguage, dependencyKey(task), task.promptVersion,
  task.input?.map(item => [item.id, item.revision, item.sourceHash]) ?? null]);

/** One planning pass indexes persisted tasks while retaining their insertion order. */
export function createTaskIndex(tasks, { lookupFingerprint, orderFor } = {}) {
  const fingerprints = new Map(), inputs = new Map(), entries = new Map();
  const byFingerprint = fingerprint => fingerprints.get(fingerprint) ?? lookupFingerprint?.(fingerprint);
  const set = task => {
    fingerprints.set(task.fingerprint, task);
    const existing = entries.get(task.id);
    if (existing) {
      const key = inputKey(task);
      if (existing.key !== key) {
        const bucket = inputs.get(existing.key);
        if (bucket) inputs.set(existing.key, bucket.filter(entry => entry !== existing));
        const next = inputs.get(key) ?? []; next.push(existing);
        if (orderFor) next.sort((a, b) => a.order - b.order);
        inputs.set(key, next); existing.key = key;
      }
      if (existing.task.fingerprint !== task.fingerprint && fingerprints.get(existing.task.fingerprint)?.id === task.id) fingerprints.delete(existing.task.fingerprint);
      existing.task = task; return;
    }
    const key = inputKey(task), entry = { task, key, order: orderFor?.(task) ?? entries.size };
    const bucket = inputs.get(key) ?? [];
    bucket.push(entry);
    if (orderFor) bucket.sort((a, b) => a.order - b.order);
    inputs.set(key, bucket); entries.set(task.id, entry);
  };
  tasks.forEach(set);
  return {
    set,
    byFingerprint,
    find(task) {
      const exact = byFingerprint(task.fingerprint);
      if (exact && dependencyKey(exact) === dependencyKey(task) && exact.promptVersion === task.promptVersion) return exact;
      const bucket = inputs.get(inputKey(task)) ?? [];
      for (let index = bucket.length - 1; index >= 0; index--) {
        const candidate = bucket[index].task;
        if (resumable.has(candidate.status) && candidate.role === task.role && candidate.kind === task.kind
            && dependencyKey(candidate) === dependencyKey(task) && candidate.promptVersion === task.promptVersion
            && candidate.targetLanguage === task.targetLanguage && Array.isArray(candidate.input) && Array.isArray(task.input)
            && candidate.input.length === task.input.length && candidate.input.every((item, position) => item.id === task.input[position].id
              && item.revision === task.input[position].revision && item.sourceHash === task.input[position].sourceHash)) return candidate;
      }
    },
  };
}
