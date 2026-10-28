import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { sha256 } from '../exchange/index.mjs';

const inputRows = () => Array.from({ length: 4 }, (_, index) => ({ id: `neutral-${index}`, kind: 'dialogue',
  source: index === 1 || index === 2 ? 'Complete neutral linked source {{name}}.' : `Complete neutral source ${index} {{name}}.`, tokens: ['{{name}}'],
  context: { file: 'neutral.json', event: 1, ...(index === 1 || index === 2 ? { syncGroup: 'linked-display' } : {}) } }));
const openReview = id => ({ reviewId: `prior-${id}`, reviewedAt: '2026-10-28T00:00:00.000Z', status: 'needs_evidence',
  issues: [{ unitId: id, kind: 'needs_evidence', message: 'Neutral identity question remains open.', resolved: false }] });
const load = async (directory, name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'));

async function fixture(t, { seed = (_unit, index) => ({ status: 'translated', translation: index === 1 || index === 2 ? '关联显示 {{name}}' : `初译 ${index} {{name}}` }),
  mode = 'translation', scopePositions, issuePositions = [], offline = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-translation-intent-'));
  const gameDir = path.join(root, 'neutral-original'), dataDir = path.join(root, 'data'), inputs = inputRows();
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'neutral.txt'), 'Immutable neutral original.');
  let providerCalls = 0, packageIndex = 0;
  const service = await createService({ dataDir, scriptTools: null,
    provider: async () => { providerCalls++; throw new Error('This fixture must not dispatch a model request.'); },
    worker: async (command, args) => {
      if (command === 'probe') return { engine: 'MZ' };
      if (command === 'extract') {
        await mkdir(args.workspaceDir, { recursive: true });
        return { units: inputs, workspaceDir: args.workspaceDir, sourceFingerprint: sha256(inputs) };
      }
      if (['roundtrip', 'validate'].includes(command)) return { ok: true };
      // Exercise the actual service handoff; the host's archive transport is an isolated directory copy.
      if (command === 'zip') { await cp(args.sourceDir, args.filePath, { recursive: true }); return { path: args.filePath }; }
      if (command === 'unzip') { await cp(args.filePath, args.outputDir, { recursive: true }); return { outputDir: args.outputDir }; }
      throw new Error(`Unexpected neutral worker command ${command}`);
    } });
  t.after(async () => {
    await service.close();
    assert.equal(providerCalls, 0);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 30 });
  });
  await service.saveSettings({ ...defaultSettings(), connection: { baseUrl: 'http://localhost:1/v1', model: offline ? '' : 'neutral-no-network' } });
  const project = await service.createProject({ gameDir }), projectId = project.id;
  const db = createStore(dataDir);
  try {
    const units = db.units(projectId);
    db.transaction(projectId, () => {
      units.forEach((unit, index) => {
        const next = { ...unit, notes: '', ...seed(unit, index), revision: unit.revision + 1 };
        db.putUnit(projectId, next, index); db.addRevision(projectId, next);
        if (issuePositions.includes(index)) for (const category of ['review-evidence', 'text-question']) db.put('issues', {
          id: `${category}-${index}`, unitId: unit.id, category, message: 'Neutral identity question remains open.',
          severity: 'warning', createdAt: '2026-10-28T00:00:00.000Z',
        }, projectId);
      });
      db.patchProject(projectId, { runConfig: { mode, targetLanguage: 'zh-Hans',
        ...(scopePositions ? { scopeUnitIds: scopePositions.map(index => units[index].id) } : {}) } });
    });
  } finally { db.close(); }
  const texts = async () => (await service.listText({ projectId, limit: 100 })).units;
  return { root, service, projectId, texts, detail: () => service.getProject({ projectId }),
    save: (unit, patch) => service.saveText({ projectId, unitId: unit.id, translation: unit.translation, expectedRevision: unit.revision, ...patch }),
    export: async (options = {}) => {
      const directory = path.join(root, `neutral-package-${packageIndex++}`);
      await service.exportPackage({ projectId, filePath: directory, ...options }); return directory;
    },
    import: directory => service.importPackage({ projectId, filePath: directory }),
    edit: async (directory, update) => {
      const records = await load(directory, 'editable/units.json'); update(records);
      await writeFile(path.join(directory, 'editable/units.json'), JSON.stringify(records));
    } };
}

async function expectReviewDisplay(f, unitId, { proofread, translated, needsEvidence, targetProofread, targetNeedsEvidence }) {
  for (const [filter, total, included] of [['proofread', proofread, targetProofread], ['translated', translated, !targetProofread],
    ['needs_evidence', needsEvidence, targetNeedsEvidence]]) {
    const page = await f.service.listText({ projectId: f.projectId, filter, limit: 100 });
    assert.equal(page.total, total, `${filter} filtered total`);
    assert.equal(page.units.some(unit => unit.id === unitId), included, `${filter} target membership`);
  }
  const detail = await f.detail();
  assert.equal(detail.proofread, proofread); assert.equal(detail.translated, translated); assert.equal(detail.needsEvidence, needsEvidence);
  assert.equal(detail.progress.phases.proofread, proofread); assert.equal(detail.progress.phases.translated, translated);
  assert.equal(detail.done, proofread + translated);
}

test('service notes-only save preserves pending text, evidence, issues and revisions', async t => {
  const f = await fixture(t, { seed: unit => ({ status: 'pending', translation: unit.source, review: openReview(unit.id) }), issuePositions: [0] });
  const before = (await f.texts())[0];
  const updated = await f.save(before, { notes: '只补充人物身份线索。' });
  assert.equal(updated.translation, before.source); assert.equal(updated.status, 'pending');
  assert.deepEqual(updated.review, before.review); assert.equal(updated.revision, before.revision + 1);
  assert.ok((await f.detail()).issues.filter(issue => issue.unitId === before.id).every(issue => !issue.resolvedAt));
  assert.equal((await f.texts()).filter(unit => unit.status === 'pending').length, 4);
  await assert.rejects(f.save(before, { notes: '过时备注' }), { code: 'REVISION_CONFLICT' });
});

test('service manual text edit is translated, while explicit confirmation only approves its selected linked member', async t => {
  const f = await fixture(t, { seed: (unit, index) => ({ status: 'translated', translation: index === 1 || index === 2 ? '关联显示 {{name}}' : `初译 ${index} {{name}}`,
    review: openReview(unit.id) }), issuePositions: [1, 2] });
  const initial = await f.texts(), selected = initial[1], sibling = initial[2];
  const edited = await f.save(selected, { translation: '人工修订关联显示 {{name}}' });
  assert.equal(edited.status, 'translated'); assert.equal(edited.review.status, 'needs_evidence');
  let current = await f.texts(), linked = current.find(unit => unit.id === sibling.id);
  assert.equal(linked.translation, edited.translation); assert.equal(linked.status, 'translated');
  assert.deepEqual(linked.review, sibling.review);
  assert.ok((await f.detail()).issues.filter(issue => [selected.id, sibling.id].includes(issue.unitId)).every(issue => !issue.resolvedAt));
  const confirmed = await f.save(edited, { action: 'confirm' });
  assert.equal(confirmed.status, 'proofread'); assert.equal(confirmed.revision, edited.revision + 1);
  assert.equal(confirmed.confirmation.source, 'human'); assert.equal(confirmed.review, undefined);
  current = await f.texts(); linked = current.find(unit => unit.id === sibling.id);
  assert.equal(linked.status, 'translated'); assert.deepEqual(linked.review, sibling.review);
  const issues = (await f.detail()).issues;
  assert.ok(issues.filter(issue => issue.unitId === selected.id).every(issue => issue.resolvedAt));
  assert.ok(issues.filter(issue => issue.unitId === sibling.id).every(issue => !issue.resolvedAt));
});

test('service pending intent alone preserves proofread text and records a repeat-import-idempotent question', async t => {
  const f = await fixture(t, { seed: (_unit, index) => ({ status: 'proofread', translation: index === 1 || index === 2 ? '关联显示 {{name}}' : `定稿 ${index} {{name}}` }), scopePositions: [0] });
  const before = (await f.texts())[0], directory = await f.export();
  await expectReviewDisplay(f, before.id, { proofread: 4, translated: 0, needsEvidence: 0, targetProofread: true, targetNeedsEvidence: false });
  await f.edit(directory, records => { records[0].intent = 'pending'; });
  assert.equal((await f.import(directory)).accepted, 1);
  const pending = (await f.texts())[0];
  assert.equal(pending.translation, before.translation); assert.equal(pending.status, 'proofread');
  assert.equal(pending.revision, before.revision + 1); assert.equal(pending.review.status, 'needs_evidence');
  await expectReviewDisplay(f, before.id, { proofread: 3, translated: 1, needsEvidence: 1, targetProofread: false, targetNeedsEvidence: true });
  const questions = (await f.detail()).issues.filter(issue => issue.category === 'text-question' && !issue.resolvedAt);
  assert.equal(questions.length, 1);
  assert.equal((await f.import(directory)).accepted, 0);
  assert.deepEqual((await f.texts())[0], pending);
  assert.equal((await f.detail()).issues.filter(issue => issue.category === 'text-question' && !issue.resolvedAt).length, 1);
  await expectReviewDisplay(f, before.id, { proofread: 3, translated: 1, needsEvidence: 1, targetProofread: false, targetNeedsEvidence: true });
  const confirmed = await f.save(pending, { action: 'confirm' });
  assert.equal(confirmed.status, 'proofread'); assert.equal(confirmed.review, undefined);
  await expectReviewDisplay(f, before.id, { proofread: 4, translated: 0, needsEvidence: 0, targetProofread: true, targetNeedsEvidence: false });
});

test('translation package notes alone neither approves pending text nor closes existing evidence', async t => {
  const f = await fixture(t, { seed: unit => ({ status: 'pending', translation: unit.source, review: openReview(unit.id) }), scopePositions: [0], issuePositions: [0] });
  const before = (await f.texts())[0], directory = await f.export();
  await f.edit(directory, records => { records[0].notes = '只添加线索，不确认译文。'; });
  assert.equal((await f.import(directory)).accepted, 1);
  const after = (await f.texts())[0];
  assert.equal(after.status, 'pending'); assert.equal(after.translation, before.translation);
  assert.deepEqual(after.review, before.review); assert.equal(after.confirmation, undefined);
  assert.equal(after.revision, before.revision + 1);
  assert.ok((await f.detail()).issues.filter(issue => issue.unitId === before.id).every(issue => !issue.resolvedAt));
  assert.equal((await f.import(directory)).accepted, 0);
});

test('translation stage body changes become translated rather than silently proofread', async t => {
  const f = await fixture(t, { seed: unit => ({ status: 'pending', translation: unit.source }), scopePositions: [0] });
  const before = (await f.texts())[0], directory = await f.export();
  await f.edit(directory, records => { records[0].translation = '外部完整初译 {{name}}'; });
  assert.equal((await f.import(directory)).accepted, 1);
  const after = (await f.texts())[0];
  assert.equal(after.status, 'translated'); assert.equal(after.translation, '外部完整初译 {{name}}');
  assert.equal(after.confirmation, undefined); assert.equal(after.revision, before.revision + 1);
});

test('proofreading stage explicit submit has external provenance and repeated imports do not advance revisions', async t => {
  const f = await fixture(t, { mode: 'proofreading', scopePositions: [0], issuePositions: [0] });
  const before = (await f.texts())[0], directory = await f.export(), manifest = await load(directory, 'manifest.json');
  assert.equal(manifest.taskStage, 'proofreading');
  assert.equal((await f.import(directory)).accepted, 1);
  const after = (await f.texts())[0];
  assert.equal(after.status, 'proofread'); assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(after.confirmation, { source: 'external', packageId: manifest.packageId, stage: 'proofreading' });
  assert.ok((await f.detail()).issues.filter(issue => issue.unitId === before.id).every(issue => issue.resolvedAt));
  assert.equal((await f.import(directory)).accepted, 0); assert.deepEqual((await f.texts())[0], after);
});

test('proofreading keep intent does not approve a target or close its question', async t => {
  const f = await fixture(t, { mode: 'proofreading', scopePositions: [0], issuePositions: [0] });
  const before = (await f.texts())[0], directory = await f.export();
  await f.edit(directory, records => { records[0].intent = 'keep'; });
  assert.equal((await f.import(directory)).accepted, 0); assert.deepEqual((await f.texts())[0], before);
  assert.ok((await f.detail()).issues.filter(issue => issue.unitId === before.id).every(issue => !issue.resolvedAt));
});

test('legacy 0.1 has unknown stage even when its prose originated from proofreading', async t => {
  const f = await fixture(t, { mode: 'proofreading', scopePositions: [0] }), directory = await f.export();
  const manifest = await load(directory, 'manifest.json'); manifest.version = '0.1';
  delete manifest.taskStage; delete manifest.referenceUnitIds;
  manifest.requiredCapabilities = ['three-way-merge', 'editable-json'];
  delete manifest.files['context/reference-units.json'];
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  await f.edit(directory, records => { records[0].notes = '旧包只有备注，无审定声明。'; });
  assert.equal((await f.import(directory)).accepted, 1);
  const after = (await f.texts())[0];
  assert.equal(after.status, 'translated'); assert.equal(after.confirmation, undefined);
});

test('service scoped export uses closed editable IDs and immutable full-project reference material', async t => {
  const f = await fixture(t, { mode: 'review-issues', scopePositions: [1] }), before = await f.texts(), directory = await f.export();
  const manifest = await load(directory, 'manifest.json');
  assert.deepEqual(manifest.unitIds, before.slice(1, 3).map(unit => unit.id));
  assert.deepEqual(manifest.referenceUnitIds, [before[0].id, before[3].id]); assert.equal(manifest.taskStage, 'proofreading');
  assert.deepEqual((await load(directory, 'editable/units.json')).map(row => row.id), manifest.unitIds);
  assert.equal((await load(directory, 'context/reference-units.json')).length, 2);
  assert.equal((await load(directory, 'context/scenes.json')).length, 4);
  assert.match(await readFile(path.join(directory, 'START_HERE.md'), 'utf8'), /目标条数：2/);
  await f.edit(directory, records => { records.forEach(record => { record.intent = 'keep'; }); });
  assert.equal((await f.import(directory)).accepted, 0); assert.deepEqual(await f.texts(), before);
});

test('concurrent local and external text edits conflict atomically without committing another target', async t => {
  const f = await fixture(t, { scopePositions: [0, 3] }), before = await f.texts(), directory = await f.export();
  await f.save(before[0], { translation: '本地完整修订 {{name}}' });
  await f.edit(directory, records => { records[0].translation = '外部不同修订 {{name}}'; records[1].translation = '外部另一条修订 {{name}}'; });
  const first = await f.import(directory);
  assert.equal(first.accepted, 0); assert.equal(first.conflicts.length, 1);
  const after = await f.texts(); assert.equal(after[0].translation, '本地完整修订 {{name}}'); assert.deepEqual(after[3], before[3]);
  assert.equal((await f.import(directory)).conflicts.length, 1); assert.deepEqual(await f.texts(), after);
  assert.equal((await f.detail()).issues.filter(issue => issue.category === 'merge-conflict' && !issue.resolvedAt).length, 1);
});

test('unchanged external text preserves a concurrent local edit while clean external notes merge once', async t => {
  const f = await fixture(t, { scopePositions: [0] }), before = (await f.texts())[0], directory = await f.export();
  const local = await f.save(before, { translation: '本地已更新文字 {{name}}' });
  await f.edit(directory, records => { records[0].notes = '外部独立补充的线索。'; });
  const result = await f.import(directory); assert.equal(result.accepted, 1); assert.deepEqual(result.conflicts, []);
  const after = (await f.texts())[0]; assert.equal(after.translation, local.translation); assert.equal(after.notes, '外部独立补充的线索。');
  assert.equal(after.status, 'translated'); assert.equal(after.revision, local.revision + 1);
  assert.equal((await f.import(directory)).accepted, 0); assert.deepEqual((await f.texts())[0], after);
});

test('an old proofreading package cannot approve newer local text while its independent notes still merge', async t => {
  const f = await fixture(t, { mode: 'proofreading', scopePositions: [0], issuePositions: [0],
    seed: (unit, index) => ({ status: 'translated', translation: index === 1 || index === 2 ? '关联显示 {{name}}' : `初译 ${index} {{name}}`, review: openReview(unit.id) }) });
  const before = (await f.texts())[0], directory = await f.export();
  const local = await f.save(before, { translation: '本地新版完整文字 {{name}}' });
  await f.edit(directory, records => { records[0].notes = '外部针对导出版本补充的独立线索。'; });
  const result = await f.import(directory);
  assert.equal(result.accepted, 1); assert.deepEqual(result.conflicts, []);
  const after = (await f.texts())[0];
  assert.equal(after.translation, local.translation); assert.equal(after.status, 'translated');
  assert.equal(after.notes, '外部针对导出版本补充的独立线索。'); assert.equal(after.revision, local.revision + 1);
  assert.equal(after.confirmation, undefined); assert.deepEqual(after.review, local.review);
  assert.equal(after.review.status, 'needs_evidence');
  const issues = (await f.detail()).issues.filter(issue => issue.unitId === before.id);
  assert.equal(issues.length, 2); assert.ok(issues.every(issue => !issue.resolvedAt));
  assert.equal((await f.import(directory)).accepted, 0); assert.deepEqual((await f.texts())[0], after);
});

test('an old proofreading package cannot clear a concurrent local evidence note without reviewing that version', async t => {
  const f = await fixture(t, { mode: 'proofreading', scopePositions: [0], issuePositions: [0],
    seed: (unit, index) => ({ status: 'translated', translation: index === 1 || index === 2 ? '关联显示 {{name}}' : `初译 ${index} {{name}}`, review: openReview(unit.id) }) });
  const before = (await f.texts())[0], directory = await f.export();
  const local = await f.save(before, { notes: '导出后发现的新疑点：身份仍须证据核实。' });
  const result = await f.import(directory);
  assert.equal(result.accepted, 0); assert.deepEqual(result.conflicts, []);
  const after = (await f.texts())[0];
  assert.equal(after.translation, before.translation); assert.equal(after.status, 'translated');
  assert.equal(after.notes, local.notes); assert.equal(after.revision, local.revision);
  assert.equal(after.confirmation, undefined); assert.deepEqual(after.review, local.review);
  assert.equal(after.review.status, 'needs_evidence');
  const issues = (await f.detail()).issues.filter(issue => issue.unitId === before.id);
  assert.equal(issues.length, 2); assert.ok(issues.every(issue => !issue.resolvedAt));
  assert.equal((await f.import(directory)).accepted, 0); assert.deepEqual((await f.texts())[0], after);
});

test('a replayed pending intent cannot reopen human confirmation but changed notes can ask a new question', async t => {
  const f = await fixture(t, { scopePositions: [0] }), before = (await f.texts())[0], directory = await f.export();
  await f.edit(directory, records => { records[0].intent = 'pending'; });
  assert.equal((await f.import(directory)).accepted, 1);
  const questioned = (await f.texts())[0];
  assert.equal(questioned.review.status, 'needs_evidence');
  await expectReviewDisplay(f, before.id, { proofread: 0, translated: 4, needsEvidence: 1, targetProofread: false, targetNeedsEvidence: true });
  const confirmed = await f.save(questioned, { action: 'confirm' });
  assert.equal(confirmed.status, 'proofread'); assert.equal(confirmed.review, undefined);
  await expectReviewDisplay(f, before.id, { proofread: 1, translated: 3, needsEvidence: 0, targetProofread: true, targetNeedsEvidence: false });
  const resolved = (await f.detail()).issues.filter(issue => issue.unitId === before.id && issue.category === 'text-question');
  assert.equal(resolved.length, 1); assert.ok(resolved[0].resolvedAt);
  const replay = await f.import(directory);
  assert.equal(replay.accepted, 0); assert.deepEqual(replay.conflicts, []);
  assert.deepEqual((await f.texts())[0], confirmed);
  await expectReviewDisplay(f, before.id, { proofread: 1, translated: 3, needsEvidence: 0, targetProofread: true, targetNeedsEvidence: false });
  assert.deepEqual((await f.detail()).issues.filter(issue => issue.unitId === before.id && issue.category === 'text-question'), resolved);
  await f.edit(directory, records => { records[0].notes = '同包新增的问题：本次称呼仍需补证据。'; });
  const fresh = await f.import(directory);
  assert.equal(fresh.accepted, 1); assert.deepEqual(fresh.conflicts, []);
  const reopened = (await f.texts())[0];
  assert.equal(reopened.translation, confirmed.translation); assert.equal(reopened.status, confirmed.status);
  assert.equal(reopened.revision, confirmed.revision + 1); assert.equal(reopened.review.status, 'needs_evidence');
  assert.equal(reopened.notes, '同包新增的问题：本次称呼仍需补证据。');
  await expectReviewDisplay(f, before.id, { proofread: 0, translated: 4, needsEvidence: 1, targetProofread: false, targetNeedsEvidence: true });
  const questions = (await f.detail()).issues.filter(issue => issue.unitId === before.id && issue.category === 'text-question');
  assert.equal(questions.filter(issue => !issue.resolvedAt).length, 1);
  assert.equal(questions.find(issue => !issue.resolvedAt).message, reopened.notes);
  assert.ok(questions.find(issue => issue.id === resolved[0].id).resolvedAt);
  assert.equal((await f.import(directory)).accepted, 0); assert.deepEqual((await f.texts())[0], reopened);
  await expectReviewDisplay(f, before.id, { proofread: 0, translated: 4, needsEvidence: 1, targetProofread: false, targetNeedsEvidence: true });
});

test('replaying an accepted submit after later local editing cannot overwrite text or invent a merge conflict', async t => {
  const f = await fixture(t, { scopePositions: [0] }), directory = await f.export();
  await f.edit(directory, records => { records[0].translation = '已接纳的外部完整修订 {{name}}'; });
  assert.equal((await f.import(directory)).accepted, 1);
  const accepted = (await f.texts())[0];
  const local = await f.save(accepted, { translation: '后来人工更新的完整文字 {{name}}' });
  const result = await f.import(directory);
  assert.equal(result.accepted, 0); assert.equal(result.unchanged, 1); assert.deepEqual(result.conflicts, []);
  assert.deepEqual((await f.texts())[0], local);
  assert.equal((await f.detail()).issues.filter(issue => issue.category === 'merge-conflict').length, 0);
  assert.equal((await f.import(directory)).accepted, 0); assert.deepEqual((await f.texts())[0], local);
});

test('offline external translation and explicit proofreading package stages need no model configuration or started project', async t => {
  const f = await fixture(t, { offline: true, scopePositions: [0], seed: unit => ({ status: 'pending', translation: unit.source }) });
  const settings = (await f.service.snapshot()).settings;
  assert.equal(settings.connection.model, ''); assert.notEqual(settings.connection.hasKey, true);
  const before = (await f.texts())[0], translationPackage = await f.export({ taskStage: 'translation' });
  assert.equal((await load(translationPackage, 'manifest.json')).taskStage, 'translation');
  await f.edit(translationPackage, records => { records[0].translation = '离线外部完成的初译 {{name}}'; });
  assert.equal((await f.import(translationPackage)).accepted, 1);
  const translated = (await f.texts())[0]; assert.equal(translated.status, 'translated'); assert.equal(translated.confirmation, undefined);
  const proofreadingPackage = await f.export({ taskStage: 'proofreading' });
  const manifest = await load(proofreadingPackage, 'manifest.json');
  assert.equal(manifest.taskStage, 'proofreading'); assert.deepEqual(manifest.unitIds, [before.id]);
  assert.equal((await f.detail()).runMode, 'translation', 'Offline package stage must not be inferred by starting or changing a project run');
  assert.equal((await f.import(proofreadingPackage)).accepted, 1);
  const reviewed = (await f.texts())[0]; assert.equal(reviewed.status, 'proofread'); assert.equal(reviewed.translation, translated.translation);
  assert.deepEqual(reviewed.confirmation, { source: 'external', packageId: manifest.packageId, stage: 'proofreading' });
  assert.equal((await f.detail()).tasks.length, 0, 'External handoff must not enqueue internal translation or proofreading');
});

test('offline proofreading export refuses an empty translated baseline without starting tasks', async t => {
  const f = await fixture(t, { offline: true, scopePositions: [0], seed: unit => ({ status: 'pending', translation: unit.source }) });
  const before = await f.texts();
  await assert.rejects(f.export({ taskStage: 'proofreading' }), /尚无可导出校对的译文/);
  assert.deepEqual(await f.texts(), before); assert.equal((await f.detail()).tasks.length, 0);
});
