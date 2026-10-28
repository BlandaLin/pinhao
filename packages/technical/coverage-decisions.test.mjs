import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scanCoverage } from './coverage.mjs';
import { createJsonCoverage } from './coverage-json.mjs';
import { runAdaptation } from './adaptation.mjs';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';
import { createService } from '../core/service.mjs';
import { adaptationTools } from './adaptation.mjs';
import { COVERAGE_DECISION_VERSION, hasCoverageDecisionProof, coverageDecisionFresh, coverageReadReceipt, coverageListingReceipt, coverageReceiptKey, coverageDigest, resourceReadProof, expressionReadProof, displayCandidateIdentity } from './coverage-decisions.mjs';
import { inspectReadSources, readSourceSlice } from './adaptation/paths.mjs';
import { createDisplayVerifier } from './adaptation/display-review.mjs';
import { createDisplaySourceResolver } from './adaptation/source-origins.mjs';

test('coverage replays the full host-origin display closure through the normal scanner and rejects changed reads, listings and absence', async t => {
  const f = await fixture(t), projectId = 'typed-display-coverage', file = 'js/hidden.js', source = 'load';
  const code = 'const command = "load";\n';
  await writeFile(path.join(f.gameDir, file), code);
  await writeFile(path.join(f.gameDir, 'js/loader.js'), 'const enabled = false;\n');
  const start = code.indexOf('"load"'), inventory = { dynamicCandidates: [{ file, source, target: { render: 'quoted', start, end: start + 6 } }] };
  const scan = decisions => scanCoverage({ projectId, rootDir: f.gameDir, inventory, units: f.units, decisions, scanCache: false });
  const coverage = await scan(), candidate = coverage.dynamicCandidates.find(row => row.file === file), id = displayCandidateIdentity(candidate);
  let reviews = 0;
  const verifier = createDisplayVerifier({ connectionFor: () => ({ baseUrl: 'https://invalid.local', model: 'fixture' }),
    projectFor: () => ({ id: projectId }), sourceResolverFor: ({ roots }) => createDisplaySourceResolver({ projectId, roots }),
    generate: async ({ tools }) => {
      reviews++;
      const sourceRead = await tools.read_resource.execute({ file });
      const loader = await tools.read_resource.execute({ file: 'js/loader.js' });
      await tools.list_files.execute({ relativePath: 'js', limit: 100 });
      await assert.rejects(tools.read_resource.execute({ file: 'js/optional.js' }), { code: 'ENOENT' });
      await assert.rejects(tools.list_files.execute({ relativePath: 'js/optional-dir' }), { code: 'ENOENT' });
      await tools.finish_review.execute({ decisions: [{ ref: '1', status: 'non-display', reason: 'The actual loading source disables this command label.',
        evidenceIds: [sourceRead.evidenceId], consumerEvidenceIds: [loader.evidenceId] }] });
    } });
  const review = await verifier({ projectId, gameDir: f.gameDir, workspaceDir: path.join(f.root, 'typed-review'),
    candidate: { candidateId: 'typed-origin', codeHash: 'a'.repeat(64), manifest: { scope: { files: [file] } } },
    units: [{ id, source, locator: { file, byteStart: start + 1, byteEnd: start + 5 } }] });
  assert.equal(await verifier.decisionsFresh(review, { projectId, gameDir: f.gameDir }), true);
  assert.deepEqual(new Set(review.dependencies.map(row => row.kind)), new Set(['read', 'list', 'origin-list', 'missing']));
  const decision = { version: COVERAGE_DECISION_VERSION, kind: 'display-candidate', id, file, sourceIndex: candidate.sourceIndex,
    sourceHash: candidate.sourceHash, evidenceHash: candidate.evidenceHash, sourceContextHash: coverage.sourceContextHash,
    disposition: 'non-display', reason: 'Independent full closure retained.', reads: [coverageReadReceipt({ file }, await readSourceSlice(f.gameDir, file))],
    independentReview: { protocol: 'pinhao-display-disposition-1', reviewProtocol: review.protocol, evidenceHash: candidate.evidenceHash,
      id, status: 'non-display', reason: review.decisions[0].reason, dependencies: review.dependencies } };
  const fresh = (value = decision, host = projectId) => coverageDecisionFresh(value, { roots: [f.gameDir], projectId: host, sourceContextHash: coverage.sourceContextHash });
  assert.equal(hasCoverageDecisionProof(decision), true); assert.equal(await fresh(), true);
  assert.equal((await scan([decision])).dynamicCandidates.some(row => row.file === file), false, 'the real scanner passes its host project identity');
  assert.equal(reviews, 1);
  assert.equal(await fresh(decision, 'other-project'), false);
  assert.equal(await coverageDecisionFresh(decision, { roots: [f.gameDir], sourceContextHash: coverage.sourceContextHash }), false);
  for (const [relative, content, directory] of [['js/optional.js', 'new consumer', false], ['js/optional-dir', '', true], ['js/new-loader.js', 'new loader', false]]) {
    if (directory) await mkdir(path.join(f.gameDir, relative)); else await writeFile(path.join(f.gameDir, relative), content);
    assert.equal(await fresh(), false, `${relative} invalidates the original closure`);
    await rm(path.join(f.gameDir, relative), { recursive: directory });
    assert.equal(await fresh(), true);
  }
  await writeFile(path.join(f.gameDir, 'js/loader.js'), 'const enabled = true;\n');
  assert.equal(await fresh(), false);
  await writeFile(path.join(f.gameDir, 'js/loader.js'), 'const enabled = false;\n');
  const altered = structuredClone(decision);
  altered.independentReview.dependencies.find(row => row.originRef).originRef.originId = '0'.repeat(64);
  assert.equal(await fresh(altered), false);
  for (const extra of [{ kind: 'future-unrecognized', hash: 'a'.repeat(64) }, { kind: 'origin-list', hash: 'a'.repeat(64), input: { sourceRoots: [f.root] } }]) {
    const invalid = { ...decision, independentReview: { ...decision.independentReview, dependencies: [...review.dependencies, extra] } };
    assert.equal(hasCoverageDecisionProof(invalid), false);
    assert.equal(await fresh(invalid), false);
  }
});

test('source-qualified missing receipts replay absence in that origin rather than replaying a directory listing', async t => {
  const f = await fixture(t), alternate = path.join(f.root, 'alternate');
  await mkdir(alternate); await mkdir(path.join(f.gameDir, 'optional-origin-directory'));
  await mkdir(path.join(alternate, 'data'));
  await writeFile(path.join(alternate, 'data/Map001.json'), await readFile(path.join(f.gameDir, 'data/Map001.json')));
  const file = 'data/Map001.json', read = coverageReadReceipt({ file }, await readSourceSlice(f.gameDir, file, { sourceRoots: [alternate], sourceIndex: 0 }));
  const decision = { version: COVERAGE_DECISION_VERSION, id: 'qualified-absence', evidenceHash: 'a'.repeat(64), sourceContextHash: 'b'.repeat(64),
    file, disposition: 'non-display', reason: 'Neutral source and exact-origin absence.', reads: [read,
      { kind: 'missing', file: 'optional-origin-directory', directory: true, sourceIndex: 1, sourceCount: 2 }] };
  assert.equal(await coverageDecisionFresh(decision, { roots: [f.gameDir, alternate], sourceContextHash: decision.sourceContextHash }), true);
  assert.equal(await coverageDecisionFresh(decision, { roots: [alternate, f.gameDir], sourceContextHash: decision.sourceContextHash }), false,
    'an unchanged numeric sourceIndex cannot silently refer to a different physical origin');
  assert.equal(await coverageDecisionFresh({ ...decision, reads: [read] }, { roots: [alternate, f.gameDir], sourceContextHash: decision.sourceContextHash }), false,
    'even equal source bytes do not authorize rebinding a receipt to another origin');
  await mkdir(path.join(alternate, 'optional-origin-directory'));
  assert.equal(await coverageDecisionFresh(decision, { roots: [f.gameDir, alternate], sourceContextHash: decision.sourceContextHash }), false);
});

test('independent read dependencies dispatch explicit raw-byte hash without silently reinterpreting legacy hashes', async t => {
  const f = await fixture(t), file = 'data/Map001.json', bytes = await readFile(path.join(f.gameDir, file));
  const read = coverageReadReceipt({ file }, await readSourceSlice(f.gameDir, file));
  const make = hashAlgorithm => ({ version: COVERAGE_DECISION_VERSION, kind: 'display-candidate', id: 'display-exact', file,
    sourceIndex: 0, sourceHash: createHash('sha256').update(bytes).digest('hex'), evidenceHash: 'a'.repeat(64), sourceContextHash: 'b'.repeat(64),
    disposition: 'non-display', reason: 'Neutral exact source review.', reads: [read], independentReview: {
      protocol: 'pinhao-display-disposition-1', reviewProtocol: 'pinhao-display-review-7', evidenceHash: 'a'.repeat(64), id: 'display-exact',
      status: 'non-display', reason: 'Actual source independently read.', dependencies: [{ kind: 'read', file, sourceIndex: 0,
        ...(hashAlgorithm ? { hashAlgorithm } : {}), hash: hashAlgorithm ? createHash('sha256').update(bytes).digest('hex') : coverageDigest(bytes.toString('base64')) }] } });
  for (const algorithm of [undefined, 'sha256-bytes-1']) {
    const decision = make(algorithm);
    assert.equal(await coverageDecisionFresh(decision, { roots: [f.gameDir], sourceContextHash: decision.sourceContextHash }), true);
  }
  const unsupported = make('unrecognized-hash');
  assert.equal(await coverageDecisionFresh(unsupported, { roots: [f.gameDir], sourceContextHash: unsupported.sourceContextHash }), false);
});

test('listing evidence preserves shallow and exact-file scope when saved and replayed', async t => {
  const f = await fixture(t), file = 'data/Map001.json', context = 'b'.repeat(64);
  const read = coverageReadReceipt({ file }, await readSourceSlice(f.gameDir, file));
  const make = listing => ({ version: COVERAGE_DECISION_VERSION, id: `scoped-listing-${listing.recursive}-${listing.allowFile}`, evidenceHash: 'a'.repeat(64),
    sourceContextHash: context, file, disposition: 'non-display', reason: 'Read source with a precisely scoped listing.', reads: [read, listing] });
  const fresh = decision => coverageDecisionFresh(decision, { roots: [f.gameDir], sourceContextHash: context });
  for (const input of [
    { relativePath: 'data', recursive: false, allowFile: false, limit: 100 },
    { relativePath: file, recursive: true, allowFile: true, limit: 100 },
  ]) {
    const receipt = coverageListingReceipt(input, await inspectReadSources(f.gameDir, input));
    const decision = make(receipt);
    assert.equal(await fresh(decision), true);
    assert.notEqual(coverageReceiptKey(receipt), coverageReceiptKey({ ...receipt, recursive: !receipt.recursive }));
    await f.lab.saveCoverageDecisions({ decisions: [decision] });
    const stored = (await f.lab.listCoverageDecisions()).find(item => item.id === decision.id);
    assert.equal(stored.reads[1].recursive, input.recursive);
    assert.equal(stored.reads[1].allowFile, input.allowFile);
    assert.equal(await fresh(stored), true);
    assert.equal(hasCoverageDecisionProof({ ...decision, reads: [read, { ...receipt, recursive: 'false' }] }), false);
  }
  const input = { relativePath: 'data', recursive: false, limit: 100 };
  const decision = make(coverageListingReceipt(input, await inspectReadSources(f.gameDir, input)));
  await writeFile(path.join(f.gameDir, 'data', 'new-consumer.txt'), 'A new consumer appeared.');
  assert.equal(await fresh(decision), false, 'The exact navigation scope remains a real freshness dependency');
});

test('route-filtered listing proof persists its scope and notices new matching consumers', async t => {
  const f = await fixture(t), file = 'data/Map001.json', context = 'b'.repeat(64);
  const read = coverageReadReceipt({ file }, await readSourceSlice(f.gameDir, file));
  const input = { relativePath: 'js', recursive: true, route: 'script', limit: 100 };
  const listing = coverageListingReceipt(input, await inspectReadSources(f.gameDir, input));
  const decision = { version: COVERAGE_DECISION_VERSION, id: 'route-listing', evidenceHash: 'a'.repeat(64),
    sourceContextHash: context, file, disposition: 'non-display', reason: 'Source checked against the readable script listing.', reads: [read, listing] };
  const fresh = value => coverageDecisionFresh(value, { roots: [f.gameDir], sourceContextHash: context });
  assert.equal(listing.route, 'script');
  assert.notEqual(coverageReceiptKey(listing), coverageReceiptKey({ ...listing, route: 'image' }));
  assert.equal(await fresh(decision), true);
  await f.lab.saveCoverageDecisions({ decisions: [decision] });
  const stored = (await f.lab.listCoverageDecisions()).find(item => item.id === decision.id);
  assert.equal(stored.reads[1].route, 'script');
  assert.equal(await fresh(stored), true);
  assert.equal(hasCoverageDecisionProof({ ...stored, reads: [read, { ...listing, route: 'all' }] }), false);
  await writeFile(path.join(f.gameDir, 'js', 'unrelated.png'), Buffer.from([0, 1]));
  assert.equal(await fresh(stored), true, 'the listing receipt replays its actual route, not an unfiltered directory');
  await writeFile(path.join(f.gameDir, 'js', 'new-consumer.js'), 'show_message("A new scene.");');
  assert.equal(await fresh(stored), false);
});

test('classification replays original search requests after non-UTF8 boundary shortening', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(262145, 65);
  bytes[262142] = 0xc2; bytes[262143] = 0xe3;
  await writeFile(path.join(f.gameDir, 'runtime.blob'), bytes);
  const result = await f.classify('search-boundary', { read: tools => tools.search_files.execute({ query: 'no matching caption', content: true }) });
  assert.equal(result.status, 'verified', JSON.stringify(result.error));
  const decision = result.coverageDecisions[0], receipt = decision.reads.find(item => item.file === 'runtime.blob');
  assert.equal(receipt.requestLength, 262144); assert.equal(receipt.length, 262143);
  const actual = await readSourceSlice(f.gameDir, receipt.file, { ...receipt, length: receipt.requestLength });
  assert.equal(coverageDigest(actual), receipt.hash, 'the complete original read result remains the hash input');
  assert.equal(await coverageDecisionFresh(decision, { roots: [f.gameDir], sourceContextHash: decision.sourceContextHash }), true);
  const [saved] = await (await createAdapterLab({ dataDir: f.labDir })).listCoverageDecisions();
  assert.deepEqual(saved.reads, decision.reads, 'shared recipes preserve both requested and actual lengths');
  assert.equal(await coverageDecisionFresh(saved, { roots: [f.gameDir], sourceContextHash: decision.sourceContextHash }), true);
  bytes[100] = 66; await writeFile(path.join(f.gameDir, receipt.file), bytes);
  assert.equal(await coverageDecisionFresh(decision, { roots: [f.gameDir], sourceContextHash: decision.sourceContextHash }), false,
    'a changed incidental binary dependency still invalidates the whole decision');
});

test('read receipts separate actual coverage from requested length and reject old or forged proof', async t => {
  const f = await fixture(t), input = { file: 'data/Map001.json' };
  const output = await readSourceSlice(f.gameDir, input.file), receipt = coverageReadReceipt(input, output);
  assert.equal(receipt.requestLength, 65536); assert.equal(receipt.length, output.returnedBytes);
  const context = 'b'.repeat(64), decision = { version: COVERAGE_DECISION_VERSION, id: 'source-review', evidenceHash: 'a'.repeat(64),
    sourceContextHash: context, file: input.file, disposition: 'non-display', reason: 'A complete source was read.', reads: [receipt] };
  const fresh = value => coverageDecisionFresh(value, { roots: [f.gameDir], sourceContextHash: context });
  assert.equal(await fresh(decision), true);
  assert.equal(resourceReadProof({ ...decision, reads: [receipt] }, { file: input.file, sourceIndex: 0, bytes: output.totalBytes + 1 }), false);
  assert.equal(expressionReadProof(decision, { file: input.file, sourceIndex: 0, byteStart: 0, byteEnd: output.returnedBytes + 1 }), false);
  for (const requestLength of [undefined, -1, 1.5, 262145, receipt.length - 1]) {
    assert.equal(hasCoverageDecisionProof({ ...decision, reads: [{ ...receipt, requestLength }] }), false);
  }
  assert.equal(await fresh({ ...decision, version: 'pinhao-coverage-decision-4' }), false, 'old wrong receipts are not migrated');
  assert.equal(await fresh({ ...decision, reads: [{ ...receipt, hash: '0'.repeat(64) }] }), false);
  assert.equal(await fresh({ ...decision, sourceContextHash: 'c'.repeat(64) }), false);
  assert.equal(await fresh({ ...decision, reads: [] }), false);
  await writeFile(path.join(f.gameDir, 'utf8.txt'), 'A€B');
  const clippedInput = { file: 'utf8.txt', length: 2 }, clipped = await readSourceSlice(f.gameDir, clippedInput.file, clippedInput);
  const clippedReceipt = coverageReadReceipt(clippedInput, clipped);
  assert.equal(clippedReceipt.requestLength, 2); assert.equal(clippedReceipt.length, 1);
  assert.equal(await fresh({ ...decision, reads: [receipt, clippedReceipt] }), true);
  const binaryInput = { file: 'utf8.txt', length: 4, encoding: 'base64' };
  const binary = coverageReadReceipt(binaryInput, await readSourceSlice(f.gameDir, binaryInput.file, binaryInput));
  assert.equal(await fresh({ ...decision, reads: [receipt, binary] }), true);
});

async function resourceFixture(t) {
  const f = await fixture(t), file = 'resource-notes.txt';
  await rm(path.join(f.gameDir, 'data/Map001.json'));
  await writeFile(path.join(f.gameDir, file), 'DESCRIPTION en "Material parameter documentation."\n');
  const run = async (id, generate, extra = {}) => runAdaptation({ project: { id, engine: 'unknown' }, inventory: {},
    gameDir: f.gameDir, lab: f.lab, coverage: await f.scan(), workspaceDir: path.join(f.root, id),
    statePath: path.join(f.root, id, 'state.json'), verifyCoverage: ({ coverageDecisions }) => f.scan(coverageDecisions), generate, ...extra });
  return { ...f, file, run };
}

test('resource-only decisions require complete real reads, persist proof and reopen without new model work', async t => {
  const f = await resourceFixture(t);
  let resource;
  const result = await f.run('resource-review', async ({ tools }) => {
    resource = (await tools.inspect_coverage.execute({})).records.find(item => item.file === f.file);
    assert.equal(resource.reviewKind, 'resource-file'); assert.equal(resource.nonDisplayAllowed, true);
    const submit = () => tools.record_coverage_decisions.execute({ decisions: [{ id: resource.id, evidenceHash: resource.evidenceHash,
      disposition: 'non-display', reason: 'The complete source is parameter documentation, not consumed by gameplay display.' }] });
    assert.match((await submit()).error.message, /read_resource/);
    await tools.read_resource.execute({ file: f.file, offset: 0, length: 8 });
    await tools.read_resource.execute({ file: f.file, offset: 9, length: 10000 });
    assert.match((await submit()).error.message, /完整读取/);
    await tools.read_resource.execute({ file: f.file, offset: 8, length: 1 });
    assert.equal((await submit()).taskComplete, true);
  });
  assert.equal(result.status, 'verified', JSON.stringify(result)); assert.equal(result.units.length, 0);
  const reopened = await createAdapterLab({ dataDir: f.labDir }), saved = await reopened.listCoverageDecisions();
  assert.equal(saved.length, 1); assert.equal(saved[0].sourceHash, resource.sourceHash);
  assert.equal(saved[0].sourceIndex, resource.sourceIndex); assert.equal(saved[0].bytes, resource.bytes);
  assert.equal(hasCoverageDecisionProof(saved[0]), true);
  const checked = await f.scan(saved);
  assert.equal(checked.resources.find(item => item.file === f.file).kind, 'technical-metadata');
  const reused = await f.run('resource-reopen', async () => assert.fail('fresh proof must replay before another model request'), { lab: reopened });
  assert.equal(reused.status, 'verified'); assert.equal(reused.reused, true);
  await writeFile(path.join(f.gameDir, 'js/rpg_core.js'), "var RPGMAKER_NAME='MZ';");
  assert.equal((await f.scan(saved)).resources.find(item => item.file === f.file).kind, 'display-text-candidate', 'same-size dependency edits expire the decision');
  await writeFile(path.join(f.gameDir, f.file), 'DESCRIPTION en "Material parameter new text here."\n');
  assert.notEqual((await f.scan(saved)).resources.find(item => item.file === f.file).evidenceHash, resource.evidenceHash);
});

test('coverage resource filters expose their real review IDs, retain pagination and reject unknown categories explicitly', async t => {
  const f = await resourceFixture(t);
  await writeFile(path.join(f.gameDir, 'second-notes.txt'), 'DESCRIPTION en "Another material parameter document."\n');
  await f.run('resource-filter-contract', async ({ tools }) => {
    assert.ok(tools.inspect_coverage.inputSchema.jsonSchema.properties.kind.enum.includes('resource-file'));
    const first = await tools.inspect_coverage.execute({ kind: 'resource-file', limit: 1 });
    assert.equal(first.total, 2); assert.equal(first.records.length, 1);
    assert.equal(first.records[0].reviewKind, 'resource-file'); assert.ok(first.records[0].id);
    assert.equal(first.nextPage.input.kind, 'resource-file');
    const second = await tools.inspect_coverage.execute(first.nextPage.input);
    assert.equal(second.records.length, 1); assert.notEqual(second.records[0].id, first.records[0].id);
    assert.ok((await tools.inspect_coverage.execute({})).total > first.total, 'omitting the filter includes other resource kinds');
    const wrong = await tools.inspect_coverage.execute({ kind: 'records' });
    assert.equal(wrong.error.code, 'COVERAGE_KIND'); assert.match(wrong.error.message, /resource-file/);
    assert.match(wrong.nextAction, /省略kind/);
    assert.equal(wrong.total, undefined, 'an invalid filter cannot masquerade as an empty successful resource list');
  });
});

test('coverage decision input errors identify the exact item and field without repairing misspellings', async t => {
  const f = await resourceFixture(t);
  const result = await f.run('decision-input-contract', async ({ tools }) => {
    const resource = (await tools.inspect_coverage.execute({ kind: 'resource-file' })).records[0];
    const valid = { id: resource.id, evidenceHash: resource.evidenceHash, disposition: 'non-display', reason: 'Full source is developer parameter documentation, not gameplay text.' };
    for (const name of ['id', 'evidenceHash', 'disposition', 'reason']) for (const invalid of [undefined, '  ', 3]) {
      const item = { ...valid, [name]: invalid };
      if (invalid === undefined) delete item[name];
      const rejected = await tools.record_coverage_decisions.execute({ decisions: [item] });
      assert.equal(rejected.error.code, 'COVERAGE_DECISION_INPUT');
      assert.ok(rejected.error.message.startsWith(`decisions[0].${name} `));
      assert.ok(rejected.nextAction.includes(`decisions[0].${name}`));
      assert.notEqual(rejected.accepted, true);
    }
    const malformed = { ...valid, 'evidence`evidenceHash`': valid.evidenceHash, reason: valid.reason + '`}]' };
    delete malformed.evidenceHash;
    const typo = await tools.record_coverage_decisions.execute({ decisions: [malformed] });
    assert.match(typo.error.message, /decisions\[0\]\.evidenceHash 缺失/);
    assert.notEqual(typo.accepted, true, 'the host never guesses an alias for a misspelled proof field');
    const unknown = await tools.record_coverage_decisions.execute({ decisions: [{ ...valid, id: 'unknown-source-id' }] });
    assert.equal(unknown.error.code, 'COVERAGE_DECISION_ID'); assert.match(unknown.error.message, /decisions\[0\]\.id/);
    const stale = await tools.record_coverage_decisions.execute({ decisions: [{ ...valid, evidenceHash: '0'.repeat(64) }] });
    assert.equal(stale.error.code, 'COVERAGE_DECISION_STALE'); assert.match(stale.error.message, /decisions\[0\]\.evidenceHash/);
    const disposition = await tools.record_coverage_decisions.execute({ decisions: [{ ...valid, disposition: 'unknown-action' }] });
    assert.match(disposition.error.message, /decisions\[0\]\.disposition/);
    assert.match((await tools.record_coverage_decisions.execute({ decisions: 'encoded-array' })).error.message, /^decisions /);
    await tools.read_resource.execute({ file: resource.file });
    assert.equal((await tools.record_coverage_decisions.execute({ decisions: [valid] })).taskComplete, true);
  });
  assert.equal(result.status, 'verified', JSON.stringify(result.error));
  assert.equal(result.coverageDecisions.length, 1, 'only the correctly named, read and verified proof is persisted');
});

test('resource display decisions keep the file pending and cannot invent extracted text', async t => {
  const f = await resourceFixture(t);
  const result = await f.run('resource-display', async ({ tools }) => {
    const resource = (await tools.inspect_coverage.execute({})).records.find(item => item.file === f.file);
    await tools.read_resource.execute({ file: f.file, length: 12 });
    const checked = await tools.record_coverage_decisions.execute({ decisions: [{ id: resource.id, evidenceHash: resource.evidenceHash,
      disposition: 'display', reason: 'This source may contain displayed text and still needs exact locators.' }] });
    assert.equal(checked.accepted, true); assert.equal(checked.taskComplete, false);
  });
  assert.notEqual(result.status, 'verified'); assert.equal(result.units?.length ?? 0, 0);
  const checked = await f.scan(result.coverageDecisions);
  assert.equal(checked.resources.find(item => item.file === f.file).reviewStatus, 'display');
  assert.equal(checked.needsAdaptation, true);
});

test('generated partial extraction keeps a resource pending until an explicit full-source binding review without ID transport', async t => {
  const f = await resourceFixture(t), selected = [];
  let text = '';
  for (let index = 0; index < 2001; index++) {
    const source = `Entry ${index}.`, byteStart = Buffer.byteLength(text + 'description "');
    const locator = { file: f.file, byteStart, byteEnd: byteStart + Buffer.byteLength(source) };
    selected.push({ id: `selected-${index}`, source, tokens: [], context: { file: f.file, adaptationLocator: locator } });
    text += `description "${source}"\n`;
  }
  await writeFile(path.join(f.gameDir, f.file), text);
  const current = [...f.units, selected[0]];
  const scan = decisions => scanCoverage({ rootDir: f.gameDir, units: current, decisions });
  const partial = await scan(), before = partial.resources.find(item => item.file === f.file);
  assert.equal(before.partialExtraction, true); assert.equal(before.hasExtractedText, true);
  assert.equal(before.kind, 'display-text-candidate'); assert.equal(partial.needsAdaptation, true);
  current.push(...selected.slice(1));
  const coverage = await scan();
  const result = await f.run('complete-resource-bindings', async ({ tools }) => {
    const resource = (await tools.inspect_coverage.execute({})).records.find(item => item.file === f.file);
    assert.equal(resource.bindingCount, 2001); assert.equal(resource.boundReferenceAllowed, true);
    const decide = () => tools.record_coverage_decisions.execute({ decisions: [{ id: resource.id, evidenceHash: resource.evidenceHash,
      disposition: 'bound-reference', reason: 'Inspected the entire source; every displayed entry now has an accepted local locator.' }] });
    await tools.read_resource.execute({ file: f.file, length: 8 });
    assert.match((await decide()).error.message, /完整读取/);
    for (let offset = 0; offset < resource.bytes;) {
      const read = await tools.read_resource.execute({ file: f.file, offset, length: 4096 });
      offset += read.returnedBytes;
    }
    assert.equal((await decide()).taskComplete, true);
  }, { coverage, inventory: { existingUnits: current }, verifyCoverage: ({ coverageDecisions }) => scan(coverageDecisions) });
  assert.equal(result.status, 'verified', JSON.stringify(result.error));
  const reopened = await createAdapterLab({ dataDir: f.labDir }), saved = await reopened.listCoverageDecisions();
  const proof = saved.find(item => item.kind === 'resource-file');
  assert.equal(proof.bindingCount, 2001); assert.match(proof.bindingHash, /^[a-f0-9]{64}$/);
  assert.equal(proof.unitIds, undefined, 'the model and registry need not transport thousands of machine IDs');
  assert.equal((await scan(saved)).needsAdaptation, false);
  current.pop();
  const changed = await scan(saved);
  assert.equal(changed.needsAdaptation, true, 'a changed accepted locator set invalidates a completeness claim');
  assert.equal(current.length, 2001, 'existing accepted units are not cleared by invalidating the review');
});

test('known partial generated resources remain pending outside every heuristic sampling gate', async t => {
  const f = await resourceFixture(t), file = 'config.partial.bin';
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 0);
  bytes.write('Selected caption.', bytes.length - 32);
  await writeFile(path.join(f.gameDir, file), bytes);
  const locator = { file, byteStart: bytes.length - 32, byteEnd: bytes.length - 32 + 'Selected caption.'.length };
  const selected = { id: 'large-partial', source: 'Selected caption.', context: { file, adaptationLocator: locator } };
  const coverage = await scanCoverage({ rootDir: f.gameDir, units: [...f.units, selected], sampleFiles: 0 });
  const resource = coverage.resources.find(item => item.file === file);
  assert.equal(resource.kind, 'display-text-candidate'); assert.equal(resource.partialExtraction, true);
  assert.equal(resource.reviewKind, 'resource-file'); assert.equal(resource.bindingCount, 1);
  assert.equal(resource.sourceHash, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(coverage.needsAdaptation, true);
});

test('a generated extraction claim is not an authoritative native completeness scan', async t => {
  const f = await resourceFixture(t);
  const selected = { id: 'generated-one', source: 'Material parameter documentation.', context: { file: f.file,
    adaptationLocator: { file: f.file, byteStart: 16, byteEnd: 49 } } };
  const coverage = await scanCoverage({ rootDir: f.gameDir, units: [...f.units, selected],
    inventory: { coverage: { resources: [{ file: f.file, status: 'extracted', units: 1 }] } } });
  const resource = coverage.resources.find(item => item.file === f.file);
  assert.equal(resource.kind, 'display-text-candidate'); assert.equal(resource.partialExtraction, true);
  assert.equal(coverage.needsAdaptation, true);
});

test('reserved built-in script units keep their native ownership despite shared locator projection', async t => {
  const f = await resourceFixture(t), file = 'native.js';
  await rm(path.join(f.gameDir, f.file));
  const source = 'A whole native caption.', text = `view.drawText("${source}", 0, 0);\n`;
  await writeFile(path.join(f.gameDir, file), text);
  const locator = { file, byteStart: text.indexOf(source), byteEnd: text.indexOf(source) + source.length };
  const native = { id: 'project-unit-id', legacyId: 'script:host-reserved-caption', source, context: { file, adaptationLocator: locator } };
  const coverage = await scanCoverage({ rootDir: f.gameDir, units: [...f.units, native] });
  assert.equal(coverage.resources.find(item => item.file === file).reviewKind, undefined);
  assert.equal(coverage.needsAdaptation, false);
});

test('complete semantic JSON scans do not add a redundant generated-resource review, while unowned or unknown leaves remain pending', async t => {
  const f = await resourceFixture(t), file = 'letters.json';
  await rm(path.join(f.gameDir, f.file));
  const selected = { id: 'letter', source: 'An actual complete letter.', context: { file, adaptationLocator: { file, pointer: '/dialogue' } } };
  const scan = () => scanCoverage({ rootDir: f.gameDir, units: [...f.units, selected], scanCache: false });
  await writeFile(path.join(f.gameDir, file), JSON.stringify({ dialogue: selected.source, logic: { key: 'unchanged-key' } }));
  const complete = await scan();
  assert.equal(complete.needsAdaptation, false);
  assert.equal(complete.resources.find(item => item.file === file).reviewKind, undefined);
  const fallback = await createJsonCoverage({ units: [{ id: 'count-only', source: selected.source, context: { file } }] });
  const counted = fallback.inspect(file, await readFile(path.join(f.gameDir, file)));
  assert.equal(counted.candidates.length, 0); assert.equal(counted.unknownClusters.length, 0);
  assert.equal(counted.exactlyAccounted, false, 'source-count fallback is not precise field ownership');
  await writeFile(path.join(f.gameDir, file), JSON.stringify({ dialogue: selected.source, tooltip: 'A missing tooltip.', logic: { key: 'unchanged-key' } }));
  const missing = await scan();
  assert.equal(missing.needsAdaptation, true); assert.equal(missing.resources.find(item => item.file === file).partialExtraction, true);
  assert.ok(missing.dynamicCandidates.some(item => item.locator?.pointer === '/tooltip'));
  await writeFile(path.join(f.gameDir, file), JSON.stringify({ dialogue: selected.source, unfamiliar: 'An unknown actual sentence.' }));
  const unknown = await scan();
  assert.equal(unknown.needsAdaptation, true); assert.equal(unknown.resources.find(item => item.file === file).partialExtraction, true);
  assert.ok(unknown.unknownClusters.some(item => item.file === file));
  await writeFile(path.join(f.gameDir, file), JSON.stringify({ dialogue: 'A changed source letter.' }));
  const stale = await scan();
  assert.equal(stale.needsAdaptation, true); assert.equal(stale.resources.find(item => item.file === file).partialExtraction, true);
  const deep = { dialogue: selected.source }; let tail = deep;
  for (let index = 0; index < 130; index++) tail = tail.child = {};
  tail.tooltip = 'A deep unseen caption.';
  await writeFile(path.join(f.gameDir, file), JSON.stringify(deep));
  const truncated = await scan();
  assert.equal(truncated.truncated, true); assert.equal(truncated.needsAdaptation, true);
  assert.equal(truncated.resources.find(item => item.file === file).partialExtraction, true);
});

test('mature native extraction does not acquire a new whole-file review just because it has locators', async t => {
  const f = await resourceFixture(t);
  const native = { id: 'native-caption', source: 'Material parameter documentation.', context: { file: f.file }, locator: { file: f.file, byteStart: 16, byteEnd: 49 } };
  const coverage = await scanCoverage({ rootDir: f.gameDir, units: [...f.units, native] });
  assert.equal(coverage.resources.find(item => item.file === f.file).kind, 'extracted');
  assert.equal(coverage.resources.find(item => item.file === f.file).reviewKind, undefined);
});

test('reopened classification chooses the later investigation rather than a random content-hash filename', async t => {
  const f = await resourceFixture(t);
  await f.run('current-investigation', async ({ tools }) => {
    const resource = (await tools.inspect_coverage.execute({})).records.find(item => item.file === f.file);
    await tools.read_resource.execute({ file: f.file });
    await tools.record_coverage_decisions.execute({ decisions: [{ id: resource.id, evidenceHash: resource.evidenceHash,
      disposition: 'non-display', reason: 'The newer complete-source investigation confirms developer metadata.' }] });
  });
  const [current] = await f.lab.listCoverageDecisions();
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  let older;
  for (let index = 0; index < 1000; index++) {
    const candidate = { ...current, disposition: 'display', reason: `Older generic display assumption ${index}.`, decidedAt: '2000-01-01T00:00:00.000Z' };
    if (digest(candidate) > digest(current)) { older = candidate; break; }
  }
  assert.ok(older, 'construct a real registry ordering that would put the older conclusion last');
  await f.lab.saveCoverageDecisions({ decisions: [older] });
  const reopened = await createAdapterLab({ dataDir: f.labDir }), saved = await reopened.listCoverageDecisions();
  assert.equal(saved.at(-1).disposition, 'non-display');
  assert.equal((await f.scan(saved)).resources.find(item => item.file === f.file).kind, 'technical-metadata');
});

test('resource-level non-display cannot swallow exact display candidates or native recovery failures', async t => {
  const f = await resourceFixture(t), file = 'mixed.js';
  const text = 'caption.text = "A real displayed sentence.";\ncaption.text = "An unlocated complete sentence.";\n// description "Developer note"\n';
  await writeFile(path.join(f.gameDir, file), text);
  const inventory = { reviewItems: [{ file: f.file, kind: 'native_record_roundtrip_failed' }] };
  const selected = { id: 'already-selected', source: 'A real displayed sentence.', context: { file,
    adaptationLocator: { file, byteStart: text.indexOf('A real'), byteEnd: text.indexOf('A real') + 'A real displayed sentence.'.length } } };
  const scan = decisions => scanCoverage({ rootDir: f.gameDir, units: [...f.units, selected], inventory, decisions });
  const coverage = await scan();
  assert.ok(coverage.dynamicCandidates.some(item => item.file === file));
  const result = await f.run('mixed-resource', async ({ tools }) => {
    for (const target of [file, f.file]) {
      const resource = (await tools.inspect_coverage.execute({})).records.find(item => item.file === target);
      assert.equal(resource.nonDisplayAllowed, false);
      assert.equal(resource.boundReferenceAllowed, false);
      await tools.read_resource.execute({ file: target });
      const rejected = await tools.record_coverage_decisions.execute({ decisions: [{ id: resource.id, evidenceHash: resource.evidenceHash,
        disposition: 'non-display', reason: 'An incorrect attempt to dismiss a mixed or failed native source.' }] });
      assert.match(rejected.error.message, /不能覆盖/);
      const bound = await tools.record_coverage_decisions.execute({ decisions: [{ id: resource.id, evidenceHash: resource.evidenceHash,
        disposition: 'bound-reference', reason: 'An incorrect attempt to hide a remaining exact field behind one accepted unit.' }] });
      assert.ok(bound.error);
    }
  }, { coverage, inventory, verifyCoverage: ({ coverageDecisions }) => scan(coverageDecisions) });
  const checked = await scan(result.coverageDecisions);
  assert.ok(checked.dynamicCandidates.some(item => item.file === file));
  assert.ok(checked.extractionIssues.some(item => item.file === f.file));
  assert.equal(checked.needsAdaptation, true);
});

test('a proven non-linguistic child expression no longer blocks complete-source locator review', async t => {
  const f = await resourceFixture(t), file = 'mixed-counter.js';
  await rm(path.join(f.gameDir, f.file));
  const text = '// description "A translated caption."\npoints = Number(points); counter.text = String(points);\n';
  await writeFile(path.join(f.gameDir, file), text);
  const locator = { file, byteStart: text.indexOf('A translated'), byteEnd: text.indexOf('A translated') + 'A translated caption.'.length };
  const units = [...f.units, { id: 'caption', source: 'A translated caption.', context: { file, adaptationLocator: locator } }];
  const scan = decisions => scanCoverage({ rootDir: f.gameDir, units, decisions });
  const coverage = await scan();
  assert.equal(coverage.resources.find(item => item.file === file).boundReferenceAllowed, false);
  const displayVerifier = createDisplayVerifier({ connectionFor: () => ({ model: 'independent-counter', baseUrl: 'https://invalid.local' }),
    generate: async ({ tools, prompt }) => {
      const source = await tools.read_resource.execute({ file });
      assert.match(source.content, /points = Number\(points\)/);
      await tools.finish_review.execute({ decisions: JSON.parse(prompt).units.map(row => ({ ref: row.ref, status: 'non-display',
        reason: 'The source coerces to a number before inline display.', evidenceIds: [source.evidenceId], consumerEvidenceIds: [source.evidenceId] })) });
    } });
  const lab = await createAdapterLab({ dataDir: f.labDir, displayVerifier });
  const result = await f.run('resolved-child', async ({ tools }) => {
    const before = await tools.inspect_coverage.execute({}), expression = before.expressionCandidates.find(item => item.file === file);
    assert.ok(expression);
    await tools.read_resource.execute({ file });
    const expressionResult = await tools.record_coverage_decisions.execute({ decisions: [{ id: expression.id, evidenceHash: expression.evidenceHash,
      disposition: 'non-linguistic', reason: 'The inspected display expression only formats the numeric points counter.' }] });
    assert.equal(expressionResult.accepted, true); assert.equal(expressionResult.taskComplete, false);
    const resource = (await tools.inspect_coverage.execute({})).records.find(item => item.file === file);
    assert.equal(resource.boundReferenceAllowed, true);
    const reviewed = await tools.record_coverage_decisions.execute({ decisions: [{ id: resource.id, evidenceHash: resource.evidenceHash,
      disposition: 'bound-reference', reason: 'Full source read confirms the caption locator; the remaining display only formats numeric points.' }] });
    assert.equal(reviewed.taskComplete, true);
  }, { coverage, lab, inventory: { existingUnits: units }, verifyCoverage: ({ coverageDecisions }) => scan(coverageDecisions) });
  assert.equal(result.status, 'verified', JSON.stringify(result.error));
  const reopened = await createAdapterLab({ dataDir: f.labDir }), saved = await reopened.listCoverageDecisions();
  assert.equal((await scan(saved)).needsAdaptation, false);
  const childRemoved = await scan(saved.filter(item => item.kind === 'resource-file'));
  assert.equal(childRemoved.needsAdaptation, true, 'removing the child proof reopens its precise remaining work');
  assert.equal(childRemoved.resources.find(item => item.file === file).boundReferenceAllowed, false);
});

test('same-name resource decisions require the matching source-index reads and retain the other origin', async t => {
  const f = await resourceFixture(t), extra = path.join(f.root, 'other-source');
  await mkdir(extra); await writeFile(path.join(extra, f.file), 'DESCRIPTION en "A second parameter document."\n');
  const scan = decisions => scanCoverage({ rootDir: f.gameDir, sourceRoots: [extra], units: f.units, decisions });
  const coverage = await scan(), resources = coverage.resources.filter(item => item.file === f.file);
  assert.equal(resources.length, 2); assert.notEqual(resources[0].id, resources[1].id);
  const result = await f.run('two-resource-roots', async ({ tools }) => {
    await tools.read_resource.execute({ file: f.file, sourceIndex: 0 });
    const submit = () => tools.record_coverage_decisions.execute({ decisions: [{ id: resources[1].id, evidenceHash: resources[1].evidenceHash,
      disposition: 'non-display', reason: 'The second-source complete document is parameter metadata.' }] });
    assert.match((await submit()).error.message, /sourceIndex/);
    await tools.read_resource.execute({ file: f.file, sourceIndex: 1 });
    assert.equal((await submit()).accepted, true);
  }, { coverage, readDir: f.gameDir, readRoots: [extra], verifyCoverage: ({ coverageDecisions }) => scan(coverageDecisions) });
  const checked = await scan(result.coverageDecisions), items = checked.resources.filter(item => item.file === f.file);
  assert.equal(items[0].kind, 'display-text-candidate'); assert.equal(items[1].kind, 'technical-metadata');
  assert.equal(checked.needsAdaptation, true);
});

async function fixture(t) {
  const parent = path.resolve('local/coverage-decision-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'review-')), gameDir = path.join(root, 'game');
  await mkdir(path.join(gameDir, 'data'), { recursive: true }); await mkdir(path.join(gameDir, 'js'));
  await writeFile(path.join(gameDir, 'data/Map001.json'), JSON.stringify({ events: [null, { name: 'Inn conversation' }] }));
  await writeFile(path.join(gameDir, 'js/rpg_core.js'), "var RPGMAKER_NAME='MV';");
  const dataDir = path.join(root, 'profile'), labDir = path.join(dataDir, 'technical-recipes');
  const lab = await createAdapterLab({ dataDir: labDir });
  const units = [{ id: 'known', kind: 'message', source: 'A complete neutral scene.', tokens: [], context: { file: 'known.txt' } }];
  let requests = 0;
  const scan = decisions => scanCoverage({ rootDir: gameDir, units, decisions });
  const classify = async (id, options = {}) => runAdaptation({ project: { id, name: 'Neutral fixture', engine: 'MV' }, inventory: {}, gameDir, lab,
    workspaceDir: path.join(root, id), statePath: path.join(root, id, 'progress.jsonl'), coverage: await scan(),
    connection: { model: 'neutral' }, verifyCoverage: ({ coverageDecisions }) => scan(coverageDecisions),
    generate: async ({ tools }) => {
      requests++;
      await tools.list_files.execute({ relativePath: 'js' });
      await tools.list_files.execute({ relativePath: 'js/optional' });
      await tools.read_resource.execute({ file: 'js/rpg_core.js' });
      await options.read?.(tools);
      const current = await tools.inspect_context.execute({}), cluster = current.coverage.unknownClusters[0];
      await tools.read_resource.execute({ file: cluster.file });
      await tools.record_coverage_decisions.execute({ decisions: [{ id: cluster.id, evidenceHash: cluster.evidenceHash,
        disposition: 'non-display', reason: 'Inspected runtime and plugin directory keep this field as editor metadata.' }] });
    }, ...options.run,
  });
  t.after(async () => { assert.equal(path.dirname(root), parent); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  return { root, gameDir, dataDir, labDir, lab, units, scan, classify, requests: () => requests };
}

test('classification binds absent directories, newly added plugins and same-size script contents', async t => {
  const f = await fixture(t), first = await f.classify('first');
  assert.equal(first.status, 'verified');
  assert.ok(first.coverageDecisions[0].reads.some(read => read.kind === 'missing' && read.file === 'js/optional' && read.directory));
  assert.equal((await f.scan(first.coverageDecisions)).unknownClusters[0].status, 'non-display');
  await mkdir(path.join(f.gameDir, 'js/optional'));
  assert.equal((await f.scan(first.coverageDecisions)).unknownClusters[0].status, 'unknown', 'even an empty formerly absent directory changes the context');
  await rm(path.join(f.gameDir, 'js/optional'), { recursive: true });
  await mkdir(path.join(f.gameDir, 'js/plugins'));
  const plugin = path.join(f.gameDir, 'js/plugins/EventLabels.js');
  await writeFile(plugin, 'Window_Base.prototype.label = function(e) { return e.note; };');
  assert.equal((await f.scan(first.coverageDecisions)).unknownClusters[0].status, 'unknown');
  const second = await f.classify('second');
  assert.equal(second.status, 'verified');
  const previous = await readFile(plugin);
  await writeFile(plugin, previous.toString().replace('e.note', 'e.name'));
  assert.equal((await readFile(plugin)).length, previous.length);
  assert.equal((await f.scan(second.coverageDecisions)).unknownClusters[0].status, 'unknown', 'a same-path same-size plugin edit expires the old semantic decision');
});

test('actual binary read slices expire independently of the resource-name index', async t => {
  const f = await fixture(t), file = path.join(f.gameDir, 'runtime.blob');
  await writeFile(file, Buffer.alloc(131072, 65));
  const result = await f.classify('binary', { read: tools => tools.read_resource.execute({ file: 'runtime.blob', offset: 8192, length: 512, encoding: 'base64' }) });
  const before = await f.scan(result.coverageDecisions), bytes = await readFile(file);
  bytes[8192] = 66; await writeFile(file, bytes);
  const after = await f.scan(result.coverageDecisions);
  assert.equal(before.sourceContextHash, after.sourceContextHash, 'opaque assets use inventory identity rather than a full-file hash');
  assert.equal(after.unknownClusters[0].status, 'unknown', 'the exact investigated binary fragment remains a real dependency');
});

test('a fresh project and a reopened lab reuse identical classification with zero new model calls', async t => {
  const f = await fixture(t), first = await f.classify('project-one');
  assert.equal(first.status, 'verified'); assert.equal(f.requests(), 1);
  const reopened = await createAdapterLab({ dataDir: f.labDir });
  const saved = await reopened.listCoverageDecisions();
  assert.equal(saved.length, 1);
  assert.ok(!JSON.stringify(saved).includes(f.root));
  const second = await f.classify('project-two', { run: { lab: reopened, generate: async () => assert.fail('identical classification must be reused before a model request') } });
  assert.equal(second.status, 'verified'); assert.equal(second.reused, true); assert.equal(f.requests(), 1);
  let service;
  try {
    service = await createService({ dataDir: f.dataDir, adapterLab: reopened, scriptTools: null, imageTools: null,
      worker: async (command, input) => {
        if (command === 'catalog') return {};
        if (command === 'probe') return { engine: 'MV' };
        if (command === 'roundtrip') return { passed: true };
        if (command === 'extract') { await mkdir(input.workspaceDir, { recursive: true }); return { workspaceDir: input.workspaceDir, units: f.units }; }
        throw new Error(`Unexpected neutral worker command ${command}`);
      },
      adaptationProvider: async () => assert.fail('native import must reuse the cached classification'),
    });
    const created = await service.createProject({ gameDir: f.gameDir });
    assert.equal(created.adaptationPending, false);
    assert.equal(created.coverage.unknownClusters[0].status, 'non-display');
  } finally { await service?.close(); }
});

test('shared classification recipes exclude raw execution evidence while project records retain it', async t => {
  const f = await fixture(t), first = await f.classify('compact-registry');
  assert.equal(first.status, 'verified');
  const decision = { ...first.coverageDecisions[0], rawToolOutput: 'private raw observation',
    reads: first.coverageDecisions[0].reads.map(receipt => ({ ...receipt, content: 'private source fragment' })) };
  const workDir = path.join(f.root, 'compact-registry');
  await f.lab.saveCoverageDecisions({ projectId: 'compact-registry', workDir, decisions: [decision] });
  const saved = await f.lab.listCoverageDecisions();
  assert.ok(saved.length > 0);
  assert.ok(!JSON.stringify(saved).includes('private raw observation'));
  assert.ok(!JSON.stringify(saved).includes('private source fragment'));
  const local = await readdir(path.join(workDir, 'technical-lab', 'coverage'));
  const original = await Promise.all(local.map(file => readFile(path.join(workDir, 'technical-lab', 'coverage', file), 'utf8')));
  assert.ok(original.some(record => record.includes('private raw observation') && record.includes('private source fragment')));
  assert.equal((await f.scan(saved)).unknownClusters[0].status, 'non-display');
});

test('cancelled classification keeps source reads and negative directory evidence across resume', async t => {
  const f = await fixture(t), controller = new AbortController();
  const paused = await f.classify('cancel-resume', { run: { signal: controller.signal, generate: async ({ tools }) => {
    await tools.read_resource.execute({ file: 'js/rpg_core.js' });
    await tools.read_resource.execute({ file: 'data/Map001.json' });
    await tools.list_files.execute({ relativePath: 'js/optional' });
    controller.abort();
  } } });
  assert.equal(paused.status, 'cancelled');
  const resumed = await f.classify('cancel-resume', { run: { retry: true, generate: async ({ tools }) => {
    const context = await tools.inspect_context.execute({}), cluster = context.coverage.unknownClusters[0];
    await tools.record_coverage_decisions.execute({ decisions: [{ id: cluster.id, evidenceHash: cluster.evidenceHash,
      disposition: 'non-display', reason: 'Resume uses the already inspected runtime and absent directory.' }] });
  } } });
  assert.equal(resumed.status, 'verified');
  assert.ok(resumed.coverageDecisions[0].reads.some(read => read.kind === 'read'));
  assert.ok(resumed.coverageDecisions[0].reads.some(read => read.kind === 'missing'));
});

test('coverage and its resource context preserve authored cache and nested image-save folders', async t => {
  const f = await fixture(t);
  for (const directory of ['cache', 'save', 'img/save']) {
    await mkdir(path.join(f.gameDir, directory), { recursive: true });
    await writeFile(path.join(f.gameDir, directory, 'story.json'), JSON.stringify({ lines: ['A complete authored scene.'] }));
  }
  await writeFile(path.join(f.gameDir, 'private.log'), 'private runtime log');
  const before = await f.scan(), resources = before.resources.map(item => item.file);
  assert.ok(resources.includes('cache/story.json')); assert.ok(resources.includes('img/save/story.json'));
  assert.ok(!resources.includes('save/story.json')); assert.ok(!resources.includes('private.log'));
  assert.ok(before.dynamicCandidates.some(item => item.file === 'cache/story.json'));
  await writeFile(path.join(f.gameDir, 'save/story.json'), '{"lines":["Private progress changed."]}');
  assert.equal((await f.scan()).sourceContextHash, before.sourceContextHash, 'private saves stay outside classification identity');
  await writeFile(path.join(f.gameDir, 'cache/story.json'), '{"lines":["A changed authored scene."]}');
  assert.notEqual((await f.scan()).sourceContextHash, before.sourceContextHash);
});

test('multi-source classification replays the exact union and selected-origin reads without losing private exclusions', async t => {
  const f = await fixture(t), managed = path.join(f.root, 'managed');
  await mkdir(managed);
  await writeFile(path.join(managed, 'managed-context.txt'), 'managed context');
  await writeFile(path.join(managed, 'shared.blob'), 'managed value');
  await writeFile(path.join(f.gameDir, 'shared.blob'), 'original value');
  await mkdir(path.join(f.gameDir, 'save')); await writeFile(path.join(f.gameDir, 'save/private.rpgsave'), 'private progress');
  const scan = decisions => scanCoverage({ rootDir: managed, sourceRoots: [f.gameDir], units: f.units, decisions });
  const coverage = await scan();
  const result = await runAdaptation({ project: { id: 'multi-root', engine: 'MV' }, inventory: {}, gameDir: managed,
    readDir: managed, readRoots: [f.gameDir], lab: f.lab, coverage,
    workspaceDir: path.join(f.root, 'multi-work'), statePath: path.join(f.root, 'multi-work', 'state.json'),
    verifyCoverage: ({ coverageDecisions }) => scan(coverageDecisions),
    generate: async ({ tools }) => {
      const union = await tools.list_files.execute({ limit: 20 });
      assert.equal(union.sourceCount, 2);
      assert.ok(!union.files.some(file => file.path.startsWith('save/')));
      await tools.list_files.execute({ relativePath: 'js', sourceIndex: 1 });
      const original = await tools.read_resource.execute({ file: 'shared.blob', sourceIndex: 1 });
      assert.equal(original.content, 'original value');
      await tools.read_resource.execute({ file: 'shared.blob', sourceIndex: 0 });
      const cluster = (await tools.inspect_context.execute({})).coverage.unknownClusters[0];
      await tools.read_resource.execute({ file: cluster.file, sourceIndex: 1 });
      const submitted = await tools.record_coverage_decisions.execute({ decisions: [{ id: cluster.id, evidenceHash: cluster.evidenceHash,
        disposition: 'non-display', reason: 'Both source views and exact runtime material were inspected.' }] });
      assert.equal(submitted.accepted, true, JSON.stringify(submitted));
    } });
  assert.equal(result.status, 'verified', JSON.stringify(result.error));
  assert.equal((await scan(result.coverageDecisions)).unknownClusters[0].status, 'non-display');
  const reads = result.coverageDecisions[0].reads.filter(item => item.file === 'shared.blob');
  assert.deepEqual(reads.map(item => item.sourceIndex).sort(), [0, 1], 'origins are distinct dependencies, not one cached file receipt');
  await writeFile(path.join(f.gameDir, 'save/private.rpgsave'), 'private progress changed');
  assert.equal((await scan(result.coverageDecisions)).unknownClusters[0].status, 'non-display');
  await writeFile(path.join(f.gameDir, 'shared.blob'), 'changed value!');
  assert.equal((await scan(result.coverageDecisions)).unknownClusters[0].status, 'unknown', 'a changed actual origin invalidates the proof');
});

for (const disposition of ['display', 'non-display']) test(`${disposition} classification requires a nonempty read of its actual source, not a summary or another file`, async t => {
  const f = await fixture(t), coverage = await f.scan();
  const session = adaptationTools({ project: { id: `source-proof-${disposition}`, engine: 'MV' }, inventory: {}, lab: f.lab,
    gameDir: f.gameDir, workspaceDir: path.join(f.root, `source-proof-${disposition}`), coverage,
    state: { failures: {}, events: [] }, verifyCoverage: ({ coverageDecisions }) => f.scan(coverageDecisions) });
  try {
    const cluster = (await session.tools.inspect_context.execute({})).coverage.unknownClusters[0];
    const input = { decisions: [{ id: cluster.id, evidenceHash: cluster.evidenceHash, disposition,
      reason: 'A summary-only assertion must not count as reading this actual resource.' }] };
    assert.match((await session.tools.record_coverage_decisions.execute(input)).error.message, /read_resource.*data\/Map001\.json/);
    await session.tools.read_resource.execute({ file: 'js/rpg_core.js' });
    assert.match((await session.tools.record_coverage_decisions.execute(input)).error.message, /实际来源文件/);
    const empty = await session.tools.read_resource.execute({ file: cluster.file, offset: 1000000, length: 10 });
    assert.equal(empty.returnedBytes, 0);
    assert.match((await session.tools.record_coverage_decisions.execute(input)).error.message, /非空内容/);
    const actual = await session.tools.read_resource.execute({ file: cluster.file });
    assert.ok(actual.returnedBytes > 0);
    const submitted = await session.tools.record_coverage_decisions.execute(input);
    assert.equal(submitted.accepted, true, JSON.stringify(submitted));
    const decision = submitted.decisions.find(item => item.id === cluster.id);
    assert.equal(decision.version, COVERAGE_DECISION_VERSION);
    assert.equal(decision.reads.find(receipt => receipt.file === cluster.file && receipt.length > 0).length, actual.returnedBytes,
      'receipts record bytes actually read, not the larger requested length');
    assert.equal(hasCoverageDecisionProof(decision), true);
    const noRead = { ...decision, reads: [] };
    assert.equal(hasCoverageDecisionProof(noRead), false);
    assert.equal(await coverageDecisionFresh(noRead, { roots: [f.gameDir], sourceContextHash: coverage.sourceContextHash }), false);
    assert.equal(hasCoverageDecisionProof({ ...decision, version: 'pinhao-coverage-decision-2' }), false);
  } finally { await session.close(); await session.flush(); }
});
