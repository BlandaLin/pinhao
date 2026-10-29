import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const views = {};
const previousWindow = globalThis.window;
globalThis.window = { pinhao: {} };
try {
  for (const language of ['zh', 'en']) {
    const result = await build({ entryPoints: [fileURLToPath(new URL('../../src/status.tsx', import.meta.url))],
      bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
      define: { __PINHAO_UI_LANGUAGE__: JSON.stringify(language) },
      external: ['react', 'react/jsx-runtime', 'react-dom', 'lucide-react'] });
    const module = { exports: {} };
    new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
    views[language] = module.exports;
  }
} finally {
  globalThis.window = previousWindow;
}

const idle = {
  total: 12, counted: 12, done: 2, remaining: 10, percent: 16.7,
  throughput: null, etaMs: null, etaAt: null, confidence: 'none',
  phases: { pending: 10, translated: 2, proofread: 0, skipped: 0 },
  blockers: [], paused: false, finished: false, phaseLabel: '文字处理中',
  runtime: { active: 0, limit: 3, queued: 0, running: 0 },
};

for (const language of ['zh', 'en']) {
  const render = progress => renderToStaticMarkup(createElement(views[language].ProgressPanel, { progress }));
  test(`${language}: idle progress keeps its counts without claiming active work or estimating an ETA`, () => {
    const html = render(idle);
    assert.match(html, /2 \/ 12/);
    assert.match(html, /16\.7%/);
    assert.doesNotMatch(html, /估算|文字处理中|Estimating|remaining time/i);
  });
  test(`${language}: a review with no returned results describes saving behavior rather than saved results`, () => {
    const html = render({ ...idle, runtime: { active: 1, limit: 3, queued: 0, running: 1 },
      review: { stage: 'scene', total: 12, reviewed: 0, skipped: 0 } });
    assert.match(html, /0 \/ 12/);
    assert.match(html, language === 'zh' ? /审阅结果自动保存/ : /Reviews are saved automatically/);
    assert.doesNotMatch(html, /审阅已保存|Reviews saved;/);
  });
  test(`${language}: saved proofreading does not promise a build while paused`, () => {
    const html = render({ ...idle, paused: true, done: 12, remaining: 0,
      review: { stage: 'committed', total: 12, reviewed: 12, skipped: 0 } });
    assert.match(html, language === 'zh' ? /校对结果已保存/ : /Proofreading results saved/);
    assert.doesNotMatch(html, /准备生成成品|Preparing the build/);
  });
}
