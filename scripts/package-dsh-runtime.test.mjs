import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { packageDshRuntime, verifyManagedNode, addManagedNodeToRuntime } from './package-dsh-runtime.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-dsh-deployment-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  const sourceRoot = path.join(root, 'source'), outputDirectory = path.join(root, 'runtime');
  await mkdir(path.join(sourceRoot, '.git'), { recursive: true });
  await writeFile(path.join(sourceRoot, '.git/HEAD'), '22ddee3792402c3e70ec5f86a63c3e3e895a2f60\n');
  await writeFile(path.join(sourceRoot, 'LICENSE'), 'MIT fixture license\n');
  const pkg = async (relative, name, version, code, dependencies = {}, entry = 'index.js') => {
    const directory = path.join(sourceRoot, relative);
    await mkdir(path.join(directory, 'lib'), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version, type: 'module', main: `lib/${entry}`, dependencies }));
    await writeFile(path.join(directory, 'lib', entry), code);
    return directory;
  };
  await pkg('packages/sdk/client', '@deepseek-ai/dsh-sdk-client', '0.2.1-rc.3', 'export class DeepSeekHarness {}\n');
  await pkg('apps/cli', '@deepseek-ai/dsh', '0.2.1-rc.3', "import a from 'first'; import b from 'second'; console.log(a,b);\n", { 'unused-web-ui': 'workspace:*', 'native-hook': '*' }, 'bin.js');
  await pkg('node_modules/@deepseek-ai/dsh-sdk-minimal', '@deepseek-ai/dsh-sdk-minimal', '0.2.1-rc.3', 'export const profile = true;\n');
  await pkg('node_modules/@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-llm-pi-ai', '0.2.1-rc.3', 'export const adapter = true;\n');
  await pkg('node_modules/first', 'first', '1.0.0', "import value from 'leaf'; export default value;\n", { leaf: '^1' });
  await pkg('node_modules/second', 'second', '1.0.0', "import value from 'leaf'; export default value;\n", { leaf: '^2' });
  await pkg('node_modules/leaf', 'leaf', '1.0.0', 'export default 1;\n');
  await pkg('node_modules/second/node_modules/leaf', 'leaf', '2.0.0', 'export default 2;\n');
  await pkg('node_modules/native-hook', 'native-hook', '1.0.0', 'export default true;\n');
  return { sourceRoot, outputDirectory, runtimeManifest: { modules: [] }, managedNodeRoot: path.resolve('local/managed-node') };
}

test('runtime deployment follows compiled imports, retains exact bytes and resolves conflicting dependency versions locally', async t => {
  const options = await fixture(t), result = await packageDshRuntime(options);
  assert.equal(result.schema, 'pinhao-dsh-runtime-1');
  assert.equal(result.nodeExecutable, 'node/node.exe');
  assert.ok(result.files.some(row => row.path === result.nodeExecutable && row.sha256 === 'b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3'));
  assert.ok(result.files.some(row => row.path === result.modelProviderEntry && /^[a-f0-9]{64}$/.test(row.sha256)));
  assert.equal(await readFile(path.join(options.outputDirectory, result.sdkEntry), 'utf8'), 'export class DeepSeekHarness {}\n');
  const report = JSON.parse(await readFile(path.join(options.outputDirectory, 'runtime-dependencies.json'), 'utf8'));
  assert.ok(!report.packages.some(row => row.name === 'unused-web-ui'));
  assert.ok(report.packages.some(row => row.name === 'native-hook'), 'declared dynamic native hooks must be included');
  assert.deepEqual(report.packages.filter(row => row.name === 'leaf').map(row => row.version).sort(), ['1.0.0', '2.0.0']);
  assert.ok(report.packages.some(row => row.name === 'leaf' && row.path.includes('/second/node_modules/leaf')));
  assert.ok(!JSON.stringify(result).includes(options.sourceRoot));
  for (const item of result.files) {
    assert.equal(path.isAbsolute(item.path), false);
    assert.equal((await lstat(path.join(options.outputDirectory, item.path))).isSymbolicLink(), false);
  }
  assert.ok(!(await readdir(options.outputDirectory)).includes('.git'));
  await assert.rejects(packageDshRuntime(options), /new or empty/);
  await writeFile(path.join(options.outputDirectory, result.sdkEntry), 'changed compiled runtime');
  await assert.rejects(addManagedNodeToRuntime(options), /runtime payload changed/);
});

test('deployment refuses changed upstream identity and absent real module manifest', async t => {
  const options = await fixture(t);
  await assert.rejects(packageDshRuntime({ ...options, runtimeManifest: undefined }), /actual loaded/);
  await writeFile(path.join(options.sourceRoot, '.git/HEAD'), 'different-commit\n');
  await assert.rejects(packageDshRuntime(options), /frozen DSH commit/);
});

test('managed Node refuses a forged checksum list or modified executable', async t => {
  const options = await fixture(t), directory = path.join(options.sourceRoot, 'bad-node');
  await mkdir(directory);
  await writeFile(path.join(directory, 'node.exe'), 'not the official binary');
  await writeFile(path.join(directory, 'LICENSE'), 'MIT');
  await writeFile(path.join(directory, 'SHASUMS256.txt'), `${'0'.repeat(64)}  win-x64/node.exe\n`);
  await assert.rejects(verifyManagedNode(directory), /official release checksum/);
  await writeFile(path.join(directory, 'SHASUMS256.txt'), 'b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3  win-x64/node.exe\n');
  await assert.rejects(verifyManagedNode(directory), /official release checksum/);
});
