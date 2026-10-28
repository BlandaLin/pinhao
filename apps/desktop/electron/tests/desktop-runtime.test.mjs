import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { desktopLocales, pruneDesktopLocales, quickJsRuntimePackages } from '../../../../scripts/desktop-runtime.mjs';
import { runSandbox } from '../../../../packages/technical/adaptation/sandbox.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-desktop-runtime-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function inventory(directory) {
  let bytes = 0, files = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await inventory(file); bytes += nested.bytes; files += nested.files;
    } else { bytes += (await lstat(file)).size; files++; }
  }
  return { bytes, files };
}
async function copyDependencies(stage, names, copied = new Set()) {
  for (const name of names) {
    if (copied.has(name)) continue;
    copied.add(name);
    const source = path.join(root, 'node_modules', name);
    await cp(source, path.join(stage, 'node_modules', name), { recursive: true });
    const metadata = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    await copyDependencies(stage, Object.keys(metadata.dependencies ?? {}), copied);
  }
  return copied;
}

test('desktop runtime retains required locales and fails before deleting an incomplete locale set', async t => {
  const directory = await temporary(t);
  const locales = path.join(directory, 'locales');
  await mkdir(locales);
  await writeFile(path.join(locales, 'fr.pak'), 'fr');
  await assert.rejects(pruneDesktopLocales(directory), /Required Electron locale/);
  assert.equal(await readFile(path.join(locales, 'fr.pak'), 'utf8'), 'fr');
  for (const locale of desktopLocales) await writeFile(path.join(locales, `${locale}.pak`), locale);
  await writeFile(path.join(locales, 'LICENSE'), 'keep');
  const result = await pruneDesktopLocales(directory);
  assert.deepEqual(result.removed, ['fr.pak']);
  assert.equal(result.removedBytes, 2);
  assert.deepEqual((await readdir(locales)).sort(), ['LICENSE', ...desktopLocales.map(locale => `${locale}.pak`)].sort());
  assert.equal((await pruneDesktopLocales(directory)).removedBytes, 0);
});

test('isolated packaged QuickJS retains host IO, interruption, cancellation and promise semantics without unused variants', async t => {
  const directory = await temporary(t);
  const before = path.join(directory, 'before'), after = path.join(directory, 'after');
  const previous = await copyDependencies(before, ['quickjs-emscripten']);
  const current = await copyDependencies(after, quickJsRuntimePackages);
  assert.equal(previous.size, 7);
  assert.deepEqual([...current].sort(), ['@jitl/quickjs-ffi-types', '@jitl/quickjs-wasmfile-release-sync', 'quickjs-emscripten-core']);
  for (const name of current) await readFile(path.join(after, 'node_modules', name, 'LICENSE'));
  const workerPath = path.join(after, 'sandbox-worker.mjs');
  const bundled = await build({
    entryPoints: [path.join(root, 'packages/technical/adaptation/sandbox-worker.mjs')], outfile: workerPath,
    bundle: true, platform: 'node', target: 'node24', format: 'esm',
    external: ['node:*', ...quickJsRuntimePackages, '@jitl/*'], legalComments: 'external', metafile: true,
  });
  const imports = Object.values(bundled.metafile.outputs).flatMap(output => output.imports.map(item => item.path));
  assert(!imports.some(name => /debug|asyncify|^quickjs-emscripten$/.test(name)));
  const sourceDir = path.join(directory, 'source'), outputDir = path.join(directory, 'output');
  await mkdir(sourceDir); await mkdir(outputDir);
  await writeFile(path.join(sourceDir, 'dialogue.txt'), 'original');
  const code = body => `({detect(){},extract(){},validate(){},roundtrip(){},build(){},assemble(host){${body}}})`;
  const run = (body, extra = {}) => runSandbox({ code: code(body), action: 'assemble', sourceDir, outputDir, allowedFiles: ['dialogue.txt'], workerPath, ...extra });
  const result = await run("host.writeText('dialogue.txt',host.readText('dialogue.txt')+' translated');return {promise:typeof Promise,list:host.list().map(x=>x.path)};");
  assert.deepEqual(result.result, { promise: 'function', list: ['dialogue.txt'] });
  assert.deepEqual(result.reads, ['dialogue.txt']);
  assert.deepEqual(result.writes, ['dialogue.txt']);
  assert.equal(await readFile(path.join(outputDir, 'dialogue.txt'), 'utf8'), 'original translated');
  assert.equal(await readFile(path.join(sourceDir, 'dialogue.txt'), 'utf8'), 'original');
  await assert.rejects(run('while(true){}', { limits: { timeoutMs: 30 } }), /interrupt|timeout|超时/i);
  await assert.rejects(run('return Promise.resolve(42);'), /must be synchronous/);
  const controller = new AbortController();
  const pending = run('while(true){}', { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /abort|取消/i);

  const { newQuickJSWASMModuleFromVariant } = await import(pathToFileURL(path.join(after, 'node_modules/quickjs-emscripten-core/dist/index.mjs')));
  const { default: release } = await import(pathToFileURL(path.join(after, 'node_modules/@jitl/quickjs-wasmfile-release-sync/dist/index.mjs')));
  const engine = await newQuickJSWASMModuleFromVariant(release), runtime = engine.newRuntime(), context = runtime.newContext();
  try {
    const result = context.evalCode('Promise.resolve(41).then(value => value + 1)');
    const pending = context.resolvePromise(result.value);
    const jobs = runtime.executePendingJobs();
    assert(!jobs.error);
    const settled = await pending;
    assert.equal(context.dump(settled.value), 42);
    settled.value.dispose(); result.value.dispose();
  } finally { context.dispose(); runtime.dispose(); }

  const beforeQuickJS = await inventory(path.join(before, 'node_modules'));
  const afterQuickJS = await inventory(path.join(after, 'node_modules'));
  const electronRuntime = process.env.PINHAO_ELECTRON_RUNTIME || path.join(root, 'node_modules/electron/dist');
  await cp(path.join(electronRuntime, 'locales'), path.join(after, 'locales'), { recursive: true });
  const beforeLocales = await inventory(path.join(after, 'locales'));
  const pruned = await pruneDesktopLocales(after);
  const afterLocales = await inventory(path.join(after, 'locales'));
  assert.equal(beforeLocales.bytes - afterLocales.bytes, pruned.removedBytes);
  assert(afterQuickJS.bytes < beforeQuickJS.bytes);
  assert.equal(afterLocales.files, 3);
  t.diagnostic(JSON.stringify({ beforeQuickJS, afterQuickJS, beforeLocales, afterLocales, removedBytes: beforeQuickJS.bytes - afterQuickJS.bytes + pruned.removedBytes }));
});
