import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { createAssistBridge } = await import(process.env.PINHAO_ASSIST_TEST_MODULE
  ? pathToFileURL(process.env.PINHAO_ASSIST_TEST_MODULE).href : './assist.mjs');

test('old ordinary drafts cannot acquire the newly observed save identity', async t => {
  const bridge = createAssistBridge();
  t.after(() => bridge.close());
  const environment = await bridge.environment('draft-switch');
  const url = `http://127.0.0.1:${environment.PINHAO_ASSIST_PORT}/state?token=${environment.PINHAO_ASSIST_TOKEN}`;
  const post = async payload => (await fetch(url, { method: 'POST', body: JSON.stringify(payload) })).json();
  await post({ state: { ready: true, gameSessionId: 'save-A' } });
  const captured = bridge.snapshot('draft-switch').gameSessionId;
  await post({ state: { ready: true, gameSessionId: 'save-B' } });
  for (const input of [
    { action: 'setGold', value: 20 }, { action: 'setItem', type: 'item', id: 1, value: 2 },
    { action: 'setSwitch', id: 1, value: true }, { action: 'setVariable', id: 1, value: 2 },
    ...['setLevel', 'setExp', 'setHp', 'setMp'].map(action => ({ action, id: 1, value: 20 })),
    { action: 'transfer', params: { mapId: 1, x: 1, y: 1 } },
  ]) {
    assert.throws(() => bridge.command({ projectId: 'draft-switch', ...input }), /当前存档/);
    assert.throws(() => bridge.command({ projectId: 'draft-switch', ...input,
      params: { ...input.params, gameSessionId: captured } }), /当前存档/);
  }
  assert.deepEqual((await post({ state: { ready: true, gameSessionId: 'save-B' } })).commands, []);
  const pending = bridge.command({ projectId: 'draft-switch', action: 'setGold', value: 30, params: { gameSessionId: 'save-B' } });
  const { commands } = await post({ state: { ready: true, gameSessionId: 'save-B' } });
  assert.equal(commands[0].params.gameSessionId, 'save-B');
  await post({ state: { ready: true, gameSessionId: 'save-B' }, results: [{ id: commands[0].id }] });
  await pending;
});
