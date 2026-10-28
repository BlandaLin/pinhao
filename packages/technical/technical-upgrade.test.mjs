import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { adaptationTools, runAdaptation } from './adaptation.mjs';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';
import { createEvidenceStore } from './adaptation/evidence.mjs';
import { boundedToolOutput } from './adaptation/tool-output.mjs';
import { scanCoverage } from './coverage.mjs';
import { planAdaptationJobs } from './adaptation-pool.mjs';
import { createNativeTools } from '../core/native-tools.mjs';
import { productWorker } from '../../apps/desktop/electron/host.mjs';
import { createTechnicalTransport } from './model-transport.mjs';

const code = `({detect(){return true},extract(h){const d=JSON.parse(h.readText('data/story.json'));return {units:d.lines.map((source,i)=>({id:'story:'+i,source,locator:{file:'data/story.json',pointer:'/lines/'+i}}))}},validate(){return {valid:true}},roundtrip(h){h.writeBytes('data/story.json',h.readBytes('data/story.json'));return {}},build(h,i){const d=JSON.parse(h.readText('data/story.json'));for(const u of i.units)if(Object.hasOwn(i.translations,u.id))d.lines[+u.id.split(':')[1]]=i.translations[u.id];h.writeText('data/story.json',JSON.stringify(d));return {}},assemble(){return {}}})`;
const manifest = { schemaVersion: 1, id: 'upgrade-fixture', version: '1.0.0', engine: 'Fixture', scope: { files: ['data/story.json'] }, license: 'MIT', sources: [] };
async function fixture(t) {
  const base = path.resolve('local/technical-upgrade-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'pinhao-upgrade-')), gameDir = path.join(root, 'game');
  await mkdir(path.join(gameDir, 'data'), { recursive: true });
  await writeFile(path.join(gameDir, 'data/story.json'), JSON.stringify({ lines: ['First complete scene.', 'Second complete scene.', 'Last complete scene.'], count: 7 }));
  await writeFile(path.join(gameDir, 'Game.exe'), 'neutral executable marker');
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab') });
  t.after(async () => { assert.equal(path.dirname(root), base); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  return { root, gameDir, lab };
}

test('pages advance by delivered records, deliver whole payloads inside the ceiling and resume past it', () => {
  for (const count of [37, 60]) {
    const seen = [], values = Array.from({ length: count }, (_, id) => ({ id }));
    for (let offset = 0; offset !== null;) {
      const end = Math.min(count, offset + 50);
      const page = boundedToolOutput({ offset, total: count, units: values.slice(offset, end), nextOffset: end < count ? end : null });
      seen.push(...page.units.map(item => item.id)); offset = page.nextOffset;
    }
    assert.deepEqual(seen, values.map(item => item.id));
  }
  // The ceilings are now 500 items and 96KiB per result, so this payload is delivered whole: a page
  // must not paginate work it can carry, and must not invent a cursor.
  const page = boundedToolOutput({ offset: 0, total: 5, dynamicTotal: 37, records: [0, 1, 2, 3, 4], dynamicCandidates: Array.from({ length: 37 }, (_, id) => ({ id })), nextOffset: null });
  assert.equal(page.dynamicCandidates.length, 37);
  assert.equal(page.fieldCursors.records.nextOffset, null);
  assert.equal(page.fieldCursors.dynamicCandidates.nextOffset, null);
  assert.equal(page.nextOffset, null);
  assert.equal(page.checkpointTruncated, undefined, 'a payload inside the ceiling is not reported as truncated');
  // Pagination still engages past the item ceiling: 501 records deliver 500 and resume at 500.
  const wide = Array.from({ length: 501 }, (_, id) => ({ id }));
  const paged = boundedToolOutput({ offset: 0, dynamicTotal: wide.length, dynamicCandidates: wide, nextOffset: null });
  assert.equal(paged.dynamicCandidates.length, 500);
  assert.equal(paged.fieldCursors.dynamicCandidates.nextOffset, 500);
  assert.equal(paged.nextOffset, 500);
  assert.equal(paged.checkpointTruncated, true);
});

test('complete evidence survives reopening and exposes long tails and nested arrays', async t => {
  const f = await fixture(t), content = `${'prefix '.repeat(1000)}final evidence`;
  const saved = await createEvidenceStore(f.root).save({ nested: { content, units: Array.from({ length: 51 }, (_, id) => ({ id })) } });
  const evidence = createEvidenceStore(f.root);
  const tail = await evidence.read({ ...saved, pointer: '/nested/content', offset: content.length - 14 });
  assert.equal(tail.content, 'final evidence'); assert.equal(tail.nextOffset, null);
  const all = [];
  for (let offset = 0; offset !== null;) { const page = await evidence.read({ ...saved, pointer: '/nested/units', offset }); all.push(...page.items.map(item => item.id)); offset = page.nextOffset; }
  assert.deepEqual(all, Array.from({ length: 51 }, (_, id) => id));
  await assert.rejects(evidence.read({ evidenceId: '../outside' }), /编号/);
});

test('program-bodied adapters return const adapter and keep guest logs on failure', async t => {
  const f = await fixture(t);
  const saved = await f.lab.writeAdapter({ manifest, code: `const adapter=${code}; adapter;` });
  assert.equal((await f.lab.validateAdapter({ ...saved, gameDir: f.gameDir })).passed, true);
  const broken = await f.lab.writeAdapter({ manifest, code: code.replace('detect(){return true}', 'detect(h){h.log("header evidence");h.readText("data/story.json");throw new Error("Bad header")}') });
  const result = await f.lab.validateAdapter({ ...broken, gameDir: f.gameDir });
  assert.equal(result.passed, false);
  assert.ok(result.evidence.some(item => item.logs?.includes('header evidence') && item.reads.includes('data/story.json')));
  await assert.rejects(f.lab.writeAdapter({ manifest, code: 'const adapter = {' }), /语法/);
});

test('representative combined edits catch adapters that only write their first record', async t => {
  const f = await fixture(t);
  const saved = await f.lab.writeAdapter({ manifest, code: code.replace('for(const u of i.units)', 'for(const u of i.units.slice(0,1))') });
  const result = await f.lab.validateAdapter({ ...saved, gameDir: f.gameDir });
  assert.equal(result.passed, false); assert.match(result.error.message, /story:1|非文字|文字以外/);
});

test('proof reuse covers actual sidecar reads and directory additions across lab instances', async t => {
  const f = await fixture(t), dataDir = path.join(f.root, 'readset-lab');
  await writeFile(path.join(f.gameDir, 'sidecar.json'), '{"version":1}');
  const lab = await createAdapterLab({ dataDir });
  const saved = await lab.writeAdapter({ manifest, code: code.replace('detect(){return true}', 'detect(h){h.readText("sidecar.json");h.list("data");return true}') });
  const first = await lab.validateAdapter({ ...saved, gameDir: f.gameDir });
  assert.equal(first.passed, true, first.error?.message);
  assert.ok(first.dependencies.files['sidecar.json']);
  const reopened = await createAdapterLab({ dataDir });
  const reused = await reopened.validateAdapter({ ...saved, gameDir: f.gameDir });
  assert.equal(reused.reused, true); assert.equal(reused.validationId, first.validationId);
  await writeFile(path.join(f.gameDir, 'sidecar.json'), '{"version":2}');
  const changed = await reopened.validateAdapter({ ...saved, gameDir: f.gameDir });
  assert.equal(changed.passed, true); assert.notEqual(changed.validationId, first.validationId);
  await writeFile(path.join(f.gameDir, 'data/new.json'), '{}');
  const added = await reopened.validateAdapter({ ...saved, gameDir: f.gameDir });
  assert.notEqual(added.validationId, changed.validationId);
  const checkerChanged = await createAdapterLab({ dataDir, verificationVersions: { checker: 'new-checker' } });
  assert.notEqual((await checkerChanged.validateAdapter({ ...saved, gameDir: f.gameDir })).validationId, added.validationId);
});

test('a previously missing optional sidecar invalidates proof when it appears', async t => {
  const f = await fixture(t);
  const saved = await f.lab.writeAdapter({ manifest, code: code.replace('detect(){return true}', 'detect(h){try{h.readText("optional.json")}catch{}return true}') });
  const first = await f.lab.validateAdapter({ ...saved, gameDir: f.gameDir });
  assert.equal(first.passed, true, first.error?.message);
  assert.deepEqual(first.dependencies.missingFiles, ['optional.json']);
  await writeFile(path.join(f.gameDir, 'optional.json'), '{}');
  const second = await f.lab.validateAdapter({ ...saved, gameDir: f.gameDir });
  assert.equal(second.passed, true); assert.notEqual(second.validationId, first.validationId);
});

test('targeted patches preserve old candidates and probes use the same structure gate', async t => {
  const f = await fixture(t), project = { id: 'patch-contract' }, workspaceDir = path.join(f.root, 'work');
  const lab = new Proxy(f.lab, { get(target, name) { const value = target[name]; return typeof value === 'function'
    ? (input = {}) => value.call(target, { ...input, projectId: project.id, workDir: workspaceDir }) : value; } });
  const saved = await lab.writeAdapter({ manifest, code });
  const state = { attempts: 0, failures: {}, events: [] };
  const session = adaptationTools({ project, inventory: {}, lab, gameDir: f.gameDir, workspaceDir, state });
  const changed = await session.tools.patch_adapter.execute({ ...saved, expectedCodeHash: saved.codeHash, before: 'detect(){return true}', after: 'detect(h){h.log("patched");return true}' });
  assert.notEqual(changed.candidateId, saved.candidateId);
  assert.equal((await lab.inspectAdapter(saved)).code, code);
  const stale = await session.tools.patch_adapter.execute({ ...saved, expectedCodeHash: 'outdated', before: 'detect(){return true}', after: 'detect(){return false}' });
  assert.match(stale.error.message, /哈希|变化/);
  const probe = await session.tools.run_probe.execute({ candidateId: changed.candidateId, translations: { 'story:1': '中文试写。' } });
  assert.equal(probe.passed, true, probe.error?.message); assert.ok(probe.evidenceId);
  const original = JSON.parse(await readFile(path.join(f.gameDir, 'data/story.json'), 'utf8'));
  assert.equal(original.lines[1], 'Second complete scene.');
});

test('new reads make progress, cached reads do not, and search continues beyond 80 files', async t => {
  const f = await fixture(t), state = { attempts: 0, failures: {}, events: [] };
  const files = Array.from({ length: 100 }, (_, index) => ({ path: `part-${index}.txt`, size: 17 }));
  for (const file of files) await writeFile(path.join(f.gameDir, file.path), file.path === 'part-99.txt' ? 'Needle evidence' : 'ordinary resource');
  const lab = { inspectFiles: async ({ offset = 0, limit = 2000 }) => ({ files: files.slice(offset, offset + limit), offset, nextOffset: offset + limit < files.length ? offset + limit : null }),
    readResource: async ({ file }) => { const content = file === 'part-99.txt' ? 'Needle evidence' : 'ordinary resource'; return { file, content, totalBytes: Buffer.byteLength(content), returnedBytes: Buffer.byteLength(content), nextOffset: null }; } };
  const session = adaptationTools({ project: { id: 'read-contract' }, inventory: {}, lab, gameDir: f.gameDir, workspaceDir: path.join(f.root, 'work'), state });
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {}
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"choices":[{"message":{"content":"received"},"finish_reason":"stop"}]}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await session.close(); await session.flush(); });
  const transport = createTechnicalTransport({ onModelPresented: input => session.control.modelPresented(input) });
  const sent = async (file, output) => {
    await (await transport.fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'fixture', messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_resource', arguments: JSON.stringify({ root: 'source', file }) } }] },
      { role: 'tool', tool_call_id: 'read', content: JSON.stringify(output) },
    ] }) })).text();
  };
  const captured = await session.tools.read_resource.execute({ file: 'part-1.txt' });
  assert.equal(state.control.materialSerial, 0, 'capturing the tool result alone is not actual presentation');
  await sent('part-1.txt', captured);
  const first = state.control.materialSerial;
  await sent('part-1.txt', await session.tools.read_resource.execute({ file: 'part-1.txt' })); assert.equal(state.control.materialSerial, first);
  await sent('part-2.txt', await session.tools.read_resource.execute({ file: 'part-2.txt' })); assert.equal(state.control.materialSerial, first + 1);
  assert.equal(state.control.acceptedSerial, 0);
  const page = await session.tools.search_files.execute({ query: 'Needle', content: true });
  assert.equal(page.nextOffset, 80); assert.equal(page.items.length, 0);
  const next = await session.tools.search_files.execute({ query: 'Needle', content: true, offset: page.nextOffset });
  assert.equal(next.items[0].file, 'part-99.txt'); assert.equal(next.nextOffset, null);
});

test('thirteen accepted batches consume no repair attempts and remain resumable', async t => {
  const f = await fixture(t), extracted = [];
  let index = 0;
  const lab = { tryRecipes: async () => null, listRecipes: async () => Array.from({ length: index }, (_, i) => ({ recipeId: `recipe-${i + 1}` })), writeAdapter: async () => ({ candidateId: `candidate-${++index}` }),
    validateAdapter: async () => ({ validationId: 'proof', passed: true }), submitRecipe: async () => ({ recipeId: `recipe-${index}` }),
    extractRecipe: async ({ recipeId }) => { const i = +recipeId.split('-')[1]; return { units: [{ id: `id-${i}`, source: `Scene ${i}`, locator: { file: 'story.json', pointer: `/lines/${i}` } }], binding: { recipeId } }; } };
  let result;
  for (const batchCount of [6, 6, 1]) result = await runAdaptation({ project: { id: 'test', engine: 'Fixture' }, inventory: {}, lab, gameDir: f.gameDir, workspaceDir: path.join(f.root, 'work'), statePath: path.join(f.root, 'state.jsonl'),
    verifyCoverage: async ({ units }) => ({ needsAdaptation: units.length < 13, summary: { unresolvedCandidates: 13 - units.length }, dynamicCandidates: [] }),
    generate: async ({ tools }) => { for (let n = 0; n < batchCount; n++) { const saved = await tools.write_adapter.execute({ manifest, code }); const checked = await tools.validate_adapter.execute(saved); extracted.push(await tools.submit_recipe.execute({ candidateId: saved.candidateId, validationId: checked.validationId, metadata: {} })); } } });
  assert.equal(result.status, 'verified'); assert.equal(result.state.attempts, 13); assert.equal(result.state.repairAttempts, 0); assert.equal(result.units.length, 13);
  assert.equal(result.state.executionWindow, 3);
  assert.ok(extracted.slice(0, -1).every(item => item.accepted && !item.taskComplete));
});

test('coverage discovers inline and indirect display calls in partly extracted files and records unknown JSON clusters', async t => {
  const f = await fixture(t), file = 'plugin.js', text = 'drawText("Inventory"); const message="Follow the river."; $gameMessage.add(message); drawText(`残り：${count}`);';
  await writeFile(path.join(f.gameDir, file), text);
  await mkdir(path.join(f.gameDir, 'locales/ja'), { recursive: true });
  await writeFile(path.join(f.gameDir, 'locales/ja/items.json'), '{"text":"Active Japanese data"}');
  await writeFile(path.join(f.gameDir, 'custom.json'), '{"text":"Known text","payload":["Follow the river."]}');
  await writeFile(path.join(f.gameDir, 'scene.rpy'), '$ renpy.say(None, "Follow the river.")\n');
  const unit = { id: 'inventory', source: 'Inventory', locator: { file, byteStart: 10, byteEnd: 19 } };
  const report = await scanCoverage({ rootDir: f.gameDir, units: [unit] });
  assert.equal(report.displaySites.find(site => site.source === 'Inventory').status, 'bound');
  // An unsolvable expression must still be identified, but it stops blocking convergence: it leaves
  // the pending queue — which would otherwise schedule an impossible adapter job forever and keep
  // needsAdaptation true — and is reported as an adapter-required candidate instead.
  assert.equal(report.summary.adapterCandidates, 2);
  assert.ok(report.classifiedCandidates.some(item => item.classification === 'adapter_required' && item.source === 'message'),
    'the adapter-required message candidate stays visible in the classification report');
  assert.ok(report.displaySites.some(site => site.requiresAdapter), 'its display site keeps the adapter flag for tracing');
  assert.equal(report.dynamicCandidates.some(item => item.requiresAdapter), false,
    'adapter-required candidates no longer sit in the pending queue');
  assert.ok(report.dynamicCandidates.some(item => item.file === 'scene.rpy'));
  assert.ok(report.dynamicCandidates.some(item => item.file === 'locales/ja/items.json'));
  assert.ok(report.unknownClusters.some(item => item.file === 'custom.json' && item.field === 'payload/*'));
});

test('scope proposals merge connected resources and preserve independent work', () => {
  const coverage = { resources: ['index.json', 'dialogue.json', 'independent.json'].map(file => ({ file, kind: 'display-text-candidate' })) };
  const jobs = planAdaptationJobs(coverage, { partition: true, scopeRequests: [{ files: ['index.json', 'dialogue.json'], reason: 'joint offsets' }] });
  assert.equal(jobs.length, 2); assert.ok(jobs.some(job => job.files.join(',') === 'dialogue.json,index.json'));
});

test('coverage discovery pages source-bound clusters within the assignment without recommending unrelated native review', async t => {
  const f = await fixture(t);
  const clusters = Array.from({ length: 105 }, (_, index) => ({ id: `cluster-${index}`, file: 'data/story.json',
    field: `columns/${index}`, evidenceHash: 'a'.repeat(64), status: 'unknown', proseLike: true, examples: [] }));
  const session = adaptationTools({ project: { id: 'cluster-pages', engine: 'VX' }, inventory: {}, lab: f.lab,
    gameDir: f.gameDir, workspaceDir: path.join(f.root, 'cluster-pages'), assignment: { files: ['data/story.json'] },
    state: { failures: {}, events: [] }, trustedToolNames: ['native_review'],
    coverage: { resources: [], unknownClusters: [...clusters, { ...clusters[0], id: 'outside', file: 'other.json' }],
      nativeReviewIssues: [{ file: 'other.json', kind: 'custom_monobehaviour_display_schema_required' }] } });
  try {
    const context = await session.tools.inspect_context.execute({});
    assert.equal(context.coverage.unknownTotal, 105);
    assert.equal(context.coverage.unknownClusters.length, 40);
    assert.equal(context.entrypoints, undefined);
    assert.ok(session.tools.native_review, 'the tool remains registered; only a misleading recommendation disappears');
    const seen = [];
    for (let offset = 0; offset !== null;) {
      const page = await session.tools.inspect_coverage.execute({ offset, limit: 30 });
      assert.equal(page.unknownTotal, 105);
      assert.ok(page.unknownClusters.every(item => item.file === 'data/story.json' && item.evidenceHash === 'a'.repeat(64)));
      seen.push(...page.unknownClusters.map(item => item.id));
      assert.deepEqual(page.nextPage, page.nextOffset === null ? null : { tool: 'inspect_coverage', input: { offset: page.nextOffset, limit: 30 } });
      offset = page.nextOffset;
    }
    assert.deepEqual(seen, clusters.map(item => item.id));
  } finally { await session.close(); await session.flush(); }
});

test('bounded coverage cursors retain cluster and expression offsets when a page is shortened', () => {
  for (const [field, total] of [['unknownClusters', 'unknownTotal'], ['expressionCandidates', 'expressionTotal']]) {
    const output = { offset: 40, [total]: 140, [field]: Array.from({ length: 60 }, (_, index) => ({
      id: `entry-${index + 40}`, evidenceHash: 'a'.repeat(64), source: 'A full contextual sentence. '.repeat(40) })), nextOffset: 100,
      nextPage: { tool: 'inspect_coverage', input: { offset: 100, limit: 60 } } };
    const page = boundedToolOutput(output, { maxCharacters: 8000 });
    assert.ok(page[field].length > 0 && page[field].length < 60);
    assert.equal(page.fieldCursors[field].nextOffset, 40 + page[field].length);
    assert.equal(page.nextOffset, 40 + page[field].length);
    assert.equal(page.nextPage.input.offset, page.nextOffset);
  }
});

test('coverage evidence pagination cannot silently pretend a captured page is the global collection', async t => {
  const f = await fixture(t), store = createEvidenceStore(path.join(f.root, 'page-evidence'));
  const value = { offset: 0, dynamicTotal: 54, dynamicCandidates: Array.from({ length: 50 }, (_, i) => ({ id: `display-${i}` })),
    nextOffset: 50, nextPage: { tool: 'inspect_coverage', input: { offset: 50, limit: 50 } } };
  const receipt = await store.save(value, { tool: 'inspect_coverage', input: {} });
  const page = await store.read({ evidenceId: receipt.evidenceId, pointer: '/dynamicCandidates', offset: 48 });
  assert.equal(page.total, 50, 'the immutable evidence contains exactly the captured page');
  assert.equal(page.items.length, 2);
  assert.equal(page.nextOffset, null);
  assert.equal(page.sourcePage.nextOffset, 50);
  assert.deepEqual(page.sourcePage.nextCall, value.nextPage, 'global continuation remains an explicit original tool call');
});

test('an Agent can select an investigated script literal without hand-writing an adapter or requiring a scanner candidate', async t => {
  const f = await fixture(t), file = 'caption.js';
  await writeFile(path.join(f.gameDir, file), 'const caption="A complete selected caption."; drawText(caption);');
  const session = adaptationTools({ project: { id: 'selected-literal', engine: 'Fixture' }, inventory: { existingUnits: [] },
    lab: f.lab, gameDir: f.gameDir, workspaceDir: path.join(f.root, 'selected-work'), assignment: { files: [file] },
    state: { failures: {}, events: [] }, coverage: { resources: [], dynamicCandidates: [] } });
  try {
    const input = await session.tools.read_resource.execute({ file });
    assert.match(input.content, /drawText\(caption\)/);
    const candidate = await session.tools.write_literal_adapter.execute({ selections: [{ file,
      text: 'A complete selected caption.', reason: 'The inspected consumer passes caption to drawText.' }] });
    assert.equal(candidate.error, undefined, JSON.stringify(candidate.error));
    assert.equal(candidate.selectedLiterals, 1);
    const result = await session.tools.validate_adapter.execute({ candidateId: candidate.candidateId });
    assert.equal(result.passed, true, JSON.stringify(result.error));
    assert.equal(result.checks.roundtrip, 'passed');
    assert.equal(result.checks.sample, 'passed');
    assert.ok(session.tools.write_adapter && session.tools.run_workspace, 'general code and managed execution remain available');
  } finally { await session.close(); await session.flush(); }
});

test('literal tool accepts text without quote wrappers and rejects the obsolete literal protocol', async t => {
  const f = await fixture(t), file = 'Vocab.rb', original = 'Buy = "Buy"\nSell = "Sell"\n';
  await writeFile(path.join(f.gameDir, file), original);
  const session = adaptationTools({ project: { id: 'literal-protocol', engine: 'Fixture' }, inventory: { existingUnits: [] },
    lab: f.lab, gameDir: f.gameDir, workspaceDir: path.join(f.root, 'literal-protocol'), assignment: { files: [file] },
    state: { failures: {}, events: [] }, coverage: { resources: [], dynamicCandidates: [] } });
  try {
    const tool = session.tools.write_literal_adapter;
    const properties = tool.inputSchema.jsonSchema.properties.selections.items.properties;
    assert.match(properties.text.description, /不要带源码外层引号/);
    assert.equal(properties.literal, undefined);
    assert.match(properties.occurrence.description, /不是selections数组下标/);
    const selections = ['Buy', 'Sell'].map(word => ({ file, text: word, reason: 'Observed shop command display consumer.' }));
    const badIndex = await tool.execute({ selections: selections.map((selection, index) => ({ ...selection, occurrence: index })) });
    assert.match(badIndex.error.message, /occurrence/);
    assert.match(badIndex.error.message, /1 处/);
    assert.match(badIndex.nextAction, /不是 selections 数组下标.*唯一匹配时省略/);
    const obsolete = await tool.execute({ selections: [{ file, literal: '"Buy"', reason: 'Old protocol.' }] });
    assert.match(obsolete.error.message, /只接受 text/);
    assert.match(obsolete.nextAction, /不传源码引号/);
    assert.equal(await readFile(path.join(f.gameDir, file), 'utf8'), original);
    const candidate = await tool.execute({ selections });
    assert.equal(candidate.selectedLiterals, 2, JSON.stringify(candidate.error));
    assert.equal((await session.tools.validate_adapter.execute({ candidateId: candidate.candidateId })).passed, true);
  } finally { await session.close(); await session.flush(); }
});

test('unknown prose clusters close through source-bound Agent classification and stale decisions expire', async t => {
  const f = await fixture(t), gameDir = path.join(f.root, 'classification');
  await mkdir(gameDir);
  const document = { text: 'Known text.', payload: ['Internal parser compatibility sentence.'] };
  await writeFile(path.join(gameDir, 'data.json'), JSON.stringify(document));
  const known = { id: 'known', source: document.text, context: { file: 'data.json' }, locator: { file: 'data.json', pointer: '/text' } };
  const coverage = await scanCoverage({ rootDir: gameDir, units: [known] });
  assert.deepEqual(coverage.triggers, ['unknown-text-clusters']);
  const jobs = planAdaptationJobs(coverage, { partition: true });
  assert.deepEqual(jobs.map(job => job.files), [['data.json']]);
  const result = await runAdaptation({ project: { id: 'unknown-classification', engine: 'Fixture' }, gameDir, workspaceDir: path.join(f.root, 'classification-work'), lab: f.lab,
    inventory: { existingUnits: [known] }, coverage, assignment: jobs[0],
    verifyCoverage: ({ units, coverageDecisions }) => scanCoverage({ rootDir: gameDir, units: [known, ...units], decisions: coverageDecisions }),
    generate: async ({ tools }) => {
      const context = await tools.inspect_context.execute({}), cluster = context.coverage.unknownClusters[0];
      await tools.read_resource.execute({ file: cluster.file });
      const recorded = await tools.record_coverage_decisions.execute({ decisions: [{ id: cluster.id, evidenceHash: cluster.evidenceHash, disposition: 'non-display', reason: 'Parser metadata consumed only by a version check.' }] });
      assert.equal(recorded.taskComplete, true);
    } });
  assert.equal(result.status, 'verified'); assert.equal(result.kind, 'coverage-review'); assert.equal(result.coverageDecisions.length, 1);
  assert.equal((await scanCoverage({ rootDir: gameDir, units: [known], decisions: result.coverageDecisions })).needsAdaptation, false);
  await writeFile(path.join(gameDir, 'data.json'), JSON.stringify({ ...document, payload: ['Changed parser compatibility sentence.'] }));
  const changed = await scanCoverage({ rootDir: gameDir, units: [known], decisions: result.coverageDecisions });
  assert.equal(changed.summary.unreviewedClusters, 1); assert.equal(changed.unknownClusters[0].status, 'unknown');
});

test('a displayed unknown field becomes exact candidates and joins the real native writeback path', async t => {
  const f = await fixture(t), gameDir = path.join(f.root, 'display-classification');
  await mkdir(gameDir);
  const document = { text: 'Known text.', payload: Array.from({ length: 5 }, (_, i) => `An entire missing scene ${i}.`) };
  await writeFile(path.join(gameDir, 'data.json'), JSON.stringify(document));
  const known = { id: 'known', source: document.text, context: { file: 'data.json' }, locator: { file: 'data.json', pointer: '/text' } };
  const coverage = await scanCoverage({ rootDir: gameDir, units: [known] });
  const result = await runAdaptation({ project: { id: 'unknown-display', engine: 'Fixture' }, gameDir, workspaceDir: path.join(f.root, 'display-classification-work'), lab: f.lab,
    inventory: { existingUnits: [known] }, coverage,
    verifyCoverage: ({ units, coverageDecisions }) => scanCoverage({ rootDir: gameDir, units: [known, ...units], decisions: coverageDecisions }),
    generate: async ({ tools }) => {
      const context = await tools.inspect_context.execute({}), cluster = context.coverage.unknownClusters[0];
      await tools.read_resource.execute({ file: cluster.file });
      await tools.record_coverage_decisions.execute({ decisions: [{ id: cluster.id, evidenceHash: cluster.evidenceHash, disposition: 'display', reason: 'The active scene loader displays each payload item.' }] });
      for (let batch = 0; batch < document.payload.length; batch++) {
        const page = await tools.inspect_coverage.execute({});
        const candidateIds = page.dynamicCandidates?.map(item => item.id) ?? [];
        if (!candidateIds.length) break;
        const candidate = await tools.write_text_adapter.execute({ candidateIds });
        assert.ok(candidate.candidateId, JSON.stringify(candidate));
        const checked = await tools.validate_adapter.execute({ candidateId: candidate.candidateId });
        assert.equal(checked.passed, true, JSON.stringify(checked.error));
        const submitted = await tools.submit_recipe.execute({ candidateId: candidate.candidateId, validationId: checked.validationId, metadata: {} });
        if (submitted.taskComplete) break;
      }
    } });
  assert.equal(result.status, 'verified', JSON.stringify(result.error)); assert.equal(result.units.length, 5); assert.equal(result.coverage.needsAdaptation, false);
  assert.equal(result.coverageDecisions[0].disposition, 'display');
});

test('failure artifacts use opaque handles and read-only checked relative paths', async t => {
  const f = await fixture(t), artifact = path.join(f.root, 'failed');
  await mkdir(artifact); await writeFile(path.join(artifact, 'result.json'), '{"text":"Failed output evidence"}');
  const session = adaptationTools({ project: {}, inventory: {}, lab: f.lab, gameDir: f.gameDir, workspaceDir: path.join(f.root, 'failure-work'), state: { attempts: 0, failures: {}, events: [] }, failure: { repairBundle: { phase: 'build', workbenchDir: f.root, artifacts: [{ id: 'build', path: artifact }] } } });
  const summary = await session.tools.read_failure.execute({});
  assert.equal(summary.failure.repairBundle.artifacts[0].id, 'build');
  assert.equal(JSON.stringify(summary).includes(f.root), false);
  const files = await session.tools.read_failure.execute({ artifactId: 'build' });
  assert.equal(files.files[0].path, 'result.json');
  assert.match((await session.tools.read_failure.execute({ artifactId: 'build', file: 'result.json' })).content, /Failed output evidence/);
  assert.ok((await session.tools.read_failure.execute({ artifactId: 'build', file: '../game/Game.exe' })).error);
  assert.ok((await session.tools.read_failure.execute({ artifactId: 'other', file: 'result.json' })).error);
});

test('real ZIP codec carries generated member adapters through validation, build, repack and readback', async t => {
  const f = await fixture(t), bundledPython = path.resolve('local/runtime/python/python.exe');
  const pythonPath = process.env.PINHAO_PYTHON ?? await access(bundledPython).then(() => bundledPython, () => process.platform === 'win32' ? 'python' : 'python3');
  const worker = productWorker({ pythonPath, workerPath: path.resolve('adapters/python/worker.py'), toolkitPath: path.resolve('kits/workbench-tutorial/toolkit'), dependencyDir: path.resolve('local/dependencies'), timeoutMs: 60000 });
  const loose = path.join(f.root, 'loose');
  await mkdir(path.join(loose, 'data'), { recursive: true });
  await writeFile(path.join(loose, 'data/story.json'), await readFile(path.join(f.gameDir, 'data/story.json')));
  await writeFile(path.join(loose, 'untouched.bin'), Buffer.from([0, 1, 2, 255]));
  const originalArchive = path.join(f.gameDir, 'game.zip');
  const packed = await worker('native_repack', { inputDir: loose, outputFile: originalArchive, format: 'zip' });
  assert.equal(packed.memberReadback, true, JSON.stringify(packed.error));
  const native = createNativeTools({ worker }), lab = await createAdapterLab({ dataDir: path.join(f.root, 'archive-lab'), archiveResolver: native, trustedTools: native.trustedTools });
  const saved = await lab.writeAdapter({ manifest: { ...manifest, container: { file: 'game.zip', format: 'zip' } }, code });
  const validation = await lab.validateAdapter({ ...saved, gameDir: f.gameDir });
  assert.equal(validation.passed, true, validation.error?.message);
  const recipe = await lab.submitRecipe({ ...saved, validationId: validation.validationId });
  const workspaceDir = path.join(f.root, 'archive-work');
  const extracted = await lab.extractRecipe({ recipeId: recipe.recipeId, gameDir: f.gameDir, workspaceDir });
  assert.equal(extracted.binding.sourceView.container.file, 'game.zip');
  const built = await lab.dispatch('build', { workspaceDir, outputDir: path.join(f.root, 'archive-build'), translations: [{ id: 'story:1', translation: '第二段完整中文，长度已经改变。' }] });
  const outputDir = path.join(f.root, 'archive-product');
  await lab.dispatch('assemble', { workspaceDir, buildDir: built.buildDir, outputDir });
  const checked = await worker('native_unpack', { archive: path.join(outputDir, 'game.zip'), outputDir: path.join(f.root, 'checked'), format: 'zip' });
  assert.equal(checked.files, 2, JSON.stringify(checked.error));
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'checked/data/story.json'), 'utf8')).lines[1], '第二段完整中文，长度已经改变。');
  assert.deepEqual(await readFile(path.join(f.root, 'checked/untouched.bin')), Buffer.from([0, 1, 2, 255]));
  let published=0;
  const sealed=await lab.withBuildPublication({builds:[{workspaceDir,buildDir:built.buildDir,buildReceiptId:built.buildReceiptId,outputDir}],commit:proofs=>{published++;assert.equal(proofs[0].finalProofRef.format,'pinhao-final-build-ref-1');}});
  await rm(built.buildDir,{recursive:true});
  await lab.withBuildPublication({builds:sealed.proofs,commit:()=>published++});
  assert.equal(published,2,'real archive final proof does not depend on the released build tree');
  const finalArchive=path.join(outputDir,'game.zip');
  await writeFile(finalArchive,Buffer.concat([await readFile(finalArchive),Buffer.from('changed final artifact')]));
  await assert.rejects(lab.withBuildPublication({builds:sealed.proofs,commit:()=>published++}),{code:'FORMAT_SOURCE_STALE'});
  assert.equal(published,2,'changed actual archive cannot reuse the retained target proof');
});
