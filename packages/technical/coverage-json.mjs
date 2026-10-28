import { createHash } from 'node:crypto';
import { jsonFieldIdentity } from './json-field-policy.mjs';
import { jsonStringSpans, embeddedExpression } from './embedded-text.mjs';

const normalize = value => typeof value === 'string' ? value.replace(/^res:\/\//, '').replaceAll('\\', '/').replace(/^\.\//, '') : '';
const pointer = parts => '/' + parts.map(part => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
const displayFields = new Set(['text', 'texts', 'line', 'lines', 'paragraph', 'paragraphs', 'dialog', 'dialogue', 'message', 'messages', 'description', 'desc', 'body', 'content', 'caption', 'title', 'tooltip', 'hint', 'prompt', 'say', 'label', 'speaker']);
const identityField = /^(?:id|\w+id|key|code|script|scripts|expression|condition|conditions|logic|flags|tags|type|mode|target|trigger|path|file|texture|image|cg|asset|assets|resources|resource|metadata|url|uri)$/i;
const resourceValue = value => /^(?:res|user):\/\//i.test(value) || /^(?:\.\.?[\\/]|[A-Za-z]:[\\/])/.test(value)
  || /^[^\r\n<>"']+\.(?:png|jpe?g|webp|bmp|gif|svg|ogg|wav|mp3|mp4|webm|ttf|otf|woff2?|gd|gdc|tscn|tres|json|js|rpy|rpyc)$/i.test(value.trim());

// Only these many display-eligible leaves are retained per file; a larger document stays replayed
// from its own bytes so an oversized profile can never truncate a later scan's candidate list.
const MAX_PROFILE_LEAVES = 12000;

/** Exact field ownership is independent of whether another string in the file was extracted. */
export async function createJsonCoverage({ units, signal, rootMetadata = () => undefined }) {
  const locations = new Map(), fallback = new Map(), seenFallback = new Set();
  const add = (file, value, unit) => {
    file = normalize(file);
    if (!file || typeof value !== 'string') return;
    const pointers = locations.get(file) ?? new Map(), rows = pointers.get(value) ?? [];
    rows.push(unit); pointers.set(value, rows); locations.set(file, pointers);
  };
  for (const unit of units) {
    const locator = unit.locator ?? unit.context?.adaptationLocator;
    const file = normalize(locator?.file ?? unit.context?.file ?? unit.file);
    const paths = [unit.context?.path, unit.context?.field].filter(Array.isArray);
    if (typeof locator?.pointer === 'string') add(file, locator.pointer, unit);
    for (const parts of paths) add(file, pointer(parts), unit);
    if (!locator && !paths.length && typeof unit.source === 'string') {
      const identity = JSON.stringify([file, unit.legacyId ?? unit.id ?? unit.context, unit.source]);
      if (seenFallback.has(identity)) continue;
      seenFallback.add(identity);
      const bySource = fallback.get(file) ?? new Map();
      bySource.set(unit.source, (bySource.get(unit.source) ?? 0) + 1); fallback.set(file, bySource);
    }
  }

  // Display-eligible string leaves and their visibility depend on the document alone, so one
  // collection pass can serve every later scan; ownership and source counts stay per scan.
  const collect = (value, file, text) => {
    const leaves = [];
    const stringSpan = jsonStringSpans(text);
    let truncated = false;
    const visit = (node, path, visible, depth) => {
      if (depth > 128) { truncated = true; return; }
      if (typeof node === 'string') {
        if (!node.trim() || !/\p{L}/u.test(node) || resourceValue(node)) return;
        const identity = jsonFieldIdentity(file, value, path);
        const embedded = identity?.rule === 'rpg-command-program' && identity.consumer.startsWith('Game_Interpreter.command356:');
        leaves.push([path, node, visible ? 1 : 0, identity ?? null, ...(embedded ? [stringSpan(path)] : [])]);
        return;
      }
      if (Array.isArray(node)) { node.forEach((item, index) => visit(item, [...path, index], visible, depth + 1)); return; }
      if (node && typeof node === 'object') for (const [key, item] of Object.entries(node)) {
        if (!identityField.test(key)) visit(item, [...path, key], visible || displayFields.has(key.toLowerCase()), depth + 1);
      }
    };
    visit(value, [], false, 0);
    return { leaves, truncated };
  };

  const replay = (file, profile, evidenceHash, reviewed) => {
    const parts = normalize(file).split('/');
    const owned = new Map();
    for (let index = 0; index < parts.length; index++) for (const [key, rows] of locations.get(parts.slice(index).join('/')) ?? []) {
      owned.set(key, [...(owned.get(key) ?? []), ...rows]);
    }
    const sources = new Map();
    for (let index = 0; index < parts.length; index++) for (const [source, count] of fallback.get(parts.slice(index).join('/')) ?? []) sources.set(source, Math.max(sources.get(source) ?? 0, count));
    const candidates = [], unknownClusters = new Map(), leafSources = new Map(), protectedFields = [], embeddedExpressions = [];
    let truncated = Boolean(profile.truncated), usedSourceFallback = false;
    for (const [path, node, visible, identity, span] of profile.leaves) {
      const key = pointer(path);
      leafSources.set(key, node);
      if (identity) {
        const embedded = embeddedExpression({ file, pointer: key, source: node, identity, span, sourceHash: evidenceHash });
        if (embedded) embeddedExpressions.push(embedded);
        protectedFields.push({ id: `json-identity:${file}#${key}`, file, source: node, path, locator: { file, pointer: key },
          status: 'ignored', classification: identity.classification, classificationEvidence: { ...identity, file } });
        continue;
      }
      if (owned.get(key)?.some(unit => (unit.rawSource ?? unit.source) === node
        || unit.context?.adaptationSourceHash === createHash('sha256').update(node).digest('hex')
        || typeof unit.source === 'string' && unit.controls && unit.source.replace(/\{\{CTRL\d{4}\}\}/g, token => unit.controls[token] ?? token) === node)) continue;
      if (sources.get(node)) { usedSourceFallback = true; sources.set(node, sources.get(node) - 1); continue; }
      if (reviewed) {
        const shape = path.map(part => typeof part === 'number' ? '*' : part).join('/'), selected = reviewed.get(shape);
        if (!selected) continue;
        candidates.push({ id: `json:${file}#${key}`, file, source: node,
          kind: 'json_reviewed_cluster_candidate', classification: 'display_unresolved', path, locator: { file, pointer: key },
          context: { file, clusterId: selected.id, evidenceHash, classificationEvidence: selected.reason } });
        continue;
      }
      if (!visible) {
        const shape = path.map(part => typeof part === 'number' ? '*' : part).join('/');
        const id = `cluster-${createHash('sha256').update(JSON.stringify([file, shape])).digest('hex').slice(0, 24)}`;
        const cluster = unknownClusters.get(shape) ?? { id, file, field: shape, evidenceHash, status: 'unknown', count: 0, proseLike: false, examples: [], evidence: 'unclassified-json-string-field' };
        cluster.count++;
        cluster.proseLike ||= /\p{L}[,;:.!?，。！？：；]?\s+\p{L}/u.test(node) || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2}/u.test(node);
        if (cluster.examples.length < 3) cluster.examples.push({ pointer: key, source: node });
        if (unknownClusters.size < 200 || unknownClusters.has(shape)) unknownClusters.set(shape, cluster);
        continue;
      }
      if (candidates.length >= 2000) { truncated = true; continue; }
      candidates.push({ id: `json:${file}#${key}`, file, source: node, kind: 'json_display_pointer_candidate', classification: 'display_unresolved', path, locator: { file, pointer: key } });
    }
    return { candidates, unknownClusters: [...unknownClusters.values()], truncated, leafSources, protectedFields, embeddedExpressions,
      exactlyAccounted: !truncated && !usedSourceFallback && !candidates.length && !unknownClusters.size && !embeddedExpressions.length };
  };

  /** `cached` carries a stored profile plus the scanned file hash; without it the bytes are parsed. */
  const inspect = (file, bytes, cached, reviewed) => {
      signal?.throwIfAborted();
      if (cached?.profile) {
        const result = replay(file, cached.profile, cached.hash, reviewed);
        return { ...result, parsed: true, metadata: cached.profile.metadata ?? undefined, profile: cached.profile };
      }
      let value;
      try { value = JSON.parse((cached?.text ?? bytes.toString('utf8')).replace(/^\uFEFF/, '')); } catch { return { candidates: [], unknownClusters: [], parsed: false, truncated: false, profile: null }; }
      const profile = { ...collect(value, file, cached?.text ?? bytes.toString('utf8')), metadata: rootMetadata(value) ?? null };
      const stored = profile.leaves.length > MAX_PROFILE_LEAVES ? null : profile;
      const result = replay(file, profile, cached?.hash ?? createHash('sha256').update(bytes).digest('hex'), reviewed);
      return { ...result, parsed: true, metadata: profile.metadata ?? undefined, profile: stored };
  };
  return {
    inspect,
    expandReviewedClusters(file, bytes, cached, selections) {
      const reviewed = new Map(selections.filter(item => item.evidenceHash === cached.hash).map(item => [item.field, item]));
      return inspect(file, bytes, cached, reviewed);
    },
  };
}
