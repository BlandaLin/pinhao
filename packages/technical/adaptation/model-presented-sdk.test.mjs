import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ToolLoopAgent, jsonSchema, tool } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createEvidenceStore } from './evidence.mjs';
import { createSessionControl } from './session-control.mjs';
import { projectToolResultGroup } from './tool-output.mjs';
import { createTechnicalTransport } from '../model-transport.mjs';

test('actual locked SDK serializes only the projected tool prefix and transport credits exactly that sent range', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-presented-sdk-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  const gameDir = path.join(root, 'game'), workspaceDir = path.join(root, 'work');
  await mkdir(gameDir); await mkdir(workspaceDir);
  const content = 'A'.repeat(6000); await writeFile(path.join(gameDir, 'scene.txt'), content);
  const evidence = createEvidenceStore(workspaceDir), state = { id: 'session', executionWindow: 1, events: [] };
  const control = createSessionControl({ state, project: { id: 'project' }, assignment: { id: 'owner', files: ['scene.txt'] },
    readDir: gameDir, gameDir, workspaceDir, evidence, persist: async () => {} });
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(body);
    const first = requests.length === 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: `fixture-${requests.length}`, object: 'chat.completion', created: 1, model: 'fixture',
      choices: [{ index: 0, message: first ? { role: 'assistant', content: null, tool_calls: [{ id: 'source-read', type: 'function', function: { name: 'read_resource', arguments: '{"file":"scene.txt"}' } }] } : { role: 'assistant', content: 'Source received.' }, finish_reason: first ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const transport = createTechnicalTransport({ onModelPresented: input => control.modelPresented(input) });
  const provider = createOpenAICompatible({ name: 'fixture', baseURL: `http://127.0.0.1:${server.address().port}/v1`, fetch: transport.fetch });
  const agent = new ToolLoopAgent({ model: provider.chatModel('fixture'), maxRetries: 0, stopWhen: ({ steps }) => steps.length >= 2,
    prepareStep: ({ messages }) => ({ messages: projectToolResultGroup(messages, { maxCharacters: 4000 }) }),
    tools: { read_resource: tool({ description: 'Read actual source.', inputSchema: jsonSchema({ type: 'object', properties: { file: { type: 'string' } }, required: ['file'], additionalProperties: false }),
      execute: async input => {
        const operation = await control.begin('read_resource', input), captured = await readFile(path.join(gameDir, input.file), 'utf8');
        const output = { content: captured, offset: 0, returnedBytes: Buffer.byteLength(captured), totalBytes: Buffer.byteLength(captured), encoding: 'utf8' };
        const saved = await evidence.save(output), receipt = await control.finish(operation, input, output, saved.evidenceId);
        assert.equal(state.control.materialSerial, 0, 'capture is not presentation');
        return { ...output, ...saved, receiptId: receipt.receiptId };
      } }) } });
  await agent.generate({ prompt: 'Read the scene source.' }); await transport.flush();
  assert.equal(requests.length, 2);
  const shown = JSON.parse(requests[1].messages.find(message => message.role === 'tool').content);
  assert.ok(typeof shown.content === 'string' && shown.content.length > 0 && shown.content.length < content.length, JSON.stringify({ length: shown.content?.length, keys: Object.keys(shown) }));
  assert.deepEqual(Object.values(state.control.readRanges), [[[0, Buffer.byteLength(shown.content)]]]);
  assert.equal(state.control.materialSerial, 1);
  assert.equal((await evidence.load(shown.evidenceId)).value.content.length, content.length, 'complete source stays available');
});
