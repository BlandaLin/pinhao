import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';
import { runSandbox } from './adaptation/sandbox.mjs';

const manifest = { schemaVersion: 1, id: 'fixture-dialogue', version: '1.0.0', engine: 'Fixture', scope: { files: ['data/dialogue.json'] }, license: 'GPL-3.0-or-later', sources: [] };
const code = `({
  detect(host) { return {matched: host.list('data').some(file => file.path === 'data/dialogue.json')}; },
  extract(host) {
    const data = JSON.parse(host.readText('data/dialogue.json'));
    return {units: data.lines.map((source, i) => ({id:'line:'+i, source, kind:'dialogue', context:{file:'data/dialogue.json',scene:'intro'},locator:{file:'data/dialogue.json',pointer:'/lines/'+i}})),coverage:[{file:'data/dialogue.json',status:'extracted'}]};
  },
  validate(host,input) { return {valid:true}; },
  roundtrip(host) { host.writeBytes('data/dialogue.json',host.readBytes('data/dialogue.json')); return {}; },
  build(host,input) {
    const data=JSON.parse(host.readText('data/dialogue.json'));
    for(const unit of input.units) if(Object.hasOwn(input.translations,unit.id)) data.lines[Number(unit.locator.pointer.split('/').pop())]=input.translations[unit.id];
    host.writeText('data/dialogue.json',JSON.stringify(data)); return {};
  },
  assemble() { return {complete:true}; }
})`;

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gameDir = path.join(root, 'game');
  await mkdir(path.join(gameDir, 'data'), { recursive: true });
  await writeFile(path.join(gameDir, 'data/dialogue.json'), `${JSON.stringify({ lines: ['Welcome \\C[2]hero', 'A whole scene.'], logic: { target: 'keep-id' } }, null, 2)}\n`);
  await writeFile(path.join(gameDir, 'Game.exe'), 'fixture launch marker');
  const dataDir = path.join(root, 'lab');
  const lab = await createAdapterLab({ dataDir, ...options });
  return { root, gameDir, dataDir, lab, workspaceDir: path.join(root, 'workbench') };
}

test('generated adapter validates byte roundtrip, protected sample and persistent reuse', async t => {
  const { root, gameDir, dataDir, lab, workspaceDir } = await fixture(t);
  const before = await readFile(path.join(gameDir, 'data/dialogue.json'));
  const candidate = await lab.writeAdapter({ manifest, code });
  const validation = await lab.validateAdapter({ ...candidate, gameDir, workspaceDir });
  assert.equal(validation.passed, true, validation.error?.message);
  assert.equal(validation.checks.roundtrip, 'passed');
  assert.equal(validation.checks.sample, 'passed');
  assert.equal(validation.runtime.status, 'pending');
  assert.match(validation.extraction.units[0].source, /\{\{CTRL0001\}\}/);
  const recipe = await lab.submitRecipe({ ...candidate, validationId: validation.validationId });
  const reopened = await createAdapterLab({ dataDir });
  const extracted = await reopened.tryRecipes({ gameDir, workspaceDir, engine: 'Fixture' });
  assert.equal(extracted.binding.recipeId, recipe.recipeId);
  const translations = [{ id: 'line:0', translation: '欢迎 {{CTRL0001}}勇者' }, { id: 'line:1', translation: '完整场景。' }];
  const built = await reopened.dispatch('build', { workspaceDir, outputDir: path.join(root, 'build'), translations });
  assert.equal(built.checks.textReadback, 'passed');
  const assembled = await reopened.dispatch('assemble', { workspaceDir, buildDir: built.buildDir, outputDir: path.join(root, 'output') });
  const product = JSON.parse(await readFile(path.join(assembled.outputDir, 'data/dialogue.json'), 'utf8'));
  assert.deepEqual(product.lines, ['欢迎 \\C[2]勇者', '完整场景。']);
  assert.equal(product.logic.target, 'keep-id');
  assert.equal(await readFile(path.join(assembled.outputDir, 'Game.exe'), 'utf8'), 'fixture launch marker');
  assert.deepEqual(await readFile(path.join(gameDir, 'data/dialogue.json')), before);
  assert.equal((await reopened.dispatch('validate', { workspaceDir, translations })).valid, true);
  assert.equal(assembled.launchPath, path.join(root, 'output', 'Game.exe'));
});

test('old passed proofs cannot bypass the current JSON identity policy at reuse, submit or binding', async t => {
  const { dataDir, lab, gameDir, workspaceDir } = await fixture(t);
  const candidate = await lab.writeAdapter({ manifest, code });
  const validation = await lab.validateAdapter({ ...candidate, gameDir });
  const recipe = await lab.submitRecipe({ ...candidate, validationId: validation.validationId });
  await lab.extractRecipe({ recipeId: recipe.recipeId, gameDir, workspaceDir });
  const file = path.join(dataDir, 'validations', `${validation.validationId}.json`);
  const old = JSON.parse(await readFile(file, 'utf8'));
  assert.match(old.dependencies.identity.jsonFieldPolicy, /^pinhao-json-field-policy-/);
  delete old.dependencies.identity.jsonFieldPolicy;
  old.dependencies.identity.protocol = 'pinhao-validation-2';
  old.dependencies.identity.checker = 'builtin-json-utf8-v2';
  await writeFile(file, JSON.stringify(old));
  const reopened = await createAdapterLab({ dataDir });
  await assert.rejects(reopened.submitRecipe({ ...candidate, validationId: validation.validationId }), /依赖|验证|变化/);
  await assert.rejects(reopened.dispatch('validate', { workspaceDir, translations: [] }), /依赖或验证协议已变化/);
  const fresh = await reopened.validateAdapter({ ...candidate, gameDir });
  assert.equal(fresh.passed, true, fresh.error?.message);
  assert.notEqual(fresh.reused, true);
  assert.notEqual(fresh.validationId, validation.validationId);
});

test('invalid detect shapes report the actual method contract without accepting alternative status fields', async t => {
  const { gameDir, lab, workspaceDir } = await fixture(t);
  for (const detection of [{ detected: true }, { status: 'detected' }, null, 'matched']) {
    const candidate = await lab.writeAdapter({ manifest, code: code.replace(
      "return {matched: host.list('data').some(file => file.path === 'data/dialogue.json')};", `return ${JSON.stringify(detection)};`) });
    const validation = await lab.validateAdapter({ ...candidate, gameDir, workspaceDir });
    assert.equal(validation.passed, false);
    assert.equal(validation.error.code, 'ADAPTER_DETECT_CONTRACT');
    assert.match(validation.error.message, /true\/false.*matched/);
    assert.deepEqual(validation.error.evidence.actual, detection);
    assert.equal(validation.extraction, undefined);
  }
  const rejected = await lab.writeAdapter({ manifest, code: code.replace(
    "return {matched: host.list('data').some(file => file.path === 'data/dialogue.json')};", 'return {matched:false};') });
  const result = await lab.validateAdapter({ ...rejected, gameDir, workspaceDir });
  assert.equal(result.passed, false);
  assert.match(result.error.message, /资源特征不符/);
});

test('project construction records stay beside the game and only registered code is shared', async t => {
  const workspaces = new Map();
  const { root, gameDir, dataDir, lab, workspaceDir } = await fixture(t, { workspaceFor: ({ projectId }) => workspaces.get(projectId) });
  workspaces.set('project-first', workspaceDir);
  workspaces.set('project-second', path.join(root, 'second-workbench'));
  const first = { projectId: 'project-first' }, second = { projectId: 'project-second' };
  const before = await readFile(path.join(gameDir, 'data/dialogue.json'));
  const failed = await lab.writeAdapter({ ...first, manifest, code: code.replace('return {matched:', 'throw new Error("failed candidate"); return {matched:') });
  const failedValidation = await lab.validateAdapter({ ...first, ...failed, gameDir });
  assert.equal(failedValidation.passed, false);
  await assert.rejects(lab.inspectAdapter({ ...second, candidateId: failed.candidateId }), { code: 'ENOENT' });
  assert.deepEqual((await readdir(dataDir)).sort(), ['recipe-candidates', 'recipes']);
  assert.deepEqual(await readdir(path.join(dataDir, 'recipe-candidates')), []);
  const candidate = await lab.writeAdapter({ ...first, manifest, code });
  const validation = await lab.validateAdapter({ ...first, ...candidate, gameDir });
  assert.equal(validation.passed, true, validation.error?.message);
  const local = path.join(workspaceDir, 'technical-lab');
  assert.ok((await readdir(path.join(local, 'candidates'))).includes(`${candidate.candidateId}.json`));
  assert.ok((await readdir(path.join(local, 'validations'))).includes(`${validation.validationId}.json`));
  assert.ok(validation.sample.path.startsWith(path.join(local, 'runs') + path.sep));
  const recipe = await lab.submitRecipe({ ...first, candidateId: candidate.candidateId, validationId: validation.validationId });
  assert.deepEqual(await readdir(path.join(dataDir, 'recipe-candidates')), [`${candidate.candidateId}.json`]);
  const reused = await lab.extractRecipe({ ...second, recipeId: recipe.recipeId, gameDir, workspaceDir: path.join(workspaces.get(second.projectId), 'extract') });
  assert.equal(reused.binding.recipeId, recipe.recipeId);
  assert.notEqual(reused.binding.validationId, validation.validationId);
  const secondLocal = path.join(workspaces.get(second.projectId), 'technical-lab');
  assert.ok((await readdir(path.join(secondLocal, 'validations'))).includes(`${reused.binding.validationId}.json`));
  assert.deepEqual((await readdir(dataDir)).sort(), ['recipe-candidates', 'recipes']);
  assert.deepEqual(await readFile(path.join(gameDir, 'data/dialogue.json')), before);
});

test('parallel project validations keep their host budget contexts isolated across nested lab calls', async t => {
  const workspaces = new Map(), seen = [], rendezvous = Promise.withResolvers();
  const displayVerifier = async input => {
    seen.push({ projectId: input.projectId, context: input.requestContext, workspaceDir: input.workspaceDir });
    if (seen.length === 2) rendezvous.resolve();
    await rendezvous.promise;
    return { status: 'passed', decisions: input.units.map(unit => ({ id: unit.id, status: 'display-supported' })) };
  };
  displayVerifier.isFresh = async () => true;
  const { root, gameDir, lab } = await fixture(t, { workspaceFor: ({ projectId }) => workspaces.get(projectId), displayVerifier });
  const inputs = ['first', 'second'].map(id => {
    const projectId = `project-${id}`, workspaceDir = path.join(root, `${id}-workspace`);
    workspaces.set(projectId, workspaceDir);
    return { projectId, workspaceDir, requestContext: { owner: { identity: id }, jobId: `job-${id}`, windowId: `window-${id}` } };
  });
  const candidates = await Promise.all(inputs.map(input => lab.writeAdapter({ ...input, manifest, code })));
  const results = await Promise.all(inputs.map((input, index) => lab.validateAdapter({ ...input, ...candidates[index], gameDir })));
  assert.equal(results.every(result => result.passed), true, JSON.stringify(results.map(result => result.error)));
  assert.equal(seen.length, 2);
  for (const input of inputs) {
    const actual = seen.find(row => row.projectId === input.projectId);
    assert.equal(actual.context, input.requestContext); assert.equal(actual.workspaceDir, input.workspaceDir);
    const receipt = JSON.parse(await readFile(path.join(input.workspaceDir, 'technical-lab', 'validations', `${results[inputs.indexOf(input)].validationId}.json`), 'utf8'));
    assert.equal(JSON.stringify(receipt).includes('requestContext'), false, 'host owner is not serialized into a candidate or model payload');
  }
});

test('real error is returned and repaired code can be promoted', async t => {
  const { lab, gameDir } = await fixture(t);
  const broken = await lab.writeAdapter({ manifest, code: code.replace("JSON.parse(host.readText('data/dialogue.json'))", "JSON.parse('bad JSON')") });
  const failed = await lab.validateAdapter({ ...broken, gameDir });
  assert.equal(failed.passed, false); assert.match(failed.error.message, /JSON|unexpected|expect/i);
  await assert.rejects(lab.submitRecipe({ ...broken, validationId: failed.validationId }), /晋升/);
  const repaired = await lab.writeAdapter({ manifest, code });
  const result = await lab.validateAdapter({ ...repaired, gameDir });
  assert.equal(result.passed, true, result.error?.message);
  await lab.submitRecipe({ ...repaired, validationId: result.validationId });
  assert.equal((await lab.listRecipes()).length, 1);
});

test('adapter scope rejects case aliases of the same Windows resource', async t => {
  const { lab } = await fixture(t);
  await assert.rejects(lab.writeAdapter({ manifest: { ...manifest, scope: { files: ['data/dialogue.json', 'DATA/Dialogue.json'] } }, code }), /重复文件/);
});

test('host JSON pointer checks accept a UTF-8 BOM while keeping the unchanged roundtrip exact', async t => {
  const { lab, gameDir } = await fixture(t);
  const file = path.join(gameDir, 'data/dialogue.json');
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await readFile(file)]);
  await writeFile(file, original);
  const candidate = await lab.writeAdapter({ manifest, code: code.replaceAll("host.readText('data/dialogue.json')", "host.readText('data/dialogue.json').replace(/^\\uFEFF/,'')") });
  const validation = await lab.validateAdapter({ ...candidate, gameDir });
  assert.equal(validation.passed, true, validation.error?.message);
  assert.equal(validation.checks.roundtrip, 'passed');
  assert.deepEqual(await readFile(file), original);
});

test('real guest build rejects a parseable translation that closes a JavaScript string', async t => {
  const { root, lab, gameDir, workspaceDir } = await fixture(t);
  const original = 'drawText("Safe text");';
  await writeFile(path.join(gameDir, 'plugin.js'), original);
  const manifestJs = { ...manifest, id: 'fixture-js-literal', scope: { files: ['plugin.js'] } };
  const codeJs = `({detect(){return true},extract(host){const text=host.readText('plugin.js'),start=text.indexOf('"')+1,end=text.lastIndexOf('"');return {units:[{id:'plugin:caption',source:text.slice(start,end),locator:{file:'plugin.js',byteStart:start,byteEnd:end}}]}},validate(){return {valid:true}},roundtrip(host){host.writeBytes('plugin.js',host.readBytes('plugin.js'));return {}},build(host,input){host.writeText('plugin.js','drawText("'+(input.translations['plugin:caption']??'Safe text')+'");');return {}},assemble(){return {}}})`;
  const candidate = await lab.writeAdapter({ manifest: manifestJs, code: codeJs });
  const validation = await lab.validateAdapter({ ...candidate, gameDir });
  assert.equal(validation.passed, true, validation.error?.message);
  const recipe = await lab.submitRecipe({ ...candidate, validationId: validation.validationId });
  await lab.extractRecipe({ recipeId: recipe.recipeId, gameDir, workspaceDir });
  await assert.rejects(lab.dispatch('build', { workspaceDir, outputDir: path.join(root, 'unsafe-script-build'), translations: [{ id: 'plugin:caption', translation: 'Hello");globalThis.injected=true;drawText("extra' }] }), /结构|边界/);
  assert.equal(await readFile(path.join(gameDir, 'plugin.js'), 'utf8'), original);
});

test('guest has no Node, environment, network or process capabilities', async t => {
  const { gameDir } = await fixture(t);
  const result = await runSandbox({ code: code.replace('return {complete:true}', "return {globals:[typeof process,typeof require,typeof fetch,typeof WebSocket,typeof Deno] }"), action: 'assemble', sourceDir: gameDir });
  assert.deepEqual(result.result.globals, ['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
});

test('sandbox rejects traversal, undeclared writes, links and source output overlap', async t => {
  const { root, gameDir } = await fixture(t);
  const run = (body, extra = {}) => runSandbox({ code: code.replace('return {complete:true}', body), action: 'assemble', sourceDir: gameDir, outputDir: path.join(root, 'writes'), allowedFiles: manifest.scope.files, ...extra });
  await assert.rejects(run("return host.readText('../private')"), /路径越界/);
  await assert.rejects(run("return host.writeText('other.json','oops')"), /未在配方范围/);
  await assert.rejects(run('return {}', { outputDir: path.join(gameDir, 'nested') }), /与游戏原版分开/);
  await writeFile(path.join(root, 'private'), 'private');
  try { await symlink(path.join(root, 'private'), path.join(gameDir, 'link.txt')); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error; }
  await assert.rejects(run("return host.readText('link.txt')"), /包含链接/);
});

test('sandbox terminates runaway code and handles cancellation', async t => {
  const { gameDir } = await fixture(t);
  await assert.rejects(runSandbox({ code: code.replace('return {complete:true}', 'while(true){}'), action: 'assemble', sourceDir: gameDir, limits: { timeoutMs: 40 } }), /interrupt|超时/i);
  const controller = new AbortController();
  const pending = runSandbox({ code: code.replace('return {complete:true}', 'while(true){}'), action: 'assemble', sourceDir: gameDir, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, error => error.name === 'AbortError');
});

test('baseline changes, ID collisions and false roundtrips fail validation', async t => {
  const { lab, gameDir, workspaceDir } = await fixture(t);
  const duplicate = await lab.writeAdapter({ manifest, code: code.replace("id:'line:'+i", "id:'line:0'") });
  assert.equal((await lab.validateAdapter({ ...duplicate, gameDir })).passed, false);
  const changesBytes = await lab.writeAdapter({ manifest, code: code.replace("host.writeBytes('data/dialogue.json',host.readBytes('data/dialogue.json'))", "host.writeText('data/dialogue.json','{}')") });
  const falseProof = await lab.validateAdapter({ ...changesBytes, gameDir });
  assert.equal(falseProof.passed, false); assert.match(falseProof.error.message, /原样往返/);
  const candidate = await lab.writeAdapter({ manifest, code });
  const validation = await lab.validateAdapter({ ...candidate, gameDir });
  const recipe = await lab.submitRecipe({ ...candidate, validationId: validation.validationId });
  await lab.extractRecipe({ recipeId: recipe.recipeId, gameDir, workspaceDir });
  await writeFile(path.join(gameDir, 'data/dialogue.json'), '{"lines":["Changed"]}');
  await assert.rejects(lab.dispatch('validate', { workspaceDir, translations: [] }), /资源已经变化/);
});

test('binding proof hashes overlapping resources once and rechecks same-size dependency edits', async t => {
  const { lab, gameDir, workspaceDir } = await fixture(t);
  await writeFile(path.join(gameDir, 'data/config.json'), '{"flag":false}');
  const candidate = await lab.writeAdapter({ manifest, code: code.replace('extract(host) {', "extract(host) { if(host.list('data').some(file=>file.path==='data/config.json')) host.readText('data/config.json');") });
  const validation = await lab.validateAdapter({ ...candidate, gameDir });
  assert.equal(validation.passed, true, validation.error?.message);
  const recipe = await lab.submitRecipe({ ...candidate, validationId: validation.validationId });
  await lab.extractRecipe({ recipeId: recipe.recipeId, gameDir, workspaceDir });
  const original = fs.promises.readFile, reads = new Map();
  fs.promises.readFile = async (target, ...args) => {
    const relative = path.relative(gameDir, String(target)).replaceAll('\\', '/');
    if (relative.startsWith('data/')) reads.set(relative, (reads.get(relative) ?? 0) + 1);
    return original(target, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.promises.readFile = original; syncBuiltinESMExports(); });
  assert.equal((await lab.dispatch('validate', { workspaceDir, translations: [] })).valid, true);
  assert.equal(reads.get('data/dialogue.json'), 1);
  assert.equal(reads.get('data/config.json'), 1);
  await writeFile(path.join(gameDir, 'data/config.json'), '{"flag":true }');
  await assert.rejects(lab.dispatch('validate', { workspaceDir, translations: [] }), /依赖或验证协议已变化/);
  assert.equal(reads.get('data/dialogue.json'), 2);
  assert.equal(reads.get('data/config.json'), 2);
  await writeFile(path.join(gameDir, 'data/config.json'), '{"flag":false}');
  assert.equal((await lab.dispatch('validate', { workspaceDir, translations: [] })).valid, true);
  const source = await original(path.join(gameDir, 'data/dialogue.json'), 'utf8');
  await writeFile(path.join(gameDir, 'data/dialogue.json'), source.replace('whole', 'other'));
  await assert.rejects(lab.dispatch('validate', { workspaceDir, translations: [] }), /资源已经变化/);
  assert.equal(reads.get('data/dialogue.json'), 4);
});

test('final adapter verification reads a fresh baseline after runtime validation', async t => {
  const { lab, gameDir } = await fixture(t, { runtimeVerifier: async ({ gameDir }) => {
    const file = path.join(gameDir, 'data/dialogue.json'), source = await readFile(file, 'utf8');
    await writeFile(file, source.replace('whole', 'other'));
    return { status: 'passed' };
  } });
  const candidate = await lab.writeAdapter({ manifest, code });
  const validation = await lab.validateAdapter({ ...candidate, gameDir });
  assert.equal(validation.passed, false);
  assert.match(validation.error.message, /资源已经变化/);
});

test('generated units use a namespace distinct from built-in script and image routes', async t => {
  const { lab, gameDir } = await fixture(t);
  for (const prefix of ['script', 'image']) {
    const candidate = await lab.writeAdapter({ manifest, code: code.replace("id:'line:'+i", `id:'${prefix}:'+i`) });
    const validation = await lab.validateAdapter({ ...candidate, gameDir });
    assert.equal(validation.passed, false);
    assert.match(validation.error.message, /独立 ID 前缀/);
    await assert.rejects(lab.submitRecipe({ ...candidate, validationId: validation.validationId }), /晋升/);
  }
});

test('host tool execution requires a fixed trusted command and argument policy', async t => {
  const { lab, root, gameDir } = await fixture(t);
  await assert.rejects(lab.runTool({ tool: 'node', args: ['-e', 'process.exit()'], gameDir, workDir: path.join(root, 'tool') }), /可信工具/);
});

test('host structure verification catches gameplay and reference edits despite guest claiming valid', async t => {
  const { lab, gameDir } = await fixture(t);
  const corrupt = await lab.writeAdapter({ manifest, code: code.replace("host.writeText('data/dialogue.json',JSON.stringify(data))", "data.logic.target='changed-resource-id';host.writeText('data/dialogue.json',JSON.stringify(data))") });
  const validation = await lab.validateAdapter({ ...corrupt, gameDir });
  assert.equal(validation.passed, false);
  assert.equal(validation.checks.roundtrip, 'passed');
  assert.match(validation.error.message, /逻辑或资源引用/);
  await assert.rejects(lab.submitRecipe({ ...corrupt, validationId: validation.validationId }), /晋升/);
});

test('controls, unknown IDs and duplicate translations are rejected before build', async t => {
  const { root, lab, gameDir, workspaceDir } = await fixture(t);
  const candidate = await lab.writeAdapter({ manifest, code });
  const validation = await lab.validateAdapter({ ...candidate, gameDir });
  const recipe = await lab.submitRecipe({ ...candidate, validationId: validation.validationId });
  await lab.extractRecipe({ ...recipe, gameDir, workspaceDir });
  const build = translations => lab.dispatch('build', { workspaceDir, outputDir: path.join(root, 'build'), translations });
  await assert.rejects(build([{ id: 'line:0', translation: '丢弃控制符' }]), /保护标记/);
  await assert.rejects(build([{ id: 'missing', translation: '未知' }]), /未知或重复/);
  // Long enough to clear the truncation guard so the duplicate-ID check is what rejects it.
  await assert.rejects(build([{ id: 'line:1', translation: '第一版译文' }, { id: 'line:1', translation: '第二版译文' }]), /未知或重复/);
});

test('candidate code substitution and forged validation cannot be promoted', async t => {
  const { lab, dataDir, gameDir } = await fixture(t);
  const candidate = await lab.writeAdapter({ manifest, code });
  const validation = await lab.validateAdapter({ ...candidate, gameDir });
  const file = path.join(dataDir, 'candidates', `${candidate.candidateId}.json`);
  const record = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...record, code: code.replace('complete:true', 'complete:false') }));
  await assert.rejects(lab.inspectAdapter(candidate), /候选校验失败/);
  await assert.rejects(lab.submitRecipe({ ...candidate, validationId: validation.validationId }), /候选校验失败/);
  const other = await lab.writeAdapter({ manifest: { ...manifest, version: '1.0.1' }, code });
  await assert.rejects(lab.submitRecipe({ ...other, validationId: validation.validationId }), /晋升/);
});

test('registered trusted callbacks are discoverable, constrained and isolated from mutable registry', async t => {
  const calls = [];
  const tools = { native_probe: { description: '读取原生引擎目录', argsHint: '[]', validateArgs: args => args.length === 0, execute: async input => { calls.push(input); return { engine: 'Fixture' }; } } };
  const { lab, root, gameDir } = await fixture(t, { trustedTools: tools });
  tools.native_probe.execute = () => { throw new Error('mutated'); };
  assert.deepEqual(lab.listTools(), [{ name: 'native_probe', description: '读取原生引擎目录', argsHint: '[]', capabilities: { protocol: 1, operation: 'native_probe' }, limits: { timeoutMs: 30000, maxOutputBytes: 1048576 } }]);
  assert.deepEqual(await lab.runTool({ tool: 'native_probe', args: [], gameDir, workDir: path.join(root, 'tools') }), { engine: 'Fixture' });
  assert.equal(calls.length, 1); assert.deepEqual(Object.keys(calls[0]).sort(), ['args', 'gameDir', 'signal', 'workDir']);
  await assert.rejects(lab.runTool({ tool: 'native_probe', args: ['--source=elsewhere'], gameDir, workDir: path.join(root, 'tools') }), /可信工具/);
});

test('standalone assembly shares the canonical private-path policy while preserving authored assets', async t => {
  const { root, lab, gameDir, workspaceDir } = await fixture(t);
  const files = { 'save/private.rpgsave': 'private save', 'logs/game.log': 'private runtime log', 'cache/story.json': '{"text":"authored resource"}', 'img/save/title.png': 'authored image marker' };
  for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(gameDir, name)), { recursive: true }); await writeFile(path.join(gameDir, name), content); }
  const candidate = await lab.writeAdapter({ manifest, code });
  const validation = await lab.validateAdapter({ ...candidate, gameDir });
  const recipe = await lab.submitRecipe({ ...candidate, validationId: validation.validationId });
  await lab.extractRecipe({ recipeId: recipe.recipeId, gameDir, workspaceDir });
  const built = await lab.dispatch('build', { workspaceDir, outputDir: path.join(root, 'privacy-build'), translations: [{ id: 'line:0', translation: '欢迎 {{CTRL0001}}勇者' }] });
  const outputDir = path.join(root, 'privacy-product');
  await lab.dispatch('assemble', { workspaceDir, buildDir: built.buildDir, outputDir });
  for (const file of ['save/private.rpgsave', 'logs/game.log']) await assert.rejects(readFile(path.join(outputDir, file)), { code: 'ENOENT' });
  for (const file of ['cache/story.json', 'img/save/title.png']) assert.equal(await readFile(path.join(outputDir, file), 'utf8'), files[file]);
});

test('direct source capabilities exclude private data without copying or classifying authored resources', async t => {
  const { root, lab, gameDir } = await fixture(t);
  const resources = { 'save/private.rpgsave': 'private save', '.env': 'private setting',
    'cache/story.json': '{"text":"authored resource"}', 'img/save/title.png': 'authored image marker' };
  for (const [file, content] of Object.entries(resources)) {
    await mkdir(path.dirname(path.join(gameDir, file)), { recursive: true });
    await writeFile(path.join(gameDir, file), content);
  }
  const listed = await lab.inspectFiles({ gameDir });
  assert.ok(listed.files.some(file => file.path === 'cache/story.json'));
  assert.ok(listed.files.some(file => file.path === 'img/save/title.png'));
  assert.ok(!listed.files.some(file => file.path === '.env' || file.path.startsWith('save/')));
  await assert.rejects(lab.inspectFiles({ gameDir, relativePath: 'save' }), /存档与私人配置/);
  await assert.rejects(lab.readResource({ gameDir, file: 'save/private.rpgsave' }), /存档与私人配置/);
  await assert.rejects(lab.writeAdapter({ manifest: { ...manifest, scope: { files: ['save/private.rpgsave'] } }, code }), /存档或私人配置/);
  const guestCode = body => code.replace('assemble() { return {complete:true}; }', `assemble(host) { ${body} }`);
  const guest = await runSandbox({ code: guestCode("return {files:host.list('')};"), action: 'assemble', sourceDir: gameDir });
  assert.deepEqual(guest.result.files, listed.files.map(({ route, ...file }) => file));
  assert.ok(listed.files.every(file => typeof file.route === 'string'));
  assert.ok(guest.result.files.every(file => !Object.hasOwn(file, 'route')), 'investigation hints are not guest dependencies');
  await assert.rejects(runSandbox({ code: guestCode("return host.readText('.env');"), action: 'assemble', sourceDir: gameDir }), /存档与私人配置/);
  await assert.rejects(runSandbox({ code: guestCode("return host.list('save');"), action: 'assemble', sourceDir: gameDir }), /存档与私人配置/);
  const workDir = path.join(root, 'workspace'); await mkdir(workDir);
  await writeFile(path.join(workDir, 'tool.log'), 'retained tool output');
  assert.equal((await lab.readResource({ gameDir: workDir, file: 'tool.log', excludePrivate: false })).content, 'retained tool output');
  for (const [file, content] of Object.entries(resources)) assert.equal(await readFile(path.join(gameDir, file), 'utf8'), content);
});

test('multiple read roots expose original-only resources and alternate same-path origins with stable pagination', async t => {
  const { root, lab, gameDir } = await fixture(t), managed = path.join(root, 'managed');
  await mkdir(path.join(managed, 'decoded'), { recursive: true });
  await writeFile(path.join(managed, 'decoded/story.json'), 'decoded story');
  await writeFile(path.join(managed, 'shared.txt'), 'managed value');
  await writeFile(path.join(gameDir, 'shared.txt'), 'original value');
  await mkdir(path.join(gameDir, 'save')); await writeFile(path.join(gameDir, 'save/private.rpgsave'), 'private');
  const options = { gameDir: managed, readRoots: [managed, gameDir] };
  const all = await lab.inspectFiles(options), shared = all.files.find(file => file.path === 'shared.txt');
  assert.ok(all.files.some(file => file.path === 'Game.exe' && file.sourceIndex === 1));
  assert.ok(all.files.some(file => file.path === 'decoded/story.json' && file.sourceIndex === 0));
  assert.ok(!all.files.some(file => file.path.startsWith('save/')));
  assert.deepEqual(shared.origins, [{ sourceIndex: 0, size: 13 }, { sourceIndex: 1, size: 14 }]);
  assert.equal((await lab.readResource({ ...options, file: 'Game.exe' })).sourceIndex, 1);
  assert.equal((await lab.readResource({ ...options, file: 'shared.txt' })).content, 'managed value');
  assert.equal((await lab.readResource({ ...options, sourceIndex: 1, file: 'shared.txt' })).content, 'original value');
  const paged = [];
  for (let offset = 0; offset !== null;) {
    const page = await lab.inspectFiles({ ...options, limit: 1, offset }); paged.push(...page.files); offset = page.nextOffset;
  }
  assert.deepEqual(paged, all.files);
  await assert.rejects(lab.readResource({ ...options, sourceIndex: 2, file: 'shared.txt' }), /sourceIndex/);
  await assert.rejects(lab.readResource({ ...options, file: 'save/private.rpgsave' }), /存档与私人配置/);
  await assert.rejects(lab.readResource({ ...options, file: 'missing.json' }), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(gameDir, 'shared.txt'), 'utf8'), 'original value');
});

test('trusted tools receive cancellation and finite deadlines', async t => {
  let observed;
  const tools = { wait: { timeoutMs: 40, validateArgs: args => !args.length, execute: async ({ signal }) => { observed = signal; return new Promise(() => {}); } } };
  const { lab, root, gameDir } = await fixture(t, { trustedTools: tools });
  await assert.rejects(lab.runTool({ tool: 'wait', gameDir, workDir: path.join(root, 'tools') }), /执行超时/);
  assert.equal(observed.aborted, true);
  const controller = new AbortController();
  const promise = lab.runTool({ tool: 'wait', gameDir, workDir: path.join(root, 'tools'), signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, error => error.name === 'AbortError');
});

test('runtime evidence remains separate and a failed runtime blocks promotion', async t => {
  const { lab, gameDir } = await fixture(t, { runtimeVerifier: async () => ({ status: 'failed', detail: 'fixture process exited unexpectedly' }) });
  const candidate = await lab.writeAdapter({ manifest, code });
  const validation = await lab.validateAdapter({ ...candidate, gameDir });
  assert.equal(validation.checks.structure, 'passed');
  assert.equal(validation.runtime.status, 'failed'); assert.equal(validation.passed, false);
  await assert.rejects(lab.submitRecipe({ ...candidate, validationId: validation.validationId }), /晋升/);
});

test('UTF-8 span adapter preserves all non-text bytes through length-changing translation', async t => {
  const { root, lab, gameDir } = await fixture(t);
  await writeFile(path.join(gameDir, 'dialogue.txt'), '# fixture header\nAlpha\nBeta\n# fixture footer');
  const spanManifest = { ...manifest, id: 'fixture-span', scope: { files: ['dialogue.txt'] } };
  const spanCode = `({
    detect(host){return {matched:host.list('').some(file=>file.path==='dialogue.txt')}} ,
    extract(host){const data=host.readText('dialogue.txt');const lines=data.split('\\n');let offset=0;const units=[];const size=s=>encodeURIComponent(s).replace(/%[0-9A-F]{2}|./g,'x').length;for(let i=0;i<lines.length;i++){if(i===1||i===2)units.push({id:'row:'+i,source:lines[i],locator:{file:'dialogue.txt',byteStart:offset,byteEnd:offset+size(lines[i])}});offset+=size(lines[i])+1;}return {units};},
    validate(){return {valid:true}},roundtrip(host){host.writeBytes('dialogue.txt',host.readBytes('dialogue.txt'));return {}},
    build(host,input){const lines=host.readText('dialogue.txt').split('\\n');for(const unit of input.units)if(Object.hasOwn(input.translations,unit.id))lines[Number(unit.id.split(':')[1])]=input.translations[unit.id];host.writeText('dialogue.txt',lines.join('\\n'));return {}},assemble(){return {}}
  })`;
  const candidate = await lab.writeAdapter({ manifest: spanManifest, code: spanCode });
  const validation = await lab.validateAdapter({ ...candidate, gameDir });
  assert.equal(validation.passed, true, validation.error?.message);
  const recipe = await lab.submitRecipe({ ...candidate, validationId: validation.validationId });
  const workspaceDir = path.join(root, 'span-workbench');
  await lab.extractRecipe({ ...recipe, gameDir, workspaceDir });
  await lab.dispatch('build', { workspaceDir, outputDir: path.join(root, 'span-build'), translations: [{ id: 'row:1', translation: '这是长度不同的中文。' }] });
  assert.equal(await readFile(path.join(root, 'span-build/dialogue.txt'), 'utf8'), '# fixture header\n这是长度不同的中文。\nBeta\n# fixture footer');
});

test('recipe journal resumes from complete records after an interrupted trailing write', async t => {
  const { dataDir, lab } = await fixture(t);
  const candidate = await lab.writeAdapter({ manifest, code });
  await appendFile(path.join(dataDir, 'candidates', `${candidate.candidateId}.json`), '{"interrupted":');
  assert.equal((await lab.inspectAdapter(candidate)).codeHash, candidate.codeHash);
  await lab.writeAdapter({ manifest, code });
  assert.equal((await lab.inspectAdapter(candidate)).code, code);
});

test('concurrent identical candidates keep complete durable records', async t => {
  const { dataDir, lab } = await fixture(t);
  const records = await Promise.all(Array.from({ length: 12 }, () => lab.writeAdapter({ manifest, code })));
  assert.equal(new Set(records.map(record => record.candidateId)).size, 1);
  const file = path.join(dataDir, 'candidates', `${records[0].candidateId}.json`);
  const lines = (await readFile(file, 'utf8')).split('\n').filter(line => line.trim());
  assert.equal(lines.length, 12);
  assert.ok(lines.map(line => JSON.parse(line)).every(record => record.codeHash === records[0].codeHash));
  assert.equal((await lab.inspectAdapter(records[0])).code, code);
});

test('concurrent lab initialization validates and shares newly created directories', async t => {
  const { root } = await fixture(t);
  const dataDir = path.join(root, 'new-parent', 'shared-recipes');
  const instances = await Promise.all(Array.from({ length: 3 }, () => createAdapterLab({ dataDir })));
  const candidate = await instances[0].writeAdapter({ manifest, code });
  assert.equal((await instances[2].inspectAdapter(candidate)).codeHash, candidate.codeHash);
});

test('unsupported binary locators require an explicit trusted structure verifier', async t => {
  const { lab, gameDir } = await fixture(t);
  const opaque = code.replace("pointer:'/lines/'+i", 'record:i').replace("Number(unit.locator.pointer.split('/').pop())", "Number(unit.id.split(':').pop())");
  const candidate = await lab.writeAdapter({ manifest, code: opaque });
  const validation = await lab.validateAdapter({ ...candidate, gameDir });
  assert.equal(validation.passed, false); assert.equal(validation.error.code, 'FORMAT_LOCATOR_UNSUPPORTED');
  assert.equal(validation.checks.structure, 'pending');
});
