import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { outputManifest, verifyOutput } from './output-manifest.mjs';
import { createStore } from './workspace-store.mjs';
import { PROMPT_VERSION } from './provider.mjs';
import { freshSemanticPreparation } from './semantic-state.mjs';
import { sha256 } from '../exchange/index.mjs';
import { textRequestLimits } from './text-capacity.mjs';

const parent = path.resolve('local/integration-review-tests');
await mkdir(parent, { recursive: true });

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(parent, 'flow-')), gameDir = path.join(root, 'original');
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'original.txt'), 'preserved original');
  const units = options.units ?? [{ id: 'line', source: 'A quiet room.', kind: 'message', tokens: [], context: { file: 'scene.json' } }];
  const service = await createService({ dataDir: path.join(root, 'profile'), scriptTools: null, imageTools: null,
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral adapter' }),
    provider: async args => {
      const { role, wire } = args;
      const payload = wire.payload;
      if (options.provider) return options.provider(args, payload);
      return role === 'proofreading' ? { review: { protocol: 'pinhao-review-1', reviewedIds: payload.units.map(unit => unit.id), edits: [],
        issues: [{ unitId: payload.units[0].id, kind: 'needs_evidence', resolution: 'open', message: '等待后文确认房间主人' }] } }
        : { records: payload.units.map(unit => ({ id: unit.id, translation: '一间安静的房间。' })) };
    },
    worker: async (command, args) => {
      if (command === 'catalog') return {};
      if (command === 'probe') return { engine: 'MV' };
      if (command === 'extract') { await mkdir(args.workspaceDir, { recursive: true }); return { workspaceDir: args.workspaceDir, units }; }
      if (['validate', 'roundtrip'].includes(command)) return {};
      if (command === 'build') {
        await mkdir(args.outputDir, { recursive: true });
        if (options.failBuild) { await writeFile(path.join(args.outputDir, 'failed-native-data.bin'), 'neutral failed artifact'); throw new Error('Neutral late build failure'); }
        await writeFile(path.join(args.outputDir, 'text.json'), JSON.stringify(args.translations));
        return { buildDir: args.outputDir };
      }
      if (command === 'assemble') {
        await mkdir(args.outputDir, { recursive: true }); await writeFile(path.join(args.outputDir, 'Game.exe'), 'neutral launcher');
        await writeFile(path.join(args.outputDir, 'text.json'), await readFile(path.join(args.buildDir, 'text.json')));
        return { outputDir: args.outputDir, launchPath: path.join(args.outputDir, 'Game.exe') };
      }
      throw new Error(`Unexpected neutral command ${command}`);
    } });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  await service.saveSettings({ ...defaultSettings(), proofreading: false, connection: { baseUrl: 'http://localhost:1/v1', model: 'neutral' } });
  const project = await service.createProject({ gameDir });
  return { root, service, project };
}

async function finish(service, projectId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await service.getProject({ projectId });
    if (['completed', 'paused', 'failed'].includes(value.status)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Neutral integration verification timed out');
}

test('static resources in generically named cache directories remain managed output', async t => {
  const root = await mkdtemp(path.join(parent, 'manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'cache')); await writeFile(path.join(root, 'Game.exe'), 'neutral launcher');
  await writeFile(path.join(root, 'cache', 'story.json'), 'translated static story');
  const proof = await outputManifest(root);
  await writeFile(path.join(root, 'cache', 'story.json'), 'externally modified story');
  assert.equal((await verifyOutput(root, proof)).valid, false);
});

test('reusing unchanged output refreshes a newly unresolved review evidence check', async t => {
  const f = await fixture(t);
  await f.service.startProject({ projectId: f.project.id });
  const first = await finish(f.service, f.project.id);
  assert.equal(first.status, 'completed');
  const originalBuild = first.builds.at(-1);
  await f.service.startProject({ projectId: f.project.id, mode: 'proofreading' });
  const reviewed = await finish(f.service, f.project.id);
  assert.equal(reviewed.status, 'completed');
  const unit = (await f.service.listText({ projectId: f.project.id })).units[0];
  assert.equal(unit.review.status, 'needs_evidence');
  const reused = reviewed.builds.at(-1);
  assert.equal(reused.id, originalBuild.id, 'The unchanged native product may remain reusable');
  assert.equal(reused.checks.find(check => check.name === '校对证据').status, 'pending');
});

test('late build repair retains actual failed native bytes before temporary cleanup', async t => {
  const options = { failBuild: true }, f = await fixture(t, options);
  const unit = (await f.service.listText({ projectId: f.project.id })).units[0];
  await f.service.saveText({ projectId: f.project.id, unitId: unit.id, translation: '一间安静的房间。', expectedRevision: unit.revision });
  await assert.rejects(f.service.buildProject({ projectId: f.project.id }), /Neutral late build failure/);
  const repairRoot = path.join(f.project.workspaceDir, 'technical', 'build-repairs'), files = [];
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file); else files.push(file);
    }
  };
  await visit(repairRoot);
  const retained = files.filter(file => path.basename(file) === 'failed-native-data.bin');
  assert.ok(retained.length, 'Saved repair evidence must include failed native output, not only a JSON description');
  assert.equal(await readFile(retained[0], 'utf8'), 'neutral failed artifact');
});

test('semantic publication retains pre-request existing-translation evidence instead of laundering new output', async t => {
  const f = await fixture(t, { units: [{ id: 'line', source: 'A quiet room.', translation: '先前译文', notes: '先前的身份依据', kind: 'message', tokens: [], context: { file: 'scene.json' } }],
    provider: async (_args, payload) => ({ records: payload.units.map(unit => ({ id: unit.id, translation: '当前原生有效译文', notes: '新的翻译备注' })),
      semanticDecisions: [{ id: 'old-identity', entity: 'room owner', sense: 'identity inferred from the old draft',
        scope: { unitIds: payload.units.map(unit => unit.id) }, evidenceIds: payload.units.map(unit => unit.id), expectedRevision: 0 }] }) });
  await f.service.startProject({ projectId: f.project.id });
  const done = await finish(f.service, f.project.id);
  assert.equal(done.status, 'completed');
  assert.equal((await f.service.listText({ projectId: f.project.id })).units[0].translation, '当前原生有效译文');
  const store = createStore(path.join(f.root, 'profile'));
  try { assert.equal(store.one('projects', f.project.id).semanticPreparation.decisions.length, 0); }
  finally { store.close(); }
  assert.ok(done.issues.some(issue => issue.category === 'semantic-evidence'));
});

test('semantic decisions can reference a proposed candidate once that same candidate commits', async t => {
  let calls = 0;
  const raw = [0, 1].map(id => ({ id: `line-${id}`, source: `A room ${id}.`, kind: 'message', tokens: [], context: { file: 'scene.json' } }));
  const f = await fixture(t, { units: raw, provider: async (_args, payload) => {
    if (++calls === 1) return { records: [{ id: payload.units[0].id, translation: '第一个房间' }] };
    const candidate = payload.referenceOnly.find(unit => unit.currentTranslation === '第一个房间');
    assert.ok(candidate);
    return { records: payload.units.map(unit => ({ id: unit.id, translation: '第二个房间' })), semanticDecisions: [{ id: 'rooms', entity: 'rooms', sense: 'two authored room labels',
      scope: { unitIds: [candidate.id, payload.units[0].id] }, evidenceIds: [candidate.id, payload.units[0].id], expectedRevision: 0 }] };
  } });
  await f.service.startProject({ projectId: f.project.id });
  const done = await finish(f.service, f.project.id);
  assert.equal(done.status, 'completed');
  const store = createStore(path.join(f.root, 'profile'));
  try { assert.equal(store.one('projects', f.project.id).semanticPreparation.decisions[0].id, 'rooms'); }
  finally { store.close(); }
  assert.equal(done.issues.some(issue => issue.category === 'semantic-evidence'), false);
});

test('restored oversized terminology prerequisites are not sent and do not block ordinary translation', async t => {
  const requests = [];
  const raw = Array.from({ length: 8 }, (_, id) => ({ id: `term-${id}`, source: `Artifact ${id}`, kind: 'database_name', tokens: [],
    context: { file: 'Skills.json', record: id, scene: `distinct evidence ${id} `.repeat(250) } }));
  const f = await fixture(t, { units: raw, provider: async (args, payload) => {
    requests.push({ task: payload.task, size: args.system.length + args.prompt.length, limit: textRequestLimits(args.connection).maxCharacters });
    assert.equal(payload.task, 'translation');
    return { records: payload.units.map(unit => ({ id: unit.id, translation: `条目${unit.source.match(/\d+/)[0]}` })) };
  } });
  const store = createStore(path.join(f.root, 'profile'));
  try {
    const project = store.one('projects', f.project.id), entries = store.units(f.project.id).map((unit, index) => ({
      id: `old-term-${index}`, source: unit.source, translation: unit.source, category: 'term', status: 'pending', revision: 0,
      unitIds: [unit.id], scope: {}, evidence: [{ unitId: unit.id, source: unit.source, context: unit.context }] }));
    const glossary = { version: 'pinhao-glossary-2', targetLanguage: 'zh-Hans', entries, prepared: false, hash: sha256(entries) };
    store.put('projects', { ...project, nameGlossary: glossary });
    store.putTask(f.project.id, { id: 'old-large-task', fingerprint: 'old-large-task', projectId: f.project.id,
      role: 'translation', kind: 'glossary', status: 'paused', attempts: 0, unitIds: [], targetLanguage: 'zh-Hans', promptVersion: PROMPT_VERSION,
      input: glossary.entries.map(entry => ({ id: entry.id, revision: entry.revision, sourceHash: sha256(entry.source) })) });
  } finally { store.close(); }
  await f.service.startProject({ projectId: f.project.id });
  const done = await finish(f.service, f.project.id);
  assert.equal(done.status, 'completed', done.lastError);
  assert.ok(requests.length > 0); assert.ok(requests.every(request => request.task === 'translation'));
  assert.ok(requests.every(request => request.size <= request.limit), JSON.stringify(requests));
  const inspect = createStore(path.join(f.root, 'profile'));
  try {
    assert.equal(inspect.tasks(f.project.id).find(task => task.id === 'old-large-task').status, 'cancelled');
    assert.equal(inspect.units(f.project.id).filter(unit => unit.status === 'translated').length, raw.length);
  } finally { inspect.close(); }
});

test('translation Agent can search supplementary evidence and finish in the same execution attempt', async t => {
  const calls = [];
  const f = await fixture(t, { provider: async (_args, payload) => {
    calls.push(payload);
    return !payload.evidenceResults ? { records: [], evidenceRequests: [{ query: { text: 'quiet' }, reason: 'Locate the complete original context' }] }
      : { records: payload.units.map(unit => ({ id: unit.id, translation: '查阅原文后的译文' })) };
  } });
  await f.service.startProject({ projectId: f.project.id });
  const done = await finish(f.service, f.project.id);
  assert.equal(done.status, 'completed'); assert.equal(calls.length, 2);
  assert.equal(calls[1].evidenceResults[0].total, 1);
  assert.ok(calls[1].referenceOnly.some(unit => unit.source === 'A quiet room.'));
  assert.equal(done.tasks.find(task => task.role === 'translation').attempts, 1);
});

test('differential review reads supplementary evidence before completing a zero-edit review', async t => {
  const reviewRequests = [];
  const f = await fixture(t, { provider: async (_args, payload) => {
    if (payload.task !== 'proofreading') return { records: payload.units.map(unit => ({ id: unit.id, translation: '一间安静的房间。' })) };
    reviewRequests.push({ stage: payload.reviewScope.stage, hasEvidence: Boolean(payload.evidenceResults) });
    if (!payload.evidenceResults) return { records: [], evidenceRequests: [{ query: { text: 'quiet' } }] };
    assert.equal(payload.evidenceResults[0].total, 1);
    return { review: { protocol: 'pinhao-review-1', reviewedIds: payload.units.map(unit => unit.id), issues: [], edits: [] } };
  } });
  await f.service.startProject({ projectId: f.project.id });
  assert.equal((await finish(f.service, f.project.id)).status, 'completed');
  const before = (await f.service.listText({ projectId: f.project.id })).units[0];
  await f.service.startProject({ projectId: f.project.id, mode: 'proofreading' });
  assert.equal((await finish(f.service, f.project.id)).status, 'completed');
  const after = (await f.service.listText({ projectId: f.project.id })).units[0];
  assert.deepEqual(reviewRequests, [{ stage: 'scene', hasEvidence: false }, { stage: 'scene', hasEvidence: true }],
    'A zero-edit scene review may read evidence, but must not buy a second conflict-free review');
  assert.equal(after.status, 'proofread');
  assert.equal(after.translation, before.translation); assert.equal(after.revision, before.revision);
});

test('a changed negative search invalidates the old reply before it can become accepted text', async t => {
  let introduced = false, queries = 0;
  const f = await fixture(t, { provider: async (_args, payload) => {
    if (payload.units.some(unit => unit.source === 'A quiet room.')) {
      if (!payload.evidenceResults) { queries++; return { records: [], evidenceRequests: [{ query: { text: 'Captain' }, reason: 'Find the speaker' }] }; }
      if (payload.evidenceResults[0].total === 0 && !introduced) {
        introduced = true;
        const store = createStore(path.join(f.root, 'profile'));
        try {
          const late = { id: 'late-source', legacyId: 'late-source', source: 'Captain Rose', sourceHash: sha256('Captain Rose'), translation: 'Captain Rose', notes: '',
            revision: 0, status: 'pending', kind: 'message', tokens: [], context: { file: 'late.json' } };
          store.putUnit(f.project.id, late, 2); store.addRevision(f.project.id, late);
        } finally { store.close(); }
        return { records: payload.units.map(unit => ({ id: unit.id, translation: '旧证据下的回复' })) };
      }
    }
    return { records: payload.units.map(unit => ({ id: unit.id, translation: '新证据下的正确回复' })) };
  } });
  await f.service.startProject({ projectId: f.project.id });
  const done = await finish(f.service, f.project.id);
  assert.equal(done.status, 'completed', done.lastError); assert.equal(queries, 2);
  const units = (await f.service.listText({ projectId: f.project.id })).units;
  assert.equal(units.some(unit => unit.translation === '旧证据下的回复'), false);
  assert.equal(units[0].translation, '新证据下的正确回复');
});

test('repeated evidence questions stop at a finite round limit and retain a visible local issue', async t => {
  let calls = 0;
  const f = await fixture(t, { provider: async () => { calls++; return { records: [], evidenceRequests: [{ query: { text: 'unresolved' } }] }; } });
  await f.service.startProject({ projectId: f.project.id });
  const done = await finish(f.service, f.project.id);
  assert.equal(calls, 5); assert.equal(done.status, 'paused');
  assert.ok(done.issues.some(issue => issue.category === 'semantic-evidence'));
  assert.equal((await f.service.listText({ projectId: f.project.id })).units[0].translation, 'A quiet room.');
});

test('query answers and their dependency receipts survive a provider pause without repeating the lookup', async t => {
  let calls = 0;
  const f = await fixture(t, { provider: async (_args, payload) => {
    if (++calls === 1) return { records: [], evidenceRequests: [{ query: { text: 'quiet' } }] };
    if (calls === 2) throw Object.assign(new Error('Neutral expired credential'), { statusCode: 401 });
    assert.equal(payload.evidenceResults[0].total, 1);
    return { records: payload.units.map(unit => ({ id: unit.id, translation: '恢复后沿用已读证据' })),
      semanticDecisions: [{ id: 'quiet-identity', entity: 'room', sense: 'room found by supplementary lookup',
        scope: { unitIds: payload.units.map(unit => unit.id) }, evidenceIds: payload.units.map(unit => unit.id), expectedRevision: 0 }] };
  } });
  await f.service.startProject({ projectId: f.project.id });
  assert.equal((await finish(f.service, f.project.id)).status, 'paused');
  await f.service.startProject({ projectId: f.project.id });
  const done = await finish(f.service, f.project.id);
  assert.equal(done.status, 'completed', done.lastError); assert.equal(calls, 3);
  const store = createStore(path.join(f.root, 'profile'));
  try {
    const state = store.one('projects', f.project.id).semanticPreparation, units = store.units(f.project.id);
    assert.ok(state.decisions[0].receipts.some(receipt => receipt.kind === 'query'));
    assert.equal(freshSemanticPreparation(state, { units }).decisions.length, 1);
    assert.equal(freshSemanticPreparation(state, { units: [...units, { ...units[0], id: 'new-quiet-line' }] }).decisions.length, 0,
      'The saved decision must retain query-membership proof across pause and resume');
  } finally { store.close(); }
});

test('a provisional streamed translation asking for evidence cannot bypass its final reply after resume', async t => {
  let calls = 0;
  const f = await fixture(t, { provider: async (args, payload) => {
    if (++calls === 1) {
      const records = payload.units.map(unit => ({ id: unit.id, translation: '仍待补查的临时文字' }));
      await args.onRecords(records);
      return { records, evidenceRequests: [{ query: { text: 'quiet' } }] };
    }
    if (calls === 2) throw Object.assign(new Error('Neutral expired credential'), { statusCode: 401 });
    return { records: payload.units.map(unit => ({ id: unit.id, translation: '完成补查的最终译文' })) };
  } });
  await f.service.startProject({ projectId: f.project.id });
  assert.equal((await finish(f.service, f.project.id)).status, 'paused');
  await f.service.startProject({ projectId: f.project.id });
  assert.equal((await finish(f.service, f.project.id)).status, 'completed');
  assert.equal(calls, 3);
  assert.equal((await f.service.listText({ projectId: f.project.id })).units[0].translation, '完成补查的最终译文');
});

test('an invalid review envelope cannot leave streamed correction candidates accepted on retry', async t => {
  const f = await fixture(t, { provider: async (args, payload) => {
    if (args.role !== 'proofreading') return { records: payload.units.map(unit => ({ id: unit.id, translation: '已接受的初译' })) };
    await args.onRecords(payload.units.map(unit => ({ id: unit.id, translation: '未通过审阅协议的改文' })));
    return { review: { protocol: 'pinhao-review-1', reviewedIds: [], issues: [], edits: [] } };
  } });
  await f.service.startProject({ projectId: f.project.id });
  assert.equal((await finish(f.service, f.project.id)).status, 'completed');
  await f.service.startProject({ projectId: f.project.id, mode: 'proofreading' });
  assert.equal((await finish(f.service, f.project.id)).status, 'paused');
  assert.equal((await f.service.listText({ projectId: f.project.id })).units[0].translation, '已接受的初译');
});

test('a replacement model receives a new evidence window while retaining prior query answers', async t => {
  let changed = false, calls = 0;
  const f = await fixture(t, { provider: async (_args, payload) => {
    calls++;
    return changed ? { records: payload.units.map(unit => ({ id: unit.id, translation: '新模型完成了任务' })) }
      : { records: [], evidenceRequests: [{ query: { text: 'unresolved' } }] };
  } });
  await f.service.startProject({ projectId: f.project.id });
  assert.equal((await finish(f.service, f.project.id)).status, 'paused'); assert.equal(calls, 5);
  const settings = (await f.service.snapshot()).settings;
  settings.connection.model = 'another-neutral-model'; await f.service.saveSettings(settings); changed = true;
  await f.service.startProject({ projectId: f.project.id });
  assert.equal((await finish(f.service, f.project.id)).status, 'completed'); assert.equal(calls, 6);
});
