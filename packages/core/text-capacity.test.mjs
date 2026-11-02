import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { sdkProvider, modelCompatibilityKey, taskPrompt } from './provider.mjs';
import { packRequestBatches } from './request-batches.mjs';
import { textRequestLimits, estimateTextTokens, assertTextRequestCapacity, textRequestEstimate, createTextCapacityPlanner } from './text-capacity.mjs';

const unit = (id, source = 'Complete neutral sentence.') => ({ id, source, translation: source, kind: 'message', context: {}, tokens: [] });

test('text capacity has explicit defaults and preserves selected configured capacity', () => {
  const defaults = textRequestLimits();
  assert.equal(defaults.contextWindow, 32768); assert.equal(defaults.maxOutputTokens, 4096);
  assert.equal(defaults.capacitySource.contextWindow, 'conservative-default');
  assert.equal(textRequestLimits({ contextWindow: 64000, maxOutputTokens: 12000 }).maxOutputTokens, 12000);
  assert.throws(() => textRequestLimits({ contextWindow: 2048, maxOutputTokens: 4096 }), { code: 'MODEL_CAPACITY_CONFIGURATION' });
  assert.ok(estimateTextTokens('Neutral sentence.') < estimateTextTokens('完整对白句子需要保持。'.repeat(10)));
});

test('capacity packs more short units and fewer long units while keeping logical groups whole', () => {
  const connection = { contextWindow: 32768, maxOutputTokens: 4096 };
  const short = Array.from({ length: 35 }, (_, index) => [unit(String(index))]);
  const batches = packRequestBatches(short, { connection, referenceSelector: () => [] });
  assert.ok(batches[0].length > 16); assert.deepEqual(batches.flat(), short.flat());
  const long = Array.from({ length: 4 }, (_, index) => [unit(String(index), '完整的中性对白。'.repeat(70))]);
  const smaller = packRequestBatches(long, { connection, referenceSelector: () => [] });
  assert.ok(smaller.length > 1); assert.deepEqual(smaller.flat(), long.flat());
  const linked = [unit('a', '完整句子。'.repeat(1000)), unit('b')];
  assert.throws(() => packRequestBatches([linked], { connection, referenceSelector: () => [] }), error => {
    assert.equal(error.code, 'TEXT_GROUP_CAPACITY_EXCEEDED'); assert.deepEqual(error.unitIds, ['a', 'b']); return true;
  });
});

test('actual text SDK respects configured output and isolates compatibility by endpoint and model', async t => {
  const bodies = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); bodies.push({ url: request.url, ...body });
    response.setHeader('content-type', 'application/json');
    if (body.model === 'no-ceiling' && body.max_tokens !== undefined) {
      response.statusCode = 400; response.end(JSON.stringify({ error: { message: 'Unknown parameter: max_tokens' } })); return;
    }
    response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '{"records":[]}' }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const call = (model, url = baseUrl) => sdkProvider({ connection: { baseUrl: url, model, contextWindow: 32768, maxOutputTokens: 1800 }, system: 'Return JSON.', prompt: 'Neutral test.' });
  await call('no-ceiling'); await call('no-ceiling'); await call('supported'); await call('supported', baseUrl.replace('/v1', '/other'));
  assert.deepEqual(bodies.map(body => body.max_tokens), [1800, undefined, undefined, 1800, 1800]);
  assert.deepEqual(bodies.map(body => body.model), ['no-ceiling', 'no-ceiling', 'no-ceiling', 'supported', 'supported']);
  assert.equal(modelCompatibilityKey({ baseUrl, model: 'same' }), modelCompatibilityKey({ url: `${baseUrl}/chat/completions`, model: 'same' }));
});

test('final required evidence above capacity is preserved and rejected before any direct SDK fetch', async t => {
  const required = 'Complete neutral evidence. '.repeat(7000);
  const source = unit('target'), reference = unit('required-evidence', required);
  const connection = { baseUrl: 'http://localhost:1/v1', model: 'neutral-no-dispatch', contextWindow: 32768, maxOutputTokens: 4096 };
  const prepared = taskPrompt('translation', [source], 'zh-Hans', [reference], [], {
    evidenceResults: [{ query: { ids: [reference.id] }, returnedIds: [reference.id], total: 1, nextOffset: null }],
    maxCharacters: textRequestLimits(connection).maxCharacters,
  });
  assert.ok(prepared.prompt.includes(required), 'Mandatory evidence is never silently removed to fit a request');
  const check = error => {
    assert.equal(error.code, 'TEXT_REQUEST_CAPACITY_EXCEEDED'); assert.equal(error.fetchStarted, false);
    assert.equal(error.transportRequests, 0); assert.ok(error.estimatedInputTokens > connection.contextWindow); return true;
  };
  assert.throws(() => assertTextRequestCapacity({ connection, ...prepared }), check);
  let fetches = 0; t.mock.method(globalThis, 'fetch', () => { fetches++; throw new Error('No fetch permitted'); });
  await assert.rejects(sdkProvider({ connection, ...prepared }), check);
  assert.equal(fetches, 0);
});

test('service-style and final body projections use the same capacity assertion', () => {
  const connection = { contextWindow: 32768, maxOutputTokens: 4096 }, system = 'Neutral system.', prompt = 'Neutral complete paragraph.';
  const expected = assertTextRequestCapacity({ connection, system, prompt });
  assert.deepEqual(assertTextRequestCapacity({ connection, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }), expected);
  assert.throws(() => assertTextRequestCapacity({ connection, messages: [{ role: 'user', content: 'x'.repeat(180000) }] }), { code: 'TEXT_REQUEST_CAPACITY_EXCEEDED' });
});

const profile = { connection: { baseUrl: 'https://neutral.invalid/v1', model: 'neutral', contextWindow: 32768, maxOutputTokens: 4096 },
  role: 'proofreading', targetLanguage: 'zh-Hans', units: [unit('sample', '完整的中性正文。'.repeat(30))] };
const observe = (planner, outputTokens, extra = {}) => planner.observe({ ...profile, outputTokens,
  complete: true, validated: true, finishReason: 'stop', ...extra });

test('cold estimates use short plaintext frames and include complete existing review text', () => {
  const units = Array.from({ length: 24 }, (_, index) => unit(String(index)));
  const limits = textRequestLimits(profile.connection), prompt = { system: '', prompt: '' };
  const estimate = textRequestEstimate(prompt, units, limits);
  const oldJsonEstimate = units.reduce((sum, value) => sum + Math.ceil(estimateTextTokens(value.source) * 1.5) + 48, 16);
  assert.ok(estimate.estimatedOutputTokens < oldJsonEstimate - units.length * 35);
  const existing = [{ ...units[0], translation: 'An existing complete paragraph. '.repeat(40) }];
  assert.ok(textRequestEstimate(prompt, existing, limits, { role: 'proofreading' }).estimatedOutputTokens
    > textRequestEstimate(prompt, existing, limits, { role: 'translation' }).estimatedOutputTokens);
  assert.equal(estimate.reasoningReserve, 1024);
});

test('only three completed validated normal-stop actual outcomes warm a review profile with a rewrite floor', () => {
  const planner = createTextCapacityPlanner(), cold = planner.estimate(profile);
  for (const extra of [{ complete: false }, { validated: false }, { finishReason: 'interrupted' }, { outputTokens: undefined }, { outputTokens: NaN }]) {
    assert.equal(observe(planner, 20, extra), false);
  }
  assert.equal(planner.estimate(profile), cold);
  observe(planner, 20); observe(planner, 20);
  assert.equal(planner.estimate(profile), cold);
  observe(planner, 20);
  const warm = planner.estimate(profile);
  assert.ok(warm < cold);
  assert.ok(warm >= cold * 0.5 + 32, 'Even unchanged reviews reserve substantial full-revision output');
  const prompt = { system: '', prompt: '', responseProtocol: 'pinhao-review-1' }, limits = textRequestLimits(profile.connection);
  const options = { ...profile, capacityPlanner: planner };
  assert.equal(textRequestEstimate(prompt, profile.units, limits, options).estimatedOutputTokens, warm);
  assert.equal(textRequestEstimate(prompt, profile.units, limits, { ...options, fullRevision: true }).estimatedOutputTokens, cold);
  assert.equal(textRequestEstimate({ system: '', prompt: '' }, profile.units, limits, options).estimatedOutputTokens, cold,
    'A full-output review must not borrow sparse differential-review observations');
});

test('complete revisions and output outliers raise high-water estimates rather than being averaged away', () => {
  const planner = createTextCapacityPlanner({ maxSamples: 3 }), cold = planner.estimate(profile);
  for (let index = 0; index < 3; index++) observe(planner, cold);
  assert.ok(planner.estimate(profile) >= Math.ceil(cold * 1.25) + 32);
  observe(planner, cold * 3);
  const peak = planner.estimate(profile);
  assert.ok(peak >= Math.ceil(cold * 3 * 1.25) + 32);
  observe(planner, 20); observe(planner, 20);
  assert.equal(planner.estimate(profile), peak, 'The largest retained outcome, not the mean, owns the margin');
  observe(planner, 20);
  assert.ok(planner.estimate(profile) < peak, 'The bounded recent window does not retain every request forever');
});

test('profiles isolate endpoint/model/reasoning/role/language/capacity while excluding credentials', () => {
  const planner = createTextCapacityPlanner(), cold = planner.estimate(profile);
  for (let index = 0; index < 3; index++) observe(planner, 20);
  const warm = planner.estimate(profile);
  assert.ok(warm < cold);
  const credentialed = new URL('https://neutral.invalid/v1/chat/completions');
  credentialed.username = 'neutral-user'; credentialed.password = 'neutral-secret';
  credentialed.search = '?api_key=neutral-secret'; credentialed.hash = 'private';
  assert.equal(planner.estimate({ ...profile, connection: { ...profile.connection,
    baseUrl: credentialed.toString(), apiKey: 'different-neutral-credential' } }), warm);
  for (const different of [
    { connection: { ...profile.connection, baseUrl: 'https://other.invalid/v1' } },
    { connection: { ...profile.connection, model: 'other-model' } },
    { connection: { ...profile.connection, reasoning: 'enabled' } },
    { role: 'translation' }, { targetLanguage: 'en' },
    { connection: { ...profile.connection, maxOutputTokens: 2048 } },
    { connection: { ...profile.connection, contextWindow: 65536 } },
  ]) assert.equal(planner.estimate({ ...profile, ...different }), cold);
  assert.equal(observe(planner, 20, { connection: { model: 'neutral', baseUrl: 'not-an-endpoint?private=neutral' } }), false);
});

test('profile memory is bounded and truncation resets successful hints to smaller conservative requests', () => {
  const planner = createTextCapacityPlanner({ maxProfiles: 2 }), cold = planner.estimate(profile);
  for (const model of ['neutral', 'second', 'third']) for (let index = 0; index < 3; index++) {
    observe(planner, 20, { connection: { ...profile.connection, model } });
  }
  assert.equal(planner.estimate(profile), cold, 'Least-recently-used profiles are evicted');
  const second = { ...profile, connection: { ...profile.connection, model: 'second' } };
  assert.ok(planner.estimate(second) < cold);
  assert.equal(planner.observe({ ...second, finishReason: 'length' }), true);
  assert.ok(planner.estimate(second) >= Math.ceil(cold * 1.25));
  for (let index = 0; index < 2; index++) planner.observe({ ...second, complete: true, validated: true, finishReason: 'stop', outputTokens: 20 });
  assert.ok(planner.estimate(second) >= Math.ceil(cold * 1.25), 'Post-truncation hints must warm from scratch');
});

test('learning does not relax configured context, output or reasoning capacity', () => {
  const planner = createTextCapacityPlanner(), limits = textRequestLimits(profile.connection);
  for (let index = 0; index < 3; index++) observe(planner, 20);
  const prompt = { system: '', prompt: 'Required evidence. '.repeat(15000), responseProtocol: 'pinhao-review-1' };
  const estimate = textRequestEstimate(prompt, profile.units, limits, { ...profile, capacityPlanner: planner });
  assert.equal(estimate.overLimit, true);
  assert.equal(estimate.reasoningReserve, 1024);
  assert.deepEqual(textRequestLimits(profile.connection), limits);
  assert.throws(() => assertTextRequestCapacity({ connection: profile.connection, ...prompt }), { code: 'TEXT_REQUEST_CAPACITY_EXCEEDED' });
});
