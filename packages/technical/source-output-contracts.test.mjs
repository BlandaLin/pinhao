import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, open, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readSlice, readSourceSlice, inspectReadSources } from './adaptation/paths.mjs';
import { createResourceDiscovery } from './adaptation/resource-discovery.mjs';
import { boundedToolOutput, projectToolResultGroup } from './adaptation/tool-output.mjs';
import { createEvidenceStore } from './adaptation/evidence.mjs';
import { createWorkspaceExecution } from './adaptation/workspace-execution.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-source-output-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const gameDir = path.join(root, 'game'), workDir = path.join(root, 'work'), other = path.join(root, 'other');
  await mkdir(gameDir); await mkdir(workDir); await mkdir(other);
  return { root, gameDir, workDir, other, projectId: 'neutral-source-output' };
}
async function nonDeleteReadLock(file) {
  const encoded = Buffer.from(file, 'utf8').toString('base64');
  const command = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$f=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{[Console]::Out.WriteLine('lock-ready');[Console]::Out.Flush();$null=[Console]::In.ReadLine()}finally{$f.Dispose()}`;
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Lock helper exited ${code}`))); });
  let output = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Windows lock helper did not become ready')), 10000);
    child.stdout.on('data', bytes => { output += bytes; if (output.includes('lock-ready')) { clearTimeout(timeout); resolve(); } });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { if (!output.includes('lock-ready')) { clearTimeout(timeout); reject(new Error('Windows lock helper exited before ready')); } });
  });
  return { closed, release: () => child.stdin.end('release\n') };
}
const partOutput = (id, value) => ({ type: 'tool-result', toolCallId: id, toolName: 'read_resource', output: { type: 'json', value } });
const group = values => [{ role: 'assistant', content: values.map((_, i) => ({ type: 'tool-call', toolCallId: `call-${i}`, toolName: 'read_resource', input: { root: 'source', file: `scene-${i}.txt` } })) },
  { role: 'tool', content: values.map((value, i) => partOutput(`call-${i}`, value)) }];

test('run finalization publication failure retains output and rejects every completion access without rerunning', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const f = await fixture(t), manager = createWorkspaceExecution({ programs: { node: process.execPath }, authorize: async () => true });
  let lock;
  try {
    const run = await manager.run({ ...f, program: 'node', timeoutMs: 20000, args: ['-e',
      "const fs=require('node:fs');fs.appendFileSync('executions.txt','run\\n');const timer=setInterval(()=>{if(fs.existsSync('finish-child')){clearInterval(timer);process.stdout.write('retained stdout');process.stderr.write('retained stderr');}},10);"] });
    const logs = path.join(f.workDir, 'process-runs'), recordFile = path.join(logs, `${run.runId}.json`);
    lock = await nonDeleteReadLock(recordFile);
    await writeFile(path.join(f.workDir, 'finish-child'), 'finish');
    let failure;
    await assert.rejects(manager.wait({ ...f, runId: run.runId, waitMs: 20000 }), error => {
      failure = error;
      t.diagnostic(JSON.stringify({ code: error.code, causeCode: error.cause?.code, runId: error.runId, hostFailure: error.hostFailure }));
      assert.equal(error.hostFailure, true); assert.equal(error.runId, run.runId);
      assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
      assert.equal(error.cause.code, error.code); assert.match(error.message, /运行记录/);
      return true;
    });
    lock.release(); await lock.closed; lock = null;
    for (const access of [() => manager.read({ ...f, runId: run.runId }), () => manager.wait({ ...f, runId: run.runId, waitMs: 0 }),
      () => manager.stop({ ...f, runId: run.runId }), () => manager.settle({ workDir: f.workDir }),
      () => manager.settle({ workDir: f.workDir, cancelled: true }), () => manager.close(), () => manager.close()]) {
      await assert.rejects(access(), error => error === failure);
    }
    assert.equal((JSON.parse(await readFile(recordFile, 'utf8'))).status, 'running');
    const temporary = (await readdir(logs)).filter(file => file.startsWith(`${run.runId}.json.`) && file.endsWith('.tmp'));
    assert.equal(temporary.length, 1);
    const unpublished = JSON.parse(await readFile(path.join(logs, temporary[0]), 'utf8'));
    assert.equal(unpublished.status, 'completed'); assert.equal(unpublished.captureComplete, true);
    assert.equal(await readFile(path.join(logs, `${run.runId}.stdout`), 'utf8'), 'retained stdout');
    assert.equal(await readFile(path.join(logs, `${run.runId}.stderr`), 'utf8'), 'retained stderr');
    assert.equal(await readFile(path.join(f.workDir, 'executions.txt'), 'utf8'), 'run\n');
  } finally { lock?.release(); await lock?.closed; await manager.close().catch(() => {}); }
});

test('F06 resolved source pages, shallow work listing and path searches carry executable locations', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.gameDir, 'same.txt'), 'first'); await writeFile(path.join(f.other, 'same.txt'), 'second');
  const page = await readSourceSlice(f.gameDir, 'same.txt', { sourceRoots: [f.other], sourceIndex: 1 });
  assert.equal(page.content, 'second'); assert.equal(page.resolvedLocation.sourceIndex, 1);
  assert.deepEqual(page.readCall.input, { root: 'source', sourceIndex: 1, file: 'same.txt', offset: 0, length: 65536, encoding: 'utf8' });
  await assert.rejects(readSourceSlice(f.gameDir, 'missing.txt', { sourceRoots: [f.other], sourceIndex: 1 }), error => {
    assert.deepEqual(error.attemptedSourceIndexes, [1]); assert.equal(error.corrections[0].call.input.sourceIndex, 1); return true;
  });
  await writeFile(path.join(f.workDir, 'generated.txt'), 'work material');
  const discovery = createResourceDiscovery({ root: 'work', list: input => inspectReadSources(f.workDir, input), read: input => readSourceSlice(f.workDir, input.file, input) });
  const list = await discovery.list();
  assert.equal(list.root, 'work'); assert.equal(list.files[0].readCall.input.root, 'work');
  const found = await discovery.search({ query: 'generated', content: false });
  assert.equal(found.items[0].nextRead.input.root, 'work'); assert.equal(found.items[0].nextRead.input.file, 'generated.txt');
});

test('F07 open UTF8 tails do not consume partial code points and invalid cursors are explicit', async t => {
  const f = await fixture(t), bytes = Buffer.from('中😀');
  await writeFile(path.join(f.workDir, 'growing'), bytes.subarray(0, 2));
  const partial = await readSlice(f.workDir, 'growing', { complete: false });
  assert.equal(partial.content, ''); assert.equal(partial.returnedBytes, 0); assert.equal(partial.nextOffset, 0); assert.equal(partial.pendingBytes, 2);
  await appendFile(path.join(f.workDir, 'growing'), bytes.subarray(2, 5));
  const middle = await readSlice(f.workDir, 'growing', { complete: false });
  assert.equal(middle.content, '中'); assert.equal(middle.nextOffset, 3); assert.equal(middle.pendingBytes, 2);
  await appendFile(path.join(f.workDir, 'growing'), bytes.subarray(5));
  const end = await readSlice(f.workDir, 'growing', { offset: 3, complete: true });
  assert.equal(end.content, '😀'); assert.equal(end.returnedBytes, 4);
  await assert.rejects(readSlice(f.workDir, 'growing', { offset: 4 }), { code: 'INVALID_UTF8_CURSOR' });
});

test('F07 UTF16 length-one evidence pages advance by complete code points and bind each occurrence', async t => {
  const f = await fixture(t), evidence = createEvidenceStore(f.workDir);
  const input = await evidence.save({ neutral: true }), saved = await evidence.save({ content: '😀中x' });
  await evidence.recordReceipt({ operationId: 'op', phase: 'started', tool: 'read_run', inputEvidenceId: input.evidenceId });
  const receipt = await evidence.recordReceipt({ operationId: 'op', phase: 'completed', tool: 'read_run', inputEvidenceId: input.evidenceId, outputEvidenceId: saved.evidenceId });
  const page = await evidence.read({ evidenceId: saved.evidenceId, occurrenceId: receipt.receiptId, pointer: '/content', length: 1 });
  assert.equal(page.content, '😀'); assert.equal(page.nextOffset, 2); assert.equal(page.nextCall.input.occurrenceId, receipt.receiptId);
  await assert.rejects(evidence.read({ evidenceId: saved.evidenceId, pointer: '/content', offset: 1 }), { code: 'EVIDENCE_INVALID_CURSOR' });
  await assert.rejects(evidence.read({ evidenceId: input.evidenceId, occurrenceId: receipt.receiptId }), { code: 'EVIDENCE_OCCURRENCE_MISMATCH' });
});

test('F07 repeated projections follow cleaned evidence before the next raw log byte page', async t => {
  const f = await fixture(t), evidence = createEvidenceStore(f.workDir);
  const content = 'cleaned 中文😀 "\\\n'.repeat(1200);
  const sourcePage = { startByte: 100000, endByte: 200000, snapshotBytes: 300000,
    nextCall: { tool: 'read_run', input: { runId: 'run-neutral', cursor: 200000 } } };
  const raw = { schema: 'pinhao-process-log-page-2', runId: 'run-neutral', stream: 'stdout', captureGeneration: 'generation',
    sourcePage, nextCursor: 200000, content, view: { pointer: '/content', offsetUnit: 'utf16', offset: 0, returnedCharacters: content.length, totalCharacters: content.length } };
  const saved = await evidence.save(raw), shown = boundedToolOutput({ ...raw, ...saved }, { maxCharacters: 6000 });
  assert.equal(shown.nextCursor, undefined); assert.equal(shown.nextCall.tool, 'read_evidence');
  assert.deepEqual(shown.sourcePage, sourcePage);
  const twice = boundedToolOutput(shown, { maxCharacters: 4500 });
  assert.deepEqual(boundedToolOutput(twice, { maxCharacters: 4500 }), twice);
  let assembled = twice.content, next = twice.nextCall;
  while (next?.tool === 'read_evidence') { const page = await evidence.read(next.input); assembled += page.content; next = page.nextCall; }
  assert.equal(assembled, content); assert.deepEqual(next, sourcePage.nextCall);
});

test('F08 projection is pure across other jobs and assigns twenty results from the actual SDK group', () => {
  const values = Array.from({ length: 20 }, (_, i) => ({ evidenceId: `evidence-${String(i).padStart(64, '0')}`, content: '"中文😀\\'.repeat(5000), status: i === 2 ? 'failed' : 'completed', ...(i === 2 ? { error: { code: 'FORMAT_PENDING', message: 'actual failure' } } : {}) }));
  const before = JSON.stringify(values), first = boundedToolOutput(values[0], {});
  for (let i = 0; i < 100; i++) boundedToolOutput({ evidenceId: values[1].evidenceId, content: 'other job'.repeat(100) }, {});
  assert.deepEqual(boundedToolOutput(values[0], {}), first);
  const messages = group(values), projected = projectToolResultGroup(messages, { maxCharacters: 40000 });
  assert.ok(JSON.stringify(projected).length <= 40000);
  assert.equal(projected[1].content.length, 20); assert.equal(projected[0].content.length, 20);
  assert.equal(projected[1].content[2].output.value.error.code, 'FORMAT_PENDING');
  assert.deepEqual(projectToolResultGroup(messages, { maxCharacters: 40000 }), projected);
  assert.equal(JSON.stringify(values), before);
});

test('F08 tiny results release capacity and invalid or impossible envelopes stop before a send', () => {
  const original = group([{ ok: true }, { ok: true }, { evidenceId: `evidence-${'a'.repeat(64)}`, content: 'x'.repeat(100000) }]);
  const projected = projectToolResultGroup(original, { maxCharacters: 20000 });
  assert.deepEqual(projected[1].content[0].output, original[1].content[0].output);
  assert.ok(projected[1].content[2].output.value.content.length > 10000);
  for (const maxCharacters of [-1, NaN]) assert.throws(() => boundedToolOutput({ x: 1 }, { maxCharacters }), RangeError);
  assert.equal(boundedToolOutput({ error: { code: 'FAIL' }, evidenceId: `evidence-${'a'.repeat(64)}`, content: 'secret full body' }, { maxCharacters: 0 }).error.code, 'FAIL');
  const huge = group([{ ok: true }]); huge[0].content[0].input = { huge: 'x'.repeat(30000) };
  assert.throws(() => projectToolResultGroup(huge, { maxCharacters: 20000 }), { code: 'CONTEXT_CAPACITY_BLOCKED' });
  assert.throws(() => projectToolResultGroup([huge[0]], { maxCharacters: 50000 }), { code: 'CONTEXT_CAPACITY_BLOCKED' });
});

async function complete(manager, input, run) {
  let result = run;
  while (result.status === 'running') result = await manager.wait({ ...input, runId: run.runId, waitMs: 100, length: 262144 });
  return result;
}
test('F07 actual child stdout/stderr capture stays complete, final, byte-paged and restart-readable', async t => {
  const f = await fixture(t), options = { programs: { node: process.execPath }, authorize: async () => true };
  const manager = createWorkspaceExecution(options); t.after(() => manager.close());
  const run = await manager.run({ ...f, program: 'node', args: ['-e', "process.stdout.write('x'.repeat(300000)); process.stderr.write('error tail 中文');"] });
  const done = await complete(manager, f, run);
  assert.equal(done.status, 'completed'); assert.equal(done.captureComplete, true); assert.equal(done.outputFinalized, true);
  assert.equal((await readFile(path.join(f.workDir, 'process-runs', `${run.runId}.stdout`))).length, 300000);
  const slice = await manager.read({ ...f, runId: run.runId, cursor: 100000, length: 100000 });
  assert.deepEqual([slice.sourcePage.startByte, slice.sourcePage.endByte], [100000, 200000]);
  const reopened = createWorkspaceExecution(options); t.after(() => reopened.close());
  const tail = await reopened.read({ ...f, runId: run.runId, stream: 'stderr', expectedCaptureGeneration: done.captureGeneration });
  assert.equal(tail.content, 'error tail 中文'); assert.equal(tail.nextCall, null);
  await assert.rejects(reopened.read({ ...f, runId: run.runId, expectedCaptureGeneration: 'wrong' }), { code: 'LOG_CHANGED' });
});

test('F07 short writes loop and per-run quota retains its exact prefix with an explicit failed capture', async t => {
  const f = await fixture(t);
  const openLog = async (...args) => {
    const handle = await open(...args);
    return { write: (bytes, offset, length) => handle.write(bytes, offset, Math.min(7, length)), sync: () => handle.sync(), close: () => handle.close() };
  };
  const manager = createWorkspaceExecution({ programs: { node: process.execPath }, authorize: async () => true, maxLogBytesPerRun: 32, openLog });
  t.after(() => manager.close());
  const run = await manager.run({ ...f, program: 'node', args: ['-e', "process.stdout.write('x'.repeat(200)); setTimeout(()=>{},30000);"] });
  const done = await complete(manager, f, run);
  assert.equal(done.status, 'failed'); assert.equal(done.errorCode, 'OUTPUT_LIMIT'); assert.equal(done.captureComplete, false);
  assert.equal(done.stdoutBytes, 32); assert.equal(done.committedBytes.stdout, 32); assert.equal(done.content, 'x'.repeat(32));
});

test('F07 a real growing child log retains split UTF8 bytes until the character finishes', async t => {
  const f = await fixture(t), manager = createWorkspaceExecution({ programs: { node: process.execPath }, authorize: async () => true });
  t.after(() => manager.close());
  const run = await manager.run({ ...f, program: 'node', args: ['-e', "const b=Buffer.from('中');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),500);"] });
  let partial;
  for (let i = 0; i < 20; i++) {
    partial = await manager.wait({ ...f, runId: run.runId, waitMs: 10 });
    if (partial.pendingBytes) break;
  }
  assert.equal(partial.pendingBytes, 2); assert.equal(partial.content, ''); assert.equal(partial.nextCall.tool, 'wait_run');
  assert.equal(partial.nextCall.input.cursor, 0);
  const done = await complete(manager, f, { ...run, status: 'running' });
  assert.equal(done.content, '中'); assert.equal(done.sourcePage.endByte, 3);
});

test('F07 disk write failure preserves its run record, closes streams and is not reported complete', async t => {
  const f = await fixture(t); let closed = 0;
  const openLog = async (...args) => {
    const handle = await open(...args);
    return { write: async () => { throw Object.assign(new Error('injected full disk'), { code: 'ENOSPC' }); },
      sync: () => handle.sync(), close: async () => { closed++; await handle.close(); } };
  };
  const manager = createWorkspaceExecution({ programs: { node: process.execPath }, authorize: async () => true, openLog });
  t.after(() => manager.close());
  const run = await manager.run({ ...f, program: 'node', args: ['-e', "process.stdout.write('lost');setTimeout(()=>{},30000);"] });
  const done = await complete(manager, f, run);
  assert.equal(done.status, 'failed'); assert.equal(done.errorCode, 'ENOSPC'); assert.equal(done.storageFailure, true);
  assert.equal(done.stdoutBytes, 0); assert.equal(done.captureComplete, false); assert.equal(closed, 2);
  const saved = JSON.parse(await readFile(path.join(f.workDir, 'process-runs', `${run.runId}.json`), 'utf8'));
  assert.equal(saved.errorCode, 'ENOSPC'); assert.equal(saved.outputFinalized, true);
});

test('F07 request-owned reservations settle only actual written bytes and preserve uncertain write outcomes', async t => {
  const f = await fixture(t), reservations = [], settlements = []; let remaining = 64;
  const manager = createWorkspaceExecution({ programs: { node: process.execPath }, authorize: async () => true,
    reserveLogBytes: async input => { reservations.push(input); const bytes = Math.min(remaining, input.bytes); remaining -= bytes; return bytes; },
    settleLogBytes: async input => { settlements.push(input); } });
  t.after(() => manager.close());
  const run = await manager.run({ ...f, requestId: 'request-one', program: 'node', args: ['-e', "process.stdout.write('a'.repeat(50));process.stderr.write('b'.repeat(50));setTimeout(()=>{},30000);"] });
  const done = await complete(manager, f, run);
  assert.equal(done.errorCode, 'OUTPUT_LIMIT'); assert.equal(done.retainedBytes, 64);
  assert.ok(reservations.every(input => input.projectId === f.projectId && input.requestId === 'request-one' && input.runId === run.runId));
  assert.equal(settlements.reduce((sum, input) => sum + input.persistedBytes, 0), 64);
  assert.ok(settlements.every(input => input.reservedBytes === input.persistedBytes && input.uncertain === false));
  const uncertain = [];
  const openLog = async (...args) => { const handle = await open(...args); return {
    write: async () => { throw Object.assign(new Error('uncertain write'), { code: 'EIO' }); }, sync: () => handle.sync(), close: () => handle.close() }; };
  const broken = createWorkspaceExecution({ programs: { node: process.execPath }, authorize: async () => true, openLog,
    reserveLogBytes: async input => input.bytes, settleLogBytes: async input => { uncertain.push(input); } });
  t.after(() => broken.close());
  const failedRun = await broken.run({ ...f, requestId: 'request-two', program: 'node', args: ['-e', "process.stdout.write('bytes');setTimeout(()=>{},30000);"] });
  const failed = await complete(broken, f, failedRun);
  assert.equal(failed.errorCode, 'EIO'); assert.equal(uncertain[0].uncertain, true); assert.equal(uncertain[0].persistedBytes, 0);
});
