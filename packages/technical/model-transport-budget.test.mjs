import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAdaptationBudget, recoverAdaptationBudget } from '../core/adaptation-budget.mjs';
import { createTechnicalTransport } from './model-transport.mjs';
import { acquireModelRequestSlot, configureRequestSlots } from '../core/provider.mjs';

function budget(t, maxHttpAttempts = 4) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let failNextPatch = false;
  db.exec('CREATE TABLE project (body TEXT NOT NULL)'); db.prepare('INSERT INTO project VALUES (?)').run('{"id":"project"}');
  const callbacks = { readProject: () => JSON.parse(db.prepare('SELECT body FROM project').get().body),
    patchProject: (_id, patch) => { if (failNextPatch) { failNextPatch = false; throw new Error('Injected SQLite settlement interruption'); }
      const row = JSON.parse(db.prepare('SELECT body FROM project').get().body); db.prepare('UPDATE project SET body=?').run(JSON.stringify({ ...row, ...patch })); },
    transaction: (_id, fn) => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } } };
  const factory = createAdaptationBudget(callbacks);
  const owner = factory.forRequest('project', 'request', { historyCoverage: 'complete', limits: { maxHttpAttempts, maxWindows: 1 } });
  owner.openWindow({ windowId: 'window' });
  return { owner, context: { owner, jobId: 'job', windowId: 'window', purpose: 'adaptation', taskId: 'task' },
    failNextPatch: () => { failNextPatch = true; },
    reload: () => createAdaptationBudget(callbacks).forRequest('project', 'request') };
}
const response = () => new Response(JSON.stringify({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost: 0.01 } }), { headers: { 'content-type': 'application/json' } });
const body = { body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'Neutral request.' }], stream: false }) };

test('parallel technical jobs send only once for the final cumulative allowance and preserve its paid result', async t => {
  const { owner, context } = budget(t, 1); let calls = 0;
  const transports = [1, 2, 3].map(index => createTechnicalTransport({ requestContext: { ...context, jobId: `job-${index}` }, fetchImpl: async () => { calls++; await delay(20); return response(); } }));
  const results = await Promise.allSettled(transports.map(async transport => (await transport.fetch('https://last-slot-budget.invalid', body)).text()));
  await Promise.all(transports.map(transport => transport.flush()));
  assert.equal(calls, 1); assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.filter(value => value.reason?.code === 'ADAPTATION_BUDGET_EXHAUSTED').length, 2);
  assert.equal(owner.snapshot().httpUsed, 1); assert.equal(owner.snapshot().httpSentKnown, 1); assert.equal(owner.snapshot().knownCost, 0.01);
});

test('each ceiling and streaming compatibility send is charged and artifacts form one retry chain', async t => {
  const { owner, context } = budget(t, 3), directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-budget-fallback-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 }));
  let calls = 0;
  const transport = createTechnicalTransport({ directory, requestContext: context, fetchImpl: async () => {
    calls++;
    if (calls === 1) return new Response('{"error":{"message":"Unsupported parameter: max_tokens"}}', { status: 400 });
    if (calls === 2) return new Response('{"error":{"message":"Streaming is not supported"}}', { status: 400 });
    return response();
  } });
  await (await transport.fetch('https://fallback-budget.invalid', { body: JSON.stringify({ ...JSON.parse(body.body), stream: true }) })).text();
  const records = await transport.flush();
  assert.equal(calls, 3); assert.equal(records.length, 3); assert.equal(owner.snapshot().httpUsed, 3);
  assert.equal(owner.snapshot().knownCost, 0.01); assert.equal(owner.snapshot().unknownCostAttempts, 2);
  assert.equal(records[1].requestContext.retryOf, records[0].id); assert.equal(records[2].requestContext.retryOf, records[1].id);
  for (const record of records) {
    assert.equal(record.requestContext.httpAttemptId, record.id); assert.equal(record.requestContext.adaptationRequestId, 'request');
    const saved = JSON.parse(await readFile(path.join(record.directory, 'request.json'), 'utf8'));
    assert.deepEqual(saved.requestContext, record.requestContext); assert.equal('owner' in saved.requestContext, false);
    assert.deepEqual(JSON.parse(await readFile(path.join(record.directory, 'result.json'), 'utf8')).requestContext, record.requestContext);
  }
});

test('unsupported streaming cannot sneak a second HTTP attempt past the cumulative cap', async t => {
  const { owner, context } = budget(t, 1); let calls = 0;
  const transport = createTechnicalTransport({ requestContext: context, fetchImpl: async () => { calls++; return new Response('streaming is not supported', { status: 400 }); } });
  await assert.rejects(transport.fetch('https://stream-budget.invalid', { body: JSON.stringify({ stream: true }) }), { code: 'ADAPTATION_BUDGET_EXHAUSTED' });
  await transport.flush(); assert.equal(calls, 1); assert.equal(owner.snapshot().unknownCostAttempts, 1);
});

test('cancellation before actual fetch returns its reservation but cancellation after fetch keeps unknown cost', async t => {
  const { owner, context } = budget(t, 1), first = new AbortController(); let calls = 0;
  const wrapped = { ...owner, markSent(id) { owner.markSent(id); first.abort(new Error('Paused before actual fetch')); } };
  const prepared = createTechnicalTransport({ requestContext: { ...context, owner: wrapped }, signal: first.signal, fetchImpl: async () => { calls++; return response(); } });
  await assert.rejects(prepared.fetch('https://cancel-budget.invalid', body), /Paused before/); await prepared.flush();
  assert.equal(calls, 0); assert.equal(owner.snapshot().httpUsed, 0);
  const second = new AbortController();
  const sent = createTechnicalTransport({ requestContext: context, signal: second.signal, fetchImpl: async () => { calls++; second.abort(new Error('Paused after actual fetch')); return new Promise(() => {}); } });
  await assert.rejects(sent.fetch('https://cancel-budget.invalid', body), /Paused after/); await sent.flush();
  assert.equal(calls, 1); assert.equal(owner.snapshot().httpUsed, 1); assert.equal(owner.snapshot().httpSentKnown, 1);
  assert.equal(owner.snapshot().knownCost, null); assert.equal(owner.snapshot().unknownCostAttempts, 1);
});

test('cancelling provider queue does not reserve or send HTTP', async t => {
  configureRequestSlots(1); t.after(() => configureRequestSlots(Infinity));
  const release = await acquireModelRequestSlot({ key: 'occupied' }); t.after(release);
  const { owner, context } = budget(t, 1), controller = new AbortController(); let calls = 0;
  const transport = createTechnicalTransport({ requestContext: context, signal: controller.signal, fetchImpl: async () => { calls++; return response(); } });
  const pending = transport.fetch('https://queued-budget.invalid', body); await delay(10); controller.abort(new Error('Pause while queued'));
  await assert.rejects(pending, error => error.message === 'Pause while queued' || error.cause?.message === 'Pause while queued'); await transport.flush();
  assert.equal(calls, 0); assert.equal(owner.snapshot().httpUsed, 0);
});

test('artifact preparation failure is not billed as HTTP, but post-send accounting failure stops later sends', async t => {
  const { owner, context } = budget(t, 2); let calls = 0;
  const failed = createTechnicalTransport({ directory: 'fixture-only', requestContext: context,
    artifactFactory: async () => { throw new Error('Evidence disk failed'); }, fetchImpl: async () => { calls++; return response(); } });
  await assert.rejects(failed.fetch('https://persist-budget.invalid', body), /Evidence disk failed/); await failed.flush();
  assert.equal(calls, 0); assert.equal(owner.snapshot().httpUsed, 0);
  const brokenOwner = { ...owner, settle() { throw new Error('Budget disk failed after send'); } };
  const sent = createTechnicalTransport({ requestContext: { ...context, owner: brokenOwner }, fetchImpl: async () => { calls++; return response(); } });
  await (await sent.fetch('https://persist-budget.invalid', body)).text();
  await assert.rejects(sent.flush(), /Budget disk failed after send/);
  await assert.rejects(sent.fetch('https://persist-budget.invalid', body), /Budget disk failed after send/);
  assert.equal(calls, 1); assert.equal(owner.snapshot().httpUsed, 1);
});

test('a mismatched host project/request context fails before reservation or network access', async t => {
  const { owner, context } = budget(t); let calls = 0;
  const transport = createTechnicalTransport({ requestContext: { ...context, adaptationRequestId: 'other-request' }, fetchImpl: async () => { calls++; return response(); } });
  await assert.rejects(transport.fetch('https://wrong-budget-owner.invalid', body), /does not match/); await transport.flush();
  assert.equal(calls, 0); assert.equal(owner.snapshot().httpUsed, 0);
});

test('recovery reads the exact host artifact pointer after interrupted settlement without buying or inventing usage', async t => {
  const { owner, context, reload } = budget(t, 2), directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-budget-recover-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 }));
  let calls = 0;
  const interrupted = { ...owner, settle() { throw new Error('Simulated interruption after artifact commit'); } };
  const transport = createTechnicalTransport({ directory: path.join(directory, 'jobs', 'job', 'request-artifacts'), requestContext: { ...context, owner: interrupted },
    fetchImpl: async () => { calls++; return response(); } });
  await (await transport.fetch('https://recover-budget.invalid', body)).text();
  await assert.rejects(transport.flush(), /Simulated interruption/);
  assert.equal(owner.snapshot().knownCost, null); assert.equal(owner.snapshot().httpUsed, 1);
  assert.equal(owner.recoveryAttempts().length, 0, 'another live owner is not crash reconciliation');
  const restarted = reload(), recovered = await recoverAdaptationBudget({ owner: restarted, directory });
  assert.equal(recovered.recovered, 1); assert.equal(recovered.errors.length, 0);
  assert.equal(restarted.snapshot().knownCost, 0.01); assert.equal(restarted.snapshot().knownUsage.totalTokens, 6);
  assert.equal(restarted.snapshot().httpUsed, 1); assert.equal(restarted.snapshot().httpSentKnown, 1);
  assert.equal((await recoverAdaptationBudget({ owner: restarted, directory })).unchanged, 1, 'unknown reasoning count does not reread unchanged final metadata');
  assert.equal(calls, 1);
});

test('recovery never converts a mismatched or escaping artifact into known billing', async t => {
  const { owner, context, reload } = budget(t, 2), directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-budget-recover-reject-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 }));
  const transport = createTechnicalTransport({ directory, requestContext: { ...context, owner: { ...owner, settle() { throw new Error('interrupted'); } } }, fetchImpl: async () => response() });
  await (await transport.fetch('https://recover-reject-budget.invalid', body)).text();
  await assert.rejects(transport.flush(), /interrupted/);
  const restarted = reload(), [attempt] = restarted.recoveryAttempts(), file = path.join(attempt.artifactDirectory, 'result.json');
  const { writeFile } = await import('node:fs/promises');
  const result = JSON.parse(await readFile(file, 'utf8')); result.requestContext.adaptationRequestId = 'wrong-owner';
  await writeFile(file, JSON.stringify(result));
  const rejected = await recoverAdaptationBudget({ owner: restarted, directory });
  assert.equal(rejected.recovered, 0); assert.equal(rejected.errors.length, 1); assert.equal(restarted.snapshot().knownCost, null);
  owner.reserve({ httpAttemptId: 'escaping', windowId: 'window', artifactDirectory: path.join(directory, '..', 'unrelated-artifact') }); owner.markSent('escaping');
  const escaped = await recoverAdaptationBudget({ owner: reload(), directory });
  assert.equal(escaped.recovered, 0); assert.ok(escaped.errors.some(error => /escaped/.test(error.message)));
  assert.equal(escaped.snapshot.httpUsed, 2); assert.equal(escaped.snapshot.unknownCostAttempts, 2);
});

test('a failed settlement transaction clears only the live marker so same-process artifact recovery can finish', async t => {
  const { owner, context, failNextPatch } = budget(t, 1), directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-budget-recover-live-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 }));
  const { createRequestArtifact } = await import('../core/request-artifacts.mjs');
  let calls = 0;
  const transport = createTechnicalTransport({ directory, requestContext: context, fetchImpl: async () => { calls++; return response(); },
    artifactFactory: async args => { const artifact = await createRequestArtifact(args); return { ...artifact, finish: async metadata => {
      const reference = await artifact.finish(metadata); failNextPatch(); return reference;
    } }; } });
  await (await transport.fetch('https://recover-live-budget.invalid', body)).text();
  await assert.rejects(transport.flush(), /Injected SQLite settlement interruption/);
  assert.equal(owner.snapshot().httpUsed, 1, 'a persistence error never refunds a possible send');
  assert.equal(owner.recoveryAttempts().length, 1, 'finished HTTP is no longer a live transport');
  assert.equal((await recoverAdaptationBudget({ owner, directory })).recovered, 1);
  assert.equal(owner.snapshot().httpUsed, 1); assert.equal(owner.snapshot().knownCost, 0.01); assert.equal(calls, 1);
});
