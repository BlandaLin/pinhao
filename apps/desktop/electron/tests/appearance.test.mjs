import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createAppearance } from '../appearance.mjs';

function nativeTheme(systemDark = false) {
  const native = new EventEmitter();
  native.themeSource = 'system';
  Object.defineProperty(native, 'shouldUseDarkColors', { get() { return this.themeSource === 'dark' || this.themeSource === 'system' && systemDark; } });
  return native;
}

test('appearance follows the system initially and persists ordered explicit theme choices', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-appearance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const native = nativeTheme(true), backgrounds = [];
  const appearance = await createAppearance({ directory, nativeTheme: native, onChanged: value => backgrounds.push(value) });
  assert.equal(native.themeSource, 'system');
  assert.equal(appearance.backgroundColor, '#181716');
  await Promise.all([appearance.setTheme('dark'), appearance.setTheme('light'), appearance.setTheme('dark')]);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'appearance.json'), 'utf8')), { theme: 'dark' });
  assert.deepEqual(backgrounds, ['#181716', '#fafafa', '#181716']);
  const restored = nativeTheme(false);
  await createAppearance({ directory, nativeTheme: restored });
  assert.equal(restored.themeSource, 'dark');
  await assert.rejects(appearance.setTheme('unexpected'), /日间模式或深夜模式/);
  assert.equal(native.themeSource, 'dark');
  await appearance.setTheme('system');
  assert.equal(native.themeSource, 'system');
  assert.equal(appearance.backgroundColor, '#181716');
  const following = nativeTheme(false);
  await createAppearance({ directory, nativeTheme: following });
  assert.equal(following.themeSource, 'system');
});

test('an incomplete appearance preference falls back to system colors', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-appearance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'appearance.json'), '{"theme":');
  const native = nativeTheme(false);
  const appearance = await createAppearance({ directory, nativeTheme: native });
  assert.equal(native.themeSource, 'system');
  assert.equal(appearance.backgroundColor, '#fafafa');
});
