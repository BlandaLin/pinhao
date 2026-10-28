import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { checkedPath, inside, readSlice } from './paths.mjs';

const attemptPattern = /^native-attempt-[a-f0-9-]{36}$/;
const text = (value, length = 2048) => typeof value === 'string' ? value.slice(0, length) : undefined;
const invalid = message => Object.assign(new Error(message), { code: 'NATIVE_ARTIFACT_INVALID', hostFailure: true });

export function nativeErrorDetails(value = {}) {
  value ??= {};
  const result = {};
  if (value.diagnostic && ['dependency', 'format', 'native'].includes(value.diagnostic.category)) {
    result.diagnostic = { category: value.diagnostic.category };
    for (const key of ['phase', 'engine', 'dependencyId', 'expectedVersion', 'detail']) {
      const item = text(value.diagnostic[key]);
      if (item !== undefined) result.diagnostic[key] = item;
    }
    if (['ready', 'missing', 'invalid', 'unsupported'].includes(value.diagnostic.state)) result.diagnostic.state = value.diagnostic.state;
  }
  if (typeof value.attemptId === 'string' && attemptPattern.test(value.attemptId)) result.attemptId = value.attemptId;
  if (value.code === 'NATIVE_TEXT_REJECTED' && Array.isArray(value.rejectedTranslations)) {
    result.rejectedTranslations = value.rejectedTranslations.slice(0, 256).filter(item =>
      typeof item?.legacyId === 'string' && item.legacyId.length > 0 && item.legacyId.length <= 2048
      && typeof item.reason === 'string' && item.reason.length > 0)
      .map(item => ({ legacyId: item.legacyId, reason: item.reason.slice(0, 1024) }));
  }
  if (Array.isArray(value.artifacts)) result.artifacts = value.artifacts.slice(0, 32).map(item => ({
    artifactId: text(item?.artifactId, 100), kind: text(item?.kind, 64), relativePath: text(item?.relativePath, 1024), sha256: text(item?.sha256, 64),
  }));
  return result;
}

export const nativeWorkerError = (value = {}) => {
  value ??= {};
  return Object.assign(new Error(text(value.message) ?? 'Native tool failed'),
    { code: text(value.code, 100), ...nativeErrorDetails(value), ...(isNativeDependencyFailure(value) ? { hostFailure: true } : {}) });
};

export const isNativeDependencyFailure = error => error?.diagnostic?.category === 'dependency'
  || ['NATIVE_DEPENDENCY_MISSING', 'NATIVE_DEPENDENCY_INVALID'].includes(error?.code);

export async function validateNativeArtifact(artifact, file) {
  const owner = artifact.nativeOwner;
  if (!owner || !attemptPattern.test(artifact.id ?? '')) throw invalid('Native attempt ownership is missing');
  const project = await realpath(owner.projectDir), parent = await realpath(path.dirname(owner.workspaceDir));
  if (!inside(project, parent)) throw invalid('Native attempt parent is outside the project');
  const relative = `${path.basename(owner.workspaceDir)}-native-attempts/${artifact.id}`;
  const root = await checkedPath(parent, relative, { directory: true });
  if (await realpath(root) !== await realpath(artifact.path)) throw invalid('Native attempt root changed');
  const bytes = await readFile(await checkedPath(root, 'attempt.json'));
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.manifestSha256) throw invalid('Native attempt manifest changed');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.protocol !== 'pinhao-native-attempt-1' || manifest.attemptId !== artifact.id) throw invalid('Native attempt identity changed');
  if (file && file !== 'attempt.json') {
    const material = [...(manifest.logs ?? []), ...(manifest.resources ?? []).map(item => item.material).filter(Boolean)]
      .find(item => item.file === file);
    if (!material || !/^[a-f0-9]{64}$/.test(material.sha256 ?? '')) throw Object.assign(new Error('File is not registered in this native attempt'), { code: 'NATIVE_ARTIFACT_FILE_INVALID' });
    const content = await readFile(await checkedPath(root, file));
    if (content.length !== material.bytes || createHash('sha256').update(content).digest('hex') !== material.sha256) throw invalid('Native attempt material changed');
  }
  return root;
}

export async function registerNativeFailure({ error, workspaceDir, projectDir }) {
  const details = nativeErrorDetails(error);
  const failure = { code: text(error?.code, 100) ?? 'NATIVE_EXTRACTION_FAILED', message: text(error?.message) ?? 'Native tool failed',
    ...(details.diagnostic ? { diagnostic: details.diagnostic } : {}), ...(details.attemptId ? { attemptId: details.attemptId } : {}) };
  if (!details.artifacts?.length) return failure;
  const artifacts = [];
  for (const item of details.artifacts) {
    if (item.kind !== 'native-attempt' || item.artifactId !== details.attemptId || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')
        || item.relativePath !== `${path.basename(workspaceDir)}-native-attempts/${item.artifactId}`) throw invalid('Native attempt reference is invalid');
    const artifact = { id: item.artifactId, kind: item.kind, path: path.resolve(path.dirname(workspaceDir), item.relativePath),
      manifestSha256: item.sha256, nativeOwner: { workspaceDir: path.resolve(workspaceDir), projectDir: path.resolve(projectDir) } };
    await validateNativeArtifact(artifact);
    artifacts.push(artifact);
  }
  failure.repairBundle = { schema: 'pinhao-native-repair-1', phase: details.diagnostic?.phase ?? 'extract', artifacts };
  return failure;
}

export const nativeFailureArtifacts = failure => failure?.repairBundle?.artifacts ?? [];

export async function readNativeArtifact(artifact, { file, ...options }) {
  const root = await validateNativeArtifact(artifact, file);
  return readSlice(root, file, options);
}

export async function inspectNativeArtifact(artifact, { offset = 0, limit = 2000 } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new Error('Invalid native artifact page');
  const root = await validateNativeArtifact(artifact);
  const bytes = await readFile(await checkedPath(root, 'attempt.json')), manifest = JSON.parse(bytes.toString('utf8'));
  const materials = [...(manifest.logs ?? []), ...(manifest.resources ?? []).map(item => item.material).filter(Boolean)];
  const files = [{ path: 'attempt.json', size: bytes.length }, ...new Map(materials.map(item => [item.file, { path: item.file, size: item.bytes }])).values()]
    .sort((left, right) => left.path.localeCompare(right.path));
  return { files: files.slice(offset, offset + limit), total: files.length, offset,
    nextOffset: offset + limit < files.length ? offset + limit : null, truncated: offset + limit < files.length };
}
