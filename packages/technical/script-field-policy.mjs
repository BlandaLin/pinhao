import path from 'node:path';
import { parse } from 'acorn';
import { ordinaryScriptLiterals } from './adaptation/literal-structure.mjs';

export const SCRIPT_FIELD_POLICY_VERSION = 3;
const javascript = new Set(['.js', '.mjs', '.cjs']);
const roles = { drawText: ['text', 'x', 'y', 'maxWidth', 'align'], drawTextEx: ['text', 'x', 'y', 'width'], addCommand: ['name', 'symbol', 'enabled', 'ext'] };
const member = node => node?.type === 'Identifier' ? node.name : node?.type === 'MemberExpression'
  && (!node.computed || node.property.type === 'Literal' && typeof node.property.value === 'string')
  ? `${member(node.object) ?? ''}.${node.computed ? node.property.value : node.property.name}` : undefined;
const children = node => Object.values(node).flatMap(value => Array.isArray(value) ? value.filter(item => item?.type) : value?.type ? [value] : []);

function gdscriptIdentities(file, text, selected) {
  let literals;
  try { literals = ordinaryScriptLiterals({ file, text }); } catch { return []; }
  const quoted = new Map(literals.map(item => [item.start, item])), tokens = [];
  const word = /[\p{ID_Start}_][\p{ID_Continue}_]*/uy;
  for (let cursor = 0; cursor < text.length;) {
    if (/\s/.test(text[cursor])) { cursor++; continue; }
    if (text[cursor] === '#') { const end = text.indexOf('\n', cursor); cursor = end < 0 ? text.length : end + 1; continue; }
    const literal = quoted.get(cursor);
    if (literal) { tokens.push({ ...literal, kind: 'string' }); cursor = literal.end; continue; }
    word.lastIndex = cursor; const identifier = word.exec(text);
    if (identifier) { tokens.push({ start: cursor, end: word.lastIndex, kind: 'word', value: identifier[0] }); cursor = word.lastIndex; continue; }
    tokens.push({ start: cursor, end: cursor + 1, kind: 'symbol', value: text[cursor++] });
  }
  const prefixWords = new Set(['return', 'await', 'yield', 'if', 'elif', 'else', 'for', 'while', 'in', 'is', 'not', 'and', 'or', 'match', 'assert', 'var', 'const', 'func', 'class', 'extends', 'signal', 'enum', 'as']);
  const directString = (start, end) => {
    while (tokens[start]?.value === '(' && tokens[end - 1]?.value === ')') { start++; end--; }
    return end - start === 1 && tokens[start].kind === 'string' ? tokens[start]
      : end - start === 2 && ['r', '&', '^'].includes(tokens[start].value) && tokens[start + 1].kind === 'string' && tokens[start].end === tokens[start + 1].start ? tokens[start + 1] : undefined;
  };
  const newlines = [...text.matchAll(/\n/g)].map(match => match.index);
  const lineAt = point => { let low = 0, high = newlines.length; while (low < high) { const middle = (low + high) >> 1; if (newlines[middle] < point) low = middle + 1; else high = middle; } return low + 1; };
  const result = [], frames = [];
  const add = (literal, role, consumer) => {
    if (!literal) return;
    const quote = text.startsWith(text[literal.start].repeat(3), literal.start) ? 3 : 1;
    const unit = selected.get(`${literal.start + quote}:${literal.end - quote}`);
    if (unit) result.push({ unitId: unit.id, locator: unit.locator, classification: 'logic_identity', rule: 'gdscript-syntax-identity',
      evidence: 'gdscript-token-role', role, consumer, line: lineAt(literal.start) });
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index], previous = tokens[index - 1], frame = frames.at(-1);
    if (['(', '[', '{'].includes(token.value)) {
      // A prefix array and a postfix subscript share brackets, but not their receiver.
      const continued = frames.length || !/[\r\n]/.test(text.slice(previous?.end ?? 0, token.start).replace(/\\[\t ]*\r?\n/g, ''));
      const receiver = previous && (previous.kind === 'word' && !prefixWords.has(previous.value) || previous.kind === 'string' || [')', ']', '}'].includes(previous.value));
      frames.push({ open: token.value, index, boundary: index, key: token.value === '{', subscript: token.value === '[' && Boolean(continued && receiver) });
    } else if ([')', ']', '}'].includes(token.value)) {
      if (!frame || frame.open !== ({ ')': '(', ']': '[', '}': '{' })[token.value]) return [];
      if (frame.subscript) add(directString(frame.index + 1, index), 'subscript-key', 'GDScript subscript index');
      frames.pop();
    } else if (token.value === ':' && frame?.open === '{' && frame.key) {
      add(directString(frame.boundary + 1, index), 'dictionary-key', 'GDScript dictionary key'); frame.key = false;
    } else if (token.value === ',' && frame?.open === '{') { frame.boundary = index; frame.key = true; }
  }
  return frames.length ? [] : result;
}

function syntaxFor(file, text) {
  const modes = path.extname(file).toLowerCase() === '.mjs' ? ['module'] : ['script', 'module'];
  for (const sourceType of modes) {
    try { return parse(text, { ecmaVersion: 'latest', sourceType, allowHashBang: true }); } catch { /* The existing structure verifier owns syntax failures. */ }
  }
}

/** Known UI argument roles require a real local prototype chain, not a matching string value. */
export function scriptFieldIdentities({ file, before, units }) {
  const extension = path.extname(file).toLowerCase();
  if ((!javascript.has(extension) && extension !== '.gd') || !units.length) return [];
  before = Buffer.isBuffer(before) ? before : Buffer.from(before);
  const text = before.toString('utf8');
  const points = [...new Set(units.flatMap(unit => [unit.locator?.byteStart, unit.locator?.byteEnd]))]
    .filter(value => Number.isSafeInteger(value) && value >= 0 && value <= before.length).sort((a, b) => a - b);
  const offsets = new Map(); let cursor = 0, character = 0;
  for (const point of points) { character += before.subarray(cursor, point).toString('utf8').length; offsets.set(point, character); cursor = point; }
  const selected = new Map(units.map(unit => [`${offsets.get(unit.locator?.byteStart)}:${offsets.get(unit.locator?.byteEnd)}`, unit]));
  if (extension === '.gd') return gdscriptIdentities(file, text, selected);
  const tree = syntaxFor(file, text);
  if (!tree) return [];
  const parents = new Map(), methods = new Map(), owners = new WeakMap();
  const collect = node => {
    if (node.type === 'AssignmentExpression' && node.operator === '=') {
      const target = member(node.left), inherited = /^(\w+)\.prototype$/.exec(target ?? '');
      if (inherited && member(node.right.callee) === 'Object.create' && node.right.arguments?.length === 1) {
        const base = /^(\w+)\.prototype$/.exec(member(node.right.arguments[0]) ?? '');
        if (base) parents.set(inherited[1], base[1]);
      }
      const method = /^(\w+)\.prototype\.(\w+)$/.exec(target ?? '');
      if (method && ['FunctionExpression', 'ArrowFunctionExpression'].includes(node.right.type)) {
        if (node.right.type === 'FunctionExpression') owners.set(node.right, method[1]);
        const names = methods.get(method[1]) ?? new Set(); names.add(method[2]); methods.set(method[1], names);
      }
    }
    for (const child of children(node)) collect(child);
  };
  collect(tree);
  const nativeOwner = (owner, method) => {
    const seen = new Set();
    while (owner && !seen.has(owner)) {
      seen.add(owner);
      // An actual local override may have different argument semantics.
      if (methods.get(owner)?.has(method)) return;
      if (owner === 'Window_Base' && ['drawText', 'drawTextEx'].includes(method)
          || owner === 'Window_Command' && method === 'addCommand') return owner;
      owner = parents.get(owner) ?? (owner === 'Window_Command' ? 'Window_Base' : undefined);
    }
  };
  const result = [];
  const visit = (node, owner, call, parent, field) => {
    if (['FunctionExpression', 'FunctionDeclaration', 'ArrowFunctionExpression'].includes(node.type)) {
      owner = owners.get(node) ?? (node.type === 'ArrowFunctionExpression' ? owner : undefined); call = undefined;
    }
    if (node.type === 'CallExpression') call = node;
    if (node.type === 'Literal' && typeof node.value === 'string' && ['"', "'"].includes(text[node.start])) {
      const unit = selected.get(`${node.start + 1}:${node.end - 1}`);
      const syntaxRole = field === 'key' && ['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent?.type) ? 'property-key'
        : field === 'property' && parent?.type === 'MemberExpression' ? 'member-key'
          : field === 'source' && ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(parent?.type) ? 'module-source'
            : ['imported', 'exported'].includes(field) && ['ImportSpecifier', 'ExportSpecifier'].includes(parent?.type) ? 'module-binding' : undefined;
      if (unit && syntaxRole) result.push({ unitId: unit.id, locator: unit.locator, classification: 'logic_identity', rule: 'javascript-syntax-identity',
        evidence: 'javascript-ast-role', role: syntaxRole, consumer: `${parent.type}.${field}`, line: text.slice(0, node.start).split('\n').length });
      if (unit && call?.callee.type === 'MemberExpression' && call.callee.object.type === 'ThisExpression') {
        const method = call.callee.computed ? call.callee.property.value : call.callee.property.name;
        const native = roles[method] && nativeOwner(owner, method);
        const argument = call.arguments.findIndex(item => item.start <= node.start && item.end >= node.end);
        if (native && argument > 0) result.push({ unitId: unit.id, locator: unit.locator, classification: 'logic_identity', rule: 'rpg-ui-nontext-argument',
          evidence: 'javascript-ast-and-window-prototype-chain', method, argument, role: roles[method][argument] ?? 'non-display-extra-argument',
          consumer: `${native}.${method} argument ${argument + 1}`, owner, line: text.slice(0, node.start).split('\n').length });
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (Array.isArray(value)) { for (const child of value) if (child?.type) visit(child, owner, call, node, key); }
      else if (value?.type) visit(value, owner, call, node, key);
    }
  };
  visit(tree);
  return result;
}

export function assertScriptFieldsWritable(input) {
  const identity = scriptFieldIdentities(input)[0];
  if (identity) throw Object.assign(new Error(`该字符串是代码身份或界面调用的非文字参数，不能作为译文回写：${input.file}:${identity.line}；${identity.consumer} (${identity.role})`), {
    code: 'PROTECTED_SCRIPT_ARGUMENT', evidence: { file: input.file, ...identity },
  });
}
