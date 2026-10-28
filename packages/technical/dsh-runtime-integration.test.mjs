import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, cp, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';
import { createAdaptationBudget } from '../core/adaptation-budget.mjs';
import { createStore } from '../core/store.mjs';
import { createAcceptanceLedger, readAcceptedBatch } from '../core/accepted-batches.mjs';
import { readAdaptationState } from './adaptation.mjs';
import { runDshAdaptation } from './dsh-runner.mjs';

const pythonPath = path.resolve(process.env.PINHAO_TEST_PYTHON ?? 'local/runtime/python/python.exe');
const model = 'pinhao-runtime-local-fixture';
const selectedRuntime = process.env.PINHAO_DSH_TEST_RUNTIME;
const runtimeCheck = { skip: !selectedRuntime && !existsSync(new URL('../../local/upstream/deepseek-harness/packages/sdk/client/src/index.ts', import.meta.url)) };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function completion(message, index, body) {
  const { _finishReason, ...content } = message;
  const promptTokens = Math.ceil(Buffer.byteLength(JSON.stringify(body), 'utf8') / 3);
  const completionTokens = Math.ceil(Buffer.byteLength(JSON.stringify(content), 'utf8') / 3);
  return { id: `fixture-${index}`, object: 'chat.completion', created: 1, model,
    choices: [{ index: 0, message: { role: 'assistant', ...content }, finish_reason: _finishReason ?? (message.tool_calls ? 'tool_calls' : 'stop') }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, cost: 0 } };
}
const tool = (name, args, id) => ({ content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function receiptFrom(messages) {
  let found;
  const visit = value => {
    if (typeof value === 'string') { try { visit(JSON.parse(value)); } catch {} return; }
    if (!value || typeof value !== 'object') return;
    if (typeof value.receiptId === 'string' && typeof value.evidenceId === 'string') found ??= value.receiptId;
    for (const item of Object.values(value)) visit(item);
  };
  for (const message of messages.filter(row => row.role === 'tool')) visit(message.content);
  return found;
}
async function provider(t, action) {
  const requests = [];
  const server = createServer(async (input, output) => {
    try {
      const chunks = []; for await (const part of input) chunks.push(part);
      const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
      const message = await action(body, requests.length);
      if (message._httpError) {
        output.writeHead(message._httpError.status, { 'content-type': 'application/json' });
        output.end(JSON.stringify(message._httpError.body));
        return;
      }
      if (message._stream) {
        output.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const delta of message._stream) output.write(`data: ${JSON.stringify({ id: `stream-${requests.length}`, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        output.write(`data: ${JSON.stringify({ id: `stream-${requests.length}`, model, choices: [{ index: 0, delta: {}, finish_reason: message._streamFinishReason ?? 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000, cost: 0 } })}\n\n`);
        output.write('data: [DONE]\n\n');
        if (message._afterDoneMs) await delay(message._afterDoneMs);
        output.end();
        return;
      }
      output.writeHead(200, { 'content-type': 'application/json' });
      output.end(JSON.stringify(completion(message, requests.length, body)));
    } catch (error) { output.writeHead(500, { 'content-type': 'application/json' }); output.end(JSON.stringify({ error: { message: String(error.message) } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}
async function fixture(t, baseUrl, { maxHttp = 2, name = 'neutral', workspaceSegments = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-dsh-runtime-'));
  const gameDir = path.join(root, 'game'), workspaceDir = path.join(root, ...workspaceSegments, 'work');
  await mkdir(gameDir); await mkdir(workspaceDir, { recursive: true });
  await writeFile(path.join(gameDir, 'story.json'), '{"text":"A complete neutral story."}');
  let project = { id: `fixture-${name}`, name, engine: 'Godot', sourceFingerprint: `source-${name}`, sourceDir: gameDir, workspaceDir: path.join(root, 'project') };
  const budget = createAdaptationBudget({ readProject: () => project, patchProject: (_id, patch) => { project = { ...project, ...patch }; }, transaction: (_id, action) => action() });
  const owner = budget.forRequest(project.id, 'request', { limits: { maxHttpAttempts: maxHttp, maxWindows: 1 }, historyCoverage: 'complete' });
  owner.openWindow({ windowId: 'window' });
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab'), execution: { pythonPath, authorize: async ({ projectId }) => projectId === project.id } });
  t.after(async () => {
    await lab.closeExecution();
    if (process.env.PINHAO_DSH_TEST_ARTIFACT_DIR) {
      const output = path.resolve(process.env.PINHAO_DSH_TEST_ARTIFACT_DIR, path.basename(root));
      await mkdir(path.dirname(output), { recursive: true });
      await cp(root, output, { recursive: true });
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const progress = [];
  return { root, gameDir, workspaceDir, project, lab, owner, progress, options: {
    connection: { baseUrl, model, apiKey: 'neutral-local-only', contextWindow: 1048576, maxOutputTokens: 65536 }, project, gameDir, workspaceDir,
    statePath: path.join(root, 'state.jsonl'), inventory: {}, coverage: { needsAdaptation: true, summary: {} }, lab,
    requestContext: { owner, projectId: project.id, adaptationRequestId: 'request', windowId: 'window', jobId: 'coordinator', purpose: 'adaptation' },
    onProgress: value => { progress.push(value); }, dsh: { ...(selectedRuntime ? { sourceRoot: selectedRuntime } : {}), initialWaitMs: 1000, initializeTimeoutMs: 30000 },
  } };
}

test('T01/T07: actual pinned runtime and tool bridge return quick script output without fake verification', { ...runtimeCheck, timeout: 120000 }, async t => {
  const local = await provider(t, async (_body, index) => index === 1
    ? tool('run_workspace', { program: 'python', args: ['-c', "print('quick-committed-output')"] }, 'quick-script')
    : { content: 'The job is complete and verified.' });
  const f = await fixture(t, local.baseUrl);
  const result = await runDshAdaptation(f.options);
  assert.equal(local.requests.length, 2, JSON.stringify(result.error));
  const output = local.requests[1].messages.find(message => message.role === 'tool');
  assert.ok(output, JSON.stringify(local.requests[1].messages));
  assert.match(JSON.stringify(output), /quick-committed-output/);
  assert.match(JSON.stringify(output), /completed/);
  assert.equal(local.requests[0].tools.filter(row => row.function.name === 'run_workspace').length, 1);
  assert.equal(result.status, 'needs-review');
  assert.equal(result.stopReason, 'ADAPTATION_BUDGET_EXHAUSTED');
  assert.equal(f.owner.snapshot().httpSentKnown, 2);
  assert.ok(f.progress.some(value => value.phase === 'runtime-ready'));
  const state = await readAdaptationState(f.options.statePath);
  assert.equal(state.backend.name, 'dsh');
  assert.equal(state.backend.backendVersion, '22ddee3792402c3e70ec5f86a63c3e3e895a2f60');
  await assert.rejects(readFile(path.join(state.backend.runtimeHome, 'runner.lock')), { code: 'ENOENT' });
  const frozen = await readFile(f.options.statePath);
  await assert.rejects(runDshAdaptation({ ...f.options, project: { ...f.project, id: 'foreign-project' },
    requestContext: { ...f.options.requestContext, projectId: 'foreign-project' } }), { code: 'DSH_SESSION_IDENTITY' });
  assert.deepEqual(await readFile(f.options.statePath), frozen, 'foreign caller cannot rewrite the owner checkpoint');
});

test('T01: SDK completes SSE tool calls before upstream EOF without being mistaken for user cancellation', { ...runtimeCheck, timeout: 120000 }, async t => {
  const local = await provider(t, async (_body, index) => index === 1 ? {
    _stream: [{ role: 'assistant', tool_calls: [
      { index: 0, id: 'inspect-context-stream', type: 'function', function: { name: 'inspect_context', arguments: '{}' } },
      { index: 1, id: 'inspect-coverage-stream', type: 'function', function: { name: 'inspect_coverage', arguments: '{}' } },
    ] }], _streamFinishReason: 'tool_calls', _afterDoneMs: 750,
  } : { content: 'The saved context and coverage are available; no adapter has been verified.' });
  const f = await fixture(t, local.baseUrl, { name: 'sse-tool-terminal-before-eof' });
  const result = await runDshAdaptation(f.options);
  assert.equal(local.requests.length, 2, JSON.stringify({ stopReason: result.stopReason, error: result.error }));
  const calls = local.requests[1].messages.filter(message => message.role === 'tool');
  assert.ok(calls.some(message => message.tool_call_id === 'inspect-context-stream'), JSON.stringify(calls));
  assert.ok(calls.some(message => message.tool_call_id === 'inspect-coverage-stream'), JSON.stringify(calls));
  assert.equal(result.stopReason, 'ADAPTATION_BUDGET_EXHAUSTED');
  assert.equal(f.owner.snapshot().httpSentKnown, 2);
  assert.notEqual(result.status, 'verified');
});

test('L2: actual SDK consumes passed validation and submits its next call into an accepted SQLite publication', { ...runtimeCheck, timeout: 120000 }, async t => {
  const manifest = { schemaVersion: 1, id: 'neutral-caption', version: '1.0.0', engine: 'Godot',
    license: 'GPL-3.0-or-later', scope: { files: ['story.json'] } };
  const code = `({detect(){return true},extract(host){return {units:[{id:'caption',source:JSON.parse(host.readText('story.json')).text,locator:{file:'story.json',pointer:'/text'}}]}},validate(){return true},roundtrip(host){host.writeBytes('story.json',host.readBytes('story.json'));return {}},build(host,input){const value=JSON.parse(host.readText('story.json'));value.text=input.translations.caption??value.text;host.writeText('story.json',JSON.stringify(value));return {}},assemble(){return {}}})`;
  let written, validated, accepted, publications = 0;
  const resultFor = (body, id) => {
    const message = body.messages.find(row => row.role === 'tool' && row.tool_call_id === id);
    assert.ok(message, `the next actual model request must contain tool result ${id}`);
    return JSON.parse(message.content);
  };
  const local = await provider(t, async (body, index) => {
    if (index === 1) return tool('write_adapter', { manifest, code }, 'write-neutral-caption');
    if (index === 2) {
      written = resultFor(body, 'write-neutral-caption');
      assert.match(written.candidateId, /^candidate-/);
      return tool('validate_adapter', { candidateId: written.candidateId }, 'validate-neutral-caption');
    }
    if (index === 3) {
      validated = resultFor(body, 'validate-neutral-caption');
      assert.equal(validated.passed, true, JSON.stringify(validated));
      for (const check of ['stableIds', 'roundtrip', 'sample', 'structure']) assert.equal(validated.checks[check], 'passed');
      assert.match(validated.validationId, /^validation-/);
      assert.deepEqual(validated.nextCall, { tool: 'submit_recipe', input: {
        candidateId: written.candidateId, validationId: validated.validationId, metadata: {},
      } });
      return tool(validated.nextCall.tool, validated.nextCall.input, 'submit-validated-caption');
    }
    return { content: 'No additional changes are proposed.' };
  });
  const f = await fixture(t, local.baseUrl, { maxHttp: 4, name: 'sdk-acceptance-closure' });
  const before = await readFile(path.join(f.gameDir, 'story.json'));
  const store = createStore(path.join(f.root, 'database'));
  const ledger = createAcceptanceLedger({ store: { ...store, transaction: (_id, action) => store.transaction(action) },
    projectId: f.project.id, adaptationRequestId: 'request' });
  try {
    const result = await runDshAdaptation({ ...f.options, onAcceptedBatch: async record => {
      assert.equal(record.payload.candidateId, written.candidateId);
      assert.equal(record.payload.validationId, validated.validationId);
      const extraction = await readAcceptedBatch({ directory: path.dirname(record.receiptFile), record });
      assert.equal(extraction.units.length, 1);
      assert.equal(extraction.units[0].source, 'A complete neutral story.');
      ledger.enqueue(record);
      ledger.commit(record.id, () => {
        publications++;
        extraction.units.forEach((unit, position) => store.putUnit(f.project.id, unit, position));
        return { addedUnits: extraction.units.length, generation: publications };
      });
      accepted = { record, extraction };
    } });
    assert.ok(validated && accepted, JSON.stringify({ status: result.status, error: result.error }));
    assert.ok(local.requests.length >= 3 && local.requests.length <= 4, 'allow a legitimate final SDK request, but not a repeated purchase of this three-call closure');
    assert.equal(f.owner.snapshot().httpSentKnown, local.requests.length);
    assert.equal(publications, 1);
    assert.equal(store.units(f.project.id).length, 1);
    assert.equal(store.units(f.project.id)[0].id, accepted.extraction.units[0].id);
    assert.equal(store.units(f.project.id)[0].source, accepted.extraction.units[0].source);
    assert.deepEqual(ledger.summary(), { accepted: 1, integrated: 1, pendingIntegration: 0, stale: 0 });
    assert.equal(result.status, 'verified', JSON.stringify(result.error));
    assert.equal(result.recipe.recipeId, accepted.record.payload.recipeId);
    assert.equal(result.units.length, 1);
    assert.deepEqual(await readFile(path.join(f.gameDir, 'story.json')), before);
  } finally { store.close(); }
});

test('T16: actual pinned SDK can execute Python in a long Chinese project job directory', { ...runtimeCheck, timeout: 120000 }, async t => {
  const code = "from pathlib import Path\np=Path('long-path-output.txt')\np.write_text('long-workspace-python-ok', encoding='utf-8')\nprint('long-workspace-python-ok',flush=True)";
  const local = await provider(t, async (_body, index) => index === 1
    ? tool('run_workspace', { program: 'python', args: ['-c', code] }, 'long-path-script')
    : { content: 'The Python result is available; no adapter is verified.' });
  const f = await fixture(t, local.baseUrl, { name: 'long-path', workspaceSegments: [
    '\u4e2d\u6587\u6e38\u620f\u6d4b\u8bd5\u5de5\u7a0b-'.repeat(8), 'requests', 'request-0123456789abcdef'.repeat(3),
    'jobs', 'resource-CommonEvents-0123456789abcdef'.repeat(3),
  ] });
  assert.ok(f.workspaceDir.length > 260, `exercise actual long directory: ${f.workspaceDir.length}`);
  const result = await runDshAdaptation(f.options);
  assert.equal(local.requests.length, 2, JSON.stringify(result.error));
  assert.match(JSON.stringify(local.requests[1].messages), /long-workspace-python-ok/);
  assert.equal(await readFile(path.join(f.workspaceDir, 'long-path-output.txt'), 'utf8'), 'long-workspace-python-ok');
  assert.notEqual(result.status, 'verified');
});

test('T15: hundreds of real streamed deltas retain raw evidence without duplicating payloads in host progress', { ...runtimeCheck, timeout: 120000 }, async t => {
  const deltas = [{ role: 'assistant' }];
  for (let index = 0; index < 300; index++) deltas.push({ reasoning_content: `stream-reason-${index};` }, { content: `stream-text-${index};` });
  const local = await provider(t, async body => {
    assert.equal(body.stream, true, 'exercise the actual streaming model adapter');
    return { _stream: deltas };
  });
  const f = await fixture(t, local.baseUrl, { maxHttp: 1, name: 'streamed-deltas' });
  const result = await runDshAdaptation(f.options);
  assert.equal(local.requests.length, 1, JSON.stringify(result.error));
  const state = await readAdaptationState(f.options.statePath);
  const eventLog = await readFile(path.join(state.backend.runtimeHome, 'events.jsonl'), 'utf8');
  const indexed = eventLog.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(indexed.length > 0);
  assert.ok(indexed.every(row => row.schema === 'pinhao-dsh-event-reference-1' && /^[a-f0-9]{64}$/.test(row.payloadHash)));
  assert.ok(!eventLog.includes('stream-text-') && !eventLog.includes('stream-reason-'), 'host event index must not duplicate streamed model payloads');
  const modelSteps = f.progress.filter(row => row.tool === 'model_step');
  assert.equal(modelSteps.length, new Set(modelSteps.map(row => row.step)).size, 'one coarse notification per SDK step, not per delta');
  assert.equal(modelSteps.length, indexed.filter(row => row.event?.type === 'step/start').length);
  assert.equal(f.owner.snapshot().httpSentKnown, 1, 'prepared SDK step count is not the external paid-request ledger');
  assert.ok(modelSteps.length >= 1 && modelSteps.length <= local.requests.length + 1,
    'a final prepared step may be refused before external dispatch, but deltas must not create progress steps');
  const retained = [];
  async function collect(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await collect(file);
      else if (/\.jsonl?$/.test(item.name)) retained.push(await readFile(file, 'utf8'));
    }
  }
  await collect(path.join(state.backend.runtimeHome, 'sessions'));
  assert.ok(retained.some(text => text.includes('stream-text-299;')), 'actual SDK durable history retains final streamed content');
  assert.notEqual(result.status, 'verified');
});

test('T07: a concrete source-backed blocker stops at ordinary idle without false acceptance or a fourth request', { ...runtimeCheck, timeout: 120000 }, async t => {
  const local = await provider(t, async (body, index) => {
    if (index === 1) return tool('read_resource', { root: 'source', file: 'story.json' }, 'read-blocker-source');
    if (index === 2) {
      const receiptId = receiptFrom(body.messages); assert.ok(receiptId, 'use the real saved read receipt, not an invented proof');
      return tool('manage_work_items', { action: 'record', finding: { file: 'story.json',
        claim: 'The source exists, but its rendering consumer is absent from this supplied fixture.',
        sourceEvidenceRefs: [receiptId], blockers: [{ code: 'consumer-not-supplied',
          message: 'No engine loader or rendering consumer is available to prove this field is displayed.', missing: 'rendering consumer source' }],
        proposedNextAction: 'Supply the actual resource loader or display consumer before preparing an adapter.' } }, 'save-blocker');
    }
    return { content: 'A concrete missing consumer has been recorded with source evidence; no adapter is verified.' };
  });
  const f = await fixture(t, local.baseUrl, { maxHttp: 5, name: 'saved-blocker' });
  const result = await runDshAdaptation(f.options);
  assert.equal(local.requests.length, 3, JSON.stringify(result.error));
  assert.equal(result.status, 'needs-review');
  assert.equal(result.stopReason, 'SAVED_EVIDENCE_BLOCKER');
  assert.equal(result.reportedBlockers.claimStatus, 'agent-reported-not-host-verified');
  assert.equal(result.reportedBlockers.items.length, 1);
  assert.ok(result.reportedBlockers.items[0].sourceEvidenceRefs.length);
  assert.equal(result.reportedBlockers.items[0].blockers[0].code, 'consumer-not-supplied');
  assert.equal(f.owner.snapshot().remainingHttpAttempts, 2, 'stop is evidence-aware rather than quota exhaustion');
  assert.equal(result.coverage.needsAdaptation, true);
  assert.equal(result.extractions?.length ?? 0, 0);
  assert.equal(result.partialExtractions.length, 0);
});

for (const scenario of [{ name: 'before-idle', sleep: 0.6, responseDelay: 950 }, { name: 'after-idle', sleep: 1.4, responseDelay: 0 }]) {
  test(`T02/T03: original slow process completion ${scenario.name} is delivered once without rerun`, { ...runtimeCheck, timeout: 120000 }, async t => {
    let f;
    const code = `from pathlib import Path\nimport time\np=Path('run-count.txt')\np.write_text(str(int(p.read_text())+1) if p.exists() else '1')\ntime.sleep(${scenario.sleep})\nprint('slow-committed-output',flush=True)`;
    const local = await provider(t, async (body, index) => {
      if (index === 1) return tool('run_workspace', { program: 'python', args: ['-c', code] }, 'slow-script');
      if (index === 2) { await delay(scenario.responseDelay); return { content: 'I am waiting for the original process.' }; }
      return { content: 'The outcome is not yet accepted.' };
    });
    f = await fixture(t, local.baseUrl, { maxHttp: 3, name: scenario.name });
    const result = await runDshAdaptation({ ...f.options, dsh: { ...f.options.dsh, initialWaitMs: 10 } });
    assert.equal(local.requests.length, 3, JSON.stringify(result.error));
    const prompt = local.requests[2].messages.filter(message => message.role === 'user').at(-1).content;
    assert.match(JSON.stringify(prompt), /slow-committed-output/);
    assert.equal((JSON.stringify(prompt).match(/notificationId/g) ?? []).length, 1, 'one notification must not be appended twice');
    assert.equal(await readFile(path.join(f.workspaceDir, 'run-count.txt'), 'utf8'), '1');
    assert.equal(result.status, 'needs-review');
  });
}

test('T04: budget-blocked completion stays not-sent, resumes same session without rerunning script', { ...runtimeCheck, timeout: 180000 }, async t => {
  const code = "from pathlib import Path\nimport time\np=Path('run-count.txt')\np.write_text(str(int(p.read_text())+1) if p.exists() else '1')\ntime.sleep(1.4)\nprint('budget-boundary-result',flush=True)";
  const local = await provider(t, async (_body, index) => index === 1
    ? tool('run_workspace', { program: 'python', args: ['-c', code] }, 'one-original-run')
    : { content: 'The original process should be used, not run again.' });
  const f = await fixture(t, local.baseUrl, { maxHttp: 2, name: 'completion-resume' });
  const options = { ...f.options, dsh: { ...f.options.dsh, initialWaitMs: 10 } };
  const first = await runDshAdaptation(options);
  assert.equal(first.stopReason, 'ADAPTATION_BUDGET_EXHAUSTED', JSON.stringify(first.error));
  const prior = await readAdaptationState(f.options.statePath);
  const pending = Object.values(prior.backend.pendingRuns);
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0].delivered, true, 'completion was not part of an actual admitted request');
  assert.equal(local.requests.length, 2);
  assert.equal(await readFile(path.join(f.workspaceDir, 'run-count.txt'), 'utf8'), '1');
  f.owner.grantAdditional({ grantId: 'explicit-local-resume', httpAttempts: 1, reason: 'An explicit no-fee resumption test grant.' });
  const resumed = await runDshAdaptation(options);
  assert.equal(resumed.state.backend.sessionId, prior.backend.sessionId);
  assert.equal(local.requests.length, 3, JSON.stringify(resumed.error));
  assert.match(JSON.stringify(local.requests[2].messages), /budget-boundary-result/);
  assert.equal(await readFile(path.join(f.workspaceDir, 'run-count.txt'), 'utf8'), '1');
  assert.equal(resumed.state.backend.pendingRuns[pending[0].runId].delivered, true);
});

test('T08: cancelling one actual runtime does not stop its concurrent sibling', { ...runtimeCheck, timeout: 180000 }, async t => {
  let firstAdmitted;
  const admitted = new Promise(resolve => { firstAdmitted = resolve; });
  const local = await provider(t, async body => {
    if (JSON.stringify(body.messages).includes('cancel-one')) { firstAdmitted(); await delay(500); }
    return { content: 'I have not submitted a validated adapter.' };
  });
  const one = await fixture(t, local.baseUrl, { maxHttp: 2, name: 'cancel-one' });
  const two = await fixture(t, local.baseUrl, { maxHttp: 2, name: 'sibling-two' });
  const abort = new AbortController();
  const first = runDshAdaptation({ ...one.options, signal: abort.signal });
  const second = runDshAdaptation(two.options);
  await admitted; abort.abort(new Error('User cancelled only job one.'));
  const [cancelled, sibling] = await Promise.all([first, second]);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(sibling.status, 'needs-review');
  assert.equal(sibling.stopReason, 'ADAPTATION_BUDGET_EXHAUSTED');
  assert.equal(two.owner.snapshot().httpSentKnown, 2);
  const frozen = await readFile(one.options.statePath);
  await delay(100);
  assert.deepEqual(await readFile(one.options.statePath), frozen, 'cancelled job does not automatically revive');
});

test('T11/T14: changed source and missing durable session fail explicitly without a fresh paid execution', { ...runtimeCheck, timeout: 180000 }, async t => {
  const local = await provider(t, async () => ({ content: 'No adapter has been accepted.' }));
  const f = await fixture(t, local.baseUrl, { maxHttp: 1, name: 'missing-session' });
  const first = await runDshAdaptation(f.options);
  assert.equal(local.requests.length, 1, JSON.stringify(first.error));
  assert.equal(first.state.backend.sessionStarted, true);
  const fingerprint = first.state.backend.sourceFingerprint;
  const changed = await runDshAdaptation({ ...f.options, project: { ...f.project, sourceFingerprint: 'changed-source' } }).catch(error => ({ error }));
  assert.equal(changed.stopReason ?? changed.error?.code, 'DSH_SESSION_SOURCE_CHANGED');
  assert.equal(local.requests.length, 1);
  assert.equal((await readAdaptationState(f.options.statePath)).backend.sourceFingerprint, fingerprint);
  const paths = [];
  async function visit(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error('Fixture session must not contain links.');
      if (item.isDirectory()) await visit(file);
      else if (/^session(?:\.v\d+)?\.jsonl$/.test(item.name)) paths.push(file);
    }
  }
  await visit(path.join(first.state.backend.runtimeHome, 'sessions'));
  assert.ok(paths.length > 0, 'actual SDK durable session must exist before loss simulation');
  for (const file of paths) {
    assert.ok(!path.relative(f.root, file).startsWith('..'), 'loss simulation touches only this isolated fixture');
    await unlink(file);
  }
  f.owner.grantAdditional({ grantId: 'missing-session-test', httpAttempts: 1, reason: 'Local test may resume only the same durable session.' });
  const missing = await runDshAdaptation(f.options);
  assert.notEqual(missing.status, 'verified');
  assert.equal(local.requests.length, 1, 'missing session must not silently create a fresh model conversation');
  assert.equal(missing.state.backend.sessionId, first.state.backend.sessionId);
  assert.ok(missing.error?.message, 'session loss must be a visible error');
});

for (const failSummary of [false, true]) {
  test(`T05/T06/T12: real profile compaction ${failSummary ? 'rejects truncated summaries' : 'preserves resumable evidence and charges its own request'}`, { ...runtimeCheck, timeout: 180000 }, async t => {
    let reads = 0, summaries = 0, evidenceId, compactedRequest;
    const local = await provider(t, async body => {
      const messages = JSON.stringify(body.messages);
      const reference = messages.match(/evidence-[a-f0-9]{64}/)?.[0];
      if (reference) evidenceId ??= reference;
      if (messages.includes('You are now acting as a compaction engine')) {
        summaries++;
        if (failSummary) return { _finishReason: 'length', content: 'TRUNCATED_SUMMARY_MUST_NOT_LAND' };
        assert.ok(evidenceId, 'summary receives a recoverable real host evidence identity');
        return { content: `## Primary Request and Intent\n- Investigate the full story without claiming acceptance.\n## Key Technical Concepts\n- Host evidence.\n## Files and Code\n- large.txt contains TARGET_TASK_FACT.\n## Errors and Fixes\n- (none)\n## Pending Jobs\n- No candidate is accepted.\n## Current Work\n- Three source slices were read.\n## Next Step\n- Use read_evidence for ${evidenceId}.\n## Critical Context\n- Preserve TARGET_TASK_FACT and reference ${evidenceId}.` };
      }
      if (messages.includes('<compacted-summary>')) {
        compactedRequest = body;
        if (!reads || reads < 4) { reads = 4; return tool('read_evidence', { evidenceId, pointer: '/content', offset: 0, length: 2000 }, 'read-after-compaction'); }
        return { content: 'No acceptance has occurred.' };
      }
      if (reads < 3) return tool('read_resource', { root: 'source', file: 'large.txt', offset: 80000 * reads++, length: 80000 }, `large-read-${reads}`);
      return { content: 'Continue from the source evidence.' };
    });
    const f = await fixture(t, local.baseUrl, { maxHttp: 8, name: failSummary ? 'summary-failure' : 'summary-success' });
    const large = 'TARGET_TASK_FACT\n' + Array.from({ length: 20000 }, (_, index) => `${index.toString(36)}: distinct neutral evidence marker ${index * 17}\n`).join('');
    await writeFile(path.join(f.gameDir, 'large.txt'), large);
    const result = await runDshAdaptation({ ...f.options, dsh: { ...f.options.dsh, contextWindow: 100000, maxTokens: 1024 } });
    assert.ok(summaries >= 1, JSON.stringify({ result: result.error, requests: local.requests.length, reads }));
    assert.equal(f.owner.snapshot().httpSentKnown, local.requests.length, 'compaction and inference share the exact same ledger');
    assert.notEqual(result.status, 'verified');
    if (failSummary) {
      assert.ok(local.requests.every(body => !JSON.stringify(body.messages).includes('<compacted-summary>\nTRUNCATED_SUMMARY_MUST_NOT_LAND')));
      assert.equal(compactedRequest, undefined, 'truncated summary must not replace the conversation');
    } else {
      assert.ok(compactedRequest, 'an actual following request contains the saved checkpoint');
      assert.match(JSON.stringify(compactedRequest.messages), /TARGET_TASK_FACT/);
      assert.ok(compactedRequest.tools.some(row => row.function.name === 'read_evidence'));
      assert.ok(local.requests.some(body => body.messages.some(message => message.role === 'tool' && JSON.stringify(message).includes('TARGET_TASK_FACT'))));
    }
  });
}

test('F04: actual SDK survives a 400 context overflow, persists compaction and retries the same session', { ...runtimeCheck, timeout: 180000 }, async t => {
  let reads = 0, overflow = false, summaries = 0, compacted;
  const local = await provider(t, async body => {
    const messages = JSON.stringify(body.messages);
    if (messages.includes('You are now acting as a compaction engine')) {
      summaries++;
      return { content: '## Primary Request and Intent\nInvestigate the same source.\n## Critical Context\nOVERFLOW_RECOVERY_CHECKPOINT: source evidence is saved; no adapter has been accepted. Preserve all receipts.' };
    }
    if (messages.includes('<compacted-summary>')) { compacted = body; return { content: 'No adapter has been accepted.' }; }
    if (reads < 3) return tool('read_resource', { root: 'source', file: 'overflow.txt', offset: reads++ * 20000, length: 20000 }, `overflow-read-${reads}`);
    if (!overflow) { overflow = true; return { _httpError: { status: 400, body: { error: { code: 'context_length_exceeded', message: 'Maximum context length exceeded' } } } }; }
    return { content: 'No candidate has been accepted.' };
  });
  const f = await fixture(t, local.baseUrl, { maxHttp: 8, name: 'context-overflow-recovery' });
  await writeFile(path.join(f.gameDir, 'overflow.txt'), 'OLD_HISTORY_SENTINEL\n' + 'distinct saved source material\n'.repeat(3000));
  const result = await runDshAdaptation(f.options);
  assert.equal(overflow, true);
  assert.ok(summaries > 0, JSON.stringify({ stopReason: result.stopReason, requests: local.requests.length }));
  assert.ok(compacted, 'the SDK must use a durable compacted history in a following real HTTP request');
  assert.match(JSON.stringify(compacted.messages), /OVERFLOW_RECOVERY_CHECKPOINT/);
  assert.equal(JSON.stringify(compacted.messages).includes('OLD_HISTORY_SENTINEL'), false);
  assert.notEqual(result.stopReason, 'TECHNICAL_CONFIGURATION_ERROR');
  assert.equal(f.owner.snapshot().httpSentKnown, local.requests.length, 'failed request, summary and retry retain their actual accounting');
  const state = await readAdaptationState(f.options.statePath);
  const events = (await readFile(path.join(state.backend.runtimeHome, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(row => row.event?.type === 'compaction/end'));
});
