import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createFormatCapabilities, readFormatKernelIdentity } from './format-capabilities.mjs';

test('isolated built format kernel preserves the real source identity without relocated source files', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-format-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 }));
  const content = await readFormatKernelIdentity(), expected = await createFormatCapabilities();
  const bundle = async (name, identity) => {
    const file = path.join(directory, `${name}.mjs`);
    await build({ entryPoints: [fileURLToPath(new URL('./format-capabilities.mjs', import.meta.url))], outfile: file,
      bundle: true, platform: 'node', format: 'esm', define: { __PINHAO_FORMAT_KERNEL__: JSON.stringify(identity) } });
    return (await import(pathToFileURL(file))).createFormatCapabilities();
  };
  const actual = await bundle('original', content);
  assert.equal(actual.fingerprint, expected.fingerprint);
  assert.deepEqual(actual.describe(), expected.describe());
  const changed = await bundle('changed', { ...content, 'adapter-lab.mjs': 'f'.repeat(64) });
  assert.notEqual(changed.fingerprint, expected.fingerprint, 'implementation changes must invalidate capability identity');
});
