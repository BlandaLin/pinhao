import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { serviceMethods } from '../host.mjs';

const report = { summary: { total: 1, translated: 1, untranslated: 0, skipped: 0, completeness: 100, verdict: 'complete' },
  blockers: [], sections: [], glossaryUsage: { entries: 1, missing: [{ source: 'Innkeeper', translation: '旅店老板', category: 'person' }] },
  latestBuild: { id: 'build', runtimeVerified: false, outputModified: false } };
const previousWindow = globalThis.window;
globalThis.window = { pinhao: { completionReport: async () => ({ report, text: '中性检查清单' }) } };
const output = await build({ entryPoints: [fileURLToPath(new URL('../../src/status.tsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'lucide-react'] });
const loaded = { exports: {} };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
const view = loaded.exports;
globalThis.window = previousWindow;

test('translation coverage remains 100 percent without claiming the review round has finished', () => {
  const progress = view.readProgress({ runtime: { active: 1, limit: 3, queued: 25, running: 1 }, progress: {
    total: 20, counted: 20, done: 20, remaining: 0, percent: 100, confidence: 'none', phases: {}, blockers: [],
    paused: false, finished: false, phaseLabel: '正在校对场景',
  } });
  const html = renderToStaticMarkup(createElement(view.ProgressPanel, { progress }));
  assert.match(html, /已有译文/); assert.match(html, /100\.0%/); assert.match(html, /正在校对场景/);
  assert.match(html, /队列 25/); assert.doesNotMatch(html, /全部完成|本轮制作完成/);
  assert.match(html, /只统计已提取文字/);
});

test('technical acceptance, integration and lanes are visible without pretending the whole game is finished', () => {
  const html = renderToStaticMarkup(createElement(view.TechnicalPublicationStatus, { project: { status: 'running', adaptationPending: true,
    publication: { generation: 2, accepted: 3, integrated: 1, pendingIntegration: 2, materialReady: true },
    lanes: { adaptation: { status: 'running' }, text: { status: 'queued' } } } }));
  assert.match(html, /已保存技术成果 3 批/); assert.match(html, /已接入工作台 1 批/); assert.match(html, /等待接入 2 批/);
  assert.match(html, /资源检查：进行中/); assert.match(html, /文字制作：排队中/);
  assert.match(html, /不是新增文字数/); assert.match(html, /尚未接入的成果不会提前用于翻译/);
  assert.doesNotMatch(html, /全部完成|游戏已完成/);
  const absent = renderToStaticMarkup(createElement(view.TechnicalPublicationStatus, { project: { status: 'ready', publication: { generation: 0 } } }));
  assert.doesNotMatch(absent, /0 批/);
});

test('the ETA names initial translation rather than promising a finished game', () => {
  const progress = view.readProgress({ progress: {
    total: 40, counted: 40, done: 20, remaining: 20, percent: 50, confidence: 'low',
    etaMs: 120000, etaAt: null, phases: {}, blockers: [], paused: false, finished: false,
    phaseLabel: '正在翻译',
  } });
  const html = renderToStaticMarkup(createElement(view.ProgressPanel, { progress }));
  assert.match(html, /初翻预计剩余约 2 分钟/);
  assert.doesNotMatch(html, /分钟后完成/);
});

const reviewProject = (stage, progress, paused = false) => ({
  reviewRound: { id: 'round-progress', stage, total: 20, candidates: 3, progress,
    ...(stage === 'committed' ? { committedAt: '2026-10-25T12:00:00Z' } : {}) },
  runtime: { active: paused ? 0 : 2, limit: 5, queued: 15, running: paused ? 0 : 2 },
  progress: { total: 20, counted: 20, done: 20, remaining: 0, percent: 100, confidence: 'none',
    phases: {}, blockers: [], paused, finished: false, phaseLabel: '正在校对场景' },
});

test('review progress counts saved stage text rather than initial translations or candidate task count', () => {
  const progress = view.readProgress(reviewProject('scene', { total: 20, reviewed: 6, skipped: 2 }));
  const html = renderToStaticMarkup(createElement(view.ProgressPanel, { progress }));
  assert.match(html, /场景校对/); assert.match(html, /已审阅 6 \/ 20 条/);
  assert.match(html, /30\.0%/); assert.match(html, /aria-valuenow="30"/);
  assert.match(html, /初翻已完成/); assert.match(html, /本阶段跳过 2 条/);
  assert.match(html, /队列 15/);
  assert.doesNotMatch(html, /100\.0%|3 \/ 20|本轮制作完成|初翻预计/);
});

test('paused review keeps its saved percentage and consistency has its own text scope', () => {
  const html = renderToStaticMarkup(createElement(view.ProgressPanel, {
    progress: view.readProgress(reviewProject('consistency', { total: 8, reviewed: 4, skipped: 0 }, true)),
  }));
  assert.match(html, /译名与疑点复核/); assert.match(html, /已审阅 4 \/ 8 条/);
  assert.match(html, /50\.0%/); assert.match(html, /已暂停/);
  assert.doesNotMatch(html, /本轮制作完成|初翻已暂停/);
});

test('the workbench can open saved scene results without changing the review stage or offering a suggestion system', () => {
  const progress = view.readProgress(reviewProject('scene', { total: 20, reviewed: 6, skipped: 0 }));
  const html = renderToStaticMarkup(createElement(view.ProgressPanel, { progress, onViewSceneReview() {} }));
  assert.match(html, /查看场景审阅结果/);
  assert.match(html, /场景校对中/);
  assert.match(html, /收尾检查完成后统一更新当前译文/);
  assert.doesNotMatch(html, /修改建议|接受建议|拒绝建议/);
  const completed = renderToStaticMarkup(createElement(view.ProgressPanel, {
    progress: view.readProgress(reviewProject('committed', undefined)), onViewSceneReview() {},
  }));
  assert.doesNotMatch(completed, /查看场景审阅结果/);
});

test('review conflict scope, commit and completion stay separate from whole-production completion', () => {
  const resolution = renderToStaticMarkup(createElement(view.ProgressPanel, {
    progress: view.readProgress(reviewProject('resolve', { total: 4, reviewed: 1, skipped: 0 })),
  }));
  assert.match(resolution, /修改分歧核对/); assert.match(resolution, /25\.0%/);
  for (const [stage, label] of [['commit', '保存校对结果'], ['committed', '校对已完成']]) {
    const html = renderToStaticMarkup(createElement(view.ProgressPanel, {
      progress: view.readProgress(reviewProject(stage, { total: 20, reviewed: 20, skipped: 0 })),
    }));
    assert.match(html, new RegExp(label));
    assert.doesNotMatch(html, /本轮制作完成|100\.0%|aria-valuenow/);
  }
});

test('a review stage without its text projection never borrows the initial-translation 100 percent', () => {
  const html = renderToStaticMarkup(createElement(view.ProgressPanel, {
    progress: view.readProgress(reviewProject('scene', undefined)),
  }));
  assert.match(html, /场景校对/); assert.match(html, /正在读取校对进度/);
  assert.doesNotMatch(html, /100\.0%|已审阅 0 \/|aria-valuenow/);
});

test('a translation-only committed round does not claim proofreading was completed', () => {
  const project = reviewProject('committed', undefined);
  delete project.reviewRound.committedAt;
  const html = renderToStaticMarkup(createElement(view.ProgressPanel, { progress: view.readProgress(project) }));
  assert.match(html, /已有译文 20 \/ 20/);
  assert.doesNotMatch(html, /校对已完成|校对结果已保存/);
});

test('name checks describe locally collected translation results, not an entry requirement', () => {
  const project = { translated: 7, proofread: 0, glossaryProgress: { total: 8, completed: 5, conflicts: 3 } };
  const html = renderToStaticMarkup(createElement(view.NameCheckSummary, { project }));
  assert.match(html, /译名检查：8 项，3 项待校对/);
  assert.doesNotMatch(html, /progressbar|5\s*\/\s*8|等待|整理|才能|未完成/);
  assert.equal(renderToStaticMarkup(createElement(view.NameCheckSummary, {
    project: { ...project, translated: 0 },
  })), '');
  assert.equal(renderToStaticMarkup(createElement(view.NameCheckSummary, {
    project: { translated: 0, proofread: 1 },
  })), '');
});

test('completed name checks stay a result count alongside the existing text actions', async () => {
  const html = renderToStaticMarkup(createElement(view.NameCheckSummary, {
    project: { translated: 0, proofread: 12, glossaryProgress: { total: 4, completed: 4, conflicts: 0 } },
  }));
  assert.match(html, /译名检查：4 项，0 项待校对/);
  const app = await readFile(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /<h2>分阶段制作<\/h2>[^]*?<NameCheckSummary project=\{project\} \/>[^]*?翻译待处理文字/);
  assert.doesNotMatch(app, /人名与术语整理：|glossaryProgress!\.completed|整理共享专名与术语/);
});

test('resource coverage hides obsolete pending counts after verified text is accepted', async () => {
  const coverage = { unitCount: 2100, summary: { extracted: 607, 'display-text-candidate': 44, nativeReviewObjects: 1115 } };
  const stale = renderToStaticMarkup(createElement(view.ResourceCoverageSummary, {
    coverage: { ...coverage, stale: true, addedUnitsSinceScan: 84 },
  }));
  assert.match(stale, /已接入 84 条文字；剩余文件待重新核对/);
  assert.match(stale, /可继续翻译和生成汉化版/);
  assert.doesNotMatch(stale, /607|44|1115|1,115|待检查原生组件/);
  const fresh = renderToStaticMarkup(createElement(view.ResourceCoverageSummary, { coverage }));
  assert.match(fresh, /待检查文字的文件 44 个/);
  assert.match(fresh, /待检查原生组件 1,115 个/);
  assert.doesNotMatch(fresh, /待重新核对/);
  const noNewText = renderToStaticMarkup(createElement(view.ResourceCoverageSummary, { coverage: { ...coverage, stale: true, addedUnitsSinceScan: 0 } }));
  assert.match(noNewText, /已保存新的适配成果/);
  assert.doesNotMatch(noNewText, /已接入 0 条/);
  assert.equal(renderToStaticMarkup(createElement(view.ResourceCoverageSummary, {})), '');
  const app = await readFile(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /<ResourceCoverageSummary coverage=\{project.coverage\} \/>/);
  assert.match(app, /<CompletionCard[^\n]*needsAdaptation=\{project.coverage\?\.needsAdaptation \|\| project.coverage\?\.stale\}/);
});

test('completion data retains missing term objects and asks for runtime checks rather than promising publication', () => {
  const normalized = view.completionFrom({ completion: report });
  assert.equal(normalized.glossaryUsage.missing[0].translation, '旅店老板');
  const html = renderToStaticMarkup(createElement(view.CompletionCard, { projectId: 'project', completion: normalized, needsAdaptation: true }));
  assert.match(html, /旅店老板/); assert.match(html, /部分游戏资源仍需检查/); assert.match(html, /核对对话、字体、分支与存档/);
  assert.match(html, /已提取文字翻译覆盖 100\.0%/);
  assert.match(html, /不代表全游戏文字已找齐/);
  assert.doesNotMatch(html, /成品完整度 100/);
  assert.doesNotMatch(html, /可以发布|可发布/);
});

test('completionReport is available through both desktop IPC allowlists and the typed caller', async () => {
  assert.equal(serviceMethods.has('completionReport'), true);
  const preload = await readFile(new URL('../preload.mjs', import.meta.url), 'utf8');
  assert.match(preload.match(/const methods = \[([\s\S]*?)\];/)[1], /'completionReport'/);
  assert.equal((await view.requestCompletionReport({ projectId: 'project' })).text, '中性检查清单');
});
