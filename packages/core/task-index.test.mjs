import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskIndex } from './task-index.mjs';

function task(id, patch = {}) {
  return { id, fingerprint: `fingerprint-${id}`, role: 'translation', status: 'paused', targetLanguage: 'zh-Hans',
    input: [{ id: 'unit-a', revision: 2, sourceHash: 'source-a' }, { id: 'unit-b', revision: 3, sourceHash: 'source-b' }], ...patch };
}
function reference(tasks, query) {
  return tasks.find(candidate => candidate.fingerprint === query.fingerprint) ?? tasks.findLast(candidate =>
    candidate.role === query.role && candidate.kind === query.kind && ['paused', 'queued', 'running'].includes(candidate.status)
    && candidate.targetLanguage === query.targetLanguage && candidate.input?.length === query.input.length
    && candidate.input.every((input, index) => input.id === query.input[index].id && input.revision === query.input[index].revision && input.sourceHash === query.input[index].sourceHash));
}
const queryFor = (value, patch = {}) => ({ ...value, fingerprint: 'new-unmatched-fingerprint', ...patch });

test('exact fingerprints precede resumable input matches for every persisted status', () => {
  for (const status of ['queued', 'running', 'paused', 'succeeded', 'stale', 'failed', 'skipped', 'cancelled']) {
    const exact = task(`exact-${status}`, { status }), fallback = task(`fallback-${status}`, { status: 'running' });
    const index = createTaskIndex([exact, fallback]);
    const query = queryFor(fallback, { fingerprint: exact.fingerprint });
    assert.equal(index.find(query), exact, `${status} exact fingerprint should retain priority`);
    assert.equal(index.byFingerprint(exact.fingerprint), exact);
  }
});

test('only paused, queued and running records qualify for input-based resume', () => {
  for (const status of ['queued', 'running', 'paused', 'succeeded', 'stale', 'failed', 'skipped', 'cancelled']) {
    const candidate = task(status, { status }), query = queryFor(candidate);
    const index = createTaskIndex([candidate]);
    assert.equal(index.find(query), reference([candidate], query), status);
  }
});

test('resume requires identical role, kind, language, ordered IDs, revisions and source hashes', () => {
  const candidate = task('existing', { kind: 'glossary-repair' });
  const query = queryFor(candidate), index = createTaskIndex([candidate]);
  assert.equal(index.find(query), candidate);
  const differences = [
    { role: 'proofreading' }, { kind: undefined }, { kind: 'glossary' }, { targetLanguage: 'en' },
    { input: [] }, { input: query.input.slice(0, 1) }, { input: [...query.input].reverse() },
    ...['id', 'revision', 'sourceHash'].map(field => ({ input: query.input.map((unit, position) => position ? unit : { ...unit, [field]: field === 'revision' ? 8 : `changed-${field}` }) })),
  ];
  for (const difference of differences) assert.equal(index.find({ ...query, ...difference }), undefined, JSON.stringify(difference));
  const metadataOnly = queryFor(candidate, { connection: { model: 'another-model' }, notes: 'new task metadata', attempts: 9 });
  assert.equal(index.find(metadataOnly), candidate, 'Resume identity follows source input rather than unrelated task metadata');
});

test('absent kind and input fields retain strict legacy comparison semantics', () => {
  const ordinary = task('ordinary'), empty = task('empty', { input: [] });
  assert.equal(createTaskIndex([ordinary]).find(queryFor(ordinary, { kind: null })), undefined);
  assert.equal(createTaskIndex([task('null-kind', { kind: null })]).find(queryFor(ordinary)), undefined);
  for (const input of [undefined, null]) {
    const candidate = task(`absent-input-${input}`, { input });
    assert.equal(createTaskIndex([candidate]).find(queryFor(empty)), undefined, 'Missing old input evidence cannot resume an empty technical task');
  }
  for (const field of ['revision', 'sourceHash']) {
    const candidate = task(`absent-${field}`, { input: [{ id: 'unit-a', revision: 1, sourceHash: 'hash', [field]: undefined }] });
    const query = queryFor(candidate, { input: [{ ...candidate.input[0], [field]: null }] });
    assert.equal(createTaskIndex([candidate]).find(query), undefined, `${field} undefined differs from null`);
  }
});

test('newest inserted resumable task wins while later terminal tasks are ignored', () => {
  const first = task('first'), latest = task('latest', { status: 'running' });
  const terminal = task('terminal', { status: 'succeeded' });
  const tasks = [first, latest, terminal], index = createTaskIndex(tasks), query = queryFor(first);
  assert.equal(index.find(query), latest);
  assert.equal(index.find(query), reference(tasks, query));
});

test('updating an existing status preserves its original fallback insertion position', () => {
  const first = task('first'), latest = task('latest');
  const index = createTaskIndex([first, latest]), query = queryFor(first);
  const updatedFirst = { ...first, status: 'queued', attempts: 4 };
  index.set(updatedFirst);
  assert.equal(index.find(query), latest, 'A status update must not move an older task to the back');
  assert.equal(index.byFingerprint(first.fingerprint), updatedFirst);
  index.set({ ...latest, status: 'succeeded' });
  assert.equal(index.find(query), updatedFirst, 'An older resumable record remains available after the newest one terminates');
  index.set({ ...updatedFirst, status: 'failed' });
  assert.equal(index.find(query), undefined);
});

test('new same-input entries append once without reordering earlier updated entries', () => {
  const first = task('first'), second = task('second'), added = task('added', { status: 'queued' });
  const index = createTaskIndex([first, second]), query = queryFor(first);
  index.set(added);
  index.set({ ...first, status: 'running' });
  index.set({ ...second, status: 'running' });
  assert.equal(index.find(query), added);
  index.set({ ...added, status: 'paused' });
  assert.equal(index.find(query)?.id, added.id);
  index.set({ ...added, status: 'succeeded' });
  assert.equal(index.find(query)?.id, second.id);
  assert.equal(index.find(queryFor(first, { fingerprint: added.fingerprint }))?.status, 'succeeded', 'Exact success remains addressable after its fallback eligibility ends');
});

test('empty index handles missing fingerprints and independent input groups', () => {
  const index = createTaskIndex([]), first = task('first');
  assert.equal(index.find(queryFor(first)), undefined); assert.equal(index.byFingerprint('missing'), undefined);
  index.set(first);
  assert.equal(index.find(queryFor(first)), first);
  const second = task('second', { input: [{ id: 'other', revision: 1, sourceHash: 'other-hash' }] });
  index.set(second);
  assert.equal(index.find(queryFor(first)), first); assert.equal(index.find(queryFor(second)), second);
});

test('dependency stamps and prompt versions gate exact and fallback recovery', () => {
  const candidate = task('existing', { dependencyHash: 'readset-a', promptVersion: 'v1' }), index = createTaskIndex([candidate]);
  assert.equal(index.find(queryFor(candidate)), candidate);
  for (const difference of [{ dependencyHash: 'readset-b' }, { dependencyHash: undefined }, { promptVersion: 'v2' }]) {
    assert.equal(index.find(queryFor(candidate, difference)), undefined);
    assert.equal(index.find({ ...candidate, ...difference }), undefined);
  }
});

test('lazy terminal fingerprint lookup keeps priority without indexing historical bodies', () => {
  const old = task('old-success', { status: 'succeeded', dependencyHash: 'deps', promptVersion: 'v1' });
  const resumable = task('resumable', { dependencyHash: 'deps', promptVersion: 'v1' });
  const orders = new Map([[old.id, 1], [resumable.id, 2]]);
  let lookups = 0;
  const index = createTaskIndex([resumable], {
    lookupFingerprint: fingerprint => { lookups++; return fingerprint === old.fingerprint ? old : undefined; },
    orderFor: value => orders.get(value.id),
  });
  assert.equal(index.find(old), old);
  assert.equal(index.find({ ...old, dependencyHash: 'changed' }), undefined);
  assert.equal(index.find(queryFor(old)), resumable);
  index.set({ ...old, status: 'queued' });
  assert.equal(index.find(queryFor(old)), resumable, 'Reactivated historical task keeps its original insertion order');
  index.set({ ...resumable, status: 'succeeded' });
  assert.equal(index.find(queryFor(old))?.id, old.id);
  assert.ok(lookups > 0);
});

test('updating a task input reindexes its bucket and removes an obsolete fingerprint alias', () => {
  const original = task('existing', { dependencyHash: 'a' }), index = createTaskIndex([original]);
  const updated = { ...original, fingerprint: 'updated', dependencyHash: 'b' };
  index.set(updated);
  assert.equal(index.find(queryFor(original)), undefined); assert.equal(index.byFingerprint(original.fingerprint), undefined);
  assert.equal(index.find(queryFor(updated)), updated);
});

test('two thousand neutral tasks and incremental updates match the original lookup algorithm', () => {
  const statuses = ['paused', 'queued', 'running', 'succeeded', 'stale', 'failed', 'skipped'];
  const tasks = Array.from({ length: 2000 }, (_, index) => task(`scale-${index}`, {
    role: ['technical', 'translation', 'proofreading'][index % 3],
    kind: [undefined, 'glossary-repair', 'adaptation', 'glossary'][index % 4],
    targetLanguage: index % 5 ? 'zh-Hans' : 'en', status: statuses[index % statuses.length],
    input: index % 4 === 2 ? [] : Array.from({ length: 1 + index % 3 }, (_, unit) => ({ id: `unit-${index % 25}-${unit}`, revision: index % 7, sourceHash: `hash-${index % 11}-${unit}` })),
  }));
  const index = createTaskIndex(tasks);
  const compare = query => assert.equal(index.find(query), reference(tasks, query), `Lookup mismatch: ${query.fingerprint}`);
  for (const [position, row] of tasks.entries()) {
    compare(queryFor(row));
    compare(queryFor(row, { fingerprint: row.fingerprint }));
    if (position % 19 === 0) compare(queryFor(row, { targetLanguage: 'unmatched-language' }));
  }
  for (let position = 0; position < 2000; position += 13) {
    const next = { ...tasks[position], status: statuses[(position + 3) % statuses.length] };
    tasks[position] = next; index.set(next);
    compare(queryFor(next));
    const added = { ...next, id: `new-${position}`, fingerprint: `new-fingerprint-${position}`, status: 'queued' };
    tasks.push(added); index.set(added);
    compare(queryFor(next)); compare(queryFor(next, { fingerprint: next.fingerprint }));
  }
});
