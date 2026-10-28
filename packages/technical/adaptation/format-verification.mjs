import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { checkedPath } from './paths.mjs';
import { formatDigest, formatFailure } from './format-capabilities.mjs';

export async function verifyFormatGroups({ catalog, plan, candidate, gameDir, outputDir, units, translations, purpose, signal }) {
  const receipts = [];
  for (const ref of plan?.capabilityRefs ?? []) if (!await catalog.fresh(ref)) throw formatFailure('FORMAT_QUALIFICATION_REVOKED', '格式能力内容或资格已变化，请从原候选重新验证', { capabilityId: ref.capabilityId });
  for (const group of plan?.writeGroups ?? []) {
    signal?.throwIfAborted();
    const profile = catalog.get(group.capabilityId), before = {}, after = {}, beforePaths = {}, afterPaths = {};
    for (const file of group.writeSet) {
      beforePaths[file] = await checkedPath(gameDir,file);
      afterPaths[file] = await checkedPath(outputDir,file);
      if (!profile.verifyFiles) {
        before[file] = await readFile(beforePaths[file], { signal });
        after[file] = await readFile(afterPaths[file], { signal });
      }
    }
    const selected = units.filter(unit => group.unitIds.includes(unit.id));
    if (selected.length !== group.unitIds.length) throw formatFailure('FORMAT_SCOPE_CONFLICT', '不能过滤格式组部分文字后继续使用整组证明');
    for (const unit of selected) {
      const binding = group.bindings?.find(item => item.id === unit.id);
      if (!binding || binding.location !== profile.identity(unit.locator) || binding.sourceHash !== formatDigest(unit.rawSource ?? unit.source)) throw formatFailure('FORMAT_SOURCE_STALE', '格式验证计划与当前文字定位或原文不一致');
    }
    const targets = Object.fromEntries(selected.map(unit => [unit.id, translations[unit.id] ?? unit.rawSource]));
    let result;
    try { result = await (profile.verifyFiles ?? profile.verify)({ candidate, group, before, after, beforePaths, afterPaths, units: selected, translations: targets, purpose, signal }); }
    catch (error) { if (signal?.aborted) throw error; if (error.code?.startsWith('FORMAT_')) throw error; throw Object.assign(new Error(`格式检查器执行失败：${error.message}`), { code: 'FORMAT_ORACLE_EXECUTION_ERROR', cause: error }); }
    if (result?.status === 'unsupported') throw formatFailure('FORMAT_UNSUPPORTED', result.message ?? '当前格式变体未被该能力覆盖');
    if (result?.status !== 'passed' || ['structure','targets','preservation','derivedFields'].some(claim => result.claims?.[claim] !== 'passed')) throw formatFailure('FORMAT_PRESERVATION_FAILED', result?.message ?? '格式检查没有完成真实目标、非目标和派生字段验证');
    const fileHashes = async files => Object.fromEntries(await Promise.all(Object.entries(files).map(async ([file, target]) => {
      const digest = createHash('sha256'); for await (const bytes of createReadStream(target, { signal })) digest.update(bytes);
      return [file, digest.digest('hex')];
    })));
    const body = { purpose, candidateId: candidate.candidateId, codeHash: candidate.codeHash, planTemplateRef: plan.planTemplateRef, groupId: group.groupId, capabilityRef: plan.capabilityRefs.find(ref => ref.capabilityId === group.capabilityId), targetsDigest: formatDigest(targets), beforeHashes: profile.verifyFiles ? await fileHashes(beforePaths) : Object.fromEntries(Object.entries(before).map(([file,bytes]) => [file,formatDigest(bytes)])), outputHashes: profile.verifyFiles ? await fileHashes(afterPaths) : Object.fromEntries(Object.entries(after).map(([file,bytes]) => [file,formatDigest(bytes)])), claims: result.claims };
    receipts.push({ ...body, receiptHash: formatDigest(body) });
  }
  return receipts;
}
