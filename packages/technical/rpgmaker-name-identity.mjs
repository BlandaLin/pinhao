import { parse } from 'acorn';

const tables = new Map(['Actors', 'Classes', 'Skills', 'Items', 'Weapons', 'Armors', 'Enemies', 'States'].map(table => [`$data${table}`, table]));
const typeFields = new Set(['elements', 'skillTypes', 'weaponTypes', 'armorTypes', 'equipTypes']);
const callbacks = new Set(['find', 'findIndex', 'filter', 'some', 'every', 'forEach', 'map']);
const enemyMethods = new Set(['name', 'originalName', 'enemy', 'enemyId']);
const imageMethods = new Set(['loadPicture', 'loadEnemy', 'loadSvEnemy', 'loadFace', 'loadCharacter', 'loadBattleback1', 'loadBattleback2', 'loadParallax', 'loadTitle1', 'loadTitle2']);
const property = node => node?.type === 'MemberExpression' ? node.computed ? node.property.type === 'Literal' ? node.property.value : undefined : node.property.name : undefined;
const memberPath = node => node?.type === 'Identifier' ? node.name : node?.type === 'MemberExpression' && typeof property(node) === 'string' ? `${memberPath(node.object)}.${property(node)}` : undefined;
const children = node => Object.values(node).flatMap(value => Array.isArray(value) ? value.filter(item => item?.type) : value?.type ? [value] : []);
const binding = (scope, name) => scope ? scope.bindings.has(name) ? scope.bindings.get(name) : binding(scope.parent, name) : undefined;
const globalIdentifier = (node, name, scope) => node?.type === 'Identifier' && node.name === name && binding(scope, name) === undefined;
const names = pattern => !pattern ? [] : pattern.type === 'Identifier' ? [pattern.name]
  : pattern.type === 'ObjectPattern' ? pattern.properties.flatMap(item => names(item.type === 'RestElement' ? item.argument : item.value))
    : pattern.type === 'ArrayPattern' ? pattern.elements.flatMap(names)
      : pattern.type === 'AssignmentPattern' ? names(pattern.left) : pattern.type === 'RestElement' ? names(pattern.argument) : [];
const element = array => ({ kind: array.element, table: array.table });

function syntax(source) {
  for (const sourceType of ['script', 'module']) {
    try { return parse(source, { ecmaVersion: 'latest', sourceType, locations: true, allowReturnOutsideFunction: true }); } catch { /* Preserve unparsed files. */ }
  }
}

// Only immutable record/array aliases are followed; scalar name aliases stay untouched.
function origin(node, scope, seen = new Set()) {
  if (!node) return;
  if (node.type === 'ThisExpression' && scope.owner) return { kind: 'battler', table: scope.owner };
  if (node.type === 'Identifier') {
    const local = binding(scope, node.name);
    if (local !== undefined) {
      if (local.mutated || seen.has(local)) return;
      if (local.derived) {
        const array = origin(local.derived.node, local.derived.scope, new Set([...seen, local]));
        return array?.kind === 'array' ? element(array) : undefined;
      }
      if (!local.init || seen.has(local)) return;
      return origin(local.init, local.scope, new Set([...seen, local]));
    }
    if (tables.has(node.name)) return { kind: 'array', table: tables.get(node.name), element: 'record' };
  }
  if (node.type === 'MemberExpression') {
    if (globalIdentifier(node.object, '$dataSystem', scope) && typeFields.has(property(node))) return { kind: 'types', field: property(node) };
    const array = origin(node.object, scope, seen);
    if (node.computed && array?.kind === 'array') return element(array);
  }
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
  const receiver = node.callee.object, method = property(node.callee);
  if (globalIdentifier(receiver, '$gameActors', scope) && method === 'actor') return { kind: 'battler', table: 'Actors' };
  if (globalIdentifier(receiver, '$gameTroop', scope) && method === 'members') return { kind: 'array', table: 'Enemies', element: 'battler' };
  if (globalIdentifier(receiver, '$gameParty', scope) && ['members', 'allMembers', 'battleMembers'].includes(method)) return { kind: 'array', table: 'Actors', element: 'battler' };
  const parent = origin(receiver, scope, seen);
  if (parent?.kind === 'array' && ['find', 'at'].includes(method)) return element(parent);
  if (parent?.kind === 'array' && ['filter', 'slice'].includes(method)) return parent;
  if (parent?.kind === 'battler') {
    if (method === 'enemy' && parent.table === 'Enemies') return { kind: 'record', table: parent.table, viaEnemy: true };
    const table = method === 'states' ? 'States' : parent.table === 'Actors' ? { skills: 'Skills', weapons: 'Weapons', armors: 'Armors' }[method] : undefined;
    if (table) return { kind: 'array', table, element: 'record' };
  }
}

function indexTree(tree) {
  const entries = [], scopes = new WeakMap();
  const declare = (statement, scope) => {
    if (statement.type === 'VariableDeclaration') for (const item of statement.declarations) for (const name of names(item.id)) scope.bindings.set(name,
      statement.kind === 'const' && item.id.type === 'Identifier' ? { init: item.init, scope } : {});
    if (['FunctionDeclaration', 'ClassDeclaration'].includes(statement.type) && statement.id) scope.bindings.set(statement.id.name, {});
    if (statement.type === 'ImportDeclaration') for (const item of statement.specifiers) scope.bindings.set(item.local.name, {});
  };
  const hoist = (node, scope) => {
    if (/Function/.test(node.type)) return;
    if (node.type === 'VariableDeclaration' && node.kind === 'var') for (const item of node.declarations) for (const name of names(item.id)) scope.bindings.set(name, {});
    for (const child of children(node)) hoist(child, scope);
  };
  const visit = (node, outer, parent) => {
    let scope = outer;
    if (['Program', 'BlockStatement', 'CatchClause', 'ForStatement', 'ForOfStatement', 'ForInStatement', 'SwitchStatement'].includes(node.type)) {
      scope = { parent: outer, bindings: new Map(), owner: outer?.owner };
      const statements = node.body?.type ? [] : node.body ?? node.cases?.flatMap(item => item.consequent) ?? [];
      for (const statement of statements) declare(statement, scope);
      if (node.type === 'Program') hoist(node, scope);
      if (node.type === 'CatchClause') for (const name of names(node.param)) scope.bindings.set(name, {});
      for (const declaration of [node.init, node.left]) if (declaration?.type === 'VariableDeclaration') declare(declaration, scope);
      if (node.type === 'ForOfStatement' && node.left.type === 'VariableDeclaration' && node.left.kind === 'const') {
        if (node.left.declarations[0]?.id.type === 'Identifier') scope.bindings.set(node.left.declarations[0].id.name, { derived: { node: node.right, scope: outer } });
      }
    }
    if (/^(?:FunctionExpression|FunctionDeclaration|ArrowFunctionExpression)$/.test(node.type)) {
      let owner = node.type === 'ArrowFunctionExpression' ? outer?.owner : parent?.type === 'AssignmentExpression'
        ? /^Game_(Actor|Enemy)\.prototype\.[^.]+$/.exec(memberPath(parent.left) ?? '')?.[1] : undefined;
      if (node.type !== 'ArrowFunctionExpression' && owner && binding(outer, `Game_${owner}`) !== undefined) owner = undefined;
      scope = { parent: outer, bindings: new Map(), owner: owner === 'Enemy' ? 'Enemies' : owner === 'Actor' ? 'Actors' : owner };
      hoist(node.body, scope);
      for (const parameter of node.params) for (const name of names(parameter)) scope.bindings.set(name, {});
      if (node.id) scope.bindings.set(node.id.name, {});
      if (parent?.type === 'CallExpression' && parent.arguments[0] === node && callbacks.has(property(parent.callee))) {
        if (node.params[0]?.type === 'Identifier') scope.bindings.set(node.params[0].name, { derived: { node: parent.callee.object, scope: outer } });
      }
    }
    scopes.set(node, scope); entries.push({ node, scope, parent });
    for (const child of children(node)) visit(child, scope, node);
  };
  visit(tree, undefined, undefined);
  for (const { node, scope } of entries) {
    const target = node.type === 'AssignmentExpression' ? node.left : node.type === 'UpdateExpression' ? node.argument
      : ['ForOfStatement', 'ForInStatement'].includes(node.type) && node.left.type === 'Identifier' ? node.left : undefined;
    if (target) for (const name of names(target)) { const local = binding(scope, name); if (local) local.mutated = true; }
  }
  return { entries, scopes };
}

function resolvedPath(node, scope, seen = new Set()) {
  if (node?.type === 'Identifier') {
    const local = binding(scope, node.name);
    if (local?.init && !local.mutated && !seen.has(local)) return resolvedPath(local.init, local.scope, new Set([...seen, local]));
    return local === undefined ? node.name : undefined;
  }
  if (node?.type === 'MemberExpression' && typeof property(node) === 'string') return `${resolvedPath(node.object, scope, seen)}.${property(node)}`;
}

function overrideFacts(index) {
  let enemyBattler = false;
  const dataTables = new Set(), sites = [], warnings = [];
  const parents = new WeakMap(index.entries.map(({ node, parent }) => [node, parent]));
  for (const { node, scope } of index.entries) {
    const target = node.type === 'AssignmentExpression' ? resolvedPath(node.left, scope) : undefined;
    if (/^Game_Enemy(?:\.prototype(?:\.(?:name|originalName|enemy|enemyId))?)?$/.test(target ?? '')) { enemyBattler = true; sites.push(node.start); }
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && property(node.left) === undefined
        && resolvedPath(node.left.object, scope) === 'Game_Enemy.prototype') { enemyBattler = true; sites.push(node.start); }
    let receiver, accessor = false, key;
    if (node.type === 'CallExpression' && (globalIdentifier(node.callee.object, 'Object', scope) || globalIdentifier(node.callee.object, 'Reflect', scope))) {
      if (property(node.callee) === 'defineProperty') {
        receiver = node.arguments[0]; key = node.arguments[1]?.value;
        accessor = (key === 'name' || key === undefined) && (node.arguments[2]?.type !== 'ObjectExpression' || node.arguments[2].properties.some(item => item.type === 'SpreadElement' || ['get', 'set'].includes(item.key.name ?? item.key.value)));
      } else if (property(node.callee) === 'defineProperties') {
        receiver = node.arguments[0];
        accessor = node.arguments[1]?.properties?.some(item => (item.key.name ?? item.key.value) === 'name' && item.value.properties?.some(part => ['get', 'set'].includes(part.key.name ?? part.key.value)));
        if (resolvedPath(receiver, scope) === 'Game_Enemy.prototype' && node.arguments[1]?.properties?.some(item => enemyMethods.has(item.key.name ?? item.key.value))) { enemyBattler = true; sites.push(node.start); }
      } else if (property(node.callee) === 'assign' && resolvedPath(node.arguments[0], scope) === 'Game_Enemy.prototype') {
        if (node.arguments.slice(1).some(item => item.type !== 'ObjectExpression' || item.properties.some(part => part.type === 'SpreadElement' || enemyMethods.has(part.key.name ?? part.key.value)))) { enemyBattler = true; sites.push(node.start); }
      }
      if (resolvedPath(receiver, scope) === 'Game_Enemy.prototype' && (enemyMethods.has(key) || accessor || property(node.callee) === 'defineProperty' && key === undefined)) { enemyBattler = true; sites.push(node.start); }
    }
    if (node.type === 'CallExpression' && ['__defineGetter__', '__defineSetter__'].includes(property(node.callee)) && node.arguments[0]?.value === 'name') { receiver = node.callee.object; accessor = true; }
    if (node.type === 'Property' && ['get', 'set'].includes(node.kind) && (node.key.name ?? node.key.value) === 'name') {
      accessor = true;
      const object = parents.get(node), assignment = parents.get(object);
      if (assignment?.type === 'AssignmentExpression' && assignment.right === object) receiver = assignment.left;
    }
    if (!accessor) continue;
    const record = origin(receiver, scope);
    if (record?.kind === 'record') { dataTables.add(record.table); sites.push(node.start); }
    else warnings.push({ start: node.start, end: node.end, line: node.loc?.start.line, code: 'unproven-name-accessor-target' });
  }
  return { enemyBattler, dataTables: [...dataTables].sort(), unknownDataAccessor: false, sites: [...new Set(sites)], warnings };
}

/** Scan plugin source without executing it. Merge these facts across all enabled plugins. */
export function detectRpgMakerNameOverrides({ source }) {
  const tree = syntax(source);
  return tree ? overrideFacts(indexTree(tree)) : { enemyBattler: true, dataTables: [], unknownDataAccessor: true, sites: [], unparsed: true };
}

/** Require the four default getter bodies, not a trusted-looking core filename. */
export function proveRpgMakerEnemyNameMethods({ source }) {
  const tree = syntax(source);
  if (!tree) return { verified: false, methods: [], reason: 'unparsed-source' };
  const expressions = { name: "this.originalName() + (this._plural ? this._letter : '')", originalName: 'this.enemy().name', enemy: '$dataEnemies[this._enemyId]', enemyId: 'this._enemyId' };
  const shape = node => JSON.stringify(node, (key, value) => ['start', 'end', 'loc', 'raw'].includes(key) ? undefined : value);
  const methods = [], entries = indexTree(tree).entries;
  const getterSites = entries.filter(({ node }) => node.type === 'AssignmentExpression' && enemyMethods.has(property(node.left)) && memberPath(node.left.object) === 'Game_Enemy.prototype');
  const prototypeSites = entries.filter(({ node }) => node.type === 'AssignmentExpression' && memberPath(node.left) === 'Game_Enemy.prototype');
  const initializer = prototypeSites.length === 1 ? prototypeSites[0] : undefined;
  const allowedInitializer = initializer?.node.operator === '=' && tree.body.includes(initializer.parent)
    && initializer.node.start < Math.min(...getterSites.map(({ node }) => node.start))
    && shape(initializer.node.right) === shape(syntax('Object.create(Game_Battler.prototype)').body[0].expression) ? initializer.node : undefined;
  const extraOverride = entries.some(({ node }) => {
    if (node.type === 'AssignmentExpression') return ['Game_Enemy', 'Game_Enemy.prototype'].includes(memberPath(node.left)) && node !== allowedInitializer
      || node.left.type === 'MemberExpression' && property(node.left) === undefined && memberPath(node.left.object) === 'Game_Enemy.prototype';
    return node.type === 'CallExpression' && ['defineProperty', 'defineProperties', 'assign', 'set'].includes(property(node.callee)) && memberPath(node.arguments[0]) === 'Game_Enemy.prototype';
  });
  for (const [method, expression] of Object.entries(expressions)) {
    const matches = entries.filter(({ node }) => node.type === 'AssignmentExpression' && memberPath(node.left) === `Game_Enemy.prototype.${method}`);
    const { node, parent } = matches[0] ?? {}, fn = node?.right, body = fn?.body?.body;
    if (matches.length === 1 && node.operator === '=' && tree.body.includes(parent) && fn.type === 'FunctionExpression' && !fn.async && !fn.generator && fn.params.length === 0
        && body?.length === 1 && body[0].type === 'ReturnStatement' && shape(body[0].argument) === shape(syntax(expression).body[0].expression)) methods.push(method);
  }
  const verified = methods.length === enemyMethods.size && !extraOverride;
  return { verified, methods, ...(verified ? {} : { reason: 'non-default-enemy-getter' }) };
}

/** Bind only native name sources used by explicit identity consumers, never display calls. */
export function analyzeRpgMakerNameIdentity({ file = '', source, allowEnemyBattler = true, blockedDataTables = [], unknownDataAccessor = false }) {
  const tree = syntax(source), warnings = [], edits = new Map(), requirements = { dataTables: [], enemyBattler: false, typeFields: [] };
  const warn = (node, code) => warnings.push({ file, start: node.start, end: node.end, line: node.loc?.start.line, code });
  if (!tree) return { edits: [], warnings: [{ file, code: 'unparsed-source' }], requirements, overrides: detectRpgMakerNameOverrides({ source }) };
  const index = indexTree(tree), overrides = overrideFacts(index), blocked = new Set([...blockedDataTables, ...overrides.dataTables]);
  unknownDataAccessor ||= overrides.unknownDataAccessor;
  warnings.push(...overrides.warnings.map(item => ({ file, ...item })));
  const text = node => source.slice(node.start, node.end);
  const isName = node => node?.type === 'MemberExpression' && property(node) === 'name'
    || node?.type === 'CallExpression' && property(node.callee) === 'name';
  const staticString = (node, seen = new Set()) => {
    if (node?.type === 'Literal') return typeof node.value === 'string';
    if (node?.type === 'TemplateLiteral') return node.expressions.length === 0;
    if (node?.type !== 'Identifier') return false;
    const value = binding(index.scopes.get(node), node.name);
    return value?.init && !seen.has(value) ? staticString(value.init, new Set([...seen, value])) : false;
  };
  const nameEdit = node => {
    const scope = index.scopes.get(node), call = node.type === 'CallExpression', receiver = call ? node.callee.object : node.object;
    const value = origin(receiver, scope);
    if (binding(scope, 'PinHaoNameIdentity') !== undefined) return { error: 'shadowed-identity-api' };
    if (!call && value?.kind === 'record') {
      if (unknownDataAccessor || blocked.has(value.table)) return { error: 'name-accessor-override' };
      if (value.viaEnemy && (!allowEnemyBattler || overrides.enemyBattler)) return { error: 'enemy-name-override' };
      return { table: value.table, replacement: `PinHaoNameIdentity.dataName(${JSON.stringify(value.table)}, ${text(receiver)})` };
    }
    if (call && node.arguments.length === 0 && value?.kind === 'battler') {
      if (value.table === 'Actors') return { error: 'actor-runtime-name-may-be-custom' };
      if (!allowEnemyBattler || overrides.enemyBattler || unknownDataAccessor || blocked.has('Enemies')) return { error: 'enemy-name-override' };
      return { enemy: true, replacement: `PinHaoNameIdentity.battlerName("Enemies", ${text(receiver)})` };
    }
    return { error: 'unproven-name-origin' };
  };
  const select = nodes => {
    const plans = nodes.map(node => ({ node, ...nameEdit(node) }));
    if (plans.some(plan => plan.error)) { for (const plan of plans) if (plan.error) warn(plan.node, plan.error); return; }
    for (const plan of plans) {
      edits.set(plan.node.start, { start: plan.node.start, end: plan.node.end, replacement: plan.replacement });
      if (plan.table && !requirements.dataTables.includes(plan.table)) requirements.dataTables.push(plan.table);
      if (plan.enemy) requirements.enemyBattler = true;
    }
  };
  const filenameNames = node => {
    if (isName(node)) return [node];
    if (node.type === 'BinaryExpression' && node.operator === '+') return [...filenameNames(node.left), ...filenameNames(node.right)];
    if (node.type === 'TemplateLiteral') return node.expressions.flatMap(filenameNames);
    return [];
  };
  const anyNames = node => isName(node) ? [node] : children(node).flatMap(anyNames);
  for (const { node, scope } of index.entries) {
    if (node.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(node.operator) && (isName(node.left) || isName(node.right))) {
      if (isName(node.left) && (staticString(node.right) || isName(node.right)) || isName(node.right) && staticString(node.left)) select([node.left, node.right].filter(isName));
      else for (const name of [node.left, node.right].filter(isName)) warn(name, 'dynamic-name-comparison');
    }
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') continue;
    const method = property(node.callee), receiver = node.callee.object;
    const image = globalIdentifier(receiver, 'ImageManager', scope) && (imageMethods.has(method) || method === 'loadBitmap');
    const picture = globalIdentifier(receiver, '$gameScreen', scope) && method === 'showPicture';
    if (image || picture) {
      const filename = node.arguments[picture || method === 'loadBitmap' ? 1 : 0];
      if (filename) {
        const selected = filenameNames(filename), all = anyNames(filename);
        if (selected.length === all.length) select(selected); else for (const name of all) warn(name, 'unsupported-name-expression');
      }
    }
    if (!['indexOf', 'includes'].includes(method)) continue;
    const array = origin(receiver, scope);
    if (array?.kind === 'types' && staticString(node.arguments[0])) {
      if (binding(scope, 'PinHaoNameIdentity') !== undefined) { warn(node, 'shadowed-identity-api'); continue; }
      edits.set(receiver.start, { start: receiver.start, end: receiver.end, replacement: `PinHaoNameIdentity.typeNames(${JSON.stringify(array.field)}, ${text(receiver)})` });
      if (!requirements.typeFields.includes(array.field)) requirements.typeFields.push(array.field);
    }
    if (receiver.type === 'CallExpression' && property(receiver.callee) === 'map') {
      const callback = receiver.arguments[0];
      const returned = callback?.body?.type === 'BlockStatement' && callback.body.body.length === 1 && callback.body.body[0].type === 'ReturnStatement' ? callback.body.body[0].argument : callback?.body;
      if (isName(returned) && (staticString(node.arguments[0]) || isName(node.arguments[0]))) select([returned, node.arguments[0]].filter(isName));
    }
  }
  return { edits: [...edits.values()].sort((a, b) => a.start - b.start), warnings: [...new Map(warnings.map(item => [`${item.start}:${item.code}`, item])).values()], requirements, overrides };
}

export function rewriteRpgMakerNameIdentity(input) {
  const result = analyzeRpgMakerNameIdentity(input);
  let source = input.source;
  for (const edit of [...result.edits].reverse()) source = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
  return { ...result, source, changed: result.edits.length };
}
