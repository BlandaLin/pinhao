import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createService } from './service.mjs';
import { productWorker } from '../../apps/desktop/electron/host.mjs';
import { createStore } from './workspace-store.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function fixture(t, installation) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-assist-capability-'));
  const game = path.join(directory, 'neutral-game'), dataDir = path.join(directory, 'data');
  const put = async (name, content) => {
    const file = path.join(game, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  };
  await put('Game.exe', 'Neutral fixture; never executed');
  await put('js/rpg_core.js', 'neutral core');
  await put('js/plugins.js', 'var $plugins = [];');
  await put('data/System.json', { gameTitle: 'Neutral capability', switches: [''], variables: [''] });
  await put('data/Actors.json', [null]);
  await put('data/CommonEvents.json', [null]);
  await put('data/MapInfos.json', [null, { id: 1, name: 'Neutral map' }]);
  await put('data/Map001.json', { width: 10, height: 10, displayName: 'Neutral map', events: [null] });
  let installations = 0;
  const worker = productWorker({ pythonPath: process.env.PINHAO_PYTHON || path.join(root, 'local/runtime/python/python.exe'),
    workerPath: path.join(root, 'adapters/python/worker.py'), toolkitPath: path.join(root, 'kits/workbench-tutorial/toolkit'),
    assistInstaller: async () => { installations++; return installation; } });
  let service = await createService({ dataDir, worker });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); });
  const project = await service.createProject({ gameDir: game });
  assert.equal(project.status, 'ready', project.lastError);
  assert.equal(project.assistance.supported, true);
  assert.deepEqual(project.assistance.modes, ['live']);
  return { project, service: () => service, installations: () => installations, async reopen() {
    await service.close(); service = await createService({ dataDir, worker }); return service;
  }, async legacyBuild(build, { detected = true } = {}) {
    await service.close();
    const store = createStore(dataDir);
    try {
      store.put('builds', { ...build, assistance: { ...build.assistance, supported: false, modes: [] } }, project.id);
      if (!detected) {
        const saved = store.one('projects', project.id);
        store.patchProject(project.id, { inventory: { ...saved.inventory, capabilities: { ...saved.inventory.capabilities, assist: false, assistModes: [] } } });
      }
    } finally { store.close(); }
    service = await createService({ dataDir, worker }); return service;
  }, legacySupported() {
    const store = createStore(dataDir);
    try { return store.all('builds', project.id).at(-1).assistance.supported; }
    finally { store.close(); }
  } };
}

for (const status of ['disabled', 'install_failed']) {
  test(`${status} is installation state, not loss of the detected live capability`, async t => {
    const f = await fixture(t, { supported: false, status, restored: true, detail: 'neutral restored installation failure' });
    if (status === 'disabled') await f.service().setAssistEnabled({ projectId: f.project.id, enabled: false });
    const build = await f.service().buildProject({ projectId: f.project.id });
    assert.equal(f.installations(), status === 'disabled' ? 0 : 1);
    assert.equal(build.assistance.status, status);
    const reopened = await f.reopen();
    const full = await reopened.getProject({ projectId: f.project.id });
    const summary = await reopened.getProject({ projectId: f.project.id, summaryOnly: true });
    assert.deepEqual({
      build: { supported: build.assistance.supported, modes: build.assistance.modes },
      full: { supported: full.assistance.supported, modes: full.assistance.modes, status: full.assistance.status },
      summary: { supported: summary.assistance.supported, modes: summary.assistance.modes, status: summary.assistance.status },
    }, {
      build: { supported: true, modes: ['live'] },
      full: { supported: true, modes: ['live'], status },
      summary: { supported: true, modes: ['live'], status },
    });
    const legacy = await f.legacyBuild(build);
    for (const summaryOnly of [false, true]) {
      const detail = await legacy.getProject({ projectId: f.project.id, summaryOnly });
      assert.equal(detail.assistance.supported, true);
      assert.deepEqual(detail.assistance.modes, ['live']);
      assert.equal(detail.builds.at(-1).assistance.supported, true);
    }
    assert.equal(f.legacySupported(), false, 'historical record is projected, not rewritten');
    const negative = await f.legacyBuild(build, { detected: false });
    assert.equal((await negative.getProject({ projectId: f.project.id })).assistance.supported, false, 'a known negative project is never upgraded by installation status');
  });
}

test('a genuinely unsupported installation is not promoted to live support by the engine catalog', async t => {
  const f = await fixture(t, { supported: false, status: 'unsupported', detail: 'neutral nonstandard entry' });
  const build = await f.service().buildProject({ projectId: f.project.id });
  const detail = await f.service().getProject({ projectId: f.project.id });
  assert.deepEqual({ supported: build.assistance.supported, modes: build.assistance.modes }, { supported: false, modes: [] });
  assert.equal(detail.assistance.supported, false);
  assert.equal(detail.assistance.status, 'unsupported');
});
