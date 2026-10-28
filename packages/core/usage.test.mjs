import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage, summarizeRequestArtifacts, recordUsage, resetUsage, usageSummary } from './usage.mjs';
import { loadRequestUsageSummary } from './request-artifacts.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('cache read/write dialects normalize without inventing unreported counts or cost', () => {
  assert.equal(normalizeUsage({ inputTokens: 10, inputTokenDetails: { cacheReadTokens: 4, cacheWriteTokens: 2 } }).cacheReadTokens, 4);
  assert.equal(normalizeUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 3 } }).cacheReadTokens, 3);
  assert.equal(normalizeUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 6 }).cacheReadTokens, 6);
  assert.equal(normalizeUsage({ cache_read_input_tokens: 8, cache_creation_input_tokens: 5 }).cacheWriteTokens, 5);
  assert.equal(normalizeUsage({ inputTokens: 10 }).cacheReadTokens, null);
  assert.equal(normalizeUsage({ inputTokens: 10 }).cost, null);
  resetUsage(); recordUsage({ usage: { inputTokens: 10 } });
  assert.equal(usageSummary().total.cacheReadTokens, null);
  recordUsage({ usage: { inputTokens: 10, cacheReadTokens: 0 } });
  assert.equal(usageSummary().total.cacheReadTokens, 0); resetUsage();
});

test('saved artifact reconstruction deduplicates identities and keeps retry/cancellation/unknown attempts visible after restart', () => {
  const artifact = { request: { requestContext: { projectId: 'project', taskId: 'text' } },
    result: { id: 'a', status: 'received', summary: { transportRequests: 2, usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cost: 0.1 } } },
    events: [{ type: 'send', index: 1 }, { type: 'send', index: 2 }] };
  const cancelled = { request: { requestContext: { projectId: 'project', taskId: 'text' } },
    result: { id: 'b', status: 'failed', error: { category: 'cancelled' }, summary: { transportRequests: 1 } }, events: [] };
  const queued = { id: 'c', request: { requestContext: { projectId: 'other', taskId: 'queued' } }, events: [] };
  const source = [artifact, artifact, cancelled, queued];
  const before = summarizeRequestArtifacts(source), restored = summarizeRequestArtifacts(JSON.parse(JSON.stringify(source)));
  assert.deepEqual(restored, before); assert.equal(before.total.requests, 3); assert.equal(before.total.httpAttempts, 3);
  assert.equal(before.total.knownCost, 0.1); assert.equal(before.total.unknownCostAttempts, 2);
  assert.equal(before.total.unknownUsageAttempts, 2); assert.equal(before.total.cancelledRequests, 1);
  assert.equal(before.total.cacheReadTokens, 4); assert.equal(before.total.cacheWriteTokens, null);
  assert.equal(before.byProject.other.knownCost, null);
  assert.equal(before.total.acceptedUnits, undefined, 'received candidates are never counted as accepted delivery');
});

test('on-demand usage reads persistent artifacts beyond task-history projections and reports incomplete evidence', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-usage-artifacts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (let index = 0; index < 23; index++) {
    const root = path.join(directory, `request-${index}`); await mkdir(root);
    await writeFile(path.join(root, 'request.json'), JSON.stringify({ requestContext: { projectId: 'p', taskId: 't' } }));
    await writeFile(path.join(root, 'events.jsonl'), '{"type":"send","index":1}\n');
    await writeFile(path.join(root, 'result.json'), JSON.stringify({ id: `r-${index}`, status: 'received', summary: { transportRequests: 1, usage: { inputTokens: 1, cost: 0.01 } } }));
  }
  const first = await loadRequestUsageSummary(directory), restarted = await loadRequestUsageSummary(directory);
  assert.deepEqual(restarted, first); assert.equal(first.total.requests, 23); assert.equal(first.total.httpAttempts, 23);
  assert.equal(first.total.unknownCostAttempts, 0); assert.equal(first.total.cacheReadTokens, null);
  assert.equal(first.evidenceComplete, true);
  await writeFile(path.join(directory, 'request-0', 'result.json'), '{unfinished');
  const partial = await loadRequestUsageSummary(directory);
  assert.equal(partial.total.requests, 23); assert.equal(partial.total.unknownCostAttempts, 1);
  assert.equal(partial.evidenceComplete, false); assert.equal(partial.warnings[0].code, 'UNREADABLE_REQUEST_EVIDENCE');
});

test('a persisted send intention is not proof of an HTTP attempt or a paid cancellation', () => {
  const beforeSend = { id: 'cancelled', result: { status: 'failed', error: { category: 'cancelled' }, summary: { transportRequests: 0 } },
    events: [{ type: 'send', index: 1 }] };
  const stopped = summarizeRequestArtifacts([beforeSend]);
  assert.equal(stopped.total.httpAttempts, 0); assert.equal(stopped.total.unknownCostAttempts, 0);
  const interrupted = summarizeRequestArtifacts([{ id: 'unfinished', events: [{ type: 'send', index: 1 }] }]);
  assert.equal(interrupted.total.httpAttempts, 0); assert.equal(interrupted.total.uncertainDispatchAttempts, 1);
  assert.equal(interrupted.total.unknownCostAttempts, 1); assert.equal(interrupted.total.knownCost, null);
});

test('text-only artifact projections exclude other channels and explicitly expose unassigned historical evidence', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-usage-channel-filter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const save = async (id, request, cost) => {
    const root = path.join(directory, id); await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'request.json'), JSON.stringify(request));
    await writeFile(path.join(root, 'result.json'), JSON.stringify({ id, status: 'received', summary: { transportRequests: 1, usage: { inputTokens: 10, cost } } }));
  };
  await save('translation', { role: 'translation' }, 1);
  await save('proofreading', { requestContext: { purpose: 'proofreading' } }, 2);
  await save('known-assist', { role: 'recollection' }, 4);
  await save('images/old-image', {}, 8);
  await save('recollection/old-assist', {}, 16);
  await save('unassigned', {}, 32);
  const full = await loadRequestUsageSummary(directory), text = await loadRequestUsageSummary(directory, { roles: ['translation', 'proofreading'] });
  assert.equal(full.total.requests, 6); assert.equal(full.total.knownCost, 63);
  assert.equal(text.total.requests, 2); assert.equal(text.total.knownCost, 3);
  assert.equal(text.excludedRequests, 3); assert.equal(text.unassignedRequests, 1);
  assert.equal(text.evidenceComplete, false); assert.ok(text.warnings.some(warning => warning.code === 'UNASSIGNED_REQUEST_ROLE'));
});
