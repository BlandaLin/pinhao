import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStoryContext } from '../exchange/story.mjs';
import { createReviewRound, prepareReviewTransport, refreshReviewRound, reviewScopes, reviewView, reviewScopeVersion, currentReviewTasks,
  reviewStageComplete, reviewRoundProgress, savedSceneReviewUnits, reviewConflicts, reviewResolutionScopes, reviewOutcome, paidConsistencyTasks, reviewGlossary } from './review-round.mjs';
import { REQUEST_BATCH_LIMITS } from './provider.mjs';
import { glossaryHash } from './glossary.mjs';

const unit = (id, event, extra = {}) => ({ id, revision: 1, sourceHash: `source-${id}`, source: `Source ${id}`,
  translation: `Current ${id}`, notes: '', kind: 'dialogue', context: { file: 'neutral.json', event, page: 0 }, ...extra });
const roundFor = (units, options = {}) => createReviewRound({ projectId: 'neutral', units, targetIds: units.map(unit => unit.id),
  story: buildStoryContext(units), glossary: { entries: [] }, id: 'round-1', ...options });
const separateBatches = (first = unit('a', 1), second = unit('b', 2)) => [first,
  ...Array.from({ length: REQUEST_BATCH_LIMITS.maxUnits - 1 }, (_, index) => unit(`padding-${index}`, 1)), second];
function task(round, scope, stage, tasks = [], edits = [], patch = {}) {
  return { id: `task-${stage}-${scope.id}-${tasks.length}`, reviewRoundId: round.id, reviewStage: stage,
    reviewScopeId: scope.id, reviewScopeVersion: reviewScopeVersion(round, scope, tasks, stage), unitIds: scope.unitIds,
    candidateRecords: edits, reviewChangedIds: edits.map(record => record.id), status: 'succeeded', ...patch };
}

test('review progress counts saved target text once and rejects old rounds, stale scopes and read-only context', () => {
  const round = roundFor(separateBatches()), scopes = reviewScopes(round, 'scene');
  const completed = task(round, scopes[0], 'scene');
  const partial = task(round, scopes[1], 'scene', [], [{ id: 'b', translation: 'Saved candidate' }],
    { status: 'paused', reviewCandidate: { reviewedIds: ['b', 'a', 'unknown'] } });
  const oldRound = { ...partial, reviewRoundId: 'old-round', status: 'skipped' };
  const oldScope = { ...partial, reviewScopeVersion: 'old-version', status: 'skipped' };
  const cancelled = { ...partial, status: 'cancelled' };
  assert.deepEqual(reviewRoundProgress(round, [completed, completed, partial, oldRound, oldScope, cancelled]),
    { total: 17, reviewed: 17, skipped: 0 });
  const refreshed = refreshReviewRound(round, round.units.map(row => row.id === 'a' ? { ...row, revision: 2, translation: 'Manual' } : row)).round;
  assert.deepEqual(reviewRoundProgress(refreshed, [completed, partial]), { total: 17, reviewed: 1, skipped: 0 });
});

test('review progress preserves reconciled pages but not streamed checkpoints and reports skipped text separately', () => {
  const round = roundFor(Array.from({ length: 24 }, (_, index) => unit(`long-${index}`, 1)));
  const [scope] = reviewScopes(round, 'scene');
  const partial = task(round, scope, 'scene', [], scope.unitIds.slice(0, 20).map(id => ({ id, translation: 'Saved value' })),
    { status: 'queued', reviewedUnitIds: scope.unitIds.slice(0, 16), reviewCandidate: { reviewedIds: scope.unitIds.slice(16, 20) } });
  assert.deepEqual(reviewRoundProgress(round, [partial, partial]), { total: 24, reviewed: 16, skipped: 0 });
  assert.deepEqual(reviewRoundProgress(round, [{ ...partial, status: 'skipped' }]), { total: 24, reviewed: 16, skipped: 8 });
  const outcome = reviewOutcome(round, [{ ...partial, status: 'skipped' }]);
  assert.deepEqual(outcome.skippedIds, scope.unitIds.slice(16));
  assert.ok(outcome.units.slice(0, 16).every(unit => unit.translation === 'Saved value'));
  assert.deepEqual(outcome.units.slice(16), round.units.slice(16), 'Unvalidated failed-page records are not promoted');
  assert.deepEqual(reviewRoundProgress(round, [{ ...partial, status: 'running', reviewedUnitIds: [], reviewCandidate: undefined }]),
    { total: 24, reviewed: 0, skipped: 0 });
});

test('saved scene rows include unchanged text and only validated owned receipts regardless of the later stage', () => {
  const round = roundFor(Array.from({ length: 24 }, (_, index) => unit(`line-${index}`, 1)));
  const [scope] = reviewScopes(round, 'scene');
  const records = [
    { id: 'line-0', translation: round.units[0].translation, notes: '' },
    { id: 'line-1', translation: 'Saved correction', notes: 'Reviewer note' },
    { id: 'line-2', translation: 'Unvalidated stream' },
    { id: 'outside', translation: 'Not owned' },
  ];
  const partial = task(round, scope, 'scene', [], records,
    { status: 'paused', reviewedUnitIds: ['line-0', 'line-1', 'outside'], reviewChangedIds: ['line-1'] });
  const excluded = [
    { ...partial, reviewRoundId: 'old-round' }, { ...partial, reviewScopeVersion: 'old-scope' },
    ...['stale', 'cancelled'].map(status => ({ ...partial, status })),
  ];
  const before = structuredClone({ round, partial, excluded });
  for (const stage of ['scene', 'consistency', 'resolve', 'committed']) {
    const actual = savedSceneReviewUnits({ ...round, stage }, [partial, ...excluded]);
    assert.deepEqual(actual.map(unit => unit.id), ['line-0', 'line-1']);
    assert.equal(actual[0].translation, round.units[0].translation);
    assert.equal(actual[1].translation, 'Saved correction');
    assert.equal(actual[1].notes, 'Reviewer note');
  }
  assert.deepEqual({ round, partial, excluded }, before);
  assert.deepEqual(savedSceneReviewUnits(round, [{ ...partial, status: 'skipped' }]), savedSceneReviewUnits(round, [partial]),
    'A later failed page does not hide earlier reconciled scene receipts');
  const refreshed = refreshReviewRound(round, round.units.map(unit => unit.id === 'line-0' ? { ...unit, revision: 2, translation: 'Manual change' } : unit)).round;
  assert.deepEqual(savedSceneReviewUnits(refreshed, [partial]), []);
  const completed = savedSceneReviewUnits(round, [{ ...partial, status: 'succeeded' }]);
  assert.equal(completed.length, 24); assert.equal(completed[2].translation, 'Unvalidated stream');
  assert.deepEqual(savedSceneReviewUnits(round, [{ ...partial, status: 'succeeded', candidateRecords: [] }]), round.units,
    'A completed no-change review keeps the frozen scene text instead of disappearing');
});

test('consistency progress counts actual issue targets once and resolution keeps its separate scope', () => {
  const units = [unit('a', 1), unit('b', 1), unit('c', 2), unit('reference', 3)];
  const round = roundFor(units, { targetIds: ['a', 'b', 'c'], glossary: { entries: [{ id: 'term', unitIds: ['a', 'b', 'reference'] }] } });
  round.story.characters = [{ id: 'person', scope: { unitIds: ['a', 'b', 'reference'], targetUnitIds: ['a', 'b'] } }];
  const scenes = reviewScopes(round, 'scene').map(scope => task(round, scope, 'scene', [], [],
    { reviewCandidate: { issues: ['a', 'b'].map(unitId => ({ unitId, resolution: 'open', message: `Check ${unitId}` })) } }));
  const [scope] = reviewScopes(round, 'consistency', scenes);
  assert.deepEqual(new Set(scope.unitIds), new Set(['a', 'b']));
  const partial = task(round, scope, 'consistency', scenes, [{ id: 'a', translation: 'One' }], { status: 'paused', reviewedUnitIds: ['a'] });
  assert.deepEqual(reviewRoundProgress(round, [...scenes, partial, partial], 'consistency'), { total: 2, reviewed: 1, skipped: 0 });
  const one = { ...partial, status: 'succeeded' }, two = { ...one, id: 'second-valid-result', candidateRecords: [{ id: 'a', translation: 'Two' }] };
  const tasks = [...scenes, one, two];
  assert.deepEqual(reviewRoundProgress(round, tasks, 'consistency'), { total: 2, reviewed: 2, skipped: 0 });
  assert.deepEqual(reviewRoundProgress(round, [...scenes, { ...partial, status: 'skipped' }], 'consistency'), { total: 2, reviewed: 1, skipped: 1 });
  assert.deepEqual(reviewOutcome(round, [...scenes, { ...partial, status: 'skipped' }]).skippedIds, ['b'],
    'A saved scene review does not settle an unfinished consistency target');
  const [resolution] = reviewResolutionScopes(round, tasks);
  assert.deepEqual(reviewRoundProgress(round, tasks, 'resolve'), { total: 1, reviewed: 0, skipped: 0 });
  const settled = task(round, resolution, 'resolve', tasks, [{ id: 'a', translation: 'Settled' }]);
  assert.deepEqual(reviewRoundProgress(round, [...tasks, settled], 'resolve'), { total: 1, reviewed: 1, skipped: 0 });
  assert.equal(reviewRoundProgress({ ...round, stage: 'committed' }, tasks), undefined);
});

test('scene edits stay candidates and consistency receives only matching round/version results', () => {
  const units = separateBatches(), round = roundFor(units), scenes = reviewScopes(round, 'scene');
  const good = task(round, scenes[0], 'scene', [], [{ id: 'a', translation: 'Valid candidate', notes: '' }]);
  const wrongRound = { ...good, reviewRoundId: 'old-round', candidateRecords: [{ id: 'a', translation: 'Wrong round' }] };
  const stale = { ...good, reviewScopeVersion: 'stale', candidateRecords: [{ id: 'a', translation: 'Stale candidate' }] };
  assert.equal(reviewView(round, [good], 'scene').units[0].translation, 'Current a');
  assert.equal(reviewView(round, [wrongRound, stale], 'consistency').units[0].translation, 'Current a');
  assert.equal(reviewView(round, [good, wrongRound, stale], 'consistency').units[0].translation, 'Valid candidate');
  assert.equal(round.units[0].translation, 'Current a');
  assert.equal(reviewStageComplete(round, [good], 'scene'), false);
  const zeroChange = task(round, scenes[1], 'scene', [good]);
  assert.equal(reviewStageComplete(round, [good, zeroChange], 'scene'), true);
});

test('manual change invalidates only related frozen scopes and does not mix old candidates into views', () => {
  const units = separateBatches(), round = roundFor(units), scopes = reviewScopes(round, 'scene');
  const tasks = scopes.map(scope => task(round, scope, 'scene', [], [{ id: scope.unitIds[0], translation: 'Candidate', notes: '' }]));
  const changedUnits = units.map(unit => unit.id === 'a' ? { ...unit, translation: 'Manual value', revision: 2, locked: true } : unit);
  const refreshed = refreshReviewRound(round, changedUnits, buildStoryContext(changedUnits));
  assert.deepEqual(refreshed.changedIds, ['a']);
  assert.deepEqual(currentReviewTasks(refreshed.round, tasks, 'scene').map(task => task.reviewScopeId), [scopes[1].id]);
  const view = reviewView(refreshed.round, tasks, 'consistency').units;
  assert.equal(view[0].translation, 'Manual value'); assert.equal(view.find(unit => unit.id === 'b').translation, 'Candidate');
  assert.equal(refreshed.round.units[0].locked, true);
});

test('sync groups share one scene owner and expanding consistency reads never mutates story or glossary', () => {
  const units = [unit('a', 1, { context: { file: 'a.json', event: 1, syncGroup: 'linked' } }),
    unit('b', 2, { context: { file: 'b.json', event: 2, syncGroup: 'linked' } })];
  const round = roundFor(units, { glossary: { entries: [{ id: 'shared', unitIds: ['a', 'b'] }] } });
  round.story.characters = [{ id: 'person', scope: { unitIds: ['a'], targetUnitIds: ['a'] } }];
  const before = structuredClone(round);
  assert.equal(reviewScopes(round, 'scene').length, 1);
  assert.deepEqual(new Set(reviewScopes(round, 'scene')[0].unitIds), new Set(['a', 'b']));
  const consistency = reviewScopes(round, 'consistency');
  assert.deepEqual(new Set(consistency[0].readIds), new Set(['a', 'b']));
  assert.deepEqual(round, before);
});

test('conflicting consistency candidates require a versioned resolution and stale resolution issues stay out', () => {
  const units = [unit('a', 1), unit('b', 1)], round = roundFor(units,
    { glossary: { entries: [{ id: 'term', unitIds: ['a', 'b'] }] } });
  round.story.characters = [{ id: 'person', scope: { unitIds: ['a', 'b'], targetUnitIds: ['a', 'b'] } }];
  const scene = task(round, reviewScopes(round, 'scene')[0], 'scene', [], [],
    { reviewCandidate: { issues: [{ unitId: 'a', resolution: 'open', message: 'Check conflicting wording' }] } });
  const scopes = reviewScopes(round, 'consistency', [scene]);
  const one = task(round, scopes[0], 'consistency', [scene], [{ id: 'a', translation: 'First proposal', notes: '' }]);
  const two = task(round, scopes[0], 'consistency', [scene, one], [{ id: 'a', translation: 'Second proposal', notes: '' }]);
  const tasks = [scene, one, two];
  assert.equal(reviewConflicts(round, tasks).length, 1);
  const resolveScope = reviewResolutionScopes(round, tasks)[0];
  const resolution = task(round, resolveScope, 'resolve', tasks, [{ id: 'a', translation: 'Settled proposal', notes: '' }],
    { reviewCandidate: { issues: [{ id: 'valid-resolution-issue', unitId: 'a' }] } });
  const stale = { ...resolution, reviewScopeVersion: 'stale', reviewCandidate: { issues: [{ id: 'stale-issue', unitId: 'a' }] } };
  const outcome = reviewOutcome(round, [...tasks, resolution, stale]);
  assert.equal(outcome.units[0].translation, 'Settled proposal'); assert.equal(outcome.unresolved.length, 0);
  assert.deepEqual(outcome.issues.map(issue => issue.id), ['valid-resolution-issue']);
  const updatedTasks = [scene, one, { ...two, candidateRecords: [{ id: 'a', translation: 'Updated second proposal', notes: '' }] }];
  const pending = reviewOutcome(round, [...updatedTasks, resolution]);
  assert.equal(pending.units[0].translation, 'Current a'); assert.equal(pending.unresolved.length, 1);
  assert.equal(currentReviewTasks(round, [...updatedTasks, resolution], 'resolve').length, 0);
});

test('candidate records outside their assigned target IDs never enter the prospective view', () => {
  const round = roundFor(separateBatches()), scope = reviewScopes(round, 'scene')[0];
  const invalid = task(round, scope, 'scene', [], [{ id: 'b', translation: 'Out of scope', notes: '' }]);
  assert.equal(reviewView(round, [invalid], 'consistency').units.find(unit => unit.id === 'b').translation, 'Current b');
});

test('canonical glossary refresh invalidates only scopes that use the actual changed term', () => {
  const units = separateBatches(unit('a', 1, { source: 'Alpha returns.' }), unit('b', 2, { source: 'A quiet morning.' }));
  const glossary = { entries: [{ id: 'alpha', source: 'Alpha', translation: '甲', status: 'confirmed', revision: 1, unitIds: ['a'] },
    { id: 'unused', source: 'Unused', translation: '旧', status: 'confirmed', revision: 1, unitIds: [] }] };
  const round = roundFor(units, { glossary }), scopes = reviewScopes(round, 'scene');
  const tasks = scopes.map(scope => task(round, scope, 'scene'));
  const unusedChanged = { entries: glossary.entries.map(entry => entry.id === 'unused' ? { ...entry, translation: '新', revision: 2 } : entry) };
  const unchanged = refreshReviewRound(round, units, round.story, unusedChanged);
  assert.equal(unchanged.round, round); assert.equal(unchanged.glossaryChanged, false);
  const usedChanged = { entries: glossary.entries.map(entry => entry.id === 'alpha' ? { ...entry, translation: '人工名', revision: 2 } : entry) };
  const refreshed = refreshReviewRound(round, units, round.story, usedChanged);
  assert.equal(refreshed.glossaryChanged, true); assert.deepEqual(refreshed.changedIds, []);
  assert.equal(refreshed.round.glossary.entries[0].translation, '人工名');
  assert.deepEqual(currentReviewTasks(refreshed.round, tasks, 'scene').map(task => task.reviewScopeId), [scopes[1].id]);
});

test('refreshed occurrence translations do not invalidate already paid review candidates', () => {
  const units = separateBatches(unit('a', 1, { source: 'Alpha returns.' }));
  const entry = { id: 'alpha', source: 'Alpha', translation: '甲', status: 'confirmed', revision: 1, evidenceHash: 'basis-a', unitIds: ['a'],
    evidence: [{ unitId: 'a', source: units[0].source, translationState: 'untranslated' }] };
  const glossary = { entries: [entry], hash: glossaryHash([entry]) }, round = roundFor(units, { glossary });
  const tasks = reviewScopes(round, 'scene').map(scope => task(round, scope, 'scene', [],
    [{ id: scope.unitIds[0], translation: 'Saved paid candidate', notes: '' }]));
  const entries = [{ ...entry, evidence: [{ ...entry.evidence[0], translationState: 'accepted', currentTranslation: units[0].translation }] }];
  const refreshed = refreshReviewRound(round, units, round.story, { entries, hash: glossaryHash(entries) });
  assert.equal(refreshed.round, round); assert.equal(refreshed.glossaryChanged, false);
  assert.deepEqual(currentReviewTasks(refreshed.round, tasks, 'scene'), tasks);
  assert.deepEqual(round.glossary.entries[0].evidence, entry.evidence);
});

test('a genuine glossary update does not refresh unrelated frozen occurrence evidence', () => {
  const units = separateBatches(unit('a', 1, { source: 'Alpha returns.' }), unit('b', 2, { source: 'Beta returns.' }));
  const entries = ['Alpha', 'Beta'].map((source, index) => ({ id: source, source, translation: index ? '乙' : '甲', status: 'confirmed', revision: 1,
    evidenceHash: `basis-${source}`, unitIds: [index ? 'b' : 'a'], evidence: [{ unitId: index ? 'b' : 'a', translationState: 'untranslated' }] }));
  const glossary = { entries, hash: glossaryHash(entries) }, round = roundFor(units, { glossary });
  const scopes = reviewScopes(round, 'scene'), tasks = scopes.map(scope => task(round, scope, 'scene'));
  const next = entries.map((entry, index) => ({ ...entry, ...(index ? {} : { translation: '阿尔法', revision: 2 }),
    evidence: entry.evidence.map(item => ({ ...item, translationState: 'accepted', currentTranslation: 'Refreshed occurrence' })) }));
  const refreshed = refreshReviewRound(round, units, round.story, { entries: next, hash: glossaryHash(next) });
  assert.equal(refreshed.glossaryChanged, true);
  assert.deepEqual(refreshed.round.glossary.entries[1], entries[1]);
  assert.equal(refreshed.round.glossary.hash, glossaryHash(refreshed.round.glossary.entries));
  assert.deepEqual(currentReviewTasks(refreshed.round, tasks, 'scene').map(task => task.reviewScopeId), [scopes[1].id]);
});

test('visible glossary decisions, source revisions and target associations still refresh the review material', () => {
  const units = separateBatches(unit('a', 1, { source: 'Alpha returns.' }));
  const entry = { id: 'alpha', source: 'Alpha', translation: '甲', category: 'name', status: 'confirmed', revision: 1, evidenceHash: 'basis-a',
    unitIds: ['a'], aliases: [], notes: '', scope: {}, evidence: [{ unitId: 'a', source: units[0].source }] };
  const glossary = { entries: [entry], hash: glossaryHash([entry]) }, round = roundFor(units, { glossary });
  for (const patch of [{ translation: '新的译名' }, { aliases: ['另一个译名'] }, { scope: { semanticScope: 'another-sense' } },
    { notes: 'A corrected meaning.' }, { status: 'pending' }, { revision: 2 },
    { evidenceHash: 'new-source-basis', revision: 2, evidence: [{ ...entry.evidence[0], source: 'Changed source basis.' }] }, { unitIds: ['a', 'b'] }]) {
    const entries = [{ ...entry, ...patch }], refreshed = refreshReviewRound(round, units, round.story, { entries, hash: glossaryHash(entries) });
    assert.equal(refreshed.glossaryChanged, true, `A semantic change must remain visible: ${Object.keys(patch)}`);
    assert.deepEqual(refreshed.round.glossary.entries[0], entries[0]);
    if (patch.unitIds) { assert.deepEqual(refreshed.round.glossary.entries[0].unitIds, ['a', 'b']); assert.deepEqual(reviewScopes(refreshed.round, 'consistency'), []); }
    else assert.equal(currentReviewTasks(refreshed.round, [task(round, reviewScopes(round, 'scene')[0], 'scene')], 'scene').length, 0);
  }
});

test('host-only context changes do not invalidate review material but protected control meanings do', () => {
  const units = [unit('a', 1, { context: { file: 'neutral.json', event: 1, adaptationLocator: { path: 'old-host-path' },
    controlBindings: { '{{CTRL1}}': '\\N[1]' } } })], round = roundFor(units);
  const technicalChange = [{ ...units[0], context: { ...units[0].context, adaptationLocator: { path: 'new-host-path' } } }];
  assert.equal(refreshReviewRound(round, technicalChange).round, round);
  const controlChange = [{ ...units[0], context: { ...units[0].context, controlBindings: { '{{CTRL1}}': '\\N[2]' } } }];
  assert.deepEqual(refreshReviewRound(round, controlChange).changedIds, ['a']);
});

test('independent complete scenes share transport batches without rewriting their story', () => {
  const units = Array.from({ length: 544 }, (_, index) => unit(`ui-${index}`, index));
  const round = roundFor(units), original = structuredClone(round);
  const scenes = reviewScopes(round, 'scene'), consistency = reviewScopes(round, 'consistency');
  assert.equal(round.story.scenes.length, 544);
  assert.equal(scenes.length, 34); assert.equal(consistency.length, 0);
  for (const scopes of [scenes]) {
    assert.ok(scopes.every(scope => scope.unitIds.length === REQUEST_BATCH_LIMITS.maxUnits));
    assert.deepEqual(scopes.flatMap(scope => scope.unitIds), units.map(unit => unit.id));
    assert.ok(scopes.every(scope => new Set(scope.readIds).size === scope.readIds.length));
  }
  assert.deepEqual(reviewScopes(round, 'scene'), scenes); assert.deepEqual(round, original);
});

test('oversized scopes remain whole and sync ownership is merged before transport packing', () => {
  const oversized = roundFor([...Array.from({ length: 17 }, (_, index) => unit(`large-${index}`, 1)), unit('b', 2), unit('c', 3)]);
  const scopes = reviewScopes(oversized, 'scene');
  assert.equal(scopes.length, 2); assert.equal(scopes[0].unitIds.length, 17);
  assert.equal(scopes[0].id, oversized.story.scenes[0].id); assert.equal(scopes[1].unitIds.length, 2);
  const units = Array.from({ length: 33 }, (_, index) => unit(`linked-${index}`, index,
    [0, 16].includes(index) ? { context: { file: 'neutral.json', event: index, syncGroup: 'linked' } } : {}));
  const round = roundFor(units);
  round.story.scenes[1].scope.unitIds.push(units[0].id);
  const before = structuredClone(round), linked = reviewScopes(round, 'scene');
  assert.ok(linked.some(scope => scope.unitIds.includes('linked-0') && scope.unitIds.includes('linked-16')));
  const ids = linked.flatMap(scope => scope.unitIds);
  assert.equal(ids.length, 33); assert.equal(new Set(ids).size, 33);
  assert.ok(linked.every(scope => scope.unitIds.length <= 16 && new Set(scope.readIds).size === scope.readIds.length));
  assert.deepEqual(round, before);
});

test('enabling transport preserves 94 completed candidates and paid partial scopes without pinning the next stage', () => {
  const units = Array.from({ length: 160 }, (_, index) => unit(`saved-${index}`, index)), round = roundFor(units);
  delete round.scopeTransport;
  const scopes = reviewScopes(round, 'scene');
  const tasks = scopes.slice(0, 94).map((scope, index) => task(round, scope, 'scene', [],
    [{ id: units[index].id, translation: index < 3 ? `Edited ${index}` : units[index].translation, notes: '' }],
    { reviewChangedIds: index < 3 ? [units[index].id] : [] }));
  tasks.push(task(round, scopes[94], 'scene', [], [{ id: units[94].id, translation: 'Partial candidate', notes: '' }], { status: 'paused' }));
  tasks.push(task(round, scopes[95], 'scene', [], [], { status: 'paused', requestHistory: [{ transportRequests: 1 }] }));
  tasks.push(task(round, scopes[96], 'scene', [], [], { status: 'paused', evidenceReplies: [{ returnedIds: [units[96].id] }] }));
  const unstarted = task(round, scopes[97], 'scene', [], [], { status: 'queued', requestCount: 1,
    requestHistory: [{ status: 'failed', code: 'PRESEND_STALE', transportRequests: 0 }] });
  tasks.push(unstarted);
  const before = structuredClone({ round, tasks }), next = prepareReviewTransport(round, tasks);
  assert.equal(next.revision, 1); assert.equal(next.scopeTransport.pinned.scene.length, 97);
  assert.deepEqual(next.scopeTransport.pinned.consistency, []);
  assert.deepEqual(currentReviewTasks(next, tasks, 'scene').map(task => task.id), tasks.slice(0, 97).map(task => task.id));
  const nextScopes = reviewScopes(next, 'scene');
  assert.equal(nextScopes.length, 101);
  for (const saved of tasks.slice(0, 97)) {
    const scope = nextScopes.find(scope => scope.id === saved.reviewScopeId);
    assert.equal(reviewScopeVersion(next, scope, tasks, 'scene'), saved.reviewScopeVersion);
  }
  const view = reviewView(next, tasks, 'consistency');
  assert.equal(view.units[0].translation, 'Edited 0'); assert.equal(view.units[94].translation, units[94].translation);
  assert.equal(reviewScopes(next, 'consistency', tasks).length, 0);
  assert.equal(prepareReviewTransport(next, tasks), next);
  assert.deepEqual({ round, tasks }, before);
});

test('existing paid consistency receipts survive without reviving the old all-character scheduler', () => {
  const units = Array.from({ length: 33 }, (_, index) => unit(`consistency-${index}`, index)), round = roundFor(units);
  delete round.scopeTransport;
  const scope = index => ({ id: `old-person-${index}`, unitIds: [units[index].id], readIds: [units[index].id] });
  const done = task(round, scope(0), 'consistency', [], [{ id: units[0].id, translation: 'Saved consistency', notes: '' }]);
  const reading = task(round, scope(1), 'consistency', [], [{ id: units[1].id, translation: 'Saved partial', notes: '' }],
    { status: 'paused', reviewedUnitIds: [units[1].id] });
  const unverified = task(round, scope(2), 'consistency', [], [{ id: units[2].id, translation: 'Streamed only', notes: '' }], { status: 'paused' });
  const tasks = [done, reading, unverified], next = prepareReviewTransport(round, tasks);
  assert.deepEqual(next.scopeTransport.pinned.scene, []);
  assert.deepEqual(next.scopeTransport.pinned.consistency, [scope(0).id, scope(1).id]);
  assert.equal(reviewScopes(next, 'scene').length, 3); assert.equal(reviewScopes(next, 'consistency', tasks).length, 0);
  assert.deepEqual(paidConsistencyTasks(next, tasks).map(task => task.id), [done.id, reading.id]);
  assert.deepEqual(currentReviewTasks(next, tasks, 'consistency').map(task => task.id), [done.id, reading.id]);
  const outcome = reviewOutcome(next, tasks);
  assert.equal(outcome.units[0].translation, 'Saved consistency'); assert.equal(outcome.units[1].translation, 'Saved partial');
  assert.equal(outcome.units[2].translation, units[2].translation);
  const refreshed = refreshReviewRound(next, units.map((value, index) => index === 1 ? { ...value, revision: 2 } : value)).round;
  assert.deepEqual(paidConsistencyTasks(refreshed, tasks).map(task => task.id), [done.id]);
});

const nameVote = (id, translation, extra = {}) => unit(id, id, { status: 'translated', source: `Mina speaks ${id}.`, translation: `${translation}说话。`,
  termChoices: [{ source: 'Mina', translation }], context: { actorId: 1, speaker: 'Mina', file: 'neutral.json', event: id }, ...extra });

test('local independent votes normalize only a proven complete name field and target only remaining minority wording', () => {
  const units = [unit('name', 0, { status: 'translated', kind: 'character_name', source: 'Mina', translation: '美娜', context: { actorId: 1 } }),
    ...Array.from({ length: 9 }, (_, index) => nameVote(`majority-${index}`, '米娜')), nameVote('minority', '美娜'), unit('unrelated', 90)];
  const round = roundFor(units), before = structuredClone(round);
  const scenes = reviewScopes(round, 'scene').map(scope => task(round, scope, 'scene'));
  const view = reviewView(round, scenes, 'consistency');
  assert.equal(view.units[0].translation, '米娜');
  assert.equal(view.units.find(row => row.id === 'minority').translation, '美娜说话。', 'Dialogue is never globally replaced');
  const scopes = reviewScopes(round, 'consistency', scenes);
  assert.deepEqual(scopes.flatMap(scope => scope.unitIds), ['minority']);
  assert.match(scopes[0].reason, /Mina/);
  assert.equal(reviewGlossary(round, scenes).entries[0].recommended, '米娜');
  assert.deepEqual(round, before, 'Host voting must not mutate the frozen round or formal text');
  const owner = reviewScopes(round, 'scene').find(scope => scope.unitIds.includes('minority'));
  const corrected = scenes.map(value => value.reviewScopeId === owner.id ? { ...value,
    candidateRecords: [{ id: 'minority', translation: '米娜说话。', notes: '' }], reviewChangedIds: ['minority'] } : value);
  assert.deepEqual(reviewScopes(round, 'consistency', corrected), [], 'Already corrected scene wording must not be purchased again');
});

test('ties and unclear identities stay confined to evidenced term occurrences rather than every character line', () => {
  const units = [nameVote('left', '米娜', { context: { file: 'neutral.json', event: 1 } }),
    nameVote('right', '美娜', { context: { file: 'neutral.json', event: 2 } }), ...Array.from({ length: 40 }, (_, index) => unit(`healthy-${index}`, index))];
  const round = roundFor(units); round.story.characters = [{ id: 'broad-person', unitIds: units.map(row => row.id) }];
  const scopes = reviewScopes(round, 'consistency');
  assert.deepEqual(new Set(scopes.flatMap(scope => scope.unitIds)), new Set(['left', 'right']));
  assert.equal(reviewRoundProgress(round, [], 'consistency').total, 2);
});

test('open scene questions get one stable targeted owner and later saved review closes the old open issue', () => {
  const round = roundFor([unit('question', 1), unit('retained', 2), unit('healthy', 3)]);
  const scene = task(round, reviewScopes(round, 'scene')[0], 'scene', [], [], { reviewCandidate: { issues: [
    { unitId: 'question', kind: 'needs_evidence', resolution: 'open', message: 'Which room?' },
    { unitId: 'retained', kind: 'source_ambiguity', resolution: 'retained', message: 'Original deliberately ambiguous.' },
  ] } });
  const [scope] = reviewScopes(round, 'consistency', [scene]);
  assert.deepEqual(scope.unitIds, ['question']);
  const resolved = task(round, scope, 'consistency', [scene], [], { reviewCandidate: { issues: [] } });
  assert.deepEqual(reviewScopes(round, 'consistency', [scene, resolved]), [scope], 'A saved new scope must not invalidate itself');
  assert.equal(reviewStageComplete(round, [scene, resolved], 'consistency'), true);
  assert.deepEqual(reviewOutcome(round, [scene, resolved]).issues.map(issue => issue.unitId), ['retained']);
});

test('old paid hashes are checked against their original material before new local name normalization', () => {
  const units = [unit('name', 0, { status: 'translated', kind: 'character_name', source: 'Mina', translation: '美娜', context: { actorId: 1 },
    terminologyNormalization: { sourceHash: 'obsolete-source', originalTranslation: '过期译名', appliedTranslation: '美娜' } }),
    ...Array.from({ length: 3 }, (_, index) => nameVote(`majority-${index}`, '米娜'))];
  const round = roundFor(units), scope = { id: 'legacy-person', unitIds: ['name'], readIds: units.map(value => value.id) };
  const paid = task(round, scope, 'consistency', [], [{ id: 'name', translation: '已付费核定名', notes: '' }]);
  paid.reviewReadIds = scope.readIds;
  paid.reviewScopeVersion = reviewScopeVersion(round, scope, [], 'consistency', new Map(round.units.map(value => [value.id, value])));
  assert.equal(reviewView(round, [], 'consistency').units[0].translation, '米娜');
  assert.equal(reviewView(round, [], 'consistency').units[0].terminologyNormalization.originalTranslation, '美娜');
  assert.deepEqual(paidConsistencyTasks(round, [paid]), [paid]);
  assert.equal(reviewOutcome(round, [paid]).units[0].translation, '已付费核定名');
});

test('overlapping term disagreements and explicit questions share one target without rereviewing unrelated text', () => {
  const round = roundFor([nameVote('majority-a', '米娜'), nameVote('majority-b', '米娜'), nameVote('minority', '美娜'), unit('healthy', 3)]);
  const scene = task(round, reviewScopes(round, 'scene')[0], 'scene', [], [], { reviewCandidate: {
    issues: [{ unitId: 'minority', resolution: 'open', message: 'Verify this name in context.' }] } });
  const scopes = reviewScopes(round, 'consistency', [scene]);
  assert.equal(scopes.length, 1); assert.deepEqual(scopes[0].unitIds, ['minority']);
  assert.match(scopes[0].reason, /Mina/); assert.match(scopes[0].reason, /Verify this name/);
});

test('an unfinished round without optional glossary data can finish healthy scene work locally', () => {
  const round = roundFor([unit('healthy', 1)]);
  delete round.glossary;
  const scene = task(round, reviewScopes(round, 'scene')[0], 'scene');
  assert.deepEqual(reviewScopes(round, 'consistency', [scene]), []);
  assert.equal(reviewStageComplete(round, [scene], 'consistency'), true);
  assert.deepEqual(reviewGlossary(round, [scene]).entries, []);
  assert.deepEqual(reviewOutcome(round, [scene]).units, round.units);
});

test('retained paid partial work contributes only reconciled text and issues, not the latest streamed page', () => {
  const round = roundFor([unit('saved', 1), unit('streamed', 2)]);
  const scope = { id: 'old-character', unitIds: ['saved', 'streamed'], readIds: ['saved', 'streamed'] };
  const paid = task(round, scope, 'consistency', [], [{ id: 'saved', translation: 'Paid validated value' }, { id: 'streamed', translation: 'Unvalidated value' }],
    { status: 'paused', reviewedUnitIds: ['saved'], reviewReadIds: scope.readIds,
      reviewCandidate: { issues: [{ unitId: 'saved', kind: 'correction', resolution: 'fixed', message: 'Validated change' },
        { unitId: 'streamed', kind: 'needs_evidence', resolution: 'open', message: 'Not reconciled yet' }] } });
  const outcome = reviewOutcome(round, [paid]);
  assert.equal(outcome.units[0].translation, 'Paid validated value');
  assert.equal(outcome.units[1].translation, 'Current streamed');
  assert.deepEqual(outcome.issues.map(issue => issue.unitId), ['saved']);
});
