import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runAdaptation } from './adaptation.mjs';
import { planAdaptationJobs, runAdaptationPool, scopeAdaptationCoverage } from './adaptation-pool.mjs';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';
import { scanCoverage } from './coverage.mjs';

test('unknown-file jobs investigate cross-file readers in parallel and resume with durable evidence but no extra write authority', async t => {
  const parent = path.resolve('local/unknown-pool-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'parallel-')), gameDir = path.join(root, 'game');
  t.after(async () => { assert.equal(path.dirname(root), parent); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  await mkdir(path.join(gameDir, 'js'), { recursive: true });
  const files = ['a.json', 'b.json', 'c.json'];
  for (const file of files) await writeFile(path.join(gameDir, file), JSON.stringify({ payload: [`A quiet neutral record for ${file}.`] }));
  const plugin = path.join(gameDir, 'js/plugin.js');
  await writeFile(plugin, 'globalThis.editorOnly = data => data.payload;');
  const workspaceFor = ({ projectId }) => path.join(root, 'project-labs', projectId);
  const labDir = path.join(root, 'lab'), lab = await createAdapterLab({ dataDir: labDir, workspaceFor });
  const units = [{ id: 'known', source: 'A complete neutral scene.', kind: 'message', tokens: [], context: { file: 'known.txt' } }];
  const scan = decisions => scanCoverage({ rootDir: gameDir, units, decisions });
  const coverage = await scan(), jobs = planAdaptationJobs(coverage, { partition: true });
  assert.deepEqual(jobs.map(job => job.files), files.map(file => [file]));
  const project = { id: 'parallel-fields', name: 'Neutral fields', engine: 'unknown' };
  const workspaceDir = path.join(root, 'work'), statePath = path.join(workspaceDir, 'progress.jsonl');
  let active = 0, peak = 0, release, rejectStart;
  const allStarted = new Promise((resolve, reject) => { release = resolve; rejectStart = reject; });
  const startupTimeout = setTimeout(() => rejectStart(new Error('Independent unknown-field jobs were serialized')), 3000);
  t.after(() => clearTimeout(startupTimeout));
  const controller = new AbortController();
  const classify = async tools => {
    const context = await tools.inspect_context.execute({});
    assert.equal(context.coverage.summary.unreviewedClusters, 1);
    const cluster = context.coverage.unknownClusters[0];
    await tools.read_resource.execute({ file: cluster.file });
    return tools.record_coverage_decisions.execute({ decisions: [{
      id: cluster.id, evidenceHash: cluster.evidenceHash, disposition: 'non-display',
      reason: 'The inspected fixture stores editor-only descriptions rather than runtime display text.',
    }] });
  };
  const result = await runAdaptationPool({
    jobs, concurrency: 3, coverage, gameDir, workspaceDir, statePath,
    verifyCoverage: ({ coverageDecisions }) => scan(coverageDecisions),
    run: args => runAdaptation({
      ...args, project, inventory: {}, lab, connection: { model: 'neutral' },
      ...(args.assignment.files[0] === 'a.json' ? { signal: controller.signal } : {}),
      generate: async ({ tools }) => {
        active++; peak = Math.max(peak, active);
        if (active === 3) { clearTimeout(startupTimeout); release(); }
        try {
          await allStarted;
          if (args.assignment.files[0] === 'a.json') {
            const listed = await tools.list_files.execute({ relativePath: 'js' });
            assert.deepEqual(listed.files.map(file => file.path), ['js/plugin.js']);
            await tools.list_files.execute({ relativePath: 'js/optional' });
            const found = await tools.search_files.execute({ query: 'editorOnly', content: true });
            assert.ok(found.items.some(item => item.file === 'js/plugin.js'));
            assert.match((await tools.read_resource.execute({ file: 'js/plugin.js' })).content, /data\.payload/);
            const denied = await tools.write_adapter.execute({ manifest: { scope: { files: ['js/plugin.js'] } }, code: '({})' });
            assert.match(denied.error.message, /assignment\.files/);
            controller.abort();
          } else {
            await classify(tools);
          }
        } finally { active--; }
      },
    }),
  });
  assert.equal(peak, 3);
  assert.equal(result.status, 'needs-review');
  assert.equal(result.verifiedJobs, 2, JSON.stringify(result.jobs));
  assert.equal(result.pendingJobs, 1);
  assert.equal((await lab.listCoverageDecisions({ projectId: project.id })).length, 2);

  const reopened = await createAdapterLab({ dataDir: labDir, workspaceFor });
  const saved = await reopened.listCoverageDecisions({ projectId: project.id });
  const job = jobs.find(job => job.files[0] === 'a.json');
  const continuation = {
    project, inventory: {}, gameDir, lab: reopened, connection: { model: 'neutral' }, assignment: job,
    workspaceDir: path.join(workspaceDir, 'jobs', job.id), statePath: path.join(workspaceDir, 'jobs', job.id, 'progress.jsonl'),
    coverage: scopeAdaptationCoverage(await scan(saved), job.files),
    verifyCoverage: async ({ coverageDecisions }) => scopeAdaptationCoverage(await scan([...saved, ...coverageDecisions]), job.files),
  };
  const resumed = await runAdaptation({ ...continuation, retry: true, generate: async ({ tools }) => classify(tools) });
  assert.equal(resumed.status, 'verified');
  const decision = resumed.coverageDecisions.find(item => item.file === 'a.json');
  assert.ok(decision.reads.some(read => read.file === 'js/plugin.js' && read.kind === 'read'));
  assert.ok(decision.reads.some(read => read.file === 'js/optional' && read.kind === 'missing' && read.directory));
  const allDecisions = await reopened.listCoverageDecisions({ projectId: project.id });
  assert.equal(allDecisions.length, 3);
  assert.equal((await scan(allDecisions)).needsAdaptation, false);
  const reused = await runAdaptation({ ...continuation, workspaceDir: path.join(root, 'reuse'), statePath: path.join(root, 'reuse/progress.jsonl'),
    generate: async () => assert.fail('Unchanged classification must be reused without a model request') });
  assert.equal(reused.status, 'verified');
  assert.equal(reused.reused, true);
  const before = await readFile(plugin);
  await writeFile(plugin, before.toString().replace('data.payload', 'data.message'));
  assert.equal((await readFile(plugin)).length, before.length);
  assert.equal((await scan(allDecisions)).unknownClusters.find(cluster => cluster.file === 'a.json').status, 'unknown');
});
