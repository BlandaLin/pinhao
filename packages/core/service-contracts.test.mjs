import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { sha256 } from '../exchange/index.mjs';

const parent = path.resolve('local/core-tests');
await mkdir(parent, { recursive: true });
async function waitFor(read, message, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(message);
}
async function fixture(t, provider, rawUnits) {
  const root = await mkdtemp(path.join(parent, 'service-contracts-')), gameDir = path.join(root, 'game');
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'original.txt'), 'Neutral immutable fixture.');
  const units = rawUnits ?? [{ id: 'neutral:line', kind: 'dialogue', source: 'A neutral greeting.', tokens: [], context: { file: 'scene.json', event: 1, page: 0 } }];
  const open = () => createService({ dataDir: path.join(root, 'data'), scriptTools: null, provider,
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral fixture route' }),
    worker: async (command, input) => {
      if (command === 'probe') return { engine: 'MV' };
      if (command === 'extract') { await mkdir(input.workspaceDir, { recursive: true }); return { workspaceDir: input.workspaceDir, sourceFingerprint: sha256(units), units }; }
      if (['validate', 'roundtrip'].includes(command)) return { ok: true };
      if (command === 'build') { await mkdir(input.outputDir, { recursive: true }); return { buildDir: input.outputDir }; }
      if (command === 'assemble') { await mkdir(input.outputDir, { recursive: true }); await writeFile(path.join(input.outputDir, 'Game.exe'), 'Neutral launcher fixture.'); return { outputDir: input.outputDir, launchPath: path.join(input.outputDir, 'Game.exe') }; }
      throw new Error(`Unsupported neutral command ${command}`);
    } });
  let service = await open();
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  await service.saveSettings({ ...defaultSettings(), connection: { baseUrl: 'http://localhost:1/v1', model: 'neutral-fixture' } });
  const project = await service.createProject({ gameDir });
  return { service, open: async () => { service = await open(); return service; }, projectId: project.id, dataDir: path.join(root, 'data') };
}
const unchangedReview = (payload, issues = []) => ({ review: { protocol: 'pinhao-review-1', reviewedIds: payload.units.map(unit => unit.id), edits: [], issues } });

test('saved scene pages advance review progress before D2 commit and survive pause and reopening without a progress pointer', async t => {
  let sceneRequests = 0, blocked = false, resume = false;
  const successfulSceneIds = [];
  const f = await fixture(t, async ({ wire, signal }) => {
    const payload = wire.payload;
    if (payload.reviewScope?.stage === 'scene') {
      sceneRequests++;
      if (sceneRequests === 2 && !resume) {
        blocked = true;
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      successfulSceneIds.push(...payload.units.map(unit => unit.id));
    }
    return unchangedReview(payload);
  }, Array.from({ length: 34 }, (_, index) => ({ id: `neutral:${index}`, kind: 'dialogue', source: `A neutral line ${index}. ${'A complete neutral context. '.repeat(15)}`,
    tokens: [], context: { file: 'scene.json', event: 1, page: 0 } })));
  for (const unit of (await f.service.listText({ projectId: f.projectId })).units) {
    await f.service.saveText({ projectId: f.projectId, unitId: unit.id, translation: `中性文字${unit.id}。`, expectedRevision: unit.revision });
  }
  await f.service.startProject({ projectId: f.projectId, mode: 'proofreading' });
  await waitFor(() => blocked, 'The second scene page did not start');
  const during = await f.service.getProject({ projectId: f.projectId, summaryOnly: true });
  assert.equal(during.reviewRound.stage, 'scene');
  assert.ok(successfulSceneIds.length > 0 && successfulSceneIds.length < 34, 'Capacity creates multiple complete semantic pages');
  assert.deepEqual(during.reviewRound.progress, { total: 34, reviewed: successfulSceneIds.length, skipped: 0 });
  assert.equal(during.proofread, 0, 'Candidates are not formally committed before D2 finishes');
  await f.service.pauseProject({ projectId: f.projectId });
  await f.service.close();
  const db = createStore(f.dataDir);
  try {
    const project = db.one('projects', f.projectId), { progress, ...pointer } = project.textRound;
    db.put('projects', { ...project, textRound: pointer });
  } finally { db.close(); }
  const reopened = await f.open();
  const restored = await reopened.getProject({ projectId: f.projectId, summaryOnly: true });
  assert.equal(restored.reviewRound.id, during.reviewRound.id);
  assert.deepEqual(restored.reviewRound.progress, during.reviewRound.progress);
  assert.equal(sceneRequests, 2, 'Reading restored progress does not buy another model request');
  assert.deepEqual((await reopened.getProject({ projectId: f.projectId })).reviewRound.progress, during.reviewRound.progress);
  resume = true;
  await reopened.startProject({ projectId: f.projectId });
  const done = await waitFor(async () => { const detail = await reopened.getProject({ projectId: f.projectId });
    if (detail.status === 'paused') assert.fail(detail.lastError); return detail.status === 'completed' && detail; }, 'Resumed review did not finish');
  assert.equal(done.proofread, 34); assert.equal(done.reviewRound.stage, 'committed');
  assert.ok(done.reviewRound.committedAt, 'Only the formal D2 commit supplies review completion evidence');
  assert.equal(successfulSceneIds.length, 34);
  assert.equal(new Set(successfulSceneIds).size, 34, 'Already saved scene pages are not sent again on resume');
});

test('a committed translation-only round does not claim a completed D2 review', async t => {
  const f = await fixture(t, async ({ role, wire }) => {
    assert.equal(role, 'translation');
    return { records: wire.payload.units.map(unit => ({ id: unit.id, translation: '中性初翻。' })) };
  });
  await f.service.saveSettings({ ...(await f.service.snapshot()).settings, proofreading: false });
  await f.service.startProject({ projectId: f.projectId });
  const done = await waitFor(async () => { const detail = await f.service.getProject({ projectId: f.projectId });
    if (detail.status === 'paused') assert.fail(detail.lastError); return detail.status === 'completed' && detail; }, 'Translation-only round did not finish');
  assert.equal(done.reviewRound.stage, 'committed');
  assert.equal(done.reviewRound.committedAt, undefined);
  assert.equal(done.proofread, 0);
});

test('D2 final commit preserves needs-evidence state for build and text summaries', async t => {
  const stages = [];
  const f = await fixture(t, async ({ role, prompt, wire }) => {
    const payload = wire.payload;
    if (role === 'translation') return { records: payload.units.map(unit => ({ id: unit.id, translation: '中性问候。', notes: '' })) };
    stages.push(payload.reviewScope.stage);
    return unchangedReview(payload, payload.units.map(unit => ({ unitId: unit.id,
      kind: 'needs_evidence', resolution: 'open', message: 'The neutral speaker identity remains unknown after the targeted check.' })));
  });
  await f.service.startProject({ projectId: f.projectId });
  const done = await waitFor(async () => { const detail = await f.service.getProject({ projectId: f.projectId });
    if (detail.status === 'paused') assert.fail(detail.lastError); return detail.status === 'completed' && detail; }, 'D2 round did not finish');
  const [unit] = (await f.service.listText({ projectId: f.projectId })).units;
  assert.equal(unit.status, 'proofread');
  assert.equal(unit.review?.status, 'needs_evidence');
  assert.ok(unit.review.reviewId || unit.review.roundId);
  assert.ok(unit.review.issues.some(issue => issue.kind === 'needs_evidence' && !issue.resolved));
  assert.equal(done.builds[0].checks.find(check => check.name === '校对证据')?.status, 'pending');
  assert.deepEqual(stages, ['scene', 'consistency'], 'A real open issue buys one targeted follow-up, not a silent resolution');
});

test('repeated review pauses reset the execution window and resume the same frozen round', async t => {
  let failed = true, proofRequests = 0;
  const f = await fixture(t, async ({ role, prompt, wire }) => {
    const payload = wire.payload;
    if (role === 'translation') return { records: payload.units.map(unit => ({ id: unit.id, translation: '中性问候。', notes: '' })) };
    proofRequests++;
    if (failed) throw Object.assign(new Error('Neutral authentication fixture failure'), { statusCode: 401 });
    return unchangedReview(payload);
  });
  let roundId;
  for (let index = 0; index < 3; index++) {
    await f.service.startProject({ projectId: f.projectId });
    const paused = await waitFor(async () => { const detail = await f.service.getProject({ projectId: f.projectId }); return detail.status === 'paused' && detail; }, 'Review request did not pause');
    roundId ??= paused.reviewRound.id;
    assert.equal(paused.reviewRound.id, roundId);
  }
  assert.equal(proofRequests, 3);
  failed = false;
  await f.service.startProject({ projectId: f.projectId });
  const done = await waitFor(async () => { const detail = await f.service.getProject({ projectId: f.projectId }); return detail.status === 'completed' && detail; }, 'A resumed review exhausted its stale window instead of running');
  assert.equal(done.reviewRound.id, roundId);
  assert.equal(proofRequests, 4, 'Three failed scene attempts resume once without adding a healthy full consistency pass');
  assert.equal(done.proofread, 1);
  assert.equal(done.reviewRound.stage, 'committed');
});

test('building and reusing a product preserves an unfinished paid review round for ordinary continuation', async t => {
  let interrupt = true, sceneCalls = 0;
  const f = await fixture(t, async ({ wire }) => {
    const payload = wire.payload;
    if (payload.reviewScope?.stage === 'scene') {
      sceneCalls++;
      const [unit, question] = payload.units;
      return { review: { protocol: 'pinhao-review-1', reviewedIds: [unit.id, question.id],
        edits: [{ id: unit.id, translation: '校对后的中性问候。', notes: 'Saved neutral candidate.' }],
        issues: [{ unitId: unit.id, kind: 'correction', resolution: 'fixed', message: 'Neutral wording correction.' },
          { unitId: question.id, kind: 'needs_evidence', resolution: 'open', message: 'This separate speaker identity needs a targeted follow-up.' }] } };
    }
    if (interrupt) throw Object.assign(new Error('Neutral review connection failure'), { statusCode: 401 });
    return unchangedReview(payload);
  }, [
    { id: 'neutral:line', kind: 'dialogue', source: 'A neutral greeting.', tokens: [], context: { file: 'scene.json', event: 1, page: 0 } },
    { id: 'neutral:question', kind: 'dialogue', source: 'The unidentified traveler answers.', tokens: [], context: { file: 'scene.json', event: 1, page: 0 } },
  ]);
  const accepted = (await f.service.listText({ projectId: f.projectId })).units;
  for (const unit of accepted) await f.service.saveText({ projectId: f.projectId, unitId: unit.id,
    translation: unit.id === accepted[0].id ? '已接受的中性问候。' : '身份未明的旅客回答。', expectedRevision: unit.revision });
  const inspect = () => { const db = createStore(f.dataDir); try { return { project: db.one('projects', f.projectId), tasks: db.tasks(f.projectId) }; } finally { db.close(); } };
  await f.service.startProject({ projectId: f.projectId, mode: 'proofreading' });
  const paused = await waitFor(async () => { const detail = await f.service.getProject({ projectId: f.projectId }); return detail.status === 'paused' && detail; }, 'Consistency did not pause');
  const before = inspect(), saved = before.tasks.find(task => task.reviewStage === 'scene').candidateRecords;
  assert.equal(sceneCalls, 1); assert.equal(saved.length, 2);
  assert.equal((await f.service.listText({ projectId: f.projectId })).units[0].translation, '已接受的中性问候。', 'The paid scene edit stays provisional while its separate evidence question is unfinished');
  const first = await f.service.buildProject({ projectId: f.projectId });
  const cached = await f.service.buildProject({ projectId: f.projectId });
  assert.equal(cached.id, first.id, 'The cache-success path is exercised as well as a fresh build');
  assert.equal((await f.service.getProject({ projectId: f.projectId })).status, 'completed');
  interrupt = false;
  await f.service.startProject({ projectId: f.projectId });
  const resumed = inspect();
  assert.equal(resumed.project.runConfig.mode, 'proofreading', 'Ordinary continue keeps the unfinished mode after a successful build');
  assert.equal(resumed.project.runConfig.runId, before.project.runConfig.runId);
  assert.equal(resumed.project.textRound.id, paused.reviewRound.id);
  assert.deepEqual(resumed.tasks.find(task => task.reviewStage === 'scene' && task.reviewRoundId === paused.reviewRound.id).candidateRecords, saved);
  const done = await waitFor(async () => { const detail = await f.service.getProject({ projectId: f.projectId }); return detail.status === 'completed' && detail; }, 'Continued D2 did not finish');
  assert.equal(done.reviewRound.id, paused.reviewRound.id); assert.equal(done.proofread, 2);
  assert.equal(sceneCalls, 1, 'The paid successful scene is not reviewed again after building');
  assert.equal((await f.service.listText({ projectId: f.projectId })).units[0].translation, '校对后的中性问候。');
  await f.service.startProject({ projectId: f.projectId });
  const next = inspect().project;
  assert.equal(next.runConfig.mode, 'all', 'A committed round does not pin the next ordinary run mode');
  assert.notEqual(next.runConfig.runId, before.project.runConfig.runId);
  assert.notEqual(next.textRound?.id, paused.reviewRound.id, 'Completed D2 material is not reopened as an unfinished round');
});

for (const change of ['mode', 'language']) test(`an unfinished built round is not incorrectly reused after an explicit ${change} change`, async t => {
  const f = await fixture(t, async ({ role, wire }) => {
    if (role === 'proofreading') throw Object.assign(new Error('Neutral review authentication failure'), { statusCode: 401 });
    return { records: wire.payload.units.map(unit => ({ id: unit.id, translation: 'A translated neutral greeting.' })) };
  });
  const [unit] = (await f.service.listText({ projectId: f.projectId })).units;
  await f.service.saveText({ projectId: f.projectId, unitId: unit.id, translation: '已接受中性文字。', expectedRevision: unit.revision });
  await f.service.startProject({ projectId: f.projectId, mode: 'proofreading' });
  const paused = await waitFor(async () => { const detail = await f.service.getProject({ projectId: f.projectId }); return detail.status === 'paused' && detail; }, 'Neutral review did not pause');
  await f.service.buildProject({ projectId: f.projectId });
  if (change === 'language') {
    const settings = (await f.service.snapshot()).settings;
    await f.service.saveSettings({ ...settings, targetLanguage: 'en' });
    await assert.rejects(f.service.startProject({ projectId: f.projectId }), /目标语言已改变/);
    assert.equal((await f.service.getProject({ projectId: f.projectId })).reviewRound.id, paused.reviewRound.id,
      'A rejected phase/language combination does not silently discard the retained round');
  }
  await f.service.startProject({ projectId: f.projectId, mode: 'translation' });
  const done = await waitFor(async () => { const detail = await f.service.getProject({ projectId: f.projectId }); return detail.status === 'completed' && detail; }, 'Explicit translation run did not finish');
  assert.notEqual(done.reviewRound?.id, paused.reviewRound.id);
  const db = createStore(f.dataDir);
  try { assert.equal(db.one('projects', f.projectId).runConfig.mode, 'translation'); }
  finally { db.close(); }
});

test('a manual canonical name update refreshes only its frozen glossary scopes before final commit', async t => {
  let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, async ({ role, prompt, signal, wire }) => {
    const payload = wire.payload;
    if (role === 'translation') return { records: payload.units.map(unit => ({ id: unit.id,
      translation: payload.task === 'glossary' || unit.source === 'Rose' ? '萝丝' : '中性问候。', notes: '' })) };
    if (payload.reviewScope?.stage === 'consistency' && !entered) {
      entered = true;
      await Promise.race([gate, new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Neutral cancelled review')), { once: true }))]);
    }
    return unchangedReview(payload, payload.reviewScope?.stage === 'scene' ? payload.units.filter(unit => unit.kind === 'character_name')
      .map(unit => ({ unitId: unit.id, kind: 'needs_evidence', resolution: 'open', message: 'The character name has two plausible readings to verify.' })) : []);
  }, [
    { id: 'actor-name', kind: 'character_name', source: 'Rose', tokens: [], context: { file: 'Actors.json', actorId: 1 } },
    { id: 'dialogue', kind: 'dialogue', source: 'A neutral greeting.', tokens: [], context: { file: 'Map001.json', event: 1, page: 0, speaker: 'Rose', actorId: 1 } },
  ]);
  await f.service.startProject({ projectId: f.projectId });
  await waitFor(() => entered, 'The name consistency stage did not start');
  const actor = (await f.service.listText({ projectId: f.projectId })).units.find(unit => unit.kind === 'character_name');
  await f.service.saveText({ projectId: f.projectId, unitId: actor.id, translation: '人工新译名', expectedRevision: actor.revision });
  release();
  const terminal = await waitFor(async () => { const detail = await f.service.getProject({ projectId: f.projectId }); return ['completed', 'paused'].includes(detail.status) && detail; }, 'Manual glossary refresh did not finish');
  assert.equal(terminal.status, 'completed', terminal.lastError);
  assert.equal((await f.service.listText({ projectId: f.projectId })).units.find(unit => unit.id === actor.id).translation, '人工新译名');
});
