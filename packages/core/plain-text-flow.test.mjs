import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { sdkProvider, taskPrompt, liveRequestSlots, REVIEW_PROTOCOL } from './provider.mjs';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { sha256, validateTranslation } from '../exchange/index.mjs';

const rows = () => [0, 1].map(index => ({ id: `canonical-private-${index}`, source: `Alice enters room ${index}. {{CTRL_0}}`,
  translation: `爱丽丝走进房间${index}。{{CTRL_0}}`, revision: 4, kind: 'dialogue', tokens: ['{{CTRL_0}}'],
  context: { speaker: 'Traveler', file: 'private/carrier.bundle', sceneId: 'private-scene-full-hash',
    sourceHash: 'private-source-full-hash', controlBindings: { '{{CTRL_0}}': 'An engine control.' } } }));
const refFor = (wire, id) => wire.state.entries.find(([, value]) => value === id)[0];
const block = (ref, body) => `[${ref}]\n${body}`;

async function endpoint(t, respond) {
  const requests = [], errors = [];
  const server = http.createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw); requests.push(input);
      await respond(response, input, requests.length);
    } catch (error) { errors.push(error); response.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, [], 'The local fixture must not hide an assertion failure');
  });
  return { requests, connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'neutral-plaintext' } };
}

function start(response) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-request-id': 'neutral-plaintext-request' });
}
function chunk(response, content, finishReason = null, usage) {
  response.write(`data: ${JSON.stringify({ id: 'neutral-plaintext-completion', choices: [{ index: 0,
    delta: content === undefined ? {} : { content }, finish_reason: finishReason }], ...(usage ? { usage } : {}) })}\n\n`);
}
function finish(response, reason = 'stop', usage = { prompt_tokens: 17, completion_tokens: 23, total_tokens: 40 }) {
  chunk(response, undefined, reason, usage); response.end('data: [DONE]\n\n');
}
async function eventually(read) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await read(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the neutral plaintext flow');
}

async function nativeFixture(t, { respond, raw = rows().map(({ translation, revision, ...unit }) => unit),
  onFailure, unavailable = true, concurrency = 1, connectionOptions = {} } = {}) {
  const testRoot = path.resolve('local/plain-text-flow-tests'); await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(path.join(testRoot, 'neutral-')), dataDir = path.join(root, 'data'), gameDir = path.join(root, 'game');
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'original.txt'), 'neutral original');
  let service, sampleCalls = 0;
  const materials = [];
  const worker = async (command, args) => {
    if (command === 'probe') return { engine: 'MV' };
    if (command === 'extract') { await mkdir(args.workspaceDir, { recursive: true });
      return { units: raw, workspaceDir: args.workspaceDir, sourceFingerprint: sha256(raw) }; }
    if (['roundtrip', 'validate'].includes(command)) return { ok: true };
    if (command === 'build') {
      if (args.outputDir.includes(`${path.sep}samples${path.sep}`)) {
        sampleCalls++; if (unavailable) throw new Error('Neutral native sample dependency unavailable');
      }
      await mkdir(args.outputDir, { recursive: true }); return { buildDir: args.outputDir };
    }
    if (command === 'assemble') { await mkdir(args.outputDir, { recursive: true }); return { outputDir: args.outputDir }; }
    throw new Error(`Unsupported neutral plaintext command: ${command}`);
  };
  const { connection, requests } = await endpoint(t, respond ?? (response => {
    start(response); chunk(response, `${block('u1', '爱丽丝进入房间0。{{CTRL_0}}')}\n${block('u2', '爱丽丝进入房间1。{{CTRL_0}}')}\n[完成]`);
    finish(response);
  }));
  const open = () => createService({ dataDir, worker, scriptTools: null,
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral plaintext native fixture' }),
    provider: async args => {
      materials.push(args.wire);
      try { return await sdkProvider(args); }
      catch (error) { await onFailure?.(error); throw error; }
    } });
  const tasks = () => { const store = createStore(dataDir); try { return store.tasks(project.id); } finally { store.close(); } };
  t.after(async () => {
    await service?.close(); assert.ok(path.resolve(root).startsWith(`${testRoot}${path.sep}`));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  });
  service = await open(); await service.saveSettings({ ...defaultSettings(), connection: { ...connection, ...connectionOptions }, concurrency, proofreading: false });
  const project = await service.createProject({ gameDir });
  return { project, dataDir, gameDir, requests, materials, tasks, workerSource: worker.toString(), raw, get service() { return service; }, get sampleCalls() { return sampleCalls; },
    async reopen() { await service.close(); unavailable = false; service = await open(); } };
}
const settled = f => eventually(async () => { const value = await f.service.getProject({ projectId: f.project.id });
  return ['completed', 'paused'].includes(value.status) && value; });

test('real SDK plaintext terminal admission across individual characters without JSON escaping or host identity', async t => {
  const units = rows(), reference = { ...units[0], id: 'private-reference-full-hash', source: 'An earlier complete scene.' };
  const prompt = taskPrompt('translation', units, 'zh-Hans', [reference]);
  const [a, b] = units.map(unit => refFor(prompt.wire, unit.id));
  const value = '  雪😀说："夺回 {房间}"。\\n 是两个字符。\n\n下一整句 {{CTRL_0}}  \n\n';
  let finished = false;
  const { connection, requests } = await endpoint(t, async (response, input) => {
    assert.equal(input.messages.at(-1).content, prompt.prompt);
    assert.equal(input.response_format, undefined, 'Plaintext output must not request JSON mode');
    const material = input.messages.map(message => message.content).join('\n');
    for (const privateValue of ['private/carrier.bundle', 'private-scene-full-hash', 'private-source-full-hash',
      units[0].id, units[1].id, reference.id]) assert.ok(!material.includes(privateValue), privateValue);
    start(response);
    const first = `${block(a, value)}\n[${b}]\n`;
    for (let index = 0; index < first.length; index++) chunk(response, first[index]);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(checkpoints.length, 0, 'No receiving prefix may be admitted');
    for (const character of '第二条完整台词 {{CTRL_0}}\n[完成]') chunk(response, character);
    finished = true; finish(response);
  });
  const checkpoints = [];
  const result = await sdkProvider({ connection, ...prompt, signal: AbortSignal.timeout(4000), onRecords: records => {
    assert.equal(finished, true);
    checkpoints.push(...records);
  } });
  assert.deepEqual(result.records, [{ id: units[0].id, translation: value, notes: '' },
    { id: units[1].id, translation: '第二条完整台词 {{CTRL_0}}', notes: '' }]);
  assert.deepEqual(checkpoints, [], 'Provider returns canonical records; only service admits candidates');
  for (const record of result.records) validateTranslation(units.find(unit => unit.id === record.id), record.translation);
  assert.equal(result.usage.inputTokens, 17); assert.equal(result.transportRequests, 1);
  assert.equal(requests.length, 1); assert.equal(liveRequestSlots(), 0);
});

test('a disconnected plaintext stream retains only closed canonical candidates without another HTTP call', async t => {
  const units = rows(), prompt = taskPrompt('translation', units, 'zh-Hans');
  const [a, b] = units.map(unit => refFor(prompt.wire, unit.id));
  const { connection, requests } = await endpoint(t, response => {
    start(response); chunk(response, `${block(a, '完整 {{CTRL_0}}')}\n[${b}]\n不能接纳的半句`); response.end();
  });
  const checkpoints = [];
  await assert.rejects(sdkProvider({ connection, ...prompt, onRecords: records => checkpoints.push(...records) }), error => {
    assert.equal(error.code, 'ECONNRESET'); assert.equal(error.category, 'transport');
    assert.equal(error.transportRequests, 1); assert.equal(error.requestId, 'neutral-plaintext-request');
    checkpoints.push(...error.completedRecords);
    assert.deepEqual(error.completedIds, [units[0].id]); return true;
  });
  assert.deepEqual(checkpoints, [{ id: units[0].id, translation: '完整 {{CTRL_0}}', notes: '' }]);
  assert.equal(requests.length, 1); assert.equal(liveRequestSlots(), 0);
});

test('plaintext length truncation preserves terminal accounting but never promotes an open final block', async t => {
  const units = rows(), prompt = taskPrompt('translation', units, 'zh-Hans');
  const [a, b] = units.map(unit => refFor(prompt.wire, unit.id));
  const { connection, requests } = await endpoint(t, response => {
    start(response); chunk(response, `${block(a, '完整 {{CTRL_0}}')}\n[${b}]\n半句`);
    finish(response, 'length', { prompt_tokens: 123, completion_tokens: 456, total_tokens: 579,
      prompt_tokens_details: { cached_tokens: 17 } });
  });
  const checkpoints = [];
  await assert.rejects(sdkProvider({ connection, ...prompt, onRecords: records => checkpoints.push(...records) }), error => {
    assert.equal(error.code, 'MODEL_OUTPUT_TRUNCATED'); assert.equal(error.category, 'output_truncated');
    assert.equal(error.finishReason, 'length'); assert.equal(error.usage.inputTokens, 123);
    assert.equal(error.usage.outputTokens, 456); assert.equal(error.rawUsage.prompt_tokens_details.cached_tokens, 17);
    checkpoints.push(...error.completedRecords);
    assert.deepEqual(error.completedIds, [units[0].id]); return true;
  });
  assert.deepEqual(checkpoints.map(record => record.id), [units[0].id]);
  assert.equal(requests.length, 1); assert.equal(liveRequestSlots(), 0);
});

test('plaintext review submits only changed blocks and explicit completion covers unchanged targets', async t => {
  const units = rows(), prompt = taskPrompt('proofreading', units, 'zh-Hans', [], [], { reviewProtocol: true });
  const [a, b] = units.map(unit => refFor(prompt.wire, unit.id));
  const { connection, requests } = await endpoint(t, (response, input, index) => {
    start(response);
    const output = index === 1 ? `${block(a, '爱丽丝进入房间0。{{CTRL_0}}')}\n[完成]\n[附加信息]\n${JSON.stringify({
      remarks: [[a, '修正人物移动方向。']],
      questions: [[b, 'source_ambiguity', '原作未指明说话对象，保留歧义。']] })}` : '[完成]';
    for (let offset = 0; offset < output.length; offset += 3) chunk(response, output.slice(offset, offset + 3));
    finish(response);
  });
  const checkpoints = [];
  const result = await sdkProvider({ connection, ...prompt, onRecords: records => checkpoints.push(...records) });
  assert.deepEqual(result.records, []); assert.deepEqual(checkpoints, []);
  assert.equal(result.review.protocol, REVIEW_PROTOCOL);
  assert.deepEqual(result.review.reviewedIds, units.map(unit => unit.id));
  assert.deepEqual(result.review.edits, [{ id: units[0].id, translation: '爱丽丝进入房间0。{{CTRL_0}}', notes: '修正人物移动方向。' }]);
  assert.ok(result.review.issues.some(issue => issue.unitId === units[1].id && issue.kind === 'source_ambiguity'));
  const unchanged = await sdkProvider({ connection, ...prompt });
  assert.deepEqual(unchanged.review.reviewedIds, units.map(unit => unit.id));
  assert.deepEqual(unchanged.review.edits, []); assert.equal(requests.length, 2);
});

test('review without explicit completion cannot claim unchanged coverage or emit translation checkpoints', async t => {
  const units = rows(), prompt = taskPrompt('proofreading', units, 'zh-Hans', [], [], { reviewProtocol: true });
  const { connection } = await endpoint(t, response => {
    start(response); chunk(response, block(refFor(prompt.wire, units[0].id), '修正 {{CTRL_0}}')); finish(response);
  });
  const checkpoints = [];
  const result = await sdkProvider({ connection, ...prompt, onRecords: records => checkpoints.push(...records) });
  assert.deepEqual(checkpoints, []);
  assert.ok(result.responseRepair, 'A clean transport stop is not a declaration that every review target was inspected');
  assert.ok(!result.review?.reviewedIds.includes(units[1].id), 'The omitted unchanged target stays unreviewed');
});

test('plaintext adjuncts retain optional term evidence and bind read and semantic references on the host', async t => {
  const units = rows(), reference = { ...units[0], id: 'canonical-readonly-reference', source: 'Alice is a person.' };
  const prompt = taskPrompt('translation', units.slice(0, 1), 'zh-Hans', [reference]);
  const a = refFor(prompt.wire, units[0].id), r = refFor(prompt.wire, reference.id);
  const { connection, requests } = await endpoint(t, response => {
    start(response); chunk(response, `${block(a, '爱丽丝走进房间0。{{CTRL_0}}')}\n[完成]\n[附加信息]\n${JSON.stringify({
      terms: [[a, 'Alice', '爱丽丝']], read: [{ ids: [r], text: 'Alice', reason: 'Resolve speaker identity' }],
      remarks: [[a, '依照上下文将Alice作为人名处理。']],
      notes: `${r} establishes a person.`, decisions: [{ entity: 'Alice', sense: 'person', translation: '爱丽丝',
        scope: { unitIds: [a] }, evidenceIds: [r] }] })}`); finish(response);
  });
  const result = await sdkProvider({ connection, ...prompt });
  assert.equal(result.records[0].id, units[0].id);
  assert.equal(result.records[0].notes, '依照上下文将Alice作为人名处理。');
  assert.equal(result.records[0].translation, '爱丽丝走进房间0。{{CTRL_0}}');
  assert.deepEqual(result.records[0].termChoices, [{ source: 'Alice', translation: '爱丽丝' }]);
  assert.deepEqual(result.evidenceRequests[0].query, { ids: [reference.id], text: 'Alice' });
  assert.deepEqual(result.semanticDecisions[0].scope.unitIds, [units[0].id]);
  assert.deepEqual(result.semanticDecisions[0].evidenceIds, [reference.id]);
  assert.equal(result.readingNotes, `${r} establishes a person.`); assert.equal(requests.length, 1);
});

test('bad, read-only and duplicate per-unit remarks cannot pollute a complete paid plaintext body', async t => {
  const units = rows(), before = structuredClone(units), prompt = taskPrompt('translation', units.slice(0, 1), 'zh-Hans', units.slice(1));
  const a = refFor(prompt.wire, units[0].id), r = refFor(prompt.wire, units[1].id);
  const invalid = [[[a, 19]], [[r, '只读参考备注不得写入目标。']], [[a, '第一项'], [a, '重复项']]];
  const { connection, requests } = await endpoint(t, (response, input, index) => {
    start(response); chunk(response, `${block(a, '爱丽丝 {{CTRL_0}}')}\n[完成]\n[附加信息]\n${JSON.stringify({ remarks: invalid[index - 1] })}`);
    finish(response);
  });
  for (let index = 0; index < invalid.length; index++) {
    const result = await sdkProvider({ connection, ...prompt });
    assert.deepEqual(result.records, [{ id: units[0].id, translation: '爱丽丝 {{CTRL_0}}', notes: '' }]);
    assert.ok(result.responseRepair, 'Rejected optional remarks stay visible without losing the translation');
    assert.equal(result.readingNotes, undefined); assert.equal(result.transportRequests, 1);
  }
  assert.deepEqual(units, before, 'The host target and read-only source material remain untouched');
  assert.equal(requests.length, invalid.length);
});

test('malformed optional adjuncts never discard complete paid translations', async t => {
  const units = rows(), prompt = taskPrompt('translation', units.slice(0, 1), 'zh-Hans');
  const reviewPrompt = taskPrompt('proofreading', units, 'zh-Hans', [], [], { reviewProtocol: true });
  const a = refFor(prompt.wire, units[0].id);
  const { connection, requests } = await endpoint(t, (response, input, index) => {
    start(response); chunk(response, `${block(a, '爱丽丝 {{CTRL_0}}')}\n[完成]\n[附加信息]\n${
      index === 1 ? '{"terms": [broken' : index === 2 ? JSON.stringify({ terms: null, read: 'not-a-query-list' })
        : JSON.stringify({ read: [{ ids: ['unknown'] }], decisions: [{ entity: 'Alice', sense: 'person',
          scope: { unitIds: ['unknown'] }, evidenceIds: [a] }] })}`); finish(response);
  });
  for (let index = 0; index < 2; index++) {
    const checkpoints = [];
    const result = await sdkProvider({ connection, ...prompt, onRecords: records => checkpoints.push(...records) });
    assert.deepEqual(result.records, [{ id: units[0].id, translation: '爱丽丝 {{CTRL_0}}', notes: '' }]);
    assert.deepEqual(checkpoints, []);
    assert.ok(result.responseRepair || result.termWarnings?.length, 'Malformed adjunct data remains visible as a repair/warning');
    assert.equal(result.usage.outputTokens, 23); assert.equal(result.transportRequests, 1);
  }
  const checkpoints = [];
  const review = await sdkProvider({ connection, ...reviewPrompt, onRecords: records => checkpoints.push(...records) });
  assert.deepEqual(checkpoints, []);
  assert.deepEqual(review.review.edits, [{ id: units[0].id, translation: '爱丽丝 {{CTRL_0}}' }]);
  assert.ok(review.responseRepair, 'Bad nested adjunct references remain visible without losing the paid edit');
  assert.ok(!review.review.reviewedIds.includes(units[1].id), 'Malformed adjuncts cannot attest unchanged review coverage');
  assert.equal(requests.length, 3);
});

test('unknown, repeated and read-only plaintext headers cannot create or overwrite a target candidate', async t => {
  const units = rows(), reference = { ...units[0], id: 'canonical-readonly-reference', source: 'Earlier scene.' };
  const prompt = taskPrompt('translation', units, 'zh-Hans', [reference]);
  const a = refFor(prompt.wire, units[0].id), b = refFor(prompt.wire, units[1].id), r = refFor(prompt.wire, reference.id);
  const outputs = [block('u999', 'Unknown'), `${block(a, 'First {{CTRL_0}}')}\n${block(a, 'Second {{CTRL_0}}')}`,
    `${block(a, 'First {{CTRL_0}}')}\n[完成]\n${block(a, 'Second {{CTRL_0}}')}`,
    block(r, 'Reference cannot mutate'), block(units[0].id, 'Canonical IDs are not the wire protocol'),
    `${block(a, 'First {{CTRL_0}}')}\n${block('u999', 'Unknown between valid translations')}\n${block(b, 'Second safe {{CTRL_0}}')}`];
  const { connection, requests } = await endpoint(t, (response, input, index) => {
    start(response); chunk(response, `${outputs[index - 1]}\n[完成]\n`); finish(response);
  });
  for (let index = 0; index < outputs.length; index++) {
    const checkpoints = [];
    await assert.rejects(sdkProvider({ connection, ...prompt, onRecords: records => checkpoints.push(...records) }), error => {
      assert.equal(error.code, 'INVALID_RESPONSE');
      checkpoints.push(...(error.completedRecords ?? []));
      if (index === 1 || index === 2) assert.deepEqual(error.invalidatedIds, [units[0].id]);
      return true;
    });
    if (index === outputs.length - 1) assert.deepEqual(checkpoints, [{ id: units[0].id, translation: 'First {{CTRL_0}}', notes: '' },
      { id: units[1].id, translation: 'Second safe {{CTRL_0}}', notes: '' }]);
    else {
      assert.ok(checkpoints.length <= 1);
      assert.ok(checkpoints.every(record => record.id === units[0].id && record.translation === 'First {{CTRL_0}}'));
    }
  }
  assert.equal(requests.length, outputs.length); assert.equal(liveRequestSlots(), 0);
});

test('SDK plaintext candidates survive native sample pause and reopen with one saved accounting artifact', async t => {
  const f = await nativeFixture(t); await f.service.startProject({ projectId: f.project.id });
  const paused = await settled(f);
  assert.equal(paused.status, 'paused'); assert.match(paused.lastError, /sample dependency/); assert.equal(f.requests.length, 1);
  const saved = f.tasks().find(task => task.candidateRecords?.length);
  assert.equal(saved.candidateRecords.length, 2);
  const history = saved.requestHistory[0], artifactPath = path.join(history.artifact.directory, 'result.json');
  const artifactBefore = await readFile(artifactPath);
  const artifact = JSON.parse(artifactBefore);
  assert.equal(artifact.status, 'received'); assert.equal(artifact.summary.records, 2);
  assert.equal(artifact.summary.transportRequests, 1); assert.equal(artifact.summary.usage.promptTokens, 17);
  assert.match(await readFile(path.join(history.artifact.directory, 'final.txt'), 'utf8'), /\[u1\]/);
  await f.reopen(); await f.service.startProject({ projectId: f.project.id });
  const done = await settled(f);
  assert.equal(done.status, 'completed', done.lastError); assert.equal(f.requests.length, 1);
  assert.equal(f.sampleCalls, 2); assert.deepEqual(await readFile(artifactPath), artifactBefore);
  const final = (await f.service.listText({ projectId: f.project.id })).units;
  assert.ok(final.every(unit => unit.status === 'translated'));
  assert.deepEqual(final.map(unit => unit.translation), ['爱丽丝进入房间0。{{CTRL_0}}', '爱丽丝进入房间1。{{CTRL_0}}']);
  for (const unit of final) validateTranslation(unit, unit.translation);
  assert.equal(await readFile(path.join(f.gameDir, 'original.txt'), 'utf8'), 'neutral original');
});

test('a persisted old partial wire state retains its second short tag for the missing target after reopen', async t => {
  const f = await nativeFixture(t, { respond: (response, input, index) => {
    start(response);
    chunk(response, index === 1 ? `${block('u1', '旧候选 {{CTRL_0}}')}\n${block('u2', '已移出的候选 {{CTRL_0}}')}\n[完成]`
      : `${block('u2', '续译房间1。{{CTRL_0}}')}\n[完成]`); finish(response);
  } });
  await f.service.startProject({ projectId: f.project.id }); assert.equal((await settled(f)).status, 'paused');
  const saved = f.tasks().find(task => task.candidateRecords?.length), firstId = new Map(saved.textWireState.entries).get('u1');
  const secondId = new Map(saved.textWireState.entries).get('u2'), first = saved.candidateRecords.find(record => record.id === firstId);
  const artifactPath = path.join(saved.requestHistory[0].artifact.directory, 'result.json'), artifactBefore = await readFile(artifactPath);
  const store = createStore(f.dataDir);
  try { store.putTask(f.project.id, { ...saved, candidateRecords: [first],
    textWireState: { entries: saved.textWireState.entries, unitIds: saved.textWireState.unitIds } }); } finally { store.close(); }
  await f.reopen(); await f.service.startProject({ projectId: f.project.id });
  const done = await settled(f); assert.equal(done.status, 'completed', done.lastError);
  assert.equal(f.requests.length, 2); assert.deepEqual(f.materials[1].payload.units.map(unit => unit.id), [secondId]);
  assert.equal(refFor(f.materials[1], secondId), 'u2'); assert.deepEqual(await readFile(artifactPath), artifactBefore);
  const final = (await f.service.listText({ projectId: f.project.id })).units;
  assert.equal(final.find(unit => unit.id === firstId).translation, first.translation);
  assert.equal(final.find(unit => unit.id === secondId).translation, '续译房间1。{{CTRL_0}}');
});

test('three prefix-only SDK responses pause pending text instead of skipping it; manual continue remains possible', async t => {
  const f = await nativeFixture(t, { unavailable: false, respond: response => {
    start(response); chunk(response, '好的，我会结合解释和上下文处理这些文字。'); finish(response);
  } });
  await f.service.startProject({ projectId: f.project.id });
  assert.equal((await settled(f)).status, 'paused');
  assert.equal(f.requests.length, 3);
  assert.ok((await f.service.listText({ projectId: f.project.id })).units.every(unit => unit.status === 'pending'));
  await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(f.requests.length, 3);
  await f.service.startProject({ projectId: f.project.id }); await settled(f);
  assert.equal(f.requests.length, 6, 'Only an explicit continue opens a new window');
});

test('an unfinished exact saved response replays locally once and commits without buying it again', async t => {
  const f = await nativeFixture(t);
  await f.service.startProject({ projectId: f.project.id }); await settled(f);
  const saved = f.tasks().find(task => task.candidateRecords?.length);
  await f.service.close();
  const attempt = saved.requestHistory.at(-1);
  await unlink(path.join(attempt.artifact.directory, 'result.json'));
  const store = createStore(f.dataDir);
  try { store.putTask(f.project.id, { ...saved, candidateRecords: [], error: undefined, lastFailure: undefined,
    requestHistory: [{ ...attempt, status: 'receiving', finishedAt: undefined }] }); } finally { store.close(); }
  await f.reopen(); await f.service.startProject({ projectId: f.project.id });
  const done = await settled(f);
  assert.equal(done.status, 'completed', done.lastError);
  assert.equal(f.requests.length, 1);
  assert.equal(f.tasks().find(task => task.id === saved.id).requestHistory.at(-1).replayConsumed, true);
  await f.reopen(); assert.equal(f.requests.length, 1);
});

test('a process crash immediately after artifact completion cannot lose terminally saved candidates', async t => {
  for (const evidence of [false, true]) {
  const f = await nativeFixture(t, { respond: (response, input, index) => {
    start(response); chunk(response, evidence && index === 1 ? '[附加信息]\n{"read":[{"text":"Alice","limit":1}]}'
      : '[u1]\n爱丽丝进入房间0。{{CTRL_0}}\n[u2]\n爱丽丝进入房间1。{{CTRL_0}}\n[完成]'); finish(response);
  } }); await f.service.close();
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { mkdir } from 'node:fs/promises';
    import path from 'node:path';
    import { sha256 } from ${JSON.stringify(pathToFileURL(path.resolve('packages/exchange/index.mjs')).href)};
    import { createService } from ${JSON.stringify(pathToFileURL(path.resolve('packages/core/service.mjs')).href)};
    const rename = fs.promises.rename;
    fs.promises.rename = async (from, to) => {
      await rename(from, to);
      if (path.basename(to) === 'result.json' && path.basename(path.dirname(path.dirname(to))) === 'requests') process.exit(73);
    };
    syncBuiltinESMExports();
    const raw = ${JSON.stringify(f.raw)}, unavailable = false;
    let sampleCalls = 0;
    const service = await createService({ dataDir: ${JSON.stringify(f.dataDir)}, worker: ${f.workerSource}, scriptTools: null });
    await service.startProject({ projectId: ${JSON.stringify(f.project.id)} });
    await new Promise(() => {});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; child.stderr.on('data', data => { errors += data; });
  const timer = setTimeout(() => child.kill(), 10000); t.after(() => { clearTimeout(timer); child.kill(); });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  clearTimeout(timer); assert.equal(code, 73, errors);
  const saved = f.tasks().find(task => task.candidateRecords?.length || task.evidenceReplies?.length);
  if (evidence) { assert.equal(saved.evidenceReplies.length, 1); assert.ok(saved.dependencies.receipts.length); }
  else assert.equal(saved.candidateRecords.length, 2);
  assert.equal(saved.requestHistory.at(-1).status, 'received');
  assert.equal(JSON.parse(await readFile(path.join(saved.requestHistory.at(-1).artifact.directory, 'result.json'), 'utf8')).status, 'received');
  await f.reopen(); await f.service.startProject({ projectId: f.project.id });
  assert.equal((await settled(f)).status, 'completed'); assert.equal(f.requests.length, evidence ? 2 : 1);
  if (evidence) assert.equal(f.materials.at(-1).payload.evidenceResults.length, 1, 'The paid query is reused, not bought again');
  }
});

test('saved candidates do not reset three later format failures and continue buys only missing IDs', async t => {
  const f = await nativeFixture(t, { unavailable: false, respond: (response, input, index) => {
    start(response);
    chunk(response, index === 1 ? `${block('u1', '已完成 {{CTRL_0}}')}\n[完成]`
      : index < 5 ? '只有解释，没有交付。' : `${block(refFor(f.materials.at(-1), f.materials.at(-1).targetIds[0]), '补缺 {{CTRL_0}}')}\n[完成]`);
    finish(response);
  } });
  await f.service.startProject({ projectId: f.project.id }); assert.equal((await settled(f)).status, 'paused');
  assert.equal(f.requests.length, 4, 'One progress response then exactly three no-progress responses');
  const saved = f.tasks().find(task => task.commitSummary?.committed);
  assert.equal(saved.commitSummary.committed, 1);
  assert.ok(saved.requestHistory.slice(1).every(request => request.checkpointed === undefined || request.newValidIds?.length === 0));
  await f.service.startProject({ projectId: f.project.id });
  assert.equal((await settled(f)).status, 'completed'); assert.equal(f.requests.length, 5);
  assert.equal(f.materials.at(-1).targetIds.length, 1);
});

test('a source revision change disqualifies unfinished replay and never promotes unverified legacy candidates', async t => {
  const f = await nativeFixture(t); await f.service.startProject({ projectId: f.project.id }); await settled(f);
  const saved = f.tasks().find(task => task.candidateRecords?.length), attempt = saved.requestHistory.at(-1);
  await f.service.close(); await unlink(path.join(attempt.artifact.directory, 'result.json'));
  const store = createStore(f.dataDir);
  try {
    const unit = store.units(f.project.id)[0]; store.putUnit(f.project.id, { ...unit, revision: unit.revision + 1 });
    store.putTask(f.project.id, { ...saved, error: undefined, lastFailure: undefined,
      candidateRecords: saved.candidateRecords.map(record => ({ ...record, terminalValidated: undefined })),
      requestHistory: [{ ...attempt, status: 'receiving', finishedAt: undefined }] });
  } finally { store.close(); }
  await f.reopen(); await f.service.startProject({ projectId: f.project.id });
  assert.equal((await settled(f)).status, 'completed'); assert.ok(f.requests.length > 1);
  assert.ok(f.tasks().every(task => !task.requestHistory?.some(request => request.replayConsumed)));
});

test('format exhaustion stops unpaid admission but drains a delayed sent sibling before pause', async t => {
  let release, siblingStarted = false;
  const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const raw = Array.from({ length: 80 }, (_, index) => ({ id: `drain-${index}`, source: `A neutral complete line ${index}.`,
    kind: 'dialogue', tokens: [], context: { file: 'drain-scene.json', sceneId: 'drain-scene' } }));
  const f = await nativeFixture(t, { raw, unavailable: false, concurrency: 2, connectionOptions: { maxOutputTokens: 1200 },
    respond: async (response, input, index) => {
      start(response);
      if (index === 2) {
        siblingStarted = true; const wire = f.materials[1]; await gate;
        chunk(response, wire.targetIds.map(id => block(refFor(wire, id), '独立有效成果。')).join('\n') + '\n[完成]');
      } else chunk(response, '只有前言，没有交付。');
      finish(response);
    } });
  await f.service.startProject({ projectId: f.project.id });
  await eventually(() => siblingStarted && f.requests.length === 4);
  await eventually(() => f.tasks().some(task => task.status === 'paused'));
  assert.equal((await f.service.getProject({ projectId: f.project.id })).status, 'running');
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(f.requests.length, 4);
  release(); assert.equal((await settled(f)).status, 'paused');
  assert.equal(f.requests.length, 4);
  const units = (await f.service.listText({ projectId: f.project.id })).units;
  assert.ok(units.some(unit => unit.status === 'translated'));
  assert.ok(units.some(unit => unit.status === 'pending'));
  assert.ok(units.every(unit => unit.status !== 'skipped'));
});

test('host evidence content, not changing offsets or notes, determines reading progress', async t => {
  for (const distinct of [false, true]) {
    const raw = rows().map(({ translation, revision, ...unit }) => ({ ...unit, context: { ...unit.context,
      references: Array.from({ length: 6 }, (_, index) => distinct ? `Actual host evidence ${index}` : 'The same actual host evidence') } }));
    const f = await nativeFixture(t, { raw, unavailable: false, respond: (response, input, index) => {
      start(response);
      chunk(response, index <= 6 ? `[附加信息]\n${JSON.stringify({ read: [{ evidence: { unitId: 'u1', section: 'references' }, offset: index - 1, limit: 1 }], notes: `Changed note ${index}` })}`
        : '[u1]\n完成一 {{CTRL_0}}\n[u2]\n完成二 {{CTRL_0}}\n[完成]');
      finish(response);
    } });
    await f.service.startProject({ projectId: f.project.id });
    const result = await settled(f);
    assert.equal(result.status, distinct ? 'completed' : 'paused', result.lastError);
    assert.equal(f.requests.length, distinct ? 7 : 4);
  }
});

test('a late duplicate revokes only its ambiguous saved candidate before pause and local recovery', async t => {
  for (const afterCompletion of [false, true]) {
    let failure;
    const raw = [...rows(), { ...rows()[1], id: 'canonical-private-2', source: 'Alice enters room 2. {{CTRL_0}}' }]
      .map(({ translation, revision, ...unit }) => unit);
    const f = await nativeFixture(t, { raw, unavailable: false,
      onFailure: async error => { failure = error; await f.service.pauseProject({ projectId: f.project.id }); },
      respond: async (response, input, index) => {
        start(response);
        if (index === 1) {
          chunk(response, `${block('u1', '歧义首选 {{CTRL_0}}')}\n[u2]\n`);
          chunk(response, `独立候选 {{CTRL_0}}\n[u3]\n${afterCompletion ? '独立房间2。{{CTRL_0}}\n[完成]\n' : '未完成'}`);
          await new Promise(resolve => setTimeout(resolve, 25));
          assert.ok(!f.tasks().some(task => task.candidateRecords?.length), 'A late duplicate must be diagnosed before any admission');
          chunk(response, `\n${block('u1', '歧义次选 {{CTRL_0}}')}\n[完成]`);
        } else chunk(response, `${block('u1', '重新确认 {{CTRL_0}}')}${afterCompletion ? `\n${block('u2', '重新独立候选 {{CTRL_0}}')}` : ''}\n${block('u3', '补齐房间2。{{CTRL_0}}')}\n[完成]`);
        finish(response);
      } });
    await f.service.startProject({ projectId: f.project.id });
    await eventually(() => f.tasks().some(task => task.requestHistory?.at(-1)?.status === 'cancelled' && task.status === 'paused'));
    const saved = f.tasks().find(task => task.textWireState), table = new Map(saved.textWireState.entries);
    assert.equal(failure.code, 'INVALID_RESPONSE');
    assert.deepEqual(new Set(failure.invalidatedIds), new Set((afterCompletion ? ['u1', 'u2', 'u3'] : ['u1']).map(ref => table.get(ref))));
    assert.deepEqual(new Set((saved.candidateRecords ?? []).map(record => record.id)), new Set((afterCompletion ? [] : ['u2']).map(ref => table.get(ref))));
    assert.equal(f.requests.length, 1);
    await f.reopen(); await f.service.startProject({ projectId: f.project.id });
    const done = await settled(f); assert.equal(done.status, 'completed', done.lastError); assert.equal(f.requests.length, 2);
    assert.deepEqual(new Set(f.materials[1].payload.units.map(unit => unit.id)),
      new Set((afterCompletion ? ['u1', 'u2', 'u3'] : ['u1', 'u3']).map(ref => table.get(ref))));
    const final = (await f.service.listText({ projectId: f.project.id })).units;
    assert.equal(final.find(unit => unit.id === table.get('u1')).translation, '重新确认 {{CTRL_0}}');
    assert.equal(final.find(unit => unit.id === table.get('u2')).translation, afterCompletion ? '重新独立候选 {{CTRL_0}}' : '独立候选 {{CTRL_0}}');
    assert.equal(final.find(unit => unit.id === table.get('u3')).translation, '补齐房间2。{{CTRL_0}}');
    assert.ok(final.every(unit => unit.status === 'translated'));
  }
});
