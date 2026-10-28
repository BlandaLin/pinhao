import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, link, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
export const displayFactHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const relative = value => {
  const result = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!result || result.startsWith('/') || result.includes(':') || result.split('/').some(part => !part || part === '..')) throw new Error('Display fact requires a relative resource path');
  return result;
};
const problem = (code, message) => Object.assign(new Error(message), { code });
const queues = new Map();
const serialize = (directory, action) => {
  const absolute=path.resolve(directory),key=process.platform==='win32'?absolute.toLowerCase():absolute,pending = (queues.get(key) ?? Promise.resolve()).then(action), tail = pending.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return pending;
};

/** Only host-verified extracted positions qualify; author hints never establish a subject. */
export function normalizeDisplaySubject({ projectId, originId, relativeFile, baselineHash, locator, rawSource, sourceViewKey, containerRef, claimKind = 'display-text' }) {
  if (!projectId || !originId || !baselineHash || typeof rawSource !== 'string' || !locator) throw new Error('Incomplete display subject');
  const position = Object.fromEntries(['pointer', 'byteStart', 'byteEnd', 'segment', 'nativePath', 'profile', 'recordId', 'field'].filter(key => locator[key] !== undefined).map(key => [key, locator[key]]));
  if (!Object.keys(position).length) throw new Error('Display subject needs a verified locator');
  const subject = canonical({ schemaVersion: 1, projectId, originId, relativeFile: relative(relativeFile), baselineHash,
    locator: position, rawSourceHash: displayFactHash(rawSource), sourceViewKey, containerRef, claimKind });
  return { subject, subjectKey: displayFactHash(subject) };
}

export function displayReviewContext(value) {
  return displayFactHash({ protocol: value.protocol, policy: value.policy, instructionsHash: value.instructionsHash,
    tools: value.tools, resolver: value.resolver, engine: value.engine, reviewer: value.reviewer });
}

export async function normalizeConsumerHints(hints = [], { resolveReceipt, resolveResource } = {}) {
  if (!Array.isArray(hints) || hints.length > 64) throw new Error('consumerHints must contain at most 64 navigation hints');
  const result = [];
  for (const hint of hints) {
    if (!hint || typeof hint !== 'object' || Array.isArray(hint)) throw new Error('Invalid consumer navigation hint');
    const relation = hint.relation ?? 'renders';
    if (!['loads', 'selects', 'renders', 'investigated'].includes(relation)) throw new Error('Invalid consumer relation');
    const receipt = hint.receiptRef && resolveReceipt ? await resolveReceipt(hint.receiptRef) : undefined;
    const resource = receipt?.resourceRef ?? hint.resourceRef;
    if (resource) relative(resource.relativeFile ?? resource.path ?? resource.file);
    const byteRange = receipt?.verified === true && receipt.resourceRef && Array.isArray(receipt.byteRange)
      && receipt.byteRange.length === 2 && receipt.byteRange.every(Number.isSafeInteger)
      && receipt.byteRange[0] >= 0 && receipt.byteRange[1] >= receipt.byteRange[0] ? receipt.byteRange : undefined;
    const slice = hint.slice ?? (byteRange ? { byteStart: byteRange[0], byteEnd: byteRange[1] } : undefined);
    if (slice && (!Number.isSafeInteger(slice.byteStart) || !Number.isSafeInteger(slice.byteEnd) || slice.byteStart < 0 || slice.byteEnd < slice.byteStart)) throw new Error('Invalid consumer hint byte range');
    if (hint.slice && byteRange && (slice.byteStart < byteRange[0] || slice.byteEnd > byteRange[1])) throw new Error('Consumer hint exceeds actual receipt byte range');
    const resolved = resource && resolveResource ? await resolveResource(resource) : undefined;
    const verified = Boolean(receipt?.verified === true && receipt.resourceRef && (!slice || byteRange && slice.byteStart >= byteRange[0] && slice.byteEnd <= byteRange[1]));
    result.push(canonical({ relation, ...(resource ? { resourceRef: resolved ?? resource } : {}), ...(slice ? { slice } : {}),
      ...(hint.receiptRef ? { receiptRef: hint.receiptRef } : {}), ...(hint.note ? { note: String(hint.note).slice(0, 800) } : {}),
      qualification: verified ? 'host-verified-navigation' : 'unverified-navigation' }));
  }
  return [...new Map(result.map(item => [displayFactHash(item), item])).values()];
}

async function immutable(directory, value, prefix) {
  await mkdir(directory, { recursive: true });
  const id = `${prefix}-${displayFactHash(value)}`, target = path.join(directory, `${id}.json`), temporary = path.join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx');
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  try { await link(temporary, target); }
  catch (error) { if (error.code !== 'EEXIST') throw error; if (displayFactHash(JSON.parse(await readFile(target, 'utf8'))) !== displayFactHash(value)) throw problem('DISPLAY_FACT_CONFLICT', 'Immutable display proof changed'); }
  finally { await unlink(temporary); }
  return id;
}

/** The immutable proof/event namespace is the source of truth; no mutable eligibility index. */
export function createDisplayFactStore({ directory, projectId }) {
  if (!directory || !projectId) throw new Error('Display fact store needs a project and directory');
  const proofsDir = path.join(directory, 'proofs'), eventsDir = path.join(directory, 'events'), reviewsDir = path.join(directory, 'reviews');
  const records = async (where, prefix) => {
    let names; try { names = await readdir(where); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(names.filter(name => name.startsWith(prefix) && /^\w+-[a-f0-9]{64}\.json$/.test(name)).sort().map(async name => {
      const value = JSON.parse(await readFile(path.join(where, name), 'utf8'));
      const id = name.slice(0, -5);
      if (id !== `${prefix}${displayFactHash(value)}` || value.projectId !== projectId || value.schemaVersion !== 1) throw problem('DISPLAY_FACT_CORRUPT', 'Display proof identity mismatch');
      return { ...value, id };
    }));
  };
  const hydrate = async (proof, cache = new Map()) => {
    const ref = proof.reviewRecordRef;
    if (!/^review-[a-f0-9]{64}$/.test(ref ?? '')) throw problem('DISPLAY_FACT_CORRUPT', 'Display proof lacks its full review reference');
    if (!cache.has(ref)) cache.set(ref, (async () => {
      const body = JSON.parse(await readFile(path.join(reviewsDir, `${ref}.json`), 'utf8'));
      if (body.projectId !== projectId || ref !== `review-${displayFactHash(body)}`) throw problem('DISPLAY_FACT_CORRUPT', 'Display review reference changed');
      return body.record;
    })());
    const reviewRecord = await cache.get(ref), dependencies = reviewRecord.dependencies ?? [];
    if (displayFactHash(dependencies) !== proof.dependencyClosureHash) throw problem('DISPLAY_FACT_CORRUPT', 'Display dependency closure changed');
    return { ...proof, reviewRecord, dependencies };
  };
  const loadProof = async proofId => {
    if (!/^proof-[a-f0-9]{64}$/.test(proofId)) throw new Error('Invalid display proof identity');
    const value = JSON.parse(await readFile(path.join(proofsDir, `${proofId}.json`), 'utf8'));
    if (value.projectId !== projectId || value.schemaVersion !== 1 || proofId !== `proof-${displayFactHash(value)}`) throw problem('DISPLAY_FACT_CORRUPT', 'Display proof identity mismatch');
    return hydrate({ ...value, id: proofId });
  };
  const lookupMany = async ({ subjectKeys, contextFingerprint, fresh }) => {
    if (typeof fresh !== 'function') throw new Error('Display facts require a host freshness check');
    const selected = new Set(subjectKeys), bySubject = new Map(subjectKeys.map(key => [key, []]));
    const [proofs, events] = await Promise.all([records(proofsDir, 'proof-'), records(eventsDir, 'event-')]);
    const revoked = new Set(events.filter(event => ['challenge', 'revoke'].includes(event.kind)).map(event => event.proofId));
    const reviews = new Map(), checks = new Map();
    for (const raw of proofs) {
      if (revoked.has(raw.id) || !selected.has(raw.subjectKey) || raw.contextFingerprint !== contextFingerprint) continue;
      const proof = await hydrate(raw, reviews);
      if (!checks.has(proof.reviewRecordRef)) checks.set(proof.reviewRecordRef, Promise.resolve(fresh(proof)));
      if (await checks.get(proof.reviewRecordRef)) bySubject.get(proof.subjectKey).push(proof);
    }
    return new Map([...bySubject].map(([key, found]) => [key, new Set(found.map(value => value.verdict)).size > 1
      ? { status: 'needsReconsideration', proofIds: found.map(value => value.id) }
      : found.length ? { status: 'hit', fact: found[0], proofIds: found.map(value => value.id) } : { status: 'miss', proofIds: [] }]));
  };
  return {
    directory, projectId, loadProof,
    async persistFact(input) {
      return serialize(directory, async () => {
      const { subject, subjectKey } = input;
      if (subject?.projectId !== projectId || subjectKey !== displayFactHash(subject) || !['display-supported', 'non-display'].includes(input.verdict)
          || !input.contextFingerprint || !Array.isArray(input.dependencies) || !input.sourceReceiptIds?.length || !input.consumerReceiptIds?.length || !input.reviewRecord) throw new Error('Display fact requires independent source, consumer and full review dependencies');
      if (displayFactHash(input.dependencies) !== displayFactHash(input.reviewRecord.dependencies ?? [])) throw new Error('Display fact must retain the complete review dependency closure');
      const { reviewRecord, dependencies, ...metadata } = input;
      const reviewRecordRef = await immutable(reviewsDir, { schemaVersion: 1, projectId, record: reviewRecord }, 'review');
      const value = canonical({ schemaVersion: 1, projectId, createdAt: new Date().toISOString(), ...metadata, reviewRecordRef, dependencyClosureHash: displayFactHash(dependencies) });
      const proofId = await immutable(proofsDir, value, 'proof');
      return { ...value, id: proofId, reviewRecord, dependencies };
      });
    },
    lookupMany,
    async lookupFacts({ subjectKey, contextFingerprint, fresh }) {
      return (await lookupMany({ subjectKeys: [subjectKey], contextFingerprint, fresh })).get(subjectKey);
    },
    async verifyFactFresh(proofId, fresh) {
      const proof = await loadProof(proofId);
      return this.verifyFactsFresh([proofId], fresh, [proof]);
    },
    async verifyFactsFresh(proofIds, fresh, supplied) {
      const proofs = supplied ?? await Promise.all(proofIds.map(loadProof)), contexts = new Map();
      for (const proof of proofs) {
        if (!contexts.has(proof.contextFingerprint)) contexts.set(proof.contextFingerprint, []);
        contexts.get(proof.contextFingerprint).push(proof);
      }
      for (const [contextFingerprint, group] of contexts) {
        const found = await lookupMany({ subjectKeys: group.map(proof => proof.subjectKey), contextFingerprint, fresh });
        for (const proof of group) {
          const result = found.get(proof.subjectKey);
          if (result.status !== 'hit' || !result.proofIds.includes(proof.id)) return false;
        }
      }
      return true;
    },
    async challengeFact({ proofId, evidenceRefs, reasonCode, verifyEvidence, kind = 'challenge' }) {
      return serialize(directory, async () => {
      const proof = await loadProof(proofId);
      if (!['challenge', 'revoke'].includes(kind) || !evidenceRefs?.length || typeof verifyEvidence !== 'function'
          || !await verifyEvidence({ proof, evidenceRefs })) throw new Error('Display challenge needs verified related evidence');
      const value = canonical({ schemaVersion: 1, projectId, proofId, kind, evidenceRefs, reasonCode });
      const id = await immutable(eventsDir, value, 'event');
      return { ...value, id };
      });
    },
    withFence({ proofIds = [], fresh, check = async () => true, commit }) {
      return serialize(directory, async () => {
        if (proofIds.length && !await this.verifyFactsFresh(proofIds, fresh) || !await check()) throw problem('DISPLAY_FACT_STALE', 'Display proof eligibility changed before publication');
        const result = commit();
        if (result?.then) throw new Error('Display publication commit must be synchronous');
        return result;
      });
    },
    withReadFence({check,action}){
      return serialize(directory,async()=>{
        if(!await check())throw problem('DISPLAY_FACT_STALE','Display proof eligibility changed before publication');
        return action();
      });
    },
    async challengeSubject({ subjectKey, evidenceRefs, reasonCode = 'new-consumer-evidence', verifyEvidence }) {
      if (!subjectKey || !evidenceRefs?.length || typeof verifyEvidence !== 'function') return [];
      const events = [];
      for (const raw of (await records(proofsDir, 'proof-')).filter(value => value.subjectKey === subjectKey)) {
        const proof = await hydrate(raw);
        const novel = evidenceRefs.filter(ref => !proof.dependencies.some(dependency => dependency.kind === 'read'
          && dependency.originId === ref.resourceRef?.originId && dependency.file === ref.resourceRef?.path && dependency.hash === ref.resourceRef?.baselineHash));
        if (!novel.length || !await verifyEvidence({ proof, evidenceRefs: novel })) continue;
        events.push(await this.challengeFact({ proofId: proof.id, evidenceRefs: novel, reasonCode, verifyEvidence }));
      }
      return events;
    },
  };
}
