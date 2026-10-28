import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runAdaptation } from './adaptation.mjs';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';

async function fixture(t, reply) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-source-output-sdk-'));
  const gameDir = path.join(directory, 'game'), workspaceDir = path.join(directory, 'work');
  await mkdir(gameDir); await mkdir(workspaceDir);
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); requests.push(body);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `neutral-${requests.length}`, object: 'chat.completion', created: 1, model: 'fixture', choices: [
      { index: 0, ...await reply(requests.length, body) } ] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { directory, gameDir, workspaceDir, requests, statePath: path.join(directory, 'state.json'),
    project: { id: 'neutral-sdk-contract', name: 'Neutral SDK contract', engine: 'unknown', sourceDir: gameDir },
    connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture' },
    lab: await createAdapterLab({ dataDir: path.join(directory, 'lab') }), maxSteps: 5 };
}
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const done = () => ({ message: { role: 'assistant', content: 'Neutral protocol check ended.' }, finish_reason: 'stop' });

test('F06-12 real locked SDK rejects missing root before execution then accepts explicit work recovery', async t => {
  const f = await fixture(t, async number => number === 1 ? { message: { role: 'assistant', content: null,
    tool_calls: [toolCall('bad-root', 'read_resource', { file: 'generated.txt' })] }, finish_reason: 'tool_calls' }
    : number === 2 ? { message: { role: 'assistant', content: null,
      tool_calls: [toolCall('good-root', 'read_resource', { root: 'work', file: 'generated.txt' })] }, finish_reason: 'tool_calls' } : done());
  await writeFile(path.join(f.workspaceDir, 'generated.txt'), 'Neutral generated work material.');
  const result = await runAdaptation(f);
  assert.equal(f.requests.length, 3, JSON.stringify(result.error));
  const definition = f.requests[0].tools.find(row => row.function?.name === 'read_resource');
  assert.ok(definition.function.parameters.required.includes('root'));
  assert.ok(f.requests[1].messages.some(message => message.role === 'tool' && message.tool_call_id === 'bad-root' && /root|invalid|参数/i.test(message.content)));
  assert.ok(f.requests[2].messages.some(message => message.role === 'tool' && message.tool_call_id === 'good-root' && message.content.includes('Neutral generated work material.')));
  assert.equal(result.state.investigationReads.filter(row => row.kind === 'missing').length, 0);
  assert.ok(result.state.observations.some(row => row.output?.error?.code === 'MODEL_TOOL_INPUT_INVALID'));
});

test('F08-02 actual SDK twenty-call group reaches next HTTP intact under the model message capacity', async t => {
  const f = await fixture(t, async number => number === 1 ? { message: { role: 'assistant', content: null,
    tool_calls: Array.from({ length: 20 }, (_, i) => toolCall(`read-${i}`, 'read_resource', { root: 'source', file: `scene-${i}.txt`, length: 262144 })) }, finish_reason: 'tool_calls' } : done());
  for (let i = 0; i < 20; i++) await writeFile(path.join(f.gameDir, `scene-${i}.txt`), `Neutral scene ${i}: ` + '"unicode 中文😀\\'.repeat(10000));
  const result = await runAdaptation({ ...f, maxNoProgressSteps: 40 });
  assert.equal(f.requests.length, 2, JSON.stringify(result.error));
  const body = f.requests[1], results = body.messages.filter(message => message.role === 'tool');
  assert.equal(results.length, 20); assert.equal(new Set(results.map(row => row.tool_call_id)).size, 20);
  const calls = body.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? []);
  assert.equal(calls.length, 20);
  for (const row of results) {
    const value = JSON.parse(row.content);
    assert.ok(value.evidenceId); assert.ok(value.receiptId); assert.equal(value.error, undefined);
    assert.ok(value.content.length > 0 || value.nextCall?.tool === 'read_evidence');
  }
  const sdkGroup = [{ role: 'assistant', content: calls.map(call => ({ type: 'tool-call', toolCallId: call.id, toolName: call.function.name, input: JSON.parse(call.function.arguments) })) },
    { role: 'tool', content: results.map(row => ({ type: 'tool-result', toolCallId: row.tool_call_id, toolName: 'read_resource', output: { type: 'json', value: JSON.parse(row.content) } })) }];
  assert.ok(JSON.stringify(sdkGroup).length <= 200000);
  t.diagnostic(JSON.stringify({ sdkGroupUtf16: JSON.stringify(sdkGroup).length, providerBodyUtf8: Buffer.byteLength(JSON.stringify(body)) }));
});
