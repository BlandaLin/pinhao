import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkedPath } from './adaptation/paths.mjs';
import { embeddedCommand } from './embedded-text.mjs';
import { qualifyEmbeddedContracts } from './embedded-command-contract.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const pointer = parts => '/' + parts.map(value => String(value).replaceAll('~', '~0').replaceAll('/', '~1')).join('/');

/** Discover only proven message consumers; unknown commands retain their normal review route. */
export async function discoverNativeEmbedded({ gameDir, signal }) {
  let root;
  for (const suffix of ['', 'www']) {
    const candidate = path.join(gameDir, suffix);
    try { await readFile(await checkedPath(candidate, 'js/rpg_objects.js')); root = candidate; break; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  if (!root) return undefined;
  // An unused MV file in an MZ distribution is not the active command parser.
  try { await readFile(await checkedPath(root, 'js/rmmz_core.js')); return undefined; }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  const units = [], sourceFiles = {};
  const entries = await readdir(await checkedPath(root, 'data', { directory: true }));
  for (const file of entries.filter(name => /^(?:Map\d+|CommonEvents|Troops)\.json$/.test(name)).sort()) {
    signal?.throwIfAborted();
    const relative = `data/${file}`, raw = await readFile(await checkedPath(root, relative));
    const document = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
    sourceFiles[relative] = hash(raw);
    const visit = (value, parts = []) => {
      if (!value || typeof value !== 'object') return;
      if (value.code === 356 && Array.isArray(value.parameters) && typeof value.parameters[0] === 'string') {
        const target = pointer([...parts, 'parameters', 0]);
        if (embeddedCommand(relative, document, target)) units.push({ id: `${relative}:${target}`, rawSource: value.parameters[0],
          locator: { file: relative, pointer: target, segment: { syntax: 'rpgmaker-plugin-command', prefix: '', suffix: '' } } });
      }
      for (const [key, item] of Object.entries(value)) visit(item, [...parts, Array.isArray(value) ? Number(key) : key]);
    };
    visit(document);
  }
  if (!units.length) return undefined;
  try {
    const result = await qualifyEmbeddedContracts({ gameDir: root, units, signal, discover: true });
    if (!result.selections.length) return undefined;
    const dependencies = Object.assign({}, ...result.selections.map(item => item.contract.dependencies));
    return { format: 'pinhao-native-embedded-1', root, selections: result.selections, dependencies, sourceFiles };
  } catch (error) {
    if (signal?.aborted || error.code !== 'EMBEDDED_REPRESENTATION_PENDING' && !(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}
