import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DSH_RELEASE_POLICY = 'pinhao-dsh-production-files-1';
const commit = '22ddee3792402c3e70ec5f86a63c3e3e895a2f60';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const slash = value => value.replaceAll('\\', '/');

export function dshReleaseExclusion(relative, { platform = 'win32', arch = 'x64' } = {}) {
  const file = slash(relative);
  if (/(?:^|\/)(?:licen[cs]e|copying|notice)(?:[._-]|$)/i.test(file)) return undefined;
  if (/\.d\.(?:ts|mts|cts)$/i.test(file)) return 'typescript-declarations';
  if (/\.map$/i.test(file)) return 'source-maps';
  if (/\.tsbuildinfo$/i.test(file)) return 'compiler-state';
  if (/\.pdb$/i.test(file)) return 'native-debug-symbols';
  if (platform === 'win32' && arch === 'x64'
    && /(?:^|\/)node_modules\/node-pty\/(?:prebuilds|third_party\/conpty)\/(?:win32|win10)-arm64(?:\/|$)/i.test(file)) return 'other-architecture';
  return undefined;
}

function relativePath(value) {
  if (typeof value !== 'string' || value.includes('\\') || path.posix.isAbsolute(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid runtime manifest path');
  return value;
}

async function listedFiles(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Runtime release cannot contain links: ${relative}`);
    if (entry.isDirectory()) result.push(...await listedFiles(directory, relative));
    else if (entry.isFile()) result.push(relative);
    else throw new Error(`Unsupported runtime entry: ${relative}`);
  }
  return result;
}

/** Derive a new production artifact; the prepared runtime and its provenance stay untouched. */
export async function copyDshRuntimeForRelease({ sourceRoot, outputDirectory, platform = 'win32', arch = 'x64' }) {
  if ((await lstat(sourceRoot)).isSymbolicLink()) throw new Error('Runtime source must not be a link');
  sourceRoot = await realpath(sourceRoot); outputDirectory = path.resolve(outputDirectory);
  for (const [parent, child] of [[sourceRoot, outputDirectory], [outputDirectory, sourceRoot]]) {
    const relative = path.relative(parent, child);
    if (!relative || !relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('Runtime release must be a separate directory');
  }
  try { await lstat(outputDirectory); throw new Error('Runtime release output already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const provenanceName = 'pinhao-runtime-provenance.json';
  const provenanceBytes = await readFile(path.join(sourceRoot, provenanceName));
  const source = JSON.parse(provenanceBytes);
  if (source.schema !== 'pinhao-dsh-runtime-1' || source.commit !== commit || !Array.isArray(source.files)) throw new Error('Unexpected DSH runtime identity');
  const originals = new Map();
  for (const row of source.files) {
    const file = relativePath(row.path), key = platform === 'win32' ? file.toLowerCase() : file;
    if (originals.has(key) || file === provenanceName || !/^[a-f0-9]{64}$/.test(row.sha256 ?? '') || !Number.isSafeInteger(row.bytes) || row.bytes < 0) throw new Error('Invalid runtime manifest record');
    originals.set(key, row);
  }
  const actual = (await listedFiles(sourceRoot)).filter(file => file !== provenanceName);
  if (actual.length !== originals.size || actual.some(file => !originals.has(platform === 'win32' ? file.toLowerCase() : file))) throw new Error('Runtime contains files outside its provenance');
  for (const entry of ['sdkEntry', 'runtimeEntry', 'modelProviderEntry', 'nodeExecutable', 'nodeProvenance']) {
    if (!source[entry] || dshReleaseExclusion(relativePath(source[entry]), { platform, arch })) throw new Error(`Runtime entry cannot be excluded: ${entry}`);
  }
  const files = [], excluded = [], exclusions = {}, directories = new Set();
  await mkdir(outputDirectory, { recursive: true });
  for (const row of source.files) {
    const bytes = await readFile(path.join(sourceRoot, row.path));
    if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw new Error(`Prepared runtime payload changed: ${row.path}`);
    const reason = dshReleaseExclusion(row.path, { platform, arch });
    if (reason) {
      excluded.push({ ...row, reason });
      const group = exclusions[reason] ??= { files: 0, bytes: 0 }; group.files++; group.bytes += row.bytes;
      continue;
    }
    const target = path.join(outputDirectory, row.path), directory = path.dirname(target);
    if (!directories.has(directory)) { await mkdir(directory, { recursive: true }); directories.add(directory); }
    await writeFile(target, bytes, { flag: 'wx' });
    files.push({ ...row });
  }
  if (hash(await readFile(path.join(sourceRoot, provenanceName))) !== hash(provenanceBytes)) throw new Error('Prepared runtime provenance changed during copying');
  const release = { ...source, releasePolicy: { id: DSH_RELEASE_POLICY, platform, arch,
    sourceProvenanceSha256: hash(provenanceBytes), sourceFiles: source.files.length, sourceBytes: source.files.reduce((sum, file) => sum + file.bytes, 0),
    excludedFiles: excluded.length, excludedBytes: excluded.reduce((sum, file) => sum + file.bytes, 0), exclusions,
    exclusionManifestSha256: hash(JSON.stringify(excluded)) }, files, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
  await writeFile(path.join(outputDirectory, provenanceName), JSON.stringify(release, null, 2), { flag: 'wx' });
  return { outputDirectory, ...release };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
  const result = await copyDshRuntimeForRelease({ sourceRoot: args.get('--source'), outputDirectory: args.get('--output') });
  console.log(JSON.stringify({ outputDirectory: result.outputDirectory, files: result.files.length, bytes: result.bytes, releasePolicy: result.releasePolicy }));
}
