import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { createReviewRound, reviewOutcome } from './review-round.mjs';
import { scanTerminology } from './glossary.mjs';
import { buildStoryContext } from '../exchange/story.mjs';
import { sha256 } from '../exchange/index.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await delay(10); }
  throw new Error('Local text recovery timed out');
}

async function fixture(t, { proofreading = false, pauseOnLocalFailure = false, provider, count = 80, observe, linked = false, rawUnits, frozenReview = false } = {}) {
  const base = path.resolve('local/local-text-recovery-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'project-')), dataDir = path.join(root, 'data');
  const gameDir = path.join(root, 'game'), workspaceDir = path.join(root, 'work');
  await mkdir(gameDir); await mkdir(workspaceDir);
  await writeFile(path.join(gameDir, 'original.txt'), 'neutral original');
  const units = rawUnits ?? Array.from({ length: count }, (_, index) => {
    const source = linked && [5, 6].includes(index) ? 'A synchronized display title {{CTRL1}}' : `A neutral complete paragraph ${index}. {{CTRL1}}`;
    return { id: `line-${index}`, legacyId: `line-${index}`, kind: 'message', source, sourceHash: sha256(source),
      translation: proofreading ? `已完成初翻 ${index}。{{CTRL1}}` : source, notes: '', revision: 0,
      status: proofreading ? 'translated' : 'pending', tokens: ['{{CTRL1}}'],
      context: { file: `scene-${Math.floor(index / 16)}.json`, ...(linked && [5, 6].includes(index) ? { syncGroup: 'neutral-linked-title' } : {}), protectedControlSyntax: 'rpgmaker-v1',
        controlBindings: { '{{CTRL1}}': '\\C[2]' } } };
  });
  const store = createStore(dataDir);
  store.put('projects', { id: 'neutral-local', name: 'Neutral recovery', gameDir, workspaceDir, workbenchDir: workspaceDir,
    engine: 'MV', status: 'ready', prepared: true, targetLanguage: 'zh-Hans', inventory: {},
    sampleValidation: { nativeStructure: 'passed' }, sourceFingerprint: sha256(units), createdAt: new Date().toISOString() });
  store.transaction('neutral-local', () => units.forEach((unit, index) => { store.putUnit('neutral-local', unit, index); store.addRevision('neutral-local', unit); }));
  if (frozenReview) {
    const glossary = scanTerminology(units, undefined, 'zh-Hans');
    const round = createReviewRound({ id: 'saved-scene-round', projectId: 'neutral-local', units,
      targetIds: units.map(unit => unit.id), story: buildStoryContext(units), glossary });
    const roundFile = path.join(workspaceDir, 'rounds', round.id, '0.json');
    await mkdir(path.dirname(roundFile), { recursive: true }); await writeFile(roundFile, JSON.stringify(round));
    store.patchProject('neutral-local', { status: 'paused', nameGlossary: glossary,
      textRound: { id: round.id, path: roundFile, phase: 'scene', targetCount: units.length },
      runConfig: { runId: 'saved-scene-run', mode: 'proofreading', targetLanguage: 'zh-Hans', proofreading: true,
        scopeUnitIds: units.map(unit => unit.id) } });
  }
  store.close();
  const calls = [], commands = [];
  let service;
  const open = () => createService({ dataDir, scriptTools: null, onChanged: () => {
    if (service && observe) void service.getProject({ projectId: 'neutral-local' }).then(detail => observe(detail, service));
  }, provider: async args => {
    calls.push({ role: args.role, ids: args.wire.targetIds, prompt: args.prompt });
    return provider(args, calls);
  }, worker: async (command, args) => {
    commands.push(command);
    if (command === 'catalog') return {};
    if (['roundtrip', 'validate'].includes(command)) return {};
    if (command === 'build' || command === 'assemble') {
      await mkdir(args.outputDir, { recursive: true });
      return command === 'build' ? { buildDir: args.outputDir } : { outputDir: args.outputDir };
    }
    throw new Error(`Unexpected neutral command ${command}`);
  } });
  service = await open();
  await service.saveSettings({ ...defaultSettings(), concurrency: 3, proofreading, pauseOnLocalFailure,
    connection: { baseUrl: 'http://localhost:1/v1', model: 'neutral-local-model', contextWindow: 32768, maxOutputTokens: 2048 } });
  const inspect = fn => { const db = createStore(dataDir); try { return fn(db); } finally { db.close(); } };
  t.after(async () => { await service.close(); assert.ok(root.startsWith(base + path.sep)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }); });
  return { calls, commands, inspect, get service() { return service; },
    async start(mode = proofreading ? 'proofreading' : 'translation') { await service.startProject({ projectId: 'neutral-local', mode }); },
    async settled() { return until(async () => { const p = await service.getProject({ projectId: 'neutral-local' }); return ['paused', 'completed'].includes(p.status) && p; }); },
    async reopen() { await service.close(); service = await open(); } };
}

const normal = args => ({ records: args.wire.payload.units.map(unit => ({ id: unit.id, translation: `中性译文 ${unit.id} {{CTRL1}}` })) });
const bad = args => ({ records: args.wire.payload.units.map(unit => ({ id: unit.id,
  translation: unit.id === 'line-5' ? '缺少保护标记' : `中性译文 ${unit.id} {{CTRL1}}` })) });

test('a local incomplete translation parks only its missing target and lets independent work finish', async t => {
  const f = await fixture(t, { provider: bad });
  await f.start(); const done = await f.settled();
  assert.equal(done.status, 'completed', done.lastError);
  const units = f.inspect(db => db.units('neutral-local'));
  assert.equal(units.filter(unit => unit.status === 'translated').length, 79);
  assert.deepEqual(units.filter(unit => unit.status === 'skipped').map(unit => unit.id), ['line-5']);
  assert.equal(units.find(unit => unit.id === 'line-5').translation, units.find(unit => unit.id === 'line-5').source);
  assert.ok(f.calls.filter(call => call.ids.includes('line-5')).length <= 4, 'Three no-progress repairs do not buy the whole batch again');
  assert.ok(f.calls.some(call => call.ids.length === 1 && call.ids[0] === 'line-5' && call.prompt.includes('保护标记数量或顺序改变')),
    'Targeted repair names the actual local validation problem');
  assert.ok(f.calls.some(call => !call.ids.includes('line-5')));
  const tasks = f.inspect(db => db.tasks('neutral-local'));
  assert.ok(tasks.some(task => task.status === 'skipped' && task.commitSummary?.committed > 0));
  assert.ok(f.inspect(db => db.all('issues', 'neutral-local')).some(issue => issue.category === 'local-skip' && issue.unitId === 'line-5'));
});

test('whole-batch zero usable output still pauses without silently skipping the project', async t => {
  const f = await fixture(t, { provider: async () => ({ records: [] }) });
  await f.start(); const stopped = await f.settled();
  assert.equal(stopped.status, 'paused');
  assert.equal(stopped.stage, '模型回复待修正');
  assert.ok(f.inspect(db => db.units('neutral-local')).every(unit => unit.status === 'pending'));
  assert.equal(f.commands.includes('assemble'), false);
});

test('explicit pause-on-local-failure retains the user stop policy even with useful candidates', async t => {
  const f = await fixture(t, { provider: bad, pauseOnLocalFailure: true });
  await f.start(); const stopped = await f.settled();
  assert.equal(stopped.status, 'paused');
  const units = f.inspect(db => db.units('neutral-local'));
  assert.equal(units.find(unit => unit.id === 'line-5').status, 'pending');
  assert.ok(units.some(unit => unit.status === 'translated'));
  assert.equal(f.commands.includes('assemble'), false);
});

test('partial D2 review keeps valid candidates and does not label the unreviewed target proofread', async t => {
  const f = await fixture(t, { proofreading: true, provider: async args => {
    const reviewed = args.wire.payload.units.filter(unit => unit.id !== 'line-5');
    return { review: { protocol: 'pinhao-review-1', reviewedIds: reviewed.map(unit => unit.id),
      edits: reviewed.map(unit => ({ id: unit.id, translation: `校对后的中性译文 ${unit.id} {{CTRL1}}` })),
      issues: reviewed.map(unit => ({ unitId: unit.id, kind: 'correction', resolution: 'fixed', message: '修正中性文字表达' })) } };
  } });
  await f.start(); const done = await f.settled();
  if (done.status !== 'completed') t.diagnostic(JSON.stringify(f.inspect(db => db.tasks('neutral-local')).map(task => ({
    status: task.status, role: task.role, error: task.error, candidates: task.candidateRecords?.length,
    reviewed: task.reviewedUnitIds?.length, window: task.windowAttempts, lastFailure: task.lastFailure }))));
  assert.equal(done.status, 'completed', done.lastError);
  const units = f.inspect(db => db.units('neutral-local'));
  assert.equal(units.filter(unit => unit.status === 'proofread').length, 79);
  const unresolved = units.find(unit => unit.id === 'line-5');
  assert.equal(unresolved.status, 'skipped'); assert.equal(unresolved.skipRole, 'proofreading');
  assert.equal(unresolved.translation, '已完成初翻 5。{{CTRL1}}');
  assert.ok(units.filter(unit => unit.id !== 'line-5').every(unit => unit.translation.startsWith('校对后的')));
  assert.ok(f.inspect(db => db.tasks('neutral-local')).some(task => task.status === 'skipped' && task.reviewedUnitIds?.length));
});

test('ordinary pause and process reopen do not rebuy parked text, while explicit repair does', async t => {
  let stopped = false, stop, corrected = false;
  const f = await fixture(t, { provider: args => corrected ? normal(args) : bad(args), observe(detail, service) {
    if (!stopped && detail.status === 'running' && detail.skipped > 0) {
      stopped = true; stop = service.pauseProject({ projectId: detail.id });
    }
  } });
  await f.start(); await until(() => Boolean(stop)); await stop;
  const firstCount = f.calls.filter(call => call.ids.includes('line-5')).length;
  assert.ok(firstCount > 0);
  await f.reopen();
  await f.start(); const resumed = await f.settled();
  assert.equal(resumed.status, 'completed', resumed.lastError);
  assert.equal(f.calls.filter(call => call.ids.includes('line-5')).length, firstCount, 'Continue must leave this round\'s known failed item parked');
  assert.equal(f.inspect(db => db.unit('neutral-local', 'line-5')).status, 'skipped');
  corrected = true;
  const beforeRepair = f.calls.length;
  await f.start('repair'); const repaired = await f.settled();
  assert.equal(repaired.status, 'completed', repaired.lastError);
  assert.deepEqual(f.calls.slice(beforeRepair).flatMap(call => call.ids), ['line-5']);
  assert.equal(f.inspect(db => db.unit('neutral-local', 'line-5')).status, 'translated');
});

test('a changed model allows the existing parked-item mechanism to retry without a new failure table', async t => {
  let stopped = false, stop, corrected = false;
  const f = await fixture(t, { provider: args => corrected ? normal(args) : bad(args), observe(detail, service) {
    if (!stopped && detail.status === 'running' && detail.skipped > 0) {
      stopped = true; stop = service.pauseProject({ projectId: detail.id });
    }
  } });
  await f.start(); await until(() => Boolean(stop)); await stop;
  const settings = (await f.service.snapshot()).settings;
  settings.connection.model = 'neutral-corrected-model';
  await f.service.saveSettings(settings); corrected = true;
  const count = f.calls.filter(call => call.ids.includes('line-5')).length;
  await f.start(); assert.equal((await f.settled()).status, 'completed');
  assert.equal(f.calls.filter(call => call.ids.includes('line-5')).length, count + 1);
  assert.equal(f.inspect(db => db.unit('neutral-local', 'line-5')).status, 'translated');
});

test('whole review scopes with no valid review result still pause and keep their initial translations', async t => {
  const f = await fixture(t, { proofreading: true, provider: async () => ({ review: {
    protocol: 'pinhao-review-1', reviewedIds: [], edits: [], issues: [] } }) });
  await f.start(); const stopped = await f.settled();
  assert.equal(stopped.status, 'paused');
  assert.equal(stopped.stage, '模型回复待修正');
  assert.ok(f.inspect(db => db.units('neutral-local')).every(unit => unit.status === 'translated' && unit.translation.startsWith('已完成初翻')));
  assert.equal(f.commands.includes('assemble'), false);
});

test('D2 isolated targets survive pause/reopen without losing saved edits and explicit repair reviews them', async t => {
  let stopped = false, stop, corrected = false;
  const f = await fixture(t, { proofreading: true, provider: async args => {
    const reviewed = args.wire.payload.units.filter(unit => corrected || unit.id !== 'line-5');
    return { review: { protocol: 'pinhao-review-1', reviewedIds: reviewed.map(unit => unit.id),
      edits: reviewed.map(unit => ({ id: unit.id, translation: `校对后的中性译文 ${unit.id} {{CTRL1}}` })),
      issues: reviewed.map(unit => ({ unitId: unit.id, kind: 'correction', resolution: 'fixed', message: '修正中性文字表达' })) } };
  }, observe(detail, service) {
    if (!stopped && detail.status === 'running' && detail.tasks.some(task => task.role === 'proofreading' && task.status === 'skipped')) {
      stopped = true; stop = service.pauseProject({ projectId: detail.id });
    }
  } });
  await f.start(); await until(() => Boolean(stop)); await stop;
  const count = f.calls.filter(call => call.ids.includes('line-5')).length;
  await f.reopen(); await f.start();
  assert.equal((await f.settled()).status, 'completed');
  assert.equal(f.calls.filter(call => call.ids.includes('line-5')).length, count);
  assert.equal(f.inspect(db => db.unit('neutral-local', 'line-5')).status, 'skipped');
  assert.equal(f.inspect(db => db.units('neutral-local')).filter(unit => unit.status === 'proofread').length, 79);
  corrected = true;
  await f.start('repair'); assert.equal((await f.settled()).status, 'completed');
  assert.equal(f.inspect(db => db.unit('neutral-local', 'line-5')).status, 'proofread');
});

test('an incomplete synchronized group is parked whole without admitting its apparently valid half', async t => {
  const f = await fixture(t, { linked: true, provider: bad });
  await f.start(); assert.equal((await f.settled()).status, 'completed');
  const units = f.inspect(db => db.units('neutral-local'));
  assert.deepEqual(units.filter(unit => unit.status === 'skipped').map(unit => unit.id), ['line-5', 'line-6']);
  assert.ok(units.filter(unit => ['line-5', 'line-6'].includes(unit.id)).every(unit => unit.translation === unit.source));
  assert.ok(f.calls.filter(call => call.ids.includes('line-5')).every(call => call.ids.includes('line-6')));
  assert.equal(units.filter(unit => unit.status === 'translated').length, 78);
});

test('D2 leaves an unreviewed name and its prior notes and review unchanged even when the prospective glossary normalizes it', async t => {
  const previousReview = { roundId: 'prior-round', reviewId: 'prior-review', status: 'proofread', issues: [] };
  const rawUnits = [{ id: 'name', source: 'Mina', translation: '美娜', kind: 'character_name',
    notes: '保留人工备注', review: previousReview, context: { actorId: 1, file: 'actors.json', record: 1 } },
  ...Array.from({ length: 9 }, (_, index) => ({ id: `vote-${index}`, source: `Mina, neutral scene ${index}.`,
    translation: `米娜，中性场景 ${index}。`, termChoices: [{ source: 'Mina', translation: '米娜' }],
    kind: 'dialogue', notes: '', context: { speaker: 'Mina', file: 'scenes.json', event: index } }))]
    .map(unit => ({ ...unit, legacyId: unit.id, sourceHash: sha256(unit.source), status: 'translated', revision: 0, tokens: [] }));
  const f = await fixture(t, { proofreading: true, rawUnits, frozenReview: true, provider: async args => ({ review: {
    protocol: 'pinhao-review-1', reviewedIds: args.wire.targetIds.filter(id => id !== 'name'), edits: [], issues: [] } }) });
  await f.start(); const done = await f.settled();
  assert.equal(done.status, 'completed', done.lastError);
  const tasks = f.inspect(db => db.tasks('neutral-local'));
  const pointer = f.inspect(db => db.one('projects', 'neutral-local').textRound);
  const round = JSON.parse(await readFile(pointer.path, 'utf8'));
  round.stage = 'resolve';
  const outcome = reviewOutcome(round, tasks);
  assert.ok(outcome.skippedIds.includes('name'));
  assert.equal(outcome.units.find(unit => unit.id === 'name').translation, '米娜', 'This must exercise the real prospective normalization path');
  const name = f.inspect(db => db.unit('neutral-local', 'name'));
  assert.equal(name.status, 'skipped'); assert.equal(name.translation, '美娜');
  assert.equal(name.notes, '保留人工备注'); assert.deepEqual(name.review, previousReview);
  assert.equal(f.inspect(db => db.units('neutral-local')).filter(unit => unit.status === 'proofread').length, 9);
});
