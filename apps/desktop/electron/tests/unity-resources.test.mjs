import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { includeUnityRuntimePath } from '../../../../scripts/prepare-unity-tools.mjs';
import { validateManagedSourceIdentity, validateManagedTools } from '../../../../scripts/prepare-managed-tools.mjs';

test('packaging includes the compiled Unity display writer next to its Cecil dependency', async () => {
  const script = await readFile(new URL('../../../../scripts/package-desktop.mjs', import.meta.url), 'utf8');
  assert.ok(script.includes("'managed/Pinhao.UnityDisplay.exe'"));
  assert.ok(script.includes("'managed/Mono.Cecil.dll'"));
  assert.ok(script.indexOf('await validateManagedTools(root)') < script.indexOf("'managed/Pinhao.UnityDisplay.exe'"));
});

test('managed packaging rejects a substituted Cecil even when a stale provenance is rehashed', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-managed-set-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'local/dependencies/managed');
  const files = {};
  for (const file of ['Mono.Cecil.dll', 'Mono.Cecil-LICENSE.txt', 'Pinhao.ManagedPatch.exe', 'Pinhao.UnityDisplay.exe', 'net20/Pinhao.ManagedAssist.dll', 'net40/Pinhao.ManagedAssist.dll']) {
    await mkdir(path.dirname(path.join(target, file)), { recursive: true });
    const bytes = Buffer.from(`neutral substituted binary: ${file}`);
    await writeFile(path.join(target, file), bytes);
    files[file] = createHash('sha256').update(bytes).digest('hex');
  }
  await writeFile(path.join(target, 'provenance.json'), JSON.stringify({ dependency: 'Mono.Cecil 0.11.6', files }));
  await assert.rejects(validateManagedTools(directory), /SHA-256 mismatch: Mono.Cecil.dll/);
  await rm(path.join(target, 'Pinhao.ManagedPatch.exe'));
  await assert.rejects(validateManagedTools(directory), { code: 'ENOENT' });
});

test('managed source identities reject stale compiled provenance after source changes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-managed-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceHashes = {};
  await mkdir(path.join(directory, 'packages/runtime/managed'), { recursive: true });
  for (const file of ['Patch.cs', 'UnityDisplay.cs', 'Bridge.cs']) {
    const content = Buffer.from(`// Neutral ${file}\npublic class NeutralBridge { }\n`);
    await writeFile(path.join(directory, 'packages/runtime/managed', file), content);
    sourceHashes[file] = createHash('sha256').update(content).digest('hex');
  }
  await validateManagedSourceIdentity(directory, sourceHashes);
  const bridge = path.join(directory, 'packages/runtime/managed/Bridge.cs');
  const before = await readFile(bridge);
  await writeFile(bridge, Buffer.concat([before, Buffer.from('\n// Changed source must be recompiled.\n')]));
  await assert.rejects(validateManagedSourceIdentity(directory, sourceHashes), /source identity mismatch: Bridge.cs/);
  await writeFile(bridge, before);
  await assert.rejects(validateManagedSourceIdentity(directory, undefined), /source identity mismatch/);
});

test('Unity runtime excludes root command launchers on Windows and POSIX paths', () => {
  for (const entry of ['bin', 'bin/archspec.exe', 'bin\\archspec.exe', './bin/archspec.exe', '.\\bin\\other.exe', 'BIN/tool']) {
    assert.equal(includeUnityRuntimePath(entry), false, entry);
  }
  for (const entry of ['', '.', 'UnityPy/bin/reader.py', 'archspec/cpu/__init__.py']) {
    assert.equal(includeUnityRuntimePath(entry), true, entry);
  }
});

test('Unity runtime excludes bytecode files and cache directories', () => {
  for (const entry of ['__pycache__', 'UnityPy/__pycache__/reader.pyc', 'archspec\\__pycache__\\cpu.pyc', 'UnityPy/reader.pyc', 'UnityPy/reader.pyo']) {
    assert.equal(includeUnityRuntimePath(entry), false, entry);
  }
});

test('Unity runtime retains library code, native modules, metadata and licenses', () => {
  for (const entry of ['UnityPy/__init__.py', 'texture2ddecoder/_texture2ddecoder.pyd', 'UnityPy/lib/codec.dll',
    'unitypy-1.23.0.dist-info', 'unitypy-1.23.0.dist-info/licenses/LICENSE',
    'archspec-0.2.6.dist-info\\LICENSE-MIT', 'archspec-0.2.6.dist-info/entry_points.txt', 'provenance.json']) {
    assert.equal(includeUnityRuntimePath(entry), true, entry);
  }
});

test('Unity runtime copy filters stale launchers while preserving libraries and licenses', async () => {
  const parent = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, 'pinhao-unity-resources-'));
  const source = path.join(directory, 'source');
  const target = path.join(directory, 'target');
  const retained = ['UnityPy/__init__.py', 'archspec/cpu/__init__.py', 'native/decoder.pyd',
    'unitypy-1.23.0.dist-info/licenses/LICENSE', 'archspec-0.2.6.dist-info/LICENSE-MIT'];
  const excluded = ['bin/archspec.exe', 'bin/extra.exe', 'UnityPy/__pycache__/reader.pyc', 'UnityPy/stale.pyo'];
  try {
    for (const file of [...retained, ...excluded]) {
      await mkdir(path.dirname(path.join(source, file)), { recursive: true });
      await writeFile(path.join(source, file), `neutral fixture: ${file}`);
    }
    await cp(source, target, {
      recursive: true,
      filter: file => includeUnityRuntimePath(path.relative(source, file)),
    });
    for (const file of retained) assert.equal(await readFile(path.join(target, file), 'utf8'), `neutral fixture: ${file}`);
    for (const file of excluded) await assert.rejects(readFile(path.join(target, file)), { code: 'ENOENT' });
    assert.equal((await readdir(target)).includes('bin'), false);
    assert.equal((await readdir(path.join(target, 'UnityPy'))).includes('__pycache__'), false);
  } finally {
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith('pinhao-unity-resources-'));
    await rm(directory, { recursive: true, force: true });
  }
});
