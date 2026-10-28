import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const registries = new Map();
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const fault = (code, message) => Object.assign(new Error(message), { code });
const evidencePattern = /^evidence-[a-f0-9]{64}$/;
const receiptPattern = /^receipt-[a-f0-9]{64}$/;
const receiptFields = ['operationId', 'phase', 'tool', 'toolCallId', 'inputEvidenceId', 'outputEvidenceId', 'resourceRefs', 'run', 'itemIds', 'hostEventPayload', 'occurredAt', 'normalizerVersion'];
const comparable = record => JSON.stringify(canonical(Object.fromEntries(receiptFields.filter(key => key !== 'occurredAt').map(key => [key, record[key]]))));

async function receiptRegistry(directory) {
  const root = path.resolve(directory, 'evidence-receipts');
  if (!registries.has(root)) registries.set(root, (async () => {
    await mkdir(root, { recursive: true });
    const metaFile = path.join(root, 'namespace.json');
    let metadata;
    try { metadata = JSON.parse(await readFile(metaFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      metadata = { format: 'pinhao-receipt-namespace-1', namespaceId: `namespace-${randomUUID()}` };
      try { await writeFile(metaFile, JSON.stringify(metadata), { flag: 'wx', flush: true }); }
      catch (failure) { if (failure.code !== 'EEXIST') throw failure; metadata = JSON.parse(await readFile(metaFile, 'utf8')); }
    }
    if (metadata.format !== 'pinhao-receipt-namespace-1' || typeof metadata.namespaceId !== 'string') throw fault('EVIDENCE_RECEIPT_VERSION', 'Unsupported receipt namespace');
    const store = { root, namespaceId: metadata.namespaceId, rows: [], operations: new Map(), byId: new Map(), queue: Promise.resolve(), pendingFiles: [] };
    const names = (await readdir(root)).sort();
    for (const name of names) {
      if (name.includes('.pending-')) { store.pendingFiles.push(name); continue; }
      if (name === 'namespace.json') continue;
      if (!/^\d{12}-receipt-[a-f0-9]{64}\.json$/.test(name)) throw fault('EVIDENCE_RECEIPT_CORRUPT', 'Unrecognized receipt entry');
      let record;
      try { record = JSON.parse(await readFile(path.join(root, name), 'utf8')); }
      catch { throw fault('EVIDENCE_RECEIPT_CORRUPT', 'Incomplete published receipt'); }
      const { receiptHash, ...body } = record;
      if (record.version !== 1 || record.normalizerVersion !== 1) throw fault('EVIDENCE_RECEIPT_VERSION', 'Unsupported receipt version');
      if (record.namespaceId !== store.namespaceId || record.seq !== store.rows.length + 1 || digest(JSON.stringify(canonical(body))) !== receiptHash
        || name !== `${String(record.seq).padStart(12, '0')}-${record.receiptId}.json`) throw fault('EVIDENCE_RECEIPT_CORRUPT', 'Receipt sequence or checksum mismatch');
      addReceipt(store, record);
    }
    return store;
  })().catch(error => { registries.delete(root); throw error; }));
  return registries.get(root);
}

function addReceipt(store, record) {
  const operation = store.operations.get(record.operationId) ?? {};
  if (operation.inputEvidenceId && operation.inputEvidenceId !== record.inputEvidenceId || operation[record.phase]) throw fault('EVIDENCE_RECEIPT_CONFLICT', 'Conflicting operation receipt');
  if (record.phase !== 'started' && (!operation.started || operation.terminal)) throw fault('EVIDENCE_RECEIPT_CONFLICT', 'Completion needs one recorded start');
  operation.inputEvidenceId = record.inputEvidenceId; operation[record.phase] = record;
  if (record.phase !== 'started') operation.terminal = record;
  store.operations.set(record.operationId, operation); store.byId.set(record.receiptId, record); store.rows.push(record);
}

/** Complete tool results live outside the model's bounded conversation. */
export function createEvidenceStore(directory) {
  const root = path.join(directory, 'evidence');
  const load = async evidenceId => {
    if (!/^evidence-[a-f0-9]{64}$/.test(evidenceId ?? '')) throw new Error('证据编号无效');
    const record = JSON.parse(await readFile(path.join(root, `${evidenceId}.json`), 'utf8'));
    if (record.evidenceId !== evidenceId || digest(JSON.stringify(record.value)) !== evidenceId.slice(9)) throw new Error('证据内容已改变');
    return record;
  };
  return {
    load,
    async recordReceipt(input) {
      const record = Object.fromEntries(receiptFields.filter(key => input[key] !== undefined).map(key => [key, structuredClone(input[key])]));
      record.phase = String(record.phase ?? '').replace(/^operation_/, '');
      record.normalizerVersion ??= 1;
      if (!record.operationId || !record.tool || !['started', 'completed', 'failed', 'cancelled'].includes(record.phase)
        || !evidencePattern.test(record.inputEvidenceId ?? '') || record.outputEvidenceId !== undefined && !evidencePattern.test(record.outputEvidenceId)
        || record.normalizerVersion !== 1) throw fault('EVIDENCE_RECEIPT_INPUT', 'Invalid operation receipt');
      const store = await receiptRegistry(directory);
      const commit = store.queue.then(async () => {
        const operation = store.operations.get(record.operationId);
        if (operation && operation.inputEvidenceId !== record.inputEvidenceId) throw fault('EVIDENCE_RECEIPT_CONFLICT', 'Operation input changed');
        const previous = operation?.[record.phase];
        if (previous) {
          if (comparable(previous) !== comparable(record)) throw fault('EVIDENCE_RECEIPT_CONFLICT', 'Operation result changed');
          return structuredClone(previous);
        }
        if (record.phase !== 'started' && (!operation?.started || operation.terminal)) throw fault('EVIDENCE_RECEIPT_CONFLICT', 'Completion needs one recorded start');
        const receiptId = `receipt-${digest(JSON.stringify([store.namespaceId, record.operationId, record.phase]))}`;
        const body = { format: 'pinhao-tool-receipt-1', version: 1, namespaceId: store.namespaceId, seq: store.rows.length + 1, receiptId, ...record };
        const saved = { ...body, receiptHash: digest(JSON.stringify(canonical(body))) };
        const target = path.join(store.root, `${String(saved.seq).padStart(12, '0')}-${receiptId}.json`), pending = `${target}.pending-${randomUUID()}`;
        await writeFile(pending, JSON.stringify(saved), { flag: 'wx', flush: true });
        await rename(pending, target);
        addReceipt(store, saved);
        return structuredClone(saved);
      });
      store.queue = commit.catch(() => {});
      return commit;
    },
    async resolveReceipt(receiptId) {
      if (!receiptPattern.test(receiptId ?? '')) throw fault('EVIDENCE_RECEIPT_INPUT', 'Invalid receipt identity');
      const store = await receiptRegistry(directory); await store.queue;
      const record = store.byId.get(receiptId);
      if (!record) throw fault('EVIDENCE_RECEIPT_MISSING', 'Receipt not found in this namespace');
      return structuredClone(record);
    },
    async readReceipts({ afterSeq = 0, limit = 100 } = {}) {
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fault('EVIDENCE_RECEIPT_INPUT', 'Invalid receipt cursor');
      const store = await receiptRegistry(directory); await store.queue;
      const rows = store.rows.filter(row => row.seq > afterSeq), records = rows.slice(0, limit);
      return { namespaceId: store.namespaceId, records: structuredClone(records), nextSeq: rows.length > limit ? records.at(-1).seq : null,
        lastSeq: store.rows.length, pendingFiles: [...store.pendingFiles] };
    },
    async search({ tool, file, runId, itemId, namespaceId, query, offset = 0, limit = 20 } = {}) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fault('EVIDENCE_RECEIPT_INPUT', 'Invalid evidence search cursor');
      const store = await receiptRegistry(directory); await store.queue;
      if (namespaceId !== undefined && namespaceId !== store.namespaceId) throw fault('EVIDENCE_NAMESPACE_MISMATCH', 'Evidence namespace is not authorized');
      const rows = store.rows.filter(row => row.phase !== 'started' && (!tool || row.tool === tool) && (!file || row.resourceRefs?.some(ref => ref.path === file))
        && (!runId || row.run?.runId === runId) && (!itemId || row.itemIds?.includes(itemId)));
      const slice = rows.slice(offset, offset + limit), items = [], blobs = new Map();
      for (const row of slice) {
        let matches = !query || JSON.stringify(row).includes(query);
        if (!matches && row.outputEvidenceId) {
          if (!blobs.has(row.outputEvidenceId)) blobs.set(row.outputEvidenceId, JSON.stringify((await load(row.outputEvidenceId)).value));
          matches = blobs.get(row.outputEvidenceId).includes(query);
        }
        if (matches) items.push(structuredClone(row));
      }
      return { namespaceId: store.namespaceId, total: rows.length, items, offset, scanned: slice.length,
        nextOffset: offset + slice.length < rows.length ? offset + slice.length : null, cursorKind: 'receipt-scan' };
    },
    async save(value, metadata = {}) {
      const content = JSON.stringify(value ?? null), evidenceId = `evidence-${digest(content)}`;
      await mkdir(root, { recursive: true });
      const record = { format: 'pinhao-tool-evidence-1', evidenceId, metadata, value: value ?? null };
      try { await writeFile(path.join(root, `${evidenceId}.json`), JSON.stringify(record), { flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      return { evidenceId, evidenceCharacters: content.length };
    },
    async read({ evidenceId, occurrenceId, receiptId, pointer = '', offset = 0, limit = 12, length = 2000 }) {
      if (!/^evidence-[a-f0-9]{64}$/.test(evidenceId ?? '') || !Number.isSafeInteger(offset) || offset < 0
          || !Number.isSafeInteger(limit) || limit < 1 || limit > 12 || !Number.isSafeInteger(length) || length < 1 || length > 2000
          || typeof pointer !== 'string' || pointer && (!pointer.startsWith('/') || /~(?![01])/.test(pointer))) throw new Error('证据编号与分页参数无效');
      const record = await load(evidenceId), occurrence = occurrenceId ?? receiptId;
      if (occurrence) {
        const registry = await receiptRegistry(directory); await registry.queue;
        const saved = registry.byId.get(occurrence);
        if (!saved || saved.outputEvidenceId !== evidenceId || saved.phase === 'started') throw fault('EVIDENCE_OCCURRENCE_MISMATCH', '该次操作与证据正文不匹配');
      }
      let value = record.value;
      if (pointer) for (const part of pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) throw new Error('证据字段不存在，请先查看上一层字段');
        value = value[part];
      }
      const read = (target, start = 0) => ({ tool: 'read_evidence', input: { evidenceId, ...(occurrence ? { occurrenceId: occurrence } : {}), pointer: target, offset: start, limit, length } });
      const base = { evidenceId, ...(occurrence ? { occurrenceId: occurrence, receiptId: occurrence } : {}), pointer, offset, readResult: read(pointer, offset),
        ...(record.value?.schema === 'pinhao-process-log-page-2' ? { sourcePage: record.value.sourcePage,
          runId: record.value.runId, stream: record.value.stream, captureGeneration: record.value.captureGeneration, captureStatus: record.value.captureStatus } : {}),
        ...(record.metadata?.tool === 'inspect_coverage' && record.metadata?.source !== 'tool-input' ? { sourcePage: { tool: 'inspect_coverage',
          offset: record.value.offset ?? 0, nextOffset: record.value.nextOffset ?? null,
          nextCall: record.value.nextPage ?? null, scope: 'This evidence contains one original tool page, not the entire coverage collection.' } } : {}) };
      const page = result => ({ ...base, ...result, nextCall: result.nextOffset == null
        ? pointer === '/content' ? base.sourcePage?.nextCall ?? null : null : read(pointer, result.nextOffset) });
      if (Array.isArray(value)) return page({ total: value.length, items: value.slice(offset, offset + limit), nextOffset: offset + limit < value.length ? offset + limit : null });
      if (typeof value === 'string') {
        if (offset > value.length || offset > 0 && /[\uDC00-\uDFFF]/.test(value[offset] ?? '') && /[\uD800-\uDBFF]/.test(value[offset - 1])) throw fault('EVIDENCE_INVALID_CURSOR', '文字游标落在字符中间，请使用上次返回的续读位置');
        let content = value.slice(offset, offset + length);
        if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1);
        // A one-code-unit request still returns one complete code point, never an empty loop.
        if (!content && offset < value.length) content = String.fromCodePoint(value.codePointAt(offset));
        return page({ totalCharacters: value.length, content, returnedCharacters: content.length,
          nextOffset: offset + content.length < value.length ? offset + content.length : null, offsetUnit: 'utf16' });
      }
      if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        return page({ directory: true, totalFields: entries.length, nextOffset: offset + limit < entries.length ? offset + limit : null,
          fields: entries.slice(offset, offset + limit).map(([key, item]) => {
            const target = `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
            return { key, pointer: target, read: read(target), type: Array.isArray(item) ? 'array' : typeof item,
              ...(Array.isArray(item) || typeof item === 'string' ? { length: item.length } : {}) };
          }) });
      }
      return { ...base, value };
    },
  };
}
