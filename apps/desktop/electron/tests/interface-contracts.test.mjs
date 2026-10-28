import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { commandErrorRecord, restoreCommandError } from '../../../../packages/contracts/command-errors.js';
import { primaryProjectAction, requestProjectWork, technicalNeeds } from '../../src/technical-action.ts';

const project = adaptation => ({ id: 'interface-project', status: 'paused', adaptationPending: true, adaptation });

test('the UI extraction action invokes retryAdaptation rather than ordinary production', async () => {
  const calls = [];
  const api = { retryAdaptation: async input => calls.push(['retryAdaptation', input]), startProject: async input => calls.push(['startProject', input]) };
  const pending = project({ status: 'needs-review', retryable: true });
  assert.equal(primaryProjectAction(pending), 'retry-adaptation');
  await requestProjectWork(api, pending);
  assert.deepEqual(calls, [['retryAdaptation', { projectId: pending.id }]]);
  await requestProjectWork(api, { ...pending, adaptationPending: false });
  assert.equal(calls[1][0], 'startProject');
  const source = await readFile(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  assert.match(source, /requestProjectWork\(api, project\)/);
  assert.match(source, /api\.continueAvailableText\(\{ projectId: project\.id \}\)/);
});

test('a host format blocker is not a prompt to switch models or to rerun paid investigation', () => {
  const blocked = project({ blocked: true, retryable: false, stopReasonCode: 'HOST_VERIFICATION_BLOCKED' });
  assert.equal(primaryProjectAction(blocked), 'blocked');
  assert.equal(primaryProjectAction({ ...blocked, adaptation: { ...blocked.adaptation, retryContextChanged: true } }), 'retry-adaptation');
  assert.equal(primaryProjectAction(project({ blocked: true, stopReasonCode: 'MODEL_CAPACITY_REQUIRED' })), 'settings');
});

test('requirements from a non-first job remain visible and aggregate duplicates do not create a second row', () => {
  const need = { requirementRef: 'requirement-two', kind: 'FORMAT_UNSUPPORTED', nextActions: ['补齐资源验证能力'] };
  const p = project({ jobs: [{ id: 'first', status: 'verified' }, { id: 'second', status: 'needs-review', files: ['archive.pck'], candidateId: 'candidate-two', validationId: 'validation-two', blockedNeeds: [need] }], blockedNeeds: [need] });
  const rows = technicalNeeds(p);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].jobId, 'second'); assert.equal(rows[0].candidateId, 'candidate-two');
  assert.equal(rows[0].validationId, 'validation-two'); assert.equal(rows[0].need.requirementRef, need.requirementRef);
});

test('controlled error envelopes preserve recovery facts without arbitrary error internals', () => {
  const error = Object.assign(new Error('Please wait'), { code: 'RATE_LIMITED', category: 'rate_limit', statusCode: 429, retryAfterMs: 2200,
    candidateId: 'candidate-one', validationId: 'validation-one', blockedNeeds: [{ requirementRef: 'requirement-one', kind: 'FORMAT_UNSUPPORTED', missingEvidence: { locatorType: 'archive-member', secret: 'not-for-renderer' } }],
    stack: 'private stack', request: { headers: { authorization: 'private' } }, apiKey: 'private' });
  const envelope = JSON.parse(JSON.stringify(commandErrorRecord(error)));
  const restored = restoreCommandError(envelope);
  assert.equal(restored.message, 'Please wait'); assert.equal(restored.code, 'RATE_LIMITED');
  assert.equal(restored.statusCode, 429); assert.equal(restored.category, 'rate_limit'); assert.equal(restored.retryAfterMs, 2200);
  assert.equal(restored.candidateId, 'candidate-one'); assert.equal(restored.validationId, 'validation-one');
  assert.deepEqual(envelope.blockedNeeds[0].missingEvidence, { locatorType: 'archive-member' });
  assert.equal(envelope.stack, undefined); assert.equal(envelope.request, undefined); assert.equal(envelope.apiKey, undefined);
  assert.doesNotMatch(commandErrorRecord(new Error('api_key=neutral-private-value')).message, /neutral-private-value/);
});

test('the actual preload API reconstructs structured command failures', async () => {
  const exposed = new Map();
  const error = { message: 'Too many requests', code: 'RATE_LIMITED', category: 'rate_limit', statusCode: 429, retryAfterMs: 5000 };
  const output = await build({ entryPoints: [fileURLToPath(new URL('../preload.mjs', import.meta.url))], bundle: true, write: false,
    format: 'cjs', platform: 'node', external: ['electron'] });
  const electron = { contextBridge: { exposeInMainWorld: (name, value) => exposed.set(name, value) },
    ipcRenderer: { invoke: async () => ({ ok: false, error: commandErrorRecord(error) }), on() {}, removeListener() {} }, webUtils: { getPathForFile: () => 'neutral.exe' } };
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', output.outputFiles[0].text)(name => { assert.equal(name, 'electron'); return electron; }, loaded, loaded.exports);
  await assert.rejects(exposed.get('pinhao').retryAdaptation({ projectId: 'interface-project' }), e =>
    e.code === 'RATE_LIMITED' && e.statusCode === 429 && e.category === 'rate_limit' && e.retryAfterMs === 5000);
});

test('the browser API fallback preserves the same structured command failure', async () => {
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch;
  globalThis.window = {};
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: commandErrorRecord({
    message: 'Please wait', code: 'RATE_LIMITED', category: 'rate_limit', statusCode: 429, retryAfterMs: 3200,
  }) }), { status: 400, headers: { 'content-type': 'application/json' } });
  try {
    const browser = await import('../../src/api.ts?browser-interface-contract');
    await assert.rejects(browser.api.retryAdaptation({ projectId: 'interface-project' }), error =>
      error.code === 'RATE_LIMITED' && error.statusCode === 429 && error.category === 'rate_limit' && error.retryAfterMs === 3200);
  } finally { globalThis.window = previousWindow; globalThis.fetch = previousFetch; }
});

test('actual overview components show candidate and non-first-job blocker identities honestly', async () => {
  const previous = globalThis.window; globalThis.window = { pinhao: {} };
  let view;
  try {
    const output = await build({ entryPoints: [fileURLToPath(new URL('../../src/App.tsx', import.meta.url))], bundle: true, write: false,
      format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-dom', 'lucide-react'] });
    const loaded = { exports: {} };
    new Function('require', 'module', 'exports', output.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
    view = loaded.exports;
  } finally { globalThis.window = previous; }
  const p = project({ jobs: [{ id: 'first', status: 'verified' }, { id: 'second', status: 'needs-review', resource: 'archive.pck', candidateId: 'candidate-two', validationId: 'validation-two', blockedNeeds: [{ requirementRef: 'requirement-two', kind: 'FORMAT_UNSUPPORTED' }] }] });
  const html = renderToStaticMarkup(createElement(view.TechnicalBlockers, { project: p }));
  assert.match(html, /archive\.pck/); assert.match(html, /candidate-two/); assert.match(html, /validation-two/); assert.match(html, /requirement-two/);
  const outcomes = renderToStaticMarkup(createElement(view.AdaptationOutcome, { adaptation: { status: 'needs-review', addedUnits: 0, remainingCandidates: 4000 }, coverage: { truncated: true } }));
  assert.match(outcomes, /待甄别候选 4,000 项/); assert.match(outcomes, /扫描尚未完整/); assert.match(outcomes, /不代表已加入文字工作台/);
  assert.doesNotMatch(outcomes, /待确认文字.*条/);
});
