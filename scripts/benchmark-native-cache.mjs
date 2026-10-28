import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const usage = 'node --expose-gc scripts/benchmark-native-cache.mjs --source <source-root> --out <result.json>';
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  if (!['--source', '--out'].includes(process.argv[index]) || !process.argv[index + 1]) throw new Error(usage);
  options[process.argv[index].slice(2)] = process.argv[index + 1];
}
if (!options.source || !options.out || !global.gc) throw new Error(usage);
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceRoot = path.resolve(options.source), output = path.resolve(options.out);
const originalReadFile = fsPromises.readFile, originalCreateReadStream = fs.createReadStream;
let reads;
fsPromises.readFile = async (...args) => {
  const bytes = await originalReadFile(...args);
  if (reads) {
    const kind = path.basename(String(args[0])) === 'host-native-result.json' ? 'result' : 'other';
    reads[kind].calls++; reads[kind].bytes += Buffer.byteLength(bytes);
  }
  return bytes;
};
fs.createReadStream = (...args) => {
  const stream = originalCreateReadStream(...args);
  if (reads) {
    const counter = reads.source;
    counter.calls++;
    stream.on('data', chunk => { counter.bytes += chunk.length; });
  }
  return stream;
};
syncBuiltinESMExports();
const { createNativeTools } = await import(pathToFileURL(path.join(sourceRoot, 'packages/core/native-tools.mjs')).href);
const parent = path.resolve('local', 'native-cache-benchmark');
await fsPromises.mkdir(parent, { recursive: true });
const directory = await fsPromises.mkdtemp(path.join(parent, 'run-'));
const projects = 24, unitCount = 12000, concurrency = 3, repetitions = 5;
const source = '{"text":"A complete neutral source baseline."}';
const counters = () => ({ result: { calls: 0, bytes: 0 }, other: { calls: 0, bytes: 0 }, source: { calls: 0, bytes: 0 } });
const collect = async () => { for (let i = 0; i < 3; i++) { global.gc(); await new Promise(resolve => setImmediate(resolve)); } return process.memoryUsage(); };

async function sample(index, count, size) {
  const root = path.join(directory, String(index));
  await fsPromises.mkdir(root);
  const inputs = [];
  for (let project = 0; project < count; project++) {
    const gameDir = path.join(root, `game-${project}`), workDir = path.join(root, `work-${project}`);
    await fsPromises.mkdir(gameDir); await fsPromises.mkdir(workDir);
    await fsPromises.writeFile(path.join(gameDir, 'source.json'), source);
    inputs.push({ gameDir, workDir, args: [] });
  }
  let extracts = 0, roundtrips = 0, active = 0, peakActive = 0;
  const tools = createNativeTools({ worker: async (command, input) => {
    if (command === 'probe') return { engine: 'Neutral native fixture' };
    if (command === 'roundtrip') { roundtrips++; return { passed: true, byteIdentical: true }; }
    assert.equal(command, 'extract');
    extracts++; active++; peakActive = Math.max(active, peakActive);
    await fsPromises.mkdir(path.join(input.workspaceDir, 'technical'), { recursive: true });
    await fsPromises.writeFile(path.join(input.workspaceDir, 'manifest.json'), '{"version":1}');
    await fsPromises.writeFile(path.join(input.workspaceDir, 'technical', 'product-source.json'),
      JSON.stringify({ sourceFiles: { 'source.json': hash(source) } }));
    const units = Array.from({ length: size }, (_, unit) => ({
      id: `neutral:${unit}`, source: `Scene ${unit}. ${'A complete semantic line continues without splitting. '.repeat(5)}`,
      tokens: [], kind: 'message', context: { file: `data/Map${unit % 48}.json`, event: unit, scene: `scene-${Math.floor(unit / 16)}` },
    }));
    active--;
    return { workspaceDir: input.workspaceDir, units, files: ['source.json'] };
  } });
  const initial = await collect(), checkpoints = [];
  let released = 0;
  reads = counters();
  const start = performance.now();
  for (let offset = 0; offset < count; offset += concurrency) {
    await Promise.all(inputs.slice(offset, offset + concurrency).map(async input => {
      const extracted = await tools.trustedTools.native_extract.execute(input);
      assert.equal(extracted.unitCount, size);
      for (let page = 0; page < 3; page++) {
        const result = await tools.trustedTools.native_inspect.execute({ ...input, args: ['--offset', String(page * 20)] });
        assert.equal(result.units[0].id, `neutral:${page * 20}`);
      }
      const accepted = await tools.trustedTools.native_accept.execute(input);
      assert.equal((await tools.resolveNativeResult({ ...input, resultId: accepted.acceptedNativeResultId })).extraction.units.length, size);
      released += tools.release?.({ workDir: input.workDir }) ?? 0;
    }));
    const memory = await collect();
    checkpoints.push({ completedProjects: Math.min(offset + concurrency, count), heapUsed: memory.heapUsed, rss: memory.rss });
  }
  const totalMs = performance.now() - start, activeReads = reads;
  reads = undefined;
  const retained = await collect();
  reads = counters();
  const resumeStart = performance.now();
  const resumed = await tools.trustedTools.native_extract.execute(inputs[0]);
  assert.equal(resumed.reused, true);
  await tools.trustedTools.native_accept.execute(inputs[0]);
  const resumeMs = performance.now() - resumeStart, resumeReads = reads;
  reads = undefined;
  assert.equal(extracts, count); assert.equal(roundtrips, count + 1); assert.equal(peakActive, Math.min(concurrency, count));
  tools.release?.();
  assert.equal(path.dirname(root), directory);
  await fsPromises.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
  return { totalMs, retainedHeapBytes: retained.heapUsed - initial.heapUsed, retainedRssBytes: retained.rss - initial.rss,
    peakActive, extracts, roundtrips, released, checkpoints, activeReads, resumeMs, resumeReads };
}

try {
  await sample('warmup', 3, 300);
  const samples = [];
  for (let index = 0; index < repetitions; index++) samples.push(await sample(index, projects, unitCount));
  const median = key => samples.map(item => item[key]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  const result = { fixture: 'native-cache-lifecycle-1', node: process.version, cpu: os.cpus()[0]?.model,
    sourceHash: hash(await originalReadFile(path.join(sourceRoot, 'packages/core/native-tools.mjs'))),
    projects, unitsPerProject: unitCount, concurrency, repetitions, warmups: 1,
    median: { totalMs: median('totalMs'), retainedHeapBytes: median('retainedHeapBytes'), retainedRssBytes: median('retainedRssBytes'), resumeMs: median('resumeMs') },
    boundaries: [
      'Generated neutral projects only, no user data, installed application, network or paid model.',
      'The same three active task slots remain available; release happens only after every tool call for that task settles.',
      'Heap/RSS are this isolated Node process, not whole Electron application memory. Explicit GC samples retained V8 heap.',
      'Read counters are logical Node filesystem reads, not physical disk I/O. All source/manifest checks remain active.',
      'Total time includes extraction serialization, active inspection/acceptance, release and forced GC; it is not real-game translation throughput.',
      'Resuming a finished released task reads its persisted result once and performs fresh acceptance, with no extraction repeated.',
    ], samples };
  await fsPromises.mkdir(path.dirname(output), { recursive: true });
  await fsPromises.writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ output: path.basename(output), median: result.median, peakActive: samples[0].peakActive,
    activeReads: samples[0].activeReads, resumeReads: samples[0].resumeReads }));
} finally {
  reads = undefined;
  fsPromises.readFile = originalReadFile; fs.createReadStream = originalCreateReadStream; syncBuiltinESMExports();
  assert.equal(path.dirname(directory), parent);
  await fsPromises.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
}
