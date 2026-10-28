import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, link, utimes, rm, unlink, cp, lstat, realpath, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { createAdaptationSource, createAdaptiveWorker, registerSupplement } from './adaptive-worker.mjs';
import { createAdapterLab } from '../technical/adaptation/adapter-lab.mjs';
import { runAdaptation } from '../technical/adaptation.mjs';
import { selectSupplementalUnits } from './adaptation-results.mjs';

const executeFile = promisify(execFile);

async function fixture(t) {
  const base = os.tmpdir();
  const root = await mkdtemp(path.join(base, 'pinhao-adaptive-copy-'));
  t.after(async () => {
    const relative = path.relative(base, root);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const gameDir = path.join(root, 'game');
  await mkdir(path.join(gameDir, 'data'), { recursive: true });
  await writeFile(path.join(gameDir, 'data/dialogue.json'), 'fresh-copy');
  return { root, gameDir };
}

test('supplement registration reconciles an interrupted DB commit and retains earlier targets atomically', async t => {
  const { root, gameDir } = await fixture(t), file = 'data/dialogue.json';
  await writeFile(path.join(gameDir, file), JSON.stringify({ lines: ['First caption.', 'Second caption.'], switchId: 4 }));
  const workspaceDir = path.join(root, 'native'), originalWriter = path.join(root, 'candidates', 'partial');
  await mkdir(workspaceDir);
  const first = { id: 'first', source: 'First caption.', locator: { file, pointer: '/lines/0' } };
  const second = { id: 'second', source: 'Second caption.', locator: { file, pointer: '/lines/1' } };
  const options = { workspaceDir, adapterWorkspaceDir: originalWriter, baselineDir: gameDir, sourceRoot: gameDir, files: [file] };
  await registerSupplement({ ...options, unitIds: ['first'], units: [first] });
  const retry = selectSupplementalUnits({ projectId: 'neutral', incoming: [first], existing: [] });
  assert.equal(retry.units.length, 1, 'the process stopped before saving the DB rows');
  await registerSupplement({ ...options, adapterWorkspaceDir: path.join(root, 'reused', 'partial'), unitIds: ['first'], units: [first] });
  let binding = JSON.parse(await readFile(path.join(workspaceDir, 'pinhao-composite-adapter.json'), 'utf8'));
  assert.equal(binding.adapters.length, 1); assert.equal(binding.adapters[0].workspaceDir, originalWriter);
  await registerSupplement({ ...options, unitIds: ['second'], units: [second] });
  binding = JSON.parse(await readFile(path.join(workspaceDir, 'pinhao-composite-adapter.json'), 'utf8'));
  assert.deepEqual(binding.adapters[0].unitIds, ['first', 'second']);
  assert.deepEqual(binding.adapters[0].units, [first, second]);
  const accepted = await readFile(path.join(workspaceDir, 'pinhao-composite-adapter.json'), 'utf8');
  await assert.rejects(registerSupplement({ ...options, unitIds: ['first'], units: [{ ...first, source: 'Changed caption.' }] }), /其他原文或位置/);
  await assert.rejects(registerSupplement({ ...options, unitIds: ['first'], units: [{ ...first, locator: second.locator }] }), /其他原文或位置/);
  const changed = path.join(root, 'changed-baseline'); await mkdir(path.join(changed, 'data'), { recursive: true });
  await writeFile(path.join(changed, file), JSON.stringify({ lines: ['First caption.', 'Second caption.'], switchId: 5 }));
  await assert.rejects(registerSupplement({ ...options, baselineDir: changed, unitIds: ['first'], units: [first] }), /基线/);
  assert.equal(await readFile(path.join(workspaceDir, 'pinhao-composite-adapter.json'), 'utf8'), accepted);
  assert.deepEqual(await readdir(workspaceDir), ['pinhao-composite-adapter.json']);
});

test('a full real recipe adds only new same-file targets and preserves reviewed partial and native translations', async t => {
  const { root, gameDir } = await fixture(t), file = 'data/dialogue.json';
  const original = JSON.stringify({ native: 'Native caption.', lines: ['First caption.', 'Second caption.'], switchId: 4 });
  await writeFile(path.join(gameDir, file), original);
  const workspaceDir = path.join(root, 'native'); await mkdir(workspaceDir);
  const lab = await createAdapterLab({ dataDir: path.join(root, 'recipes') });
  const extract = async (full, directory) => {
    const manifest = { schemaVersion: 1, id: full ? 'full' : 'partial', version: '1.0.0', engine: 'Neutral fixture', scope: { files: [file] }, license: 'GPL-3.0-or-later', sources: [] };
    const code = `({detect(){return {matched:true}},extract(host){const data=JSON.parse(host.readText('${file}'));return {units:data.lines.slice(0,${full ? 2 : 1}).map((source,i)=>({id:'caption:'+i,source,locator:{file:'${file}',pointer:'/lines/'+i}}))}},validate(){return {valid:true}},roundtrip(host){host.writeBytes('${file}',host.readBytes('${file}'));return {}},build(host,input){const data=JSON.parse(host.readText('${file}'));for(const unit of input.units)if(Object.hasOwn(input.translations,unit.id))data.lines[Number(unit.locator.pointer.split('/').pop())]=input.translations[unit.id];host.writeText('${file}',JSON.stringify(data));return {}},assemble(){return {}}})`;
    const candidate = await lab.writeAdapter({ manifest, code });
    const validation = await lab.validateAdapter({ ...candidate, gameDir }); assert.equal(validation.passed, true, validation.error?.message);
    const recipe = await lab.submitRecipe({ ...candidate, validationId: validation.validationId });
    return lab.extractRecipe({ ...recipe, gameDir, workspaceDir: path.join(root, directory) });
  };
  const partial = await extract(false, 'partial-writer');
  const register = (extraction, selected) => registerSupplement({ workspaceDir, adapterWorkspaceDir: extraction.workspaceDir,
    unitIds: selected.rawUnits.map(unit => unit.id), units: selected.rawUnits, files: [file], baselineDir: gameDir, sourceRoot: gameDir });
  const first = selectSupplementalUnits({ projectId: 'neutral', incoming: partial.units, existing: [] });
  await register(partial, first);
  const reviewed = first.units.map(unit => ({ ...unit, translation: '保留审校成果。', notes: 'Reviewed context.', revision: 7, status: 'proofread' }));
  const full = await extract(true, 'full-writer');
  const next = selectSupplementalUnits({ projectId: 'neutral', incoming: full.units, existing: reviewed });
  assert.deepEqual(next.rawUnits.map(unit => unit.id), ['caption:1']);
  await register(full, next);
  assert.equal(reviewed[0].translation, '保留审校成果。'); assert.equal(reviewed[0].revision, 7);
  const worker = createAdaptiveWorker({ getLab: async () => lab, nativeWorker: async (command, args) => {
    if (command === 'build') {
      assert.deepEqual(args.translations, [{ id: 'native', translation: '原生人工译文。' }]);
      await mkdir(path.join(args.outputDir, 'data'), { recursive: true });
      await writeFile(path.join(args.outputDir, file), JSON.stringify({ ...JSON.parse(original), native: '原生人工译文。' }));
      return { buildDir: args.outputDir };
    }
    if (command === 'assemble') { await cp(gameDir, args.outputDir, { recursive: true }); await cp(args.buildDir, args.outputDir, { recursive: true }); return { outputDir: args.outputDir }; }
    throw new Error(`Unexpected command ${command}`);
  } });
  const built = await worker('build', { workspaceDir, outputDir: path.join(root, 'build/native'), translations: [{ id: 'native', translation: '原生人工译文。' }, { id: 'caption:0', translation: reviewed[0].translation }, { id: 'caption:1', translation: '新增译文。' }] });
  const product = await worker('assemble', { gameDir, workspaceDir, buildDir: built.buildDir, adapterBuilds: built.adapterBuilds, outputDir: path.join(root, 'product') });
  assert.deepEqual(JSON.parse(await readFile(path.join(product.outputDir, file), 'utf8')), { native: '原生人工译文。', lines: ['保留审校成果。', '新增译文。'], switchId: 4 });
  assert.equal(await readFile(path.join(gameDir, file), 'utf8'), original);
});

test('source copy and supplemental overlays reject linked destinations without modifying external files', async t => {
  const { root, gameDir } = await fixture(t);
  const work = path.join(root, 'work'), external = path.join(root, 'external');
  await mkdir(work); await mkdir(external);
  await writeFile(path.join(external, 'dialogue.json'), 'keep');
  try { await symlink(external, path.join(work, 'data'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('当前执行环境未授予创建测试目录链接的权限'); return; }
    throw error;
  }
  await assert.rejects(createAdaptationSource({ gameDir, outputDir: work }), /链接/);
  assert.equal(await readFile(path.join(external, 'dialogue.json'), 'utf8'), 'keep');
  const rootAlias = path.join(root, 'linked-workspace');
  await symlink(external, rootAlias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createAdaptationSource({ gameDir, outputDir: rootAlias }), /链接/);
  await assert.rejects(createAdaptationSource({ gameDir, outputDir: path.join(rootAlias, 'new-copy') }), /链接/);
  assert.deepEqual(await readdir(external), ['dialogue.json'], 'linked parents are rejected before creating output directories');
  const hardlinkedCopy = path.join(root, 'hardlinked-copy');
  await mkdir(path.join(hardlinkedCopy, 'data'), { recursive: true });
  await link(path.join(gameDir, 'data/dialogue.json'), path.join(hardlinkedCopy, 'data/dialogue.json'));
  await assert.rejects(createAdaptationSource({ gameDir, outputDir: hardlinkedCopy }), /独立文件/);
  assert.equal(await readFile(path.join(gameDir, 'data/dialogue.json'), 'utf8'), 'fresh-copy');

  const workspaceDir = path.join(root, 'native-workbench'), buildDir = path.join(root, 'translated'), product = path.join(root, 'product');
  await mkdir(workspaceDir); await mkdir(path.join(buildDir, 'data'), { recursive: true });
  await mkdir(path.join(product, 'data'), { recursive: true });
  await writeFile(path.join(buildDir, 'data/dialogue.json'), 'translated');
  await link(path.join(external, 'dialogue.json'), path.join(product, 'data/dialogue.json'));
  await registerSupplement({ workspaceDir, adapterWorkspaceDir: path.join(root, 'adapter-workbench'), unitIds: ['dialogue:0'], files: ['data/dialogue.json'], sourceRoot: gameDir });
  const worker = createAdaptiveWorker({ nativeWorker: async () => ({ ok: true, result: { outputDir: product } }), getLab: async () => ({ dispatch: async () => null }) });
  const adapterBuilds = [{ sourceRoot: gameDir, resourceRoot: '.', files: ['data/dialogue.json'], buildDir }];
  await assert.rejects(worker('assemble', { gameDir, workspaceDir, buildDir, outputDir: product, adapterBuilds }), /独立文件/);
  assert.equal(await readFile(path.join(external, 'dialogue.json'), 'utf8'), 'keep');
  assert.equal(await readFile(path.join(gameDir, 'data/dialogue.json'), 'utf8'), 'fresh-copy');
});

test('ordinary Windows destination directories accept equivalent path casing', { skip: process.platform !== 'win32' }, async t => {
  const { root, gameDir } = await fixture(t);
  await mkdir(path.join(root, 'MixedCaseWorkspace'));
  const outputDir = path.join(root, 'mixedcaseworkspace', 'copy');
  const target = await createAdaptationSource({ gameDir, outputDir });
  assert.equal(await readFile(path.join(target, 'data/dialogue.json'), 'utf8'), 'fresh-copy');
  assert.equal(await readFile(path.join(outputDir, 'data/dialogue.json'), 'utf8'), 'fresh-copy');
  await createAdaptationSource({ gameDir, outputDir: path.join(root, 'MIXEDCASEWORKSPACE', 'COPY') });
  assert.equal(await readFile(path.join(gameDir, 'data/dialogue.json'), 'utf8'), 'fresh-copy');
});

test('ordinary Windows destination directories accept available 8.3 aliases', { skip: process.platform !== 'win32' }, async t => {
  const { root, gameDir } = await fixture(t);
  const parent = path.join(root, 'Workspace With Long Name');
  await mkdir(parent);
  const script = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $fs = New-Object -ComObject Scripting.FileSystemObject; $fs.GetFolder($env:PINHAO_SHORT_PATH).ShortPath';
  const { stdout } = await executeFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, PINHAO_SHORT_PATH: parent }, windowsHide: true, timeout: 15000,
  });
  const shortParent = stdout.trim();
  assert.ok(path.isAbsolute(shortParent));
  if (path.resolve(shortParent).toLowerCase() === path.resolve(parent).toLowerCase()) {
    t.skip('当前卷未生成此临时目录的8.3别名'); return;
  }
  const outputDir = path.join(shortParent, 'copy');
  const target = await createAdaptationSource({ gameDir, outputDir });
  assert.equal(await readFile(path.join(target, 'data/dialogue.json'), 'utf8'), 'fresh-copy');
  assert.equal(await readFile(path.join(parent, 'copy', 'data/dialogue.json'), 'utf8'), 'fresh-copy');
  await createAdaptationSource({ gameDir, outputDir: path.join(parent, 'copy') });
  assert.equal(await readFile(path.join(gameDir, 'data/dialogue.json'), 'utf8'), 'fresh-copy');
});

test('snapshot identity detects equal-size old-mtime changes and removed resources while preserving progress', async t => {
  const { root, gameDir } = await fixture(t);
  const outputDir = path.join(root, 'copy');
  await writeFile(path.join(gameDir, 'data/dialogue.json'), 'alpha');
  await createAdaptationSource({ gameDir, outputDir });
  const checkpoint = await readFile(`${outputDir}.snapshot.json`, 'utf8');
  const progressFile = path.join(root, 'accepted-translations.json');
  await writeFile(progressFile, '{"translation":"已校对译文","revision":4}');
  await writeFile(path.join(gameDir, 'data/dialogue.json'), 'bravo');
  await utimes(path.join(gameDir, 'data/dialogue.json'), 1, 1);
  await assert.rejects(createAdaptationSource({ gameDir, outputDir }), /原版资源已更新/);
  assert.equal(await readFile(path.join(outputDir, 'data/dialogue.json'), 'utf8'), 'alpha');
  assert.equal(await readFile(`${outputDir}.snapshot.json`, 'utf8'), checkpoint);
  assert.equal(await readFile(progressFile, 'utf8'), '{"translation":"已校对译文","revision":4}');
  await unlink(path.join(gameDir, 'data/dialogue.json'));
  await assert.rejects(createAdaptationSource({ gameDir, outputDir }), /原版资源已更新/);
  assert.equal(await readFile(path.join(outputDir, 'data/dialogue.json'), 'utf8'), 'alpha');
});

test('completed snapshots reuse verified media and copy only missing or changed destination files', async t => {
  const { root, gameDir } = await fixture(t);
  await mkdir(path.join(gameDir, 'media'));
  await writeFile(path.join(gameDir, 'media/movie.bin'), Buffer.alloc(8 * 1024 * 1024, 42));
  await writeFile(path.join(gameDir, 'data/second.json'), 'second');
  const outputDir = path.join(root, 'reusable-copy');
  let progress;
  const options = { gameDir, outputDir, onProgress: value => { progress = value; } };
  await createAdaptationSource(options);
  assert.equal(progress.copied, 3); assert.equal(progress.reused, 0);
  const movie = path.join(outputDir, 'media/movie.bin'), originalMetadata = await lstat(movie, { bigint: true });
  await createAdaptationSource(options);
  assert.equal(progress.copied, 0); assert.equal(progress.reused, 3); assert.equal(progress.bytesCopied, 0);
  const retriedMetadata = await lstat(movie, { bigint: true });
  assert.equal(retriedMetadata.mtimeNs, originalMetadata.mtimeNs); assert.equal(retriedMetadata.ctimeNs, originalMetadata.ctimeNs);
  await unlink(path.join(outputDir, 'data/second.json'));
  const edited = path.join(outputDir, 'data/dialogue.json'), old = await lstat(edited);
  await writeFile(edited, 'wrong-copy'); await utimes(edited, old.atime, old.mtime);
  await createAdaptationSource(options);
  assert.equal(progress.copied, 2); assert.equal(progress.reused, 1); assert.equal(progress.bytesCopied, 16);
  assert.equal(await readFile(edited, 'utf8'), 'fresh-copy');
  assert.equal(await readFile(path.join(outputDir, 'data/second.json'), 'utf8'), 'second');
  assert.equal((await lstat(movie, { bigint: true })).ctimeNs, originalMetadata.ctimeNs);
});

test('concrete technical inputs share one expandable independent snapshot without copying unrelated media', async t => {
  const { root, gameDir } = await fixture(t);
  await mkdir(path.join(gameDir, 'media'));
  await writeFile(path.join(gameDir, 'media/movie.bin'), Buffer.alloc(8 * 1024 * 1024, 42));
  await writeFile(path.join(gameDir, 'data/second.json'), 'second');
  await writeFile(path.join(gameDir, 'data/third.json'), 'third');
  await mkdir(path.join(gameDir, 'save')); await writeFile(path.join(gameDir, 'save/private.rpgsave'), 'private');
  const outputDir = path.join(root, 'scoped-source');
  let progress;
  const base = { gameDir, outputDir, onProgress: value => { progress = value; } };
  const sourceDir = await createAdaptationSource({ ...base, files: ['data/dialogue.json'], reuseSource: true });
  assert.notEqual(sourceDir, await realpath(gameDir));
  assert.equal(progress.copied, 1); assert.equal(progress.bytesCopied, 10);
  assert.deepEqual(await readdir(outputDir), ['data']);
  const first = await lstat(path.join(sourceDir, 'data/dialogue.json'), { bigint: true });
  await Promise.all(['data/second.json', 'data/third.json'].map(file => createAdaptationSource({ ...base, files: [file] })));
  assert.deepEqual((await readdir(path.join(sourceDir, 'data'))).sort(), ['dialogue.json', 'second.json', 'third.json']);
  const snapshot = JSON.parse(await readFile(`${outputDir}.snapshot.json`, 'utf8'));
  assert.equal(snapshot.scope, 'selected'); assert.equal(snapshot.files.length, 3);
  await createAdaptationSource({ ...base, files: ['data/dialogue.json'] });
  assert.equal(progress.copied, 0); assert.equal(progress.reused, 3);
  assert.equal((await lstat(path.join(sourceDir, 'data/dialogue.json'), { bigint: true })).ctimeNs, first.ctimeNs);
  await assert.rejects(createAdaptationSource({ ...base, files: ['save/private.rpgsave'] }), /存档或私人配置/);
  await assert.rejects(createAdaptationSource({ ...base, files: ['../outside'] }), /相对定位/);
  await writeFile(path.join(gameDir, 'data/second.json'), 'edited');
  await assert.rejects(createAdaptationSource({ ...base, files: ['data/dialogue.json'] }), /原版资源已更新/);
  assert.equal(await readFile(path.join(sourceDir, 'data/second.json'), 'utf8'), 'second');
  assert.equal(await readFile(path.join(gameDir, 'save/private.rpgsave'), 'utf8'), 'private');
});

test('Agent discovers the full source read-only then copies a concrete dependency for its technical tools', async t => {
  const { root, gameDir } = await fixture(t);
  await writeFile(path.join(gameDir, 'data/extra.json'), '{"caption":"Extra context."}');
  const outputDir = path.join(root, 'inputs'), workspaceDir = path.join(root, 'technical'), managed = path.join(root, 'managed');
  await mkdir(managed);
  await writeFile(path.join(managed, 'shared.txt'), 'managed value');
  await writeFile(path.join(gameDir, 'shared.txt'), 'original value');
  const copy = files => createAdaptationSource({ gameDir: managed, sourceRoots: [gameDir], outputDir, files });
  const sourceDir = await copy(['data/dialogue.json']);
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab') });
  await runAdaptation({ project: { id: 'scoped-inputs', engine: 'Fixture' }, inventory: {}, lab, gameDir: sourceDir, readDir: managed, readRoots: [gameDir],
    workspaceDir, statePath: path.join(workspaceDir, 'state.json'),
    copySourceFiles: copy,
    generate: async ({ tools, instructions }) => {
      assert.match(instructions, /copy_source_files/);
      assert.equal((await tools.inspect_context.execute({})).executionContext.sourceFiles, 'on-demand-copy');
      const listing = await tools.list_files.execute({ relativePath: 'data' });
      assert.ok(listing.files.some(file => file.path === 'data/extra.json' && file.sourceIndex === 1));
      assert.equal((await tools.read_resource.execute({ file: 'data/extra.json' })).content, '{"caption":"Extra context."}');
      assert.equal((await tools.read_resource.execute({ file: 'shared.txt', sourceIndex: 1 })).content, 'original value');
      const searched = await tools.search_files.execute({ query: 'Extra context', content: true });
      assert.ok(searched.items.some(item => item.file === 'data/extra.json' && item.sourceIndex === 1));
      await assert.rejects(readFile(path.join(sourceDir, 'data/extra.json')), { code: 'ENOENT' });
      const copied = await tools.copy_source_files.execute({ files: ['data/extra.json'] });
      assert.equal(copied.sourceDir, sourceDir);
      assert.equal(await readFile(path.join(sourceDir, 'data/extra.json'), 'utf8'), '{"caption":"Extra context."}');
      await writeFile(path.join(sourceDir, 'data/extra.json'), 'tool working change');
      assert.equal(await readFile(path.join(gameDir, 'data/extra.json'), 'utf8'), '{"caption":"Extra context."}');
    } });
});

test('a tool that needs the complete environment can expand a selected snapshot without treating scope growth as an original edit', async t => {
  const { root, gameDir } = await fixture(t), outputDir = path.join(root, 'expanding-input');
  await writeFile(path.join(gameDir, 'data/dependency.json'), 'dependency');
  await createAdaptationSource({ gameDir, outputDir, files: ['data/dialogue.json'] });
  await assert.rejects(readFile(path.join(outputDir, 'data/dependency.json')), { code: 'ENOENT' });
  await createAdaptationSource({ gameDir, outputDir });
  assert.equal(await readFile(path.join(outputDir, 'data/dependency.json'), 'utf8'), 'dependency');
  assert.equal(JSON.parse(await readFile(`${outputDir}.snapshot.json`, 'utf8')).scope, undefined);
  await createAdaptationSource({ gameDir, outputDir });
  assert.equal(await readFile(path.join(gameDir, 'data/dialogue.json'), 'utf8'), 'fresh-copy');
});

test('concrete carrier inputs resolve across original and managed roots and bind the actual origin on resume', async t => {
  const { root, gameDir } = await fixture(t), managed = path.join(root, 'managed'), outputDir = path.join(root, 'mixed-source');
  await mkdir(path.join(managed, 'decoded'), { recursive: true });
  await writeFile(path.join(managed, 'decoded/story.json'), 'decoded story');
  await mkdir(path.join(gameDir, 'media'));
  await writeFile(path.join(gameDir, 'media/unused.bin'), Buffer.alloc(1024 * 1024, 42));
  let progress;
  const options = { gameDir: managed, sourceRoots: [managed, gameDir], outputDir,
    files: ['data/dialogue.json', 'decoded/story.json'], onProgress: value => { progress = value; } };
  const sourceDir = await createAdaptationSource(options);
  assert.equal(progress.copied, 2); assert.equal(progress.bytesCopied, 23);
  assert.equal(await readFile(path.join(sourceDir, 'data/dialogue.json'), 'utf8'), 'fresh-copy');
  assert.equal(await readFile(path.join(sourceDir, 'decoded/story.json'), 'utf8'), 'decoded story');
  await assert.rejects(readFile(path.join(sourceDir, 'media/unused.bin')), { code: 'ENOENT' });
  const snapshot = JSON.parse(await readFile(`${outputDir}.snapshot.json`, 'utf8'));
  assert.deepEqual(snapshot.sourceRoots, [await realpath(managed), await realpath(gameDir)]);
  assert.equal(snapshot.files.find(file => file.relative === 'data/dialogue.json').sourceIndex, 1);
  assert.equal(snapshot.files.find(file => file.relative === 'decoded/story.json').sourceIndex, 0);
  await createAdaptationSource(options);
  assert.equal(progress.copied, 0); assert.equal(progress.reused, 2);
  await assert.rejects(createAdaptationSource({ ...options, files: ['data/missing.json'] }), { code: 'ENOENT' });
  await writeFile(path.join(gameDir, 'data/dialogue.json'), 'changed!!!');
  await assert.rejects(createAdaptationSource(options), /原版资源已更新/);
  assert.equal(await readFile(path.join(sourceDir, 'data/dialogue.json'), 'utf8'), 'fresh-copy');
  assert.equal(await readFile(path.join(managed, 'decoded/story.json'), 'utf8'), 'decoded story');
});

test('complete mixed environments refuse conflicting same-path resources instead of overwriting one source with another', async t => {
  const { root, gameDir } = await fixture(t), managed = path.join(root, 'managed'), outputDir = path.join(root, 'mixed-conflict');
  await mkdir(path.join(managed, 'data'), { recursive: true });
  await writeFile(path.join(managed, 'data/dialogue.json'), 'decoded and different');
  const options = { gameDir: managed, sourceRoots: [gameDir], outputDir };
  await assert.rejects(createAdaptationSource(options), /同名资源内容不同/);
  assert.deepEqual(await readdir(outputDir), []);
  await assert.rejects(readFile(`${outputDir}.snapshot.json`), { code: 'ENOENT' });
  await createAdaptationSource({ ...options, files: ['data/dialogue.json'] });
  assert.equal(await readFile(path.join(outputDir, 'data/dialogue.json'), 'utf8'), 'decoded and different');
  assert.equal(await readFile(path.join(gameDir, 'data/dialogue.json'), 'utf8'), 'fresh-copy');
});

test('legacy snapshots gain reusable evidence without rewriting correct files and recover partial journals', async t => {
  const { root, gameDir } = await fixture(t);
  const outputDir = path.join(root, 'legacy-copy'), progressFile = `${outputDir}.snapshot-progress.jsonl`;
  await createAdaptationSource({ gameDir, outputDir });
  const checkpoint = await readFile(`${outputDir}.snapshot.json`, 'utf8');
  const metadata = await lstat(path.join(outputDir, 'data/dialogue.json'), { bigint: true });
  await unlink(progressFile);
  let progress;
  const options = { gameDir, outputDir, onProgress: value => { progress = value; } };
  await createAdaptationSource(options);
  assert.equal(progress.copied, 0); assert.equal(progress.reused, 1);
  assert.equal(await readFile(`${outputDir}.snapshot.json`, 'utf8'), checkpoint);
  assert.equal((await lstat(path.join(outputDir, 'data/dialogue.json'), { bigint: true })).ctimeNs, metadata.ctimeNs);
  await appendFile(progressFile, '{"unfinished":');
  await utimes(path.join(gameDir, 'data/dialogue.json'), 2, 2);
  await createAdaptationSource(options);
  await createAdaptationSource(options);
  assert.equal(progress.copied, 0); assert.equal(progress.reused, 1);
  assert.equal(await readFile(path.join(gameDir, 'data/dialogue.json'), 'utf8'), 'fresh-copy');
});

test('managed source reuse keeps private files excluded when a filtered copy is needed', async t => {
  const { root, gameDir } = await fixture(t);
  await mkdir(path.join(gameDir, 'save'));
  await writeFile(path.join(gameDir, 'save/current.rpgsave'), 'private-save');
  await writeFile(path.join(gameDir, '.env'), 'private-setting');
  const outputDir = path.join(root, 'filtered-managed-copy');
  const actual = await createAdaptationSource({ gameDir, outputDir, reuseSource: true });
  assert.equal(actual, await realpath(outputDir));
  assert.deepEqual(await readdir(actual), ['data']);
  assert.equal(await readFile(path.join(gameDir, '.env'), 'utf8'), 'private-setting');
  assert.equal(await readFile(path.join(gameDir, 'save/current.rpgsave'), 'utf8'), 'private-save');
});

test('interrupted source snapshot resumes fully and keeps original saves and accepted work intact', async t => {
  const { root, gameDir } = await fixture(t);
  for (let index = 0; index < 105; index++) await writeFile(path.join(gameDir, `data/scene-${String(index).padStart(3, '0')}.json`), `scene-${index}`);
  await mkdir(path.join(gameDir, 'save'));
  await writeFile(path.join(gameDir, 'save/private.rpgsave'), 'private-save');
  await writeFile(path.join(gameDir, 'Save01.rvdata2'), 'private-rgss-save');
  await writeFile(path.join(gameDir, '.env'), 'private-runtime-setting');
  const outputDir = path.join(root, 'source-copy'), accepted = path.join(root, 'accepted-progress.json');
  await writeFile(accepted, '{"candidateId":"kept","translation":"已接受译文"}');
  const controller = new AbortController();
  await assert.rejects(createAdaptationSource({ gameDir, outputDir, signal: controller.signal, onProgress: () => controller.abort() }), error => error.name === 'AbortError');
  assert.equal((await readdir(path.join(outputDir, 'data'))).length, 100);
  const checkpoint = await readFile(`${outputDir}.snapshot.json`, 'utf8');
  let resumed;
  const copiedFile = path.join(outputDir, 'data/scene-000.json'), metadata = await lstat(copiedFile, { bigint: true });
  await createAdaptationSource({ gameDir, outputDir, onProgress: value => { resumed = value; } });
  assert.equal(resumed.copied, 6); assert.equal(resumed.reused, 100);
  assert.equal((await lstat(copiedFile, { bigint: true })).ctimeNs, metadata.ctimeNs);
  assert.equal((await readdir(path.join(outputDir, 'data'))).length, 106);
  assert.equal(await readFile(`${outputDir}.snapshot.json`, 'utf8'), checkpoint);
  assert.equal(await readFile(path.join(outputDir, 'data/scene-104.json'), 'utf8'), 'scene-104');
  assert.equal(await readFile(path.join(gameDir, 'save/private.rpgsave'), 'utf8'), 'private-save');
  assert.equal(await readFile(path.join(gameDir, 'Save01.rvdata2'), 'utf8'), 'private-rgss-save');
  assert.equal(await readFile(accepted, 'utf8'), '{"candidateId":"kept","translation":"已接受译文"}');
  const entries = await readdir(outputDir);
  assert.ok(!entries.includes('save') && !entries.includes('Save01.rvdata2') && !entries.includes('.env'));
});

const sha256 = value => createHash('sha256').update(value).digest('hex');

async function supplementalFixture(t, { packed = false, span = false } = {}) {
  const f = await fixture(t);
  const file = span ? 'data/shared.txt' : 'data/shared.json';
  const original = span ? 'prefix|Native line|Hidden line|resource=keep.png' : JSON.stringify({ lines: ['Native line'], hidden: 'Hidden line', resource: 'keep.png', switchId: 4 });
  await writeFile(path.join(f.gameDir, file), original);
  const gameDir = packed ? path.join(f.root, 'packed-game') : f.gameDir;
  if (packed) { await mkdir(gameDir); await writeFile(path.join(gameDir, 'game.pck'), 'neutral archive marker'); }
  const workspaceDir = path.join(f.root, 'native-workbench'); await mkdir(workspaceDir);
  const adapterWorkspaceDir = path.join(f.root, 'adapter-workbench');
  const lab = await createAdapterLab({ dataDir: path.join(f.root, 'recipes') });
  const manifest = { schemaVersion: 1, id: span ? 'shared-span' : 'shared-json', version: '1.0.0', engine: 'Neutral fixture', scope: { files: [file] }, license: 'GPL-3.0-or-later', sources: [] };
  const code = span ? `({
    detect(host){return {matched:host.list('data').some(item=>item.path===${JSON.stringify(file)})}},
    extract(host){const parts=host.readText(${JSON.stringify(file)}).split('|');const start=encodeURIComponent(parts.slice(0,2).join('|')+'|').replace(/%[0-9A-F]{2}|./g,'x').length;const size=encodeURIComponent(parts[2]).replace(/%[0-9A-F]{2}|./g,'x').length;return {units:[{id:'supplement:hidden',source:parts[2],kind:'message',context:{file:${JSON.stringify(file)}},locator:{file:${JSON.stringify(file)},byteStart:start,byteEnd:start+size}}]}},
    validate(){return {valid:true}},roundtrip(host){host.writeBytes(${JSON.stringify(file)},host.readBytes(${JSON.stringify(file)}));return {}},
    build(host,input){const parts=host.readText(${JSON.stringify(file)}).split('|');if(Object.hasOwn(input.translations,'supplement:hidden'))parts[2]=input.translations['supplement:hidden'];host.writeText(${JSON.stringify(file)},parts.join('|'));return {}},assemble(){return {}}
  })` : `({
    detect(host){return {matched:host.list('data').some(item=>item.path===${JSON.stringify(file)})}},
    extract(host){return {units:[{id:'supplement:hidden',source:JSON.parse(host.readText(${JSON.stringify(file)})).hidden,kind:'message',context:{file:${JSON.stringify(file)}},locator:{file:${JSON.stringify(file)},pointer:'/hidden'}}]}},
    validate(){return {valid:true}},roundtrip(host){host.writeBytes(${JSON.stringify(file)},host.readBytes(${JSON.stringify(file)}));return {}},
    build(host,input){const data=JSON.parse(host.readText(${JSON.stringify(file)}));if(Object.hasOwn(input.translations,'supplement:hidden'))data.hidden=input.translations['supplement:hidden'];host.writeText(${JSON.stringify(file)},JSON.stringify(data));return {}},assemble(){return {}}
  })`;
  const candidate = await lab.writeAdapter({ manifest, code });
  const validation = await lab.validateAdapter({ ...candidate, gameDir: f.gameDir });
  assert.equal(validation.passed, true, validation.error?.message);
  const recipe = await lab.submitRecipe({ ...candidate, validationId: validation.validationId });
  const extraction = await lab.extractRecipe({ ...recipe, gameDir: f.gameDir, workspaceDir: adapterWorkspaceDir });
  await registerSupplement({ workspaceDir, adapterWorkspaceDir, unitIds: extraction.units.map(unit => unit.id), units: extraction.binding.units, files: [file], baselineDir: f.gameDir, sourceRoot: f.gameDir, resourceRoot: '.' });
  return { ...f, file, original, sourceDir: f.gameDir, gameDir, workspaceDir, lab };
}

test('managed native snapshots supply the real guest through read-only source capabilities without duplicating media', async t => {
  const f = await supplementalFixture(t);
  await mkdir(path.join(f.sourceDir, 'media'));
  await writeFile(path.join(f.sourceDir, 'media/unchanged.bin'), Buffer.alloc(1024 * 1024, 41));
  const outputDir = path.join(f.root, 'technical-source');
  let progress;
  const readRoot = await createAdaptationSource({ gameDir: f.sourceDir, outputDir, reuseSource: true, onProgress: value => { progress = value; } });
  assert.equal(readRoot, await realpath(f.sourceDir));
  assert.equal(progress.copied, 0); assert.equal(progress.reused, 3);
  assert.deepEqual(await readdir(outputDir), []);
  await assert.rejects(f.lab.dispatch('build', { workspaceDir: path.join(f.root, 'adapter-workbench'), outputDir: readRoot, translations: [{ id: 'supplement:hidden', translation: '补充译文' }] }), /与游戏原版分开/);
  const result = await f.lab.dispatch('build', { workspaceDir: path.join(f.root, 'adapter-workbench'), outputDir: path.join(f.root, 'read-only-guest-build'), translations: [{ id: 'supplement:hidden', translation: '补充译文' }] });
  assert.equal(JSON.parse(await readFile(path.join(result.buildDir, f.file), 'utf8')).hidden, '补充译文');
  assert.equal(await readFile(path.join(readRoot, f.file), 'utf8'), f.original);
  assert.equal((await lstat(path.join(readRoot, f.file))).nlink, 1);
});

test('real JSON supplemental lab build preserves a native translation in the same resource file', async t => {
  const f = await supplementalFixture(t);
  const nativeWorker = async (command, args) => {
    if (command === 'build') {
      assert.deepEqual(args.translations, [{ id: 'native:line', translation: '原生译文' }]);
      const data = JSON.parse(await readFile(path.join(f.sourceDir, f.file), 'utf8')); data.lines[0] = args.translations[0].translation;
      await mkdir(path.join(args.outputDir, 'data'), { recursive: true }); await writeFile(path.join(args.outputDir, f.file), JSON.stringify(data));
      return { ok: true, result: { buildDir: args.outputDir } };
    }
    if (command === 'assemble') {
      await cp(f.sourceDir, args.outputDir, { recursive: true }); await cp(args.buildDir, args.outputDir, { recursive: true });
      return { ok: true, result: { outputDir: args.outputDir } };
    }
    throw new Error(`Unexpected command ${command}`);
  };
  const worker = createAdaptiveWorker({ nativeWorker, getLab: async () => f.lab });
  const built = await worker('build', { workspaceDir: f.workspaceDir, outputDir: path.join(f.root, 'build', 'native'), translations: [{ id: 'native:line', translation: '原生译文' }, { id: 'supplement:hidden', translation: '补充译文' }] });
  assert.equal(built.ok, true);
  const assembled = await worker('assemble', { gameDir: f.gameDir, workspaceDir: f.workspaceDir, buildDir: built.result.buildDir, adapterBuilds: built.result.adapterBuilds, outputDir: path.join(f.root, 'product') });
  assert.equal(assembled.ok, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(assembled.result.outputDir, f.file), 'utf8')), { lines: ['原生译文'], hidden: '补充译文', resource: 'keep.png', switchId: 4 });
  assert.equal(await readFile(path.join(f.sourceDir, f.file), 'utf8'), f.original);
});

test('packed supplemental overlays carry checked dictionary hashes and retain the original PNG channel', async t => {
  const f = await supplementalFixture(t, { packed: true });
  const pngDir = path.join(f.root, 'png-overlay'); await mkdir(pngDir);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  await writeFile(path.join(pngDir, 'face.png'), png);
  const pngRows = [{ file: 'face.png', sha256: sha256(png), sourceHash: sha256(Buffer.from('original png marker')) }];
  let assemblyCalls = 0;
  const nativeWorker = async (command, args) => {
    if (command === 'build') {
      assert.equal(args.translations.length, 1); assert.equal(args.translations[0].id, 'native:line');
      const data = JSON.parse(f.original); data.lines[0] = args.translations[0].translation;
      await mkdir(path.join(args.outputDir, 'data'), { recursive: true }); await writeFile(path.join(args.outputDir, f.file), JSON.stringify(data));
      return { ok: true, result: { buildDir: args.outputDir } };
    }
    if (command === 'assemble') {
      assemblyCalls++;
      assert.equal(args.assetOverlayDir, pngDir); assert.deepEqual(args.assetOverlayFiles, pngRows);
      assert.equal(args.adapterOverlayFiles.length, 1);
      const row = args.adapterOverlayFiles[0];
      assert.deepEqual(Object.keys(row).sort(), ['file', 'sha256', 'sourceHash']);
      assert.equal(row.file, f.file); assert.equal(row.sourceHash, sha256(await readFile(path.join(args.buildDir, f.file))));
      assert.notEqual(row.sourceHash, sha256(Buffer.from(f.original)), 'overlay baseline is the native built resource rather than untranslated data');
      const bytes = await readFile(path.join(args.adapterOverlayDir, row.file)); assert.equal(row.sha256, sha256(bytes));
      assert.deepEqual(JSON.parse(bytes), { lines: ['原生译文'], hidden: '补充译文', resource: 'keep.png', switchId: 4 });
      await mkdir(path.join(args.outputDir, 'data'), { recursive: true }); await writeFile(path.join(args.outputDir, f.file), bytes);
      return { ok: true, result: { outputDir: args.outputDir } };
    }
    throw new Error(`Unexpected command ${command}`);
  };
  const worker = createAdaptiveWorker({ nativeWorker, getLab: async () => f.lab });
  const built = await worker('build', { workspaceDir: f.workspaceDir, outputDir: path.join(f.root, 'build', 'native'), translations: [{ id: 'native:line', translation: '原生译文' }, { id: 'supplement:hidden', translation: '补充译文' }] });
  await worker('assemble', { gameDir: f.gameDir, workspaceDir: f.workspaceDir, buildDir: built.result.buildDir, adapterBuilds: built.result.adapterBuilds, outputDir: path.join(f.root, 'product'), assetOverlayDir: pngDir, assetOverlayFiles: pngRows });
  assert.equal(assemblyCalls, 1); assert.deepEqual(await readFile(path.join(pngDir, 'face.png')), png);
  assert.equal(await readFile(path.join(f.sourceDir, f.file), 'utf8'), f.original);
});

test('real UTF-8 supplemental spans preserve native length changes in the same resource', async t => {
  const f = await supplementalFixture(t, { span: true });
  const nativeWorker = async (command, args) => {
    if (command === 'build') {
      const text = f.original.replace('Native line', args.translations[0].translation);
      await mkdir(path.join(args.outputDir, 'data'), { recursive: true }); await writeFile(path.join(args.outputDir, f.file), text);
      return { buildDir: args.outputDir };
    }
    if (command === 'assemble') { await cp(f.sourceDir, args.outputDir, { recursive: true }); await cp(args.buildDir, args.outputDir, { recursive: true }); return { outputDir: args.outputDir }; }
    throw new Error(`Unexpected command ${command}`);
  };
  const worker = createAdaptiveWorker({ nativeWorker, getLab: async () => f.lab });
  const built = await worker('build', { workspaceDir: f.workspaceDir, outputDir: path.join(f.root, 'build', 'native'), translations: [{ id: 'native:line', translation: '长度改变的原生译文' }, { id: 'supplement:hidden', translation: '补充隐藏文本' }] });
  const assembled = await worker('assemble', { gameDir: f.gameDir, workspaceDir: f.workspaceDir, buildDir: built.buildDir, adapterBuilds: built.adapterBuilds, outputDir: path.join(f.root, 'product') });
  assert.equal(await readFile(path.join(assembled.outputDir, f.file), 'utf8'), 'prefix|长度改变的原生译文|补充隐藏文本|resource=keep.png');
  assert.equal(await readFile(path.join(f.sourceDir, f.file), 'utf8'), f.original);
});
