import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createLiveAssist } from '../live-assist.mjs';
import { createGameSessions } from '../host.mjs';
import { createService } from '../../../../packages/core/service.mjs';
import { sessionFileName } from '../../../../packages/runtime/session-file.mjs';

async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-live-assist-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  return root;
}

async function fixture(t, engine = 'RPG Maker VX Ace') {
  const root = await directory(t), events = [];
  const older = { id: 'older', path: path.join(root, 'older') };
  const latest = { id: 'latest', path: path.join(root, 'latest') };
  await mkdir(older.path); await mkdir(latest.path);
  const project = { id: 'project', engine, assistEnabled: true, builds: [older, latest] };
  const service = {
    getProjectContext: async () => structuredClone(project),
    async setAssistEnabled(input) { events.push(['persist', input]); project.assistEnabled = input.enabled; return structuredClone(project); },
  };
  const gameSessions = createGameSessions();
  const worker = async (command, input) => { events.push([command, input]); return { removed: true, restored: true }; };
  const assist = { disconnect: id => events.push(['disconnect', id]), snapshot: () => ({ connected: true, gold: 7 }) };
  const live = createLiveAssist({ service, worker, assist, gameSessions,
    install: async (output, options) => { events.push(['install', output]); assert.equal(options.worker, worker); return { supported: true }; } });
  return { root, project, latest, older, events, gameSessions, service, worker, assist, live };
}

test('launch installation accepts only verified restored failures and exposes unavailable assistance', async () => {
  const project = { id: 'p', assistEnabled: true };
  const make = result => createLiveAssist({ service: { getProjectContext: async () => project }, assist: { snapshot: () => ({ connected: false }) },
    install: async () => result });
  await assert.rejects(make({ supported: false, status: 'install_failed' }).install(project, { path: 'unused' }), { code: 'ASSIST_INSTALL_RECOVERY_REQUIRED' });
  const live = make({ supported: false, status: 'install_failed', restored: true, detail: '已恢复，辅助不可用' });
  await live.install(project, { path: 'unused' });
  assert.deepEqual(await live.snapshot({ projectId: 'p' }), { connected: false, detail: '已恢复，辅助不可用' });
});

test('live preference survives real service/store reopen and remains in project context', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-live-store-'));
  const gameDir = path.join(root, 'original'), dataDir = path.join(root, 'data');
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'original.txt'), 'neutral original');
  const worker = async (command, input) => {
    if (command === 'catalog') return { engines: [{ id: 'xp', name: 'RPG Maker XP', assist: true, assistModes: ['live'] }] };
    if (command === 'probe') return { engine: 'XP', capabilities: { extract: true, nativeBuild: true, assist: true, assistModes: ['live'] } };
    if (command === 'extract') {
      await mkdir(input.workspaceDir, { recursive: true });
      return { workspaceDir: input.workspaceDir, sourceFingerprint: 'neutral-native-baseline',
        units: [{ id: 'actor-1', source: 'Neutral hero', translation: '中性角色', kind: 'database_name', context: { file: 'Data/Actors.rxdata' } }] };
    }
    if (command === 'roundtrip') return { ok: true };
    throw new Error('Unexpected fixture worker command: ' + command);
  };
  let service = await createService({ dataDir, worker, scriptTools: null });
  t.after(async () => { try { if (service) await service.close(); } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); } });
  const project = await service.createProject({ gameDir });
  assert.equal((await service.getProjectContext({ projectId: project.id })).assistEnabled, true);
  const host = () => createLiveAssist({ service, worker, gameSessions: createGameSessions(), assist: { disconnect() {}, snapshot: () => ({ connected: true }) } });
  await host().configure({ projectId: project.id, enabled: false });
  await service.close();
  service = await createService({ dataDir, worker, scriptTools: null });
  assert.equal((await service.getProjectContext({ projectId: project.id })).assistEnabled, false);
  assert.equal((await service.getProject({ projectId: project.id })).assistEnabled, false);
  assert.equal((await host().snapshot({ projectId: project.id })).connected, false);
  await assert.rejects(host().requireEnabled({ projectId: project.id }), /已关闭/);
  await host().configure({ projectId: project.id, enabled: true });
  await service.close();
  service = await createService({ dataDir, worker, scriptTools: null });
  assert.equal((await service.getProjectContext({ projectId: project.id })).assistEnabled, true);
  assert.equal((await service.getProject({ projectId: project.id })).assistEnabled, true);
  await host().requireEnabled({ projectId: project.id });
  assert.equal(await readFile(path.join(gameDir, 'original.txt'), 'utf8'), 'neutral original');
});

test('live configuration cannot remove or change assistance while its game is running', async t => {
  const f = await fixture(t), child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  await f.gameSessions.launch('project', async () => ({ child, buildId: f.latest.id }));
  await assert.rejects(f.live.configure({ projectId: 'project', enabled: false }), /关闭/);
  await assert.rejects(f.live.configure({ projectId: 'project', enabled: true }), /关闭/);
  assert.deepEqual(f.events, []);
  assert.equal(f.project.assistEnabled, true);
  child.emit('exit', 0);
});

test('RGSS disable restores only the host-selected latest build and enable defers installation', async t => {
  const f = await fixture(t);
  const disabled = await f.live.configure({ projectId: 'project', enabled: false, buildId: 'older', outputDir: f.older.path });
  assert.equal(disabled.assistEnabled, false);
  assert.deepEqual(f.events, [['assistUninstall', { outputDir: f.latest.path }],
    ['persist', { projectId: 'project', enabled: false }], ['disconnect', 'project']]);
  f.events.length = 0;
  await f.live.configure({ projectId: 'project', enabled: true });
  assert.deepEqual(f.events, [['persist', { projectId: 'project', enabled: true }], ['disconnect', 'project']]);
  await f.live.install(f.project, f.latest);
  assert.deepEqual(f.events.at(-1), ['install', f.latest.path]);
});

test('an RGSS uninstall conflict does not persist a disabled preference or disconnect the bridge', async t => {
  const f = await fixture(t);
  const live = createLiveAssist({ ...f, worker: async (command, input) => {
    assert.equal(command, 'assistUninstall'); assert.equal(input.outputDir, f.latest.path);
    throw new Error('ASSIST_INSTALL_CONFLICT: preserve existing scripts');
  } });
  await assert.rejects(live.configure({ projectId: 'project', enabled: false }), /ASSIST_INSTALL_CONFLICT/);
  assert.equal(f.project.assistEnabled, true);
  assert.deepEqual(f.events, []);
});

test('non-RGSS disable never calls the RGSS removal worker', async t => {
  for (const engine of ['MV', 'Unity', 'Godot']) {
    const f = await fixture(t, engine);
    await f.live.configure({ projectId: 'project', enabled: false });
    assert.deepEqual(f.events, [['persist', { projectId: 'project', enabled: false }], ['disconnect', 'project']]);
  }
});

test('disabled launch skips installation and removes only an owned session schema', async t => {
  const f = await fixture(t);
  f.project.assistEnabled = false;
  await mkdir(path.join(f.latest.path, 'www'));
  await writeFile(path.join(f.latest.path, 'www/index.html'), 'neutral entry');
  const files = [path.join(f.latest.path, sessionFileName), path.join(f.latest.path, 'www', sessionFileName)];
  for (const file of files) await writeFile(file, JSON.stringify({ schema: 'pinhao-assist-session-v1', token: 'neutral-session-token' }));
  assert.deepEqual(await f.live.install(f.project, f.latest), { supported: false, status: 'disabled', detail: '实时辅助已关闭，未安装辅助插件' });
  for (const file of files) await assert.rejects(access(file), { code: 'ENOENT' });
  assert.deepEqual(f.events, []);
  for (const content of [JSON.stringify({ schema: 'another-app' }), '{invalid-json']) {
    await writeFile(files[0], content);
    await assert.rejects(f.live.install(f.project, f.latest), /会话文件/);
    assert.equal(await readFile(files[0], 'utf8'), content);
    assert.deepEqual(f.events, []);
  }
});
