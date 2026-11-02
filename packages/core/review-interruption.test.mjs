import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sdkProvider, taskPrompt, liveRequestSlots } from './provider.mjs';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { sha256 } from '../exchange/index.mjs';

const sampleRows = (count = 3) => Array.from({ length: count }, (_, index) => ({
  id: `review-target-${index}`, source: `A complete sentence ${index}. {{CTRL_0}}`,
  translation: `原译 ${index} {{CTRL_0}}`, revision: 4, kind: 'dialogue', tokens: ['{{CTRL_0}}'],
  context: { file: 'scene.json', event: 1, page: 0 },
}));
const refFor = (wire, id) => wire.state.entries.find(([, value]) => value === id)[0];
const block = (ref, text) => `[${ref}]\n${text}\n`;
function start(response) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); }
function chunk(response, content, reason = null, usage) {
  response.write(`data: ${JSON.stringify({ id: 'neutral-review', choices: [{ index: 0,
    delta: content === undefined ? {} : { content }, finish_reason: reason }], ...(usage ? { usage } : {}) })}\n\n`);
}
function finish(response, reason = 'stop') {
  chunk(response, undefined, reason, { prompt_tokens: 31, completion_tokens: 29, total_tokens: 60 });
  response.end('data: [DONE]\n\n');
}
async function endpoint(t, respond) {
  const requests = [], failures = [];
  const server = http.createServer(async (request, response) => {
    try {
      let raw = ''; for await (const part of request) raw += part;
      requests.push(JSON.parse(raw)); await respond(response, requests.length);
    } catch (error) { failures.push(error); response.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.deepEqual(failures, [], 'The local server must not hide failed assertions');
  });
  return { requests, connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'neutral-review' } };
}
async function until(read) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Neutral review flow did not settle');
}

for (const ending of ['length', 'disconnect']) test(`interrupted review retains only closed explicit edits: ${ending}`, async t => {
  const units = sampleRows(), prompt = taskPrompt('proofreading', units, 'zh-Hans', [], [], { reviewProtocol: true });
  const [a, b] = units.map(unit => refFor(prompt.wire, unit.id));
  const { connection, requests } = await endpoint(t, response => {
    start(response); chunk(response, `${block(a, '完整改文 {{CTRL_0}}')}[${b}]\n未结束的最后一块`);
    if (ending === 'disconnect') response.end(); else finish(response, ending);
  });
  const streamed = [];
  await assert.rejects(sdkProvider({ connection, ...prompt, onRecords: rows => streamed.push(...rows) }), error => {
    assert.equal(error.code, ending === 'length' ? 'MODEL_OUTPUT_TRUNCATED' : 'ECONNRESET');
    assert.deepEqual(error.partialReview.reviewedIds, [units[0].id]);
    assert.deepEqual(error.partialReview.edits.map(({ id, translation }) => ({ id, translation })),
      [{ id: units[0].id, translation: '完整改文 {{CTRL_0}}' }]);
    assert.deepEqual(error.completedIds, [units[0].id]);
    if (ending === 'length') assert.equal(error.usage.outputTokens, 29);
    return true;
  });
  assert.deepEqual(streamed, [], 'Review edits are not translation checkpoints or final commits');
  assert.equal(requests.length, 1); assert.equal(liveRequestSlots(), 0);
});

test('a late duplicate revokes only that explicit edit and never attests omitted targets', async t => {
  const units = sampleRows(), prompt = taskPrompt('proofreading', units, 'zh-Hans', [], [], { reviewProtocol: true });
  const [a, b] = units.map(unit => refFor(prompt.wire, unit.id));
  const { connection } = await endpoint(t, response => {
    start(response); chunk(response, `${block(a, '有歧义 {{CTRL_0}}')}${block(b, '独立改文 {{CTRL_0}}')}[完成]\n[${a}]\n重复`);
    finish(response);
  });
  await assert.rejects(sdkProvider({ connection, ...prompt }), error => {
    assert.equal(error.code, 'INVALID_RESPONSE'); assert.deepEqual(error.invalidatedIds, [units[0].id]);
    assert.deepEqual(error.partialReview.reviewedIds, [units[1].id]);
    assert.ok(!error.partialReview.reviewedIds.includes(units[2].id)); return true;
  });
});

test('truncated optional metadata does not discard an explicit closed review edit', async t => {
  const units = sampleRows(), prompt = taskPrompt('proofreading', units, 'zh-Hans', [], [], { reviewProtocol: true });
  const a = refFor(prompt.wire, units[0].id);
  const { connection } = await endpoint(t, response => {
    start(response); chunk(response, `${block(a, '有效改文 {{CTRL_0}}')}[完成]\n[附加信息]\n{"remarks": [`);
    finish(response, 'length');
  });
  await assert.rejects(sdkProvider({ connection, ...prompt }), error => {
    assert.deepEqual(error.partialReview.reviewedIds, [units[0].id]); return true;
  });
});

for (const reason of ['content_filter', 'evidence']) test(`refusal or evidence-seeking review does not attest provisional edits: ${reason}`, async t => {
  const units = sampleRows(), prompt = taskPrompt('proofreading', units, 'zh-Hans', [], [], { reviewProtocol: true });
  const a = refFor(prompt.wire, units[0].id);
  const { connection } = await endpoint(t, response => {
    start(response); chunk(response, `${block(a, '待定改文 {{CTRL_0}}')}[完成]\n${reason === 'evidence'
      ? `[附加信息]\n${JSON.stringify({ read: [{ ids: [a], reason: 'Need the full source first' }] })}` : ''}`);
    finish(response, reason === 'evidence' ? 'length' : reason);
  });
  await assert.rejects(sdkProvider({ connection, ...prompt }), error => {
    assert.equal(error.partialReview, undefined); assert.deepEqual(error.completedIds, []); return true;
  });
});

async function serviceFixture(t, { initialOutput, subsequentOutput, initialEnding } = {}) {
  const localRoot = path.resolve('local/review-interruption-tests'); await mkdir(localRoot, { recursive: true });
  const root = await mkdtemp(path.join(localRoot, 'neutral-')), dataDir = path.join(root, 'data'), gameDir = path.join(root, 'original');
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'original.txt'), 'unchanged neutral original');
  const raw = sampleRows(5).map(({ revision, translation, ...unit }) => unit);
  raw[1].context.syncGroup = raw[2].context.syncGroup = 'neutral-linked-display';
  const worker = async (command, args) => {
    if (command === 'probe') return { engine: 'MZ' };
    if (command === 'extract') { await mkdir(args.workspaceDir, { recursive: true }); return { units: raw, workspaceDir: args.workspaceDir, sourceFingerprint: sha256(raw) }; }
    if (['roundtrip', 'validate'].includes(command)) return { ok: true };
    if (command === 'build') { await mkdir(args.outputDir, { recursive: true }); return { buildDir: args.outputDir }; }
    if (command === 'assemble') { await mkdir(args.outputDir, { recursive: true }); return { outputDir: args.outputDir }; }
    throw new Error(`Unexpected neutral worker command ${command}`);
  };
  let service, latestWire, firstWire, received = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const materials = [];
  const { connection, requests } = await endpoint(t, async (response, index) => {
    const wire = latestWire; start(response);
    if (index === 1) {
      const refs = raw.map(source => refFor(wire, wire.payload.units.find(unit => unit.source === source.source).id));
      const output = initialOutput?.(refs) ?? block(refs[0], '保留独立修改零 {{CTRL_0}}') + block(refs[1], '重复关联修改 {{CTRL_0}}')
        + block(refs[3], '这条故意漏控制符') + block(refs[4], '保留独立修改四 {{CTRL_0}}')
        + `[完成]\n[${refs[1]}]\n重复不能接纳`;
      chunk(response, output);
      if (initialEnding) finish(response, initialEnding); else await gate;
    } else { chunk(response, subsequentOutput?.(wire) ?? wire.payload.units.map(unit => block(refFor(wire, unit.id),
      unit.context?.syncGroup ? '完整关联修改 {{CTRL_0}}' : '有效修订 {{CTRL_0}}')).join('') + '[完成]'); finish(response); }
  });
  const open = () => createService({ dataDir, worker, scriptTools: null,
    provider: args => {
      latestWire = args.wire; firstWire ??= args.wire; materials.push(args.wire);
      return sdkProvider({ ...args, onProgress: async value => { await args.onProgress?.(value); received = true; } });
    } });
  t.after(async () => { release(); await service?.close(); assert.ok(root.startsWith(`${localRoot}${path.sep}`));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }); });
  service = await open(); await service.saveSettings({ ...defaultSettings(), connection, concurrency: 1 });
  const project = await service.createProject({ gameDir });
  const units = (await service.listText({ projectId: project.id })).units;
  const savedGroups = new Set();
  for (const unit of units) {
    if (unit.context.syncGroup && savedGroups.has(unit.context.syncGroup)) continue;
    if (unit.context.syncGroup) savedGroups.add(unit.context.syncGroup);
    await service.saveText({ projectId: project.id, unitId: unit.id,
      translation: `初译 ${unit.context.syncGroup ? '关联' : unit.id} {{CTRL_0}}`, notes: '', expectedRevision: unit.revision });
  }
  return { project, units, materials, requests, dataDir, get service() { return service; }, get received() { return received; }, get firstWire() { return firstWire; },
    async reopen() { await service.close(); service = await open(); }, release };
}

test('normal service saves independent explicit review edits on pause and resumes only the unresolved group and invalid text', async t => {
  const f = await serviceFixture(t);
  await f.service.startProject({ projectId: f.project.id, mode: 'proofreading' });
  await until(() => f.received);
  await f.service.pauseProject({ projectId: f.project.id });
  await until(async () => (await f.service.getProject({ projectId: f.project.id })).runtime.active === 0);
  const original = (await f.service.listText({ projectId: f.project.id })).units;
  assert.ok(original.every(unit => unit.translation.startsWith('初译')), 'D2 formal text is unchanged while paused');
  const saved = await f.service.listText({ projectId: f.project.id, filter: 'reviewed' });
  assert.equal(saved.total, 2, JSON.stringify({ saved: saved.units.map(unit => [unit.id, unit.translation]),
    sent: f.firstWire.payload.units.map(unit => [unit.id, unit.context?.syncGroup]) })); assert.equal(saved.sceneReview.committed, false);
  assert.deepEqual(saved.units.map(unit => unit.id), [f.units[0].id, f.units[4].id]);
  const store = createStore(f.dataDir);
  try {
    const task = store.tasks(f.project.id).find(task => task.reviewStage === 'scene');
    assert.deepEqual(task.reviewedUnitIds, saved.units.map(unit => unit.id));
    assert.deepEqual(task.candidateRecords.map(record => record.id), saved.units.map(unit => unit.id));
    assert.equal(task.status, 'paused'); assert.ok(task.requestHistory[0].artifact.finalBodyCaptured);
  } finally { store.close(); }
  await f.reopen(); f.release();
  await f.service.startProject({ projectId: f.project.id, mode: 'proofreading' });
  await until(async () => (await f.service.getProject({ projectId: f.project.id })).status === 'completed');
  const resumed = f.materials.slice(1).filter(wire => wire.payload.reviewScope?.stage === 'scene');
  assert.deepEqual([...new Set(resumed.flatMap(wire => wire.targetIds))].sort(), [f.units[1].id, f.units[2].id, f.units[3].id].sort());
  for (const wire of resumed) for (const id of wire.targetIds) assert.equal(refFor(wire, id), refFor(f.firstWire, id), 'Resume keeps the frozen short-marker map');
  assert.ok(resumed[0].payload.referenceOnly.some(unit => unit.id === f.units[0].id && unit.currentTranslation === '保留独立修改零 {{CTRL_0}}'),
    'Saved revisions are available as read-only context, not repurchased targets');
  const final = (await f.service.listText({ projectId: f.project.id })).units;
  assert.ok(final.every(unit => unit.status === 'proofread'));
  assert.equal(final[0].translation, '保留独立修改零 {{CTRL_0}}');
  assert.equal(final[4].translation, '保留独立修改四 {{CTRL_0}}');
  assert.equal(final[1].translation, final[2].translation);
  assert.ok(final[3].translation.includes('{{CTRL_0}}')); assert.equal(liveRequestSlots(), 0);
});

test('an interrupted review preserves a fully closed consistent display group but not its open tail', async t => {
  const f = await serviceFixture(t, { initialOutput: refs => block(refs[0], '独立改文 {{CTRL_0}}')
    + block(refs[1], '整组已改 {{CTRL_0}}') + block(refs[2], '整组已改 {{CTRL_0}}') + `[${refs[3]}]\n未完` });
  await f.service.startProject({ projectId: f.project.id, mode: 'proofreading' });
  await until(() => f.received); await f.service.pauseProject({ projectId: f.project.id });
  await until(async () => (await f.service.getProject({ projectId: f.project.id })).runtime.active === 0);
  const saved = await f.service.listText({ projectId: f.project.id, filter: 'reviewed' });
  assert.deepEqual(saved.units.map(unit => unit.id), f.units.slice(0, 3).map(unit => unit.id));
  assert.equal(saved.units[1].translation, saved.units[2].translation);
  assert.ok((await f.service.listText({ projectId: f.project.id })).units.every(unit => unit.translation.startsWith('初译')));
});

test('normal service automatically retries a length-truncated review without rebuying its valid explicit edit', async t => {
  const f = await serviceFixture(t, { initialEnding: 'length', initialOutput: refs => block(refs[0], '已保存截断前改文 {{CTRL_0}}')
    + `[${refs[1]}]\n未结束关联文字` });
  await f.service.startProject({ projectId: f.project.id, mode: 'proofreading' });
  await until(async () => (await f.service.getProject({ projectId: f.project.id })).status === 'completed');
  assert.ok(f.materials.length >= 2);
  assert.ok(f.materials.slice(1).every(wire => !wire.targetIds.includes(f.units[0].id)), 'The closed edit is not requested again after truncation');
  const final = (await f.service.listText({ projectId: f.project.id })).units;
  assert.equal(final[0].translation, '已保存截断前改文 {{CTRL_0}}'); assert.ok(final.every(unit => unit.status === 'proofread'));
});

test('an explicit needs-evidence question still blocks its interrupted edit without attesting other questioned targets', async t => {
  const f = await serviceFixture(t, { initialOutput: refs => block(refs[0], '独立有效 {{CTRL_0}}') + block(refs[4], '仍需证据 {{CTRL_0}}')
    + `[完成]\n[附加信息]\n${JSON.stringify({ questions: [[refs[4], 'needs_evidence', '身份仍需核实'],
      [refs[3], 'source_ambiguity', '没有交付改文的条目不能由中断回复确认']] })}` });
  await f.service.startProject({ projectId: f.project.id, mode: 'proofreading' });
  await until(() => f.received); await f.service.pauseProject({ projectId: f.project.id });
  await until(async () => (await f.service.getProject({ projectId: f.project.id })).runtime.active === 0);
  const saved = await f.service.listText({ projectId: f.project.id, filter: 'reviewed' });
  assert.deepEqual(saved.units.map(unit => unit.id), [f.units[0].id]);
});

test('a manual revision after interrupted review invalidates the old frozen candidate before D2 commit', async t => {
  const f = await serviceFixture(t, { subsequentOutput: () => '[完成]' });
  await f.service.startProject({ projectId: f.project.id, mode: 'proofreading' });
  await until(() => f.received); await f.service.pauseProject({ projectId: f.project.id });
  await until(async () => (await f.service.getProject({ projectId: f.project.id })).runtime.active === 0);
  const saved = await f.service.listText({ projectId: f.project.id, filter: 'reviewed' }); assert.equal(saved.total, 2);
  const original = (await f.service.listText({ projectId: f.project.id })).units[0];
  await f.service.saveText({ projectId: f.project.id, unitId: original.id, translation: '用户新修订 {{CTRL_0}}',
    notes: '保留用户的新备注', expectedRevision: original.revision });
  assert.equal((await f.service.listText({ projectId: f.project.id, filter: 'reviewed' })).total, 0,
    'A changed frozen scene cannot expose the old edit as current review evidence');
  await f.reopen(); f.release(); await f.service.startProject({ projectId: f.project.id, mode: 'proofreading' });
  await until(async () => (await f.service.getProject({ projectId: f.project.id })).status === 'completed');
  const final = (await f.service.listText({ projectId: f.project.id })).units.find(unit => unit.id === original.id);
  assert.equal(final.translation, '用户新修订 {{CTRL_0}}'); assert.equal(final.notes, '保留用户的新备注');
  assert.ok(final.revision > original.revision);
});
