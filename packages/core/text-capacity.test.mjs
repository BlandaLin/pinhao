import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { sdkProvider, modelCompatibilityKey, taskPrompt } from './provider.mjs';
import { packRequestBatches } from './request-batches.mjs';
import { textRequestLimits, estimateTextTokens, assertTextRequestCapacity } from './text-capacity.mjs';

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
