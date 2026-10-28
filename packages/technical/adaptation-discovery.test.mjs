import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { adaptationTools } from './adaptation.mjs';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';

async function fixture(t, coverage = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-author-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  const readDir = path.join(root, 'materials'), gameDir = path.join(root, 'input'), workspaceDir = path.join(root, 'work');
  await mkdir(path.join(readDir, 'scripts'), { recursive: true });
  await mkdir(gameDir); await mkdir(workspaceDir);
  await writeFile(path.join(readDir, 'scripts', 'main.gd'), 'var heading = "A complete heading"\nlabel.text = heading\n');
  await writeFile(path.join(readDir, 'story.json'), '{"caption":"A complete heading"}');
  await writeFile(path.join(gameDir, 'story.json'), '{"caption":"A complete heading"}');
  const state = { status: 'running', events: [], failures: {}, attempts: 0 };
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab') });
  const args = { project: { id: 'author-discovery', name: 'Neutral resource', engine: 'Godot' }, lab,
    gameDir, readDir, readRoots: [readDir, gameDir], workspaceDir, state, inventory: {}, coverage };
  return { root, state, args, session: adaptationTools(args) };
}

test('author context exposes complete read materials separately from its selected script input', async t => {
  const f = await fixture(t), tools = f.session.tools;
  const context = await tools.inspect_context.execute({});
  assert.equal(context.executionContext.sourceDir, f.args.gameDir);
  assert.equal(context.executionContext.sourceFiles, 'on-demand-copy');
  assert.equal(context.inputView.root, 'source');
  assert.equal(context.inputView.sources.length, 2, 'canonical duplicate roots do not shift sourceIndex');
  assert.equal(context.inputView.sources[0].directory, f.args.readDir);
  assert.deepEqual(context.inputView.entries.map(row => [row.path, row.kind]), [['scripts', 'directory'], ['story.json', 'file']]);
  const page = await tools.list_files.execute({});
  assert.equal(page.files.find(row => row.path === 'scripts').kind, 'directory');
  const recursive = await tools.list_files.execute({ recursive: true });
  assert.ok(recursive.files.some(row => row.path === 'scripts/main.gd' && row.kind === 'file'));
  assert.equal(await readFile(path.join(f.args.gameDir, 'story.json'), 'utf8'), '{"caption":"A complete heading"}');
  await assert.rejects(readFile(path.join(f.args.gameDir, 'scripts/main.gd')), error => error.code === 'ENOENT', 'discovery does not copy full material trees');
});

test('author search has explicit modes, exact scope, and valid root-aware continuation parameters', async t => {
  const f = await fixture(t), tools = f.session.tools;
  assert.match((await tools.search_files.execute({ query: 'heading' })).error.message, /content/);
  const schema = tools.search_files.inputSchema.jsonSchema;
  assert.ok(schema.required.includes('content'));
  assert.deepEqual(schema.properties.matchMode.enum, ['literal', 'regex']);
  assert.deepEqual(schema.properties.route.enum, ['text', 'script', 'container', 'image', 'media', 'font', 'binary', 'unknown']);
  assert.deepEqual(tools.list_files.inputSchema.jsonSchema.properties.route.enum, schema.properties.route.enum);
  assert.equal((await tools.search_files.execute({ query: '[', matchMode: 'regex', content: true })).error.code, 'INVALID_SEARCH_PATTERN');
  const result = await tools.search_files.execute({ relativePath: 'scripts/main.gd', query: 'heading', content: true });
  assert.equal(result.mode, 'content');
  assert.equal(result.matchMode, 'literal');
  assert.equal(result.relativePath, 'scripts/main.gd');
  assert.deepEqual([...new Set(result.items.map(row => row.file))], ['scripts/main.gd']);
  await writeFile(path.join(f.args.workspaceDir, 'many.txt'), Array.from({ length: 20 }, (_, i) => `target ${i}`).join('\n'));
  const truncated = await tools.search_files.execute({ root: 'work', relativePath: 'many.txt', query: 'target', content: true });
  assert.equal(truncated.partial[0].nextRead.input.root, 'work');
  assert.ok(truncated.partial[0].nextRead.input.length <= 65536);
  const routed = await tools.search_files.execute({ route: 'script', content: false, query: 'main' });
  assert.equal(routed.route, 'script');
  assert.deepEqual(routed.items.map(row => row.file), ['scripts/main.gd']);
  assert.equal((await tools.list_files.execute({ route: 'script', recursive: true })).files[0].path, 'scripts/main.gd');
});

test('discovery never adds a generic eight-read deadline or removes general author tools', async t => {
  const f = await fixture(t), tools = f.session.tools;
  for (const name of ['write_adapter', 'write_python_adapter', 'run_workspace', 'prepare_dependencies', 'copy_source_files']) assert.ok(tools[name]);
  for (let offset = 0; offset < 12; offset++) {
    const result = await tools.read_resource.execute({ file: 'story.json', offset, length: 1 });
    assert.doesNotMatch(result.nextAction ?? '', /本资源已有工具证据|结案/);
  }
  assert.equal(f.state.discoveryCalls, undefined);
  const context = await tools.inspect_context.execute({});
  assert.equal(context.progress.nextAction, undefined);
});

test('raw JSON coverage candidates use the same writable display IDs in summary, context and pages', async t => {
  const raw = { id: 'json:story.json#/caption', file: 'story.json', source: 'A complete heading', classification: 'display_unresolved', locator: { file: 'story.json', pointer: '/caption' } };
  const cluster = { id: 'cluster-caption', file: 'story.json', field: 'caption', evidenceHash: 'a'.repeat(64) };
  const coverage = { sourceContextHash: 'b'.repeat(64), needsAdaptation: true, dynamicCandidates: [raw], unknownClusters: [cluster], resources: [] };
  const f = await fixture(t, coverage);
  const session = adaptationTools({ ...f.args, verifyCoverage: async input => ({ ...coverage, coverageDecisions: input.coverageDecisions }) });
  const tools = session.tools;
  await tools.read_resource.execute({ file: 'story.json' });
  const classified = await tools.record_coverage_decisions.execute({ decisions: [{ id: cluster.id, evidenceHash: cluster.evidenceHash, disposition: 'display', reason: 'The real display consumer loads caption.' }] });
  assert.equal(classified.accepted, true, JSON.stringify(classified));
  const page = await tools.inspect_coverage.execute({});
  const context = await tools.inspect_context.execute({});
  const id = page.dynamicCandidates[0].id;
  assert.match(id, /^display-/);
  assert.equal(classified.remainingCoverage.dynamicCandidates[0].id, id);
  assert.equal(context.coverage.dynamicCandidates[0].id, id);
  assert.equal(context.coverage.unknownClusters[0].id, cluster.id);
  assert.notEqual(id, cluster.id);
  assert.ok((await tools.write_text_adapter.execute({ candidateIds: [id] })).candidateId);
  assert.ok((await tools.write_text_adapter.execute({ candidateIds: [raw.id] })).error, 'a raw scanner ID is not a second submission protocol');
});
