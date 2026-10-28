import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, cp, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { sha256 } from '../exchange/index.mjs';
import { makeWorker } from '../../apps/desktop/electron/host.mjs';
import { createStore } from './workspace-store.mjs';
import { buildStoryContext } from '../exchange/story.mjs';
import { createReviewRound, reviewScopes, reviewScopeVersion } from './review-round.mjs';

const rootPath = path.resolve('local/core-tests');
await mkdir(rootPath, { recursive: true });
const secrets = { encrypt: value => `neutral:${value}`, decrypt: value => value.slice(8) };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(10); }
  throw new Error(message);
}
function rows(count, perScene = 1) {
  return Array.from({ length: count }, (_, index) => ({ id: `neutral:${index}`, source: `Neutral line ${index}.`,
    tokens: [], kind: 'dialogue', context: { file: 'neutral.json', event: Math.floor(index / perScene), page: 0 } }));
}
function fixtureWorker(units) {
  return async (command, args) => {
    if (command === 'probe') return { engine: 'MZ' };
    if (command === 'extract') { await mkdir(args.workspaceDir, { recursive: true }); return { units, workspaceDir: args.workspaceDir, sourceFingerprint: sha256(units) }; }
    if (command === 'roundtrip' || command === 'validate') return { ok: true };
    if (command === 'build') { await mkdir(args.outputDir, { recursive: true }); return { buildDir: args.outputDir }; }
    if (command === 'assemble') { await mkdir(args.outputDir, { recursive: true }); await writeFile(path.join(args.outputDir, 'Game.exe'), 'neutral fixture'); return { outputDir: args.outputDir, runtimeVerified: false }; }
    if (command === 'zip') { await cp(args.sourceDir, args.filePath, { recursive: true }); return { path: args.filePath }; }
    if (command === 'unzip') { await cp(args.filePath, args.outputDir, { recursive: true }); return { outputDir: args.outputDir }; }
    throw new Error(`Unexpected fixture worker command ${command}`);
  };
}
const review = (payload, edits = []) => ({ review: { protocol: 'pinhao-review-1', reviewedIds: payload.units.map(unit => unit.id),
  edits, issues: edits.map(edit => ({ unitId: edit.id, kind: 'correction', resolution: 'fixed', message: 'Neutral consistency correction.' })) } });
async function fixture(t, { units = rows(1), provider, concurrency = 3, configure = true, worker, strict = false, capacity = {} } = {}) {
  const root = await mkdtemp(path.join(rootPath, 'rounds-')), gameDir = path.join(root, 'original');
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'original.txt'), 'neutral immutable source');
  const service = await createService({ dataDir: path.join(root, 'data'), worker: worker ?? fixtureWorker(units), secrets,
    provider, technicalProvider: async () => ({ decision: 'native', summary: 'Neutral native route', selectedCandidateIds: [] }), scriptTools: null });
  const beforeCleanup = [];
  t.after(async () => { await service.close(); for (const cleanup of beforeCleanup) await cleanup(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }); });
  if (configure) { const settings = defaultSettings(); settings.concurrency = concurrency; settings.pauseOnLocalFailure = strict;
    settings.connection.model = 'neutral-fixture'; settings.connection.apiKey = 'neutral-key'; Object.assign(settings.connection, capacity); await service.saveSettings(settings); }
  return { service, root, gameDir, beforeCleanup };
}

test('scene result pages project saved receipts without writes or requests and retain a pinned round', async t => {
  let calls = 0;
  const f = await fixture(t, { units: rows(8, 8), provider: async () => { calls++; throw new Error('Browsing must not request a model'); } });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  assert.deepEqual((await f.service.listText({ projectId: project.id, filter: 'reviewed' })).sceneReview, { state: 'none', committed: false });
  await f.service.close();
  const dataDir = path.join(f.root, 'data'), prepared = createStore(dataDir);
  let frozen, round, roundFile;
  try {
    frozen = prepared.units(project.id).map((unit, position) => {
      const next = { ...unit, status: 'translated', translation: `初翻 ${position}`, notes: '' };
      prepared.putUnit(project.id, next, position); return next;
    });
    const original = prepared.one('projects', project.id);
    round = createReviewRound({ projectId: project.id, id: 'browse-round', units: frozen, targetIds: frozen.slice(0, 6).map(unit => unit.id),
      story: buildStoryContext(frozen), glossary: original.nameGlossary });
    const scope = reviewScopes(round, 'scene')[0];
    roundFile = path.join(original.workspaceDir, 'rounds', round.id, '0.json');
    await mkdir(path.dirname(roundFile), { recursive: true }); await writeFile(roundFile, JSON.stringify(round));
    prepared.patchProject(project.id, { status: 'paused', textRound: { id: round.id, path: roundFile, phase: 'scene', targetCount: 6 } });
    const task = { id: 'browse-scene', projectId: project.id, role: 'proofreading', kind: 'review-scene', fingerprint: 'browse-scene',
      reviewRoundId: round.id, reviewStage: 'scene', reviewScopeId: scope.id, reviewScopeVersion: reviewScopeVersion(round, scope, [], 'scene'),
      reviewReadIds: scope.readIds, unitIds: scope.unitIds, input: frozen.slice(0, 6), status: 'paused', reviewedUnitIds: frozen.slice(0, 2).map(unit => unit.id),
      candidateRecords: [
        { id: frozen[0].id, translation: frozen[0].translation, notes: ' unchanged note' },
        { id: frozen[1].id, translation: '已保存的修订', notes: '修订备注' },
        { id: frozen[2].id, translation: '未验证流式内容' },
        { id: frozen[6].id, translation: '只读参考不得加入' },
      ], reviewChangedIds: [frozen[1].id] };
    prepared.putTask(project.id, task);
    for (const [index, patch] of [{ reviewRoundId: 'old-round' }, { reviewScopeVersion: 'old-version' }, { status: 'skipped' }, { status: 'cancelled' }, { status: 'stale' }].entries()) {
      prepared.putTask(project.id, { ...task, ...patch, id: `excluded-${index}`, fingerprint: `excluded-${index}` });
    }
  } finally { prepared.close(); }
  const service = await createService({ dataDir, worker: fixtureWorker(rows(8, 8)), secrets,
    provider: async () => { calls++; throw new Error('Browsing must not request a model'); }, scriptTools: null });
  f.beforeCleanup.push(() => service.close());
  const inspect = createStore(dataDir);
  f.beforeCleanup.push(() => inspect.close());
  const snapshot = () => JSON.stringify(['projects', 'tasks', 'units', 'revisions'].map(table => inspect.all(table, project.id)));
  const before = snapshot(), baseline = await readFile(roundFile, 'utf8');
  const input = { projectId: project.id, filter: 'reviewed', reviewRoundId: round.id };
  const first = await service.listText({ ...input, limit: 1 });
  assert.equal(first.total, 2); assert.equal(first.units[0].id, frozen[0].id);
  assert.deepEqual(first.sceneReview, { roundId: round.id, state: 'saved', committed: false });
  const second = await service.listText({ ...input, offset: 1, limit: 1 });
  assert.equal(second.units[0].translation, '已保存的修订');
  assert.equal((await service.listText({ ...input, search: '修订备注' })).total, 1);
  assert.equal((await service.listText({ ...input, search: 'neutral LINE' })).total, 2);
  assert.equal((await service.listText({ ...input, search: frozen[1].id })).total, 1);
  assert.equal((await service.listText({ ...input, search: '未验证流式内容' })).total, 0);
  assert.equal((await service.listText({ ...input, offset: 999 })).units.length, 0);
  assert.equal((await service.listText({ projectId: project.id, search: '已保存的修订' })).total, 0, 'Formal text searches do not see staged text');
  assert.equal((await service.listText({ projectId: project.id, filter: 'proofread' })).total, 0);
  assert.equal(snapshot(), before, 'Browsing does not persist any projection');
  assert.equal(await readFile(roundFile, 'utf8'), baseline);
  for (const phase of ['consistency', 'resolve', 'commit']) {
    inspect.patchProject(project.id, { textRound: { ...inspect.one('projects', project.id).textRound, phase } });
    assert.equal((await service.listText(input)).total, 2, `The scene view does not switch or disappear during ${phase}`);
  }
  const manual = { ...frozen[0], translation: '人工修改', revision: frozen[0].revision + 1 };
  inspect.putUnit(project.id, manual, 0);
  const manualBefore = snapshot();
  assert.equal((await service.listText(input)).total, 0, 'Manual changes invalidate their dependent scene, even while paused');
  assert.equal(snapshot(), manualBefore, 'Freshness checking is ephemeral and leaves tasks and the round intact');
  const committedFile = path.join(path.dirname(roundFile), '1.json');
  await writeFile(committedFile, JSON.stringify({ ...round, revision: 1, stage: 'committed', committedAt: new Date().toISOString() }));
  inspect.patchProject(project.id, { textRound: { ...inspect.one('projects', project.id).textRound, path: committedFile, phase: 'committed' } });
  const archived = await service.listText(input);
  assert.equal(archived.total, 2); assert.equal(archived.sceneReview.committed, true);
  assert.equal(archived.units[0].translation, frozen[0].translation, 'The completed scene view remains a labelled archive, not current formal text');
  inspect.patchProject(project.id, { textRound: { id: 'new-round', path: committedFile, phase: 'scene' } });
  assert.deepEqual(await service.listText(input), { total: 0, units: [], sceneReview: { state: 'changed', committed: false } });
  const translationFile = path.join(path.dirname(roundFile), 'translation.json');
  await writeFile(translationFile, JSON.stringify({ id: 'translation-only', projectId: project.id, stage: 'committed', targetIds: [] }));
  inspect.patchProject(project.id, { textRound: { id: 'translation-only', path: translationFile, phase: 'committed' } });
  assert.deepEqual((await service.listText({ projectId: project.id, filter: 'reviewed' })).sceneReview, { state: 'none', committed: false });
  assert.equal(calls, 0);
});

test('identical source text does not authorize semantic reuse across dialogue and direction controls', async t => {
  const calls = [];
  const f = await fixture(t, { concurrency: 1, units: [
    { id: 'agreement', source: 'Right.', kind: 'message', tokens: [], context: { file: 'dialogue.json', event: 1, speaker: 'Teacher' } },
    { id: 'direction', source: 'Right.', kind: 'menu', tokens: [], context: { file: 'settings.json', event: 2 } },
  ], provider: async ({ role, wire }) => {
    const payload = wire.payload;
    if (role === 'proofreading') return review(payload);
    calls.push(...payload.units.map(unit => unit.kind));
    return { records: payload.units.map(unit => ({ id: unit.id, translation: unit.kind === 'menu' ? '右侧。' : '对。' })) };
  } });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  await f.service.startProject({ projectId: project.id, mode: 'translation' });
  await until(async () => (await f.service.getProject({ projectId: project.id })).status === 'completed', 'Context-specific translation did not finish');
  const { units } = await f.service.listText({ projectId: project.id });
  assert.equal(units.find(unit => unit.legacyId === 'direction').translation, '右侧。');
  assert.ok(calls.includes('message') && calls.includes('menu'));
});

test('valid scene reviews are not replaced by host-generated evidence queries', async t => {
  const sceneTargets = [];
  const f = await fixture(t, { units: rows(80, 80), provider: async ({ role, wire }) => {
    const payload = wire.payload;
    if (role === 'translation') return { records: payload.units.map(unit => ({ id: unit.id, translation: `已翻译 ${unit.source}` })) };
    assert.equal(payload.evidenceResults?.length ?? 0, 0, 'Only the Agent can request additional reading');
    if (payload.reviewScope.stage === 'scene') sceneTargets.push(...payload.units.map(unit => unit.id));
    return review(payload);
  } });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  await f.service.startProject({ projectId: project.id });
  await until(async () => (await f.service.getProject({ projectId: project.id })).status === 'completed', 'Valid review did not reach formal D2 commit');
  assert.equal(sceneTargets.length, 80);
  assert.equal(new Set(sceneTargets).size, 80);
});

test('changing the configured model reopens locally exhausted text without losing its history', async t => {
  let valid = false, calls = 0;
  const f = await fixture(t, { concurrency: 1, units: [{ id: 'protected', source: 'A line {{P1}}', tokens: ['{{P1}}'],
    kind: 'message', context: { file: 'dialogue.json', event: 1 } }], provider: async ({ role, wire }) => {
    const payload = wire.payload;
    if (role === 'proofreading') return review(payload);
    calls++;
    return { records: payload.units.map(unit => ({ id: unit.id, translation: valid ? '有效文字 {{P1}}' : '缺少受保护标记' })) };
  } });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  for (let cycle = 0; cycle < 3; cycle++) {
    await f.service.startProject({ projectId: project.id, mode: 'translation' });
    await until(async () => ['paused', 'completed'].includes((await f.service.getProject({ projectId: project.id })).status), 'Failure cycle did not settle');
  }
  const before = calls;
  const settings = (await f.service.snapshot()).settings;
  settings.connection.model = 'another-model';
  await f.service.saveSettings(settings);
  valid = true;
  await f.service.startProject({ projectId: project.id, mode: 'translation' });
  await until(async () => (await f.service.listText({ projectId: project.id })).units[0].status === 'translated', 'Model change did not reopen the text');
  assert.ok(calls > before);
  const stored = createStore(path.join(f.root, 'data'));
  try { assert.ok(stored.tasks(project.id).some(task => task.attempts >= 3)); } finally { stored.close(); }
});

test('an incomplete streamed review cannot be promoted to a saved review when its request fails', async t => {
  let reviewCalls = 0;
  const f = await fixture(t, { units: rows(3), provider: async ({ role, wire, onRecords }) => {
    const payload = wire.payload;
    if (role === 'translation') return { records: payload.units.map(unit => ({ id: unit.id, translation: `已翻译 ${unit.source}`, notes: '' })) };
    assert.equal(payload.reviewScope.stage, 'scene');
    if (++reviewCalls === 1) {
      onRecords(payload.units.map(unit => ({ id: unit.id, translation: '尚未完成整批审阅的流式文字', notes: '不可定稿' })));
      throw Object.assign(new Error('The streamed prefix did not finish the review protocol'), { code: 'INVALID_REVIEW' });
    }
    assert.ok(payload.units.every(unit => unit.currentTranslation.startsWith('已翻译')));
    return review(payload);
  } });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  await f.service.startProject({ projectId: project.id });
  await until(async () => { const current = await f.service.getProject({ projectId: project.id });
    if (current.status === 'paused') throw new Error(current.lastError);
    return current.status === 'completed'; }, 'The complete review was not retried');
  assert.equal(reviewCalls, 2, 'A raw prefix is not a validated review receipt');
  const final = (await f.service.listText({ projectId: project.id })).units;
  assert.ok(final.every(unit => unit.status === 'proofread' && unit.translation.startsWith('已翻译') && unit.notes === ''));
});

test('a failed later review page retains paid earlier pages and does not falsely stamp skipped drafts as reviewed', async t => {
  const reviewPages = [], units = rows(20, 20);
  for (const unit of units) unit.source += ' A complete neutral scene context.'.repeat(20);
  let badId;
  const f = await fixture(t, { units, concurrency: 1, provider: async ({ role, wire }) => {
    const payload = wire.payload;
    if (role === 'translation') return { records: payload.units.map(unit => ({ id: unit.id, translation: `初译 ${unit.source}`, notes: '' })) };
    assert.equal(payload.reviewScope.stage, 'scene');
    const bad = payload.units.find(unit => unit.source.startsWith('Neutral line 19.'));
    reviewPages.push(payload.units.map(unit => unit.id));
    if (bad) badId = bad.id;
    return review(payload, [{ id: bad?.id ?? payload.units[0].id, translation: bad ? '错误新增 {{invented}}' : '已验证的首屏校订' }]);
  } });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  await f.service.startProject({ projectId: project.id });
  const completed = await until(async () => {
    const current = await f.service.getProject({ projectId: project.id });
    if (current.status === 'paused') throw new Error(current.lastError ?? current.stage);
    return current.status === 'completed' && current;
  }, 'Review page exhaustion did not settle');
  const badPage = reviewPages.findIndex(ids => ids.includes(badId));
  assert.ok(badPage > 0, 'A capacity-limited page succeeds before the later failed page');
  assert.ok(reviewPages.slice(badPage + 1).length >= 1);
  assert.ok(reviewPages.slice(badPage + 1).every(ids => ids.length === 1 && ids[0] === badId), 'Independent good receipts from the failed page are not bought again');
  const final = (await f.service.listText({ projectId: project.id })).units;
  assert.equal(final.filter(unit => unit.status === 'proofread').length, 19);
  assert.equal(final.filter(unit => unit.status === 'skipped').length, 1);
  assert.equal(final[0].translation, '已验证的首屏校订');
  assert.ok(final.filter(unit => unit.status === 'skipped').every(unit => unit.id === badId && unit.translation.startsWith('初译 ') && unit.review === undefined));
  assert.match(completed.stage, /1 条待重试.*保留已有文字/);
  assert.equal(completed.builds.at(-1).checks.find(check => check.name === '校对证据').status, 'pending');
  const store = createStore(path.join(f.root, 'data'));
  try {
    const failed = store.tasks(project.id).find(task => task.reviewStage === 'scene' && task.status === 'skipped');
    assert.equal(failed.candidateRecords.length, 19);
    assert.equal(failed.reviewedUnitIds.length, 19);
    assert.ok(failed.candidateRecords.every(record => !record.translation.includes('{{invented}}')));
  } finally { store.close(); }
});

test('a skipped D2 target retains only its unchanged previous review instead of inventing this rounds proof', async t => {
  const provider = async ({ role, wire }) => {
    assert.equal(role, 'proofreading');
    return review(wire.payload, [{ id: wire.payload.units[0].id, translation: '错误新增 {{invented}}' }]);
  };
  const f = await fixture(t, { units: rows(2, 2), concurrency: 1, provider });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  await f.service.close();
  const prepared = createStore(path.join(f.root, 'data'));
  const previous = { roundId: 'previous-round', status: 'proofread', reviewedAt: '2026-01-01T00:00:00.000Z', sourceRevision: 0, issues: [] };
  try {
    for (const [index, unit] of prepared.units(project.id).entries()) prepared.putUnit(project.id,
      { ...unit, translation: `已有译文 ${index}`, status: 'translated', ...(index === 0 ? { review: previous } : {}) }, index);
  } finally { prepared.close(); }
  const service = await createService({ dataDir: path.join(f.root, 'data'), worker: fixtureWorker(rows(2, 2)), secrets, provider, scriptTools: null,
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral native route', selectedCandidateIds: [] }) });
  f.beforeCleanup.push(() => service.close());
  await service.startProject({ projectId: project.id, mode: 'proofreading' });
  await until(async () => {
    const current = await service.getProject({ projectId: project.id });
    if (current.reviewRound?.stage === 'committed') return true;
    if (current.status === 'paused') throw new Error(JSON.stringify({ stage: current.stage, error: current.lastError, round: current.reviewRound, tasks: current.tasks }));
    return false;
  }, 'Skipped D2 review did not settle', 10000);
  const final = (await service.listText({ projectId: project.id })).units;
  assert.deepEqual(final.map(unit => unit.status), ['skipped', 'proofread']);
  assert.deepEqual(final[0].review, previous);
  assert.equal(final[1].review.status, 'proofread');
  assert.notEqual(final[1].review.roundId, previous.roundId, 'An independent valid receipt belongs to this round');
  assert.deepEqual(final.map(unit => unit.translation), ['已有译文 0', '已有译文 1']);
});

for (const concurrency of [3, 20]) test(`whole translation round precedes review and fills concurrency ${concurrency}`, async t => {
  const count = concurrency * 16, finishedIds = new Set(), calls = [], active = { translation: 0, proofreading: 0 }, peak = { translation: 0, proofreading: 0 };
  const waves = Object.fromEntries(['translation', 'proofreading'].map(role => [role, { ...Promise.withResolvers(), entered: 0 }]));
  t.after(() => { for (const wave of Object.values(waves)) clearTimeout(wave.timer); });
  let earlyReview = false;
  const units = rows(count);
  for (const unit of units) unit.source += ' Complete neutral context.'.repeat(18);
  const f = await fixture(t, { units, concurrency, provider: async ({ role, wire }) => {
    const payload = wire.payload; calls.push({ role, payload }); active[role]++; peak[role] = Math.max(peak[role], active[role]);
    if (role === 'proofreading' && finishedIds.size < count) earlyReview = true;
    const wave = waves[role];
    if (++wave.entered === 1) wave.timer = setTimeout(() => wave.reject(new Error(`${role} did not fill ${concurrency} independent model lanes`)), 15000);
    if (wave.entered === concurrency) { clearTimeout(wave.timer); wave.resolve(); }
    await wave.promise;
    active[role]--;
    if (role === 'proofreading') return review(payload);
    payload.units.forEach(unit => finishedIds.add(unit.id));
    return { records: payload.units.map(unit => ({ id: unit.id, translation: `中性译文 ${unit.source}`, notes: '' })) };
  } });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  // The first-sample gate is tested separately; this case measures an already prepared round.
  const prepared = createStore(path.join(f.root, 'data'));
  try { prepared.put('projects', { ...prepared.one('projects', project.id), sampleValidation: { nativeStructure: 'passed' } }); }
  finally { prepared.close(); }
  await f.service.startProject({ projectId: project.id });
  const done = await until(async () => { const current = await f.service.getProject({ projectId: project.id });
    if (current.status === 'paused') throw new Error(`Unexpected pause: ${current.lastError}`);
    return current.status === 'completed' && current; }, 'The complete staged round did not finish');
  assert.equal(earlyReview, false); assert.equal(finishedIds.size, count); assert.equal(done.proofread, count);
  assert.equal(peak.translation, concurrency); assert.equal(peak.proofreading, concurrency);
  const reviews = calls.filter(call => call.role === 'proofreading');
  assert.ok(reviews.every(call => call.payload.reviewScope?.stage === 'scene'), 'A conflict-free round must not buy a second full review');
  assert.equal(reviews.flatMap(call => call.payload.units).length, count);
});

for (const policy of ['continue', 'strict', 'global-api-failure']) test(`translation barrier respects ${policy} failures before review`, async t => {
  let proofCalls = 0;
  const f = await fixture(t, { units: rows(48, 16), strict: policy === 'strict', provider: async ({ role, wire }) => {
    const payload = wire.payload;
    if (role === 'proofreading') { proofCalls++; return review(payload); }
    const failing = payload.units.some(unit => unit.source === 'Neutral line 16.');
    if (failing && policy === 'global-api-failure') throw Object.assign(new Error('Neutral API authentication failure'), { statusCode: 401 });
    return { records: payload.units.filter(unit => unit.source !== 'Neutral line 16.').map(unit => ({ id: unit.id, translation: `已翻译 ${unit.source}`, notes: '' })) };
  } });
  const project = await f.service.createProject({ gameDir: f.gameDir }); await f.service.startProject({ projectId: project.id });
  const terminal = await until(async () => { const current = await f.service.getProject({ projectId: project.id });
    return ['paused', 'completed'].includes(current.status) && current; }, 'Failure policy did not reach a terminal state');
  if (policy === 'continue') {
    assert.equal(terminal.status, 'completed'); assert.equal(terminal.skipped, 1); assert.equal(terminal.proofread, 47); assert.ok(proofCalls > 0);
  } else {
    assert.equal(terminal.status, 'paused'); assert.equal(proofCalls, 0);
    const accepted = (await f.service.listText({ projectId: project.id })).units.filter(unit => unit.status === 'translated');
    assert.ok(accepted.length >= 16, 'The completed native-sample batch stays saved');
  }
});

test('a 137-unit scene retains older page history with reading notes without consuming the failure-evidence allowance', async t => {
  const readPages = [], f = await fixture(t, { units: rows(137, 137), provider: async ({ role, wire }) => {
    const payload = wire.payload;
    if (role === 'translation') return { records: payload.units.map(unit => ({ id: unit.id, translation: `中性 ${unit.source}`, notes: '' })) };
    if (payload.reviewScope?.stage === 'scene') {
      const entry = payload.story.scopes.find(scope => scope.kind === 'scene');
      const replies = payload.evidenceResults?.filter(answer => answer.query?.story?.id === entry.id) ?? [];
      const offset = replies.length ? replies.at(-1).nextOffset : 0;
      if (offset >= 48) assert.ok(payload.evidenceHistory?.some(item => item.query?.story?.id === entry.id && item.readRanges?.some(([start]) => start === 0)), 'The actual next request retains the first page receipt after its text leaves the prompt');
      if (offset !== null && offset < entry.total) { readPages.push(offset); return { readingNotes: 'Neutral cumulative scene meaning, identities and evidence remain available through the reading receipts.',
        evidenceRequests: [{ query: { story: { kind: 'scene', id: entry.id }, offset, limit: 16 }, reason: 'Read complete neutral scene' }] }; }
    }
    return review(payload);
  } });
  const project = await f.service.createProject({ gameDir: f.gameDir }); await f.service.startProject({ projectId: project.id });
  const done = await until(async () => { const current = await f.service.getProject({ projectId: project.id });
    if (current.status === 'paused') throw new Error(`Unexpected pause: ${current.lastError}`);
    return current.status === 'completed' && current; }, 'Long-scene review did not finish');
  assert.equal(readPages[0], 0);
  const inspect = createStore(path.join(f.root, 'data'));
  try {
    const sceneTask = inspect.tasks(done.id).find(task => task.reviewStage === 'scene');
    assert.equal(sceneTask.evidenceRounds ?? 0, 0); assert.equal(sceneTask.readUnitIds.length, 137);
    const pages = sceneTask.storyReadingReceipts.filter(receipt => receipt.scopeKind === 'scene');
    assert.deepEqual(pages.map(receipt => receipt.offset), readPages);
    for (let index = 1; index < pages.length; index++) assert.equal(pages[index].offset, pages[index - 1].nextOffset);
    assert.equal(pages.at(-1).nextOffset, 137);
    assert.equal(new Set(pages.flatMap(receipt => receipt.unitIds)).size, 137);
  } finally { inspect.close(); }
});

for (const strict of [false, true]) test(`a stalled reading batch follows local failure policy with strict=${strict} without repeating the stalled request`, async t => {
  let failingCalls = 0, siblingFinished = false, enterSibling;
  const siblingEntered = new Promise(resolve => { enterSibling = resolve; });
  // Fit one neutral scene, not two, so the native sample and delayed sibling use distinct requests.
  const f = await fixture(t, { units: rows(48, 16), capacity: { maxOutputTokens: 1250 }, strict, provider: async ({ wire, signal }) => {
    const payload = wire.payload;
    if (payload.units.some(unit => unit.source === 'Neutral line 16.')) {
      failingCalls++; await siblingEntered;
      throw Object.assign(new Error('Neutral reading did not discover additional material'), { code: 'READ_NO_PROGRESS' });
    }
    if (payload.units.some(unit => unit.source === 'Neutral line 32.')) {
      enterSibling(); await sleep(60); signal.throwIfAborted(); siblingFinished = true;
    }
    return { records: payload.units.map(unit => ({ id: unit.id, translation: `已保存 ${unit.source}` })) };
  } });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  await f.service.startProject({ projectId: project.id, mode: 'translation' });
  const terminal = await until(async () => { const current = await f.service.getProject({ projectId: project.id });
    return ['paused', 'completed'].includes(current.status) && current; }, 'Reading failure policy did not settle');
  assert.equal(failingCalls, 1, 'A stalled reading batch is not bought again within this window');
  assert.equal(terminal.status, strict ? 'paused' : 'completed');
  const accepted = (await f.service.listText({ projectId: project.id })).units.filter(unit => unit.status === 'translated');
  assert.ok(accepted.some(unit => unit.source === 'Neutral line 0.'), 'Already accepted native-sample text stays saved');
  if (!strict) {
    assert.equal(siblingFinished, true, 'An independent in-flight batch is not cancelled by local reading stagnation');
    assert.ok(accepted.some(unit => unit.source === 'Neutral line 32.'));
    assert.equal(terminal.skipped, 16);
  } else assert.equal(terminal.stage, '等待重试');
});

test('model edits bind captured revisions while candidates stay provisional and a manual edit wins', async t => {
  let release, consistencyEntered = false;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, { units: rows(3, 1), provider: async ({ role, wire }) => {
    const payload = wire.payload;
    if (role === 'translation') return { records: payload.units.map(unit => ({ id: unit.id, translation: `已翻译 ${unit.source}`, notes: '' })) };
    if (payload.reviewScope?.stage === 'consistency') { consistencyEntered = true; await gate; return review(payload); }
    const problem = payload.units.find(unit => unit.source === 'Neutral line 2.');
    const result = review(payload, payload.units.filter(unit => unit !== problem && !unit.currentTranslation.startsWith('人工')).map(unit => ({ id: unit.id,
      expectedRevision: 0, translation: `候选 ${unit.currentTranslation}`, notes: '' })));
    if (problem) result.review.issues.push({ unitId: problem.id, kind: 'needs_evidence', resolution: 'open', message: 'A specific unresolved pronoun needs checking, not a whole-game consistency pass.' });
    return result;
  } });
  const project = await f.service.createProject({ gameDir: f.gameDir }); await f.service.startProject({ projectId: project.id });
  await until(() => consistencyEntered, 'Consistency stage did not start');
  const before = (await f.service.listText({ projectId: project.id })).units;
  assert.ok(before.every(unit => unit.translation.startsWith('已翻译')));
  const scenePage = await f.service.listText({ projectId: project.id, filter: 'reviewed' });
  assert.equal(scenePage.total, 3);
  assert.ok(scenePage.units.filter(unit => unit.source !== 'Neutral line 2.').every(unit => unit.translation.startsWith('候选 已翻译')));
  assert.equal(scenePage.sceneReview.committed, false);
  assert.equal((await f.service.listText({ projectId: project.id, filter: 'proofread' })).total, 0);
  await f.service.saveText({ projectId: project.id, unitId: before[0].id, translation: '人工保留', notes: 'Manual fixture note', expectedRevision: before[0].revision });
  release();
  await until(async () => { const current = await f.service.getProject({ projectId: project.id });
    if (current.status === 'paused') throw new Error(`Unexpected pause: ${current.lastError}`);
    return current.status === 'completed'; }, 'Refreshed candidate round did not complete');
  const after = (await f.service.listText({ projectId: project.id })).units;
  assert.equal(after[0].translation, '人工保留'); assert.equal(after[0].notes, 'Manual fixture note');
  assert.ok(after[1].translation.startsWith('候选 已翻译'));
  const archive = await f.service.listText({ projectId: project.id, filter: 'reviewed', reviewRoundId: scenePage.sceneReview.roundId });
  assert.equal(archive.sceneReview.committed, true);
  assert.equal(archive.total, 3);
  assert.equal((await f.service.listText({ projectId: project.id, filter: 'proofread' })).total, 3);
});

for (const invalid of ['unknown', 'duplicate']) test(`model revision binding still rejects ${invalid} edit IDs`, async t => {
  const f = await fixture(t, { units: rows(1), strict: true, provider: async ({ role, wire }) => {
    const payload = wire.payload;
    if (role === 'translation') return { records: payload.units.map(unit => ({ id: unit.id, translation: `已翻译 ${unit.source}` })) };
    const edit = { id: invalid === 'unknown' ? 'unknown-model-id' : payload.units[0].id, expectedRevision: 0, translation: '不应接受的修改' };
    return review(payload, invalid === 'duplicate' ? [edit, { ...edit }] : [edit]);
  } });
  const project = await f.service.createProject({ gameDir: f.gameDir }); await f.service.startProject({ projectId: project.id });
  await until(async () => (await f.service.getProject({ projectId: project.id })).status === 'paused', 'Invalid edit IDs were not rejected');
  const current = (await f.service.listText({ projectId: project.id })).units[0];
  assert.equal(current.translation, `已翻译 ${current.source}`);
  assert.equal(current.status, 'translated');
});

test('resuming an older scene round persists transport once without buying its saved candidate again', async t => {
  const units = rows(33), sceneTargets = [];
  const provider = async ({ role, wire }) => {
    assert.equal(role, 'proofreading');
    const payload = wire.payload;
    if (payload.reviewScope.stage === 'scene') sceneTargets.push(...payload.units.map(unit => unit.id));
    return review(payload);
  };
  const f = await fixture(t, { units, provider }), project = await f.service.createProject({ gameDir: f.gameDir });
  await f.service.close();
  const dataDir = path.join(f.root, 'data'), store = createStore(dataDir);
  let savedId, candidate, roundFile;
  try {
    const current = store.units(project.id).map((unit, position) => {
      const next = { ...unit, status: 'translated', translation: `已翻译 ${unit.source}` };
      store.putUnit(project.id, next, position); return next;
    });
    const original = store.one('projects', project.id);
    const round = createReviewRound({ projectId: project.id, id: 'legacy-round', units: current, targetIds: current.map(unit => unit.id),
      story: buildStoryContext(current), glossary: original.nameGlossary });
    delete round.scopeTransport;
    const scope = reviewScopes(round, 'scene')[0]; savedId = scope.unitIds[0];
    candidate = { id: savedId, translation: '已保存的场景修订', notes: '', expectedRevision: current[0].revision };
    roundFile = path.join(original.workspaceDir, 'rounds', round.id, '0.json');
    await mkdir(path.dirname(roundFile), { recursive: true }); await writeFile(roundFile, JSON.stringify(round));
    store.patchProject(project.id, { status: 'paused', runConfig: { mode: 'proofreading', targetLanguage: defaultSettings().targetLanguage, scopeUnitIds: current.map(unit => unit.id) },
      textRound: { id: round.id, path: roundFile, phase: 'scene', targetCount: 33 } });
    store.putTask(project.id, { id: 'saved-scene-task', projectId: project.id, role: 'proofreading', kind: 'review-scene',
      fingerprint: 'saved-scene-fingerprint', reviewRoundId: round.id, reviewStage: 'scene', reviewScopeId: scope.id,
      reviewScopeVersion: reviewScopeVersion(round, scope, [], 'scene'), reviewReadIds: scope.readIds, unitIds: scope.unitIds,
      input: [current[0]], status: 'succeeded', candidateRecords: [candidate], reviewChangedIds: [savedId], reviewCandidate: { issues: [] } });
  } finally { store.close(); }
  const service = await createService({ dataDir, worker: fixtureWorker(units), secrets, provider,
    technicalProvider: async () => ({ decision: 'native', selectedCandidateIds: [] }), scriptTools: null });
  f.beforeCleanup.push(() => service.close());
  await service.startProject({ projectId: project.id, mode: 'proofreading' });
  await until(async () => { const current = await service.getProject({ projectId: project.id });
    if (current.status === 'paused') throw new Error(`Unexpected migrated pause: ${current.lastError}`);
    return current.status === 'completed'; }, 'Migrated review did not complete');
  assert.equal(sceneTargets.length, 32); assert.ok(!sceneTargets.includes(savedId));
  const final = (await service.listText({ projectId: project.id, limit: 100 })).units;
  assert.equal(final.find(unit => unit.id === savedId).translation, candidate.translation);
  assert.ok(final.every(unit => unit.status === 'proofread'));
  const inspect = createStore(dataDir);
  try {
    const pointer = inspect.one('projects', project.id).textRound;
    const persisted = JSON.parse(await readFile(pointer.path, 'utf8'));
    assert.equal(persisted.revision, 1); assert.equal(persisted.scopeTransport.pinned.scene.length, 1);
    assert.deepEqual(inspect.tasks(project.id).find(task => task.id === 'saved-scene-task').candidateRecords, [candidate]);
    assert.ok(!JSON.parse(await readFile(roundFile, 'utf8')).scopeTransport, 'The original frozen round remains unchanged');
  } finally { inspect.close(); }
});

test('continuation preserves paid partial consistency results without dispatching obsolete full-review tasks', async t => {
  const units = rows(4), f = await fixture(t, { units, provider: async () => { throw new Error('Obsolete full review must not call a model'); } });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  await f.service.close();
  const dataDir = path.join(f.root, 'data'), store = createStore(dataDir);
  let savedId;
  try {
    const current = store.units(project.id).map((unit, position) => {
      const row = { ...unit, status: 'translated', translation: `已翻译 ${unit.source}` };
      store.putUnit(project.id, row, position); return row;
    });
    const original = store.one('projects', project.id);
    const round = createReviewRound({ projectId: project.id, units: current, targetIds: current.map(unit => unit.id),
      story: buildStoryContext(current), glossary: { entries: [] } });
    round.stage = 'consistency'; savedId = current[0].id;
    for (const scope of reviewScopes(round, 'scene')) store.putTask(project.id, {
      id: `scene-${scope.id}`, projectId: project.id, role: 'proofreading', kind: 'review-scene', fingerprint: `scene-${scope.id}`,
      status: 'succeeded', reviewRoundId: round.id, reviewStage: 'scene', reviewScopeId: scope.id,
      reviewReadIds: scope.readIds, reviewScopeVersion: reviewScopeVersion(round, scope, [], 'scene'), unitIds: scope.unitIds,
      candidateRecords: current.filter(unit => scope.unitIds.includes(unit.id)).map(({ id, translation, notes }) => ({ id, translation, notes })), reviewChangedIds: [],
    });
    for (const [index, ids] of [current.slice(0, 2), current.slice(2)].entries()) {
      const scope = { id: `old-person-${index}`, unitIds: ids.map(unit => unit.id), readIds: ids.map(unit => unit.id) };
      store.putTask(project.id, { id: `old-${index}`, projectId: project.id, role: 'proofreading', kind: 'review-consistency',
        fingerprint: `old-${index}`, status: 'queued', attempts: index ? 0 : 1, input: ids,
        reviewRoundId: round.id, reviewStage: 'consistency', reviewScopeId: scope.id, reviewReadIds: scope.readIds,
        reviewScopeVersion: reviewScopeVersion(round, scope, [], 'consistency'), unitIds: scope.unitIds,
        candidateRecords: index ? [] : [{ id: savedId, translation: '已付费且已验证的局部修订', notes: '保留付费成果' }],
        reviewedUnitIds: index ? [] : [savedId], reviewChangedIds: index ? [] : [savedId],
      });
    }
    const file = path.join(original.workspaceDir, 'rounds', round.id, '0.json');
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(round));
    store.patchProject(project.id, { status: 'paused', runConfig: { mode: 'proofreading', targetLanguage: defaultSettings().targetLanguage, scopeUnitIds: current.map(unit => unit.id) },
      textRound: { id: round.id, path: file, phase: 'consistency', targetCount: 4 } });
  } finally { store.close(); }
  let calls = 0;
  const service = await createService({ dataDir, worker: fixtureWorker(units), secrets,
    provider: async () => { calls++; throw new Error('No additional review is needed'); },
    technicalProvider: async () => ({ decision: 'native', selectedCandidateIds: [] }), scriptTools: null });
  f.beforeCleanup.push(() => service.close());
  await service.startProject({ projectId: project.id, mode: 'proofreading' });
  await until(async () => { const detail = await service.getProject({ projectId: project.id });
    if (detail.status === 'paused') throw new Error(detail.lastError);
    return detail.status === 'completed'; }, 'Paid continuation did not finish');
  const final = (await service.listText({ projectId: project.id })).units;
  assert.equal(calls, 0); assert.ok(final.every(unit => unit.status === 'proofread'));
  assert.equal(final.find(unit => unit.id === savedId).translation, '已付费且已验证的局部修订');
  assert.equal(final.find(unit => unit.id === savedId).notes, '保留付费成果');
  const inspect = createStore(dataDir);
  try {
    assert.equal(inspect.one('tasks', 'old-0').status, 'paused');
    assert.equal(inspect.one('tasks', 'old-0').candidateRecords.length, 1);
    assert.equal(inspect.one('tasks', 'old-1').status, 'stale');
  } finally { inspect.close(); }
});

test('137-target review resumes one scope after process restart and commits both early and final page candidates', async t => {
  const units = rows(137, 137), resumedTargets = [], acceptedBeforePause = new Set();
  let gateEntered = false, resumed = false, sceneRequests = 0;
  const provider = async ({ role, wire, signal }) => {
    const payload = wire.payload;
    if (role === 'translation') return { records: payload.units.map(unit => ({ id: unit.id, translation: `已翻译 ${unit.source}`, notes: '' })) };
    if (payload.reviewScope?.stage === 'scene') {
      if (resumed) resumedTargets.push(...payload.units.map(unit => unit.id));
      if (!resumed && ++sceneRequests === 2) {
        gateEntered = true;
        return new Promise((_resolve, reject) => { const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
      }
      return review(payload, payload.units.map(unit => ({ id: unit.id, expectedRevision: unit.revision,
        translation: `修订 ${unit.currentTranslation}`, notes: 'Neutral page candidate' })));
    }
    return review(payload);
  };
  const f = await fixture(t, { units, provider }), project = await f.service.createProject({ gameDir: f.gameDir });
  await f.service.startProject({ projectId: project.id }); await until(() => gateEntered, 'The second transport page did not start');
  const inspect = createStore(path.join(f.root, 'data'));
  try {
    const scene = inspect.tasks(project.id).find(task => task.reviewStage === 'scene');
    assert.ok(scene.candidateRecords.length > 0 && scene.candidateRecords.length < units.length);
    scene.candidateRecords.forEach(record => acceptedBeforePause.add(record.id));
  } finally { inspect.close(); }
  assert.ok((await f.service.listText({ projectId: project.id })).units.every(unit => unit.translation.startsWith('已翻译')));
  await f.service.pauseProject({ projectId: project.id }); await f.service.close();
  resumed = true;
  const service = await createService({ dataDir: path.join(f.root, 'data'), worker: fixtureWorker(units), secrets, provider,
    technicalProvider: async () => ({ decision: 'native', selectedCandidateIds: [] }), scriptTools: null });
  f.beforeCleanup.push(() => service.close());
  await service.startProject({ projectId: project.id });
  await until(async () => { const current = await service.getProject({ projectId: project.id });
    if (current.status === 'paused') {
      const debug = createStore(path.join(f.root, 'data'));
      try { throw new Error(`Unexpected resumed pause: ${JSON.stringify({ error: current.lastError, tasks: debug.tasks(project.id).filter(task => task.error).map(task => ({ role: task.role, stage: task.reviewStage, error: task.error, response: task.responseSummary })) })}`); }
      finally { debug.close(); }
    }
    return current.status === 'completed'; }, 'The resumed full scope did not complete');
  assert.ok(resumedTargets.length > 0); assert.ok(resumedTargets.every(id => !acceptedBeforePause.has(id)), 'Persisted page candidates are not requested again');
  const final = (await service.listText({ projectId: project.id, limit: 200 })).units;
  assert.equal(final.length, 137); assert.equal(final[0].translation, '修订 已翻译 Neutral line 0.');
  assert.equal(final.at(-1).translation, '修订 已翻译 Neutral line 136.');
  assert.ok(final.every(unit => unit.status === 'proofread'));
});

test('review transport keeps a linked display group together and never splits a long semantic unit', async t => {
  const units = rows(40, 40), linkedLegacy = new Set(['neutral:10', 'neutral:25']);
  for (const row of units.filter(row => linkedLegacy.has(row.id))) { row.source = 'Shared neutral label'; row.context.syncGroup = 'same-display'; }
  units[39].source = 'A complete neutral paragraph. '.repeat(300);
  const requests = [];
  const f = await fixture(t, { units, capacity: { contextWindow: 65536, maxOutputTokens: 16384 }, provider: async ({ role, wire }) => {
    const payload = wire.payload;
    if (role === 'translation') return { records: payload.units.map(unit => ({ id: unit.id, translation: `已翻译 ${unit.source}`, notes: '' })) };
    requests.push(payload);
    return review(payload, payload.units.map(unit => ({ id: unit.id, expectedRevision: unit.revision,
      translation: payload.reviewScope.stage === 'scene' ? `修订 ${unit.currentTranslation}` : unit.currentTranslation, notes: '' })));
  } });
  const project = await f.service.createProject({ gameDir: f.gameDir }); await f.service.startProject({ projectId: project.id });
  await until(async () => { const current = await f.service.getProject({ projectId: project.id });
    if (current.status === 'paused') throw new Error(`Unexpected linked-page pause: ${current.lastError}`);
    return current.status === 'completed'; }, 'Linked display review did not finish');
  for (const request of requests) {
    const linked = request.units.filter(unit => unit.source === 'Shared neutral label');
    if (linked.length) assert.equal(linked.length, 2);
    for (const row of request.units.filter(row => row.source.startsWith('A complete neutral paragraph.'))) assert.equal(row.source, units[39].source);
  }
  const current = (await f.service.listText({ projectId: project.id, limit: 100 })).units;
  const linked = current.filter(unit => linkedLegacy.has(unit.legacyId));
  assert.equal(linked.length, 2); assert.equal(new Set(linked.map(unit => unit.translation)).size, 1);
  assert.ok(linked[0].translation.startsWith('修订 已翻译'));
});

test('no product API is needed for external package handoff and neutral native standalone output', async t => {
  const worker = makeWorker({ pythonPath: 'python', workerPath: path.resolve('adapters/python/worker.py'),
    toolkitPath: path.resolve('kits/workbench-tutorial/toolkit') });
  let modelCalls = 0;
  const f = await fixture(t, { worker, configure: false, provider: async () => { modelCalls++; throw new Error('This path must not call an API'); } });
  await mkdir(path.join(f.gameDir, 'js'), { recursive: true }); await mkdir(path.join(f.gameDir, 'data'));
  await writeFile(path.join(f.gameDir, 'js/rmmz_core.js'), "var Utils = { RPGMAKER_VERSION: '1.0' };\n");
  await writeFile(path.join(f.gameDir, 'js/plugins.js'), 'var $plugins = [];\n');
  await writeFile(path.join(f.gameDir, 'Game.exe'), 'Neutral launcher fixture; not executable');
  await writeFile(path.join(f.gameDir, 'data/System.json'), JSON.stringify({ gameTitle: 'Neutral story', currencyUnit: 'Coin', elements: ['', 'Fire'], terms: { basic: ['Level'] } }));
  await writeFile(path.join(f.gameDir, 'data/Map001.json'), JSON.stringify({ displayName: 'Neutral inn', events: [null, { x: 0, y: 0, pages: [{ list: [
    { code: 101, indent: 0, parameters: ['', 0, 0, 2, 'Guide'] }, { code: 401, indent: 0, parameters: ['A complete neutral sentence.'] }, { code: 0, indent: 0, parameters: [] },
  ] }] }] }));
  const original = await readFile(path.join(f.gameDir, 'data/Map001.json'));
  const project = await f.service.createProject({ gameDir: f.gameDir }), exported = path.join(f.root, 'external.zip');
  await f.service.exportPackage({ projectId: project.id, filePath: exported });
  const outside = path.join(f.root, 'external-agent'); await worker('unzip', { filePath: exported, outputDir: outside });
  const editable = path.join(outside, 'editable/units.json'), returned = JSON.parse(await readFile(editable, 'utf8'));
  returned.forEach(record => { record.translation = `中文 ${record.translation}`; }); await writeFile(editable, JSON.stringify(returned));
  const incoming = path.join(f.root, 'returned.zip'); await worker('zip', { sourceDir: outside, filePath: incoming });
  const imported = await f.service.importPackage({ projectId: project.id, filePath: incoming });
  assert.equal(imported.accepted, returned.length); assert.equal((await f.service.importPackage({ projectId: project.id, filePath: incoming })).accepted, 0);
  const output = await f.service.buildProject({ projectId: project.id });
  const nativeMap = JSON.parse(await readFile(path.join(output.path, 'data/Map001.json'), 'utf8'));
  assert.equal(nativeMap.events[1].pages[0].list[1].parameters[0], '中文 A complete neutral sentence.');
  const reextracted = await worker('extract', { gameDir: output.path, workspaceDir: path.join(f.root, 'independent-reextract') });
  assert.ok(reextracted.units.some(unit => unit.source === '中文 A complete neutral sentence.'));
  assert.deepEqual(await readFile(path.join(f.gameDir, 'data/Map001.json')), original);
  assert.equal(modelCalls, 0); assert.ok((await readdir(output.path)).includes('Game.exe'));
});
