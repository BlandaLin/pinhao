import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { checkedPath, describeReadSources, inspectReadSources, readSourceSlice } from './adaptation/paths.mjs';
import { isPrivateGamePath } from '../core/private-paths.mjs';
import { RESOURCE_ROUTES } from './resource-routing.mjs';
import { createDisplaySourceResolver } from './adaptation/source-origins.mjs';

export const COVERAGE_DECISION_VERSION = 'pinhao-coverage-decision-8';
export const DISPLAY_DISPOSITION_PROTOCOL = 'pinhao-display-disposition-1';
export const DISPLAY_REVIEW_PROOF_VERSION = 'pinhao-display-review-7';
export const EXPRESSION_DISPOSITIONS = ['bound-reference', 'non-linguistic'];
export const coverageDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const relative = value => typeof value === 'string' && !value.startsWith('/') && !value.includes('\\') && !value.includes(':') && !value.split('/').includes('..');
const normalize = value => String(value ?? '').replace(/^res:\/\//, '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\.$/, '');

// Legacy v8 receipts hash the original value, before location navigation was added.
// Reproduce that exact projection; do not rewrite the stored hash or invent an origin.
function matchesReceiptHash(actual, receipt) {
  if (coverageDigest(actual) === receipt.hash) return true;
  if (receipt.sourceRootKey || receipt.sourceRootKeys) return false;
  const legacy = { ...actual };
  for (const key of ['sourceRootKey', 'sourceRootKeys', 'resolvedLocation', 'readCall', 'nextCall']) delete legacy[key];
  if (actual.sourceCount === 1 && !receipt.sourceCount) { delete legacy.sourceIndex; delete legacy.sourceCount; }
  return coverageDigest(legacy) === receipt.hash;
}

export function displayCandidatePosition(item) {
  const pointer = item.locator?.pointer ?? (Array.isArray(item.path) ? '/' + item.path.map(part => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/') : undefined);
  if (typeof pointer === 'string') return ['json', pointer];
  if (item.target?.render === 'quoted') return ['quoted', item.target.start, item.target.end];
  if (Number.isSafeInteger(item.locator?.byteStart) && Number.isSafeInteger(item.locator?.byteEnd)) return ['utf8', item.locator.byteStart, item.locator.byteEnd];
  return item.target ?? item.locator ?? item.path;
}

export function displayCandidateIdentity(item) {
  const file = normalize(item.locator?.file ?? item.context?.adaptationLocator?.file ?? item.context?.file ?? item.file);
  return `display-${coverageDigest([file, item.sourceIndex ?? 0, displayCandidatePosition(item), item.source]).slice(0, 24)}`;
}

const validDisplayListing = input => input && typeof input === 'object' && !Array.isArray(input)
  && Object.keys(input).every(key => ['relativePath', 'sourceIndex', 'route', 'offset', 'limit', 'recursive', 'allowFile'].includes(key))
  && (input.relativePath === undefined || relative(input.relativePath))
  && (input.sourceIndex === undefined || Number.isSafeInteger(input.sourceIndex) && input.sourceIndex >= 0)
  && (input.route === undefined || RESOURCE_ROUTES.includes(input.route))
  && (input.offset === undefined || Number.isSafeInteger(input.offset) && input.offset >= 0)
  && (input.limit === undefined || Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 2000)
  && (input.recursive === undefined || typeof input.recursive === 'boolean') && (input.allowFile === undefined || typeof input.allowFile === 'boolean');
const validDisplayDependency = item => {
  if (!item || typeof item !== 'object') return false;
  if (item.kind === 'read') return relative(item.file) && item.file.length > 0 && hex(item.hash)
    && Number.isSafeInteger(item.sourceIndex) && item.sourceIndex >= 0
    && (item.originRef === undefined || item.originRef?.file === item.file && hex(item.originRef.originId) && hex(item.originRef.hash));
  if (item.kind === 'list' || item.kind === 'origin-list') return validDisplayListing(item.input) && hex(item.hash)
    && (item.stableOrigins === undefined || typeof item.stableOrigins === 'boolean');
  if (item.kind !== 'missing' || !['read', 'list'].includes(item.mode)) return false;
  if ((item.originHash !== undefined || item.originInput !== undefined) && (!hex(item.originHash) || !validDisplayListing(item.originInput))) return false;
  return item.mode === 'list' ? validDisplayListing(item.input) : relative(item.file) && item.file.length > 0
    && Array.isArray(item.sourceIndexes) && item.sourceIndexes.length > 0 && item.sourceIndexes.every(index => Number.isSafeInteger(index) && index >= 0);
};

function displayDispositionProof(decision) {
  const proof = decision.independentReview;
  return proof?.protocol === DISPLAY_DISPOSITION_PROTOCOL && proof.evidenceHash === decision.evidenceHash
    && proof.id === decision.id && proof.status === 'non-display' && typeof proof.reason === 'string' && proof.reason.trim()
    && proof.reviewProtocol === DISPLAY_REVIEW_PROOF_VERSION && Array.isArray(proof.dependencies) && proof.dependencies.length > 0
    && proof.dependencies.every(validDisplayDependency);
}

export function coverageContextIdentity(files, directories) {
  const entries = [...new Set(files.map(item => JSON.stringify(item)))].sort();
  return coverageDigest([COVERAGE_DECISION_VERSION, entries, [...new Set(directories)].sort()]);
}

export function coverageReadReceipt(input, output) {
  const file = normalize(input.file);
  return { kind: 'read', file, offset: input.offset ?? 0, length: output.returnedBytes, requestLength: input.length ?? 65536,
    encoding: input.encoding ?? 'utf8', hash: coverageDigest({ ...output, file }),
    ...(output.sourceCount ? { sourceCount: output.sourceCount, sourceIndex: output.sourceIndex } : {}),
    ...(output.sourceRootKey ? { sourceRootKey: output.sourceRootKey } : {}) };
}

export function coverageListingReceipt(input, output) {
  return { kind: 'listing', relativePath: normalize(input.relativePath),
    offset: input.offset ?? 0, limit: input.limit ?? 2000, hash: coverageDigest(output),
    ...(input.route === undefined ? {} : { route: input.route }),
    ...(input.recursive === undefined ? {} : { recursive: input.recursive }),
    ...(input.allowFile === undefined ? {} : { allowFile: input.allowFile }),
    ...(output.sourceCount ? { sourceCount: output.sourceCount, ...(input.sourceIndex === undefined ? {} : { sourceIndex: input.sourceIndex }) } : {}),
    ...(output.sourceRootKeys ? { sourceRootKeys: output.sourceRootKeys } : {}) };
}

export const coverageReceiptKey = receipt => JSON.stringify([receipt.kind, receipt.file ?? receipt.relativePath, receipt.offset, receipt.length, receipt.requestLength, receipt.limit, receipt.encoding, receipt.directory, receipt.sourceCount, receipt.sourceIndex, receipt.recursive, receipt.allowFile, receipt.route, receipt.sourceRootKey, receipt.sourceRootKeys]);

export function coverageSourceReadProof(decision, file, sourceIndex) {
  return Array.isArray(decision?.reads) && decision.reads.some(receipt => receipt.kind === 'read'
    && receipt.file === file && (sourceIndex === undefined || (receipt.sourceIndex ?? 0) === sourceIndex)
    && Number.isSafeInteger(receipt.length) && receipt.length > 0);
}

export function resourceReadProof(decision, resource) {
  const spans = (decision?.reads ?? []).filter(receipt => receipt.kind === 'read' && receipt.file === resource.file
    && (receipt.sourceIndex ?? 0) === resource.sourceIndex && receipt.length > 0)
    .map(receipt => [receipt.offset, receipt.offset + receipt.length]).sort((a, b) => a[0] - b[0]);
  if (decision?.disposition === 'display') return spans.length > 0;
  let end = 0;
  for (const span of spans) {
    if (span[0] > end) return false;
    end = Math.max(end, span[1]);
    if (end >= resource.bytes) return true;
  }
  return false;
}

export function hasCoverageDecisionProof(decision) {
  const expression = decision?.kind === 'display-expression';
  const resource = decision?.kind === 'resource-file';
  const candidate = decision?.kind === 'display-candidate';
  return decision?.version === COVERAGE_DECISION_VERSION && typeof decision.id === 'string'
    && hex(decision.evidenceHash) && hex(decision.sourceContextHash) && relative(decision.file)
    && (expression ? EXPRESSION_DISPOSITIONS : resource ? ['display', 'non-display', 'bound-reference'] : ['display', 'non-display']).includes(decision.disposition)
    && typeof decision.reason === 'string' && decision.reason.trim().length > 0
    && coverageSourceReadProof(decision, decision.file)
    && (!expression || decision.disposition !== 'non-linguistic' || displayDispositionProof(decision))
    && (!candidate || decision.disposition === 'non-display' && hex(decision.sourceHash)
      && Number.isSafeInteger(decision.sourceIndex) && decision.sourceIndex >= 0
      && coverageSourceReadProof(decision, decision.file, decision.sourceIndex) && displayDispositionProof(decision))
    && (!resource || hex(decision.sourceHash) && Number.isSafeInteger(decision.sourceIndex) && decision.sourceIndex >= 0
      && Number.isSafeInteger(decision.bytes) && decision.bytes > 0 && resourceReadProof(decision, decision))
    && (!resource || decision.disposition !== 'bound-reference' || hex(decision.bindingHash)
      && Number.isSafeInteger(decision.bindingCount) && decision.bindingCount > 0)
    && (resource || decision.disposition !== 'bound-reference' || Array.isArray(decision.unitIds) && decision.unitIds.length > 0
      && decision.unitIds.length <= 2000 && decision.unitIds.every(id => typeof id === 'string' && id.length > 0)
      && new Set(decision.unitIds).size === decision.unitIds.length)
    && Array.isArray(decision.reads) && decision.reads.every(receipt => {
      if (receipt.sourceRootKey !== undefined && !hex(receipt.sourceRootKey)) return false;
      if (receipt.sourceRootKeys !== undefined && (!Array.isArray(receipt.sourceRootKeys) || !receipt.sourceRootKeys.every(hex))) return false;
      if (receipt.sourceCount !== undefined && (!Number.isSafeInteger(receipt.sourceCount) || receipt.sourceCount < 1)) return false;
      if (receipt.sourceIndex !== undefined && (!Number.isSafeInteger(receipt.sourceIndex) || receipt.sourceIndex < 0 || !receipt.sourceCount || receipt.sourceIndex >= receipt.sourceCount)) return false;
      if (receipt.kind === 'missing') return relative(receipt.file);
      if (receipt.kind === 'read') return relative(receipt.file) && hex(receipt.hash)
        && Number.isSafeInteger(receipt.offset) && receipt.offset >= 0 && Number.isSafeInteger(receipt.length) && receipt.length >= 0
        && Number.isSafeInteger(receipt.requestLength) && receipt.requestLength >= receipt.length && receipt.requestLength <= 262144
        && ['utf8', 'base64'].includes(receipt.encoding);
      return receipt.kind === 'listing' && relative(receipt.relativePath) && hex(receipt.hash)
        && (receipt.route === undefined || RESOURCE_ROUTES.includes(receipt.route))
        && (receipt.recursive === undefined || typeof receipt.recursive === 'boolean')
        && (receipt.allowFile === undefined || typeof receipt.allowFile === 'boolean')
        && Number.isSafeInteger(receipt.offset) && receipt.offset >= 0 && Number.isSafeInteger(receipt.limit) && receipt.limit >= 1 && receipt.limit <= 2000;
    });
}

export function expressionReadProof(decision, candidate) {
  return Array.isArray(decision?.reads) && decision.reads.some(receipt => receipt.kind === 'read' && receipt.file === candidate.file
    && (receipt.sourceIndex ?? 0) === candidate.sourceIndex
    && receipt.offset <= candidate.byteStart && receipt.offset + receipt.length >= candidate.byteEnd);
}

/** Replay only actual source reads and listings; large game assets remain untouched. */
export async function coverageDecisionFresh(decision, { roots, projectId, sourceContextHash, signal, cache = new Map() }) {
  if (!hasCoverageDecisionProof(decision) || decision.sourceContextHash !== sourceContextHash) return false;
  const sourceResolver = async () => {
    if (!projectId) return null;
    const key = coverageDigest(['display-source-resolver', projectId, roots]);
    if (!cache.has(key)) cache.set(key, createDisplaySourceResolver({ projectId, roots }));
    return cache.get(key);
  };
  if (decision.independentReview && (!Array.isArray(decision.independentReview.dependencies) || !decision.independentReview.dependencies.every(validDisplayDependency))) return false;
  if (decision.independentReview) for (const dependency of decision.independentReview.dependencies) {
    signal?.throwIfAborted();
    const key = coverageDigest(['independent-display', projectId, roots, dependency]);
    if (!cache.has(key)) cache.set(key, (async () => {
      try {
        if (dependency.kind === 'read') {
          const bytes = await readFile(await checkedPath(roots[dependency.sourceIndex], dependency.file));
          if (dependency.hashAlgorithm !== undefined && dependency.hashAlgorithm !== 'sha256-bytes-1') return false;
          if ((dependency.hashAlgorithm === 'sha256-bytes-1' ? createHash('sha256').update(bytes).digest('hex') : coverageDigest(bytes.toString('base64'))) !== dependency.hash) return false;
          if (dependency.originRef) {
            const origin = await (await sourceResolver())?.resolve({ file: dependency.file, sourceIndex: dependency.sourceIndex });
            return origin?.originId === dependency.originRef.originId && origin.file === dependency.originRef.file && origin.hash === dependency.originRef.hash;
          }
          return true;
        }
        if (dependency.kind === 'origin-list') return await (await sourceResolver())?.listingHash(dependency.input) === dependency.hash;
        if (dependency.kind === 'missing') {
          if (dependency.mode === 'read') {
            for (const index of dependency.sourceIndexes) {
              if (!roots[index]) return false;
              try { await checkedPath(roots[index], dependency.file, { directory: true }); return false; }
              catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
          } else {
            try { await inspectReadSources(roots[0], { sourceRoots: roots.slice(1), excludePath: isPrivateGamePath, ...dependency.input }); return false; }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          return dependency.originHash === undefined || await (await sourceResolver())?.listingHash(dependency.originInput) === dependency.originHash;
        }
        const listing = await inspectReadSources(roots[0], { sourceRoots: roots.slice(1), excludePath: isPrivateGamePath, ...dependency.input });
        if (!dependency.stableOrigins) return matchesReceiptHash(listing, dependency);
        const resolver = await sourceResolver();
        return Boolean(resolver) && coverageDigest({ ...listing, sourceRootKeys: resolver.rootKeys }) === dependency.hash;
      } catch { return false; }
    })());
    if (!await cache.get(key)) return false;
  }
  for (const receipt of decision.reads) {
    signal?.throwIfAborted();
    const key = coverageDigest(receipt);
    if (!cache.has(key)) cache.set(key, (async () => {
      if (receipt.sourceCount) {
        try {
          if (receipt.sourceRootKey || receipt.sourceRootKeys) {
            const current = await describeReadSources(roots[0], roots.slice(1));
            if (receipt.sourceRootKey && current[receipt.sourceIndex]?.sourceRootKey !== receipt.sourceRootKey
              || receipt.sourceRootKeys && JSON.stringify(current.map(row => row.sourceRootKey)) !== JSON.stringify(receipt.sourceRootKeys)) return false;
          }
          if (receipt.kind === 'missing') {
            if (!Number.isSafeInteger(receipt.sourceIndex) || !roots[receipt.sourceIndex]) return false;
            try { await lstat(await checkedPath(roots[receipt.sourceIndex], receipt.file, { directory: Boolean(receipt.directory) })); return false; }
            catch (error) { return error.code === 'ENOENT'; }
          }
          const options = { ...receipt, sourceRoots: roots.slice(1) };
          const actual = receipt.kind === 'read'
            ? await readSourceSlice(roots[0], receipt.file, { ...options, length: receipt.requestLength })
            : await inspectReadSources(roots[0], { ...options, excludePath: isPrivateGamePath });
          return matchesReceiptHash(actual, receipt);
        } catch { return false; }
      }
      for (const root of roots) {
        try {
          if (receipt.kind === 'missing') {
            await lstat(await checkedPath(root, receipt.file, { directory: Boolean(receipt.directory) }));
            return false;
          }
          const actual = receipt.kind === 'read'
            ? await readSourceSlice(root, receipt.file, { ...receipt, length: receipt.requestLength })
            : await inspectReadSources(root, { ...receipt, excludePath: isPrivateGamePath });
          return matchesReceiptHash(actual, receipt);
        } catch (error) {
          if (error.code !== 'ENOENT') return false;
        }
      }
      return receipt.kind === 'missing';
    })());
    if (!await cache.get(key)) return false;
  }
  return true;
}
