import { createHash } from 'node:crypto';
import { parseExpressionAt } from 'acorn';
import { jsonFieldIdentity } from './json-field-policy.mjs';
import { encodeEmbeddedTarget } from './embedded-command-contract.mjs';

export const EMBEDDED_TEXT_VERSION = 'pinhao-embedded-text-2';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const jsonPointerParts = pointer => {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || /~(?![01])/.test(pointer)) throw new Error('需要准确的 JSON pointer');
  return pointer.slice(1).split('/').map(value => value.replaceAll('~1', '/').replaceAll('~0', '~'));
};
export function jsonStringTarget(document, pointer) {
  const parts = jsonPointerParts(pointer);
  let parent = document;
  for (const part of parts.slice(0, -1)) {
    if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, part)) throw new Error('JSON 容器位置已变化');
    parent = parent[part];
  }
  const key = parts.at(-1);
  if (!parent || !Object.hasOwn(parent, key) || typeof parent[key] !== 'string') throw new Error('JSON 容器不是文字字符串');
  return { parent, key };
}

/** Source offsets come from one parse of the already validated JSON, never from the model. */
export function jsonStringSpans(text) {
  let root;
  return parts => {
    try {
      root ??= parseExpressionAt(text, text.charCodeAt(0) === 0xfeff ? 1 : 0, { ecmaVersion: 'latest' });
      let node = root;
      for (const part of parts) {
        if (node?.type === 'ArrayExpression') node = node.elements[Number(part)];
        else if (node?.type === 'ObjectExpression') node = node.properties.find(property => String(property.key?.value ?? property.key?.name) === String(part))?.value;
        else return;
      }
      if (node?.type === 'Literal' && typeof node.value === 'string') return {
        byteStart: Buffer.byteLength(text.slice(0, node.start)), byteEnd: Buffer.byteLength(text.slice(0, node.end)),
      };
    } catch { return; }
  };
}

export function embeddedCommand(file, document, pointer) {
  const identity = jsonFieldIdentity(file, document, jsonPointerParts(pointer));
  if (identity?.rule !== 'rpg-command-program' || !identity.consumer.startsWith('Game_Interpreter.command356:')) return;
  const { parent, key } = jsonStringTarget(document, pointer), source = parent[key], separator = source.indexOf(' ');
  if (separator > 0) return { syntax: 'rpgmaker-plugin-command', command: source.slice(0, separator), source };
}

export function embeddedExpression({ file, pointer, source, identity, span, sourceHash }) {
  if (identity?.rule !== 'rpg-command-program' || !identity.consumer.startsWith('Game_Interpreter.command356:')
      || !span || source.indexOf(' ') < 1) return;
  const command = source.slice(0, source.indexOf(' '));
  return { id: `embedded:${digest([file, pointer]).slice(0, 24)}`, file, path: jsonPointerParts(pointer), locator: { file, pointer },
    kind: 'script_display_expression_candidate', status: 'unresolved', classification: 'adapter_required',
    expression: source, source, ...span, embedded: { syntax: 'rpgmaker-plugin-command', command },
    evidenceHash: digest([EMBEDDED_TEXT_VERSION, sourceHash, pointer, source]),
    context: { file, field: pointer, displaySite: { api: 'Game_Interpreter.pluginCommand', expression: source,
      evidence: '受保护的插件命令容器；追踪实际消费者，区分显示正文与命令/资源参数，不能翻译整条命令。' } } };
}

/** This selection preserves outer bytes, not yet consumer argument semantics. */
export function selectEmbeddedText({ file, document, pointer, text, reason }) {
  const command = embeddedCommand(file, document, pointer);
  if (!command) throw new Error('当前字段没有受支持的插件命令容器；不能用片段定位绕过程序或逻辑字段保护');
  if (typeof text !== 'string' || !text.trim() || !/\p{L}/u.test(text) || /[\r\n\0]/.test(text)) throw new Error('请选择命令参数内完整的显示正文，不选择命令名、纯数值或换行');
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('显示片段需要消费者和用途依据');
  const first = command.source.indexOf(' ') + 1, matches = [];
  let offset = first;
  while (offset <= command.source.length) {
    const index = command.source.indexOf(text, offset);
    if (index < 0) break;
    const end = index + text.length;
    if ((index === first || command.source[index - 1] === ' ') && (end === command.source.length || command.source[end] === ' ')) matches.push(index);
    offset = index + Math.max(1, text.length);
  }
  if (matches.length !== 1) throw new Error(`显示正文在完整参数边界中匹配 ${matches.length} 处；请选择完整、唯一的正文，不截取单词或命令名`);
  const start = matches[0], end = start + text.length;
  return { file, pointer, segment: { syntax: command.syntax, prefix: command.source.slice(0, start), suffix: command.source.slice(end) } };
}

export function embeddedText(value, segment) {
  if (segment?.syntax !== 'rpgmaker-plugin-command' || typeof segment.prefix !== 'string' || typeof segment.suffix !== 'string'
      || segment.prefix.indexOf(' ') < 1 || !segment.prefix.endsWith(' ') || segment.suffix && !segment.suffix.startsWith(' ')
      || typeof value !== 'string' || !value.startsWith(segment.prefix) || !value.endsWith(segment.suffix)
      || value.length < segment.prefix.length + segment.suffix.length) throw new Error('命令容器或受保护参数已变化');
  return value.slice(segment.prefix.length, value.length - segment.suffix.length || undefined);
}

export function replaceEmbeddedText({ file, document, locator, source, translation, contract }) {
  const command = embeddedCommand(file, document, locator.pointer);
  if (!command) throw new Error('显示片段不属于受支持的真实命令容器');
  const target = jsonStringTarget(document, locator.pointer);
  if (embeddedText(target.parent[target.key], locator.segment) !== source) throw new Error('显示片段与当前原文不一致');
  if (typeof translation !== 'string' || /[\r\n\0]/.test(translation)) throw new Error('插件命令正文不能新增实际换行或空字符');
  target.parent[target.key] = encodeEmbeddedTarget({ before: target.parent[target.key], source, target: translation, contract });
  if (!target.parent[target.key].startsWith(command.command + ' ')) throw new Error('命令身份发生变化');
  return target.parent[target.key];
}
