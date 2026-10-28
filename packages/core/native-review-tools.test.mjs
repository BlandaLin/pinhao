import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createNativeTools } from './native-tools.mjs';
import { createEvidenceStore } from '../technical/adaptation/evidence.mjs';

const parent = path.resolve('local', 'native-review-tools-tests');
await mkdir(parent, { recursive: true });
const sourceFile = 'Game_Data/dialog.assets';
const groupId = 'neutral-dialog-component';
const evidenceHash = 'a'.repeat(64);
const unit = index => ({
  id: `native:${index}`, legacyId: `dialog:${index}`, kind: 'message',
  source: `A complete neutral source line ${index}.`, tokens: [], file: sourceFile,
  context: { file: sourceFile, field: ['rows', index, 'text'] },
});
const displayDecision = () => ({
  groupId, evidenceHash, disposition: 'display',
  fields: [{ path: ['rows', '*', 'text'], kind: 'message' }],
  reason: 'The scene dialogue component displays this field.',
});

async function fixture(t, { additions = 4, roundtrip = { passed: true, byteIdentical: true }, buildError, buildOperation, reviewFile = sourceFile, managedReview = false,
  manifestUnits = {}, unitTransform = value => value } = {}) {
  const directory = await mkdtemp(path.join(parent, 'case-'));
  const gameDir = path.join(directory, 'game'), workDir = managedReview ? path.join(directory, 'technical', 'round', 'adapter-workbench') : path.join(directory, 'task');
  const childDir = path.join(workDir, 'jobs', 'dialog'), workspaceDir = path.join(directory, 'host-workbench');
  await mkdir(path.dirname(path.join(gameDir, sourceFile)), { recursive: true });
  await writeFile(path.join(gameDir, sourceFile), 'Neutral original resource bytes.');
  await mkdir(childDir, { recursive: true });
  await mkdir(workspaceDir);
  await writeFile(path.join(workspaceDir, 'manifest.json'), '{"engine":"neutral","version":1}');
  const originalUnits = [unit(0), unit(1)].map(unitTransform);
  const calls = [], sampleReports = [];
  const worker = async (command, input, { signal } = {}) => {
    signal?.throwIfAborted();
    calls.push({ command, input, signal });
    if (command === 'native_review') return { ok: true, result: {
      total: 9, offset: input.offset ?? 0, nextOffset: 6,
      groups: [{ groupId, evidenceHash, file: sourceFile, count: 9 }],
    } };
    if (command === 'native_adapt') {
      await assert.rejects(lstat(input.outputDir), { code: 'ENOENT' }, 'native_adapt creates its fresh output itself');
      await mkdir(input.outputDir, { recursive: true });
      await writeFile(path.join(input.outputDir, 'manifest.json'), JSON.stringify({ engine: 'neutral', version: 2, units: manifestUnits }));
      try {
        const metadata = await readFile(path.join(input.workspaceDir, 'technical', 'product-source.json'));
        await mkdir(path.join(input.outputDir, 'technical')); await writeFile(path.join(input.outputDir, 'technical', 'product-source.json'), metadata);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return { ok: true, result: {
        workspaceDir: input.outputDir,
        units: [...originalUnits, ...Array.from({ length: additions }, (_, index) => unitTransform(unit(index + 2)))],
        files: [sourceFile],
        nativeReviewDecisions: input.decisions.map(decision => ({ ...decision, file: reviewFile })),
      } };
    }
    if (command === 'roundtrip') return { ok: true, result: roundtrip };
    if (command === 'build') {
      try { await lstat(input.outputDir); return { ok: false, error: { code: 'OUTPUT_EXISTS', message: 'Output already exists.' } }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await mkdir(input.outputDir);
      await writeFile(path.join(input.outputDir, 'sample.assets'), 'Neutral built sample bytes.');
      const report = { changed: input.translations.length, nativeFiles: 1, nativeChangedFiles: 1,
        status: 'built_structurally_verified_not_runtime_tested', files_sha256: { 'sample.assets': 'b'.repeat(64) } };
      sampleReports.push(report);
      await buildOperation?.(input, { gameDir, directory, report, signal });
      return buildError ? { ok: false, error: { code: 'sample-failed', message: 'Neutral sample readback failed.' } } : { ok: true, result: report };
    }
    throw new Error(`Unexpected native review command: ${command}`);
  };
  const tools = createNativeTools({ worker });
  await tools.seed({
    gameDir, workDir,
    extraction: { workspaceDir, units: originalUnits, files: [sourceFile] },
    probe: { engine: 'neutral-native', capabilities: { extract: true, nativeBuild: true } },
    ...(managedReview ? { reviewDir: path.join(directory, 'nr') } : {}),
  });
  t.after(async () => {
    assert.equal(path.dirname(directory), parent);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
  });
  const input = { gameDir, workDir: childDir, args: [] };
  const decide = (decision = displayDecision(), extra = {}) => tools.trustedTools.native_review_decide.execute({
    ...input, args: [JSON.stringify(decision)], ...extra,
  });
  return { directory, gameDir, workDir, childDir, workspaceDir, calls, sampleReports, tools, input, decide, worker };
}

test('child resource jobs reuse a host-seeded parent workbench for native review', async t => {
  const f = await fixture(t);
  const extraction = await f.tools.trustedTools.native_extract.execute(f.input);
  assert.equal(extraction.reused, true);
  assert.equal(extraction.unitCount, 2);
  assert.deepEqual(f.calls, []);
  const reviewed = await f.tools.trustedTools.native_review.execute(f.input);
  assert.equal(reviewed.groups[0].groupId, groupId);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].input.workspaceDir, f.workspaceDir);
});

test('native review forwards bounded pagination, group and normalized resource path', async t => {
  const f = await fixture(t), review = f.tools.trustedTools.native_review;
  const controller = new AbortController();
  const args = ['--file', 'Game_Data\\dialog.assets', '--group', groupId, '--offset', '2', '--limit', '6'];
  assert.equal(review.validateArgs(args), true);
  const result = await review.execute({ ...f.input, args, signal: controller.signal });
  assert.equal(result.offset, 2);
  assert.deepEqual(f.calls[0].input, { workspaceDir: f.workspaceDir, file: sourceFile, groupId, offset: 2, limit: 6 });
  assert.equal(f.calls[0].signal, controller.signal);
  for (const invalid of [
    ['--limit', '13'], ['--limit', '0'], ['--offset', '-1'], ['--offset', '1.5'],
    ['--file', '../private'], ['--file', 'C:\\private'], ['--file', './dialog.assets'],
    ['--offset'], ['--unknown', 'value'], ['--file', sourceFile, '--file', sourceFile],
    ['--group', groupId, '--group', 'other-group'],
  ]) {
    assert.equal(review.validateArgs(invalid), false, JSON.stringify(invalid));
    await assert.rejects(review.execute({ ...f.input, args: invalid }), /参数|分页|范围|相对/);
  }
});

test('native display decisions issue host receipts after roundtrip and bounded Chinese samples', async t => {
  const f = await fixture(t);
  const result = await f.decide({ ...displayDecision(), file: 'model-claimed-file' });
  assert.match(result.nativeReviewReceiptId, /^native-review-/);
  assert.equal(result.addedUnits, 4);
  assert.equal(result.decisions, 1);
  assert.deepEqual(result.validation, { roundtrip: 'passed', sample: 'passed', additionalUnits: 4 });
  assert.deepEqual(f.calls.map(call => call.command), ['native_adapt', 'roundtrip', 'build']);
  const adapted = f.calls[0].input.outputDir;
  assert.equal(path.relative(f.childDir, adapted).split(path.sep)[0], 'native-review');
  assert.equal(f.calls[1].input.workspaceDir, adapted);
  assert.equal(f.calls[2].input.workspaceDir, adapted);
  assert.deepEqual(f.calls[2].input.translations.map(item => item.id), ['dialog:2', 'dialog:3', 'dialog:4']);
  assert.ok(f.calls[2].input.translations.every(item => item.translation.startsWith('译')));
  const receipt = await f.tools.resolveNativeReview({ ...f.input, receiptId: result.nativeReviewReceiptId });
  assert.deepEqual(receipt.files, [sourceFile]);
  assert.equal(receipt.decisions[0].file, sourceFile, 'The receipt must retain the verified native resource rather than the model claim.');
  assert.equal(receipt.validation.additionalUnits, 4);
  assert.deepEqual(receipt.validation.sampleDetails.report, f.sampleReports[0]);
  assert.deepEqual(receipt.validation.sampleDetails.units.map(item => item.id), ['dialog:2', 'dialog:3', 'dialog:4']);
  assert.ok(receipt.validation.sampleDetails.units.every(item => /^[a-f0-9]{64}$/.test(item.translationHash)));
  assert.deepEqual(result.sampleArtifact.cleanup, { status: 'released' });
  assert.equal(result.sampleArtifact.evidenceId, receipt.validation.sampleDetails.evidenceId);
  const saved = await createEvidenceStore(f.childDir).read({ evidenceId: result.sampleArtifact.evidenceId, pointer: '/report/nativeFiles' });
  assert.equal(saved.value, 1);
  await assert.rejects(lstat(f.calls[2].input.outputDir), { code: 'ENOENT' });
  assert.equal(result.validation.sampleDetails, undefined, 'The full hash report stays on the host rather than repeating in model context.');
  assert.equal(receipt.baseline.workspaceDir, await realpath(f.workspaceDir));
  assert.equal(receipt.extraction.workspaceDir, adapted);
  assert.equal(receipt.resultIdentity.workspaceDir, adapted);
  assert.equal(result.extraction, undefined, 'Validated extraction stays in the private host receipt.');
  assert.equal(await readFile(path.join(f.gameDir, sourceFile), 'utf8'), 'Neutral original resource bytes.');
});

test('Chinese samples keep complete manifest-linked groups, including old and late members, without expanding equal unlinked text', async t => {
  const sharedIds = ['dialog:0', 'dialog:2', 'dialog:9'];
  const sameTextIds = new Set([...sharedIds, 'dialog:8']);
  const sharedSource = 'The same complete line {{name}}.\n\nA second paragraph.';
  const manifestUnits = Object.fromEntries(sharedIds.map(id => [id, { sync_group: 'neutral-shared-display' }]));
  const f = await fixture(t, { additions: 8, manifestUnits,
    unitTransform: value => value.legacyId === 'dialog:9' ? { ...value, source: 'Another view of the same jointly written target {{name}}.' }
      : sameTextIds.has(value.legacyId) ? { ...value, source: sharedSource } : value,
    buildOperation: async input => {
      const translations = new Map(input.translations.map(item => [item.id, item.translation]));
      assert.deepEqual([...translations.keys()], ['dialog:0', 'dialog:2', 'dialog:3', 'dialog:4', 'dialog:9']);
      for (const id of sharedIds) assert.equal(translations.get(id), `译${sharedSource}`, 'every physical shared target must receive the same whole sample text');
      assert.equal(translations.has('dialog:8'), false, 'equal text without the manifest joint-write constraint must stay outside the sample');
    } });
  const result = await f.decide();
  assert.equal(result.addedUnits, 8, 'sample expansion does not change the count of newly extracted units');
  assert.equal(f.calls.filter(call => call.command === 'build').length, 1);
  const receipt = await f.tools.resolveNativeReview({ ...f.input, receiptId: result.nativeReviewReceiptId });
  assert.equal(receipt.extraction.units.length, 10, 'independent method/scene IDs are not deduplicated');
  assert.equal(receipt.extraction.units.find(item => item.legacyId === 'dialog:9').source, 'Another view of the same jointly written target {{name}}.', 'sample text does not rewrite source material');
  assert.deepEqual(receipt.validation.sampleDetails.units.map(item => item.id), ['dialog:0', 'dialog:2', 'dialog:3', 'dialog:4', 'dialog:9']);
  const hashes = receipt.validation.sampleDetails.units.filter(item => sharedIds.includes(item.id)).map(item => item.translationHash);
  assert.equal(new Set(hashes).size, 1);
  assert.equal(result.sampleArtifact.cleanup.status, 'released');
});

test('a changed verified result cannot be promoted through an earlier host receipt', async t => {
  const f = await fixture(t), result = await f.decide();
  const receipt = await f.tools.resolveNativeReview({ ...f.input, receiptId: result.nativeReviewReceiptId });
  await writeFile(path.join(receipt.extraction.workspaceDir, 'manifest.json'), '{"changed":true}');
  await assert.rejects(f.tools.resolveNativeReview({ ...f.input, receiptId: result.nativeReviewReceiptId }), /工作台已改变/);
});

test('native review receipts enforce game and exact job ownership and reject unregistered IDs', async t => {
  const f = await fixture(t), result = await f.decide();
  const receiptId = result.nativeReviewReceiptId;
  const otherGame = path.join(f.directory, 'other-game');
  await mkdir(otherGame);
  for (const input of [
    { ...f.input, receiptId: 'native-review-unregistered' },
    { ...f.input, receiptId, gameDir: otherGame },
    { ...f.input, receiptId, workDir: f.workDir },
    { ...f.input, receiptId, workDir: path.join(f.workDir, 'jobs', 'other') },
  ]) await assert.rejects(f.tools.resolveNativeReview(input), /本资源任务/);
  const first = await f.tools.resolveNativeReview({ ...f.input, receiptId });
  first.files.push('forged');
  first.decisions[0].reason = 'Changed external copy.';
  const second = await f.tools.resolveNativeReview({ ...f.input, receiptId });
  assert.deepEqual(second.files, [sourceFile]);
  assert.equal(second.decisions[0].reason, displayDecision().reason);
  const controller = new AbortController();
  controller.abort(new DOMException('Cancelled neutral review.', 'AbortError'));
  await assert.rejects(f.tools.resolveNativeReview({ ...f.input, receiptId, signal: controller.signal }), { name: 'AbortError' });
});

test('releasing a resource task revokes its native review receipts', async t => {
  const f = await fixture(t), result = await f.decide();
  f.tools.release({ workDir: f.childDir });
  await assert.rejects(f.tools.resolveNativeReview({ ...f.input, receiptId: result.nativeReviewReceiptId }), /本资源任务/);
  const proof = await createEvidenceStore(f.childDir).read({ evidenceId: result.sampleArtifact.evidenceId, pointer: '/report/files_sha256/sample.assets' });
  assert.equal(proof.content, f.sampleReports[0].files_sha256['sample.assets'], 'Proof remains readable after the receipt map is released.');
  const extraction = await f.tools.trustedTools.native_extract.execute(f.input);
  assert.equal(extraction.reused, true, 'A sibling-capable parent seed should remain reusable until its own task is released.');
});

test('non-display native decisions validate roundtrip without generating sample translations', async t => {
  const f = await fixture(t, { additions: 0 });
  const result = await f.decide({ groupId, evidenceHash, disposition: 'non-display', reason: 'The fields store asset identifiers.' });
  assert.equal(result.addedUnits, 0);
  assert.deepEqual(result.validation, { roundtrip: 'passed', sample: 'not-required', additionalUnits: 0 });
  assert.deepEqual(f.calls.map(call => call.command), ['native_adapt', 'roundtrip']);
  assert.deepEqual((await f.tools.resolveNativeReview({ ...f.input, receiptId: result.nativeReviewReceiptId })).files, [sourceFile]);
});

for (const roundtrip of [{ passed: false }, { valid: false }, { byteIdentical: false }]) {
  test(`native review rejects unsuccessful roundtrip ${JSON.stringify(roundtrip)}`, async t => {
    const f = await fixture(t, { roundtrip });
    await assert.rejects(f.decide(), /无改动回写检查失败/);
    assert.deepEqual(f.calls.map(call => call.command), ['native_adapt', 'roundtrip']);
    await assert.rejects(f.tools.resolveNativeReview({ ...f.input, receiptId: 'native-review-unregistered' }), /本资源任务/);
  });
}

test('native sample errors stop review receipt creation', async t => {
  const f = await fixture(t, { buildError: true });
  await assert.rejects(f.decide(), { message: 'Neutral sample readback failed.', code: 'sample-failed' });
  assert.deepEqual(f.calls.map(call => call.command), ['native_adapt', 'roundtrip', 'build']);
  assert.equal(await readFile(path.join(f.calls[2].input.outputDir, 'sample.assets'), 'utf8'), 'Neutral built sample bytes.');
});

test('a successful sample with an unconfirmed junction target is retained without touching source data', async t => {
  const f = await fixture(t, { buildOperation: async (input, { gameDir, directory }) => {
    assert.ok(input.outputDir.startsWith(`${directory}${path.sep}`));
    assert.match(path.basename(input.outputDir), /^s-[a-f0-9]{32}$/);
    await rm(input.outputDir, { recursive: true });
    await symlink(gameDir, input.outputDir, 'junction');
  } });
  const result = await f.decide();
  assert.deepEqual(result.sampleArtifact.cleanup, { status: 'retained', reason: 'ownership-unconfirmed' });
  assert.equal((await lstat(f.calls[2].input.outputDir)).isSymbolicLink(), true);
  assert.equal(await readFile(path.join(f.gameDir, sourceFile), 'utf8'), 'Neutral original resource bytes.');
  assert.deepEqual((await f.tools.resolveNativeReview({ ...f.input, receiptId: result.nativeReviewReceiptId })).validation.sampleDetails.report, f.sampleReports[0]);
});

test('cleanup lookup failures do not revoke a successfully validated receipt or claim released bytes', async t => {
  const f = await fixture(t, { buildOperation: async (input, { directory }) => {
    assert.ok(input.outputDir.startsWith(`${directory}${path.sep}`));
    await rm(input.outputDir, { recursive: true });
  } });
  const result = await f.decide();
  assert.equal(result.sampleArtifact.cleanup.status, 'retained');
  assert.equal(result.sampleArtifact.cleanup.reason, 'cleanup-error');
  assert.equal(result.sampleArtifact.cleanup.error.code, 'ENOENT');
  const receipt = await f.tools.resolveNativeReview({ ...f.input, receiptId: result.nativeReviewReceiptId });
  assert.deepEqual(receipt.validation.sampleDetails.report, f.sampleReports[0]);
  assert.equal(receipt.validation.sample, 'passed');
});

test('cancelled sample workers retain their output before and after settling', async t => {
  const entered = Promise.withResolvers(), settle = Promise.withResolvers(), controller = new AbortController();
  const f = await fixture(t, { buildOperation: async input => { entered.resolve(input.outputDir); await settle.promise; } });
  const pending = f.decide(displayDecision(), { signal: controller.signal });
  const sampleDir = await entered.promise;
  controller.abort(new DOMException('Neutral cancellation.', 'AbortError'));
  assert.equal((await lstat(sampleDir)).isDirectory(), true);
  settle.resolve();
  const result = await pending;
  assert.deepEqual(result.sampleArtifact.cleanup, { status: 'retained', reason: 'cancelled' });
  assert.equal(await readFile(path.join(sampleDir, 'sample.assets'), 'utf8'), 'Neutral built sample bytes.');
});

test('parallel sample receipts release only their own settled output directory', async t => {
  const entered = Promise.withResolvers(), gates = [Promise.withResolvers(), Promise.withResolvers()], samples = [];
  const f = await fixture(t, { buildOperation: async input => {
    const index = samples.length; samples.push(input.outputDir);
    if (samples.length === 2) entered.resolve();
    await gates[index].promise;
  } });
  const pending = [f.decide(), f.decide()];
  try {
    await entered.promise;
    const firstDone = Promise.race(pending); gates[0].resolve();
    await firstDone;
    await assert.rejects(lstat(samples[0]), { code: 'ENOENT' });
    assert.equal((await lstat(samples[1])).isDirectory(), true);
    gates[1].resolve();
    const results = await Promise.all(pending);
    for (const sample of samples) await assert.rejects(lstat(sample), { code: 'ENOENT' });
    for (const result of results) assert.equal((await f.tools.resolveNativeReview({ ...f.input, receiptId: result.nativeReviewReceiptId })).validation.sampleDetails.cleanup.status, 'released');
    assert.notEqual(results[0].nativeReviewReceiptId, results[1].nativeReviewReceiptId);
  } finally { for (const gate of gates) gate.resolve(); await Promise.allSettled(pending); }
});

test('native review requires host-verified resource provenance before issuing a receipt', async t => {
  const f = await fixture(t, { reviewFile: null });
  await assert.rejects(f.decide({ ...displayDecision(), file: sourceFile }), /已核对的资源与决定/);
  assert.deepEqual(f.calls.map(call => call.command), ['native_adapt']);
});

test('native review decisions require current evidence, disposition and field intent', async t => {
  const f = await fixture(t), tool = f.tools.trustedTools.native_review_decide;
  for (const args of [
    [], ['{}'], ['[]'], ['invalid JSON'], [JSON.stringify({ ...displayDecision(), evidenceHash: 'not-a-digest' })],
    [JSON.stringify({ ...displayDecision(), disposition: 'unknown' })],
    [JSON.stringify({ ...displayDecision(), reason: ' ' })],
    [JSON.stringify({ ...displayDecision(), fields: [] })],
  ]) assert.equal(tool.validateArgs(args), false, JSON.stringify(args));
  assert.equal(tool.validateArgs([JSON.stringify(displayDecision())]), true);
  const withSites = { ...displayDecision(), fields: [{ path: ['rows', '*', 'text'], kind: 'message', displaySites: ['native-display-site-1'] }] };
  assert.equal(tool.validateArgs([JSON.stringify(withSites)]), true);
  for (const displaySites of [null, 'site', [''], [' '], [42]]) {
    assert.equal(tool.validateArgs([JSON.stringify({ ...withSites, fields: [{ ...withSites.fields[0], displaySites }] })]), false);
  }
  assert.deepEqual(f.calls, []);
});

test('identical native decisions reuse a receipt only after rechecking the baseline, result and original source', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.workspaceDir, 'technical'));
  const original = await readFile(path.join(f.gameDir, sourceFile));
  await writeFile(path.join(f.workspaceDir, 'technical', 'product-source.json'), JSON.stringify({ sourceFiles: {
    [sourceFile]: createHash('sha256').update(original).digest('hex'),
  } }));
  const first = await f.decide(), second = await f.decide();
  assert.equal(second.nativeReviewReceiptId, first.nativeReviewReceiptId);
  assert.equal(second.reused, true);
  assert.deepEqual(f.calls.map(call => call.command), ['native_adapt', 'roundtrip', 'build', 'roundtrip']);
  const receipt = await f.tools.resolveNativeReview({ ...f.input, receiptId: first.nativeReviewReceiptId });
  await writeFile(path.join(f.gameDir, sourceFile), 'Changed neutral original.');
  await assert.rejects(f.decide(), /输入资源已改变/);
  await writeFile(path.join(f.gameDir, sourceFile), original);
  await writeFile(path.join(receipt.extraction.workspaceDir, 'manifest.json'), '{"changed":true}');
  await assert.rejects(f.decide(), /已验证的原生工作台已改变/);
  assert.equal(f.calls.filter(call => call.command === 'native_adapt').length, 1);
});

test('settling reclaims committed candidates but retains uncommitted validated results and their complete evidence', async t => {
  const f = await fixture(t, { managedReview: true });
  const result = await f.decide(), receipt = await f.tools.resolveNativeReview({ ...f.input, receiptId: result.nativeReviewReceiptId });
  const workspaceDir = receipt.extraction.workspaceDir;
  const uncommitted = await f.tools.settleReviewWorkbenches({ workDir: f.workDir, projectDir: f.directory });
  assert.equal(uncommitted.retained.length, 1);
  assert.equal(uncommitted.retained[0].status, 'verified');
  assert.equal((await lstat(workspaceDir)).isDirectory(), true);
  f.tools.commitReviewWorkbenches({ workspaceDirs: [workspaceDir] });
  const completed = await f.tools.settleReviewWorkbenches({ workDir: f.workDir, projectDir: f.directory });
  assert.deepEqual(completed.retained, []);
  assert.deepEqual(completed.results, [{ workspaceDir, status: 'released' }]);
  await assert.rejects(lstat(workspaceDir), { code: 'ENOENT' });
  const lifecycle = JSON.parse(await readFile(path.join(f.childDir, 'evidence', `${uncommitted.retained[0].evidenceId}.json`), 'utf8')).value;
  assert.equal(lifecycle.validation.sampleDetails.evidenceId, result.sampleArtifact.evidenceId);
  const proof = JSON.parse(await readFile(path.join(f.childDir, 'evidence', `${result.sampleArtifact.evidenceId}.json`), 'utf8')).value;
  assert.deepEqual(proof.report, f.sampleReports[0]);
  assert.deepEqual(proof.units, receipt.validation.sampleDetails.units);
  const checked = await createEvidenceStore(f.childDir).read({ evidenceId: result.sampleArtifact.evidenceId, pointer: '/report/nativeFiles' });
  assert.equal(checked.value, 1);
  assert.equal(await readFile(path.join(f.gameDir, sourceFile), 'utf8'), 'Neutral original resource bytes.');
});

test('failed generations remain bounded across release and resume, while protected current and previous copies survive', async t => {
  const f = await fixture(t, { managedReview: true });
  const allocate = async (status = 'failed') => {
    const workspaceDir = await f.tools.allocateReviewWorkbench({ workDir: f.childDir, reviewDir: path.join(f.directory, 'nf') });
    await mkdir(workspaceDir); await writeFile(path.join(workspaceDir, 'retained.bin'), 'Neutral recovery data.');
    await f.tools.finishReviewWorkbench({ workspaceDir, status, error: { code: 'NEUTRAL_FAILURE', message: 'Recoverable neutral attempt.' } });
    return workspaceDir;
  };
  const current = await allocate('verified'), previous = await allocate('verified');
  f.tools.commitReviewWorkbenches({ workspaceDirs: [current, previous] });
  const oldFailures = [await allocate(), await allocate(), await allocate()];
  const first = await f.tools.settleReviewWorkbenches({ workDir: f.workDir, projectDir: f.directory, keep: [current, previous, f.workspaceDir] });
  await assert.rejects(lstat(oldFailures[0]), { code: 'ENOENT' });
  assert.equal(first.retained.filter(entry => entry.status === 'failed').length, 2);
  f.tools.release({ workDir: f.workDir });
  const nextFailures = [await allocate(), await allocate()];
  const resumed = await f.tools.settleReviewWorkbenches({ workDir: f.workDir, projectDir: f.directory, keep: [current, previous, f.workspaceDir], retained: first.retained });
  assert.deepEqual(resumed.retained.filter(entry => entry.status === 'failed').map(entry => entry.workspaceDir), nextFailures);
  for (const file of oldFailures) await assert.rejects(lstat(file), { code: 'ENOENT' });
  for (const file of [current, previous, f.workspaceDir, ...nextFailures]) assert.equal((await lstat(file)).isDirectory(), true);
});

test('settling ignores unregistered history and refuses junction ownership without deleting the target', async t => {
  const f = await fixture(t, { managedReview: true });
  const root = path.join(f.directory, 'nr');
  await mkdir(root);
  const oldDir = path.join(root, 'a'.repeat(32)); await mkdir(oldDir); await writeFile(path.join(oldDir, 'old.bin'), 'Unregistered historical artifact.');
  const workspaceDir = await f.tools.allocateReviewWorkbench({ workDir: f.childDir, reviewDir: root });
  await symlink(f.gameDir, workspaceDir, 'junction');
  await f.tools.finishReviewWorkbench({ workspaceDir, status: 'verified', validation: { passed: true } });
  f.tools.commitReviewWorkbenches({ workspaceDirs: [workspaceDir] });
  const result = await f.tools.settleReviewWorkbenches({ workDir: f.workDir, projectDir: f.directory });
  assert.equal(result.results[0].status, 'retained');
  assert.equal(result.results[0].reason, 'ownership-or-evidence-unconfirmed');
  assert.equal(await readFile(path.join(oldDir, 'old.bin'), 'utf8'), 'Unregistered historical artifact.');
  assert.equal(await readFile(path.join(f.gameDir, sourceFile), 'utf8'), 'Neutral original resource bytes.');
});

test('a restarted host restores a hash-bound verified candidate without carrier copies or another Chinese sample', async t => {
  const f = await fixture(t, { managedReview: true });
  const answer = await f.decide(), original = await f.tools.resolveNativeReview({ ...f.input, receiptId: answer.nativeReviewReceiptId });
  const saved = await f.tools.settleReviewWorkbenches({ workDir: f.workDir, projectDir: f.directory });
  assert.match(saved.retained[0].stageHash, /^[a-f0-9]{64}$/);
  const stage = JSON.parse(await readFile(saved.retained[0].stageFile, 'utf8'));
  assert.deepEqual(stage.extraction, original.extraction, 'the stage contains this candidate, not an inherited stale extraction');
  f.tools.release({ workDir: f.workDir });
  const resumed = createNativeTools({ worker: f.worker });
  const restored = await resumed.restoreNativeReviews({ gameDir: f.gameDir, workDir: f.workDir, projectDir: f.directory, retained: saved.retained });
  assert.deepEqual(restored.failures, []);
  assert.deepEqual(restored.receipts, [{ id: answer.nativeReviewReceiptId, workDir: await realpath(f.childDir) }]);
  const receipt = await resumed.resolveNativeReview({ ...f.input, receiptId: answer.nativeReviewReceiptId });
  assert.deepEqual(receipt.extraction, original.extraction);
  assert.deepEqual(receipt.validation, original.validation);
  assert.deepEqual(f.calls.map(call => call.command), ['native_adapt', 'roundtrip', 'build', 'roundtrip']);
  resumed.commitReviewWorkbenches({ workspaceDirs: [receipt.extraction.workspaceDir] });
  const settled = await resumed.settleReviewWorkbenches({ workDir: f.workDir, projectDir: f.directory, retained: saved.retained });
  assert.deepEqual(settled.retained, []);
  await assert.rejects(lstat(receipt.extraction.workspaceDir), { code: 'ENOENT' });
  resumed.release({ workDir: f.workDir });
  await assert.rejects(resumed.resolveNativeReview({ ...f.input, receiptId: answer.nativeReviewReceiptId }), /本资源任务通过原生验证/);
});

for (const tamper of ['stage', 'evidence', 'source', 'junction']) test(`restoring a ${tamper}-changed candidate reports its pending reason and retains all work`, async t => {
  const f = await fixture(t, { managedReview: true });
  if (tamper === 'source') {
    await mkdir(path.join(f.workspaceDir, 'technical'));
    await writeFile(path.join(f.workspaceDir, 'technical', 'product-source.json'), JSON.stringify({ sourceFiles: {
      [sourceFile]: createHash('sha256').update(await readFile(path.join(f.gameDir, sourceFile))).digest('hex'),
    } }));
  }
  await f.decide();
  const saved = await f.tools.settleReviewWorkbenches({ workDir: f.workDir, projectDir: f.directory }), entry = saved.retained[0];
  if (tamper === 'stage') await writeFile(entry.stageFile, `${await readFile(entry.stageFile, 'utf8')} `);
  if (tamper === 'evidence') {
    const file = path.join(entry.workDir, 'evidence', `${entry.evidenceId}.json`), record = JSON.parse(await readFile(file, 'utf8'));
    record.value.decisions[0].reason = 'Tampered neutral reason.'; await writeFile(file, JSON.stringify(record));
  }
  if (tamper === 'source') await writeFile(path.join(f.gameDir, sourceFile), 'A deliberately changed source fixture.');
  if (tamper === 'junction') {
    await rename(entry.workspaceDir, path.join(f.directory, 'preserved-candidate'));
    await symlink(f.gameDir, entry.workspaceDir, 'junction');
  }
  f.tools.release({ workDir: f.workDir });
  const resumed = createNativeTools({ worker: f.worker });
  const restored = await resumed.restoreNativeReviews({ gameDir: f.gameDir, workDir: f.workDir, projectDir: f.directory, retained: saved.retained });
  assert.deepEqual(restored.receipts, []);
  assert.equal(restored.failures.length, 1); assert.ok(restored.failures[0].message);
  const settled = await resumed.settleReviewWorkbenches({ workDir: f.workDir, projectDir: f.directory, retained: saved.retained });
  assert.equal(settled.retained[0].status, 'invalid');
  assert.deepEqual(settled.retained[0].restoreError, { code: restored.failures[0].code, message: restored.failures[0].message });
  assert.equal((await lstat(entry.workspaceDir)).isDirectory() || (await lstat(entry.workspaceDir)).isSymbolicLink(), true);
  assert.equal(f.calls.filter(call => call.command === 'native_adapt').length, 1);
  const repeated = await resumed.restoreNativeReviews({ gameDir: f.gameDir, workDir: f.workDir, projectDir: f.directory, retained: settled.retained });
  assert.deepEqual(repeated, { receipts: [], failures: [] }, 'invalid work is retained with its reason, not re-armed as a global repeating failure');
});

test('old uncommitted audit candidates without a host stage hash are left intact, not auto-restored or deleted', async t => {
  const f = await fixture(t, { managedReview: true }); await f.decide();
  const saved = await f.tools.settleReviewWorkbenches({ workDir: f.workDir, projectDir: f.directory });
  const retained = saved.retained.map(({ stageHash, stageFile, ...entry }) => entry);
  f.tools.release({ workDir: f.workDir });
  const resumed = createNativeTools({ worker: f.worker });
  assert.deepEqual(await resumed.restoreNativeReviews({ gameDir: f.gameDir, workDir: f.workDir, projectDir: f.directory, retained }), { receipts: [], failures: [] });
  assert.equal((await lstat(retained[0].workspaceDir)).isDirectory(), true);
});
