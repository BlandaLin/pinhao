import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { builtinModules, createRequire } from 'node:module';
import { access, cp, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DSH_RELEASE_POLICY, dshReleaseExclusion } from './dsh-release-policy.mjs';

const COMMIT = '22ddee3792402c3e70ec5f86a63c3e3e895a2f60';
const NODE_VERSION = 'v24.16.0';
const NODE_SHA256 = 'b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3';
const NODE_BASE_URL = `https://nodejs.org/dist/${NODE_VERSION}`;
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const slash = value => value.replaceAll('\\', '/');
const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);
const exists = async file => { try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; } };

async function packageRoot(file) {
  let directory = path.dirname(file);
  while (!await exists(path.join(directory, 'package.json'))) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`No package metadata for ${file}`);
    directory = parent;
  }
  return realpath(directory);
}

async function resolvePackage(name, from) {
  const require = createRequire(path.join(from, 'package.json'));
  for (const lookup of require.resolve.paths(name) ?? []) {
    const directory = path.join(lookup, name);
    if (await exists(path.join(directory, 'package.json'))) return realpath(directory);
  }
  throw Object.assign(new Error(`Missing installed runtime dependency ${name} from ${from}`), { code: 'DSH_DEPENDENCY_MISSING' });
}

async function filesBelow(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Runtime artifact must not contain links: ${relative}`);
    if (entry.isDirectory()) files.push(...await filesBelow(directory, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

export async function verifyManagedNode(managedNodeRoot = path.join(root, 'local/managed-node')) {
  const [executable, license, sums] = await Promise.all(['node.exe', 'LICENSE', 'SHASUMS256.txt'].map(file => readFile(path.join(managedNodeRoot, file))));
  const checksum = sums.toString('utf8').split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?(\S+)$/.exec(line.trim()))
    .find(match => match?.[2] === 'win-x64/node.exe')?.[1];
  if (checksum !== NODE_SHA256 || hash(executable) !== NODE_SHA256) throw new Error('Managed Node executable does not match the frozen official release checksum');
  if (!license.length) throw new Error('Managed Node license is missing');
  return { executable, license, sums, provenance: { schema: 'pinhao-managed-node-1', version: NODE_VERSION,
    platform: 'win32', arch: 'x64', sourceUrl: `${NODE_BASE_URL}/win-x64/node.exe`, sha256: NODE_SHA256,
    checksumUrl: `${NODE_BASE_URL}/SHASUMS256.txt`, checksumEntry: 'win-x64/node.exe', checksumFileSha256: hash(sums),
    licenseUrl: 'https://raw.githubusercontent.com/nodejs/node/v24.16.0/LICENSE', licenseSha256: hash(license) } };
}

async function copyManagedNode(outputDirectory, asset) {
  const directory = path.join(outputDirectory, 'node');
  await mkdir(directory, { recursive: true });
  const payloads = { 'node.exe': asset.executable, LICENSE: asset.license, 'SHASUMS256.txt': asset.sums,
    'provenance.json': Buffer.from(JSON.stringify(asset.provenance, null, 2)) };
  for (const [file, bytes] of Object.entries(payloads)) {
    const target = path.join(directory, file);
    if (await exists(target)) {
      if (hash(await readFile(target)) !== hash(bytes)) throw new Error(`Existing managed Node asset differs: ${file}`);
    } else await writeFile(target, bytes, { flag: 'wx' });
  }
}

async function saveProvenance(outputDirectory, metadata) {
  const files = [];
  for (const relative of (await filesBelow(outputDirectory)).sort()) {
    if (relative === 'pinhao-runtime-provenance.json') continue;
    const bytes = await readFile(path.join(outputDirectory, relative));
    files.push({ path: slash(relative), sha256: hash(bytes), bytes: bytes.length });
  }
  const provenance = { ...metadata, files, bytes: files.reduce((sum, item) => sum + item.bytes, 0) };
  await writeFile(path.join(outputDirectory, 'pinhao-runtime-provenance.json'), JSON.stringify(provenance, null, 2));
  return { outputDirectory, ...provenance };
}

/** Add the same verified asset to an already built isolated runtime. */
export async function addManagedNodeToRuntime({ outputDirectory, managedNodeRoot } = {}) {
  const provenance = JSON.parse(await readFile(path.join(outputDirectory, 'pinhao-runtime-provenance.json'), 'utf8'));
  if (provenance.schema !== 'pinhao-dsh-runtime-1' || provenance.commit !== COMMIT) throw new Error('Unexpected runtime artifact identity');
  for (const entry of provenance.files) {
    const relative = path.relative(outputDirectory, path.resolve(outputDirectory, entry.path));
    if (path.isAbsolute(entry.path) || relative.startsWith('..') || path.isAbsolute(relative)
        || hash(await readFile(path.join(outputDirectory, entry.path))) !== entry.sha256) throw new Error('Existing runtime payload changed before adding Node');
  }
  await copyManagedNode(outputDirectory, await verifyManagedNode(managedNodeRoot));
  return saveProvenance(outputDirectory, { ...provenance, nodeExecutable: 'node/node.exe', nodeProvenance: 'node/provenance.json' });
}

/** Copy the actual compiled profile, without bundling or editing upstream code. */
export async function packageDshRuntime({ sourceRoot = path.join(root, 'local/upstream/deepseek-harness'),
  outputDirectory = path.join(root, 'local/dsh-runtime'), runtimeManifest, managedNodeRoot = path.join(root, 'local/managed-node') } = {}) {
  sourceRoot = await realpath(sourceRoot); outputDirectory = path.resolve(outputDirectory);
  const relativeOutput = path.relative(sourceRoot, outputDirectory);
  if (!relativeOutput || !relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput)) throw new Error('Runtime output must be outside the fixed upstream checkout');
  if (await exists(outputDirectory) && (await readdir(outputDirectory)).length) throw new Error('Runtime output must be new or empty; existing artifacts are not overwritten');
  let head = (await readFile(path.join(sourceRoot, '.git/HEAD'), 'utf8')).trim();
  if (head.startsWith('ref: ')) head = (await readFile(path.join(sourceRoot, '.git', head.slice(5)), 'utf8')).trim();
  if (head !== COMMIT) throw new Error('Upstream checkout is not the frozen DSH commit');
  const manifest = typeof runtimeManifest === 'string' ? JSON.parse(await readFile(runtimeManifest, 'utf8')) : runtimeManifest;
  if (!Array.isArray(manifest?.modules)) throw new Error('An actual loaded runtime module manifest is required');
  const managedNode = await verifyManagedNode(managedNodeRoot);
  const records = new Map(), staticEdges = [], missingOptional = [];
  const add = async directory => {
    directory = await realpath(directory);
    if (!records.has(directory)) {
      const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      const relative = path.relative(sourceRoot, directory);
      const workspace = relative && !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.split(path.sep).includes('node_modules');
      records.set(directory, { directory, metadata, workspace: Boolean(workspace), edges: new Map() });
    }
    return records.get(directory);
  };
  const seeds = [path.join(sourceRoot, 'packages/sdk/client/lib/index.js'), path.join(sourceRoot, 'apps/cli/lib/bin.js')];
  const cli = path.join(sourceRoot, 'apps/cli');
  for (const name of ['@deepseek-ai/dsh-sdk-minimal', '@deepseek-ai/dsh-llm-pi-ai']) {
    const record = await add(await resolvePackage(name, cli));
    if (await exists(path.join(record.directory, 'lib/index.js'))) seeds.push(path.join(record.directory, 'lib/index.js'));
  }
  for (const module of manifest.modules) {
    if (!module.name?.startsWith('@deepseek-ai/') || !module.packageDir) continue;
    const record = await add(module.packageDir);
    if (await exists(path.join(record.directory, 'lib/index.js'))) seeds.push(path.join(record.directory, 'lib/index.js'));
  }
  for (const file of seeds) await add(await packageRoot(file));
  const workspaceScan = await build({ entryPoints: [...new Set(seeds)], bundle: true, write: false,
    outdir: path.join(outputDirectory, '.scan-not-written'), platform: 'node', target: 'node24', format: 'esm',
    metafile: true, logLevel: 'silent', plugins: [{ name: 'runtime-dependency-identity', setup(builder) {
      builder.onResolve({ filter: /^[^./#]/ }, async args => {
        if (args.pluginData?.resolved || builtins.has(args.path) || path.isAbsolute(args.path)) return;
        const resolved = await builder.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { resolved: true } });
        if (resolved.errors.length) return { errors: resolved.errors, warnings: resolved.warnings };
        const target = await add(await packageRoot(resolved.path));
        const source = args.importer ? await add(await packageRoot(args.importer)) : null;
        if (source) {
          source.edges.set(target.metadata.name, target.directory);
          staticEdges.push({ source: source.directory, target: target.directory, specifier: args.path,
            kind: args.kind, resolved: path.relative(target.directory, resolved.path) });
        }
        return target.workspace ? { path: resolved.path } : { path: args.path, external: true };
      });
    } }] });
  // Workspace metadata is deliberately broad (CLI includes Web/TUI). Only
  // actual static imports and profile modules above select workspace packages.
  for (const record of records.values()) {
    const declarations = { ...record.metadata.dependencies, ...record.metadata.peerDependencies, ...record.metadata.optionalDependencies };
    for (const name of Object.keys(declarations)) {
      // createRequire-based native hooks are invisible to an import scan.
      // Keep selected workspace packages' declared third-party dependencies,
      // without pulling unrelated workspace applications from the CLI list.
      if (record.workspace && String(declarations[name]).startsWith('workspace:')) continue;
      try {
        const dependency = await add(await resolvePackage(name, record.directory));
        record.edges.set(name, dependency.directory);
      } catch (error) {
        if (!record.metadata.optionalDependencies?.[name] && !record.metadata.peerDependenciesMeta?.[name]?.optional) throw error;
        missingOptional.push({ package: `${record.metadata.name}@${record.metadata.version}`, dependency: name, reason: 'not-installed-for-this-platform' });
      }
    }
  }
  const placements = new Map(), queue = [], rootSlots = new Map();
  const place = (record, directory) => {
    if (placements.has(directory)) {
      if (placements.get(directory).record.directory !== record.directory) throw new Error(`Dependency placement collision: ${directory}`);
      return;
    }
    const item = { record, directory }; placements.set(directory, item); queue.push(item);
  };
  for (const record of records.values()) if (!rootSlots.has(record.metadata.name)) {
    const directory = path.join(outputDirectory, 'node_modules', record.metadata.name);
    rootSlots.set(record.metadata.name, record.directory); place(record, directory);
  }
  const resolvePlacement = (name, from) => {
    let directory = from;
    for (;;) {
      const found = placements.get(path.join(directory, 'node_modules', name));
      if (found) return found;
      if (directory === outputDirectory) return null;
      const parent = path.dirname(directory);
      if (parent === directory || path.relative(outputDirectory, parent).startsWith('..')) return null;
      directory = parent;
    }
  };
  for (const item of queue) {
    for (const [name, target] of item.record.edges) {
      const resolved = resolvePlacement(name, item.directory);
      if (resolved?.record.directory !== target) place(records.get(target), path.join(item.directory, 'node_modules', name));
    }
    if (placements.size > records.size * 16) throw new Error('Runtime dependency nesting did not converge');
  }
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, 'package.json'), JSON.stringify({ name: 'pinhao-dsh-runtime', private: true, type: 'module', license: 'MIT' }, null, 2));
  for (const item of placements.values()) {
    await mkdir(item.directory, { recursive: true });
    const source = item.record.directory;
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (item.record.workspace && ['src', 'tests', 'test', 'reference', '.agents', '.codex'].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Package payload contains a link: ${item.record.metadata.name}/${entry.name}`);
      await cp(path.join(source, entry.name), path.join(item.directory, entry.name), { recursive: true, dereference: true,
        filter: async file => (await lstat(file)).isDirectory() || !dshReleaseExclusion(slash(path.relative(outputDirectory,
          path.join(item.directory, path.relative(source, file))))),
      });
    }
    if (item.record.workspace && !await exists(path.join(item.directory, 'LICENSE'))) await cp(path.join(sourceRoot, 'LICENSE'), path.join(item.directory, 'LICENSE'));
  }
  const packageReport = [];
  for (const item of placements.values()) {
    for (const [name, target] of item.record.edges) {
      const resolved = await resolvePackage(name, item.directory);
      const expected = resolvePlacement(name, item.directory);
      if (!expected || resolved !== await realpath(expected.directory) || expected.record.directory !== target) throw new Error(`Final Node dependency resolution differs: ${item.record.metadata.name} -> ${name}`);
    }
    packageReport.push({ name: item.record.metadata.name, version: item.record.metadata.version,
      path: slash(path.relative(outputDirectory, item.directory)), workspace: item.record.workspace,
      dependencies: [...item.record.edges].map(([name, target]) => ({ name, version: records.get(target).metadata.version })) });
  }
  // Verify static import entrypoints too, including export subpaths. The scan
  // validates the copied original files; it does not generate a substitute bundle.
  const sdkDirectory = [...placements.values()].find(item => item.record.metadata.name === '@deepseek-ai/dsh-sdk-client').directory;
  const cliDirectory = [...placements.values()].find(item => item.record.metadata.name === '@deepseek-ai/dsh').directory;
  const modelProviderDirectory = [...placements.values()].find(item => item.record.metadata.name === '@deepseek-ai/dsh-llm-pi-ai').directory;
  await build({ entryPoints: [path.join(sdkDirectory, 'lib/index.js'), path.join(cliDirectory, 'lib/bin.js')],
    bundle: true, write: false, outdir: path.join(outputDirectory, '.verify-not-written'), platform: 'node', target: 'node24',
    format: 'esm', logLevel: 'silent', external: [...builtins], plugins: [{ name: 'verify-copied-package-imports', setup(builder) {
      builder.onResolve({ filter: /^[^./#]/ }, async args => {
        if (args.pluginData?.resolved || builtins.has(args.path) || path.isAbsolute(args.path)) return;
        const result = await builder.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { resolved: true } });
        if (result.errors.length) return { errors: result.errors, warnings: result.warnings };
        const inside = path.relative(outputDirectory, result.path);
        if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`Runtime import escaped artifact: ${args.path}`);
        return { path: args.path, external: true };
      });
    } }] });
  await cp(path.join(sourceRoot, 'LICENSE'), path.join(outputDirectory, 'LICENSE'));
  await writeFile(path.join(outputDirectory, 'runtime-dependencies.json'), JSON.stringify({ schema: 'pinhao-dsh-dependencies-1',
    commit: COMMIT, packages: packageReport, missingOptional,
    staticImports: staticEdges.map(edge => ({ from: records.get(edge.source).metadata.name, to: records.get(edge.target).metadata.name,
      specifier: edge.specifier, kind: edge.kind, entry: slash(edge.resolved) })),
    scanInputs: Object.keys(workspaceScan.metafile.inputs).length }, null, 2));
  await copyManagedNode(outputDirectory, managedNode);
  return saveProvenance(outputDirectory, { schema: 'pinhao-dsh-runtime-1', commit: COMMIT,
    sdkEntry: slash(path.relative(outputDirectory, path.join(sdkDirectory, 'lib/index.js'))),
    runtimeEntry: slash(path.relative(outputDirectory, path.join(cliDirectory, 'lib/bin.js'))),
    modelProviderEntry: slash(path.relative(outputDirectory, path.join(modelProviderDirectory, 'lib/index.js'))),
    nodeExecutable: 'node/node.exe', nodeProvenance: 'node/provenance.json', packages: packageReport.length,
    releasePolicy: { id: DSH_RELEASE_POLICY, platform: 'win32', arch: 'x64' } });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const options = { sourceRoot: args.get('--source'), outputDirectory: args.get('--output'), runtimeManifest: args.get('--manifest'), managedNodeRoot: args.get('--node') };
  const result = args.has('--add-node') ? await addManagedNodeToRuntime(options) : await packageDshRuntime(options);
  console.log(JSON.stringify({ outputDirectory: result.outputDirectory, packages: result.packages, files: result.files.length, bytes: result.bytes }));
}
