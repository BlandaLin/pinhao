import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { validateTranslation } from '../exchange/index.mjs';
import { createDependencySnapshot, dependencyHash, dependenciesFresh, createReadReceipt, createQueryReceipt,
  createSemanticState, createSemanticContext, publishSemanticDecisions, freshSemanticPreparation, semanticReuseRecords, retainDependencySnapshot } from './semantic-state.mjs';

const row = (id, patch = {}) => ({ id, source: 'Rose', sourceHash: `source-${id}`, translation: 'Rose', notes: '',
  context: { file: 'scene.json', speaker: id }, tokens: [], revision: 0, status: 'pending', ...patch });
const base = () => [row('actor'), row('item', { kind: 'database_name', context: { file: 'Items.json' } })];
const decide = (units, extra = {}) => ({ id: 'rose-person', entity: 'actor:Rose', sense: 'person name',
  scope: { unitIds: [units[0].id] }, translation: '萝丝', evidenceIds: [units[0].id], expectedRevision: 0, ...extra });
const publish = (units, extra, state) => publishSemanticDecisions(state, [decide(units, extra)],
  { units, receipts: units.map(unit => createReadReceipt(unit, { translation: false })) });

test('dependency snapshots survive JSON persistence and preserve unrelated work', () => {
  const units = base(), snapshot = createDependencySnapshot({ units: [units[0]], promptVersion: 'v1', targetLanguage: 'zh-Hans' });
  const restored = JSON.parse(JSON.stringify(snapshot));
  assert.equal(dependencyHash(restored), dependencyHash(snapshot));
  assert.equal(dependenciesFresh(restored, { units, promptVersion: 'v1', targetLanguage: 'zh-Hans' }), true);
  assert.equal(dependenciesFresh(restored, { units: [units[0], row('item', { source: 'changed' })] }), true);
  assert.equal(dependenciesFresh(restored, { units, promptVersion: 'v2' }), false);
  assert.equal(dependenciesFresh(restored, { units, targetLanguage: 'en' }), false);
});

for (const patch of [{ context: { speaker: 'changed' } }, { controls: { '{{C}}': '\\N[2]' } },
  { source: 'changed' }, { translation: '人工译文' }, { revision: 1 }, { notes: '人工备注' }, { locked: true }]) {
  test(`target dependency changes invalidate results: ${Object.keys(patch)}`, () => {
    const units = base(), snapshot = createDependencySnapshot({ units: [units[0]] });
    assert.equal(dependenciesFresh(snapshot, { units: [{ ...units[0], ...patch }, units[1]] }), false);
  });
}

test('source-only references allow independent translations while actual consumed translations remain bound', () => {
  const units = base(), snapshot = createDependencySnapshot({ units: [units[0]], referenceUnits: [units[1]] });
  const changed = [units[0], { ...units[1], translation: '玫瑰', revision: 1 }];
  assert.equal(dependenciesFresh(snapshot, { units: changed }), true);
  const consumed = createDependencySnapshot({ units: [units[0]], referenceUnits: [changed[1]] });
  assert.equal(dependenciesFresh(consumed, { units }), false);
  assert.equal(dependenciesFresh(snapshot, { units: [units[0], { ...units[1], notes: 'new generated note' }] }), true, 'Empty reference notes were not sent to the model');
  const noted = { ...units[1], notes: 'existing meaning evidence' };
  const noteSnapshot = createDependencySnapshot({ units: [units[0]], referenceUnits: [noted] });
  assert.equal(dependenciesFresh(noteSnapshot, { units: [units[0], { ...noted, notes: 'changed evidence' }] }), false);
});

test('supplementary reads invalidate the target even without a published decision', () => {
  const units = base(), snapshot = createDependencySnapshot({ units: [units[0]], receipts: [createReadReceipt(units[1])] });
  assert.equal(dependenciesFresh(snapshot, { units: [units[0], { ...units[1], source: 'changed' }] }), false);
});

test('selective CAS recovery retains unrelated candidates while keeping explicit evidence dependencies', () => {
  const units = base(), snapshot = createDependencySnapshot({ units });
  const changed = [{ ...units[0], notes: 'manual notes', revision: 1 }, units[1]];
  assert.equal(dependenciesFresh(snapshot, { units: changed }), false);
  const retained = retainDependencySnapshot(snapshot, ['item']);
  assert.equal(dependenciesFresh(retained, { units: changed }), true);
  const explicitRead = createDependencySnapshot({ units, receipts: [createReadReceipt(units[0])] });
  assert.equal(dependenciesFresh(retainDependencySnapshot(explicitRead, ['item']), { units: changed }), false);
  assert.equal(snapshot.targetIds.length, 2);
});

test('negative query receipts detect new hits, removals and changed existing evidence', () => {
  const units = base(), negative = createQueryReceipt(units, { text: 'Captain' });
  const snapshot = createDependencySnapshot({ units: [units[0]], receipts: [negative] });
  assert.equal(dependenciesFresh(snapshot, { units }), true);
  assert.equal(dependenciesFresh(snapshot, { units: [...units, row('late', { source: 'Captain Rose' })] }), false);
  const positive = createDependencySnapshot({ units: [units[0]], receipts: [createQueryReceipt(units, { ids: ['item'] })] });
  assert.equal(dependenciesFresh(positive, { units: [units[0]] }), false);
});

test('glossary dependencies bind the terms actually relevant to the request', () => {
  const units = base(), glossary = { entries: [{ source: 'Rose', translation: '萝丝', status: 'confirmed' }, { source: 'Moon', translation: '月亮', status: 'confirmed' }] };
  const snapshot = createDependencySnapshot({ units: [units[0]], glossary });
  assert.equal(dependenciesFresh(snapshot, { units, glossary: { entries: [glossary.entries[0], { source: 'Moon', translation: '月球' }] } }), true);
  assert.equal(dependenciesFresh(snapshot, { units, glossary: { entries: [{ source: 'Rose', translation: '玫瑰', status: 'confirmed' }] } }), false);
});

test('snapshot contexts share indexes and receipt hashes across preparation and dependency checks', () => {
  const units = base(), state = publish(units);
  const snapshot = createDependencySnapshot({ units: [units[0]], preparation: state,
    receipts: [createQueryReceipt(units, { text: 'Rose' })] });
  let sourceReads = 0;
  for (const unit of units) {
    const source = unit.source;
    Object.defineProperty(unit, 'source', { enumerable: true, get() { sourceReads++; return source; } });
  }
  const context = createSemanticContext(units);
  const preparation = freshSemanticPreparation(state, { units, context });
  assert.equal(dependenciesFresh(snapshot, { units, preparation, context }), true);
  const initialReads = sourceReads;
  assert.ok(initialReads > 0);
  assert.equal(dependenciesFresh(snapshot, { units, preparation: freshSemanticPreparation(state, { units, context }), context }), true);
  assert.equal(sourceReads, initialReads, 'the same snapshot validates cached receipts without re-reading unit content');
  assert.deepEqual(preparation, freshSemanticPreparation(state, { units }));
});

test('empty semantic preparation skips project indexing', () => {
  const units = new Proxy([], { get(target, key) {
    if (key === Symbol.iterator) throw new Error('project scan');
    return Reflect.get(target, key);
  } });
  assert.deepEqual(freshSemanticPreparation(undefined, { units }), createSemanticState());
});

test('new snapshot contexts recheck source, manual changes, query membership and relevant glossary', () => {
  const units = base(), context = createSemanticContext(units), glossary = { entries: [{ source: 'Rose', translation: '萝丝', status: 'confirmed' }] };
  const snapshot = createDependencySnapshot({ units: [units[0]], glossary, receipts: [createQueryReceipt(units, { text: 'Captain' })] });
  assert.equal(dependenciesFresh(snapshot, { units, glossary, context }), true);
  for (const patch of [{ source: 'Changed' }, { translation: '用户译文', revision: 1 }, { notes: '用户备注' }, { manualLock: true }]) {
    const changed = [{ ...units[0], ...patch }, units[1]];
    assert.equal(dependenciesFresh(snapshot, { units: changed, glossary, context: createSemanticContext(changed) }), false);
    assert.equal(dependenciesFresh(snapshot, { units: changed, glossary, context }), false, 'a context from another snapshot is replaced');
  }
  const added = [...units, row('late', { source: 'Captain Rose' })];
  assert.equal(dependenciesFresh(snapshot, { units: added, glossary, context: createSemanticContext(added) }), false);
  assert.equal(dependenciesFresh(snapshot, { units, glossary: { entries: [{ source: 'Rose', translation: '玫瑰', status: 'confirmed' }] }, context }), false);
  units[0].source = 'Updated in-place';
  assert.equal(dependenciesFresh(snapshot, { units, glossary, context: createSemanticContext(units) }), false);
});

test('decisions remain scoped, revisioned and revocable with preserved history', () => {
  const units = base(), state = publish(units);
  const snapshot = createDependencySnapshot({ units: [units[0]], preparation: state });
  assert.equal(dependenciesFresh(snapshot, { units, preparation: state }), true);
  const revised = publish(units, { expectedRevision: 1, translation: '罗丝' }, state);
  assert.equal(revised.decisions[0].revision, 2); assert.equal(revised.history.length, 1);
  assert.equal(dependenciesFresh(snapshot, { units, preparation: revised }), false);
  const revoked = publish(units, { expectedRevision: 2, status: 'revoked' }, revised);
  assert.equal(freshSemanticPreparation(revoked, { units }).decisions.length, 0);
  assert.equal(state.decisions[0].revision, 1, 'publication does not mutate stored state before transaction');
  const itemSnapshot = createDependencySnapshot({ units: [units[1]], preparation: state });
  assert.equal(dependenciesFresh(itemSnapshot, { units, preparation: revised }), true);
});

test('new decisions affect matching in-flight targets while expired decisions leave future work runnable', () => {
  const units = base(), snapshot = createDependencySnapshot({ units: [units[0]] }), state = publish(units);
  assert.equal(dependenciesFresh(snapshot, { units, preparation: state }), false);
  const changed = [{ ...units[0], context: { speaker: 'another actor' } }, units[1]];
  const fresh = freshSemanticPreparation(state, { units: changed });
  assert.equal(fresh.decisions.length, 0); assert.equal(state.decisions.length, 1);
  assert.equal(dependenciesFresh(createDependencySnapshot({ units: [changed[0]], preparation: fresh }), { units: changed, preparation: fresh }), true);
});

test('source-scoped preparation survives its own subsequent translation and notes updates', () => {
  const units = base(), state = publish(units);
  const changed = [{ ...units[0], translation: '萝丝', notes: '确认人物名字', revision: 1 }, units[1]];
  assert.equal(freshSemanticPreparation(state, { units: changed }).decisions.length, 1);
});

for (const extra of [{ scope: { unitIds: ['unknown'] } }, { evidenceIds: ['unknown'] }, { sense: '' }, { expectedRevision: 9 }]) {
  test(`invalid semantic publication remains atomic: ${Object.keys(extra)}`, () => {
    const units = base(), state = createSemanticState();
    assert.throws(() => publish(units, extra, state), { code: 'SEMANTIC_CONFLICT' });
    assert.equal(state.revision, 0); assert.deepEqual(state.decisions, []);
  });
}

test('manual decisions are locked by host actor identity', () => {
  const units = base(), receipts = units.map(unit => createReadReceipt(unit));
  const state = publishSemanticDecisions(undefined, [decide(units, { locked: true })], { units, receipts, actor: 'manual' });
  assert.throws(() => publish(units, { expectedRevision: 1 }, state), /锁定/);
});

test('equivalence requires an explicit scoped decision and native validator', () => {
  const units = [row('from', { translation: '萝丝', status: 'proofread' }), row('to')];
  const state = publish(units, { scope: { unitIds: ['from', 'to'] }, evidenceIds: ['from', 'to'], equivalence: { fromUnitId: 'from', toUnitIds: ['to'] } });
  const decision = state.decisions[0];
  assert.throws(() => semanticReuseRecords(decision, { units }), /原生/);
  const records = semanticReuseRecords(decision, { units, validate: validateTranslation });
  assert.equal(records[0].translation, '萝丝'); assert.equal(records[0].status, 'translated');
  assert.equal(units[1].translation, 'Rose');
  assert.throws(() => semanticReuseRecords(decision, { units: [units[0], { ...units[1], manualLock: true }], validate: validateTranslation }), /独立修改/);
  assert.throws(() => semanticReuseRecords(decision, { units: [units[0], { ...units[1], status: 'translated', translation: '用户译名', revision: 1 }], validate: validateTranslation }), /独立修改/);
});

test('native control validation remains authoritative during semantic reuse', () => {
  const units = [row('from', { translation: '萝丝\\V[2]', status: 'proofread' }), row('to', { context: { protectedControlSyntax: 'rpgmaker-v1' } })];
  const state = publish(units, { scope: { unitIds: ['from', 'to'] }, evidenceIds: ['from', 'to'], equivalence: { fromUnitId: 'from', toUnitIds: ['to'] } });
  assert.throws(() => semanticReuseRecords(state.decisions[0], { units, validate: validateTranslation }));
});

test('serialized semantic decisions and receipts remain valid in a fresh process', () => {
  const units = base(), state = publish(units);
  const input = { units, state, snapshot: createDependencySnapshot({ units: [units[0]], preparation: state }) };
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { readFileSync } from 'node:fs'; import { dependenciesFresh } from './packages/core/semantic-state.mjs'; const x=JSON.parse(readFileSync(0,'utf8')); process.stdout.write(JSON.stringify(dependenciesFresh(x.snapshot,{units:x.units,preparation:x.state})));`], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, 'true');
});
