import { parse } from 'acorn';

const owned = new Set(['PinHaoLocalization', 'PinhaoAssist', 'PinHaoNameIdentity']);
const markers = { PinHaoLocalization: 'PinHao localization runtime', PinhaoAssist: 'PinHao optional assistance registration' };
const put = (rows, descriptor, first = false) => first
  ? [descriptor, ...rows.filter(row => row.name !== descriptor.name)]
  : [...rows.filter(row => row.name !== descriptor.name), descriptor];
const failure = message => Object.assign(new Error(message), { code: 'PLUGIN_MANIFEST' });
const rows = value => {
  if (!Array.isArray(value) || value.some(row => !row || Array.isArray(row) || typeof row !== 'object' || typeof row.name !== 'string' || typeof row.status !== 'boolean')) throw failure('plugins.js must contain standard plugin descriptors with name and status');
  return value;
};

function manifest(source) {
  let ast;
  try { ast = parse(source, { ecmaVersion: 'latest' }); } catch { throw failure('plugins.js is not valid JavaScript'); }
  const declarations = ast.body.filter(node => node.type === 'VariableDeclaration').flatMap(node => node.declarations)
    .filter(node => node.id.type === 'Identifier' && node.id.name === '$plugins');
  if (declarations.length !== 1 || declarations[0].init?.type !== 'ArrayExpression') throw failure('plugins.js requires one top-level standard static $plugins declaration');
  const declaration = declarations[0], statement = ast.body.find(node => node.type === 'VariableDeclaration' && node.declarations.includes(declaration));
  if (ast.body[0] !== statement || statement.declarations.length !== 1 || source[statement.end - 1] !== ';') throw failure('plugins.js requires one top-level standard static $plugins declaration');
  let plugins;
  try { plugins = rows(JSON.parse(source.slice(declaration.init.start, declaration.init.end))); } catch { throw failure('plugins.js $plugins array is not standard JSON'); }
  const spans = [[statement.start, statement.end]], legacy = [];
  for (const [name, marker] of Object.entries(markers)) {
    const header = new RegExp(`^[ \\t]*// ${marker}[ \\t]*\\r?\\n[ \\t]*(\\$plugins)\\s*=\\s*\\$plugins\\.filter\\(function\\(plugin\\)\\s*\\{\\s*return plugin\\.name !== "${name}";\\s*\\}\\);\\s*\\$plugins\\.push\\(`, 'gm');
    for (const found of source.matchAll(header)) {
      const codeStart = found.index + found[0].indexOf('$plugins');
      const index = ast.body.findIndex(node => node.start === codeStart && node.type === 'ExpressionStatement');
      const push = ast.body[index + 1];
      if (index < 0 || push?.type !== 'ExpressionStatement' || push.expression.type !== 'CallExpression' || push.expression.arguments.length !== 1) continue;
      const argument = push.expression.arguments[0];
      let descriptor;
      try { descriptor = rows([JSON.parse(source.slice(argument.start, argument.end))])[0]; } catch { continue; }
      if (descriptor.name !== name || argument.start !== found.index + found[0].length) continue;
      const suffix = /^\);[ \t]*(?:\r?\n|$)/.exec(source.slice(argument.end));
      if (!suffix) continue;
      let end = argument.end + suffix[0].length;
      if (name === 'PinhaoAssist') end += /^\/\/ PinHao optional assistance end[ \t]*(?:\r?\n|$)/.exec(source.slice(end))?.[0].length ?? 0;
      legacy.push({ start: found.index, end, descriptor });
    }
  }
  for (const block of legacy.sort((a, b) => a.start - b.start)) {
    spans.push([block.start, block.end]); plugins = put(plugins, block.descriptor);
  }
  let unresolved = false;
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (spans.some(([start, end]) => node.start >= start && node.end <= end)) return;
    if (node.type === 'Identifier' && node.name === '$plugins') unresolved = true;
    for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === 'object') visit(child);
  };
  visit(ast);
  return { plugins, unresolved: unresolved ? ['plugins.js has an unsupported $plugins reference outside its static declaration'] : [], array: declaration.init, legacy };
}

export function inspectPlugins(source) {
  try { const { plugins, unresolved } = manifest(source); return { plugins, unresolved }; }
  catch (error) { return { plugins: [], unresolved: [error.message] }; }
}

export function registerPlugin(source, descriptor, { first = false } = {}) {
  rows([descriptor]);
  if (!owned.has(descriptor.name)) throw failure('Only explicitly owned PinHao plugins may be registered');
  const parsed = manifest(source);
  if (parsed.unresolved.length) throw failure(parsed.unresolved.join('; '));
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const content = JSON.stringify(put(parsed.plugins, descriptor, first), null, 2).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029').replaceAll('\n', newline);
  const edits = [{ start: parsed.array.start, end: parsed.array.end, content }, ...parsed.legacy.map(block => ({ ...block, content: '' }))];
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.content + source.slice(edit.end);
  return source;
}
