import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useState } from 'react';
import type { DesktopApi, Settings } from '../../../../../packages/contracts/index';

window.pinhao = {} as DesktopApi;
const { default: SettingsPage } = await import('../../../src/Settings');
const { errorMessage } = await import('../../../src/api');
const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(check: () => unknown) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (check()) return; await wait(); }
  throw new Error('Settings feedback fixture timed out');
}
const connection = { baseUrl: 'http://127.0.0.1:1/v1', model: 'neutral-initial' };
const initial: Settings = { connection, roles: { technical: { useShared: true, connection }, translation: { useShared: true, connection }, proofreading: { useShared: true, connection } },
  concurrency: 3, targetLanguage: 'zh-Hans', fontPath: '', proofreading: true, processImages: false, pauseOnLocalFailure: false };
const container = document.createElement('div'); document.body.append(container);
let root: Root | undefined, submitted: Settings | undefined, finish: ((value: Settings | undefined) => void) | undefined;
let saveMode: 'deferred' | 'failed' = 'deferred';
function Screen() {
  const [busy, setBusy] = useState('');
  return <SettingsPage settings={initial} fonts={[]} busy={busy} onError={() => {}}
    onTest={async () => ({ ok: false, message: 'User not found.', statusCode: 401, category: 'authentication' })}
    onSave={async draft => {
      submitted = structuredClone(draft); setBusy('settings');
      const result = saveMode === 'failed' ? undefined : await new Promise<Settings | undefined>(resolve => { finish = resolve; });
      setBusy(''); return result;
    }} />;
}
async function mount(mode: typeof saveMode = 'deferred') {
  if (root) flushSync(() => root!.unmount());
  saveMode = mode; submitted = undefined; finish = undefined;
  root = createRoot(container); flushSync(() => root!.render(<Screen />)); await wait();
}
function input(label = '共享连接模型名称') {
  const value = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
  assert(value, 'Missing input: ' + label); return value;
}
function change(value: string, label?: string) {
  const element = input(label);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}
function reasoning(label = '共享连接模型推理') {
  const value = document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`);
  assert(value, 'Missing reasoning selector: ' + label); return value;
}
function changeReasoning(value: string, label?: string) {
  const element = reasoning(label);
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('change', { bubbles: true }));
}
function sharedToggle(roleName: string) {
  const card = [...document.querySelectorAll('.role-card')].find(item => item.querySelector('h3')?.textContent === roleName);
  const value = card?.querySelector<HTMLInputElement>('input[role="switch"]');
  assert(value, 'Missing shared connection toggle: ' + roleName); return value;
}
function button(text: string) {
  const value = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
  assert(value, 'Missing button: ' + text); return value;
}

export async function runSettingsFeedbackChecks() {
  const cases: [string, () => Promise<void>][] = [
    ['settings describe post-translation review and the cost of testing a connection', async () => {
      await mount();
      const text = document.body.textContent || '';
      assert(text.includes('初翻完成后') && text.includes('文字模型校对译文、人物称呼和译名') && text.includes('翻译与校对共用文字模型'), 'The displayed preference must describe the actual initial-translation and shared-model review order');
      assert(text.includes('连接测试会发送一条简短的模型请求') && text.includes('费用按服务商规则计算'), 'The cost of a connection test must be visible before invoking it');
    }],
    ['reasoning defaults to the recommended model setting without redundant helper text', async () => {
      await mount();
      assert(reasoning().value === 'auto', 'An existing connection without a reasoning preference must follow the model default');
      assert(reasoning().selectedOptions[0].textContent === '跟随模型默认（推荐）', 'The default choice must be clearly recommended');
      assert(!reasoning().parentElement?.querySelector('small'), 'The reasoning setting should not carry redundant helper paragraphs');
      assert(button('保存设置').disabled, 'Showing the default must not change existing settings');
    }],
    ['reasoning mode is saved and retained after a successful save', async () => {
      await mount(); changeReasoning('disabled'); await wait();
      assert(!button('保存设置').disabled, 'Changing reasoning must make settings saveable');
      button('保存设置').click(); await until(() => finish);
      assert(submitted?.connection.reasoning === 'disabled', 'The selected mode must be included in the submitted connection');
      finish!(submitted); await wait();
      assert(reasoning().value === 'disabled' && button('保存设置').disabled, 'The saved mode must remain visible and clear the dirty marker');
    }],
    ['shared and independent role reasoning preferences do not overwrite each other', async () => {
      await mount(); changeReasoning('disabled'); await wait();
      assert(!document.querySelector('[aria-label="技术模型模型推理"]'), 'A shared role must not show an independent preference instead of inheriting the shared connection');
      sharedToggle('技术模型').click(); await wait();
      assert(reasoning('技术模型模型推理').value === 'auto', 'Changing the shared preference must not overwrite the independent technical connection');
      changeReasoning('enabled', '技术模型模型推理'); await wait();
      sharedToggle('文字模型（翻译与校对）').click(); await wait();
      assert(reasoning('文字模型（翻译与校对）模型推理').value === 'auto', 'The independent text connection must retain its own default');
      changeReasoning('disabled', '文字模型（翻译与校对）模型推理'); await wait();
      sharedToggle('技术模型').click(); await wait(); sharedToggle('技术模型').click(); await wait();
      assert(reasoning().value === 'disabled' && reasoning('技术模型模型推理').value === 'enabled', 'Switching shared usage must preserve the independent role preference');
      button('保存设置').click(); await until(() => finish);
      assert(submitted?.connection.reasoning === 'disabled' && submitted.roles.technical.connection.reasoning === 'enabled' && submitted.roles.translation.connection.reasoning === 'disabled', 'Each connection must save its own reasoning preference');
      finish!(submitted); await wait();
    }],
    ['saving settings preserves a newer edit made before its response', async () => {
      await mount(); change('first-save'); await wait(); button('保存设置').click(); await until(() => finish);
      assert(!input().disabled, 'The form permits continued editing while saving');
      change('newer-unsaved-edit'); await wait(); finish!(submitted); await wait();
      assert(input().value === 'newer-unsaved-edit', 'A stale save result must not replace the newer draft');
      assert(!button('保存设置').disabled, 'The newer draft must remain dirty and saveable');
      assert(submitted?.connection.model === 'first-save', 'The pending request must retain the originally submitted draft');
    }],
    ['a completed unchanged save clears key input and the dirty marker', async () => {
      await mount(); change('new-model'); change('neutral-key-value', '共享连接API密钥'); await wait();
      button('保存设置').click(); await until(() => finish);
      finish!({ ...submitted!, connection: { ...submitted!.connection, apiKey: undefined, hasKey: true } }); await wait();
      assert(input().value === 'new-model' && input('共享连接API密钥').value === '', 'A successful unchanged save must adopt public settings without retaining the input key');
      assert(button('保存设置').disabled, 'An unchanged successful save must clear dirty');
    }],
    ['a failed settings save keeps the edited draft available', async () => {
      await mount('failed'); change('keep-after-failure'); await wait(); button('保存设置').click(); await wait();
      assert(input().value === 'keep-after-failure' && !button('保存设置').disabled, 'A failed save must not clear the user draft');
    }],
    ['connection test UI consumes structured authentication metadata', async () => {
      await mount(); button('测试已保存连接').click(); await until(() => document.querySelector('.test-error'));
      const text = document.querySelector('.test-error')!.textContent || '';
      assert(text.includes('密钥') && text !== 'User not found.', 'The actual settings error view must use the complete test result, not only its message');
    }],
    ['provider reservation capacity explains waiting rather than exhausted credit', async () => {
      const text = errorMessage({ message: 'Temporary reservation limit.', statusCode: 402, category: 'provider_capacity' });
      assert(text.includes('处理容量已满') && text.includes('等待') && text.includes('请求结束'), 'A structured provider-capacity failure must explain waiting for in-flight requests');
      assert(!text.includes('余额'), 'An in-flight request budget must not be presented as insufficient account credit');
    }],
    ['error formatting uses status and category while retaining message-only diagnostics', async () => {
      assert(errorMessage({ message: 'User not found.', statusCode: 401 }).includes('密钥'), 'HTTP401 must not depend on the provider English sentence');
      assert(errorMessage({ message: 'Denied.', statusCode: 403 }).includes('权限'), 'HTTP403 must explain access permission');
      assert(errorMessage({ message: 'Unknown plan.', statusCode: 402 }).includes('额度'), 'HTTP402 must explain service quota');
      const rate = errorMessage({ message: 'Slow.', category: 'rate_limit', retryAfterMs: 2500 });
      assert(rate.includes('3') && rate.includes('秒'), 'A structured retry delay must be rounded up for user guidance');
      assert(errorMessage({ message: 'Slow.', category: 'timeout' }).includes('超时'), 'Timeout classification must be actionable without matching prose');
      assert(errorMessage(new Error('fetch failed')).includes('连接模型服务失败'), 'Existing message-only network fallback must stay intact');
      assert(errorMessage('neutral local detail') === 'neutral local detail', 'Unknown local diagnostic text must remain available');
    }],
  ];
  const results = [];
  for (const [name, run] of cases) {
    try { await run(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: String(error) }); }
  }
  if (root) flushSync(() => root!.unmount());
  return results;
}
(window as unknown as { runSettingsFeedbackChecks: typeof runSettingsFeedbackChecks }).runSettingsFeedbackChecks = runSettingsFeedbackChecks;
