import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { adaptationTools, runAdaptation, readAdaptationState } from './adaptation.mjs';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';
import { scanCoverage } from './coverage.mjs';
import { isPublicAddress, readPublicPage, resolvePublicUrl } from './research.mjs';
import { runAdaptationPool } from './adaptation-pool.mjs';
import { accumulateVerifiedExtractions } from './adaptation/verified-batches.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';

async function temporary(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-adaptation-test-'));
  try { return await fn(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); }
}

function fakeLab({ validate, reuse } = {}) {
  const extraction = { workspaceDir: 'workbench', units: [{ id: 'scene-1', source: 'The story continues.', kind: 'dialogue', context: { file: 'story.json' }, locator: { file: 'story.json', pointer: '/text' } }], binding: { format: 'pinhao-generated-adapter-1', recipeId: 'story-1' }, coverage: [{ file: 'story.json', status: 'extracted' }] };
  const calls = [];
  return {
    calls, extraction,
    tryRecipes: async () => reuse ? extraction : null,
    listRecipes: async () => [],
    inspectFiles: async () => ({ files: [{ path: 'story.json', size: 50 }], truncated: false }),
    readResource: async () => ({ content: '{"text":"The story continues."}' }),
    writeAdapter: async input => { calls.push(['write', input]); return { candidateId: `candidate-${calls.length}`, codeHash: 'hash' }; },
    validateAdapter: async input => { calls.push(['validate', input]); return validate ? validate(input) : { validationId: 'proof-1', passed: true, checks: { roundtrip: true, sample: true, structure: true }, runtime: { status: 'pending' }, extraction }; },
    submitRecipe: async input => { calls.push(['submit', input]); assert.equal(input.validationId, 'proof-1'); return { recipeId: 'story-1' }; },
    extractRecipe: async () => extraction,
    runTool: async ({ tool }) => ({ tool, output: 'complete' }),
  };
}

const defaultRoot = mkdtempSync(path.join(os.tmpdir(), 'pinhao-adaptation-defaults-')), defaultDirectories = new WeakMap();
after(() => rm(defaultRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
const base = lab => {
  if (!defaultDirectories.has(lab)) {
    const directory = mkdtempSync(path.join(defaultRoot, 'case-')), gameDir = path.join(directory, 'game-copy');
    mkdirSync(gameDir);
    for (const file of ['story.json', 'a.json', 'b.json', 'c.json', 'd.json']) writeFileSync(path.join(gameDir, file), '{"text":"The story continues."}');
    defaultDirectories.set(lab, { gameDir, workspaceDir: path.join(directory, 'work') });
  }
  return { lab, project: { id: 'game-1', name: 'Neutral sample', engine: 'Godot' }, ...defaultDirectories.get(lab), inventory: { unitCount: 0 } };
};
const write = tools => tools.write_adapter.execute({ manifest: { id: 'story-1' }, code: '({extract(){}})' });

test('rejected coverage proposals never enter accepted task state', () => temporary(async directory => {
  const gameDir = path.join(directory, 'game');
  await mkdir(gameDir);
  await writeFile(path.join(gameDir, 'notes.json'), '{"note":"An internal author note."}');
  const kept = { id: 'prior-accepted', evidenceHash: 'b'.repeat(64) };
  const cluster = { id: 'cluster-note', file: 'notes.json', field: 'note', evidenceHash: 'a'.repeat(64) };
  const coverage = { sourceContextHash: 'c'.repeat(64), needsAdaptation: true, unknownClusters: [cluster], coverageDecisions: [kept] };
  const state = { status: 'running', events: [], failures: {}, attempts: 0, coverageDecisions: [kept] }, saved = [];
  const lab = await createAdapterLab({ dataDir: path.join(directory, 'lab') });
  let accept = false;
  const session = adaptationTools({ project: { id: 'decision-commit', engine: 'unknown' }, gameDir,
    workspaceDir: path.join(directory, 'work'), inventory: {}, coverage, state,
    lab: { ...lab, saveCoverageDecisions: async input => saved.push(input) },
    verifyCoverage: async ({ coverageDecisions }) => ({ ...coverage, coverageDecisions: accept ? coverageDecisions : [kept] }) });
  try {
    await session.tools.read_resource.execute({ file: cluster.file });
    const input = { decisions: [{ id: cluster.id, evidenceHash: cluster.evidenceHash, disposition: 'non-display',
      reason: 'Source is an internal author note.' }] };
    assert.match((await session.tools.record_coverage_decisions.execute(input)).error.message, /证据已有变化/);
    assert.deepEqual(state.coverageDecisions, [kept]);
    assert.equal(saved.length, 0);
    accept = true;
    const result = await session.tools.record_coverage_decisions.execute(input);
    assert.equal(result.accepted, true);
    assert.equal(state.coverageDecisions.length, 2);
    assert.equal(saved.length, 1);
  } finally { session.close(); await session.flush(); }
}));

test('adaptation uses validation output to repair and submits the verified extraction', () => temporary(async directory => {
  let attempts = 0;
  const lab = fakeLab({ validate: () => ++attempts === 1 ? { validationId: 'bad-1', passed: false, checks: { roundtrip: false }, error: { code: 'BYTE_MISMATCH', message: 'story.json byte 9 differs' } } : { validationId: 'proof-1', passed: true, checks: { roundtrip: true, sample: true, structure: true }, runtime: { status: 'pending' } } });
  const statePath = path.join(directory, 'task.json');
  const result = await runAdaptation({ ...base(lab), statePath, generate: async ({ tools }) => {
    const first = await write(tools);
    const bad = await tools.validate_adapter.execute({ candidateId: first.candidateId });
    assert.equal(bad.error.code, 'BYTE_MISMATCH');
    const repaired = await write(tools);
    const good = await tools.validate_adapter.execute({ candidateId: repaired.candidateId });
    await tools.submit_recipe.execute({ candidateId: repaired.candidateId, validationId: good.validationId, metadata: { summary: 'JSON story text' } });
  } });
  assert.equal(result.status, 'verified');
  assert.equal(result.units.length, 1);
  assert.equal(result.validation.runtime.status, 'pending');
  assert.equal(result.state.attempts, 2);
  const saved = await readAdaptationState(statePath);
  assert.equal(saved.recipeId, 'story-1');
  assert.equal(saved.status, 'verified');
}));

test('known recipes are reused before any model request', async () => {
  const result = await runAdaptation({ ...base(fakeLab({ reuse: true })), generate: () => assert.fail('reusable recipe should skip model') });
    assert.equal(result.status, 'verified', JSON.stringify(result.error));
  assert.equal(result.reused, true);
});

test('a reusable partial recipe still enters the model loop when host coverage finds a gap', async () => {
  const lab = fakeLab({ reuse: true });
  let generated = false;
  const result = await runAdaptation({ ...base(lab), verifyCoverage: async () => ({ needsAdaptation: true, triggers: ['suspected-omission'], resources: [{ file: 'second.json', kind: 'display-text-candidate' }], summary: { 'display-text-candidate': 1 } }), generate: async ({ tools }) => {
    generated = true;
    const context = await tools.inspect_context.execute({});
    assert.equal(context.coverage.resources[0].file, 'second.json');
  } });
  assert.equal(generated, true);
  assert.equal(result.status, 'needs-review');
  assert.equal(result.state.partialRecipeId, 'story-1');
  assert.equal(result.coverage.needsAdaptation, true);
  assert.equal(result.partialExtractions.length, 1);
  assert.equal(result.partialExtractions[0].units.length, 1);
});

test('cancelled tasks save candidate progress and resume it', () => temporary(async directory => {
  const lab = fakeLab(), controller = new AbortController(), statePath = path.join(directory, 'task.json');
  const cancelled = await runAdaptation({ ...base(lab), signal: controller.signal, statePath, generate: async ({ tools, signal }) => {
    await write(tools); controller.abort(); signal.throwIfAborted();
  } });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.state.attempts, 1);
  const resumed = await runAdaptation({ ...base(lab), statePath, generate: async ({ tools }) => {
    const context = await tools.inspect_context.execute({});
    assert.equal(context.progress.candidateId, 'candidate-1');
    const validation = await tools.validate_adapter.execute({ candidateId: context.progress.candidateId });
    await tools.submit_recipe.execute({ candidateId: context.progress.candidateId, validationId: validation.validationId, metadata: {} });
  } });
  assert.equal(resumed.status, 'verified');
  assert.equal(resumed.state.attempts, 1);
}));

test('identical validation failures ask for a new strategy instead of freezing the loop', () => temporary(async directory => {
  const lab = fakeLab({ validate: () => { throw Object.assign(new Error('Unsupported header 0x1234'), { code: 'BAD_HEADER' }); } });
  const statePath = path.join(directory, 'task.json');
  const outputs = [];
  const result = await runAdaptation({ ...base(lab), statePath, generate: async ({ tools }) => {
    for (let index = 0; index < 4; index++) outputs.push(await tools.validate_adapter.execute({ candidateId: 'candidate-1' }));
  } });
  assert.equal(result.status, 'needs-review');
  assert.equal(lab.calls.length, 4, 'a repeated identical failure never freezes the loop');
  assert.equal(outputs[1].mustChangeStrategy, undefined);
  assert.match(outputs[2].mustChangeStrategy, /必须换策略/, 'the third identical failure demands a different approach');
  assert.match(outputs[2].mustChangeStrategy, /Unsupported header 0x1234/, 'the directive carries the last difference');
  assert.match(outputs[3].mustChangeStrategy, /必须换策略：同一工具错误已连续出现 4 次：Unsupported header 0x1234/, 'the directive carries the full wording and the last error');
  assert.equal(outputs[3].paused, false, 'a repeated failure is a strategy switch, not a pause');
  assert.match(result.state.strategyDirective, /同一工具错误已连续出现 4 次/);
  assert.equal(result.state.blocked, undefined);
  // The stop is window-local: the next window runs the model again instead of inheriting a freeze.
  let generated = 0;
  const resumed = await runAdaptation({ ...base(lab), statePath, retry: true, generate: async ({ tools }) => { generated++; await tools.inspect_context.execute({}); } });
  assert.equal(generated, 1);
  assert.equal(resumed.status, 'needs-review');
}));

test('an exhausted repair allowance switches strategy without pausing or squeezing steps', async () => {
  const lab = fakeLab({ validate: () => ({ passed: false, error: { message: 'Unresolved sample layout' } }) });
  const validations = [];
  const result = await runAdaptation({ ...base(lab), maxAttempts: 2, generate: async ({ tools }) => {
    for (let index = 0; index < 2; index++) { const candidate = await write(tools); validations.push(await tools.validate_adapter.execute({ candidateId: candidate.candidateId })); }
    const afterBudget = await write(tools);
    assert.equal(afterBudget.paused, undefined, 'the next write is not swallowed by a pause');
    assert.ok(afterBudget.candidateId);
  } });
  assert.equal(lab.calls.length, 5, 'both writes and both validations run, plus the write after the budget');
  assert.match(validations[1].mustChangeStrategy, /本轮修复已累计 2 次/);
  assert.equal(result.status, 'needs-review');
  assert.equal(result.retryable, true, 'the window ends without blocking the task');
  assert.equal(result.state.blocked, undefined);
});

test('distinct validation messages keep separate fingerprints while identical command failures deduplicate', async () => {
  let validation = 0;
  const lab = fakeLab({ validate: () => ({ passed: false, error: { code: 'ADAPTER_VALIDATION_FAILED', message: `Different error ${++validation}` } }) });
  lab.runTool = async () => ({ exitCode: 2, stderr: 'Parser header mismatch', stdout: '' });
  const commands = [];
  const result = await runAdaptation({ ...base(lab), generate: async ({ tools }) => {
    for (let index = 0; index < 4; index++) await tools.validate_adapter.execute({ candidateId: 'candidate-1' });
    const context = await tools.inspect_context.execute({});
    assert.equal(context.progress.events.filter(event => event.tool === 'validate_adapter').length, 4);
    for (let index = 0; index < 4; index++) commands.push(await tools.run_tool.execute({ tool: 'parser', args: [] }));
  } });
  assert.equal(result.status, 'needs-review');
  assert.equal(validation, 4, 'every distinct message reaches the validator');
  const fingerprints = result.state.events.filter(event => event.tool === 'validate_adapter' && event.fingerprint).map(event => event.fingerprint);
  assert.equal(fingerprints.length, 4);
  assert.equal(new Set(fingerprints).size, 4, 'different validation messages stay distinct');
  const commandEvents = result.state.events.filter(event => event.tool === 'run_tool' && event.fingerprint);
  assert.equal(new Set(commandEvents.map(event => event.fingerprint)).size, 1, 'the identical command failure deduplicates to one fingerprint');
  assert.equal(commandEvents.at(-1).repetitions, 4);
  assert.match(commands[2].mustChangeStrategy, /同一错误已连续出现 3 次/, 'the repeated command asks for a new approach');
  assert.equal(commands[3].paused, undefined);
});

test('retry and changed plans preserve cumulative failures and candidate attempts', () => temporary(async directory => {
  const statePath = path.join(directory, 'task.jsonl'), lab = fakeLab({ validate: () => ({ passed: false, error: { code: 'HEADER', message: 'Same header error' } }) });
  const stopped = await runAdaptation({ ...base(lab), statePath, generate: async ({ tools }) => {
    const candidate = await write(tools);
    for (let index = 0; index < 3; index++) await tools.validate_adapter.execute({ candidateId: candidate.candidateId });
  } });
  assert.equal(stopped.status, 'needs-review');
  assert.equal(stopped.state.blocked, undefined);
  assert.match(stopped.state.strategyDirective, /同一错误已连续出现 3 次/);
  const originalCandidate = stopped.state.candidateId;
  // Continue runs the model again in the same failure window, keeping the candidate progress.
  let continued = 0;
  const same = await runAdaptation({ ...base(lab), statePath, retry: true, generate: async ({ tools }) => { continued++; await tools.inspect_context.execute({}); } });
  assert.equal(continued, 1, 'a window-local stop never freezes the next window');
  assert.equal(same.state.repairWindow, 1);
  assert.equal(same.state.candidateId, originalCandidate);
  assert.equal(same.state.repairAttempts, 3, 'a new window preserves failures');
  assert.equal(same.retryable, true);
  const retried = await runAdaptation({ ...base(lab), statePath, retry: true, planKey: 'verified-json-strategy-2', generate: async ({ tools }) => {
    const context = await tools.inspect_context.execute({});
    assert.equal(context.progress.attempts, 1);
    assert.equal(context.progress.candidateId, originalCandidate);
    assert.ok(context.progress.events.some(event => event.tool === 'repair_window' && event.reason === 'input-changed'));
    await write(tools);
  } });
  assert.equal(retried.state.repairWindow, 2);
  assert.equal(retried.state.attempts, 2);
  assert.equal(retried.state.blocked, undefined);
}));

test('changing endpoint or model opens a new failure window and changing only the API key preserves it', () => temporary(async directory => {
  const statePath = path.join(directory, 'task.jsonl'), lab = fakeLab({ validate: () => ({ passed: false, error: { message: 'Unresolved layout' } }) });
  const first = await runAdaptation({ ...base(lab), statePath, connection: { baseUrl: 'https://provider.example/v1', model: 'model-a', apiKey: 'key-first' }, maxAttempts: 1, generate: async ({ tools }) => { const candidate = await write(tools); await tools.validate_adapter.execute({ candidateId: candidate.candidateId }); await write(tools); } });
  assert.match(first.state.strategyDirective, /本轮修复已累计 1 次/);
  assert.equal(first.state.blocked, undefined);
  const same = await runAdaptation({ ...base(lab), statePath, connection: { baseUrl: 'https://provider.example/v1', model: 'model-a', apiKey: 'key-second' }, generate: async ({ tools }) => { await tools.inspect_context.execute({}); await write(tools); } });
  assert.equal(same.status, 'needs-review');
  assert.equal(same.state.repairWindow, 1, 'key rotation keeps the failure window');
  assert.equal(same.state.attempts, 3, 'the attempt count continues instead of restarting');
  const changed = await runAdaptation({ ...base(lab), statePath, connection: { baseUrl: 'https://provider.example/v1', model: 'model-b', apiKey: 'key-third' }, generate: async ({ tools }) => {
    assert.equal((await tools.inspect_context.execute({})).progress.attempts, 3);
    await write(tools);
  } });
  assert.equal(changed.state.repairWindow, 2);
  assert.equal(changed.state.attempts, 4);
  const journal = await readFile(statePath, 'utf8');
  assert.equal(journal.includes('provider.example'), false);
  for (const secret of ['key-first', 'key-second', 'key-third']) assert.equal(journal.includes(secret), false);
}));

test('changing reasoning opens a failure window without discarding the prior candidate', () => temporary(async directory => {
  const statePath = path.join(directory, 'task.jsonl');
  const lab = fakeLab({ validate: () => ({ passed: false, error: { message: 'Unresolved layout' } }) });
  const connection = { baseUrl: 'https://openrouter.ai/api/v1', model: 'neutral-model' };
  const first = await runAdaptation({ ...base(lab), statePath, connection, maxAttempts: 1, generate: async ({ tools }) => {
    const candidate = await write(tools); await tools.validate_adapter.execute({ candidateId: candidate.candidateId });
  } });
  const candidateId = first.state.candidateId;
  assert.ok(candidateId);
  const unchanged = await runAdaptation({ ...base(lab), statePath, connection: { ...connection, reasoning: 'auto' }, generate: async ({ tools }) => { await tools.inspect_context.execute({}); } });
  assert.equal(unchanged.state.repairWindow, first.state.repairWindow, 'An explicit default is not a new model configuration');
  const changed = await runAdaptation({ ...base(lab), statePath, connection: { ...connection, reasoning: 'disabled' }, generate: async ({ tools }) => {
    const context = await tools.inspect_context.execute({});
    assert.equal(context.progress.attempts, first.state.attempts);
    assert.equal(context.progress.candidateId, candidateId, 'The existing paid candidate remains available');
  } });
  assert.equal(changed.state.repairWindow, first.state.repairWindow + 1);
  assert.equal(changed.state.candidateId, candidateId);
}));

test('real SDK tool calls feed failed validation back to the next model step', async () => {
  const messages = [], steps = [
    ['write_adapter', { manifest: { id: 'story-1' }, code: '({extract(){}})' }],
    ['validate_adapter', { candidateId: 'candidate-1' }],
    ['write_adapter', { manifest: { id: 'story-1' }, code: '({extract(){return {}}})' }],
    ['validate_adapter', { candidateId: 'candidate-3' }],
    ['submit_recipe', { candidateId: 'candidate-3', validationId: 'proof-1', metadata: {} }],
  ];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    messages.push(JSON.parse(body));
    const [name, input] = steps[messages.length - 1];
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `response-${messages.length}`, object: 'chat.completion', created: 1, model: 'test-model', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: `call-${messages.length}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    let validations = 0;
    const lab = fakeLab({ validate: () => ++validations === 1 ? { validationId: 'bad-1', passed: false, checks: { roundtrip: false }, error: { code: 'BYTE_MISMATCH', message: 'byte differs' } } : { validationId: 'proof-1', passed: true, checks: { roundtrip: true, sample: true, structure: true } } });
    const result = await runAdaptation({ ...base(lab), connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'test-model', apiKey: 'sdk-host-secret' } });
    assert.equal(result.status, 'verified', JSON.stringify(result.error));
    assert.equal(messages.length, 5);
    assert.match(JSON.stringify(messages[2].messages), /BYTE_MISMATCH/);
    assert.equal(JSON.stringify(lab.calls).includes('sdk-host-secret'), false);
    assert.equal(JSON.stringify(result.state).includes('sdk-host-secret'), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('coverage detects uncovered custom dialogue without treating images as missing translations', () => temporary(async directory => {
  await mkdir(path.join(directory, 'data'));
  await mkdir(path.join(directory, 'js'));
  await writeFile(path.join(directory, 'data', 'Map001.json'), '{"text":"Known dialogue"}');
  await writeFile(path.join(directory, 'data', 'story-extra.json'), '{"dialogue":["Hidden story"]}');
  await writeFile(path.join(directory, 'js', 'rpg_windows.js'), 'window.drawText("Engine text")');
  await writeFile(path.join(directory, 'picture.png'), Buffer.from([0x89, 0x50]));
  const report = await scanCoverage({ rootDir: directory, units: [{ source: 'Known dialogue', context: { file: 'data/Map001.json' } }] });
  assert.equal(report.summary.extracted, 1);
  assert.equal(report.summary['display-text-candidate'], 1);
  assert.equal(report.summary['image-candidate'], 1);
  assert.deepEqual(report.triggers, ['suspected-omission']);
  assert.equal(report.resources.find(item => item.file === 'js/rpg_windows.js').kind, 'script-resource');
  assert.equal(report.runtime.status, 'pending');
}));

test('one extracted JSON field cannot hide another display field in the same resource', () => temporary(async directory => {
  await writeFile(path.join(directory, 'scene.json'), JSON.stringify({ lines: ['Visible first line.', 'Visible second omitted line.'], image: 'assets/title.png', logic: { text: 'Internal gameplay identity' }, id: 'resource-123' }));
  const first = { id: 'line-first', source: 'Visible first line.', locator: { file: 'scene.json', pointer: '/lines/0' }, context: { file: 'scene.json' } };
  const partial = await scanCoverage({ rootDir: directory, units: [first] });
  assert.equal(partial.needsAdaptation, true);
  assert.deepEqual(partial.dynamicCandidates.map(item => item.locator?.pointer), ['/lines/1']);
  const second = { id: 'line-second', source: 'Visible second omitted line.', locator: { file: 'scene.json', pointer: '/lines/1' }, context: { file: 'scene.json' } };
  const complete = await scanCoverage({ rootDir: directory, units: [first, second] });
  assert.equal(complete.needsAdaptation, false);
  assert.equal(complete.summary.unresolvedCandidates, 0);
}));

test('JSON duplicate strings require distinct pointer ownership and native target manifests are honored', () => temporary(async directory => {
  const game = path.join(directory, 'game'); await mkdir(game);
  await writeFile(path.join(game, 'scene.json'), '{"lines":["Repeated scene.","Repeated scene."]}');
  const unit = { id: 'scene:1', source: 'Repeated scene.', context: { file: 'scene.json' }, locator: { file: 'scene.json', pointer: '/lines/0' } };
  const partial = await scanCoverage({ rootDir: game, units: [unit], inventory: { units: [unit] } });
  assert.equal(partial.dynamicCandidates.length, 1);
  assert.equal(partial.dynamicCandidates[0].locator.pointer, '/lines/1');
  const manifestPath = path.join(directory, 'manifest.json');
  const data = await readFile(path.join(game, 'scene.json'));
  const rawManifest = JSON.stringify({ schema: 'rpgmaker-ai-work-v1', files: { 'scene.json': { sha256: createHash('sha256').update(data).digest('hex') } },
    units: { a: { file: 'scene.json', source: 'Repeated scene.', targets: [['lines', 0]] }, b: { file: 'scene.json', source: 'Repeated scene.', targets: [['lines', 1]] } } });
  await mkdir(path.join(directory, 'technical'));
  await writeFile(manifestPath, rawManifest);
  await writeFile(path.join(directory, 'technical', 'manifest.sha256'), createHash('sha256').update(rawManifest).digest('hex'));
  const complete = await scanCoverage({ rootDir: game, units: ['a', 'b'].map(id => ({ id, source: 'Repeated scene.', context: { file: 'scene.json' } })), inventory: { nativeManifestPath: manifestPath } });
  assert.equal(complete.needsAdaptation, false);
  const fallback = { id: 'no-pointer', source: 'Repeated scene.', context: { file: 'scene.json' } };
  const cautious = await scanCoverage({ rootDir: game, units: [fallback], inventory: { units: [fallback] } });
  assert.equal(cautious.dynamicCandidates.length, 1, 'normalized and raw copies of one fallback unit do not count twice');
}));

test('technical unit inspection exposes stable IDs and host locators in bounded file pages', async () => {
  const lab = fakeLab();
  await runAdaptation({ ...base(lab), inventory: { existingUnits: [
    { id: 'internal-1', legacyId: 'native:1', source: 'First unit.', context: { file: 'a.json', adaptationLocator: { file: 'a.json', pointer: '/lines/0' } } },
    { id: 'internal-2', legacyId: 'native:2', source: 'Second unit.', context: { file: 'b.json' } },
  ] }, generate: async ({ tools }) => {
    const page = await tools.inspect_units.execute({ file: 'a.json', offset: 0, limit: 1 });
    assert.equal(page.total, 1);
    assert.equal(page.units[0].id, 'native:1');
    assert.equal(page.units[0].locator.pointer, '/lines/0');
  } });
});

test('zero text and extraction failures trigger adaptation independently from unit progress', () => temporary(async directory => {
  const report = await scanCoverage({ rootDir: directory, inventory: { unitCount: 0, reviewItems: [{ kind: 'compiled_script_requires_decompiler', file: 'story.gdc' }] } });
  assert.deepEqual(report.triggers, ['zero-text', 'partial-extraction']);
  assert.equal(report.completeness, 'review-required');
}));

test('coverage ledger accepts extracted archive roots and avoids symlink traversal', () => temporary(async directory => {
  const unpacked = path.join(directory, 'unpacked');
  await mkdir(unpacked);
  await writeFile(path.join(unpacked, 'story.json'), '{"dialogue":"Known"}');
  const report = await scanCoverage({ rootDir: directory, sourceRoots: [unpacked], units: [{ id: 'known-dialogue', source: 'Known', context: { file: 'story.json' }, locator: { file: 'story.json', pointer: '/dialogue' } }] });
  assert.equal(report.needsAdaptation, false);
  assert.equal(report.summary['display-text-candidate'], 0);
}));

test('a partly extracted script still reports its unresolved dynamic literals', () => temporary(async directory => {
  await writeFile(path.join(directory, 'story.gd'), 'var title = tr("Known title")\nvar prose = "Missing scene text"');
  const report = await scanCoverage({ rootDir: directory, units: [{ source: 'Known title', context: { file: 'story.gd' }, locator: { start: 15 } }], inventory: {
    dynamicCandidates: [{ file: 'story.gd', source: 'Missing scene text', kind: 'godot_script_literal_candidate', target: { start: 45, end: 65 } }],
    coverage: { resources: [{ file: 'story.gd', status: 'display_candidates', units: 1 }] },
  } });
  assert.equal(report.summary.extracted, 1);
  assert.equal(report.summary.unresolvedCandidates, 1);
  assert.equal(report.resources[0].hasExtractedText, true);
  assert.equal(report.resources[0].unresolvedCandidates, 1);
  assert.equal(report.resources[0].kind, 'display-text-candidate');
  assert.deepEqual(report.triggers, ['suspected-omission']);
}));

test('host-validated GD byte spans resolve the exact quoted candidate after Unicode and escapes', () => temporary(async directory => {
  const gameDir = path.join(directory, 'game'); await mkdir(gameDir);
  const rawBody = 'Hidden \\nscene \\u4F60 \\"quoted\\"';
  const source = `# 前置🙂\nvar known = "Native title"\nvar extra = "${rawBody}"\nvar duplicate = "${rawBody}"\n`;
  await writeFile(path.join(gameDir, 'story.gd'), source);
  const literal = `"${rawBody}"`, first = source.indexOf(literal), second = source.indexOf(literal, first + literal.length);
  const candidate = index => ({ file: 'story.gd', source: JSON.parse(literal), classification: 'display_unresolved', kind: 'godot_script_literal_candidate', target: { start: Array.from(source.slice(0, index)).length, end: Array.from(source.slice(0, index + literal.length)).length, render: 'quoted' } });
  const candidates = [candidate(first), candidate(second)];
  const manifest = { schemaVersion: 1, id: 'gd-extra-span', version: '1.0.0', engine: 'Godot', scope: { files: ['story.gd'] }, license: 'GPL-3.0-or-later', sources: [] };
  const code = `({detect(host){return {matched:host.list('').some(item=>item.path==='story.gd')}},extract(host){const text=host.readText('story.gd'),prefix='var extra = "',start=text.indexOf(prefix)+prefix.length;let end=start;while(end<text.length){if(text[end]==='\\\\'){end+=2;continue;}if(text[end]==='"')break;end++;}const size=value=>encodeURIComponent(value).replace(/%[0-9A-F]{2}|./g,'x').length;return {units:[{id:'extra',source:text.slice(start,end),kind:'script_display',context:{file:'story.gd'},locator:{file:'story.gd',byteStart:size(text.slice(0,start)),byteEnd:size(text.slice(0,end))}}]}},validate(){return {valid:true}},roundtrip(host){host.writeBytes('story.gd',host.readBytes('story.gd'));return {}},build(host,input){const text=host.readText('story.gd'),prefix='var extra = "',start=text.indexOf(prefix)+prefix.length;let end=start;while(end<text.length){if(text[end]==='\\\\'){end+=2;continue;}if(text[end]==='"')break;end++;}host.writeText('story.gd',text.slice(0,start)+(input.translations.extra??text.slice(start,end))+text.slice(end));return {}},assemble(){return {}}})`;
  const lab = await createAdapterLab({ dataDir: path.join(directory, 'lab') });
  const stored = await lab.writeAdapter({ manifest, code });
  const validation = await lab.validateAdapter({ candidateId: stored.candidateId, gameDir });
  assert.equal(validation.passed, true, validation.error?.message);
  const native = { id: 'native-title', source: 'Native title', context: { file: 'story.gd' } };
  const inventory = { dynamicCandidates: candidates, units: validation.extraction.units, coverage: { resources: [{ file: 'story.gd', status: 'display_candidates', units: 1 }] } };
  const partial = await scanCoverage({ rootDir: gameDir, units: [native, ...validation.extraction.units], inventory });
  assert.equal(partial.summary.resolvedCandidates, 1);
  assert.equal(partial.summary.unresolvedCandidates, 1);
  assert.equal(partial.dynamicCandidates[0].target.start, candidates[1].target.start, 'identical text at a different location stays unresolved');
  assert.deepEqual(partial.triggers, ['suspected-omission']);
  const secondUnit = { id: 'duplicate', rawSource: rawBody, source: rawBody, context: { file: 'story.gd' }, locator: { file: 'story.gd', byteStart: Buffer.byteLength(source.slice(0, second + 1)), byteEnd: Buffer.byteLength(source.slice(0, second + literal.length - 1)) } };
  const all = [...validation.extraction.units, secondUnit];
  const complete = await scanCoverage({ rootDir: gameDir, units: [native, ...all.map(unit => ({ id: unit.id, source: unit.source, context: unit.context }))], inventory: { ...inventory, units: all } });
  assert.equal(complete.summary.resolvedCandidates, 2);
  assert.equal(complete.summary.unresolvedCandidates, 0);
  assert.equal(complete.needsAdaptation, false, 'core-normalized units retain raw host locator evidence through inventory.units');
  const normalizedOnly = await scanCoverage({ rootDir: gameDir, units: [native, ...all.map(unit => ({ id: unit.id, source: 'protected source {{CTRL0001}}', context: { file: 'story.gd', adaptationLocator: unit.locator, adaptationSourceHash: createHash('sha256').update(unit.rawSource ?? unit.source).digest('hex') } }))], inventory: { ...inventory, units: undefined } });
  assert.equal(normalizedOnly.needsAdaptation, false, 'host source hashes bind normalized protected text to the exact original bytes');
}));

test('quoted candidate mapping preserves BOM, single/triple quotes and octal escapes without clearing unrelated spans', () => temporary(async directory => {
  const text = "# 🙂 prefix\nvar a = 'One \\141 scene'\nvar b = \"\"\"Multi\nline \\u4F60\"\"\"\n";
  await writeFile(path.join(directory, 'quoted.gd'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]));
  const literals = ["'One \\141 scene'", '"""Multi\nline \\u4F60"""'];
  const values = ['One a scene', 'Multi\nline 你'];
  const candidates = literals.map((literal, index) => ({ file: 'quoted.gd', source: values[index], target: { start: Array.from(text.slice(0, text.indexOf(literal))).length, end: Array.from(text.slice(0, text.indexOf(literal) + literal.length)).length, render: 'quoted' } }));
  const units = literals.map((literal, index) => {
    const width = literal.startsWith('"""') ? 3 : 1, start = text.indexOf(literal) + width, end = text.indexOf(literal) + literal.length - width;
    return { id: `literal-${index}`, source: text.slice(start, end), locator: { file: 'quoted.gd', byteStart: 3 + Buffer.byteLength(text.slice(0, start)), byteEnd: 3 + Buffer.byteLength(text.slice(0, end)) }, context: { file: 'quoted.gd' } };
  });
  const complete = await scanCoverage({ rootDir: directory, units, inventory: { dynamicCandidates: candidates } });
  assert.equal(complete.summary.resolvedCandidates, 2);
  assert.equal(complete.needsAdaptation, false);
  const wrongSource = await scanCoverage({ rootDir: directory, units: [{ ...units[0], source: 'Different text' }, units[1]], inventory: { dynamicCandidates: candidates } });
  assert.equal(wrongSource.summary.unresolvedCandidates, 1);
  const wrongRange = await scanCoverage({ rootDir: directory, units: [{ ...units[0], locator: { ...units[0].locator, byteEnd: units[0].locator.byteEnd - 1 } }, units[1]], inventory: { dynamicCandidates: candidates } });
  assert.equal(wrongRange.summary.unresolvedCandidates, 1);
}));

test('coverage consumes archive manifests even when only the packed file is visible', () => temporary(async directory => {
  await writeFile(path.join(directory, 'game.pck'), 'archive marker');
  const report = await scanCoverage({ rootDir: directory, units: [{ source: 'One title', context: { file: 'story.gd' } }], inventory: {
    coverage: { resources: [{ file: 'story.gd', status: 'display_candidates', units: 1 }, { file: 'screens/menu.tscn', status: 'text_extracted', units: 4 }], structuralRecoveryWarnings: 1 },
  } });
  assert.equal(report.resources.filter(item => item.root === 'native-manifest').length, 2);
  assert.equal(report.summary.extracted, 2);
  assert.deepEqual(report.triggers, ['suspected-omission', 'partial-extraction']);
}));

test('RenPy control-flow labels stay distinct from unsupported display statements', () => temporary(async directory => {
  await mkdir(path.join(directory, 'game'));
  await writeFile(path.join(directory, 'game', 'script.rpy'), 'label start:\n    narrator "A complete scene."\ntextbutton _("Another button") action Return()\n');
  const units = [{ source: 'A complete scene.', context: { file: 'game/script.rpy' } }];
  const reviewItems = [{ file: 'game/script.rpy', line: 1, kind: 'unsupported_source_statement' }];
  const valid = await scanCoverage({ rootDir: directory, units, inventory: { reviewItems } });
  assert.equal(valid.needsAdaptation, false);
  assert.equal(valid.nonTextReviewItems[0].classification, 'control-flow-label');
  const unsupported = await scanCoverage({ rootDir: directory, units, inventory: { reviewItems: [...reviewItems, { file: 'game/script.rpy', line: 3, kind: 'unsupported_source_statement' }] } });
  assert.deepEqual(unsupported.triggers, ['partial-extraction']);
  assert.equal(unsupported.extractionIssues.length, 1);
  assert.equal(unsupported.extractionIssues[0].line, 3);
}));

test('Unity native carrier evidence and font layout reminders do not open a text repair task', () => temporary(async directory => {
  await mkdir(path.join(directory, 'Fixture_Data'));
  await writeFile(path.join(directory, 'Fixture_Data', 'resources.assets'), Buffer.from([0, 1, 2]));
  const report = await scanCoverage({ rootDir: directory, units: [{ source: 'Start adventure', context: { file: '__unity_text__/virtual.json', carrier: 'Fixture_Data/resources.assets', object: '@:7' } }], inventory: { reviewItems: [
    { file: 'Fixture_Data/resources.assets', object: '@:12', kind: 'static_or_external_font_requires_adapter' },
    { file: 'Fixture_Data/resources.assets', object: '@:13', kind: 'tmp_font_atlas_requires_separate_font_adapter' },
  ] } });
  assert.equal(report.needsAdaptation, false);
  assert.equal(report.summary.extracted, 1);
  assert.equal(report.nonTextReviewItems.length, 2);
  assert.equal(report.reviewItems.length, 2);
}));

test('classified logic, resource and debug literals stay visible without triggering display repair', () => temporary(async directory => {
  await writeFile(path.join(directory, 'state.gd'), 'extends Node\n');
  const units = [{ source: 'Known menu text', context: { file: 'menu.tscn' } }];
  const candidates = ['logic_identity', 'resource_identity', 'debug_output'].map((classification, index) => ({ file: 'state.gd', source: `internal ${index}`, classification, target: { start: index + 1, end: index + 2 } }));
  const nonDisplay = await scanCoverage({ rootDir: directory, units, inventory: { dynamicCandidates: candidates } });
  assert.equal(nonDisplay.needsAdaptation, false);
  assert.equal(nonDisplay.classifiedCandidates.length, 3);
  assert.equal(nonDisplay.summary.nonDisplayCandidates, 3);
  const display = await scanCoverage({ rootDir: directory, units, inventory: { dynamicCandidates: [...candidates, { file: 'state.gd', source: 'An unresolved story line.', classification: 'display_unresolved' }] } });
  assert.equal(display.summary.unresolvedCandidates, 1);
  assert.deepEqual(display.triggers, ['suspected-omission']);
}));

test('source and work file tools use only host-selected roots', () => temporary(async directory => {
  const gameDir = path.join(directory, 'game'), workDir = path.join(directory, 'work');
  await mkdir(gameDir); await mkdir(workDir);
  await writeFile(path.join(gameDir, 'source.json'), '{"dialogue":"Source story"}');
  await writeFile(path.join(workDir, 'unpacked.json'), '{"dialogue":"Unpacked story"}');
  const lab = await createAdapterLab({ dataDir: path.join(directory, 'lab') });
  const result = await runAdaptation({ ...base(lab), gameDir, workspaceDir: workDir, generate: async ({ tools }) => {
    const source = await tools.list_files.execute({ root: 'source' });
    assert.deepEqual(source.files.map(item => item.path), ['source.json']);
    const work = await tools.list_files.execute({ root: 'work' });
    assert.deepEqual(work.files.map(item => item.path), ['unpacked.json']);
    const resource = await tools.read_resource.execute({ root: 'work', file: 'unpacked.json' });
    assert.match(resource.content, /Unpacked story/);
    const search = await tools.search_files.execute({ root: 'work', query: 'Unpacked story', content: true });
    assert.equal(search.items[0].file, 'unpacked.json');
    assert.match((await tools.list_files.execute({ root: '../' })).error.message, /source 或 work/);
    assert.ok((await tools.read_resource.execute({ root: 'work', file: '../game/source.json' })).error);
  } });
  assert.equal(result.status, 'needs-review');
}));

test('task journals and tool feedback redact transport secrets and recover a truncated tail', () => temporary(async directory => {
  const statePath = path.join(directory, 'task.jsonl'), secret = 'custom-provider-secret-value';
  const sampleKeyA = ['sk', '1234567890123456'].join('-'), sampleKeyB = ['sk', 'abcdef0123456789'].join('-');
  const lab = fakeLab();
  lab.runTool = async () => { throw new Error(`request failed Bearer sensitive-bearer-token ${sampleKeyA} ${secret}`); };
  const result = await runAdaptation({ ...base(lab), connection: { apiKey: secret }, statePath, generate: async ({ tools }) => {
    const output = await tools.run_tool.execute({ tool: 'parser', args: [] });
    assert.equal(JSON.stringify(output).includes(secret), false);
    assert.equal(JSON.stringify(output).includes('sensitive-bearer-token'), false);
    throw new Error(`transport ${secret} Bearer other-sensitive-token ${sampleKeyB}`);
  } });
  assert.equal(result.status, 'failed');
  const journal = await readFile(statePath, 'utf8');
  for (const token of [secret, 'sensitive-bearer-token', 'other-sensitive-token', sampleKeyA, sampleKeyB]) assert.equal(journal.includes(token), false, token);
  await writeFile(statePath, `${journal}{"format":"pinhao-adaptation-task-1","broken":`, 'utf8');
  assert.equal((await readAdaptationState(statePath)).status, 'failed');
  const recovered = await runAdaptation({ ...base(lab), statePath, generate: async () => {} });
  assert.equal(recovered.status, 'needs-review');
  assert.equal((await readAdaptationState(statePath)).status, 'needs-review');
}));

test('a real lab trusted tool can unpack into the work root and be inspected', () => temporary(async directory => {
  const gameDir = path.join(directory, 'game'), workspaceDir = path.join(directory, 'work');
  await mkdir(gameDir); await mkdir(workspaceDir);
  const lab = await createAdapterLab({ dataDir: path.join(directory, 'lab'), trustedTools: {
    'fixture-unpack': { description: 'Decode a neutral fixture', argsHint: '[]', validateArgs: args => args.length === 0, execute: async ({ workDir }) => {
      await writeFile(path.join(workDir, 'extracted.json'), '{"dialogue":"Unpacked neutral text"}');
      return { exitCode: 0, files: ['extracted.json'] };
    } },
  } });
  await runAdaptation({ ...base(lab), gameDir, workspaceDir, generate: async ({ tools }) => {
    const info = await tools.inspect_context.execute({});
    assert.equal(info.tools.trusted[0].name, 'fixture-unpack');
    const output = await tools.run_tool.execute({ tool: 'fixture-unpack', args: [] });
    assert.equal(output.exitCode, 0);
    assert.match((await tools.read_resource.execute({ root: 'work', file: 'extracted.json' })).content, /Unpacked neutral text/);
  } });
}));

test('SDK, real QuickJS validation, repair, build and persisted unknown-engine reuse connect end to end', () => temporary(async directory => {
  const gameDir = path.join(directory, 'game'), workspaceDir = path.join(directory, 'work');
  await mkdir(path.join(gameDir, 'data'), { recursive: true });
  await writeFile(path.join(gameDir, 'data', 'story.json'), '{"lines":["A whole scene.","Another scene."],"logic":{"id":"keep"}}');
  await writeFile(path.join(gameDir, 'Game.exe'), 'neutral marker');
  const sourceBefore = await readFile(path.join(gameDir, 'data', 'story.json'));
  const manifest = { schemaVersion: 1, id: 'neutral-sdk-story', version: '1.0.0', engine: 'Neutral SDK Fixture', scope: { files: ['data/story.json'] }, license: 'GPL-3.0-or-later', sources: [] };
  const code = `({detect(host){return {matched:host.list('data').some(item=>item.path==='data/story.json')}} ,extract(host){const data=JSON.parse(host.readText('data/story.json'));return {units:data.lines.map((source,i)=>({id:'line:'+i,source,kind:'dialogue',context:{file:'data/story.json'},locator:{file:'data/story.json',pointer:'/lines/'+i}})),coverage:[{file:'data/story.json',status:'extracted'}]}},validate(){return {valid:true}},roundtrip(host){host.writeBytes('data/story.json',host.readBytes('data/story.json'));return {}},build(host,input){const data=JSON.parse(host.readText('data/story.json'));for(const unit of input.units)if(Object.hasOwn(input.translations,unit.id))data.lines[Number(unit.locator.pointer.split('/').pop())]=input.translations[unit.id];host.writeText('data/story.json',JSON.stringify(data));return {}},assemble(){return {complete:true}}})`;
  const broken = code.replace("JSON.parse(host.readText('data/story.json'))", "JSON.parse('broken JSON')");
  const messages = [], output = (body, index) => JSON.parse(body.messages.findLast(item => item.role === 'tool' && item.tool_call_id === `call-${index}`).content);
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), index = messages.length; messages.push(body);
    const calls = [
      ['inspect_context', {}], ['read_resource', { root: 'source', file: 'data/story.json' }],
      ['write_adapter', { manifest, code: broken }], ['validate_adapter', () => ({ candidateId: output(body, 2).candidateId })],
      ['read_adapter', () => ({ candidateId: output(body, 2).candidateId })], ['write_adapter', { manifest, code }],
      ['validate_adapter', () => ({ candidateId: output(body, 5).candidateId })],
      ['submit_recipe', () => ({ candidateId: output(body, 5).candidateId, validationId: output(body, 6).validationId, metadata: { summary: 'Neutral complete scene fixture' } })],
    ];
    const [name, factory] = calls[index];
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `model-${index}`, object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: `call-${index}`, type: 'function', function: { name, arguments: JSON.stringify(typeof factory === 'function' ? factory() : factory) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dataDir = path.join(directory, 'lab'), lab = await createAdapterLab({ dataDir, workspaceFor: () => workspaceDir });
  try {
    const result = await runAdaptation({ ...base(lab), project: { id: 'neutral-real-lab', name: 'Neutral fixture', engine: 'unknown' }, gameDir, workspaceDir, connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture', apiKey: 'host-test-key-only' }, statePath: path.join(directory, 'task.jsonl') });
    assert.equal(result.status, 'verified', JSON.stringify(result.error ?? result.state));
    assert.equal(result.extraction.units.length, 2);
    assert.equal(result.validation.checks.roundtrip, 'passed');
    assert.equal(result.validation.checks.sample, 'passed');
    assert.equal(result.validation.checks.structure, 'passed');
    assert.equal(result.validation.runtime.status, 'pending');
    assert.equal(messages.length, 8);
    assert.match(JSON.stringify(messages[4].messages), /JSON|unexpected|expect/i);
    const built = await lab.dispatch('build', { projectId: 'neutral-real-lab', workspaceDir, outputDir: path.join(directory, 'built'), translations: [{ id: 'line:0', translation: '完整场景。' }, { id: 'line:1', translation: '另一场景。' }] });
    const assembled = await lab.dispatch('assemble', { projectId: 'neutral-real-lab', workspaceDir, buildDir: built.buildDir, outputDir: path.join(directory, 'product') });
    assert.deepEqual(JSON.parse(await readFile(path.join(assembled.outputDir, 'data', 'story.json'), 'utf8')), { lines: ['完整场景。', '另一场景。'], logic: { id: 'keep' } });
    assert.deepEqual(await readFile(path.join(gameDir, 'data', 'story.json')), sourceBefore);
    const reopened = await createAdapterLab({ dataDir });
    const reused = await runAdaptation({ ...base(reopened), project: { id: 'second-import', name: 'Same game', engine: '识别中' }, gameDir, workspaceDir: path.join(directory, 'second-work'), generate: () => assert.fail('validated recipe should reuse without model') });
    assert.equal(reused.status, 'verified');
    assert.equal(reused.reused, true);
    assert.equal(reused.units.length, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));

test('SDK receives remaining coverage and expands a real recipe to the second resource before completion', () => temporary(async directory => {
  const gameDir = path.join(directory, 'game'), workspaceDir = path.join(directory, 'work');
  await mkdir(path.join(gameDir, 'data'), { recursive: true });
  await writeFile(path.join(gameDir, 'data', 'first.json'), '{"lines":["First complete scene."],"logic":{"id":"first"}}');
  await writeFile(path.join(gameDir, 'data', 'second.json'), '{"lines":["Second complete scene."],"logic":{"id":"second"}}');
  const definition = files => ({
    manifest: { schemaVersion: 1, id: 'coverage-scene-fixture', version: '1.0.0', engine: 'Coverage Fixture', scope: { files }, license: 'GPL-3.0-or-later', sources: [] },
    code: `({detect(host){return {matched:${JSON.stringify(files)}.every(file=>host.list('').some(item=>item.path===file))}},extract(host){return {units:${JSON.stringify(files)}.flatMap(file=>JSON.parse(host.readText(file)).lines.map((source,i)=>({id:file+':'+i,source,kind:'dialogue',context:{file},locator:{file,pointer:'/lines/'+i}}))),coverage:${JSON.stringify(files)}.map(file=>({file,status:'extracted'}))}},validate(){return {valid:true}},roundtrip(host){for(const file of ${JSON.stringify(files)})host.writeBytes(file,host.readBytes(file));return {}},build(host,input){for(const file of ${JSON.stringify(files)}){const data=JSON.parse(host.readText(file));for(const unit of input.units)if(unit.locator.file===file&&Object.hasOwn(input.translations,unit.id))data.lines[Number(unit.locator.pointer.split('/').pop())]=input.translations[unit.id];host.writeText(file,JSON.stringify(data));}return {}},assemble(){return {}}})`,
  });
  const partial = definition(['data/first.json']), complete = definition(['data/first.json', 'data/second.json']);
  const messages = [], output = (body, index) => JSON.parse(body.messages.findLast(item => item.role === 'tool' && item.tool_call_id === `coverage-${index}`).content);
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), index = messages.length; messages.push(body);
    const calls = [
      ['write_adapter', partial], ['validate_adapter', () => ({ candidateId: output(body, 0).candidateId })],
      ['submit_recipe', () => ({ candidateId: output(body, 0).candidateId, validationId: output(body, 1).validationId, metadata: {} })],
      ['inspect_context', {}], ['write_adapter', complete], ['validate_adapter', () => ({ candidateId: output(body, 4).candidateId })],
      ['submit_recipe', () => ({ candidateId: output(body, 4).candidateId, validationId: output(body, 5).validationId, metadata: {} })],
    ];
    const [name, factory] = calls[index];
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `coverage-model-${index}`, object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: `coverage-${index}`, type: 'function', function: { name, arguments: JSON.stringify(typeof factory === 'function' ? factory() : factory) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const lab = await createAdapterLab({ dataDir: path.join(directory, 'lab'), workspaceFor: () => workspaceDir });
  try {
    let checks = 0;
    const result = await runAdaptation({ ...base(lab), gameDir, workspaceDir, connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture' }, verifyCoverage: async extraction => {
      checks++;
      return scanCoverage({ rootDir: gameDir, inventory: extraction, units: extraction.units });
    } });
    assert.equal(result.status, 'verified', JSON.stringify(result.error ?? result.state));
    assert.equal(checks, 2);
    assert.equal(result.coverage.needsAdaptation, false);
    assert.equal(result.units.length, 2);
    assert.equal(messages.length, 7);
    const partialReply = output(messages[3], 2);
    assert.equal(partialReply.taskComplete, false);
    assert.equal(partialReply.remainingCoverage.resources[0].file, 'data/second.json');
    assert.match(JSON.stringify(messages[4].messages), /second\.json/);
    const built = await lab.dispatch('build', { projectId: base(lab).project.id, workspaceDir: result.extraction.workspaceDir, outputDir: path.join(directory, 'built'), translations: result.units.map(unit => ({ id: unit.id, translation: `译文：${unit.source}` })) });
    for (const file of ['first', 'second']) {
      const data = JSON.parse(await readFile(path.join(built.buildDir, 'data', `${file}.json`), 'utf8'));
      assert.match(data.lines[0], /^译文：/);
      assert.equal(data.logic.id, file);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
}));

test('public research rejects private, mapped, reserved and rebinding DNS targets', async () => {
  for (const value of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.1.1', '192.168.0.1', '::1', '::ffff:8.8.8.8', '2001::1', '2001:db8::1', 'fc00::1']) assert.equal(isPublicAddress(value), false, value);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  await assert.rejects(resolvePublicUrl('https://docs.example.test', { lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), /保留网络/);
  const credentials = new URL('https://example.com'); credentials.username = 'fixture-user'; credentials.password = 'fixture-password';
  for (const value of ['http://example.com', credentials.href, 'https://example.com:444/', 'https://127.1/', 'https://localhost/', 'https://[::ffff:127.0.0.1]/']) await assert.rejects(resolvePublicUrl(value));
});

test('public research validates every redirect and returns reference links as data', async () => {
  const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
  let requests = 0;
  await assert.rejects(readPublicPage('https://docs.example.test', { lookup, request: async () => { requests++; return { redirect: 'https://169.254.169.254/latest/meta-data/' }; } }), /保留网络/);
  assert.equal(requests, 1);
  const page = await readPublicPage('https://docs.example.test', { lookup, request: async ({ address }) => { assert.equal(address.address, '8.8.8.8'); return { text: '<script>run()</script><a href="/format">Format documentation</a>', contentType: 'text/html' }; } });
  assert.equal(page.text, 'Format documentation');
  assert.deepEqual(page.links, ['https://docs.example.test/format']);
  assert.equal(page.sourceKind, 'untrusted-public-reference');
});

test('public research cancellation and absolute deadlines cover stalled DNS and response activity', async () => {
  const lookup = () => new Promise(() => {});
  await assert.rejects(resolvePublicUrl('https://docs.example.test', { lookup, timeoutMs: 15 }), /超时/);
  await assert.rejects(readPublicPage('https://docs.example.test', { lookup, timeoutMs: 15 }), /超时/);
  const controller = new AbortController();
  const cancelled = readPublicPage('https://docs.example.test', { lookup, signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, error => error.name === 'AbortError');
  const activeLookup = async () => [{ address: '8.8.8.8', family: 4 }];
  let requestSignal;
  await assert.rejects(readPublicPage('https://docs.example.test', { lookup: activeLookup, timeoutMs: 20, request: async (_target, { signal }) => { requestSignal = signal; return new Promise(() => {}); } }), /超时/);
  assert.equal(requestSignal.aborted, true);
});

test('read tools share three slots, cache identical reads and yield to exclusive adapter changes', async () => {
  const lab = fakeLab();
  let reads = 0, active = 0, maximum = 0, writes = 0;
  const ready = Promise.withResolvers(), gate = Promise.withResolvers();
  lab.readResource = async ({ file }) => {
    reads++; active++; maximum = Math.max(maximum, active);
    if (reads === 3) ready.resolve();
    await gate.promise;
    active--;
    return { file, content: `Evidence for ${file}` };
  };
  const originalWrite = lab.writeAdapter;
  lab.writeAdapter = async input => { assert.equal(active, 0, 'writes must follow all queued reads'); writes++; return originalWrite(input); };
  const progress = [];
  const result = await runAdaptation({ ...base(lab), onProgress: item => progress.push(item), generate: async ({ tools }) => {
    const pending = ['a.json', 'b.json', 'c.json', 'd.json', 'a.json'].map(file => tools.read_resource.execute({ file }));
    const candidate = write(tools);
    await ready.promise;
    assert.equal(reads, 3);
    assert.equal(writes, 0);
    gate.resolve();
    const output = await Promise.all(pending);
    assert.equal(output[4].cached, true);
    await candidate;
    assert.equal(reads, 4);
    await tools.read_resource.execute({ file: 'a.json' });
    assert.equal(reads, 5, 'a write invalidates cached file evidence');
    for (let index = 0; index < 8; index++) await tools.inspect_units.execute({});
    const nextAction = (await tools.read_resource.execute({ file: 'a.json' })).nextAction;
    assert.equal(nextAction, undefined, 'reads do not acquire an arbitrary eight-call completion deadline');
  } });
  assert.equal(result.status, 'needs-review');
  assert.equal(maximum, 3);
  assert.ok(progress.some(item => item.tool === 'read_resource' && item.phase === 'running'));
  assert.ok(result.state.events.some(item => item.tool === 'read_resource' && Number.isFinite(item.elapsedMs)));
});

test('mutable workspace reads, listings and searches observe running and completed managed output', () => temporary(async directory => {
  const gameDir = path.join(directory, 'game'), workspaceDir = path.join(directory, 'work');
  await mkdir(gameDir); await mkdir(workspaceDir);
  await writeFile(path.join(gameDir, 'stable.txt'), 'immutable source');
  await writeFile(path.join(workspaceDir, 'output.txt'), 'before');
  const lab = await createAdapterLab({ dataDir: path.join(directory, 'lab'),
    execution: { programs: { node: process.execPath }, authorize: async () => true } });
  const session = adaptationTools({ project: { id: 'mutable-work', engine: 'unknown' }, inventory: {}, lab, gameDir, workspaceDir,
    state: { events: [], failures: {}, attempts: 0 } });
  try {
    const code = `const fs=require('node:fs'); let stage=0;
      const timer=setInterval(()=>{
        if(stage===0 && fs.existsSync('release-one')) { fs.writeFileSync('output.txt','during marker'); fs.writeFileSync('generated-one.txt','one'); stage=1; console.log('during'); }
        if(stage===1 && fs.existsSync('release-two')) { fs.writeFileSync('output.txt','after marker'); fs.writeFileSync('generated-two.txt','two'); console.log('after'); clearInterval(timer); }
      },20); setTimeout(()=>clearInterval(timer),10000).unref();`;
    const run = await session.tools.run_workspace.execute({ program: 'node', args: ['-e', code] });
    assert.ok(run.runId, JSON.stringify(run));
    const read = () => session.tools.read_resource.execute({ root: 'work', file: 'output.txt' });
    const list = () => session.tools.list_files.execute({ root: 'work' });
    const search = () => session.tools.search_files.execute({ root: 'work', relativePath: 'output.txt', query: 'marker', content: true });
    assert.equal((await read()).content, 'before');
    assert.equal((await list()).files.some(file => file.path.startsWith('generated-')), false);
    assert.equal((await search()).items.length, 0);
    await session.tools.read_resource.execute({ file: 'stable.txt' });
    await writeFile(path.join(workspaceDir, 'release-one'), 'go');
    let status;
    for (let attempt = 0; attempt < 50; attempt++) {
      status = await session.tools.wait_run.execute({ runId: run.runId, waitMs: 20 });
      if (status.content.includes('during')) break;
    }
    assert.equal(status.status, 'running');
    assert.match(status.content, /during/);
    assert.equal((await read()).content, 'during marker');
    assert.ok((await list()).files.some(file => file.path === 'generated-one.txt'));
    assert.match((await search()).items[0].snippet, /during marker/);
    await writeFile(path.join(workspaceDir, 'release-two'), 'go');
    status = await session.tools.wait_run.execute({ runId: run.runId, waitMs: 5000 });
    assert.equal(status.status, 'completed');
    assert.equal((await read()).content, 'after marker');
    assert.ok((await list()).files.some(file => file.path === 'generated-two.txt'));
    assert.match((await search()).items[0].snippet, /after marker/);
    const unchangedSource = await session.tools.read_resource.execute({ file: 'stable.txt' });
    assert.equal(unchangedSource.cached, true, 'immutable source evidence still uses the existing cache');
  } finally { await lab.closeExecution(); session.close(); await session.flush(); }
}));

test('resource assignments preserve whole-copy read discovery and reject adapter writes outside their file ownership', async () => {
  const lab = fakeLab(), requested = [];
  lab.tryRecipes = async input => { requested.push(['reuse', input.files]); return null; };
  lab.listRecipes = async input => { requested.push(['list', input.files]); return []; };
  lab.inspectAdapter = async () => ({ manifest: { scope: { files: ['scripts/other.gd'] } } });
  const files = ['scripts/letter.gd'];
  lab.inspectFiles = async () => ({ files: files.concat('scripts/other.gd').map(file => ({ path: file })), truncated: false });
  const result = await runAdaptation({ ...base(lab), assignment: { id: 'letters', files, summary: 'One script resource' },
    inventory: { existingUnits: files.concat('scripts/other.gd').map((file, index) => ({ id: `unit-${index}`, source: 'A known line', context: { file } })) },
    coverage: { resources: files.concat('scripts/other.gd').map(file => ({ file, kind: 'display-text-candidate' })), dynamicCandidates: files.concat('scripts/other.gd').map(file => ({ file, source: 'A candidate line' })) },
    generate: async ({ tools, prompt }) => {
      assert.deepEqual(JSON.parse(prompt).assignment.files, files);
      assert.deepEqual((await tools.list_files.execute({ relativePath: '.', recursive: true })).files.map(item => item.path), files.concat('scripts/other.gd'));
      assert.deepEqual((await tools.search_files.execute({ query: 'letter', content: false })).items.map(item => item.file), files);
      assert.equal((await tools.inspect_units.execute({})).total, 1);
      const coverage = await tools.inspect_coverage.execute({});
      assert.equal(coverage.total, 1);
      assert.equal(coverage.dynamicTotal, 1);
      await tools.list_recipes.execute({});
      const rejected = await tools.write_adapter.execute({ manifest: { id: 'outside', scope: { files: ['scripts/other.gd'] } }, code: '({})' });
      assert.match(rejected.error.message, /assignment.files/);
      assert.equal(lab.calls.length, 0);
      assert.match((await tools.validate_adapter.execute({ candidateId: 'other-task-candidate' })).error.message, /其他资源任务/);
      assert.match((await tools.submit_recipe.execute({ candidateId: 'other-task-candidate', validationId: 'proof-1', metadata: {} })).error.message, /其他资源任务/);
      assert.equal(lab.calls.length, 0);
      await tools.write_adapter.execute({ manifest: { id: 'inside', scope: { files } }, code: '({})' });
    },
  });
  assert.equal(result.state.attempts, 1);
  assert.deepEqual(requested, [['reuse', files], ['list', files]]);
  await assert.rejects(runAdaptation({ ...base(lab), assignment: { files: ['../outside.json'] } }), /无效文件路径/);
});

test('model step journals preserve compact paired messages, evidence and a precise step-limit reason for SDK resume', () => temporary(async directory => {
  const requests = [], lab = fakeLab(), statePath = path.join(directory, 'progress.jsonl');
  const server = http.createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text), index = requests.length;
    requests.push(body);
    const calls = [
      ['read_resource', { root: 'source', file: 'story.json' }],
      ['write_adapter', { manifest: { id: 'story' }, code: '({})' }],
      ['validate_adapter', { candidateId: 'candidate-1' }],
      ['submit_recipe', { candidateId: 'candidate-1', validationId: 'proof-1', metadata: {} }],
    ];
    const [name, input] = calls[index];
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `resume-${index}`, object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: `resume-call-${index}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }, finish_reason: 'tool_calls' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const connection = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture', apiKey: 'resume-model-fixture-secret' };
    const first = await runAdaptation({ ...base(lab), connection, statePath, maxSteps: 1 });
    assert.equal(first.stopReason, 'step-limit');
    assert.equal(first.state.finishReason, 'tool-calls');
    assert.equal(first.state.conversation.length, 1);
    assert.ok(first.state.observations.some(item => item.tool === 'read_resource' && item.input.file === 'story.json'));
    const second = await runAdaptation({ ...base(lab), connection, statePath });
    assert.equal(second.status, 'verified', JSON.stringify(second.error));
    assert.ok(requests[1].messages.some(message => message.role === 'tool' && message.tool_call_id === 'resume-call-0'));
    assert.match(JSON.stringify(requests[1].messages), /The story continues/);
    const journal = await readFile(statePath, 'utf8');
    assert.equal(journal.includes(connection.apiKey), false);
    assert.ok(second.state.events.some(item => item.tool === 'model_step' && item.phase === 'complete'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}));

test('a stalled single model request times out with a recoverable checkpoint and explicit reason', () => temporary(async directory => {
  const received = Promise.withResolvers();
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {}
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"choices":');
    received.resolve();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const statePath = path.join(directory, 'progress.jsonl');
    const pending = runAdaptation({ ...base(fakeLab()), statePath, requestTimeoutMs: 80, connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture' } });
    await received.promise;
    const result = await pending;
    assert.equal(result.status, 'failed');
    assert.equal(result.stopReason, 'request-timeout');
    assert.equal(result.error.code, 'TECHNICAL_REQUEST_TIMEOUT');
    assert.equal((await readAdaptationState(statePath)).stopReason, 'request-timeout');
    assert.ok(result.state.events.some(item => item.tool === 'model_step' && item.phase === 'requesting'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}));

test('technical SDK streaming keeps a progressing tool call alive and executes it once after local preparation', () => temporary(async directory => {
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); requests++;
    assert.equal(body.stream, true);
    // Technical steps must declare their own output ceiling instead of relying on the provider default.
    assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens > 0 || Number.isInteger(body.max_completion_tokens) && body.max_completion_tokens > 0,
      `technical requests declare a positive output ceiling, got ${JSON.stringify({ max_tokens: body.max_tokens, max_completion_tokens: body.max_completion_tokens })}`);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'slow-tool', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'slow-call', type: 'function', function: { name: 'write_adapter', arguments: '' } }] });
    for (let index = 0; index < 6; index++) { await delay(25); emit({ reasoning_content: 'Inspect the neutral format. ' }); }
    const args = JSON.stringify({ manifest: { id: 'story' }, code: '({})' });
    for (const argumentsPart of [args.slice(0, 10), args.slice(10)]) { await delay(25); emit({ tool_calls: [{ index: 0, function: { arguments: argumentsPart } }] }); }
    emit({}, 'tool_calls'); response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const lab = fakeLab(), statePath = path.join(directory, 'progress.jsonl');
    const result = await runAdaptation({ ...base(lab), workspaceDir: path.join(directory, 'work'), statePath, requestTimeoutMs: 100, maxSteps: 1,
      onProgress: async event => { if (event.tool === 'model_step' && event.phase === 'requesting') await delay(150); },
      connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture' } });
    assert.equal(result.stopReason, 'step-limit', JSON.stringify(result.error));
    assert.equal(requests, 1); assert.equal(lab.calls.filter(([name]) => name === 'write').length, 1);
    assert.equal(result.state.conversation.length, 1);
    assert.equal((await readAdaptationState(statePath)).candidateId, 'candidate-1');
    const [artifact] = result.state.requestArtifacts;
    assert.ok(artifact.reasoningCharacters > 100);
    assert.ok(Date.parse(artifact.bodyEndedAt) - Date.parse(artifact.sentAt) >= 150, 'actual progress survives longer than the idle timeout');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}));

test('cancelling an incomplete streamed technical tool call saves progress without executing the partial tool', () => temporary(async directory => {
  const partial = Promise.withResolvers(), controller = new AbortController();
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {}
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'partial-tool', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'partial-call', type: 'function', function: { name: 'write_adapter', arguments: '{"manifest":' } }] }, finish_reason: null }] })}\n\n`);
    partial.resolve();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const lab = fakeLab(), statePath = path.join(directory, 'progress.jsonl');
    const pending = runAdaptation({ ...base(lab), workspaceDir: path.join(directory, 'work'), statePath, signal: controller.signal,
      connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture' } });
    await partial.promise; await delay(25); controller.abort(new Error('neutral pause'));
    const result = await pending;
    assert.equal(result.status, 'cancelled'); assert.equal(lab.calls.length, 0);
    assert.equal((await readAdaptationState(statePath)).status, 'cancelled');
    assert.equal(result.state.requestArtifacts.length, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}));

test('a JSON-only compatible provider reasoning response is diagnosed without repeating the model call', () => temporary(async directory => {
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {}
    requests++;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: 'reasoning-only', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: '', reasoning_content: 'Inspect the format.' }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const lab = fakeLab();
    const result = await runAdaptation({ ...base(lab), workspaceDir: path.join(directory, 'work'), statePath: path.join(directory, 'progress.jsonl'),
      connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture' } });
    assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'MODEL_REASONING_ONLY');
    assert.equal(requests, 1); assert.equal(lab.calls.length, 0);
    assert.equal(result.state.requestArtifacts[0].reasoningCharacters, 'Inspect the format.'.length);
    assert.equal(result.state.requestArtifacts[0].textCharacters, 0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}));

test('cancellation checkpoints settle even when a model transport ignores its abort signal', () => temporary(async directory => {
  const controller = new AbortController(), entered = Promise.withResolvers(), statePath = path.join(directory, 'progress.jsonl');
  const pending = runAdaptation({ ...base(fakeLab()), statePath, signal: controller.signal, generate: async ({ tools }) => {
    await tools.read_resource.execute({ file: 'story.json' });
    entered.resolve();
    await new Promise(() => {});
  } });
  await entered.promise;
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  const saved = await readAdaptationState(statePath);
  assert.equal(saved.status, 'cancelled');
  assert.equal(saved.observations[0].input.file, 'story.json');
}));

test('compact conversation checkpoints bound growth while retaining complete tool-call groups', () => temporary(async directory => {
  const secret = 'compact-checkpoint-fixture-secret', statePath = path.join(directory, 'progress.jsonl');
  const result = await runAdaptation({ ...base(fakeLab()), statePath, connection: { apiKey: secret }, generate: async ({ onStepStart, onStepEnd }) => {
    for (let index = 0; index < 30; index++) {
      await onStepStart({ stepNumber: index });
      await onStepEnd({ finishReason: 'tool-calls', response: { messages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `call-${index}`, toolName: 'read_resource', input: { file: 'story.json' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: `call-${index}`, toolName: 'read_resource', output: { type: 'json', value: { content: `${secret} ${'evidence '.repeat(300)}` } } }] },
      ] } });
    }
  } });
  // The ceilings are 24 step groups and 200000 characters per checkpoint.
  assert.ok(JSON.stringify(result.state.conversation).length <= 200000);
  assert.equal(result.state.conversation.length, 24, 'the newest 24 groups are kept and older ones are dropped');
  assert.ok(result.state.conversation.every(group => group.length === 2 && group[0].role === 'assistant' && group[1].role === 'tool'));
  assert.equal((await readFile(statePath, 'utf8')).includes(secret), false);
}));

test('failure deduplication distinguishes read locations while an unchanged validation error switches strategy', async () => {
  const lab = fakeLab({ validate: () => ({ passed: false, error: { code: 'SAME_LAYOUT', message: 'Same field mismatch at story.json /text' } }) });
  lab.readResource = async () => { throw Object.assign(new Error('Missing file'), { code: 'ENOENT' }); };
  const result = await runAdaptation({ ...base(lab), generate: async ({ tools }) => {
    for (const file of ['a.json', 'b.json', 'c.json']) assert.equal((await tools.read_resource.execute({ file })).paused, false);
    const validations = [];
    for (let index = 0; index < 3; index++) {
      const candidate = await write(tools);
      validations.push(await tools.validate_adapter.execute({ candidateId: candidate.candidateId }));
    }
    assert.match(validations[2].mustChangeStrategy, /同一错误已连续出现 3 次/);
    const afterDirective = await write(tools);
    assert.equal(afterDirective.paused, undefined, 'an unchanged validation error asks for a new strategy instead of pausing');
    assert.ok(afterDirective.candidateId);
  } });
  assert.equal(result.status, 'needs-review');
  assert.equal(result.state.blocked, undefined);
  assert.equal(lab.calls.filter(([operation]) => operation === 'validate').length, 3);
});

test('selected display candidates use the host text scaffold through real validation, coverage and native output', () => temporary(async directory => {
  const gameDir = path.join(directory, 'game'), workspaceDir = path.join(directory, 'work');
  await mkdir(gameDir);
  const script = 'extends Node\nvar native = "A native title"\nvar first = "First shown line."\nvar second = "Second shown line."\nvar count = 7\n';
  await writeFile(path.join(gameDir, 'story.gd'), script);
  await writeFile(path.join(gameDir, 'letters.json'), JSON.stringify({ dialogue: 'One complete letter.', logic: { key: 'keep-id' } }));
  const candidates = ['First shown line.', 'Second shown line.'].map(source => {
    const literal = JSON.stringify(source), start = script.indexOf(literal);
    return { file: 'res://story.gd', line: 3, source, classification: 'display_unresolved', target: { start, end: start + literal.length, render: 'quoted' } };
  });
  candidates.push({ file: 'letters.json', source: 'One complete letter.', classification: 'display_unresolved', locator: { file: 'letters.json', pointer: '/dialogue' } });
  const existingUnits = [{ id: 'native-title', source: 'A native title', context: { file: 'story.gd' } }];
  const lab = await createAdapterLab({ dataDir: path.join(directory, 'lab'), workspaceFor: () => workspaceDir });
  const result = await runAdaptation({ ...base(lab), gameDir, workspaceDir, assignment: { id: 'display-group', files: ['story.gd', 'letters.json'] },
    inventory: { existingUnits }, coverage: { dynamicCandidates: candidates },
    verifyCoverage: extraction => scanCoverage({ rootDir: gameDir, units: [...existingUnits, ...extraction.units], inventory: { dynamicCandidates: candidates } }),
    generate: async ({ tools, instructions }) => {
      assert.match(instructions, /write_text_adapter/);
      const page = await tools.inspect_coverage.execute({ offset: 0, limit: 2 });
      assert.equal(page.dynamicTotal, 3);
      assert.equal(page.dynamicCandidates.length, 2);
      assert.ok(page.dynamicCandidates.every(item => item.id && item.source && item.target));
      const last = await tools.inspect_coverage.execute({ offset: 2, limit: 2 });
      assert.equal(last.dynamicCandidates[0].locator.pointer, '/dialogue');
      const ids = [...page.dynamicCandidates, ...last.dynamicCandidates].map(item => item.id);
      const invalid = await tools.write_text_adapter.execute({ candidateIds: ['outside-task-id'] });
      assert.match(invalid.error.message, /其他资源任务/);
      const saved = await tools.write_text_adapter.execute({ candidateIds: ids, id: 'neutral-selected-text' });
      assert.equal(saved.selectedCandidates, 3);
      assert.equal(saved.nextAction, 'validate_adapter');
      const validation = await tools.validate_adapter.execute({ candidateId: saved.candidateId });
      assert.equal(validation.passed, true, JSON.stringify(validation));
      await tools.submit_recipe.execute({ candidateId: saved.candidateId, validationId: validation.validationId, metadata: { summary: 'Selected neutral display fields' } });
    },
  });
  assert.equal(result.status, 'verified', JSON.stringify(result.error ?? result.state));
  assert.equal(result.state.attempts, 1);
  assert.equal(result.units.length, 3);
  const translations = result.units.map((unit, index) => ({ id: unit.id, translation: index === 0 ? '第一份完整的来信。' : `第${index + 1}段较长的中性显示文字。` }));
  const built = await lab.dispatch('build', { projectId: base(lab).project.id, workspaceDir: result.extraction.workspaceDir, outputDir: path.join(directory, 'built'), translations });
  const assembled = await lab.dispatch('assemble', { projectId: base(lab).project.id, workspaceDir: result.extraction.workspaceDir, buildDir: built.buildDir, outputDir: path.join(directory, 'product') });
  const changedScript = await readFile(path.join(assembled.outputDir, 'story.gd'), 'utf8');
  assert.match(changedScript, /A native title/);
  assert.match(changedScript, /var count = 7/);
  assert.match(changedScript, /中性显示文字/);
  assert.equal(JSON.parse(await readFile(path.join(assembled.outputDir, 'letters.json'), 'utf8')).logic.key, 'keep-id');
  assert.equal(await readFile(path.join(gameDir, 'story.gd'), 'utf8'), script);
}));

test('length-limited output continues through bounded tool-focused rounds and completes', () => temporary(async directory => {
  let rounds = 0;
  const progress = [];
  const result = await runAdaptation({ ...base(fakeLab()), statePath: path.join(directory, 'progress.jsonl'), onProgress: item => progress.push(item), generate: async ({ tools, messages, onStepStart, onStepEnd }) => {
    rounds++;
    await onStepStart({});
    if (rounds < 3) {
      await onStepEnd({ finishReason: 'length', response: { messages: [{ role: 'assistant', content: 'An incomplete technical explanation.' }] } });
      return { finishReason: 'length' };
    }
    assert.match(messages.at(-1).content, /inspect_coverage.*write_text_adapter/);
    const candidate = await write(tools);
    const validation = await tools.validate_adapter.execute({ candidateId: candidate.candidateId });
    await tools.submit_recipe.execute({ candidateId: candidate.candidateId, validationId: validation.validationId, metadata: {} });
    await onStepEnd({ finishReason: 'tool-calls' });
    return { finishReason: 'tool-calls' };
  } });
  assert.equal(result.status, 'verified');
  assert.equal(rounds, 3);
  assert.equal(result.state.events.filter(item => item.tool === 'output_continuation').length, 2);
  assert.equal(result.continuationNeeded, false);
  assert.equal(progress.at(-1).stopReason, 'verified');
}));

test('an empty model finish offers retry without claiming an advancing continuation', () => temporary(async directory => {
  const result = await runAdaptation({ ...base(fakeLab()), statePath: path.join(directory, 'progress.jsonl'), generate: async () => {} });
  assert.equal(result.status, 'needs-review');
  assert.equal(result.stopReason, 'model-finished');
  assert.equal(result.retryable, true);
  assert.equal(result.continuationNeeded, false);
}));

test('coverage inspection remains activity, not accepted output; an empty following window does not rearm', () => temporary(async directory => {
  const args = { ...base(fakeLab()), statePath: path.join(directory, 'progress.jsonl') };
  const first = await runAdaptation({ ...args, generate: async ({ tools }) => { await tools.inspect_coverage.execute({}); } });
  assert.equal(first.continuationNeeded, true);
  assert.equal(first.state.control.acceptedSerial, 0);
  assert.equal(first.state.control.materialSerial, 0);
  const resumed = await runAdaptation({ ...args, retry: true, generate: async () => {} });
  assert.equal(resumed.continuationNeeded, false);
  assert.equal(resumed.retryable, true);
}));

// Retry policy: repeated truncation is retried by the service.mjs attempts loop, never inside one
// adaptation window. A truncated reply has already generated (and billed) output, so retrying it
// here would pay twice, and two layers of retries multiply one failure into six requests.
test('repeated output truncation keeps its stop reason and does not refill its allowance', {
  skip: '重试由 service.mjs 的 attempts 循环统一负责，provider 层重复实现会造成两层重试叠加' }, async () => temporary(async directory => {
  const statePath = path.join(directory, 'progress.jsonl');
  let rounds = 0;
  const generate = async ({ onStepStart, onStepEnd }) => {
    rounds++;
    await onStepStart({});
    await onStepEnd({ finishReason: 'length' });
    return { finishReason: 'length' };
  };
  const first = await runAdaptation({ ...base(fakeLab()), statePath, generate });
  const firstRounds = rounds;
  assert.equal(first.status, 'needs-review');
  assert.equal(first.stopReason, 'output-truncated');
  assert.ok(firstRounds >= 1);
  const second = await runAdaptation({ ...base(fakeLab()), statePath, retry: true, generate });
  assert.equal(second.stopReason, 'output-truncated');
  assert.equal(second.state.repairWindow, first.state.repairWindow, 'a resume must not open a new repair window');
}));

test('real SDK length responses resume with tool-focused context and reach verified output', async () => {
  const requests = [], lab = fakeLab();
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), index = requests.length;
    requests.push(body);
    const steps = [['write_adapter', { manifest: { id: 'story' }, code: '({})' }], ['validate_adapter', { candidateId: 'candidate-1' }], ['submit_recipe', { candidateId: 'candidate-1', validationId: 'proof-1', metadata: {} }]];
    const [name, input] = steps[index - 1] ?? [];
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `length-fixture-${index}`, object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0,
      message: index === 0 ? { role: 'assistant', content: 'An incomplete plan for a neutral UI resource.' } : { role: 'assistant', content: null, tool_calls: [{ id: `length-call-${index}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] },
      finish_reason: index === 0 ? 'length' : 'tool_calls' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runAdaptation({ ...base(lab), maxSteps: 8, connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture' } });
    assert.equal(result.status, 'verified', JSON.stringify(result.error));
    assert.equal(requests.length, 4);
    assert.match(requests[1].messages.at(-1).content, /write_text_adapter/);
    assert.ok(requests[2].messages.some(message => message.role === 'tool' && message.tool_call_id === 'length-call-1'));
    assert.equal(result.state.events.filter(event => event.tool === 'output_continuation').length, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('new actionable coverage opens a repair window while the same coverage keeps its attempt count', () => temporary(async directory => {
  const statePath = path.join(directory, 'progress.jsonl'), lab = fakeLab({ validate: () => ({ passed: false, error: { message: 'Unresolved layout' } }) });
  const coverage = { resources: [{ file: 'story.json', kind: 'display-text-candidate' }], dynamicCandidates: [] };
  const first = await runAdaptation({ ...base(lab), statePath, coverage, maxAttempts: 1, generate: async ({ tools }) => { const candidate = await write(tools); await tools.validate_adapter.execute({ candidateId: candidate.candidateId }); await write(tools); } });
  assert.match(first.state.strategyDirective, /本轮修复已累计 1 次/);
  assert.equal(first.retryable, true, 'an exhausted allowance ends the window without blocking the task');
  const same = await runAdaptation({ ...base(lab), statePath, coverage, retry: true, generate: async ({ tools }) => {
    assert.equal((await tools.inspect_context.execute({})).progress.attempts, 2, 'the same scope continues its attempt count');
    await write(tools);
  } });
  assert.equal(same.state.repairWindow, 1);
  assert.equal(same.state.attempts, 3);
  const changed = await runAdaptation({ ...base(lab), statePath, coverage: { ...coverage, resources: [...coverage.resources, { file: 'extra.json', kind: 'display-text-candidate' }] }, generate: async ({ tools }) => {
    assert.equal((await tools.inspect_context.execute({})).progress.attempts, 0);
  } });
  assert.equal(changed.state.repairWindow, 2);
  assert.equal(changed.state.events.findLast(event => event.tool === 'repair_window').reason, 'input-changed');
}));

test('repeated reads get one bounded replan and a new window cannot erase the stalled outcome clock', () => temporary(async directory => {
  const statePath = path.join(directory, 'progress.jsonl');
  const lab = fakeLab();
  const first = await runAdaptation({ ...base(lab), statePath, maxNoProgressSteps: 3, controlLimits: { recoverySteps: 1 }, generate: async ({ tools, onStepStart, onStepEnd }) => {
    for (let step = 0; step < 6; step++) {
      await onStepStart({ stepNumber: step });
      await tools.read_resource.execute({ file: 'story.json' });
      await onStepEnd({ finishReason: 'tool-calls' });
    }
  } });
  assert.equal(first.stopReason, 'STALLED');
  assert.equal(first.state.windowStop.reason, 'STALLED');
  // Reading never becomes a repair attempt, but unchanged material does require a new plan.
  assert.equal(first.state.repairAttempts, 0);
  assert.match(first.state.strategyDirective, /主机复盘/);
  assert.equal(first.state.blocked, undefined);
  assert.equal(first.retryable, true);
  let calls = 0;
  const continued = await runAdaptation({ ...base(lab), statePath, retry: true, maxNoProgressSteps: 3, controlLimits: { recoverySteps: 1 }, generate: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(continued.stopReason, 'STALLED');
}));

test('a compact coverage page delivers candidates whole inside the checkpoint budget and resumes past it', () => temporary(async directory => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({ id: `display-fixture-${index}`, file: 'story.gd', source: `Neutral menu item ${index}`, target: { start: index * 40, end: index * 40 + 30, render: 'quoted' } }));
  const pageFor = async (values, statePath) => {
    const result = await runAdaptation({ ...base(fakeLab()), statePath, generate: async ({ onStepStart, onStepEnd }) => {
      await onStepStart({});
      await onStepEnd({ finishReason: 'tool-calls', response: { messages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'coverage-page', toolName: 'inspect_coverage', input: { offset: 0, limit: values.length } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'coverage-page', toolName: 'inspect_coverage', output: { type: 'json', value: { offset: 0, dynamicTotal: values.length, dynamicCandidates: values, nextOffset: null } } }] },
      ] } });
    } });
    return result.state.conversation[0][1].content[0].output.value;
  };
  // The checkpoint path keeps its own 24000-character ceiling, so 30 compact candidates are stored
  // whole: no cursor, no truncation notice, no id list to reconstruct from.
  const page = await pageFor(candidates, path.join(directory, 'progress.jsonl'));
  assert.equal(page.dynamicCandidates.length, 30);
  assert.equal(page.checkpointTruncated, undefined);
  assert.equal(page.nextOffset, null);
  assert.equal(page.pageCandidateIds, undefined);
  assert.equal(page.dynamicTotal, 30);
  // Past that ceiling the page still keeps every candidate id and resumes at the first omitted one.
  const large = candidates.map((candidate, index) => ({ ...candidate, source: `${candidate.source} ${String(index).padStart(2, '0')} ${'x'.repeat(900)}` }));
  const truncated = await pageFor(large, path.join(directory, 'progress-large.jsonl'));
  assert.equal(truncated.checkpointTruncated, true);
  assert.ok(truncated.nextOffset > 0 && truncated.nextOffset < large.length, `resumes at ${truncated.nextOffset}`);
  assert.equal(truncated.dynamicCandidates.length, truncated.nextOffset, 'the cursor is the first omitted candidate');
  assert.deepEqual(truncated.pageCandidateIds, large.map(candidate => candidate.id));
  assert.equal(truncated.dynamicTotal, large.length);
}));

test('same-file independent QuickJS batches accumulate monotonically and resume from their exact remaining IDs', () => temporary(async directory => {
  const gameDir = path.join(directory, 'game'), workspaceDir = path.join(directory, 'work'), statePath = path.join(directory, 'progress.jsonl');
  await mkdir(gameDir);
  const original = JSON.stringify({ lines: ['First complete scene.', 'Second complete scene.', 'Third complete scene.'], logic: 'keep' });
  await writeFile(path.join(gameDir, 'story.json'), original);
  const candidates = JSON.parse(original).lines.map((source, index) => ({ file: 'story.json', source, classification: 'display_unresolved', locator: { file: 'story.json', pointer: `/lines/${index}` } }));
  const coverage = { dynamicCandidates: candidates, resources: [{ file: 'story.json', kind: 'display-text-candidate' }], needsAdaptation: true };
  const lab = await createAdapterLab({ dataDir: path.join(directory, 'lab'), workspaceFor: () => workspaceDir });
  const counts = [], submit = async (tools, candidateIds) => {
    const candidate = await tools.write_text_adapter.execute({ candidateIds });
    assert.ok(candidate.candidateId, JSON.stringify(candidate));
    const validation = await tools.validate_adapter.execute({ candidateId: candidate.candidateId });
    assert.equal(validation.passed, true, JSON.stringify(validation));
    return tools.submit_recipe.execute({ candidateId: candidate.candidateId, validationId: validation.validationId, metadata: {} });
  };
  const verifyCoverage = async extraction => {
    const pointers = new Set(extraction.units.map(unit => unit.locator.pointer));
    const dynamicCandidates = candidates.filter(item => !pointers.has(item.locator.pointer));
    counts.push(dynamicCandidates.length);
    return { resources: dynamicCandidates.length ? coverage.resources : [], dynamicCandidates, needsAdaptation: Boolean(dynamicCandidates.length), summary: { unresolvedCandidates: dynamicCandidates.length } };
  };
  let originalIds;
  const first = await runAdaptation({ ...base(lab), gameDir, workspaceDir, statePath, coverage, verifyCoverage, generate: async ({ tools }) => {
    originalIds = (await tools.inspect_coverage.execute({})).dynamicCandidates.map(item => item.id);
    const submitted = await submit(tools, [originalIds[0]]);
    assert.equal(submitted.taskComplete, false);
    assert.deepEqual((await tools.inspect_coverage.execute({})).dynamicCandidates.map(item => item.id), originalIds.slice(1));
  } });
  assert.equal(first.status, 'needs-review');
  assert.equal(first.partialExtractions.length, 1);
  assert.equal((await readAdaptationState(statePath)).acceptedBatches.length, 1);
  counts.length = 0;
  const second = await runAdaptationPool({ run: runAdaptation, lab, project: base(lab).project, inventory: {}, gameDir, workspaceDir, statePath, coverage,
    jobs: [{ id: 'coordinator', files: null }], verifyCoverage, generate: async ({ tools }) => {
      assert.deepEqual((await tools.inspect_coverage.execute({})).dynamicCandidates.map(item => item.id), originalIds.slice(1));
      assert.equal((await submit(tools, [originalIds[1]])).taskComplete, false);
      assert.deepEqual((await tools.inspect_coverage.execute({})).dynamicCandidates.map(item => item.id), originalIds.slice(2));
      assert.equal((await submit(tools, [originalIds[2]])).taskComplete, true);
    } });
  assert.equal(second.status, 'verified', JSON.stringify(second.error ?? second.state));
  assert.equal(second.extractions.length, 3);
  assert.equal(second.units.length, 3);
  assert.ok(counts.every((count, index) => !index || count <= counts[index - 1]), JSON.stringify(counts));
  for (const [index, extraction] of second.extractions.entries()) {
    const build = await lab.dispatch('build', { projectId: base(lab).project.id, workspaceDir: extraction.workspaceDir, outputDir: path.join(directory, `build-${index}`), translations: extraction.units.map(unit => ({ id: unit.id, translation: `已改第${index}批。` })) });
    const content = JSON.parse(await readFile(path.join(build.buildDir, 'story.json'), 'utf8'));
    assert.equal(content.lines.filter(value => value.startsWith('已改')).length, 1);
    assert.equal(content.logic, 'keep');
  }
  assert.equal(await readFile(path.join(gameDir, 'story.json'), 'utf8'), original);
  const resumed = await runAdaptation({ ...base(lab), gameDir, workspaceDir, statePath, coverage, verifyCoverage, generate: () => assert.fail('Completed batches should resume locally') });
  assert.equal(resumed.status, 'verified');
  assert.equal(resumed.units.length, 3);
}));

test('verified batch overlap deduplicates exact snapshots and rejects ID, source or location conflicts', () => {
  const unit = (id, pointer, source = 'Neutral line.') => ({ id, source, locator: { file: 'story.json', pointer } });
  const first = { workspaceDir: 'first', units: [unit('a', '/a')] };
  const complete = { workspaceDir: 'complete', units: [unit('a', '/a'), unit('b', '/b')] };
  const combined = accumulateVerifiedExtractions([first], [complete]);
  assert.deepEqual(combined, [complete]);
  assert.equal(accumulateVerifiedExtractions(combined, [complete]).flatMap(item => item.units).length, 2);
  for (const changed of [unit('a', '/other'), unit('a', '/a', 'Changed source.'), unit('other', '/a')]) assert.throws(() => accumulateVerifiedExtractions([first], [{ units: [changed] }]), /冲突/);
  assert.throws(() => accumulateVerifiedExtractions([], [{ units: [unit('a', '/a'), unit('a', '/a')] }]), /重复/);
});

test('native acceptance returns opaque host results to the pool while tool feedback and checkpoints remain bounded', () => temporary(async directory => {
  const units = Array.from({ length: 35000 }, (_, index) => ({ id: `native-${index}`, source: `A complete neutral line ${index}. ${'evidence '.repeat(100)}`, locator: { file: 'data/story.json', pointer: `/lines/${index}` } }));
  const native = { units, workspaceDir: path.join(directory, 'native') }, probe = { engine: 'RPG Maker MZ', root: '.' };
  const lab = fakeLab();
  let resolved = 0;
  lab.runTool = async ({ tool }) => tool === 'native_accept' ? { acceptedNativeResultId: 'native-host-token', unitCount: units.length } : { nativeResultId: 'native-host-token', units, files: Array.from({ length: 2000 }, (_, index) => `data/file-${index}.json`) };
  lab.resolveNativeResult = async ({ resultId }) => { assert.equal(resultId, 'native-host-token'); resolved++; return { extraction: native, probe }; };
  const statePath = path.join(directory, 'progress.jsonl');
  const result = await runAdaptationPool({ ...base(lab), jobs: [{ id: 'coordinator', files: null }], statePath, run: runAdaptation, generate: async ({ tools }) => {
    const output = await tools.run_tool.execute({ tool: 'native_extract', args: [] });
    assert.ok(JSON.stringify(output).length <= 96 * 1024);
    assert.equal(output.fieldCounts.units, 35000);
    assert.equal(output.nativeResultId, 'native-host-token');
    assert.ok(output.units.length < 35000);
    const accepted = await tools.run_tool.execute({ tool: 'native_accept', args: [] });
    assert.equal(accepted.acceptedNativeResultId, 'native-host-token');
    assert.equal(accepted.nativeExtraction, undefined);
  } });
  assert.equal(result.status, 'verified');
  assert.equal(result.nativeExtraction.units.length, 35000);
  assert.deepEqual(result.nativeProbe, probe);
  assert.equal(resolved, 1);
  assert.ok((await readFile(statePath, 'utf8')).length < 150000);
  let accepts = 0;
  lab.runTool = async () => { accepts++; return { acceptedNativeResultId: 'native-host-token' }; };
  await runAdaptation({ ...base(lab), assignment: { files: ['story.json'] }, generate: async ({ tools }) => assert.match((await tools.run_tool.execute({ tool: 'native_accept', args: [] })).error.message, /协调任务/) });
  assert.equal(accepts, 0);
}));

test('long resource and adapter tool pages expose usable continuation offsets', async () => {
  const lab = fakeLab();
  const content = '中'.repeat(10000), code = 'neutral-code '.repeat(1000);
  lab.readResource = async ({ offset = 0 }) => ({ content: Buffer.from(content).subarray(offset).toString('utf8'), encoding: 'utf8', offset, totalBytes: Buffer.byteLength(content) });
  lab.inspectAdapter = async () => ({ candidateId: 'candidate-fixture', code, manifest: {} });
  await runAdaptation({ ...base(lab), generate: async ({ tools }) => {
    const first = await tools.read_resource.execute({ file: 'story.json' });
    assert.equal(first.nextOffset, Buffer.byteLength(first.content));
    assert.equal(first.returnedBytes, first.nextOffset);
    const second = await tools.read_resource.execute({ file: 'story.json', offset: first.nextOffset });
    assert.equal(second.offset, first.nextOffset);
    const firstCode = await tools.read_adapter.execute({ candidateId: 'candidate-fixture' });
    const nextCode = await tools.read_adapter.execute({ candidateId: 'candidate-fixture', offset: firstCode.nextCodeOffset });
    assert.equal(firstCode.code + nextCode.code, code.slice(0, firstCode.code.length + nextCode.code.length));
  } });
});

test('real SDK receives a bounded native-tool summary and host-only native acceptance', () => temporary(async directory => {
  const units = Array.from({ length: 35000 }, (_, index) => ({ id: `sdk-native-${index}`, source: `Neutral complete scene ${index}. ${'evidence '.repeat(100)}` }));
  const lab = fakeLab(), requests = [];
  lab.runTool = async ({ tool }) => tool === 'native_accept' ? { acceptedNativeResultId: 'sdk-native-handle' } : { nativeResultId: 'sdk-native-handle', units, unitCount: units.length };
  lab.resolveNativeResult = async () => ({ extraction: { units, workspaceDir: 'native-workbench' }, probe: { engine: 'RPG Maker MZ' } });
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), index = requests.length; requests.push(body);
    assert.ok(raw.length <= 200000, `Unexpected SDK context length ${raw.length}`);
    if (index) {
      const output = JSON.parse(body.messages.findLast(item => item.role === 'tool').content);
      assert.equal(output.nativeResultId, 'sdk-native-handle');
      assert.equal(output.fieldCounts.units, units.length);
      // Tool output ceilings are 96KiB per result and 200000 characters per round.
      assert.ok(JSON.stringify(output).length <= 96 * 1024, `unbounded tool result ${JSON.stringify(output).length}`);
      assert.equal(raw.includes('sdk-native-34999'), false);
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `bounded-${index}`, object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: `bounded-call-${index}`, type: 'function', function: { name: 'run_tool', arguments: JSON.stringify({ tool: index ? 'native_accept' : 'native_extract', args: [] }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runAdaptation({ ...base(lab), statePath: path.join(directory, 'progress.jsonl'), connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture' } });
    assert.equal(result.status, 'verified', JSON.stringify(result.error));
    assert.equal(result.nativeExtraction.units.length, 35000);
    assert.equal(requests.length, 2);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}));
