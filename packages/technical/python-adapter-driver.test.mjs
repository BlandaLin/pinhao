import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';

const pythonPath = path.resolve(process.env.PINHAO_TEST_PYTHON ?? 'local/runtime/python/python.exe');
const runtime = { skip: !existsSync(pythonPath) };
const moduleCode = String.raw`import json
def detect(host,input): return {'matched':isinstance(json.loads(host.readText('story.json')),dict)}
def extract(host,input):
 data=json.loads(host.readText('story.json'))
 return {'units':[{'id':'line:1','source':data['caption'],'locator':{'file':'story.json','pointer':'/caption'}}]}
def validate(host,input): return {'valid':True}
def roundtrip(host,input): return host.writeBytes('story.json',host.readBytes('story.json'))
def build(host,input):
 data=json.loads(host.readText('story.json')); data['caption']=input['translations'].get('line:1',data['caption'])
 host.writeText('story.json',json.dumps(data,ensure_ascii=False)); return {}
def assemble(host,input): return {'complete':True}
`;
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-python-module-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const gameDir = path.join(root, 'source'), workDir = path.join(root, 'work');
  await mkdir(gameDir); await mkdir(workDir);
  await writeFile(path.join(gameDir, 'story.json'), '{ "caption": "Welcome.", "identity": 42 }\n');
  const projectId = 'driver-test';
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab'), workspaceFor: () => workDir,
    execution: { pythonPath, authorize: async input => input.projectId === projectId }, ...options });
  t.after(() => lab.closeExecution());
  const manifest = { schemaVersion: 1, id: 'json-module', version: '1.0.0', engine: 'Neutral', license: 'MIT', scope: { files: ['story.json'] }, execution: { runtime: 'python', protocol: 'python-module-v1' } };
  const save = code => lab.writeAdapter({ projectId, manifest, code, workDir });
  return { root, gameDir, workDir, projectId, lab, manifest, save };
}

test('module driver executes six actions through the Lab and records declared reads without changing other JSON fields', runtime, async t => {
  const f = await fixture(t), candidate = await f.save(moduleCode), original = await readFile(path.join(f.gameDir, 'story.json'));
  const validation = await f.lab.validateAdapter({ ...f, candidateId: candidate.candidateId });
  assert.equal(validation.passed, true, JSON.stringify(validation.error));
  assert.ok(validation.evidence.every(item => item.evidence.action === item.action));
  assert.ok(validation.evidence.some(item => item.reads?.includes('story.json')));
  assert.equal(validation.dependencies.identity.python.protocol, 'python-module-v1');
  assert.match(validation.dependencies.identity.python.driver, /^[a-f0-9]{64}$/);
  const recipe = await f.lab.submitRecipe({ ...f, candidateId: candidate.candidateId, validationId: validation.validationId });
  const extraction = await f.lab.extractRecipe({ ...f, recipeId: recipe.recipeId, workspaceDir: path.join(f.root, 'bound') });
  const build = await f.lab.dispatch('build', { ...f, workspaceDir: extraction.workspaceDir, outputDir: path.join(f.root, 'build'), translations: [{ id: 'line:1', translation: '欢迎来到旅店。' }] });
  const product = await f.lab.dispatch('assemble', { ...f, workspaceDir: extraction.workspaceDir, buildDir: build.buildDir, outputDir: path.join(f.root, 'product') });
  assert.equal(product.adapterResult.complete, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(product.outputDir, 'story.json'), 'utf8')), { caption: '欢迎来到旅店。', identity: 42 });
  assert.deepEqual(await readFile(path.join(f.gameDir, 'story.json')), original);
});

test('Python action contracts reject missing methods, bad signatures, None and ok aliases with exact action evidence', runtime, async t => {
  const f = await fixture(t);
  const cases = [
    ['extract', moduleCode.replace('def assemble(host,input):', 'def not_assemble(host,input):'), /assemble\(host,input\)/],
    ['extract', moduleCode.replace('def extract(host,input):', 'def extract(host,input,required):'), /extract\(host,input\)/],
    ['detect', moduleCode.replace("return {'matched':isinstance(json.loads(host.readText('story.json')),dict)}", 'return None'), /None/],
    ['detect', moduleCode.replace("return {'matched':isinstance(json.loads(host.readText('story.json')),dict)}", "__import__('os')._exit(0)"), /未产生有效结果/],
    ['validate', moduleCode.replace("return {'valid':True}", "return {'ok':False}"), /valid:boolean/],
    ['extract', moduleCode.replace("data=json.loads(host.readText('story.json'))", "raise ValueError('actual parser failure')"), /actual parser failure/],
  ];
  for (const [action, code, pattern] of cases) {
    const candidate = await f.save(code);
    await assert.rejects(f.lab.previewAdapter({ ...f, candidateId: candidate.candidateId, action }), error => {
      assert.match(error.message, pattern); assert.equal(error.evidence.action, action);
      assert.match(error.code, /^PYTHON_ADAPTER_/); assert.ok(error.evidence.runId); return true;
    });
  }
});

test('declared host read/list boundaries preserve full dependency hashes and detect same-size auxiliary changes', runtime, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.gameDir, 'roles.txt'), 'role=one');
  await writeFile(path.join(f.gameDir, 'not-declared.txt'), 'not in host view');
  f.manifest.execution.readFiles = ['roles.txt'];
  const code = moduleCode.replace("def validate(host,input): return {'valid':True}", "def validate(host,input):\n host.log(host.list())\n assert [v['path'] for v in host.list()]==['roles.txt','story.json']\n assert host.readText('roles.txt')=='role=one'\n return {'valid':True}");
  const candidate = await f.save(code), validation = await f.lab.validateAdapter({ ...f, candidateId: candidate.candidateId });
  assert.equal(validation.passed, true, JSON.stringify(validation.error));
  assert.ok(validation.dependencies.files['roles.txt']);
  assert.deepEqual(validation.dependencies.listings, {});
  assert.ok(validation.evidence.some(item => item.evidence.declaredListings.length));
  await writeFile(path.join(f.gameDir, 'roles.txt'), 'role=two');
  await assert.rejects(f.lab.submitRecipe({ ...f, candidateId: candidate.candidateId, validationId: validation.validationId }), /变化/);
  const undeclared = await f.save(moduleCode.replace("def validate(host,input): return {'valid':True}", "def validate(host,input):\n host.readText('not-declared.txt')\n return True"));
  await assert.rejects(f.lab.previewAdapter({ ...f, candidateId: undeclared.candidateId, action: 'validate' }), /not declared/);
});

test('Python host IO budgets and read-only actions remain actual failures rather than successful empty output', runtime, async t => {
  const f = await fixture(t, { limits: { maxReadBytes: 1 } });
  const candidate = await f.save(moduleCode);
  await assert.rejects(f.lab.previewAdapter({ ...f, candidateId: candidate.candidateId, action: 'extract' }), /read exceeds limits/);
  const other = await fixture(t);
  const write = await other.save(moduleCode.replace("def validate(host,input): return {'valid':True}", "def validate(host,input):\n host.writeText('story.json','wrong')\n return True"));
  await assert.rejects(other.lab.previewAdapter({ ...other, candidateId: write.candidateId, action: 'validate' }), /read-only/);
  const nul = await other.save(moduleCode.replace("def validate(host,input): return {'valid':True}", "def validate(host,input):\n host.list(chr(0))\n return True"));
  await assert.rejects(other.lab.previewAdapter({ ...other, candidateId: nul.candidateId, action: 'validate' }), /relative resource path/);
});
