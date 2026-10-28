import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { AssistState, DesktopApi, ProjectDetail } from '../../../../../packages/contracts/index';

const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(check: () => unknown) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { if (check()) return; await wait(); }
  throw new Error('Assist controls fixture timed out');
}
let current: AssistState;
let detail: ProjectDetail;
const selectedHash = 'a'.repeat(64), backupId = 'b'.repeat(64), restoredHash = 'c'.repeat(64);
let commands: Record<string, unknown>[] = [], restored: Record<string, unknown>[] = [], configured: Record<string, unknown>[] = [];
const errors: unknown[] = [];
window.pinhao = {
  assistSnapshot: async () => current,
  assistCommand: async input => {
    commands.push(input);
    if (input.action === 'setVariable') current = { ...current, variables: current.variables?.map(row => row.id === input.id ? { ...row, value: input.value } : row) };
    return current;
  },
  configureAssist: async input => { configured.push(input); detail = { ...detail, assistEnabled: input.enabled }; return detail; },
  listAssistSaveBackups: async () => ({ saveFile: current.saveFile!, backups: [{ id: backupId, sha256: 'd'.repeat(64), createdAt: '2026-10-25T00:00:00Z', bytes: 120 }] }),
  restoreAssistSave: async input => { restored.push(input); current = { ...current, gold: 4, saveFile: { ...current.saveFile!, sha256: restoredHash } }; return current; },
} as DesktopApi;
const { default: Assist } = await import('../../../src/Assist');
const container = document.createElement('div');
document.body.append(container);
let root: Root | undefined;
function button(text: string, scope: ParentNode = document) {
  const result = [...scope.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
  assert(result, 'Missing button: ' + text); return result;
}
function dialog() { return document.querySelector<HTMLDialogElement>('dialog[open]'); }
function inputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
async function mount(mode: 'live' | 'save', options: { enabled?: boolean; detail?: string } = {}) {
  if (root) flushSync(() => root!.unmount());
  commands = []; restored = []; configured = []; errors.length = 0;
  detail = { id: 'assist-fixture', name: 'Fixture', engine: mode === 'save' ? '2000' : 'mv', builds: [], assistEnabled: options.enabled !== false,
    assistance: { supported: true, modes: [mode] } } as unknown as ProjectDetail;
  current = { connected: true, ready: true, engine: mode === 'save' ? '2000' : 'MV', mode, detail: options.detail,
    actions: ['setVariable', 'setSwitch', 'setHp', 'setGold'],
    switches: [{ id: 42, name: '开关 #42', value: false }],
    variables: [{ id: 73, name: '变量 #73', value: 6 }], gold: 10,
    actors: [{ id: 1, name: 'Hero', hp: 35, maxHp: 100, level: 1 }],
    ...(mode === 'save' ? { saveFile: { path: 'fixture/Save01.lsd', sha256: selectedHash, backupDir: 'fixture/backups' }, editLimits: { hp: { min: 0, max: 9999, integer: true } } } : {}),
  } as AssistState;
  root = createRoot(container);
  flushSync(() => root!.render(<Assist project={detail} onError={error => errors.push(error)} />));
  await until(() => options.enabled === false ? document.body.textContent?.includes('实时辅助已关闭，仍可正常游玩') : document.querySelector('[aria-label="搜索游戏数据"]'));
}

export async function runAssistControlsChecks() {
  const cases: [string, () => Promise<void>][] = [
    ['disabled live assistance does not promise an automatic connection or repeat stale connection instructions', async () => {
      await mount('live', { enabled: false, detail: '点击启动后自动连接旧状态' });
      const text = document.body.textContent || '';
      assert(text.includes('当前不会连接或显示游戏状态') && text.includes('开启实时辅助'), 'The disabled state must explain how to resume assistance');
      assert(!text.includes('点击启动后自动连接旧状态') && !text.includes('这里会自动显示当前游戏状态'), 'The disabled state must override stale or enabled-only instructions');
      assert(configured.length === 0 && commands.length === 0, 'Rendering the disabled state must not silently enable or edit the game');
    }],
    ['unnamed real ID can be searched and edited without an AI gate', async () => {
      await mount('live');
      document.querySelector<HTMLButtonElement>('#assist-tab-variables')!.click(); await wait();
      inputValue(document.querySelector<HTMLInputElement>('[aria-label="搜索游戏数据"]')!, '73');
      await until(() => document.querySelector('.assist-data-row strong')?.textContent === '变量 #73');
      button('修改', document.querySelector('.assist-data-row')!).click(); await until(dialog);
      const input = dialog()!.querySelector<HTMLInputElement>('input')!;
      inputValue(input, '27'); await wait(); button('确认修改', dialog()!).click();
      await until(() => commands.length === 1 && !dialog());
      assert(commands[0].action === 'setVariable' && commands[0].id === 73 && commands[0].value === 27, 'Manual command must retain the actual ID and value');
      assert(!('approval' in commands[0]) && !errors.length, 'Manual editing must not introduce an AI approval');
    }],
    ['save restore confirms current file hash and clears a stale draft', async () => {
      await mount('save');
      inputValue(document.querySelector<HTMLInputElement>('[aria-label="新的游戏金钱"]')!, '99'); await wait();
      button('恢复存档备份').click(); await until(dialog);
      assert(restored.length === 0, 'Opening the backup dialog must not restore immediately');
      assert(dialog()!.textContent?.includes('当前进度会先另存为备份'), 'Restore must describe the pre-restore backup');
      button('确认恢复', dialog()!).click();
      await until(() => restored.length === 1 && !dialog());
      assert(restored[0].backupId === backupId && restored[0].expectedSaveSha256 === selectedHash, 'Restore must submit the selected backup and current CAS hash');
      assert(document.querySelector<HTMLInputElement>('[aria-label="新的游戏金钱"]')!.value === '4', 'A pre-restore money draft must not survive restoring the save');
      assert(document.body.textContent?.includes('备份已恢复') && !errors.length, 'Restore result must be visible');
    }],
    ['LCF editable HP range is independent of the displayed role maximum', async () => {
      await mount('save');
      document.querySelector<HTMLButtonElement>('[aria-label="修改Hero的HP"]')!.click(); await until(dialog);
      const input = dialog()!.querySelector<HTMLInputElement>('input')!;
      assert(input.max === '9999', 'LCF stored HP limit must be 9999, not maxHp 100');
      inputValue(input, '777'); await wait(); button('确认修改', dialog()!).click();
      await until(() => commands.length === 1 && !dialog());
      assert(commands[0].action === 'setHp' && commands[0].value === 777 && commands[0].expectedSaveSha256 === selectedHash, 'HP edit above display max must retain the storage limit and CAS');
      assert(!errors.length, 'HP edit should be accepted');
    }],
    ['live switch calls configuration and says closing does not undo progress', async () => {
      await mount('live');
      button('关闭实时辅助').click();
      await until(() => configured.length === 1 && document.body.textContent?.includes('实时辅助已关闭，仍可正常游玩'));
      assert(configured[0].enabled === false && configured[0].projectId === detail.id, 'Close must configure the selected project');
      assert(document.body.textContent?.includes('已经修改的游戏进度和存档不会撤销'), 'Closing must not imply undoing progress');
      button('开启实时辅助').click();
      await until(() => configured.length === 2 && document.body.textContent?.includes('实时辅助已开启。重新启动成品后连接。'));
      assert(configured[1].enabled === true && !errors.length, 'Reopen must be explicit and leave no mock error');
    }],
  ];
  const results = [];
  for (const [name, run] of cases) {
    console.log('assist case start: ' + name);
    try { await run(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: String(error) }); }
    console.log('assist case result: ' + JSON.stringify(results[results.length - 1]));
  }
  if (root) flushSync(() => root!.unmount());
  return results;
}
(window as unknown as { runAssistControlsChecks: typeof runAssistControlsChecks }).runAssistControlsChecks = runAssistControlsChecks;
