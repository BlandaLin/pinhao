import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWorkspaceExecution } from './adaptation/workspace-execution.mjs';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';
import { runAdaptation } from './adaptation.mjs';
import { createAdaptiveWorker } from '../core/adaptive-worker.mjs';
import { prepareProjectDependencies } from './adaptation/project-dependencies.mjs';

const pythonPath = path.resolve(process.env.PINHAO_TEST_PYTHON ?? 'local/runtime/python/python.exe');
const runtimeCheck = { skip: !existsSync(pythonPath) };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), '拼好脚本-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const gameDir = path.join(root, 'game'), workDir = path.join(root, 'work');
  await mkdir(gameDir); await mkdir(workDir);
  const context = { projectId: 'neutral-project', gameDir, workDir };
  const execution = { pythonPath, authorize: async ({ projectId }) => projectId === context.projectId };
  return { root, ...context, execution, manager: createWorkspaceExecution(execution) };
}
async function complete(manager, input) {
  let result = input;
  while (result.status === 'running') result = await manager.wait({ ...input, runId: result.runId, waitMs: 100 });
  return result;
}

test('local Python reads an assigned source file through host root mappings without secret environment',
  { skip: !existsSync(process.env.PINHAO_TEST_PYTHON ?? pythonPath) }, async t => {
    const f = await fixture(t);
    const manager = createWorkspaceExecution({ ...f.execution, pythonPath: process.env.PINHAO_TEST_PYTHON ?? pythonPath });
    t.after(() => manager.close());
    await writeFile(path.join(f.gameDir, 'assigned.neutral'), 'neutral source evidence');
    const previous = process.env.PINHAO_EXEC_TEST_SECRET;
    process.env.PINHAO_EXEC_TEST_SECRET = 'not-for-child';
    t.after(() => { if (previous === undefined) delete process.env.PINHAO_EXEC_TEST_SECRET; else process.env.PINHAO_EXEC_TEST_SECRET = previous; });
    const code = "import os,json,pathlib\nsource=pathlib.Path(os.environ['PINHAO_SOURCE_DIR'])\nwork=pathlib.Path(os.environ['PINHAO_WORK_DIR'])\nprint(json.dumps({'source':str(source),'work':str(work),'cwd':str(pathlib.Path.cwd()),'content':(source/'assigned.neutral').read_text(),'secret':os.getenv('PINHAO_EXEC_TEST_SECRET')}))\n";
    await manager.writeFile({ ...f, file: 'inspect.py', content: code });
    const run = await manager.run({ ...f, program: 'python', args: ['inspect.py'] });
    const result = await complete(manager, { ...f, ...run });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    const observed = JSON.parse(result.content);
    assert.equal(path.resolve(observed.source), path.resolve(f.gameDir));
    assert.equal(path.resolve(observed.work), path.resolve(f.workDir));
    assert.equal(path.resolve(observed.cwd), path.resolve(f.workDir));
    assert.equal(observed.content, 'neutral source evidence');
    assert.equal(observed.secret, null);
    assert.equal(await readFile(path.join(f.gameDir, 'assigned.neutral'), 'utf8'), 'neutral source evidence');
  });

test('A11 A14 bundled Python runs edited workspace programs, with real current-user permissions and no secret environment', runtimeCheck, async t => {
  const f = await fixture(t), { manager } = f;
  await assert.rejects(manager.writeFile({ ...f, projectId: 'other', file: 'script.py', content: 'print(1)' }), { code: 'WORKSPACE_EXECUTION_AUTH_REQUIRED' });
  await assert.rejects(manager.writeFile({ ...f, file: '../outside.py', content: 'x' }), /相对路径|无效/);
  await writeFile(path.join(f.root, 'outside.txt'), 'outside neutral evidence');
  const previous = process.env.PINHAO_EXEC_TEST_SECRET; process.env.PINHAO_EXEC_TEST_SECRET = 'not-for-child';
  t.after(() => { if (previous === undefined) delete process.env.PINHAO_EXEC_TEST_SECRET; else process.env.PINHAO_EXEC_TEST_SECRET = previous; });
  const script = `import os,pathlib\nprint('plain log: 非 JSON')\nprint(os.getenv('PINHAO_EXEC_TEST_SECRET'))\nprint(pathlib.Path(${JSON.stringify(path.join(f.root, 'outside.txt'))}).read_text())\n`;
  const saved = await manager.writeFile({ ...f, file: 'tool.py', content: script });
  await assert.rejects(manager.writeFile({ ...f, file: 'tool.py', content: 'print(2)', expectedHash: 'wrong' }), { code: 'WORKSPACE_FILE_CONFLICT' });
  const run = await manager.run({ ...f, program: 'python', args: ['tool.py'] });
  const done = await complete(manager, { ...f, ...run });
  assert.equal(done.status, 'completed', JSON.stringify(done));
  assert.match(done.content, /plain log: 非 JSON\r?\nNone\r?\noutside neutral evidence/);
  await manager.writeFile({ ...f, file: 'tool.py', content: 'print("fixed")', expectedHash: saved.sha256 });
  assert.match((await complete(manager, { ...f, ...await manager.run({ ...f, program: 'python', args: ['tool.py'] }) })).content, /fixed/);
  await link(path.join(f.root, 'outside.txt'), path.join(f.workDir, 'linked.txt'));
  await assert.rejects(manager.writeFile({ ...f, file: 'linked.txt', content: 'overwrite' }), /独立文件/);
  try {
    await symlink(path.join(f.root, 'outside.txt'), path.join(f.workDir, 'alias.txt'));
    await assert.rejects(manager.writeFile({ ...f, file: 'alias.txt', content: 'overwrite' }), /链接/);
  } catch (error) { if (error.code !== 'EPERM') throw error; }
});

test('A11 bundled Python runs and edits scripts through very long Chinese Windows workspace paths', runtimeCheck, async t => {
  const f = await fixture(t);
  const workDir = path.join(f.root, '第一层中文长目录'.repeat(14), '第二层中文长目录'.repeat(14));
  assert.ok(workDir.length > 260);
  const context = { ...f, workDir };
  const saved = await f.manager.writeFile({ ...context, file: '脚本/测试.py', content: "from pathlib import Path\np=Path('中文结果.txt');p.write_text('长路径执行完成',encoding='utf-8');print(p.read_text(encoding='utf-8'))" });
  const run = await f.manager.run({ ...context, program: 'python', args: ['脚本/测试.py'] });
  const result = await complete(f.manager, { ...context, ...run });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.match(result.content, /长路径执行完成/);
  assert.equal(await readFile(path.join(workDir, '中文结果.txt'), 'utf8'), '长路径执行完成');
  await f.manager.writeFile({ ...context, file: '脚本/测试.py', expectedHash: saved.sha256, content: "print('长路径修订完成')" });
  const revised = await complete(f.manager, { ...context, ...await f.manager.run({ ...context, program: 'python', args: ['脚本/测试.py'] }) });
  assert.equal(revised.status, 'completed', JSON.stringify(revised)); assert.match(revised.content, /长路径修订完成/);
});

test('A13 an actual Windows exclusive file lock stays intact until managed process cancellation closes the handle', { skip: runtimeCheck.skip || process.platform !== 'win32' }, async t => {
  const f = await fixture(t), controller = new AbortController();
  const code = "import ctypes,time\nfrom ctypes import wintypes\nfn=ctypes.windll.kernel32.CreateFileW\nfn.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,wintypes.DWORD,wintypes.LPVOID,wintypes.DWORD,wintypes.DWORD,wintypes.HANDLE]\nfn.restype=wintypes.HANDLE\nhandle=fn('locked.dat',0xC0000000,0,None,4,0x80,None)\nassert handle not in (None,ctypes.c_void_p(-1).value),ctypes.get_last_error()\nprint('exclusive-lock-ready',flush=True)\nwhile True:time.sleep(1)\n";
  await f.manager.writeFile({ ...f, file: 'lock.py', content: code });
  const run = await f.manager.run({ ...f, program: 'python', args: ['lock.py'], signal: controller.signal });
  let ready;
  for (let i = 0; i < 50; i++) { ready = await f.manager.read({ ...f, runId: run.runId }); if (ready.content.includes('exclusive-lock-ready')) break; await new Promise(resolve => setTimeout(resolve, 30)); }
  assert.match(ready.content, /exclusive-lock-ready/);
  const locked = path.join(f.workDir, 'locked.dat');
  await assert.rejects(rm(locked), error => ['EPERM', 'EBUSY', 'EACCES'].includes(error.code));
  controller.abort();
  assert.equal((await complete(f.manager, { ...f, ...run })).status, 'cancelled');
  await writeFile(locked, 'lock released only after exit');
  assert.equal(await readFile(locked, 'utf8'), 'lock released only after exit');
  await rm(locked);
});

test('A10 A13 long running process waits without restart, paginates large logs, cancels tree and retains interrupted evidence', runtimeCheck, async t => {
  const f = await fixture(t), { manager } = f;
  await manager.writeFile({ ...f, file: 'loop.py', content: "import sys,time,subprocess\nchild=subprocess.Popen([sys.executable,'-c','import time;time.sleep(100)'])\nprint('child='+str(child.pid),flush=True)\nprint('x'*200000,flush=True)\nwhile True: time.sleep(1)\n" });
  const controller = new AbortController();
  const run = await manager.run({ ...f, program: 'python', args: ['loop.py'], signal: controller.signal });
  const waited = await manager.wait({ ...f, runId: run.runId, waitMs: 50 });
  assert.equal(waited.runId, run.runId); assert.equal(waited.status, 'running');
  let page;
  for (let i = 0; i < 30; i++) { page = await manager.read({ ...f, runId: run.runId, length: 100 }); if (page.totalBytes > 1000) break; await new Promise(resolve => setTimeout(resolve, 40)); }
  assert.ok(page.totalBytes > 1000); assert.equal(page.nextCursor, 100);
  const second = await manager.read({ ...f, runId: run.runId, cursor: page.nextCursor, length: 100 });
  assert.equal(second.nextCursor, 200);
  controller.abort();
  const stopped = await complete(manager, { ...f, ...run });
  assert.equal(stopped.status, 'cancelled');
  const childPid = Number(/child=(\d+)/.exec(page.content)?.[1]);
  assert.ok(childPid); assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  const logs = path.join(f.workDir, 'process-runs');
  assert.equal((await readdir(logs)).filter(file => file.endsWith('.json')).length, 1);
  const crashed = { ...run, runId: 'run-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', status: 'running' };
  await writeFile(path.join(logs, `${crashed.runId}.json`), JSON.stringify(crashed));
  await writeFile(path.join(logs, `${crashed.runId}.stdout`), 'prior output');
  const reopened = createWorkspaceExecution(f.execution);
  const saved = await reopened.read({ ...f, runId: crashed.runId });
  assert.equal(saved.status, 'interrupted'); assert.equal(saved.content, 'prior output');
  assert.equal((await readdir(logs)).filter(file => file.endsWith('.json')).length, 2);
  const timed = await manager.run({ ...f, program: 'python', args: ['-c', 'while True: pass'], timeoutMs: 80 });
  assert.equal((await complete(manager, { ...f, ...timed })).status, 'timed-out');
});

test('A12 project-local pure Python wheel locks, cache, failed and interrupted downloads preserve the bundled runtime', runtimeCheck, async t => {
  const f = await fixture(t), wheelName = 'neutral_dep-1.0-py3-none-any.whl';
  const beforeRuntime = hash(await readFile(pythonPath));
  await f.manager.writeFile({ ...f, file: 'make_wheel.py', content: `import zipfile\nwith zipfile.ZipFile('${wheelName}','w') as z:\n z.writestr('neutral_dep.py','value = 41\\n')\n z.writestr('neutral_dep-1.0.dist-info/METADATA','Name: neutral-dep\\nVersion: 1.0\\nLicense: MIT\\n')\n` });
  assert.equal((await complete(f.manager, { ...f, ...await f.manager.run({ ...f, program: 'python', args: ['make_wheel.py'] }) })).status, 'completed');
  const bytes = await readFile(path.join(f.workDir, wheelName));
  const wheel = { file: wheelName, name: 'neutral-dep', version: '1.0', license: 'MIT', source: 'generated-neutral-fixture', sha256: hash(bytes) };
  const environment = await f.manager.prepareDependencies({ ...f, wheels: [wheel] });
  assert.equal(environment.reused, false); assert.equal(environment.runtime.implementation.startsWith('cpython-'), true);
  assert.equal((await f.manager.prepareDependencies({ ...f, wheels: [wheel] })).reused, true);
  const imported = await complete(f.manager, { ...f, ...await f.manager.run({ ...f, program: 'python', args: ['-c', 'import neutral_dep;print(neutral_dep.value)'], wheels: [wheel] }) });
  assert.equal(imported.content.trim(), '41');
  const other = await ensureNeutralDirectory(path.join(f.root, 'download-work'));
  const remote = { ...wheel, url: 'https://dependency.invalid/neutral.whl' };
  await assert.rejects(prepareProjectDependencies({ root: other, pythonPath, wheels: [remote], fetchImpl: async () => { throw new Error('offline'); } }), { code: 'DEPENDENCY_UNAVAILABLE' });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(prepareProjectDependencies({ root: other, pythonPath, wheels: [remote], signal: abort.signal }), { name: 'AbortError' });
  const downloaded = await prepareProjectDependencies({ root: other, pythonPath, wheels: [remote], fetchImpl: async () => new Response(bytes) });
  assert.ok(downloaded.path);
  assert.equal((await prepareProjectDependencies({ root: other, pythonPath, wheels: [remote], fetchImpl: async () => { throw new Error('should reuse'); } })).reused, true);
  await writeFile(path.join(environment.path, 'neutral_dep.py'), 'value = 999');
  await assert.rejects(f.manager.prepareDependencies({ ...f, wheels: [wheel] }), { code: 'DEPENDENCY_ENVIRONMENT_CHANGED' });
  assert.equal(hash(await readFile(pythonPath)), beforeRuntime);
});

async function ensureNeutralDirectory(directory) { await mkdir(directory); return directory; }

const pack = rows => {
  const parts = [Buffer.from('NEUTRAL1'), Buffer.from([rows.length])];
  for (const row of rows) { const text = Buffer.from(row.text), header = Buffer.alloc(7); header.writeUInt32LE(row.id); header[4] = row.flag; header.writeUInt16LE(text.length, 5); parts.push(header, text); }
  return Buffer.concat(parts);
};
const unpack = bytes => {
  assert.equal(bytes.subarray(0, 8).toString(), 'NEUTRAL1'); let offset = 9; const rows = [];
  for (let i = 0; i < bytes[8]; i++) { const id = bytes.readUInt32LE(offset), flag = bytes[offset + 4], size = bytes.readUInt16LE(offset + 5); offset += 7; rows.push({ id, flag, text: bytes.subarray(offset, offset + size).toString() }); offset += size; }
  assert.equal(offset, bytes.length); return rows;
};
const script = String.raw`import base64,struct
def records(host):
 data=base64.b64decode(host.readBytes('story.neutral'))
 if data[:8]!=b'NEUTRAL1': raise ValueError('wrong format')
 rows=[]; offset=9
 for i in range(data[8]):
  ident,flag,size=struct.unpack_from('<IBH',data,offset); offset+=7
  text=data[offset:offset+size].decode('utf-8'); offset+=size
  rows.append((ident,flag,text))
 if offset!=len(data): raise ValueError('trailing bytes')
 return data,rows
def detect(host,input):
 return {'matched':base64.b64decode(host.readBytes('story.neutral'))[:8]==b'NEUTRAL1'}
def extract(host,input):
 data,rows=records(host)
 return {'units':[{'id':'neutral:'+str(ident),'source':text,'kind':'dialogue','locator':{'file':'story.neutral','nativePath':['records',ident,'text']}} for ident,flag,text in rows]}
def validate(host,input): return {'valid':True}
def roundtrip(host,input): return host.writeBytes('story.neutral',host.readBytes('story.neutral'))
def build(host,input):
 data,rows=records(host); parts=[data[:9]]
 for ident,flag,text in rows:
  text=input['translations'].get('neutral:'+str(ident),text).encode('utf-8')
  parts.extend([struct.pack('<IBH',ident,flag,len(text)),text])
 return host.writeBytes('story.neutral',base64.b64encode(b''.join(parts)).decode('ascii'))
def assemble(host,input): return {'complete':True}
`;

test('Python recipes require the explicit module protocol instead of accepting the former CLI contract', runtimeCheck, async t => {
  const f = await fixture(t);
  const lab = await createAdapterLab({ dataDir: path.join(f.root, 'lab'), workspaceFor: () => f.workDir, execution: f.execution });
  const manifest = { schemaVersion: 1, id: 'old-cli-recipe', version: '1.0.0', engine: 'Neutral', license: 'MIT', scope: { files: ['story.neutral'] }, execution: { runtime: 'python' } };
  await assert.rejects(lab.writeAdapter({ projectId: f.projectId, manifest, code: 'import json,sys\nreq=json.load(sys.stdin)' }), { code: 'PYTHON_ADAPTER_PROTOCOL' });
});

test('A15 A16 same technical Agent writes unregistered binary Python recipe and reuses real validated writer through adaptive worker', runtimeCheck, async t => {
  const f = await fixture(t), before = pack([{ id: 41, flag: 7, text: 'Welcome.' }, { id: 92, flag: 3, text: 'Stay here.' }]);
  await writeFile(path.join(f.gameDir, 'story.neutral'), before);
  const manifest = { schemaVersion: 1, id: 'neutral-binary-script', version: '1.0.0', engine: 'Neutral', license: 'MIT', scope: { files: ['story.neutral'] }, execution: { runtime: 'python', protocol: 'python-module-v1' } };
  const lab = await createAdapterLab({ dataDir: path.join(f.root, 'lab'), workspaceFor: () => f.workDir, execution: f.execution, structuralVerifier: async ({ before, after, translations }) => {
    const original = unpack(before), actual = unpack(after);
    return { valid: JSON.stringify(original.map(row => ({ ...row, text: translations[`neutral:${row.id}`] ?? row.text }))) === JSON.stringify(actual) };
  } });
  const result = await runAdaptation({ project: { id: f.projectId, name: 'neutral', engine: 'Neutral' }, lab, gameDir: f.gameDir, workspaceDir: f.workDir,
    inventory: {}, generate: async ({ tools }) => {
      await tools.write_workspace_file.execute({ file: 'inspect.py', content: "from pathlib import Path\nprint(Path(" + JSON.stringify(path.join(f.gameDir, 'story.neutral')) + ").read_bytes()[:8])" });
      const started = await tools.run_workspace.execute({ program: 'python', args: ['inspect.py'] });
      let status; do { status = await tools.wait_run.execute({ runId: started.runId, waitMs: 100 }); } while (status.status === 'running');
      assert.match(status.content, /NEUTRAL1/);
      const { execution, ...moduleManifest } = manifest;
      const candidate = await tools.write_python_adapter.execute({ manifest: moduleManifest, code: script });
      assert.ok(candidate.candidateId, JSON.stringify(candidate));
      const validation = await tools.validate_adapter.execute(candidate);
      assert.equal(validation.passed, true, JSON.stringify(validation));
      await tools.submit_recipe.execute({ candidateId: candidate.candidateId, validationId: validation.validationId });
      return { finishReason: 'stop' };
    } });
  assert.equal(result.status, 'verified', JSON.stringify(result));
  assert.ok(result.validation.evidence.every(item => !item.evidence?.workDir || item.evidence.workDir.startsWith(path.join(f.workDir, 'technical-lab', 'script-runs') + path.sep)));
  const scriptRoot = path.join(f.workDir, 'technical-lab', 'script-runs');
  assert.ok((await readdir(scriptRoot)).length > 0);
  for (const file of await readdir(path.join(f.root, 'lab'))) assert.ok(['recipes', 'recipe-candidates', 'wheel-artifacts'].includes(file), file);
  const workspaceDir = result.extractions[0].workspaceDir;
  const worker = createAdaptiveWorker({ nativeWorker: async () => { throw new Error('unregistered native format'); }, getLab: async () => lab });
  const translations = [{ id: 'neutral:41', translation: '欢迎来到这个全新的中文世界。' }, { id: 'neutral:92', translation: '留在这里。' }];
  const built = await worker('build', { projectId: f.projectId, workspaceDir, outputDir: path.join(f.root, 'build'), translations });
  const assembled = await worker('assemble', { projectId: f.projectId, workspaceDir, buildDir: built.buildDir, outputDir: path.join(f.root, 'product') });
  const product = unpack(await readFile(path.join(assembled.outputDir, 'story.neutral')));
  assert.equal(product[0].text, translations[0].translation); assert.equal(product[0].flag, 7);
  assert.deepEqual(await readFile(path.join(f.gameDir, 'story.neutral')), before);
  const reused = await lab.tryRecipes({ projectId: f.projectId, gameDir: f.gameDir, workspaceDir: path.join(f.root, 'reused'), engine: 'Neutral' });
  assert.equal(reused.binding.recipeId, result.recipe.recipeId);
  const differentGame = path.join(f.root, 'different-format'); await mkdir(differentGame);
  await writeFile(path.join(differentGame, 'story.neutral'), Buffer.from('DIFFERENT-FORMAT'));
  assert.equal(await lab.tryRecipes({ projectId: f.projectId, gameDir: differentGame, workspaceDir: path.join(f.root, 'mismatch'), engine: 'Neutral' }), null);
  await assert.rejects(lab.tryRecipes({ projectId: 'other-project', gameDir: f.gameDir, workspaceDir: path.join(f.root, 'denied'), engine: 'Neutral' }), /允许|未找到/);
  const pending = await createAdapterLab({ dataDir: path.join(f.root, 'unverified-lab'), workspaceFor: () => f.workDir, execution: f.execution });
  const unverified = await pending.writeAdapter({ projectId: f.projectId, manifest, code: script });
  const check = await pending.validateAdapter({ projectId: f.projectId, candidateId: unverified.candidateId, gameDir: f.gameDir });
  assert.equal(check.passed, false); assert.equal(check.checks.structure, 'pending');
  await assert.rejects(pending.submitRecipe({ projectId: f.projectId, candidateId: unverified.candidateId, validationId: check.validationId }), /晋升/);
});
