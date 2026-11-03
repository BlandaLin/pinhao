import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { sdkProvider, taskPrompt } from './provider.mjs';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { sha256, validateTranslation } from '../exchange/index.mjs';

// All prefixes and deliveries are original neutral fixtures, not customer material
// or evidence about any real model's output.
const prefixes = [
  '我会先阅读全部材料，再按要求依次整理。\n\n',
  '这份材料围绕社区阅览室的开放时间展开。志愿者正在向初次到访的读者介绍书架位置、借阅步骤和归还方式。为便于阅读，可以先概括场景，再按原顺序处理后面的完整文字。以下是逐项整理后的内容：\n\n',
];
const raw = [0, 1].map(i => ({ id: `neutral-delivery-${i}`, source: `Traveler enters room ${i}. {{CTRL_0}}`,
  kind: 'dialogue', tokens: ['{{CTRL_0}}'], context: { speaker: 'Traveler', file: 'neutral-scene.json',
    sceneId: 'neutral-scene', controlBindings: { '{{CTRL_0}}': 'Pause' } } }));
const block = (ref, text = '旅人进入房间。{{CTRL_0}}') => `[${ref}]\n${text}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(read) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await wait(15); }
  throw new Error('Neutral delivery acceptance did not settle');
}
function send(response, text, reason = null, usage) {
  response.write(`data: ${JSON.stringify({ id: 'neutral-delivery', choices: [{ index: 0,
    delta: text === undefined ? {} : { content: text }, finish_reason: reason }], ...(usage ? { usage } : {}) })}\n\n`);
}
function finish(response, reason = 'stop') {
  send(response, undefined, reason, { prompt_tokens: 31, completion_tokens: 47, total_tokens: 78 });
  response.end('data: [DONE]\n\n');
}
async function endpoint(t, respond) {
  const requests = [], errors = [];
  const server = http.createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) text += chunk;
      requests.push(JSON.parse(text)); response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      await respond(response, requests.length, requests.at(-1));
    } catch (error) { errors.push(error); response.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(errors, []); });
  return { requests, connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'neutral-delivery' } };
}
async function fixture(t, respond, { proofreading = false, pauseFailure = true, units = raw } = {}) {
  const parent = path.resolve('local/text-delivery-acceptance'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'case-')), dataDir = path.join(root, 'data'), gameDir = path.join(root, 'game');
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'original.txt'), 'neutral original');
  const events = [], failures = [], materials = []; let service, samples = 0;
  const worker = async (command, args) => {
    if (command === 'probe') return { engine: 'MV' };
    if (command === 'extract') { await mkdir(args.workspaceDir, { recursive: true }); return { units, workspaceDir: args.workspaceDir, sourceFingerprint: sha256(units) }; }
    if (['roundtrip', 'validate'].includes(command)) return { ok: true };
    if (command === 'build') { if (args.outputDir.includes(`${path.sep}samples${path.sep}`)) samples++;
      await mkdir(args.outputDir, { recursive: true }); return { buildDir: args.outputDir }; }
    if (command === 'assemble') { await mkdir(args.outputDir, { recursive: true }); return { outputDir: args.outputDir }; }
    throw new Error(`Unexpected fixture worker command ${command}`);
  };
  const local = await endpoint(t, (response, index, input) => respond(response, index,
    materials.find(wire => wire.prompt === input.messages.at(-1).content)));
  service = await createService({ dataDir, worker, scriptTools: null,
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral native fixture' }),
    provider: async args => {
      materials.push(args.wire);
      try { return await sdkProvider({ ...args,
        onTransport: async event => { events.push(event); await args.onTransport?.(event); } }); }
      catch (error) { failures.push(error); if (pauseFailure) await service.pauseProject({ projectId: project.id }); throw error; }
    } });
  t.after(async () => { await service.close(); assert.ok(root.startsWith(`${parent}${path.sep}`)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); });
  await service.saveSettings({ ...defaultSettings(), connection: local.connection, concurrency: 2, proofreading });
  const project = await service.createProject({ gameDir });
  const tasks = () => { const store = createStore(dataDir); try { return store.tasks(project.id); } finally { store.close(); } };
  return { ...local, service, project, tasks, events, failures, materials, gameDir, get samples() { return samples; } };
}
async function settle(f) {
  return eventually(async () => { const project = await f.service.getProject({ projectId: f.project.id });
    return ['completed', 'paused'].includes(project.status)
      && f.tasks().every(task => (task.requestHistory ?? []).every(request => request.finishedAt)) && project; });
}
async function artifacts(f) {
  const histories = f.tasks().flatMap(task => task.requestHistory ?? []);
  return Promise.all(histories.map(async history => {
    // Task results are durable before the accounting artifact is finalized.
    const result = await eventually(async () => {
      try { return JSON.parse(await readFile(path.join(history.artifact.directory, 'result.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    });
    return { history, result, body: await readFile(path.join(history.artifact.directory, 'final.txt'), 'utf8') };
  }));
}
for (const [index, prefix] of prefixes.entries()) test(`synthetic prefix ${index + 1} plus delayed neutral tail reaches service/D2 and accounting`, async t => {
  let ended = false;
  const f = await fixture(t, async response => {
    send(response, prefix); await wait(60);
    send(response, `${block('u1')}\n${block('u2')}\n[完成]\n[附加信息]\n${JSON.stringify({ terms: [['u1', 'Traveler', '旅人']], notes: 'Neutral synthetic reading note.' })}`);
    ended = true; finish(response);
  });
  await f.service.startProject({ projectId: f.project.id }); const project = await settle(f);
  assert.equal(project.status, 'completed', JSON.stringify({ lastError: project.lastError, failures: f.failures.map(error => ({ message: error.message, stack: error.stack })) })); assert.equal(ended, true);
  assert.equal(f.requests.length, 1); assert.equal(f.failures.length, 0); assert.ok(f.samples > 0, 'Native D2 sample remains required');
  const units = (await f.service.listText({ projectId: f.project.id })).units;
  for (const unit of units) { assert.equal(unit.status, 'translated'); validateTranslation(unit, unit.translation); }
  const saved = await artifacts(f); assert.equal(saved.length, 1); assert.ok(saved[0].body.startsWith(prefix));
  assert.match(saved[0].body, /\[完成\]/); assert.equal(saved[0].result.summary.usage.promptTokens, 31);
  assert.equal(saved[0].result.summary.usage.outputTokens ?? saved[0].result.summary.usage.completionTokens, 47);
  assert.ok(f.events.some(event => event.type === 'body-end'));
  assert.equal(saved[0].result.summary.finishReason, 'stop');
  assert.ok(f.events.some(event => event.type === 'raw-chunk' && event.text.includes('"finish_reason":"stop"')));
  assert.equal(await readFile(path.join(f.gameDir, 'original.txt'), 'utf8'), 'neutral original');
});

for (const [name, output] of [
  ['prefix 1 only', prefixes[0]],
  ['prefix 2 only', prefixes[1]],
  ['late duplicate', `${block('u1')}\n${block('u2')}\n${block('u1', '另一版 {{CTRL_0}}')}\n[完成]`],
  ['second delivery', `${block('u1')}\n${block('u2')}\n[完成]\n${block('u1', '第二份 {{CTRL_0}}')}\n[完成]`],
]) test(`${name} drains usage/artifacts without promoting an ambiguous target`, async t => {
  const f = await fixture(t, async response => { send(response, output); await wait(40); finish(response); });
  await f.service.startProject({ projectId: f.project.id }); await settle(f);
  assert.equal(f.requests.length, 1); assert.equal(f.failures.length, 1);
  const saved = await artifacts(f); assert.equal(saved[0].body, output);
  assert.equal(saved[0].result.summary.usage.promptTokens, 31);
  assert.ok(f.events.some(event => event.type === 'body-end'));
  const units = (await f.service.listText({ projectId: f.project.id })).units;
  const firstId = new Map(f.materials[0].state.entries).get('u1');
  assert.ok(units.some(unit => unit.id === firstId), 'The actual first target must remain inspectable');
  const first = units.find(unit => unit.id === firstId);
  assert.equal(first.translation, first.source, 'Duplicate/absent first target must retain its original placeholder');
  assert.notEqual(first.status, 'translated');
});

test('zero-change proofreading traverses service with explicit completion and no invented edits', async t => {
  const f = await fixture(t, (response, _index, wire) => {
    send(response, wire.review ? '[完成]' : `${block('u1')}\n${block('u2')}\n[完成]`); finish(response);
  }, { proofreading: true });
  await f.service.startProject({ projectId: f.project.id }); const project = await settle(f);
  assert.equal(project.status, 'completed', JSON.stringify({ lastError: project.lastError, failures: f.failures.map(error => ({ message: error.message, stack: error.stack })) }));
  assert.ok(f.materials.some(wire => wire.review)); assert.equal(f.failures.length, 0);
  assert.ok((await artifacts(f)).every(item => item.result.summary.usage.promptTokens === 31));
  for (const unit of (await f.service.listText({ projectId: f.project.id })).units) assert.equal(unit.translation, '旅人进入房间。{{CTRL_0}}');
});

for (const reason of ['length', 'disconnect']) test(`${reason} terminal retains only closed blocks through service`, async t => {
  const f = await fixture(t, response => {
    send(response, `${block('u1')}\n[u2]\nunfinished`);
    if (reason === 'length') finish(response, 'length'); else response.end();
  });
  await f.service.startProject({ projectId: f.project.id }); await settle(f);
  assert.equal(f.requests.length, 1); assert.equal(f.failures.length, 1);
  const table = new Map(f.materials[0].state.entries), firstId = table.get('u1'), secondId = table.get('u2');
  assert.deepEqual(f.failures[0].completedRecords.map(row => row.id), [firstId]);
  const tasks = f.tasks(); assert.ok(tasks.some(task => task.candidateRecords?.some(row => row.id === firstId)));
  assert.ok(!tasks.some(task => task.candidateRecords?.some(row => row.id === secondId)));
  assert.match((await artifacts(f))[0].body, /unfinished$/);
});

test('readonly markers are not delivered, while auxiliary lexical arrays preserve paid text', async t => {
  const prompt = taskPrompt('translation', [raw[0]], 'zh-Hans', [raw[1]]);
  const outputs = [`${block('u2')}\n[完成]`, `${block('u1')}\n[完成]\n[附加信息]\n{\n"terms": [\n["u1","Traveler","旅人"]\n]\n}`];
  const local = await endpoint(t, (response, index) => { send(response, outputs[index - 1]); finish(response); });
  await assert.rejects(sdkProvider({ ...prompt, connection: local.connection }), error => error.code === 'INVALID_RESPONSE');
  const result = await sdkProvider({ ...prompt, connection: local.connection });
  assert.equal(result.records[0].id, raw[0].id); assert.equal(result.records[0].termChoices[0].translation, '旅人');
  assert.equal(result.usage.outputTokens, 47); assert.equal(local.requests.length, 2);
});

test('two SDK responses overlap until terminal admission instead of serializing receive/parse', async t => {
  let live = 0, maximum = 0, release;
  const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const local = await endpoint(t, async response => {
    maximum = Math.max(maximum, ++live); if (live === 2) release();
    send(response, prefixes[0]); await gate; send(response, `${block('u1')}\n[完成]`); finish(response); live--;
  });
  const prompt = taskPrompt('translation', [raw[0]], 'zh-Hans');
  const results = await Promise.all([0, 1].map(() => sdkProvider({ ...prompt, connection: local.connection, signal: AbortSignal.timeout(5000) })));
  assert.equal(maximum, 2); assert.equal(local.requests.length, 2); assert.ok(results.every(result => result.records.length === 1));
});

test('after native sample validation service keeps two requests concurrent and accepts both', async t => {
  let live = 0, maximum = 0, release;
  const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  // Three complete units force separate requests under the declared 4096-output budget.
  // The first completes the real native sample gate; only the following two use a barrier.
  const units = [0, 1, 2].map(index => ({ ...raw[0], id: `neutral-concurrent-${index}`,
    source: `Traveler enters room ${index}. `.repeat(200) + '{{CTRL_0}}',
    context: { ...raw[0].context, sceneId: `neutral-scene-${index}` } }));
  const f = await fixture(t, async (response, index, wire) => {
    maximum = Math.max(maximum, ++live); if (live === 2) release();
    send(response, prefixes[0]);
    if (index > 1) {
      let timer;
      try { await Promise.race([gate, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Service serialized two available tasks')), 5000); timer.unref(); })]); }
      finally { clearTimeout(timer); }
    }
    const targets = new Set(wire.targetIds);
    send(response, `${wire.state.entries.filter(([, id]) => targets.has(id)).map(([ref]) => block(ref)).join('\n')}\n[完成]`);
    finish(response); live--;
  }, { units });
  await f.service.startProject({ projectId: f.project.id }); const project = await settle(f);
  assert.equal(project.status, 'completed', project.lastError); assert.equal(maximum, 2);
  assert.equal(f.requests.length, 3); assert.equal(f.failures.length, 0); assert.ok(f.samples > 0);
  assert.ok((await f.service.listText({ projectId: f.project.id })).units.every(unit => unit.status === 'translated'));
  assert.equal((await artifacts(f)).filter(item => item.result.summary.usage.promptTokens === 31).length, 3);
});
