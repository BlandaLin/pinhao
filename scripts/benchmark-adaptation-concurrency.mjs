import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const option = name => process.argv[process.argv.indexOf(name) + 1];
const before = path.resolve(option('--before')), after = path.resolve(option('--after'));
const output = path.resolve(option('--out')), samples = 5, count = 24, latencyMs = 150, concurrency = 6;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const files = Array.from({ length: count }, (_, index) => `data/scene-${index}.json`);
const coverage = { needsAdaptation: true, resources: [], dynamicCandidates: [], extractionIssues: [],
  summary: { unreviewedClusters: count },
  unknownClusters: files.map(file => ({ id: file, file, status: 'unknown', proseLike: true })) };
const rows = files.map(file => ({ id: file, source: `A complete neutral scene in ${file}.`,
  context: { file }, locator: { file, pointer: '/display' } }));
const runOne = async source => {
  const { planAdaptationJobs, runAdaptationPool } = await import(pathToFileURL(path.join(source, 'packages/technical/adaptation-pool.mjs')));
  const jobs = planAdaptationJobs(coverage, { partition: true });
  let requests = 0, active = 0, peak = 0;
  const start = performance.now();
  const result = await runAdaptationPool({ jobs, concurrency, coverage, workspaceDir: 'neutral-benchmark',
    verifyCoverage: async ({ units }) => ({ ...coverage, needsAdaptation: units.length !== count,
      unknownClusters: coverage.unknownClusters.filter(cluster => !units.some(unit => unit.id === cluster.file)) }),
    run: async ({ assignment }) => {
      const selected = rows.filter(row => !assignment || assignment.files.includes(row.context.file));
      for (const _row of selected) {
        requests++; active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, latencyMs));
        active--;
      }
      return { status: 'verified', extraction: { workspaceDir: assignment?.id ?? 'coordinator', units: selected } };
    },
  });
  const elapsedMs = performance.now() - start;
  assert.equal(result.status, 'verified');
  assert.equal(requests, count);
  assert.equal(result.units.length, count);
  return { elapsedMs, jobs: jobs.length, requests, peak, units: result.units.length,
    resultHash: hash(result.units.sort((a, b) => a.id.localeCompare(b.id))) };
};
const results = { before: [], after: [] };
for (let index = 0; index < samples; index++) for (const [label, source] of [['before', before], ['after', after]]) {
  results[label].push(await runOne(source));
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
assert.equal(new Set([...results.before, ...results.after].map(item => item.resultHash)).size, 1);
const summary = Object.fromEntries(Object.entries(results).map(([label, values]) => [label, {
  medianMs: median(values.map(value => value.elapsedMs)), peak: values[0].peak,
  jobs: values[0].jobs, requests: values[0].requests, units: values[0].units,
}]));
const report = { fixture: { count, latencyMs, concurrency, samples, inputHash: hash(coverage) },
  limitation: 'Production planner and pool; injected 150 ms per-resource model waits, not a real API or semantic adaptation success benchmark.',
  summary, speedup: summary.before.medianMs / summary.after.medianMs, results };
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ summary, speedup: report.speedup }));
