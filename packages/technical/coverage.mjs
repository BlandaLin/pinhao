import { lstat, mkdir, open, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createJsonCoverage } from './coverage-json.mjs';
import { inspectDisplayCalls } from './coverage-calls.mjs';
import { COVERAGE_DECISION_VERSION, coverageContextIdentity, coverageDecisionFresh, coverageDigest, displayCandidateIdentity, displayCandidatePosition, EXPRESSION_DISPOSITIONS, expressionReadProof, resourceReadProof } from './coverage-decisions.mjs';
import { isPrivateGamePath } from '../core/private-paths.mjs';
import { groupReviewDiagnostics, REVIEW_DIAGNOSTICS_VERSION } from './review-diagnostics.mjs';
import { readNativeTargetManifest } from './native-targets.mjs';
import { jsonFieldIdentity, JSON_FIELD_POLICY_VERSION } from './json-field-policy.mjs';
import { SCRIPT_FIELD_POLICY_VERSION } from './script-field-policy.mjs';
import { RESOURCE_ROUTING_VERSION, resourceRoute, isDisplaySampleResource, isSourceContextResource, resourceRouteSummary } from './resource-routing.mjs';

const displayEvidence = /(?:dialog(?:ue)?|caption|subtitle|message|description|speaker|drawText|setText|addText|tr\s*\(|\.text\s*=|["'](?:text|lines|paragraphs|content)["']\s*:)/i;
// Unknown formats need a concrete display-like shape, not a stray word in framework/config text.
const unknownDisplayEvidence = /(?:\b(?:show_message|drawText|setText|addText|tr)\s*\(|\.text\s*=\s*["']|["'](?:text|dialogue|message|subtitle|caption|description|speaker|title|label|lines|paragraphs|content)["']\s*:\s*(?:["']|\[))/i;
const ignoredDirectories = new Set(['node_modules']);
const runtimeResource = file => /(?:^|\/)(?:js\/(?:libs\/|(?:rpg|rmmz)_[^/]+\.js$|plugins\.js$)|(?:readme|license|changelog)[^/]*$)/i.test(file);
const resourcePath = value => typeof value === 'string' ? value.replace(/^res:\/\//, '').replaceAll('\\', '/').replace(/^\.\//, '') : '';
const contextualScripts = new Set(['.js', '.mjs', '.cjs', '.gd', '.py', '.rpy', '.rb']);

/**
 * One scan reads each source once. Cheap derivations (utf-8 text, digest, parsed JSON, offset
 * tables, masked syntax) are memoised per resolved path with a bounded footprint, so the four
 * resolution stages below no longer re-read or re-parse a file another stage already opened.
 */
function scanDocuments(signal) {
  const entries = new Map();
  let retained = 0;
  const budget = 32 * 1024 * 1024;
  const entryFor = async target => {
    abort(signal);
    const key = path.resolve(target);
    const known = entries.get(key);
    if (known) { entries.delete(key); entries.set(key, known); return known; }
    const bytes = await readFile(target, { signal });
    const entry = { bytes, derived: new Map(), cost: bytes.length <= 4 * 1024 * 1024 ? bytes.length : 0 };
    if (entry.cost) { retained += entry.cost; entries.set(key, entry); }
    while (retained > budget && entries.size > 1) {
      const oldest = entries.keys().next().value, dropped = entries.get(oldest);
      retained -= dropped.cost; entries.delete(oldest);
    }
    return entry;
  };
  const shared = async (target, name, compute) => {
    const entry = await entryFor(target);
    const known = entry.derived.get(name);
    if (known) return known.value;
    const created = compute(entry);
    entry.derived.set(name, created);
    entry.cost += created.cost; retained += created.cost;
    return created.value;
  };
  return {
    bytes: async target => (await entryFor(target)).bytes,
    hash: target => shared(target, 'hash', entry => ({ value: createHash('sha256').update(entry.bytes).digest('hex'), cost: 72 })),
    text: target => shared(target, 'text', entry => {
      const decoded = entry.bytes.toString('utf8'), bom = decoded.startsWith('\uFEFF') ? 1 : 0;
      return { value: { decoded, text: bom ? decoded.slice(1) : decoded, valid: Buffer.from(decoded).equals(entry.bytes) }, cost: 0 };
    }),
    json: target => shared(target, 'json', entry => {
      let value;
      try { value = JSON.parse(entry.bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { value = undefined; }
      return { value, cost: value === undefined ? 0 : entry.bytes.length * 3 };
    }),
    charOffsets: target => shared(target, 'charOffsets', entry => {
      const text = entry.bytes.toString('utf8').replace(/^\uFEFF/, ''), offsets = [0];
      let cursor = 0;
      for (const character of text) offsets.push(cursor += character.length);
      return { value: offsets, cost: offsets.length * 8 };
    }),
    byteOffsets: target => shared(target, 'byteOffsets', entry => {
      const bom = entry.bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
      const text = entry.bytes.subarray(bom).toString('utf8'), offsets = new Uint32Array(text.length + 1);
      let count = 0, offset = bom;
      offsets[0] = offset;
      for (const character of text) { const code = character.codePointAt(0); offset += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4; offsets[++count] = offset; }
      return { value: { bytes: entry.bytes, offsets, count, bom, valid: Buffer.from(text).equals(entry.bytes.subarray(bom)) }, cost: offsets.byteLength + entry.bytes.length };
    }),
    syntax: (target, extension) => shared(target, `syntax:${extension}`, entry => {
      const matched = maskSource(entry.bytes.toString('utf8').replace(/^\uFEFF/, ''), extension);
      return { value: matched, cost: matched ? matched.masked.length * 2 : 0 };
    }),
  };
}

/**
 * Per-file scan facts keyed by (path, mtime, size). A file whose stamp still matches is neither
 * re-read nor re-parsed: its digest, JSON leaf profile and script display calls are reused.
 * Any stamp change, a missing file, or a version bump makes the entry unusable.
 */
function createScanIndex(file) {
  const empty = { version: SCAN_INDEX_VERSION, files: {} };
  let state = empty, dirty = false, status = file ? 'miss' : 'disabled';
  const claimed = new Set();
  const keyOf = target => path.resolve(target);
  return {
    get status() { return status; },
    get size() { return Object.keys(state.files).length; },
    async load() {
      if (!file) return this;
      const info = await lstat(file).catch(() => undefined);
      const stamp = info ? `${info.mtimeMs}:${info.size}` : undefined;
      // Back-to-back scans of one project run in one process; an index whose file stamp still
      // matches is not read and parsed again. Per-file stamps below stay authoritative.
      const known = stamp ? scanIndexMemory.get(file) : undefined;
      if (known && known.stamp === stamp) { state = known.state; status = 'restored'; return this; }
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        if (parsed?.version === SCAN_INDEX_VERSION && parsed.files && typeof parsed.files === 'object') { state = parsed; status = 'restored'; }
      } catch (error) { if (!(error instanceof SyntaxError) && !['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
      if (stamp) scanIndexMemory.set(file, { stamp, state });
      return this;
    },
    /** Claim the path for this scan and drop a stamp that no longer matches the file on disk. */
    touch(target, info) {
      if (!file || !info) return;
      const key = keyOf(target), entry = state.files[key];
      claimed.add(key);
      if (entry && !sameStamp(entry, info)) { delete state.files[key]; dirty = true; }
    },
    hit(target, info) {
      if (!file || !info || !Number.isFinite(info.mtimeMs)) return undefined;
      const entry = state.files[keyOf(target)];
      return entry && sameStamp(entry, info) && typeof entry.h === 'string' ? entry : undefined;
    },
    want(target, info, values) {
      if (!file || !info || !Number.isFinite(info.mtimeMs)) return;
      const key = keyOf(target);
      state.files[key] = { m: info.mtimeMs, c: info.ctimeMs, s: info.size, ...values };
      claimed.add(key); dirty = true;
    },
    async save({ prune = true } = {}) {
      if (!file || !dirty) return this;
      const keep = candidate => { if (!prune) return candidate; const files = {}; for (const key of claimed) if (candidate[key]) files[key] = candidate[key]; return files; };
      let body = JSON.stringify({ version: SCAN_INDEX_VERSION, files: keep(state.files) });
      // A profile-heavy ledger that grew past the cap keeps only stamps and digests.
      if (body.length > SCAN_INDEX_LIMIT) body = JSON.stringify({ version: SCAN_INDEX_VERSION, files: Object.fromEntries(Object.entries(keep(state.files)).map(([key, entry]) => [key, { m: entry.m, s: entry.s, h: entry.h }])) });
      if (body.length > SCAN_INDEX_LIMIT) return this;
      try {
        await mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(temporary, body);
        await rename(temporary, file);
        const info = await lstat(file).catch(() => undefined);
        if (info) scanIndexMemory.set(file, { stamp: `${info.mtimeMs}:${info.size}`, state });
      } catch { /* a cache that cannot be written must never fail the scan */ }
      return this;
    },
  };
}

const SCAN_INDEX_VERSION = `pinhao-coverage-index-3:${JSON_FIELD_POLICY_VERSION}:script-${SCRIPT_FIELD_POLICY_VERSION}:${RESOURCE_ROUTING_VERSION}`;
const SCAN_INDEX_LIMIT = 64 * 1024 * 1024;
const scanIndexMemory = new Map();
// mtime alone can be replayed (archive extraction, `touch -d`, copy tools); the inode change
// time cannot be set back from userland, so a same-size swap still invalidates the entry.
const sameStamp = (entry, info) => entry.m === info.mtimeMs && entry.s === info.size
  && (entry.c === undefined || entry.c === info.ctimeMs);

/**
 * The ledger cache lives beside the workbench that owns the manifest, so it is per project and
 * dies with it. Without a manifest the root path alone names the cache in the system temp dir.
 */
function scanCachePath({ rootDir, inventory, enabled }) {
  if (enabled === false) return undefined;
  const manifestPath = inventory.nativeManifestPath ?? inventory.manifestPath;
  if (typeof manifestPath === 'string' && manifestPath) return path.join(path.dirname(manifestPath), 'technical', 'coverage-index.json');
  const key = createHash('sha256').update(path.resolve(rootDir ?? '')).digest('hex').slice(0, 32);
  return path.join(os.tmpdir(), 'pinhao-coverage-index', `${key}.json`);
}

function jsonMetadata(value) {
  const object = item => item && typeof item === 'object' && !Array.isArray(item);
  if (!object(value) || typeof value.$schema !== 'string'
      || !/^https?:\/\/json-schema\.org\/(?:draft-0[467]\/schema|draft\/(?:2019-09|2020-12)\/schema)#?$/.test(value.$schema)) return;
  const types = new Set(['null', 'boolean', 'object', 'array', 'number', 'string', 'integer']);
  const declaredTypes = Array.isArray(value.type) ? value.type : [value.type];
  const structure = ['properties', 'patternProperties', '$defs', 'definitions'].some(key => object(value[key]))
    || object(value.items) || ['allOf', 'anyOf', 'oneOf'].some(key => Array.isArray(value[key]) && value[key].length > 0 && value[key].every(item => object(item) || typeof item === 'boolean'));
  if (declaredTypes.length && declaredTypes.every(type => types.has(type)) && structure) return {
    classification: 'technical_metadata', rule: 'json-schema-document', dialect: value.$schema, evidence: 'json-schema-dialect-and-structure',
  };
}

function identityField(field, parent = '') {
  const name = field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  if (/^(?:font_(?:names?|famil(?:y|ies)|family_names|family_list|face)|fallback_fonts?)$/.test(name)
      || /^(?:family|families|names)$/.test(name) && /font/i.test(parent)) return { classification: 'resource_identity', rule: 'font-family-field' };
  if (/^(?:(?:resource|asset|texture|image|script|font|file)_path|path|file|texture|image|asset|resource|script|url|uri)$/.test(name)) return { classification: 'resource_identity', rule: 'resource-reference-field' };
  if (/^(?:id|\w+_id|key|code|type|mode|condition|trigger|_readme|metadata)$/.test(name)) return { classification: 'logic_identity', rule: 'logic-identity-field' };
}

function maskSource(text, extension) {
  const output = [], literals = [];
  const javascript = ['.js', '.mjs', '.cjs'].includes(extension);
  let cursor = 0, plainStart = 0;
  while (cursor < text.length) {
    let end;
    if (!javascript && text[cursor] === '#' || javascript && text.startsWith('//', cursor)) {
      end = text.indexOf('\n', cursor); if (end < 0) end = text.length;
    } else if (javascript && text.startsWith('/*', cursor)) {
      end = text.indexOf('*/', cursor + 2); end = end < 0 ? text.length : end + 2;
    } else if (['"', "'", ...(javascript ? ['`'] : [])].includes(text[cursor])) {
      const quote = !javascript && text.startsWith(text[cursor].repeat(3), cursor) ? text[cursor].repeat(3) : text[cursor];
      end = cursor + quote.length;
      while (end < text.length && !text.startsWith(quote, end)) end += text[end] === '\\' ? 2 : 1;
      if (end >= text.length) return undefined;
      end += quote.length;
      // A template without interpolation is one literal the extractor can translate directly.
      if (quote !== '`' || !text.slice(cursor, end).includes('${')) literals.push({ start: cursor, end });
    } else { cursor++; continue; }
    output.push(text.slice(plainStart, cursor), text.slice(cursor, end).replace(/[^\r\n]/g, ' '));
    cursor = end; plainStart = end;
  }
  output.push(text.slice(plainStart));
  return { masked: output.join(''), literals };
}

function contextualIdentity(item, document, extension) {
  if (extension === '.json') {
    const parts = Array.isArray(item.path) ? item.path : typeof item.locator?.pointer === 'string' && item.locator.pointer.startsWith('/')
      ? item.locator.pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')) : undefined;
    if (!parts?.length) return;
    // A replayed document carries its display leaves; the parsed tree is only walked when the
    // document was parsed for this call (external candidate classification).
    let value;
    if (document.leafSources) { value = document.leafSources.get(jsonPointer(parts)); if (value === undefined) return; }
    else {
      value = document.value;
      for (const part of parts) { if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return; value = value[part]; }
    }
    if (value !== item.source) return;
    const nativeIdentity = document.value && jsonFieldIdentity(item.file ?? item.context?.file ?? item.locator?.file, document.value, parts);
    if (nativeIdentity) return nativeIdentity;
    const metadata = Object.hasOwn(document, 'metadata') ? document.metadata : jsonMetadata(document.value);
    if (metadata) return { ...metadata, path: parts };
    const fields = parts.filter(part => typeof part === 'string' && !/^\d+$/.test(part));
    const field = fields.at(-1) ?? '', parent = fields.at(-2) ?? '';
    const identity = identityField(field, parent);
    return identity && { ...identity, field, path: parts, evidence: 'json-field-source' };
  }
  const { start, end, render } = item.target ?? {};
  if (!document.syntax || render !== 'quoted' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end >= document.offsets.length) return;
  const begin = document.offsets[start], finish = document.offsets[end];
  if (!document.syntax.literals.some(literal => literal.start === begin && literal.end === finish)) return;
  if (decodeQuotedLiteral(document.text.slice(begin, finish))?.value !== item.source) return;
  const prefix = document.syntax.masked.slice(Math.max(0, begin - 4096), begin);
  const assignments = [...prefix.matchAll(/([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s*:\s*[\w.[\], ]+)?\s*=(?!=|>)\s*/g)];
  const assignment = assignments.at(-1);
  if (assignment && /^(?:(?:PackedStringArray|Array|list|tuple)\s*\(\s*)?[\[(]?\s*(?:,\s*)*$/.test(prefix.slice(assignment.index + assignment[0].length))) {
    const fields = assignment[1].split('.'), field = fields.at(-1), parent = fields.at(-2) ?? '';
    const identity = identityField(field, parent);
    if (identity) return { ...identity, field: assignment[1], evidence: 'literal-field-assignment', line: document.text.slice(0, begin).split('\n').length };
  }
  const previous = document.syntax.literals.findLast(literal => literal.end <= begin && begin - literal.end < 4096
    && /^\s*:\s*(?:(?:PackedStringArray|Array|list|tuple)\s*\(\s*)?[\[(]?\s*(?:,\s*)*$/.test(document.syntax.masked.slice(literal.end, begin))
    && /[{,]\s*$/.test(document.syntax.masked.slice(0, literal.start)));
  if (previous) {
    const field = decodeQuotedLiteral(document.text.slice(previous.start, previous.end))?.value;
    const identity = typeof field === 'string' && identityField(field);
    if (identity) return { ...identity, field, evidence: 'literal-dictionary-field' };
  }
  const call = /(?:^|[^\w.])([\w.]+)\s*\(\s*(?:(?:PackedStringArray|Array|list|tuple)\s*\(\s*)?[\[(]?\s*(?:,\s*)*$/.exec(prefix);
  if (call) {
    const method = call[1].split('.').at(-1);
    const font = /^(?:set_font_(?:names?|family|families)|setFont(?:Family|Families|Name|Names))$/.test(method);
    const resource = /^(?:load|preload|get_node|get_node_or_null|load_resource)$/.test(method);
    const logic = /^(?:connect|disconnect|emit_signal|has_signal|get_setting)$/.test(method);
    const firstArgument = !call[0].slice(call[0].indexOf('(') + 1).trim();
    if (font || firstArgument && (resource || logic)) return { classification: logic ? 'logic_identity' : 'resource_identity', rule: font ? 'font-family-call' : resource ? 'resource-reference-call' : 'logic-identity-call', field: call[1], evidence: 'literal-call-argument' };
  }
}

async function classifyCandidates(candidates, roots, signal, documents) {
  const grouped = new Map(), result = [...candidates];
  for (const [index, item] of candidates.entries()) {
    if (item.classification && item.classification !== 'display_unresolved') continue;
    const file = resourcePath(item.file ?? item.context?.file ?? item.locator?.file), extension = path.extname(file).toLowerCase();
    if (!file || file.split('/').includes('..') || path.isAbsolute(file) || extension !== '.json' && !contextualScripts.has(extension)) continue;
    const group = grouped.get(file) ?? []; group.push({ item, index }); grouped.set(file, group);
  }
  for (const [file, group] of grouped) for (const root of roots) {
    abort(signal);
    let document;
    try {
      if ((await lstat(root)).isSymbolicLink()) continue;
      const canonical = await realpath(root), target = await realpath(path.resolve(canonical, file)), relative = path.relative(canonical, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const info = await lstat(target); if (!info.isFile() || info.size > 4 * 1024 * 1024) continue;
      const loaded = await documents.text(target); if (!loaded.valid) continue;
      const text = loaded.text, extension = path.extname(file).toLowerCase();
      if (extension === '.json') {
        const value = await documents.json(target);
        if (value === undefined) continue;
        document = { text, value };
      } else document = { text, offsets: await documents.charOffsets(target), syntax: await documents.syntax(target, extension) };
      for (const { item, index } of group) {
        const evidence = contextualIdentity(item, document, extension);
        // A resolved identity field is not game text: keep the evidence, drop it from the open queue.
        if (evidence) result[index] = { ...item, status: 'ignored', classification: evidence.classification, classificationEvidence: { ...evidence, file } };
      }
      break;
    } catch (error) { if (error.name === 'SyntaxError' || ['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) continue; throw error; }
  }
  return result;
}

function abort(signal) { if (signal?.aborted) throw signal.reason ?? new DOMException('任务已取消', 'AbortError'); }

function originalValueMatches(unit, value) {
  if ((unit.rawSource ?? unit.source) === value) return true;
  if (unit.context?.adaptationSourceHash === createHash('sha256').update(value).digest('hex')) return true;
  return typeof unit.source === 'string' && unit.controls && unit.source.replace(/\{\{CTRL\d{4}\}\}/g, token => unit.controls[token] ?? token) === value;
}

const jsonPointer = parts => '/' + parts.map(part => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/');

async function nativeGeneratedViews(inventory, signal) {
  // Only sealed, registered native views own their engineering metadata; names alone never do.
  const manifestPath = inventory.nativeManifestPath ?? inventory.manifestPath;
  const result = new Map();
  if (!manifestPath) return result;
  const manifest = await readNativeTargetManifest({ manifestPath, signal });
  if (!manifest) return result;
  try {
    const metadata = JSON.parse(await readFile(path.join(path.dirname(manifestPath), 'technical', 'product-source.json'), { encoding: 'utf8', signal }));
    if (metadata.schema !== 'pinhao-native-unity-v1' || typeof metadata.nativeSource !== 'string'
        || !metadata.recordMap || typeof metadata.recordMap !== 'object') return result;
    if ((await lstat(metadata.nativeSource)).isSymbolicLink()) return result;
    const source = await realpath(metadata.nativeSource);
    for (const [name, record] of Object.entries(metadata.recordMap)) {
      const file = resourcePath(name), sha256 = manifest.files?.[file]?.sha256;
      if (!file || file.split('/').includes('..') || path.isAbsolute(file) || !/^[a-f\d]{64}$/i.test(sha256 ?? '')
          || !record || !['TextAsset', 'TextMesh', 'MonoBehaviour', 'ManagedMethod'].includes(record.type)) continue;
      result.set(path.join(source, file), { sha256, manifestSha256: manifest.manifestSha256, schema: metadata.schema });
    }
  } catch (error) { if (!(error instanceof SyntaxError) && !['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
  return result;
}

async function nativeTargetUnits(inventory, units, roots, signal, readBytes = readFile) {
  const manifestPath = inventory.nativeManifestPath ?? inventory.manifestPath;
  if (!manifestPath) return [];
  const manifest = await readNativeTargetManifest({ manifestPath, signal });
  if (!manifest) return [];
  const manifestHash = manifest.manifestSha256;
  const current = new Map(units.map(unit => [unit.legacyId ?? unit.id, unit]));
  const groups = new Map(), result = [];
  for (const [id, unit] of Object.entries(manifest.units ?? {})) {
    if (!current.has(id) || current.get(id).source !== unit.source || !Array.isArray(unit.targets)) continue;
    const file = resourcePath(unit.file);
    if (!file || file.split('/').includes('..') || path.isAbsolute(file)) continue;
    const parts = (unit.initial_value ?? unit.source)?.split(/\{\{LINE\d{4}\}\}/).map(part => part.replace(/\{\{CTRL\d{4}\}\}/g, token => unit.controls?.[token] ?? token));
    if (!parts || parts.length !== unit.targets.length && !(unit.kind === 'choice' && parts.length === 1)) continue;
    const entries = groups.get(file) ?? [];
    unit.targets.forEach((target, index) => entries.push({ id, unit, target, value: parts[unit.kind === 'choice' ? 0 : index] }));
    groups.set(file, entries);
  }
  for (const [file, entries] of groups) for (const root of roots) {
    abort(signal);
    try {
      if ((await lstat(root)).isSymbolicLink()) continue;
      const canonical = await realpath(root), targetFile = await realpath(path.resolve(canonical, file)), relative = path.relative(canonical, targetFile);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const info = await lstat(targetFile); if (!info.isFile() || info.size > 4 * 1024 * 1024) continue;
      const raw = await readBytes(targetFile, { signal }), resourceHash = createHash('sha256').update(raw).digest('hex');
      if (manifest.files?.[file]?.sha256 !== resourceHash) continue;
      const bom = raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
      const text = raw.subarray(bom).toString('utf8'); if (!Buffer.from(text).equals(raw.subarray(bom))) continue;
      const offsets = [bom];
      if (entries.some(({ target }) => target?.render === 'quoted')) {
        let bytes = bom;
        for (const character of text) offsets.push(bytes += Buffer.byteLength(character));
      }
      let document;
      if (path.extname(file).toLowerCase() === '.json') { try { document = JSON.parse(text); } catch { continue; } }
      for (const { id, unit, target, value } of entries) {
        const evidence = { manifestSha256: manifestHash, resourceSha256: resourceHash };
        if (Array.isArray(target)) {
          let actual = document;
          for (const part of target) actual = actual && typeof actual === 'object' && Object.hasOwn(actual, part) ? actual[part] : undefined;
          if (actual === value) result.push({ id, legacyId: id, rawSource: value, locator: { file, pointer: jsonPointer(target) }, nativeEvidence: 'native-manifest-json-target', nativeHashes: evidence });
        } else if (target?.render === 'quoted' && Number.isSafeInteger(target.start) && Number.isSafeInteger(target.end)
          && target.start >= 0 && target.end > target.start && target.end < offsets.length) {
          const start = offsets[target.start], end = offsets[target.end], decoded = decodeQuotedLiteral(raw.subarray(start, end).toString('utf8'));
          if (!decoded || decoded.value !== value) continue;
          result.push({ id, legacyId: id, rawSource: decoded.body, locator: { file, byteStart: start + decoded.quoteBytes, byteEnd: end - decoded.quoteBytes }, nativeEvidence: 'native-manifest-quoted-target', nativeHashes: evidence });
          const contextPath = unit.contexts?.find(context => Array.isArray(context.path))?.path;
          if (document && contextPath) {
            let actual = document;
            for (const part of contextPath) actual = actual && typeof actual === 'object' && Object.hasOwn(actual, part) ? actual[part] : undefined;
            if (actual === value) result.push({ id, legacyId: id, rawSource: value, locator: { file, pointer: jsonPointer(contextPath) }, nativeEvidence: 'native-manifest-json-target', nativeHashes: evidence });
          }
        }
      }
      break;
    } catch (error) { if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
  }
  return result;
}

/** Exact native positions are available to incremental merges after seal and live-byte checks. */
export async function resolveNativeLocations({ inventory = {}, units = [], roots = [], signal }) {
  return (await nativeTargetUnits(inventory, units, roots, signal)).map(unit => ({
    unitId: unit.legacyId ?? unit.id, ...unit.locator,
    sourceHash: createHash('sha256').update(unit.rawSource).digest('hex'),
    evidence: unit.nativeEvidence, hashes: unit.nativeHashes,
  }));
}

async function resolveJsonCandidates(candidates, units, roots, signal, store) {
  const locations = new Map(), resolved = new Map();
  for (const unit of units) {
    const locator = unit.locator ?? unit.context?.adaptationLocator;
    const file = resourcePath(locator?.file ?? unit.context?.file ?? unit.file);
    const pointers = [locator?.pointer, ...[unit.context?.path, unit.context?.field].filter(Array.isArray).map(jsonPointer)].filter(value => typeof value === 'string');
    for (const pointer of pointers) {
      const key = JSON.stringify([file, pointer]);
      const rows = locations.get(key) ?? []; rows.push(unit); locations.set(key, rows);
    }
  }
  for (const item of candidates) {
    abort(signal);
    const file = resourcePath(item.file ?? item.context?.file ?? item.locator?.file);
    const pointer = Array.isArray(item.path) && item.path.every(part => typeof part === 'string' || Number.isSafeInteger(part))
      ? '/' + item.path.map(part => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/') : item.locator?.pointer;
    if (typeof pointer !== 'string' || !pointer.startsWith('/') || /~(?![01])/.test(pointer) || typeof item.source !== 'string'
        || file.split('/').includes('..') || path.isAbsolute(file)) continue;
    const located = locations.get(JSON.stringify([file, pointer]));
    if (!located?.length) continue;
    for (const root of roots) {
      abort(signal);
      try {
        if ((await lstat(root)).isSymbolicLink()) continue;
        const directory = await realpath(root), target = await realpath(path.resolve(directory, file)), relative = path.relative(directory, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
        const info = await lstat(target);
        if (!info.isFile() || info.size > 4 * 1024 * 1024) continue;
        if (!(await store.text(target)).valid) continue;
        const parsed = await store.json(target);
        if (parsed === undefined) continue;
        let value = parsed;
        for (const part of pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
          if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) { value = undefined; break; }
          value = value[part];
        }
        if (value !== item.source) continue;
        const match = located.find(unit => originalValueMatches(unit, value));
        if (match) { resolved.set(item, { unitId: match.legacyId ?? match.id, file, pointer, evidence: match.nativeEvidence ?? 'json-pointer-source', ...(match.nativeHashes ? { hashes: match.nativeHashes } : {}) }); break; }
      } catch (error) { if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
    }
  }
  return resolved;
}

export function decodeQuotedLiteral(literal) {
  // Backticks cover templates the extractor translates verbatim; interpolated ones stay expressions.
  const quote = ['"""', "'''", '"', "'", '`'].find(value => literal.startsWith(value) && literal.endsWith(value));
  if (!quote || literal.length < quote.length * 2) return undefined;
  const body = literal.slice(quote.length, -quote.length), escapes = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'" };
  let value = '';
  for (let cursor = 0; cursor < body.length; cursor++) {
    if (body.startsWith(quote, cursor)) return undefined;
    if (body[cursor] !== '\\') { value += body[cursor]; continue; }
    const escaped = body[++cursor];
    if (escaped === undefined) return undefined;
    if (Object.hasOwn(escapes, escaped)) { value += escapes[escaped]; continue; }
    if (escaped === '\n') continue;
    if (escaped === '\r' && body[cursor + 1] === '\n') { cursor++; continue; }
    if (/[0-7]/.test(escaped)) {
      const digits = body.slice(cursor).match(/^[0-7]{1,3}/)[0];
      value += String.fromCodePoint(parseInt(digits, 8)); cursor += digits.length - 1; continue;
    }
    const width = { x: 2, u: 4, U: 8 }[escaped];
    if (width) {
      const digits = body.slice(cursor + 1, cursor + 1 + width);
      if (digits.length !== width || !/^[\da-f]+$/i.test(digits)) return undefined;
      const code = parseInt(digits, 16);
      if (code > 0x10ffff) return undefined;
      value += String.fromCodePoint(code); cursor += width; continue;
    }
    if (escaped === 'N') return undefined;
    value += `\\${escaped}`;
  }
  return { value, body, quoteBytes: quote.length };
}

async function resolveByteCandidates(candidates, units, roots, signal, store) {
  const byFile = new Map(), resolved = new Map();
  for (const raw of units) {
    const locator = raw.locator ?? raw.context?.adaptationLocator;
    if (!Number.isSafeInteger(locator?.byteStart) || !Number.isSafeInteger(locator?.byteEnd)) continue;
    const unit = { ...raw, locator };
    const file = resourcePath(locator.file);
    const positions = byFile.get(file) ?? new Map(), key = JSON.stringify([locator.byteStart, locator.byteEnd]);
    const values = positions.get(key) ?? [];
    values.push(unit); positions.set(key, values); byFile.set(file, positions);
  }
  for (const item of candidates) {
    abort(signal);
    const file = resourcePath(item.file ?? item.context?.file ?? item.locator?.file), located = byFile.get(file);
    const { start, end, render } = item.target ?? {};
    if (!located?.size || render !== 'quoted' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || file.split('/').includes('..') || path.isAbsolute(file)) continue;
    for (const root of roots) {
      abort(signal);
      let document;
      try {
        if ((await lstat(root)).isSymbolicLink()) continue;
        const directory = await realpath(root), target = await realpath(path.resolve(directory, file)), relative = path.relative(directory, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
        const info = await lstat(target);
        if (!info.isFile() || info.size > 4 * 1024 * 1024) continue;
        document = await store.byteOffsets(target);
        if (!document.valid) continue;
      } catch (error) { if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) continue; throw error; }
      if (end > document.count) continue;
      const literalStart = document.offsets[start], literalEnd = document.offsets[end];
      const decoded = decodeQuotedLiteral(document.bytes.subarray(literalStart, literalEnd).toString('utf8'));
      if (!decoded || decoded.value !== item.source) continue;
      const bodyStart = literalStart + decoded.quoteBytes, bodyEnd = literalEnd - decoded.quoteBytes;
      // Host-native locators count file bytes including the BOM, extractors that read utf-8-sig count
      // them without it; either base is accepted, and the source text still has to match exactly.
      const bases = document.bom ? [[bodyStart, bodyEnd], [bodyStart - document.bom, bodyEnd - document.bom]] : [[bodyStart, bodyEnd]];
      const units = bases.map(base => located.get(JSON.stringify(base))).find(Boolean);
      const match = units?.find(unit => originalValueMatches(unit, decoded.body));
      if (match) { resolved.set(item, { unitId: match.legacyId ?? match.id, file, byteStart: bodyStart, byteEnd: bodyEnd, evidence: match.nativeEvidence ?? 'quoted-literal-utf8-span', ...(match.nativeHashes ? { hashes: match.nativeHashes } : {}) }); break; }
    }
  }
  return resolved;
}

/** A resource ledger records extraction evidence separately from translated-unit progress. */
export async function scanCoverage({ rootDir, sourceRoots = [], projectId, inventory = {}, units = [], decisions = [], signal, maxFiles = 100000, sampleFiles = 96, scanCache, scanCacheFile }) {
  // All stages share bounded source bytes for this scan; a later scan re-reads only changed files.
  const documents = scanDocuments(signal);
  const readBytes = target => documents.bytes(target);
  const index = await createScanIndex(scanCacheFile ?? scanCachePath({ rootDir, inventory, enabled: scanCache })).load();
  const roots = [rootDir, ...sourceRoots.map(item => typeof item === 'string' ? item : item.path)].filter(Boolean);
  const knownUnits = [...units, ...(Array.isArray(inventory.units) ? inventory.units : [])];
  const evidenceUnits = [...knownUnits, ...await nativeTargetUnits(inventory, knownUnits, roots, signal, readBytes)];
  const generatedViews = await nativeGeneratedViews(inventory, signal);
  const jsonCoverage = await createJsonCoverage({ units: evidenceUnits, inventory, signal, rootMetadata: jsonMetadata });
  const jsonCandidates = [];
  const callCandidates = [], displaySites = [], unknownClusters = [];
  const clusterDocuments = new Map();
  const proposedDecisions = (Array.isArray(decisions) ? decisions : []).filter(item => item && ['display', 'non-display', ...EXPRESSION_DISPOSITIONS].includes(item.disposition));
  const coverageDecisions = new Map();
  const contextFiles = [], contextDirectories = [];
  const processed = new Set();
  const unitLocations = new Set(evidenceUnits.filter(unit => Number.isSafeInteger(unit.locator?.start ?? unit.context?.start))
    .map(unit => JSON.stringify([resourcePath(unit.context?.file ?? unit.locator?.file ?? unit.file), unit.source, unit.locator?.start ?? unit.context?.start])));
  const classifiedCandidates = await classifyCandidates(inventory.dynamicCandidates ?? [], roots, signal, documents);
  const byteMatches = await resolveByteCandidates(classifiedCandidates, evidenceUnits, roots, signal, documents);
  const jsonMatches = await resolveJsonCandidates(classifiedCandidates, evidenceUnits, roots, signal, documents);
  const exactMatches = new Map([...byteMatches, ...jsonMatches]);
  const classifiedPositions = new Map(classifiedCandidates.map(item => [JSON.stringify([resourcePath(item.file ?? item.context?.file), item.target]), item]));
  const evidenceByFile = new Map(), legacyPositions = new Map();
  const supplementalByFile = new Map(), nativeUnitFiles = new Set();
  for (const unit of knownUnits) {
    const locator = unit.context?.adaptationLocator;
    const file = resourcePath(locator?.file ?? unit.locator?.file ?? unit.context?.file ?? unit.file);
    if (!file) continue;
    if (!locator || /^(?:script|image):/.test(unit.legacyId ?? unit.id ?? '')) { nativeUnitFiles.add(file); continue; }
    const selected = supplementalByFile.get(file) ?? new Map();
    selected.set(unit.legacyId ?? unit.id, [unit.legacyId ?? unit.id, unit.source, locator, unit.tokens ?? [],
      unit.context?.controlFingerprint ?? coverageDigest(Object.fromEntries(Object.entries(unit.controls ?? {}).sort(([a], [b]) => a.localeCompare(b))))]);
    supplementalByFile.set(file, selected);
  }
  for (const unit of evidenceUnits) {
    const file = resourcePath(unit.locator?.file ?? unit.context?.adaptationLocator?.file ?? unit.context?.file ?? unit.file);
    const entries = evidenceByFile.get(file) ?? []; entries.push(unit); evidenceByFile.set(file, entries);
    const start = unit.locator?.start ?? unit.context?.start;
    if (Number.isSafeInteger(start)) legacyPositions.set(JSON.stringify([file, start]), unit);
  }
  const representedCandidateFiles = new Set(classifiedCandidates.map(item => resourcePath(item.file ?? item.context?.file ?? item.locator?.file)));
  const dynamicCandidates = classifiedCandidates.filter(item => {
    if (['extracted', 'resolved', 'ignored'].includes(item.status)) return false;
    if (item.requiresAdapter || item.classification && item.classification !== 'display_unresolved') return false;
    return !exactMatches.has(item) && !unitLocations.has(JSON.stringify([resourcePath(item.file ?? item.context?.file ?? item.locator?.file), item.source, item.target?.start ?? item.locator?.start]));
  });
  const nativeResources = Array.isArray(inventory.coverage?.resources) ? inventory.coverage.resources : Array.isArray(inventory.coverage) ? inventory.coverage : [];
  const nativeByFile = new Map(nativeResources.map(item => [resourcePath(item.file ?? item.path), item]));
  const candidateCounts = new Map();
  for (const item of dynamicCandidates) { const file = resourcePath(item.file ?? item.context?.file ?? item.locator?.file); candidateCounts.set(file, (candidateCounts.get(file) ?? 0) + 1); }
  for (const unit of units) {
    const file = resourcePath(unit.context?.file ?? unit.locator?.file);
    if (file) processed.add(file);
    const carrier = resourcePath(unit.context?.carrier);
    if (carrier) processed.add(carrier);
  }
  for (const item of inventory.processedResources ?? inventory.coverage?.processedResources ?? []) {
    const file = resourcePath(typeof item === 'string' ? item : item.file ?? item.path);
    if (file) processed.add(file);
  }
  const processedSuffixes = new Set();
  for (const file of processed) {
    const parts = file.split('/');
    for (let index = 0; index < parts.length; index++) processedSuffixes.add(parts.slice(index).join('/'));
  }
  const resources = [], issues = [], seenRoots = new Set();
  let sampled = 0, sampledUnknown = 0, truncated = false;
  for (const root of roots) {
    abort(signal);
    let canonical;
    try {
      if ((await lstat(root)).isSymbolicLink()) { issues.push({ kind: 'resource-root-link', message: '资源清单使用普通工作目录' }); continue; }
      canonical = await realpath(root);
    } catch (error) { issues.push({ kind: 'resource-root-unavailable', message: error.code ?? 'read_failed' }); continue; }
    if (seenRoots.has(canonical)) continue;
    seenRoots.add(canonical);
    const pending = [''];
    while (pending.length && resources.length < maxFiles) {
      abort(signal);
      const directory = pending.pop();
      let entries;
      try { entries = await readdir(path.join(canonical, directory), { withFileTypes: true }); }
      catch (error) { issues.push({ file: resourcePath(directory), kind: 'directory-unreadable', message: error.code ?? 'read_failed' }); continue; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        abort(signal);
        if (entry.isSymbolicLink()) continue;
        const relative = path.join(directory, entry.name), file = resourcePath(relative);
        if (isPrivateGamePath(file, { directory: entry.isDirectory() })) continue;
        if (entry.isDirectory()) { if (!ignoredDirectories.has(entry.name.toLowerCase())) { pending.push(relative); contextDirectories.push(file); } continue; }
        if (!entry.isFile()) continue;
        if (resources.length >= maxFiles) { truncated = true; break; }
        const target = path.join(canonical, relative), info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        // `canonical` is already resolved and every directory on the way here came from a
        // non-symlink Dirent, so the joined path is its own real path; no per-file realpath.
        index.touch(target, info);
        const extension = path.extname(entry.name).toLowerCase(), route = resourceRoute(file);
        const context = { file, target, sourceIndex: seenRoots.size - 1, size: info.size, modified: info.mtimeMs, info };
        contextFiles.push(context);
        const parts = file.split('/');
        const native = nativeByFile.get(file) ?? parts.map((_, index) => nativeByFile.get(parts.slice(index).join('/'))).find(Boolean);
        const extracted = processedSuffixes.has(file) || parts.some((_, index) => processed.has(parts.slice(index).join('/'))) || native?.units > 0 || ['text_extracted', 'extracted'].includes(native?.status);
        const bindings = [...(supplementalByFile.get(file)?.values() ?? [])].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        let kind = extracted ? 'extracted' : route === 'image' ? 'image-candidate' : route === 'script' ? 'script-resource' : 'unclassified';
        let evidence, metadata, resourceReview, completeJsonScan = false;
        let candidateCount = candidateCounts.get(file) ?? parts.map((_, index) => candidateCounts.get(parts.slice(index).join('/'))).find(Boolean) ?? 0;
        const unrepresentedNativeCandidate = native?.status === 'display_candidates' && !parts.some((_, index) => representedCandidateFiles.has(parts.slice(index).join('/')));
        if (candidateCount || unrepresentedNativeCandidate) { kind = 'display-text-candidate'; evidence = '原生提取器记录了待定位的显示文字候选'; }
        const registeredView = generatedViews.get(target);
        const generatedView = registeredView && registeredView.sha256 === await documents.hash(target);
        if (generatedView) {
          context.hash = registeredView.sha256;
          metadata = { rule: 'native-generated-view', schema: registeredView.schema, manifestSha256: registeredView.manifestSha256,
            resourceSha256: registeredView.sha256 };
          evidence = '已校验原生文字视图；工程定位信息不作为游戏文字重复检查';
          if (!extracted && !candidateCount) kind = 'technical-metadata';
        }
        if (!generatedView && extension === '.json' && !runtimeResource(file) && !/^(?:package(?:-lock)?|plugins)\./i.test(entry.name) && info.size <= 4 * 1024 * 1024) {
          const cached = index.hit(target, info);
          let json;
          if (cached && cached.j !== undefined) {
            // An unchanged file keeps its leaf profile and digest: this scan re-applies ownership
            // to stored leaves instead of reading or parsing the document again.
            context.hash = cached.h;
            json = cached.j === 0 ? { candidates: [], unknownClusters: [], parsed: false, truncated: false }
              : jsonCoverage.inspect(file, undefined, { profile: cached.j, hash: cached.h });
          } else {
            const bytes = await readBytes(target);
            const hash = cached?.h ?? createHash('sha256').update(bytes).digest('hex');
            context.hash = hash;
            json = jsonCoverage.inspect(file, bytes, { hash });
            if (json.parsed) index.want(target, info, json.profile ? { h: hash, j: json.profile } : { h: hash });
            else index.want(target, info, { h: hash, j: 0 });
          }
          if (json.parsed) {
            const document = { leafSources: json.leafSources, metadata: json.metadata };
            metadata = json.metadata;
            for (const item of json.protectedFields ?? []) {
              if (!classifiedCandidates.some(previous => resourcePath(previous.file) === file && JSON.stringify(previous.path) === JSON.stringify(item.path))) classifiedCandidates.push(item);
            }
            for (const item of json.embeddedExpressions ?? []) {
              const sourceIndex = seenRoots.size - 1;
              const candidate = { ...item, sourceIndex, sourceHash: context.hash,
                id: `script-expression:${coverageDigest([file, sourceIndex, item.locator]).slice(0, 24)}`,
                evidenceHash: coverageDigest([item.evidenceHash, sourceIndex]) };
              if (!classifiedCandidates.some(previous => previous.id === candidate.id)) classifiedCandidates.push(candidate);
            }
            json.candidates = json.candidates.filter(item => {
              const evidence = contextualIdentity(item, document, '.json');
              if (!evidence) return true;
              if (!classifiedCandidates.some(previous => resourcePath(previous.file) === file && JSON.stringify(previous.path) === JSON.stringify(item.path))) classifiedCandidates.push({ ...item, status: 'ignored', classification: evidence.classification, classificationEvidence: { ...evidence, file } });
              return false;
            });
            completeJsonScan = json.exactlyAccounted === true;
            const sourceDocument = { target, root: seenRoots.size - 1, profile: json.profile, hash: context.hash, document };
            if (!metadata) for (const cluster of json.unknownClusters ?? []) {
              if (cluster.examples.every(example => contextualIdentity({ source: example.source, path: example.pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')) }, document, '.json'))) continue;
              unknownClusters.push(cluster);
              clusterDocuments.set(cluster, sourceDocument);
            }
          }
          if (json.truncated) truncated = true;
          if (json.candidates.length) {
            jsonCandidates.push(...json.candidates.map(candidate => ({ ...candidate, sourceIndex: seenRoots.size - 1 }))); candidateCount += json.candidates.length;
            kind = 'display-text-candidate'; evidence = '明确显示字段存在尚无精确提取定位的 JSON 字符串';
          }
          if (metadata && !candidateCount) { kind = 'technical-metadata'; evidence = 'JSON Schema 方言与结构字段确认了资源校验规范'; }
        }
        const nativeScanned = !candidateCount && (native?.status === 'text_scanned' || native?.status === 'display_candidates'
          && parts.some((_, index) => representedCandidateFiles.has(parts.slice(index).join('/'))));
        const generatedPartial = bindings.length > 0 && !nativeUnitFiles.has(file) && !nativeScanned && !completeJsonScan;
        if (!generatedView && contextualScripts.has(extension) && !runtimeResource(file) && info.size <= 4 * 1024 * 1024) {
          // Masking and call discovery depend only on the file bytes, so an unchanged script
          // replays its stored call sites; positions are still checked against live units.
          const cached = index.hit(target, info);
          let calls;
          if (cached && cached.calls !== undefined) { context.hash = cached.h; calls = structuredClone(cached.calls); }
          else if (cached && cached.u === 0) { context.hash = cached.h; }
          else {
            const loaded = await documents.text(target);
            context.hash = cached?.h ?? await documents.hash(target);
            if (loaded.valid) {
              const text = loaded.text;
              calls = inspectDisplayCalls(file, text, maskSource(text, extension), decodeQuotedLiteral);
              index.want(target, info, calls.length <= 2000 ? { h: context.hash, u: 1, calls } : { h: context.hash, u: 1 });
            } else index.want(target, info, { h: context.hash, u: 0 });
          }
          if (calls) {
            const bound = calls.length ? await resolveByteCandidates(calls, evidenceByFile.get(file) ?? [], [root], signal, documents) : new Map();
            const offsets = calls.some(item => item.requiresAdapter) ? await documents.byteOffsets(target) : null;
            for (const rawCandidate of calls) {
              const sourceIndex = seenRoots.size - 1;
              const candidate = rawCandidate.requiresAdapter ? { ...rawCandidate,
                id: `script-expression:${coverageDigest([file, sourceIndex, rawCandidate.target]).slice(0, 24)}`,
                evidenceHash: coverageDigest([context.hash, sourceIndex, rawCandidate.target, rawCandidate.source]), sourceIndex,
                byteStart: offsets.offsets[rawCandidate.target.start], byteEnd: offsets.offsets[rawCandidate.target.end] } : rawCandidate;
              const existing = classifiedPositions.get(JSON.stringify([file, candidate.target]));
              const legacy = legacyPositions.get(JSON.stringify([file, candidate.target.start]));
              const resolved = bound.get(rawCandidate) ?? (existing && exactMatches.get(existing)) ?? (legacy && originalValueMatches(legacy, candidate.source) ? { unitId: legacy.legacyId ?? legacy.id, file, evidence: 'native-character-position-and-source' } : undefined);
              displaySites.push({ ...candidate.context.displaySite, source: candidate.source, status: resolved ? 'bound' : 'unresolved',
                ...(candidate.requiresAdapter ? { id: candidate.id, evidenceHash: candidate.evidenceHash, sourceIndex, byteStart: candidate.byteStart, byteEnd: candidate.byteEnd, requiresAdapter: true } : {}), ...(resolved ? { binding: resolved } : {}) });
              if (existing && candidate.requiresAdapter && existing.kind === candidate.kind) Object.assign(existing, candidate, { status: 'unresolved' });
              if (!resolved && !existing) {
                // Indirect display sites need either a located source or an evidence-backed Agent decision.
                if (candidate.requiresAdapter) classifiedCandidates.push({ ...candidate, status: 'unresolved', classification: 'adapter_required', classificationEvidence: { rule: 'non-literal-display-expression', line: candidate.context?.displaySite?.line, evidence: 'expression-needs-source-review', file } });
                else { callCandidates.push({ ...candidate, sourceIndex }); candidateCount++; kind = 'display-text-candidate'; evidence = '显示调用仍有待追踪的文字或动态表达式'; }
              }
            }
          }
        }
        // Unknown binary-looking files cannot consume the established text/script sampling budget.
        if (!extracted && !metadata && !nativeScanned && !runtimeResource(file) && isDisplaySampleResource(file) && (route === 'unknown' ? sampledUnknown : sampled) < sampleFiles && info.size <= 4 * 1024 * 1024 && !/^(?:package(?:-lock)?|project|plugins|config)\./i.test(entry.name)) {
          if (route === 'unknown') sampledUnknown++; else sampled++;
          const handle = await open(target, 'r');
          let text;
          try { const buffer = Buffer.alloc(Math.min(info.size, 65536)); const read = await handle.read(buffer, 0, buffer.length, 0); text = buffer.subarray(0, read.bytesRead).toString('utf8'); }
          finally { await handle.close(); }
          if (!text.includes('\u0000') && !text.includes('\uFFFD') && (route === 'unknown' ? unknownDisplayEvidence : displayEvidence).test(text) && /["'][^"'\r\n]{3,200}["']/u.test(text)) {
            kind = 'display-text-candidate';
            evidence = '显示字段或对话调用存在于尚无提取定位的资源中';
            resourceReview = true;
          }
        }
        // A generated locator proves partial work exists; completeness cannot depend on a sampling heuristic.
        if (generatedPartial || resourceReview) {
          kind = 'display-text-candidate';
          evidence = generatedPartial ? '已接入局部文字，仍需核对整个资源的显示文字是否完整定位' : evidence;
          const sourceIndex = seenRoots.size - 1, sourceHash = context.hash ?? await documents.hash(target);
          const bindingHash = coverageDigest(bindings);
          resourceReview = { reviewKind: 'resource-file', sourceIndex, sourceHash, bindingHash, bindingCount: bindings.length, partialExtraction: generatedPartial,
            id: `resource-file:${coverageDigest([file, sourceIndex]).slice(0, 24)}`,
            evidenceHash: coverageDigest(['resource-file', file, sourceIndex, sourceHash, info.size, bindingHash]) };
        }
        resources.push({ file, root: roots.indexOf(root), bytes: info.size, route, kind, hasExtractedText: extracted, unresolvedCandidates: candidateCount, ...(evidence ? { evidence } : {}), ...(metadata ? { classificationEvidence: metadata } : {}), ...resourceReview });
      }
    }
    if (pending.length) truncated = true;
  }
  const listed = new Set(resources.map(item => item.file));
  for (const [file, native] of nativeByFile) {
    if (!file || listed.has(file)) continue;
    if (resources.length >= maxFiles) { truncated = true; break; }
    const hasExtractedText = native.units > 0 || ['text_extracted', 'extracted'].includes(native.status);
    const unresolvedCandidates = candidateCounts.get(file) ?? 0;
    const kind = unresolvedCandidates || native.status === 'display_candidates' && !representedCandidateFiles.has(file) ? 'display-text-candidate' : hasExtractedText ? 'extracted' : native.status === 'image_candidate' ? 'image-candidate' : 'unclassified';
    resources.push({ file, root: 'native-manifest', bytes: native.bytes ?? 0, route: resourceRoute(file), kind, hasExtractedText, unresolvedCandidates, nativeStatus: native.status });
    listed.add(file);
  }
  // Reuse scanned text bytes; large assets contribute names and sizes, not another full read.
  const contextEntries = resources.map(item => [item.file, item.bytes]);
  const hashOf = async (target, info) => {
    const cached = index.hit(target, info);
    if (cached) return cached.h;
    const hash = await documents.hash(target);
    index.want(target, info, { h: hash });
    return hash;
  };
  const expressionCandidates = classifiedCandidates.filter(item => item.kind === 'script_display_expression_candidate' && item.id && item.evidenceHash);
  const resourceCandidates = resources.filter(resource => resource.reviewKind === 'resource-file');
  const exactCandidates = [...dynamicCandidates, ...jsonCandidates, ...callCandidates];
  if (unknownClusters.length || expressionCandidates.length || resourceCandidates.length || exactCandidates.length) for (const file of contextFiles) {
    if (!isSourceContextResource(file.file)) continue;
    if (!file.hash && file.size <= 4 * 1024 * 1024) file.hash = await hashOf(file.target, file.info);
    contextEntries.push([file.file, file.size, file.hash ?? { modified: file.modified }]);
  }
  await index.save({ prune: !truncated });
  const sourceContextHash = coverageContextIdentity(contextEntries, contextDirectories);
  const receiptCache = new Map();
  const reviewedDocuments = new Map();
  for (const cluster of unknownClusters) {
    for (const decision of proposedDecisions.filter(item => item.id === cluster.id && item.evidenceHash === cluster.evidenceHash && ['display', 'non-display'].includes(item.disposition)).reverse()) {
      if (!await coverageDecisionFresh(decision, { roots: [...seenRoots], projectId, sourceContextHash, signal, cache: receiptCache })) continue;
      cluster.status = decision.disposition; cluster.decision = decision;
      coverageDecisions.set(decision.id, decision);
      if (decision.disposition === 'display') {
        const document = clusterDocuments.get(cluster), selected = reviewedDocuments.get(document) ?? [];
        selected.push({ ...cluster, reason: decision.reason }); reviewedDocuments.set(document, selected);
      }
      break;
    }
  }
  for (const [document, selections] of reviewedDocuments) {
    const file = selections[0].file;
    const expanded = jsonCoverage.expandReviewedClusters(file, document.profile ? undefined : await readBytes(document.target),
      { profile: document.profile, hash: document.hash }, selections);
    const candidates = expanded.candidates.filter(item => !contextualIdentity(item, document.document, '.json'))
      .map(item => ({ ...item, sourceIndex: document.root }));
    jsonCandidates.push(...candidates);
    exactCandidates.push(...candidates);
    for (const resource of resources.filter(item => candidates.length && item.file === file && item.root === document.root)) {
      resource.kind = 'display-text-candidate'; resource.unresolvedCandidates += candidates.length;
      resource.evidence = '已审阅显示字段的全部未提取位置等待精确接入';
    }
    if (expanded.truncated) truncated = true;
  }
  for (const candidate of exactCandidates) {
    const file = resourcePath(candidate.file ?? candidate.locator?.file ?? candidate.context?.file);
    const context = contextFiles.find(item => item.file === file && (candidate.sourceIndex === undefined || item.sourceIndex === candidate.sourceIndex));
    if (!context) continue;
    const sourceIndex = context.sourceIndex, sourceHash = context.hash ?? await hashOf(context.target, context.info);
    Object.assign(candidate, { sourceIndex, sourceHash, evidenceHash: coverageDigest([COVERAGE_DECISION_VERSION, sourceIndex, sourceHash, displayCandidatePosition(candidate), candidate.source]) });
  }
  const knownIds = new Set(evidenceUnits.map(unit => unit.legacyId ?? unit.id));
  const rejectedCandidates = new Set();
  for (const candidate of exactCandidates) {
    const id = displayCandidateIdentity(candidate);
    for (const decision of proposedDecisions.filter(item => item.kind === 'display-candidate' && item.id === id && item.evidenceHash === candidate.evidenceHash).reverse()) {
      if (decision.sourceHash !== candidate.sourceHash || decision.sourceIndex !== candidate.sourceIndex
          || !await coverageDecisionFresh(decision, { roots: [...seenRoots], projectId, sourceContextHash, signal, cache: receiptCache })) continue;
      rejectedCandidates.add(candidate); coverageDecisions.set(id, decision);
      classifiedCandidates.push({ ...candidate, id, status: 'ignored', classification: 'reviewed-non-display', decision });
      break;
    }
  }
  for (const collection of [dynamicCandidates, jsonCandidates, callCandidates]) {
    for (let index = collection.length - 1; index >= 0; index--) if (rejectedCandidates.has(collection[index])) collection.splice(index, 1);
  }
  for (const resource of resources) {
    const removed = [...rejectedCandidates].filter(candidate => resourcePath(candidate.file ?? candidate.context?.file) === resource.file && candidate.sourceIndex === resource.root).length;
    if (!removed) continue;
    resource.unresolvedCandidates = Math.max(0, resource.unresolvedCandidates - removed);
    if (resource.kind === 'display-text-candidate' && !resource.unresolvedCandidates && !resource.reviewKind) {
      resource.kind = resource.hasExtractedText ? 'extracted' : resource.route === 'script' ? 'script-resource' : 'technical-metadata';
      resource.evidence = '精确候选经独立用途复核确认为非显示；来源变化后重新调查';
    }
  }
  for (const candidate of expressionCandidates) {
    for (const decision of proposedDecisions.filter(item => item.id === candidate.id && item.evidenceHash === candidate.evidenceHash).reverse()) {
      if (decision.kind !== 'display-expression' || !EXPRESSION_DISPOSITIONS.includes(decision.disposition)
          || !expressionReadProof(decision, candidate)
          || decision.disposition === 'bound-reference' && !decision.unitIds?.every(id => knownIds.has(id))
          || !await coverageDecisionFresh(decision, { roots: [...seenRoots], projectId, sourceContextHash, signal, cache: receiptCache })) continue;
      candidate.status = 'resolved'; candidate.requiresAdapter = false;
      candidate.classification = decision.disposition === 'bound-reference' ? 'display-reference' : 'non-linguistic-display';
      candidate.decision = decision; coverageDecisions.set(decision.id, decision);
      for (const site of displaySites.filter(item => item.id === candidate.id)) {
        site.status = decision.disposition; site.requiresAdapter = false; site.decision = decision;
        if (decision.unitIds) site.binding = { unitIds: decision.unitIds, evidence: 'agent-reviewed-source-reference' };
      }
      break;
    }
  }
  for (const resource of resourceCandidates) {
    const sameFile = item => resourcePath(item.file ?? item.context?.file) === resource.file;
    // A whole-file opinion cannot erase a native failure or a more precise display/source task.
    const childWork = resource.unresolvedCandidates
      || [...dynamicCandidates, ...jsonCandidates, ...callCandidates, ...expressionCandidates.filter(item => item.status !== 'resolved')].some(sameFile)
      || unknownClusters.some(item => sameFile(item) && item.status !== 'non-display')
      || (inventory.reviewItems ?? []).some(sameFile);
    resource.nonDisplayAllowed = !resource.hasExtractedText && !childWork;
    resource.boundReferenceAllowed = resource.partialExtraction && resource.bindingCount > 0 && !childWork;
    for (const decision of proposedDecisions.filter(item => item.id === resource.id && item.evidenceHash === resource.evidenceHash).reverse()) {
      if (decision.kind !== 'resource-file' || decision.sourceHash !== resource.sourceHash || decision.sourceIndex !== resource.sourceIndex
          || decision.bytes !== resource.bytes || !resourceReadProof(decision, resource)
          || decision.disposition === 'non-display' && !resource.nonDisplayAllowed
          || decision.disposition === 'bound-reference' && (!resource.boundReferenceAllowed || decision.bindingHash !== resource.bindingHash || decision.bindingCount !== resource.bindingCount)
          || !await coverageDecisionFresh(decision, { roots: [...seenRoots], projectId, sourceContextHash, signal, cache: receiptCache })) continue;
      resource.reviewStatus = decision.disposition;
      resource.classificationEvidence = { rule: 'agent-resource-review', decisionId: decision.id, sourceHash: decision.sourceHash, reason: decision.reason };
      if (decision.disposition === 'non-display') {
        resource.kind = 'technical-metadata';
        resource.evidence = '已读取完整资源并调查用途，确认不属于游戏显示文字';
      } else if (decision.disposition === 'bound-reference') {
        resource.kind = 'extracted';
        resource.evidence = '已通读并调查资源，确认显示文字由当前已接受定位覆盖';
      } else resource.evidence = '已确认资源含显示文字，仍需精确定位、验证和接入';
      coverageDecisions.set(decision.id, decision);
      break;
    }
  }
  const reviewItems = (inventory.reviewItems ?? []).map(item => ({ ...item }));
  const contextualReviewItems = [], textCache = new Map();
  let cacheBytes = 0;
  const sourceLine = async item => {
    const file = resourcePath(item.file);
    if (!file || file.split('/').includes('..') || path.isAbsolute(file) || !Number.isInteger(item.line) || item.line < 1) return '';
    for (const directory of seenRoots) {
      try {
        const target = await realpath(path.resolve(directory, file)), relative = path.relative(directory, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
        let text = textCache.get(target);
        if (text === undefined) {
          const info = await lstat(target);
          if (!info.isFile() || info.size > 4 * 1024 * 1024) continue;
          text = (await readBytes(target)).toString('utf8');
          while (cacheBytes + text.length * 2 > 8 * 1024 * 1024 && textCache.size) {
            const first = textCache.keys().next().value;
            cacheBytes -= textCache.get(first).length * 2; textCache.delete(first);
          }
          textCache.set(target, text); cacheBytes += text.length * 2;
        }
        let start = 0;
        for (let line = 1; line < item.line; line++) { start = text.indexOf('\n', start); if (start < 0) return ''; start++; }
        const end = text.indexOf('\n', start);
        return text.slice(start, end < 0 ? text.length : end);
      } catch (error) { if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
    }
    return '';
  };
  for (const item of reviewItems) {
    if (item.kind === 'unsupported_source_statement' && /^\s*label\s+[\w.]+(?:\([^\r\n]*\))?\s*:\s*(?:#.*)?$/u.test(await sourceLine(item))) {
      contextualReviewItems.push({ ...item, classification: 'control-flow-label' }); continue;
    }
    contextualReviewItems.push(item);
  }
  const diagnostics = groupReviewDiagnostics(contextualReviewItems);
  const { extractionIssues, nativeReviewIssues, presentationItems, informationalItems } = diagnostics;
  const nonTextReviewItems = [...diagnostics.nonTextReviewItems, ...presentationItems];
  const unresolved = resources.filter(item => item.kind === 'display-text-candidate');
  const summary = Object.fromEntries(['extracted', 'display-text-candidate', 'script-resource', 'image-candidate', 'technical-metadata', 'unclassified'].map(kind => [kind, resources.filter(item => item.kind === kind).length]));
  summary.extracted = resources.filter(item => item.hasExtractedText).length;
  summary.unresolvedCandidates = dynamicCandidates.length + jsonCandidates.length + callCandidates.length;
  summary.resolvedCandidates = exactMatches.size;
  summary.adapterCandidates = classifiedCandidates.filter(item => item.classification === 'adapter_required').length;
  summary.nonDisplayCandidates = classifiedCandidates.filter(item => item.classification && !['display_unresolved', 'adapter_required', 'display-reference', 'non-linguistic-display'].includes(item.classification)).length;
  summary.unresolvedExpressions = expressionCandidates.filter(item => item.status !== 'resolved').length;
  summary.resolvedExpressions = expressionCandidates.length - summary.unresolvedExpressions;
  summary.unreviewedClusters = unknownClusters.filter(item => item.status === 'unknown' && item.proseLike).length;
  Object.assign(summary, diagnostics.summary);
  summary.resourceRoutes = resourceRouteSummary(resources);
  const unitCount = units.length || inventory.unitCount || 0;
  const structuralRecoveryWarnings = inventory.coverage?.structuralRecoveryWarnings ?? 0;
  // Triggers name remaining work only. Reviewed clusters leave 'unknown' once a coverage decision is
  // applied; expression reviews preserve the display site without requiring a redundant adapter.
  const triggers = [...(!unitCount ? ['zero-text'] : []), ...(unresolved.length || dynamicCandidates.length ? ['suspected-omission'] : []), ...(summary.unresolvedExpressions ? ['unresolved-display-expressions'] : []), ...(summary.unreviewedClusters ? ['unknown-text-clusters'] : []), ...(nativeReviewIssues.length ? ['native-schema-review'] : []), ...(extractionIssues.length || structuralRecoveryWarnings ? ['partial-extraction'] : [])];
  return {
    format: 'pinhao-extraction-coverage-1', reviewDiagnosticsVersion: REVIEW_DIAGNOSTICS_VERSION, resourceRoutingVersion: RESOURCE_ROUTING_VERSION, scannedAt: new Date().toISOString(), resources, summary, unitCount,
    reviewItems, issues, extractionIssues, nativeReviewIssues, presentationItems, informationalItems, dynamicCandidates: [...dynamicCandidates, ...jsonCandidates, ...callCandidates], classifiedCandidates, displaySites, unknownClusters, sourceContextHash, coverageDecisions: [...coverageDecisions.values()], resolvedCandidates: [...exactMatches.values()], nonTextReviewItems, structuralRecoveryWarnings,
    imageCandidates: inventory.images ?? [], sampledResources: sampled + sampledUnknown, sampledUnknownResources: sampledUnknown, truncated,
    scanCache: { status: index.status, files: index.size },
    needsAdaptation: triggers.length > 0, triggers,
    completeness: triggers.length || truncated ? 'review-required' : 'complete',
    runtime: inventory.runtimeVerified ? { status: 'passed' } : { status: 'pending' },
  };
}
