import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';

async function fixture(t) {
  const parent = path.resolve('local/settings-default-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'target-'));
  const dataDir = path.join(root, 'data'), services = [];
  t.after(async () => {
    for (const service of services) await service.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { root, dataDir, async open(defaultTargetLanguage) {
    const service = await createService({ dataDir, defaultTargetLanguage, scriptTools: null,
      worker: async command => {
        assert.equal(command, 'catalog');
        return { engines: [] };
      },
    });
    services.push(service);
    return service;
  } };
}

test('fresh settings use the injected target while unconfigured builds keep Simplified Chinese', async t => {
  assert.equal(defaultSettings().targetLanguage, 'zh-Hans');
  assert.equal(defaultSettings('en').targetLanguage, 'en');
  for (const targetLanguage of ['en', 'zh-Hans', undefined]) {
    const f = await fixture(t), service = await f.open(targetLanguage);
    assert.equal((await service.snapshot()).settings.targetLanguage, targetLanguage ?? 'zh-Hans');
  }
});

test('saving a blank or missing target restores this build default without changing a chosen target', async t => {
  for (const targetLanguage of ['en', 'zh-Hans']) {
    const f = await fixture(t), service = await f.open(targetLanguage);
    const settings = (await service.snapshot()).settings;
    assert.equal((await service.saveSettings({ ...settings, targetLanguage: 'ja' })).targetLanguage, 'ja');
    assert.equal((await service.saveSettings({ ...settings, targetLanguage: '  ' })).targetLanguage, targetLanguage);
    delete settings.targetLanguage;
    assert.equal((await service.saveSettings(settings)).targetLanguage, targetLanguage);
    await service.close();
    const reopened = await f.open(targetLanguage === 'en' ? 'zh-Hans' : 'en');
    assert.equal((await reopened.snapshot()).settings.targetLanguage, targetLanguage);
  }
});

test('a missing settings target uses the build default without rewriting project or run targets', async t => {
  const f = await fixture(t), workspaceDir = path.join(f.root, 'project');
  await mkdir(f.dataDir, { recursive: true });
  await mkdir(workspaceDir);
  const original = { id: 'target-test', name: 'Target fixture', workspaceDir, gameDir: path.join(f.root, 'game'),
    status: 'ready', targetLanguage: 'ja', runConfig: { targetLanguage: 'ja', mode: 'translation' } };
  let store = createStore(f.dataDir);
  const settings = { id: 'global', ...defaultSettings(), concurrency: 7 };
  delete settings.targetLanguage;
  store.put('settings', settings);
  store.put('projects', original);
  store.close();
  const service = await f.open('en');
  assert.equal((await service.snapshot()).settings.targetLanguage, 'en');
  assert.equal((await service.snapshot()).settings.concurrency, 7);
  await service.saveSettings({ ...(await service.snapshot()).settings, targetLanguage: '' });
  await service.close();
  store = createStore(f.dataDir);
  try { assert.deepEqual(store.one('projects', original.id), original); }
  finally { store.close(); }
});
