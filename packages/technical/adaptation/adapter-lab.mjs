import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { StringDecoder } from 'node:string_decoder';
import { createReadStream, lstatSync } from 'node:fs';
import { mkdir, readFile, readdir, lstat, copyFile, open } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { runSandbox, DEFAULT_LIMITS } from './sandbox.mjs';
import { checkedPath, ensureRoot, independentRoot, inspectReadSources, listFiles, readJson, readSourceSlice, relativeFile } from './paths.mjs';
import { validateTranslation } from '../../exchange/index.mjs';
import { verifyTextStructure } from './literal-structure.mjs';
import { parse } from 'acorn';
import { isPrivateGamePath } from '../../core/private-paths.mjs';
import { DISPLAY_DISPOSITION_PROTOCOL, hasCoverageDecisionProof } from '../coverage-decisions.mjs';
import { createWorkspaceExecution } from './workspace-execution.mjs';
import { assertJsonFieldWritable, JSON_FIELD_POLICY_VERSION } from '../json-field-policy.mjs';
import { embeddedText, replaceEmbeddedText } from '../embedded-text.mjs';
import { EMBEDDED_CONTRACT_PROTOCOL, qualifyEmbeddedContracts, assertEmbeddedContractsFresh, encodeEmbeddedTarget } from '../embedded-command-contract.mjs';
import { createFormatCapabilities, formatFailure } from './format-capabilities.mjs';
import { verifyFormatGroups } from './format-verification.mjs';
import { assertScriptFieldsWritable, SCRIPT_FIELD_POLICY_VERSION } from '../script-field-policy.mjs';
import { launchManagedProcess, processEnvironment } from '../../core/managed-process.mjs';
import { PYTHON_ADAPTER_DRIVER, PYTHON_ADAPTER_PROTOCOL } from './python-adapter-driver.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const timestamp = () => new Date().toISOString();
const guestContracts = contracts => Object.fromEntries(Object.entries(contracts ?? {}).map(([id, contract]) => [id, { format: contract.format, target: contract.target, contractHash: contract.contractHash }]));
const actions = ['detect', 'extract', 'validate', 'roundtrip', 'build', 'assemble'];
const control = /\\(?:[A-Za-z]+(?:\[(?:[^\[\]\r\n]|\[[^\]\r\n]*\])*\]|<[^>\r\n]*>)?|[^\r\n])|%[-+0-9.]*[dsf]|%[1-9]\d*|\r\n|\n|\r/g;
function controlPattern(file, locator) {
  if (['kag-text', 'container-member-text'].includes(locator?.format)) return new RegExp(String.raw`\[(?:[^\[\]\r\n"']|"[^"\r\n]*"|'[^'\r\n]*'|\[[^\]\r\n]*\])*\]|${control.source}`, 'g');
  if (!Number.isSafeInteger(locator?.byteStart)) return control;
  const extension = path.extname(file).toLowerCase();
  if (extension === '.rb') return new RegExp(String.raw`#\{(?:[^{}\\]|\\.)*\}|#(?:@@?|\$)(?:[\p{L}_][\p{L}\p{N}_]*|[0-9]+|-[A-Za-z]|.)|${control.source}`, 'gu');
  const escapes = extension === '.gd' ? String.raw`\\(?:u[\da-fA-F]{4}|U[\da-fA-F]{6})`
    : ['.py', '.rpy'].includes(extension) ? String.raw`\\(?:u[\da-fA-F]{4}|U[\da-fA-F]{8}|x[\da-fA-F]{2}|[0-7]{1,3})` : '';
  return escapes ? new RegExp(`${escapes}|${control.source}`, 'g') : control;
}
const bindingName = 'pinhao-adapter-binding.json';
// Per-resource size gate. Engines that already ship as an unpacked tree put whole scenario
// databases or asset tables in one file; 256 MiB covers those while keeping one read bounded
// (a 256 MiB file becomes ~341M base64 characters inside the worker). Packed archives
// (zip/xp3/rgssad/pck) are handled by the archive resolver, not by this gate.
const RESOURCE_SIZE_LIMIT = 256 * 1024 * 1024;
const recordWrites = new Map();
const qualificationCommits = new Map();
async function qualificationCommit(root, operation) {
  const key=process.platform==='win32'?root.toLowerCase():root, previous=qualificationCommits.get(key)??Promise.resolve();
  const pending=previous.catch(()=>{}).then(operation);qualificationCommits.set(key,pending);
  try{return await pending;}finally{if(qualificationCommits.get(key)===pending)qualificationCommits.delete(key);}
}
const VALIDATION_PROTOCOL = 'pinhao-validation-4';

async function verifyDisplay(verifier, input, identity = {}) {
  try { return await verifier(input); }
  catch (error) {
    if (error.hostFailure) throw error;
    const cancelled = input.signal?.aborted || error.name === 'AbortError' || error.code === 'CANCELLED';
    const statusCode = error.statusCode ?? error.status ?? (Number.isInteger(error.code) && error.code >= 100 && error.code <= 599 ? error.code : undefined);
    const cause = { name: error.name, message: error.message,
      ...(['string', 'number'].includes(typeof error.code) ? { code: error.code } : {}),
      ...(Number.isInteger(statusCode) ? { statusCode } : {}),
      ...(typeof error.category === 'string' ? { category: error.category } : {}),
      ...(Number.isFinite(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}) };
    const details = { kind: cancelled ? 'cancelled' : 'reviewer-unavailable', ...identity,
      cause, ...(['string', 'number'].includes(typeof error.code) ? { causeCode: error.code } : {}),
      ...(Number.isInteger(statusCode) ? { statusCode } : {}),
      category: cancelled ? 'cancelled' : 'reviewer_unavailable',
      ...(typeof error.category === 'string' ? { causeCategory: error.category } : {}),
      ...(Number.isFinite(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
      retryable: !cancelled && ![401, 403].includes(statusCode) };
    throw Object.assign(new Error(cancelled ? '显示用途复核已取消，候选已保留' : '显示用途复核服务尚未完成；候选未被否定，接口恢复后可继续复核', { cause: error }),
      { code: cancelled ? 'ADAPTER_CANCELLED' : 'DISPLAY_REVIEW_UNAVAILABLE', ...details, evidence: details });
  }
}

function classifyValidationOutputRoot(error, outputRoot) {
  if (!outputRoot || error.code !== 'ENOENT' || typeof error.path !== 'string') return error;
  const identity = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (identity(error.path) !== identity(outputRoot)) return error;
  let confirmation;
  try {
    const info = lstatSync(outputRoot);
    confirmation = { kind: info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory-present' : 'not-directory' };
  } catch (cause) { confirmation = { code: cause.code, message: cause.message }; }
  return Object.assign(new Error('技术验证的临时工作目录无法读取，候选和验证记录已保存；请检查工作位置后继续。', { cause: error }), {
    code: 'HOST_VALIDATION_OUTPUT_UNAVAILABLE', hostFailure: true,
    evidence: { phase: 'candidate-sample-output-check', outputRoot, originalCode: error.code, confirmation },
  });
}

async function appendRecord(file, value) {
  const previous = recordWrites.get(file) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const handle = await open(file, 'a');
    try { await handle.writeFile(`\n${JSON.stringify(value)}\n`); await handle.sync(); }
    finally { await handle.close(); }
  });
  recordWrites.set(file, operation);
  try { await operation; }
  finally { if (recordWrites.get(file) === operation) recordWrites.delete(file); }
}

function manifestRecord(value) {
  if (!value || ![1,2].includes(value.schemaVersion) || !/^[a-z][a-z0-9-]{1,79}$/.test(value.id) || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version ?? '') || typeof value.engine !== 'string' || !value.engine.trim() || typeof value.license !== 'string' || !value.license.trim()) throw new Error('适配清单需要版本、引擎和来源许可证');
  if (!Array.isArray(value.scope?.files) || !value.scope.files.length || value.scope.files.length > 20000) throw new Error('适配清单需要明确的资源文件范围');
  const files = [...new Set(value.scope.files.map(file => relativeFile(file)))].sort();
  if (files.some(file => isPrivateGamePath(file))) throw new Error('适配范围不能包含存档或私人配置');
  if (files.length !== value.scope.files.length || new Set(files.map(file => file.toLowerCase())).size !== files.length) throw new Error('适配范围存在重复文件');
  const sources = value.sources ?? [];
  if (!Array.isArray(sources) || sources.length > 40 || sources.some(source => typeof source.license !== 'string' || !source.license || !/^https:\/\//.test(source.url ?? ''))) throw new Error('参考资料需要公开 HTTPS 来源和许可证');
  const launchFile = value.launchFile === undefined ? undefined : relativeFile(value.launchFile);
  const container = value.container ? { file: relativeFile(value.container.file), format: value.container.format } : undefined;
  if (container && !['zip', 'xp3', 'rgss', 'rgssad', 'pck'].includes(container.format)) throw new Error('归档配方请选择已登记的成熟封包格式');
  const execution = value.execution;
  if (value.verification !== undefined && (value.schemaVersion !== 2 || !value.verification || typeof value.verification !== 'object' || Array.isArray(value.verification) || JSON.stringify(value.verification).length > 24000)) throw new Error('格式验证提案需要schemaVersion 2及有限声明；提案不会授予宿主资格');
  if (execution && (execution.runtime !== 'python' || !Array.isArray(execution.wheels ?? []) || (execution.wheels ?? []).length > 80)) throw new Error('脚本配方请选择受管 Python 和锁定的 wheel 依赖');
  if (execution && execution.protocol !== PYTHON_ADAPTER_PROTOCOL) throw Object.assign(new Error(`Python 配方需要 ${PYTHON_ADAPTER_PROTOCOL} 六函数模块；不执行旧 CLI 配方`), { code: 'PYTHON_ADAPTER_PROTOCOL' });
  return { schemaVersion: value.schemaVersion, id: value.id, version: value.version, engine: value.engine.slice(0, 120), license: value.license.slice(0, 120), scope: { files, ...(typeof value.scope.description === 'string' ? { description: value.scope.description.slice(0, 2000) } : {}) }, ...(execution ? { execution: { runtime: 'python', protocol: PYTHON_ADAPTER_PROTOCOL, wheels: execution.wheels ?? [], readFiles: [...new Set((execution.readFiles ?? []).map(file => relativeFile(file)))].sort() } } : {}), ...(value.schemaVersion === 2 && value.verification ? { verification: JSON.parse(JSON.stringify(value.verification)) } : {}), ...(container ? { container } : {}), ...(launchFile ? { launchFile } : {}), sources: sources.map(({ url, license }) => ({ url, license })) };
}

function protectUnits(result, scope) {
  if (!Array.isArray(result?.units) || !result.units.length || result.units.length > 200000) throw new Error('适配器需要提取可定位的完整文字单元');
  const seen = new Set(), locators = new Set();
  return result.units.map(raw => {
    if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 300 || seen.has(raw.id) || typeof raw.source !== 'string' || raw.source.length > 200000) throw new Error('文字 ID、源文或重复定位无效');
    if (/^(?:script|image):/.test(raw.id)) throw new Error(`请为适配文字选择独立 ID 前缀；script: 与 image: 已由脚本、图像协议使用：${raw.id}`);
    seen.add(raw.id);
    const file = raw.locator?.file ?? raw.context?.file ?? raw.file;
    if (!scope.includes(file) || !raw.locator || Object.keys(raw.locator).length < 2) throw new Error(`文字缺少可回写定位：${raw.id}`);
    const locatorKey = JSON.stringify(raw.locator);
    if (locators.has(locatorKey)) throw new Error(`文字存在重复回写定位：${raw.id}`);
    locators.add(locatorKey);
    const controls = {}, tokens = [];
    const source = raw.source.replace(controlPattern(file, raw.locator), text => {
      const key = `{{CTRL${String(tokens.length + 1).padStart(4, '0')}}}`;
      controls[key] = text; tokens.push(key); return key;
    });
    if (/\{\{|\}\}/.test(source.replace(/\{\{CTRL\d{4}\}\}/g, ''))) throw new Error(`源文保护标记存在歧义：${raw.id}`);
    return { id: raw.id, legacyId: raw.id, source, rawSource: raw.source, kind: typeof raw.kind === 'string' ? raw.kind : 'text', tokens, controls, context: { ...raw.context, file, protectedControlSyntax: 'rpgmaker-v1', adaptationLocator: raw.locator }, locator: raw.locator };
  });
}

function jsonTarget(root, pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || /~(?![01])/.test(pointer)) throw new Error('JSON 文字定位须为明确的字段指针');
  const parts = pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, part)) throw new Error('JSON 文字指针超出原版结构');
    parent = parent[part];
  }
  const key = parts.at(-1);
  if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('JSON 文字字段已经变化');
  return { parent, key };
}

async function verifyResourceStructure({ candidate, gameDir, outputDir, units, translations, structuralVerifier, representationContracts = {}, formatCatalog, verificationPlan, purpose = 'build', signal }) {
  const groupReceipts = await verifyFormatGroups({ catalog: formatCatalog, plan: verificationPlan, candidate, gameDir, outputDir, units, translations, purpose, signal });
  const groupFiles = new Set(groupReceipts.flatMap(receipt => Object.keys(receipt.outputHashes)));
  const byFile = new Map();
  for (const unit of units) {
    const located = byFile.get(unit.locator.file) ?? [];
    located.push(unit); byFile.set(unit.locator.file, located);
  }
  for (const file of candidate.manifest.scope.files) {
    signal?.throwIfAborted();
    if (groupFiles.has(file)) continue;
    const before = await readFile(await checkedPath(gameDir, file));
    const after = await readFile(await checkedPath(outputDir, file));
    const located = byFile.get(file) ?? [];
    if (!located.length) {
      if (!before.equals(after)) throw new Error(`非文字资源发生变化：${file}`);
      continue;
    }
    if (located.every(unit => typeof unit.locator.pointer === 'string')) {
      let original, actual;
      try { original = JSON.parse(before.toString('utf8').replace(/^\uFEFF/, '')); actual = JSON.parse(after.toString('utf8').replace(/^\uFEFF/, '')); }
      catch { throw new Error(`JSON 定位的资源需要可解析的 UTF-8 结构：${file}`); }
      for (const unit of located) {
        const { parent, key } = jsonTarget(original, unit.locator.pointer);
        if (unit.locator.segment) {
          replaceEmbeddedText({ file, document: original, locator: unit.locator, source: unit.rawSource,
            translation: Object.hasOwn(translations, unit.id) ? translations[unit.id] : unit.rawSource, contract: representationContracts[unit.id] });
        } else {
          assertJsonFieldWritable({ file, document: original, pointer: unit.locator.pointer });
          if (parent[key] !== unit.rawSource) throw new Error(`JSON 定位的原文不一致：${unit.id}`);
          if (Object.hasOwn(translations, unit.id)) Object.defineProperty(parent, key, { value: translations[unit.id], writable: true, configurable: true, enumerable: true });
        }
        const target = jsonTarget(actual, unit.locator.pointer);
        if (target.parent[target.key] !== parent[key]) throw Object.assign(new Error(`改文回读不一致：${unit.id} (${file}${unit.locator.pointer})`), { code: 'ADAPTER_TEXT_READBACK', evidence: { file, unitId: unit.id, locator: unit.locator, expected: parent[key], actual: target.parent[target.key] } });
      }
      if (!isDeepStrictEqual(original, actual)) throw new Error(`回写改变了文字定位之外的逻辑或资源引用：${file}`);
    } else if (located.every(unit => Number.isSafeInteger(unit.locator.byteStart) && Number.isSafeInteger(unit.locator.byteEnd))) {
      assertScriptFieldsWritable({ file, before, units: located });
      const spans = [...located].sort((left, right) => left.locator.byteStart - right.locator.byteStart);
      const chunks = []; let cursor = 0;
      for (const unit of spans) {
        const { byteStart, byteEnd } = unit.locator;
        if (byteStart < cursor || byteEnd < byteStart || byteEnd > before.length || !before.subarray(byteStart, byteEnd).equals(Buffer.from(unit.rawSource, 'utf8'))) throw new Error(`文字字节定位重叠或原文不一致：${unit.id}`);
        chunks.push(before.subarray(cursor, byteStart), Buffer.from(Object.hasOwn(translations, unit.id) ? translations[unit.id] : unit.rawSource, 'utf8'));
        cursor = byteEnd;
      }
      chunks.push(before.subarray(cursor));
      if (!Buffer.concat(chunks).equals(after)) throw new Error(`回写改变了文字定位之外的字节：${file}`);
      const result = structuralVerifier
        ? await structuralVerifier({ candidate: { candidateId: candidate.candidateId, manifest: candidate.manifest }, file, before, after, units: located, translations, signal })
        : verifyTextStructure({ file, before, after, units: located, translations });
      if (result?.valid !== true) throw new Error(result?.message || `可信格式结构校验未通过：${file}`);
    } else {
      if (!structuralVerifier) throw formatFailure('FORMAT_LOCATOR_UNSUPPORTED', `资源定位需要可信格式校验器：${file}；可保留候选并补充格式能力后重验`);
      const result = await structuralVerifier({ candidate: { candidateId: candidate.candidateId, manifest: candidate.manifest }, file, before, after, units: located, translations, signal });
      if (result?.valid !== true) throw new Error(result?.message || `可信格式结构校验未通过：${file}`);
    }
  }
  return groupReceipts;
}

function rawTranslations(units, input = {}) {
  const records = Array.isArray(input) ? input : Object.entries(input).map(([id, translation]) => ({ id, translation }));
  const index = new Map(units.map(unit => [unit.id, unit]));
  const seen = new Set(), result = {};
  for (const record of records) {
    const unit = index.get(record.id);
    if (!unit || seen.has(record.id)) throw new Error('译文包含未知或重复 ID');
    seen.add(record.id); validateTranslation(unit, record.translation);
    result[unit.id] = record.translation.replace(/\{\{CTRL\d{4}\}\}/g, token => unit.controls[token]);
  }
  return result;
}

function reusableCoverageDecision(decision) {
  const pick = (value, fields) => Object.fromEntries(fields.filter(field => value[field] !== undefined).map(field => [field, value[field]]));
  return {
    ...pick(decision, ['version', 'id', 'evidenceHash', 'sourceContextHash', 'file', 'field', 'kind', 'sourceHash', 'sourceIndex', 'bytes', 'bindingHash', 'bindingCount', 'unitIds', 'disposition', 'reason', 'independentReview', 'decidedAt', 'decidedBy']),
    reads: decision.reads.map(receipt => pick(receipt, ['kind', 'file', 'relativePath', 'offset', 'length', 'requestLength', 'limit', 'encoding', 'directory', 'hash', 'sourceCount', 'sourceIndex', 'sourceRootKey', 'sourceRootKeys', 'recursive', 'allowFile', 'route'])),
  };
}

async function resourceHashes(gameDir, files, { signal, maxFileBytes = RESOURCE_SIZE_LIMIT, digests = new Map() } = {}) {
  const result = {};
  for (const file of files) {
    signal?.throwIfAborted();
    const target = await checkedPath(gameDir, file);
    const info = await lstat(target);
    if (!info.isFile()) throw new Error(`适配资源须为普通文件：${file}`);
    if (info.size > maxFileBytes) throw new Error(`适配资源大小达到上限，请使用已注册的格式工具：${file}`);
    if (!digests.has(target)) digests.set(target, hash(await readFile(target, { signal })));
    result[file] = digests.get(target);
  }
  return result;
}

async function copyTree(source, output, signal) {
  output = await independentRoot(source, output);
  const inventory = await listFiles(source, '', 200000, { excludePath: isPrivateGamePath });
  if (inventory.truncated) throw new Error('成品资源清单达到上限');
  for (const file of inventory.files) {
    signal?.throwIfAborted();
    const from = await checkedPath(source, file.path);
    const to = await checkedPath(output, file.path, { write: true });
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

async function executeTrustedCallback(descriptor, input) {
  const controller = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('可信工具执行超时'), { code: 'ADAPTER_TOOL_TIMEOUT' })), descriptor.timeoutMs ?? 30000);
  let onAbort;
  try {
    signal.throwIfAborted();
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new DOMException('适配任务已取消', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([Promise.resolve().then(() => descriptor.execute({ ...input, signal })), aborted]);
  } finally { clearTimeout(timer); if (onAbort) signal.removeEventListener('abort', onAbort); }
}

/** Candidate code is data. Only the QuickJS worker receives it; host Node never imports it. */
export async function createAdapterLab({ dataDir, workspaceFor, trustedTools = {}, nativeResultResolver, nativeReviewResolver, archiveResolver, runtimeVerifier, structuralVerifier, displayVerifier, representationSourceFor, formatCapabilities, verificationVersions = {}, workerPath, limits = {}, execution }) {
  if (!dataDir) throw new Error('适配实验室需要工作目录');
  if (displayVerifier && typeof displayVerifier.isFresh !== 'function') throw new Error('显示用途复核器需要提供依赖新鲜度检查');
  const root = await ensureRoot(path.resolve(dataDir));
  const catalogBase = formatCapabilities ?? await createFormatCapabilities();
  const qualificationFile = ref => path.join(root,'format-qualifications',`qualification-${hash(ref).slice(0,40)}.json`);
  const qualificationState = async ref => {
    try {const state=await readJson(qualificationFile(ref));if(state.qualificationRef!==ref||state.status!=='revoked')throw new Error('格式资格状态记录损坏');return state;}
    catch(error){if(error.code==='ENOENT')return{qualificationRef:ref,status:'active',revision:0};throw Object.assign(error,{storageFailure:true});}
  };
  const capabilityFresh = async ref => await catalogBase.fresh(ref) && (await qualificationState(ref.qualificationRef)).status!=='revoked';
  const formatCatalog=Object.freeze({...catalogBase,fresh:capabilityFresh,plan:async input=>{
    const plan=await catalogBase.plan(input);
    for(const ref of plan.capabilityRefs)if(!await capabilityFresh(ref))throw formatFailure('FORMAT_QUALIFICATION_REVOKED','对应格式资格已撤销，保留候选并等待新资格后重验',{qualificationRef:ref.qualificationRef});
    return plan;
  }});
  // Legacy host callbacks have no package/configuration closure. Do not reuse their
  // proof across newly configured labs merely because Function.toString is equal.
  const callbackEpoch = randomUUID();
  const toolCatalog = Object.freeze(Object.fromEntries(Object.entries(trustedTools).map(([name, descriptor]) => [name, Object.freeze({ ...descriptor, prefixArgs: Object.freeze([...(descriptor.prefixArgs ?? [])]) })])));
  for (const folder of ['recipes', 'recipe-candidates']) await ensureRoot(path.join(root, folder));
  const trace = new AsyncLocalStorage();
  const executionContext = new AsyncLocalStorage();
  const storageRoot = () => {
    const context = executionContext.getStore();
    if (context?.recordRoot) return path.resolve(context.recordRoot);
    if (!context?.projectId) return root;
    if (!context.workDir) throw new Error('项目技术执行需要明确的工作目录');
    return path.join(path.resolve(context.workDir), 'technical-lab');
  };
  const fileFor = (folder, id, shared = false) => {
    if (!/^[a-z0-9-]{8,160}$/.test(id ?? '')) throw new Error('适配记录 ID 无效');
    return path.join(shared ? root : storageRoot(), folder, `${id}.json`);
  };
  const readCandidate = async candidateId => {
    let candidate;
    try { candidate = await readJson(fileFor('candidates', candidateId)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      candidate = await readJson(fileFor('recipe-candidates', candidateId, true));
    }
    candidate.manifest = manifestRecord(candidate.manifest);
    if (hash(candidate.code) !== candidate.codeHash || `candidate-${hash({ manifest: candidate.manifest, codeHash: candidate.codeHash }).slice(0, 40)}` !== candidate.candidateId) throw new Error('适配候选校验失败');
    return candidate;
  };
  const workspaceExecution = createWorkspaceExecution(execution);
  const authorizeCandidate = async candidate => {
    if (candidate.manifest.execution && !await execution?.authorize?.({ projectId: executionContext.getStore()?.projectId })) throw Object.assign(new Error('请先允许此项目运行本地技术脚本'), { code: 'WORKSPACE_EXECUTION_AUTH_REQUIRED' });
  };
  const archiveHash = async (gameDir, file, signal) => {
    const digest = createHash('sha256');
    for await (const bytes of createReadStream(await checkedPath(gameDir, file),{signal})) digest.update(bytes);
    return digest.digest('hex');
  };
  const sourceView = async (candidate, gameDir, signal) => {
    if (!candidate.manifest.container) return { gameDir };
    if (!archiveResolver?.resolveArchive || !archiveResolver?.repackArchive) throw Object.assign(new Error('归档配方需要登记解封包与成员回读能力'), { code: 'CAPABILITY_MISSING' });
    const artifact = await archiveResolver.resolveArchive({ gameDir, container: candidate.manifest.container, workDir: path.join(storageRoot(), 'archives', hash(path.resolve(gameDir)).slice(0, 24)), signal });
    return { gameDir: artifact.sourceDir, sourceView: { originalGameDir: path.resolve(gameDir), container: artifact.container, archiveHash: artifact.archiveHash, artifactId: artifact.artifactId } };
  };
  const run = async (candidate, action, { gameDir, outputDir, input, signal, auxiliarySourceDir = gameDir }) => {
    const record = trace.getStore();
    try {
      let result;
      if (candidate.manifest.execution) {
        const projectId = executionContext.getStore()?.projectId;
        const workDir = await ensureRoot(path.join(storageRoot(), 'script-runs', hash([projectId, candidate.codeHash]).slice(0, 32)));
        const context = { projectId, requestId:executionContext.getStore()?.requestContext?.adaptationRequestId, gameDir, workDir, signal };
        const sourceFiles = [...new Set([...candidate.manifest.scope.files, ...candidate.manifest.execution.readFiles])].sort();
        const auxiliaryFiles = sourceFiles.filter(file => !candidate.manifest.scope.files.includes(file));
        const scopeHashes = await resourceHashes(gameDir, candidate.manifest.scope.files, { signal, maxFileBytes: limits.maxFileBytes });
        const auxiliaryHashes = await resourceHashes(auxiliarySourceDir, auxiliaryFiles, { signal, maxFileBytes: limits.maxFileBytes });
        const readHashes = { ...scopeHashes, ...auxiliaryHashes };
        await workspaceExecution.writeFile({ ...context, file: 'adapter.py', content: candidate.code });
        await workspaceExecution.writeFile({ ...context, file: 'driver.py', content: PYTHON_ADAPTER_DRIVER });
        for (const wheel of candidate.manifest.execution.wheels.filter(item => !item.url)) {
          const bytes = await readFile(await checkedPath(root, `wheel-artifacts/${wheel.sha256}-${path.basename(wheel.file)}`));
          if (hash(bytes) !== wheel.sha256) throw new Error('配方依赖摘要已变化');
          const target = await checkedPath(workDir, wheel.file, { write: true });
          await ensureRoot(path.dirname(target));
          const handle = await open(target, 'w'); try { await handle.writeFile(bytes); } finally { await handle.close(); }
        }
        const resultName = `result-${randomUUID()}.json`, resultFile = path.join(workDir, resultName);
        const request = { action, sourceDir: gameDir, auxiliarySourceDir, outputDir, input: input ?? {}, files: candidate.manifest.scope.files, readFiles: sourceFiles, resultFile, limits: { ...DEFAULT_LIMITS, ...limits } };
        let running = await workspaceExecution.run({ ...context, program: 'python', args: ['driver.py'], wheels: candidate.manifest.execution.wheels, stdin: JSON.stringify(request), timeoutMs: limits.scriptTimeoutMs ?? 900000 });
        while (running.status === 'running') running = await workspaceExecution.wait({ ...context, runId: running.runId, waitMs: 1000 });
        const evidence = { runId: running.runId, workDir, action };
        let response;
        try {
          const resultPath = await checkedPath(workDir, resultName);
          if ((await lstat(resultPath)).size > request.limits.maxResultBytes) throw new Error('结果超过 maxResultBytes');
          response = JSON.parse(await readFile(resultPath, 'utf8'));
        } catch (error) {
          throw Object.assign(new Error(`Python ${action} 未产生有效结果：${running.error ?? error.message}`), { code: running.errorCode ?? 'PYTHON_ADAPTER_RESULT', evidence });
        }
        if (running.status !== 'completed' || response?.error) throw Object.assign(new Error(`Python ${action}：${response?.error?.message ?? running.error ?? running.status}`), { code: response?.error?.code ?? running.errorCode ?? 'SCRIPT_ADAPTER_FAILED', evidence: { ...evidence, detail: response?.error } });
        if (!Object.hasOwn(response ?? {}, 'result')) throw Object.assign(new Error(`Python ${action} 结果缺少 result`), { code: 'PYTHON_ADAPTER_RESULT', evidence });
        const writes = outputDir ? (await listFiles(outputDir)).files.map(item => item.path) : [];
        if (writes.some(file => !candidate.manifest.scope.files.includes(file))) throw new Error('脚本产物包含未声明资源');
        await fingerprintsMatch(gameDir, scopeHashes, signal);
        await fingerprintsMatch(auxiliarySourceDir, auxiliaryHashes, signal);
        result = { result: response.result, writes, reads: response.reads, readHashes, listings: {}, metrics: response.metrics, evidence: { ...evidence, declaredListings: response.declaredListings } };
      } else result = await runSandbox({ code: candidate.code, action, sourceDir: gameDir, outputDir, input, allowedFiles: candidate.manifest.scope.files, signal, workerPath, limits });
      if (record) {
        record.evidence.push({ action, source: path.resolve(gameDir) === record.gameDir ? 'baseline' : 'sample', ...result });
        if (path.resolve(gameDir) === record.gameDir) {
          Object.assign(record.dependencies.files, result.readHashes);
          Object.assign(record.dependencies.listings, result.listings);
          record.dependencies.missingFiles = [...new Set([...(record.dependencies.missingFiles ?? []), ...(result.missingReads ?? [])])];
        }
      }
      return result;
    } catch (error) {
      if (record) record.evidence.push({ action, source: path.resolve(gameDir) === record.gameDir ? 'baseline' : 'sample', ...(error.evidence ?? {}), error: { code: error.code, message: error.message } });
      throw error;
    }
  };
  const fingerprintsMatch = async (gameDir, expected, signal, digests) => {
    const actual = await resourceHashes(gameDir, Object.keys(expected), { signal, maxFileBytes: limits.maxFileBytes, digests });
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('适配原版资源已经变化，请重新提取以匹配新版');
  };
  const displayInput = (candidate, gameDir, signal, workspaceDir) => ({ candidate, gameDir, signal,
    producerHints:candidate.producerHints ?? [],
    projectId: executionContext.getStore()?.projectId, requestContext: executionContext.getStore()?.requestContext,
    workspaceDir: executionContext.getStore()?.workDir ?? workspaceDir ?? root });
  const dependencyIdentity = { protocol: VALIDATION_PROTOCOL, python: { protocol: PYTHON_ADAPTER_PROTOCOL, driver: hash(PYTHON_ADAPTER_DRIVER) }, display: displayVerifier ? hash([String(displayVerifier), String(displayVerifier.isFresh)]) : 'not-configured', jsonFieldPolicy: JSON_FIELD_POLICY_VERSION, scriptFieldPolicy: SCRIPT_FIELD_POLICY_VERSION, sandbox: 'quickjs-emscripten@0.31.0', limits: { ...DEFAULT_LIMITS, ...limits }, checker: structuralVerifier ? verificationVersions.structuralVerifierDigest ?? `legacy-instance:${callbackEpoch}` : 'builtin-json-utf8-v3', runtime: runtimeVerifier ? verificationVersions.runtimeVerifierDigest ?? `legacy-instance:${callbackEpoch}` : 'pending', samplePlan: 'first-second-middle-last-combined-v2', versions: verificationVersions,
    tools: Object.fromEntries(Object.entries(toolCatalog).map(([name, item]) => [name, { version: item.version ?? '1', capabilities: item.capabilities ?? null }])) };
  const completeNegativeReview = validation => validation?.passed === false && validation.error?.code === 'ADAPTER_DISPLAY_REVIEW_FAILED'
    && ['stableIds', 'roundtrip', 'sample', 'structure'].every(key => validation.checks?.[key] === 'passed')
    && validation.displayReview?.status === 'failed' && validation.displayReview.decisions?.length > 0
    && validation.displayReview.decisions.every(item => ['display-supported', 'non-display'].includes(item.status));
  const proofMatches = async (validation, candidate, gameDir, signal, digests = new Map(), allowNegative = false) => {
    const negative = allowNegative && completeNegativeReview(validation);
    if ((!validation?.passed && !negative) || validation.candidateId !== candidate.candidateId || validation.codeHash !== candidate.codeHash
        || validation.gameDir !== path.resolve(gameDir) || !isDeepStrictEqual(validation.dependencies?.identity, dependencyIdentity)) return false;
    try {
      await assertEmbeddedContractsFresh(validation.representationContracts, gameDir);
      if(representationSourceFor&&Object.values(validation.representationContracts??{}).some(contract=>contract.sourceBinding)){
        const source=await representationSourceFor({gameDir,candidate,projectId:executionContext.getStore()?.projectId,signal});
        if(!source?.root||Object.values(validation.representationContracts).some(contract=>contract.sourceBinding&&contract.sourceBinding.consumerRoot!==path.resolve(source.root)))return false;
      }
      for (const ref of validation.verificationPlan?.capabilityRefs ?? []) if (!await formatCatalog.fresh(ref)) return false;
      if (displayVerifier && !(negative
        ? typeof displayVerifier.decisionsFresh === 'function' && await displayVerifier.decisionsFresh(validation.displayReview, displayInput(candidate, gameDir, signal))
        : validation.displayReview?.status === 'passed' && await displayVerifier.isFresh(validation.displayReview, displayInput(candidate, gameDir, signal)))) return false;
      if (validation.sourceView && await archiveHash(validation.sourceView.originalGameDir, validation.sourceView.container.file) !== validation.sourceView.archiveHash) return false;
      await fingerprintsMatch(gameDir, validation.resourceHashes, signal, digests);
      await fingerprintsMatch(gameDir, validation.dependencies.files, signal, digests);
      for (const file of validation.dependencies.missingFiles ?? []) {
        try { await checkedPath(gameDir, file, { directory: true }); return false; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      for (const [directory, expected] of Object.entries(validation.dependencies.listings)) {
        const listed = await listFiles(gameDir, directory, dependencyIdentity.limits.maxFiles, { excludePath: isPrivateGamePath });
        if (listed.truncated || hash(JSON.stringify(listed.files)) !== expected) return false;
      }
      return true;
    } catch (error) { if (signal?.aborted) throw error; return false; }
  };
  const proofFor = async (candidate, gameDir, signal) => {
    try {
      const saved = await readJson(fileFor('proofs', `proof-${hash([candidate.candidateId, path.resolve(gameDir)]).slice(0, 40)}`));
      const validation = await readJson(fileFor('validations', saved.validationId));
      return await proofMatches(validation, candidate, gameDir, signal, new Map(), true) ? validation : null;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const readBinding = async (workspaceDir, signal) => {
    let binding;
    try { binding = await readJson(await checkedPath(workspaceDir, bindingName)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (binding.format !== 'pinhao-adapter-binding' || binding.version !== 1) throw new Error('适配绑定版本无效');
      if (binding.recordNamespace?.root && executionContext.getStore()?.recordRoot !== binding.recordNamespace.root) return executionContext.run({ ...executionContext.getStore(), recordRoot:binding.recordNamespace.root }, () => readBinding(workspaceDir,signal));
      const candidate = await readCandidate(binding.candidateId);
      await authorizeCandidate(candidate);
      if (candidate.codeHash !== binding.codeHash) throw new Error('适配绑定与候选代码不一致');
      // The binding and proof inspect one immutable baseline in this operation.
      const digests = new Map();
      await fingerprintsMatch(binding.gameDir, binding.resourceHashes, signal, digests);
      const validation = await readJson(fileFor('validations', binding.validationId));
      if (!await proofMatches(validation, candidate, binding.gameDir, signal, digests)) throw new Error('适配依赖或验证协议已变化，请重新验证配方');
      return { binding, candidate };
  };
  const readBuildBinding = async (workspaceDir,signal) => {
    try{return await readBinding(workspaceDir,signal);}
    catch(error){
      if(signal?.aborted)throw error;
      if(error.code==='ENOENT'||/适配原版资源已经变化|适配依赖或验证协议已变化/.test(error.message))throw formatFailure('ADAPTER_ACCEPTED_STALE','成品所依赖的来源或验证资格已变化，请保留产物并重新核对',{cause:error.message});
      throw error;
    }
  };
  const buildFingerprintsMatch = async (directory,expected,signal,{temporary=false}={}) => {
    try{await fingerprintsMatch(directory,expected,signal);}
    catch(error){
      if(signal?.aborted)throw error;
      if(error.code==='ENOENT')throw formatFailure(temporary?'FORMAT_BUILD_PROOF_REQUIRED':'FORMAT_SOURCE_STALE',temporary?'临时构建已释放且没有最终成品证明，请重新生成':'最终成品文件缺失，不能复用已保存的验证结果');
      if(/适配原版资源已经变化/.test(error.message))throw formatFailure('FORMAT_SOURCE_STALE','最终成品或已验证构建资源已经变化，请重新核对');
      throw error;
    }
  };

  async function extract(candidate, gameDir, signal, detect = true, auxiliarySourceDir = gameDir) {
    if (detect) {
      const detection = (await run(candidate, 'detect', { gameDir, signal, auxiliarySourceDir })).result;
      if (typeof detection !== 'boolean' && typeof detection?.matched !== 'boolean') throw Object.assign(
        new Error('detect 返回格式无效：请返回 true/false 或 {matched: true/false}；detected、status 不是识别结果字段。请修正 detect，不必重新猜测已经读取成功的资源。'),
        { code: 'ADAPTER_DETECT_CONTRACT', evidence: { expected: 'boolean | {matched:boolean}', actual: detection } });
      if (detection !== true && detection?.matched !== true) throw new Error('适配配方与当前游戏资源特征不符');
    }
    const result = (await run(candidate, 'extract', { gameDir, signal, auxiliarySourceDir })).result;
    const units = protectUnits(result, candidate.manifest.scope.files);
    return { units, coverage: Array.isArray(result.coverage) ? result.coverage : candidate.manifest.scope.files.map(file => ({ file, status: 'extracted' })), reviewItems: result.reviewItems ?? [], images: result.images ?? [] };
  }

  async function bindExtraction(recipe, candidate, validation, gameDir, workspaceDir, signal) {
    gameDir = validation.gameDir;
    await fingerprintsMatch(gameDir, validation.resourceHashes, signal);
    workspaceDir = await independentRoot(gameDir, workspaceDir);
    const units = validation.sourceView ? validation.extraction.units.map(unit => ({ ...unit, context: { ...unit.context, carrier: validation.sourceView.container.file } })) : validation.extraction.units;
    const binding = { format: 'pinhao-adapter-binding', version: 1, recipeId: recipe.recipeId, candidateId: candidate.candidateId, codeHash: candidate.codeHash, gameDir: path.resolve(gameDir), ...(validation.sourceView ? { sourceView: validation.sourceView } : {}), ...(validation.representationContracts ? { representationContracts: validation.representationContracts } : {}), ...(validation.verificationPlan ? { verificationPlan: validation.verificationPlan } : {}), resourceHashes: validation.resourceHashes, units, validationId: validation.validationId, runtime: validation.runtime };
    binding.recordNamespace = { root:storageRoot(), ...(executionContext.getStore()?.projectId ? {projectId:executionContext.getStore().projectId} : {}) };
    await appendRecord(path.join(workspaceDir, bindingName), binding);
    const manifestFile = path.join(workspaceDir, 'manifest.json');
    const currentManifest = { engine: candidate.manifest.engine, units: Object.fromEntries(binding.units.map(unit => [unit.id, { ...unit.locator, controls: unit.controls, tokens: unit.tokens }])) };
    try {
      const previous = JSON.parse(await readFile(manifestFile, 'utf8'));
      if (hash(previous) !== hash(currentManifest)) throw new Error('工作台已绑定其他提取版本，请为新版本使用独立工作目录');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const handle = await open(manifestFile, 'wx');
      try { await handle.writeFile(JSON.stringify(currentManifest)); await handle.sync(); } finally { await handle.close(); }
    }
    return { ...validation.extraction, units, binding, workspaceDir, engine: candidate.manifest.engine, sourceFingerprint: hash({ resources: binding.resourceHashes, archive: binding.sourceView?.archiveHash }), validation: { ...validation.checks, runtime: validation.runtime } };
  }

  async function validateBuild(candidate, gameDir, units, translations, outputDir, signal, representationContracts = trace.getStore()?.representationContracts ?? {}, verificationPlan = trace.getStore()?.verificationPlan, hostSampleRoot) {
    const raw = rawTranslations(units, translations);
    await assertEmbeddedContractsFresh(representationContracts, gameDir);
    for (const unit of units.filter(item => item.locator.segment)) if (Object.hasOwn(raw, unit.id)) encodeEmbeddedTarget({ before: unit.locator.segment.prefix + unit.rawSource + unit.locator.segment.suffix, source: unit.rawSource, target: raw[unit.id], contract: representationContracts[unit.id] });
    verificationPlan ??= await formatCatalog.plan({ units, manifest: candidate.manifest }).catch(error => { if (!structuralVerifier) throw error; return undefined; });
    const input = { units: units.map(unit => ({ ...unit, source: unit.rawSource })), translations: raw, representationContracts: guestContracts(representationContracts), verificationPlan };
    const adapterValidation = (await run(candidate, 'validate', { gameDir, input, signal })).result;
    if (adapterValidation === false || adapterValidation?.valid === false) throw new Error(adapterValidation?.message || '适配器结构校验未通过');
    await run(candidate, 'build', { gameDir, outputDir, input, signal });
    // Copy unchanged scoped files only. Re-extraction sees exactly the resources emitted for this build.
    for (const file of candidate.manifest.scope.files) {
      let target;
      try { target = await checkedPath(outputDir, file, { write: true }); }
      catch (error) { throw classifyValidationOutputRoot(error, hostSampleRoot); }
      try { await lstat(target); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(await checkedPath(gameDir, file), target);
      }
    }
    const groupReceipts = await verifyResourceStructure({ candidate, gameDir, outputDir, units, translations: raw, structuralVerifier, representationContracts, formatCatalog, verificationPlan, purpose: trace.getStore() ? 'candidate-sample' : 'build', signal });
    const actual = await extract(candidate, outputDir, signal, false, gameDir);
    const byId = new Map(actual.units.map(unit => [unit.id, unit]));
    if (byId.size !== units.length) throw new Error('改文回读后的文字单元数量改变');
    for (const unit of units) {
      const next = byId.get(unit.id);
      const locatorChanged = unit.locator.pointer !== undefined ? JSON.stringify(next?.locator) !== JSON.stringify(unit.locator) : next?.locator.file !== unit.locator.file;
      if (!next || next.rawSource !== (Object.hasOwn(raw, unit.id) ? raw[unit.id] : unit.rawSource) || locatorChanged) throw new Error(`改文回读定位或文字不一致：${unit.id}`);
    }
    const result = { buildDir: outputDir, files: candidate.manifest.scope.files, resourceHashes: await resourceHashes(outputDir, candidate.manifest.scope.files, { signal, maxFileBytes: limits.maxFileBytes }), unitCount: units.length, changed: Object.keys(raw).length, ...(Object.keys(representationContracts).length ? { representationContracts } : {}), verificationPlan, groupReceipts, checks: { structure: 'passed', textReadback: 'passed', controls: 'passed' } };
    const buildReceiptId = `build-${hash([candidate.candidateId,path.resolve(outputDir),result.resourceHashes,raw]).slice(0,40)}`;
    await appendRecord(fileFor('build-artifacts',buildReceiptId), { ...result, buildReceiptId, candidateId: candidate.candidateId, codeHash: candidate.codeHash, targetSetHash: hash(raw), purpose: trace.getStore() ? 'candidate-sample' : 'build' });
    if (!trace.getStore()) await appendRecord(fileFor('build-pointers',`build-${hash([candidate.candidateId,path.resolve(outputDir)]).slice(0,40)}`),{buildReceiptId});
    return { ...result, buildReceiptId };
  }

  const lab = {
    async revokeFormatQualification({qualificationRef,reason='host-revoked',expectedRevision}){
      if(typeof qualificationRef!=='string'||!qualificationRef||qualificationRef.length>1000)throw new Error('需要明确的宿主资格引用');
      return qualificationCommit(root,async()=>{
        const previous=await qualificationState(qualificationRef);
        if(expectedRevision!==undefined&&expectedRevision!==previous.revision)throw formatFailure('FORMAT_QUALIFICATION_REVOKED','资格状态已变化，请读取最新状态');
        if(previous.status==='revoked')return previous;
        const record={format:'pinhao-format-qualification-status-1',qualificationRef,status:'revoked',revision:previous.revision+1,reason:String(reason).slice(0,2000),recordedAt:timestamp()};
        await appendRecord(qualificationFile(qualificationRef),record);return record;
      });
    },
    async withQualificationFence({capabilityRefs=[],commit}){
      if(typeof commit!=='function')throw new Error('资格提交栅栏仅供宿主提交使用');
      return qualificationCommit(root,async()=>{
        for(const ref of capabilityRefs)if(!await formatCatalog.fresh(ref))throw formatFailure('FORMAT_QUALIFICATION_REVOKED','提交前格式资格已经变化');
        return commit();
      });
    },
    withAcceptedPublication: async function withAcceptedPublication(input){
      const {extraction,gameDir,commit,signal}=input,binding=extraction?.binding;
      if(typeof commit!=='function'||!binding?.validationId)throw new Error('接受成果发布需要宿主证明与提交回调');
      if(binding.recordNamespace?.root&&executionContext.getStore()?.recordRoot!==binding.recordNamespace.root)return executionContext.run({...executionContext.getStore(),recordRoot:binding.recordNamespace.root},()=>withAcceptedPublication(input));
      const validation=await readJson(fileFor('validations',binding.validationId)),candidate=await readCandidate(binding.candidateId);
      return qualificationCommit(root,async()=>{
        await lab.assertAcceptedFresh(input);
        for(const ref of validation.verificationPlan?.capabilityRefs??[])if(!await formatCatalog.fresh(ref))throw formatFailure('FORMAT_QUALIFICATION_REVOKED','发布前资格已撤销');
        if(displayVerifier?.withPublicationFence)return displayVerifier.withPublicationFence(validation.displayReview,displayInput(candidate,binding.gameDir??gameDir,signal),commit);
        // Legacy injected verifiers have no host challenge writer; their ordinary
        // freshness check remains in assertAcceptedFresh, without inventing a fence.
        return commit();
      });
    },
    async withBuildPublication({builds=[],commit,signal,projectId}){
      if(typeof commit!=='function'||!Array.isArray(builds))throw new Error('成品发布需要宿主构建证明和同步提交回调');
      const entries=[];
      for(const item of builds){
        signal?.throwIfAborted();
        const state=await readBuildBinding(item.workspaceDir,signal);
        if(!state)throw formatFailure('FORMAT_BUILD_PROOF_REQUIRED','成品缺少实际参与写入的适配绑定');
        const {binding,candidate}=state,context={...executionContext.getStore(),...(projectId?{projectId}:{}),recordRoot:binding.recordNamespace?.root??storageRoot()};
        await executionContext.run(context,async()=>{
          const validation=await readJson(fileFor('validations',binding.validationId));
          let outputDir=item.outputDir,artifactDir=item.artifactDir,artifactFiles=item.artifactFiles,expectedArtifactHashes,nativeMetadataRef,releaseReadback;
          const nativePacked=item.sourceRoot&&item.gameDir&&path.resolve(item.sourceRoot)!==path.resolve(item.gameDir,item.resourceRoot??'.')&&!candidate.manifest.container;
          if(nativePacked&&!item.finalProofRef){
            if(typeof archiveResolver?.resolveFinalView!=='function')throw formatFailure('FORMAT_FINAL_VIEW_REQUIRED','原生归档已组装，但该补充适配尚无可信最终成员回读；保留产物等待验证',{workspaceDir:item.workspaceDir});
            const files=[...new Set([...candidate.manifest.scope.files,...Object.values(binding.representationContracts??{}).flatMap(contract=>Object.keys(contract.dependencies??{}))])];
            const resolved=await archiveResolver.resolveFinalView({gameDir:item.gameDir,outputDir:item.finalGameDir??item.outputDir,nativeWorkspaceDir:item.nativeWorkspaceDir,files,workDir:path.join(storageRoot(),'final-native-readback'),signal});
            outputDir=resolved.sourceDir;artifactDir=resolved.artifactDir;artifactFiles=resolved.artifactFiles;expectedArtifactHashes=resolved.artifactHashes;nativeMetadataRef=resolved.nativeMetadataRef;releaseReadback=resolved.release;
          }
          if(candidate.manifest.container&&!item.finalProofRef){
            artifactDir=item.finalGameDir??item.outputDir;artifactFiles=[candidate.manifest.container.file];
            const resolved=await sourceView(candidate,artifactDir,signal);outputDir=resolved.gameDir;expectedArtifactHashes={[candidate.manifest.container.file]:resolved.sourceView.archiveHash};
          }else if((candidate.manifest.container||nativePacked)&&item.finalProofRef){
            outputDir=item.finalGameDir??item.outputDir;
          }
          entries.push({item,context,validation,candidate,binding,releaseReadback,input:{...item,outputDir,artifactDir,artifactFiles,expectedArtifactHashes,nativeMetadataRef,signal},display:{record:validation.displayReview,input:displayInput(candidate,binding.gameDir,signal,item.workspaceDir)}});
        });
      }
      let published;
      try{published=await qualificationCommit(root,async()=>{
        const proofs=[];
        const check=async()=>{
          proofs.length=0;
          for(const entry of entries){
            signal?.throwIfAborted();
            const proof=await executionContext.run(entry.context,()=>lab.assertBuildOutputFresh(entry.input));
            proofs.push({...entry.item,finalProofRef:proof.finalProofRef});
          }
        };
        const publish=()=>{signal?.throwIfAborted();const result=commit(proofs);if(result?.then)throw new Error('Build publication commit must be synchronous');return{result,proofs};};
        // One format lock and one display-store lock per physical project cover
        // every participating writer, including reuse after temporary build cleanup.
        if(displayVerifier?.withPublicationsFence)return displayVerifier.withPublicationsFence(entries.map(entry=>entry.display),publish,{check});
        await check();return publish();
      });return published;}
      finally{if(published)for(const entry of entries)if(entry.releaseReadback)await entry.releaseReadback();}
    },
    describeVerificationCapabilities() { return { protocol: 'pinhao-format-capability-1', fingerprint: formatCatalog.fingerprint, capabilities: formatCatalog.describe(), legacyStructuralCallback: !!structuralVerifier }; },
    async readFormatView({ gameDir, readRoots = [], sourceIndex = 0, file, capabilityId = 'builtin-json-pointer', view = 'parsed', offset = 0, length = 65536, signal }) {
      const roots = [gameDir,...readRoots];
      if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= roots.length || isPrivateGamePath(file)) throw new Error('格式读取需要明确且非私有的来源');
      const resource = await checkedPath(roots[sourceIndex],file), info = await lstat(resource);
      if (!info.isFile() || info.size > (limits.maxFileBytes ?? RESOURCE_SIZE_LIMIT)) throw new Error('格式视图资源达到读取上限');
      const bytes = await readFile(resource,{signal}), sourceHash=hash(bytes);
      const sourceRef={relativeFile:file,sourceIndex,baselineHash:sourceHash};
      if (view === 'raw') {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 65536) throw new Error('原始字节视图需要有效范围');
        const end=Math.min(bytes.length,offset+length);
        return {format:'pinhao-source-view-1',view:'raw-byte-1',sourceRef,sourcePage:{offset,end,snapshotBytes:bytes.length},encoding:'base64',content:bytes.subarray(offset,end).toString('base64'),nextCall:end<bytes.length?{file,sourceIndex,view:'raw',offset:end,length}:null};
      }
      const descriptor=formatCatalog.describe().find(item=>item.capabilityId===capabilityId);
      if (!descriptor || !await formatCatalog.fresh(descriptor)) throw formatFailure('FORMAT_READER_MISSING','没有当前可用且有资格的来源解码器');
      let parsed;
      if (capabilityId === 'builtin-json-pointer') {
        try {parsed=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,''));}
        catch(error){throw Object.assign(new Error('JSON来源损坏或不是受支持的UTF-8结构'),{code:'FORMAT_STRUCTURE_INVALID',cause:error});}
      } else {
        const profile=formatCatalog.get(capabilityId);
        if (typeof profile?.read !== 'function') throw formatFailure('FORMAT_READER_MISSING','该检查能力没有声明可信来源读取视图');
        parsed=await profile.read({bytes:Buffer.from(bytes),file,signal});
      }
      return {format:'pinhao-source-view-1',view:'parsed-value-1',sourceRef,capabilityRef:descriptor.capabilityRef,viewHash:hash([sourceHash,descriptor.capabilityRef,parsed]),content:parsed,proofScope:['host-decoded-source-only']};
    },
    assertAcceptedFresh: async function assertAcceptedFresh(input) {
      const { extraction, gameDir, signal } = input;
      const binding = extraction?.binding;
      if (!binding?.candidateId || !binding.validationId) throw Object.assign(new Error('接入缺少主机接受证明'), { code: 'ADAPTER_ACCEPTED_STALE' });
      if (binding.recordNamespace?.root && executionContext.getStore()?.recordRoot !== binding.recordNamespace.root) return executionContext.run({ ...executionContext.getStore(), recordRoot:binding.recordNamespace.root }, () => assertAcceptedFresh(input));
      const candidate = await readCandidate(binding.candidateId), validation = await readJson(fileFor('validations', binding.validationId));
      const expectedUnits = validation.sourceView ? validation.extraction?.units.map(unit => ({ ...unit, context: { ...unit.context, carrier: validation.sourceView.container.file } })) : validation.extraction?.units;
      if (!isDeepStrictEqual(extraction.units ?? binding.units,expectedUnits) || !isDeepStrictEqual(binding.units,expectedUnits) || !isDeepStrictEqual(binding.resourceHashes,validation.resourceHashes)) throw Object.assign(new Error('接受回执的单位或来源绑定与主机验证不一致'), { code: 'ADAPTER_ACCEPTED_STALE' });
      if (candidate.codeHash !== binding.codeHash || !await proofMatches(validation,candidate,binding.gameDir ?? gameDir,signal)) throw Object.assign(new Error('已接受成果的来源、消费者或验证资格已经变化，请保留成果并重验'), { code: 'ADAPTER_ACCEPTED_STALE' });
      if (validation.sourceView && await archiveHash(gameDir ?? validation.sourceView.originalGameDir,validation.sourceView.container.file) !== validation.sourceView.archiveHash) throw Object.assign(new Error('已接受成果的原容器已经变化'), { code: 'ADAPTER_ACCEPTED_STALE' });
      return { validationId: validation.validationId, candidateId: candidate.candidateId, codeHash: candidate.codeHash, resourceHashes: validation.resourceHashes, dependencyFingerprint: hash(validation.dependencies), verificationPlan: validation.verificationPlan, representationContracts: validation.representationContracts, displayFactRefs: validation.displayReview?.displayFactRefs ?? [] };
    },
    assertBuildOutputFresh: async function assertBuildOutputFresh(input) {
      const { workspaceDir, buildReceiptId, buildDir, outputDir, signal, unitIds, strictResourceHashes=false, finalProofRef, artifactDir, artifactFiles,expectedArtifactHashes,nativeMetadataRef } = input;
      const state = await readBuildBinding(workspaceDir,signal);
      if (!state) throw new Error('缺少成品验证的适配绑定');
      const {binding,candidate} = state;
      if (binding.recordNamespace?.root && executionContext.getStore()?.recordRoot !== binding.recordNamespace.root) return executionContext.run({ ...executionContext.getStore(), recordRoot:binding.recordNamespace.root }, () => assertBuildOutputFresh(input));
      const proof = await readJson(fileFor('build-artifacts',buildReceiptId)).catch(error=>{if(error.code==='ENOENT')throw formatFailure('FORMAT_BUILD_PROOF_REQUIRED','本次构建的宿主证明缺失，请保留产物并重新生成');throw error;});
      if (proof.purpose !== 'build' || proof.candidateId !== candidate.candidateId || proof.codeHash !== candidate.codeHash || buildDir && path.resolve(proof.buildDir) !== path.resolve(buildDir)) throw formatFailure('FORMAT_SOURCE_STALE','成品必须使用本次真实目标的构建证明');
      for (const ref of proof.verificationPlan?.capabilityRefs ?? []) if (!await formatCatalog.fresh(ref)) throw formatFailure('FORMAT_QUALIFICATION_REVOKED','构建后格式资格已改变');
      if(finalProofRef){
        if(finalProofRef.format!=='pinhao-final-build-ref-1'||!outputDir)throw formatFailure('FORMAT_BUILD_PROOF_REQUIRED','缺少可复用的最终成品证明，需要重新生成');
        const retained=await readJson(fileFor('final-artifacts',finalProofRef.id)).catch(error=>{if(error.code==='ENOENT')throw formatFailure('FORMAT_BUILD_PROOF_REQUIRED','最终成品证明缺失，请重新生成');throw error;});
        if(`final-${hash(retained).slice(0,40)}`!==finalProofRef.id||retained.buildReceiptId!==buildReceiptId||retained.candidateId!==candidate.candidateId||retained.targetSetHash!==proof.targetSetHash||!isDeepStrictEqual(retained.unitIds,[...(unitIds??binding.units.map(unit=>unit.id))].sort()))throw formatFailure('FORMAT_SOURCE_STALE','最终成品证明与当前目标或位置不一致');
        if(retained.artifactDir){
          if(retained.artifactDir!==path.resolve(artifactDir??outputDir))throw formatFailure('FORMAT_SOURCE_STALE','最终归档成品位置已经变化');
          for(const [file,expected] of Object.entries(retained.artifactHashes)){
            const actual=await archiveHash(retained.artifactDir,file,signal).catch(error=>{if(error.code==='ENOENT')throw formatFailure('FORMAT_SOURCE_STALE','最终归档文件缺失，不能复用成品证明');throw error;});
            if(actual!==expected)throw formatFailure('FORMAT_SOURCE_STALE','最终归档内容已经变化');
          }
          if(retained.nativeMetadataRef&&await archiveHash(retained.nativeMetadataRef.workspaceDir,'technical/product-source.json',signal)!==retained.nativeMetadataRef.sha256)throw formatFailure('FORMAT_SOURCE_STALE','原生容器来源记录已经变化');
        }else{
          if(retained.outputDir!==path.resolve(outputDir))throw formatFailure('FORMAT_SOURCE_STALE','最终成品位置已经变化');
          await buildFingerprintsMatch(outputDir,retained.resourceHashes,signal);
          await assertEmbeddedContractsFresh(proof.representationContracts,outputDir,{purpose:'final'});
        }
        return{buildReceiptId,targetSetHash:proof.targetSetHash,resourceHashes:retained.resourceHashes,checks:proof.checks,finalProofRef};
      }
      if(!buildDir)throw formatFailure('FORMAT_BUILD_PROOF_REQUIRED','临时构建已释放且没有最终成品证明，请重新生成');
      await buildFingerprintsMatch(buildDir,proof.resourceHashes,signal,{temporary:true});
      if (outputDir) {
        if (strictResourceHashes) await buildFingerprintsMatch(outputDir,proof.resourceHashes,signal);
        await assertEmbeddedContractsFresh(proof.representationContracts,outputDir,{purpose:'final'});
        for (const group of proof.groupReceipts ?? []) await buildFingerprintsMatch(outputDir,group.outputHashes,signal);
        const pointers = binding.units.filter(unit => typeof unit.locator.pointer === 'string' && (!unitIds || unitIds.includes(unit.id)));
        for (const file of new Set(pointers.map(unit => unit.locator.file))) {
          const before = JSON.parse((await readFile(await checkedPath(buildDir,file),'utf8')).replace(/^\uFEFF/,''));
          const after = JSON.parse((await readFile(await checkedPath(outputDir,file),'utf8')).replace(/^\uFEFF/,''));
          for (const unit of pointers.filter(item => item.locator.file === file)) {
            const expected=jsonTarget(before,unit.locator.pointer), actual=jsonTarget(after,unit.locator.pointer);
            if (expected.parent[expected.key] !== actual.parent[actual.key]) throw formatFailure('FORMAT_PRESERVATION_FAILED',`最终成品没有保留本次正文：${unit.id}`);
          }
        }
      }
      let retainedRef;
      if(outputDir){
        const artifactHashes=artifactDir?Object.fromEntries(await Promise.all(artifactFiles.map(async file=>[file,await archiveHash(artifactDir,file,signal)]))):undefined;
        if(expectedArtifactHashes&&!isDeepStrictEqual(expectedArtifactHashes,artifactHashes))throw formatFailure('FORMAT_SOURCE_STALE','最终容器在实际成员验证后已经变化');
        if(nativeMetadataRef&&await archiveHash(nativeMetadataRef.workspaceDir,'technical/product-source.json',signal)!==nativeMetadataRef.sha256)throw formatFailure('FORMAT_SOURCE_STALE','原生容器来源记录在验证期间已经变化');
        const retained={format:'pinhao-final-build-proof-1',buildReceiptId,candidateId:candidate.candidateId,codeHash:candidate.codeHash,targetSetHash:proof.targetSetHash,outputDir:path.resolve(outputDir),unitIds:[...(unitIds??binding.units.map(unit=>unit.id))].sort(),resourceHashes:await resourceHashes(outputDir,proof.files,{signal,maxFileBytes:limits.maxFileBytes}),...(artifactDir?{artifactDir:path.resolve(artifactDir),artifactHashes}:{}),...(nativeMetadataRef?{nativeMetadataRef}:{})};
        const id=`final-${hash(retained).slice(0,40)}`;await appendRecord(fileFor('final-artifacts',id),retained);retainedRef={format:'pinhao-final-build-ref-1',id};
      }
      return {buildReceiptId,targetSetHash:proof.targetSetHash,resourceHashes:proof.resourceHashes,checks:proof.checks,...(retainedRef?{finalProofRef:retainedRef}:{})};
    },
    writeWorkspaceFile(input) { return workspaceExecution.writeFile(input); },
    runWorkspace(input) { return workspaceExecution.run(input); },
    readRun(input) { return workspaceExecution.read(input); },
    waitRun(input) { return workspaceExecution.wait(input); },
    stopRun(input) { return workspaceExecution.stop(input); },
    prepareDependencies(input) { return workspaceExecution.prepareDependencies(input); },
    settleWorkspaceRuns(input) { return workspaceExecution.settle(input); },
    closeExecution() { return workspaceExecution.close(); },
    async resolveNativeResult(input) {
      if (typeof nativeResultResolver !== 'function') throw new Error('主机尚未登记原生提取结果接入');
      input.signal?.throwIfAborted();
      return nativeResultResolver(input);
    },
    async resolveNativeReview(input) {
      if (typeof nativeReviewResolver !== 'function') throw new Error('主机正在等待原生字段验证接入');
      return nativeReviewResolver(input);
    },
    listTools() { return Object.entries(toolCatalog).map(([name, descriptor]) => ({ name, description: descriptor.description ?? name, argsHint: descriptor.argsHint ?? '', capabilities: descriptor.capabilities ?? { protocol: 1, operation: name }, limits: { timeoutMs: descriptor.timeoutMs ?? 30000, maxOutputBytes: descriptor.maxOutputBytes ?? 1024 * 1024 } })); },
    async previewAdapter({ candidateId, gameDir, action = 'extract', input = {}, signal }) {
      if (!['detect', 'extract', 'validate'].includes(action)) throw new Error('预览步骤请选择 detect、extract 或 validate');
      const candidate = await readCandidate(candidateId);
      ({ gameDir } = await sourceView(candidate, gameDir, signal));
      return run(candidate, action, { gameDir, input, signal });
    },
    async runProbe({ candidateId, gameDir, translations = {}, signal }) {
      const candidate = await readCandidate(candidateId), prepared = await sourceView(candidate, gameDir, signal);
      gameDir = prepared.gameDir;
      const probeId = `probe-${randomUUID()}`, directory = await ensureRoot(path.join(storageRoot(), 'runs', probeId));
      const record = { probeId, candidateId, gameDir: path.resolve(gameDir), passed: false, evidence: [], dependencies: { files: {}, listings: {} } };
      return trace.run(record, async () => {
        try {
          const extracted = await extract(candidate, gameDir, signal);
          record.result = await validateBuild(candidate, gameDir, extracted.units, translations, directory, signal);
          record.passed = true;
        } catch (error) {
          if (signal?.aborted) throw error;
          record.error = { code: error.code ?? 'ADAPTER_PROBE_FAILED', message: error.message, ...(error.evidence ? { evidence: error.evidence } : {}) };
        }
        await appendRecord(fileFor('validations', probeId), record);
        return record;
      });
    },
    async inspectAdapter({ candidateId, validationId }) {
      const { code, codeHash, manifest } = await readCandidate(candidateId);
      let capabilityHandoff;
      if (validationId) {
        const record=await readJson(fileFor('validations',validationId));
        if (record.candidateId !== candidateId) throw new Error('验证记录不属于当前候选');
        capabilityHandoff={format:'pinhao-format-handoff-1',candidateId,codeHash,manifest,validationId,sourceRefs:record.resourceHashes,blockedNeeds:record.blockedNeeds??[],checks:record.checks,verificationPlan:record.verificationPlan,extraction:record.extraction,probeEvidence:record.evidence,nextCall:{tool:'validate_adapter',input:{candidateId}},runtime:record.runtime};
      }
      return { candidateId, code, codeHash, manifest, ...(capabilityHandoff?{capabilityHandoff}:{}) };
    },
    async inspectFiles({ gameDir, readRoots = [], sourceIndex, relativePath = '', offset = 0, limit = 20000, recursive = true, allowFile = false, route, excludePrefixes = [], excludePrivate = true }) {
      if (excludePrivate && (isPrivateGamePath(relativePath) || isPrivateGamePath(relativePath, { directory: true }))) throw new Error('存档与私人配置不属于游戏文字资源');
      const options = { excludePrefixes, ...(excludePrivate ? { excludePath: isPrivateGamePath } : {}) };
      return inspectReadSources(gameDir, { sourceRoots: readRoots, sourceIndex, relativePath, offset, limit, recursive, allowFile, route, ...options });
    },
    async readResource({ gameDir, readRoots = [], sourceIndex, file, offset, length, encoding, excludePrivate = true }) {
      if (excludePrivate && isPrivateGamePath(file)) throw new Error('存档与私人配置不属于游戏文字资源');
      return readSourceSlice(gameDir, file, { sourceRoots: readRoots, sourceIndex, offset, length, encoding });
    },
    async writeAdapter({ manifest, code, workDir, producerHints = [] }) {
      const normalized = manifestRecord(manifest);
      if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code) > 512 * 1024) throw new Error('请提交适配代码正文');
      if (!normalized.execution) {
      try { parse(`(${code})`, { ecmaVersion: 'latest' }); }
      catch {
        try { parse(`(()=>{${code}\n;return typeof adapter==='object'?adapter:undefined;})()`, { ecmaVersion: 'latest' }); }
        catch (error) { throw Object.assign(new Error(`适配代码语法需要修正：${error.message}`), { code: 'ADAPTER_SYNTAX_ERROR' }); }
      }
      } else {
        const context = executionContext.getStore();
        if (!await execution?.authorize?.({ ...context })) throw Object.assign(new Error('请先允许此项目运行本地技术脚本'), { code: 'WORKSPACE_EXECUTION_AUTH_REQUIRED' });
        for (const wheel of normalized.execution.wheels.filter(item => !item.url)) {
          if (!workDir || !/^[a-f0-9]{64}$/.test(wheel.sha256 ?? '')) throw new Error('脚本配方的本地依赖需要工作目录与锁定摘要');
          const bytes = await readFile(await checkedPath(workDir, wheel.file));
          if (hash(bytes) !== wheel.sha256) throw new Error('脚本配方依赖摘要不匹配');
          await ensureRoot(path.join(root, 'wheel-artifacts'));
          const target = await checkedPath(root, `wheel-artifacts/${wheel.sha256}-${path.basename(wheel.file)}`, { write: true });
          const handle = await open(target, 'w'); try { await handle.writeFile(bytes); } finally { await handle.close(); }
        }
      }
      const codeHash = hash(code);
      const candidateId = `candidate-${hash({ manifest: normalized, codeHash }).slice(0, 40)}`;
      if (!Array.isArray(producerHints) || producerHints.length>2000 || JSON.stringify(producerHints).length>256000) throw new Error('消费者导航侧车需要有限结构化列表');
      let previousHints=[];
      try {previousHints=(await readCandidate(candidateId)).producerHints??[];} catch(error){if(error.code!=='ENOENT')throw error;}
      const mergedHints=[...new Map([...previousHints,...producerHints].map(item=>[hash(item),item])).values()];
      const record = { candidateId, codeHash, manifest: normalized, code, ...(mergedHints.length?{producerHints:mergedHints}:{}), createdAt: timestamp() };
      await appendRecord(fileFor('candidates', candidateId), record);
      return { candidateId, codeHash, manifest: normalized };
    },
    async validateAdapter({ candidateId, gameDir, workspaceDir, signal }) {
      const candidate = await readCandidate(candidateId);
      await authorizeCandidate(candidate);
      const prepared = await sourceView(candidate, gameDir, signal);
      gameDir = prepared.gameDir;
      const previous = await proofFor(candidate, gameDir, signal);
      if (previous) return { ...previous, reused: true };
      const validationId = `validation-${randomUUID()}`;
      const directory = await ensureRoot(path.join(storageRoot(), 'runs', validationId));
      const record = { validationId, candidateId, codeHash: candidate.codeHash, gameDir: path.resolve(gameDir), ...(prepared.sourceView ? { sourceView: prepared.sourceView } : {}), createdAt: timestamp(), passed: false, checks: {}, evidence: [], dependencies: { identity: dependencyIdentity, files: {}, listings: {} }, runtime: { status: 'pending', detail: '等待该游戏的实机验证' } };
      return trace.run(record, async () => {
      let hostError;
      try {
        signal?.throwIfAborted();
        record.resourceHashes = await resourceHashes(gameDir, candidate.manifest.scope.files, { signal, maxFileBytes: limits.maxFileBytes });
        const extracted = await extract(candidate, gameDir, signal);
        const second = await extract(candidate, gameDir, signal);
        if (hash(extracted.units) !== hash(second.units)) throw new Error('提取结果或稳定 ID 在重复运行时变化');
        record.checks.stableIds = 'passed';
        record.extraction = extracted;
        record.verificationPlan = await formatCatalog.plan({ units: extracted.units, manifest: candidate.manifest }).catch(error => { if (!structuralVerifier) throw error; return undefined; });
        for (const unit of extracted.units) {
          const binding = record.verificationPlan?.unitBindings?.find(item => item.id === unit.id);
          if (binding) unit.context.formatBinding = binding;
        }
        const roundtripDir = await ensureRoot(path.join(directory, 'roundtrip'));
        const returned = await run(candidate, 'roundtrip', { gameDir, outputDir: roundtripDir, input: { units: extracted.units.map(unit => ({ ...unit, source: unit.rawSource })) }, signal });
        const roundtripHashes = await resourceHashes(roundtripDir, candidate.manifest.scope.files, { signal, maxFileBytes: limits.maxFileBytes });
        if (JSON.stringify(record.resourceHashes) !== JSON.stringify(roundtripHashes) || returned.writes.length !== candidate.manifest.scope.files.length) throw new Error('原样往返未保留全部资源字节');
        record.checks.roundtrip = 'passed';
        record.extraction = extracted;
        if (extracted.units.some(unit => unit.locator.segment)) {
          if (displayVerifier) {
            record.displayReview = await verifyDisplay(displayVerifier, { ...displayInput(candidate, gameDir, signal, workspaceDir), units: extracted.units }, { candidateId, validationId });
            record.checks.display = record.displayReview?.status ?? 'pending';
            if (record.checks.display !== 'passed') throw Object.assign(new Error('命令正文显示用途尚未确认，保留候选和来源后继续补证。'), { code: record.checks.display === 'failed' ? 'ADAPTER_DISPLAY_REVIEW_FAILED' : 'ADAPTER_DISPLAY_REVIEW_PENDING', evidence: { decisions: record.displayReview?.decisions ?? [] } });
          }
          const consumerSource=representationSourceFor?await representationSourceFor({gameDir,candidate,projectId:executionContext.getStore()?.projectId,signal}):{root:gameDir};
          if(typeof consumerSource?.root!=='string')throw Object.assign(new Error('缺少宿主确认的命令消费者来源'),{code:'EMBEDDED_REPRESENTATION_PENDING'});
          record.representationContracts = await qualifyEmbeddedContracts({ gameDir, consumerGameDir:consumerSource.root, units: extracted.units, signal });
          record.checks.representation = 'passed';
        }
        const editable = extracted.units.filter(unit => unit.source.trim());
        if (!editable.length) throw new Error('请提供可改文的小样');
        const representatives = editable.length <= 16 ? editable : [...new Map([editable[0], editable[1], editable[Math.floor(editable.length / 2)], editable.at(-1),
          ...candidate.manifest.scope.files.map(file => editable.find(unit => unit.locator.file === file)).filter(Boolean)].slice(0, 16).map(unit => [unit.id, unit])).values()];
        const sampleTranslations = Object.fromEntries(representatives.map((unit, index) => [unit.id, `${unit.source}〔拼好校验${index + 1}：变长中文〕`]));
        const sampleDir = await ensureRoot(path.join(directory, 'sample'));
        await validateBuild(candidate, gameDir, extracted.units, sampleTranslations, sampleDir, signal, undefined, undefined, sampleDir);
        record.checks.sample = 'passed'; record.checks.structure = 'passed';
        record.sample = { id: representatives[0].id, ids: representatives.map(unit => unit.id), expectedHash: hash(sampleTranslations), path: sampleDir, plan: dependencyIdentity.samplePlan };
        record.extraction = extracted;
        if (displayVerifier && !record.displayReview) {
          record.displayReview = await verifyDisplay(displayVerifier, { ...displayInput(candidate, gameDir, signal, workspaceDir), units: extracted.units }, { candidateId, validationId });
          record.checks.display = record.displayReview?.status ?? 'pending';
          if (record.checks.display !== 'passed') throw Object.assign(new Error('新增文字的显示用途尚未全部确认；请根据逐项证据修正或拆分配方。'), {
            code: record.checks.display === 'failed' ? 'ADAPTER_DISPLAY_REVIEW_FAILED' : 'ADAPTER_DISPLAY_REVIEW_PENDING',
            evidence: { decisions: record.displayReview?.decisions ?? [], reason: record.displayReview?.reason },
          });
        }
        if (runtimeVerifier) {
          const runtime = await runtimeVerifier({ gameDir, sampleDir, candidate: { candidateId, manifest: candidate.manifest }, signal });
          if (!runtime || !['passed', 'failed', 'pending'].includes(runtime.status)) throw new Error('实机验证器需要提交实际状态');
          record.runtime = runtime;
        }
        const finalDigests = new Map();
        await fingerprintsMatch(gameDir, record.resourceHashes, signal, finalDigests);
        await fingerprintsMatch(gameDir, record.dependencies.files, signal, finalDigests);
        record.passed = record.runtime.status !== 'failed';
        if (record.passed && !await proofMatches(record, candidate, gameDir, signal, finalDigests)) throw new Error('验证期间资源依赖发生变化，请重新验证当前基线');
      } catch (error) {
        if (error.hostFailure) hostError = error;
        record.passed = false;
        record.failureDiagnostic = { stack: error.stack ?? null };
        if (error.code === 'ADAPTER_STRUCTURE_PENDING' || typeof error.code === 'string' && error.code.startsWith('FORMAT_') && /UNSUPPORTED|MISSING|REQUIRED|REVOKED|STALE/.test(error.code)) record.checks.structure = 'pending';
        if (error.code === 'EMBEDDED_REPRESENTATION_PENDING') { record.checks.representation = 'pending'; record.checks.sample ??= 'not-run'; }
        if (/^FORMAT_.*(?:UNSUPPORTED|MISSING|REQUIRED|REVOKED|STALE)$|^EMBEDDED_REPRESENTATION_PENDING$/.test(error.code ?? '')) record.blockedNeeds = [{ requirementRef: `requirement-${hash([record.resourceHashes,record.extraction?.units.map(unit => [unit.locator,unit.rawSource]),error.code,error.evidence?.unitId ?? null]).slice(0,40)}`, kind: error.code, missingEvidence: error.evidence ?? {}, nextActions: error.evidence?.nextActions ?? ['补充对应来源或宿主验证能力后，对原candidateId重新validate_adapter'], satisfiedBy: null }];
        if (error.kind === 'reviewer-unavailable' || error.kind === 'cancelled') {
          record.checks.display = error.kind === 'cancelled' ? 'cancelled' : 'unavailable';
          record.reviewFailure = { ...error.evidence, candidateId, validationId };
        } else if (error.code === 'ADAPTER_DISPLAY_REVIEW_FAILED') record.reviewFailure = { kind: 'candidate-rejected', candidateId, validationId, retryable: false };
        record.error = { name: error.name, message: error.message, code: error.code ?? (signal?.aborted ? 'ADAPTER_CANCELLED' : 'ADAPTER_VALIDATION_FAILED'),
          ...Object.fromEntries(['kind', 'statusCode', 'category', 'retryAfterMs', 'retryable'].filter(key => error[key] !== undefined).map(key => [key, error[key]])),
          ...(error.hostFailure ? { hostFailure: true } : {}), ...(error.evidence ? { evidence: error.evidence } : {}) };
      }
      record.finishedAt = timestamp();
      await appendRecord(fileFor('validations', validationId), record);
      if (hostError) {
        hostError.evidence = { ...hostError.evidence, candidateId, validationId, validationRecordFile: fileFor('validations', validationId) };
        throw hostError;
      }
      if (record.passed || (completeNegativeReview(record) && await proofMatches(record, candidate, gameDir, signal, new Map(), true))) {
        await appendRecord(fileFor('proofs', `proof-${hash([candidate.candidateId, path.resolve(gameDir)]).slice(0, 40)}`), { validationId });
      }
      return record;
      });
    },
    async submitRecipe({ candidateId, validationId, metadata = {} }) {
      const candidate = await readCandidate(candidateId);
      const validation = await readJson(fileFor('validations', validationId));
      if (validation.candidateId !== candidateId || validation.codeHash !== candidate.codeHash || !validation.passed || ['stableIds', 'roundtrip', 'sample', 'structure'].some(key => validation.checks[key] !== 'passed')) throw new Error('配方晋升需要主机记录的原样往返和改文小样通过结果');
      if (!await proofMatches(validation, candidate, validation.gameDir)) throw new Error('适配依赖或验证协议已变化，请重新验证配方');
      const recipeId = `recipe-${hash({ candidateId, scope: candidate.manifest.scope }).slice(0, 40)}`;
      const record = { recipeId, candidateId, codeHash: candidate.codeHash, manifest: candidate.manifest, validationId, structuralStatus: 'passed', runtime: validation.runtime, createdAt: timestamp(), toolVersions: { sandbox: 'quickjs-emscripten@0.31.0', protocol: 1 }, metadata: { summary: typeof metadata.summary === 'string' ? metadata.summary.slice(0, 3000) : '', testCases: Array.isArray(metadata.testCases) ? metadata.testCases.filter(item => typeof item === 'string').slice(0, 50) : [] } };
      await appendRecord(fileFor('recipe-candidates', candidateId, true), candidate);
      await appendRecord(fileFor('recipes', recipeId, true), record);
      return record;
    },
    async listRecipes({ engine, files } = {}) {
      const records = [];
      for (const file of (await readdir(path.join(root, 'recipes'))).filter(file => file.endsWith('.json')).sort()) {
        const record = await readJson(path.join(root, 'recipes', file));
        if ((!engine || record.manifest.engine === engine) && (!files || (record.manifest.container ? files.includes(record.manifest.container.file) : record.manifest.scope.files.every(file => files.includes(file))))) records.push(record);
      }
      return records;
    },
    async reviewDisplayCandidates({ candidates, gameDir, workspaceDir, signal }) {
      if (!displayVerifier || typeof displayVerifier.decisionsFresh !== 'function') throw Object.assign(new Error('精确显示候选的非显示结案需要独立用途复核器'), { code: 'DISPLAY_DISPOSITION_REVIEW_REQUIRED' });
      if (!Array.isArray(candidates) || !candidates.length || candidates.some(item => !item.id || !/^[a-f0-9]{64}$/.test(item.evidenceHash ?? ''))) throw new Error('用途结案需要本机当前精确候选与来源摘要');
      candidates = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
      const identity = candidates.map(item => [item.id, item.evidenceHash]);
      const candidate = { candidateId: `disposition-${hash(identity).slice(0, 40)}`, codeHash: hash(identity),
        manifest: { scope: { files: [...new Set(candidates.map(item => item.file))] } } };
      const input = { ...displayInput(candidate, gameDir, signal, workspaceDir), units: candidates.map(item => ({ id: item.id,
        source: item.source, rawSource: item.source, sourceIndex: item.sourceIndex ?? 0,
        locator: item.locator ?? { file: item.file, target: item.target }, context: { ...item.context, file: item.file } })) };
      const review = await verifyDisplay(displayVerifier, input, { candidateId: candidate.candidateId });
      if (!await displayVerifier.decisionsFresh(review, input)) throw Object.assign(new Error('独立用途复核尚未形成完整且新鲜的结论'), { code: 'DISPLAY_DISPOSITION_PENDING', evidence: { decisions: review?.decisions } });
      const proofs = candidates.map(item => {
        const verdict = review.decisions.find(row => row.id === item.id);
        if (verdict?.status !== 'non-display') throw Object.assign(new Error(`候选 ${item.id} 未被独立确认为非显示，继续追踪正文来源，不可关闭`), { code: 'DISPLAY_DISPOSITION_REJECTED', evidence: { id: item.id, status: verdict?.status, reason: verdict?.reason } });
        return { protocol: DISPLAY_DISPOSITION_PROTOCOL, id: item.id, evidenceHash: item.evidenceHash,
          status: verdict.status, reason: verdict.reason, reviewProtocol: review.protocol, dependencies: review.dependencies };
      });
      return proofs;
    },
    async listCoverageDecisions() {
      const records = [];
      const directory = await ensureRoot(path.join(root, 'coverage-recipes'));
      for (const file of (await readdir(directory)).filter(file => /^coverage-[a-f0-9]{40}\.json$/.test(file)).sort()) {
        const record = await readJson(path.join(directory, file));
        if (hasCoverageDecisionProof(record) && `coverage-${hash(record).slice(0, 40)}.json` === file) records.push(record);
      }
      return records.sort((a, b) => (Date.parse(a.decidedAt) || 0) - (Date.parse(b.decidedAt) || 0));
    },
    async saveCoverageDecisions({ decisions }) {
      for (const decision of decisions) {
        if (!hasCoverageDecisionProof(decision)) throw new Error('资源分类需要完整调查证据');
        await appendRecord(fileFor('coverage', `coverage-${hash(decision).slice(0, 40)}`), decision);
        const reusable = reusableCoverageDecision(decision);
        await appendRecord(fileFor('coverage-recipes', `coverage-${hash(reusable).slice(0, 40)}`, true), reusable);
      }
      return { saved: decisions.length };
    },
    async extractRecipe({ recipeId, gameDir, workspaceDir, signal }) {
      const recipe = await readJson(fileFor('recipes', recipeId, true));
      const candidate = await readCandidate(recipe.candidateId);
      // A reusable scope still receives the same real validation on every new resource baseline.
      const validation = await lab.validateAdapter({ candidateId: candidate.candidateId, gameDir, workspaceDir, signal });
      if (!validation.passed) throw new Error(validation.error?.message ?? '配方在当前游戏中验证未通过');
      return bindExtraction(recipe, candidate, validation, gameDir, workspaceDir, signal);
    },
    async tryRecipes({ gameDir, workspaceDir, engine, files, preferredRecipeIds = [], skipRecipeIds = [], evaluateCoverage, signal }) {
      const preferred = new Map(preferredRecipeIds.filter(Boolean).map((id, index) => [id, index]));
      const skipped = new Set(skipRecipeIds);
      const recipes = (await lab.listRecipes({ engine, files })).filter(recipe => !skipped.has(recipe.recipeId)).sort((a, b) => (preferred.get(a.recipeId) ?? Infinity) - (preferred.get(b.recipeId) ?? Infinity));
      let best;
      for (const recipe of recipes) {
        signal?.throwIfAborted();
        let evaluatingCoverage = false;
        try {
          for (const file of recipe.manifest.container ? [recipe.manifest.container.file] : recipe.manifest.scope.files) await checkedPath(gameDir, file);
          const candidate = await readCandidate(recipe.candidateId);
          const validation = await lab.validateAdapter({ candidateId: candidate.candidateId, gameDir, workspaceDir, signal });
          if (!validation.passed) continue;
          const preview = { ...validation.extraction, engine: candidate.manifest.engine, sourceFingerprint: hash(validation.resourceHashes), recipeId: recipe.recipeId,
            binding: { recipeId: recipe.recipeId, candidateId: candidate.candidateId, validationId: validation.validationId },
            validation: { ...validation.checks, runtime: validation.runtime } };
          evaluatingCoverage = true;
          const coverage = evaluateCoverage ? await evaluateCoverage(preview) : undefined;
          if (evaluateCoverage && (!coverage || typeof coverage.needsAdaptation !== 'boolean')) throw new Error('主机覆盖检查需要返回明确的资源处理状态');
          const remaining = coverage ? (coverage.summary?.unresolvedCandidates ?? coverage.dynamicCandidates?.length ?? 0)
            + (coverage.resources?.filter(item => item.kind === 'display-text-candidate').length ?? 0)
            + (coverage.extractionIssues?.length ?? 0) + (coverage.structuralRecoveryWarnings ?? 0) : 0;
          const rank = [coverage?.needsAdaptation ? 1 : 0, remaining, -preview.units.length, preferred.get(recipe.recipeId) ?? Infinity];
          if (!best || rank.some((value, index) => value < best.rank[index] && rank.slice(0, index).every((earlier, n) => earlier === best.rank[n]))) best = { recipe, candidate, validation, coverage, rank };
          if (coverage && !coverage.needsAdaptation) break;
        }
        catch (error) { if (signal?.aborted || evaluatingCoverage || error.code === 'WORKSPACE_EXECUTION_AUTH_REQUIRED') throw error; }
      }
      if (!best) return null;
      const selectedWorkspace = evaluateCoverage || preferredRecipeIds.length ? path.join(workspaceDir, best.recipe.recipeId) : workspaceDir;
      const extraction = await bindExtraction(best.recipe, best.candidate, best.validation, gameDir, selectedWorkspace, signal);
      return { ...extraction, ...(best.coverage ? { checkedCoverage: best.coverage } : {}) };
    },
    dispatch: async function dispatchAction(command, payload, signal) {
      if (!payload.workspaceDir || !['validate', 'roundtrip', 'build', 'assemble'].includes(command)) return null;
      const verified=executionContext.getStore()?.verifiedDispatch;
      const state = verified?.workspaceDir === path.resolve(payload.workspaceDir) ? verified.state : await readBinding(payload.workspaceDir, signal);
      if (!state) return null;
      const { binding, candidate } = state;
      if (binding.recordNamespace?.root && executionContext.getStore()?.recordRoot !== binding.recordNamespace.root) return executionContext.run({ ...executionContext.getStore(), recordRoot:binding.recordNamespace.root,verifiedDispatch:{workspaceDir:path.resolve(payload.workspaceDir),state} }, () => dispatchAction(command,payload,signal));
      if (command === 'validate') {
        const raw = rawTranslations(binding.units, payload.translations);
        await assertEmbeddedContractsFresh(binding.representationContracts, binding.gameDir);
        for (const unit of binding.units.filter(item => item.locator.segment)) if (Object.hasOwn(raw, unit.id)) encodeEmbeddedTarget({ before: unit.locator.segment.prefix + unit.rawSource + unit.locator.segment.suffix, source: unit.rawSource, target: raw[unit.id], contract: binding.representationContracts?.[unit.id] });
        const result = (await run(candidate, 'validate', { gameDir: binding.gameDir, input: { units: binding.units.map(unit => ({ ...unit, source: unit.rawSource })), translations: raw, representationContracts: guestContracts(binding.representationContracts) }, signal })).result;
        if (result === false || result?.valid === false) throw new Error(result?.message || '适配器结构校验未通过');
        return { valid: true, unitCount: binding.units.length };
      }
      if (command === 'roundtrip') {
        const validation = await lab.validateAdapter({ candidateId: binding.candidateId, gameDir: binding.gameDir, signal });
        if (!validation.passed) throw new Error(validation.error?.message || '原样往返验证未通过');
        return { passed: true, ...validation.checks, runtime: validation.runtime };
      }
      if (command === 'build') {
        const output = await independentRoot(binding.gameDir, payload.outputDir);
        return validateBuild(candidate, binding.gameDir, binding.units, payload.translations, output, signal, binding.representationContracts ?? {}, binding.verificationPlan);
      }
      const buildPointer = await readJson(fileFor('build-pointers',`build-${hash([candidate.candidateId,path.resolve(payload.buildDir)]).slice(0,40)}`));
      await lab.assertBuildOutputFresh({ workspaceDir:payload.workspaceDir,buildDir:payload.buildDir,buildReceiptId:buildPointer.buildReceiptId,signal });
      await copyTree(binding.sourceView?.originalGameDir ?? binding.gameDir, payload.outputDir, signal);
      const files = await listFiles(payload.buildDir);
      if (files.truncated) throw new Error('成品覆盖文件数量达到上限');
      for (const file of files.files) {
        if (!candidate.manifest.scope.files.includes(file.path)) throw new Error('成品包含未声明的适配资源');
        if (binding.sourceView) continue;
        const target = await checkedPath(payload.outputDir, file.path, { write: true });
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(await checkedPath(payload.buildDir, file.path), target);
      }
      let assembled;
      if (binding.sourceView) {
        if (!archiveResolver?.repackArchive) throw new Error('归档组装需要已登记的封包能力');
        const staging = await ensureRoot(path.join(storageRoot(), 'runs', `repack-${randomUUID()}`));
        const outputFile = path.join(staging, path.basename(binding.sourceView.container.file));
        // The codec overlays only changed members on the complete original archive.
        assembled = await archiveResolver.repackArchive({ gameDir: binding.sourceView.originalGameDir, container: binding.sourceView.container, inputDir: payload.buildDir, outputFile, signal });
        const target = await checkedPath(payload.outputDir, binding.sourceView.container.file, { write: true });
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(outputFile, target);
      } else assembled = (await run(candidate, 'assemble', { gameDir: payload.outputDir, input: { files: files.files }, signal })).result;
      const finalView = await sourceView(candidate,payload.outputDir,signal);
      await lab.assertBuildOutputFresh({ workspaceDir:payload.workspaceDir,buildDir:payload.buildDir,buildReceiptId:buildPointer.buildReceiptId,outputDir:finalView.gameDir,strictResourceHashes:true,signal });
      const inventory = await listFiles(payload.outputDir);
      const entries = inventory.files.filter(file => /\.exe$/i.test(file.path));
      const preferred = candidate.manifest.launchFile ?? (entries.some(file => file.path === 'Game.exe') ? 'Game.exe' : entries.length === 1 ? entries[0].path : undefined);
      const launchPath = preferred ? await checkedPath(payload.outputDir, preferred) : undefined;
      if (launchPath && !(await lstat(launchPath)).isFile()) throw new Error('配方启动入口须为普通文件');
      return { outputDir: payload.outputDir, files: files.files.length, ...(launchPath ? { launchPath } : { sourceOnly: true }), structuralStatus: 'passed', runtime: binding.runtime, adapterResult: assembled };
    },
    async runTool({ tool, args = [], gameDir, workDir, signal }) {
      const descriptor = toolCatalog[tool];
      if (!descriptor || (typeof descriptor.command !== 'string' && typeof descriptor.execute !== 'function') || typeof descriptor.validateArgs !== 'function' || !Array.isArray(args) || !args.every(arg => typeof arg === 'string') || !descriptor.validateArgs(args)) throw new Error('请使用已注册的可信工具及参数');
      workDir = await independentRoot(gameDir, workDir);
      if (typeof descriptor.execute === 'function') {
        signal?.throwIfAborted();
        return executeTrustedCallback(descriptor, { args: [...args], gameDir, workDir, signal });
      }
      if (!path.isAbsolute(descriptor.command)) throw new Error('可信工具需要固定的绝对路径');
      if (!descriptor.toolRoot || !path.isAbsolute(descriptor.toolRoot)) throw new Error('可信工具需要固定的工具目录');
      const relativeCommand = path.relative(descriptor.toolRoot, descriptor.command).replaceAll(path.sep, '/');
      const commandPath = await checkedPath(descriptor.toolRoot, relativeCommand);
      if (!(await lstat(commandPath)).isFile()) throw new Error('可信工具需要普通可执行文件');
      let stdout = '', stderr = '', running, captured = 0, truncated = false;
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
      const chunks = { stdout: [], stderr: [] };
      const max = descriptor.maxOutputBytes ?? 1024 * 1024;
      const append = key => chunk => {
        const bytes = chunk.subarray(0, Math.max(0, max - captured));
        captured += bytes.length; chunks[key].push(bytes);
        if (key === 'stdout') stdout += decoders[key].write(bytes); else stderr += decoders[key].write(bytes);
        if (bytes.length !== chunk.length) { truncated = true; running.stop(Object.assign(new Error('可信工具输出达到记录上限'), { code: 'ADAPTER_TOOL_OUTPUT_LIMIT' })); }
      };
      running = launchManagedProcess({ program: commandPath, args: [...(descriptor.prefixArgs ?? []), ...args], cwd: workDir, signal,
        env: processEnvironment({ PATH: path.dirname(commandPath), TEMP: workDir, TMP: workDir }), timeoutMs: descriptor.timeoutMs ?? 30000,
        onStdout: append('stdout'), onStderr: append('stderr') });
      let result, failure;
      try { result = await running.completion; } catch (error) { failure = error; }
      stdout += decoders.stdout.end(); stderr += decoders.stderr.end();
      const captureId = `tool-${randomUUID()}`, captureDir = await ensureRoot(path.join(workDir, 'tool-output', captureId));
      for (const key of ['stdout','stderr']) {
        const handle = await open(await checkedPath(captureDir, `${key}.bin`, { write: true }), 'wx');
        try { await handle.writeFile(Buffer.concat(chunks[key])); await handle.sync(); } finally { await handle.close(); }
      }
      const evidence = { captureId, captureDir, stdoutBytes: chunks.stdout.reduce((sum,bytes) => sum + bytes.length,0), stderrBytes: chunks.stderr.reduce((sum,bytes) => sum + bytes.length,0), finalized: true, truncated };
      if (failure) { failure.evidence = { ...failure.evidence, ...evidence, stdout, stderr }; throw failure; }
      return { tool, ...result, stdout, stderr, truncated, capture: evidence };
    },
  };
  for (const [name, method] of Object.entries(lab)) {
    lab[name] = (...args) => {
      const input = name === 'dispatch' ? args[1] : args[0];
      const previous = executionContext.getStore();
      const projectId = input?.projectId ?? previous?.projectId;
      // workspaceDir can be a newly created extraction binding, not a record namespace.
      const workDir = (projectId && workspaceFor?.({ projectId })) || input?.workDir || (projectId === previous?.projectId ? previous?.workDir : undefined) || input?.workspaceDir;
      const requestContext = input?.requestContext ?? previous?.requestContext;
      return executionContext.run({ ...previous, ...(projectId ? { projectId, workDir } : {}), ...(requestContext ? { requestContext } : {}) }, () => method(...args));
    };
  }
  return lab;
}

export { actions as ADAPTER_ACTIONS };
