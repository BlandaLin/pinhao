import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDisplayFactStore, normalizeDisplaySubject, normalizeConsumerHints } from './display-facts.mjs';
import { createDisplayVerifier } from './display-review.mjs';
import { createSessionControl } from './session-control.mjs';
import { createEvidenceStore } from './evidence.mjs';
import { createAdapterLab } from './adapter-lab.mjs';

async function fixture(t, count = 2) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-display-facts-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  const gameDir = path.join(root, 'game'), workspaceDir = path.join(root, 'job-a'), projectDir = path.join(root, 'project');
  await mkdir(gameDir); await mkdir(workspaceDir); await mkdir(projectDir);
  await writeFile(path.join(gameDir, 'lines.json'), JSON.stringify({ lines: Array.from({ length: count }, (_, index) => `Caption ${index}`) }));
  await writeFile(path.join(gameDir, 'main.js'), 'const active = true; display(data.lines[index]);');
  await writeFile(path.join(gameDir, 'extra.js'), 'const optional = false;');
  return { root, projectDir, input: { projectId: 'project', gameDir, workspaceDir,
    candidate: { candidateId: 'writer-a', codeHash: 'code-a', manifest: { engine: 'neutral' } },
    units: Array.from({ length: count }, (_, index) => ({ id: `unit-${index}`, source: `Caption ${index}`, locator: { file: 'lines.json', pointer: `/lines/${index}` } })) } };
}
const connection = { baseUrl: 'http://local.invalid/v1', model: 'independent-model' };
async function decide({ tools, prompt }, { extra = false, status = 'display-supported' } = {}) {
  const source = await tools.read_resource.execute({ file: 'lines.json' });
  const consumer = await tools.read_resource.execute({ file: 'main.js' });
  if (extra) await tools.read_resource.execute({ file: 'extra.js' });
  await tools.finish_review.execute({ decisions: JSON.parse(prompt).units.map(row => ({ ref: row.ref, status,
    reason: 'Actual enabled display consumer examined.', evidenceIds: [source.receiptId], consumerEvidenceIds: [consumer.receiptId] })) });
}

test('stable subjects exclude candidate, ordering and work directories while binding origin, locator, raw source and decoded view', () => {
  const base = { projectId: 'p', originId: 'original', relativeFile: 'data.json', baselineHash: 'baseline', locator: { pointer: '/caption' }, rawSource: 'Same text' };
  const first = normalizeDisplaySubject(base);
  assert.equal(normalizeDisplaySubject({ ...base, locator: { pointer: '/caption', file: 'ignored' } }).subjectKey, first.subjectKey);
  for (const change of [{ originId: 'another' }, { locator: { pointer: '/identity' } }, { rawSource: 'Changed' }, { sourceViewKey: 'decoder-v2' }, { containerRef: { member: 'different' } }]) {
    assert.notEqual(normalizeDisplaySubject({ ...base, ...change }).subjectKey, first.subjectKey);
  }
});

test('consumer hints are navigation only; forged evidence and author claims never qualify independent proof', async () => {
  const hints = await normalizeConsumerHints([{ receiptRef: 'forged', resourceRef: { file: 'main.js' }, note: 'already proved' }], { resolveReceipt: async () => null });
  assert.equal(hints[0].qualification, 'unverified-navigation');
  const verified = await normalizeConsumerHints([{ receiptRef: 'real', resourceRef: { file: 'ignored.js' } }],
    { resolveReceipt: async () => ({ verified: true, resourceRef: { path: 'main.js' } }) });
  assert.equal(verified[0].resourceRef.path, 'main.js'); assert.equal(verified[0].qualification, 'host-verified-navigation');
  await assert.rejects(normalizeConsumerHints([{ resourceRef: { path: '../private' } }]), /relative/);
});

test('a real producer read receipt preserves its byte slice for the next independent reader without supplying its proof', async t => {
  const f = await fixture(t, 1);
  await writeFile(path.join(f.input.gameDir, 'main.js'), ' '.repeat(5998)
    + 'const render = data => display(data.lines[0]);\n'.padEnd(8000, ' ') + '\n'.repeat(6000));
  let originalRead;
  const interrupted = createDisplayVerifier({ connectionFor: () => connection,
    projectFor: () => ({ workspaceDir: f.projectDir }), generate: async ({ tools }) => {
      originalRead = await tools.read_resource.execute({ file: 'main.js', offset: 5998, length: 8000 });
      throw new Error('Stop after the real completed source read.');
    } });
  await assert.rejects(interrupted(f.input), /real completed source read/);
  const evidence = createEvidenceStore(path.join(f.input.workspaceDir, 'display-review'));
  const resolveReceipt = async reference => {
    const receipt = await evidence.resolveReceipt(typeof reference === 'string' ? reference : reference.receiptId);
    assert.equal(receipt.phase, 'completed'); assert.equal(receipt.tool, 'read_resource');
    const value = (await evidence.load(receipt.outputEvidenceId)).value;
    return { verified: true, resourceRef: receipt.resourceRefs[0],
      byteRange: [value.offset, value.offset + value.returnedBytes] };
  };
  const hint = { receiptRef: originalRead.receiptId };
  const normalized = await normalizeConsumerHints([hint], { resolveReceipt });
  assert.deepEqual(normalized[0].slice, { byteStart: 5998, byteEnd: 13998 });
  assert.equal(normalized[0].qualification, 'host-verified-navigation');
  const explicit = await normalizeConsumerHints([{ ...hint, slice: { byteStart: 6000, byteEnd: 6010 } }], { resolveReceipt });
  assert.deepEqual(explicit[0].slice, { byteStart: 6000, byteEnd: 6010 }, 'an explicit narrower slice wins');
  for (const slice of [{ byteStart: 5997, byteEnd: 13998 }, { byteStart: 5998, byteEnd: 13999 },
    { byteStart: -1, byteEnd: 6010 }, { byteStart: 6001, byteEnd: 6000 }, { byteStart: 6000.5, byteEnd: 6010 }]) {
    await assert.rejects(normalizeConsumerHints([{ ...hint, slice }], { resolveReceipt }), /byte range/);
  }
  let reviews = 0;
  const verify = createDisplayVerifier({ connectionFor: () => connection,
    projectFor: () => ({ workspaceDir: f.projectDir }), generate: async ({ tools, prompt }) => {
      reviews++;
      const message = JSON.parse(prompt), next = message.producerHints[0].nextCall;
      assert.deepEqual(next, { tool: 'read_resource', input: { file: 'main.js', sourceIndex: 0, offset: 5998, length: 8000 } });
      const source = await tools.read_resource.execute({ file: 'lines.json' });
      const decisions = consumer => message.units.map(row => ({ ref: row.ref, status: 'display-supported',
        reason: 'Read the actual display consumer in this independent review.', evidenceIds: [source.receiptId], consumerEvidenceIds: [consumer] }));
      await assert.rejects(tools.finish_review.execute({ decisions: decisions(originalRead.receiptId) }),
        { code: 'DISPLAY_REVIEW_EVIDENCE_REQUIRED' });
      const actual = await tools.read_resource.execute(next.input);
      await tools.finish_review.execute({ decisions: decisions(actual.receiptId) });
    } });
  const review = await verify({ ...f.input, workspaceDir: path.join(f.root, 'job-next'), producerHints: [{ hints: normalized }] });
  assert.equal(review.status, 'passed'); assert.equal(reviews, 1);
});

test('missing, unverified and malformed receipt ranges do not synthesize an inherited slice', async () => {
  const hint = { receiptRef: 'a-navigation-reference', resourceRef: { path: 'main.js' } };
  for (const receipt of [undefined, { verified: false, resourceRef: { path: 'main.js' }, byteRange: [5998, 13998] }]) {
    const [value] = await normalizeConsumerHints([hint], { resolveReceipt: async () => receipt });
    assert.equal(value.slice, undefined); assert.equal(value.qualification, 'unverified-navigation');
  }
  for (const byteRange of [undefined, [5998], [5998, 13998, 14000], [-1, 13998], [13998, 5998], [5998.5, 13998], [0, Number.MAX_SAFE_INTEGER + 1]]) {
    const [value] = await normalizeConsumerHints([hint], { resolveReceipt: async () => ({ verified: true, resourceRef: { path: 'main.js' }, byteRange }) });
    assert.equal(value.slice, undefined);
  }
});

test('project display facts reuse renamed writers, true subsets, reordered units and another job directory without rebuying', async t => {
  const f = await fixture(t); let calls = 0;
  const verify = createDisplayVerifier({ connectionFor: () => connection, projectFor: () => ({ workspaceDir: f.projectDir }), generate: async value => { calls++; await decide(value); } });
  const original = await verify(f.input);
  assert.equal(original.status, 'passed'); assert.equal(original.displayFactRefs.length, 2); assert.equal(calls, 1);
  assert.equal((await readdir(path.join(f.projectDir, 'display-facts', 'reviews'))).length, 1, 'the complete review is shared, not duplicated for every subject');
  const store = createDisplayFactStore({ directory: path.join(f.projectDir, 'display-facts'), projectId: 'project' });
  const proofs = await Promise.all(original.displayFactRefs.map(id => store.loadProof(id))); let checks = 0;
  const lookup = await store.lookupMany({ subjectKeys: proofs.map(proof => proof.subjectKey), contextFingerprint: proofs[0].contextFingerprint,
    fresh: async () => { checks++; return true; } });
  assert.equal(lookup.size, 2); assert.equal(checks, 1, 'one complete dependency closure is checked once per lookup, never cached across checks');
  const moved = { ...f.input, workspaceDir: path.join(f.root, 'job-b'), candidate: { ...f.input.candidate, candidateId: 'renamed', codeHash: 'new-writer' },
    units: [f.input.units[1], f.input.units[0]].map((unit, index) => ({ ...unit, id: `new-${index}` })) };
  const second = await verify(moved); assert.equal(second.status, 'passed'); assert.equal(calls, 1);
  assert.deepEqual(second.decisions.map(row => row.id), ['new-0', 'new-1']); assert.equal(second.requests.length, 0);
  const subset = await verify({ ...moved, units: [moved.units[1]] });
  assert.equal(subset.status, 'passed'); assert.equal(calls, 1); assert.equal(await verify.isFresh(subset, moved), true);
});

test('full observed dependency closure, unreferenced read files, listing additions and model changes invalidate reused facts', async t => {
  const f = await fixture(t, 1); let calls = 0, model = connection.model;
  const verify = createDisplayVerifier({ connectionFor: () => ({ ...connection, model }), projectFor: () => ({ workspaceDir: f.projectDir }), generate: async value => {
    calls++; await value.tools.list_files.execute({}); await decide(value, { extra: true });
  } });
  let previous = await verify(f.input); assert.equal(calls, 1);
  await writeFile(path.join(f.input.gameDir, 'extra.js'), 'const optional = true;');
  assert.equal(await verify.isFresh(previous, f.input), false);
  previous = await verify(f.input); assert.equal(calls, 2);
  await writeFile(path.join(f.input.gameDir, 'new-loader.js'), 'enable(other);');
  assert.equal(await verify.isFresh(previous, f.input), false);
  previous = await verify(f.input); assert.equal(calls, 3);
  model = 'other-reviewer'; assert.equal(await verify.isFresh(previous, f.input), false);
  await verify(f.input); assert.equal(calls, 4);
});

test('hints reach the independent reviewer without becoming source/consumer reads', async t => {
  const f = await fixture(t, 1);
  f.input.units[0].context = { consumerHints: [{ resourceRef: { path: 'main.js' }, relation: 'renders', note: 'caption sink' }] };
  const verify = createDisplayVerifier({ connectionFor: () => connection, projectFor: () => ({ workspaceDir: f.projectDir }), generate: async value => {
    const row = JSON.parse(value.prompt).units[0]; assert.equal(row.producerHints[0].resourceRef.path, 'main.js');
    await assert.rejects(value.tools.finish_review.execute({ decisions: [{ ref: row.ref, status: 'display-supported', reason: 'Author hint claims it.', evidenceIds: [], consumerEvidenceIds: [] }] }),
      error => error.code === 'DISPLAY_REVIEW_EVIDENCE_REQUIRED');
    await decide(value);
  } });
  assert.equal((await verify(f.input)).status, 'passed');
});

test('durable challenges survive a new store, invalidate submitted candidates and force independent re-review', async t => {
  const f = await fixture(t, 1); let calls = 0;
  const directory = path.join(f.projectDir, 'display-facts'), store = createDisplayFactStore({ directory, projectId: 'project' });
  const verify = createDisplayVerifier({ connectionFor: () => connection, factStoreFor: () => store, generate: async value => { calls++; await decide(value); } });
  const first = await verify(f.input), proofId = first.displayFactRefs[0];
  await assert.rejects(store.challengeFact({ proofId, evidenceRefs: [{ receiptId: 'pretend' }], reasonCode: 'claim', verifyEvidence: async () => false }), /verified related evidence/);
  const challenge = { proofId, evidenceRefs: [{ receiptId: 'new-related-loader' }], reasonCode: 'new-loader', verifyEvidence: async () => true };
  const event = await store.challengeFact(challenge); assert.equal((await store.challengeFact(challenge)).id, event.id);
  const reopened = createDisplayFactStore({ directory, projectId: 'project' });
  assert.equal(await reopened.verifyFactFresh(proofId, async () => true), false);
  assert.equal(await verify.isFresh(first, f.input), false);
  const next = await verify(f.input); assert.equal(next.status, 'passed'); assert.equal(calls, 2);
  assert.notEqual(next.displayFactRefs[0], proofId);
});

test('conflicting eligible proofs are not resolved by timestamp, order or optimistic verdict', async t => {
  const f = await fixture(t, 1), store = createDisplayFactStore({ directory: path.join(f.projectDir, 'proofs'), projectId: 'project' });
  const subject = normalizeDisplaySubject({ projectId: 'project', originId: 'original', relativeFile: 'lines.json', baselineHash: 'baseline', locator: { pointer: '/lines/0' }, rawSource: 'Caption 0' });
  const dependencies = [{ kind: 'read', file: 'main.js', hash: 'hash' }];
  const base = { ...subject, contextFingerprint: 'context', reason: 'Verified independent evidence', dependencies, sourceReceiptIds: ['source'], consumerReceiptIds: ['consumer'], reviewRecord: { protocol: 'test', dependencies } };
  const supported = await store.persistFact({ ...base, verdict: 'display-supported' });
  await store.persistFact({ ...base, verdict: 'non-display' });
  assert.equal((await store.lookupFacts({ subjectKey: subject.subjectKey, contextFingerprint: 'context', fresh: async () => true })).status, 'needsReconsideration');
  assert.equal(await store.verifyFactFresh(supported.id, async () => true), false);
});

test('normal finding entry challenges only a genuinely new verified consumer and repeated prose does not create another challenge', async t => {
  const f = await fixture(t, 1); let calls = 0;
  const verify = createDisplayVerifier({ connectionFor: () => connection, projectFor: () => ({ workspaceDir: f.projectDir }), generate: async value => { calls++; await decide(value); } });
  const previous = await verify(f.input); assert.equal(await verify.isFresh(previous, f.input), true);
  const evidence = createEvidenceStore(f.input.workspaceDir), state = { id: 'discovery', executionWindow: 1, events: [] };
  const control = createSessionControl({ state, project: { id: f.input.projectId, workspaceDir: f.projectDir },
    assignment: { id: 'source-owner', files: ['lines.json'] }, gameDir: f.input.gameDir, readDir: f.input.gameDir,
    workspaceDir: f.input.workspaceDir, evidence, persist: async () => {} });
  const read = async file => {
    const input = { file }, operation = await control.begin('read_resource', input), content = await readFile(path.join(f.input.gameDir, file), 'utf8');
    const output = { content, offset: 0, returnedBytes: Buffer.byteLength(content) };
    return control.finish(operation, input, output, (await evidence.save(output)).evidenceId);
  };
  const source = await read('lines.json'), oldConsumer = await read('main.js');
  const finding = { file: 'lines.json', locator: { pointer: '/lines/0' }, selection: { file: 'lines.json', pointer: '/lines/0', text: 'Caption 0', reason: 'Observed consumer' },
    sourceEvidenceRefs: [source.receiptId], consumerEvidenceRefs: [oldConsumer.receiptId] };
  await control.recordFinding(finding);
  assert.equal(await verify.isFresh(previous, f.input), true, 'the already observed consumer is not a new counterexample');
  await writeFile(path.join(f.input.gameDir, 'new-consumer.js'), 'displayAlternative(data.lines[0]);');
  const newConsumer = await read('new-consumer.js');
  await control.recordFinding({ ...finding, consumerEvidenceRefs: [newConsumer.receiptId] });
  assert.equal(await verify.isFresh(previous, f.input), false);
  const eventDir = path.join(f.projectDir, 'display-facts', 'events'), count = (await readdir(eventDir)).length;
  await control.recordFinding({ ...finding, claim: 'different explanation only', consumerEvidenceRefs: [newConsumer.receiptId] });
  assert.equal((await readdir(eventDir)).length, count); assert.equal(calls, 1, 'recording evidence does not itself buy a model request');
});

test('long producer navigation remains bounded and full hints are available by evidence reference', async t => {
  const f = await fixture(t, 1);
  f.input.units[0].context = { consumerHints: Array.from({ length: 32 }, (_, index) => ({ resourceRef: { path: `plugin-${index}.js` }, note: `Hint ${index} ${'detail '.repeat(130)}` })) };
  const verify = createDisplayVerifier({ connectionFor: () => connection, generate: async value => {
    const row = JSON.parse(value.prompt).units[0]; assert.ok(value.prompt.length < 10000); assert.ok(row.producerHintsRead);
    const page = await value.tools.read_evidence.execute(row.producerHintsRead.input); assert.equal(page.total, 32);
    await decide(value);
  } });
  assert.equal((await verify(f.input)).status, 'passed');
});

test('cached display facts do not exempt a changed writer from actual roundtrip, structure and target readback', async t => {
  const f = await fixture(t, 1); let reviews = 0;
  const displayVerifier = createDisplayVerifier({ connectionFor: () => connection,
    projectFor: () => ({ id: f.input.projectId, workspaceDir: f.projectDir }), generate: async value => { reviews++; await decide(value); } });
  const lab = await createAdapterLab({ dataDir: path.join(f.root, 'lab'), displayVerifier });
  const manifest = { schemaVersion: 1, id: 'display-fact-writer', version: '1.0.0', engine: 'neutral', license: 'GPL-3.0-or-later', scope: { files: ['lines.json'] } };
  const prefix = `({detect(){return true},extract(host){return {units:[{id:'unit-0',source:JSON.parse(host.readText('lines.json')).lines[0],kind:'message',locator:{file:'lines.json',pointer:'/lines/0'}}]}},validate(){return {valid:true}},roundtrip(host){host.writeBytes('lines.json',host.readBytes('lines.json'));return {}},`;
  const correctBuild = `build(host,input){const data=JSON.parse(host.readText('lines.json'));if(Object.hasOwn(input.translations,'unit-0'))data.lines[0]=input.translations['unit-0'];host.writeText('lines.json',JSON.stringify(data));return {}},assemble(){return {complete:true}}})`;
  const initial = await lab.writeAdapter({ manifest, code: prefix + correctBuild });
  const first = await lab.validateAdapter({ candidateId: initial.candidateId, gameDir: f.input.gameDir, workspaceDir: f.input.workspaceDir });
  assert.equal(first.passed, true, JSON.stringify(first.error)); assert.equal(reviews, 1);
  const variant = await lab.writeAdapter({ manifest: { ...manifest, id: 'renamed-display-writer' }, code: prefix + correctBuild + '\n/* Different writer still must execute. */' });
  const second = await lab.validateAdapter({ candidateId: variant.candidateId, gameDir: f.input.gameDir, workspaceDir: f.input.workspaceDir });
  assert.equal(second.passed, true, JSON.stringify(second.error)); assert.equal(reviews, 1, 'only display facts reuse');
  assert.ok(second.evidence.some(row => row.action === 'build'), 'new writer sample really executed');
  const broken = await lab.writeAdapter({ manifest: { ...manifest, id: 'broken-display-writer' }, code: prefix + `build(host){host.writeBytes('lines.json',host.readBytes('lines.json'));return {}},assemble(){return {complete:true}}})` });
  const rejected = await lab.validateAdapter({ candidateId: broken.candidateId, gameDir: f.input.gameDir, workspaceDir: f.input.workspaceDir });
  assert.equal(rejected.passed, false); assert.equal(reviews, 1, 'cached semantic support cannot rescue a mechanically broken writer');
});

test('publication and a new challenge share one namespace fence across store instances', async t => {
  const f = await fixture(t, 1), directory = path.join(f.projectDir, 'display-facts');
  const verify = createDisplayVerifier({ connectionFor: () => connection, projectFor: () => ({ workspaceDir: f.projectDir }), generate: decide });
  const reviewed = await verify(f.input), proofId = reviewed.displayFactRefs[0];
  const first = createDisplayFactStore({ directory, projectId: 'project' }), other = createDisplayFactStore({ directory, projectId: 'project' });
  let entered, release;
  const checking = new Promise(resolve => { entered = resolve; }), hold = new Promise(resolve => { release = resolve; });
  const order = [];
  const publishing = first.withFence({ proofIds: [proofId], fresh: async () => true,
    check: async () => { entered(); await hold; return true; }, commit: () => { order.push('commit'); return 'published'; } });
  await checking;
  const challenge = other.challengeFact({ proofId, evidenceRefs: [{ receiptId: 'new-consumer' }], reasonCode: 'real-new-consumer', verifyEvidence: async () => true }).then(() => order.push('challenge'));
  await new Promise(resolve => setTimeout(resolve, 5)); assert.deepEqual(order, []);
  release(); assert.equal(await publishing, 'published'); await challenge;
  assert.deepEqual(order, ['commit', 'challenge']);
  await assert.rejects(verify.withPublicationFence(reviewed, f.input, () => { throw new Error('Must not publish revoked proof'); }), error => error.code === 'DISPLAY_FACT_STALE');
});
