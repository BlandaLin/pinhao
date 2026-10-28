import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { xp3TextProfile } from './xp3-format.mjs';

export const FORMAT_CAPABILITY_PROTOCOL = 'pinhao-format-capability-1';
export const FORMAT_PLAN_PROTOCOL = 'pinhao-format-plan-1';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' && !Buffer.isBuffer(value) ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])) : value;
export const formatDigest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex');
export const formatFailure = (code, message, details = {}) => Object.assign(new Error(message), { code, evidence: { format: 'pinhao-capability-gap-1', status: /UNSUPPORTED|MISSING|REQUIRED|REVOKED|STALE/.test(code) ? 'unsupported' : 'failed', ...details } });
const spans = new Set(['.txt','.csv','.tsv','.js','.mjs','.cjs','.gd','.py','.rpy','.rb','.tscn','.tres']);
const requiredClaims = Object.freeze(['structure', 'targets', 'preservation']);
const freeze = value => {
  if (!value || typeof value !== 'object') return value;
  for (const item of Object.values(value)) freeze(item);
  return Object.freeze(value);
};
const locatorType = locator => typeof locator?.pointer === 'string' ? 'json-pointer'
  : Number.isSafeInteger(locator?.byteStart) && Number.isSafeInteger(locator?.byteEnd) ? 'utf8-span'
  : Array.isArray(locator?.nativePath) ? 'native-path' : 'unknown';

export const FORMAT_KERNEL_FILES = ['literal-structure.mjs', 'adapter-lab.mjs', '../embedded-command-contract.mjs',
  '../embedded-consumer-chain.mjs', 'format-capabilities.mjs', 'format-verification.mjs', 'xp3-format.mjs'];

/** Bundlers embed the exact source identities before relocating the modules. */
export async function readFormatKernelIdentity() {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const content = {};
  for (const file of FORMAT_KERNEL_FILES) content[file] = formatDigest(await readFile(path.resolve(root, file)));
  return content;
}

/** Host profiles are software configuration, never candidate manifest capabilities. */
export async function createFormatCapabilities({ profiles = [] } = {}) {
  const content = typeof __PINHAO_FORMAT_KERNEL__ === 'undefined' ? await readFormatKernelIdentity() : __PINHAO_FORMAT_KERNEL__;
  if (FORMAT_KERNEL_FILES.some(file => !/^[a-f0-9]{64}$/.test(content?.[file] ?? ''))) throw new Error('Missing built-in format implementation identity');
  const hostKernelDigest=formatDigest(content);
  const builtins = [
    { capabilityId: 'builtin-json-pointer', profileFamily: 'json', locatorContracts: ['json-pointer'], claims: requiredClaims, integrationModes: ['independent', 'json-pointer'], limits: { byteExactRoundtrip: true }, contentRef: { implementationDigest: content['adapter-lab.mjs'] } },
    { capabilityId: 'builtin-utf8-span', profileFamily: 'utf8-text', locatorContracts: ['utf8-span'], claims: requiredClaims, integrationModes: ['independent', 'utf8-span'], limits: { extensions: [...spans], guarantees: 'plain span / supported literal grammar; not arbitrary CSV or engine semantics' }, contentRef: { implementationDigest: content['literal-structure.mjs'] } },
    { capabilityId: 'builtin-mv-command356', profileFamily: 'mv-command356', locatorContracts: ['json-pointer'], claims: requiredClaims, integrationModes: ['independent', 'json-pointer'], limits: { mapping: ['one-argument','joined-range-before-tail'], qualifiedActiveConsumersRequired: true }, contentRef: { implementationDigest: content['../embedded-command-contract.mjs'] } },
    xp3TextProfile({ implementationDigest: content['xp3-format.mjs'] }),
  ].map(item => freeze({ ...item, contentRef:{...item.contentRef,hostKernelDigest}, protocolVersion: FORMAT_CAPABILITY_PROTOCOL, qualificationRef: `host-builtin:${item.capabilityId}:${hostKernelDigest.slice(0,24)}` }));
  const extensions = profiles.map(profile => {
    if (!profile || typeof profile.match !== 'function' || typeof profile.verify !== 'function' || typeof profile.identity !== 'function'
        || !/^[a-z][a-z0-9-]+$/.test(profile.capabilityId ?? '') || !profile.qualificationRef || typeof profile.isQualified !== 'function'
        || !profile.contentRef || ['implementationDigest','configurationDigest','dependencyLockDigest'].some(key => !/^[a-f0-9]{64}$/.test(profile.contentRef[key] ?? ''))
        || requiredClaims.some(claim => !profile.claims?.includes(claim))) throw new Error('格式能力需要宿主实现、内容/配置/依赖摘要、独立资格和完整目标/保护检查');
    return freeze({ ...profile, protocolVersion: FORMAT_CAPABILITY_PROTOCOL, contentRef: { ...profile.contentRef,hostKernelDigest }, claims: [...profile.claims], integrationModes: [...profile.integrationModes ?? []] });
  });
  const entries = new Map([...builtins, ...extensions].map(profile => [profile.capabilityId, profile]));
  if (entries.size !== builtins.length + extensions.length) throw new Error('格式能力标识重复');
  const describe = () => [...entries.values()].map(profile => {
    const { match, verify, verifyFiles, identity, read, isQualified, ...descriptor } = profile;
    return freeze({ ...descriptor, capabilityRef: formatDigest(descriptor) });
  });
  const refs = new Map(describe().map(profile => [profile.capabilityId, profile]));
  const fresh = async ref => {
    const profile = entries.get(ref.capabilityId), descriptor = refs.get(ref.capabilityId);
    return !!descriptor && descriptor.capabilityRef === ref.capabilityRef && (!profile.isQualified || await profile.isQualified(profile.qualificationRef));
  };
  const plan = async ({ units, manifest, purpose = 'candidate-sample', integrationMode = 'independent' }) => {
    const selected = [], groups = [];
    for (const profile of [...builtins.filter(item => item.match), ...extensions]) {
      const matched = await profile.match({ units, manifest, integrationMode });
      if (!matched) continue;
      if (profile.isQualified && !await profile.isQualified(profile.qualificationRef)) throw formatFailure('FORMAT_QUALIFICATION_REVOKED', '该格式资格已撤销，保留候选并等待重新验证', { capabilityId: profile.capabilityId });
      if (!profile.integrationModes?.includes(integrationMode)) throw formatFailure('FORMAT_INTEGRATION_UNSUPPORTED', '该格式还没有当前产品组合的安全合并能力', { capabilityId: profile.capabilityId, integrationMode });
      const writeSet = [...new Set(matched.writeSet ?? [])].sort();
      if (!writeSet.length || writeSet.some(file => !manifest.scope.files.includes(file))) throw formatFailure('FORMAT_SCOPE_CONFLICT', '格式写入组超出当前配方授权范围');
      const ids = matched.unitIds ?? units.map(unit => unit.id);
      const boundUnits = units.filter(unit => ids.includes(unit.id));
      if (boundUnits.length !== ids.length) throw formatFailure('FORMAT_LOCATOR_UNSUPPORTED', '格式写入组包含未绑定文字');
      const bindings = boundUnits.map(unit => ({ id: unit.id, location: profile.identity(unit.locator), sourceHash: formatDigest(unit.rawSource ?? unit.source), protocol: 'pinhao-format-binding-1', family: profile.profileFamily ?? profile.capabilityId, capabilityRef: refs.get(profile.capabilityId).capabilityRef }));
      if (bindings.some(binding => typeof binding.location!=='string'||!binding.location)) throw formatFailure('FORMAT_LOCATOR_UNSUPPORTED', '格式缺少可信的稳定定位规则');
      selected.push(refs.get(profile.capabilityId));
      groups.push({ capabilityId: profile.capabilityId, writeSet, unitIds: ids, bindings, integrationMode: profile.integrationModes.includes('exclusive-resource-group') ? 'exclusive-resource-group' : integrationMode, groupId: formatDigest([profile.capabilityId,writeSet,bindings]) });
    }
    const grouped = new Set(groups.flatMap(group => group.unitIds));
    for (const unit of units.filter(item => !grouped.has(item.id))) {
      const type = locatorType(unit.locator), extension = path.extname(unit.locator?.file ?? '').toLowerCase();
      const id = type === 'json-pointer' ? unit.locator.segment ? 'builtin-mv-command356' : 'builtin-json-pointer'
        : type === 'utf8-span' && spans.has(extension) ? 'builtin-utf8-span' : null;
      if (!id) throw formatFailure(type === 'unknown' ? 'FORMAT_LOCATOR_UNSUPPORTED' : 'FORMAT_UNSUPPORTED', `缺少 ${unit.locator?.file ?? '该资源'} 的定位/结构验证能力；保留候选，可补充宿主格式能力后重验`, { unitId: unit.id, locatorType: type, nextActions: ['为此格式安装已资格化的 reader/locator/structure/integration profile', '保留原 candidateId 后重新运行 validate_adapter'] });
      selected.push(refs.get(id));
    }
    const groupFiles = groups.flatMap(group => group.writeSet);
    if (new Set(groupFiles).size !== groupFiles.length) throw formatFailure('FORMAT_SCOPE_CONFLICT', '不同格式写入组不能分别拥有同一物理文件');
    const body = { protocol: FORMAT_PLAN_PROTOCOL, purpose, capabilityRefs: [...new Map(selected.map(item => [item.capabilityId,item])).values()], writeGroups: groups, unitBindings: groups.flatMap(group => group.bindings), unitIds: units.map(unit => unit.id) };
    return { ...body, planTemplateRef: formatDigest(body) };
  };
  return Object.freeze({ describe, plan, fresh, get: id => entries.get(id), fingerprint: formatDigest(describe()) });
}
