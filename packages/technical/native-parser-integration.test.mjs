import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { adaptationTools } from './adaptation.mjs';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';
import { readNativeTargetManifest } from './native-targets.mjs';
import { resolveNativeLocations, scanCoverage } from './coverage.mjs';
import { unitFileMatches } from './adaptation/unit-location.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const parent = path.resolve('local/native-parser-integration-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'case-'));
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
  });
  const gameDir = path.join(root, 'game'), workDir = path.join(root, 'task');
  await mkdir(gameDir); await mkdir(workDir);
  return { root, gameDir, workDir };
}
async function seal(workDir, manifest) {
  const manifestPath = path.join(workDir, 'manifest.json'), raw = JSON.stringify(manifest);
  await mkdir(path.join(workDir, 'technical'), { recursive: true });
  await writeFile(manifestPath, raw);
  await writeFile(path.join(workDir, 'technical/manifest.sha256'), digest(raw));
  return manifestPath;
}

test('normal table Agent tool reaches validated recipe and physical comma-safe output', async t => {
  const f = await fixture(t), file = 'dialogue.csv';
  const before = '\ufeffkey,source,text,voice\r\nintro,"Welcome, traveler",Welcome,voice_01\r\nmenu,Items,Items,voice_02\r\n';
  await writeFile(path.join(f.gameDir, file), before);
  const lab = await createAdapterLab({ dataDir: path.join(f.root, 'lab') });
  const state = { status: 'running', failures: {}, events: [] };
  const session = adaptationTools({ project: { id: 'table-agent', engine: 'Fixture' }, inventory: {},
    lab, gameDir: f.gameDir, workspaceDir: f.workDir, state, assignment: { files: [file] } });
  t.after(async () => { await session.close(); await session.flush(); });
  const selection = { file, keyColumn: 'key', sourceColumn: 'source', targetColumn: 'text', key: 'intro',
    reason: 'Neutral fixture consumer shows the text column; key and voice remain lookup identities.' };
  const denied = await session.tools.write_table_adapter.execute({ selections: [{ ...selection, targetColumn: 'key' }] });
  assert.ok(denied.error, 'normal tool cannot turn key identity into a target');
  const candidate = await session.tools.write_table_adapter.execute({ selections: [selection] });
  assert.equal(candidate.error, undefined, JSON.stringify(candidate.error));
  assert.equal(candidate.selectedTableFields, 1); assert.ok(candidate.candidateId);
  const validation = await session.tools.validate_adapter.execute({ candidateId: candidate.candidateId });
  assert.equal(validation.passed, true, JSON.stringify(validation.error));
  assert.equal(validation.checks.structure, 'passed'); assert.equal(validation.checks.roundtrip, 'passed');
  const submitted = await session.tools.submit_recipe.execute({ candidateId: candidate.candidateId,
    validationId: validation.validationId, metadata: {} });
  assert.equal(submitted.error, undefined, JSON.stringify(submitted.error));
  assert.equal(submitted.accepted, true); assert.equal(submitted.unitCount, 1);
  const extracted = await lab.extractRecipe({ recipeId: submitted.recipeId, gameDir: f.gameDir,
    workspaceDir: path.join(f.root, 'extracted') });
  assert.equal(extracted.units[0].source, 'Welcome');
  assert.equal(extracted.units[0].locator.format, 'table-cell');
  const translation = '\u4f60\u597d, "\u65c5\u884c\u8005"';
  const built = await lab.dispatch('build', { workspaceDir: extracted.workspaceDir,
    outputDir: path.join(f.root, 'output'), translations: [{ id: extracted.units[0].id, translation }] });
  assert.equal(built.checks.structure, 'passed'); assert.equal(built.checks.textReadback, 'passed');
  const expected = before.replace(',Welcome,voice_01', ',"' + translation.replaceAll('"', '""') + '",voice_01');
  assert.equal(await readFile(path.join(built.buildDir, file), 'utf8'), expected);
  assert.equal(await readFile(path.join(f.gameDir, file), 'utf8'), before);
  assert.ok(state.acceptedReceiptRefs?.length, 'normal submit persists its existing acceptance receipt');
});

async function rubyOwnership(t) {
  const f = await fixture(t), sourceFile = '__rgss_scripts__/Data_Scripts/0001.rb', carrier = 'Data/Scripts.rvdata2';
  const prefix = '# \u4e2d\u6587\ud83d\ude00 prefix\n', literal = '"Covered caption"';
  const text = prefix + `draw_text(${literal})\ndraw_text("Uncovered caption")\n`;
  await mkdir(path.dirname(path.join(f.gameDir, sourceFile)), { recursive: true });
  await mkdir(path.join(f.gameDir, 'Data')); await writeFile(path.join(f.gameDir, carrier), 'neutral carrier identity');
  await writeFile(path.join(f.gameDir, sourceFile), text);
  const start = Array.from(text.slice(0, text.indexOf(literal))).length, end = start + Array.from(literal).length;
  const manifest = { schema: 'rpgmaker-ai-work-v1', files: { [carrier]: { sha256: digest('neutral carrier identity') } }, units: {
    owned: { file: carrier, source: 'Covered caption', kind: 'script_display', controls: {}, targets: ['rgss:1:Caption'],
      rgss_script: { schema: 'pinhao-rgss-display-literal-1', sourceFile, viewSha256: digest(text), start, end, literal } }
  } };
  const manifestPath = await seal(f.workDir, manifest);
  const units = [{ id: 'db-unit', legacyId: 'owned', source: 'Covered caption', context: { file: carrier, source_file: sourceFile } }];
  return { ...f, sourceFile, carrier, text, literal, manifestPath, units, inventory: { nativeManifestPath: manifestPath } };
}

test('sealed RGSS source mapping survives emoji and Chinese prefix with precise UTF-8 body bounds', async t => {
  const f = await rubyOwnership(t), manifest = await readNativeTargetManifest({ manifestPath: f.manifestPath });
  assert.equal(manifest.units.owned.rgss_script.sourceFile, f.sourceFile);
  const locations = await resolveNativeLocations({ inventory: f.inventory, units: f.units, roots: [f.gameDir] });
  assert.equal(locations.length, 1);
  const bodyStart = Buffer.byteLength(f.text.slice(0, f.text.indexOf(f.literal) + 1));
  assert.deepEqual([locations[0].file, locations[0].byteStart, locations[0].byteEnd],
    [f.sourceFile, bodyStart, bodyStart + Buffer.byteLength('Covered caption')]);
  assert.equal(locations[0].sourceHash, digest('Covered caption'));
  assert.equal(locations[0].evidence, 'native-rgss-script-display');
  await writeFile(path.join(f.gameDir, f.sourceFile), f.text + '# changed baseline\n');
  assert.deepEqual(await resolveNativeLocations({ inventory: f.inventory, units: f.units, roots: [f.gameDir] }), []);
});

test('sealed command ownership retains only its display segment, never the whole command string', async t => {
  const f = await fixture(t), file = 'data/CommonEvents.json', source = 'Whole source caption';
  const segment = { syntax: 'rpgmaker-plugin-command', prefix: 'NOTICE ', suffix: ' 32' };
  const text = JSON.stringify([null, { id: 1, list: [{ code: 356, parameters: [segment.prefix + source + segment.suffix] }] }]);
  await mkdir(path.join(f.gameDir, 'data')); await writeFile(path.join(f.gameDir, file), text);
  const manifest = { schema: 'rpgmaker-ai-work-v1', files: { [file]: { sha256: digest(text) } },
    units: { owned: { file, source, controls: {}, targets: [[1, 'list', 0, 'parameters', 0]], embedded: { segment } } } };
  const manifestPath = await seal(f.workDir, manifest), inventory = { nativeManifestPath: manifestPath };
  const units = [{ id: 'db-owned', legacyId: 'owned', source, context: { file } }];
  assert.deepEqual((await readNativeTargetManifest({ manifestPath })).units.owned.embedded.segment, segment);
  const locations = await resolveNativeLocations({ inventory, units, roots: [f.gameDir] });
  assert.equal(locations.length, 1); assert.deepEqual(locations[0].segment, segment);
  assert.equal(locations[0].pointer, '/1/list/0/parameters/0');
  assert.equal(locations[0].sourceHash, digest(source));
  assert.notEqual(locations[0].sourceHash, digest(segment.prefix + source + segment.suffix));
  await writeFile(path.join(f.gameDir, file), text.replace(' 32', ' 64'));
  assert.deepEqual(await resolveNativeLocations({ inventory, units, roots: [f.gameDir] }), []);
});

test('source_file navigation does not suppress the other unextracted literal in the same Ruby view', async t => {
  const f = await rubyOwnership(t), unit = f.units[0];
  assert.equal(unitFileMatches(unit, f.sourceFile.replaceAll('/', '\\')), true);
  assert.equal(unitFileMatches(unit, 'other.rb'), false);
  const coverage = await scanCoverage({ rootDir: f.gameDir, inventory: f.inventory, units: f.units, scanCache: false });
  assert.ok(coverage.dynamicCandidates.some(item => item.file === f.sourceFile && item.source === 'Uncovered caption'));
  assert.equal(coverage.dynamicCandidates.some(item => item.file === f.sourceFile && item.source === 'Covered caption'), false);
  assert.equal(coverage.resources.find(item => item.file === f.sourceFile)?.kind, 'display-text-candidate');
});
