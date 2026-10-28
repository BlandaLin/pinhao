import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { taskPrompt, rebindTextPrompt, sdkProvider, parseModelResponse } from './provider.mjs';
import { createTextWire, decodeTextResponse, textWireRecords, textWireScanner, TEXT_WIRE_VERSION } from './text-wire.mjs';
import { packRequestBatches, requestPromptCharacters } from './request-batches.mjs';
import { validateTranslation } from '../exchange/index.mjs';

const unit = (id, source = 'A complete sentence.\n\nSecond line {{name}}.') => ({ id, source, translation: source, revision: 7, kind: 'dialogue', tokens: ['{{name}}'],
  context: { file: 'Game_Data/Managed/Private.dll', field: 'sentences', speaker: 'Traveler', sceneId: 'scene-canonical-hash', syncGroup: 'linked-private-hash',
    sourceHash: 'private-hash', controlBindings: { '{{name}}': 'Character name' } } });
const units = [unit('unit-canonical-a'), unit('unit-canonical-b')];
const refs = [unit('reference-canonical-c', 'A complete context sentence.')];
const refFor = (wire, id) => wire.state.entries.find(entry => entry[1] === id)[0];

test('existing notes remain non-authoritative commentary and cannot invent source protection markers', () => {
  const row = { id: 'action-suffix', source: 'is watching.', translation: '正在观察。', notes: 'Action message: {{name}} is watching.',
    tokens: [], kind: 'database_message1', context: { file: 'data/Skills.json', record: 7, field: 'message1', controlBindings: {} } };
  for (const role of ['translation', 'proofreading']) {
    const request = taskPrompt(role, [row], 'zh-Hans', [], [], { reviewProtocol: role === 'proofreading' });
    assert.ok(!request.system.includes('人工备注'), 'Unattributed model notes must not be presented as human authority');
    assert.match(request.system, /备注.*不是原文.*不是.*保护标记/);
    assert.match(request.prompt, /参考备注（非正文）/);
    assert.ok(request.prompt.includes(row.notes), 'Keep the explanation available instead of silently deleting it');
    assert.deepEqual(request.wire.payload.units[0].controls, {});
  }
  assert.throws(() => validateTranslation(row, '{{name}}正在观察。'), /保护标记/);
  assert.doesNotThrow(() => validateTranslation(row, row.translation));
});

test('the text packet carries complete words and short references, not engineering identity or a JSON unit catalog', () => {
  const literal = 'Do not rewrite unit-canonical-a or scene-canonical-hash inside source.\n\n';
  const prompt = taskPrompt('translation', [unit('unit-canonical-a', literal)], 'zh-Hans', refs, []);
  assert.ok(prompt.prompt.startsWith('【待处理文字】'));
  assert.ok(prompt.prompt.includes(literal));
  assert.ok(!prompt.prompt.includes('Private.dll'));
  assert.ok(!prompt.prompt.includes('sourceHash'));
  assert.ok(!prompt.prompt.includes('"revision"'));
  assert.ok(!prompt.prompt.includes('reference-canonical-c'));
  assert.ok(!prompt.prompt.includes('linked-private-hash'));
  assert.ok(prompt.prompt.includes('Traveler'));
  assert.equal(prompt.wire.payload.units[0].revision, 7, 'captured host material retains the revision');
});

test('translation tuples preserve multiline and empty text literally and reject duplicate, unknown and reference spoofing', () => {
  const { wire } = taskPrompt('translation', units, 'zh-Hans', refs);
  const a = refFor(wire, units[0].id), b = refFor(wire, units[1].id), r = refFor(wire, refs[0].id);
  const text = '译文\n\n{{name}} unit-canonical-a';
  assert.deepEqual(decodeTextResponse({ text: [[a, text, ''], [b, '', '保留空单元']] }, wire).records,
    [{ id: units[0].id, translation: text, notes: '' }, { id: units[1].id, translation: '', notes: '保留空单元' }]);
  for (const rows of [[[a, '一'], [a, '二']], [['unknown', '一']], [[r, '一']], [[units[0].id, '一']]]) {
    assert.throws(() => textWireRecords(rows, wire), { code: 'INVALID_RESPONSE' });
  }
  assert.throws(() => decodeTextResponse({ records: [{ id: a, translation: '旧协议' }] }, wire), { code: 'INVALID_RESPONSE' });
});

test('optional first-translation terms bind actual source and final text without sacrificing a paid record', () => {
  const rows = [unit('name-unit', 'Ａｌｉｃｅ met Bob. {{SecretName}}'), unit('other-unit', 'Return to the Guild.')];
  const { wire } = taskPrompt('translation', rows, 'zh-Hans', refs);
  const a = refFor(wire, rows[0].id), b = refFor(wire, rows[1].id), reference = refFor(wire, refs[0].id);
  const text = [[a, '爱丽丝遇见鲍勃。{{SecretName}}'], [b, '返回公会。']];
  const decoded = decodeTextResponse({ text, terms: [[a, 'Alice', '爱丽丝'], [a, 'Bob', '鲍勃'], [b, 'Guild', '公会'],
    [a, 'Alice', '爱丽丝'], ['unknown', 'Alice', '爱丽丝'], [reference, 'context', '公会'],
    [a, 'SecretName', '{{SecretName}}'], [a, '\0', '爱丽丝'], [a, 'Alicia', '爱丽丝'], [a, 'Alice', '艾丽西亚'], [a, 'Alice'], null] }, wire);
  assert.deepEqual(decoded.records, [{ id: rows[0].id, translation: text[0][1], notes: '',
    termChoices: [{ source: 'Alice', translation: '爱丽丝' }, { source: 'Bob', translation: '鲍勃' }] },
  { id: rows[1].id, translation: text[1][1], notes: '', termChoices: [{ source: 'Guild', translation: '公会' }] }]);
  assert.deepEqual(decoded.termWarnings.map(warning => warning.code), ['DUPLICATE_TERM', 'UNKNOWN_TERM_TARGET', 'UNKNOWN_TERM_TARGET',
    'TERM_TEXT_MISMATCH', 'TERM_TEXT_MISMATCH', 'TERM_TEXT_MISMATCH', 'TERM_TEXT_MISMATCH', 'INVALID_TERM', 'INVALID_TERM']);
  assert.equal(decodeTextResponse({ text, terms: null }, wire).termWarnings[0].code, 'INVALID_TERMS');
  assert.deepEqual(decodeTextResponse({ text, terms: null }, wire).records, decodeTextResponse({ text }, wire).records);
  assert.equal(decodeTextResponse({ text }, wire).termWarnings, undefined);
  assert.throws(() => decodeTextResponse({ text: [[a, '一'], [a, '二']], terms: [] }, wire), { code: 'INVALID_RESPONSE' });
});

test('terminology disagreements show only relevant short-bound language hints without a separate glossary stage', () => {
  const prompt = taskPrompt('translation', units, 'zh-Hans', refs, [], { terminologyHints: [
    { source: 'Alice', recommendation: '爱丽丝', variants: [{ translation: '爱丽丝', count: 3, privatePath: 'not-sent' },
      { translation: '艾丽丝', count: 1 }], unitIds: [units[0].id, refs[0].id, 'unrelated-unit'], revision: 99, hash: 'not-sent' },
    { source: 'UnrelatedTerm', variants: [{ translation: '无关', count: 12 }], unitIds: ['unrelated-unit'] } ] });
  assert.ok(prompt.system.includes('初翻时可顺手附 terms:'));
  assert.ok(prompt.system.includes('"read"'));
  assert.ok(prompt.system.includes('decisions:'));
  assert.ok(prompt.prompt.includes('【译名分歧】'));
  const hint = JSON.parse(prompt.prompt.split('【译名分歧】\n')[1].split('\n')[0]);
  assert.deepEqual(hint, [{ source: 'Alice', recommendation: '爱丽丝', variants: [{ translation: '爱丽丝', count: 3 },
    { translation: '艾丽丝', count: 1 }], unitIds: [refFor(prompt.wire, units[0].id)] }]);
  assert.ok(!prompt.prompt.includes('UnrelatedTerm'));
  assert.ok(!prompt.prompt.includes('not-sent'));
  assert.ok(!prompt.prompt.includes('unrelated-unit'));
  assert.ok(!prompt.system.includes('收录规则'));
  const review = taskPrompt('proofreading', units, 'zh-Hans', refs, [], { reviewProtocol: true });
  assert.ok(!review.system.includes('初翻时可顺手附 terms:'));
  assert.ok(review.system.includes('"read"'));
  const a = refFor(review.wire, units[0].id), b = refFor(review.wire, units[1].id);
  const reviewed = decodeTextResponse({ reviewed: [a, b], terms: [[a, 'Alice', '爱丽丝']] }, review.wire);
  assert.equal(reviewed.review.edits.length, 0);
  assert.equal(reviewed.termWarnings[0].code, 'REVIEW_TERMS_IGNORED');
});

test('root tuple streaming survives every split and never checkpoints a nested array or quoted text property', () => {
  const raw = JSON.stringify({ notes: '文字包含 "text":[["u1","假的"]]', read: [{ text: [['u1', '假的']] }], text: [['u1', '完整\n\n{{name}}'], ['u2', '第二条']] });
  const scan = textWireScanner(), rows = [];
  for (const char of raw) rows.push(...scan(char));
  assert.deepEqual(rows, [['u1', '完整\n\n{{name}}'], ['u2', '第二条']]);
  assert.deepEqual(textWireScanner()(JSON.stringify({ read: [{ text: [['u1', '假的']] }] })), []);
});

test('review only returns changes and keeps exact target coverage with strict host D2 fields', () => {
  const { wire } = taskPrompt('proofreading', units, 'zh-Hans', refs, [], { reviewProtocol: true });
  const a = refFor(wire, units[0].id), b = refFor(wire, units[1].id), r = refFor(wire, refs[0].id);
  const response = decodeTextResponse({ reviewed: [a, b], changes: [[a, '完整改文 {{name}}', '修正主客体']], questions: [[b, 'needs_evidence', '待确认人物']] }, wire);
  assert.equal(response.review.protocol, 'pinhao-review-1');
  assert.deepEqual(response.review.reviewedIds, units.map(unit => unit.id));
  assert.deepEqual(response.review.edits, [{ id: units[0].id, translation: '完整改文 {{name}}' }]);
  assert.equal(response.review.issues[0].resolution, 'fixed');
  assert.equal(response.review.issues[1].resolution, 'open');
  for (const reviewed of [[a], [a, a], [a, r]]) assert.throws(() => decodeTextResponse({ reviewed, changes: [], questions: [] }, wire), { code: 'INVALID_RESPONSE' });
  assert.deepEqual(decodeTextResponse({ reviewed: [a, b], changes: [], questions: [] }, wire).review.edits, []);
  assert.deepEqual(decodeTextResponse({ reviewed: [a, b] }, wire).review, { protocol: 'pinhao-review-1', reviewedIds: units.map(unit => unit.id), edits: [], issues: [] });
  assert.deepEqual(decodeTextResponse({ reviewed: [a, b], changes: [[a, '完整改文 {{name}}', '修正主客体']] }, wire).review.edits, response.review.edits);
  for (const key of ['changes', 'questions']) for (const invalid of [null, {}, '']) {
    assert.throws(() => decodeTextResponse({ reviewed: [a, b], [key]: invalid }, wire), { code: 'INVALID_RESPONSE' });
  }
  assert.throws(() => decodeTextResponse({ changes: [], questions: [] }, wire), { code: 'INVALID_RESPONSE' });
});

test('partial review decoding isolates only attributable malformed rows and keeps explicit coverage', () => {
  const { wire } = taskPrompt('proofreading', units, 'zh-Hans', refs, [], { reviewProtocol: true });
  const a = refFor(wire, units[0].id), b = refFor(wire, units[1].id);
  const result = decodeTextResponse({ reviewed: [a, b], changes: [[a, '完整改文 {{name}}', '修正依据'], [b, 9, '不是完整译文']] }, wire, { allowPartialReview: true });
  assert.deepEqual(result.review.edits.map(edit => edit.id), [units[0].id]);
  assert.deepEqual(result.review.invalidEntries.map(entry => entry.unitId), [units[1].id]);
  assert.deepEqual(result.review.reviewedIds, units.map(unit => unit.id));
  assert.deepEqual(decodeTextResponse({ reviewed: [a] }, wire, { allowPartialReview: true }).review.reviewedIds, [units[0].id]);
  for (const changes of [[['unknown', '改文', '依据']], [{}]]) {
    assert.throws(() => decodeTextResponse({ reviewed: [a, b], changes }, wire, { allowPartialReview: true }), { code: 'INVALID_RESPONSE' });
  }
});

test('accepted name candidates stay read-only, scoped and distinct from confirmed glossary rules', () => {
  const candidate = { source: 'Alice', category: 'person', scope: { characterId: 'person-alice' }, unitIds: [units[0].id], evidenceIds: [refs[0].id],
    variants: [{ translation: '爱丽丝', count: 2, evidenceIds: [refs[0].id] }] };
  const payload = { task: 'translation', units, referenceOnly: refs, glossary: [], terminologyCandidates: [candidate] };
  const wire = createTextWire(payload);
  assert.ok(wire.prompt.includes('已接纳译名候选，只读（非确认规则）'));
  assert.ok(wire.prompt.includes('不因多数票强制统一')); assert.ok(wire.prompt.includes('爱丽丝'));
  assert.ok(!wire.prompt.includes(refs[0].id));
  assert.deepEqual(wire.targetIds, units.map(unit => unit.id));
});

test('all structured unit references and scene queries map locally while literal query text remains untouched', () => {
  const scope = 'scene-canonical-hash';
  const { wire } = taskPrompt('translation', units, 'zh-Hans', refs, [], { story: { scopes: [{ id: scope, targetUnitIds: units.map(unit => unit.id), query: { story: { kind: 'scene', id: scope } } }] },
    preparation: [{ id: 'semantic-private-id', revision: 4, entity: 'Guide', sense: 'a person', translation: '向导', scope: { unitIds: units.map(unit => unit.id) }, evidenceIds: [refs[0].id] }],
    reviewScope: { alternatives: { [units[0].id]: [{ translation: '另一个完整译文', evidenceIds: [refs[0].id] }] } } });
  assert.ok(!wire.prompt.includes('semantic-private-id'));
  assert.ok(!wire.prompt.includes(scope));
  const a = refFor(wire, units[0].id), b = refFor(wire, units[1].id), r = refFor(wire, refs[0].id), s = refFor(wire, scope);
  const result = decodeTextResponse({ read: [{ ids: [r], text: 'unit-canonical-a', story: { kind: 'scene', id: s }, offset: 0, limit: 16 }],
    notes: `${r}说明人物关系。`, decisions: [{ ref: refFor(wire, 'semantic-private-id'), entity: 'Guide', sense: 'a person', translation: '向导',
      scope: { unitIds: [a, b] }, evidenceIds: [r], equivalence: { fromUnitId: r, toUnitIds: [a, b] } }] }, wire);
  assert.equal(result.evidenceRequests[0].query.text, 'unit-canonical-a');
  assert.equal(result.evidenceRequests[0].query.story.id, scope);
  assert.deepEqual(result.evidenceRequests[0].query.ids, [refs[0].id]);
  assert.equal(result.semanticDecisions[0].expectedRevision, 4);
  assert.deepEqual(result.semanticDecisions[0].equivalence.toUnitIds, units.map(unit => unit.id));
  for (const response of [{ read: [{ ids: [units[0].id] }] }, { read: [{ story: { kind: 'scene', id: 'unknown' } }] },
    { text: [], decisions: [{ ref: 'unknown', entity: 'Guide', sense: 'person', scope: { unitIds: [a] }, evidenceIds: [a] }] }]) {
    assert.throws(() => decodeTextResponse(response, wire), { code: 'INVALID_RESPONSE' });
  }
  const indexOnly = taskPrompt('translation', units, 'zh-Hans', [], [], { story: { scopes: [{ id: scope, total: 100,
    unitIds: Array.from({ length: 100 }, (_, i) => `private-member-${i}`), targetUnitIds: units.map(unit => unit.id),
    query: { story: { kind: 'scene', id: scope } } }] } });
  assert.ok(!indexOnly.prompt.includes('private-member-'));
  assert.ok(!indexOnly.prompt.includes('targetUnitIds'));
  assert.ok(indexOnly.prompt.includes('"total":100'));
});

test('review prompt names exact paid targets and reports reference or material identity mistakes precisely', () => {
  const { wire, prompt } = taskPrompt('proofreading', units, 'zh-Hans', refs, [], { reviewProtocol: true,
    story: { scopes: [{ id: 'material-scene-only', kind: 'scene' }] } });
  const a = refFor(wire, units[0].id), b = refFor(wire, units[1].id), reference = refFor(wire, refs[0].id);
  const scene = refFor(wire, 'material-scene-only');
  assert.ok(prompt.includes(`本次目标标记：${JSON.stringify([a, b])}`));
  assert.throws(() => decodeTextResponse({ reviewed: [a, b, reference] }, wire), error =>
    error.code === 'INVALID_RESPONSE' && error.message.includes(reference) && error.message.includes('只读参考') && error.message.includes(JSON.stringify([a, b])));
  assert.throws(() => decodeTextResponse({ read: [{ ids: [scene] }] }, wire), error =>
    error.code === 'INVALID_RESPONSE' && error.message.includes(scene) && error.message.includes('read.story'));
});

test('optional null notes mean absent notes without accepting bad targets, edits or arbitrary values', () => {
  const { wire } = taskPrompt('proofreading', units, 'zh-Hans', refs, [], { reviewProtocol: true });
  const a = refFor(wire, units[0].id), b = refFor(wire, units[1].id);
  const edit = text => decodeTextResponse({ reviewed: [a, b], changes: [[a, text, '修正主客体', null]] }, wire).review.edits[0];
  assert.deepEqual(edit('完整改文 {{name}}'), { id: units[0].id, translation: '完整改文 {{name}}' });
  for (const note of [{}, [], 1, false]) assert.throws(() => decodeTextResponse({ reviewed: [a, b],
    changes: [[a, '完整改文 {{name}}', '修改依据', note]] }, wire), { code: 'INVALID_RESPONSE' });
  assert.throws(() => decodeTextResponse({ reviewed: [a, b], changes: [['unknown', '改文', '依据', null]] }, wire), { code: 'INVALID_RESPONSE' });
  const translation = taskPrompt('translation', units, 'zh-Hans').wire;
  const x = refFor(translation, units[0].id), y = refFor(translation, units[1].id);
  assert.deepEqual(decodeTextResponse({ text: [[x, '译文一', null], [y, '译文二']] }, translation).records,
    [{ id: units[0].id, translation: '译文一', notes: '' }, { id: units[1].id, translation: '译文二', notes: '' }]);
});

test('task state keeps reading notes and references stable through page changes, partial targets and serialized resume', () => {
  const first = taskPrompt('translation', units, 'zh-Hans', refs);
  const original = refFor(first.wire, refs[0].id), notes = `${original} confirms the speaker.`;
  const next = taskPrompt('translation', [units[1]], 'zh-Hans', [unit('new-reference', 'New complete scene.')], [], { readingNotes: notes });
  const rebound = rebindTextPrompt(next, JSON.parse(JSON.stringify(first.wire.state)));
  assert.equal(refFor(rebound.wire, refs[0].id), original);
  assert.equal(refFor(rebound.wire, units[1].id), refFor(first.wire, units[1].id));
  assert.ok(rebound.prompt.includes(notes));
  assert.throws(() => textWireRecords([[refFor(rebound.wire, units[0].id), '不能重交']], rebound.wire), { code: 'INVALID_RESPONSE' });
});

test('packing estimates the exact same compact projection and never splits full linked semantic groups', () => {
  const rows = Array.from({ length: 35 }, (_, index) => ({ ...unit(`canonical-${index}`, `完整场景 ${index}\n\n${'台词。'.repeat(45)}`), context: { speaker: 'Traveler' } }));
  const options = { maxCharacters: 6500, maxUnits: 16 };
  const batches = packRequestBatches(rows.map(row => [row]), { ...options, allUnits: rows, referenceSelector: () => [] });
  assert.equal(batches.flat().length, rows.length);
  for (const batch of batches) {
    const prompt = taskPrompt('translation', batch, 'zh-Hans', [], [], { maxCharacters: options.maxCharacters });
    assert.equal(prompt.budget.characters, requestPromptCharacters(prompt));
    assert.ok(prompt.budget.characters <= options.maxCharacters);
    for (const row of batch) assert.ok(prompt.prompt.includes(row.source));
  }
});

test('only complete new-wire tuples recover from malformed JSON without guessing user text', () => {
  const raw = '{"text":[["u1","完整改文"],["u2","口号中"夺回"的对象"]]}';
  const parsed = parseModelResponse(raw, { finishReason: 'stop', responseProtocol: TEXT_WIRE_VERSION });
  assert.deepEqual(parsed.text, [['u1', '完整改文']]);
  assert.throws(() => parseModelResponse(raw, { finishReason: 'length', responseProtocol: TEXT_WIRE_VERSION }), { code: 'MODEL_OUTPUT_TRUNCATED' });
});

test('repeated identical context evidence is complete once while independent target text remains complete', () => {
  const source = 'A complete common scene. '.repeat(100);
  const payload = { task: 'translation', glossary: [], referenceOnly: [], units: [0, 1].map(index => ({ id: `target-${index}`,
    source: 'An independent repeated display.', currentTranslation: `现译${index}`, controls: { '{{x}}': `control-${index}` },
    context: { speaker: `speaker-${index}`, evidence: [{ source, context: { speaker: 'Witness' } }] } })) };
  const wire = createTextWire(payload);
  assert.equal(wire.prompt.split(source).length - 1, 1);
  assert.equal(wire.prompt.split(payload.units[0].source).length - 1, 2);
  for (const unit of payload.units) {
    assert.ok(wire.prompt.includes(unit.currentTranslation)); assert.ok(wire.prompt.includes(unit.controls['{{x}}']));
    assert.ok(wire.prompt.includes(unit.context.speaker));
    assert.equal(unit.context.evidence[0].source, source, 'Host material remains unchanged');
  }
  assert.ok(wire.prompt.includes('readOnlyText')); assert.ok(wire.prompt.includes('Witness'));
});

test('native display-call evidence and structured metadata remain valid context without pretending to be text lists', () => {
  const contexts = [{ evidence: 'display_call:showMsj' }, { evidence: { kind: 'script-call', description: 'A visible menu title.' } }];
  const wire = createTextWire({ task: 'translation', glossary: [], referenceOnly: [], units: contexts.map((context, index) => ({
    id: `native-${index}`, source: `Menu ${index}`, context,
  })) });
  assert.ok(wire.prompt.includes('display_call:showMsj'));
  assert.ok(wire.prompt.includes('A visible menu title.'));
  assert.equal(wire.prompt.includes('共用语境原文'), false);
  assert.deepEqual(wire.payload.units.map(unit => unit.context), contexts);
});

test('equal evidence wording with a different semantic context is not merged', () => {
  const source = 'The same words mean different things here.';
  const wire = createTextWire({ task: 'translation', glossary: [], referenceOnly: [], units: [0, 1].map(index => ({ id: `target-${index}`, source: `Target ${index}`,
    context: { evidence: [{ source, context: { speaker: `Witness-${index}` } }] } })) });
  assert.equal(wire.prompt.split(source).length - 1, 2);
  assert.ok(wire.prompt.includes('Witness-0')); assert.ok(wire.prompt.includes('Witness-1'));
  assert.ok(!wire.prompt.includes('共用语境原文'));
});

test('shared context references bind content across continued reading notes and process serialization', () => {
  const payload = source => ({ task: 'translation', glossary: [], referenceOnly: [], units: [0, 1].map(index => ({ id: `target-${index}`, source: `Target ${index}`,
    context: { evidence: [{ source }] } })) });
  const first = createTextWire(payload('A complete earlier scene.'));
  const [previousRef, previousId] = first.state.entries.find(([, id]) => id.startsWith('context-text-'));
  const continued = createTextWire({ ...payload('A different complete scene.'), readingNotes: `Earlier evidence was ${previousRef}.` }, JSON.parse(JSON.stringify(first.state)));
  assert.equal(new Map(continued.state.entries).get(previousRef), previousId);
  const [nextRef] = continued.state.entries.find(([, id]) => id.startsWith('context-text-') && id !== previousId);
  assert.notEqual(nextRef, previousRef); assert.ok(continued.prompt.includes(`Earlier evidence was ${previousRef}.`));
  const resumed = createTextWire(payload('A complete earlier scene.'), continued.state);
  assert.equal(resumed.state.entries.find(([, id]) => id === previousId)[0], previousRef);
  assert.equal(resumed.prompt.split('A complete earlier scene.').length - 1, 1);
});

test('real SDK streaming checkpoints canonical host IDs and returns the compact protocol without altering literal text', async t => {
  const prompt = taskPrompt('translation', [units[0]], 'zh-Hans');
  const ref = refFor(prompt.wire, units[0].id), value = `完整\n\n{{name}} unit-canonical-a`;
  const body = JSON.stringify({ text: [[ref, value, '']] });
  const server = http.createServer(async (request, response) => {
    let received = ''; for await (const chunk of request) received += chunk;
    const sent = JSON.parse(received);
    assert.equal(sent.messages.at(-1).content, prompt.prompt);
    assert.ok(!sent.messages.at(-1).content.includes('Private.dll'));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const text of [body.slice(0, 18), body.slice(18)]) response.write(`data: ${JSON.stringify({ id: 'neutral-wire', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ id: 'neutral-wire', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const checkpointed = [];
  const result = await sdkProvider({ connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'neutral', apiKey: 'neutral' }, ...prompt,
    onRecords: rows => checkpointed.push(...rows) });
  assert.deepEqual(result.records, [{ id: units[0].id, translation: value, notes: '' }]);
  assert.deepEqual(checkpointed, result.records);
});
