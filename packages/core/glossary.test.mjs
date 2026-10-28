import test from 'node:test';
import assert from 'node:assert/strict';
import { scanTerminology, terminologyUpdates, terminologyHints, incrementalTerminologyCandidates, terminologyReviewStamp, containsTerm, relevantGlossary, glossaryConflicts, glossaryHash, GLOSSARY_VERSION } from './glossary.mjs';

const unit = (id, source, translation, patch = {}) => ({ id, source, sourceHash: `hash-${id}`, translation, status: 'translated', kind: 'dialogue', tokens: [], context: {}, ...patch });
const line = (id, translation = '米娜', patch = {}) => unit(id, `ミナ、場面${id}です。`, `${translation}，这是场景${id}。`, { termChoices: [{ source: 'ミナ', translation }], ...patch, context: { speaker: 'ミナ', ...patch.context } });
const scan = (units, previous) => scanTerminology(units, previous, 'zh-Hans');
const nineToTwo = () => [unit('name', 'ミナ', '美娜', { kind: 'character_name', context: { actorId: 1 } }),
  ...Array.from({ length: 9 }, (_, index) => line(`a${index}`)), line('b', '美娜')];

test('accepted 9-to-2 decisions select a proven name and only normalize the complete name field', () => {
  const units = nineToTwo(), glossary = scan(units), entry = glossary.entries[0];
  assert.equal(glossary.version, GLOSSARY_VERSION); assert.equal(glossary.prepared, true);
  assert.equal(entry.status, 'confirmed'); assert.equal(entry.translation, '米娜'); assert.equal(entry.identityProven, true);
  assert.deepEqual(entry.votes.map(({ translation, count }) => [translation, count]), [['米娜', 9], ['美娜', 2]]);
  assert.deepEqual(terminologyUpdates(units, glossary), [{ id: 'name', translation: '米娜' }]);
  assert.deepEqual(terminologyHints(glossary, [units.at(-1)]), [{ source: 'ミナ', recommendation: '米娜', variants: [{ translation: '米娜', count: 9 }, { translation: '美娜', count: 2 }], unitIds: ['b'] }]);
  assert.equal(glossaryConflicts(units.at(-1), units.at(-1).translation, glossary).length, 1);
});

test('host normalization preserves the original minority vote and stable hashes on repeated scans', () => {
  const units = nineToTwo(), first = scan(units), updates = new Map(terminologyUpdates(units, first).map(value => [value.id, value.translation]));
  const updated = units.map(value => updates.has(value.id) ? { ...value, translation: updates.get(value.id), terminologyNormalization: {
    sourceHash: value.sourceHash, originalTranslation: value.translation, appliedTranslation: updates.get(value.id),
  } } : value);
  const second = scan(updated, first), third = scan(updated, second);
  assert.deepEqual(second.entries[0].votes, first.entries[0].votes);
  assert.equal(second.hash, first.hash); assert.equal(third.hash, second.hash);
  assert.deepEqual(terminologyUpdates(updated, second), []);
});

test('formal review clears checked disagreements without hiding later edits or overriding a lock', () => {
  const units = nineToTwo();
  units[0].locked = true;
  const first = scan(units), stamp = terminologyReviewStamp(first.entries[0]);
  const reviewed = units.map(value => value.locked ? value : { ...value, status: 'proofread', terminologyReview: {
    sourceHash: value.sourceHash, translation: value.translation, decisions: [stamp],
  } });
  const checked = scan(reviewed, first);
  assert.equal(checked.entries[0].needsReview, false);
  assert.equal(terminologyHints(checked, reviewed).length, 0);
  assert.deepEqual(reviewed.flatMap(value => glossaryConflicts(value, value.translation, checked)), []);
  const edited = reviewed.map(value => value.id === 'a0' ? { ...value, translation: '米娜，这是改过的文字。' } : value);
  assert.equal(scan(edited, checked).entries[0].needsReview, true);
  const changedSource = reviewed.map(value => value.id === 'a0' ? { ...value, sourceHash: 'new-source' } : value);
  assert.equal(scan(changedSource, checked).entries[0].needsReview, true);
});

test('a normalization marker cannot outlive a different source or accepted translation', () => {
  for (const patch of [{ sourceHash: 'old' }, { appliedTranslation: 'old' }]) {
    const value = unit('name', 'ミナ', '米娜', { kind: 'character_name', terminologyNormalization: {
      sourceHash: 'hash-name', appliedTranslation: '米娜', originalTranslation: '美娜', ...patch,
    } });
    assert.equal(scan([value]).entries[0].votes[0].translation, '米娜');
  }
});

test('ties remain disputed and do not invent a traversal-order winner', () => {
  const units = [line('a', '米娜', { context: { actorId: 1 } }), line('b', '美娜', { context: { actorId: 1 } })];
  const entry = scan(units).entries[0];
  assert.equal(entry.status, 'disputed'); assert.equal(entry.translation, 'ミナ'); assert.equal(entry.recommended, undefined);
  assert.deepEqual(terminologyUpdates(units, scan(units)), []);
});

test('unproven identity can show evidence but cannot establish a global canonical', () => {
  const units = [line('a'), line('b'), line('c', '美娜')], glossary = scan(units), entry = glossary.entries[0];
  assert.equal(entry.status, 'disputed'); assert.equal(entry.identityProven, false); assert.equal(entry.recommended, '米娜');
  assert.deepEqual(relevantGlossary(glossary, units), []); assert.equal(terminologyHints(glossary, units).length, 1);
  assert.equal(scan([line('single')]).entries[0].status, 'unresolved');
});

test('different actor IDs and semantic senses are never merged by matching source spelling', () => {
  const units = [line('a', '米娜', { context: { actorId: 1 } }), line('b', '美娜', { context: { actorId: 2 } }),
    unit('teacher', 'マスターが来た', '师父来了', { context: { semanticScope: 'teacher' }, termChoices: [{ source: 'マスター', translation: '师父' }] }),
    unit('shop', 'マスターに聞く', '问问店长', { context: { semanticScope: 'shop' }, termChoices: [{ source: 'マスター', translation: '店长' }] })];
  const glossary = scan(units);
  assert.equal(glossary.entries.length, 4);
  assert.equal(relevantGlossary(glossary, [units[0]])[0].translation, '米娜');
  assert.equal(relevantGlossary(glossary, [units[1]])[0].translation, '美娜');
  assert.equal(relevantGlossary(glossary, [unit('unknown', 'ミナが来た', '')]).length, 0);
  assert.equal(relevantGlossary(glossary, [units[2]])[0].translation, '师父');
  assert.equal(relevantGlossary(glossary, [units[3]])[0].translation, '店长');
});

test('a speaker identity is not transferred to another person mentioned in their dialogue', () => {
  const units = [line('a', '米娜', { context: { speaker: 'アリス', actorId: 1 } })];
  assert.equal(scan(units).entries[0].identityProven, false);
  const unknownSpeaker = line('unknown', '米娜', { context: { speaker: undefined, actorId: 1 } });
  assert.equal(scan([unknownSpeaker]).entries[0].identityProven, false);
});

test('one unproven observed spelling is not a dispute and adds no review prompt', () => {
  const units = [line('single')], glossary = scan(units);
  assert.equal(glossary.entries[0].status, 'unresolved'); assert.equal(glossary.entries[0].needsReview, false);
  assert.deepEqual(terminologyHints(glossary, units), []); assert.deepEqual(terminologyUpdates(units, glossary), []);
});

test('newly accepted terminology is advisory and retains matching targets and evidence', () => {
  const accepted = line('accepted', '米娜', { revision: 1, context: { actorId: 1 } });
  const pending = line('pending', '待翻译', { status: 'pending', context: { actorId: 1 } });
  const glossary = scan([]), before = structuredClone(glossary);
  const candidates = incrementalTerminologyCandidates([accepted, pending], [pending], glossary, 'zh-Hans');
  assert.deepEqual(candidates, [{ source: 'ミナ', category: 'name', scope: { category: 'name', identity: 'actor:1' },
    unitIds: ['pending'], evidenceIds: ['accepted'], variants: [{ translation: '米娜', count: 1, evidenceIds: ['accepted'] }] }]);
  assert.deepEqual(glossary, before);
  assert.deepEqual(relevantGlossary(glossary, [pending]), []);
  assert.deepEqual(terminologyUpdates([accepted, pending], glossary), []);
  assert.equal(Object.hasOwn(candidates[0], 'recommendation'), false);
});

test('incremental terminology excludes pending, skipped and stale term choices', () => {
  const target = line('target', '未翻译', { status: 'pending', context: { actorId: 1 } });
  const observed = [line('pending', '米娜', { status: 'pending', context: { actorId: 1 } }),
    line('skipped', '米娜', { status: 'skipped', context: { actorId: 1 } }),
    line('stale', '美娜', { context: { actorId: 1 }, termChoices: [{ source: 'ミナ', translation: '米娜' }] })];
  assert.deepEqual(incrementalTerminologyCandidates([...observed, target], [target], scan([]), 'zh-Hans'), []);
});

test('incremental terminology keeps actors and semantic senses separate', () => {
  const sources = [line('actor-a', '米娜', { context: { actorId: 1 } }), line('actor-b', '美娜', { context: { actorId: 2 } }),
    unit('teacher', 'マスターが来た', '师父来了', { context: { semanticScope: 'teacher' }, termChoices: [{ source: 'マスター', translation: '师父' }] }),
    unit('shop', 'マスターに聞く', '问问店长', { context: { semanticScope: 'shop' }, termChoices: [{ source: 'マスター', translation: '店长' }] })];
  const a = unit('target-a', 'ミナ', '未翻译', { status: 'pending', kind: 'character_name', context: { actorId: 1 } });
  const shop = unit('target-shop', 'マスターに聞く', '未翻译', { status: 'pending', context: { semanticScope: 'shop' } });
  const unknown = unit('unknown', 'ミナが来た', '未翻译', { status: 'pending' });
  const candidates = incrementalTerminologyCandidates([...sources, a, shop, unknown], [a, shop, unknown], scan([]), 'zh-Hans');
  assert.deepEqual(candidates.map(entry => [entry.unitIds, entry.variants.map(variant => variant.translation)]),
    [[['target-a'], ['米娜']], [['target-shop'], ['店长']]]);
});

test('candidate snapshots update after accepted work without promoting early votes or replacing fixed terminology', () => {
  const first = line('first', '米娜', { context: { actorId: 1 } });
  const second = line('second', '美娜', { context: { actorId: 1 } });
  const target = line('target', '未翻译', { status: 'pending', context: { actorId: 1 } });
  const glossary = scan([first]); glossary.entries[0].locked = true;
  assert.deepEqual(incrementalTerminologyCandidates([first, target], [target], glossary, 'zh-Hans'), []);
  const before = structuredClone(glossary);
  const result = incrementalTerminologyCandidates([first, second, target], [target], glossary, 'zh-Hans');
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].variants.map(variant => variant.translation).sort(), ['米娜', '美娜']);
  assert.equal(Object.hasOwn(result[0], 'recommendation'), false);
  assert.deepEqual(glossary, before);
  assert.equal(relevantGlossary(glossary, [target])[0].translation, '米娜');
});

test('incremental candidates describe current accepted text rather than old normalization votes', () => {
  const accepted = line('accepted', '米娜', { context: { actorId: 1 }, terminologyNormalization: {
    sourceHash: 'hash-accepted', originalTranslation: '美娜，这是旧译文。', appliedTranslation: '米娜，这是场景accepted。',
  }, termChoices: [{ source: 'ミナ', translation: '米娜' }] });
  const target = line('target', '未翻译', { status: 'pending', context: { actorId: 1 } });
  const result = incrementalTerminologyCandidates([accepted, target], [target], scan([]), 'zh-Hans');
  assert.deepEqual(result[0].variants.map(variant => variant.translation), ['米娜']);
});

test('a weak plurality and two actors inside the same broad semantic scope are not automatic winners', () => {
  const units = [line('a', '米娜', { context: { actorId: 1 } }), line('b', '米娜', { context: { actorId: 1 } }),
    line('c', '美娜', { context: { actorId: 1 } }), line('d', '蜜娜', { context: { actorId: 1 } })];
  assert.equal(scan(units).entries[0].status, 'disputed');
  const actors = [line('a', '米娜', { context: { actorId: 1, semanticScope: 'cast' } }), line('b', '美娜', { context: { actorId: 2, semanticScope: 'cast' } })];
  assert.equal(scan(actors).entries.length, 2);
});

test('homonymous actor and item names retain their own field anchors', () => {
  const actor = unit('actor', 'Rose', '萝丝', { legacyId: 'Actors:00001', kind: 'database_name', context: { file: 'Actors.json', record: 1 } });
  const item = unit('item', 'Rose', '玫瑰', { legacyId: 'Items:00001', kind: 'database_name', context: { file: 'Items.json', record: 1 } });
  const glossary = scan([actor, item]); assert.equal(glossary.entries.length, 2);
  assert.equal(relevantGlossary(glossary, [actor])[0].translation, '萝丝');
  assert.equal(relevantGlossary(glossary, [item])[0].translation, '玫瑰');
  assert.equal(relevantGlossary(glossary, [unit('unknown', 'Rose arrives', '')]).length, 0);
});

test('a homonymous speaker does not prove which person is mentioned inside their dialogue', () => {
  const speaker = unit('speaker-name', 'Alex', '阿甲', { kind: 'character_name', context: { actorId: 1 } });
  const other = unit('other-name', 'Alex', '阿乙', { kind: 'character_name', context: { actorId: 2 } });
  const dialogue = unit('talk', 'I met Alex yesterday.', '昨天我见过阿乙。', {
    context: { speaker: 'Alex', actorId: 1 }, termChoices: [{ source: 'Alex', translation: '阿乙' }],
  });
  const glossary = scan([speaker, other, dialogue]);
  const first = glossary.entries.find(entry => entry.scope.identity === 'actor:1');
  const second = glossary.entries.find(entry => entry.scope.identity === 'actor:2');
  assert.deepEqual(first.unitIds, ['speaker-name']);
  assert.deepEqual(second.unitIds, ['other-name']);
  assert.equal(first.status, 'confirmed'); assert.equal(first.needsReview, false);
  assert.equal(second.status, 'confirmed'); assert.equal(second.needsReview, false);
  const mention = glossary.entries.find(entry => entry.unitIds.includes('talk'));
  assert.equal(mention.identityProven, false);
  assert.notEqual(mention.scope.identity, 'actor:1'); assert.notEqual(mention.scope.identity, 'actor:2');
  assert.deepEqual(terminologyHints(glossary, [dialogue]), []);
  assert.deepEqual(relevantGlossary(glossary, [dialogue]), []);
});

test('repeated source text, physical positions, sync groups, fanned-out copies and retries do not manufacture votes', () => {
  const original = line('a', '米娜', { context: { actorId: 1, file: 'Map001.json', event: 1, command: 4 } });
  const units = [original,
    { ...original, id: 'same-source' },
    line('same-position', '米娜', { context: original.context }),
    line('sync-a', '米娜', { context: { actorId: 1 }, syncGroup: 'sync' }),
    line('sync-b', '米娜', { context: { actorId: 1 }, syncGroup: 'sync' }),
    line('fan', '米娜', { context: { actorId: 1, translationSourceUnitId: 'a' } }),
    line('retry', '米娜', { context: { actorId: 1 } }),
    line('retry', '米娜', { context: { actorId: 1 } })];
  const entry = scan(units).entries[0];
  assert.equal(entry.votes[0].count, 3);
  assert.equal(entry.votes[0].unitIds.length, 7);
});

test('conflicting copies of one source do not count as independent votes for either spelling', () => {
  const a = line('a', '米娜', { context: { actorId: 1 } }), b = { ...a, id: 'b', translation: '美娜，另一个译文', termChoices: [{ source: 'ミナ', translation: '美娜' }] };
  const entry = scan([a, b]).entries[0];
  assert.equal(entry.status, 'disputed'); assert.deepEqual(entry.votes.map(value => value.count), [0, 0]);
});

test('manual locks override the plurality and are never rewritten', () => {
  const units = nineToTwo(); units[0].manualLock = true;
  const glossary = scan(units); assert.equal(glossary.entries[0].translation, '美娜');
  assert.deepEqual(terminologyUpdates(units, glossary), []);
  const previous = scan(nineToTwo()); previous.entries[0].translation = '用户译名'; previous.entries[0].locked = true;
  const refreshed = scan(nineToTwo(), previous);
  assert.equal(refreshed.entries[0].translation, '用户译名'); assert.equal(refreshed.entries[0].locked, true);
});

test('conflicting manual decisions remain disputed rather than silently choosing one', () => {
  const units = [line('a', '米娜', { manualLock: true, context: { actorId: 1 } }), line('b', '美娜', { manualLock: true, context: { actorId: 1 } })];
  assert.equal(scan(units).entries[0].status, 'disputed');
});

test('ordinary dialogue without a reported term choice never fabricates a name alignment', () => {
  const units = [unit('a', 'ミナがカウンターに来た。', '米娜来到柜台。'), line('pending', '米娜', { status: 'pending' }),
    line('missing-source', '米娜', { termChoices: [{ source: 'ボブ', translation: '米娜' }] }),
    line('missing-target', '米娜', { termChoices: [{ source: 'ミナ', translation: '美娜' }] })];
  const glossary = scan(units); assert.equal(glossary.entries.length, 0); assert.equal(glossary.prepared, true);
});

test('old generated glossary tasks are discarded while explicit user decisions survive', () => {
  const previous = { targetLanguage: 'zh-Hans', entries: [
    { id: 'old-pending', source: 'アリス', translation: 'アリス', status: 'pending' },
    { id: 'old-generated', source: 'ボブ', translation: '鲍勃', status: 'confirmed' },
    { id: 'manual', source: 'キャロル', translation: '卡萝尔', status: 'confirmed', manualLock: true },
  ] };
  assert.deepEqual(scan([], previous).entries.map(entry => entry.id), ['manual']);
  assert.equal(scanTerminology([], previous, 'en').entries.length, 0);
});

test('control-marked name fields and conflicting synchronization groups are not auto-replaced', () => {
  const units = nineToTwo(); units[0] = { ...units[0], source: '{{CTRL0001}}ミナ{{CTRL0002}}', translation: '{{CTRL0001}}美娜{{CTRL0002}}', tokens: ['{{CTRL0001}}', '{{CTRL0002}}'] };
  assert.deepEqual(terminologyUpdates(units, scan(units)), []);
  const other = nineToTwo(); other[0].syncGroup = 'same';
  other.push(unit('shared', '別の名前', '独立名字', { kind: 'character_name', syncGroup: 'same' }));
  assert.deepEqual(terminologyUpdates(other, scan(other)), []);
});

test('informational checks use explicit correspondences rather than guessing Chinese substrings', () => {
  const units = nineToTwo(), glossary = scan(units);
  const noChoice = unit('other', 'ミナが来た', '美娜来了', { context: { actorId: 1 } });
  assert.equal(glossaryConflicts(noChoice, noChoice.translation, glossary).length, 0);
  assert.notEqual(glossaryHash(glossary.entries), glossaryHash(glossary.entries.map(entry => ({ ...entry, notes: '人工证据' }))));
});

test('Unicode normalization and protected-marker boundaries preserve exact term matching', () => {
  assert.equal(containsTerm('Anna walks.', 'Ann'), false); assert.equal(containsTerm("Ann's book", 'Ann'), true);
  assert.equal(containsTerm('サンタを呼ぶ', 'サン'), false); assert.equal(containsTerm('サンを呼ぶ', 'サン'), true);
  assert.equal(containsTerm('{{Ann}}', 'Ann'), false); assert.equal(containsTerm('ﾎﾞﾌﾞと会う', 'ボブ'), true);
});
