import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { sha256 } from '../exchange/index.mjs';

const rootPath = path.resolve('local/core-tests');
await mkdir(rootPath, { recursive: true });
const secrets = { encrypt: value => `neutral:${value}`, decrypt: value => value.slice(8) };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await sleep(10); }
  throw new Error(message);
}
const unit = (id, source, extra = {}) => ({ id, source, kind: 'message', tokens: [],
  context: { file: 'neutral.json', event: id }, ...extra });
const review = (payload, edits = []) => ({ review: { protocol: 'pinhao-review-1', reviewedIds: payload.units.map(row => row.id), edits,
  issues: edits.map(edit => ({ unitId: edit.id, kind: 'correction', resolution: 'fixed', message: '采用同一人物的已确认多数译名。' })) } });

async function fixture(t, { units, provider, proofreading = false, configure } = {}) {
  const root = await mkdtemp(path.join(rootPath, 'terminology-flow-'));
  const dataDir = path.join(root, 'data'), gameDir = path.join(root, 'original');
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'original.txt'), 'Neutral fixture only.');
  const worker = async (command, args) => {
    if (command === 'probe') return { engine: 'MZ' };
    if (command === 'extract') { await mkdir(args.workspaceDir, { recursive: true }); return { units, workspaceDir: args.workspaceDir, sourceFingerprint: sha256(units) }; }
    if (command === 'roundtrip' || command === 'validate') return { ok: true };
    if (command === 'zip') { await cp(args.sourceDir, args.filePath, { recursive: true }); return { path: args.filePath }; }
    if (command === 'unzip') { await cp(args.filePath, args.outputDir, { recursive: true }); return { outputDir: args.outputDir }; }
    if (command === 'build') { await mkdir(args.outputDir, { recursive: true }); return { buildDir: args.outputDir }; }
    if (command === 'assemble') { await mkdir(args.outputDir, { recursive: true }); await writeFile(path.join(args.outputDir, 'Game.exe'), 'Neutral fixture executable placeholder.'); return { outputDir: args.outputDir, runtimeVerified: false }; }
    throw new Error(`Unexpected neutral worker command: ${command}`);
  };
  const open = () => createService({ dataDir, worker, secrets, provider, scriptTools: null,
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral native fixture route.', selectedCandidateIds: [] }) });
  const f = { root, dataDir, gameDir, service: await open(),
    async reopen() { await f.service.close(); f.service = await open(); } };
  t.after(async () => { await f.service.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }); });
  const settings = defaultSettings(); settings.concurrency = 1; settings.proofreading = proofreading;
  settings.connection = { baseUrl: 'https://neutral.invalid/v1', model: 'neutral-shared', apiKey: 'neutral-fixture-key' };
  configure?.(settings); await f.service.saveSettings(settings);
  const project = await f.service.createProject({ gameDir }); f.projectId = project.id;
  return f;
}
async function completed(f) {
  return until(async () => {
    const current = await f.service.getProject({ projectId: f.projectId });
    if (current.status === 'paused') throw new Error(`Unexpected neutral pause: ${current.lastError}`);
    return current.status === 'completed' && current;
  }, 'Neutral terminology flow did not complete');
}
function inspect(f, read) {
  const store = createStore(f.dataDir);
  try { return read(store); } finally { store.close(); }
}

test('first translation needs no glossary prerequisite or retry when optional terms are absent', async t => {
  const calls = [];
  const f = await fixture(t, { units: [unit('name', 'リナ', { kind: 'character_name' })], provider: async ({ role, wire }) => {
    calls.push({ role, task: wire.payload.task, ids: wire.payload.units.map(row => row.id) });
    assert.equal(role, 'translation'); assert.equal(wire.payload.task, 'translation');
    return { records: wire.payload.units.map(row => ({ id: row.id, translation: '莉娜', notes: '' })) };
  } });
  await f.service.startProject({ projectId: f.projectId, mode: 'translation' }); await completed(f);
  assert.equal(calls.length, 1, 'Missing optional terms do not buy another response');
  const stored = inspect(f, store => ({ units: store.units(f.projectId), tasks: store.tasks(f.projectId) }));
  assert.equal(stored.units[0].translation, '莉娜'); assert.equal(stored.units[0].status, 'translated');
  assert.equal(stored.units[0].termChoices, undefined);
  assert.ok(stored.tasks.every(task => !['glossary', 'glossary-repair'].includes(task.kind)));
});

test('accepted term choices survive pause, process close and ordinary continuation without buying accepted text again', async t => {
  const calls = [], units = Array.from({ length: 33 }, (_, index) => unit(`line-${index}`, `Alice speaks neutral line ${index}.`,
    { context: { file: 'neutral.json', event: index, actorId: 1, speaker: 'Alice' } }));
  let firstId, blocked = false, hold = true;
  const f = await fixture(t, { units, provider: async ({ role, wire, signal }) => {
    const payload = wire.payload; assert.equal(payload.task, 'translation'); assert.equal(role, 'translation');
    if (!hold) assert.equal(payload.repairInstruction, undefined, 'A user pause is not a language mistake');
    calls.push(payload.units.map(row => row.id));
    if (firstId && hold) {
      blocked = true;
      await new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error('Neutral pause.'));
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      });
    }
    firstId ??= payload.units[0].id;
    return { records: payload.units.map(row => ({ id: row.id, translation: '爱丽丝说了一句完整台词。', notes: '',
      termChoices: [{ source: 'Alice', translation: '爱丽丝' }] })) };
  } });
  await f.service.startProject({ projectId: f.projectId, mode: 'translation' });
  await until(() => blocked, 'A later neutral batch never entered');
  await f.service.pauseProject({ projectId: f.projectId });
  const before = inspect(f, store => store.unit(f.projectId, firstId));
  assert.equal(before.status, 'translated'); assert.deepEqual(before.termChoices, [{ source: 'Alice', translation: '爱丽丝' }]);
  // Actual pre-transport aborts can have only DOMException code 20, without a provider category.
  inspect(f, store => {
    for (const task of store.tasks(f.projectId).filter(task => task.status === 'paused')) store.putTask(f.projectId, {
      ...task, error: 'This operation was aborted', lastFailure: { code: 20 },
    });
  });
  hold = false; await f.reopen();
  const reopened = inspect(f, store => store.unit(f.projectId, firstId));
  assert.equal(reopened.translation, before.translation); assert.equal(reopened.revision, before.revision);
  assert.deepEqual(reopened.termChoices, before.termChoices);
  await f.service.startProject({ projectId: f.projectId }); await completed(f);
  assert.equal(calls.flat().filter(id => id === firstId).length, 1);
  assert.equal(inspect(f, store => store.units(f.projectId).filter(row => row.termChoices?.length === 1).length), units.length);
  assert.ok(inspect(f, store => store.tasks(f.projectId)).every(task => !['glossary', 'glossary-repair'].includes(task.kind)));
});

test('persisted obsolete prerequisite jobs are cancelled rather than sent to a model', async t => {
  const calls = [];
  const f = await fixture(t, { units: [unit('name', 'Alice', { kind: 'character_name' })], provider: async ({ wire }) => {
    assert.equal(wire.payload.task, 'translation'); calls.push(wire.payload.task);
    return { records: wire.payload.units.map(row => ({ id: row.id, translation: '爱丽丝' })) };
  } });
  await f.service.close();
  inspect(f, store => {
    for (const [index, kind] of ['glossary', 'glossary-repair'].entries()) store.putTask(f.projectId, {
      id: `obsolete-${index}`, projectId: f.projectId, fingerprint: `obsolete-neutral-${index}`, kind, role: 'translation',
      status: 'queued', targetLanguage: 'zh-Hans', unitIds: [], input: [], attempts: 0,
      connection: { baseUrl: 'https://unused.invalid/v1', model: '' } });
  });
  await f.reopen(); await f.service.startProject({ projectId: f.projectId, mode: 'translation' }); await completed(f);
  assert.deepEqual(calls, ['translation']);
  const obsolete = inspect(f, store => store.tasks(f.projectId).filter(task => task.id.startsWith('obsolete-')));
  assert.equal(obsolete.length, 2);
  assert.ok(obsolete.every(task => task.status === 'cancelled'));
});

for (const method of ['manual', 'exchange']) test(`${method} dialogue edits discard obsolete name votes without buying new text`, async t => {
  let calls = 0;
  const f = await fixture(t, { units: [unit('dialogue', 'Alice comes home.', { context: { speaker: 'Alice', actorId: 1, file: 'scene.json' } })],
    provider: async ({ wire }) => { calls++; return { records: wire.payload.units.map(row => ({ id: row.id, translation: '爱丽丝回家了。',
      termChoices: [{ source: 'Alice', translation: '爱丽丝' }] })) }; } });
  await f.service.startProject({ projectId: f.projectId, mode: 'translation' }); await completed(f);
  assert.equal(inspect(f, store => store.one('projects', f.projectId).nameGlossary.entries.length), 1);
  const [before] = (await f.service.listText({ projectId: f.projectId })).units;
  if (method === 'manual') await f.service.saveText({ projectId: f.projectId, unitId: before.id,
    translation: '她已经回家了。', expectedRevision: before.revision });
  else {
    const filePath = path.join(f.root, 'returned.zip');
    await f.service.exportPackage({ projectId: f.projectId, filePath });
    const editable = path.join(filePath, 'editable', 'units.json'), rows = JSON.parse(await readFile(editable, 'utf8'));
    rows[0].translation = '她已经回家了。'; await writeFile(editable, JSON.stringify(rows));
    assert.equal((await f.service.importPackage({ projectId: f.projectId, filePath })).accepted, 1);
  }
  const [after] = (await f.service.listText({ projectId: f.projectId })).units;
  assert.equal(after.translation, '她已经回家了。'); assert.equal(after.termChoices, undefined);
  assert.deepEqual(inspect(f, store => store.one('projects', f.projectId).nameGlossary.entries), []);
  assert.equal(calls, 1);
});

test('post-translation review gets only related disagreements and uses the translation connection despite an invalid old override', async t => {
  const input = [unit('alice-name', 'Alice', { kind: 'character_name', context: { file: 'Actors.json', record: 1, actorId: 1 } }),
    unit('bobby-name', 'Bobby', { kind: 'character_name', context: { file: 'Actors.json', record: 2, actorId: 2 } }),
    ...['Alice', 'Bobby'].flatMap((speaker, actor) => Array.from({ length: 16 }, (_, index) => unit(`${speaker}-${index}`,
      `${speaker} says neutral line ${index}.`, { context: { file: 'neutral.json', event: actor * 16 + index, actorId: actor + 1, speaker } })))];
  const reviewed = [], translationCalls = [];
  const f = await fixture(t, { units: input, proofreading: true, configure: settings => {
    settings.roles.translation = { useShared: false, connection: { baseUrl: 'https://translation.invalid/v1', model: 'translation-only', apiKey: 'neutral-translation-key' } };
    settings.roles.proofreading = { useShared: false, connection: { baseUrl: 'https://obsolete-proofreading.invalid/v1', model: '' } };
  }, provider: async ({ role, connection, wire }) => {
    const payload = wire.payload;
    assert.equal(connection.model, 'translation-only'); assert.equal(connection.baseUrl, 'https://translation.invalid/v1');
    if (role === 'proofreading') {
      reviewed.push(payload);
      const edits = payload.units.filter(row => /艾莉丝|巴比/.test(row.currentTranslation)).map(row => ({
        id: row.id, expectedRevision: row.revision, translation: row.currentTranslation.replaceAll('艾莉丝', '爱丽丝').replaceAll('巴比', '鲍比'), notes: '',
      }));
      return review(payload, edits);
    }
    assert.equal(role, 'translation'); assert.equal(payload.task, 'translation'); translationCalls.push(...payload.units.map(row => row.id));
    return { records: payload.units.map(row => {
      const alice = row.source.startsWith('Alice'), index = Number(/line (\d+)/.exec(row.source)?.[1] ?? 0);
      const name = alice ? index < 12 ? '爱丽丝' : '艾莉丝' : index < 12 ? '鲍比' : '巴比';
      return { id: row.id, translation: row.kind === 'character_name' ? name : `${name}说了一句完整台词。`,
        termChoices: [{ source: alice ? 'Alice' : 'Bobby', translation: name }] };
    }) };
  } });
  await f.service.startProject({ projectId: f.projectId }); const done = await completed(f);
  assert.equal(done.proofread, input.length); assert.equal(new Set(translationCalls).size, input.length);
  assert.equal(translationCalls.length, input.length);
  assert.ok(reviewed.length > 1);
  assert.ok(reviewed.every(payload => payload.reviewScope.stage === 'scene'), 'Scene-resolved name differences do not buy another review round');
  const glossary = inspect(f, store => store.one('projects', f.projectId).nameGlossary);
  assert.equal(new Set(glossary.entries.map(entry => entry.source)).size, 2);
  const hinted = reviewed.filter(payload => payload.terminologyHints?.length);
  assert.ok(hinted.length, 'Actual review requests include post-translation disagreements');
  assert.ok(hinted.some(payload => payload.terminologyHints.length < glossary.entries.length), 'Unrelated glossary entries do not fill every review request');
  for (const payload of hinted) for (const hint of payload.terminologyHints) {
    assert.ok(payload.units.some(row => row.source.includes(hint.source)));
    assert.ok(hint.unitIds.every(id => payload.units.some(row => row.id === id)));
    assert.ok(hint.variants.length > 1);
    assert.deepEqual(Object.keys(hint).sort(), ['recommendation', 'source', 'unitIds', 'variants']);
  }
  assert.ok(inspect(f, store => store.tasks(f.projectId)).every(task => !['glossary', 'glossary-repair'].includes(task.kind)));
});

test('only remaining minority name decisions are reviewed after scenes, not every line belonging to either character', async t => {
  const input = [unit('alice-name', 'Alice', { kind: 'character_name', context: { file: 'Actors.json', record: 1, actorId: 1 } }),
    unit('bobby-name', 'Bobby', { kind: 'character_name', context: { file: 'Actors.json', record: 2, actorId: 2 } }),
    ...['Alice', 'Bobby'].flatMap((speaker, actor) => Array.from({ length: 16 }, (_, index) => unit(`${speaker}-${index}`,
      `${speaker} says neutral line ${index}.`, { context: { file: 'neutral.json', event: actor * 16 + index, actorId: actor + 1, speaker } })))];
  const targets = [], expected = Array.from({ length: 4 }, (_, index) => `Alice says neutral line ${index + 12}.`);
  const f = await fixture(t, { units: input, proofreading: true, provider: async ({ role, wire }) => {
    const payload = wire.payload;
    if (role === 'translation') return { records: payload.units.map(row => {
      const alice = row.source.startsWith('Alice'), index = Number(/line (\d+)/.exec(row.source)?.[1] ?? 0);
      const name = alice ? index < 12 ? '爱丽丝' : '艾莉丝' : '鲍比';
      return { id: row.id, translation: row.kind === 'character_name' ? name : `${name}说了一句完整台词。`,
        termChoices: [{ source: alice ? 'Alice' : 'Bobby', translation: name }] };
    }) };
    if (payload.reviewScope.stage === 'scene') return review(payload);
    assert.equal(payload.reviewScope.stage, 'consistency');
    for (const row of payload.units) {
      assert.ok(expected.includes(row.source), `Unrelated or majority text was reviewed again: ${row.source}`);
      targets.push(row.source);
    }
    return review(payload, payload.units.map(row => ({
      id: row.id, expectedRevision: row.revision, translation: row.currentTranslation.replace('艾莉丝', '爱丽丝'), notes: '',
    })));
  } });
  await f.service.startProject({ projectId: f.projectId });
  const done = await completed(f);
  assert.equal(done.proofread, input.length);
  assert.deepEqual(targets.sort(), expected.sort(), 'Only four independent outlier decisions are bought once');
  const final = (await f.service.listText({ projectId: f.projectId })).units;
  assert.ok(final.filter(row => row.source.startsWith('Alice')).every(row => row.translation.includes('爱丽丝') && !row.translation.includes('艾莉丝')));
  assert.ok(final.filter(row => row.source.startsWith('Bobby')).every(row => row.translation.includes('鲍比')));
});
