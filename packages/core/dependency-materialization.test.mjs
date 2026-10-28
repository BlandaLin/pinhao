import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createAdaptationSource } from './adaptive-worker.mjs';
import { runAdaptation } from '../technical/adaptation.mjs';
import { createAdapterLab } from '../technical/adaptation/adapter-lab.mjs';
import { createWorkspaceExecution } from '../technical/adaptation/workspace-execution.mjs';
import { createEvidenceStore } from '../technical/adaptation/evidence.mjs';

const exec = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-origin-dependency-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const gameDir = path.join(root, 'managed'), other = path.join(root, 'original'), outputDir = path.join(root, 'source'), workDir = path.join(root, 'job');
  await mkdir(gameDir); await mkdir(other); await mkdir(workDir);
  await writeFile(path.join(gameDir, 'same.txt'), 'managed material');
  await writeFile(path.join(other, 'same.txt'), 'original material');
  const base = { gameDir, sourceRoots: [other], outputDir, dependencyWorkDir: workDir, returnDetails: true };
  await createAdaptationSource({ ...base, files: [{ file: 'same.txt', sourceIndex: 0 }] });
  const files = [0, 1].map(sourceIndex => ({ file: 'same.txt', sourceIndex, purpose: 'dependency',
    expectedHash: digest(sourceIndex ? 'original material' : 'managed material') }));
  return { root, gameDir, other, workDir, base, files };
}

test('F06-13 two same-name origins materialize at host-assigned paths and a real script reads both without changing source env', async t => {
  const f = await fixture(t), before = await readFile(`${f.base.outputDir}.snapshot.json`);
  const result = await createAdaptationSource({ ...f.base, files: [{ ...f.files[0], purpose: 'source' }, ...f.files] });
  assert.equal(result.sourceDir, f.base.outputDir); assert.equal(result.sources.length, 1);
  assert.equal(result.materializations.length, 2);
  const [first, second] = result.materializations;
  assert.notEqual(first.scriptRelative, second.scriptRelative);
  for (const row of result.materializations) {
    assert.match(row.scriptRelative, /^dependencies\/[a-f0-9]{64}\/same\.txt$/);
    assert.deepEqual(row.workRef, { root: 'work', file: row.scriptRelative });
    assert.equal(row.proofScope, 'working-dependency-only');
    assert.equal(row.sha256, row.derivedFrom.baselineHash);
    const { materializationReceiptId, ...body } = row;
    assert.equal(materializationReceiptId, digest(JSON.stringify(body)));
  }
  const manager = createWorkspaceExecution({ programs: { node: process.execPath }, authorize: async () => true });
  t.after(() => manager.close());
  const context = { projectId: 'origin-dependency', gameDir: result.sourceDir, workDir: f.workDir };
  const script = "const fs=require('node:fs'),p=require('node:path');console.log(JSON.stringify({source:fs.readFileSync(p.join(process.env.PINHAO_SOURCE_DIR,'same.txt'),'utf8'),deps:process.argv.slice(1).map(x=>fs.readFileSync(p.join(process.env.PINHAO_WORK_DIR,x),'utf8'))}));";
  const run = await manager.run({ ...context, program: 'node', args: ['-e', script, first.scriptRelative, second.scriptRelative] });
  let page;
  do { page = await manager.wait({ ...context, runId: run.runId, waitMs: 1000 }); } while (page.status === 'running');
  assert.equal(page.status, 'completed', JSON.stringify(page));
  assert.deepEqual(JSON.parse(page.content), { source: 'managed material', deps: ['managed material', 'original material'] });
  assert.deepEqual(await readFile(`${f.base.outputDir}.snapshot.json`), before);
  assert.equal(await readFile(path.join(f.gameDir, 'same.txt'), 'utf8'), 'managed material');
  assert.equal(await readFile(path.join(f.other, 'same.txt'), 'utf8'), 'original material');
});

test('F06-13 dependency snapshot resumes in a fresh host process, retains receipt identity and repairs only its damaged copy', async t => {
  const f = await fixture(t), options = { ...f.base, files: f.files };
  const first = await createAdaptationSource(options);
  const target = path.join(f.workDir, first.materializations[1].scriptRelative), before = await stat(target);
  const moduleUrl = pathToFileURL(path.join(import.meta.dirname, 'adaptive-worker.mjs')).href;
  const child = await exec(process.execPath, ['--input-type=module', '-e',
    'const {createAdaptationSource}=await import(process.argv[1]);console.log(JSON.stringify(await createAdaptationSource(JSON.parse(process.argv[2]))));', moduleUrl, JSON.stringify(options)]);
  assert.deepEqual(JSON.parse(child.stdout), first);
  assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
  await writeFile(target, 'damaged working copy');
  assert.deepEqual(await createAdaptationSource(options), first);
  assert.equal(await readFile(target, 'utf8'), 'original material');
  assert.equal(await readFile(path.join(f.base.outputDir, 'same.txt'), 'utf8'), 'managed material');
});

test('F06-13 stale hashes, changed origins and linked destination paths never overwrite a dependency baseline', async t => {
  const f = await fixture(t), result = await createAdaptationSource({ ...f.base, files: f.files });
  const target = path.join(f.workDir, result.materializations[1].scriptRelative);
  await writeFile(path.join(f.other, 'same.txt'), 'changed material');
  await assert.rejects(createAdaptationSource({ ...f.base, files: f.files }), { code: 'SOURCE_BASELINE_CHANGED' });
  assert.equal(await readFile(target, 'utf8'), 'original material');
  const changed = f.files.map(row => row.sourceIndex === 1 ? { ...row, expectedHash: digest('changed material') } : row);
  await assert.rejects(createAdaptationSource({ ...f.base, files: changed }), /原版资源已更新/);
  assert.equal(await readFile(target, 'utf8'), 'original material');
  await assert.rejects(createAdaptationSource({ ...f.base, files: [{ ...f.files[0], file: '../escape.txt' }] }), /相对定位|相对路径/);
  const unsafeWork = path.join(f.root, 'unsafe-job'); await mkdir(unsafeWork);
  await symlink(f.other, path.join(unsafeWork, 'dependencies'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createAdaptationSource({ ...f.base, dependencyWorkDir: unsafeWork, files: [f.files[0]] }), /链接/);
  await assert.rejects(createAdaptationSource({ ...f.base, files: [{ file: 'same.txt', sourceIndex: 1 }] }), /同名施工输入/);
  assert.equal(await readFile(path.join(f.base.outputDir, 'same.txt'), 'utf8'), 'managed material');
});

test('F06-13 copy tool persists an accurate materialization receipt without source credit, assignment or owner changes', async t => {
  const f = await fixture(t), project = { id: 'dependency-tool', engine: 'Fixture' };
  const assignment = { id: 'same-file-job', files: ['same.txt'] }, initialAssignment = structuredClone(assignment);
  const lab = await createAdapterLab({ dataDir: path.join(f.root, 'lab') });
  let toolOutput;
  const result = await runAdaptation({ project, lab, gameDir: f.base.outputDir, readDir: f.gameDir, readRoots: [f.other], assignment,
    workspaceDir: f.workDir, statePath: path.join(f.workDir, 'state.json'),
    copySourceFiles: (files, { workDir }) => createAdaptationSource({ ...f.base, files, dependencyWorkDir: workDir }),
    generate: async ({ tools }) => { toolOutput = await tools.copy_source_files.execute({ targets: f.files }); } });
  assert.equal(toolOutput.error, undefined, JSON.stringify(toolOutput));
  assert.ok(toolOutput.receiptId); assert.ok(toolOutput.evidenceId);
  assert.equal(toolOutput.materializations.length, 2);
  for (const row of toolOutput.materializations) assert.match(row.derivedFrom.originId, /^[a-f0-9]{64}$/);
  const store = createEvidenceStore(f.workDir), receipt = await store.resolveReceipt(toolOutput.receiptId);
  assert.equal(receipt.phase, 'completed'); assert.equal(receipt.tool, 'copy_source_files');
  assert.deepEqual(receipt.resourceRefs, []);
  const saved = await store.load(receipt.outputEvidenceId);
  assert.deepEqual(saved.value.materializations, toolOutput.materializations);
  assert.deepEqual(result.state.investigationReads, []);
  assert.equal(Object.keys(result.state.workItems).length, 0);
  assert.equal(result.state.scopeRequest, undefined);
  assert.deepEqual(assignment, initialAssignment);
});

test('F06-13 actual locked SDK receives two distinct dependency workRefs and follows them without a scope change', async t => {
  const f = await fixture(t), requests = [];
  const call = (id, name, input) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(input) } });
  const server = http.createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); requests.push(body);
    let calls;
    if (requests.length === 1) calls = [call('materialize', 'copy_source_files', { targets: f.files })];
    if (requests.length === 2) {
      const output = JSON.parse(body.messages.find(row => row.role === 'tool' && row.tool_call_id === 'materialize').content);
      calls = output.materializations.map((row, index) => call(`dependency-${index}`, 'read_resource', row.workRef));
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `local-${requests.length}`, object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0,
      message: { role: 'assistant', content: calls ? null : 'Local contract ended.', ...(calls ? { tool_calls: calls } : {}) },
      finish_reason: calls ? 'tool_calls' : 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const lab = await createAdapterLab({ dataDir: path.join(f.root, 'sdk-lab') });
  const result = await runAdaptation({ project: { id: 'dependency-sdk', engine: 'unknown' }, lab,
    connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture' },
    gameDir: f.base.outputDir, readDir: f.gameDir, readRoots: [f.other], workspaceDir: f.workDir,
    statePath: path.join(f.workDir, 'sdk-state.json'), maxSteps: 5,
    copySourceFiles: (files, { workDir }) => createAdaptationSource({ ...f.base, files, dependencyWorkDir: workDir }) });
  assert.equal(requests.length, 3, JSON.stringify(result.error));
  const definition = requests[0].tools.find(row => row.function?.name === 'copy_source_files');
  assert.deepEqual(definition.function.parameters.properties.targets.items.properties.purpose.enum, ['source', 'dependency']);
  const reads = requests[2].messages.filter(row => row.role === 'tool' && row.tool_call_id.startsWith('dependency-')).map(row => JSON.parse(row.content));
  assert.deepEqual(reads.map(row => row.content), ['managed material', 'original material']);
  assert.ok(reads.every(row => row.root === 'work' && row.receiptId));
  assert.deepEqual(result.state.investigationReads, []);
  assert.equal(Object.keys(result.state.workItems).length, 0);
});
