import { parse } from 'acorn';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const control = /\\(?:[A-Za-z]+(?:\[(?:[^\[\]\r\n]|\[[^\]\r\n]*\])*\]|<[^>\r\n]*>)?|[^\r\n])|%[-+0-9.]*[dsf]|%[1-9]\d*|\r\n|\n|\r/g;
const marker = /\{\{CTRL\d{4}\}\}/g;
const displayCalls = new Map([
  ['drawText', 0], ['drawTextEx', 0], ['addCommand', 0], ['setText', 0],
  ['setHelpText', 0], ['setMessage', 0], ['addText', 0], ['setSpeakerName', 0],
]);

function protect(text) {
  const controls = {}, tokens = [];
  const source = text.replace(control, value => {
    const id = `{{CTRL${String(tokens.length + 1).padStart(4, '0')}}}`;
    controls[id] = value; tokens.push(id); return id;
  });
  if (/\{\{|\}\}/.test(source.replace(marker, ''))) return null;
  return { source, controls, tokens };
}

function restore(text, candidate) {
  if (typeof text !== 'string' || !text.trim()) throw new Error(`插件译文为空：${candidate.id}`);
  const actual = text.match(marker) ?? [];
  if (JSON.stringify(actual) !== JSON.stringify(candidate.tokens)) throw new Error(`插件译文保护标记不一致：${candidate.id}`);
  const plain = text.replace(marker, '');
  if (/\{\{|\}\}/.test(plain) || new RegExp(control.source).test(plain) || /[\x00-\x1f]/.test(plain)) throw new Error(`插件译文含原始控制符：${candidate.id}`);
  return text.replace(marker, value => candidate.controls[value]);
}

function literals(node) {
  if (!node) return [];
  if (node.type === 'Literal' && typeof node.value === 'string') return [{ node, value: node.value }];
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return [{ node, value: node.quasis[0].value.cooked }];
  if (node.type === 'BinaryExpression' && node.operator === '+') return [...literals(node.left), ...literals(node.right)];
  if (node.type === 'ConditionalExpression') return [...literals(node.consequent), ...literals(node.alternate)];
  return [];
}

/** Map every UTF-16 index of the decoded text to its UTF-8 byte offset in the source file. */
function byteOffsets(text) {
  const offsets = new Uint32Array(text.length + 1);
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    offsets[index] = bytes;
    const code = text.codePointAt(index);
    if (code > 0xffff) { offsets[++index] = bytes += 4; continue; }
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
  }
  offsets[text.length] = bytes;
  return offsets;
}

function visit(node, callback) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) visit(item, callback); return; }
  if (typeof node.type === 'string') callback(node);
  for (const [key, child] of Object.entries(node)) {
    if (!['start', 'end', 'loc', 'range', 'raw'].includes(key) && child && typeof child === 'object') visit(child, callback);
  }
}

async function regularFile(root, relative) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('插件定位路径无效');
  const target = path.join(root, relative);
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('插件需要普通文件');
  const canonical = await realpath(target);
  const rel = path.relative(await realpath(root), canonical);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('插件文件位于项目之外');
  return target;
}

/** Read JavaScript syntax without loading or evaluating any game code. */
export async function extractDisplayText(gameDir) {
  const units = [], files = [], issues = [];
  for (const prefix of ['', 'www']) {
    const relativeDir = path.posix.join(prefix, 'js/plugins');
    const directory = path.join(gameDir, relativeDir);
    let entries;
    try {
      if ((await lstat(directory)).isSymbolicLink()) throw new Error('插件目录需要普通文件夹');
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.js') || entry.name.toLowerCase().startsWith('pinhao')) continue;
      const relative = path.posix.join(relativeDir, entry.name);
      const target = await regularFile(gameDir, relative);
      if ((await lstat(target)).size > 8 * 1024 * 1024) { issues.push({ file: relative, message: '大型插件保留原文件，列入专项适配' }); continue; }
      const bytes = await readFile(target);
      const source = bytes.toString('utf8');
      if (source.includes('\uFFFD')) { issues.push({ file: relative, message: '插件采用其他编码，保留原文件' }); continue; }
      // Byte spans only identify real file bytes while the decoded text re-encodes losslessly.
      const positions = byteOffsets(source);
      if (!Buffer.from(source, 'utf8').equals(bytes)) { issues.push({ file: relative, message: '插件文本无法无损换算字节偏移，已保留原文件' }); continue; }
      let ast;
      try { ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }); }
      catch { issues.push({ file: relative, message: '插件语法需专项适配，已保留原文件' }); continue; }
      const candidates = [], seen = new Set();
      visit(ast, node => {
        if (node.type !== 'CallExpression' || node.callee?.type !== 'MemberExpression' || node.callee.computed || node.callee.property.type !== 'Identifier') return;
        const name = node.callee.property.name;
        if (!displayCalls.has(name)) return;
        for (const item of literals(node.arguments[displayCalls.get(name)])) {
          if (typeof item.value !== 'string' || !/\p{L}/u.test(item.value) || seen.has(item.node.start)) continue;
          const protectedText = protect(item.value);
          if (!protectedText) { issues.push({ file: relative, line: item.node.loc.start.line, message: '显示文字与保留标记冲突，已保留原文' }); continue; }
          seen.add(item.node.start);
          const id = `script:${digest(`${relative}:${item.node.start}:${name}`).slice(0, 24)}`;
          candidates.push({ id, start: item.node.start, end: item.node.end, raw: source.slice(item.node.start, item.node.end), ...protectedText });
          units.push({ id, kind: 'script_display', source: protectedText.source, translation: protectedText.source, tokens: protectedText.tokens, notes: '', context: { file: relative, line: item.node.loc.start.line, displayCall: name, location: source.slice(Math.max(0, node.start - 80), Math.min(source.length, node.end + 80)) },
            // Literal body bytes, so host coverage can bind this unit to the quoted span it already found.
            locator: { file: relative, byteStart: positions[item.node.start + 1], byteEnd: positions[item.node.end - 1] },
            rawSource: source.slice(item.node.start + 1, item.node.end - 1) });
        }
      });
      if (candidates.length) files.push({ relative, sourceHash: digest(bytes), candidates });
    }
  }
  return { units, binding: { format: 'pinhao-js-display-1', files }, issues };
}

/** Patch only syntax nodes bound to the source snapshot; expressions and resource IDs stay intact. */
export async function applyDisplayText({ outputDir, binding, translations }) {
  if (binding.format !== 'pinhao-js-display-1') throw new Error('请用当前版本重新提取插件显示文字');
  const known = new Set(binding.files.flatMap(file => file.candidates.map(candidate => candidate.id)));
  const selected = new Map();
  for (const row of translations) {
    if (!known.has(row.id) || selected.has(row.id)) throw new Error('插件译文包含未知或重复 ID');
    selected.set(row.id, row.translation);
  }
  const patches = [];
  for (const file of binding.files) {
    const target = await regularFile(outputDir, file.relative);
    const bytes = await readFile(target);
    if (digest(bytes) !== file.sourceHash) throw new Error(`插件源文件已经变化：${file.relative}`);
    let source = bytes.toString('utf8'), changed = 0;
    for (const candidate of [...file.candidates].sort((a, b) => b.start - a.start)) {
      if (!selected.has(candidate.id) || selected.get(candidate.id) === candidate.source) continue;
      const value = restore(selected.get(candidate.id), candidate);
      const quoted = JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      source = source.slice(0, candidate.start) + quoted + source.slice(candidate.end);
      changed++;
    }
    if (changed) {
      parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
      patches.push({ target, source, file: file.relative, changed });
    }
  }
  for (const patch of patches) await writeFile(patch.target, patch.source, 'utf8');
  return { changed: patches.reduce((sum, patch) => sum + patch.changed, 0), files: patches.map(({ file, changed }) => ({ file, changed })) };
}
