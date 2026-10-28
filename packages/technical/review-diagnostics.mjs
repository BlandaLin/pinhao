import { createHash } from 'node:crypto';

export const REVIEW_DIAGNOSTICS_VERSION = 1;

export const reviewResourcePath = item => {
  const value = item?.file ?? item?.carrier ?? item?.locator?.file ?? item?.context?.file;
  return typeof value === 'string' ? value.replace(/^res:\/\//, '').replaceAll('\\', '/').replace(/^\.\//, '') : '';
};

const categories = new Map([
  ['native-schema', 'native-schema'], ['native_schema', 'native-schema'], ['schema-review', 'native-schema'], ['native-review', 'native-schema'],
  ['extraction-failure', 'extraction-failure'], ['extraction_failure', 'extraction-failure'], ['presentation', 'presentation'], ['font-layout', 'presentation'],
  ['non-display', 'non-display'], ['control-flow-label', 'non-display'], ['logic_identity', 'non-display'], ['resource_identity', 'non-display'],
  ['technical_metadata', 'non-display'], ['debug_output', 'non-display'], ['info', 'info'],
]);

/** Diagnostic categories describe the next operation, not a count of dialogue. */
export function classifyReviewItem(item = {}) {
  if (['resolved', 'extracted', 'passed'].includes(item.status)) return 'info';
  if (item.disposition === 'non-display') return 'non-display';
  const explicit = categories.get(item.diagnostic?.category ?? item.category ?? item.classification);
  if (explicit) return explicit;
  const code = `${item.kind ?? ''} ${item.code ?? ''}`.toLowerCase().replaceAll('-', '_');
  if (/(?:^|_)(?:font|glyph|atlas)(?:_|\s|$)/.test(code)) return 'presentation';
  if (/(?:speaker_reference_id|(?:^|_)non_display(?:_|\s|$)|game_title_save_identity|control_flow_label)/.test(code)) return 'non-display';
  const required = /(?:^|_)(?:requires?|required|unsupported|unreadable|failed|failure|missing|error)(?:_|\s|$)/.test(code);
  if (required && /(?:schema|typetree|component|monobehaviour|display_field)/.test(code)
      && !/(?:failed|unreadable|error)/.test(code)) return 'native-schema';
  if (required || /(?:recovery_partial|nonliteral_display_property|godot_json_resource|godot_managed_code|godot_additional_packs)/.test(code)) return 'extraction-failure';
  return 'info';
}

function groupOf(item) {
  const value = item.group ?? item.scriptIdentity ?? item.classIdentity ?? item.schemaGroup;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return JSON.stringify(value);
  if (item.script && typeof item.script === 'object') return JSON.stringify([item.script.assembly ?? '', item.script.namespace ?? '', item.script.className ?? '']);
  const namespace = item.namespace ?? item.scriptNamespace;
  const name = item.className ?? item.scriptClass;
  return name ? `${namespace ?? ''}:${name}` : '';
}

const quantity = item => Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 1;

export function summarizeReviewDiagnostics({ nativeReviewIssues = [], presentationItems = [] } = {}) {
  return {
    nativeReviewObjects: nativeReviewIssues.reduce((sum, item) => sum + quantity(item), 0),
    nativeReviewResources: new Set(nativeReviewIssues.map(reviewResourcePath).filter(Boolean)).size,
    nativeReviewGroups: nativeReviewIssues.length,
    presentationItems: presentationItems.length,
  };
}

/** One schema issue per carrier/type retains a bounded sample of its objects. */
export function groupReviewDiagnostics(items = []) {
  const groups = new Map(), seen = new Set();
  const extractionIssues = [], presentationItems = [], nonTextReviewItems = [], informationalItems = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const category = classifyReviewItem(item);
    if (category === 'presentation') { presentationItems.push({ ...item, classification: 'font-layout' }); continue; }
    if (category === 'non-display') { nonTextReviewItems.push(item); continue; }
    if (category === 'extraction-failure') { extractionIssues.push(item); continue; }
    if (category !== 'native-schema') { informationalItems.push(item); continue; }
    const file = reviewResourcePath(item), kind = item.kind ?? item.code ?? 'native-schema', group = groupOf(item);
    const identity = JSON.stringify([file, kind, group]);
    const object = item.object ?? item.objectId ?? item.locator?.object;
    const objectIdentity = object === undefined ? undefined : JSON.stringify([identity, object]);
    if (objectIdentity && seen.has(objectIdentity)) continue;
    if (objectIdentity) seen.add(objectIdentity);
    if (!groups.has(identity)) groups.set(identity, { id: `native-review-${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`,
      file, kind, category: 'native-schema', ...(group ? { group } : {}), count: 0, examples: [] });
    const entry = groups.get(identity);
    entry.count += quantity(item);
    if (entry.examples.length < 3) entry.examples.push({ ...(object !== undefined ? { object } : {}),
      ...(typeof item.name === 'string' ? { name: item.name } : {}), ...(typeof item.detail === 'string' ? { detail: item.detail } : {}) });
  }
  const nativeReviewIssues = [...groups.values()];
  const result = { nativeReviewIssues, extractionIssues, presentationItems, nonTextReviewItems, informationalItems };
  return { ...result, version: REVIEW_DIAGNOSTICS_VERSION, summary: summarizeReviewDiagnostics(result) };
}

/** Accepted changes invalidate the last scan, not its recorded candidate counts. */
export function markCoverageStale(coverage, addedUnits = 0) {
  if (!coverage) return coverage;
  return { ...coverage, stale: true,
    addedUnitsSinceScan: (coverage.stale ? coverage.addedUnitsSinceScan ?? 0 : 0) + addedUnits };
}

/** Keep text candidates, native components, and resource checks in their own units. */
export function describeRemainingCoverage(coverage = {}) {
  if (coverage.stale) return `${coverage.addedUnitsSinceScan > 0 ? `已接入 ${coverage.addedUnitsSinceScan} 条文字` : '已保存新的适配成果'}；剩余文件待重新核对`;
  const summary = coverage.summary ?? {};
  const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
  const groups = groupReviewDiagnostics(coverage.reviewItems ?? [...(coverage.nativeReviewIssues ?? []), ...(coverage.extractionIssues ?? [])]);
  const candidates = count(summary.unresolvedCandidates);
  const components = groups.summary.nativeReviewObjects || (coverage.reviewItems ? 0 : count(summary.nativeReviewObjects));
  const files = new Set([...groups.extractionIssues.map(reviewResourcePath),
    ...(coverage.resources ?? []).filter(item => item.kind === 'display-text-candidate').map(item => item.file)].filter(Boolean));
  const parts = [];
  if (candidates) parts.push(`${candidates} 处文字候选待确认`);
  if (components) parts.push(`${components} 个原生组件待适配`);
  if (files.size) parts.push(`${files.size} 个资源文件需要检查`);
  else if (groups.extractionIssues.length) parts.push('仍有提取问题需要处理');
  return parts.join('；') || '部分资源仍需检查';
}
