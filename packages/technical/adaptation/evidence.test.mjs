import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createEvidenceStore } from './evidence.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(process.env.PINHAO_TEST_TMP ?? os.tmpdir(), 'pinhao-receipts-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  return { root, store: createEvidenceStore(root) };
}
async function operation(store, operationId, input, output, extra = {}) {
  const inputEvidenceId = (await store.save(input)).evidenceId, outputEvidenceId = (await store.save(output)).evidenceId;
  const base = { operationId, tool: 'read_resource', inputEvidenceId, resourceRefs: [{ originId: 'origin', path: 'one.txt', baselineHash: 'hash', root: input.root }], ...extra };
  const start = await store.recordReceipt({ ...base, phase: 'started' });
  const complete = await store.recordReceipt({ ...base, phase: 'completed', outputEvidenceId });
  return { base, start, complete };
}

test('same content may share blobs but source and work calls have distinct immutable provenance', async t => {
  const { store } = await fixture(t), output = { content: 'same output' };
  const source = await operation(store, 'source-call', { root: 'source' }, output), work = await operation(store, 'work-call', { root: 'work' }, output);
  assert.equal(source.complete.outputEvidenceId, work.complete.outputEvidenceId);
  assert.notEqual(source.complete.receiptId, work.complete.receiptId);
  assert.equal((await store.resolveReceipt(work.complete.receiptId)).resourceRefs[0].root, 'work');
  assert.deepEqual((await store.readReceipts()).records.map(row => row.seq), [1, 2, 3, 4]);
});

test('concurrent stores serialize small receipts, reject changed operation input, and do not duplicate long output', async t => {
  const { root, store } = await fixture(t), other = createEvidenceStore(root), long = 'a complete process output '.repeat(4000);
  const calls = await Promise.all(Array.from({ length: 8 }, (_, index) => operation(index % 2 ? store : other, `op-${index}`, { index }, { content: long })));
  const receipts = await store.readReceipts(); assert.equal(receipts.lastSeq, 16);
  assert.equal(new Set(receipts.records.map(row => row.receiptId)).size, 16);
  const call = calls[0], duplicate = await other.recordReceipt({ ...call.base, phase: 'completed', outputEvidenceId: call.complete.outputEvidenceId });
  assert.equal(duplicate.seq, call.complete.seq); assert.ok(JSON.stringify(duplicate).length < 3000);
  assert.ok(!JSON.stringify(duplicate).includes(long));
  await assert.rejects(store.recordReceipt({ ...call.base, phase: 'started', inputEvidenceId: (await store.save({ changed: true })).evidenceId }), error => error.code === 'EVIDENCE_RECEIPT_CONFLICT');
});

test('a persisted completion replays beyond an older snapshot, while starts without completion remain explicit', async t => {
  const { store } = await fixture(t);
  const one = await operation(store, 'one', {}, { content: 'caption' }, { hostEventPayload: { type: 'recipe_accepted', itemId: 'item', key: 'binding' } });
  const inputEvidenceId = (await store.save({ file: 'pending' })).evidenceId;
  await store.recordReceipt({ operationId: 'unconfirmed-side-effect', tool: 'run_workspace', phase: 'started', inputEvidenceId });
  const replay = await store.readReceipts({ afterSeq: one.start.seq, limit: 1 });
  assert.equal(replay.records[0].receiptId, one.complete.receiptId);
  assert.equal(replay.nextSeq, one.complete.seq);
  const tail = await store.readReceipts({ afterSeq: replay.nextSeq });
  assert.equal(tail.records[0].phase, 'started'); assert.equal(tail.nextSeq, null);
  const search = await store.search({ query: 'caption', limit: 1 });
  assert.equal(search.items[0].receiptId, one.complete.receiptId);
  assert.equal((await store.search({ tool: 'run_workspace' })).items.length, 0);
});

test('fresh-process recovery validates published receipts and does not silently skip corrupt records', async t => {
  const { root, store } = await fixture(t); const saved = await operation(store, 'read', {}, { value: 'text' });
  const fresh = await import(`./evidence.mjs?recovery=${randomUUID()}`), restored = fresh.createEvidenceStore(root);
  assert.equal((await restored.resolveReceipt(saved.complete.receiptId)).seq, 2);
  const names = (await readdir(path.join(root, 'evidence-receipts'))).filter(name => name.endsWith('.json') && name !== 'namespace.json').sort();
  const file = path.join(root, 'evidence-receipts', names[0]), record = JSON.parse(await readFile(file, 'utf8'));
  record.tool = 'tampered'; await writeFile(file, JSON.stringify(record));
  const again = await import(`./evidence.mjs?corrupt=${randomUUID()}`);
  await assert.rejects(again.createEvidenceStore(root).readReceipts(), error => error.code === 'EVIDENCE_RECEIPT_CORRUPT');
});
