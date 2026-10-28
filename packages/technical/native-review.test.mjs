import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { adaptationTools } from './adaptation.mjs';
import { boundedToolOutput } from './adaptation/tool-output.mjs';

const parent = path.resolve('local', 'adaptation-native-review-tests');
await mkdir(parent, { recursive: true });
const file = 'Game_Data/dialog.assets';
const otherFile = 'Game_Data/other.assets';
const coverageFor = (remaining = 1) => ({
  needsAdaptation: remaining > 0,
  resources: [], dynamicCandidates: [], extractionIssues: [],
  nativeReviewIssues: remaining ? [{ file, kind: 'component_schema_required', count: remaining }] : [],
  summary: { nativeReviewObjects: remaining, nativeReviewResources: remaining ? 1 : 0, unresolvedCandidates: 0 },
  triggers: remaining ? ['native-schema-review'] : [],
});
const accepted = {
  workspaceDir: 'neutral-accepted-workbench', binding: { recipeId: 'accepted-dialogue' },
  units: [{ id: 'accepted:1', kind: 'message', source: 'The already extracted dialogue remains.', locator: { file, pointer: '/line' } }],
};
const receiptFor = (files = [file]) => ({
  id: 'host-native-review-receipt', files,
  decisions: [{ groupId: `native-review-v1:${'a'.repeat(16)}:${'b'.repeat(24)}`, evidenceHash: 'a'.repeat(64), disposition: 'display', fields: [{ path: ['rows', '*', 'text'], kind: 'message' }], reason: 'A scene reader displays these strings.' }],
  validation: { roundtrip: 'passed', sample: 'passed', additionalUnits: 2 },
});

async function fixture(t, { receipt = receiptFor(), resolverError, verify = async () => coverageFor(0), withVerifier = true, withResolver = true } = {}) {
  const directory = await mkdtemp(path.join(parent, 'case-'));
  const gameDir = path.join(directory, 'game'), workspaceDir = path.join(directory, 'job');
  await mkdir(gameDir); await mkdir(workspaceDir);
  const state = { status: 'running', attempts: 0, failures: {}, events: [] };
  const calls = { tools: [], receipts: [], verification: [] };
  const lab = {
    runTool: async input => {
      calls.tools.push(input);
      if (input.tool === 'native_review') return { schema: 'pinhao-native-field-review-v1', groups: [{ ...receiptFor().decisions[0], file }], offset: 0, total: 1, nextOffset: null };
      return { nativeReviewReceiptId: receipt.id, addedUnits: 2 };
    },
    ...(withResolver ? { resolveNativeReview: async input => {
      calls.receipts.push(input);
      if (resolverError) throw resolverError;
      return structuredClone(receipt);
    } } : {}),
  };
  const session = adaptationTools({
    project: { id: 'neutral-game', name: 'Neutral game', engine: 'neutral-native' }, inventory: { unitCount: 1 },
    gameDir, workspaceDir, state, lab, assignment: { id: 'carrier-dialogue', files: [file] },
    trustedToolNames: ['native_review', 'native_review_decide'],
    initialExtractions: [accepted], coverage: coverageFor(2),
    ...(withVerifier ? { verifyCoverage: async input => {
      calls.verification.push(input);
      return verify(input);
    } } : {}),
  });
  t.after(async () => {
    await session.flush(); await session.close();
    assert.equal(path.dirname(directory), parent);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
  });
  let groupRef;
  return { session, state, calls, gameDir, workspaceDir, run: async () => {
    groupRef ??= (await session.tools.native_review.execute({})).groups[0].groupRef;
    const { groupId, evidenceHash, ...decision } = receiptFor().decisions[0];
    return session.tools.native_review_decide.execute({ decisions: [{ groupRef, ...decision }] });
  } };
}

test('host native review receipts enter coverage verification and retain accepted text', async t => {
  const f = await fixture(t);
  const output = await f.run();
  assert.equal(output.taskComplete, true);
  assert.equal(output.addedUnits, 2);
  assert.equal(f.calls.receipts.length, 1);
  assert.equal(f.calls.receipts[0].receiptId, 'host-native-review-receipt');
  assert.equal(f.calls.receipts[0].gameDir, f.gameDir);
  assert.equal(f.calls.receipts[0].workDir, f.workspaceDir);
  assert.deepEqual(f.calls.verification[0].nativeReviews, [receiptFor()]);
  assert.deepEqual(f.calls.verification[0].units, accepted.units);
  assert.equal(f.session.result().kind, 'native-review');
  assert.equal(f.session.result().status, 'verified');
  assert.deepEqual(f.session.result().units, accepted.units);
  assert.equal(f.state.status, 'verified');
  assert.equal(f.session.done(), true);
  assert.ok(f.state.progressKeys.some(key => key.startsWith('native-review:')));
});

test('a native review group can commit while remaining groups continue in the same task', async t => {
  let checks = 0;
  const f = await fixture(t, { verify: async () => coverageFor(++checks === 1 ? 1 : 0) });
  const first = await f.run();
  assert.equal(first.taskComplete, false);
  assert.equal(first.remainingCoverage.summary.nativeReviewObjects, 1);
  assert.equal(f.session.result(), undefined);
  assert.equal(f.session.done(), false);
  const second = await f.run();
  assert.equal(second.taskComplete, true);
  assert.equal(f.calls.verification.length, 2);
  assert.deepEqual(f.session.result().units, accepted.units);
});

for (const files of [[], [otherFile], [file, otherFile]]) {
  test(`native review receipt outside the assigned scope is rejected: ${JSON.stringify(files)}`, async t => {
    const f = await fixture(t, { receipt: receiptFor(files) });
    const output = await f.run();
    assert.match(output.error.message, /本资源任务范围/);
    assert.equal(f.calls.verification.length, 0);
    assert.equal(f.session.result(), undefined);
    assert.deepEqual(f.session.partialExtractions()[0].units, accepted.units);
  });
}

test('an unregistered native review receipt cannot reach host coverage acceptance', async t => {
  const f = await fixture(t, { resolverError: new Error('请选择本资源任务通过原生验证的字段决定') });
  const output = await f.run();
  assert.match(output.error.message, /通过原生验证/);
  assert.equal(f.calls.verification.length, 0);
  assert.equal(f.session.result(), undefined);
});

for (const options of [{ withVerifier: false }, { withResolver: false }]) {
  test(`native review requires both host resolution and coverage verification: ${JSON.stringify(options)}`, async t => {
    const f = await fixture(t, options);
    const output = await f.run();
    assert.match(output.error.message, /主机覆盖检查/);
    assert.equal(f.calls.receipts.length, 0);
    assert.equal(f.calls.verification.length, 0);
    assert.equal(f.session.result(), undefined);
  });
}

for (const invalid of [undefined, {}, { needsAdaptation: 'false' }]) {
  test(`native review requires an explicit boolean completion state: ${JSON.stringify(invalid)}`, async t => {
    const f = await fixture(t, { verify: async () => invalid });
    const output = await f.run();
    assert.match(output.error.message, /明确的资源处理状态/);
    assert.equal(f.calls.verification.length, 1);
    assert.equal(f.session.result(), undefined);
    assert.notEqual(f.state.status, 'verified');
  });
}

test('native review discovery exposes only the current resource assignment', async t => {
  const f = await fixture(t);
  const context = await f.session.tools.inspect_context.execute({});
  assert.deepEqual(context.assignment.files, [file]);
  assert.equal(context.coverage.nativeReviewIssues.length, 1);
  assert.equal(context.coverage.nativeReviewIssues[0].file, file);
  const page = await f.session.tools.inspect_coverage.execute({ offset: 0, limit: 1 });
  assert.equal(page.nativeReviewTotal, 1);
  assert.equal(page.nativeReviewIssues[0].count, 2);
  assert.deepEqual(f.calls.verification, []);
});
test('native review summaries retain nested field examples and absolute pagination offsets', () => {
  const output = { schema: 'pinhao-native-field-review-v1', offset: 18, total: 40, nextOffset: 38,
    groups: Array.from({ length: 20 }, (_, index) => ({ groupId: `group-${index}`, fields: [{ path: ['lines', '*', 'caption'],
      examples: [{ object: '@:9', path: ['lines', 0, 'caption'], value: 'A complete neutral sentence.' }] }] })) };
  const page = boundedToolOutput(output);
  assert.equal(page.groups[0].fields[0].examples[0].value, 'A complete neutral sentence.');
  assert.deepEqual(page.groups[0].fields[0].examples[0].path, ['lines', 0, 'caption']);
  assert.equal(page.fieldCursors.groups.offset, 18);
  assert.equal(page.nextOffset, 18 + page.groups.length);
  assert.ok(JSON.stringify(page).length <= 24000);
});
