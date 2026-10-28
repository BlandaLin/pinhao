import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { configureDesktopStorage, desktopDataDirectory, importWithWorkspaceSelection } from '../storage.mjs';

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-storage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('portable and explicit profiles do not resolve through system AppData', () => {
  const root = path.resolve('portable-root');
  const options = { packaged: true, execPath: path.join(root, 'Pinhao.exe'), sourceRoot: path.resolve('source') };
  assert.equal(desktopDataDirectory(options), path.join(root, 'data'));
  assert.equal(desktopDataDirectory({ ...options, override: path.join(root, 'selected') }), path.join(root, 'selected'));
  assert.equal(desktopDataDirectory({ ...options, packaged: false }), path.join(options.sourceRoot, 'local', 'product-data'));
  assert.equal(desktopDataDirectory({ ...options, packaged: false, smoke: true }), path.join(options.sourceRoot, 'local', 'desktop-smoke-data'));
});

test('portable setup creates only its own profile and preserves existing contents', async t => {
  const directory = await temporary(t), settings = path.join(directory, 'settings.json');
  await writeFile(settings, 'existing settings');
  const paths = [];
  assert.equal(configureDesktopStorage({ setPath: (...args) => paths.push(args) }, directory), directory);
  assert.deepEqual(paths, [['userData', path.join(directory, 'electron-profile')], ['sessionData', path.join(directory, 'electron-profile')]]);
  assert.equal(await readFile(settings, 'utf8'), 'existing settings');
  assert.deepEqual((await readdir(directory)).sort(), ['electron-profile', 'settings.json']);
  assert.deepEqual(await readdir(path.join(directory, 'electron-profile')), []);
});

test('an unusable selected folder fails clearly without configuring a fallback', async t => {
  const directory = await temporary(t), blocked = path.join(directory, 'not-a-folder');
  await writeFile(blocked, 'do not change');
  const paths = [];
  assert.throws(() => configureDesktopStorage({ setPath: (...args) => paths.push(args) }, blocked), error => {
    assert.equal(error.code, 'PORTABLE_DATA_UNWRITABLE');
    assert.match(error.message, /没有改用其他目录/);
    assert(error.message.includes(blocked));
    return true;
  });
  assert.deepEqual(paths, []);
  assert.equal(await readFile(blocked, 'utf8'), 'do not change');
});

test('import retries once only after a user selects a workspace parent', async () => {
  const calls = [], input = { gameDir: 'original-game', name: 'Game', outputDir: 'explicit-output' };
  const result = await importWithWorkspaceSelection(async value => {
    calls.push(value);
    if (calls.length === 1) throw Object.assign(new Error('read-only parent'), { code: 'WORKSPACE_LOCATION_REQUIRED' });
    return { id: 'new-project' };
  }, input, async error => {
    assert.equal(error.code, 'WORKSPACE_LOCATION_REQUIRED');
    return 'chosen-workspace-parent';
  });
  assert.deepEqual(result, { id: 'new-project' });
  assert.deepEqual(calls, [input, { ...input, workspaceParent: 'chosen-workspace-parent' }]);
  assert.equal(input.workspaceParent, undefined);
});

test('cancelling or unrelated errors do not create an import elsewhere', async () => {
  const expected = Object.assign(new Error('no space'), { code: 'WORKSPACE_LOCATION_REQUIRED' });
  let calls = 0;
  await assert.rejects(importWithWorkspaceSelection(async () => { calls++; throw expected; }, {}, async () => null), error => error === expected);
  assert.equal(calls, 1);
  const unrelated = new Error('extraction failed');
  await assert.rejects(importWithWorkspaceSelection(async () => { throw unrelated; }, {}, async () => assert.fail('must not select a folder')), error => error === unrelated);
});

test('a failed selected workspace is surfaced rather than prompting in a loop', async () => {
  let calls = 0, selections = 0;
  await assert.rejects(importWithWorkspaceSelection(async () => {
    calls++;
    throw Object.assign(new Error('still no space'), { code: 'WORKSPACE_LOCATION_REQUIRED' });
  }, {}, async () => { selections++; return 'also-full'; }), /still no space/);
  assert.equal(calls, 2);
  assert.equal(selections, 1);
});
