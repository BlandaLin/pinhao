import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, link, unlink } from 'node:fs/promises';
import path from 'node:path';

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, item[key]])) : item);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const failure = (code, message) => Object.assign(new Error(message), { code, hostFailure: true });

async function immutable(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.pending`;
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(canonical(value));
    await handle.sync();
    await handle.close(); handle = undefined;
    await link(temporary, file);
  } catch (error) {
    if (error.code !== 'EEXIST') throw failure('ACCEPTANCE_STORAGE_FAILED', `Accepted result could not be saved: ${error.message}`);
    let previous;
    try { previous = JSON.parse(await readFile(file, 'utf8')); }
    catch (cause) { throw failure('ACCEPTANCE_STORAGE_FAILED', `Saved accepted receipt is incomplete: ${cause.message}`); }
    if (hash(previous) !== hash(value)) throw failure('ACCEPTANCE_RECEIPT_CONFLICT', 'An accepted receipt has conflicting contents');
  } finally { await handle?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Producer files survive a lost callback; the project database owns delivery state. */
export async function persistAcceptedBatch({ directory, projectId, adaptationRequestId, assignment, windowId, operationId, extraction, candidateId, validationId, acceptanceProof }) {
  const extractionHash = hash(extraction);
  const payload = { schemaVersion: 1, projectId, adaptationRequestId,
    originOwnerId: assignment?.ownerId ?? assignment?.id ?? 'coordinator', assignmentRevision: assignment?.assignmentRevision ?? 0,
    windowId, operationId, candidateId, validationId, recipeId: extraction.binding?.recipeId ?? extraction.recipeId,
    extractionHash, workspaceDir: extraction.workspaceDir, acceptanceProof };
  const acceptedBatchId = hash(payload);
  await immutable(path.join(directory, `${extractionHash}.extraction.json`), extraction);
  const record = { id: acceptedBatchId, payload, payloadHash: hash(payload) };
  await immutable(path.join(directory, `${acceptedBatchId}.receipt.json`), record);
  return { ...record, receiptFile: path.join(directory, `${acceptedBatchId}.receipt.json`) };
}

export async function readAcceptedBatch({ directory, record }) {
  if (record.id !== hash(record.payload) || record.payloadHash !== hash(record.payload)) throw failure('ACCEPTANCE_RECEIPT_CONFLICT', 'Accepted receipt identity is invalid');
  const extraction = JSON.parse(await readFile(path.join(directory, `${record.payload.extractionHash}.extraction.json`), 'utf8'));
  if (hash(extraction) !== record.payload.extractionHash) throw failure('ACCEPTANCE_RECEIPT_CONFLICT', 'Accepted extraction changed after validation');
  return extraction;
}

export async function discoverAcceptedBatches(directory) {
  let files;
  try { files = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return Promise.all(files.filter(file => /^[a-f0-9]{64}\.receipt\.json$/.test(file)).sort().map(async file => {
    let record;
    try { record = JSON.parse(await readFile(path.join(directory, file), 'utf8')); }
    catch (cause) { throw failure('ACCEPTANCE_STORAGE_FAILED', `Saved accepted receipt is incomplete: ${file}: ${cause.message}`); }
    if (`${record.id}.receipt.json` !== file || record.payloadHash !== hash(record.payload)) throw failure('ACCEPTANCE_RECEIPT_CONFLICT', 'Accepted receipt changed on disk');
    return record;
  }));
}

export function createAcceptanceLedger({ store, projectId, adaptationRequestId }) {
  const row = id => store.one('acceptance_receipts', id);
  const summary = () => {
    const rows = store.all('acceptance_receipts', projectId);
    return { accepted: rows.length, integrated: rows.filter(item => item.status === 'integrated').length,
      pendingIntegration: rows.filter(item => item.status === 'pending').length, stale: rows.filter(item => item.status === 'stale').length };
  };
  return {
    enqueue(record) {
      if (record.payload.projectId !== projectId || record.payload.adaptationRequestId !== adaptationRequestId
          || record.payloadHash !== hash(record.payload) || record.id !== hash(record.payload)) throw failure('ACCEPTANCE_RECEIPT_CONFLICT', 'Accepted batch belongs to another project or request');
      const previous = row(record.id);
      if (previous && previous.payloadHash !== record.payloadHash) throw failure('ACCEPTANCE_RECEIPT_CONFLICT', 'Accepted batch ID was reused');
      if (!previous) store.put('acceptance_receipts', { ...record, status: 'pending', attempts: 0, acceptedAt: new Date().toISOString() }, projectId);
      return previous ?? row(record.id);
    },
    pending() { return store.all('acceptance_receipts', projectId).filter(item => item.payload.adaptationRequestId === adaptationRequestId && item.status === 'pending'); },
    findExtraction(extraction) { return store.all('acceptance_receipts', projectId).find(item => item.payload.adaptationRequestId === adaptationRequestId && item.payload.extractionHash === hash(extraction)); },
    commit(id, publish) {
      return store.transaction(projectId, () => {
        const previous = row(id);
        if (!previous) throw failure('INTEGRATION_PENDING', 'Accepted batch has not been queued');
        if (previous.status === 'integrated') return { ...previous.result, reused: true };
        const result = publish();
        if (result?.then) throw new Error('Publication transaction must be synchronous');
        store.put('acceptance_receipts', { ...previous, status: 'integrated', attempts: previous.attempts + 1,
          integratedAt: new Date().toISOString(), result }, projectId);
        if (store.one('projects', projectId)) store.patchProject(projectId, { acceptance: summary() });
        return result;
      });
    },
    mark(id, status, error) {
      const previous = row(id);
      if (previous && previous.status !== 'integrated') store.put('acceptance_receipts', { ...previous, status,
        attempts: previous.attempts + 1, lastError: { code: error.code, message: error.message } }, projectId);
    },
    summary,
  };
}
