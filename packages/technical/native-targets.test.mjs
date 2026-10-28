import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { projectNativeTargets, readNativeTargetManifest } from './native-targets.mjs';
import { scanCoverage, resolveNativeLocations } from './coverage.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const base = os.tmpdir(), root = await mkdtemp(path.join(base, 'pinhao-native-targets-'));
  t.after(async () => {
    const relative = path.relative(base, root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const work = path.join(root, '.git', 'work'); await mkdir(path.join(work, 'technical'), { recursive: true });
  return { root, work, manifestPath: path.join(work, 'manifest.json') };
}

test('compact native target metadata retains exact ownership and excludes repeated scene context', () => {
  const manifest = { schema: 'rpgmaker-ai-work-v1', files: { 'scene.json': { sha256: 'a'.repeat(64) } },
    units: { unit: { file: 'scene.json', source: 'A {{CTRL0001}} line.', controls: { '{{CTRL0001}}': '%1' }, kind: 'dialogue',
      targets: [['text']], contexts: [{ path: ['text'], storyLinks: [{ from: 'a', to: 'b' }], branch: 'hidden' }, { line: 3 }], notes: 'private' } } };
  const projected = projectNativeTargets(manifest, 'b'.repeat(64));
  assert.equal(projected.manifestSha256, 'b'.repeat(64));
  assert.deepEqual(projected.units.unit.contexts, [{ path: ['text'] }]);
  assert.deepEqual(projected.units.unit.targets, [['text']]);
  assert.ok(!JSON.stringify(projected).includes('storyLinks'));
  assert.ok(!JSON.stringify(projected).includes('private'));
});

test('sealed legacy manifest above 64 MiB preserves protected native fields and real plugin candidates', async t => {
  const { root, work, manifestPath } = await fixture(t);
  const file = 'scene.json', source = 'A {{CTRL0001}} protected description.', rawSource = 'A %1 protected description.';
  const data = JSON.stringify({ entries: [{ description: rawSource }, { description: rawSource }], plugin: { text: 'An unextracted plugin sentence.' } });
  await writeFile(path.join(root, file), data);
  const manifest = { schema: 'rpgmaker-ai-work-v1', files: { [file]: { sha256: hash(data) } }, units: {
    owned: { file, source, controls: { '{{CTRL0001}}': '%1' }, targets: [['entries', 0, 'description']], contexts: [{ path: ['entries', 0, 'description'] }] },
  } };
  const head = JSON.stringify(manifest).slice(0, -1) + ',"ignoredContext":"', tail = '"}', chunk = 'x'.repeat(1024 * 1024);
  const digest = createHash('sha256'), handle = await open(manifestPath, 'w');
  try {
    await handle.writeFile(head); digest.update(head);
    for (let index = 0; index < 65; index++) { await handle.writeFile(chunk); digest.update(chunk); }
    await handle.writeFile(tail); digest.update(tail);
  } finally { await handle.close(); }
  const manifestSha256 = digest.digest('hex'); await writeFile(path.join(work, 'technical', 'manifest.sha256'), manifestSha256);
  const units = [{ id: 'db-owned', legacyId: 'owned', source, context: { file } }], inventory = { nativeManifestPath: manifestPath };
  const locations = await resolveNativeLocations({ inventory, units, roots: [root] });
  assert.deepEqual(locations.map(item => [item.pointer, item.sourceHash]), [['/entries/0/description', hash(rawSource)]]);
  const report = await scanCoverage({ rootDir: root, inventory, units });
  assert.deepEqual(report.dynamicCandidates.map(item => item.locator.pointer), ['/entries/1/description', '/plugin/text']);
  assert.equal(report.needsAdaptation, true);
  assert.ok(report.dynamicCandidates.every(item => item.source !== source));
  assert.equal(report.summary.unresolvedCandidates, 2);
});

test('compact index uses matching seals and live file hashes; stale index cannot hide game text', async t => {
  const { root, work, manifestPath } = await fixture(t), file = 'scene.json';
  const data = '{"text":"A neutral sentence."}'; await writeFile(path.join(root, file), data);
  const manifest = { schema: 'rpgmaker-ai-work-v1', files: { [file]: { sha256: hash(data) } }, units: { owned: { file, source: 'A neutral sentence.', targets: [['text']] } } };
  const raw = JSON.stringify(manifest), expected = hash(raw); await writeFile(manifestPath, raw);
  await writeFile(path.join(work, 'technical', 'manifest.sha256'), expected);
  const index = JSON.stringify(projectNativeTargets(manifest, expected));
  await writeFile(path.join(work, 'technical', 'native-targets.json'), index);
  await writeFile(path.join(work, 'technical', 'native-targets.sha256'), hash(index));
  const units = [{ id: 'owned', source: 'A neutral sentence.', context: { file } }], inventory = { nativeManifestPath: manifestPath };
  assert.equal((await resolveNativeLocations({ inventory, units, roots: [root] })).length, 1);
  await writeFile(path.join(root, file), '{"text":"A changed scene sentence."}');
  const changed = await scanCoverage({ rootDir: root, inventory, units });
  assert.equal(changed.dynamicCandidates[0].source, 'A changed scene sentence.');
  await writeFile(manifestPath, raw + ' ');
  assert.equal(await readNativeTargetManifest({ manifestPath }), undefined);
  await writeFile(manifestPath, raw);
  await writeFile(path.join(work, 'technical', 'native-targets.sha256'), '0'.repeat(64));
  assert.equal((await readNativeTargetManifest({ manifestPath })).units.owned.source, 'A neutral sentence.', 'invalid cache is rebuilt from the sealed manifest');
});

test('legacy streaming projection validates skipped JSON and handles chunk boundaries without retaining contexts', async t => {
  const { work, manifestPath } = await fixture(t);
  const manifest = { schema: 'rpgmaker-ai-work-v1', files: {}, units: { neutral: { file: 'text.json', source: '\u4e2d\u6587\ud83d\ude00', targets: [['text']],
    contexts: [{ path: ['text'], storyLinks: 'x'.repeat(65536) + '\\"\u4e2d\u6587' }] } }, ignored: [false, null, -1.2e3, { inner: ['a'] }] };
  const raw = JSON.stringify(manifest);
  await writeFile(manifestPath, raw); await writeFile(path.join(work, 'technical', 'manifest.sha256'), hash(raw));
  const projected = await readNativeTargetManifest({ manifestPath });
  assert.deepEqual(projected, projectNativeTargets(manifest, hash(raw)));
  for (const invalid of [raw.replace('"ignored":', '"ignored":,'), raw.slice(0, -1), raw.replace('"ignored":', '"ignored":['), raw.replace('false', 'fals'), raw.replace('"ignored":', '"ignored":"\\q", "other":')]) {
    await writeFile(manifestPath, invalid); await writeFile(path.join(work, 'technical', 'manifest.sha256'), hash(invalid));
    assert.equal(await readNativeTargetManifest({ manifestPath }), undefined);
  }
  assert.equal((await readFile(path.join(work, 'technical', 'manifest.sha256'), 'utf8')).length, 64);
});
