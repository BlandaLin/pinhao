import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createAdaptationBudget } from '../../core/adaptation-budget.mjs';
import { createDisplayVerifier, createRequestRecordReader, DISPLAY_REVIEW_PROTOCOL } from './display-review.mjs';

const connection = { baseUrl: 'http://local-fixture.invalid/v1', model: 'test-model', apiKey: 'private-fixture-key' };
async function fixture(t, count = 2) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-display-review-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }));
  const gameDir = path.join(root, 'game'), workspaceDir = path.join(root, 'review');
  await mkdir(gameDir); await mkdir(workspaceDir);
  await writeFile(path.join(gameDir, 'lines.json'), JSON.stringify({ lines: Array.from({ length: count }, (_, index) => `Welcome ${index}`) }));
  await writeFile(path.join(gameDir, 'main.gd'), 'var data = load_json("lines.json")\nfunc show(i):\n  label.text = data.lines[i]\n');
  return { root, gameDir, workspaceDir, projectId: 'review-project', candidate: { candidateId: 'candidate-test', codeHash: 'test-code', manifest: { engine: 'test-engine' } },
    units: Array.from({ length: count }, (_, index) => ({ id: `unit-${index}`, source: `Welcome ${index}`, locator: { file: 'lines.json', pointer: `/lines/${index}` } })) };
}
async function decide({ tools, prompt }, status = 'display-supported') {
  const source = await tools.read_resource.execute({ file: 'lines.json' });
  const consumer = await tools.read_resource.execute({ file: 'main.gd' });
  const decisions = JSON.parse(prompt).units.map(row => ({ ref: row.ref, status, reason: status === 'display-supported' ? 'The active source is loaded and assigned to label.text.' : 'Purpose remains unproved.', evidenceIds: [source.evidenceId], consumerEvidenceIds: [consumer.evidenceId] }));
  await tools.finish_review.execute({ decisions });
}

test('completed request metadata is read once across cumulative flushes and concurrent checkpoints', async t => {
  const input = await fixture(t, 1), references = [], expected = [];
  for (let index = 0; index < 32; index++) {
    const directory = path.join(input.root, `request-${index}`), id = `request-${index}`;
    await mkdir(directory);
    const status = index % 3 === 0 ? 'failed' : 'received';
    const usage = index % 4 === 0 ? null : { totalTokens: index + 10, cost: index / 10000 };
    await writeFile(path.join(directory, 'result.json'), JSON.stringify({ status, summary: { usage }, error: status === 'failed' ? { category: index === 0 ? 'cancelled' : 'timeout' } : undefined }));
    references.push({ id, directory }); expected.push({ id, directory, status, usage });
  }
  let reads = 0;
  const reader = createRequestRecordReader(async (...args) => { reads++; return readFile(...args); });
  for (let count = 1; count <= references.length; count++) assert.deepEqual(await reader(references.slice(0, count)), expected.slice(0, count));
  assert.equal(reads, 32);
  const parallel = await Promise.all([reader(references), reader(references)]);
  assert.deepEqual(parallel, [expected, expected]); assert.equal(reads, 32);
  assert.equal(expected[0].status, 'failed'); assert.equal(expected[0].usage, null);
  let reopenedReads = 0;
  const reopened = createRequestRecordReader(async (...args) => { reopenedReads++; return readFile(...args); });
  assert.deepEqual(await Promise.all([reopened(references), reopened(references)]), [expected, expected]);
  assert.equal(reopenedReads, 32);
});

test('request metadata keeps directory identity and retries real read and parse failures', async t => {
  const input = await fixture(t, 1), references = [];
  for (const [index, status] of ['received', 'failed'].entries()) {
    const directory = path.join(input.root, `identity-${index}`); await mkdir(directory);
    await writeFile(path.join(directory, 'result.json'), JSON.stringify({ status }));
    references.push({ id: 'same-id', directory });
  }
  let reads = 0;
  const reader = createRequestRecordReader(async (...args) => { reads++; return readFile(...args); });
  assert.deepEqual((await reader(references)).map(row => [row.status, row.usage]), [['received', null], ['failed', null]]);
  assert.equal(reads, 2);
  const directory = path.join(input.root, 'incomplete-request'); await mkdir(directory);
  const missing = { id: 'incomplete-request', directory }, file = path.join(directory, 'result.json');
  await assert.rejects(reader([missing]), error => error.code === 'ENOENT');
  await writeFile(file, '{invalid');
  await assert.rejects(reader([missing]), SyntaxError);
  await writeFile(file, JSON.stringify({ status: 'failed' }));
  assert.deepEqual(await reader([missing]), [{ ...missing, status: 'failed', usage: null }]);
  assert.equal(reads, 5);
});

test('all supplemental units are reviewed independently and stable proof reuses completed batches', async t => {
  const input = await fixture(t, 40); let calls = 0;
  const verify = createDisplayVerifier({ connectionFor: () => connection, projectFor: () => ({ engine: 'test-engine', reason: 'author must not be sent', conversation: 'not reviewer context' }),
    readRootsFor: () => [input.gameDir, path.join(input.gameDir, '.')], generate: async value => {
      calls++; assert.doesNotMatch(value.prompt, /author must|conversation|test-code|candidate-test|unit-0/);
      await decide(value);
    } });
  const first = await verify(input);
  assert.equal(DISPLAY_REVIEW_PROTOCOL, 'pinhao-display-review-7');
  assert.equal(first.protocol, DISPLAY_REVIEW_PROTOCOL); assert.equal(first.status, 'passed');
  assert.equal(first.decisions.length, 40); assert.equal(calls, 2); assert.equal(await verify.isFresh(first, input), true);
  const second = await verify(input);
  assert.equal(calls, 2); assert.equal(second.batches.every(batch => batch.reused), true);
  assert.equal(new Set(first.decisions.map(row => row.id)).size, 40);
});

test('next batch receives actual prior consumer locations but must obtain its own read receipts', async t => {
  const input = await fixture(t, 40); let calls = 0, priorConsumer;
  const consumerBytes = (await readFile(path.join(input.gameDir, 'main.gd'))).length;
  const verify = createDisplayVerifier({ connectionFor: () => connection, generate: async ({ tools, prompt }) => {
    calls++;
    const value = JSON.parse(prompt), source = await tools.read_resource.execute({ file: 'lines.json' });
    if (calls === 1) {
      assert.equal(value.priorReviewNavigation, undefined);
      priorConsumer = await tools.read_resource.execute({ file: 'main.gd' });
      await tools.finish_review.execute({ decisions: value.units.map(row => ({ ref: row.ref, status: 'display-supported',
        reason: 'Actual independent reads.', evidenceIds: [source.receiptId], consumerEvidenceIds: [priorConsumer.receiptId] })) });
    } else {
      assert.equal(value.priorReviewNavigation.length, 1);
      assert.deepEqual(value.priorReviewNavigation[0].nextCall, { tool: 'read_resource', input: { file: 'main.gd', sourceIndex: 0, offset: 0, length: consumerBytes } });
      await assert.rejects(tools.finish_review.execute({ decisions: value.units.map(row => ({ ref: row.ref, status: 'display-supported',
        reason: 'An old receipt is not a new read.', evidenceIds: [source.receiptId], consumerEvidenceIds: [priorConsumer.receiptId] })) }),
      error => error.code === 'DISPLAY_REVIEW_EVIDENCE_REQUIRED');
      const consumer = await tools.read_resource.execute(value.priorReviewNavigation[0].nextCall.input);
      await tools.finish_review.execute({ decisions: value.units.map(row => ({ ref: row.ref, status: 'display-supported',
        reason: 'Current batch read the actual consumer.', evidenceIds: [source.receiptId], consumerEvidenceIds: [consumer.receiptId] })) });
    }
  } });
  assert.equal((await verify(input)).status, 'passed'); assert.equal(calls, 2);
});

test('completed persisted batch guides a fresh remaining batch without replaying its decisions', async t => {
  const input = await fixture(t, 40); let calls = 0;
  const verify = createDisplayVerifier({ connectionFor: () => connection, generate: async value => {
    calls++;
    if (calls === 2) throw new Error('Offline interruption after the first durable batch.');
    if (calls === 3) {
      assert.equal(JSON.parse(value.prompt).units.length, 8);
      assert.equal(JSON.parse(value.prompt).priorReviewNavigation[0].nextCall.input.file, 'main.gd');
    }
    await decide(value);
  } });
  await assert.rejects(verify(input), /Offline interruption/);
  const result = await verify(input);
  assert.equal(result.status, 'passed'); assert.equal(calls, 3);
  assert.equal(result.batches[0].reused, true);
});

test('producer navigation resolves real origin and hash to the current root and is shared once per batch', async t => {
  const input = await fixture(t, 40), sourceRoot = path.join(input.root, 'original');
  await mkdir(sourceRoot); await writeFile(path.join(sourceRoot, 'loader.gd'), 'enabled = true; show_caption(data)');
  const baselineHash = createHash('sha256').update(await readFile(path.join(sourceRoot, 'loader.gd'))).digest('hex');
  input.producerHints = [{ hints: [{ resourceRef: { originId: 'original', path: 'loader.gd', baselineHash, sourceIndex: 0 },
    slice: { byteStart: 0, byteEnd: 20 }, note: 'Investigation read, not a display verdict.' }] }];
  let calls = 0;
  const verify = createDisplayVerifier({ connectionFor: () => connection, readRootsFor: () => [sourceRoot],
    sourceOriginFor: ({ sourceIndex }) => sourceIndex === 1 ? 'original' : 'working', generate: async value => {
      calls++; const prompt = JSON.parse(value.prompt);
      assert.equal(prompt.producerHints.length, 1);
      assert.equal(prompt.units.some(row => row.producerHints), false);
      assert.deepEqual(prompt.producerHints[0].nextCall, { tool: 'read_resource', input: { file: 'loader.gd', sourceIndex: 1, offset: 0, length: 20 } });
      assert.doesNotMatch(JSON.stringify(prompt.producerHints), /baselineHash|originId|receiptRef/);
      await decide(value);
    } });
  assert.equal((await verify(input)).status, 'passed'); assert.equal(calls, 2);
  await writeFile(path.join(sourceRoot, 'loader.gd'), 'changed');
  input.candidate = { ...input.candidate, candidateId: 'other', codeHash: 'other' };
  const stale = createDisplayVerifier({ connectionFor: () => connection, readRootsFor: () => [sourceRoot],
    sourceOriginFor: ({ sourceIndex }) => sourceIndex === 1 ? 'original' : 'working', generate: async value => {
      const hint = JSON.parse(value.prompt).producerHints[0];
      assert.equal(hint.navigationUnavailable, true); assert.equal(hint.nextCall, undefined);
      assert.equal(hint.resourceRef.sourceIndex, undefined);
      await decide(value);
    } });
  assert.equal((await stale(input)).status, 'passed');
});

test('restored checkpoint navigation is included in actual continuation messages, not just prompt metadata', async t => {
  const input = await fixture(t, 1); let calls = 0;
  const verify = createDisplayVerifier({ connectionFor: () => connection, generate: async value => {
    calls++;
    if (calls === 1) {
      await value.tools.read_resource.execute({ file: 'main.gd' });
      await value.onStepEnd({ response: { messages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'read-1', toolName: 'read_resource', input: { file: 'main.gd' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'read-1', toolName: 'read_resource', output: {} }] }] } });
      throw new Error('Pause with completed reads.');
    }
    const navigation = value.messages.filter(message => message.role === 'user').map(message => JSON.parse(message.content)).find(message => message.priorReviewNavigation);
    assert.equal(navigation.priorReviewNavigation[0].nextCall.input.file, 'main.gd');
    await decide(value);
  } });
  await assert.rejects(verify(input), /Pause with completed reads/);
  assert.equal((await verify(input)).status, 'passed'); assert.equal(calls, 2);
});

test('consumer changes, model changes, source changes and deleted dependencies invalidate proof', async t => {
  const input = await fixture(t); let calls = 0, model = connection.model;
  const verify = createDisplayVerifier({ connectionFor: () => ({ ...connection, model }), generate: async value => { calls++; await decide(value); } });
  let result = await verify(input);
  await writeFile(path.join(input.gameDir, 'main.gd'), 'label.text = "different source"\n');
  assert.equal(await verify.isFresh(result, input), false); result = await verify(input); assert.equal(calls, 2);
  model = 'other-model'; assert.equal(await verify.isFresh(result, input), false); result = await verify(input); assert.equal(calls, 3);
  assert.equal(await verify.isFresh({ ...result, protocol: 'pinhao-display-review-2' }, input), false);
  assert.equal(await verify.isFresh({ ...result, protocol: 'pinhao-display-review-3' }, input), false);
  assert.equal(await verify.isFresh({ ...result, protocol: 'pinhao-display-review-4' }, input), false);
  assert.equal(await verify.isFresh({ ...result, protocol: 'pinhao-display-review-5' }, input), false);
  await writeFile(path.join(input.gameDir, 'lines.json'), '{"lines":["Changed"]}');
  assert.equal(await verify.isFresh(result, input), false);
  await rm(path.join(input.gameDir, 'main.gd')); assert.equal(await verify.isFresh(result, input), false);
});

test('listing and search dependencies notice newly added potential consumer files', async t => {
  const input = await fixture(t);
  const verify = createDisplayVerifier({ connectionFor: () => connection, generate: async value => {
    assert.deepEqual(value.tools.search_files.inputSchema.jsonSchema.properties.matchMode.enum, ['literal', 'regex']);
    await value.tools.list_files.execute({}); await value.tools.search_files.execute({ query: 'label', content: true }); await decide(value);
  } });
  const result = await verify(input); assert.equal(await verify.isFresh(result, input), true);
  await writeFile(path.join(input.gameDir, 'plugin.gd'), 'label.text = str(other_data)\n');
  assert.equal(await verify.isFresh(result, input), false);
});

test('resource routes filter discovery without deciding display use or limiting direct reads', async t => {
  const input = await fixture(t, 1);
  await writeFile(path.join(input.gameDir, 'music.ogg'), 'media-fixture');
  const routes = ['text', 'script', 'container', 'image', 'media', 'font', 'binary', 'unknown'];
  const verify = createDisplayVerifier({ connectionFor: () => connection, generate: async value => {
    for (const name of ['list_files', 'search_files']) assert.deepEqual(value.tools[name].inputSchema.jsonSchema.properties.route.enum, routes);
    const scripts = await value.tools.list_files.execute({ route: 'script' });
    assert.equal(scripts.route, 'script');
    assert.deepEqual(scripts.files.map(row => row.path), ['main.gd']);
    assert.equal(scripts.files[0].route, 'script');
    const first = await value.tools.search_files.execute({ query: 'label', content: true, route: 'script' });
    const repeated = await value.tools.search_files.execute({ query: 'label', content: true, route: 'script' });
    assert.equal(first.route, 'script'); assert.equal(repeated.route, 'script');
    assert.equal(repeated.resultRepeated, true);
    const other = await value.tools.search_files.execute({ query: 'label', content: true, route: 'binary' });
    assert.equal(other.route, 'binary'); assert.equal(other.resultRepeated, undefined);
    assert.equal(other.items.length, 0);
    await decide(value);
  } });
  const result = await verify(input);
  assert.equal(result.status, 'passed');
  assert.ok(result.dependencies.some(row => row.kind === 'list' && row.input.route === 'script'));
  assert.equal(result.dependencies.some(row => row.kind === 'read' && row.file === 'lines.json'), true);
  assert.equal(await verify.isFresh(result, input), true);
  await writeFile(path.join(input.gameDir, 'unused.ogg'), 'another-media-fixture');
  assert.equal(await verify.isFresh(result, input), true);
  await writeFile(path.join(input.gameDir, 'new-consumer.gd'), 'label.text = data.lines[0]\n');
  assert.equal(await verify.isFresh(result, input), false);
});

test('consumer search navigates real-style media layout without reading encrypted audio', async t => {
  const input = await fixture(t, 1), results = [];
  await mkdir(path.join(input.gameDir, 'audio')); await mkdir(path.join(input.gameDir, 'js'));
  await Promise.all(Array.from({ length: 140 }, (_, index) => writeFile(path.join(input.gameDir, 'audio', `${String(index).padStart(3, '0')}.rpgmvo`), 'encrypted-media-fixture')));
  await writeFile(path.join(input.gameDir, 'audio', 'sample.ogg_'), 'encrypted-media-fixture');
  await writeFile(path.join(input.gameDir, 'js', 'main.js'), 'Window_SkillList.prototype.drawItem = function() { this.drawItemName(skill); };');
  await writeFile(path.join(input.gameDir, 'js', 'large.txt'), 'x'.repeat(1024 * 1024) + '\nWindow_SkillList suffix');
  const verify = createDisplayVerifier({ connectionFor: () => connection, generate: async value => {
    results.push(await value.tools.search_files.execute({ query: 'main\\.js$', matchMode: 'regex', content: false }));
    results.push(await value.tools.search_files.execute({ query: 'Window_SkillList', relativePath: 'js', content: true }));
    results.push(await value.tools.search_files.execute({ query: 'not-present', relativePath: 'audio', content: true }));
    results.push(await value.tools.search_files.execute({ query: '.', matchMode: 'regex', relativePath: 'audio', content: false }));
    const nextCall = results[3].nextCall;
    assert.equal(nextCall.tool, 'search_files');
    assert.equal(Object.keys(nextCall.input).every(key => key in value.tools.search_files.inputSchema.jsonSchema.properties), true);
    results.push(await value.tools.search_files.execute(nextCall.input));
    const nextRead = results[1].partial[0].nextRead;
    assert.equal(nextRead.tool, 'read_resource'); assert.ok(nextRead.input.length <= 65536);
    assert.equal(Object.keys(nextRead.input).every(key => key in value.tools.read_resource.inputSchema.jsonSchema.properties), true);
    assert.match((await value.tools.read_resource.execute(nextRead.input)).content, /Window_SkillList suffix/);
    await decide(value);
  } });
  const result = await verify(input);
  assert.deepEqual(results[0].items.map(row => row.file), ['js/main.js']); assert.equal(results[0].nextOffset, null);
  assert.equal(results[1].items.some(row => row.file === 'js/main.js' && row.line === 1 && row.snippet.includes('Window_SkillList')), true);
  assert.equal(results[1].partial[0].file, 'js/large.txt'); assert.equal(results[1].partial[0].nextContentOffset, 1024 * 1024);
  assert.equal(results[2].skipped.binary, 40); assert.equal(results[2].nextOffset, 40);
  assert.equal(result.dependencies.filter(row => row.kind === 'read' && row.file.startsWith('audio/')).length, 0);
  assert.equal(results[3].nextOffset, 100); assert.equal(results[4].nextOffset, null);
  assert.equal(new Set([...results[3].items, ...results[4].items].map(row => row.file)).size, 141);
});

test('search explicitly selects its mode and accepts exact files without broadening scope', async t => {
  const input = await fixture(t, 1), results = [];
  await mkdir(path.join(input.gameDir, 'scripts')); await writeFile(path.join(input.gameDir, 'scripts', 'inner.gd'), 'label.text = data.lines[0]\n');
  const verify = createDisplayVerifier({ connectionFor: () => connection, generate: async value => {
    const shallow = await value.tools.list_files.execute({});
    assert.ok(shallow.files.some(row => row.path === 'scripts' && row.kind === 'directory'));
    assert.equal(shallow.files.some(row => row.path === 'scripts/inner.gd'), false);
    assert.ok((await value.tools.list_files.execute({ recursive: true })).files.some(row => row.path === 'scripts/inner.gd'));
    await assert.rejects(value.tools.search_files.execute({ query: 'label' }), /content|模式/);
    results.push(await value.tools.search_files.execute({ query: 'label', content: true, relativePath: 'main.gd' }));
    results.push(await value.tools.search_files.execute({ query: 'label', content: true, relativePath: 'main.gd' }));
    assert.equal((await value.tools.search_files.execute({ query: 'label', content: true, relativePath: 'main.gd', limit: 2 })).resultRepeated, undefined);
    const literal = await value.tools.search_files.execute({ query: '[i]', content: true, relativePath: 'main.gd' });
    const regex = await value.tools.search_files.execute({ query: '[i]', matchMode: 'regex', content: true, relativePath: 'main.gd' });
    assert.equal(literal.matchMode, 'literal'); assert.equal(regex.matchMode, 'regex');
    assert.equal(literal.items.length, 1); assert.ok(regex.items.length > literal.items.length);
    const paths = await value.tools.search_files.execute({ query: 'main', content: false, relativePath: 'main.gd' });
    assert.equal(paths.content, false); assert.equal(paths.mode, 'path');
    await decide(value);
  } });
  const result = await verify(input);
  assert.equal(result.status, 'passed');
  assert.equal(results[0].content, true); assert.equal(results[0].relativePath, 'main.gd');
  assert.equal(results[0].items.every(row => row.file === 'main.gd'), true);
  assert.ok(results[0].items.some(row => row.line === 3));
  assert.equal(results[1].resultRepeated, true); assert.equal(results[1].evidenceId, results[0].evidenceId);
  assert.match(results[1].notice, /相同|复用/);
});

test('finish errors identify search receipts and offer existing reads instead of accepting weaker evidence', async t => {
  const input = await fixture(t, 1), other = path.join(input.root, 'other'); await mkdir(other);
  await writeFile(path.join(other, 'lookup.gd'), 'label.text = other.lines[0]\n'.repeat(100));
  const verify = createDisplayVerifier({ connectionFor: () => connection, readRootsFor: () => [other], generate: async ({ tools }) => {
    const source = await tools.read_resource.execute({ file: 'lines.json' });
    const consumer = await tools.read_resource.execute({ file: 'main.gd' });
    const search = await tools.search_files.execute({ query: 'label', content: true, relativePath: 'main.gd' });
    await assert.rejects(tools.finish_review.execute({ decisions: [{ ref: '1', status: 'display-supported', reason: 'Actual consumers were investigated.',
      evidenceIds: [source.evidenceId, search.evidenceId], consumerEvidenceIds: [consumer.evidenceId] }] }), error => {
      assert.equal(error.code, 'DISPLAY_REVIEW_EVIDENCE_REQUIRED');
      assert.equal(error.details.invalidEvidence[0].type, 'search_files');
      assert.equal(error.details.invalidEvidence[0].files.includes('main.gd'), true);
      assert.equal(error.details.availableReads.some(row => row.evidenceId === consumer.evidenceId && row.file === 'main.gd'), true);
      assert.deepEqual(error.details.readCalls, []);
      assert.match(error.message, /read_resource/);
      return true;
    });
    const auxiliary = await tools.search_files.execute({ query: 'label', content: true, relativePath: 'lookup.gd', sourceIndex: 1 });
    assert.equal(auxiliary.items.length, 100);
    await assert.rejects(tools.finish_review.execute({ decisions: [{ ref: '1', status: 'display-supported', reason: 'A search hit is not a consumer read.',
      evidenceIds: [source.evidenceId], consumerEvidenceIds: [auxiliary.evidenceId] }] }), error => {
      assert.deepEqual(error.details.readCalls, [{ tool: 'read_resource', input: { file: 'lookup.gd', sourceIndex: 1 } }]);
      assert.deepEqual(error.details.invalidEvidence[0].locations, [{ file: 'lookup.gd', sourceIndex: 1 }]);
      return true;
    });
    await tools.finish_review.execute({ decisions: [{ ref: '1', status: 'display-supported', reason: 'Use actual source and consumer receipts.',
      evidenceIds: [source.evidenceId], consumerEvidenceIds: [consumer.evidenceId] }] });
  } });
  assert.equal((await verify(input)).status, 'passed');
});

test('identical dependencies collapse but changed hashes never replace earlier reads', async t => {
  const input = await fixture(t, 1);
  const verify = createDisplayVerifier({ connectionFor: () => connection, generate: async value => {
    await value.tools.list_files.execute({}); await value.tools.list_files.execute({});
    await value.tools.read_resource.execute({ file: 'main.gd' });
    await value.tools.read_resource.execute({ file: 'main.gd', offset: 5, length: 10 });
    await decide(value);
  } });
  const result = await verify(input);
  assert.equal(result.dependencies.filter(row => row.kind === 'list').length, 1);
  assert.equal(result.dependencies.filter(row => row.kind === 'read' && row.file === 'main.gd').length, 1);
  const changed = await fixture(t, 1);
  const unstable = createDisplayVerifier({ connectionFor: () => connection, generate: async value => {
    await value.tools.read_resource.execute({ file: 'main.gd' });
    await writeFile(path.join(changed.gameDir, 'main.gd'), 'label.text = data.lines[0] // changed\n');
    await decide(value);
  } });
  await assert.rejects(unstable(changed), /来源或消费者发生变化/);
});

test('real missing-status finish shape is rejected before persistence and corrected verdicts remain reusable', async t => {
  const input = await fixture(t, 32); let calls = 0;
  const verify = createDisplayVerifier({ connectionFor: () => connection, generate: async ({ tools, prompt }) => {
    calls++;
    const source = await tools.read_resource.execute({ file: 'lines.json' });
    const consumer = await tools.read_resource.execute({ file: 'main.gd' });
    const missing = JSON.parse(prompt).units.map(row => ({ ref: row.ref, reason: 'Actual source and display consumer read.', evidenceIds: [source.evidenceId], consumerEvidenceIds: [consumer.evidenceId] }));
    await assert.rejects(tools.finish_review.execute({ decisions: missing }), error => error.code === 'DISPLAY_REVIEW_DECISION_CONTRACT' && /decisions\[0\]\.status/.test(error.message));
    const valid = missing.map(row => ({ ...row, status: 'display-supported' }));
    for (const [field, value] of [['ref', 1], ['status', 'unknown'], ['reason', null], ['evidenceIds', source.evidenceId], ['consumerEvidenceIds', [1]]]) {
      await assert.rejects(tools.finish_review.execute({ decisions: [{ ...valid[0], [field]: value }, ...valid.slice(1)] }), error => error.code === 'DISPLAY_REVIEW_DECISION_CONTRACT' && error.message.includes(`decisions[0].${field}`));
    }
    await assert.rejects(tools.finish_review.execute({ decisions: {} }), /decisions.*数组/);
    await assert.rejects(tools.finish_review.execute({ decisions: [null] }), /decisions\[0\].*对象/);
    await tools.finish_review.execute({ decisions: valid });
  } });
  const result = await verify(input); assert.equal(result.status, 'passed'); assert.equal(calls, 1);
  assert.equal((await verify(input)).status, 'passed'); assert.equal(calls, 1);
  const malformed = { ...result, decisions: result.decisions.map(({ status, ...row }) => row) };
  assert.equal(await verify.isFresh(malformed, input), false);
  const directory = path.join(input.workspaceDir, 'display-review'), recordFile = (await readdir(directory)).find(file => file.endsWith('.json') && !file.endsWith('.checkpoint.json'));
  const saved = JSON.parse(await readFile(path.join(directory, recordFile), 'utf8'));
  saved.status = 'pending'; saved.decisions = saved.decisions.map(({ status, ...row }) => row);
  await writeFile(path.join(directory, recordFile), JSON.stringify(saved));
  assert.equal((await verify(input)).status, 'passed'); assert.equal(calls, 2, 'malformed pending decisions are not silently resolved');
});

test('display needs actual exact-root source reads and real consumer evidence, not a reason', async t => {
  const input = await fixture(t, 1), other = path.join(input.root, 'other'); await mkdir(other);
  await writeFile(path.join(other, 'lines.json'), 'same filename, unrelated source');
  const verify = createDisplayVerifier({ connectionFor: () => connection, readRootsFor: () => [other], generate: async ({ tools }) => {
    const source = await tools.read_resource.execute({ file: 'lines.json', sourceIndex: 1 });
    const consumer = await tools.read_resource.execute({ file: 'main.gd', sourceIndex: 0 });
    await assert.rejects(tools.finish_review.execute({ decisions: [{ ref: '1', status: 'display-supported', reason: 'The author says safe.', evidenceIds: [source.evidenceId], consumerEvidenceIds: [consumer.evidenceId] }] }), /实际读取来源/);
  } });
  assert.equal((await verify(input)).status, 'pending');
});

test('all unit refs must be unique and complete; unresolved and non-display do not pass', async t => {
  const input = await fixture(t);
  const verify = createDisplayVerifier({ connectionFor: () => connection, generate: async value => {
    await assert.rejects(value.tools.finish_review.execute({ decisions: [] }), /全部ref/);
    await assert.rejects(value.tools.finish_review.execute({ decisions: [{ ref: '1', status: 'display-supported', reason: 'Unsupported assertion', evidenceIds: ['evidence-fake'], consumerEvidenceIds: [] }] }), /实际返回/);
    await decide(value, 'unresolved');
  } });
  const result = await verify(input); assert.equal(result.status, 'pending'); assert.equal(result.decisions.length, 2);
  assert.equal(await verify.isFresh(result, input), false);
  const negative = createDisplayVerifier({ connectionFor: () => ({ ...connection, model: 'negative' }), generate: value => decide(value, 'non-display') });
  assert.equal((await negative(input)).status, 'failed');
});

test('pending review resumes only unresolved units and preserves completed decisions', async t => {
  const input = await fixture(t); let calls = 0;
  const verify = createDisplayVerifier({ connectionFor: () => connection, generate: async value => {
    calls++;
    const rows = JSON.parse(value.prompt).units;
    assert.equal(rows.length, calls === 1 ? 2 : 1);
    if (calls > 1) assert.equal(rows[0].ref, '2');
    const source = await value.tools.read_resource.execute({ file: 'lines.json' });
    const consumer = await value.tools.read_resource.execute({ file: 'main.gd' });
    await value.tools.finish_review.execute({ decisions: rows.map(row => ({ ref: row.ref,
      status: calls === 1 && row.ref === '2' ? 'unresolved' : 'display-supported', reason: 'Actual consumer checked for this unit.',
      evidenceIds: [source.evidenceId], consumerEvidenceIds: [consumer.evidenceId] })) });
  } });
  assert.equal((await verify(input)).status, 'pending');
  const resumed = await verify(input);
  assert.equal(resumed.status, 'passed'); assert.equal(calls, 2);
  assert.deepEqual(resumed.decisions.map(row => [row.id, row.status]), [['unit-0', 'display-supported'], ['unit-1', 'display-supported']]);
  assert.equal((await verify(input)).status, 'passed'); assert.equal(calls, 2);
});

test('snapshot reader rejects old slices paired with a new whole-file hash and mid-confirmation changes', async () => {
  const { readDisplaySnapshot } = await import('./display-review.mjs');
  let count = 0;
  const old = { file: 'main.gd', content: 'old', totalBytes: 3, returnedBytes: 3, nextOffset: null };
  const updated = { ...old, content: 'new' };
  await assert.rejects(readDisplaySnapshot(['fixture-root'], 'main.gd', {}, {
    readSlice: async () => ++count === 1 ? old : updated, hashFile: async () => 'new-file-hash',
  }), /读取期间|快照/);
  count = 0;
  await assert.rejects(readDisplaySnapshot(['fixture-root'], 'main.gd', {}, {
    readSlice: async () => old, hashFile: async () => ++count === 1 ? 'before' : 'after',
  }), /读取期间|快照/);
  const stable = await readDisplaySnapshot(['fixture-root'], 'main.gd', {}, { readSlice: async () => updated, hashFile: async () => 'stable' });
  assert.equal(stable.digest, 'stable'); assert.equal(stable.data.content, 'new'); assert.equal(stable.sourceIndex, 0);
});

test('completed batches survive interruption without re-buying them; private source paths stay excluded', async t => {
  const input = await fixture(t, 40), controller = new AbortController(); let calls = 0;
  await mkdir(path.join(input.gameDir, 'save')); await writeFile(path.join(input.gameDir, 'save', 'slot.json'), 'private fixture');
  const verify = createDisplayVerifier({ connectionFor: () => connection, generate: async value => {
    calls++;
    await assert.rejects(value.tools.read_resource.execute({ file: 'save/slot.json' }), /私人/);
    if (calls === 2) { controller.abort(new Error('user paused')); throw controller.signal.reason; }
    await decide(value);
  } });
  await assert.rejects(verify({ ...input, signal: controller.signal }), /user paused/);
  const result = await verify(input);
  assert.equal(calls, 3); assert.equal(result.status, 'passed'); assert.equal(result.batches[0].reused, true);
});

test('real SDK resumes completed tool groups after HTTP cancellation and invalidates changed consumers', async t => {
  for (const changedConsumer of [false, true]) await t.test(changedConsumer ? 'consumer dependency changed' : 'completed source read reused', async t => {
    let server;
    t.after(() => server && new Promise(resolve => server.close(resolve)));
    const input = await fixture(t, 1), controller = new AbortController(), requests = []; let interrupted = false, sourceCalls = 0;
    server = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(body);
      const observed = body.messages.filter(row => row.role === 'tool').map(row => JSON.parse(row.content));
      if (!interrupted && observed.length) {
        interrupted = true; controller.abort(new Error('pause after complete tool group')); res.end('{}'); return;
      }
      const source = observed.find(row => row.file === 'lines.json'), consumer = observed.find(row => row.file === 'main.gd');
      const calls = !source ? [{ name: 'read_resource', arguments: { file: 'lines.json' } }, ...(changedConsumer ? [{ name: 'read_resource', arguments: { file: 'main.gd' } }] : [])]
        : !consumer ? [{ name: 'read_resource', arguments: { file: 'main.gd' } }]
          : [{ name: 'finish_review', arguments: { decisions: [{ ref: '1', status: 'display-supported', reason: 'Actual source and consumer read.', evidenceIds: [source.evidenceId], consumerEvidenceIds: [consumer.evidenceId] }] } }];
      sourceCalls += calls.filter(call => call.name === 'read_resource' && call.arguments.file === 'lines.json').length;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `checkpoint-response-${requests.length}`, object: 'chat.completion', created: 1, model: 'local-checkpoint',
        choices: [{ index: 0, message: { role: 'assistant', content: null, reasoning_content: 'Fixture reasoning is preserved by the SDK.', tool_calls: calls.map((call, index) => ({ id: `checkpoint-call-${requests.length}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const verify = createDisplayVerifier({ connectionFor: () => ({ ...connection, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }) });
    await assert.rejects(verify({ ...input, signal: controller.signal }), /pause after complete tool group/);
    const checkpoints = (await readdir(path.join(input.workspaceDir, 'display-review'))).filter(file => file.endsWith('.checkpoint.json'));
    assert.equal(checkpoints.length, 1);
    const checkpoint = JSON.parse(await readFile(path.join(input.workspaceDir, 'display-review', checkpoints[0]), 'utf8'));
    assert.equal(checkpoint.messages.some(message => message.role === 'tool'), true);
    assert.equal(checkpoint.requests.length, 2); assert.equal(checkpoint.requests.filter(row => row.usage === null).length, 1);
    if (changedConsumer) await writeFile(path.join(input.gameDir, 'main.gd'), 'label.text = data.lines[0] // changed consumer\n');
    const resumeIndex = requests.length, result = await verify(input);
    assert.equal(result.status, 'passed'); assert.equal(sourceCalls, changedConsumer ? 2 : 1);
    assert.equal(requests[resumeIndex].messages.some(message => message.role === 'tool'), !changedConsumer);
    if (!changedConsumer) { assert.equal(result.requests.length, 4); assert.equal(new Set(result.requests.map(row => row.id)).size, 4); }
    assert.equal((await readdir(path.join(input.workspaceDir, 'display-review'))).some(file => file.endsWith('.checkpoint.json')), false);
  });
});

test('complete finish checkpoint restores verdict without another call and incomplete tool groups are not stored', async t => {
  const input = await fixture(t, 1), controller = new AbortController(); let calls = 0;
  const verify = createDisplayVerifier({ connectionFor: () => connection, generate: async value => {
    calls++; await decide(value);
    await value.onStepEnd({ response: { messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'Preserve reasoning metadata.', providerOptions: { fixture: { signature: 'unchanged' } } }, { type: 'tool-call', toolCallId: 'finish-once', toolName: 'finish_review', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'finish-once', toolName: 'finish_review', output: { type: 'json', value: { accepted: true } } }] }] } });
    controller.abort(new Error('pause after finish')); throw controller.signal.reason;
  } });
  await assert.rejects(verify({ ...input, signal: controller.signal }), /pause after finish/);
  const names = await readdir(path.join(input.workspaceDir, 'display-review'));
  const checkpoint = JSON.parse(await readFile(path.join(input.workspaceDir, 'display-review', names.find(file => file.endsWith('.checkpoint.json'))), 'utf8'));
  assert.equal(checkpoint.messages[1].content[0].providerOptions.fixture.signature, 'unchanged');
  assert.equal((await verify(input)).status, 'passed'); assert.equal(calls, 1);
  const half = await fixture(t, 1);
  const incomplete = createDisplayVerifier({ connectionFor: () => connection, generate: async value => {
    await value.onStepEnd({ response: { messages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'half', toolName: 'read_resource', input: { file: 'lines.json' } }] }] } });
    throw new Error('interrupted before tool result');
  } });
  await assert.rejects(incomplete(half), /before tool result/);
  assert.equal((await readdir(path.join(half.workspaceDir, 'display-review'))).some(file => file.endsWith('.checkpoint.json')), false);
});

test('production SDK independently reads consumers and returns host-bound decisions through real local HTTP', async t => {
  let server;
  t.after(() => server && new Promise(resolve => server.close(resolve)));
  const input = await fixture(t, 1), requests = [];
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE project(body TEXT)'); db.prepare('INSERT INTO project VALUES (?)').run(JSON.stringify({ id: input.projectId }));
  const budget = createAdaptationBudget({ readProject: () => JSON.parse(db.prepare('SELECT body FROM project').get().body),
    patchProject: (_id, patch) => db.prepare('UPDATE project SET body=?').run(JSON.stringify({ ...JSON.parse(db.prepare('SELECT body FROM project').get().body), ...patch })),
    transaction: (_id, fn) => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } } });
  const owner = budget.forRequest(input.projectId, 'shared-adaptation', { historyCoverage: 'complete', limits: { maxHttpAttempts: 3, maxWindows: 1 } });
  owner.openWindow({ windowId: 'service-window' });
  input.requestContext = { owner, jobId: 'author-job', windowId: 'service-window', purpose: 'adaptation' };
  server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(body);
    const ordinal = requests.length;
    const observed = body.messages.filter(row => row.role === 'tool').map(row => JSON.parse(row.content));
    const calls = ordinal === 1 ? [{ name: 'read_resource', arguments: { file: 'lines.json' } }]
      : ordinal === 2 ? [{ name: 'read_resource', arguments: { file: 'main.gd' } }]
        : [{ name: 'finish_review', arguments: { decisions: [{ ref: '1', status: 'display-supported', reason: 'Actual JSON source is consumed by label.text in the active loader.', evidenceIds: [observed[0].evidenceId], consumerEvidenceIds: [observed[1].evidenceId] }] } }];
    const message = { role: 'assistant', content: null, tool_calls: calls.map((call, index) => ({ id: `call-${ordinal}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `response-${ordinal}`, object: 'chat.completion', created: 1, model: 'local-sdk', choices: [{ index: 0, message, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const verify = createDisplayVerifier({ connectionFor: () => ({ ...connection, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }) });
  const result = await verify(input);
  assert.equal(result.status, 'passed'); assert.equal(requests.length, 3); assert.equal(result.requests.length, 3);
  assert.equal(result.decisions[0].id, 'unit-0'); assert.equal(result.requests.every(row => row.usage?.totalTokens === 25), true);
  assert.equal(owner.snapshot().httpUsed, requests.length); assert.equal(owner.snapshot().httpSentKnown, 3);
  assert.equal(owner.snapshot().unknownCostAttempts, 3, 'unreported price is not free');
  assert.equal(result.requests.every(row => row.requestContext.adaptationRequestId === 'shared-adaptation' && row.requestContext.jobId === 'author-job' && row.requestContext.purpose === 'display-review'), true);
  assert.equal(requests.every(row => row.messages[0].role === 'system' && row.messages[0].content === requests[0].messages[0].content), true);
  const journal = await readFile(path.join(result.requests[0].directory, 'request.json'), 'utf8'); assert.doesNotMatch(journal, /private-fixture-key/);
  assert.equal((await verify(input)).status, 'passed'); assert.equal(requests.length, 3, 'fresh proof does not reserve or re-buy another HTTP request');
  await writeFile(path.join(input.gameDir, 'main.gd'), 'changed source requires new review');
  await assert.rejects(verify(input), error => error.code === 'ADAPTATION_BUDGET_EXHAUSTED' || error.cause?.code === 'ADAPTATION_BUDGET_EXHAUSTED');
  assert.equal(requests.length, 3, 'nested verifier cannot exceed the author request allowance');
});
