import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { sha256 } from '../exchange/index.mjs';
import { runAdaptation } from '../technical/adaptation.mjs';

const parent = path.resolve('local', 'native-review-service-tests');
await mkdir(parent, { recursive: true });
const secrets = { encrypt: value => `fixture:${Buffer.from(value).toString('base64')}`, decrypt: value => Buffer.from(value.slice(8), 'base64').toString() };
const delay = time => new Promise(resolve => setTimeout(resolve, time));

async function until(service, projectId, predicate) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const project = await service.getProject({ projectId });
    if (predicate(project)) return project;
    if (project.status === 'paused' && project.lastError) assert.fail(JSON.stringify({ error: project.lastError, adaptation: project.adaptation }));
    await delay(10);
  }
  assert.fail(`Native review did not reach its checkpoint: ${JSON.stringify(await service.getProject({ projectId }))}`);
}

async function fixture(t, { carrierCount = 2, fontOnly = false, generate, beforeNativeAdapt, coverageProjection } = {}) {
  const directory = await mkdtemp(path.join(parent, 'case-'));
  const gameDir = path.join(directory, 'game'), dataDir = path.join(directory, 'profile');
  const carriers = Array.from({ length: carrierCount }, (_, index) => `Neutral_Data/level${index}`);
  const groupFor = file => `native-review-v1:${sha256(file).slice(0, 16)}:${sha256('neutral-component').slice(0, 24)}`;
  const evidenceFor = file => sha256(['neutral-display-schema', file]);
  await mkdir(path.join(gameDir, 'Neutral_Data'), { recursive: true });
  await mkdir(path.join(gameDir, 'js'));
  await writeFile(path.join(gameDir, 'js', 'neutral.js'), 'const caption = "A complete supplemental caption.";');
  await mkdir(path.join(gameDir, 'save'));
  await writeFile(path.join(gameDir, 'save', 'slot01.sav'), 'Preserved neutral save.');
  await writeFile(path.join(gameDir, 'Game.exe'), 'Neutral launch marker.');
  for (const [index, file] of carriers.entries()) await writeFile(path.join(gameDir, file), JSON.stringify({ text: `A complete hidden scene ${index + 1}.`, logic: { sceneId: index + 10 } }));
  const before = new Map(await Promise.all([...carriers, 'js/neutral.js', 'save/slot01.sav'].map(async file => [file, await readFile(path.join(gameDir, file))])));
  const primary = { id: 'native:original', source: 'A complete original scene.', kind: 'message', tokens: [], context: { file: '__neutral_native__/original.json', carrier: carriers[0] } };
  const script = { id: 'script:neutral', source: 'A complete supplemental caption.', kind: 'script_text', tokens: [], context: { file: 'js/neutral.js' } };
  const fonts = [{ file: carriers[0], object: '@:font', kind: 'static_or_external_font_requires_adapter' }];
  const reviewItems = decisions => [...(fontOnly ? [] : carriers.filter(file => !decisions.some(decision => decision.file === file)).map((file, index) => ({ file, object: `@:${index + 20}`,
    kind: 'custom_monobehaviour_display_schema_required', script: { assembly: 'Neutral.dll', namespace: 'Fixture', className: 'ScenePresenter' } }))), ...fonts];
  const calls = { extract: 0, nativeAdapt: [], roundtrip: 0, roundtripPaths: [], samples: 0, adaptations: [], coverageProjections: [], provider: 0 };
  const readState = async workspaceDir => JSON.parse(await readFile(path.join(workspaceDir, 'neutral-state.json'), 'utf8'));
  const saveWorkbench = async (workspaceDir, decisions = []) => {
    await mkdir(path.join(workspaceDir, 'technical'), { recursive: true });
    const units = [primary, ...decisions.filter(decision => decision.disposition === 'display').map(decision => ({
      id: `native:field:${carriers.indexOf(decision.file)}`, source: `A complete hidden scene ${carriers.indexOf(decision.file) + 1}.`, kind: 'message', tokens: [],
      context: { file: `__neutral_native__/field-${carriers.indexOf(decision.file)}.json`, carrier: decision.file, object: '@:field' },
    }))];
    await writeFile(path.join(workspaceDir, 'manifest.json'), JSON.stringify({ schema: 'neutral-native-workbench-1', units: Object.fromEntries(units.map(unit => [unit.id, { source: unit.source, controls: {} }])) }));
    await writeFile(path.join(workspaceDir, 'neutral-state.json'), JSON.stringify({ decisions }));
    await writeFile(path.join(workspaceDir, 'technical', 'product-source.json'), JSON.stringify({ nativeReviewDecisions: decisions }));
    return { workspaceDir, units, sourceFingerprint: sha256([...before]), reviewItems: reviewItems(decisions), nativeReviewDecisions: decisions,
      coverage: { resources: carriers.map(file => ({ file, status: 'text_extracted', units: 1 })) } };
  };
  const worker = async (command, input = {}, { signal } = {}) => {
    signal?.throwIfAborted();
    if (command === 'catalog') return { engines: [] };
    if (command === 'assistInfo') return { supported: false, modes: [] };
    if (command === 'probe') return { engine: 'Unity', root: '.', capabilities: { extract: true, nativeBuild: true, assist: false } };
    if (command === 'extract') { calls.extract++; return saveWorkbench(input.workspaceDir); }
    if (command === 'roundtrip') { calls.roundtrip++; calls.roundtripPaths.push(input.workspaceDir); return { valid: true, passed: true, byteIdentical: true }; }
    if (command === 'native_review') {
      const { decisions } = await readState(input.workspaceDir);
      if (input.coverageOnly) {
        assert.equal(input.acceptedOnly, true);
        calls.coverageProjections.push(input.workspaceDir);
        return { schema: 'pinhao-native-field-review-v1', engine: 'Unity', capability: 'supported', workspaceDir: input.workspaceDir,
          reviewItems: coverageProjection ? await coverageProjection({ workspaceDir: input.workspaceDir, decisions, reviewItems: reviewItems(decisions) }) : reviewItems(decisions), refreshedGroups: decisions.filter(item => item.disposition === 'display').length };
      }
      const groups = carriers.filter(file => (!input.file || file === input.file) && !decisions.some(decision => decision.file === file)).map(file => ({
        groupId: groupFor(file), file, evidenceHash: evidenceFor(file), objectCount: 1, status: 'ready', fields: [{ path: ['text'], samples: [`A complete hidden scene ${carriers.indexOf(file) + 1}.`] }],
        fieldUses: { fields: [{ path: ['text'], uses: [{ siteId: `display-site-v1:${sha256(file)}`, safe: true }] }] },
      }));
      return { schema: 'pinhao-native-field-review-v1', total: groups.length, groups, nextOffset: null };
    }
    if (command === 'native_adapt') {
      await assert.rejects(lstat(input.outputDir), { code: 'ENOENT' }, 'real native_adapt requires a fresh output path');
      await beforeNativeAdapt?.(input, signal);
      const state = await readState(input.workspaceDir);
      const incoming = input.decisions.map(decision => {
        const file = carriers.find(file => groupFor(file) === decision.groupId);
        assert.ok(file, 'a reviewed group comes from the neutral native inspector');
        assert.equal(decision.evidenceHash, evidenceFor(file));
        if (decision.disposition === 'display') {
          assert.deepEqual(decision.fields.map(({ displaySites, ...field }) => field), [{ path: ['text'], kind: 'message' }]);
          assert.ok(decision.fields.every(field => field.displaySites === undefined || field.displaySites.every(site => typeof site === 'string')));
        }
        else assert.equal(decision.fields, undefined);
        return { ...decision, file };
      });
      const decisions = [...new Map([...state.decisions, ...incoming].map(decision => [decision.groupId, decision])).values()];
      calls.nativeAdapt.push({ from: input.workspaceDir, to: input.outputDir, baselineFiles: state.decisions.map(decision => decision.file), files: decisions.map(decision => decision.file), inputDecisions: structuredClone(input.decisions) });
      return saveWorkbench(input.outputDir, decisions);
    }
    if (command === 'build') {
      await assert.rejects(lstat(input.outputDir), { code: 'ENOENT' }, 'real build requires a fresh output path');
      await mkdir(input.outputDir); await writeFile(path.join(input.outputDir, 'sample.bin'), 'Neutral sample.');
      calls.samples++; return { buildDir: input.outputDir, changed: input.translations.length, nativeFiles: carrierCount };
    }
    throw new Error(`Unexpected neutral native command: ${command}`);
  };
  const create = () => createService({ dataDir, worker, secrets, imageTools: null,
    scriptTools: { extractDisplayText: async () => ({ units: [script], binding: { files: [{ file: 'js/neutral.js', candidates: [{ id: script.id, controls: {} }] }] } }) },
    technicalProvider: async () => ({ decision: 'native-standard', summary: 'Neutral resource check complete.', selectedCandidateIds: [] }),
    provider: async ({ signal }) => {
      calls.provider++;
      signal?.throwIfAborted();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    adaptationProvider: args => runAdaptation({ ...args, generate: async input => {
      calls.adaptations.push(args.assignment?.files);
      if (generate) await generate({ ...input, assignment: args.assignment });
      else {
        const result = await input.tools.native_review.execute({ file: args.assignment.files[0] });
        const group = result.groups[0];
        assert.ok(group, JSON.stringify(result));
        const accepted = await input.tools.native_review_decide.execute({ decisions: [{
          groupRef: group.groupRef, disposition: 'display', fields: [{ path: ['text'], kind: 'message' }], reason: 'The field is used by the scene dialogue presenter.',
        }] });
        assert.equal(accepted.taskComplete, true, JSON.stringify(accepted));
      }
    } }),
  });
  let service = await create();
  const settings = defaultSettings(); settings.concurrency = 3; settings.connection.model = 'neutral-local-fixture'; settings.connection.apiKey = 'neutral-local-host-value';
  await service.saveSettings(settings);
  t.after(async () => { await service.close(); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 }); });
  return { directory, gameDir, dataDir, carriers, before, calls, get service() { return service; },
    async reopen(edit) { await service.close(); if (edit) { const store = createStore(dataDir); try { await edit(store); } finally { store.close(); } } service = await create(); },
  };
}

test('opening a legacy font-only project keeps the available text flow and never opens adaptation', async t => {
  const f = await fixture(t, { fontOnly: true });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  await f.reopen(store => { const project = store.one('projects', created.id); store.put('projects', { ...project, reviewDiagnosticsVersion: undefined }); });
  const upgraded = await f.service.getProject({ projectId: created.id });
  assert.equal(upgraded.adaptationAvailable, false);
  assert.equal(upgraded.canContinueAvailableText, true);
  assert.equal(upgraded.coverage.needsAdaptation, false);
  assert.equal(upgraded.coverage.summary.nativeReviewObjects, 0);
  assert.equal(upgraded.coverage.summary.presentationItems, 1);
  assert.equal(f.calls.extract, 1);
});

test('resuming Unity refreshes partial accepted display coverage before seeding without changing workbench identity or text', async t => {
  let projectedItems;
  const f = await fixture(t, { carrierCount: 1,
    coverageProjection: ({ decisions }) => {
      assert.equal(decisions[0].fields[0].displaySites.length, 1, 'the earlier accepted decision selected only one safe site');
      return projectedItems;
    },
    generate: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  const original = (await f.service.listText({ projectId: created.id })).units;
  await f.service.saveText({ projectId: created.id, unitId: original[0].id, expectedRevision: original[0].revision, translation: '保留已接受的人工译文。', notes: 'Preserve this note.' });
  const accepted = (await f.service.listText({ projectId: created.id })).units;
  let stagePath, stageBytes, workbenchDir, manifestBytes, sourceFingerprint;
  await f.reopen(async store => {
    const project = store.one('projects', created.id);
    stagePath = project.nativeStage.path; workbenchDir = project.workbenchDir; sourceFingerprint = project.sourceFingerprint;
    const staged = JSON.parse(await readFile(stagePath, 'utf8'));
    const file = f.carriers[0], decision = { groupId: `native-review-v1:${sha256(file).slice(0, 16)}:${sha256('neutral-component').slice(0, 24)}`,
      evidenceHash: sha256(['neutral-display-schema', file]), file, disposition: 'display',
      fields: [{ path: ['text'], kind: 'message', displaySites: [`display-site-v1:${sha256('selected-safe-site')}`] }] };
    staged.extraction.nativeReviewDecisions = [decision];
    staged.extraction.reviewItems = staged.extraction.reviewItems.filter(item => item.kind.includes('font'));
    projectedItems = [...staged.extraction.reviewItems, { file, kind: 'display_field_coverage_required', category: 'native-schema',
      group: decision.groupId, count: 30, detail: 'Thirty unselected safe display sites remain.' }];
    await writeFile(path.join(workbenchDir, 'neutral-state.json'), JSON.stringify({ decisions: [decision] }));
    await writeFile(stagePath, JSON.stringify(staged));
    stageBytes = await readFile(stagePath); manifestBytes = await readFile(path.join(workbenchDir, 'manifest.json'));
    store.put('projects', { ...project, inventory: { ...project.inventory, reviewItems: staged.extraction.reviewItems } });
  });
  await f.service.retryAdaptation({ projectId: created.id });
  const refreshed = await until(f.service, created.id, project => project.coverage?.summary.nativeReviewObjects === 30 && f.calls.adaptations.length === 1);
  await f.service.cancelProject({ projectId: created.id });
  assert.deepEqual(f.calls.coverageProjections, [workbenchDir]);
  assert.deepEqual(f.calls.adaptations, [[f.carriers[0]]], 'the existing resource job reopens the missed display sites');
  assert.equal(refreshed.coverage.summary.presentationItems, 1, 'unrelated font diagnostics survive the projection');
  assert.deepEqual((await f.service.listText({ projectId: created.id })).units, accepted);
  assert.deepEqual(await readFile(stagePath), stageBytes);
  assert.deepEqual(await readFile(path.join(workbenchDir, 'manifest.json')), manifestBytes);
  const store = createStore(f.dataDir);
  try { const project = store.one('projects', created.id); assert.equal(project.workbenchDir, workbenchDir); assert.equal(project.sourceFingerprint, sourceFingerprint); }
  finally { store.close(); }
});

test('a completed Unity workbench can discover new native candidates through the existing retry entry without replacing accepted text', async t => {
  const managedFile = 'Neutral_Data/Managed/Neutral.dll';
  const f = await fixture(t, { fontOnly: true, carrierCount: 1,
    coverageProjection: ({ reviewItems }) => [...reviewItems, { file: managedFile, kind: 'managed_display_schema_required', category: 'native-schema', count: 2 }],
    generate: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  });
  await mkdir(path.join(f.gameDir, 'Neutral_Data/Managed'));
  await writeFile(path.join(f.gameDir, managedFile), 'Neutral managed source marker.');
  const created = await f.service.createProject({ gameDir: f.gameDir });
  const initial = (await f.service.listText({ projectId: created.id })).units;
  for (const unit of initial) await f.service.saveText({ projectId: created.id, unitId: unit.id, expectedRevision: unit.revision, translation: '保留已校对文字。', notes: 'Accepted before a new native capability.' });
  const accepted = (await f.service.listText({ projectId: created.id })).units;
  let stagePath, stageBytes, manifestPath, manifestBytes, fingerprint;
  await f.reopen(async store => {
    const project = store.one('projects', created.id);
    assert.equal(project.adaptationRequest, undefined);
    stagePath = project.nativeStage.path; manifestPath = path.join(project.workbenchDir, 'manifest.json'); fingerprint = project.sourceFingerprint;
    stageBytes = await readFile(stagePath); manifestBytes = await readFile(manifestPath);
    store.put('projects', { ...project, status: 'completed', stage: '成品已生成' });
  });
  await f.service.retryAdaptation({ projectId: created.id });
  await until(f.service, created.id, project => project.coverage?.summary.nativeReviewObjects === 2 && f.calls.adaptations.length === 1);
  await f.service.cancelProject({ projectId: created.id });
  assert.deepEqual(f.calls.adaptations, [[managedFile]]);
  assert.equal(f.calls.extract, 1, 'capability discovery does not repeat native extraction');
  assert.deepEqual((await f.service.listText({ projectId: created.id })).units, accepted);
  assert.deepEqual(await readFile(stagePath), stageBytes);
  assert.deepEqual(await readFile(manifestPath), manifestBytes);
  const store = createStore(f.dataDir);
  try { assert.equal(store.one('projects', created.id).sourceFingerprint, fingerprint); }
  finally { store.close(); }
});

test('checking a settled Unity workbench without new candidates returns its current progress without buying model work', async t => {
  const f = await fixture(t, { fontOnly: true });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  const before = (await f.service.listText({ projectId: created.id })).units;
  const result = await f.service.retryAdaptation({ projectId: created.id });
  assert.equal(result.adaptationAvailable, false);
  assert.equal(result.coverage.needsAdaptation, false);
  assert.equal(f.calls.coverageProjections.length, 1);
  assert.equal(f.calls.provider, 0); assert.equal(f.calls.adaptations.length, 0);
  assert.deepEqual((await f.service.listText({ projectId: created.id })).units, before);
});

test('failed native candidate discovery preserves the completed project and accepted workbench state', async t => {
  const f = await fixture(t, { fontOnly: true, coverageProjection: () => { throw new Error('Neutral native inspector unavailable.'); } });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  const stored = createStore(f.dataDir); let before;
  try { before = stored.one('projects', created.id); } finally { stored.close(); }
  await assert.rejects(f.service.retryAdaptation({ projectId: created.id }), /Neutral native inspector unavailable/);
  const after = createStore(f.dataDir);
  try { assert.deepEqual(after.one('projects', created.id), before); } finally { after.close(); }
  assert.equal(f.calls.provider, 0); assert.equal(f.calls.adaptations.length, 0);
});

test('parallel native review receipts merge into the latest workbench while preserving accepted text and supplemental bindings', { timeout: 40000 }, async t => {
  let active = 0, peak = 0, release;
  const entered = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { carrierCount: 3, generate: async ({ tools, assignment }) => {
    const file = assignment.files[0];
    const inspected = await tools.native_review.execute({ file });
    const group = inspected.groups[0]; assert.ok(group, JSON.stringify(inspected));
    active++; peak = Math.max(peak, active); if (active === 3) release();
    await entered;
    const accepted = await tools.native_review_decide.execute({ decisions: [{ groupRef: group.groupRef,
      disposition: 'display', fields: [{ path: ['text'], kind: 'message', displaySites: [group.fieldUses.fields[0].uses[0].siteRef] }], reason: 'ScenePresenter displays this full text field.' }] });
    active--; assert.equal(accepted.taskComplete, true, JSON.stringify(accepted));
  } });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  const initial = (await f.service.listText({ projectId: created.id })).units;
  for (const unit of initial) await f.service.saveText({ projectId: created.id, unitId: unit.id, expectedRevision: unit.revision,
    translation: unit.legacyId.startsWith('script:') ? '保留脚本人工译文。' : '保留原生人工译文。', notes: `Preserve note ${unit.legacyId}.` });
  const acceptedBefore = (await f.service.listText({ projectId: created.id })).units;
  const storedBefore = createStore(f.dataDir);
  let originalWorkbench, savedRevisions;
  try { originalWorkbench = storedBefore.one('projects', created.id).workbenchDir; savedRevisions = acceptedBefore.map(unit => storedBefore.revision(created.id, unit.id, unit.revision)); }
  finally { storedBefore.close(); }
  const supplement = JSON.stringify({ format: 'pinhao-composite-adapter-1', adapters: [{ workspaceDir: path.join(f.directory, 'previous-js-adapter'),
    unitIds: ['script:neutral'], units: [], files: ['js/neutral.js'], baselineDir: f.gameDir, sourceRoot: f.gameDir, resourceRoot: '.', baselineHashes: { 'js/neutral.js': sha256(f.before.get('js/neutral.js')) } }] });
  await writeFile(path.join(originalWorkbench, 'pinhao-composite-adapter.json'), supplement);
  await f.service.startProject({ projectId: created.id, mode: 'translation' });
  const adapted = await until(f.service, created.id, project => project.total === 5 && project.coverage?.needsAdaptation === false);
  await f.service.cancelProject({ projectId: created.id });
  assert.equal(peak, 3);
  assert.equal(adapted.coverage.summary.nativeReviewObjects, 0);
  assert.equal(adapted.coverage.summary.presentationItems, 1);
  assert.equal(f.calls.extract, 1, 'existing staged native workbenches seed the technical tools');
  assert.equal(f.calls.samples, 3, 'each genuine host receipt performs its native sample build');
  const independent = f.calls.nativeAdapt.filter(call => path.basename(path.dirname(call.to)) === 'nr');
  const rebased = f.calls.nativeAdapt.filter(call => path.basename(path.dirname(call.to)) === 'nf');
  assert.equal(independent.length, 3, 'all three independent candidates retain their own native validation');
  assert.ok(independent.every(call => call.inputDecisions.length === 1));
  assert.ok(rebased.length >= 1 && rebased.length <= independent.length - 1,
    'each ready batch rebases once; unfinished native validation must not delay an earlier commit');
  for (const call of rebased) assert.deepEqual([...call.files].sort(),
    [...new Set([...call.baselineFiles, ...call.inputDecisions.map(decision => decision.file)])].sort(),
    'rebases retain exactly the accepted baseline and the ready receipt decisions');
  t.diagnostic(JSON.stringify({ nativeRebases: rebased.map(call => ({ baseline: call.baselineFiles, incoming: call.inputDecisions.map(decision => decision.file), result: call.files })) }));
  assert.deepEqual(rebased[0].inputDecisions.flatMap(decision => decision.fields.flatMap(field => field.displaySites)).sort(),
    rebased[0].inputDecisions.map(decision => `display-site-v1:${sha256(decision.file)}`).sort());
  const text = (await f.service.listText({ projectId: created.id })).units;
  for (const previous of acceptedBefore) assert.deepEqual(text.find(unit => unit.id === previous.id), previous);
  const added = text.filter(unit => !acceptedBefore.some(previous => previous.id === unit.id));
  assert.equal(added.length, 3);
  assert.ok(added.every(unit => unit.status === 'pending' && unit.revision === 0 && unit.translation === unit.source));
  const storedAfter = createStore(f.dataDir);
  try {
    for (const [index, previous] of acceptedBefore.entries()) assert.deepEqual(storedAfter.revision(created.id, previous.id, previous.revision), savedRevisions[index]);
    const project = storedAfter.one('projects', created.id);
    assert.notEqual(project.workbenchDir, originalWorkbench);
    assert.equal(f.calls.roundtripPaths.at(-1), project.workbenchDir);
    assert.equal(await readFile(path.join(project.workbenchDir, 'pinhao-composite-adapter.json'), 'utf8'), supplement);
    const state = JSON.parse(await readFile(path.join(project.workbenchDir, 'neutral-state.json'), 'utf8'));
    assert.deepEqual(state.decisions.map(decision => decision.file).sort(), f.carriers);
    const staged = JSON.parse(await readFile(project.nativeStage.path, 'utf8'));
    assert.equal(staged.extraction.units.length, 4);
    assert.equal(project.nativeStage.initialWorkbenchDir, originalWorkbench);
    assert.equal(project.nativeStage.previousWorkbenchDir, rebased.at(-1).from, 'the immediately preceding accepted workbench remains recoverable');
    assert.equal((await lstat(originalWorkbench)).isDirectory(), true);
    assert.equal((await lstat(project.workbenchDir)).isDirectory(), true);
    for (const candidate of independent) {
      if (candidate.to === project.nativeStage.previousWorkbenchDir) assert.equal((await lstat(candidate.to)).isDirectory(), true);
      else await assert.rejects(lstat(candidate.to), { code: 'ENOENT' });
    }
    assert.deepEqual(await readdir(path.join(project.workspaceDir, 'nr')), independent.filter(candidate => candidate.to === project.nativeStage.previousWorkbenchDir).map(candidate => path.basename(candidate.to)),
      'only a previous accepted generation, not redundant candidates or successful samples, remains after settling');
    assert.ok(project.nativeStage.retainedWorkbenches.every(entry => [project.workbenchDir, project.nativeStage.previousWorkbenchDir].includes(entry.workspaceDir)));
  } finally { storedAfter.close(); }
  for (const [file, bytes] of f.before) assert.deepEqual(await readFile(path.join(f.gameDir, file)), bytes);
});

test('one native receipt is promoted without copying and validating the same workbench twice', async t => {
  const f = await fixture(t, { carrierCount: 1 });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  await f.service.startProject({ projectId: created.id, mode: 'translation' });
  await until(f.service, created.id, project => project.total === 3 && !project.coverage.needsAdaptation
    && !project.tasks.some(task => task.role === 'technical' && ['running', 'queued'].includes(task.status)));
  await f.service.cancelProject({ projectId: created.id });
  assert.equal(f.calls.nativeAdapt.length, 1);
  assert.equal(f.calls.roundtrip, 3, 'initial extraction, one receipt validation and the existing final project gate');
  const store = createStore(f.dataDir);
  try { assert.equal(store.one('projects', created.id).workbenchDir, f.calls.nativeAdapt[0].to); }
  finally { store.close(); }
});

test('concurrent non-display receipts retain earlier classifications without changing source identity', async t => {
  let entered = 0, release;
  const ready = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { carrierCount: 2, generate: async ({ tools, assignment }) => {
    const result = await tools.native_review.execute({ file: assignment.files[0] });
    const group = result.groups[0];
    if (++entered === 2) release();
    await ready;
    await tools.native_review_decide.execute({ decisions: [{ groupRef: group.groupRef,
      disposition: 'non-display', reason: 'These fields identify resources rather than displayed text.' }] });
  } });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  const before = createStore(f.dataDir);
  let fingerprint;
  try { fingerprint = before.one('projects', created.id).sourceFingerprint; }
  finally { before.close(); }
  await f.service.startProject({ projectId: created.id, mode: 'translation' });
  await until(f.service, created.id, project => !project.coverage.needsAdaptation);
  await f.service.cancelProject({ projectId: created.id });
  assert.equal(f.calls.nativeAdapt.length, 3, 'metadata-only advancement also requires rebasing the second concurrent receipt');
  const after = createStore(f.dataDir);
  try {
    const project = after.one('projects', created.id);
    assert.equal(project.sourceFingerprint, fingerprint);
    const state = JSON.parse(await readFile(path.join(project.workbenchDir, 'neutral-state.json'), 'utf8'));
    assert.deepEqual(state.decisions.map(decision => decision.file).sort(), f.carriers);
  } finally { after.close(); }
});

test('native field decisions survive cancellation and reopen without repeating accepted carriers', { timeout: 40000 }, async t => {
  let resumed = false;
  const f = await fixture(t, { generate: async ({ tools, assignment, signal }) => {
    const file = assignment.files[0];
    if (!resumed && file.endsWith('level1')) await new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const result = await tools.native_review.execute({ file });
    const group = result.groups[0]; assert.ok(group);
    await tools.native_review_decide.execute({ decisions: [{ groupRef: group.groupRef,
      disposition: 'display', fields: [{ path: ['text'], kind: 'message' }], reason: 'ScenePresenter shows the complete scene field.' }] });
  } });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  await f.service.startProject({ projectId: created.id, mode: 'translation' });
  await until(f.service, created.id, current => current.total === 3);
  await f.service.cancelProject({ projectId: created.id });
  const paused = await f.service.getProject({ projectId: created.id });
  assert.equal(paused.coverage.stale, true, 'accepted native fields invalidate the previous scan before cancellation');
  assert.equal(paused.coverage.addedUnitsSinceScan, 1);
  const before = (await f.service.listText({ projectId: created.id })).units;
  const firstCalls = f.calls.adaptations.filter(files => files.includes(f.carriers[0])).length;
  resumed = true;
  await f.reopen();
  await f.service.startProject({ projectId: created.id, mode: 'translation' });
  const refreshed = await until(f.service, created.id, current => current.total === 4 && !current.coverage.needsAdaptation);
  assert.equal(refreshed.coverage.stale, false);
  assert.equal(refreshed.coverage.addedUnitsSinceScan, 0);
  await f.service.cancelProject({ projectId: created.id });
  const after = (await f.service.listText({ projectId: created.id })).units;
  for (const unit of before) assert.deepEqual(after.find(item => item.id === unit.id), unit);
  assert.equal(f.calls.adaptations.filter(files => files.includes(f.carriers[0])).length, firstCalls);
  assert.equal(f.calls.extract, 1);
});

test('reopening promotes hash-bound uncommitted native candidates before another model task or carrier copy', { timeout: 40000 }, async t => {
  const entered = Promise.withResolvers(); let resumed = false;
  const f = await fixture(t, { carrierCount: 2, beforeNativeAdapt: async (input, signal) => {
    if (!resumed && path.basename(path.dirname(input.outputDir)) === 'nf') {
      entered.resolve();
      await new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
  } });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  await f.service.startProject({ projectId: created.id, mode: 'translation' });
  await entered.promise;
  await f.service.cancelProject({ projectId: created.id });
  const store = createStore(f.dataDir); let retained;
  try { retained = store.one('projects', created.id).nativeStage.retainedWorkbenches.filter(entry => entry.status === 'verified'); }
  finally { store.close(); }
  assert.ok(retained.length >= 1);
  assert.ok(retained.every(entry => /^[a-f0-9]{64}$/.test(entry.stageHash)));
  const modelTasks = f.calls.adaptations.length, candidates = f.calls.nativeAdapt.filter(call => path.basename(path.dirname(call.to)) === 'nr').length;
  const before = (await f.service.listText({ projectId: created.id })).units;
  resumed = true; await f.reopen();
  await f.service.startProject({ projectId: created.id, mode: 'translation' });
  await until(f.service, created.id, project => project.total === 4 && !project.coverage.needsAdaptation);
  await f.service.cancelProject({ projectId: created.id });
  assert.equal(f.calls.adaptations.length, modelTasks, 'saved validated decisions resume without another technical model turn');
  assert.equal(f.calls.nativeAdapt.filter(call => path.basename(path.dirname(call.to)) === 'nr').length, candidates, 'no native candidate is copied or sampled again');
  const after = (await f.service.listText({ projectId: created.id })).units;
  for (const unit of before) assert.deepEqual(after.find(current => current.id === unit.id), unit);
  const restored = createStore(f.dataDir);
  try {
    const project = restored.one('projects', created.id);
    assert.equal(project.nativeStage.reviewRestore.restored, retained.length);
    assert.deepEqual(project.nativeStage.reviewRestore.failures, []);
    assert.ok(project.nativeStage.retainedWorkbenches.every(entry => entry.status !== 'verified'));
  } finally { restored.close(); }
  for (const [file, bytes] of f.before) assert.deepEqual(await readFile(path.join(f.gameDir, file)), bytes);
});

test('coverage projection runs after restored native candidates so their old diagnostics cannot hide unselected sites', { timeout: 40000 }, async t => {
  const entered = Promise.withResolvers(); let resumed = false;
  const f = await fixture(t, { carrierCount: 2,
    beforeNativeAdapt: async (input, signal) => {
      if (!resumed && path.basename(path.dirname(input.outputDir)) === 'nf') {
        entered.resolve();
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
    },
    coverageProjection: ({ decisions, reviewItems }) => {
      if (!resumed) return reviewItems;
      assert.equal(decisions.length, 2, 'both saved candidates are promoted before diagnostics are projected');
      return [...reviewItems, { file: f.carriers[0], kind: 'display_field_coverage_required', category: 'native-schema', count: 30 }];
    },
    generate: async ({ tools, assignment, signal }) => {
      if (resumed) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      const result = await tools.native_review.execute({ file: assignment.files[0] }), group = result.groups[0];
      await tools.native_review_decide.execute({ decisions: [{ groupRef: group.groupRef,
        disposition: 'display', fields: [{ path: ['text'], kind: 'message' }], reason: 'Neutral scene text is displayed.' }] });
    },
  });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  await f.service.startProject({ projectId: created.id, mode: 'translation' });
  await entered.promise;
  await f.service.cancelProject({ projectId: created.id });
  const before = (await f.service.listText({ projectId: created.id })).units, modelsBefore = f.calls.adaptations.length;
  resumed = true; await f.reopen();
  await f.service.startProject({ projectId: created.id, mode: 'translation' });
  await until(f.service, created.id, project => project.total === 4 && project.coverage?.summary.nativeReviewObjects === 30 && f.calls.adaptations.length > modelsBefore);
  await f.service.cancelProject({ projectId: created.id });
  assert.deepEqual(f.calls.adaptations.slice(modelsBefore), [[f.carriers[0]]]);
  const after = (await f.service.listText({ projectId: created.id })).units;
  for (const unit of before) assert.deepEqual(after.find(current => current.id === unit.id), unit);
  const store = createStore(f.dataDir);
  try {
    const project = store.one('projects', created.id);
    assert.ok(project.nativeStage.reviewRestore.restored > 0);
    assert.equal(f.calls.coverageProjections.at(-1), project.workbenchDir);
    assert.ok(project.inventory.reviewItems.some(item => item.category === 'native-schema' && item.count === 30));
    const staged = JSON.parse(await readFile(project.nativeStage.path, 'utf8'));
    assert.ok(!staged.extraction.reviewItems.some(item => item.count === 30), 'the current diagnostic projection does not rewrite the verified stage');
  } finally { store.close(); }
});
