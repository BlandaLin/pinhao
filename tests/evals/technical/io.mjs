import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { artifactRecord, digest, uniqueToolCalls } from './events.mjs';

export const loadSource = (root, file) => import(pathToFileURL(path.join(root, file)));
export const within = (root, file) => { const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
export async function fingerprint(file) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
export async function tree(root, { hashes = true, exclude = () => false } = {}) {
  const files = [];
  async function walk(directory, prefix = '') {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${prefix}${entry.name}`, file = path.join(directory, entry.name);
      if (exclude(relative, entry)) continue;
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new Error(`Measured trees must not contain links: ${relative}`);
      if (stat.isDirectory()) await walk(file, `${relative}/`);
      else if (stat.isFile()) files.push({ path: relative, bytes: stat.size, ...(hashes ? { sha256: await fingerprint(file) } : {}) });
      else throw new Error(`Measured tree contains a special file: ${relative}`);
    }
  }
  await walk(root); return files;
}

export async function readConfig(file) {
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  const allowed = new Set(['sourceRoot', 'gameDir', 'outputRoot', 'pythonPath', 'dependencyDir', 'baseUrl', 'model', 'reasoning', 'caseId', 'pairId', 'concurrency', 'mode', 'limits', 'answerIsolation']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown configuration field: ${key}`);
  if (Object.hasOwn(value, 'apiKey') || Object.hasOwn(value, 'connection') || Object.hasOwn(value, 'expectations')) throw new Error('Configuration must not contain credentials or grading answers.');
  const required = ['sourceRoot', 'gameDir', 'outputRoot', 'pythonPath', 'dependencyDir', 'baseUrl', 'model', 'reasoning', 'caseId', 'pairId'];
  for (const field of required) if (typeof value[field] !== 'string' || !value[field].trim()) throw new Error(`Explicit ${field} is required.`);
  for (const field of ['sourceRoot', 'gameDir', 'outputRoot', 'pythonPath', 'dependencyDir']) {
    if (!path.isAbsolute(value[field])) throw new Error(`${field} must be absolute.`);
    value[field] = path.resolve(value[field]);
  }
  const endpoint = new URL(value.baseUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Use a plain model API base URL without credentials, query or fragment.');
  if (!['adaptation', 'all'].includes(value.mode)) throw new Error('Explicit mode must be adaptation or all.');
  if (!Number.isInteger(value.concurrency) || value.concurrency < 1 || value.concurrency > 32) throw new Error('Explicit concurrency must be 1 through 32.');
  if (!Number.isSafeInteger(value.limits?.maxHttp) || value.limits.maxHttp < 1
    || !Number.isFinite(value.limits?.maxMinutes) || value.limits.maxMinutes <= 0) throw new Error('Positive cumulative maxHttp and maxMinutes limits are required.');
  value.limits.maxWindows ??= 16;
  if (!Number.isSafeInteger(value.limits.maxWindows) || value.limits.maxWindows < 1 || value.limits.maxWindows > 16) throw new Error('maxWindows must be 1 through 16.');
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(value.caseId) || !/^[a-z0-9][a-z0-9_-]*$/i.test(value.pairId)) throw new Error('caseId and pairId must be ASCII labels.');
  if (within(value.gameDir, value.outputRoot) || within(value.sourceRoot, value.outputRoot)) throw new Error('Output must be outside the input game and source trees.');
  value.answerIsolation = 'unisolated-development';
  return value;
}

export async function freezeEnvironment(config) {
  const result = {};
  for (const file of ['package.json', 'package-lock.json']) result[`source/${file}`] = await fingerprint(path.join(config.sourceRoot, file));
  for (const directory of ['packages', 'apps/desktop/electron', 'adapters/python', 'kits/workbench-tutorial/toolkit']) {
    const rows = await tree(path.join(config.sourceRoot, directory), { exclude: (relative, entry) =>
      relative.split('/').some(part => ['node_modules', '__pycache__', '.git', '.pytest_cache'].includes(part))
      || entry.isFile() && !/\.(?:mjs|cjs|js|json|yml|yaml|py|cs|wasm|dll|exe)$/.test(relative) });
    for (const row of rows) result[`source/${directory}/${row.path}`] = row.sha256;
  }
  for (const row of await tree(config.dependencyDir)) result[`dependencies/${row.path}`] = row.sha256;
  result.pythonExecutable = await fingerprint(config.pythonPath);
  result.nodeExecutable = await fingerprint(process.execPath);
  for (const row of await tree(import.meta.dirname)) result[`evaluator/${row.path}`] = row.sha256;
  result['evaluator/entry.mjs'] = await fingerprint(path.resolve(import.meta.dirname, '../../../scripts/eval-technical.mjs'));
  return result;
}

export async function planTechnicalRun(config) {
  for (const field of ['sourceRoot', 'gameDir', 'pythonPath', 'dependencyDir']) await fs.access(config[field]);
  return { schema: 'pinhao-technical-eval-plan-1', configuration: config, sourceAndDependencies: await freezeEnvironment(config),
    networkRequests: 0, projectWrites: 0, gameImported: false, answerIsolation: 'unisolated-development',
    warning: 'This plan verifies paths and file identities only; it does not prove native import, solvability or runtime.' };
}

export async function readArtifact(file) {
  const text = await fs.readFile(file, 'utf8'); return { path: file, sha256: digest(text), text };
}

export async function collectArtifacts({ config, dataDir, workspaceDir, database, build }) {
  const artifacts = { candidates: [], validations: [], recipes: [], bindings: [], resolutions: [], checkpoints: [], acceptedReceipts: [], acceptedExtractions: [] }, seen = new Set();
  for (const root of [dataDir, workspaceDir]) {
    for (const file of await tree(root, { hashes: false })) {
      const normalized = file.path.replaceAll('\\', '/');
      const kind = /\/accepted-receipts\/[a-f0-9]{64}\.receipt\.json$/.test(`/${normalized}`) ? 'acceptedReceipts'
        : /\/accepted-receipts\/[a-f0-9]{64}\.extraction\.json$/.test(`/${normalized}`) ? 'acceptedExtractions'
        : normalized.endsWith('pinhao-adapter-binding.json') ? 'bindings'
        : /\/(?:recipe-)?candidates\//.test(`/${normalized}`) ? 'candidates'
        : /\/validations\//.test(`/${normalized}`) ? 'validations' : /\/recipes\//.test(`/${normalized}`) ? 'recipes'
          : normalized.endsWith('/progress.jsonl') ? 'checkpoints' : undefined;
      if (!kind || !/\.jsonl?$/.test(normalized)) continue;
      const artifact = await readArtifact(path.join(root, file.path)), record = artifactRecord(artifact);
      const id = record?.candidateId && kind === 'candidates' ? record.candidateId : record?.validationId && kind === 'validations'
        ? record.validationId : record?.recipeId && kind === 'recipes' ? record.recipeId : artifact.sha256;
      if (!seen.has(`${kind}:${id}`)) { artifacts[kind].push(artifact); seen.add(`${kind}:${id}`); }
    }
  }
  const project = database.project, roots = [...new Set([project.imageReadRoot, path.resolve(config.gameDir, project.resourceRoot ?? '.'), ...(project.technicalSourceRoots ?? [])].filter(Boolean))];
  const { createDisplayVerifier } = await loadSource(config.sourceRoot, 'packages/technical/adaptation/display-review.mjs');
  const { listFiles, checkedPath } = await loadSource(config.sourceRoot, 'packages/technical/adaptation/paths.mjs');
  const { createDisplaySourceResolver } = await loadSource(config.sourceRoot, 'packages/technical/adaptation/source-origins.mjs');
  const { isPrivateGamePath } = await loadSource(config.sourceRoot, 'packages/core/private-paths.mjs');
  const display = createDisplayVerifier({ connectionFor: async () => ({ baseUrl: config.baseUrl, model: config.model }), projectFor: async () => project, readRootsFor: async () => roots,
    sourceResolverFor: async ({ input, roots: reviewRoots }) => {
      const technical = path.join(workspaceDir, 'technical'), relative = path.relative(technical, path.resolve(input.gameDir));
      const parts = relative.split(path.sep); let sourceCopyPath;
      if (parts.length === 2 && parts[0] !== '..' && parts[1] === 'source' && !path.isAbsolute(relative)) {
        sourceCopyPath = await checkedPath(technical, relative.replaceAll('\\', '/'));
      }
      return createDisplaySourceResolver({ projectId: project.id, roots: reviewRoots, sourceCopyPath, allowedSourceRoots: roots });
    } });
  const freshness = {};
  for (const artifact of artifacts.validations) {
    const record = artifactRecord(artifact); if (!record) continue;
    const check = { files: [], listings: [], roundtripFiles: [], sampleFiles: [], complete: true, displayFresh: false };
    try {
      if (![config.gameDir, workspaceDir].some(root => within(root, record.gameDir))) throw new Error('Validation source escaped measured roots.');
      for (const [file, expected] of [...Object.entries(record.resourceHashes ?? {}), ...Object.entries(record.dependencies?.files ?? {})]) {
        const target = path.resolve(record.gameDir, file);
        if (!within(record.gameDir, target)) throw new Error('Invalid validation dependency path.');
        check.files.push({ file, expected, actual: await fingerprint(target) });
      }
      if (!record.sample?.path || !within(workspaceDir, record.sample.path)) throw new Error('Missing or unmeasured sample output.');
      for (const [file, expected] of Object.entries(record.resourceHashes ?? {})) {
        const roundtrip = path.resolve(record.sample.path, '..', 'roundtrip', file), sample = path.resolve(record.sample.path, file);
        if (!within(workspaceDir, roundtrip) || !within(record.sample.path, sample)) throw new Error('Sample resource escaped the validation output.');
        check.roundtripFiles.push({ file, expected, actual: await fingerprint(roundtrip) });
        check.sampleFiles.push({ file, original: expected, actual: await fingerprint(sample) });
      }
      for (const file of record.dependencies?.missingFiles ?? []) {
        if (await fs.access(path.join(record.gameDir, file)).then(() => true, () => false)) check.complete = false;
      }
      for (const [directory, expected] of Object.entries(record.dependencies?.listings ?? {})) {
        const listing = await listFiles(record.gameDir, directory, record.dependencies.identity?.limits?.maxFiles, { excludePath: isPrivateGamePath });
        const actual = digest(JSON.stringify(listing.files));
        check.listings.push({ directory, expected, actual });
        if (listing.truncated || actual !== expected) check.complete = false;
      }
      check.displayFresh = await display.isFresh(record.displayReview, { gameDir: record.gameDir });
      if (!check.displayFresh) check.complete = false;
      if (record.sourceView) {
        const archive = path.join(record.sourceView.originalGameDir, record.sourceView.container.file);
        check.files.push({ file: 'source-container', expected: record.sourceView.archiveHash, actual: await fingerprint(archive) });
      }
    } catch (error) { check.complete = false; check.error = error.message; }
    freshness[record.validationId] = check;
  }
  const resolutionFreshness = {};
  const { hasCoverageDecisionProof, coverageDecisionFresh } = await loadSource(config.sourceRoot, 'packages/technical/coverage-decisions.mjs');
  const decisions = [...new Map([...(project.coverage?.coverageDecisions ?? []), ...(project.coverageDecisions ?? [])]
    .map(decision => [decision.id, decision])).values()];
  for (const decision of decisions) {
    const text = JSON.stringify(decision), artifact = { path: 'database:coverage', text, sha256: digest(text) };
    artifacts.resolutions.push(artifact);
    resolutionFreshness[decision.id] = { artifactSha256: artifact.sha256, protocolVerified: hasCoverageDecisionProof(decision),
      fresh: await coverageDecisionFresh(decision, { roots, projectId: project.id, sourceContextHash: project.coverage?.sourceContextHash }) };
  }
  let buildEvidence;
  if (build) {
    const outputFiles = [];
    for (const row of build.outputManifest?.files ?? []) {
      const file = path.resolve(build.path, row.path);
      outputFiles.push({ file: row.path, expected: row.sha256, actual: within(build.path, file) ? await fingerprint(file).catch(() => null) : null });
    }
    const text = JSON.stringify(build);
    buildEvidence = { artifact: { path: 'database:builds', text, sha256: digest(text) }, outputFiles, reachedThroughService: true, partial: project.adaptationDeferred === true };
  }
  const wires = [];
  const httpRoot = path.join(path.dirname(dataDir), 'http');
  try {
    for (const file of await tree(httpRoot, { hashes: false })) if (file.path.endsWith('/request.json')) {
      try { wires.push(JSON.parse(await fs.readFile(path.join(httpRoot, file.path), 'utf8'))); } catch {}
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const toolCalls = uniqueToolCalls(wires, artifacts.checkpoints.map(artifactRecord).filter(Boolean));
  const inputPublications = [...new Map([project.publication, ...database.tasks.map(task => task.productionInput)].filter(Boolean)
    .map(input => [canonicalPublication(input), input])).values()];
  const publicationEvidence = [];
  for (const input of inputPublications) {
    const root = input.workbenchDir ?? project.workbenchDir, ref = input.compositeManifestRef;
    const file = root && path.resolve(root, ref?.file ?? 'manifest.json');
    const record = { generation: input.generation ?? 0, workbenchDir: root, compositeManifestRef: ref ?? null };
    if (!file || !within(workspaceDir, file)) publicationEvidence.push({ ...record, valid: false, reason: 'snapshot-outside-measured-workspace' });
    else try {
      const artifact = await readArtifact(file), actual = await fingerprint(file);
      publicationEvidence.push({ ...record, artifact, actualSha256: actual, expectedSha256: ref?.sha256 ?? actual,
        valid: !ref || ref.sha256 === actual, proofScope: ref ? 'exact-composite-manifest' : 'native-manifest-at-collection' });
    } catch (error) { publicationEvidence.push({ ...record, valid: false, reason: error.message }); }
  }
  return { artifacts, freshness, resolutionFreshness, build: buildEvidence, publicationEvidence,
    observer: { toolCallIds: toolCalls.map(call => ({ id: call.id, name: call.name })),
      sdkSteps: null, note: 'Logical tool calls are deduplicated over actual wire history plus final checkpoints; they are not SDK steps or HTTP requests.' } };
}

const canonicalPublication = input => JSON.stringify([input.generation ?? 0, input.workbenchDir, input.compositeManifestRef ?? null]);
