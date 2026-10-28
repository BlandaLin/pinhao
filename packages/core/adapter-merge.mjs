import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { parseExpressionAt } from 'acorn';
import { diffChars } from 'diff';
import { checkedPath, ensureRoot, independentRoot, relativeFile } from '../technical/adaptation/paths.mjs';
import { validateTranslation } from '../exchange/index.mjs';
import { embeddedText, replaceEmbeddedText } from '../technical/embedded-text.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const maxBytes = 16 * 1024 * 1024;
const controls = /\\(?:[A-Za-z]+(?:\[(?:[^\[\]\r\n]|\[[^\]\r\n]*\])*\]|<[^>\r\n]*>)?|[^\r\n])|%[-+0-9.]*[dsf]|%[1-9]\d*|\r\n|\n|\r/g;
const failure = (message, code = 'ADAPTER_MERGE_CONFLICT') => Object.assign(new Error(message), { code });

function pointerParts(pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || /~(?![01])/.test(pointer)) throw failure('合并需要明确的 JSON 字段定位', 'ADAPTER_MERGE_LOCATOR');
  return pointer.slice(1).split('/').map(value => value.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function jsonField(root, parts) {
  let parent = root;
  for (const key of parts.slice(0, -1)) {
    if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw failure('JSON 定位超出当前资源结构');
    parent = parent[key];
  }
  const key = parts.at(-1);
  if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw failure('JSON 文字字段已经改变');
  return { parent, key, value: parent[key] };
}

function jsonNode(root, parts) {
  let node = root;
  for (const key of parts) {
    if (node.type === 'ObjectExpression') node = node.properties.findLast(property => property.type === 'Property' && property.key.value === key)?.value;
    else if (node.type === 'ArrayExpression' && /^(?:0|[1-9]\d*)$/.test(key)) node = node.elements[Number(key)];
    else node = undefined;
    if (!node) throw failure('JSON 语法节点与文字定位不一致');
  }
  if (node.type !== 'Literal' || typeof node.value !== 'string') throw failure('补充文字只合并明确的字符串字段');
  return node;
}

function utf8(bytes) {
  try { return decoder.decode(bytes); }
  catch { throw failure('文字合并需要已确认的 UTF-8 资源', 'ADAPTER_MERGE_ENCODING'); }
}

function sourceOf(unit) {
  if (typeof unit.rawSource === 'string') return unit.rawSource;
  if (typeof unit.source !== 'string') throw failure('文字定位缺少原始源文', 'ADAPTER_MERGE_LOCATOR');
  return unit.source.replace(/\{\{CTRL\d{4}\}\}/g, token => {
    if (typeof unit.controls?.[token] !== 'string') throw failure('文字保护标记缺少原始绑定');
    return unit.controls[token];
  });
}

function checkControls(before, after, id) {
  if (!isDeepStrictEqual(before.match(controls) ?? [], after.match(controls) ?? [])) throw failure(`补充文字改变了控制符：${id}`, 'ADAPTER_MERGE_CONTROLS');
}

function translationIndex(translations) {
  if (translations === undefined) return null;
  const records = Array.isArray(translations) ? translations : Object.entries(translations).map(([id, translation]) => ({ id, translation }));
  const index = new Map();
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || typeof record.translation !== 'string' || index.has(record.id)) throw failure('合并译文存在重复或无效 ID', 'ADAPTER_MERGE_TRANSLATIONS');
    index.set(record.id, record.translation);
  }
  return index;
}

function targetOf(unit, index) {
  const value = index?.get(unit.id) ?? unit.translation;
  if (value === undefined) return sourceOf(unit);
  validateTranslation(unit, value);
  const restored = value.replace(/\{\{CTRL\d{4}\}\}/g, token => {
    if (typeof unit.controls?.[token] !== 'string') throw failure('译文控制符缺少原始绑定');
    return unit.controls[token];
  });
  checkControls(sourceOf(unit), restored, unit.id);
  return restored;
}

function mergeJson(baseline, native, adapter, units, index, representationContracts) {
  const baselineText = utf8(baseline), nativeText = utf8(native), adapterText = utf8(adapter);
  let base, current, supplied;
  try {
    base = JSON.parse(baselineText.replace(/^\uFEFF/, ''));
    current = JSON.parse(nativeText.replace(/^\uFEFF/, ''));
    supplied = JSON.parse(adapterText.replace(/^\uFEFF/, ''));
  } catch { throw failure('JSON 合并需要完整可解析的三个资源版本', 'ADAPTER_MERGE_FORMAT'); }
  const expectedAdapter = structuredClone(base), expectedOutput = structuredClone(current);
  const root = parseExpressionAt(nativeText, nativeText.search(/[^\s\uFEFF]/), { ecmaVersion: 'latest' });
  const patches = [], changes = [], pointers = new Set();
  for (const unit of units) {
    const parts = pointerParts(unit.locator.pointer);
    const key = JSON.stringify(parts);
    if (pointers.has(key)) throw failure(`JSON 字段存在重复补充定位：${unit.id}`, 'ADAPTER_MERGE_LOCATOR');
    pointers.add(key);
    const original = jsonField(base, parts).value, next = jsonField(supplied, parts).value, existing = jsonField(current, parts).value;
    if (typeof original !== 'string' || typeof next !== 'string' || typeof existing !== 'string') throw failure(`JSON 文字原文与绑定不一致：${unit.id}`);
    const segment = unit.locator.segment;
    const originalText = segment ? embeddedText(original, segment) : original;
    const nextText = segment ? embeddedText(next, segment) : next;
    if (originalText !== sourceOf(unit)) throw failure(`JSON 文字原文与绑定不一致：${unit.id}`);
    checkControls(originalText, nextText, unit.id);
    if (index?.has(unit.id) && nextText !== targetOf(unit, index)) throw failure(`补充文件与本轮译文不一致：${unit.id}`);
    const expectedField = jsonField(expectedAdapter, parts);
    if (segment) replaceEmbeddedText({ file: unit.locator.file, document: expectedAdapter, locator: unit.locator, source: originalText, translation: nextText, contract: representationContracts?.[unit.id] });
    else Object.defineProperty(expectedField.parent, expectedField.key, { value: next, writable: true, configurable: true, enumerable: true });
    if (next === original) { changes.push({ id: unit.id, pointer: unit.locator.pointer, status: 'unchanged' }); continue; }
    if (existing === next) { changes.push({ id: unit.id, pointer: unit.locator.pointer, status: 'already-present' }); continue; }
    if (existing !== original) throw failure(`原生译文与补充译文修改了同一字段：${unit.id}`);
    const node = jsonNode(root, parts);
    patches.push({ start: node.start, end: node.end, text: JSON.stringify(next) });
    const outputField = jsonField(expectedOutput, parts);
    Object.defineProperty(outputField.parent, outputField.key, { value: next, writable: true, configurable: true, enumerable: true });
    changes.push({ id: unit.id, pointer: unit.locator.pointer, status: 'applied' });
  }
  if (!isDeepStrictEqual(expectedAdapter, supplied)) throw failure('补充文件改变了文字定位之外的逻辑或资源引用');
  let output = nativeText;
  for (const patch of patches.sort((left, right) => right.start - left.start)) output = output.slice(0, patch.start) + patch.text + output.slice(patch.end);
  if (!isDeepStrictEqual(JSON.parse(output.replace(/^\uFEFF/, '')), expectedOutput)) throw failure('JSON 合并结果与结构白名单不一致');
  return { output: patches.length ? Buffer.from(output, 'utf8') : native, kind: 'json-pointer', changes, nativeChanges: baseline.equals(native) ? 0 : 1 };
}

async function byteEdits(before, after, { signal, timeoutMs, maxEditLength }) {
  if (before.equals(after)) return [];
  await yieldEventLoop();
  signal?.throwIfAborted();
  // Latin-1 keeps one diff token per byte, including multi-byte UTF-8 text.
  const parts = diffChars(before.toString('latin1'), after.toString('latin1'), { timeout: timeoutMs, maxEditLength });
  await yieldEventLoop();
  signal?.throwIfAborted();
  if (!parts) throw failure('原生改动映射达到复杂度限制，请保留进度后使用明确字段定位', 'ADAPTER_MERGE_DIFF_LIMIT');
  const edits = []; let position = 0, pending;
  const flush = () => { if (pending) { edits.push({ start: pending.start, end: pending.end, bytes: Buffer.concat(pending.chunks) }); pending = undefined; } };
  for (const part of parts) {
    if (part.added || part.removed) {
      pending ??= { start: position, end: position, chunks: [] };
      if (part.removed) { position += part.value.length; pending.end = position; }
      if (part.added) pending.chunks.push(Buffer.from(part.value, 'latin1'));
    } else { flush(); position += part.value.length; }
  }
  flush();
  return edits;
}

function mapSpan(span, edits) {
  let delta = 0;
  for (const edit of edits) {
    if (span.start === span.end && edit.start === span.start) throw failure(`原生改动与补充文字插入点重叠：${span.id}`);
    if (edit.end <= span.start) delta += edit.bytes.length - (edit.end - edit.start);
    else if (edit.start < span.end) throw failure(`原生改动与补充文字字节范围重叠：${span.id}`);
  }
  return { start: span.start + delta, end: span.end + delta };
}

async function mergeSpans(baseline, native, adapter, units, index, options) {
  utf8(baseline); utf8(native); utf8(adapter);
  if (!index && units.some(unit => typeof unit.translation !== 'string')) throw failure('UTF-8 字节合并需要本轮明确译文，以保留相邻文字单元的准确边界', 'ADAPTER_MERGE_TRANSLATIONS');
  const spans = units.map(unit => ({ id: unit.id, start: unit.locator.byteStart, end: unit.locator.byteEnd, original: Buffer.from(sourceOf(unit), 'utf8'), bytes: Buffer.from(targetOf(unit, index), 'utf8') })).sort((left, right) => left.start - right.start || left.end - right.end);
  let cursor = 0; const locations = new Set();
  const expected = [];
  for (const span of spans) {
    const location = `${span.start}:${span.end}`;
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < cursor || span.end < span.start || span.end > baseline.length || locations.has(location) || !baseline.subarray(span.start, span.end).equals(span.original)) throw failure(`UTF-8 原文定位重叠或基线不一致：${span.id}`, 'ADAPTER_MERGE_LOCATOR');
    locations.add(location);
    expected.push(baseline.subarray(cursor, span.start), span.bytes); cursor = span.end;
  }
  expected.push(baseline.subarray(cursor));
  if (!Buffer.concat(expected).equals(adapter)) throw failure('补充文件与明确译文不一致，或修改了文字范围之外的字节');
  const nativeEdits = await byteEdits(baseline, native, options);
  const changed = spans.filter(span => !span.original.equals(span.bytes));
  const reverseEdits = changed.length && nativeEdits.length
    ? (await byteEdits(Buffer.from(baseline).reverse(), Buffer.from(native).reverse(), options)).map(edit => ({ start: baseline.length - edit.end, end: baseline.length - edit.start, bytes: Buffer.from(edit.bytes).reverse() })).sort((left, right) => left.start - right.start)
    : nativeEdits;
  const patches = [], changes = [];
  for (const span of spans) {
    options.signal?.throwIfAborted();
    if (span.original.equals(span.bytes)) { changes.push({ id: span.id, status: 'unchanged' }); continue; }
    let forward, reverse, forwardError, reverseError;
    try { forward = mapSpan(span, nativeEdits); } catch (error) { forwardError = error; }
    try { reverse = mapSpan(span, reverseEdits); } catch (error) { reverseError = error; }
    if (forwardError && reverseError) throw forwardError;
    if (forwardError || reverseError || forward.start !== reverse.start || forward.end !== reverse.end) throw failure(`重复字节使原生改动定位存在歧义：${span.id}`, 'ADAPTER_MERGE_AMBIGUOUS');
    if (!native.subarray(forward.start, forward.end).equals(span.original)) throw failure(`原生改动映射与源文不一致：${span.id}`);
    patches.push({ ...forward, bytes: span.bytes });
    changes.push({ id: span.id, baselineStart: span.start, baselineEnd: span.end, nativeStart: forward.start, nativeEnd: forward.end, status: 'applied' });
  }
  const chunks = []; cursor = 0;
  for (const patch of patches.sort((left, right) => left.start - right.start)) {
    if (patch.start < cursor) throw failure('合并后的文字范围发生重叠');
    chunks.push(native.subarray(cursor, patch.start), patch.bytes); cursor = patch.end;
  }
  chunks.push(native.subarray(cursor));
  return { output: Buffer.concat(chunks), kind: 'utf8-span', changes, nativeChanges: nativeEdits.length };
}

/** Merge verified supplemental text into a separate overlay, retaining every other native byte. */
export async function mergeAdapterResource({ baselineFile, nativeFile, adapterFile, units, translations, outputFile, signal, representationContracts, timeoutMs = 2000, maxEditLength = 100000 }) {
  signal?.throwIfAborted();
  if (!Array.isArray(units) || !units.length || !outputFile) throw failure('合并需要绑定的文字单元与独立输出路径', 'ADAPTER_MERGE_LOCATOR');
  const files = new Set(), ids = new Set();
  for (const unit of units) {
    if (!unit?.locator || typeof unit.id !== 'string' || ids.has(unit.id)) throw failure('合并文字 ID 或定位无效', 'ADAPTER_MERGE_LOCATOR');
    ids.add(unit.id); files.add(relativeFile(unit.locator.file));
  }
  if (files.size !== 1) throw failure('每次合并须对应同一资源文件', 'ADAPTER_MERGE_LOCATOR');
  const inputs = [];
  for (const file of [baselineFile, nativeFile, adapterFile]) {
    const target = await checkedPath(path.dirname(path.resolve(file)), path.basename(file));
    const info = await lstat(target);
    if (!info.isFile() || info.size > maxBytes) throw failure('合并资源需要限定大小的普通文件', 'ADAPTER_MERGE_RESOURCE_LIMIT');
    inputs.push({ path: await realpath(target), bytes: await readFile(target, { signal }) });
  }
  const outputDir = await independentRoot(path.dirname(inputs[0].path), path.dirname(path.resolve(outputFile)));
  await ensureRoot(outputDir);
  const target = await checkedPath(outputDir, path.basename(outputFile), { write: true });
  const canonicalTarget = await realpath(target).catch(error => { if (error.code !== 'ENOENT') throw error; return target; });
  if (inputs.some(input => input.path === canonicalTarget)) throw failure('合并结果需要独立的覆盖文件', 'ADAPTER_MERGE_OUTPUT');
  const [baseline, native, adapter] = inputs.map(input => input.bytes);
  const index = translationIndex(translations);
  if (index && [...index.keys()].some(id => !ids.has(id))) throw failure('合并译文含有未绑定 ID', 'ADAPTER_MERGE_TRANSLATIONS');
  let merged;
  if (units.every(unit => typeof unit.locator.pointer === 'string')) merged = mergeJson(baseline, native, adapter, units, index, representationContracts);
  else if (units.every(unit => Number.isSafeInteger(unit.locator.byteStart) && Number.isSafeInteger(unit.locator.byteEnd))) merged = await mergeSpans(baseline, native, adapter, units, index, { signal, timeoutMs, maxEditLength });
  else throw failure('当前资源需要已验证的 JSON pointer 或 UTF-8 字节范围定位', 'ADAPTER_MERGE_LOCATOR');
  signal?.throwIfAborted();
  await checkedPath(outputDir, path.basename(outputFile), { write: true });
  await writeFile(target, merged.output, { signal });
  return { outputFile: target, files: [...files], merged: { kind: merged.kind, applied: merged.changes.filter(change => change.status === 'applied').length, preservedNative: true, nativeChanges: merged.nativeChanges, changes: merged.changes }, hashes: { baseline: digest(baseline), native: digest(native), adapter: digest(adapter), output: digest(merged.output) } };
}
