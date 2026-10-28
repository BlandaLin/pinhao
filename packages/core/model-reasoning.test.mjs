import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { applyModelReasoning, reasoningPreference } from './model-reasoning.mjs';
import { sdkProvider } from './provider.mjs';
import { createTechnicalTransport } from '../technical/model-transport.mjs';

async function endpoint(t, respond) {
  const requests = [], upstream = fetch;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    response.setHeader('content-type', 'application/json');
    if (respond) return respond(response, body, requests.length);
    response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '{"records":[]}', reasoning_content: 'Neutral retained reasoning.' }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(['openrouter.ai', 'api.deepseek.com'].includes(new URL(url).hostname));
    return upstream(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, options);
  });
  return requests;
}

test('default reasoning leaves request bodies and retry identities untouched; unsupported explicit modes fail closed', () => {
  const body = { messages: [{ role: 'user', content: 'Neutral text.' }], reasoning: { effort: 'low' } };
  for (const reasoning of [undefined, 'auto']) {
    const connection = { baseUrl: 'http://127.0.0.1/v1', reasoning };
    assert.equal(applyModelReasoning(body, connection), body);
    assert.deepEqual(reasoningPreference(connection), {});
  }
  for (const baseUrl of ['http://127.0.0.1/v1', 'https://openrouter.ai.example/v1', 'https://example.com/openrouter.ai']) {
    assert.throws(() => applyModelReasoning(body, { baseUrl, reasoning: 'disabled' }), { code: 'MODEL_REASONING_UNSUPPORTED' });
  }
  assert.throws(() => reasoningPreference({ reasoning: 'hide' }), /模型推理请选择/);
});

for (const [baseUrl, field] of [['https://openrouter.ai/api/v1', 'reasoning'], ['https://api.deepseek.com/v1', 'thinking']]) {
  test(`${field} preference reaches actual text SDK and technical HTTP bodies without hiding reasoning or removing tools`, async t => {
    const requests = await endpoint(t);
    const messages = [{ role: 'assistant', content: 'Keep history.', reasoning_content: 'Keep prior reasoning.' }, { role: 'user', content: 'Continue.' }];
    const tools = [{ type: 'function', function: { name: 'inspect', parameters: { type: 'object', properties: {} } } }];
    for (const reasoning of ['auto', 'enabled', 'disabled']) {
      const connection = { baseUrl, model: 'neutral-model', reasoning };
      const result = await sdkProvider({ connection, system: 'Return JSON.', prompt: 'Return {"records":[]}.' });
      assert.deepEqual(result.records, []);
      assert.ok(result.reasoningCharacters > 0, 'Returned reasoning is not hidden even when disabling is requested');
      const transport = createTechnicalTransport({ connection });
      const response = await transport.fetch(`${baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify({ model: connection.model, messages, tools }) });
      await response.text(); await transport.flush();
      for (const body of requests.slice(-2)) {
        assert.deepEqual(body[field], reasoning === 'auto' ? undefined : field === 'reasoning' ? { enabled: reasoning === 'enabled' } : { type: reasoning });
        assert.equal(body[field === 'reasoning' ? 'thinking' : 'reasoning'], undefined);
      }
      assert.deepEqual(requests.at(-1).messages, messages);
      assert.deepEqual(requests.at(-1).tools, tools);
    }
    assert.equal(requests.length, 6);
  });
}

test('a rejected reasoning setting is not silently dropped for a second paid request', async t => {
  const requests = await endpoint(t, response => {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: { message: 'The reasoning setting is unsupported by this model.' } }));
  });
  const connection = { baseUrl: 'https://openrouter.ai/api/v1', model: 'neutral-model', reasoning: 'disabled' };
  await assert.rejects(sdkProvider({ connection, system: 'Return JSON.', prompt: 'Return {"records":[]}.' }));
  assert.equal(requests.length, 1);
  const transport = createTechnicalTransport({ connection });
  const response = await transport.fetch(`${connection.baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [] }) });
  await response.text(); await transport.flush();
  assert.equal(response.status, 400);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(body => body.reasoning.enabled === false));
});

test('stream compatibility fallback preserves the explicit reasoning choice in both transports', async t => {
  const requests = await endpoint(t, (response, body) => {
    if (body.stream) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: { message: 'stream is not supported; use stream=false' } }));
    } else response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '{"records":[]}' }, finish_reason: 'stop' }] }));
  });
  const connection = { baseUrl: 'https://openrouter.ai/api/v1', model: 'neutral-model', reasoning: 'enabled' };
  await sdkProvider({ connection, system: 'Return JSON.', prompt: 'Return {"records":[]}.' });
  const transport = createTechnicalTransport({ connection });
  const response = await transport.fetch(`${connection.baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [], stream: true }) });
  await response.text(); await transport.flush();
  assert.deepEqual(requests.map(body => body.stream), [true, false, true, false]);
  assert.ok(requests.every(body => body.reasoning.enabled === true));
});

test('an output-ceiling rejection does not remove the selected reasoning mode', async t => {
  const requests = await endpoint(t, (response, body) => {
    if (body.max_tokens !== undefined) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: { message: 'Unknown parameter: max_tokens' } }));
    } else response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '{"records":[]}' }, finish_reason: 'stop' }] }));
  });
  const connection = { baseUrl: 'https://api.deepseek.com/v1', model: 'neutral-model', reasoning: 'disabled' };
  await sdkProvider({ connection, system: 'Return JSON.', prompt: 'Return {"records":[]}.' });
  assert.equal(requests.length, 2);
  const transport = createTechnicalTransport({ connection });
  const response = await transport.fetch(`${connection.baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [] }) });
  await response.text(); await transport.flush();
  assert.equal(requests.length, 3, 'The technical channel reuses the shared output-ceiling diagnosis');
  assert.ok(requests.every(body => body.thinking.type === 'disabled'));
  assert.equal(requests.at(-1).max_tokens, undefined);
});
