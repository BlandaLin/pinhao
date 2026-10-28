import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { adaptationTools } from './adaptation.mjs';
import { runAdaptationPool } from './adaptation-pool.mjs';
import { distillLessons, lessonsForSource, mergeLessons, renderLessons } from './lessons.mjs';

test('SDK unavailable-name feedback preserves the exact observed name without guessing a replacement', () => {
  const lessons = distillLessons({ error: { code: 'MODEL_TOOL_NOT_AVAILABLE', tool: 'Native_Run_Tool',
    message: "Model tried to call unavailable tool 'Native_Run_Tool'. Available tools: native_review." } });
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].kind, 'tool-name');
  assert.equal(lessons[0].subject, '"Native_Run_Tool"');
  assert.equal(lessons[0].factLevel, 'direct');
  assert.match(lessons[0].fact, /精确工具名未发布/);
  assert.doesNotMatch(lessons[0].fact, /native_review/);
});

test('a received-flags list and a bad value never become a prohibition of valid paging flags', () => {
  const error = { tool: 'native_review', message: 'native_review 的参数被主机校验拒绝（参数名：--offset、--limit）。允许的参数是 --file、--group、--offset、--limit。' };
  const calls = [{ tool: 'native_review', args: ['--offset', '0'], ok: true },
    { tool: 'native_review', args: ['--offset', '0', '--limit', '0'], failed: true, error }];
  const lessons = distillLessons({ error, toolCalls: calls });
  assert.ok(lessons.length);
  assert.ok(lessons.every(lesson => !lesson.fact.includes('不接受')));
  assert.ok(lessons.every(lesson => lesson.factLevel === 'inferred'));
  const explicit = distillLessons({ error: { tool: 'native_review', message: '不认识参数 --id；可用的是 --file、--group、--offset、--limit。' } });
  assert.equal(explicit[0].factLevel, 'direct');
  assert.match(explicit[0].fact, /不接受 id/);
});

test('resource conclusions are scoped to the inspected source while tool protocol facts survive reimport', () => {
  const tool = distillLessons({ error: { code: 'NATIVE_REVIEW_PROTOCOL', message: 'Use native_review_decide for native groups' } })[0];
  assert.match(tool.fact, /groupRef/);
  assert.match(tool.fact, /siteRef/);
  assert.match(tool.fact, /不填写groupId\/evidenceHash/);
  const resource = distillLessons({ outcome: 'verified', classes: [{ name: 'Neutral', file: 'a.assets', fieldCount: 0, objects: 20 }] })[0];
  const list = [tool, { ...resource, evidenceFingerprint: 'source-a' }];
  assert.equal(lessonsForSource(list, 'source-a').length, 2);
  assert.deepEqual(lessonsForSource(list, 'source-b').map(lesson => lesson.id), [tool.id]);
  assert.match(resource.subject, /a.assets/);
});

test('the fixed native protocol projects current references without rewriting saved or unrelated facts', () => {
  const saved = [{ kind: 'tool-arg', subject: 'native-review-decisions', fact: '原生组件组使用 native_review 返回的 groupId/evidenceHash，交给 native_review_decide。', factLevel: 'direct' }];
  const original = structuredClone(saved);
  const current = distillLessons({ error: { code: 'NATIVE_REVIEW_PROTOCOL', message: 'Native groups use observed references' } })[0];
  assert.equal(lessonsForSource(saved)[0].fact, current.fact);
  assert.ok(renderLessons(saved).includes(current.fact));
  assert.doesNotMatch(renderLessons(saved), /返回的 groupId\/evidenceHash/);
  assert.deepEqual(saved, original);
  for (const raw of [{ ...saved[0], kind: 'other' }, { ...saved[0], subject: 'native-review-decisions-other' }]) {
    assert.ok(renderLessons([raw]).includes(raw.fact));
  }
});

test('a full set of structural class facts leaves room and prompt priority for an actual tool correction', () => {
  let lessons = [];
  for (let index = 0; index < 40; index++) {
    const fact = distillLessons({ outcome: 'verified', classes: [{ name: `Component${index}`, file: 'a.assets', fieldCount: 0, objects: 20 }] })[0];
    lessons = mergeLessons(lessons, { ...fact, evidenceFingerprint: 'source-a' }).lessons;
  }
  const correction = distillLessons({ error: { code: 'NATIVE_REVIEW_PROTOCOL', message: 'Native groups have a distinct decision protocol' } })[0];
  lessons = mergeLessons(lessons, correction).lessons;
  assert.equal(lessons.length, 40);
  assert.ok(lessons.some(lesson => lesson.id === correction.id));
  assert.match(renderLessons(lessons).split('\n')[1], /native-review-decisions/);
});

test('long resource subjects never displace the complete shared fact or silently expand its scope', () => {
  const fact = '当前资源中该组已检查1个对象，未发现可提取字符串字段，继续其他组';
  const lessons = Array.from({ length: 40 }, (_, index) => ({ kind: 'class-no-text',
    subject: `Game_Data/level${String(index).padStart(2, '0')}#Assembly-CSharp.dll.Game.UI.Component${index}`, fact,
    factLevel: 'direct', confidence: 0.85, hits: 1 }));
  const original = structuredClone(lessons), output = renderLessons(lessons);
  assert.ok(output.length <= 1200, `Actual shared rendering: ${output.length}`);
  assert.ok(output.includes(fact), 'the complete fact and its final action must remain visible');
  assert.ok(output.includes(lessons[0].subject), 'at least one complete resource-scoped subject remains explicit');
  assert.match(output, /另\d+个主体未展开，不外推其他资源/);
  assert.equal(output.includes('…'), false, 'neither the fact nor a listed subject is cut in half');
  assert.deepEqual(lessons, original, 'rendering does not rewrite the full local records');
});

test('a fact that cannot fit with a complete subject is omitted rather than rendered as a half sentence', () => {
  const lesson = { kind: 'class-no-text', subject: 'Game_Data/level01#Assembly-CSharp.dll.Component',
    fact: '当前资源中该组未发现可提取字符串字段；待审清单中的组仍须提交non-display决定才能结案。' };
  assert.equal(renderLessons([lesson], { maxCharacters: 60 }), '');
});

test('actual tool feedback is checkpointed and shared before a job finishes, including a recovered error', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-lessons-'));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true }); });
  const gameDir = path.join(root, 'game'), workspaceDir = path.join(root, 'work');
  await mkdir(gameDir); await mkdir(workspaceDir);
  const state = { status: 'running', attempts: 0, failures: {}, events: [] }, published = [];
  const coverage = { needsAdaptation: true, sourceContextHash: 'source-a', unknownClusters: [],
    resources: [], dynamicCandidates: [], nativeReviewIssues: [{ file: 'a.assets' }], summary: {} };
  const session = adaptationTools({ project: { id: 'neutral', engine: 'Unity', sourceFingerprint: 'source-a' }, inventory: {},
    gameDir, workspaceDir, state, coverage, onLessons: async facts => published.push(...facts),
    trustedToolNames: ['native_review'],
    lab: { listTools: () => [{ name: 'native_review' }], runTool: async () => ({ schema: 'pinhao-native-field-review-v1',
      offset: 0, total: 1, nextOffset: null, groups: [{ groupId: 'group', file: 'a.assets', script: { className: 'Neutral' },
        status: 'no-text', fieldCount: 0, fields: [], objectCount: 20 }] }) }, verifyCoverage: async () => coverage });
  const rejected = await session.tools.record_coverage_decisions.execute({ decisions: [{ id: 'native-review-v1:group', evidenceHash: 'a'.repeat(64), disposition: 'non-display', reason: 'Neutral host proof' }] });
  assert.equal(rejected.error.code, 'NATIVE_REVIEW_PROTOCOL');
  assert.ok(published.some(lesson => lesson.subject === 'native-review-decisions'));
  const recovered = await session.tools.native_review.execute({});
  assert.equal(recovered.error, undefined);
  assert.ok(state.lessons.some(lesson => lesson.kind === 'class-no-text' && lesson.evidenceFingerprint === 'source-a'));
  assert.ok(state.lessons.some(lesson => lesson.kind === 'prefilter'));
  assert.match((await session.tools.inspect_context.execute({})).operationGuide.version, /engine-operations/);
  await session.close(); await session.flush();
});

test('pool persists learned conclusions and exposes them to other active jobs and a later run', async () => {
  const fact = distillLessons({ error: { code: 'NATIVE_REVIEW_PROTOCOL', message: 'Native groups use their own decision tool' } })[0];
  const released = Promise.withResolvers(), saved = [], observed = [];
  const coverage = { needsAdaptation: true, resources: ['a.assets', 'b.assets'].map(file => ({ file, kind: 'display-text-candidate' })) };
  const jobs = [{ id: 'a', files: ['a.assets'] }, { id: 'b', files: ['b.assets'] }];
  const result = await runAdaptationPool({ jobs, concurrency: 2, workspaceDir: 'unused', coverage,
    project: { sourceFingerprint: 'source-a' }, onLessons: async lessons => saved.push(structuredClone(lessons)),
    run: async input => {
      if (input.assignment.id === 'a') { await input.onLessons([fact]); released.resolve(); }
      else { await released.promise; observed.push(input.getLessons()); }
      return { status: 'verified', state: {} };
    } });
  assert.equal(result.lessons.length, 1);
  assert.equal(saved.at(-1)[0].id, fact.id);
  assert.equal(observed[0][0].id, fact.id);
  await runAdaptationPool({ jobs: [jobs[0]], workspaceDir: 'unused', coverage, lessons: saved.at(-1),
    run: async input => { assert.match(renderLessons(input.getLessons()), /native_review_decide/); assert.equal(input.lessonsText, undefined); return { status: 'verified' }; } });
});
