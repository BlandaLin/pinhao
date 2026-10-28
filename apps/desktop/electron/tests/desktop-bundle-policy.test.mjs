import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import { desktopBundleBuilds } from '../../../../scripts/desktop-bundle-policy.mjs';
import { quickJsRuntimePackages } from '../../../../scripts/desktop-runtime.mjs';
import { readFormatKernelIdentity } from '../../../../packages/technical/adaptation/format-capabilities.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const stage = path.join(root, 'local', 'bundle-policy-test-not-written');
const optionsFor = (extra = {}) => ({ root, stage, define: { __PINHAO_FORMAT_KERNEL__: 'test-identity' }, ...extra });
const dataModule = source => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-bundle-policy-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('normal desktop builds retain the three production entries and their runtime boundaries', () => {
  const builds = desktopBundleBuilds(optionsFor());
  assert.deepEqual(builds.map(row => row.name), ['main', 'service-worker', 'sandbox-worker']);
  const byName = Object.fromEntries(builds.map(row => [row.name, row.options]));
  for (const [name, options] of Object.entries(byName)) {
    assert.equal(options.outfile, path.join(stage, `${name}.mjs`));
    assert.equal(options.bundle, true);
    assert.equal(options.platform, 'node');
    assert.equal(options.target, 'node24');
    assert.equal(options.format, 'esm');
    assert.equal(options.legalComments, 'external');
    assert.equal(options.metafile, true);
    for (const key of ['minify', 'minifyWhitespace', 'minifySyntax', 'minifyIdentifiers', 'keepNames', 'splitting']) {
      assert.equal(options[key], undefined, `${name} unexpectedly changes ${key}`);
    }
  }
  assert.deepEqual(byName.main.entryPoints, [path.join(root, 'apps/desktop/electron/main.mjs')]);
  assert.deepEqual(byName['service-worker'].entryPoints, [path.join(root, 'apps/desktop/electron/service-worker.mjs')]);
  assert.deepEqual(byName['sandbox-worker'].entryPoints, [path.join(root, 'packages/technical/adaptation/sandbox-worker.mjs')]);
  assert.deepEqual(byName.main.external, ['electron', 'node:*', 'sharp']);
  assert.deepEqual(byName['service-worker'].external, ['node:*', 'sharp']);
  assert.deepEqual(byName['sandbox-worker'].external, ['node:*', ...quickJsRuntimePackages, '@jitl/*']);
  assert.deepEqual(byName.main.define, optionsFor().define);
  assert.deepEqual(byName['service-worker'].define, optionsFor().define);
  assert.equal(byName['sandbox-worker'].define, undefined);
  assert.match(byName.main.banner.js, /__pinhaoCreateRequire\(import\.meta\.url\)/);
  assert.deepEqual(byName['service-worker'].banner, byName.main.banner);
  assert.equal(byName['sandbox-worker'].banner, undefined);
});

test('only the explicit acceptance flag adds the isolated carrier without changing production builds', () => {
  const normal = desktopBundleBuilds(optionsFor());
  const acceptance = desktopBundleBuilds(optionsFor({ args: ['--acceptance-bundle'] }));
  assert.deepEqual(acceptance.slice(0, 3), normal);
  assert.deepEqual(acceptance.map(row => row.name), ['main', 'service-worker', 'sandbox-worker', 'dsh-business']);
  const carrier = acceptance.at(-1).options;
  assert.deepEqual(carrier.entryPoints, [path.join(root, 'scripts/dsh-carrier-entry.mjs')]);
  assert.equal(carrier.outfile, path.join(stage, 'dsh-business.mjs'));
  assert.deepEqual(carrier.external, ['node:*', 'sharp']);
  assert.deepEqual(carrier.banner, normal[0].options.banner);
  assert.deepEqual(desktopBundleBuilds(optionsFor({ args: ['--dsh-experiment'] })), normal);
});

test('the explicit acceptance carrier still bundles and exposes the real isolated business modules', async t => {
  const directory = await temporary(t);
  const define = { __PINHAO_FORMAT_KERNEL__: JSON.stringify(await readFormatKernelIdentity()) };
  const carrier = desktopBundleBuilds(optionsFor({ stage: directory, define, args: ['--acceptance-bundle'] })).at(-1);
  const result = await build({ ...carrier.options, write: false });
  const inputs = Object.keys(result.metafile.inputs).map(file => file.replaceAll('\\', '/'));
  for (const file of ['scripts/dsh-carrier-entry.mjs', 'packages/technical/adaptation/adapter-lab.mjs',
    'packages/core/adaptation-budget.mjs', 'packages/technical/dsh-runner.mjs', 'packages/technical/adaptation.mjs']) {
    assert(inputs.some(input => input.endsWith(file)), `Acceptance bundle lost ${file}`);
  }
  const expected = ['createAdaptationBudget', 'createAdapterLab', 'inspectDshRuntime', 'readAdaptationState', 'runDshAdaptation'];
  const output = Object.values(result.metafile.outputs).find(value => value.entryPoint?.endsWith('dsh-carrier-entry.mjs'));
  assert.deepEqual(output.exports, expected);
  assert(output.imports.every(item => item.external && item.path.startsWith('node:')));
  const source = result.outputFiles.find(file => file.path === carrier.options.outfile).text;
  // The production createRequire/import.meta.url banner requires a file URL, not a data URL.
  await writeFile(carrier.options.outfile, source);
  const loaded = await import(pathToFileURL(carrier.options.outfile));
  assert.deepEqual(Object.keys(loaded).sort(), expected);
  for (const name of expected) assert.equal(typeof loaded[name], 'function');
  t.diagnostic(`Acceptance bundle ${Buffer.byteLength(source)} bytes; imports only Node built-ins; no model or game execution.`);
});

const serializationModes = [
  ['current default', {}],
  ['candidate whitespace and syntax only', { minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false, keepNames: false }],
];

for (const [label, minification] of serializationModes) {
  test(`${label}: the serialized game assistance plugin has no desktop helper dependency`, async () => {
    const result = await build({ entryPoints: [path.join(root, 'packages/runtime/assist.mjs')], bundle: true,
      platform: 'node', target: 'node24', format: 'esm', external: ['node:*'], write: false, ...minification });
    const loaded = await dataModule(result.outputFiles[0].text);
    let intervals = 0;
    vm.runInNewContext(loaded.assistPluginSource, {
      window: { require: () => ({}) },
      process: { env: { PINHAO_ASSIST_PORT: '1', PINHAO_ASSIST_TOKEN: 'neutral-local-test' } },
      setInterval: (_handler, milliseconds) => { intervals++; assert.equal(milliseconds, 1000); },
    }, { timeout: 1000 });
    assert.equal(intervals, 1);
  });

  test(`${label}: the serialized text adapter extracts, preserves and updates a neutral field`, async t => {
    const directory = await temporary(t);
    await mkdir(path.join(directory, 'data'));
    const original = '{"gameTitle":"Demo","currencyUnit":"Coin"}';
    await writeFile(path.join(directory, 'data/System.json'), original);
    const result = await build({ entryPoints: [path.join(root, 'packages/technical/adaptation/text-adapter.mjs')],
      bundle: true, platform: 'node', target: 'node24', format: 'esm', external: ['node:*'], write: false, ...minification });
    const loaded = await dataModule(result.outputFiles[0].text);
    const candidate = await loaded.createTextAdapter({ gameDir: directory, candidates: [
      { file: 'data/System.json', source: 'Demo', locator: { file: 'data/System.json', pointer: '/gameTitle' }, classification: 'display_unresolved' },
    ] });
    const guest = vm.runInNewContext(candidate.code, {}, { timeout: 1000 });
    const writes = [];
    const host = { readText: () => original, readBytes: () => Buffer.from(original),
      writeBytes: (file, bytes) => writes.push({ file, bytes: Buffer.from(bytes) }),
      writeText: (file, text) => writes.push({ file, bytes: Buffer.from(text) }) };
    assert.equal(guest.detect(host).matched, true);
    const { units } = guest.extract(host);
    assert.equal(units.length, 1);
    assert.equal(units[0].source, 'Demo');
    guest.roundtrip(host);
    assert.equal(writes[0].bytes.toString('utf8'), original);
    guest.build(host, { units, translations: { [units[0].id]: 'Translated title' } });
    assert.deepEqual(JSON.parse(writes[1].bytes), { gameTitle: 'Translated title', currencyUnit: 'Coin' });
    assert.equal(await readFile(path.join(directory, 'data/System.json'), 'utf8'), original);
  });
}
