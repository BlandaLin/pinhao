import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { scanTerminology, glossaryHash } from './glossary.mjs';
import { sha256 } from '../exchange/index.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('Neutral glossary recovery fixture timed out');
}

async function fixture(t, sourceUnits, provider, { concurrency = 3, skipGlossary = false, legacySingletons = false } = {}) {
  const parent = path.resolve('local/core-tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'glossary-recovery-'));
  const dataDir = path.join(root, 'data'), gameDir = path.join(root, 'original'); await mkdir(gameDir);
  const units = sourceUnits.map(unit => ({ legacyId: unit.id, tokens: [], revision: 0, notes: '', translation: unit.source,
    status: 'pending', sourceHash: sha256(unit.source), ...unit }));
  const store = createStore(dataDir), projectId = 'neutral-glossary-recovery';
  let glossary = scanTerminology(units, undefined, 'zh-Hans');
  if (skipGlossary || legacySingletons) {
    const entries = units.filter(unit => ['database_name', 'character_name'].includes(unit.kind)).map((unit, index) => ({
      id: `legacy-name-${index}`, source: unit.source, translation: unit.source, category: 'name', aliases: [], scope: {},
      status: skipGlossary ? 'skipped' : 'pending', revision: 0, unitIds: [unit.id], evidence: [] }));
    glossary = { version: 'pinhao-glossary-2', targetLanguage: 'zh-Hans', entries, prepared: skipGlossary, hash: glossaryHash(entries) };
  }
  store.put('projects', { id: projectId, name: 'Neutral glossary recovery', gameDir, engine: 'MZ', prepared: true,
      status: 'ready', stage: '文字工作台就绪', targetLanguage: 'zh-Hans', workspaceDir: path.join(root, 'workspace'),
      workbenchDir: path.join(root, 'workspace'), technicalPlan: { decision: 'native' }, sampleValidation: { nativeStructure: 'passed' },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', sourceFingerprint: sha256(units),
      inventory: {}, nameGlossary: glossary, coverage: { format: 1, unitCount: units.length, summary: { extracted: units.length },
        needsAdaptation: false, completeness: 'structural', triggers: [], resources: [], reviewItems: [], dynamicCandidates: [], imageCandidates: [] } });
  store.transaction(projectId, () => {
    units.forEach((unit, index) => { store.putUnit(projectId, unit, index); store.addRevision(projectId, unit); });
    if (legacySingletons) glossary.entries.forEach((entry, index) => store.putTask(projectId, { id: `legacy-${index}`, projectId,
      role: 'translation', kind: 'glossary', status: 'paused', fingerprint: `legacy-${entry.id}`, targetLanguage: 'zh-Hans',
      connection: { baseUrl: 'http://localhost:1/v1', model: 'neutral-fixture' }, promptVersion: 'pinhao-scenes-0.7',
      glossaryVersion: 'pinhao-glossary-2', unitIds: [], input: [{ id: entry.id, sourceHash: sha256(entry.source), revision: entry.revision }],
      attempts: 1, ...(index === 0 ? { candidateRecords: [{ id: entry.id, translation: '人物0000', notes: 'Saved neutral candidate' }] } : {}),
      createdAt: '2026-01-01T00:00:00.000Z' }));
  });
  store.close();
  const service = await createService({ dataDir, scriptTools: null, imageTools: null, provider,
    worker: async (command, args) => {
      if (command === 'catalog') return { engines: [] };
      if (['validate', 'roundtrip'].includes(command)) return { ok: true };
      if (['build', 'assemble'].includes(command)) {
        await mkdir(args.outputDir, { recursive: true }); await writeFile(path.join(args.outputDir, 'neutral.txt'), 'Neutral fixture output.');
        return command === 'build' ? { buildDir: args.outputDir } : { outputDir: args.outputDir, runtimeVerified: false };
      }
      throw new Error(`Unexpected neutral worker ${command}`);
    } });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); });
  await service.saveSettings({ ...defaultSettings(), concurrency, proofreading: false,
    connection: { baseUrl: 'http://localhost:1/v1', model: 'neutral-fixture', contextWindow: 32768, maxOutputTokens: 1200 } });
  const inspect = action => { const db = createStore(dataDir); try { return action(db); } finally { db.close(); } };
  return { service, projectId, inspect };
}

test('persistent translation disconnect drains 19 paid siblings and resumes from the saved partial candidate', { timeout: 30000 }, async t => {
  const units = Array.from({ length: 320 }, (_, index) => ({ id: `Actors:${index + 1}:name`, kind: 'database_name',
    source: `Person${String(index).padStart(4, '0')}`, context: { file: 'data/Actors.json', record: index + 1, field: 'name' } }));
  const initialWave = Promise.withResolvers(), recoveryExhausted = Promise.withResolvers(), calls = [], aborted = new Set(), drained = new Set();
  t.after(() => { initialWave.resolve(); recoveryExhausted.resolve(); });
  let outage = true, firstGroup, savedCandidateId, firstPartial = true, initialCalls = 0, failedAttempts = 0;
  const record = unit => ({ id: unit.id, translation: `人物${unit.source.match(/\d+/)[0]}`, notes: '' });
  const f = await fixture(t, units, async ({ role, prompt, signal, onRecords, wire }) => {
    const payload = wire.payload, ids = payload.units.map(unit => unit.id); calls.push({ role: payload.task, ids });
    assert.equal(payload.task, 'translation');
    if (!outage) {
      assert.equal(payload.repairInstruction, undefined, 'A connection interruption is not a translation error for the model to repair');
      return { records: payload.units.map(record) };
    }
    if (!firstGroup) firstGroup = new Set(ids);
    if (++initialCalls === 20) initialWave.resolve();
    if (ids.some(id => firstGroup.has(id))) {
      await initialWave.promise;
      if (firstPartial) { firstPartial = false; savedCandidateId = ids[0]; await onRecords([record(payload.units[0])]); }
      if (++failedAttempts === 3) recoveryExhausted.resolve();
      throw Object.assign(new Error('Cannot connect to API: other side closed'), { code: 'ECONNRESET' });
    }
    const abort = () => aborted.add(ids[0]);
    signal.addEventListener('abort', abort, { once: true });
    try {
      await recoveryExhausted.promise;
      signal.throwIfAborted();
      drained.add(ids[0]);
      return { records: payload.units.map(record) };
    } finally { signal.removeEventListener('abort', abort); }
  }, { concurrency: 20 });
  await f.service.startProject({ projectId: f.projectId, mode: 'translation' });
  const paused = await until(async () => { const project = await f.service.getProject({ projectId: f.projectId }); return project.status === 'paused' && project; });
  assert.equal(drained.size, 19, 'Already-sent sibling results are saved before the project pauses');
  assert.equal(aborted.size, 0, 'A temporary connection failure must not discard paid sibling responses');
  assert.equal(failedAttempts, 3, 'Transport recovery is bounded before pausing');
  assert.match(paused.lastError, /other side closed/);
  const checkpoint = f.inspect(db => db.tasks(f.projectId).find(task => task.candidateRecords?.some(item => item.id === savedCandidateId)));
  assert.ok(checkpoint, 'the valid partial translation candidate survives the global pause');
  assert.equal(calls.filter(call => call.ids.includes(savedCandidateId)).length, 1, 'local retries do not resend the checkpointed target');
  outage = false;
  const continued = await Promise.race([f.service.startProject({ projectId: f.projectId }), delay(3000).then(() => { throw new Error('Continue remained blocked by sibling requests'); })]);
  assert.equal(continued.status, 'running');
  const done = await until(async () => { const project = await f.service.getProject({ projectId: f.projectId }); return project.status === 'completed' && project; });
  assert.equal(done.translated, units.length); assert.equal(done.skipped, 0);
  assert.equal(calls.filter(call => call.ids.includes(savedCandidateId)).length, 1, 'resume retains the checkpointed translation target without another request');
  assert.equal(f.inspect(db => db.one('projects', f.projectId).nameGlossary.entries.every(entry => entry.status === 'confirmed')), true);
});

test('old generated glossary entries do not block ordinary first translation', { timeout: 15000 }, async t => {
  const requests = [];
  const f = await fixture(t, [{ id: 'Actors:1:name', kind: 'character_name', source: 'Alden', context: { file: 'data/Actors.json' } },
    { id: 'line-1', kind: 'message', source: 'Alden arrives.', context: { file: 'data/Map001.json', event: 1 } }], async ({ role, prompt, wire }) => {
    const payload = wire.payload; requests.push({ role: payload.task, payload });
    return { records: payload.units.map(unit => ({ id: unit.id, translation: unit.source === 'Alden' ? '奥登' : '奥登到了。' })) };
  }, { skipGlossary: true });
  await f.service.startProject({ projectId: f.projectId, mode: 'translation' });
  const done = await until(async () => { const project = await f.service.getProject({ projectId: f.projectId }); return project.status === 'completed' && project; });
  assert.equal(done.translated, 2);
  assert.equal(requests.some(request => request.role === 'glossary'), false);
  assert.equal(f.inspect(db => db.one('projects', f.projectId).nameGlossary.prepared), true);
});

test('an untranslated name and body share ordinary work without breaking atomic display groups', { timeout: 15000 }, async t => {
  const bodyCalls = [];
  const units = [{ id: 'name', kind: 'character_name', source: 'Alden', context: { file: 'data/Map001.json', event: 1 } },
    { id: 'dependent', kind: 'message', source: 'Alden arrives.', context: { file: 'data/Map001.json', event: 1, syncGroup: 'same-display' } },
    { id: 'linked', kind: 'message', source: 'He arrives.', context: { file: 'data/Map001.json', event: 1, syncGroup: 'same-display' } },
    { id: 'unrelated', kind: 'message', source: 'The door opens.', context: { file: 'data/Map001.json', event: 1 } }];
  const f = await fixture(t, units, async ({ role, prompt, signal, wire }) => {
    const payload = wire.payload;
    assert.equal(payload.task, 'translation');
    bodyCalls.push(payload);
    return { records: payload.units.map(unit => ({ id: unit.id, translation: unit.id === 'name' ? '奥登' : unit.id === 'unrelated' ? '门开了。' : '奥登到了。' })) };
  });
  await f.service.startProject({ projectId: f.projectId, mode: 'translation' });
  const done = await until(async () => { const project = await f.service.getProject({ projectId: f.projectId }); return project.status === 'completed' && project; });
  assert.equal(done.translated, units.length); assert.equal(done.skipped, 0);
  const dependent = bodyCalls.find(payload => payload.units.some(unit => unit.id === 'dependent'));
  assert.ok(dependent.units.some(unit => unit.id === 'linked'), 'one syncGroup is submitted together');
  assert.deepEqual(new Set(bodyCalls.flatMap(payload => payload.units.map(unit => unit.id))), new Set(units.map(unit => unit.id)));
  assert.ok(f.inspect(db => db.tasks(f.projectId)).every(task => !['glossary', 'glossary-repair'].includes(task.kind)));
});

test('legacy prerequisite tasks are cancelled with saved candidates retained while ordinary batches translate every name', { timeout: 15000 }, async t => {
  const units = Array.from({ length: 18 }, (_, index) => ({ id: `Actors:${index + 1}:name`, kind: 'database_name',
    source: `Person${String(index).padStart(4, '0')}`, context: { file: 'data/Actors.json', record: index + 1, field: 'name' } }));
  const requests = [];
  const f = await fixture(t, units, async ({ prompt, wire }) => {
    const payload = wire.payload;
    assert.equal(payload.task, 'translation'); requests.push(payload);
    return { records: payload.units.map(unit => ({ id: unit.id, translation: `人物${unit.source.match(/\d+/)[0]}` })) };
  }, { legacySingletons: true });
  await f.service.startProject({ projectId: f.projectId, mode: 'translation' });
  const done = await until(async () => { const project = await f.service.getProject({ projectId: f.projectId }); return project.status === 'completed' && project; });
  assert.equal(done.translated, units.length); assert.equal(done.skipped, 0);
  assert.deepEqual(requests.map(payload => payload.units.length).sort((a, b) => a - b), [2, 16]);
  assert.equal(requests.some(payload => payload.units.some(unit => unit.source === 'Person0000')), true, 'old terminology output is not silently applied as a dialogue/name translation');
  const legacy = f.inspect(db => db.tasks(f.projectId).filter(task => task.id.startsWith('legacy-')));
  assert.equal(legacy.length, 18); assert.ok(legacy.every(task => task.status === 'cancelled'));
  assert.deepEqual(legacy.find(task => task.id === 'legacy-0').candidateRecords,
    [{ id: 'legacy-name-0', translation: '人物0000', notes: 'Saved neutral candidate' }]);
});

test('whole-round proofreading disconnect drains three paid siblings and resumes saved scene candidates before D2 commit', { timeout: 30000 }, async t => {
  const units = Array.from({ length: 4 }, (_, scene) => Array.from({ length: scene === 0 ? 33 : 17 }, (_, index) => ({
    id: `scene-${scene}-${index}`, kind: 'dialogue', source: `Complete neutral scene ${scene} sentence ${index}.`,
    translation: `Existing neutral translation ${scene}-${index}.`, status: 'translated', revision: 1,
    context: { file: `data/Map00${scene + 1}.json`, map: `Map00${scene + 1}`, event: 1, page: 0, command: index },
  }))).flat();
  const siblingsEntered = Promise.withResolvers(), recoveryExhausted = Promise.withResolvers(), aborted = new Set(), drained = new Set(), siblingScopes = new Set(), calls = [];
  t.after(() => { siblingsEntered.resolve(); recoveryExhausted.resolve(); });
  let outage = true, savedCandidateId, failedAttempts = 0;
  const review = (payload, changed) => ({ review: { protocol: 'pinhao-review-1', reviewedIds: payload.units.map(unit => unit.id),
    issues: changed ? [{ unitId: changed.id, kind: 'correction', resolution: 'fixed', message: 'Neutral wording correction.' }] : [],
    edits: changed ? [{ id: changed.id, expectedRevision: changed.revision, translation: '校对后的中性文字。', notes: 'Saved scene candidate.' }] : [] } });
  const f = await fixture(t, units, async ({ prompt, signal, wire }) => {
    const payload = wire.payload, stage = payload.reviewScope?.stage, ids = payload.units.map(unit => unit.id);
    calls.push({ stage, ids }); assert.ok(stage, 'this test operates only through the frozen review protocol');
    if (!outage || stage !== 'scene') return review(payload);
    if (ids.some(id => id.startsWith('scene-0-'))) {
      savedCandidateId ??= ids[0];
      if (ids.includes(savedCandidateId)) return review(payload, payload.units.find(unit => unit.id === savedCandidateId));
      await siblingsEntered.promise;
      if (++failedAttempts === 3) recoveryExhausted.resolve();
      throw Object.assign(new Error('Cannot connect to API: other side closed during scene proofreading'), { code: 'ECONNRESET' });
    }
    siblingScopes.add(payload.reviewScope.id);
    if (siblingScopes.size === 3) siblingsEntered.resolve();
    const abort = () => aborted.add(payload.reviewScope.id);
    signal.addEventListener('abort', abort, { once: true });
    try {
      await recoveryExhausted.promise;
      signal.throwIfAborted();
      drained.add(payload.reviewScope.id);
      return review(payload);
    } finally { signal.removeEventListener('abort', abort); }
  }, { concurrency: 4 });
  await f.service.startProject({ projectId: f.projectId, mode: 'proofreading' });
  const paused = await until(async () => { const project = await f.service.getProject({ projectId: f.projectId }); return project.status === 'paused' && project; });
  assert.equal(drained.size, 3, 'Already-sent scene pages are saved before the project pauses');
  assert.equal(aborted.size, 0, 'Temporary transport recovery does not discard paid sibling reviews');
  assert.equal(failedAttempts, 3);
  assert.match(paused.lastError, /scene proofreading/);
  const checkpoint = f.inspect(db => db.tasks(f.projectId).find(task => task.reviewStage === 'scene'
    && task.candidateRecords?.some(record => record.id === savedCandidateId)));
  assert.ok(checkpoint, 'the successful first scene page is persisted before another page disconnects');
  assert.equal(checkpoint.candidateRecords.find(record => record.id === savedCandidateId).translation, '校对后的中性文字。');
  const beforeCommit = f.inspect(db => db.unit(f.projectId, savedCandidateId));
  assert.equal(beforeCommit.translation, units.find(unit => unit.id === savedCandidateId).translation, 'D2 keeps official text unchanged until every scene and any targeted follow-up finish');
  assert.equal(beforeCommit.revision, 1);
  const resumedAt = calls.length; outage = false;
  const continued = await Promise.race([f.service.startProject({ projectId: f.projectId }), delay(3000).then(() => { throw new Error('Proofreading continuation remained blocked by sibling requests'); })]);
  assert.equal(continued.status, 'running');
  const done = await until(async () => { const project = await f.service.getProject({ projectId: f.projectId }); return project.status === 'completed' && project; });
  assert.equal(done.proofread, units.length);
  assert.equal(calls.slice(resumedAt).some(call => call.stage === 'scene' && call.ids.includes(savedCandidateId)), false,
    'resumption does not pay for the accepted scene candidate again');
  assert.equal(calls.slice(resumedAt).some(call => call.stage === 'consistency'), false, 'Healthy saved scene results do not require a second paid review');
  assert.equal(f.inspect(db => db.unit(f.projectId, savedCandidateId).translation), '校对后的中性文字。');
  assert.equal(f.inspect(db => db.tasks(f.projectId).some(task => task.reviewStage === 'scene' && task.status === 'succeeded'
    && task.candidateRecords?.some(record => record.id === savedCandidateId))), true);
});
