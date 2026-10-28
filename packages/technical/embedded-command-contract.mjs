import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'acorn';
import { checkedPath } from './adaptation/paths.mjs';
import path from 'node:path';
import {inspectEmbeddedConsumerProgram} from './embedded-consumer-chain.mjs';

export const EMBEDDED_CONTRACT_PROTOCOL = 'pinhao-embedded-command-contract-1';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])) : value;
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
const fail = (message, code, evidence) => Object.assign(new Error(message), { code, evidence });
const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(item => walk(item, visit)); else if (value && typeof value === 'object') walk(value, visit);
};
const member = (node, name) => node?.type === 'MemberExpression' && (node.computed ? node.property?.value : node.property?.name) === name;
const argumentName = node => node?.type === 'Identifier' ? node.name : null;
const literalNumber = node => node?.type === 'Literal' && Number.isSafeInteger(node.value) ? node.value
  : node?.type === 'UnaryExpression' && node.operator === '-' && Number.isSafeInteger(node.argument?.value) ? -node.argument.value : null;
const sourceText = (text, node) => text.slice(node.start, node.end);
function mappingOf(node, args) {
  if (node?.type === 'MemberExpression' && node.computed && argumentName(node.object) === args) {
    const start = literalNumber(node.property);
    return start !== null && start >= 0 ? { mode: 'one-argument', argvStart: start, tailArgumentCount: null } : null;
  }
  if (node?.type !== 'CallExpression' || !member(node.callee, 'join') || node.arguments.length !== 1 || node.arguments[0].value !== ' ') return null;
  const slice = node.callee.object;
  if (slice?.type !== 'CallExpression' || !member(slice.callee, 'slice') || argumentName(slice.callee.object) !== args || slice.arguments.length > 2) return null;
  const start = slice.arguments.length ? literalNumber(slice.arguments[0]) : 0;
  const end = slice.arguments.length === 2 ? literalNumber(slice.arguments[1]) : 0;
  return start !== null && start >= 0 && end !== null && end <= 0 ? { mode: 'joined-range-before-tail', argvStart: start, tailArgumentCount: -end } : null;
}
function pluginMappings(text, command, ast = parse(text, { ecmaVersion: 'latest', allowReturnOutsideFunction: false }), allowedHandlers) {
  const mappings = [];
  walk(ast, node => {
    if (node.type !== 'AssignmentExpression' || !member(node.left, 'pluginCommand') || node.right?.type !== 'FunctionExpression'||allowedHandlers&&!allowedHandlers.has(node.right.start)) return;
    const fn = node.right, commandName = argumentName(fn.params[0]), args = argumentName(fn.params[1]);
    if (!commandName || !args) return;
    let mutatesArgs = false;
    walk(fn.body, part => {
      const target = part.type === 'AssignmentExpression' ? part.left : part.type === 'UpdateExpression' ? part.argument : null;
      if (target && (argumentName(target) === args || target.type === 'MemberExpression' && argumentName(target.object) === args)) mutatesArgs = true;
      if (part.type === 'CallExpression' && part.callee?.type === 'MemberExpression' && argumentName(part.callee.object) === args && !member(part.callee,'slice')) mutatesArgs = true;
    });
    if (mutatesArgs) return;
    walk(fn.body, branch => {
      if (branch.type !== 'IfStatement' || branch.test?.type !== 'BinaryExpression' || !['===', '=='].includes(branch.test.operator)) return;
      const test = branch.test;
      if (!((argumentName(test.left) === commandName && test.right.value === command) || (argumentName(test.right) === commandName && test.left.value === command))) return;
      walk(branch.consequent, sink => {
        let expression;
        if (sink.type === 'CallExpression' && (member(sink.callee, 'add') && argumentName(sink.callee.object) === '$gameMessage' || ['drawText', 'setText', 'set_text'].some(name => member(sink.callee, name)))) expression = sink.arguments[0];
        if (sink.type === 'AssignmentExpression' && ['text', 'innerText', 'textContent'].some(name => member(sink.left, name))) expression = sink.right;
        const mapping = mappingOf(expression, args);
        if (mapping) mappings.push({ ...mapping, consumerExpression: sourceText(text, expression), consumerSpan: { start: sink.start, end: sink.end } });
      });
    });
  });
  return mappings;
}
export function parseEmbeddedCarrier(raw) {
  if (typeof raw !== 'string' || /[\r\n\0]/.test(raw)) throw fail('插件命令不是受支持的单行输入', 'EMBEDDED_TEXT_UNREPRESENTABLE');
  const [command, ...args] = raw.split(' ');
  if (!command || !args.length) throw fail('插件命令缺少正文参数', 'EMBEDDED_TEXT_UNREPRESENTABLE');
  return { command, args };
}
export function projectEmbeddedCommand(parsed, mapping) {
  const start = mapping.argvStart;
  if (!Number.isSafeInteger(start) || start < 0 || start >= parsed.args.length) throw fail('消费者正文参数已变化', 'EMBEDDED_TEXT_UNREPRESENTABLE');
  const end = mapping.mode === 'one-argument' ? start + 1 : parsed.args.length - mapping.tailArgumentCount;
  if (end <= start || end > parsed.args.length) throw fail('消费者尾部参数已变化', 'EMBEDDED_TEXT_UNREPRESENTABLE');
  return { display: parsed.args.slice(start, end).join(' '), protected: { command: parsed.command, before: parsed.args.slice(0, start), after: parsed.args.slice(end) } };
}
export function encodeEmbeddedTarget({ before, source, target, contract }) {
  if (target === source && !contract) return before;
  if (contract?.format !== EMBEDDED_CONTRACT_PROTOCOL || contract.sourceFieldHash !== hash(before)) throw fail('命令正文缺少当前来源与消费者的表示契约；请读取实际启用插件和加载入口', 'EMBEDDED_REPRESENTATION_PENDING');
  if (typeof target !== 'string' || /[\r\n\0]/.test(target)) throw fail('命令正文不能含实际换行或空字符', 'EMBEDDED_TEXT_UNREPRESENTABLE');
  const parsed = parseEmbeddedCarrier(before), original = projectEmbeddedCommand(parsed, contract.target);
  if (original.display !== source) throw fail('消费者读取的正文与提取原文不一致', 'EMBEDDED_REPRESENTATION_PENDING');
  if (contract.target.mode === 'one-argument' && target.includes(' ')) throw fail('当前插件把正文当作单个空格分隔参数，不能无损表示含空格的译文；请追踪独立正文来源或实际编码协议', 'EMBEDDED_TEXT_UNREPRESENTABLE', { violation: 'target-splits-one-argument', blockedValueHash: hash(target), contractRef: contract.contractHash });
  const after = [...original.protected.before, target, ...original.protected.after];
  const rewritten = [parsed.command, ...after].join(' '), projected = projectEmbeddedCommand(parseEmbeddedCarrier(rewritten), contract.target);
  if (projected.display !== target || JSON.stringify(projected.protected) !== JSON.stringify(original.protected)) throw fail('目标改变了消费者正文或受保护参数', 'EMBEDDED_TEXT_UNREPRESENTABLE');
  return rewritten;
}
export function verifyEmbeddedRewrite({ before, after, source, target, contract }) {
  const expected = encodeEmbeddedTarget({ before, source, target, contract });
  if (after !== expected) throw fail('实际输出不符合命令正文表示契约', 'EMBEDDED_TEXT_UNREPRESENTABLE');
  return { contractHash: contract?.contractHash ?? null, targetHash: hash(target), outputHash: hash(after) };
}

// This deliberately recognizes a narrow, observable carrier and direct display mapping.
// Arbitrary parser overrides and secondary grammars remain capability-pending.
export async function qualifyEmbeddedContracts({ gameDir, consumerGameDir=gameDir, units, signal }) {
  const embedded = units.filter(unit => unit.locator?.segment);
  if (!embedded.length) return {};
  const dependencies = {};
  const read = async file => { signal?.throwIfAborted(); const text = await readFile(await checkedPath(consumerGameDir, file), 'utf8'); dependencies[file] = hash(text); return text; };
  let engine, loader;
  try { engine = await read('js/rpg_objects.js'); loader = await read('js/plugins.js'); }
  catch (error) { if (signal?.aborted) throw error; throw fail('缺少实际MV命令解析器或插件启用入口，无法确认正文表示', 'EMBEDDED_REPRESENTATION_PENDING'); }
  let carrier, carrierNode;
  walk(parse(engine, { ecmaVersion: 'latest' }), node => {
    if (node.type === 'AssignmentExpression' && member(node.left, 'command356') && node.right?.type === 'FunctionExpression') { carrier = sourceText(engine, node.right); carrierNode = node.right; }
  });
  const statements = carrierNode?.body.body;
  const declaration = index => statements?.[index]?.type === 'VariableDeclaration' && statements[index].declarations.length === 1 ? statements[index].declarations[0] : null;
  const first = declaration(0), second = declaration(1), call = statements?.[2]?.expression;
  const argsName = argumentName(first?.id), commandName = argumentName(second?.id);
  if (!carrier || statements?.length !== 4 || !argsName || !commandName
      || !/^this\._params\[0\]\.split\(['"] ['"]\)$/.test(sourceText(engine, first.init).replace(/\s+(?=(?:[^'"]*['"][^'"]*['"])*[^'"]*$)/g,''))
      || second.init?.type !== 'CallExpression' || !member(second.init.callee,'shift') || argumentName(second.init.callee.object) !== argsName
      || call?.type !== 'CallExpression' || !member(call.callee,'pluginCommand') || call.callee.object?.type !== 'ThisExpression'
      || argumentName(call.arguments[0]) !== commandName || argumentName(call.arguments[1]) !== argsName
      || statements[3].type !== 'ReturnStatement' || statements[3].argument?.value !== true) throw fail('实际command356不是已支持的ASCII空格分词协议', 'EMBEDDED_REPRESENTATION_PENDING');
  let declarations;
  walk(parse(loader, { ecmaVersion: 'latest' }), node => {
    if (node.type === 'VariableDeclarator' && node.id?.name === '$plugins' && node.init?.type === 'ArrayExpression') declarations = node.init.elements;
  });
  if (!declarations) throw fail('插件启用入口不是可确认的静态清单', 'EMBEDDED_REPRESENTATION_PENDING');
  const plugins = [],baseTransport=inspectEmbeddedConsumerProgram(engine);
  for (const declaration of declarations) {
    const fields = Object.fromEntries((declaration?.properties ?? []).map(property => [property.key?.name ?? property.key?.value, property.value?.value]));
    if (fields.status !== true) continue;
    if (typeof fields.name !== 'string' || /[\\/:]/.test(fields.name)) throw fail('启用插件文件名无效', 'EMBEDDED_REPRESENTATION_PENDING');
    const file = `js/plugins/${fields.name}.js`, text = await read(file);
    if (/\.command356\s*=|\[['"]command356['"]\]\s*=/.test(text)) throw fail('启用插件覆盖了命令解析器，需要补充对应协议', 'EMBEDDED_REPRESENTATION_PENDING');
    const transport=inspectEmbeddedConsumerProgram(text);
    if(transport.unsafeBuiltins)throw fail('启用插件改变了参数运输所依赖的原生方法，不能沿用当前表示合同','EMBEDDED_REPRESENTATION_PENDING');
    plugins.push({ file, text, transport });
  }
  const contracts = {};
  for (const unit of embedded) {
    const before = unit.locator.segment.prefix + unit.rawSource + unit.locator.segment.suffix;
    const parsed = parseEmbeddedCarrier(before), claims = [];
    for (const [index,plugin] of plugins.entries()) {
      const priorSafe=baseTransport.overrides&&baseTransport.priorTransparent&&plugins.slice(0,index).every(item=>item.transport.priorTransparent);
      const laterSafe=plugins.slice(index+1).every(item=>!item.transport.methodWrites.has('Game_Interpreter.prototype.pluginCommand')&&!item.transport.methodWrites.has('*')||item.transport.forwardsFirst);
      if(!laterSafe)continue;
      const direct=pluginMappings(plugin.text,parsed.command,plugin.transport.ast,plugin.transport.handlerStarts).map(mapping=>({...mapping,...(plugin.transport.forwardsFirst?{usesPrior:true}:{})}));
      for (const mapping of [...direct,...plugin.transport.delegatedMappings(parsed.command,parsed.args)]) {
        if(mapping.usesPrior&&!priorSafe)continue;
        if(mapping.methodDependencies?.some(method=>plugins.some((other,otherIndex)=>otherIndex!==index&&(other.transport.methodWrites.has(method)||other.transport.methodWrites.has('*')))))continue;
        if (projectEmbeddedCommand(parsed, mapping).display === unit.rawSource) claims.push({ mapping, consumerFile: plugin.file });
      }
    }
    if (claims.length !== 1) throw fail(`正文 ${unit.id} 的实际启用消费者映射仍不明确（${claims.length}处）；请追踪固定参数或join正文来源`, 'EMBEDDED_REPRESENTATION_PENDING', { unitId: unit.id });
    const claim = claims[0];
    const contract = { format: EMBEDDED_CONTRACT_PROTOCOL, carrier: 'mv-command356-space-v1', sourceFieldHash: hash(before), target: claim.mapping, consumerFile: claim.consumerFile, dependencies: { ...dependencies },
      ...(path.resolve(consumerGameDir)!==path.resolve(gameDir)?{sourceBinding:{baselineRoot:path.resolve(gameDir),consumerRoot:path.resolve(consumerGameDir)}}:{}),
      proofScope: ['argument-transport', claim.mapping.transport?'bounded-consumer-call-projection':'direct-consumer-projection'] };
    contracts[unit.id] = { ...contract, contractHash: hash(contract) };
  }
  return contracts;
}
export async function assertEmbeddedContractsFresh(contracts, gameDir, {purpose='baseline'}={}) {
  for (const contract of Object.values(contracts ?? {})) {
    const { contractHash, ...body } = contract;
    if (hash(body) !== contractHash || body.format !== EMBEDDED_CONTRACT_PROTOCOL) throw fail('命令表示契约内容已变化', 'EMBEDDED_REPRESENTATION_PENDING');
    if(!['baseline','final'].includes(purpose))throw fail('命令表示验证需要明确的来源或最终成品范围','EMBEDDED_REPRESENTATION_PENDING');
    if(purpose==='baseline'&&body.sourceBinding&&path.resolve(gameDir)!==body.sourceBinding.baselineRoot)throw fail('命令表示基线来源与宿主记录不一致','EMBEDDED_REPRESENTATION_PENDING');
    const dependencyRoot=purpose==='baseline'&&body.sourceBinding?body.sourceBinding.consumerRoot:gameDir;
    for (const [file, expected] of Object.entries(body.dependencies ?? {})) if (hash(await readFile(await checkedPath(dependencyRoot, file), 'utf8')) !== expected) throw fail(`命令表示依赖已变化：${file}`, 'EMBEDDED_REPRESENTATION_PENDING');
  }
}
