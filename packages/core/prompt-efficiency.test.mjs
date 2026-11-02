import test from 'node:test';
import assert from 'node:assert/strict';
import { taskPrompt, rebindTextPrompt } from './provider.mjs';
import { createTextWire, decodeTextResponse } from './text-wire.mjs';
import { resolveEvidenceRequests } from './semantic-tools.mjs';

const target = (id, source = 'Alice returned. {{name}}', context = {}) => ({ id, source, translation: source, kind: 'dialogue', context,
  controls: { '{{name}}': 'The current player-defined name' } });
const payload = (units, extra = {}) => ({ task: 'translation', glossary: [], referenceOnly: [], units, ...extra });
const section = (prompt, title) => JSON.parse(prompt.split(`【${title}】\n`)[1].split('\n')[0]);
const occurrences = (text, value) => text.split(value).length - 1;
const restoredContext = (wire, id) => {
  const ref = wire.state.entries.find(([, value]) => value === id)[0];
  const body = wire.prompt.slice(wire.prompt.lastIndexOf(`\n[${ref}]\n原文：`));
  const line = body.split('\n').find(line => line.startsWith('语境：'))?.slice(3);
  if (!line?.startsWith('共用 ')) return line ? JSON.parse(line) : {};
  const shared = wire.prompt.split('【共用条目语境，只读】\n')[1].split('\n【')[0], fields = {};
  for (const [, key] of line.split('；本条 ')[0].matchAll(/\[(u\d+)\]/g)) {
    const value = shared.split(`[${key}]\n`)[1].split('\n')[0];
    for (const [field, item] of Object.entries(JSON.parse(value))) {
      assert.equal(field in fields, false, 'Shared fragments must not overwrite one another'); fields[field] = item;
    }
  }
  return { ...fields, ...(line.includes('；本条 ') ? JSON.parse(line.split('；本条 ')[1]) : {}) };
};

test('terminology wire keeps votes and scope but not repeated complete occurrence ledgers', () => {
  const ids = Array.from({ length: 1200 }, (_, index) => `private-occurrence-${index}`);
  const candidate = { source: 'Alice', category: 'name', scope: { identity: 'actor:7', semanticScope: 'daytime' }, unitIds: ['target-a'],
    evidenceIds: ids, variants: [{ translation: '爱丽丝', count: 700, evidenceIds: ids.slice(0, 700) },
      { translation: '艾丽丝', count: 500, evidenceIds: ids.slice(700) }] };
  const input = payload([target('target-a')], { terminologyCandidates: [candidate] }), before = JSON.stringify(input);
  const wire = createTextWire(input), value = section(wire.prompt, '已接纳译名候选，只读（非确认规则）');
  const exampleRefs = [ids[0], ids[700]].map(id => wire.state.entries.find(([, value]) => value === id)[0]);
  assert.deepEqual(value.entries[0], { source: 'Alice', category: 'name', scope: candidate.scope, unitIds: ['u1'],
    variants: [{ translation: '爱丽丝', count: 700, query: { ids: [exampleRefs[0]] } },
      { translation: '艾丽丝', count: 500, query: { ids: [exampleRefs[1]] } }], query: { term: 'Alice' } });
  assert.equal(wire.prompt.includes('private-occurrence-'), false);
  assert.equal(wire.prompt.includes('evidenceIds'), false);
  assert.ok(wire.prompt.includes('不因多数票强制统一'));
  assert.deepEqual(wire.state.entries.filter(([, id]) => ids.includes(id)).map(([, id]) => id), [ids[0], ids[700]],
    'Only one exact accepted example per variant occupies a transport tag, not complete ledgers');
  assert.equal(wire.payload.terminologyCandidates[0], candidate, 'Full canonical evidence remains local');
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(decodeTextResponse({ read: [{ ...value.entries[0].query, offset: 32, limit: 32 }] }, wire).evidenceRequests[0].query,
    { term: 'Alice', offset: 32, limit: 32 });
  assert.deepEqual(decodeTextResponse({ read: [value.entries[0].variants[1].query] }, wire).evidenceRequests[0].query,
    { ids: [ids[700]] });
});

test('large identical contexts travel once without deduplicating target text or per-unit controls', () => {
  const summary = 'The travelers discuss the northern gate before choosing their next route. '.repeat(12);
  const context = { sceneId: 'northern-gate', speaker: 'Alice', branch_path: ['gate-open'], summary,
    evidence: { kind: 'scene-note', meaning: 'The gate is open, not locked.' } };
  const units = Array.from({ length: 16 }, (_, index) => ({ ...target(`target-${index}`, `Line ${index} {{name}}`, { ...context }),
    controls: { '{{name}}': `Player name for position ${index}` } }));
  const input = payload(units), before = JSON.stringify(input), wire = createTextWire(input);
  assert.equal(occurrences(wire.prompt, summary), 1);
  assert.equal(occurrences(wire.prompt, '语境：共用 ['), 16);
  assert.ok(wire.prompt.includes(context.evidence.meaning));
  for (const unit of units) {
    assert.equal(occurrences(wire.prompt, unit.source), 1);
    assert.ok(wire.prompt.includes(unit.controls['{{name}}']));
    assert.deepEqual(restoredContext(wire, unit.id), { ...context,
      sceneId: wire.state.entries.find(([, id]) => id === context.sceneId)[0] });
  }
  const [commonRef] = wire.state.entries.find(([, id]) => id.startsWith('context-block-'));
  assert.throws(() => decodeTextResponse({ read: [{ ids: [commonRef] }] }, wire), /材料入口而非文字/);
  assert.equal(JSON.stringify(input), before);
});

test('compact term query reaches every normalized occurrence through decoded paged evidence requests', () => {
  const evidence = Array.from({ length: 70 }, (_, index) => target(`occurrence-${index}`, `${index % 2 ? 'Ａｌｉｃｅ' : 'Alice'} arrived at gate ${index}.`));
  const input = payload([target('current')], { terminologyCandidates: [{ source: 'Alice', category: 'name', unitIds: ['current'],
    evidenceIds: evidence.map(unit => unit.id), variants: [{ translation: '爱丽丝', count: 70, evidenceIds: evidence.map(unit => unit.id) }] }] });
  const wire = createTextWire(input), query = section(wire.prompt, '已接纳译名候选，只读（非确认规则）').entries[0].query;
  const found = [];
  for (let offset = 0; offset < evidence.length; offset += 32) {
    const requests = decodeTextResponse({ read: [{ ...query, offset, limit: 32, reason: 'Check all independent uses' }] }, wire).evidenceRequests;
    const resolved = resolveEvidenceRequests(requests, evidence, { maxCharacters: 100000 });
    found.push(...resolved.units.map(unit => unit.id));
  }
  assert.deepEqual(found, evidence.map(unit => unit.id));
  assert.equal(new Set(found).size, 70, 'No hard evidence cap or duplicated page votes');
});

test('sharing equal wording preserves every distinct branch, speaker, scope and evidence field', () => {
  const summary = 'This identical note is used in independent contexts. '.repeat(10);
  const contexts = [
    { summary, speaker: 'Alice', branch_path: ['left'], semanticScope: 'person-a', evidence: { meaning: 'direct observation' } },
    { summary, speaker: 'Alice', branch_path: ['right'], semanticScope: 'person-a', evidence: { meaning: 'direct observation' } },
    { summary, speaker: 'Bob', branch_path: ['left'], semanticScope: 'person-a', evidence: { meaning: 'direct observation' } },
    { summary, speaker: 'Alice', branch_path: ['left'], semanticScope: 'person-b', evidence: { meaning: 'direct observation' } },
    { summary, speaker: 'Alice', branch_path: ['left'], semanticScope: 'person-a', evidence: { meaning: 'a disputed recollection' } },
  ];
  const wire = createTextWire(payload(contexts.map((context, index) => target(`target-${index}`, `Line ${index}`, context))));
  assert.equal(occurrences(wire.prompt, summary), 1, 'Only equal bytes are reused, not their meanings or owners');
  for (const [index, context] of contexts.entries()) assert.deepEqual(restoredContext(wire, `target-${index}`), context);
  assert.ok(wire.prompt.includes('a disputed recollection'));
  assert.ok(wire.prompt.includes('"branch_path":["left"]'));
  assert.ok(wire.prompt.includes('"branch_path":["right"]'));
});

test('overlapping common field groups reconstruct each context without overriding unique evidence', () => {
  const units = Array.from({ length: 24 }, (_, index) => target(`target-${index}`, `Line ${index}`, {
    summary: 'A common background shared by the scene. '.repeat(10),
    description: `${index % 2 ? 'Night' : 'Day'} background. `.repeat(12),
    constraints: [`${index % 3} independent branch rules. `.repeat(12)],
    speaker: `Speaker ${index % 4}`, evidence: { description: `Unique observation ${index}` },
  }));
  const wire = createTextWire(payload(units));
  for (const unit of units) assert.deepEqual(restoredContext(wire, unit.id), unit.context);
  assert.ok(wire.prompt.includes('、['), 'A row can combine several disjoint common field bundles');
  const summary = 'The condition is not inferred from a missing field. '.repeat(20);
  const optional = createTextWire(payload([target('missing', 'First', { summary, condition: undefined }),
    target('null', 'Second', { summary, condition: null })]));
  assert.deepEqual(restoredContext(optional, 'missing'), { summary });
  assert.deepEqual(restoredContext(optional, 'null'), { summary, condition: null });
});

test('small contexts stay inline and reordered equivalent object keys share one complete context', () => {
  const small = createTextWire(payload([target('a', 'First', { speaker: 'Alice' }), target('b', 'Second', { speaker: 'Alice' })]));
  assert.equal(small.prompt.includes('共用条目语境'), false);
  const summary = 'A complete scene explanation. '.repeat(12);
  const wire = createTextWire(payload([target('a', 'First', { summary, speaker: 'Alice' }),
    target('b', 'Second', { speaker: 'Alice', summary })]));
  assert.equal(occurrences(wire.prompt, summary), 1);
  const ascii = createTextWire(payload([0, 1, 2].map(index => target(`ascii-${index}`, `Line ${index}`, { summary: 'x'.repeat(80) }))));
  assert.equal(ascii.prompt.includes('共用条目语境'), false, 'Fewer characters must not trade for a larger token planning estimate');
});

test('stable instructions precede changing targets without claiming remote conversation memory', () => {
  const request = (source, role = 'translation') => taskPrompt(role, [target('a', source)], 'zh-Hans', [], [],
    { reviewProtocol: role === 'proofreading' });
  const first = request('The first complete line.'), next = request('A different complete line.');
  const prefix = prompt => prompt.slice(0, prompt.indexOf('【待处理文字】'));
  assert.equal(prefix(first.prompt), prefix(next.prompt));
  assert.ok(first.prompt.indexOf('【按需能力】') < first.prompt.indexOf('【待处理文字】'));
  assert.ok(first.prompt.includes('"term":"原词"'));
  assert.ok(first.prompt.includes('"text"') || first.prompt.includes('text 查原文字面'));
  assert.ok(first.prompt.includes('decisions')); assert.ok(first.prompt.includes('terms')); assert.ok(first.prompt.includes('remarks'));
  assert.ok(!prefix(first.prompt).includes('The first complete line.'));
  const initial = taskPrompt('translation', [target('a'), target('b')], 'zh-Hans');
  const resumed = rebindTextPrompt(request('Another complete line.'), JSON.parse(JSON.stringify(initial.wire.state)));
  assert.equal(prefix(first.prompt), prefix(resumed.prompt), 'A restored short-tag map does not alter the capability prefix');
  const review = request('An existing translation.', 'proofreading');
  assert.ok(review.prompt.includes('questions')); assert.ok(review.prompt.includes('逐条审完'));
  assert.ok(review.prompt.includes('[完成]'));
});

test('shared context identities remain stable on resume and never enter reply target coverage', () => {
  const context = { speaker: 'Alice', summary: 'The same complete shared context. '.repeat(12) };
  const input = payload([target('a', 'First {{name}}', context), target('b', 'Second {{name}}', context)]);
  const first = createTextWire(input), [ref, id] = first.state.entries.find(([, value]) => value.startsWith('context-block-'));
  const resumed = createTextWire({ ...input, readingNotes: `${ref} identifies the earlier context.` }, JSON.parse(JSON.stringify(first.state)));
  assert.equal(new Map(resumed.state.entries).get(ref), id);
  assert.ok(resumed.prompt.includes(`${ref} identifies the earlier context.`));
  assert.deepEqual(resumed.targetIds, ['a', 'b']);
  assert.throws(() => decodeTextResponse({ text: [[ref, 'Not a translation target']] }, resumed), { code: 'INVALID_RESPONSE' });
});
