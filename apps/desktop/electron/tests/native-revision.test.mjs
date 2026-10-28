import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { nativePipelineRevision } from '../host.mjs';

async function fixture(t) {
  const base = os.tmpdir(), root = await mkdtemp(path.join(base, 'pinhao-native-revision-'));
  const adapters = path.join(root, 'original', 'adapters'), toolkit = path.join(root, 'original', 'toolkit');
  await mkdir(path.join(adapters, 'codec'), { recursive: true });
  await mkdir(path.join(toolkit, 'resources'), { recursive: true });
  await writeFile(path.join(adapters, 'worker.py'), 'from codec.parser import extract\n');
  await writeFile(path.join(adapters, 'codec', 'parser.py'), 'def extract():\n    return "one"\n');
  await writeFile(path.join(toolkit, 'resources', 'format.json'), '{"format":1}');
  const options = { workerPath: path.join(adapters, 'worker.py'), toolkitPath: toolkit };
  t.after(async () => {
    const relative = path.relative(base, root);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { root, adapters, toolkit, options };
}

test('native pipeline revision is a stable source-content digest independent of installation location', async t => {
  const f = await fixture(t);
  const first = await nativePipelineRevision(f.options);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(await nativePipelineRevision(f.options), first);
  const relocated = path.join(f.root, 'relocated');
  await cp(path.join(f.root, 'original'), relocated, { recursive: true });
  assert.equal(await nativePipelineRevision({ workerPath: path.join(relocated, 'adapters', 'worker.py'), toolkitPath: path.join(relocated, 'toolkit') }), first);
  await writeFile(path.join(f.adapters, 'codec', 'parser.py'), 'def extract():\n    return "two"\n');
  const changed = await nativePipelineRevision(f.options);
  assert.notEqual(changed, first, 'equal-length parser source changes must change the revision');
  await writeFile(path.join(f.toolkit, 'resources', 'format.json'), '{"format":2}');
  assert.notEqual(await nativePipelineRevision(f.options), changed, 'toolkit resource changes must change the revision');
  const beforeBridge = await nativePipelineRevision(f.options);
  await writeFile(path.join(f.adapters, 'unity_schema.cs'), 'class Schema { const int Version = 1; }');
  const bridge = await nativePipelineRevision(f.options);
  assert.notEqual(bridge, beforeBridge);
  await writeFile(path.join(f.adapters, 'unity_schema.cs'), 'class Schema { const int Version = 2; }');
  assert.notEqual(await nativePipelineRevision(f.options), bridge, 'managed schema source changes must invalidate native proof');
});

test('native pipeline revision ignores test sources and Python cache directories', async t => {
  const f = await fixture(t);
  const baseline = await nativePipelineRevision(f.options);
  for (const directory of [path.join(f.adapters, '__pycache__'), path.join(f.toolkit, 'tests'), path.join(f.adapters, 'test_helpers')]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'ignored.py'), 'raise AssertionError("neutral test content")\n');
  }
  await writeFile(path.join(f.adapters, 'test_codec.py'), 'raise AssertionError("neutral test")\n');
  assert.equal(await nativePipelineRevision(f.options), baseline);
  await writeFile(path.join(f.adapters, 'test_codec.py'), 'raise AssertionError("changed neutral test")\n');
  await writeFile(path.join(f.adapters, '__pycache__', 'ignored.py'), 'changed cache content\n');
  assert.equal(await nativePipelineRevision(f.options), baseline);
});
