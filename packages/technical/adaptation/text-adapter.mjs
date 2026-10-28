import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { checkedPath, relativeFile } from './paths.mjs';
import { decodeQuotedLiteral } from '../coverage.mjs';
import { verifyTextStructure, ordinaryScriptLiterals } from './literal-structure.mjs';
import { assertJsonFieldWritable } from '../json-field-policy.mjs';
import { assertScriptFieldsWritable } from '../script-field-policy.mjs';
import { selectEmbeddedText, embeddedText } from '../embedded-text.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const pointerFor = parts => '/' + parts.map(part => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
const fileOf = item => String(item.file ?? item.locator?.file ?? item.context?.file ?? '').replace(/^res:\/\//, '').replaceAll('\\', '/');
const locationKey = (file, locator) => typeof locator?.pointer === 'string' ? JSON.stringify([file, 'json', locator.pointer,
  ...(locator.segment ? [[locator.segment.syntax, locator.segment.prefix, locator.segment.suffix]] : [])])
  : Number.isSafeInteger(locator?.byteStart) && Number.isSafeInteger(locator?.byteEnd) ? JSON.stringify([file, 'utf8', locator.byteStart, locator.byteEnd]) : undefined;

function jsonValue(document, pointer) {
  if (!pointer.startsWith('/') || /~(?![01])/.test(pointer)) throw new Error('候选缺少精确的 JSON 字段定位');
  let value = document;
  for (const key of pointer.slice(1).split('/').map(item => item.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error('候选 JSON 字段已改变');
    value = value[key];
  }
  return value;
}

// This function is serialized into the same restricted guest as handwritten adapters.
function textAdapter(specifications, segmentText) {
  const files = [...new Set(specifications.map(item => item.file))];
  const utf8Size = text => {
    let size = 0;
    for (const character of text) { const code = character.codePointAt(0); size += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4; }
    return size;
  };
  const at = (document, pointer) => {
    const parts = pointer.slice(1).split('/').map(item => item.replace(/~1/g, '/').replace(/~0/g, '~'));
    let parent = document;
    for (const part of parts.slice(0, -1)) { if (!parent || !Object.hasOwn(parent, part)) throw new Error('JSON path changed'); parent = parent[part]; }
    const key = parts[parts.length - 1];
    if (!parent || !Object.hasOwn(parent, key) || typeof parent[key] !== 'string') throw new Error('JSON display field changed');
    return { parent, key };
  };
  const extract = host => {
    const units = [];
    for (const file of files) {
      const text = host.readText(file), selected = specifications.filter(item => item.file === file);
      if (selected[0].pointer) {
        const document = JSON.parse(text.replace(/^\uFEFF/, ''));
        for (const item of selected) {
          const target = at(document, item.pointer);
          units.push({ id: item.id, source: item.segment ? segmentText(target.parent[target.key], item.segment) : target.parent[target.key],
            kind: 'text', context: { file, evidence: 'technical-agent-selected', ...(item.reason ? { selectionReason: item.reason } : {}) },
            locator: { file, pointer: item.pointer, ...(item.segment ? { segment: item.segment } : {}) } });
        }
      } else {
        let delta = 0;
        for (const item of selected) {
          const start = item.literalStart + delta;
          if (text.slice(start, start + item.quote.length) !== item.quote) throw new Error('Quoted source boundary changed');
          const bodyStart = start + item.quote.length;
          let end = bodyStart;
          while (end < text.length && text.slice(end, end + item.quote.length) !== item.quote) {
            if (text[end] === '\\') end += 2; else end++;
          }
          if (end >= text.length) throw new Error('Quoted source terminator missing');
          units.push({ id: item.id, source: text.slice(bodyStart, end), kind: 'script_display',
            context: { file, evidence: 'technical-agent-selected', ...(item.reason ? { selectionReason: item.reason } : {}), textAdapter: { charStart: bodyStart, charEnd: end } },
            locator: { file, byteStart: utf8Size(text.slice(0, bodyStart)), byteEnd: utf8Size(text.slice(0, end)) } });
          delta += end + item.quote.length - (item.literalEnd + delta);
        }
      }
    }
    return { units, coverage: files.map(file => ({ file, status: 'extracted' })) };
  };
  return {
    detect(host) { try { return { matched: extract(host).units.length === specifications.length }; } catch { return { matched: false }; } },
    extract,
    validate() { return { valid: true }; },
    roundtrip(host) { for (const file of files) host.writeBytes(file, host.readBytes(file)); return {}; },
    build(host, input) {
      for (const file of files) {
        let text = host.readText(file);
        const selected = input.units.filter(item => item.locator.file === file);
        if (selected[0].locator.pointer) {
          const document = JSON.parse(text.replace(/^\uFEFF/, ''));
          for (const item of selected) if (Object.hasOwn(input.translations, item.id)) {
            const target = at(document, item.locator.pointer);
            const segment = item.locator.segment;
            if (segment) segmentText(target.parent[target.key], segment);
            const translated = input.translations[item.id];
            if (segment && /[\r\n\0]/.test(translated)) throw new Error('A plugin command cannot contain a new physical line or null character');
            if (segment && translated !== item.source) {
              const contract = input.representationContracts?.[item.id];
              if (contract?.format !== 'pinhao-embedded-command-contract-1') throw new Error('EMBEDDED_REPRESENTATION_PENDING');
              if (contract.target.mode === 'one-argument' && translated.includes(' ')) throw new Error('EMBEDDED_TEXT_UNREPRESENTABLE');
            }
            Object.defineProperty(target.parent, target.key, { value: segment ? segment.prefix + translated + segment.suffix : translated, enumerable: true, configurable: true, writable: true });
          }
          text = JSON.stringify(document);
        } else {
          for (const item of selected.sort((left, right) => right.context.textAdapter.charStart - left.context.textAdapter.charStart)) if (Object.hasOwn(input.translations, item.id)) {
            const target = item.context.textAdapter;
            text = text.slice(0, target.charStart) + input.translations[item.id] + text.slice(target.charEnd);
          }
        }
        host.writeText(file, text);
      }
      return {};
    },
    assemble() { return {}; },
  };
}

/** Select exact host candidates; the ordinary lab still validates and promotes the result. */
export async function createTextAdapter({ candidates, gameDir, engine, existingUnits = [], assignment, id }) {
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > 2000) throw new Error('请选择本任务的显示文字候选');
  const documents = new Map(), specifications = [], locations = new Set(), producerHints = [];
  const owned = new Set(existingUnits.map(unit => locationKey(fileOf(unit), unit.locator ?? unit.context?.adaptationLocator ??
    (Array.isArray(unit.context?.path) ? { pointer: pointerFor(unit.context.path) } : undefined))).filter(Boolean));
  const ownedContainers = new Set(existingUnits.flatMap(unit => {
    const locator = unit.locator ?? unit.context?.adaptationLocator;
    return typeof locator?.pointer === 'string' ? [JSON.stringify([fileOf(unit), locator.pointer])] : [];
  }));
  for (const candidate of candidates) {
    if (candidate.classification && candidate.classification !== 'display_unresolved') throw new Error('已分类为逻辑或调试输出的候选继续保留原值');
    const file = relativeFile(fileOf(candidate));
    if (assignment && !assignment.files.includes(file)) throw new Error('文字候选超出本次资源分工');
    let document = documents.get(file);
    if (!document) {
      const source = await checkedPath(gameDir, file);
      if ((await lstat(source)).size > 16 * 1024 * 1024) throw new Error('文字脚手架使用不超过 16 MiB 的单个文本资源');
      const bytes = await readFile(source), text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      document = { bytes, text }; documents.set(file, document);
    }
    const pointer = candidate.locator?.pointer ?? (Array.isArray(candidate.path) ? pointerFor(candidate.path) : undefined);
    let specification, locator;
    if (path.extname(file).toLowerCase() === '.json' && pointer) {
      const parsed = JSON.parse(document.text.replace(/^\uFEFF/, ''));
      const value = jsonValue(parsed, pointer);
      if (candidate.locator?.segment) {
        locator = selectEmbeddedText({ file, document: parsed, pointer, text: candidate.source, reason: candidate.reason });
        if (JSON.stringify(locator.segment) !== JSON.stringify(candidate.locator.segment)) throw new Error('命令片段定位与主机当前解析不一致');
        if (specifications.some(item => item.file === file && item.pointer === pointer)) throw new Error('同一命令容器的显示正文必须作为一个完整语义单元选择');
        specification = { file, pointer, segment: locator.segment };
      } else {
        if (typeof value !== 'string' || value !== candidate.source) throw new Error('候选 JSON 原文与当前字段不一致');
        assertJsonFieldWritable({ file, document: parsed, pointer });
        specification = { file, pointer }; locator = { file, pointer };
      }
    } else {
      const { start, end, render } = candidate.target ?? {};
      if (render !== 'quoted' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) throw new Error('文字脚手架需要精确的引号字符串或 JSON 字段定位');
      const characters = Array.from(document.text);
      if (end > characters.length) throw new Error('候选字符串超出资源范围');
      const literal = characters.slice(start, end).join(''), decoded = decodeQuotedLiteral(literal);
      if (!decoded || decoded.value !== candidate.source) throw new Error('候选字符串原文与当前资源不一致');
      const literalStart = characters.slice(0, start).join('').length, literalEnd = characters.slice(0, end).join('').length;
      const quote = literal.slice(0, decoded.quoteBytes);
      specification = { file, literalStart, literalEnd, quote };
      locator = { file, byteStart: Buffer.byteLength(document.text.slice(0, literalStart + quote.length)), byteEnd: Buffer.byteLength(document.text.slice(0, literalEnd - quote.length)) };
      assertScriptFieldsWritable({ file, before: document.bytes, units: [{ locator }] });
    }
    const identity = locationKey(file, locator);
    if (locations.has(identity)) throw new Error('显示候选包含重复定位');
    if (owned.has(identity)) throw new Error('该文字定位已经由现有提取器处理');
    if (locator.pointer && ownedContainers.has(JSON.stringify([file, locator.pointer]))) throw new Error('该 JSON 容器已有文字写入定位，请联合修正而非新增重叠片段');
    const unitId=`text:${hash(locator)}`;
    locations.add(identity); specifications.push({ ...specification, ...(candidate.reason ? { reason: candidate.reason } : {}), id: unitId });
    if (candidate.consumerHints) producerHints.push({unitId,selector:{file,...(pointer?{pointer}:{text:candidate.source})},hints:candidate.consumerHints});
  }
  specifications.sort((left, right) => left.file.localeCompare(right.file) || (left.literalStart ?? 0) - (right.literalStart ?? 0));
  const files = [...documents.keys()].sort();
  return { manifest: { schemaVersion: 1, id: id ?? `text-${hash(specifications)}`, version: '1.0.0', engine: engine || 'unknown', scope: { files }, license: 'GPL-3.0-or-later', sources: [] },
    code: `(${textAdapter.toString()})(${JSON.stringify(specifications)}, ${embeddedText.toString()})`, ...(producerHints.length?{producerHints}:{}) };
}

/** The agent selects proven display text; the host owns its protected container boundaries. */
export async function createEmbeddedSelections({ selections, gameDir, engine, existingUnits = [], assignment, id }) {
  if (!Array.isArray(selections) || !selections.length || selections.length > 2000) throw new Error('请选择 1..2000 处命令容器内的完整显示正文');
  const documents = new Map(), candidates = [];
  for (const selection of selections) {
    const file = relativeFile(fileOf(selection));
    if (assignment && !assignment.files.includes(file)) throw new Error('显示正文来源超出当前分工，请先申请关联资源范围');
    if (!documents.has(file)) {
      const source = await checkedPath(gameDir, file);
      if ((await lstat(source)).size > 16 * 1024 * 1024) throw new Error('显示片段单个资源不超过 16 MiB');
      documents.set(file, JSON.parse((await readFile(source, 'utf8')).replace(/^\uFEFF/, '')));
    }
    const locator = selectEmbeddedText({ file, document: documents.get(file), pointer: selection.pointer, text: selection.text, reason: selection.reason });
    candidates.push({ file, source: selection.text, reason: selection.reason, ...(selection.consumerHints ? { consumerHints: selection.consumerHints } : {}), locator, classification: 'display_unresolved' });
  }
  return createTextAdapter({ candidates, gameDir, engine, existingUnits, assignment, id });
}

/** Agent selects literal meaning; the host supplies exact existing adapter bindings, not new permissions. */
export async function createLiteralSelections({ selections, gameDir, engine, existingUnits = [], assignment, id }) {
  if (!Array.isArray(selections) || !selections.length || selections.length > 2000) throw new Error('请选择 1..2000 处有用途依据的原文字句 text');
  const documents = new Map(), candidates = [];
  for (const [selectionIndex, selection] of selections.entries()) {
    const file = relativeFile(fileOf(selection));
    const selectionLabel = `selections[${selectionIndex}] (0-based index) file=${JSON.stringify(file)} text=${JSON.stringify(String(selection.text ?? '').slice(0, 100))}`;
    if (assignment && !assignment.files.includes(file)) throw new Error('文字选择超出本次资源分工');
    if (Object.hasOwn(selection, 'literal') || typeof selection.text !== 'string' || !selection.text.trim()) throw new Error('文字选择只接受 text 原文字句，例如 {"text":"Buy","reason":"商店购买按钮"}；不要传 literal、源码外层引号或空字符串');
    if (typeof selection.reason !== 'string' || !selection.reason.trim()) throw new Error('文字选择需要实际显示用途依据 reason');
    let document = documents.get(file);
    if (!document) {
      const source = await checkedPath(gameDir, file);
      if ((await lstat(source)).size > 16 * 1024 * 1024) throw new Error('文字脚手架使用不超过 16 MiB 的单个文本资源');
      const bytes = await readFile(source), text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const literals = ordinaryScriptLiterals({ file, text }).flatMap(literal => {
        const decoded = decodeQuotedLiteral(text.slice(literal.start, literal.end));
        return decoded && decoded.value.trim() ? [{ ...literal, decoded }] : [];
      });
      document = { bytes, text, literals, matches: new Map(), selections: [] }; documents.set(file, document);
    }
    let matches = document.matches.get(selection.text);
    if (!matches) {
      matches = document.literals.filter(literal => selection.text === (literal.value ?? literal.decoded.value) || selection.text === literal.decoded.body);
      document.matches.set(selection.text, matches);
    }
    if (!matches.length) throw new Error(`${selectionLabel}：当前资源没有精确匹配的普通脚本文字 text；注释、正则、复杂插值及 JSON 字段不能当作普通显示字句`);
    if (selection.occurrence === undefined && matches.length !== 1) throw new Error(`${selectionLabel}：text 精确匹配 ${matches.length} 处普通字符串；请按真实源码字符串顺序明确 occurrence（从 0 开始，不计注释）`);
    const occurrence = selection.occurrence ?? 0;
    if (!Number.isSafeInteger(occurrence) || occurrence < 0 || occurrence >= matches.length) throw new Error(`${selectionLabel}：text 精确匹配 ${matches.length} 处，occurrence 合法范围为 0..${matches.length - 1}；每个不同 text 分别从 0 计数，不是 selections 数组序号；唯一匹配时可省略 occurrence`);
    document.selections.push({ selection, ...matches[occurrence] });
  }
  for (const [file, document] of documents) {
    const positions = [...new Set(document.selections.flatMap(item => [item.start, item.end, item.start + item.decoded.quoteBytes, item.end - item.decoded.quoteBytes]))].sort((a, b) => a - b);
    const offsets = new Map(); let cursor = 0, scalar = 0, byte = 0;
    for (const position of positions) {
      const segment = document.text.slice(cursor, position);
      scalar += Array.from(segment).length; byte += Buffer.byteLength(segment); cursor = position;
      offsets.set(position, { scalar, byte });
    }
    const bindings = document.selections.map(({ selection, decoded, start, end }, index) => {
      candidates.push({ file, source: decoded.value, reason: selection.reason.trim(), ...(selection.consumerHints ? { consumerHints: selection.consumerHints } : {}), classification: 'display_unresolved',
        target: { start: offsets.get(start).scalar, end: offsets.get(end).scalar, render: 'quoted' } });
      return { id: `selected:${index}`, rawSource: decoded.body, locator: { file,
        byteStart: offsets.get(start + decoded.quoteBytes).byte, byteEnd: offsets.get(end - decoded.quoteBytes).byte } };
    });
    // No-change verification rejects comments, embedded expressions and unsupported quote boundaries.
    verifyTextStructure({ file, before: document.bytes, after: document.bytes, units: bindings });
  }
  return createTextAdapter({ candidates, gameDir, engine, existingUnits, assignment, id });
}
