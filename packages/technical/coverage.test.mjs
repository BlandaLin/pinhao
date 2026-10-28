import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { scanCoverage, resolveNativeLocations } from './coverage.mjs';
import { planAdaptationJobs, scopeAdaptationCoverage } from './adaptation-pool.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const quoted = (file, text, literal, source, last = false) => {
  const start = last ? text.lastIndexOf(literal) : text.indexOf(literal);
  assert.notEqual(start, -1);
  return { file, source, classification: 'display_unresolved', target: {
    start: Array.from(text.slice(0, start)).length, end: Array.from(text.slice(0, start + literal.length)).length, render: 'quoted',
  } };
};

async function fixture(t) {
  const base = os.tmpdir(), root = await mkdtemp(path.join(base, 'pinhao-coverage-'));
  t.after(async () => {
    const relative = path.relative(base, root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  await writeFile(path.join(root, 'known.json'), '{"text":"Known scene."}');
  return { root, known: { id: 'known', source: 'Known scene.', context: { file: 'known.json' }, locator: { file: 'known.json', pointer: '/text' } } };
}

test('resource routes never settle mixed native failures, unknown prose or image review work', async t => {
  const { root, known } = await fixture(t);
  await writeFile(path.join(root, 'title.png'), Buffer.from([137, 80, 78, 71, 0]));
  await writeFile(path.join(root, 'game.pck'), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, 'menu.gdc'), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, 'ambiguous.dat'), 'show_message("An untranslated line.")');
  await writeFile(path.join(root, 'font.fnt'), 'info face="Neutral" size=16');
  const input = { rootDir: root, units: [known], scanCache: false };
  const report = await scanCoverage(input);
  const byFile = new Map(report.resources.map(item => [item.file, item]));
  assert.equal(byFile.get('menu.gdc').route, 'container');
  assert.equal(byFile.get('menu.gdc').kind, 'unclassified');
  assert.equal(byFile.get('ambiguous.dat').route, 'unknown');
  assert.equal(byFile.get('ambiguous.dat').kind, 'display-text-candidate');
  assert.equal(byFile.get('font.fnt').kind, 'unclassified');
  assert.equal(byFile.get('title.png').kind, 'image-candidate');
  assert.deepEqual(planAdaptationJobs(report, { partition: true }).flatMap(job => job.files ?? []), ['ambiguous.dat']);
  const unresolved = await scanCoverage({ ...input, inventory: { reviewItems: [
    { file: 'game.pck', kind: 'archive_adapter_required' }, { file: 'title.png', kind: 'custom_engine_display_schema_required' },
  ] } });
  const files = planAdaptationJobs(unresolved, { partition: true }).flatMap(job => job.files ?? []);
  assert.deepEqual(files.sort(), ['ambiguous.dat', 'game.pck', 'title.png']);
  const scoped = scopeAdaptationCoverage(unresolved, ['game.pck']);
  assert.equal(scoped.summary.resourceRoutes.container, 1);
  assert.equal(scoped.summary.resourceRoutes.image, 0);
  assert.equal(scoped.extractionIssues.length, 1);
  assert.equal(scoped.needsAdaptation, true);
});

test('unknown binary samples never exhaust the known-text budget and compiled consumer edits stay visible', async t => {
  const { root, known } = await fixture(t);
  for (let index = 0; index < 5; index++) await writeFile(path.join(root, `a${index}.dat`), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, 'z-scene.txt'), 'show_message("A scene after binary resources.")');
  const file = 'consumer.dll';
  await writeFile(path.join(root, file), Buffer.from([0, 1, 2]));
  const input = { rootDir: root, units: [known], scanCache: false, sampleFiles: 2 };
  const first = await scanCoverage(input);
  assert.equal(first.resources.find(item => item.file === 'z-scene.txt').kind, 'display-text-candidate');
  assert.equal(first.sampledUnknownResources, 2);
  assert.equal(first.sampledResources, 3);
  assert.ok(first.resources.some(item => item.reviewKind === 'resource-file'), 'a pending resource makes consumer context relevant');
  await writeFile(path.join(root, file), Buffer.from([0, 1, 3]));
  const changed = await scanCoverage(input);
  assert.notEqual(first.sourceContextHash, changed.sourceContextHash, 'same-size compiled consumer edits invalidate the context');
});

test('unknown files stay visible without manufacturing a display task from documentation keywords', async t => {
  const { root, known } = await fixture(t);
  await writeFile(path.join(root, 'framework.config'), '<configuration><section name="message" type="Framework.Handler" /></configuration>');
  await writeFile(path.join(root, 'page.aspx'), '<%@ Page Language="C#" %>\n<!-- description for generated service documentation -->');
  await writeFile(path.join(root, 'dialogue.dat'), '{"text":"A real display-field candidate."}');
  const report = await scanCoverage({ rootDir: root, units: [known], scanCache: false });
  for (const file of ['framework.config', 'page.aspx']) {
    const row = report.resources.find(item => item.file === file);
    assert.equal(row.route, 'unknown');
    assert.equal(row.kind, 'unclassified', 'not a non-display verdict or a hidden resource');
  }
  assert.equal(report.resources.find(item => item.file === 'dialogue.dat').kind, 'display-text-candidate');
  assert.deepEqual(planAdaptationJobs(report, { partition: true }).flatMap(job => job.files ?? []), ['dialogue.dat']);
});

test('searchable source formats do not create broad review jobs or displace established scene checks', async t => {
  const { root, known } = await fixture(t);
  for (let index = 0; index < 5; index++) await writeFile(path.join(root, `a${index}.py`), 'message = "Engine diagnostic label"');
  await writeFile(path.join(root, 'battle.cs'), 'string description = "Audio processing settings";');
  await writeFile(path.join(root, 'z-scene.rpy'), 'message = "A potential player-facing sentence"');
  const report = await scanCoverage({ rootDir: root, units: [known], sampleFiles: 2, scanCache: false });
  for (const file of ['a0.py', 'battle.cs']) {
    const row = report.resources.find(item => item.file === file);
    assert.equal(row.route, 'script'); assert.equal(row.kind, 'script-resource');
  }
  assert.equal(report.resources.find(item => item.file === 'z-scene.rpy').kind, 'display-text-candidate');
  assert.deepEqual(planAdaptationJobs(report, { partition: true }).flatMap(job => job.files ?? []), ['z-scene.rpy']);
});

test('managed Ruby source roots expose literal and indirect display sites without translating all strings', async t => {
  const { root, known } = await fixture(t);
  const source = path.join(root, 'managed');
  await mkdir(path.join(source, '__pinhao_rgss__', 'scripts'), { recursive: true });
  await writeFile(path.join(source, '__pinhao_rgss__/scripts/000001-Window.rb'),
    'class Window_ShopCommand\n  def make_command_list\n    add_command(Vocab::buy, :buy)\n    draw_text(0,0,100,24,"Welcome")\n    hidden = "internal-key"\n  end\nend\n');
  const report = await scanCoverage({ rootDir: root, sourceRoots: [source], inventory: {}, units: [known], scanCache: false });
  const candidates = report.dynamicCandidates.filter(row => row.file.endsWith('.rb'));
  assert.ok(candidates.some(row => row.source === 'Welcome'));
  assert.ok(report.classifiedCandidates.some(row => row.file.endsWith('.rb') && row.requiresAdapter && row.source.includes('Vocab::buy')));
  assert.ok(!candidates.some(row => row.source === 'internal-key'));
  assert.equal(report.needsAdaptation, true);
});

test('sealed native views exclude only unchanged registered engineering metadata, never same-named game JSON', async t => {
  const { root } = await fixture(t);
  const game = path.join(root, 'game'), source = path.join(root, 'native-source'), work = path.join(root, 'work');
  await mkdir(game); await mkdir(source); await mkdir(path.join(work, 'technical'), { recursive: true });
  const file = '__unity_review__/line.json';
  await mkdir(path.join(source, '__unity_review__'));
  const view = JSON.stringify({ entries: [{ path: ['sentences', 0], source: 'A complete line.', kind: 'dialogue',
    codeOrigin: { method: 'System.Void Story::Prepare()' }, displayBinding: { format: 'unity-display-site', version: 'display-protocol' } }] });
  await writeFile(path.join(source, file), view);
  const id = `${file}:00001`, unit = { id, file, source: 'A complete line.', initial_value: 'A complete line.', kind: 'dialogue',
    controls: {}, targets: [['entries', 0, 'source']] };
  const manifestPath = path.join(work, 'manifest.json');
  const rawManifest = JSON.stringify({ schema: 'rpgmaker-ai-work-v1', files: { [file]: { sha256: hash(view), bytes: Buffer.byteLength(view) } }, units: { [id]: unit } });
  await writeFile(manifestPath, rawManifest);
  await writeFile(path.join(work, 'technical', 'manifest.sha256'), hash(rawManifest));
  await writeFile(path.join(work, 'technical', 'product-source.json'), JSON.stringify({ schema: 'pinhao-native-unity-v1', nativeSource: source,
    recordMap: { [file]: { type: 'ManagedMethod', carrier: 'Game_Data/Managed/Assembly-CSharp.dll' } } }));
  const nativeIssue = { file: 'Game_Data/Managed/Assembly-CSharp.dll', kind: 'managed_code_display_schema_required', groupId: 'dynamic', count: 1 };
  const input = { rootDir: game, sourceRoots: [source], inventory: { nativeManifestPath: manifestPath, reviewItems: [nativeIssue] },
    units: [{ id: 'current', legacyId: id, source: unit.source }], scanCache: false };
  const original = await scanCoverage(input);
  assert.equal(original.unknownClusters.length, 0);
  assert.equal(original.dynamicCandidates.length, 0);
  assert.equal(original.unitCount, 1);
  assert.ok(original.resources.some(resource => resource.file === file && resource.classificationEvidence?.rule === 'native-generated-view'));
  assert.equal(original.nativeReviewIssues.length, 1, 'native dynamic/unsupported coverage remains pending');
  await mkdir(path.join(game, '__unity_review__'));
  await writeFile(path.join(game, file), view);
  const sameName = await scanCoverage(input);
  assert.ok(sameName.unknownClusters.some(cluster => cluster.file === file && cluster.field === 'entries/*/codeOrigin/method'));
  assert.equal(sameName.resources.filter(resource => resource.classificationEvidence?.rule === 'native-generated-view').length, 1);
  await writeFile(path.join(source, file), view.replace('A complete line.', 'A replaced line.'));
  const changed = await scanCoverage(input);
  assert.ok(changed.unknownClusters.some(cluster => cluster.examples.some(example => example.source === 'A replaced line.')));
  assert.ok(!changed.resources.some(resource => resource.classificationEvidence?.rule === 'native-generated-view'));
  await writeFile(path.join(source, file), view);
  await writeFile(path.join(work, 'technical', 'manifest.sha256'), '0'.repeat(64));
  const unsealed = await scanCoverage(input);
  assert.ok(!unsealed.resources.some(resource => resource.classificationEvidence?.rule === 'native-generated-view'));
});

test('native schema objects open review without inflating display candidate or font counts', async t => {
  const { root, known } = await fixture(t);
  const file = 'Neutral_Data/resources.assets';
  await mkdir(path.join(root, 'Neutral_Data'));
  await writeFile(path.join(root, file), Buffer.from([0, 1, 2]));
  const reviewItems = [1, 2, 3].map(object => ({ file, object: `@:${object}`, kind: 'custom_monobehaviour_display_schema_required' }));
  reviewItems.push({ file, kind: 'font_typetree_required' }, { file: 'known.json', kind: 'speaker_reference_id' });
  const report = await scanCoverage({ rootDir: root, inventory: { reviewItems }, units: [known] });
  assert.equal(report.needsAdaptation, true);
  assert.deepEqual(report.triggers, ['native-schema-review']);
  assert.equal(report.summary.nativeReviewObjects, 3);
  assert.equal(report.summary.nativeReviewResources, 1);
  assert.equal(report.summary.presentationItems, 1);
  assert.equal(report.summary.unresolvedCandidates, 0);
  assert.equal(report.nativeReviewIssues.length, 1);
  assert.equal(report.extractionIssues.length, 0);
  assert.equal(report.reviewItems.length, 5);
  const settled = await scanCoverage({ rootDir: root, inventory: { reviewItems: reviewItems.slice(-2) }, units: [known] });
  assert.equal(settled.needsAdaptation, false);
  assert.equal(settled.summary.nativeReviewObjects, 0);
});

test('multi-engine required diagnostics retain file recovery and proven non-display classifications', async t => {
  const { root, known } = await fixture(t);
  const reviewItems = [{ file: 'scene.bin', kind: 'custom_engine_display_schema_required', object: 'neutral:1' },
    { file: 'game.arc', kind: 'archive_adapter_required' }, { kind: 'static_or_external_font_requires_adapter' },
    { file: 'scene.bin', kind: 'speaker_reference_id' }];
  const report = await scanCoverage({ rootDir: root, inventory: { reviewItems }, units: [known] });
  assert.equal(report.nativeReviewIssues.length, 1);
  assert.equal(report.extractionIssues.length, 1);
  assert.equal(report.nonTextReviewItems.length, 2);
  assert.deepEqual(report.triggers, ['native-schema-review', 'partial-extraction']);
});

test('one coverage scan shares source reads and the next scan sees same-size edits', async t => {
  const { root, known } = await fixture(t);
  const file = 'caption.js', text = 'drawText("Hello hero");';
  await writeFile(path.join(root, file), text);
  await writeFile(path.join(root, 'unknown.json'), '{"entries":[{"fragment":"A hidden sentence."}]}');
  const candidate = quoted(file, text, '"Hello hero"', 'Hello hero');
  const unit = { id: 'caption', source: 'Hello hero', locator: { file, byteStart: 10, byteEnd: 20 } };
  const original = fs.promises.readFile;
  let reads = 0;
  fs.promises.readFile = async (target, ...args) => {
    if (path.resolve(String(target)) === path.join(root, file)) reads++;
    return original(target, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.promises.readFile = original; syncBuiltinESMExports(); });
  const input = { rootDir: root, inventory: { dynamicCandidates: [candidate] }, units: [known, unit] };
  const first = await scanCoverage(input);
  assert.equal(reads, 1);
  assert.equal(first.displaySites.find(site => site.file === file).status, 'bound');
  await writeFile(path.join(root, file), text.replace('Hello', 'Hullo'));
  const second = await scanCoverage(input);
  assert.equal(reads, 2);
  assert.notEqual(second.sourceContextHash, first.sourceContextHash);
  assert.equal(second.displaySites.find(site => site.file === file).status, 'unresolved');
});

test('large script coverage binds positions directly while retaining every display site', async t => {
  const { root, known } = await fixture(t), file = 'large.js';
  const lines = [], units = [known];
  let offset = 0;
  for (let index = 0; index < 3000; index++) {
    const source = `Scene line ${index}`, line = `drawText("${source}");\n`;
    units.push({ id: `large:${index}`, source, locator: { file, byteStart: offset + 10, byteEnd: offset + 10 + source.length } });
    lines.push(line); offset += line.length;
  }
  await writeFile(path.join(root, file), lines.join(''));
  const report = await scanCoverage({ rootDir: root, units });
  assert.equal(report.displaySites.length, 3000);
  assert.ok(report.displaySites.every(site => site.status === 'bound'));
  assert.equal(report.summary.unresolvedCandidates, 0);
});

test('authoritative native text scans retain their zero-candidate result while unscanned files still receive sampling', async t => {
  const { root, known } = await fixture(t);
  await mkdir(path.join(root, 'scripts'));
  const source = '# message animation helper\nvar icon = "res://icon.png"\n';
  await writeFile(path.join(root, 'scripts/utility.gd'), source);
  const inventory = { coverage: { resources: [{ file: 'scripts/utility.gd', status: 'text_scanned', units: 0 }] } };
  const complete = await scanCoverage({ rootDir: root, inventory, units: [known] });
  assert.equal(complete.needsAdaptation, false);
  assert.equal(complete.resources.find(item => item.file === 'scripts/utility.gd').kind, 'script-resource');
  await writeFile(path.join(root, 'scripts/custom.gd'), source);
  const sampled = await scanCoverage({ rootDir: root, inventory, units: [known] });
  assert.equal(sampled.needsAdaptation, true);
  assert.equal(sampled.resources.find(item => item.file === 'scripts/custom.gd').kind, 'display-text-candidate');
});

test('an explicit unresolved candidate keeps a natively scanned resource in the adaptation queue', async t => {
  const { root, known } = await fixture(t);
  await writeFile(path.join(root, 'utility.gd'), 'var label = "Missing scene."\n');
  const candidate = { file: 'utility.gd', source: 'Missing scene.', classification: 'display_unresolved', target: { start: 12, end: 28, render: 'quoted' } };
  const report = await scanCoverage({ rootDir: root, inventory: { coverage: { resources: [{ file: 'utility.gd', status: 'text_scanned', units: 0 }] }, dynamicCandidates: [candidate] }, units: [known] });
  assert.equal(report.needsAdaptation, true); assert.equal(report.summary.unresolvedCandidates, 1);
});

test('JSON native candidate paths resolve only matching pointers rather than duplicate source strings', async t => {
  const { root, known } = await fixture(t);
  const file = 'scene.json', source = 'Repeated neutral scene.';
  await writeFile(path.join(root, file), JSON.stringify({ entries: [source, source] }));
  const first = { file, source, classification: 'display_unresolved', path: ['entries', 0], target: { start: 12, end: 37, render: 'quoted' } };
  const second = { file, source, classification: 'display_unresolved', locator: { file, pointer: '/entries/1' } };
  const unit = { id: 'extra:0', source, context: { file }, locator: { file, pointer: '/entries/0' } };
  const inventory = { dynamicCandidates: [first, second], coverage: { resources: [{ file, status: 'display_candidates', units: 0 }] } };
  const partial = await scanCoverage({ rootDir: root, inventory, units: [known, unit] });
  assert.equal(partial.summary.resolvedCandidates, 1);
  assert.equal(partial.summary.unresolvedCandidates, 1);
  assert.deepEqual(partial.dynamicCandidates, [second]);
  const complete = await scanCoverage({ rootDir: root, inventory, units: [known, unit, { ...unit, id: 'extra:1', locator: { file, pointer: '/entries/1' } }] });
  assert.equal(complete.needsAdaptation, false); assert.equal(complete.summary.resolvedCandidates, 2);
});

test('JSON candidate ownership verifies real resource values, escaped pointers and protected source evidence', async t => {
  const { root, known } = await fixture(t);
  const file = 'scene.json', source = 'Line\nwith %1 protected.';
  await writeFile(path.join(root, file), JSON.stringify({ 'a~/b': source }));
  const candidate = { file, source, classification: 'display_unresolved', path: ['a~/b'], target: { start: 9, end: 36, render: 'quoted' } };
  const unit = { id: 'extra:0', source: 'Line{{CTRL0001}}with {{CTRL0002}} protected.', context: { file, adaptationLocator: { file, pointer: '/a~0~1b' }, adaptationSourceHash: hash(source) } };
  const inventory = { dynamicCandidates: [candidate], coverage: { resources: [{ file, status: 'display_candidates', units: 0 }] } };
  const report = await scanCoverage({ rootDir: root, inventory, units: [known, unit] });
  assert.equal(report.needsAdaptation, false); assert.equal(report.summary.resolvedCandidates, 1);
  const wrong = await scanCoverage({ rootDir: root, inventory, units: [known, { ...unit, context: { ...unit.context, adaptationSourceHash: hash('wrong baseline') } }] });
  assert.equal(wrong.needsAdaptation, true); assert.equal(wrong.summary.resolvedCandidates, 0);
  const restored = await scanCoverage({ rootDir: root, inventory, units: [known, { ...unit, context: { file }, locator: unit.context.adaptationLocator, controls: { '{{CTRL0001}}': '\n', '{{CTRL0002}}': '%1' } }] });
  assert.equal(restored.needsAdaptation, false);
  await writeFile(path.join(root, file), JSON.stringify({ 'a~/b': 'Resource changed.' }));
  const stale = await scanCoverage({ rootDir: root, inventory, units: [known, unit] });
  assert.equal(stale.needsAdaptation, true); assert.equal(stale.summary.resolvedCandidates, 0);
});

test('font-family arrays classify runtime identities while identical names in dialogue remain display candidates', async t => {
  const { root, known } = await fixture(t);
  const file = 'theme.gd', text = '# 中文😀\nvar font = SystemFont.new()\nfont.font_names = PackedStringArray(["Craft Serif", "Tower Sans"])\nlabel.text = "Craft Serif"\n';
  await writeFile(path.join(root, file), text);
  const candidates = [quoted(file, text, '"Craft Serif"', 'Craft Serif'), quoted(file, text, '"Tower Sans"', 'Tower Sans'), quoted(file, text, '"Craft Serif"', 'Craft Serif', true)];
  const report = await scanCoverage({ rootDir: root, inventory: { dynamicCandidates: candidates }, units: [known] });
  assert.equal(report.summary.nonDisplayCandidates, 2);
  assert.deepEqual(report.dynamicCandidates, [candidates[2]]);
  const classified = report.classifiedCandidates.slice(0, 2);
  assert.ok(classified.every(item => item.classification === 'resource_identity' && item.classificationEvidence.rule === 'font-family-field' && item.classificationEvidence.field === 'font.font_names'));
});

test('JavaScript and Python configuration fields use syntax context rather than font-name text', async t => {
  const { root, known } = await fixture(t);
  const sources = { 'theme.js': 'view.style.fontFamily = "A Future Typeface"; const theme = {"font_names": ["A Future Typeface", "Another Typeface"]}; say("A Future Typeface");',
    'theme.py': 'view.font_family = ("A Future Typeface", "Another Typeface")\nsay("A Future Typeface")\n' };
  const candidates = [];
  for (const [file, text] of Object.entries(sources)) {
    await writeFile(path.join(root, file), text);
    let offset = 0;
    for (const match of text.matchAll(/"([^"]+)"/g)) {
      if (match[1] === 'font_names') continue;
      const candidate = quoted(file, text.slice(offset), match[0], match[1]);
      candidate.target.start += Array.from(text.slice(0, offset)).length;
      candidate.target.end += Array.from(text.slice(0, offset)).length;
      candidates.push(candidate); offset = match.index + match[0].length;
    }
  }
  const report = await scanCoverage({ rootDir: root, inventory: { dynamicCandidates: candidates }, units: [known] });
  assert.equal(report.summary.nonDisplayCandidates, 5);
  assert.equal(report.dynamicCandidates.length, 2);
  assert.ok(report.dynamicCandidates.every(item => item.source === 'A Future Typeface'));
});

test('identity calls classify only structural arguments and retain emitted dialogue payloads', async t => {
  const { root, known } = await fixture(t);
  const file = 'ui.gd', text = 'font.set_font_names(PackedStringArray(["A Future Typeface"]))\nload("An asset reference")\nemit_signal("spoken_line", "A Future Typeface")\n';
  await writeFile(path.join(root, file), text);
  const candidates = [quoted(file, text, '"A Future Typeface"', 'A Future Typeface'), quoted(file, text, '"An asset reference"', 'An asset reference'),
    quoted(file, text, '"spoken_line"', 'spoken_line'), quoted(file, text, '"A Future Typeface"', 'A Future Typeface', true)];
  const report = await scanCoverage({ rootDir: root, inventory: { dynamicCandidates: candidates }, units: [known] });
  assert.equal(report.summary.nonDisplayCandidates, 3);
  assert.deepEqual(report.dynamicCandidates, [candidates[3]]);
});

test('JSON font and resource fields carry classification evidence while ordinary prose retains font names', async t => {
  const { root, known } = await fixture(t);
  const file = 'theme.json', data = { content: { fontFamily: 'A Future Typeface', theme: { font: { family: 'Another Typeface' } }, asset_path: 'Readable asset reference', text: 'A Future Typeface' } };
  await writeFile(path.join(root, file), JSON.stringify(data));
  const report = await scanCoverage({ rootDir: root, units: [known] });
  assert.equal(report.summary.nonDisplayCandidates, 3);
  assert.deepEqual(report.dynamicCandidates.map(item => item.path), [['content', 'text']]);
  assert.ok(report.classifiedCandidates.every(item => item.classificationEvidence.evidence === 'json-field-source'));
});

test('stale and commented font contexts never suppress a display candidate', async t => {
  const { root, known } = await fixture(t);
  const file = 'theme.gd', text = '# font_names = [\nlabel.text = "A Future Typeface"\nfont.font_names = ["Current Typeface"]\n';
  await writeFile(path.join(root, file), text);
  const candidates = [quoted(file, text, '"A Future Typeface"', 'A Future Typeface'), quoted(file, text, '"Current Typeface"', 'Old Typeface')];
  const report = await scanCoverage({ rootDir: root, inventory: { dynamicCandidates: candidates }, units: [known] });
  assert.equal(report.summary.nonDisplayCandidates, 0);
  assert.deepEqual(report.dynamicCandidates, candidates);
});

test('native sealed quoted targets resolve exact Unicode byte positions and JSON paths without conflating repeated text', async t => {
  const { root, known } = await fixture(t);
  const script = '# 中文😀\nvar a = "Hello %1"\nvar b = "Hello %1"\n', file = 'view.gd';
  const data = JSON.stringify({ entries: ['Hello %1', 'Hello %1'] });
  await writeFile(path.join(root, file), '\uFEFF' + script);
  await writeFile(path.join(root, 'scene.json'), data);
  const firstScript = quoted(file, script, '"Hello %1"', 'Hello %1');
  const secondScript = quoted(file, script, '"Hello %1"', 'Hello %1', true);
  const firstJson = quoted('scene.json', data, '"Hello %1"', 'Hello %1');
  firstJson.path = ['entries', 0];
  const secondJson = { ...quoted('scene.json', data, '"Hello %1"', 'Hello %1', true), path: ['entries', 1] };
  const source = 'Hello {{CTRL0001}}', controls = { '{{CTRL0001}}': '%1' };
  const units = [known, { id: 'db-a', legacyId: 'native-a', source, context: { file, line: 2 } },
    { id: 'db-json', legacyId: 'native-json', source, context: { file: 'scene.json', path: ['entries', 0] } }];
  const manifest = { schema: 'rpgmaker-ai-work-v1', files: { [file]: { sha256: hash('\uFEFF' + script) }, 'scene.json': { sha256: hash(data) } }, units: {
    'native-a': { file, source, controls, targets: [firstScript.target], contexts: [{ line: 2 }] },
    'native-json': { file: 'scene.json', source, controls, targets: [firstJson.target], contexts: [{ path: ['entries', 0] }] },
  } };
  const work = path.join(root, '.git', 'work'); await mkdir(path.join(work, 'technical'), { recursive: true });
  const rawManifest = JSON.stringify(manifest), manifestPath = path.join(work, 'manifest.json');
  await writeFile(manifestPath, rawManifest); await writeFile(path.join(work, 'technical', 'manifest.sha256'), hash(rawManifest));
  const inventory = { nativeManifestPath: manifestPath, dynamicCandidates: [firstScript, secondScript, firstJson, secondJson] };
  const report = await scanCoverage({ rootDir: root, inventory, units });
  assert.equal(report.summary.resolvedCandidates, 2);
  assert.deepEqual(report.dynamicCandidates, [secondScript, secondJson]);
  assert.ok(report.resolvedCandidates.every(item => item.evidence.startsWith('native-manifest-') && item.hashes.manifestSha256 === hash(rawManifest)));
  const locations = await resolveNativeLocations({ inventory, units, roots: [root] });
  const scriptPosition = locations.find(item => item.file === file);
  assert.equal(scriptPosition.byteStart, Buffer.byteLength('\uFEFF' + script.slice(0, script.indexOf('"Hello %1"') + 1)));
  assert.equal(scriptPosition.sourceHash, hash('Hello %1'));
  assert.ok(locations.some(item => item.file === 'scene.json' && item.pointer === '/entries/0'));
  assert.ok(!locations.some(item => item.pointer === '/entries/1'));
  await writeFile(path.join(work, 'technical', 'manifest.sha256'), '0'.repeat(64));
  assert.deepEqual(await resolveNativeLocations({ inventory, units, roots: [root] }), []);
  await writeFile(path.join(work, 'technical', 'manifest.sha256'), hash(rawManifest));
  await writeFile(path.join(root, file), '\uFEFF' + script + '# changed bytes\n');
  assert.ok(!(await resolveNativeLocations({ inventory, units, roots: [root] })).some(item => item.file === file));
  assert.ok(!(await resolveNativeLocations({ inventory, units: units.map(unit => unit.legacyId === 'native-json' ? { ...unit, source: 'A different source.' } : unit), roots: [root] })).some(item => item.file === 'scene.json'));
});

test('native JSON context paths verify original fields and keep equal text at other locations pending', async t => {
  const { root, known } = await fixture(t);
  const file = 'scene.json', source = 'Repeated whole scene.';
  await writeFile(path.join(root, file), JSON.stringify({ entries: [source, source] }));
  const candidates = [0, 1].map(index => ({ file, source, path: ['entries', index], classification: 'display_unresolved' }));
  const unit = { id: 'native', source, context: { file, path: ['entries', 0] } };
  const report = await scanCoverage({ rootDir: root, inventory: { dynamicCandidates: candidates }, units: [known, unit] });
  assert.equal(report.summary.resolvedCandidates, 1);
  assert.deepEqual(report.dynamicCandidates, [candidates[1]]);
});

test('native JSON array-path ownership does not construct quoted character-offset tables', async t => {
  const { root } = await fixture(t), file = 'map.json', source = 'A neutral protected %1 description.';
  const data = JSON.stringify({ tiles: Array(10000).fill(0), description: source });
  await writeFile(path.join(root, file), data);
  const work = path.join(root, '.git', 'work'); await mkdir(path.join(work, 'technical'), { recursive: true });
  const manifest = JSON.stringify({ schema: 'rpgmaker-ai-work-v1', files: { [file]: { sha256: hash(data) } }, units: {
    native: { file, source: 'A neutral protected {{CTRL0001}} description.', controls: { '{{CTRL0001}}': '%1' }, targets: [['description']] },
  } });
  const manifestPath = path.join(work, 'manifest.json');
  await writeFile(manifestPath, manifest); await writeFile(path.join(work, 'technical', 'manifest.sha256'), hash(manifest));
  const original = Buffer.byteLength;
  let characterOffsets = 0;
  Buffer.byteLength = (value, ...args) => { if (typeof value === 'string' && Array.from(value).length === 1) characterOffsets++; return original(value, ...args); };
  let locations;
  try {
    locations = await resolveNativeLocations({ inventory: { nativeManifestPath: manifestPath },
      units: [{ id: 'native', source: 'A neutral protected {{CTRL0001}} description.' }], roots: [root] });
  } finally { Buffer.byteLength = original; }
  assert.equal(characterOffsets, 0);
  assert.equal(locations.length, 1);
  assert.equal(locations[0].pointer, '/description');
  assert.equal(locations[0].sourceHash, hash(source));
});

test('JSON Schema documents retain technical evidence without scheduling their documentation as game text', async t => {
  const { root, known } = await fixture(t);
  const file = 'arbitrary-name.json';
  await writeFile(path.join(root, file), JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', $id: 'https://example.invalid/data-schema',
    title: 'Resource format', description: 'Documentation for a resource validator.', type: 'object', properties: { text: { type: 'string', description: 'Displayed scene text.' } },
    defaultSnippets: [{ label: 'New resource', body: { text: 'A neutral example.' } }] }));
  const candidate = { file, source: 'Resource format', path: ['title'], classification: 'display_unresolved' };
  const report = await scanCoverage({ rootDir: root, units: [known], inventory: { dynamicCandidates: [candidate] } });
  assert.equal(report.needsAdaptation, false);
  assert.equal(report.summary['technical-metadata'], 1);
  assert.equal(report.summary.unresolvedCandidates, 0);
  assert.equal(report.summary.nonDisplayCandidates, 5);
  assert.ok(report.classifiedCandidates.every(item => item.classification === 'technical_metadata' && item.classificationEvidence.rule === 'json-schema-document'));
  assert.equal(report.resources.find(item => item.file === file).classificationEvidence.dialect, 'http://json-schema.org/draft-07/schema#');
});

test('schema-linked game data, locale tables and credits retain display text regardless of directory names', async t => {
  const { root, known } = await fixture(t);
  for (const [file, value] of Object.entries({
    'schemas/runtime.json': { $schema: '../schemas/scene.schema.json', title: 'A neutral scene', type: 'object', properties: { description: 'Runtime description.' } },
    'languages/EN/items.json': { item: { description: 'A neutral item.' } },
    'CREDITS.json': [{ title: 'Contributors', content: 'A neutral contribution.' }],
    'schema-label-only.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', description: 'A scene carrying a label.' },
  })) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), JSON.stringify(value));
  }
  const report = await scanCoverage({ rootDir: root, units: [known] });
  assert.equal(report.summary['technical-metadata'], 0);
  assert.ok(['schemas/runtime.json', 'languages/EN/items.json', 'CREDITS.json', 'schema-label-only.json'].every(file => report.resources.find(item => item.file === file).kind === 'display-text-candidate'));
  assert.ok(report.dynamicCandidates.some(item => item.file === 'languages/EN/items.json' && item.locator.pointer === '/item/description'));
});
