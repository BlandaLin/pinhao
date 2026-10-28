import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from './store.mjs';
import { persistAcceptedBatch, discoverAcceptedBatches, readAcceptedBatch, createAcceptanceLedger } from './accepted-batches.mjs';

test('accepted producer receipt survives a lost callback, database reopen and lost ACK without republishing', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-acceptance-'));
  let db;
  t.after(async () => { db?.close(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); });
  const directory = path.join(root, 'receipts');
  const extraction = { workspaceDir: path.join(root, 'writer'), units: [{ id: 'a', source: 'Hello', locator: { file: 'scene.json', pointer: '/text' } }], binding: { recipeId: 'recipe-a' } };
  const record = await persistAcceptedBatch({ directory, projectId: 'project-a', adaptationRequestId: 'request-a', extraction });
  assert.deepEqual(await readAcceptedBatch({ directory, record }), extraction);
  assert.equal((await discoverAcceptedBatches(directory)).length, 1);
  db = createStore(root);
  const connect = () => createAcceptanceLedger({ store: { ...db, transaction: (_project, action) => db.transaction(action) }, projectId: 'project-a', adaptationRequestId: 'request-a' });
  let ledger = connect();
  ledger.enqueue(record);
  assert.equal(ledger.pending().length, 1);
  assert.throws(() => ledger.commit(record.id, () => { db.put('projects', { id: 'project-a', publication: 1 }); throw new Error('disk transaction failed'); }));
  assert.equal(db.one('projects', 'project-a'), undefined);
  assert.equal(ledger.pending().length, 1);
  ledger.commit(record.id, () => { db.put('projects', { id: 'project-a', publication: 1 }); return { generation: 1, addedUnits: 1 }; });
  db.close();
  db = createStore(root); ledger = connect();
  ledger.enqueue(record);
  const result = ledger.commit(record.id, () => { throw new Error('must not publish twice'); });
  assert.equal(result.reused, true);
  assert.deepEqual(ledger.summary(), { accepted: 1, integrated: 1, pendingIntegration: 0, stale: 0 });
  assert.equal(db.one('projects', 'project-a').publication, 1);
});

test('stale receipts stay auditable without blocking pending delivery and can be locally revalidated', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-acceptance-stale-'));
  const db = createStore(path.join(root, 'db'));
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); });
  const record = await persistAcceptedBatch({ directory: path.join(root, 'receipts'), projectId: 'a', adaptationRequestId: 'r', extraction: { units: [] } });
  const ledger = createAcceptanceLedger({ store: { ...db, transaction: (_project, action) => db.transaction(action) }, projectId: 'a', adaptationRequestId: 'r' });
  ledger.enqueue(record);
  ledger.mark(record.id, 'stale', { code: 'ADAPTER_ACCEPTED_STALE', message: 'Consumer changed' });
  assert.equal(ledger.pending().length, 0);
  assert.deepEqual(ledger.summary(), { accepted: 1, integrated: 0, pendingIntegration: 0, stale: 1 });
  assert.equal(ledger.findExtraction({ units: [] }).lastError.code, 'ADAPTER_ACCEPTED_STALE');
  assert.equal(ledger.enqueue(record).status, 'stale', 'a replay cannot reset qualification');
  ledger.commit(record.id, () => ({ generation: 1, addedUnits: 0 }));
  assert.deepEqual(ledger.summary(), { accepted: 1, integrated: 1, pendingIntegration: 0, stale: 0 });
});

test('accepted record identity, project binding and extraction bytes cannot be replaced', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-acceptance-integrity-'));
  let db;
  t.after(async () => { db?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); });
  const record = await persistAcceptedBatch({ directory, projectId: 'a', adaptationRequestId: 'r', extraction: { units: [] } });
  db = createStore(path.join(directory, 'db'));
  const ledger = createAcceptanceLedger({ store: db, projectId: 'b', adaptationRequestId: 'r' });
  assert.throws(() => ledger.enqueue(record), { code: 'ACCEPTANCE_RECEIPT_CONFLICT' });
  await writeFile(path.join(directory, `${record.payload.extractionHash}.extraction.json`), '{"units":["changed"]}');
  await assert.rejects(readAcceptedBatch({ directory, record }), { code: 'ACCEPTANCE_RECEIPT_CONFLICT' });
});
