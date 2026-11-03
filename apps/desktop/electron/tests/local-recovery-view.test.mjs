import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../../src/status.tsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'lucide-react'] });
const loaded = { exports: {} };
const previousWindow = globalThis.window;
globalThis.window = { pinhao: {} };
try {
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
} finally {
  globalThis.window = previousWindow;
}

test('local text failures remain visible as retry work without claiming the original replaces an existing translation', () => {
  const progress = loaded.exports.readProgress({ progress: {
    total: 20, counted: 19, done: 5, remaining: 14, percent: 26.3, confidence: 'none',
    phases: { skipped: 1 }, blockers: [], paused: false, finished: false, phaseLabel: '正在翻译',
  } });
  const html = renderToStaticMarkup(createElement(loaded.exports.ProgressPanel, { progress }));
  assert.match(html, /1 条待重试，保留当前文字/);
  assert.doesNotMatch(html, /成品中保留原文|全部完成|本轮制作完成/);
});
