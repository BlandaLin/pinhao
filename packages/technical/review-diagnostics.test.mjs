import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReviewItem, groupReviewDiagnostics, describeRemainingCoverage, markCoverageStale, REVIEW_DIAGNOSTICS_VERSION } from './review-diagnostics.mjs';

test('legacy diagnostic naming in either direction opens the appropriate operation', () => {
  for (const kind of ['custom_monobehaviour_display_schema_required', 'engine_component_schema_requires_adapter', 'requires_native_schema']) {
    assert.equal(classifyReviewItem({ kind }), 'native-schema', kind);
  }
  for (const kind of ['unity_carrier_adapter_required', 'compiled_script_requires_decompiler', 'archive_recipe_required', 'requires_archive_adapter', 'unsupported_source_statement', 'custom_parser_failed', 'missing_payload']) {
    assert.equal(classifyReviewItem({ kind }), 'extraction-failure', kind);
  }
  assert.equal(classifyReviewItem({ kind: 'new_engine_object', diagnostic: { category: 'native-schema' } }), 'native-schema');
});

test('display preparation and proven identities remain distinct from text extraction', () => {
  for (const kind of ['static_or_external_font_requires_adapter', 'tmp_font_atlas_requires_separate_font_adapter', 'font_typetree_required', 'glyph_missing']) {
    assert.equal(classifyReviewItem({ kind }), 'presentation', kind);
  }
  for (const item of [{ kind: 'speaker_reference_id' }, { kind: 'lcf_non_display_string' }, { kind: 'game_title_save_identity' },
    { kind: 'unsupported_source_statement', classification: 'control-flow-label' }, { kind: 'requires_schema', disposition: 'non-display' }]) {
    assert.equal(classifyReviewItem(item), 'non-display');
  }
  assert.equal(classifyReviewItem({ kind: 'schema_required', status: 'resolved' }), 'info');
});

test('large object diagnostics are grouped by carrier and script with bounded samples', () => {
  const items = Array.from({ length: 23883 }, (_, index) => ({ file: index % 2 ? 'Game_Data/level0' : 'Game_Data/sharedassets0.assets',
    object: `@: ${index}`, kind: 'custom_monobehaviour_display_schema_required', script: { assembly: 'Game.dll', namespace: 'Neutral', className: 'DialoguePresenter' } }));
  const result = groupReviewDiagnostics([...items, items[0], { kind: 'tmp_font_atlas_requires_separate_font_adapter', file: 'Game_Data/level0' },
    { kind: 'static_or_external_font_requires_adapter', file: 'Game_Data/level0' }, { kind: 'speaker_reference_id', file: 'story.json' }]);
  assert.equal(result.version, REVIEW_DIAGNOSTICS_VERSION);
  assert.equal(result.nativeReviewIssues.length, 2);
  assert.equal(result.summary.nativeReviewObjects, 23883);
  assert.equal(result.summary.nativeReviewResources, 2);
  assert.equal(result.summary.presentationItems, 2);
  assert.equal(result.extractionIssues.length, 0);
  assert.ok(result.nativeReviewIssues.every(issue => issue.examples.length === 3));
  assert.ok(JSON.stringify(result.nativeReviewIssues).length < 2000);
  assert.deepEqual(groupReviewDiagnostics(items).nativeReviewIssues, result.nativeReviewIssues);
});

test('different types share a carrier job while retaining separate review groups', () => {
  const file = 'Game_Data/resources.assets', kind = 'custom_monobehaviour_display_schema_required';
  const result = groupReviewDiagnostics([{ file, kind, object: '@:1', script: { className: 'Dialogue' } },
    { file, kind, object: '@:2', script: { className: 'Inventory' } }, { file, kind: 'unity_carrier_adapter_required', detail: 'Neutral load failure' }]);
  assert.equal(result.nativeReviewIssues.length, 2);
  assert.equal(result.summary.nativeReviewResources, 1);
  assert.equal(result.extractionIssues.length, 1);
});

test('remaining coverage describes native failures without calling their fields text units', () => {
  const coverage = { needsAdaptation: true, summary: { unresolvedCandidates: 0 }, reviewItems: [
    { kind: 'native_record_roundtrip_failed', category: 'extraction-failure', file: 'data/GameSettings.rbr',
      object: 'native-record', candidateCount: 214, originalPreserved: true },
  ] };
  assert.equal(describeRemainingCoverage(coverage), '1 个资源文件需要检查');
  assert.doesNotMatch(describeRemainingCoverage(coverage), /0|214/);
});

test('remaining coverage keeps different measurement units separate and deduplicates resource files', () => {
  const coverage = { summary: { unresolvedCandidates: 4 }, reviewItems: [
    { category: 'native-schema', file: 'objects.assets', kind: 'display_schema_required', count: 7 },
    { category: 'extraction-failure', file: 'archive.bin', kind: 'record_failed', object: 'one' },
    { category: 'extraction-failure', file: 'archive.bin', kind: 'record_failed', object: 'two' },
  ], resources: [{ file: 'story.dat', kind: 'display-text-candidate' }] };
  assert.equal(describeRemainingCoverage(coverage), '4 处文字候选待确认；7 个原生组件待适配；2 个资源文件需要检查');
});

test('remaining coverage uses projected diagnostics and never invents a zero-work result', () => {
  assert.equal(describeRemainingCoverage({ nativeReviewIssues: [{ category: 'native-schema', count: 12 }] }), '12 个原生组件待适配');
  assert.equal(describeRemainingCoverage({ summary: { nativeReviewObjects: 3 } }), '3 个原生组件待适配');
  assert.equal(describeRemainingCoverage({ reviewItems: [{ category: 'extraction-failure', kind: 'unreadable' }] }), '仍有提取问题需要处理');
  assert.equal(describeRemainingCoverage({ needsAdaptation: true, summary: { unresolvedCandidates: 0 } }), '部分资源仍需检查');
  assert.equal(describeRemainingCoverage({ reviewItems: [{ kind: 'schema_required', status: 'resolved' }], summary: { nativeReviewObjects: 9 } }), '部分资源仍需检查');
});

test('accepted increments mark an immutable scan stale without subtracting unlike candidate counts', () => {
  const snapshot = { unitCount: 2100, summary: { unresolvedCandidates: 1115 }, scannedAt: 'before-acceptance' };
  const stale = markCoverageStale(markCoverageStale(snapshot, 24), 60);
  assert.equal(stale.unitCount, 2100);
  assert.equal(stale.summary.unresolvedCandidates, 1115);
  assert.equal(snapshot.stale, undefined);
  assert.equal(stale.addedUnitsSinceScan, 84);
  assert.equal(describeRemainingCoverage(stale), '已接入 84 条文字；剩余文件待重新核对');
  assert.doesNotMatch(describeRemainingCoverage(stale), /1115|1,115/);
  assert.equal(describeRemainingCoverage(markCoverageStale(snapshot)), '已保存新的适配成果；剩余文件待重新核对');
  assert.equal(markCoverageStale(undefined, 4), undefined);
});
