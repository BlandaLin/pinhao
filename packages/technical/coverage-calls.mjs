import path from 'node:path';
import { scriptFieldIdentities } from './script-field-policy.mjs';

const displayCall = /(?:\b(?:drawText(?:Ex)?|setText|set_text|addText|addCommand|say|tr|qsTr|gettext|draw_text(?:_ex)?|add_command|set_help_text)|\$gameMessage\.add|renpy\.say)\s*\(/g;
const displayAssignment = /\b[\w$.]+\.(?:text|bbcode_text)\s*=(?!=|>)/g;

/** Keep call-site evidence even when a different string in this script was extracted. */
export function inspectDisplayCalls(file, text, syntax, decode) {
  if (!syntax) return [];
  const result = new Map(), offsets = new Uint32Array(text.length + 1), newlines = [];
  let characters = 0, count = 0;
  for (const char of text) { if (char === '\n') newlines.push(characters); offsets[++count] = characters += char.length; }
  const lowerBound = (values, value, key = item => item, high = values.length) => { let low = 0; while (low < high) { const middle = (low + high) >> 1; if (key(values[middle]) < value) low = middle + 1; else high = middle; } return low; };
  const point = index => lowerBound(offsets, index, item => item, count + 1);
  const add = item => { const key = JSON.stringify(item.target); if (!result.has(key)) result.set(key, item); };
  const identities = new Map();
  if (path.extname(file).toLowerCase() === '.gd') {
    let cursor = 0, bytes = 0;
    const byteOffset = end => { bytes += Buffer.byteLength(text.slice(cursor, end)); cursor = end; return bytes; };
    const units = syntax.literals.map(literal => {
      const quote = text.startsWith(text[literal.start].repeat(3), literal.start) ? 3 : 1;
      return { id: String(literal.start), locator: { file, byteStart: byteOffset(literal.start + quote), byteEnd: byteOffset(literal.end - quote) } };
    });
    for (const identity of scriptFieldIdentities({ file, before: Buffer.from(text), units })) identities.set(Number(identity.unitId), identity);
  }
  const sites = [...syntax.masked.matchAll(displayCall)].map(match => ({ match, assignment: false }));
  sites.push(...[...syntax.masked.matchAll(displayAssignment)].map(match => ({ match, assignment: true })));
  for (const { match, assignment } of sites) {
    const commandLabel = /^addCommand\s*\(/.test(match[0]);
    const js = ['.js', '.mjs', '.cjs'].includes(path.extname(file).toLowerCase());
    if (commandLabel && !js) continue;
    const firstDisplayArgument = js && /^(?:addCommand|drawText(?:Ex)?)\s*\(/.test(match[0]);
    const start = match.index + match[0].length, maxEnd = Math.min(text.length, start + 16384);
    let end = start, depth = assignment ? 0 : 1;
    if (assignment) {
      const finish = /[;\r\n]/g; finish.lastIndex = start;
      end = Math.min(maxEnd, finish.exec(syntax.masked)?.index ?? text.length);
    } else {
      for (; end < maxEnd && depth; end++) { if (syntax.masked[end] === '(') depth++; else if (syntax.masked[end] === ')') depth--; }
      if (depth) continue;
    }
    let expressionEnd = assignment ? end : end - 1;
    if (firstDisplayArgument) {
      // Only the text/label is displayed; geometry, alignment and command symbols are logic.
      let nested = 0;
      for (let index = start; index < expressionEnd; index++) {
        const char = syntax.masked[index];
        if ('([{'.includes(char)) nested++;
        else if (')]}'.includes(char)) nested--;
        else if (char === ',' && nested === 0) { expressionEnd = index; break; }
      }
    }
    const literals = [];
    for (let index = lowerBound(syntax.literals, start, item => item.start); index < syntax.literals.length && syntax.literals[index].start < expressionEnd; index++) if (syntax.literals[index].end <= expressionEnd) literals.push(syntax.literals[index]);
    const site = { file, line: lowerBound(newlines, match.index) + 1, call: match[0].trim(), start: point(match.index), end: point(end) };
    for (const literal of literals) {
      const source = decode(text.slice(literal.start, literal.end))?.value;
      if (!source?.trim() || !/\p{L}/u.test(source)) continue;
      const identity = identities.get(literal.start);
      add({ file, source, kind: 'script_display_literal_candidate', classification: identity?.classification ?? 'display_unresolved',
        ...(identity ? { status: 'ignored', classificationEvidence: { ...identity, file } } : {}),
        target: { start: point(literal.start), end: point(literal.end), render: 'quoted' }, context: { file, line: site.line, displaySite: site } });
    }
    // Interpolated templates and indirect arguments have no source text an extractor can finish.
    // They are recorded as external adapter work so a permanently unfinishable site cannot keep
    // the coverage queue open forever.
    const expression = text.slice(start, expressionEnd).trim();
    if (!literals.some(literal => !identities.has(literal.start)) && expression && !/^(?:null|None|true|false|\d+(?:\.\d+)?)$/.test(expression)) add({ file, source: expression, kind: 'script_display_expression_candidate', classification: 'adapter_required', status: 'ignored', requiresAdapter: true, target: { start: point(start), end: point(expressionEnd), render: 'expression' }, context: { file, line: site.line, displaySite: site, extension: path.extname(file), evidence: 'Follow the displayed expression to its source; preserve the expression and runtime bindings.' } });
  }
  return [...result.values()];
}
