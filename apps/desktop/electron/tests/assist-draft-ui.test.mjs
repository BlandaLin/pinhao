import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Exercise the real component handlers with deterministic hooks, without a game or DOM.
async function fixture({ baseline = false, saveMode = false, installationStatus, capabilitySupported = false, engine } = {}) {
  const values = [], refs = [], effects = [];
  let cursor = 0, refCursor = 0;
  const calls = [], errors = [];
  const api = {
    assistCommand: async input => { calls.push(input); return values[0]; },
    listAssistSaveBackups: async () => ({ backups: [{ id: 'b', status: 'available', filePath: 'neutral.sav', currentSha256: 'original-hash', targetAbsent: false }] }),
    restoreAssistSave: async input => { calls.push(input); return { connected: true, mode: 'save', backupCreated: true }; },
    configureAssist: async input => { calls.push(input); return { ...project, assistEnabled: input.enabled }; },
    launchGame: async input => { calls.push(input); },
  };
  const hooks = {
    useState(initial) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }]; },
    useRef(initial) { const index = refCursor++; return refs[index] ??= { current: initial }; },
    useEffect(effect, deps) { effects.push({ effect, deps }); },
  };
  const file = new URL('../../src/Assist.tsx', import.meta.url);
  const baselineFile = process.env.PINHAO_ASSIST_BEFORE;
  const source = await readFile(baseline && baselineFile ? baselineFile : file, 'utf8');
  const output = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('.', file)) },
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'lucide-react'] });
  const previous = globalThis.window;
  globalThis.window = { pinhao: api };
  const loaded = { exports: {} }, require = createRequire(import.meta.url);
  try { new Function('require', 'module', 'exports', output.outputFiles[0].text)(name => name === 'react' ? hooks : require(name), loaded, loaded.exports); }
  finally { globalThis.window = previous; }
  const project = { id: 'p', engine: 'MV', builds: [{ id: 'b' }], assistEnabled: installationStatus !== 'disabled',
    assistance: installationStatus ? { supported: capabilitySupported, modes: [], status: installationStatus } : { supported: true, modes: [saveMode ? 'save' : 'live'] } };
  const render = () => { cursor = 0; refCursor = 0; effects.length = 0; return loaded.exports.default({ project, engine, onError: error => errors.push(error) }); };
  render();
  values[0] = { connected: true, mode: saveMode ? 'save' : 'live', gameSessionId: 'A', gold: 10, actions: ['setGold', 'setItem'], items: [{ id: 1, name: 'neutral item', type: 'item', count: 2 }] };
  return { values, calls, errors, render, effects, project };
}

function nodes(root) {
  if (!root || typeof root !== 'object') return [];
  return [root, ...[root.props?.children].flat(Infinity).flatMap(nodes)];
}
const find = (tree, predicate) => nodes(tree).find(predicate);
const tick = () => new Promise(resolve => setImmediate(resolve));

test('gold draft submits the session from first edit, not a later snapshot', async () => {
  const f = await fixture({ baseline: Boolean(process.env.PINHAO_ASSIST_BEFORE) });
  let tree = f.render();
  find(tree, node => node.props?.['aria-label'] === '新的游戏金钱').props.onChange({ target: { value: '99' } });
  f.values[0] = { ...f.values[0], gameSessionId: 'B' };
  tree = f.render();
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await tick();
  assert.equal(f.calls[0].params.gameSessionId, 'A');
});

test('a disabled build retains the known live enable control', async () => {
  const f = await fixture({ baseline: Boolean(process.env.PINHAO_ASSIST_BEFORE), installationStatus: 'disabled', capabilitySupported: true, engine: { id: 'mv', assist: true, assistModes: ['live'] } });
  f.values[0] = { connected: false };
  const button = find(f.render(), node => node.props?.children === '开启实时辅助');
  assert.ok(button);
  button.props.onClick(); await tick();
  assert.deepEqual(f.calls[0], { projectId: 'p', enabled: true });
  assert.ok(find(f.render(), node => node.props?.children === '关闭实时辅助'));
});

test('a failed installation can retry and an actual connection bypasses the stale build result', async () => {
  const f = await fixture({ baseline: Boolean(process.env.PINHAO_ASSIST_BEFORE), installationStatus: 'install_failed', capabilitySupported: true, engine: { id: 'mv', assist: true, assistModes: ['live'] } });
  f.values[0] = { connected: false };
  const retry = find(f.render(), node => node.props?.children === '重新安装并连接');
  assert.ok(retry); retry.props.onClick(); await tick();
  assert.deepEqual(f.calls[0], { projectId: 'p' });
  f.project.assistance.supported = false;
  f.values[0] = { connected: true, ready: true, gold: 123, actions: ['setGold'], gameSessionId: 'new-session' };
  const tree = f.render();
  assert.ok(find(tree, node => node.props?.['aria-label'] === '新的游戏金钱'));
  assert.equal(find(tree, node => node.props?.children === '重新安装并连接'), undefined);
});

test('recovery preserves save-only modes and does not upgrade explicit unsupported games', async () => {
  const wolf = await fixture({ baseline: Boolean(process.env.PINHAO_ASSIST_BEFORE), installationStatus: 'disabled', capabilitySupported: true, engine: { id: 'wolf', assist: true, assistModes: ['save'] } });
  wolf.values[0] = { connected: false };
  const tree = wolf.render();
  assert.ok(find(tree, node => node.props?.children === '恢复存档备份'));
  assert.equal(find(tree, node => node.props?.children === '开启实时辅助'), undefined);
  const unsupported = await fixture({ installationStatus: 'unsupported', engine: { id: 'unity', assist: true, assistModes: ['live'] } });
  unsupported.values[0] = { connected: false };
  assert.equal(find(unsupported.render(), node => node.props?.children === '关闭实时辅助'), undefined);
  assert.equal(find(unsupported.render(), node => node.props?.children === '重新安装并连接'), undefined);
  const negative = await fixture({ installationStatus: 'disabled', capabilitySupported: false, engine: { id: 'unity', assist: true, assistModes: ['live'] } });
  negative.values[0] = { connected: false };
  assert.equal(find(negative.render(), node => node.props?.children === '开启实时辅助'), undefined);
});

test('ordinary item modal freezes its read session', async () => {
  const f = await fixture({ baseline: Boolean(process.env.PINHAO_ASSIST_BEFORE) });
  let tree = f.render();
  find(tree, node => node.props?.['aria-label']?.startsWith('修改物品')).props.onClick();
  f.values[0] = { ...f.values[0], gameSessionId: 'B' };
  tree = f.render();
  await find(tree, node => node.props?.target?.action === 'setItem').props.onSave(9);
  assert.equal(f.calls[0].params.gameSessionId, 'A');
});

test('backup center remains reachable without a selected or readable save', async () => {
  const f = await fixture({ saveMode: true, baseline: Boolean(process.env.PINHAO_ASSIST_BEFORE) });
  let tree = f.render();
  const list = find(tree, node => node.props?.children === '恢复存档备份');
  assert.ok(list);
  list.props.onClick(); await tick(); tree = f.render();
  const dialog = find(tree, node => node.props?.data?.backups);
  assert.ok(dialog);
  dialog.props.onRestore('b'); await tick();
  assert.deepEqual(f.calls[0], { projectId: 'p', backupId: 'b', expectedSaveSha256: 'original-hash' });
  assert.deepEqual(f.errors, []);
});
