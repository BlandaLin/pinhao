import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createEvidenceStore } from './evidence.mjs';
import { createSessionControl } from './session-control.mjs';
import { createAdapterLab } from './adapter-lab.mjs';
import { adaptationTools } from '../adaptation.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(process.env.PINHAO_TEST_TMP ?? os.tmpdir(), 'pinhao-session-control-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const gameDir = path.join(root, 'game'), workspaceDir = path.join(root, 'work');
  await mkdir(path.join(gameDir, 'data'), { recursive: true }); await mkdir(workspaceDir);
  await writeFile(path.join(gameDir, 'data/story.json'), '{"text":"Caption."}');
  await writeFile(path.join(gameDir, 'consumer.js'), 'function show(text) { return text; }');
  const state = { id: 'neutral-session', executionWindow: 1, events: [] }, snapshots = [], evidence = createEvidenceStore(workspaceDir);
  const args = { state, project: { id: 'neutral-project' }, assignment: { id: 'resource', files: ['data/story.json', 'consumer.js'] },
    gameDir, readDir: gameDir, workspaceDir, evidence, persist: async value => { snapshots.push(structuredClone(value)); await writeFile(path.join(root, 'state.json'), JSON.stringify(value)); } };
  const session = createSessionControl(args); let serial = 0;
  const call = async (tool, input, output) => {
    const operation = await session.begin(tool, input, { toolCallId: `call-${++serial}` });
    return session.finish(operation, input, output, (await evidence.save(output)).evidenceId);
  };
  const read = async (file, input = {}) => {
    const content = await readFile(path.join(gameDir, file), 'utf8'), size = Buffer.byteLength(content);
    return call('read_resource', { file, ...input }, { content, returnedBytes: size, totalBytes: size, offset: 0 });
  };
  const present = async (receipts, control = session, request = `sent-${++serial}`) => control.modelPresented({ modelRequestId: request,
    messages: await Promise.all(receipts.map(async receipt => ({ role: 'tool', content: JSON.stringify({ ...(await evidence.load(receipt.outputEvidenceId)).value,
      evidenceId: receipt.outputEvidenceId, receiptId: receipt.receiptId }) }))) });
  return { root, gameDir, workspaceDir, state, snapshots, evidence, args, session, call, read, present };
}

test('completed receipts restore beyond a started snapshot without minting duplicate material', async t => {
  const f = await fixture(t), input = { file: 'data/story.json' };
  const operation = await f.session.begin('read_resource', input, { toolCallId: 'durable-read' });
  await f.session.checkpoint();
  const previous = structuredClone(f.snapshots.at(-1));
  assert.equal(Object.keys(previous.pendingOperations).length, 1);
  const content = await readFile(path.join(f.gameDir, input.file), 'utf8');
  const receipt = await f.session.finish(operation, input, { content, returnedBytes: Buffer.byteLength(content), totalBytes: Buffer.byteLength(content) },
    (await f.evidence.save({ content })).evidenceId);
  assert.equal(f.state.control.materialSerial, 0, 'capture/prepare is not an actual model send');
  await f.present([receipt]);
  const restored = createSessionControl({ ...f.args, state: previous });
  await restored.restore();
  assert.equal(previous.control.materialSerial, 1); assert.equal(Object.keys(previous.pendingOperations).length, 0);
  const before = previous.control.materialSerial;
  await restored.restore(); assert.equal(previous.control.materialSerial, before);
  assert.equal((await f.evidence.readReceipts()).lastSeq, 4);
});

test('default and explicit source roots merge actual ranges while changed stdout stays only activity', async t => {
  const f = await fixture(t);
  const first = await f.read('data/story.json'), second = await f.read('data/story.json', { root: 'source', length: 900 });
  assert.equal(f.state.control.materialSerial, 0);
  await f.present([first, second]);
  assert.equal(f.state.control.materialSerial, 1);
  for (let index = 0; index < 3; index++) await f.call('wait_run', { runId: `process-${index}` },
    { runId: `process-${index}`, status: 'completed', exitCode: 0, codeHash: digest(String(index)), content: `different output ${index}` });
  assert.equal(f.state.control.materialSerial, 1); assert.equal(f.state.control.activity, 5);
});

test('actual lab content-addressed candidates keep one first-candidate milestone across code variants', async t => {
  const f = await fixture(t), lab = await createAdapterLab({ dataDir: path.join(f.root, 'lab') });
  const manifest = { schemaVersion: 1, id: 'neutral-caption', version: '1.0.0', engine: 'MV', license: 'GPL-3.0-or-later', scope: { files: ['data/story.json'] } };
  const code = '({detect(){return true},extract(){return {units:[]}},validate(){return true},roundtrip(){return {}},build(){return {}},assemble(){return {}}})';
  const first = await lab.writeAdapter({ manifest, code }), same = await lab.writeAdapter({ manifest, code }), other = await lab.writeAdapter({ manifest, code: code + '\n// neutral variant' });
  assert.equal(first.candidateId, same.candidateId); assert.notEqual(first.candidateId, other.candidateId);
  for (const [candidate, text] of [[first, code], [same, code], [other, code + '\n// neutral variant']]) await f.call('write_adapter', { manifest, code: text }, candidate);
  assert.equal(f.state.control.materialSerial, 1);
  assert.equal(Object.values(f.state.workItems).length, 1);
});

test('candidate-to-item ownership survives completion replay before a later validation', async t => {
  const f = await fixture(t), input = { manifest: { scope: { files: ['data/story.json'] } }, code: 'neutral body' };
  const operation = await f.session.begin('write_adapter', input, { toolCallId: 'candidate-call' });
  await f.session.checkpoint();
  const previous = structuredClone(f.snapshots.at(-1)), output = { candidateId: 'candidate-content-hash' };
  await f.session.finish(operation, input, output, (await f.evidence.save(output)).evidenceId);
  await createSessionControl({ ...f.args, state: previous }).restore();
  assert.deepEqual(previous.candidateItems[output.candidateId], f.state.candidateItems[output.candidateId]);
});

test('imported locator findings retain source and consumer references and revoke stale or missing dependencies', async t => {
  const f = await fixture(t), source = await f.read('data/story.json'), consumer = await f.read('consumer.js');
  const document = { format: 'pinhao-investigation-findings-1', findings: [{ file: 'data/story.json', locator: { pointer: '/text' },
    selection: { file: 'data/story.json', pointer: '/text', text: 'Caption.', reason: 'The consumer receives this caption.' },
    sourceEvidenceRefs: [source.receiptId], consumerEvidenceRefs: [consumer.receiptId], dependencies: consumer.resourceRefs }] };
  const bytes = Buffer.from(JSON.stringify(document)), file = path.join(f.workspaceDir, 'findings.json'); await writeFile(file, bytes);
  const imported = await f.session.importFindings('findings.json', digest(bytes)), id = imported.itemIds[0];
  assert.equal(f.state.workItems[id].status, 'ready_for_attempt');
  assert.equal((await f.session.selections([id]))[0].text, 'Caption.');
  await writeFile(path.join(f.gameDir, 'consumer.js'), 'function showChanged(text) { return "prefix" + text; }');
  await f.session.restore();
  assert.equal(f.state.workItems[id].status, 'needs_evidence');
  assert.equal(f.state.workItems[id].itemId, id);
  await rm(path.join(f.gameDir, 'consumer.js')); await f.session.restore();
  assert.equal(f.state.workItems[id].blockers[0].code, 'dependency-missing');
  await rm(path.join(f.gameDir, 'data/story.json')); await f.session.restore();
  assert.equal(f.state.workItems[id].status, 'stale');
});

test('mixed findings import preserves valid rows and rejects stale sources without promoting invalid evidence', async t => {
  const f = await fixture(t), file = 'data/story.json';
  const text = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`caption${index}`, `Caption ${index}.`]));
  await writeFile(path.join(f.gameDir, file), JSON.stringify(text));
  const source = await f.read(file), consumer = await f.read('consumer.js');
  const findings = Array.from({ length: 10 }, (_, index) => ({ file, claim: `Finding ${index}`,
    locator: { pointer: `/caption${index}` },
    selection: { file, pointer: `/caption${index}`, text: text[`caption${index}`], reason: 'The consumer receives this caption.' },
    sourceEvidenceRefs: [source.receiptId], consumerEvidenceRefs: [consumer.receiptId] }));
  for (const index of [1, 5]) {
    findings[index].locator.pointer = `/missing${index}`;
    findings[index].selection.pointer = `/missing${index}`;
  }
  for (const index of [2, 6]) findings[index].sourceHash = '0'.repeat(64);
  findings[3].sourceEvidenceRefs = ['forged-receipt'];
  findings[7].sourceEvidenceRefs = [(await f.evidence.save({ claimedReceipt: source.receiptId })).evidenceId];
  findings[8].sourceEvidenceRefs = [consumer.receiptId];
  const bytes = Buffer.from(JSON.stringify({ format: 'pinhao-investigation-findings-1', findings }));
  await writeFile(path.join(f.workspaceDir, 'mixed-findings.json'), bytes);
  const result = await f.session.importFindings('mixed-findings.json', digest(bytes));
  assert.equal(result.imported, 8);
  assert.deepEqual(result.rejected.map(row => [row.index, row.code]), [[2, 'FINDING_SOURCE_CHANGED'], [6, 'FINDING_SOURCE_CHANGED']]);
  const imported = result.itemIds.map(id => f.state.workItems[id]);
  for (const index of [0, 4, 9]) assert.equal(imported.find(item => item.claim === `Finding ${index}`).status, 'ready_for_attempt');
  for (const index of [1, 3, 5, 7, 8]) assert.equal(imported.find(item => item.claim === `Finding ${index}`).status, 'needs_evidence');
  for (const index of [2, 6]) assert.equal(imported.some(item => item.claim === `Finding ${index}`), false);
  for (const index of [3, 7, 8]) assert.deepEqual(imported.find(item => item.claim === `Finding ${index}`).sourceEvidenceRefs, []);
  const before = { count: Object.keys(f.state.workItems).length, material: f.state.control.materialSerial };
  const repeated = await f.session.importFindings('mixed-findings.json', digest(bytes));
  assert.deepEqual(repeated.itemIds, result.itemIds);
  assert.deepEqual(repeated.rejected, result.rejected);
  assert.equal(Object.keys(f.state.workItems).length, before.count);
  assert.equal(f.state.control.materialSerial, before.material);
});

test('concurrent tool completions and checkpoints persist all counters with no pending operations', async t => {
  const f = await fixture(t), persisted = path.join(f.root, 'concurrent-state.json');
  let blockNext = false, releaseCheckpoint, enteredCheckpoint;
  const blocked = new Promise(resolve => { enteredCheckpoint = resolve; });
  const release = new Promise(resolve => { releaseCheckpoint = resolve; });
  const session = createSessionControl({ ...f.args, persist: async state => {
    const snapshot = structuredClone(state);
    if (blockNext) { blockNext = false; enteredCheckpoint(); await release; }
    await writeFile(persisted, JSON.stringify(snapshot));
  } });
  const inputs = [{ file: 'data/story.json' }, { file: 'consumer.js' }];
  const operations = await Promise.all(inputs.map((input, index) => session.begin('read_resource', input, { toolCallId: `concurrent-${index}` })));
  await session.checkpoint();
  assert.equal(Object.keys(JSON.parse(await readFile(persisted, 'utf8')).pendingOperations).length, 2);
  const outputs = await Promise.all(inputs.map(async input => {
    const content = await readFile(path.join(f.gameDir, input.file), 'utf8'), bytes = Buffer.byteLength(content);
    const output = { content, returnedBytes: bytes, totalBytes: bytes, offset: 0 };
    return { output, evidenceId: (await f.evidence.save(output)).evidenceId };
  }));
  blockNext = true;
  const checkpoint = session.checkpoint(); await blocked;
  const completions = Promise.all(operations.map((operation, index) => session.finish(operation, inputs[index], outputs[index].output, outputs[index].evidenceId)));
  const step = session.step(), finalCheckpoint = session.checkpoint();
  releaseCheckpoint();
  await Promise.all([checkpoint, completions, step, finalCheckpoint]);
  assert.equal(f.state.control.materialSerial, 0);
  await f.present(await completions, session); await session.flush();
  const disk = JSON.parse(await readFile(persisted, 'utf8'));
  assert.deepEqual(disk.pendingOperations, {});
  assert.equal(disk.control.materialSerial, 2); assert.equal(disk.control.activity, 2); assert.equal(disk.control.logicalSteps, 1);
  assert.deepEqual(disk.control, f.state.control);
  assert.deepEqual(disk.appliedReceiptPositions, f.state.appliedReceiptPositions);
  assert.equal(Object.keys(disk.workItems).length, 2);
  const receipts = await f.evidence.readReceipts();
  assert.equal(receipts.records.filter(row => row.tool === 'read_resource' && row.phase === 'completed').length, 2);
  assert.equal(disk.appliedReceiptPositions[receipts.namespaceId], receipts.lastSeq);
});

test('small working sets omit empty investigations and machine metadata without losing full item lookup', async t => {
  const f = await fixture(t), source = await f.read('data/story.json'), consumer = await f.read('consumer.js');
  const item = await f.session.recordFinding({ file: 'data/story.json', locator: { pointer: '/text' }, claim: 'The consumer receives this caption.',
    selection: { file: 'data/story.json', pointer: '/text', text: 'Caption.', reason: 'Display consumer located.' },
    sourceEvidenceRefs: [source.receiptId], consumerEvidenceRefs: [consumer.receiptId], proposedNextAction: 'Write the located caption adapter.' });
  const full = f.session.projection(), view = f.session.workingSet();
  assert.ok(full.items.some(row => row.claimKind === 'resource-investigation' && !row.claim));
  assert.deepEqual(view.items.map(row => row.itemId), [item.itemId]);
  assert.equal(view.items[0].file, 'data/story.json'); assert.equal(view.items[0].nextAction, 'Write the located caption adapter.');
  for (const key of ['projectId', 'originId', 'baselineHash', 'sourceEpoch', 'artifacts', 'createdAt', 'updatedAt']) assert.equal(JSON.stringify(view).includes(`"${key}"`), false);
  const complete = full.items.find(row => row.itemId === item.itemId);
  assert.equal(complete.projectId, f.args.project.id); assert.equal(complete.resource.baselineHash, source.resourceRefs[0].baselineHash);
  const host = adaptationTools({ ...f.args, inventory: {}, lab: {} });
  try {
    const result = await host.tools.manage_work_items.execute({ action: 'get', itemId: item.itemId });
    assert.equal(result.item.itemId, item.itemId); assert.deepEqual(result.item.resource, complete.resource);
    assert.equal(result.item.projectId, complete.projectId);
  } finally { await host.close(); await host.flush(); }
});

test('partial submission accepts only its exact position, not blocked neighbours or the whole file investigation', async t => {
  const f = await fixture(t), file = 'data/story.json';
  await writeFile(path.join(f.gameDir, file), '{"a":"Alpha","b":"Beta","c":"Unknown"}');
  const source = await f.read(file), consumer = await f.read('consumer.js'), rows = [];
  for (const [field, text] of [['a', 'Alpha'], ['b', 'Beta'], ['c', 'Unknown']]) rows.push(await f.session.recordFinding({ file,
    locator: { pointer: `/${field}` }, selection: { file, pointer: `/${field}`, text, reason: 'actual display consumer' },
    sourceEvidenceRefs: [source.receiptId], consumerEvidenceRefs: [consumer.receiptId] }));
  const session = createSessionControl({ ...f.args, acceptedUnitsForRecipe: () => [{ id: 'unit-a', source: 'Alpha', locator: { file, pointer: '/a' } }] });
  const input = { candidateId: 'candidate-a', itemIds: rows.map(item => item.itemId) }, output = { accepted: true, taskComplete: false, recipeId: 'recipe-a', acceptedBatchId: 'batch-a' };
  const operation = await session.begin('submit_recipe', input);
  await session.finish(operation, input, output, (await f.evidence.save(output)).evidenceId);
  assert.equal(f.state.workItems[rows[0].itemId].status, 'accepted');
  assert.equal(f.state.workItems[rows[1].itemId].status, 'ready_for_attempt');
  assert.equal(f.state.workItems[rows[2].itemId].status, 'ready_for_attempt');
  const investigation = Object.values(f.state.workItems).find(item => item.resource.path === file && !item.locator);
  assert.notEqual(investigation.status, 'accepted');
});

test('only the sent UTF8 prefix and actual evidence continuation earn credit; preparation and repeated sends do not', async t => {
  const f = await fixture(t), receipt = await f.read('data/story.json'), saved = (await f.evidence.load(receipt.outputEvidenceId)).value;
  const send = async (id, output) => f.session.modelPresented({ modelRequestId: id, messages: [{ role: 'tool', content: JSON.stringify(output) }] });
  const base = { evidenceId: receipt.outputEvidenceId, receiptId: receipt.receiptId };
  assert.equal(f.state.control.materialSerial, 0);
  await send('first', { ...base, content: saved.content.slice(0, 5), view: { offset: 0 } });
  assert.deepEqual(Object.values(f.state.control.readRanges), [[[0, 5]]]);
  await send('repeated', { ...base, content: saved.content.slice(0, 5), view: { offset: 0 } });
  assert.equal(f.state.control.materialSerial, 1);
  await send('continuation', { ...base, occurrenceId: receipt.receiptId, pointer: '/content', offset: 5, content: saved.content.slice(5) });
  assert.deepEqual(Object.values(f.state.control.readRanges), [[[0, Buffer.byteLength(saved.content)]]]);
  assert.equal(f.state.control.materialSerial, 2);
  await send('forged', { ...base, content: 'Not actually captured source' });
  assert.equal(f.state.control.materialSerial, 2);
});

test('redaction that changes byte lengths earns only clean-view credit and never invents raw source ranges', async t => {
  const f = await fixture(t), file = 'data/story.json', raw = 'Caption TEST_SECRET_NEUTRAL end.';
  await writeFile(path.join(f.gameDir, file), raw);
  const sanitize = value => value.replaceAll('TEST_SECRET_NEUTRAL', '[hidden]');
  const session = createSessionControl({ ...f.args, sanitize });
  const input = { file }, operation = await session.begin('read_resource', input), output = { content: sanitize(raw), offset: 0, returnedBytes: Buffer.byteLength(raw), encoding: 'utf8' };
  const saved = await f.evidence.save(output), receipt = await session.finish(operation, input, output, saved.evidenceId);
  await session.modelPresented({ modelRequestId: 'clean-send', messages: [{ role: 'tool', content: JSON.stringify({ ...output, evidenceId: saved.evidenceId, receiptId: receipt.receiptId }) }] });
  assert.deepEqual(f.state.control.readRanges, {});
  assert.deepEqual(Object.values(f.state.control.viewRanges), [[[0, output.content.length]]]);
  assert.equal(f.state.control.materialSerial, 1);
});
