import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from '../../../../packages/core/service.mjs';
import { createStore } from '../../../../packages/core/workspace-store.mjs';

const testRoot = path.resolve('local', 'credential-preflight-tests');
await mkdir(testRoot, { recursive: true });

function storedState(dataDir) {
  const store = createStore(dataDir);
  try {
    return Object.fromEntries(['projects', 'units', 'revisions', 'tasks', 'settings'].map(table => [table, store.all(table)]));
  } finally { store.close(); }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(testRoot, 'neutral-'));
  const dataDir = path.join(root, 'data');
  const gameDir = path.join(root, 'game');
  await mkdir(gameDir);
  await writeFile(path.join(gameDir, 'original.txt'), 'Neutral original fixture');
  const requests = [];
  const secrets = {
    encrypt: async text => text === 'fixture-new-key' ? 'fixture:new' : 'fixture:old',
    decrypt: async text => {
      if (text === 'fixture:old') throw new Error('Saved credential decryption failed');
      assert.equal(text, 'fixture:new');
      return 'fixture-new-key';
    },
  };
  const service = await createService({
    dataDir, secrets, scriptTools: null, imageTools: null,
    worker: async (command, input) => {
      if (command === 'catalog') return { engines: [] };
      if (command === 'probe') return { engine: 'MZ' };
      if (command === 'extract') {
        await mkdir(input.workspaceDir, { recursive: true });
        return { workspaceDir: input.workspaceDir, units: [
          { id: 'message:1', source: 'A neutral greeting.', kind: 'message', context: { file: 'Map001.json', event: 1, page: 1 } },
        ] };
      }
      if (command === 'roundtrip') return { ok: true };
      throw new Error(`Unexpected worker command: ${command}`);
    },
    provider: async input => { requests.push(input); return { records: [] }; },
  });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const settings = defaultSettings();
  settings.connection.model = 'neutral-credential-check';
  settings.connection.apiKey = 'fixture-old-key';
  await service.saveSettings(settings);
  const project = await service.createProject({ gameDir, name: 'Neutral credential check' });
  assert.equal(project.status, 'ready');
  const { units: [unit] } = await service.listText({ projectId: project.id });
  await service.saveText({ projectId: project.id, unitId: unit.id, translation: '中性问候。', expectedRevision: unit.revision });
  return { service, dataDir, projectId: project.id, requests, settings };
}

for (const mode of ['translation', 'proofreading', 'repair']) {
  test(`${mode} credential preflight preserves accepted text and project state when decryption fails`, async t => {
    const { service, dataDir, projectId, requests } = await fixture(t);
    const before = storedState(dataDir);
    await assert.rejects(service.startProject({ projectId, mode }), /Saved credential decryption failed/);
    assert.deepEqual(storedState(dataDir), before);
    assert.equal(requests.length, 0);
    assert.equal((await service.getProject({ projectId })).status, 'ready');
  });
}

test('saving a replacement credential restores the connection and retains translations and revisions', async t => {
  const { service, dataDir, projectId, requests, settings } = await fixture(t);
  await assert.rejects(service.startProject({ projectId, mode: 'proofreading' }), /Saved credential decryption failed/);
  const before = storedState(dataDir);
  settings.connection.apiKey = 'fixture-new-key';
  await service.saveSettings(settings);
  const result = await service.testConnection();
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].connection.apiKey, 'fixture-new-key');
  const after = storedState(dataDir);
  for (const table of ['projects', 'units', 'revisions', 'tasks']) assert.deepEqual(after[table], before[table]);
  assert.notDeepEqual(after.settings, before.settings);
  assert.equal(after.units[0].translation, '中性问候。');
});
