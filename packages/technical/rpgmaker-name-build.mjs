import { readFile, realpath, lstat, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { inspectPlugins } from '../runtime/rpgmaker-plugins.mjs';
import { detectRpgMakerNameOverrides, proveRpgMakerEnemyNameMethods, rewriteRpgMakerNameIdentity } from './rpgmaker-name-identity.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const owned = new Set(['PinHaoLocalization', 'PinHaoNameIdentity', 'PinhaoAssist']);
const inside = (base, file) => { const relative = path.relative(base, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const fileKey = file => process.platform === 'win32' ? file.toLowerCase() : file;

async function fileAt(root, relative) {
  const file = path.resolve(root, relative);
  if (!inside(root, file)) throw new Error('名称检查文件超出成品目录');
  const info = await lstat(file), canonical = await realpath(file);
  if (!info.isFile() || info.isSymbolicLink() || !inside(root, canonical)) throw new Error('名称检查只接受成品内的普通文件');
  return canonical;
}

// Replacing the directory entry also breaks a possible shared hardlink before any write.
async function replaceFile(file, content, expected) {
  if (expected !== undefined && hash(await readFile(file)) !== hash(expected)) throw new Error('名称检查期间成品文件已变化，请重新生成');
  const temporary = `${file}.pinhao-${randomUUID()}.tmp`;
  try { await writeFile(temporary, content, { flag: 'wx' }); await rename(temporary, file); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Finalize after all text overlays; only the new independent product is changed. */
export async function finalizeRpgMakerNameIdentity({ outputDir, engine, resourceRoot, signal }) {
  if (!['MV', 'MZ'].includes(engine)) return { status: 'not-applicable', changed: 0, warningCount: 0 };
  const output = await realpath(outputDir);
  let root = output;
  if (resourceRoot) root = await realpath(path.resolve(output, resourceRoot));
  else {
    try { await fileAt(root, 'js/plugins.js'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { root = await realpath(path.join(output, 'www')); } catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
    }
  }
  if (!inside(output, root)) throw new Error('名称检查资源目录超出独立成品');
  const report = { schema: 'pinhao-name-identity-report-1', changed: 0, files: [], warnings: [], informational: [], runtimeVerified: false };
  let changedThisRun = 0;
  const warn = (file, code) => report.warnings.push({ file, code });
  const finish = async status => {
    const reportFile = 'pinhao-name-identity-report.json';
    await replaceFile(path.join(output, reportFile), JSON.stringify(report, null, 2));
    return { status: status ?? (report.warnings.length ? 'needs-review' : 'checked'), changed: report.changed, changedThisRun, warningCount: report.warnings.length, reportFile };
  };
  let manifestFile;
  try { manifestFile = await fileAt(root, 'js/plugins.js'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; warn('js/plugins.js', 'plugin-manifest-missing'); return finish('unavailable'); }
  const manifest = inspectPlugins(await readFile(manifestFile, 'utf8'));
  for (const issue of manifest.unresolved) warn('js/plugins.js', `plugin-manifest:${issue}`);
  const enabled = manifest.plugins.filter(row => row.status === true);
  if (enabled[0]?.name !== 'PinHaoNameIdentity') warn('js/plugins.js', 'identity-runtime-not-first');
  const identityRelative = 'js/plugins/PinHaoNameIdentity.js';
  let identityFile, identitySource, config, unknownLoad = Boolean(report.warnings.length);
  try {
    identityFile = await fileAt(root, identityRelative); identitySource = await readFile(identityFile, 'utf8');
    config = JSON.parse(/  var config = (.+);\r?\n/.exec(identitySource)?.[1] ?? 'null');
    if (config?.schema !== 'pinhao-name-identity-1' || !config.tables || !config.types) throw new Error('名称身份资料不完整，请重新生成成品');
  } catch (error) { if (error.code !== 'ENOENT') throw error; warn(identityRelative, 'identity-runtime-missing'); unknownLoad = true; }
  const core = `js/${engine === 'MZ' ? 'rmmz' : 'rpg'}_objects.js`;
  let proof = { verified: false, reason: 'core-not-found' }, coreFile;
  try { coreFile = await fileAt(root, core); proof = proveRpgMakerEnemyNameMethods({ source: await readFile(coreFile, 'utf8') }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pluginFiles = new Set(enabled.filter(row => !owned.has(row.name)).map(row => `js/plugins/${row.name}.js`));
  const scripts = new Set(pluginFiles), directScripts = new Set(), inlineScripts = [];
  for (const part of ['core', 'managers', 'objects', 'scenes', 'sprites', 'windows']) scripts.add(`js/${engine === 'MZ' ? 'rmmz' : 'rpg'}_${part}.js`);
  try {
    const html = (await readFile(await fileAt(root, 'index.html'), 'utf8')).replace(/<!--[\s\S]*?-->/g, '');
    for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
      const relative = (match[1] ?? match[2] ?? match[3]).split(/[?#]/)[0].replace(/^\.\//, '');
      if (/^(?:[a-z]+:|\/|\\)/i.test(relative)) { warn('index.html', 'external-script-unverified'); unknownLoad = true; continue; }
      scripts.add(relative); directScripts.add(relative);
    }
    for (const [index, match] of [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].entries()) {
      const attrs = match[1], type = /\btype\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]?.toLowerCase() ?? '';
      if (/\bsrc\s*=/i.test(attrs) || !match[2].trim() || !['', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript', 'module'].includes(type)) continue;
      inlineScripts.push({ relative: `index.html#script-${index + 1}`, source: match[2], rewriteEligible: false });
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; warn('index.html', 'entry-scripts-unverified'); unknownLoad = true; }
  const documents = [], byFile = new Map(), blocked = new Set(config?.blockedTables ?? []);
  let enemyOverride = false, unknownAccessor = false;
  for (const relative of scripts) {
    signal?.throwIfAborted();
    try {
      const file = await fileAt(root, relative), key = fileKey(file), rewriteEligible = pluginFiles.has(relative) && !directScripts.has(relative);
      if (byFile.has(key)) { byFile.get(key).rewriteEligible &&= rewriteEligible; continue; }
      const source = await readFile(file, 'utf8');
      const facts = detectRpgMakerNameOverrides({ source });
      report.informational.push(...(facts.warnings ?? []).map(item => ({ ...item, file: relative })));
      enemyOverride ||= facts.enemyBattler && !(coreFile && key === fileKey(coreFile) && proof.verified); unknownAccessor ||= facts.unknownDataAccessor;
      facts.dataTables.forEach(table => blocked.add(table));
      if (facts.unparsed) { warn(relative, 'script-scope-unparsed'); unknownLoad = true; }
      const document = { relative, file, source, rewriteEligible }; byFile.set(key, document); documents.push(document);
    } catch (error) { if (error.code !== 'ENOENT') throw error; warn(relative, 'loaded-script-missing'); unknownLoad = true; }
  }
  for (const document of inlineScripts) {
    const facts = detectRpgMakerNameOverrides({ source: document.source });
    enemyOverride ||= facts.enemyBattler; unknownAccessor ||= facts.unknownDataAccessor;
    facts.dataTables.forEach(table => blocked.add(table));
    report.informational.push(...(facts.warnings ?? []).map(item => ({ ...item, file: document.relative })));
    if (facts.unparsed) { warn(document.relative, 'script-scope-unparsed'); unknownLoad = true; }
    documents.push(document);
  }
  report.enemyGetter = { ...proof, pluginOverride: enemyOverride };
  if (!proof.verified) warn(core, proof.reason ?? 'enemy-getter-unverified');
  if (enemyOverride) warn('js/plugins.js', 'custom-enemy-getter');
  const allowEnemyBattler = proof.verified && !enemyOverride && !unknownAccessor;
  const patches = [];
  try {
    const previous = JSON.parse(await readFile(await fileAt(output, 'pinhao-name-identity-report.json'), 'utf8'));
    if (previous.schema === report.schema && Array.isArray(previous.files)) for (const item of previous.files) {
      const document = documents.find(value => value.relative === item.file);
      if (document && item.after === hash(document.source) && Number.isSafeInteger(item.changed) && item.changed > 0) {
        report.files.push(item); report.changed += item.changed;
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!unknownLoad) for (const document of documents) {
    signal?.throwIfAborted();
    const result = rewriteRpgMakerNameIdentity({ file: document.relative, source: document.source,
      allowEnemyBattler, blockedDataTables: [...blocked], unknownDataAccessor: unknownAccessor });
    report.warnings.push(...result.warnings.filter(item => item.code !== 'unproven-name-accessor-target'));
    if (result.changed && !document.rewriteEligible) { warn(document.relative, 'script-before-identity-runtime'); continue; }
    if (result.changed) {
      patches.push({ ...document, after: result.source }); report.changed += result.changed; changedThisRun += result.changed;
      const previous = report.files.find(item => item.file === document.relative);
      const receipt = { file: document.relative, changed: (previous?.changed ?? 0) + result.changed, before: previous?.before ?? hash(document.source), after: hash(result.source) };
      if (previous) Object.assign(previous, receipt); else report.files.push(receipt);
    }
  }
  if (config) {
    config.enemyNativeVerified = allowEnemyBattler && !unknownLoad;
    const replacement = identitySource.replace(/  var config = .+;\r?\n/, () => `  var config = ${JSON.stringify(config).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')};\n`);
    if (replacement !== identitySource) patches.unshift({ file: identityFile, source: identitySource, after: replacement });
  }
  for (const patch of patches) { signal?.throwIfAborted(); await replaceFile(patch.file, patch.after, patch.source); }
  return finish();
}
