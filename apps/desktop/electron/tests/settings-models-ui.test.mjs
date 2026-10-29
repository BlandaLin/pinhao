import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const file = new URL('../../src/settings.tsx', import.meta.url);
const source = await readFile(file, 'utf8');
const previousWindow = globalThis.window;
globalThis.window = { pinhao: {} };
const output = await build({ stdin: { contents: `${source}\nexport { clearKeys };`, loader: 'tsx',
  resolveDir: fileURLToPath(new URL('.', file)), sourcefile: 'settings.tsx' }, bundle: true, write: false,
  format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-dom', 'lucide-react'] });
const loaded = { exports: {} };
try {
  new Function('require', 'module', 'exports', output.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
} finally {
  globalThis.window = previousWindow;
}
const view = loaded.exports;
const settings = {
  connection: { baseUrl: 'https://shared.invalid/v1', model: 'shared', apiKey: 'shared-secret' },
  roles: Object.fromEntries(['technical', 'translation', 'proofreading'].map(role => [role, {
    useShared: false, connection: { baseUrl: `https://${role}.invalid/v1`, model: `${role}-model`, apiKey: `${role}-secret` },
  }])),
  concurrency: 3, pauseOnLocalFailure: false, processImages: false, proofreading: true,
  targetLanguage: 'zh-Hans', fontPath: '',
};

test('settings expose technical and shared text model choices without a separate proofreading connection', () => {
  const html = renderToStaticMarkup(createElement(view.default, {
    settings, fonts: [], busy: '', onSave() {}, onTest() {}, onError() {},
  }));
  assert.match(html, /技术模型/);
  assert.match(html, /文字模型（翻译与校对）/);
  assert.match(html, /翻译与校对共用文字模型/);
  assert.match(html, /翻译后进行校对/);
  assert.match(html, /technical\.invalid/);
  assert.match(html, /translation\.invalid/);
  assert.doesNotMatch(html, /校对模型|proofreading\.invalid|proofreading-model|三类任务/);
  assert.doesNotMatch(html, /shared-secret|technical-secret|translation-secret|proofreading-secret/);
  assert.doesNotMatch(source, /testRole\("proofreading"\)/);
});

test('draft scrubbing includes hidden stored roles without discarding their existing settings', () => {
  const draft = view.clearKeys(settings);
  assert.equal(draft.connection.apiKey, '');
  assert.deepEqual(Object.keys(draft.roles), ['technical', 'translation', 'proofreading']);
  for (const role of Object.keys(settings.roles)) {
    assert.equal(draft.roles[role].connection.apiKey, '');
    assert.equal(draft.roles[role].connection.baseUrl, settings.roles[role].connection.baseUrl);
    assert.equal(draft.roles[role].connection.model, settings.roles[role].connection.model);
    assert.equal(draft.roles[role].useShared, settings.roles[role].useShared);
    assert.equal(settings.roles[role].connection.apiKey, `${role}-secret`);
  }
  assert.equal(settings.connection.apiKey, 'shared-secret');
});

test('model capacity controls preserve independent shared and role values without exposing secrets', () => {
  const configured = structuredClone(settings);
  configured.connection.contextWindow = 131072; configured.connection.maxOutputTokens = 8192;
  configured.roles.technical.connection.contextWindow = 65536; configured.roles.technical.connection.maxOutputTokens = 4096;
  const draft = view.clearKeys(configured);
  assert.equal(draft.connection.contextWindow, 131072); assert.equal(draft.connection.maxOutputTokens, 8192);
  assert.equal(draft.roles.technical.connection.contextWindow, 65536); assert.equal(draft.roles.technical.connection.maxOutputTokens, 4096);
  const html = renderToStaticMarkup(createElement(view.default, { settings: configured, fonts: [], busy: '', onSave() {}, onTest() {}, onError() {} }));
  assert.match(html, /共享连接上下文容量[^>]*value="131072"/);
  assert.match(html, /共享连接最大回复长度[^>]*value="8192"/);
  assert.match(html, /技术模型上下文容量[^>]*value="65536"/);
  assert.match(html, /技术模型最大回复长度[^>]*value="4096"/);
  assert.match(html, /单次回复的上限，按模型支持的输出容量填写/);
  assert.match(html, /留空默认：上下文 32,768 tokens，单次回复 4,096 tokens/);
  assert.match(html, /修改时填写服务商给出的容量/);
  assert.doesNotMatch(html, /这两项只用于技术 Agent/);
});
