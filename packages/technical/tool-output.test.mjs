import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { toolModelMessageSchema, modelMessageSchema } from 'ai';
import { boundedToolOutput, deduplicateToolMessages, restoreToolCheckpoint, supplementalObservations } from './adaptation/tool-output.mjs';
import { createEvidenceStore } from './adaptation/evidence.mjs';

const review = () => ({ schema: 'pinhao-native-field-review-v1', offset: 3, total: 4, nextOffset: null,
  groups: [{ groupId: `native-review-v1:${'a'.repeat(16)}:${'b'.repeat(24)}`, evidenceHash: 'c'.repeat(64),
    file: 'Neutral_Data/level1', fieldUses: { available: true, schema: 'pinhao-unity-field-uses-v1',
      assemblySha256: 'd'.repeat(64), assemblyFile: 'Neutral_Data/Managed/Assembly-CSharp.dll',
      fields: [{ path: ['Identity'], field: 'System.String Neutral.Choice::Identity', directRewrite: false,
        uses: [{ siteId: `display-site-v1:${'e'.repeat(64)}`, method: 'System.Void Neutral.Choice::Show()', offset: 45,
          displayOnly: true, display: true, unresolvedOrBusinessUse: false,
          receivers: ['UnityEngine.UI.Text Neutral.Choice::Label'],
          calls: ['System.Void Neutral.Choice::Show()@0032 -> System.Void UnityEngine.UI.Text::set_text(System.String)'] }] }] } }] });

for (const wrapped of [false, true]) {
  test(`native field consumer calls and receivers survive ${wrapped ? 'SDK JSON wrapper' : 'raw output'} depth`, () => {
    const original = review(), output = wrapped ? { type: 'json', value: original } : original;
    const bounded = boundedToolOutput(output, { maxCharacters: 24000 });
    const page = wrapped ? bounded.value : bounded;
    assert.deepEqual(page.groups[0].fieldUses, original.groups[0].fieldUses);
    assert.equal(page.outputTruncated, undefined);
    assert.deepEqual(page.fieldCursors.groups, { offset: 3, returned: 1, nextOffset: null });
  });
}

test('native depth repair retains the character ceiling and group pagination', () => {
  const original = review();
  original.groups = Array.from({ length: 30 }, () => structuredClone(original.groups[0]));
  original.total = 33;
  const page = boundedToolOutput(original, { maxCharacters: 8000 });
  assert.ok(JSON.stringify(page).length <= 8000);
  assert.equal(page.outputTruncated, true);
  assert.ok(page.groups.length < original.groups.length);
  assert.deepEqual(page.fieldCursors.groups, { offset: 3, returned: page.groups.length, nextOffset: 3 + page.groups.length });
});

test('non-native output keeps its existing depth boundary', () => {
  const page = boundedToolOutput({ ...review(), schema: 'neutral-other-tool-v1' }, { maxCharacters: 24000 });
  assert.equal(page.outputTruncated, true);
  assert.equal(page.groups[0].fieldUses.fields[0].uses[0], '[记录已省略，可分页读取]');
});

for (const truncate of [false, true]) test(`search scan navigation stays distinct from ${truncate ? 'truncated' : 'complete'} snapshot items`, () => {
  const original = { query: 'label', content: true, mode: 'content', relativePath: 'scripts', offset: 80,
    items: Array.from({ length: truncate ? 100 : 2 }, (_, index) => ({ file: `scripts/scene${index}.gd`, line: 1, snippet: 'A neutral display consumer. '.repeat(truncate ? 20 : 1) })),
    nextOffset: 160, nextCall: { tool: 'search_files', input: { query: 'label', content: true, relativePath: 'scripts', offset: 160, limit: 40 } },
    evidenceId: `evidence-${'1'.repeat(64)}`, route: 'script' };
  const page = boundedToolOutput(original, { maxCharacters: truncate ? 8000 : 24000 });
  assert.equal(page.nextOffset, 160); assert.deepEqual(page.nextCall, original.nextCall);
  assert.equal(page.route, 'script');
  assert.deepEqual(page.fieldCursors.items, { offset: 0, returned: page.items.length, nextOffset: page.items.length < original.items.length ? page.items.length : null });
  assert.equal(page.items.length < original.items.length, truncate);
  assert.ok(JSON.stringify(page).length <= (truncate ? 8000 : 24000));
});

const candidateRows = count => Array.from({ length: count }, (_, index) => ({ id: `candidate-${index}`, source: 'A complete neutral display sentence. '.repeat(12),
  evidenceHash: index.toString(16).padStart(64, '0'), locator: { file: 'data/scene.json', pointer: `/lines/${index}` } }));

test('repeated checkpoint projections retain existing array bases when the source offset was already omitted', () => {
  const original = { evidenceId: `evidence-${'7'.repeat(64)}`, records: [], total: 1, expressionCandidates: candidateRows(13), expressionTotal: 256,
    nextOffset: 63, nextPage: { tool: 'inspect_coverage', input: { offset: 63, limit: 100, kind: 'extracted' } },
    fieldCursors: { records: { offset: 50, returned: 0, nextOffset: null }, expressionCandidates: { offset: 50, returned: 13, nextOffset: 63 },
      unknownClusters: { offset: 50, returned: 0, nextOffset: null } }, fieldCounts: { expressionCandidates: 100 } };
  const first = boundedToolOutput(original);
  assert.equal(first.nextOffset, 63); assert.deepEqual(first.nextPage, original.nextPage);
  assert.deepEqual(first.fieldCursors, original.fieldCursors);
  assert.deepEqual(first.expressionCandidates, original.expressionCandidates);
  const second = boundedToolOutput(first);
  assert.deepEqual(second, first, 'compressing a checkpoint again cannot rewrite its page contract');
});

test('multiple array continuations and exact rows survive late navigation fields and repeated smaller previews', () => {
  const original = { records: [], dynamicCandidates: candidateRows(40), nativeReviewIssues: [], expressionCandidates: candidateRows(40), unknownClusters: [],
    total: 1, dynamicTotal: 160, nativeReviewTotal: 0, expressionTotal: 256, unknownTotal: 0, offset: 50, nextOffset: 90,
    nextPage: { tool: 'inspect_coverage', input: { offset: 90, limit: 40, kind: 'extracted' } } };
  const first = boundedToolOutput(original, { maxCharacters: 12000 });
  for (const key of ['records', 'dynamicCandidates', 'nativeReviewIssues', 'expressionCandidates', 'unknownClusters']) assert.equal(first.fieldCursors[key].offset, 50);
  assert.equal(first.fieldCursors.records.nextOffset, null, 'a finished short sibling cannot send the whole page back to zero');
  for (const key of ['dynamicCandidates', 'expressionCandidates']) assert.deepEqual(first[key], original[key].slice(0, first[key].length));
  const second = boundedToolOutput(first, { maxCharacters: 8000 });
  const third = boundedToolOutput(second, { maxCharacters: 8000 });
  assert.deepEqual(third, second); assert.equal(second.offset, 50);
  assert.equal(second.fieldCounts.dynamicCandidates, 40);
  assert.ok(JSON.stringify(second).length <= 8000);
});

test('inspectable unit pages never deliver a budget-truncated candidate identity or change their base', () => {
  const original = { units: candidateRows(20), total: 150, offset: 80, nextOffset: 100 };
  const first = boundedToolOutput({ type: 'json', value: original }, { maxCharacters: 6000 });
  assert.ok(first.value.units.length > 0 && first.value.units.length < 20);
  assert.deepEqual(first.value.units, original.units.slice(0, first.value.units.length));
  assert.equal(first.value.fieldCursors.units.offset, 80);
  assert.equal(first.value.nextOffset, 80 + first.value.units.length);
  assert.deepEqual(boundedToolOutput(first, { maxCharacters: 6000 }), first);
});

test('repeated search projections preserve scan inputs and the complete snapshot continuation count', () => {
  const input = { query: 'caption', content: true, route: 'script', relativePath: 'js', sourceIndex: 1, offset: 160, limit: 40 };
  const original = { items: candidateRows(60), query: 'caption', content: true, mode: 'content', route: 'script', relativePath: 'js', sourceIndex: 1,
    offset: 80, nextOffset: 160, nextCall: { tool: 'search_files', input }, evidenceId: `evidence-${'8'.repeat(64)}` };
  const before = JSON.stringify(original), first = boundedToolOutput(original, { maxCharacters: 10000 });
  const second = boundedToolOutput(first, { maxCharacters: 7000 }), third = boundedToolOutput(second, { maxCharacters: 7000 });
  assert.deepEqual(third, second); assert.equal(second.nextOffset, 160); assert.deepEqual(second.nextCall.input, input);
  assert.equal(second.fieldCounts.items, 60);
  assert.equal(second.fieldCursors.items.nextOffset, second.items.length);
  assert.deepEqual(second.items, original.items.slice(0, second.items.length));
  assert.equal(JSON.stringify(original), before, 'projection must not mutate the actual request or saved source output');
});

test('identical tool history bodies keep their first full result and a resolvable receipt thereafter', () => {
  const evidenceId = `evidence-${'a'.repeat(64)}`;
  const value = { evidenceId, content: 'Complete neutral log. '.repeat(500), error: { code: 'FORMAT_PENDING', message: 'Keep the actual failure.' } };
  const result = id => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'read_resource', output: { type: 'json', value: structuredClone(value) } }] });
  const original = [result('one'), result('two')], raw = JSON.stringify(original);
  const projected = deduplicateToolMessages(original);
  assert.deepEqual(projected[0], original[0]);
  const repeated = projected[1].content[0].output.value;
  assert.equal(repeated.resultRepeated, true);
  assert.deepEqual(repeated.readResult, { tool: 'read_evidence', input: { evidenceId } });
  assert.deepEqual(repeated.error, value.error);
  assert.equal(JSON.stringify(original), raw, 'mechanical model projection never changes the retained full records');
  assert.ok(JSON.stringify(projected).length < raw.length * 0.6);
});

test('different evidence pages and different tool contents never collapse merely because the evidenceId is shared', () => {
  const message = (offset, content) => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: String(offset), toolName: 'read_evidence',
    output: { type: 'json', value: { evidenceId: `evidence-${'b'.repeat(64)}`, pointer: '/log', offset, content } } }] });
  const original = [message(0, 'first page'), message(10, 'second page'), message(0, 'changed actual body')];
  assert.deepEqual(deduplicateToolMessages(original), original);
});

test('occurrence receipts do not duplicate equal bodies and every original call keeps its own receipt', () => {
  const evidenceId = `evidence-${'a'.repeat(64)}`;
  const result = (id, receiptId, content = 'A complete neutral result. '.repeat(500)) => ({ role: 'tool', content: [{
    type: 'tool-result', toolCallId: id, toolName: 'read_resource', output: { type: 'json', value: { evidenceId, receiptId, content } },
  }] });
  const receipts = ['1', '2', '3'].map(character => `receipt-${character.repeat(64)}`);
  const original = [result('one', receipts[0]), result('two', receipts[1]), result('three', receipts[2], 'Different actual content.')];
  const before = JSON.stringify(original), projected = deduplicateToolMessages(original);
  assert.deepEqual(projected[0], original[0]);
  assert.equal(projected[1].content[0].output.value.resultRepeated, true);
  assert.equal(projected[1].content[0].output.value.sameResultAs, 'one');
  assert.equal(projected[1].content[0].output.value.content, undefined);
  assert.deepEqual(projected[1].content[0].output.value.readResult, { tool: 'read_evidence', input: { evidenceId } });
  assert.deepEqual(projected.map(message => message.content[0].output.value.receiptId), receipts);
  assert.deepEqual(projected[2], original[2], 'changing occurrence metadata cannot hide a genuinely changed body');
  assert.equal(JSON.stringify(original), before, 'full retained occurrence records are not rewritten');
  assert.deepEqual(deduplicateToolMessages(projected), projected);
});

test('equal evidence pages with distinct occurrence receipts retain exact page inputs', () => {
  const evidenceId = `evidence-${'b'.repeat(64)}`, input = { evidenceId, pointer: '/units', offset: 8, limit: 2, length: 1200 };
  const messages = [{ role: 'assistant', content: [0, 1].map(index => ({ type: 'tool-call', toolCallId: `page-${index}`, toolName: 'read_evidence', input })) },
    ...[0, 1].map(index => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: `page-${index}`, toolName: 'read_evidence',
      output: { type: 'json', value: { evidenceId, receiptId: `receipt-${String(index + 1).repeat(64)}`, pointer: input.pointer, offset: 8, total: 12, items: ['saved'], nextOffset: 9 } } }] }))];
  const projected = deduplicateToolMessages(messages), repeated = projected.at(-1).content[0].output.value;
  assert.equal(repeated.resultRepeated, true);
  assert.equal(repeated.receiptId, `receipt-${'2'.repeat(64)}`);
  assert.deepEqual(repeated.readResult.input, input);
  assert.deepEqual(deduplicateToolMessages(projected), projected);
});

test('repeated output references preserve request identity, query differences and navigation', () => {
  const evidenceId = `evidence-${'f'.repeat(64)}`;
  const value = { evidenceId, matchMode: 'literal', route: 'script', items: [], offset: 0, nextOffset: 80, skipped: { binary: 51 } };
  const group = (id, query) => [
    { role: 'assistant', content: [{ type: 'tool-call', toolName: 'search_files', toolCallId: id, input: { query, content: true } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolName: 'search_files', toolCallId: id, output: { type: 'json', value: structuredClone(value) } }] },
  ];
  const original = [...group('first-query', 'court_names'), ...group('second-query', 'letter')];
  const before = JSON.stringify(original), projected = deduplicateToolMessages(original);
  const repeated = projected[3].content[0];
  assert.equal(repeated.toolCallId, 'second-query');
  assert.equal(repeated.output.value.sameResultAs, 'first-query');
  assert.equal(repeated.output.value.sameInput, false);
  assert.match(repeated.output.value.notice, /结果.*相同.*查询|输出.*相同.*参数/);
  assert.equal(repeated.output.value.offset, 0); assert.equal(repeated.output.value.nextOffset, 80);
  assert.equal(repeated.output.value.matchMode, 'literal');
  assert.equal(repeated.output.value.route, 'script');
  assert.deepEqual(repeated.output.value.skipped, { binary: 51 });
  assert.deepEqual(repeated.output.value.readResult, { tool: 'read_evidence', input: { evidenceId } });
  assert.equal(JSON.stringify(original), before);
});

test('observation indices only supplement complete same-tool results still present in recent history', () => {
  const evidenceId = `evidence-${'b'.repeat(64)}`;
  const observations = [{ tool: 'read_resource', evidenceId, total: 1 }, { tool: 'inspect_units', evidenceId, total: 2 }];
  const message = value => [
    { role: 'assistant', content: [{ type: 'tool-call', toolName: 'read_resource', toolCallId: 'read', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolName: 'read_resource', toolCallId: 'read', output: { type: 'json', value } }] },
  ];
  assert.deepEqual(supplementalObservations(observations, message({ evidenceId, content: 'Complete source.' })), [observations[1]]);
  for (const partial of [{ outputTruncated: true }, { checkpointTruncated: true }, { resultRepeated: true }]) {
    assert.deepEqual(supplementalObservations(observations, message({ evidenceId, ...partial })), observations);
  }
  const evidencePage = message({ evidenceId, pointer: '/content', content: 'One evidence page.' });
  evidencePage[1].content[0].toolName = 'read_evidence';
  assert.deepEqual(supplementalObservations(observations, evidencePage), observations);
  const hostParameters = [{ ...observations[0], input: { file: 'Default resource.' } }];
  assert.deepEqual(supplementalObservations(hostParameters, message({ evidenceId, content: 'Complete source.' })), hostParameters, 'host-supplied parameters absent from the model call stay discoverable');
  assert.deepEqual(supplementalObservations(observations, []), observations, 'an observation returns to the index when its full result leaves recent history');
});

test('recipe submission references only an identical previously shown validation and leaves complete evidence intact', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-validation-reference-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const store = createEvidenceStore(root);
  const validation = { validationId: 'proof', passed: true, checks: { roundtrip: 'passed', sample: 'passed' }, runtime: { status: 'pending' },
    sample: { output: 'Complete sample data. '.repeat(500) }, evidence: { difference: 'Exact original evidence.' }, dependencies: [{ file: 'story.json', sha256: 'a'.repeat(64) }] };
  const receipt = await store.save(validation, { tool: 'validate_adapter' });
  const submission = { accepted: true, taskComplete: false, validation: structuredClone(validation), evidenceId: `evidence-${'c'.repeat(64)}` };
  const toolMessage = (toolName, value) => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: toolName, toolName, output: { type: 'json', value } }] });
  const assistant = { role: 'assistant', providerOptions: { neutral: { reasoning: 'Retain provider reasoning metadata.' } }, content: [{ type: 'text', text: 'Inspect before submitting.' }] };
  const history = [assistant, toolMessage('validate_adapter', { ...receipt, ...validation }), toolMessage('submit_recipe', submission)];
  const original = JSON.stringify(history), projected = deduplicateToolMessages(history), result = projected[2].content[0].output.value;
  assert.deepEqual(projected[0], assistant);
  assert.equal(result.taskComplete, false);
  assert.equal(result.validation.evidenceId, receipt.evidenceId);
  assert.equal(result.validation.sample, undefined);
  assert.deepEqual(result.validation.checks, validation.checks);
  assert.deepEqual(result.validation.runtime, validation.runtime);
  assert.deepEqual(result.validation.readResult, { tool: 'read_evidence', input: { evidenceId: receipt.evidenceId } });
  assert.equal((await store.load(receipt.evidenceId)).value.sample.output, validation.sample.output);
  assert.equal((await store.read({ evidenceId: receipt.evidenceId, pointer: '/sample/output' })).totalCharacters, validation.sample.output.length);
  assert.equal(JSON.stringify(history), original);
  assert.deepEqual(deduplicateToolMessages([history[2]])[0], history[2], 'without the earlier validation, submission stays self-contained');
  const changed = structuredClone(history);
  changed[2].content[0].output.value.validation.sample.output = 'Different actual sample.';
  assert.deepEqual(deduplicateToolMessages(changed)[2], changed[2], 'same proof ID does not hide changed evidence');
  assert.ok(JSON.stringify(projected).length < original.length * 0.6);
});

test('equal lossy input indices never hide distinct input evidence links sharing the same output receipt', () => {
  const evidenceId = `evidence-${'d'.repeat(64)}`;
  const indexInput = input => Object.fromEntries(Object.entries(input).map(([key, value]) => [key,
    Array.isArray(value) ? { items: value.length } : value && typeof value === 'object' ? { fields: Object.keys(value) }
      : typeof value === 'string' && value.length > 160 ? { preview: value.slice(0, 160), characters: value.length, truncated: true } : value]));
  const message = input => [
    { role: 'assistant', content: [{ type: 'tool-call', toolName: 'run_tool', toolCallId: 'read', input }] },
    { role: 'tool', content: [{ type: 'tool-result', toolName: 'run_tool', toolCallId: 'read', output: { type: 'json', value: { evidenceId, status: 'completed' } } }] },
  ];
  for (const [first, other] of [
    [{ args: ['first'] }, { args: ['other'] }],
    [{ options: { file: 'first.json' } }, { options: { file: 'other.json' } }],
    [{ text: `${'a'.repeat(160)}first` }, { text: `${'a'.repeat(160)}other` }],
  ]) {
    assert.deepEqual(indexInput(first), indexInput(other), 'the original compact indices collide');
    const observations = [{ tool: 'run_tool', input: indexInput(other), evidenceId, inputEvidenceId: `evidence-${'e'.repeat(64)}` }];
    assert.deepEqual(supplementalObservations(observations, message(first), indexInput), observations);
    assert.deepEqual(supplementalObservations(observations, message(other), indexInput), observations, 'even matching complex input stays available through its exact local input receipt');
  }
  const simple = { file: 'story.json', offset: 0, root: 'source' };
  const observation = { tool: 'run_tool', input: simple, evidenceId };
  assert.deepEqual(supplementalObservations([observation], message(simple), indexInput), []);
});

test('oversized checkpoint fallback retains the actual SDK JSON envelope and metadata', () => {
  const value = { evidenceId: `evidence-${'a'.repeat(64)}`, ...Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`${index}-${'long-key'.repeat(20)}`, ['value']])), receiptId: `receipt-${'1'.repeat(64)}` };
  for (const type of ['json', 'error-json']) {
    const output = boundedToolOutput({ type, value, providerOptions: { neutral: { preserved: true } } });
    assert.equal(output.type, type);
    assert.equal(output.value.evidenceId, value.evidenceId);
    assert.equal(output.value.receiptId, value.receiptId, 'occurrence navigation survives both regular and final fallback compaction');
    assert.equal(output.value.outputTruncated, true);
    assert.equal(output.providerOptions.neutral.preserved, true);
    assert.ok(JSON.stringify(output).length <= 24000);
    assert.equal(toolModelMessageSchema.safeParse({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call', toolName: 'validate_adapter', output }] }).success, true);
  }
});

test('SDK text, error, denial and content payloads retain legal typed envelopes', () => {
  for (const type of ['text', 'error-text']) {
    const output = boundedToolOutput({ type, value: '文字\\\"'.repeat(10000), providerOptions: { neutral: { keep: true } } });
    assert.equal(output.type, type);
    assert.equal(typeof output.value, 'string');
    assert.ok(output.value.length > 3000, 'serialization should fit the actual string, not divide its payload by a guessed escape ratio');
    assert.ok(JSON.stringify(output).length <= 24000);
    assert.equal(toolModelMessageSchema.safeParse({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call', toolName: 'read_resource', output }] }).success, true);
  }
  for (const output of [{ type: 'execution-denied', reason: 'User paused.' }, { type: 'content', value: [{ type: 'text', text: 'Actual typed content.' }] }]) {
    assert.deepEqual(boundedToolOutput(output), output);
  }
});

test('checkpoint recovery reprojects only authoritative local evidence and preserves tool pairs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-checkpoint-envelope-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const evidence = createEvidenceStore(root);
  const receipt = await evidence.save({ passed: true, candidateId: 'retained-candidate', validationId: 'retained-proof' }, { tool: 'validate_adapter' });
  const original = [[
    { role: 'assistant', providerOptions: { neutral: { retained: true } }, content: [{ type: 'text', text: 'Keep this actual model statement.' }, { type: 'tool-call', toolCallId: 'saved-call', toolName: 'validate_adapter', input: { candidateId: 'retained-candidate' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'saved-call', toolName: 'validate_adapter', output: { ...receipt, receiptId: `receipt-${'2'.repeat(64)}`, outputTruncated: true } }] },
  ]];
  const before = JSON.stringify(original);
  assert.equal(modelMessageSchema.safeParse(original[0][1]).success, false);
  const restored = await restoreToolCheckpoint(original, evidence);
  assert.ok(restored.flat().every(message => modelMessageSchema.safeParse(message).success));
  assert.deepEqual(restored[0][0], original[0][0]);
  assert.equal(restored[0][1].content[0].toolCallId, 'saved-call');
  assert.equal(restored[0][1].content[0].output.value.validationId, 'retained-proof');
  assert.equal(restored[0][1].content[0].output.value.receiptId, `receipt-${'2'.repeat(64)}`);
  assert.equal(JSON.stringify(original), before, 'checkpoint recovery never rewrites the retained source record');
  await assert.rejects(restoreToolCheckpoint(original, { load: async () => { throw new Error('Missing evidence'); } }), error => error.code === 'TECHNICAL_CHECKPOINT_EVIDENCE');
  await assert.rejects(restoreToolCheckpoint(original, { load: async () => ({ metadata: { tool: 'wrong_tool' }, value: { passed: true } }) }), error => error.code === 'TECHNICAL_CHECKPOINT_EVIDENCE');
});

test('evidence directories provide exact executable field reads and local continuations', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-evidence-navigation-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const store = createEvidenceStore(root);
  const source = { 'a/b~c': { rows: Array.from({ length: 5 }, (_, id) => ({ id })), text: 'A complete display sentence.' } };
  const { evidenceId } = await store.save(source);
  const directory = await store.read({ evidenceId });
  assert.equal(directory.directory, true);
  const enter = directory.fields[0].read;
  assert.equal(enter.tool, 'read_evidence');
  assert.equal(enter.input.pointer, '/a~1b~0c');
  const child = await store.read(enter.input);
  const rows = child.fields.find(field => field.key === 'rows').read;
  const first = await store.read({ ...rows.input, limit: 2 });
  assert.deepEqual(first.items, source['a/b~c'].rows.slice(0, 2));
  assert.equal(first.nextCall.input.pointer, '/a~1b~0c/rows');
  assert.equal(first.nextCall.input.offset, 2);
  const second = await store.read(first.nextCall.input);
  assert.deepEqual(second.items, source['a/b~c'].rows.slice(2, 4));
  const text = child.fields.find(field => field.key === 'text').read;
  const fragment = await store.read({ ...text.input, length: 10 });
  assert.equal((await store.read(fragment.nextCall.input)).content, source['a/b~c'].text.slice(10, 20));
  const page = await store.read({ evidenceId, pointer: '/a~1b~0c', limit: 1 });
  assert.equal((await store.read(page.nextCall.input)).fields[0].key, 'text');
});

test('bounded evidence directories keep complete field reads and continue at the delivered local offset', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-evidence-bounds-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const store = createEvidenceStore(root);
  const { evidenceId } = await store.save(Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`${index}-${'field'.repeat(20)}`, []])));
  const original = await store.read({ evidenceId, offset: 3, limit: 12 });
  const page = boundedToolOutput(original, { maxCharacters: 8000 });
  assert.equal(page.directory, true);
  assert.ok(page.fields.length > 0 && page.fields.length < 12);
  assert.deepEqual(page.fields, original.fields.slice(0, page.fields.length));
  assert.equal(page.nextCall.input.offset, 3 + page.fields.length);
  assert.equal(page.nextCall.input.pointer, '');
  assert.equal((await store.read(page.nextCall.input)).fields[0].key, Object.keys((await store.load(evidenceId)).value)[page.nextOffset]);
  assert.deepEqual(boundedToolOutput(page, { maxCharacters: 8000 }), page);
});

test('repeated evidence result references never lose their field pointer or original read parameters', () => {
  const evidenceId = `evidence-${'f'.repeat(64)}`, input = { evidenceId, pointer: '/units', offset: 12, limit: 4, length: 1800 };
  const calls = Array.from({ length: 3 }, (_, index) => ({ type: 'tool-call', toolCallId: `field-${index}`, toolName: 'read_evidence', input }));
  const messages = [{ role: 'assistant', content: calls }, ...calls.map(call => ({ role: 'tool', content: [{ type: 'tool-result',
    toolCallId: call.toolCallId, toolName: call.toolName, output: { type: 'json', value: { evidenceId, pointer: input.pointer, offset: 12, total: 20, items: ['saved'], nextOffset: 13 } } }] }))];
  const first = deduplicateToolMessages(messages), again = deduplicateToolMessages(first);
  assert.equal(again.at(-1).content[0].output.value.readResult.input.pointer, input.pointer);
  for (const message of again.slice(2)) assert.deepEqual(message.content[0].output.value.readResult.input, input);
  assert.deepEqual(again, first, 'already resolved references are not repeatedly wrapped or redirected to the root');
});

test('a bounded final evidence page can still resume its exact array or UTF16 string field', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-evidence-final-page-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const store = createEvidenceStore(root), text = '\\"'.repeat(2000);
  const { evidenceId } = await store.save({ rows: candidateRows(6), text });
  for (const pointer of ['/rows', '/text']) {
    const input = { evidenceId, pointer, offset: pointer === '/text' ? 7 : 0, limit: 8, length: 2000 };
    const original = await store.read(input), page = boundedToolOutput(original, { maxCharacters: 3000 });
    assert.equal(original.nextOffset === null, pointer === '/rows');
    assert.equal(page.nextCall.tool, 'read_evidence');
    assert.deepEqual(page.nextCall.input, { ...input, offset: page.nextOffset });
    if (pointer === '/rows') assert.deepEqual((await store.read(page.nextCall.input)).items, candidateRows(6).slice(page.items.length));
    else {
      assert.equal(page.nextOffset, input.offset + page.content.length);
      assert.ok(page.content.length < original.content.length);
      assert.equal((await store.read(page.nextCall.input)).content, text.slice(page.nextOffset, page.nextOffset + input.length));
    }
  }
});
