import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectFilePage, listFiles } from './adaptation/paths.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-path-kind-'));
  await mkdir(path.join(directory, 'data'));
  await writeFile(path.join(directory, 'data', 'level0'), 'Neutral binary carrier.');
  await writeFile(path.join(directory, 'root-carrier'), 'Root carrier.');
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('pinhao-path-kind-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
  });
  return directory;
}

test('listing an extensionless file retains ENOTDIR and gives its real kind, size, parent and recovery action', async t => {
  const root = await fixture(t);
  for (const [relativePath, parent, size] of [['data/level0', 'data', 23], ['root-carrier', '', 13]]) {
    for (const list of [() => listFiles(root, relativePath), () => inspectFilePage(root, { relativePath, limit: 12 })]) {
      await assert.rejects(list(), error => {
        assert.equal(error.code, 'ENOTDIR');
        assert.deepEqual(error.resource, { kind: 'file', relativePath, parent, size });
        assert.match(error.nextAction, /read_resource/);
        assert.match(error.nextAction, /native_review/);
        assert.ok(error.nextAction.includes(`relativePath:${JSON.stringify(parent)}`));
        assert.equal(error.files, undefined, 'a mistaken file path never triggers an implicit parent scan');
        return true;
      });
    }
  }
});

test('directory listing pagination and missing-path errors preserve their existing contracts', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'data', 'second'), 'Second file.');
  const first = await inspectFilePage(root, { relativePath: 'data', limit: 1 });
  assert.deepEqual(first, { files: [{ path: 'data/level0', route: 'unknown', size: 23 }], offset: 0, nextOffset: 1, truncated: true });
  const second = await inspectFilePage(root, { relativePath: 'data', offset: 1, limit: 1 });
  assert.deepEqual(second, { files: [{ path: 'data/second', route: 'unknown', size: 12 }], offset: 1, nextOffset: null, truncated: false });
  await assert.rejects(inspectFilePage(root, { relativePath: 'missing' }), error => error.code === 'ENOENT' && error.resource === undefined);
});

test('routing enriches investigation views without changing deterministic guest listing hashes', async t => {
  const root = await fixture(t);
  const raw = await listFiles(root, 'data');
  assert.deepEqual(raw.files, [{ path: 'data/level0', size: 23 }]);
  const inspected = await inspectFilePage(root, { relativePath: 'data' });
  assert.equal(inspected.files[0].route, 'unknown');
  assert.deepEqual(inspected.files.map(({ route, ...file }) => file), raw.files);
});

test('path-kind recovery never bypasses link or traversal checks', async t => {
  const root = await fixture(t);
  await symlink(path.join(root, 'data'), path.join(root, 'linked'), 'junction');
  await assert.rejects(listFiles(root, 'linked/level0'), error => /链接|越界/.test(error.message) && error.resource === undefined);
  await assert.rejects(listFiles(root, '../outside'), error => /无效片段/.test(error.message) && error.resource === undefined);
});
