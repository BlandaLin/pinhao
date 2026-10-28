import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { sha256 } from '../exchange/index.mjs';

// The fake reviewer checks its real supplied evidence, then applies a predetermined correction.
// This fixture measures material delivery and state transitions, not model semantic ability.
for (const ambiguityKind of ['needs_evidence', 'source_ambiguity']) test(`cross-scene reading fixes identity once and retains the distinct ${ambiguityKind} outcome`, async t => {
  const parent = path.resolve('local/core-tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'story-quality-')), dataDir = path.join(root, 'data'), gameDir = path.join(root, 'original');
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'original.txt'), 'Neutral story fixture, unchanged.');
  const intro = 'I am the apprentice at the inn. The silver key opens the east gate.';
  const later = 'I am the keeper now. Call me Keeper. I kept the silver key, so we can open the east gate.';
  const ambiguous = 'They arrived before dawn.';
  const corrected = '我现在是掌柜了。叫我掌柜。我一直保管着银钥匙，所以我们能打开东门。';
  const current = new Map([
    ['Mira', '米拉'], [intro, '我是旅店的学徒。银钥匙能打开东门。'],
    [later, '我现在还是学徒。叫我学徒。我把铜钥匙交给了你，我们只能开西门。'],
    [ambiguous, '他在黎明前到达了。'], ['The east gate is open.', '东门已经打开了。'],
  ]);
  const units = [
    { id: 'actor-name', kind: 'database_name', source: 'Mira', tokens: [], context: { file: 'data/Actors.json', record: 1, actor_id: 1, field: 'name' } },
    { id: 'opening', kind: 'dialogue', source: intro, tokens: [], context: { file: 'data/Map001.json', event: 1, page: 0, actorId: 1, speaker: '\\N[1]' } },
    { id: 'return', kind: 'dialogue', source: later, tokens: [], context: { file: 'data/Map002.json', event: 2, page: 0, actorId: 1, speaker: '\\N[1]' } },
    { id: 'ambiguity', kind: 'dialogue', source: ambiguous, tokens: [], context: { file: 'data/Map002.json', event: 2, page: 0, speaker: 'unknown' } },
    { id: 'accurate', kind: 'dialogue', source: 'The east gate is open.', tokens: [], context: { file: 'data/Map003.json', event: 3, page: 0, speaker: 'unknown' } },
  ];
  let sceneEvidence = 0;
  const unchangedReviewedSources = new Set();
  const followupTargets = [];
  const provider = async ({ prompt, role, wire }) => {
    const payload = wire.payload;
    assert.equal(role, 'proofreading', 'This test starts from accepted translations, without a translation/model preparation pass');
    const crossScene = payload.reviewScope.stage === 'scene' && payload.units.some(unit => unit.source === later);
    if (payload.reviewScope.stage !== 'scene') {
      assert.equal(ambiguityKind, 'needs_evidence', 'A source ambiguity is retained, not bought again');
      assert.equal(payload.reviewScope.stage, 'consistency');
      followupTargets.push(...payload.units.map(unit => unit.source));
      assert.deepEqual(payload.units.map(unit => unit.source), [ambiguous], 'Only the explicit unresolved problem may be reviewed again');
      assert.equal((await service.listText({ projectId: project.id })).units.find(unit => unit.source === later).translation,
        current.get(later), 'Formal text stays on its accepted baseline until targeted follow-up finishes');
    }
    if (crossScene) {
      const actor = payload.story.scopes.find(scope => scope.kind === 'character' && scope.id === 'actor-1');
      assert.ok(actor, 'Explicit actor identity exposes the cross-scene reading entry');
      const characterReply = payload.evidenceResults?.find(answer => answer.query?.story?.kind === 'character');
      if (!characterReply) {
        const requests = [{ query: { story: { kind: 'character', id: actor.id }, offset: 0, limit: 32 }, reason: 'Read the same actor across opening and return scenes' }];
        const returnScene = payload.story.scopes.find(scope => scope.kind === 'scene' && scope.total === 2);
        assert.ok(returnScene, 'The return scene keeps its own readable identity inside a transport batch');
        requests.push({ query: { story: { kind: 'scene', id: returnScene.id }, offset: 0, limit: 32 }, reason: 'Read the complete return scene and its unresolved narrator line' });
        return { evidenceRequests: requests };
      }
      assert.ok(characterReply.total >= 4);
      const supplied = [...payload.units, ...payload.referenceOnly];
      const opening = supplied.find(unit => unit.source === intro), returnLine = supplied.find(unit => unit.source === later);
      assert.ok(opening); assert.ok(returnLine);
      assert.equal(opening.context.actorId, 1); assert.equal(returnLine.context.actorId, 1);
      assert.equal(opening.currentTranslation, current.get(intro));
      assert.ok(characterReply.returnedIds.includes(opening.id));
      assert.ok(characterReply.returnedIds.includes(returnLine.id));
      sceneEvidence++;
      assert.ok(payload.evidenceResults.some(answer => answer.query?.story?.kind === 'scene' && answer.total === 2));
    }
    const edits = crossScene ? payload.units.filter(unit => unit.source === later).map(unit => ({ id: unit.id,
      expectedRevision: unit.revision, translation: corrected, notes: '前场景的银钥匙与东门保持一致；同一人物在后场景已成为掌柜。' })) : [];
    for (const unit of payload.units) if (!edits.some(edit => edit.id === unit.id)) unchangedReviewedSources.add(unit.source);
    const issues = edits.map(edit => ({ unitId: edit.id, kind: 'correction', resolution: 'fixed',
      message: '依据同一角色的前后场景，修正身份、称谓、钥匙归属与方向。' }));
    for (const unit of payload.units.filter(unit => unit.source === ambiguous)) issues.push({ unitId: unit.id,
      kind: ambiguityKind, resolution: ambiguityKind === 'needs_evidence' ? 'open' : 'retained', message: 'They 的人数和指代对象缺少依据，保留现译等待后续材料。' });
    return { review: { protocol: 'pinhao-review-1', reviewedIds: payload.units.map(unit => unit.id), edits, issues } };
  };
  const service = await createService({ dataDir, provider, scriptTools: null,
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral fixture route' }),
    worker: async (command, input) => {
      if (command === 'probe') return { engine: 'MZ' };
      if (command === 'extract') { await mkdir(input.workspaceDir, { recursive: true }); return { units, workspaceDir: input.workspaceDir, sourceFingerprint: sha256(units) }; }
      if (['roundtrip', 'validate'].includes(command)) return {};
      if (command === 'build') { await mkdir(input.outputDir, { recursive: true }); return { buildDir: input.outputDir }; }
      if (command === 'assemble') { await mkdir(input.outputDir, { recursive: true }); await writeFile(path.join(input.outputDir, 'Game.exe'), 'Neutral non-executable launcher fixture'); return { outputDir: input.outputDir, runtimeVerified: false }; }
      throw new Error(`Unexpected neutral worker command ${command}`);
    } });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }); });
  await service.saveSettings({ ...defaultSettings(), concurrency: 3, connection: { baseUrl: 'http://localhost:1/v1', model: 'neutral-story-fixture' } });
  const project = await service.createProject({ gameDir });
  for (const unit of (await service.listText({ projectId: project.id })).units) await service.saveText({ projectId: project.id,
    unitId: unit.id, translation: current.get(unit.source), expectedRevision: unit.revision });
  const before = (await service.listText({ projectId: project.id })).units;
  await service.startProject({ projectId: project.id, mode: 'proofreading' });
  let done;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    done = await service.getProject({ projectId: project.id });
    if (done.status === 'paused') assert.fail(done.lastError);
    if (done.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(done.status, 'completed'); assert.ok(sceneEvidence > 0);
  assert.ok(unchangedReviewedSources.has('The east gate is open.'), 'Accurate text is reviewed without requiring an extra zero-change request');
  assert.deepEqual(followupTargets, ambiguityKind === 'needs_evidence' ? [ambiguous] : [],
    'The corrected character and unrelated accurate scene are never reviewed a second time');
  const final = (await service.listText({ projectId: project.id })).units;
  assert.equal(final.find(unit => unit.source === later).translation, corrected);
  const pending = final.find(unit => unit.source === ambiguous), pendingBefore = before.find(unit => unit.source === ambiguous);
  assert.equal(pending.translation, pendingBefore.translation); assert.equal(pending.revision, pendingBefore.revision);
  assert.equal(pending.review.status, ambiguityKind === 'needs_evidence' ? 'needs_evidence' : 'proofread');
  assert.ok(pending.review.issues.some(issue => issue.kind === ambiguityKind && issue.resolved === (ambiguityKind !== 'needs_evidence')));
  assert.equal(done.issues.some(issue => issue.category === 'review-evidence'), ambiguityKind === 'needs_evidence');
  assert.equal(final.find(unit => unit.source === 'The east gate is open.').revision,
    before.find(unit => unit.source === 'The east gate is open.').revision, 'Zero-edit scene keeps its accepted revision');
  const inspect = createStore(dataDir);
  try {
    const tasks = inspect.tasks(project.id).filter(task => task.reviewRoundId);
    assert.ok(tasks.some(task => task.storyReadingReceipts?.some(receipt => receipt.scopeKind === 'character')));
    assert.ok(tasks.some(task => task.storyReadingReceipts?.some(receipt => receipt.scopeKind === 'scene')));
  } finally { inspect.close(); }
  assert.equal(await readFile(path.join(gameDir, 'original.txt'), 'utf8'), 'Neutral story fixture, unchanged.');
});
