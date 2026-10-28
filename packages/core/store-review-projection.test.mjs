import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from './store.mjs';
import { createStore as createWorkspaceStore } from './workspace-store.mjs';
import { createService, defaultSettings } from './service.mjs';
import { sha256 } from '../exchange/index.mjs';

const row = (id, status = 'proofread', needs = false) => ({ id, source: `Neutral source ${id}.`, translation: `中性译文 ${id}。`,
  notes: '', revision: 0, sourceHash: `source-${id}`, status, ...(needs ? { review: { status: 'needs_evidence' } } : {}) });
const page = (store, filter, search = '') => store.page('project', { filter, search, offset: 0, limit: 100 });
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-review-projection-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 30 })); return root;
}

test('review-aware counts, searched pages and lightweight progress project pending evidence without changing stored state', async t => {
  const directory = await temporary(t), store = createStore(directory);
  try {
    const units = [row('approved'), row('question', 'proofread', true), row('translated-question', 'translated', true),
      row('pending-question', 'pending', true), row('skipped-question', 'skipped', true), row('null-review')];
    units[5].review = null;
    units.forEach((unit, index) => store.putUnit('project', unit, index));
    assert.deepEqual(store.counts('project'), { total: 6, proofread: 2, translated: 2, skipped: 1, needsEvidence: 4 });
    assert.deepEqual(page(store, 'proofread').units.map(unit => unit.id), ['approved', 'null-review']);
    assert.deepEqual(page(store, 'translated').units.map(unit => unit.id), ['question', 'translated-question']);
    assert.equal(page(store, 'needs_evidence').total, 4); assert.equal(page(store, 'needs_evidence', 'question').units.length, 4);
    assert.equal(page(store, 'proofread', 'question').total, 0);
    assert.equal(page(store, 'translated', 'question').total, 2);
    assert.deepEqual(store.unitProgress('project', 'question'), { id: 'question', status: 'translated' });
    assert.equal(store.unitProgress('project').filter(unit => unit.status === 'proofread').length, 2);
    assert.ok(store.unitProgress('project').every(unit => Object.keys(unit).join(',') === 'id,status'));
    assert.equal(store.unit('project', 'question').status, 'proofread');
    assert.equal(store.unitIndex('project').find(unit => unit.id === 'question').status, 'proofread', 'Planning status is not a display projection');
    assert.equal(store.unitProgress('project', 'missing'), undefined);
  } finally { store.close(); }
  const reopened = createStore(directory);
  try {
    assert.deepEqual(reopened.counts('project'), { total: 6, proofread: 2, translated: 2, skipped: 1, needsEvidence: 4 });
    assert.equal(page(reopened, 'proofread').total, 2); assert.equal(page(reopened, 'needs_evidence').total, 4);
    assert.deepEqual(reopened.unitProgress('project', 'question'), { id: 'question', status: 'translated' });
  } finally { reopened.close(); }
});

test('review-only edits update the warm count cache and rollback/external writes agree with cold SQL', async t => {
  const directory = await temporary(t), store = createStore(directory), external = createStore(directory);
  let aggregates = 0; const original = store.db.prepare.bind(store.db);
  store.db.prepare = sql => {
    const statement = original(sql); if (!sql.includes('SUM(CASE')) return statement;
    const get = statement.get.bind(statement); statement.get = (...args) => { aggregates++; return get(...args); }; return statement;
  };
  try {
    store.putUnit('project', row('one'));
    assert.equal(store.counts('project').proofread, 1);
    store.putUnit('project', row('one', 'proofread', true));
    assert.deepEqual(store.counts('project'), { total: 1, proofread: 0, translated: 1, skipped: 0, needsEvidence: 1 });
    assert.equal(page(store, 'needs_evidence').total, 1); assert.equal(aggregates, 1);
    assert.throws(() => store.transaction(() => {
      store.putUnit('project', row('one')); assert.equal(store.counts('project').proofread, 1); throw new Error('rollback');
    }), /rollback/);
    assert.equal(store.counts('project').needsEvidence, 1); assert.equal(aggregates, 2);
    external.putUnit('project', row('one'));
    assert.deepEqual(store.counts('project'), { total: 1, proofread: 1, translated: 0, skipped: 0, needsEvidence: 0 });
    assert.equal(aggregates, 3); assert.equal(page(store, 'needs_evidence').total, 0);
    assert.deepEqual(store.unitProgress('project', 'one'), { id: 'one', status: 'proofread' });
  } finally { store.close(); external.close(); }
});

test('workspace empty display projections include the evidence count without creating a project database', async t => {
  const store = createWorkspaceStore(await temporary(t));
  try {
    assert.deepEqual(store.counts('missing'), { total: 0, proofread: 0, translated: 0, skipped: 0, needsEvidence: 0 });
    assert.deepEqual(store.unitProgress('missing'), []); assert.equal(store.unitProgress('missing', 'unit'), undefined);
  } finally { store.close(); }
});

test('pending package import and explicit confirmation change store display counts and filters while retaining terminal scheduling state', async t => {
  const root = await temporary(t), gameDir = path.join(root, 'neutral-original'), dataDir = path.join(root, 'data');
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'neutral.txt'), 'Immutable neutral fixture.');
  const units = [row('neutral')]; let calls = 0;
  const service = await createService({ dataDir, scriptTools: null, provider: async () => { calls++; throw new Error('No model request permitted'); },
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral native fixture', selectedCandidateIds: [] }),
    worker: async (command, args) => {
      if (command === 'probe') return { engine: 'MZ' };
      if (command === 'extract') { await mkdir(args.workspaceDir, { recursive: true }); return { units, workspaceDir: args.workspaceDir, sourceFingerprint: sha256(units) }; }
      if (['roundtrip', 'validate'].includes(command)) return { ok: true };
      if (command === 'zip') { await cp(args.sourceDir, args.filePath, { recursive: true }); return {}; }
      if (command === 'unzip') { await cp(args.filePath, args.outputDir, { recursive: true }); return {}; }
      throw new Error(`Unexpected neutral worker command ${command}`);
    } });
  try {
    await service.saveSettings({ ...defaultSettings(), connection: { baseUrl: 'http://localhost:1/v1', model: 'neutral-no-network' } });
    const project = await service.createProject({ gameDir }), store = createWorkspaceStore(dataDir);
    try {
      const initial = store.units(project.id)[0], approved = { ...initial, translation: '已确认中性译文。', status: 'proofread', revision: initial.revision + 1 };
      store.putUnit(project.id, approved); store.addRevision(project.id, approved);
      store.patchProject(project.id, { runConfig: { mode: 'translation', targetLanguage: 'zh-Hans' } });
      assert.equal(store.counts(project.id).proofread, 1);
      const directory = path.join(root, 'neutral-package'); await service.exportPackage({ projectId: project.id, filePath: directory });
      const editable = JSON.parse(await readFile(path.join(directory, 'editable', 'units.json'), 'utf8'));
      editable[0].intent = 'pending'; await writeFile(path.join(directory, 'editable', 'units.json'), JSON.stringify(editable));
      await service.importPackage({ projectId: project.id, filePath: directory });
      const pending = store.units(project.id)[0];
      assert.equal(pending.status, 'proofread'); assert.equal(store.counts(project.id).proofread, 0);
      assert.equal(store.counts(project.id).translated, 1); assert.equal(store.counts(project.id).needsEvidence, 1);
      assert.equal((await service.listText({ projectId: project.id, filter: 'proofread', limit: 10 })).total, 0);
      assert.equal((await service.listText({ projectId: project.id, filter: 'needs_evidence', limit: 10 })).total, 1);
      assert.equal(store.unitProgress(project.id, pending.id).status, 'translated');
      await service.saveText({ projectId: project.id, unitId: pending.id, translation: pending.translation, expectedRevision: pending.revision, action: 'confirm' });
      assert.equal(store.counts(project.id).proofread, 1); assert.equal(store.counts(project.id).needsEvidence, 0);
      assert.equal((await service.listText({ projectId: project.id, filter: 'proofread', limit: 10 })).total, 1);
      assert.equal((await service.listText({ projectId: project.id, filter: 'needs_evidence', limit: 10 })).total, 0);
      assert.equal(store.unitProgress(project.id, pending.id).status, 'proofread');
    } finally { store.close(); }
    assert.equal(calls, 0);
  } finally { await service.close(); }
});
