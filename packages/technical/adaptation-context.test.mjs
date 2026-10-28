import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { readAdaptationState, runAdaptation } from './adaptation.mjs';
import { engineOperations } from './engine-operations.mjs';

async function temporary(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-context-'));
  try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); }
}
const fixture = directory => ({ project: { id: 'neutral-context', name: 'Neutral context', engine: 'Godot' },
  gameDir: path.join(directory, 'game'), workspaceDir: path.join(directory, 'work'), statePath: path.join(directory, 'progress.jsonl'),
  lab: { tryRecipes: async () => null, runTool: async () => ({ status: 'completed', total: 1, nextOffset: null,
    groups: [{ text: `complete-neutral-output-${'evidence '.repeat(7000)}` }] }) } });
const input = { tool: 'fixture', args: [JSON.stringify({ groupId: 'neutral-group', path: 'neutral-folder/'.repeat(700) })] };

test('local execution context maps virtual file roots to the actual current job directories', () => temporary(async directory => {
  const args = fixture(directory);
  let context, system;
  await runAdaptation({ ...args, coverage: { resources: [], summary: {} }, generate: async ({ tools, instructions }) => {
    context = await tools.inspect_context.execute({}); system = instructions;
  } });
  assert.equal(context.executionContext.sourceDir, path.resolve(args.gameDir));
  assert.equal(context.executionContext.workDir, path.resolve(args.workspaceDir));
  assert.deepEqual(context.executionContext.environment, {
    PINHAO_SOURCE_DIR: path.resolve(args.gameDir), PINHAO_WORK_DIR: path.resolve(args.workspaceDir),
  });
  assert.match(system, /PINHAO_SOURCE_DIR/);
  assert.match(system, /PINHAO_WORK_DIR/);
  assert.equal(context.originalGameDir, undefined);
  assert.match(context.coverage.candidateInterfaces.embedded, /write_embedded_text_adapter/);
}));

test('existing units default to the assigned carrier and allow explicit related-resource reads without changing locators', () => temporary(async directory => {
  const assignedFile = 'Neutral_Data/level2', virtualFile = '__native_text__/one.json';
  const locator = { file: virtualFile, nativePath: ['@:7', 'caption'] };
  const entries = [
    { id: 'neutral:1', kind: 'ui_text', file: virtualFile, source: 'Neutral heading.', locator,
      context: { file: virtualFile, carrier: assignedFile, object: '@:7', field: ['caption'] } },
    { id: 'neutral:2', kind: 'message', source: 'A complete neutral sentence.',
      context: { file: '__native_text__/two.json', carrier: assignedFile, object: '@:8', field: ['caption'] } },
    { id: 'other:1', kind: 'ui_text', source: 'Other resource.',
      context: { file: '__native_text__/other.json', carrier: 'Neutral_Data/level3' } },
  ];
  const pages = [];
  await runAdaptation({ ...fixture(directory), inventory: { existingUnits: entries }, assignment: { id: 'neutral-resource', files: [assignedFile] },
    generate: async ({ tools }) => {
      for (const file of [undefined, assignedFile, virtualFile, '__native_text__/other.json']) {
        pages.push(await tools.inspect_units.execute(file ? { file } : {}));
      }
    } });
  assert.deepEqual(pages.map(page => page.total), [2, 2, 1, 1]);
  assert.equal(pages[3].units[0].id, 'other:1');
  assert.equal(pages[0].units[0].kind, 'ui_text');
  assert.deepEqual(pages[0].units[0].locator, locator);
  assert.deepEqual(pages[0].units[0].context, entries[0].context);
  assert.deepEqual(entries[0].locator, locator);
}));

test('saved workspace files identify the work root for later resource reads', () => temporary(async directory => {
  const args = fixture(directory);
  let saved;
  await runAdaptation({ ...args, lab: { ...args.lab, writeWorkspaceFile: async ({ file }) => ({ file, sha256: 'a'.repeat(64), bytes: 9 }) },
    generate: async ({ tools }) => { saved = await tools.write_workspace_file.execute({ file: 'inspect.py', content: 'print(1)' }); } });
  assert.equal(saved.root, 'work');
  assert.equal(saved.file, 'inspect.py');
}));

test('a resumed SDK request reports provider cooldown and returns to requesting progress', () => temporary(async directory => {
  const progress = [];
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _ of request) { /* consume the neutral request */ }
    requests++;
    if (requests === 1) {
      response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '0.001' });
      response.end(JSON.stringify({ error: { message: 'This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.' } }));
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'neutral-provider-ready', object: 'chat.completion', created: 1, model: 'fixture',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Saved evidence is available.' }, finish_reason: 'stop' }] }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const args = { ...fixture(directory), onProgress: item => progress.push(item),
      connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture' } };
    assert.equal((await runAdaptation(args)).status, 'failed');
    const result = await runAdaptation(args);
    assert.equal(requests, 2, JSON.stringify(result.error));
    const waiting = progress.find(item => item.phase === 'waiting-provider');
    assert.equal(waiting?.status, 'running');
    assert.equal(waiting?.tool, '等待接口恢复');
    assert.ok(waiting.retryAfterMs > 0);
    assert.ok(progress.some(item => item.phase === 'requesting' && item.retryAfterMs === 0));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}));

test('resume sends observation indices while full input, output and local observations remain readable', () => temporary(async directory => {
  const args = fixture(directory);
  const first = await runAdaptation({ ...args, generate: async ({ tools }) => { await tools.run_tool.execute(input); } });
  const savedObservation = first.state.observations[0];
  assert.ok(savedObservation.inputEvidenceId);
  assert.ok(savedObservation.evidenceId);
  const second = await runAdaptation({ ...args, generate: async ({ prompt, tools }) => {
    const initial = JSON.parse(prompt);
    assert.equal(initial.resume.stateId, first.state.id);
    assert.equal(initial.resume.observations, undefined);
    assert.ok(prompt.length < 2000);
    const context = await tools.inspect_context.execute({});
    const observation = context.progress.observations[0];
    assert.equal(observation.tool, 'run_tool');
    assert.deepEqual(observation.input.args, { items: 1 });
    assert.equal(observation.status, 'completed');
    assert.equal(observation.output, undefined);
    assert.equal(observation.evidenceId, savedObservation.evidenceId);
    const parameters = await tools.read_evidence.execute({ evidenceId: observation.inputEvidenceId, pointer: '/args/0', length: 2000 });
    assert.equal(parameters.totalCharacters, input.args[0].length);
    assert.equal(parameters.content, input.args[0].slice(0, 2000));
    const output = await tools.read_evidence.execute({ evidenceId: observation.evidenceId, pointer: '/groups/0/text', length: 2000 });
    assert.equal(output.totalCharacters, (await args.lab.runTool()).groups[0].text.length);
    assert.match(output.content, /^complete-neutral-output-/);
  } });
  assert.equal(second.status, 'needs-review');
  assert.deepEqual(second.state.observations[0].input, savedObservation.input);
  assert.deepEqual(second.state.observations[0].output, savedObservation.output);
  assert.deepEqual((await readAdaptationState(args.statePath)).observations[0], second.state.observations[0]);
}));

test('the actual SDK receives a small dynamic index and the unchanged paired tool history once', t => temporary(async directory => {
  const args = fixture(directory);
  const first = await runAdaptation({ ...args, generate: async ({ tools, onStepStart, onStepEnd }) => {
    await onStepStart({ stepNumber: 0 });
    const output = await tools.run_tool.execute(input);
    await onStepEnd({ finishReason: 'tool-calls', response: { messages: [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'preserved-call', toolName: 'run_tool', input }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'preserved-call', toolName: 'run_tool', output: { type: 'json', value: output } }] },
    ] } });
  } });
  const originalPair = JSON.stringify(first.state.conversation[0]);
  // A legacy checkpoint has observations without receipt IDs; reconnect from its paired history.
  const legacy = JSON.parse(await readFile(args.statePath, 'utf8'));
  delete legacy.observations[0].evidenceId;
  delete legacy.observations[0].inputEvidenceId;
  delete legacy.observations[0].evidenceSource;
  await writeFile(args.statePath, JSON.stringify(legacy), 'utf8');
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: 'neutral-resume', object: 'chat.completion', created: 1, model: 'fixture', choices: [
      { index: 0, message: { role: 'assistant', content: 'Saved evidence is available.' }, finish_reason: 'stop' },
    ] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const second = await runAdaptation({ ...args, connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture' } });
    assert.equal(requests.length, 1);
    const messages = requests[0].messages;
    const initial = messages.find(message => message.role === 'user' && message.content.startsWith('{'));
    const dynamic = messages.find(message => message.role === 'user' && message.content.startsWith('主机已保存的接续证据：'));
    assert.equal(JSON.parse(initial.content).resume.observations, undefined);
    assert.ok(initial.content.length < 2000);
    assert.ok(dynamic.content.length < 3000);
    t.diagnostic(JSON.stringify({ initialCharacters: initial.content.length, dynamicIndexCharacters: dynamic.content.length,
      archivedObservationCharacters: JSON.stringify(legacy.observations).length, pairedHistoryCharacters: originalPair.length }));
    const index = JSON.parse(dynamic.content.slice('主机已保存的接续证据：'.length)).observations[0];
    assert.equal(index.evidenceSource, 'tool-output');
    assert.equal(index.evidenceId, first.state.observations[0].evidenceId);
    assert.equal(index.output, undefined);
    assert.ok(messages.some(message => message.role === 'tool' && message.tool_call_id === 'preserved-call' && message.content.includes('complete-neutral-output-')));
    assert.equal(messages.filter(message => message.role === 'tool' && message.tool_call_id === 'preserved-call').length, 1);
    assert.equal(JSON.stringify(second.state.conversation[0]), originalPair);
    assert.deepEqual(second.state.observations[0].output, legacy.observations[0].output);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}));

test('an observation without retained history is explicitly archived rather than presented as complete original output', () => temporary(async directory => {
  const args = fixture(directory);
  await runAdaptation({ ...args, generate: async ({ tools }) => { await tools.run_tool.execute(input); } });
  const legacy = JSON.parse(await readFile(args.statePath, 'utf8'));
  for (const observation of legacy.observations) for (const key of ['evidenceId', 'inputEvidenceId', 'evidenceSource']) delete observation[key];
  legacy.observations[0].output.error = { code: 'ARCHIVED_FORMAT', message: 'Neutral archived error. '.repeat(50) };
  await writeFile(args.statePath, JSON.stringify(legacy), 'utf8');
  await runAdaptation({ ...args, generate: async ({ tools }) => {
    const context = await tools.inspect_context.execute({});
    const observation = context.progress.observations[0];
    assert.equal(observation.evidenceSource, 'archived-observation');
    assert.equal(observation.error.code, 'ARCHIVED_FORMAT');
    assert.equal(observation.error.truncated, true);
    assert.equal(observation.error.message.length, 400);
    const archived = await tools.read_evidence.execute({ evidenceId: observation.evidenceId, pointer: '/groups/0/text', length: 2000 });
    assert.equal(archived.totalCharacters, legacy.observations[0].output.groups[0].text.length);
    assert.equal(archived.content, legacy.observations[0].output.groups[0].text);
  } });
}));

test('the SDK omits an index already represented by complete paired history without changing persisted observations', () => temporary(async directory => {
  const args = fixture(directory), toolInput = {};
  const first = await runAdaptation({ ...args, generate: async ({ tools, onStepEnd }) => {
    const output = await tools.inspect_context.execute(toolInput);
    await onStepEnd({ finishReason: 'tool-calls', response: { messages: [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'visible-call', toolName: 'inspect_context', input: toolInput }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'visible-call', toolName: 'inspect_context', output: { type: 'json', value: output } }] },
    ] } });
  } });
  let sent;
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk; sent = JSON.parse(raw);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: 'visible-history', object: 'chat.completion', created: 1, model: 'fixture', choices: [
      { index: 0, message: { role: 'assistant', content: 'Evidence retained.' }, finish_reason: 'stop' },
    ] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const second = await runAdaptation({ ...args, connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture' } });
    const dynamic = sent.messages.find(message => message.role === 'user' && message.content.startsWith('主机已保存的接续证据：'));
    assert.deepEqual(JSON.parse(dynamic.content.slice('主机已保存的接续证据：'.length)).observations, []);
    assert.ok(sent.messages.some(message => message.role === 'tool' && message.tool_call_id === 'visible-call' && message.content.includes('Neutral context')));
    assert.deepEqual(second.state.observations, first.state.observations);
    assert.deepEqual(second.state.conversation.slice(0, first.state.conversation.length), first.state.conversation);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}));

test('old full context guides are projected out of SDK requests without rewriting original paired history', () => temporary(async directory => {
  const args = fixture(directory), guide = engineOperations('Godot', []);
  const first = await runAdaptation({ ...args, generate: async ({ tools, onStepEnd }) => {
    const output = { ...await tools.inspect_context.execute({}), operationGuide: guide,
      tools: { trusted: [{ name: 'native_unpack', description: 'Use the native archive codec.', argsHint: '[file, format?]', argContract: 'Exactly two positional parameters.',
        capabilities: { protocol: 1, operation: 'unpack', formats: ['zip', 'pck'] }, limits: { timeoutMs: 900000, maxOutputBytes: 1048576 } }] } };
    await onStepEnd({ finishReason: 'tool-calls', response: { messages: [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'context-guide', toolName: 'inspect_context', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'context-guide', toolName: 'inspect_context', output: { type: 'json', value: output } }] },
    ] } });
  } });
  const originalPair = JSON.stringify(first.state.conversation[0]), requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: 'guide-reference', object: 'chat.completion', created: 1, model: 'fixture', choices: [
      { index: 0, message: { role: 'assistant', content: 'Evidence retained.' }, finish_reason: 'stop' },
    ] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const second = await runAdaptation({ ...args, connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture' } });
    const messages = requests[0].messages, context = JSON.parse(messages.find(message => message.tool_call_id === 'context-guide').content);
    assert.ok(context.operationGuide.sections.every(section => !section.text));
    assert.equal(context.operationGuide.source, 'system-instructions');
    assert.ok(messages.find(message => message.role === 'system').content.includes(guide.sections[0].text));
    assert.equal(context.executionContext.sourceDir, path.resolve(args.gameDir));
    assert.equal(context.executionContext.workDir, path.resolve(args.workspaceDir));
    assert.equal(context.executionContext.environment, undefined, 'the exact paths already appear under their promised fields');
    assert.deepEqual(context.tools, first.state.conversation[0][1].content[0].output.value.tools, 'all unique native contracts and capabilities remain available');
    assert.equal(JSON.stringify(second.state.conversation[0]), originalPair);
    assert.ok(originalPair.includes(guide.sections[0].text), 'the original full tool response remains archived');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}));

test('an actual SDK unknown-tool error is saved and shared before the next request then recovers through typed native tools', () => temporary(async directory => {
  const requests = [], learned = [], groupId = `native-review-v1:${'a'.repeat(16)}:${'b'.repeat(24)}`;
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    const name = requests.length === 1 ? 'native_run_tool' : 'native_review';
    const message = requests.length < 3 ? { role: 'assistant', content: null, tool_calls: [
      { id: `call-${requests.length}`, type: 'function', function: { name, arguments: '{}' } },
    ] } : { role: 'assistant', content: 'Native evidence is available.' };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `sdk-error-${requests.length}`, object: 'chat.completion', created: 1, model: 'fixture',
      choices: [{ index: 0, message, finish_reason: requests.length < 3 ? 'tool_calls' : 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runAdaptation({ project: { id: 'neutral-sdk-error', engine: 'Unity' }, inventory: {}, gameDir: directory,
      workspaceDir: path.join(directory, 'work'), assignment: { id: 'resource', files: ['Game_Data/level10'] },
      onLessons: async facts => learned.push(...facts), getLessons: () => learned,
      lab: { tryRecipes: async () => null, listTools: async () => [{ name: 'native_review' }], runTool: async () => ({
        schema: 'pinhao-native-field-review-v1', groups: [{ groupId, evidenceHash: 'c'.repeat(64), file: 'Game_Data/level10', fields: [] }],
        total: 1, offset: 0, nextOffset: null }) },
      connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture' } });
    assert.equal(requests.length, 3);
    assert.ok(learned.some(lesson => lesson.kind === 'tool-name' && lesson.subject === '"native_run_tool"'),
      JSON.stringify({ learned, observations: result.state.observations.map(item => ({ tool: item.tool, error: item.output?.error })) }));
    assert.ok(requests[1].messages.some(message => typeof message.content === 'string' && message.content.startsWith('共享结论：') && message.content.includes('native_run_tool')));
    const failure = result.state.observations.find(observation => observation.tool === 'native_run_tool');
    assert.equal(failure.output.error.code, 'MODEL_TOOL_NOT_AVAILABLE');
    assert.ok(failure.evidenceId && failure.inputEvidenceId);
    assert.ok(result.state.events.some(event => event.tool === 'model_tool_error' && event.operation === 'native_run_tool'));
    const dynamic = requests[2].messages.find(message => typeof message.content === 'string' && message.content.startsWith('主机已保存的接续证据：'));
    const index = JSON.parse(dynamic.content.slice('主机已保存的接续证据：'.length)).observations;
    assert.deepEqual(index.find(observation => observation.tool === 'native_review').input, { file: 'Game_Data/level10' });
    assert.equal(index.some(observation => observation.tool === 'run_tool'), false, 'typed calls never appear as an incompatible argv route');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}));
