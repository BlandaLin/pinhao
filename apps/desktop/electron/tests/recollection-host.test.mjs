import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecollectionHost } from '../recollection-host.mjs';

function fixture() {
  const events = [];
  const capture = { recipeId: 'recipe', gameSessionId: 'session', entries: [] };
  const backup = { id: 'backup', capture, status: 'applied' };
  let failure = false;
  const host = createRecollectionHost({
    gameSessions: { current: () => ({ buildId: 'build' }) },
    service: {
      getProjectContext: async () => ({}), getRecollection: async () => ({ scan: { maps: [{ id: 1, width: 10, height: 8 }] } }),
      prepareRecollection: async () => ({ recipeId: 'recipe', operations: [] }),
      captureRecollection: async () => { events.push('persist'); return backup; },
      updateRecollectionBackup: async input => { events.push(input.status); return { ...backup, status: input.status }; },
      getRecollectionBackup: async () => backup,
    },
    assist: { snapshot: () => ({ connected: true, gameSessionId: 'session' }), command: async input => {
      events.push(input.action);
      if (input.action === 'applyRecollection' && failure) throw new Error('game changed');
      return { connected: true, gameSessionId: 'session', recollectionBackup: capture };
    } },
  });
  return { host, events, backup, fail: () => { failure = true; } };
}

test('host persists the captured backup before applying any gallery operation', async () => {
  const f = fixture();
  await f.host.apply({ projectId: 'p', recipeIds: ['one'], gameSessionId: 'session' });
  assert.deepEqual(f.events, ['captureRecollection', 'persist', 'applyRecollection', 'applied']);
  await f.host.restore({ projectId: 'p', backupId: 'backup' });
  assert.deepEqual(f.events.slice(-2), ['restoreRecollection', 'restored']);
});

test('host retains failed applications and requires recipes rather than arbitrary renderer operations', async () => {
  const f = fixture();
  f.fail();
  await assert.rejects(f.host.apply({ projectId: 'p', recipeIds: ['one'], gameSessionId: 'session' }), /game changed/);
  assert.equal(f.events.at(-1), 'failed');
  await assert.rejects(f.host.command({ projectId: 'p', action: 'applyRecollection' }), /已确认方案/);
  await assert.rejects(f.host.command({ projectId: 'p', action: 'captureRecollection' }), /已确认方案/);
  await assert.rejects(f.host.command({ projectId: 'p', action: 'transfer', params: { mapId: 1, x: 10, y: 2 } }), /范围/);
  await f.host.command({ projectId: 'p', action: 'transfer', params: { mapId: 1, x: 9, y: 7, direction: 2 } });
  assert.equal(f.events.at(-1), 'transfer');
});

test('host rejects an old confirmation before capturing or writing the new game session', async () => {
  const f = fixture();
  await assert.rejects(f.host.apply({ projectId: 'p', recipeIds: ['one'], gameSessionId: 'old-session' }), /进度已变化/);
  await assert.rejects(f.host.apply({ projectId: 'p', recipeIds: ['one'] }), /进度已变化/);
  assert.deepEqual(f.events, []);
});

test('host prevents repeat restoration and cross-game-session writes', async () => {
  const f = fixture();
  f.backup.capture.gameSessionId = 'other-session';
  await assert.rejects(f.host.restore({ projectId: 'p', backupId: 'backup' }), /读档.*旧记录无法恢复当前游玩/);
  assert.deepEqual(f.events, []);
  f.backup.capture.gameSessionId = 'session';
  f.backup.status = 'restored';
  await assert.rejects(f.host.restore({ projectId: 'p', backupId: 'backup' }), /已经恢复/);
});
