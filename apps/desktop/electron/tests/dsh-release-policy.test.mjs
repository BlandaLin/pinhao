import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyDshRuntimeForRelease, dshReleaseExclusion, DSH_RELEASE_POLICY } from '../../../../scripts/dsh-release-policy.mjs';

const hash = raw => createHash('sha256').update(raw).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-dsh-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'prepared'), target = path.join(root, 'release');
  const payloads = {
    'package.json': '{"name":"neutral-runtime","type":"module"}',
    'LICENSE': 'Neutral licensed fixture',
    'node/node.exe': 'neutral-placeholder-node', 'node/provenance.json': '{}',
    'node_modules/sdk/lib/index.js': 'export const SDK = true;',
    'node_modules/cli/lib/bin.js': 'export const CLI = true;',
    'node_modules/provider/lib/index.js': 'export const provider = true;',
    'node_modules/sdk/lib/index.js.map': '{}', 'node_modules/sdk/lib/index.d.ts': 'export declare const SDK: true;',
    'node_modules/sdk/lib/index.d.mts': 'export declare const SDK: true;', 'node_modules/sdk/lib/index.d.cts': 'declare const SDK: true;',
    'node_modules/sdk/.tsbuildinfo': '{}', 'node_modules/native/symbols.pdb': 'debug-only',
    'node_modules/node-pty/prebuilds/win32-x64/pty.node': 'neutral-x64-native',
    'node_modules/node-pty/prebuilds/win32-arm64/pty.node': 'neutral-arm64-native',
    'node_modules/node-pty/third_party/conpty/win10-arm64/OpenConsole.exe': 'neutral-arm64-terminal',
    'node_modules/node-pty/prebuilds/win32-arm64/LICENSE.txt': 'Keep every license even under an excluded architecture',
    'node_modules/native/LICENSE.map': 'License names take priority over extension filtering',
    'node_modules/native/schema.json': '{"required":true}',
  };
  const files = [];
  for (const [file, text] of Object.entries(payloads)) {
    const raw = Buffer.from(text); await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), raw); files.push({ path: file, sha256: hash(raw), bytes: raw.length });
  }
  const provenance = { schema: 'pinhao-dsh-runtime-1', commit: '22ddee3792402c3e70ec5f86a63c3e3e895a2f60',
    sdkEntry: 'node_modules/sdk/lib/index.js', runtimeEntry: 'node_modules/cli/lib/bin.js', modelProviderEntry: 'node_modules/provider/lib/index.js',
    nodeExecutable: 'node/node.exe', nodeProvenance: 'node/provenance.json', files, bytes: files.reduce((sum, row) => sum + row.bytes, 0) };
  await writeFile(path.join(source, 'pinhao-runtime-provenance.json'), JSON.stringify(provenance));
  return { source, target, provenance, payloads };
}

test('production policy removes developer metadata and wrong-architecture terminal files, not runtime code or licenses', () => {
  for (const name of ['sdk.d.ts', 'sdk.d.mts', 'sdk.d.cts', 'sdk.js.map', '.tsbuildinfo', 'symbols.pdb']) assert.ok(dshReleaseExclusion(name));
  assert.equal(dshReleaseExclusion('node_modules/node-pty/prebuilds/win32-arm64/pty.node'), 'other-architecture');
  assert.equal(dshReleaseExclusion('node_modules/node-pty/prebuilds/win32-x64/pty.node'), undefined);
  assert.equal(dshReleaseExclusion('node_modules/node-pty/prebuilds/win32-arm64/pty.node', { platform: 'win32', arch: 'arm64' }), undefined);
  for (const name of ['LICENSE.map', 'nested/NOTICE.txt', 'index.js', 'schema.json', 'data.bin']) assert.equal(dshReleaseExclusion(name), undefined);
});

test('release derivation verifies original bytes and regenerates exact provenance without changing the prepared artifact', async t => {
  const f = await fixture(t), original = await readFile(path.join(f.source, 'pinhao-runtime-provenance.json'));
  const release = await copyDshRuntimeForRelease({ sourceRoot: f.source, outputDirectory: f.target });
  assert.equal(release.releasePolicy.id, DSH_RELEASE_POLICY);
  assert.equal(release.releasePolicy.sourceProvenanceSha256, hash(original));
  assert.ok(release.releasePolicy.excludedFiles > 0);
  assert.ok(release.bytes < f.provenance.bytes);
  for (const row of release.files) {
    const raw = await readFile(path.join(f.target, row.path));
    assert.equal(hash(raw), row.sha256); assert.equal(raw.length, row.bytes);
    assert.equal(dshReleaseExclusion(row.path), undefined);
  }
  assert.deepEqual(await readFile(path.join(f.source, 'pinhao-runtime-provenance.json')), original);
  for (const [file, text] of Object.entries(f.payloads)) assert.equal(await readFile(path.join(f.source, file), 'utf8'), text);
  const files = new Set(release.files.map(row => row.path));
  assert.ok(files.has('node/node.exe')); assert.ok(files.has('node_modules/native/LICENSE.map'));
  assert.ok(files.has('node_modules/node-pty/prebuilds/win32-arm64/LICENSE.txt'));
  await assert.rejects(copyDshRuntimeForRelease({ sourceRoot: f.source, outputDirectory: f.target }), /already exists/);
});

test('release copy refuses unrecorded private state and a tampered file even when it would be excluded', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'state.json'), '{"session":"not-a-runtime-file"}');
  await assert.rejects(copyDshRuntimeForRelease({ sourceRoot: f.source, outputDirectory: f.target }), /outside its provenance/);
  await rm(path.join(f.source, 'state.json'));
  await writeFile(path.join(f.source, 'node_modules/sdk/lib/index.js.map'), '{"changed":true}');
  await assert.rejects(copyDshRuntimeForRelease({ sourceRoot: f.source, outputDirectory: f.target }), /payload changed/);
});

test('release output cannot overwrite or nest inside the prepared artifact', async t => {
  const f = await fixture(t);
  await assert.rejects(copyDshRuntimeForRelease({ sourceRoot: f.source, outputDirectory: f.source }), /separate directory/);
  await assert.rejects(copyDshRuntimeForRelease({ sourceRoot: f.source, outputDirectory: path.join(f.source, 'release') }), /separate directory/);
  assert.ok((await readdir(f.source)).includes('node_modules'));
});
