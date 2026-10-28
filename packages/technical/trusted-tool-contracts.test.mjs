import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';
import { createNativeTools } from '../core/native-tools.mjs';
import { adaptationTools, prepareTrustedToolArgs, runAdaptation } from './adaptation.mjs';

const native = createNativeTools({ worker: async () => { throw new Error('No native operation expected'); } }).trustedTools;
const decisions = Array.from({ length: 24 }, (_, index) => ({ groupId: `neutral-native-group-${index}`,
  evidenceHash: 'a'.repeat(64), disposition: 'non-display', reason: `The host checked the serialized fields for component ${index}; they retain engine state and object identity, not displayed dialogue.` }));

test('native unpack accepts its registered optional format through the Agent surface', () => {
  for (const args of [['data.xp3'], ['data.xp3', 'xp3']]) {
    assert.ok(native.native_unpack.validateArgs(args));
    assert.deepEqual(prepareTrustedToolArgs('native_unpack', args).args, args);
  }
  assert.throws(() => prepareTrustedToolArgs('native_unpack', []), /位置参数/);
});

test('trusted native decisions use their structured batch contract, not a generic argument string ceiling', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-trusted-contract-'));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); });
  const gameDir = path.join(root, 'game'); await mkdir(gameDir);
  const descriptor = native.native_review_decide;
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab'), trustedTools: {
    native_review_decide: { ...descriptor, execute: async ({ args }) => ({ accepted: JSON.parse(args[0]).length }) },
  } });
  const args = [JSON.stringify(decisions)];
  assert.ok(args[0].length > 4096);
  assert.ok(descriptor.validateArgs(args));
  assert.deepEqual(await lab.runTool({ tool: 'native_review_decide', args, gameDir, workDir: path.join(root, 'work') }), { accepted: 24 });
  await assert.rejects(lab.runTool({ tool: 'native_review_decide', args: [JSON.stringify([...decisions, ...decisions, ...decisions])], gameDir, workDir: path.join(root, 'work') }), /可信工具/);
});

test('native field decisions retain the actual Python shape and capacity checks', () => {
  const accepts = value => native.native_review_decide.validateArgs([JSON.stringify(value)]);
  assert.ok(accepts(decisions));
  assert.equal(accepts([{ ...decisions[0], reason: 'x'.repeat(4001) }]), false);
  assert.equal(accepts([{ ...decisions[0], disposition: 'display', fields: [{ path: ['caption'], kind: 'invented' }] }]), false);
  assert.equal(accepts([{ ...decisions[0], disposition: 'display', fields: [{ path: Array(65).fill('caption') }] }]), false);
  assert.equal(accepts([{ ...decisions[0], fields: [{ path: ['caption'] }] }]), false);
});

test('trusted names are exact catalog values and a quoted name produces shareable name feedback, not parameter advice', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-tool-names-'));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); });
  const names = ['native_extract', 'native_inspect'], calls = [], lessons = [];
  const session = adaptationTools({ project: { id: 'neutral', engine: 'Unity' }, inventory: {},
    gameDir: root, workspaceDir: path.join(root, 'work'), trustedToolNames: names,
    state: { status: 'running', failures: {}, events: [] }, onLessons: async facts => lessons.push(...facts),
    lab: { runTool: async input => { calls.push(input); return { unitCount: 1 }; } } });
  assert.deepEqual(session.tools.run_tool.inputSchema.jsonSchema.properties.tool.enum, names);
  for (const tool of ['"native_extract"', ' native_extract ', 'Native_Extract', 'unregistered_shell']) {
    const rejected = await session.tools.run_tool.execute({ tool, args: [] });
    assert.equal(rejected.error.code, 'TOOL_NOT_REGISTERED');
    assert.match(rejected.error.message, /native_extract、native_inspect/);
    assert.doesNotMatch(rejected.error.message, /参数被主机校验拒绝/);
  }
  assert.equal(calls.length, 0, 'rejected names neither execute nor gain permissions');
  for (const name of ['"native_extract"', ' native_extract ', 'Native_Extract']) {
    assert.ok(lessons.some(lesson => lesson.kind === 'tool-name' && lesson.subject === JSON.stringify(name)));
  }
  assert.equal(lessons.some(lesson => lesson.subject === 'native_extract'), false, 'a quoted name must not prohibit its registered bare name');
  const recovered = await session.tools.run_tool.execute({ tool: 'native_extract', args: [] });
  assert.equal(recovered.error, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'native_extract');
  await session.close(); await session.flush();
});

test('a model session fetches the actual trusted catalog once for both its tool schema and engine guide', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-tool-catalog-'));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); });
  let catalogReads = 0;
  const result = await runAdaptation({ project: { id: 'neutral', engine: 'Unity' }, inventory: {}, gameDir: root,
    workspaceDir: path.join(root, 'work'), lab: { tryRecipes: async () => null,
      listTools: async () => { catalogReads++; return [{ name: 'native_review' }]; } },
    generate: async ({ tools, instructions }) => {
      assert.equal(tools.run_tool, undefined, 'do not publish a generic tool with no remaining registered choices');
      assert.ok(tools.native_review);
      assert.match(instructions, /Unity 组件字段审阅/);
      assert.doesNotMatch(instructions, /归档与成员：/);
      return { finishReason: 'stop' };
    } });
  assert.equal(result.error, undefined);
  assert.equal(catalogReads, 1);
});

test('typed native calls delegate once through the existing validation, evidence and resource commit path', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-typed-native-'));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); });
  const calls = [], reviews = [], published = [], decision = { ...decisions[0], groupId: `native-review-v1:${'a'.repeat(16)}:${'b'.repeat(24)}` };
  const coverage = { needsAdaptation: true, sourceContextHash: 'source-a', summary: {}, nativeReviewIssues: [{ file: 'a.assets' }] };
  const session = adaptationTools({ project: { id: 'neutral', engine: 'Unity' }, inventory: {}, gameDir: root,
    workspaceDir: path.join(root, 'work'), state: { status: 'running', failures: {}, events: [] }, coverage,
    assignment: { id: 'neutral', files: ['a.assets'] }, trustedToolNames: ['native_review', 'native_review_decide', 'native_probe'],
    onLessons: async facts => published.push(...facts), verifyCoverage: async input => { reviews.push(input); return { ...coverage, nativeReviewIssues: [], needsAdaptation: false }; },
    lab: { listTools: () => ['native_review', 'native_review_decide', 'native_probe'].map(name => ({ name })), runTool: async input => {
      calls.push(input);
      if (input.tool === 'native_review') return { schema: 'pinhao-native-field-review-v1', offset: 0, total: 1, nextOffset: null,
        groups: [{ ...decision, file: 'a.assets', status: 'no-text', fieldCount: 0, fields: [], objectCount: 3 }] };
      if (!native.native_review_decide.validateArgs(input.args)) throw new Error('请使用已注册的可信工具及参数');
      assert.deepEqual(JSON.parse(input.args[0]), [decision]);
      return { nativeReviewReceiptId: 'neutral-native-receipt', decisions: 1, addedUnits: 0 };
    }, resolveNativeReview: async () => ({ id: 'neutral-native-receipt', files: ['a.assets'], decisions: [decision] }) } });
  assert.deepEqual(session.tools.run_tool.inputSchema.jsonSchema.properties.tool.enum, ['native_probe']);
  for (const name of ['native_review', 'native_review_decide']) {
    const rejected = await session.tools.run_tool.execute({ tool: name, args: [] });
    assert.equal(rejected.error.code, 'DIRECT_NATIVE_TOOL_REQUIRED');
    assert.match(rejected.error.message, /同名结构化工具直接调用/);
    assert.match(rejected.nextAction, new RegExp(`${name}\\(\\{`));
  }
  assert.equal(calls.length, 0, 'the duplicate generic routes never reach a native worker');
  const context = await session.tools.inspect_context.execute({});
  assert.ok(context.tools.trusted.filter(item => item.name !== 'native_probe').every(item => item.interface === 'direct'));
  const read = await session.tools.native_review.execute({ file: 'a.assets', offset: 0, limit: 12 });
  assert.equal(read.error, undefined);
  assert.deepEqual(calls[0].args, ['--file', 'a.assets', '--offset', '0', '--limit', '12']);
  assert.equal(read.groups[0].groupId, undefined); assert.equal(read.groups[0].evidenceHash, undefined);
  const { groupId: canonicalGroup, evidenceHash: canonicalHash, ...meaning } = decision;
  const modelDecision = { groupRef: read.groups[0].groupRef, ...meaning };
  assert.equal(session.done(), false, 'a pending no-text group still requires its non-display decision');
  const malformed = await session.tools.native_review_decide.execute({ decisions: JSON.stringify([decision]) });
  assert.equal(malformed.error.code, 'TOOL_ARGS_REJECTED');
  assert.equal(reviews.length, 0, 'a double-encoded decision never gains a receipt or commits coverage');
  const accepted = await Promise.race([session.tools.native_review_decide.execute({ decisions: [modelDecision] }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Typed delegate mutation barrier deadlocked')), 1000).unref())]);
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.taskComplete, true);
  assert.ok(accepted.evidenceId);
  assert.equal(reviews[0].nativeReviews[0].id, 'neutral-native-receipt');
  assert.equal(session.result().status, 'verified');
  assert.ok(published.some(lesson => lesson.kind === 'class-no-text'));
  assert.equal(session.result().units.length, 0);
  await session.close(); await session.flush();
});

test('typed native interfaces are exposed only for those exact registered capabilities', async () => {
  for (const names of [[], ['native_review'], ['native_review_decide'], ['native_probe']]) {
    const session = adaptationTools({ project: { id: 'neutral' }, inventory: {}, gameDir: 'unused', workspaceDir: 'unused',
      state: { status: 'running', failures: {}, events: [] }, lab: {}, trustedToolNames: names });
    assert.equal(Boolean(session.tools.native_review), names.includes('native_review'));
    assert.equal(Boolean(session.tools.native_review_decide), names.includes('native_review_decide'));
    assert.equal(Boolean(session.tools.run_tool), names.some(name => !['native_review', 'native_review_decide'].includes(name)));
    if (session.tools.native_review_decide) {
      const item = session.tools.native_review_decide.inputSchema.jsonSchema.properties.decisions;
      assert.equal(item.type, 'array');
      assert.equal(item.maxItems, 50);
      assert.equal(item.items.type, 'object');
      assert.equal(item.items.properties.fields.items.properties.path.items.anyOf.length, 2);
      const sites = item.items.properties.fields.items.properties.displaySites;
      assert.equal(sites.type, 'array');
      assert.equal(sites.maxItems, 128);
      assert.equal(sites.uniqueItems, true);
      assert.equal(sites.items.pattern, '^s[1-9][0-9]*$');
      assert.equal(item.items.properties.groupId, undefined);
      assert.equal(item.items.properties.evidenceHash, undefined);
    }
    await session.close(); await session.flush();
  }
});

test('typed native review binds its default resource and rejects diagnostic or script identities before execution', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-native-identities-'));
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); });
  const calls = [], lessons = [], groupId = `native-review-v1:${'a'.repeat(16)}:${'b'.repeat(24)}`;
  const coverage = { nativeReviewIssues: [{ id: 'native-review-diagnostic', group: '["Neutral.dll","","Caption"]', file: 'Game_Data/level24' }] };
  const original = structuredClone(coverage);
  const session = adaptationTools({ project: { id: 'neutral', engine: 'Unity' }, inventory: {}, coverage,
    gameDir: root, workspaceDir: path.join(root, 'work'), assignment: { id: 'resource', files: ['Game_Data/level24'] },
    state: { status: 'running', failures: {}, events: [] }, trustedToolNames: ['native_review', 'native_review_decide'],
    onLessons: async facts => lessons.push(...facts), lab: { runTool: async input => { calls.push(input); return { schema: 'pinhao-native-field-review-v1',
      groups: [{ groupId, evidenceHash: 'c'.repeat(64), file: 'Game_Data/related.assets', fields: [] }] }; } } });
  const context = await session.tools.inspect_context.execute({});
  const page = await session.tools.inspect_coverage.execute({});
  for (const issue of [context.coverage.nativeReviewIssues[0], page.nativeReviewIssues[0]]) {
    assert.equal(issue.diagnosticId, 'native-review-diagnostic');
    assert.equal(issue.scriptIdentity, '["Neutral.dll","","Caption"]');
    assert.equal(issue.id, undefined); assert.equal(issue.group, undefined);
  }
  assert.deepEqual(coverage, original, 'model labels do not mutate the host coverage schema');
  for (const invalid of ['native-review-diagnostic', '["Neutral.dll","","Caption"]', 'Neutral.dll', 'native-review-v1:not-a-real-id']) {
    const result = await session.tools.native_review.execute({ groupRef: invalid });
    assert.equal(result.error.code, 'NATIVE_REVIEW_PROTOCOL');
    assert.match(result.nextAction, /groups\[\]\.groupRef/);
    assert.doesNotMatch(result.error.message + result.nextAction, /--group|--file/);
  }
  assert.equal(calls.length, 0);
  assert.ok(lessons.some(lesson => lesson.subject === 'native-review-decisions'));
  assert.equal(session.tools.native_review.inputSchema.jsonSchema.properties.groupRef.pattern, '^g[1-9][0-9]*$');
  const read = await session.tools.native_review.execute({});
  assert.deepEqual(calls[0].args, ['--file', 'Game_Data/level24']);
  await session.tools.native_review.execute({ groupRef: read.groups[0].groupRef });
  assert.deepEqual(calls[1].args, ['--file', 'Game_Data/related.assets', '--group', groupId], 'related resource reads remain available');
  const rejected = await session.tools.native_review_decide.execute({ decisions: [{ groupRef: 'native-review-diagnostic', disposition: 'non-display', reason: 'Not an observed reference.' }] });
  assert.equal(rejected.error.code, 'NATIVE_REVIEW_PROTOCOL');
  assert.equal(calls.length, 2, 'invalid decisions cannot obtain a native receipt');
  await session.close(); await session.flush();
});

test('typed native errors retain structured recovery instructions rather than exposing CLI parameters', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-native-typed-errors-'));
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); });
  const groupId = `native-review-v1:${'a'.repeat(16)}:${'b'.repeat(24)}`;
  let code = 'NATIVE_REVIEW_GROUP_MISSING', count = 0;
  const session = adaptationTools({ project: { id: 'neutral', engine: 'Unity' }, inventory: {}, gameDir: root,
    workspaceDir: path.join(root, 'work'), assignment: { id: 'resource', files: ['Game_Data/level24'] },
    state: { status: 'running', failures: {}, events: [] }, trustedToolNames: ['native_review', 'native_review_decide'],
    lab: { runTool: async () => { count++; throw Object.assign(new Error(code ? 'Native review group does not exist' : '请使用已注册的可信工具及参数'), { code }); } } });
  const missing = await session.tools.native_review.execute({});
  assert.equal(missing.error.code, 'NATIVE_REVIEW_PROTOCOL');
  assert.match(missing.nextAction, /groups\[\]\.groupRef/);
  assert.equal(missing.error.evidence.cause.code, 'NATIVE_REVIEW_GROUP_MISSING');
  code = undefined;
  const rejected = await session.tools.native_review.execute({ file: 'native_review{file:"Game_Data/level24"}' });
  assert.equal(rejected.error.code, 'TOOL_ARGS_REJECTED');
  assert.match(rejected.nextAction, /native_review\(\{/);
  assert.doesNotMatch(rejected.error.message + rejected.nextAction, /--file|--group|允许的参数是/);
  const encoded = await session.tools.native_review_decide.execute({ decisions: JSON.stringify([decisions[0]]) });
  assert.equal(encoded.error.code, 'TOOL_ARGS_REJECTED');
  assert.match(encoded.nextAction, /decisions/);
  assert.doesNotMatch(encoded.error.message + encoded.nextAction, /位置参数|JSON参数|--file/);
  assert.equal(count, 2);
  await session.close(); await session.flush();
});

test('typed decision feedback identifies duplicate groups, non-display fields and the exact invalid identity', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-native-decision-feedback-'));
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); });
  const groupId = `native-review-v1:${'a'.repeat(16)}:${'b'.repeat(24)}`;
  const first = { groupRef: 'g1', disposition: 'non-display', reason: 'Internal identifier.' };
  let calls = 0;
  const session = adaptationTools({ project: { id: 'neutral', engine: 'Unity' }, inventory: {}, gameDir: root,
    workspaceDir: path.join(root, 'work'), state: { status: 'running', failures: {}, events: [] },
    trustedToolNames: ['native_review', 'native_review_decide'], lab: { runTool: async input => {
      if (input.tool === 'native_review') return { schema: 'pinhao-native-field-review-v1', groups: [{ groupId, evidenceHash: 'c'.repeat(64), fields: [] }] };
      calls++;
      throw Object.assign(new Error('Host decision contract rejected the submitted record.'), { code: 'TOOL_ARGS_REJECTED' });
    } } });
  assert.equal((await session.tools.native_review.execute({})).groups[0].groupRef, first.groupRef);
  const duplicate = await session.tools.native_review_decide.execute({ decisions: [first,
    { ...first, disposition: 'display', fields: [{ path: ['caption'], kind: 'ui_text' }] }] });
  assert.equal(duplicate.error.code, 'TOOL_ARGS_REJECTED');
  assert.match(duplicate.error.message, /同一groupRef只能有一条决定/);
  assert.match(duplicate.nextAction, /同一条display决定的fields/);
  assert.equal(duplicate.error.evidence.issues[0].path, 'decisions[1].groupRef');
  assert.equal(duplicate.error.evidence.issues[0].groupRef, first.groupRef);
  assert.equal(duplicate.error.evidence.issues[0].firstIndex, 0);
  assert.equal(duplicate.error.evidence.cause.message, 'Host decision contract rejected the submitted record.');
  const nonDisplay = await session.tools.native_review_decide.execute({ decisions: [{ ...first, fields: [{ path: ['caption'] }] }] });
  assert.equal(nonDisplay.error.code, 'TOOL_ARGS_REJECTED');
  assert.equal(nonDisplay.error.evidence.issues[0].path, 'decisions[0].fields');
  assert.match(nonDisplay.error.message, /non-display决定不能包含显示fields/);
  assert.equal(calls, 2, 'both invalid batches still reach and respect the existing host validator');
  const invalid = await session.tools.native_review_decide.execute({ decisions: [{ ...first, groupRef: 'native-review-diagnostic' }] });
  assert.equal(invalid.error.code, 'NATIVE_REVIEW_PROTOCOL');
  assert.equal(invalid.error.evidence.issues[0].path, 'decisions[0].groupRef');
  assert.equal(invalid.error.evidence.issues[0].received, 'native-review-diagnostic');
  assert.match(invalid.nextAction, /groups\[\]\.groupRef/);
  assert.equal(calls, 2, 'a diagnostic identity is rejected before reaching the native worker');
  assert.equal(session.done(), false, 'invalid feedback never grants a native receipt or accepts coverage');
  await session.close(); await session.flush();
});

test('file-versus-directory tool errors retain resource facts and the host recovery instruction', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-native-file-facts-'));
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); });
  const resource = { kind: 'file', relativePath: 'Game_Data/level0', parent: 'Game_Data', size: 700 };
  const nextAction = '当前路径是文件；原生二进制资源用native_review，列同级需指定parent，不自动扫描父目录。';
  const session = adaptationTools({ project: { id: 'neutral', engine: 'Unity' }, inventory: {}, gameDir: root,
    workspaceDir: path.join(root, 'work'), state: { status: 'running', failures: {}, events: [] },
    lab: { inspectFiles: async () => { throw Object.assign(new Error('The requested directory is a file.'), { code: 'ENOTDIR', resource, nextAction }); } } });
  const result = await session.tools.list_files.execute({ relativePath: 'Game_Data/level0' });
  assert.equal(result.error.code, 'ENOTDIR');
  assert.deepEqual(result.error.resource, resource);
  assert.equal(result.nextAction, nextAction);
  assert.ok(result.evidenceId, 'the actual failure remains traceable to retained host evidence');
  await session.close(); await session.flush();
});
