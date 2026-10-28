import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createJsonCoverage } from './coverage-json.mjs';
import { scanCoverage } from './coverage.mjs';
import { adaptationTools } from './adaptation.mjs';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

test('a reviewed shape expands every current unowned array position, not its three preview examples', async () => {
  const file = 'content/defs.json';
  const bytes = Buffer.from(JSON.stringify({ chapters: [0, 1].map(chapter => ({ segments: Array.from({ length: 7 }, (_, line) => ({
    fragment: `Sentence ${chapter}-${line}.`, id: `logic-${chapter}-${line}`, resource: 'ui/panel.png',
  })) })) }));
  const units = [{ id: 'owned', source: 'Sentence 0-0.', locator: { file, pointer: '/chapters/0/segments/0/fragment' } }];
  const coverage = await createJsonCoverage({ units });
  const inspected = coverage.inspect(file, bytes);
  const cluster = inspected.unknownClusters.find(item => item.field === 'chapters/*/segments/*/fragment');
  assert.equal(cluster.count, 13); assert.equal(cluster.examples.length, 3);
  const selections = [{ ...cluster, reason: 'Actual scene consumer displays each fragment.' }];
  const expanded = coverage.expandReviewedClusters(file, undefined, { profile: inspected.profile, hash: hash(bytes) }, selections);
  assert.equal(expanded.candidates.length, 13);
  assert.deepEqual(expanded.candidates.map(item => item.locator.pointer), [
    ...Array.from({ length: 6 }, (_, index) => `/chapters/0/segments/${index + 1}/fragment`),
    ...Array.from({ length: 7 }, (_, index) => `/chapters/1/segments/${index}/fragment`),
  ]);
  assert.equal(new Set(expanded.candidates.map(item => item.id)).size, 13);
  assert.ok(expanded.candidates.every(item => item.context.clusterId === cluster.id));
  assert.ok(!expanded.candidates.some(item => item.source.startsWith('logic-') || item.source.endsWith('.png')));
  assert.equal(inspected.unknownClusters[0].examples.length, 3, 'the compact preview is not enlarged or persisted as the full list');
});

test('explicit reviewed expansion is not capped by automatic-candidate preview limits', async () => {
  const file = 'defs.json', bytes = Buffer.from(JSON.stringify({ rows: Array.from({ length: 2305 }, (_, index) => ({ fragment: `Complete sentence ${index}.` })) }));
  const coverage = await createJsonCoverage({ units: [] }), inspected = coverage.inspect(file, bytes);
  const cluster = inspected.unknownClusters[0];
  assert.equal(cluster.count, 2305); assert.equal(cluster.examples.length, 3);
  const expanded = coverage.expandReviewedClusters(file, undefined, { profile: inspected.profile, hash: hash(bytes) }, [{ ...cluster, reason: 'Displayed content' }]);
  assert.equal(expanded.candidates.length, 2305);
  assert.equal(expanded.candidates.at(-1).locator.pointer, '/rows/2304/fragment');
  assert.equal(expanded.truncated, false);
  const expired = coverage.expandReviewedClusters(file, undefined, { profile: inspected.profile, hash: '0'.repeat(64) }, [{ ...cluster, reason: 'Old decision' }]);
  assert.equal(expired.candidates.length, 0);
});

test('reviewed expansion and cached profiles retain shared native identity protection without banning ordinary names', async () => {
  const file = 'data/Map003.json', bytes = Buffer.from(JSON.stringify({ width: 1, height: 1, data: [], events: [],
    bgm: { name: 'Actual_Bgm_Resource', volume: 90, pitch: 100, pan: 0 },
    records: Array.from({ length: 5 }, (_, index) => ({ name: `A displayed name ${index}.` })) }));
  const coverage = await createJsonCoverage({ units: [] }), inspected = coverage.inspect(file, bytes);
  assert.ok(inspected.protectedFields.some(item => item.locator.pointer === '/bgm/name' && item.classification === 'resource_identity'));
  const cluster = inspected.unknownClusters.find(item => item.field === 'records/*/name');
  assert.equal(cluster.count, 5);
  const cached = { profile: inspected.profile, hash: hash(bytes) };
  const expanded = coverage.expandReviewedClusters(file, undefined, cached, [
    { ...cluster, reason: 'Actual UI consumer reads the custom displayed names.' },
    { id: 'unsafe', field: 'bgm/name', evidenceHash: hash(bytes), reason: 'An invalid broad display decision cannot override native identity.' },
  ]);
  assert.equal(expanded.candidates.length, 5);
  assert.ok(expanded.candidates.every(item => item.locator.pointer.startsWith('/records/')));
  assert.ok(expanded.protectedFields.some(item => item.locator.pointer === '/bgm/name'));
  const replay = coverage.inspect(file, undefined, cached);
  assert.deepEqual(replay.protectedFields, inspected.protectedFields);
});

test('real source reads promote an entire cluster and cached replay keeps exact ownership and pagination', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-reviewed-json-')), gameDir = path.join(root, 'source');
  await mkdir(gameDir);
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const file = 'defs.json', text = JSON.stringify({ rows: Array.from({ length: 15 }, (_, index) => ({ fragment: `Scene sentence ${index}.`, id: `entry-${index}` })) });
  await writeFile(path.join(gameDir, file), text);
  const units = [{ id: 'native-first', source: 'Scene sentence 0.', locator: { file, pointer: '/rows/0/fragment' } }];
  const scan = (decisions = [], current = units) => scanCoverage({ rootDir: gameDir, units: current, decisions,
    scanCacheFile: path.join(root, 'scan-index.json') });
  const coverage = await scan(), state = { events: [], failures: {}, observations: [], attempts: 0, status: 'running' };
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab') });
  const session = adaptationTools({ project: { id: 'reviewed-json', engine: 'Unknown' }, inventory: {}, gameDir,
    lab, workspaceDir: path.join(root, 'task'), state, coverage,
    verifyCoverage: ({ coverageDecisions }) => scan(coverageDecisions) });
  try {
    const read = await session.tools.read_resource.execute({ file, length: 65536 });
    assert.ok(read.content.includes('Scene sentence 14.'));
    const cluster = coverage.unknownClusters[0];
    const recorded = await session.tools.record_coverage_decisions.execute({ decisions: [{ id: cluster.id, evidenceHash: cluster.evidenceHash,
      disposition: 'display', reason: 'Read the current full source; fragment values are scene dialogue.' }] });
    assert.equal(recorded.accepted, true, JSON.stringify(recorded));
    const promoted = await scan(recorded.decisions);
    assert.equal(promoted.dynamicCandidates.length, 14);
    assert.equal(promoted.resources.find(item => item.file === file).unresolvedCandidates, 14);
    assert.ok(promoted.dynamicCandidates.some(item => item.locator.pointer === '/rows/14/fragment'));
    const page = await session.tools.inspect_coverage.execute({ offset: 10, limit: 4 });
    assert.equal(page.dynamicCandidates.length, 4);
    const moreOwned = [...units, { id: 'second', source: 'Scene sentence 8.', locator: { file, pointer: '/rows/8/fragment' } }];
    const replay = await scan(recorded.decisions, moreOwned);
    assert.equal(replay.dynamicCandidates.length, 13);
    assert.ok(!replay.dynamicCandidates.some(item => item.locator.pointer === '/rows/8/fragment'));
    assert.ok(replay.dynamicCandidates.some(item => item.locator.pointer === '/rows/14/fragment'));
    assert.equal(replay.scanCache.status, 'restored');
  } finally { await session.flush(); await session.close(); }
});
