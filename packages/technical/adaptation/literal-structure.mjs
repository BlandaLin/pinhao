import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'acorn';

const javascript = new Set(['.js', '.mjs', '.cjs']);
const quoted = new Set(['.gd', '.rpy', '.py', '.tscn', '.tres', '.rb']);
const plain = new Set(['.txt', '.csv', '.tsv']);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const failure = file => new Error(`文字回写改变了代码结构或字符串边界：${file}；请使用可信格式校验器`);
const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
const replacement = (unit, translations) => Object.hasOwn(translations, unit.id) ? translations[unit.id] : unit.rawSource;

function spansFor(before, after, units, translations, file) {
  const spans = [...units].sort((left, right) => left.locator.byteStart - right.locator.byteStart);
  const chunks = []; let cursor = 0, delta = 0;
  const seen = new Set();
  for (let index = 0; index < spans.length; index++) {
    const unit = spans[index];
    const { byteStart: start, byteEnd: end } = unit.locator;
    const value = replacement(unit, translations);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < cursor || end < start || end > before.length
        || typeof unit.id !== 'string' || seen.has(unit.id) || typeof unit.rawSource !== 'string' || typeof value !== 'string'
        || !before.subarray(start, end).equals(Buffer.from(unit.rawSource, 'utf8'))) throw failure(file);
    seen.add(unit.id);
    const encoded = Buffer.from(value, 'utf8');
    chunks.push(before.subarray(cursor, start), encoded);
    spans[index] = { ...unit, afterStart: start + delta, afterEnd: start + delta + encoded.length };
    delta += encoded.length - (end - start); cursor = end;
  }
  chunks.push(before.subarray(cursor));
  if (!Buffer.concat(chunks).equals(after)) throw failure(file);
  return spans;
}

function utf8(value, file) {
  try { return decoder.decode(value); } catch { throw failure(file); }
}

function offset(text, index) { return Buffer.byteLength(text.slice(0, index), 'utf8'); }

function javascriptAst(text, extension, file) {
  const modes = extension === '.mjs' ? ['module'] : extension === '.cjs' ? ['script'] : ['script', 'module'];
  for (const sourceType of modes) {
    try { return parse(text, { ecmaVersion: 'latest', sourceType, allowHashBang: true }); } catch { /* Try the other valid JS source mode. */ }
  }
  throw failure(file);
}

function normalizeAst(value, text, bindings, used, file) {
  if (!value || typeof value !== 'object' || value instanceof RegExp) return value;
  if (Array.isArray(value)) return value.map(child => normalizeAst(child, text, bindings, used, file));
  let binding;
  if (value.type === 'Literal' && typeof value.value === 'string' && ['"', "'"].includes(text[value.start])) {
    const key = `${offset(text, value.start + 1)}:${offset(text, value.end - 1)}`;
    binding = bindings.get(key);
    if (binding) {
      if (text[value.start] !== binding.quote || text[value.end - 1] !== binding.quote) throw failure(file);
      used.add(binding.id);
    }
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (['start', 'end', 'loc', 'range'].includes(key)) continue;
    if (binding && ['value', 'raw'].includes(key)) result[key] = { textUnit: binding.id };
    else result[key] = normalizeAst(child, text, bindings, used, file);
  }
  return result;
}

function verifyJavascript(before, after, spans, extension, file) {
  const original = utf8(before, file), actual = utf8(after, file);
  const beforeBindings = new Map(), afterBindings = new Map();
  for (const unit of spans) {
    const { byteStart, byteEnd } = unit.locator;
    const quote = String.fromCharCode(before[byteStart - 1] ?? 0);
    if (!['"', "'"].includes(quote) || before[byteEnd] !== before[byteStart - 1]) throw failure(file);
    const binding = { id: unit.id, quote };
    beforeBindings.set(`${byteStart}:${byteEnd}`, binding);
    afterBindings.set(`${unit.afterStart}:${unit.afterEnd}`, binding);
  }
  const originalUsed = new Set(), actualUsed = new Set();
  const first = normalizeAst(javascriptAst(original, extension, file), original, beforeBindings, originalUsed, file);
  const second = normalizeAst(javascriptAst(actual, extension, file), actual, afterBindings, actualUsed, file);
  if (originalUsed.size !== spans.length || actualUsed.size !== spans.length || !isDeepStrictEqual(first, second)) throw failure(file);
}

function quotedLiterals(text, file) {
  const ruby = path.extname(file).toLowerCase() === '.rb';
  const result = []; let cursor = 0;
  while (cursor < text.length) {
    if (ruby) {
      const atLine = cursor === 0 || text[cursor - 1] === '\n';
      const block = atLine && /^=begin(?:\s|$)/.test(text.slice(cursor));
      if (block) {
        const finish = /^=end(?:[^\r\n]*)$/gm; finish.lastIndex = cursor + 6;
        const end = finish.exec(text); if (!end) throw failure(file);
        cursor = end.index + end[0].length; continue;
      }
      const heredoc = text.startsWith('<<', cursor) && /^<<[-~]?(["']?)([A-Za-z_]\w*)\1/.exec(text.slice(cursor));
      if (heredoc) {
        const start = text.indexOf('\n', cursor + heredoc[0].length);
        const finish = new RegExp(`^[ \\t]*${heredoc[2]}[ \\t]*\\r?$`, 'gm'); finish.lastIndex = start + 1;
        const end = start >= 0 && finish.exec(text);
        if (end) { cursor = end.index + end[0].length; continue; }
      }
      const percent = text[cursor] === '%' && /^%[qQwWiIrxs]([^\w\s])/.exec(text.slice(cursor));
      let regexp = false;
      if (text[cursor] === '/') {
        let prior = cursor - 1;
        while (prior >= 0 && /\s/.test(text[prior])) prior--;
        let word = prior;
        while (word >= 0 && /[A-Za-z_]/.test(text[word])) word--;
        regexp = prior < 0 || '=(,[!?:;{'.includes(text[prior]) || text[prior] === '~'
          || ['return', 'when', 'if', 'unless'].includes(text.slice(word + 1, prior + 1));
      }
      if (percent || regexp || text[cursor] === '`') {
        const open = percent ? percent[1] : text[cursor], close = ({ '(': ')', '[': ']', '{': '}', '<': '>' })[open] ?? open;
        cursor += percent ? percent[0].length : 1;
        let depth = 1;
        while (cursor < text.length && depth) {
          if (text[cursor] === '\\') { cursor += 2; continue; }
          if (open !== close && text[cursor] === open) depth++;
          else if (text[cursor] === close) depth--;
          cursor++;
        }
        if (depth) throw failure(file);
        continue;
      }
    }
    if (text[cursor] === '#') {
      const end = text.indexOf('\n', cursor); cursor = end < 0 ? text.length : end + 1; continue;
    }
    if (!['"', "'"].includes(text[cursor])) { cursor++; continue; }
    const start = cursor, character = text[cursor];
    const quote = !ruby && text.startsWith(character.repeat(3), cursor) ? character.repeat(3) : character;
    const prefix = ruby ? '' : /([A-Za-z]+)$/.exec(text.slice(0, cursor))?.[1] ?? '';
    const unsupportedPrefix = /^[rubft]+$/i.test(prefix) && /[bft]/i.test(prefix);
    // Interpolated Python literals have nested code/quotes and need a real Python parser.
    if (/^[rubft]+$/i.test(prefix) && /[ft]/i.test(prefix)) throw failure(file);
    cursor += quote.length; const bodyStart = cursor;
    while (cursor < text.length && !text.startsWith(quote, cursor)) {
      if (text[cursor] === '\\') cursor += 2;
      else {
        if (quote.length === 1 && /[\r\n]/.test(text[cursor])) throw failure(file);
        cursor++;
      }
    }
    if (cursor >= text.length) throw failure(file);
    result.push({ start, bodyStart: offset(text, bodyStart), bodyEnd: offset(text, cursor), body: text.slice(bodyStart, cursor), quote, unsupportedPrefix,
      raw: /^[rubf]+$/i.test(prefix) && /r/i.test(prefix) });
    cursor += quote.length;
  }
  return result;
}

/** Reuse the same syntax boundaries for host-selected ordinary source text. */
export function ordinaryScriptLiterals({ file, text }) {
  const extension = path.extname(file).toLowerCase();
  if (javascript.has(extension)) {
    const result = [];
    const visit = (value, parent, field) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const child of value) visit(child, parent, field); return; }
      if (value.type === 'Literal' && typeof value.value === 'string' && ['"', "'"].includes(text[value.start])) {
        const identity = ['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent?.type) && field === 'key'
          || parent?.type === 'MemberExpression' && field === 'property'
          || ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(parent?.type) && field === 'source';
        if (!identity) result.push({ start: value.start, end: value.end, value: value.value });
      }
      for (const [key, child] of Object.entries(value)) if (child && typeof child === 'object') visit(child, value, key);
    };
    visit(javascriptAst(text, extension, file));
    return result.sort((left, right) => left.start - right.start);
  }
  if (!quoted.has(extension)) throw new Error(`普通脚本文字选择不处理 ${extension || '该格式'}；JSON 使用字段 pointer 或已有 display-id，其它格式可编写适配器`);
  return quotedLiterals(text, file).filter(literal => !literal.unsupportedPrefix).map(literal => ({
    start: literal.start, end: literal.start + literal.quote.length * 2 + literal.body.length,
    ...(literal.raw ? { value: literal.body } : extension === '.rb' && literal.quote === "'"
      ? { value: literal.body.replace(/\\([\\'])/g, '$1') } : {}),
  }));
}

function rubySubstitutions(body, file) {
  const result = [];
  for (let cursor = 0; cursor < body.length; cursor++) {
    if (body[cursor] === '\\') { cursor++; continue; }
    if (body[cursor] !== '#' || !['{', '@', '$'].includes(body[cursor + 1])) continue;
    const start = cursor;
    if (body[++cursor] !== '{') {
      const token = /^#(?:@@?|\$)(?:[\p{L}_][\p{L}\p{N}_]*|[0-9]+|-[A-Za-z]|.)/u.exec(body.slice(start));
      if (!token) throw failure(file);
      result.push(token[0]); cursor = start + token[0].length - 1; continue;
    }
    let depth = 1, quote;
    while (++cursor < body.length && depth) {
      if (body[cursor] === '\\') { cursor++; continue; }
      if (quote) { if (body[cursor] === quote) quote = undefined; continue; }
      if (['"', "'"].includes(body[cursor])) { quote = body[cursor]; continue; }
      if (body[cursor] === '{') depth++;
      else if (body[cursor] === '}') depth--;
    }
    if (depth) throw failure(file);
    result.push(body.slice(start, cursor)); cursor--;
  }
  return result;
}

function verifyQuotedEscapes(literal, extension, file) {
  if (literal.raw || !['.gd', '.py', '.rpy'].includes(extension)) return;
  const godot = extension === '.gd';
  let highSurrogate = false;
  for (let cursor = 0; cursor < literal.body.length; cursor++) {
    if (literal.body[cursor] !== '\\') { if (highSurrogate) throw failure(file); continue; }
    const escaped = literal.body[++cursor];
    if (escaped === undefined) throw failure(file);
    const width = escaped === 'u' ? 4 : escaped === 'U' ? (godot ? 6 : 8) : escaped === 'x' && !godot ? 2 : 0;
    if (width) {
      const digits = literal.body.slice(cursor + 1, cursor + 1 + width);
      if (digits.length !== width || !/^[\da-fA-F]+$/.test(digits)) throw failure(file);
      const code = Number.parseInt(digits, 16);
      if (code > 0x10ffff) throw failure(file);
      if (godot) {
        const lowSurrogate = code >= 0xdc00 && code <= 0xdfff;
        if (highSurrogate !== lowSurrogate) throw failure(file);
        highSurrogate = code >= 0xd800 && code <= 0xdbff;
      }
      cursor += width;
    } else {
      if (highSurrogate || godot && !/[abfnrtv\\'"\r\n]/.test(escaped)) throw failure(file);
      if (!godot && escaped === 'N') throw failure(file);
      if (escaped === '\r' && literal.body[cursor + 1] === '\n') cursor++;
    }
  }
  if (highSurrogate) throw failure(file);
}

function renpySubstitutions(text, file) {
  const result = [];
  for (let cursor = 0; cursor < text.length; cursor++) {
    if (!['[', '{'].includes(text[cursor])) continue;
    const open = text[cursor], close = open === '[' ? ']' : '}';
    if (text[cursor + 1] === open) { cursor++; continue; }
    const start = cursor; let depth = 1;
    while (++cursor < text.length && depth) {
      if (text[cursor] === '\\') cursor++;
      else if (text[cursor] === open) depth++;
      else if (text[cursor] === close) depth--;
    }
    if (depth) throw failure(file);
    result.push(text.slice(start, cursor)); cursor--;
  }
  return result;
}

function pythonText(text, raw, file) {
  if (raw) return text;
  if (/\\N\{/.test(text)) throw failure(file);
  const simple = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
  return text.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|[0-7]{1,3}|[\\'"abfnrtv]|\r?\n)/g, (_, value) => {
    if (/^[uUx]/.test(value)) {
      const code = Number.parseInt(value.slice(1), 16);
      if (code > 0x10ffff) throw failure(file);
      return String.fromCodePoint(code);
    }
    if (/^[0-7]/.test(value)) return String.fromCodePoint(Number.parseInt(value, 8));
    if (/[\r\n]/.test(value)) return '';
    return simple[value] ?? value;
  });
}

function verifyQuoted(before, after, spans, extension, file, translations) {
  const original = quotedLiterals(utf8(before, file), file);
  const actual = quotedLiterals(utf8(after, file), file);
  for (const unit of spans) {
    const first = original.find(item => item.bodyStart === unit.locator.byteStart && item.bodyEnd === unit.locator.byteEnd);
    const second = actual.find(item => item.bodyStart === unit.afterStart && item.bodyEnd === unit.afterEnd);
    if (!first || !second || first.unsupportedPrefix || second.unsupportedPrefix || first.quote !== second.quote || first.raw !== second.raw) throw failure(file);
    verifyQuotedEscapes(first, extension, file);
    verifyQuotedEscapes(second, extension, file);
    if (extension === '.rb' && first.quote === '"' && !isDeepStrictEqual(
      rubySubstitutions(first.body, file), rubySubstitutions(second.body, file))) throw failure(file);
    if (extension === '.rpy' && !isDeepStrictEqual(
      renpySubstitutions(pythonText(unit.rawSource, first.raw, file), file),
      renpySubstitutions(pythonText(replacement(unit, translations), second.raw, file), file))) throw failure(file);
  }
}

function verifyJson(before, after, units, translations, file) {
  let original, actual;
  try { original = JSON.parse(utf8(before, file).replace(/^\uFEFF/, '')); actual = JSON.parse(utf8(after, file).replace(/^\uFEFF/, '')); }
  catch { throw failure(file); }
  const seen = new Set();
  for (const unit of units) {
    const pointer = unit.locator.pointer;
    if (typeof pointer !== 'string' || !pointer.startsWith('/') || /~(?![01])/.test(pointer) || seen.has(pointer)) throw failure(file);
    seen.add(pointer);
    const parts = pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    let parent = original;
    for (const part of parts.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, part)) throw failure(file);
      parent = parent[part];
    }
    const key = parts.at(-1);
    if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key) || parent[key] !== unit.rawSource) throw failure(file);
    const value = replacement(unit, translations);
    if (typeof value !== 'string') throw failure(file);
    Object.defineProperty(parent, key, { value, writable: true, configurable: true, enumerable: true });
  }
  if (!isDeepStrictEqual(original, actual)) throw failure(file);
}

export function verifyTextStructure({ file, before, after, units, translations = {} }) {
  before = bytes(before); after = bytes(after);
  const extension = path.extname(file).toLowerCase();
  if (extension === '.json') {
    verifyJson(before, after, units, translations, file);
    return { valid: true, format: 'json-pointer' };
  }
  const spans = spansFor(before, after, units, translations, file);
  if (javascript.has(extension)) { verifyJavascript(before, after, spans, extension, file); return { valid: true, format: 'javascript-ast' }; }
  if (quoted.has(extension)) { verifyQuoted(before, after, spans, extension, file, translations); return { valid: true, format: 'quoted-literal' }; }
  if (plain.has(extension)) { utf8(before, file); utf8(after, file); return { valid: true, format: 'plain-span' }; }
  throw Object.assign(new Error(`资源文字定位需要可信格式校验器：${file}；可保留候选，补充匹配能力后重新验证`), { code: 'FORMAT_UNSUPPORTED', evidence: { status: 'unsupported', file, missing: ['structure'], nextActions: ['安装适用且已资格化的格式检查能力后，从原candidateId继续validate_adapter'] } });
}
