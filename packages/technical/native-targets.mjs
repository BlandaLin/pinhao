import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const fields = new Set(['id', 'file', 'source', 'initial_value', 'controls', 'kind', 'targets', 'pointer', 'locator']);
const selected = parts => !parts.length || parts[0] === 'schema' || parts[0] === 'files'
  || parts[0] === 'units' && (parts.length <= 2 || fields.has(parts[2])
    || parts[2] === 'contexts' && (parts.length <= 4 || parts[4] === 'path'));

/** Ownership metadata excludes scene evidence, previews and editable translations. */
export function projectNativeTargets(manifest, manifestSha256) {
  return { format: 'pinhao-native-targets-1', manifestSha256, schema: manifest.schema, files: manifest.files ?? {},
    units: Object.fromEntries(Object.entries(manifest.units ?? {}).map(([id, unit]) => [id, {
      ...Object.fromEntries(Object.entries(unit).filter(([key]) => fields.has(key))),
      ...(unit.contexts?.some(context => Array.isArray(context.path))
        ? { contexts: unit.contexts.filter(context => Array.isArray(context.path)).map(context => ({ path: context.path })) } : {}),
    }])) };
}

// Legacy workbenches can contain hundreds of MB of repeated contexts. Parse their
// JSON grammar while retaining only ownership fields, rather than materializing it.
class TargetProjection {
  constructor(select = selected, transform = value => value) { this.frames = []; this.rootState = 'value'; this.token = ''; this.mode = ''; this.select = select; this.transform = transform; }
  error() { throw new SyntaxError('Invalid native ownership manifest JSON'); }
  valuePath() {
    const parent = this.frames.at(-1);
    return parent ? [...parent.path, parent.type === 'object' ? parent.key : parent.index] : [];
  }
  accept(value, keep) {
    const parent = this.frames.at(-1);
    if (keep) value = this.transform(value, this.valuePath());
    if (!parent) { if (this.rootState !== 'value') this.error(); this.value = value; this.rootState = 'done'; return; }
    if (parent.state !== 'value' && parent.state !== 'first') this.error();
    if (keep) {
      if (parent.type === 'object') Object.defineProperty(parent.value, parent.key, { value, enumerable: true, configurable: true, writable: true });
      else parent.value.push(value);
    }
    parent.state = 'comma'; parent.index++;
  }
  start(character) {
    const parent = this.frames.at(-1), valuePath = this.valuePath(), keep = this.select(valuePath);
    if (parent && parent.state !== 'value' && !(parent.type === 'array' && parent.state === 'first') || !parent && this.rootState !== 'value') this.error();
    if (character === '{' || character === '[') {
      if (this.frames.length >= 512) this.error();
      this.frames.push({ type: character === '{' ? 'object' : 'array', state: 'first', path: valuePath,
        keep, value: keep ? (character === '{' ? {} : []) : undefined, index: 0, keys: new Set() });
    } else if (character === '"') { this.mode = 'string'; this.token = keep ? '"' : ''; this.keep = keep; this.isKey = false; }
    else if (/[-\dtnf]/.test(character)) { this.mode = 'primitive'; this.token = character; this.keep = keep; }
    else this.error();
  }
  write(chunk) {
    for (let index = 0; index < chunk.length; index++) {
      const character = chunk[index];
      if (this.mode === 'string') {
        if (this.keep) this.token += character;
        if (this.unicode) { if (!/[\da-f]/i.test(character)) this.error(); this.unicode--; continue; }
        if (this.escape) {
          this.escape = false;
          if (character === 'u') this.unicode = 4;
          else if (!'"\\/bfnrt'.includes(character)) this.error();
          continue;
        }
        if (character === '\\') { this.escape = true; continue; }
        if (character.charCodeAt(0) < 32) this.error();
        if (character !== '"') continue;
        const value = this.keep ? JSON.parse(this.token) : undefined;
        if (this.isKey) {
          const parent = this.frames.at(-1);
          if (parent.keys.has(value)) this.error();
          parent.keys.add(value); parent.key = value; parent.state = 'colon';
        }
        else this.accept(value, this.keep);
        this.mode = ''; this.token = ''; continue;
      }
      if (this.mode === 'primitive') {
        if (!/[\s,\]}]/.test(character)) { this.token += character; if (this.token.length > 1024) this.error(); continue; }
        if (!/^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(this.token)) this.error();
        this.accept(this.keep ? JSON.parse(this.token) : undefined, this.keep); this.mode = ''; this.token = '';
      }
      if (character === '\uFEFF' && !this.frames.length && this.rootState === 'value') continue;
      if (/\s/.test(character)) continue;
      const parent = this.frames.at(-1);
      if (parent?.type === 'object' && ['first', 'key'].includes(parent.state)) {
        if (character === '}' && parent.state === 'first') { this.frames.pop(); this.accept(parent.value, parent.keep); }
        else if (character === '"') { this.mode = 'string'; this.token = '"'; this.keep = true; this.isKey = true; }
        else this.error();
      } else if (parent?.state === 'colon') { if (character !== ':') this.error(); parent.state = 'value'; }
      else if (parent?.state === 'comma') {
        if (character === ',') parent.state = parent.type === 'object' ? 'key' : 'value';
        else if (character === (parent.type === 'object' ? '}' : ']')) { this.frames.pop(); this.accept(parent.value, parent.keep); }
        else this.error();
      } else if (parent?.type === 'array' && parent.state === 'first' && character === ']') { this.frames.pop(); this.accept(parent.value, parent.keep); }
      else this.start(character);
    }
  }
  finish() {
    this.write(' ');
    if (this.mode || this.frames.length || this.rootState !== 'done') this.error();
    return this.value;
  }
}

/** Transform each completed value before its parent retains it; no giant context copy is built. */
export async function readJsonProjection(file, { signal, select = () => true, transform = value => value } = {}) {
  const projection = new TargetProjection(select, transform), digest = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const chunk of createReadStream(file, { signal })) {
    signal?.throwIfAborted(); digest.update(chunk); projection.write(decoder.decode(chunk, { stream: true }));
  }
  projection.write(decoder.decode());
  return { value: projection.finish(), sha256: digest.digest('hex') };
}

// A projection costs a full 18 MB streaming read plus its seal hash. One app
// process asks for the same untouched manifest repeatedly, so a (size, mtime)
// stamp of the manifest and its seal is enough to answer without re-reading.
const projectionCache = new Map();
const PROJECTION_CACHE_LIMIT = 8;

function cacheKey(info, seal) {
  return `${info.size}:${info.mtimeMs}:${seal.size}:${seal.mtimeMs}`;
}

export async function readNativeTargetManifest({ manifestPath, signal }) {
  if (!manifestPath) return undefined;
  try {
    const info = await lstat(manifestPath);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    const technical = path.join(path.dirname(manifestPath), 'technical');
    const sealPath = path.join(technical, 'manifest.sha256');
    const key = cacheKey(info, await lstat(sealPath));
    const cached = projectionCache.get(manifestPath);
    if (cached?.key === key) {
      signal?.throwIfAborted();
      return cached.manifest;
    }
    const expected = (await readFile(sealPath, 'utf8')).trim();
    let manifest;
    if (/^[\da-f]{64}$/i.test(expected)) {
      const hash = createHash('sha256'), projection = new TargetProjection();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      for await (const chunk of createReadStream(manifestPath, { signal })) {
        signal?.throwIfAborted(); hash.update(chunk);
        projection.write(decoder.decode(chunk, { stream: true }));
      }
      if (hash.digest('hex') === expected) {
        projection.write(decoder.decode());
        const projected = projectNativeTargets(projection.finish(), expected);
        if (projected.schema === 'rpgmaker-ai-work-v1') manifest = projected;
      }
    }
    projectionCache.delete(manifestPath);
    projectionCache.set(manifestPath, { key, manifest });
    if (projectionCache.size > PROJECTION_CACHE_LIMIT) projectionCache.delete(projectionCache.keys().next().value);
    return manifest;
  } catch (error) {
    if (error instanceof SyntaxError || error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA' || ['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return undefined;
    throw error;
  }
}
