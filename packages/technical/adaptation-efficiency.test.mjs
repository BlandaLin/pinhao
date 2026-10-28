import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { adaptationTools, readAdaptationState, runAdaptation } from './adaptation.mjs';
import { runAdaptationPool } from './adaptation-pool.mjs';
import { mergeLessons } from './lessons.mjs';

const fact = marker => mergeLessons([], { kind: 'tool-arg', subject: marker.split('-')[0],
  fact: marker, factLevel: 'direct', confidence: 0.9 }).lessons[0];
const initial = fact('initial-shared-fact-marker'), learned = fact('new-shared-fact-marker');
const count = (value, marker) => JSON.stringify(value).split(marker).length - 1;
const lab = { tryRecipes: async () => null, listTools: async () => [{ name: 'fixture', argsHint: '[]' }], runTool: async () => ({ status: 'completed', output: 'complete evidence' }) };
const input = directory => ({ project: { id: 'efficiency', name: 'Neutral resource', engine: 'Godot' },
  gameDir: directory, workspaceDir: path.join(directory, 'work'), statePath: path.join(directory, 'progress.jsonl'), inventory: {}, lab });
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-adaptation-efficiency-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }));
  return directory;
}

test('pool SDK requests contain one dynamic shared conclusion and keep a stable system after updates', async t => {
  const directory = await temporary(t), requests = [];
  let publish;
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (requests.length === 1) await publish([learned]);
    const tools = requests.length === 1;
    const message = tools ? { role: 'assistant', content: null, tool_calls: [{
      id: 'inspect-1', type: 'function', function: { name: 'inspect_units', arguments: '{}' },
    }] } : { role: 'assistant', content: 'Evidence retained.' };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `efficiency-${requests.length}`, object: 'chat.completion', model: 'fixture',
      choices: [{ index: 0, message, finish_reason: tools ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const jobs = [{ id: 'scene', files: ['story.json'] }];
  const result = await runAdaptationPool({ ...input(directory), jobs, lessons: [initial], concurrency: 1,
    coverage: { needsAdaptation: true, resources: [{ file: 'story.json', kind: 'display-text-candidate' }] },
    connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture' },
    run: args => { publish = args.onLessons; return runAdaptation(args); },
  });
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(count(request.messages, initial.fact), 1);
    assert.equal(count(request.messages.filter(message => message.role === 'system'), initial.fact), 0);
    assert.equal(request.messages.filter(message => message.role === 'user' && message.content.startsWith('共享结论：')).length, 1);
    const names = request.tools.map(item => item.function.name);
    for (const name of ['run_workspace', 'write_adapter', 'write_python_adapter', 'copy_source_files']) assert.ok(names.includes(name));
  }
  assert.equal(count(requests[1].messages, learned.fact), 1);
  assert.equal(requests[0].messages[0].content, requests[1].messages[0].content);
  assert.equal(result.lessons.length, 2);
  const saved = await readAdaptationState(path.join(directory, 'jobs', 'scene', 'progress.jsonl'));
  assert.equal(saved.requestArtifacts.length, 2, 'both actual local HTTP request records remain durable');
  assert.ok(saved.conversation.length >= 1);
  for (const reference of saved.requestArtifacts) assert.ok(JSON.parse(await readFile(path.join(reference.directory, 'result.json'), 'utf8')).summary.usage);
});

test('custom generators get the same one-copy dynamic lesson preparation for initial and later steps', async t => {
  const directory = await temporary(t);
  let shared = [initial];
  const result = await runAdaptation({ ...input(directory), getLessons: () => shared,
    generate: async ({ instructions, messages, prepareStep }) => {
      assert.equal(typeof prepareStep, 'function');
      assert.equal(count(instructions, initial.fact), 0);
      assert.equal(count(messages, initial.fact), 1);
      shared = [initial, learned];
      const next = prepareStep({ messages });
      const repeated = prepareStep({ messages: next.messages });
      assert.equal(next.instructions, instructions);
      for (const value of [next.messages, repeated.messages]) {
        assert.equal(count(value, initial.fact), 1);
        assert.equal(count(value, learned.fact), 1);
        assert.equal(value.filter(message => message.role === 'user' && message.content.startsWith('共享结论：')).length, 1);
      }
    },
  });
  assert.equal(result.status, 'needs-review', JSON.stringify(result.error));
});

test('notification-only requesting and tool starts emit progress without checkpoint writes', async t => {
  const directory = await temporary(t), writes = [], progress = [];
  const state = { status: 'running', events: [], failures: {}, attempts: 0 };
  const session = adaptationTools({ ...input(directory), state,
    persist: async value => writes.push(structuredClone(value)), onProgress: value => progress.push(value) });
  await session.event('model_step', { phase: 'requesting', step: 1 });
  await session.event('tool_start', { operation: 'read_resource', phase: 'running' });
  assert.equal(writes.length, 0);
  assert.equal(progress.length, 2);
  await session.event('model_step', { phase: 'complete', step: 1 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].events.length, 3, 'notifications join the next durable boundary');
  const output = await session.tools.inspect_units.execute({});
  assert.equal(output.error, undefined, JSON.stringify(output));
  assert.equal(writes.length, 2, 'a completed read tool writes one evidence checkpoint, not a start plus completion pair');
  assert.equal(writes[1].observations.at(-1).evidenceId, output.evidenceId);
  await session.tools.run_tool.execute({ tool: 'fixture', args: [] });
  assert.equal(writes.length, 4, 'a mutating tool retains durable preflight and completion boundaries');
  assert.equal(writes[2].events.at(-1).tool, 'tool_start');
  assert.equal(writes[3].observations.at(-1).tool, 'run_tool');
  await session.event('model_tool_error', { operation: 'missing_tool', error: 'exact failure' });
  assert.equal(writes.length, 5, 'completed error evidence is not notification-only');
  assert.equal(writes[4].events.at(-1).error, 'exact failure');
  await session.close(); await session.flush();
});

test('request starts leave disk unchanged while completed tool pairs survive cancellation and resume', async t => {
  const directory = await temporary(t), controller = new AbortController();
  const args = input(directory);
  const first = await runAdaptation({ ...args, signal: controller.signal,
    generate: async ({ tools, onStepStart, onStepEnd }) => {
      const before = await readFile(args.statePath, 'utf8');
      await onStepStart({ stepNumber: 0 });
      assert.equal(await readFile(args.statePath, 'utf8'), before);
      const output = await tools.run_tool.execute({ tool: 'fixture', args: [] });
      assert.ok((await readAdaptationState(args.statePath)).observations.at(-1).evidenceId);
      await onStepEnd({ finishReason: 'tool-calls', response: { messages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'retained-call', toolName: 'run_tool', input: { tool: 'fixture', args: [] } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'retained-call', toolName: 'run_tool', output: { type: 'json', value: output } }] },
      ] } });
      controller.abort(new Error('Stop after a completed pair'));
      throw controller.signal.reason;
    },
  });
  assert.equal(first.status, 'cancelled', JSON.stringify(first.error));
  const saved = await readAdaptationState(args.statePath);
  assert.equal(saved.status, 'cancelled');
  assert.equal(saved.conversation.length, 1);
  assert.equal(saved.conversation[0][0].content[0].toolCallId, 'retained-call');
  assert.equal(saved.conversation[0][1].content[0].toolCallId, 'retained-call');
  const resumed = await runAdaptation({ ...args, generate: async ({ messages }) => {
    assert.ok(messages.some(message => message.role === 'tool' && message.content.some(part => part.toolCallId === 'retained-call')));
  } });
  assert.equal(resumed.status, 'needs-review', JSON.stringify(resumed.error));
});
