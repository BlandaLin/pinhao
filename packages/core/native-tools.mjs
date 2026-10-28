import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { checkedPath } from '../technical/adaptation/paths.mjs';
import { createEvidenceStore } from '../technical/adaptation/evidence.mjs';
import { unitFileMatches } from '../technical/adaptation/unit-location.mjs';
import { nativeWorkerError, registerNativeFailure } from '../technical/adaptation/native-failure.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export const passedNativeRoundtrip = value => value?.valid !== false && value?.passed !== false
  && (value?.byteIdentical !== false || value?.nativeSemanticRoundtrip === true && value?.status === 'native_roundtrip_structurally_equal');
const fileHash = async file => {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
};
const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

async function releaseSuccessfulSample({ sampleDir, reviewDir, reviewRoot, signal }) {
  if (signal?.aborted) return { status: 'retained', reason: 'cancelled' };
  try {
    const entry = await lstat(sampleDir), currentRoot = await realpath(reviewDir), actual = await realpath(sampleDir);
    if (!entry.isDirectory() || entry.isSymbolicLink() || currentRoot !== reviewRoot || actual !== sampleDir
        || path.dirname(actual) !== reviewRoot || !/^s-[a-f0-9]{32}$/.test(path.basename(actual))) {
      return { status: 'retained', reason: 'ownership-unconfirmed' };
    }
    if (signal?.aborted) return { status: 'retained', reason: 'cancelled' };
    await rm(actual, { recursive: true, force: false, maxRetries: 3, retryDelay: 30 });
    return { status: 'released' };
  } catch (error) {
    return { status: 'retained', reason: 'cleanup-error', error: { code: error.code, message: String(error.message ?? error) } };
  }
}

export async function nativeWorkbenchIdentity(workspaceDir) {
  const root = await realpath(workspaceDir);
  let metadataHash;
  try { metadataHash = await fileHash(path.join(root, 'technical', 'product-source.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { workspaceDir: root, manifestHash: await fileHash(path.join(root, 'manifest.json')),
    ...(metadataHash ? { metadataHash } : {}) };
}

function pageOptions(args) {
  const result = { offset: 0, limit: 20 };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!['--offset', '--limit', '--file'].includes(name) || value === undefined || Object.hasOwn(result, name)) throw new Error('原生文字分页参数无效');
    result[name] = true;
    if (name === '--file') {
      if (path.isAbsolute(value) || value.includes(':') || value.split(/[\\/]/).includes('..')) throw new Error('原生资源使用相对文件名');
      result.file = value.replaceAll('\\', '/');
    } else result[name.slice(2)] = Number(value);
  }
  if (!Number.isSafeInteger(result.offset) || result.offset < 0 || !Number.isSafeInteger(result.limit) || result.limit < 1 || result.limit > 50) throw new Error('原生文字分页范围无效');
  return result;
}

function reviewOptions(args) {
  const options = {}, seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!['--file', '--group', '--offset', '--limit'].includes(name) || value === undefined || seen.has(name)) throw new Error('原生对象检查参数无效');
    seen.add(name);
    if (name === '--file') {
      if (path.isAbsolute(value) || value.includes(':') || value.split(/[\\/]/).some(part => part === '..' || part === '.')) throw new Error('原生对象检查使用相对资源路径');
      options.file = value.replaceAll('\\', '/');
    } else if (name === '--group') options.groupId = value;
    else options[name.slice(2)] = Number(value);
  }
  if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0)
      || options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 12)) throw new Error('原生对象检查分页范围无效');
  return options;
}

function reviewDecisions(args) {
  if (args.length !== 1) throw new Error('原生字段决定需要一份 JSON 记录');
  const parsed = JSON.parse(args[0]), decisions = Array.isArray(parsed) ? parsed : [parsed];
  const fieldKinds = new Set(['display_text', 'ui_text', 'localized_string', 'dialogue', 'speaker_name', 'description', 'message', 'paragraph', 'menu']);
  const validFields = fields => Array.isArray(fields) && fields.length <= 256 && fields.every(field => field && typeof field === 'object'
    && Object.keys(field).every(key => ['path', 'kind', 'displaySites'].includes(key)) && (field.kind === undefined || fieldKinds.has(field.kind))
    && (field.displaySites === undefined || Array.isArray(field.displaySites) && field.displaySites.every(site => typeof site === 'string' && site.trim().length > 0))
    && Array.isArray(field.path) && field.path.length >= 1 && field.path.length <= 64
    && field.path.every(step => typeof step === 'string' && step.length > 0 || Number.isSafeInteger(step) && step >= 0));
  if (!decisions.length || decisions.length > 50 || new Set(decisions.map(item => item?.groupId)).size !== decisions.length
    || decisions.some(item => !item || typeof item.groupId !== 'string' || !item.groupId
    || Object.keys(item).some(key => !['groupId', 'evidenceHash', 'disposition', 'fields', 'reason', 'file'].includes(key))
    || !/^[a-f0-9]{64}$/.test(item.evidenceHash) || !['display', 'non-display'].includes(item.disposition)
    || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 4000
    || item.file !== undefined && typeof item.file !== 'string'
    || item.fields !== undefined && !validFields(item.fields)
    || item.disposition === 'display' && (!Array.isArray(item.fields) || !item.fields.length)
    || item.disposition === 'non-display' && item.fields?.length)) throw new Error('原生字段决定需要当前组编号、证据摘要、显示字段和判定依据；每批至多50组、每组至多256个字段、字段路径至多64段、依据至多4000字');
  return decisions;
}

/** Native codecs retain their full result on the host; the model receives a small handle. */
export function createNativeTools({ worker }) {
  const cache = new Map();
  const sourceMetadata = new Map(), sourceBaselines = new Map(), materializedSources = new Map();
  const reviews = new Map();
  const reviewAnswers = new Map(), reviewWorkbenches = new Map();
  const seeded = new WeakSet();
  const call = async (command, input, signal) => {
    const result = await worker(command, input, { signal });
    if (result?.ok === false) throw nativeWorkerError(result.error);
    return result?.ok === true && Object.hasOwn(result, 'result') ? result.result : result;
  };
  const stamp = async file => {
    const info = await lstat(file, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('归档与已展开资源需要普通文件');
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  };
  const verifySource = async (file, expected) => {
    const version = await stamp(file), key = JSON.stringify([file, version, expected]);
    let baseline = sourceBaselines.get(key);
    if (!baseline) {
      baseline = (async () => {
        if (await fileHash(file) !== expected || await stamp(file) !== version) {
          throw Object.assign(new Error('原归档与提取基线不同，请重新提取'), { code: 'SOURCE_CHANGED' });
        }
      })();
      sourceBaselines.set(key, baseline);
      baseline.catch(() => sourceBaselines.delete(key));
    }
    await baseline;
    return version;
  };
  const materializeSource = async ({ gameDir, workspaceDir, files, signal }) => {
    const metadataFile = path.join(workspaceDir, 'technical', 'product-source.json');
    let version;
    try { version = await stamp(metadataFile); }
    catch (error) { if (error.code === 'ENOENT') return { archived: false, materialized: 0, sourceRoot: gameDir }; throw error; }
    let record = sourceMetadata.get(metadataFile);
    if (record?.version !== version) {
      record = { version, metadata: JSON.parse(await readFile(metadataFile, 'utf8')) };
      sourceMetadata.set(metadataFile, record);
    }
    const metadata = record.metadata;
    if (metadata.archiveFormat !== 'asar') return { archived: false, materialized: 0, sourceRoot: metadata.nativeSource ?? gameDir };
    if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string' || !file
        || path.isAbsolute(file) || file.includes(':') || file.split(/[\\/]/).some(part => !part || part === '.' || part === '..'))) throw new Error('归档成员需要相对文件路径');
    const archive = await checkedPath(gameDir, metadata.archiveLayouts.archive);
    const archiveVersion = await verifySource(archive, metadata.sourceFiles?.[metadata.archiveLayouts.archive]);
    let count = 0;
    for (const file of [...new Set(files)]) {
      signal?.throwIfAborted();
      const relative = file.replaceAll('\\', '/');
      const root = metadata.root.replaceAll('\\', '/').replace(/\/$/, '');
      if (!relative.startsWith(`${root}/`)) throw new Error('归档成员不在当前资源根目录中');
      const member = relative.slice(root.length + 1);
      const descriptor = metadata.archiveLayouts.members.find(row => row.file === member);
      if (!descriptor) throw new Error('归档成员未登记');
      const sourceVersion = descriptor.unpacked ? await verifySource(await checkedPath(`${archive}.unpacked`, member),
        metadata.sourceFiles?.[`${metadata.archiveLayouts.archive}.unpacked/${member}`]) : archiveVersion;
      const key = JSON.stringify([path.resolve(gameDir), path.resolve(workspaceDir), version, archiveVersion, sourceVersion, relative]);
      let current;
      try { current = await stamp(await checkedPath(metadata.nativeSource, relative)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const known = materializedSources.get(key);
      if (known?.promise) { await known.promise; count++; continue; }
      if (known?.version === current && current !== undefined) { count++; continue; }
      const pending = { promise: call('materialize_source', { gameDir, workspaceDir, files: [relative] }, signal) };
      materializedSources.set(key, pending);
      try {
        const result = await pending.promise;
        if (path.resolve(result.sourceRoot) !== path.resolve(metadata.nativeSource)) throw new Error('归档展开资源根目录不一致');
        pending.version = await stamp(await checkedPath(metadata.nativeSource, relative));
        delete pending.promise;
      } catch (error) { materializedSources.delete(key); throw error; }
      count++;
    }
    return { archived: true, materialized: count, sourceRoot: metadata.nativeSource };
  };
  const fileFor = workDir => path.join(workDir, 'host-native-result.json');
  const load = async ({ gameDir, workDir }) => {
    const key = path.resolve(workDir);
    let record = cache.get(key);
    if (!record) record = [...cache.entries()].filter(([root, candidate]) => seeded.has(candidate) && within(root, key))
      .sort(([left], [right]) => right.length - left.length)[0]?.[1];
    if (!record) {
      const saved = JSON.parse(await readFile(fileFor(key), 'utf8'));
      if (saved.format !== 'pinhao-native-result-1') throw new Error('原生提取记录格式无效');
      record = saved;
      cache.set(key, record);
    }
    if (record.gameDir !== await realpath(gameDir)) throw new Error('原生提取记录与当前资源不一致');
    const workspace = await realpath(record.extraction.workspaceDir ?? record.extraction.workDir);
    if (!seeded.has(record) && !within(await realpath(workDir), workspace)) throw new Error('原生提取结果需要当前任务的独立工作台');
    const manifest = await readFile(path.join(workspace, 'manifest.json'));
    if (hash(manifest) !== record.manifestHash) throw new Error('原生提取清单已改变，请重新提取');
    for (const [file, expected] of Object.entries(record.sourceFiles ?? {})) {
      if (await fileHash(await checkedPath(gameDir, file)) !== expected) throw new Error('原生输入资源已改变，请重新建立技术任务');
    }
    return record;
  };
  const summary = record => ({ nativeResultId: record.id, engine: record.probe.engine,
    unitCount: record.extraction.units.length, files: record.extraction.files,
    workspace: path.basename(record.extraction.workspaceDir ?? record.extraction.workDir),
    ...(record.nativeFailure ? { nativeFailure: record.nativeFailure } : {}),
    nextAction: 'native_inspect 分页检查文字；native_accept 执行原样回写并接入制作' });
  const accept = async input => {
    const record = await load(input);
    record.validation = undefined;
    const validation = await call('roundtrip', { workspaceDir: record.extraction.workspaceDir ?? record.extraction.workDir }, input.signal);
    if (!passedNativeRoundtrip(validation)) throw new Error('原生回写检查仍有待处理项');
    record.validation = validation;
    return record;
  };
  const formats = ['zip', 'xp3', 'rgss', 'rgssad', 'pck'];
  const archiveInput = args => args.length >= 1 && args.length <= 2 && (!args[1] || formats.includes(args[1]));
  const resolveArchive = async ({ gameDir, workDir, container, signal }) => {
    const archive = await checkedPath(gameDir, container.file);
    const archiveHash = await fileHash(archive);
    const artifactId = `archive-${hash(JSON.stringify([container.file, container.format ?? '', archiveHash])).slice(0, 40)}`;
    const outputDir = path.join(workDir, 'native-archives', artifactId);
    await mkdir(path.dirname(outputDir), { recursive: true });
    const unpacked = await call('native_unpack', { archive, outputDir, ...(container.format ? { format: container.format } : {}) }, signal);
    if (unpacked.archiveHash !== archiveHash) throw new Error('归档在解包期间发生变化，请从当前基线继续');
    return { ...unpacked, artifactId, archiveHash, sourceDir: await realpath(unpacked.outputDir ?? outputDir), container: { file: container.file, format: unpacked.format ?? container.format } };
  };
  const repackArchive = async ({ gameDir, container, inputDir, outputFile, signal }) => {
    const originalArchive = await checkedPath(gameDir, container.file);
    return call('native_repack', { inputDir, outputFile, format: container.format, originalArchive }, signal);
  };
  const resolveFinalView = async ({gameDir,outputDir,nativeWorkspaceDir,files,workDir,signal}) => {
    const pending = message => Object.assign(new Error(message),{code:'FORMAT_FINAL_VIEW_REQUIRED'});
    if(!nativeWorkspaceDir||!Array.isArray(files)||!files.length)throw pending('缺少原生工作台的容器来源和最终成员范围');
    let metadataBytes;
    try{metadataBytes=await readFile(await checkedPath(nativeWorkspaceDir,'technical/product-source.json'));}
    catch(error){if(error.code==='ENOENT')throw pending('原生工作台没有可核对的容器来源记录');throw error;}
    const metadata=JSON.parse(metadataBytes),metadataHash=hash(metadataBytes);
    if(metadata.schema!=='pinhao-native-source-v1'||metadata.packed!==true||!metadata.nativeSource||!Array.isArray(metadata.archives)||!metadata.archives.length||!metadata.sourceFiles)throw pending('原生容器来源记录不完整，不能猜测最终成员位置');
    const relative = value => {if(typeof value!=='string'||!value||path.isAbsolute(value)||value.includes(':')||value.split(/[\\/]/).some(part=>!part||part==='.'||part==='..'))throw pending('原生成员或容器定位无效');return value.replaceAll('\\','/');};
    const archives=metadata.archives.map(relative),root=metadata.root==='.'||!metadata.root?'':relative(metadata.root),requested=[...new Set(files.map(relative))].sort();
    const kindOf=file=>({godot:'pck','nwjs-zip':'zip',rgssad:'rgss',rgss2a:'rgss',rgss3a:'rgss'}[metadata.archiveFormat]??metadata.archiveFormat??(metadata.engine==='Godot'&&metadata.godot?'pck':({rgssad:'rgss',rgss2a:'rgss',rgss3a:'rgss'}[path.extname(file).slice(1).toLowerCase()]??path.extname(file).slice(1).toLowerCase())));
    if(archives.some(file=>!['pck','zip','xp3','rgss','asar'].includes(kindOf(file))))throw pending('该原生容器还没有已登记的最终成员读取器');
    for(const archive of archives){
      if(!/^[a-f0-9]{64}$/.test(metadata.sourceFiles[archive]??''))throw pending('原生容器缺少已验证的原版摘要');
      await verifySource(await checkedPath(gameDir,archive),metadata.sourceFiles[archive]);
    }
    const grouped=new Map(),loose=[],artifactFiles=new Set(archives);
    for(const file of requested){
      if(Object.hasOwn(metadata.sourceFiles,file)&&!archives.includes(file)){
        await verifySource(await checkedPath(gameDir,file),metadata.sourceFiles[file]);loose.push(file);artifactFiles.add(file);continue;
      }
      const member=root?(file.startsWith(`${root}/`)?file.slice(root.length+1):null):file;
      if(!member)throw pending('待验证成员不在已登记的资源根目录中');
      let archive;
      if(metadata.archiveFormat==='xp3'&&Array.isArray(metadata.archiveLayouts)){
        for(const layout of metadata.archiveLayouts)if(layout.active!==false&&Array.isArray(layout.members)&&layout.members.includes(member)&&archives.includes(layout.file))archive=layout.file;
      }else if(archives.length===1)archive=archives[0];
      if(!archive)throw pending('多个原生容器之间缺少当前成员的已验证装载归属');
      const group=grouped.get(archive)??[];group.push({file,member});grouped.set(archive,group);
      if(kindOf(archive)==='asar'){
        const descriptor=metadata.archiveLayouts?.members?.find(row=>row.file===member);
        if(!descriptor)throw pending('ASAR成员不在宿主登记的索引中');
        if(descriptor.unpacked)artifactFiles.add(`${archive}.unpacked/${member}`);
      }
    }
    const artifactHashes=Object.fromEntries(await Promise.all([...artifactFiles].sort().map(async file=>[file,await fileHash(await checkedPath(outputDir,file))])));
    await mkdir(workDir,{recursive:true});const reviewRoot=await realpath(workDir),attemptRoot=path.join(reviewRoot,`s-${randomUUID().replaceAll('-','')}`),sourceDir=path.join(attemptRoot,'view'),groupsDir=path.join(attemptRoot,'members');
    await mkdir(sourceDir,{recursive:true});
    const publish=async(file,input)=>{
      const target=await checkedPath(sourceDir,file,{write:true});await mkdir(path.dirname(target),{recursive:true});
      try{if(await fileHash(target)!==await fileHash(input))throw Object.assign(new Error('已验证的最终成员副本发生变化'),{code:'FORMAT_SOURCE_STALE'});}
      catch(error){if(error.code!=='ENOENT')throw error;await copyFile(input,target);}
    };
    for(const file of loose)await publish(file,await checkedPath(outputDir,file));
    for(const [archive,rows] of grouped){
      signal?.throwIfAborted();const target=path.join(groupsDir,hash(archive).slice(0,24));
      const result=await call('native_unpack',{archive:await checkedPath(outputDir,archive),outputDir:target,format:kindOf(archive),files:rows.map(row=>row.member)},signal);
      if(result.archiveHash!==artifactHashes[archive]||result.files!==rows.length)throw Object.assign(new Error('最终容器成员回读与宿主范围不一致'),{code:'FORMAT_SOURCE_STALE'});
      for(const row of rows)await publish(row.file,await checkedPath(result.outputDir??target,row.member));
    }
    for(const [file,expected] of Object.entries(artifactHashes))if(await fileHash(await checkedPath(outputDir,file))!==expected)throw Object.assign(new Error('最终容器在成员验证期间发生变化'),{code:'FORMAT_SOURCE_STALE'});
    return{sourceDir,artifactDir:path.resolve(outputDir),artifactFiles:[...artifactFiles].sort(),artifactHashes,nativeMetadataRef:{workspaceDir:path.resolve(nativeWorkspaceDir),sha256:metadataHash},
      release:()=>releaseSuccessfulSample({sampleDir:attemptRoot,reviewDir:reviewRoot,reviewRoot,signal}),temporaryReadbackDir:attemptRoot};
  };
  const allocateReviewWorkbench = async ({ workDir, reviewDir, sample = false }) => {
    await mkdir(reviewDir, { recursive: true });
    const root = await realpath(reviewDir), workspaceDir = path.join(root, `${sample ? 's-' : ''}${randomUUID().replaceAll('-', '')}`);
    reviewWorkbenches.set(workspaceDir, { workspaceDir, root, workDir: path.resolve(workDir), status: 'pending' });
    return workspaceDir;
  };
  const finishReviewWorkbench = async ({ workspaceDir, evidenceDir, status, ...details }) => {
    const entry = reviewWorkbenches.get(workspaceDir);
    if (!entry) throw new Error('原生工作副本未登记');
    entry.status = status;
    if (details.stageHash) { entry.stageHash = details.stageHash; entry.stageFile = details.stageFile; }
    // Persist validation and failure evidence before any private generation is reclaimed.
    try {
      const saved = await createEvidenceStore(evidenceDir ?? entry.workDir).save(details,
        { tool: 'native_review_decide', kind: 'native-workbench-lifecycle' });
      entry.evidenceId = saved.evidenceId;
      delete entry.evidenceError;
    } catch (error) { entry.evidenceError = { code: error.code, message: String(error.message ?? error) }; }
  };
  const validateReviewReceipt = async (receipt, gameDir, signal) => {
    const workspaceDir = receipt.extraction.workspaceDir ?? receipt.extraction.workDir;
    if (JSON.stringify(await nativeWorkbenchIdentity(workspaceDir)) !== JSON.stringify(receipt.resultIdentity)) throw new Error('已验证的原生工作台已改变，请重新提交字段决定');
    let metadata;
    try { metadata = JSON.parse(await readFile(path.join(workspaceDir, 'technical', 'product-source.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const [file, expected] of Object.entries(metadata?.sourceFiles ?? {})) {
      if (await fileHash(await checkedPath(gameDir, file)) !== expected) throw new Error('原生输入资源已改变，请重新建立技术任务');
    }
    const validation = await call('roundtrip', { workspaceDir }, signal);
    if (!passedNativeRoundtrip(validation)) throw new Error('原生字段的无改动回写检查失败');
  };
  return {
    materializeSource,
    resolveArchive,
    repackArchive,
    resolveFinalView,
    allocateReviewWorkbench,
    finishReviewWorkbench,
    async restoreNativeReviews({ gameDir, workDir, projectDir, retained = [], signal }) {
      const receipts = [], failures = [], projectRoot = await realpath(projectDir), sourceRoot = await realpath(gameDir);
      for (const entry of retained) {
        if (entry.status !== 'verified' || !/^[a-f0-9]{64}$/.test(entry.stageHash ?? '')) continue;
        const registered = { ...entry, scopeDir: path.resolve(workDir) };
        reviewWorkbenches.set(entry.workspaceDir, registered);
        try {
          signal?.throwIfAborted();
          const workspaceDir = await realpath(entry.workspaceDir), info = await lstat(entry.workspaceDir);
          const reviewRoot = await realpath(path.join(projectRoot, 'nr')), owner = await realpath(entry.workDir);
          if (!info.isDirectory() || info.isSymbolicLink() || workspaceDir !== entry.workspaceDir || entry.root !== reviewRoot
              || path.dirname(reviewRoot) !== projectRoot || path.dirname(workspaceDir) !== reviewRoot || !/^[a-f0-9]{32}$/.test(path.basename(workspaceDir))
              || owner !== entry.workDir || !within(path.join(projectRoot, 'technical'), owner)) throw new Error('待接入候选的主机目录归属不一致');
          const readEvidence = async id => {
            if (!/^evidence-[a-f0-9]{64}$/.test(id ?? '')) throw new Error('待接入候选缺少有效证据编号');
            const record = JSON.parse(await readFile(await checkedPath(owner, `evidence/${id}.json`), 'utf8'));
            if (record.evidenceId !== id || `evidence-${hash(JSON.stringify(record.value))}` !== id) throw new Error('待接入候选的验证证据已改变');
            return record;
          };
          const proof = await readEvidence(entry.evidenceId), saved = proof.value;
          const stageFile = await checkedPath(workspaceDir, 'technical/pinhao-native-extraction.json'), stage = await readFile(stageFile);
          if (proof.metadata?.kind !== 'native-workbench-lifecycle' || saved.gameDir !== sourceRoot || saved.workDir !== owner
              || saved.stageFile !== stageFile || entry.stageFile !== stageFile || saved.stageHash !== entry.stageHash || hash(stage) !== entry.stageHash
              || saved.validation?.roundtrip !== 'passed' || !['passed', 'not-required'].includes(saved.validation?.sample)) throw new Error('待接入候选的任务、阶段文件或验证身份不一致');
          const { extraction } = JSON.parse(stage);
          if (!Array.isArray(extraction?.units) || (extraction.workspaceDir ?? extraction.workDir) !== workspaceDir
              || saved.resultIdentity?.workspaceDir !== workspaceDir || !saved.decisions?.length || saved.decisions.some(decision => !decision.file
                || !extraction.nativeReviewDecisions?.some(actual => hash(JSON.stringify(actual)) === hash(JSON.stringify(decision))))) throw new Error('待接入候选缺少完整文字定位或已验证决定');
          const validation = structuredClone(saved.validation);
          if (validation.sample === 'passed') {
            const sample = await readEvidence(validation.sampleDetails?.evidenceId);
            if (sample.metadata?.kind !== 'native-sample-validation' || hash(JSON.stringify(sample.value.units)) !== hash(JSON.stringify(validation.sampleDetails.units))) throw new Error('待接入候选的小样验证证据不一致');
            validation.sampleDetails.report = sample.value.report;
          }
          const receipt = { id: saved.receiptId, gameDir: sourceRoot, workDir: owner, baseline: saved.baseline, extraction,
            resultIdentity: saved.resultIdentity, decisions: saved.decisions, files: [...new Set(saved.decisions.map(item => item.file))], validation,
            releaseScope: path.resolve(workDir) };
          if (!/^native-review-/.test(receipt.id ?? '') || !receipt.baseline) throw new Error('待接入候选缺少主机签发的原生记录');
          await validateReviewReceipt(receipt, gameDir, signal);
          reviews.set(receipt.id, receipt); receipts.push({ id: receipt.id, workDir: owner });
        } catch (error) {
          if (signal?.aborted) throw error;
          registered.status = 'invalid'; registered.restoreError = { code: error.code ?? 'NATIVE_REVIEW_RESTORE_INVALID', message: String(error.message ?? error) };
          failures.push({ workspaceDir: entry.workspaceDir, ...registered.restoreError });
        }
      }
      return { receipts, failures };
    },
    commitReviewWorkbenches({ workspaceDirs }) {
      for (const workspaceDir of workspaceDirs) {
        const entry = reviewWorkbenches.get(workspaceDir);
        if (entry?.status === 'verified') entry.status = 'committed';
      }
    },
    async settleReviewWorkbenches({ workDir, projectDir, keep = [], retained = [] }) {
      const scope = path.resolve(workDir), projectRoot = await realpath(projectDir);
      const allowedRoots = await Promise.all(['nr', 'nf'].map(async name => {
        try { const root = await realpath(path.join(projectRoot, name)); return path.dirname(root) === projectRoot ? root : undefined; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }));
      const entries = new Map(retained.map(entry => [entry.workspaceDir, entry]));
      for (const [file, entry] of reviewWorkbenches) if (within(scope, entry.scopeDir ?? entry.workDir) || entries.has(file)) entries.set(file, entry);
      const protectedPaths = keep.filter(Boolean).map(file => path.resolve(file));
      const failures = [...entries.values()].filter(entry => entry.status === 'failed').slice(-2);
      const preserved = new Set(failures.map(entry => entry.workspaceDir)), kept = [], results = [];
      for (const entry of entries.values()) {
        const file = entry.workspaceDir;
        if (['pending', 'verified', 'invalid'].includes(entry.status) || preserved.has(file)
            || protectedPaths.some(protectedPath => within(file, protectedPath) || within(protectedPath, file))) {
          kept.push(entry); continue;
        }
        let result;
        try {
          const info = await lstat(file), root = await realpath(entry.root), actual = await realpath(file);
          if (!info.isDirectory() || info.isSymbolicLink() || root !== entry.root || !allowedRoots.includes(root)
              || actual !== file || path.dirname(actual) !== root || !/^(s-)?[a-f0-9]{32}$/.test(path.basename(actual))
              || !entry.evidenceId || entry.evidenceError) result = { status: 'retained', reason: 'ownership-or-evidence-unconfirmed' };
          else {
            await rm(actual, { recursive: true, force: false, maxRetries: 3, retryDelay: 30 });
            result = { status: 'released' };
          }
        } catch (error) {
          result = error.code === 'ENOENT' ? { status: 'absent' }
            : { status: 'retained', reason: 'cleanup-error', error: { code: error.code, message: String(error.message ?? error) } };
        }
        results.push({ workspaceDir: file, ...result });
        if (result.status === 'retained') kept.push({ ...entry, cleanup: result });
        else reviewWorkbenches.delete(file);
      }
      return { retained: kept, results };
    },
    // Release only after the task and its concurrent tools have settled.
    release({ workDir } = {}) {
      const root = workDir === undefined ? undefined : path.resolve(workDir);
      for (const key of sourceMetadata.keys()) if (root === undefined || within(root, key)) sourceMetadata.delete(key);
      for (const key of materializedSources.keys()) if (root === undefined || within(root, JSON.parse(key)[1])) materializedSources.delete(key);
      if (root === undefined) sourceBaselines.clear();
      let released = 0;
      for (const [key, record] of cache) {
        if (root !== undefined && !within(root, key)) continue;
        seeded.delete(record);
        cache.delete(key);
        released++;
      }
      for (const [key, receipt] of reviews) if (root === undefined || within(root, receipt.releaseScope ?? receipt.workDir)) reviews.delete(key);
      for (const [key, answer] of reviewAnswers) if (root === undefined || within(root, answer.workDir)) reviewAnswers.delete(key);
      for (const [key, entry] of reviewWorkbenches) if (root === undefined || within(root, entry.scopeDir ?? entry.workDir)) reviewWorkbenches.delete(key);
      return released;
    },
    async seed({ gameDir, workDir, extraction, probe, reviewDir }) {
      const manifestHash = hash(await readFile(path.join(extraction.workspaceDir ?? extraction.workDir, 'manifest.json')));
      const record = { format: 'pinhao-native-result-1', id: `native-${randomUUID()}`,
        gameDir: await realpath(gameDir), extraction, probe, manifestHash,
        ...(reviewDir ? { reviewDir: path.resolve(reviewDir) } : {}) };
      seeded.add(record);
      cache.set(path.resolve(workDir), record);
    },
    trustedTools: {
      native_unpack: { version: 'pinhao-archive-tools-v2', description: '使用成熟编解码器解包归档，返回已落盘成员及保留在原档中的 opaqueMembers；同输入自动复用工件', argsHint: '["data.xp3","xp3"]；第二项格式可省略', validateArgs: archiveInput,
        capabilities: { protocol: 1, operation: 'unpack', formats, results: ['archive-members-v1', 'utf8-span', 'json-pointer'], preservesMembers: true }, timeoutMs: 900000,
        execute: async ({ args, ...input }) => {
          const artifact = await resolveArchive({ ...input, container: { file: args[0], format: args[1] } });
          return { artifactId: artifact.artifactId, format: artifact.format, archiveHash: artifact.archiveHash, memberRoot: path.relative(input.workDir, artifact.sourceDir).replaceAll(path.sep, '/'), members: artifact.members, reused: artifact.reused };
        } },
      native_repack: { version: 'pinhao-archive-tools-v2', description: '将工作目录中的修改重新封包，保留原归档中其余成员（包括 opaqueMembers），并逐成员读回校验', argsHint: '["native-archives/archive-id","output/data.xp3","xp3","data.xp3"]', validateArgs: args => args.length === 4 && formats.includes(args[2]),
        capabilities: { protocol: 1, operation: 'repack', formats, preservesMembers: true, memberReadback: true }, timeoutMs: 900000,
        execute: async ({ args, gameDir, workDir, signal }) => {
          const inputDir = await checkedPath(workDir, args[0], { directory: true });
          const outputFile = await checkedPath(workDir, args[1], { write: true });
          await mkdir(path.dirname(outputFile), { recursive: true });
          const result = await repackArchive({ gameDir, inputDir, outputFile, container: { format: args[2], file: args[3] }, signal });
          return { ...result, outputFile: args[1] };
        } },
      native_probe: { description: '查看已核对原生阶段的引擎与能力；没有原生阶段时才识别当前输入，probeSource说明来源', argsHint: '[]', validateArgs: args => args.length === 0,
        execute: async ({ gameDir, workDir, signal }) => {
          signal?.throwIfAborted();
          if (workDir) {
            try {
              const record = await load({ gameDir, workDir });
              signal?.throwIfAborted();
              if (record.probe) return { ...record.probe, probeSource: 'native-stage', nativeResultId: record.id };
            } catch (error) {
              const key = path.resolve(workDir);
              const known = [...cache].some(([root, record]) => root === key || seeded.has(record) && within(root, key));
              if (error.code !== 'ENOENT' || known) throw error;
            }
          }
          return { ...await call('probe', { gameDir }, signal), probeSource: 'current-input' };
        } },
      native_extract: { description: '完整原生提取并保存主机结果，返回结果编号与数量', argsHint: '[]；按文件查看使用 native_inspect', validateArgs: args => args.length === 0,
        timeoutMs: 900000,
        execute: async ({ gameDir, workDir, signal }) => {
          try { return { ...summary(await load({ gameDir, workDir })), reused: true }; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          const probe = await call('probe', { gameDir }, signal);
          const workspaceDir = path.join(workDir, 'native-workbench', randomUUID());
          await mkdir(path.dirname(workspaceDir), { recursive: true });
          let extraction;
          try { extraction = await call('extract', { gameDir, workspaceDir, allowEmpty: true,
            nativeRecoveryCacheDir: path.join(workDir, 'native-recovery-cache') }, signal); }
          catch (error) {
            error.nativeFailure = await registerNativeFailure({ error, workspaceDir, projectDir: workDir });
            throw error;
          }
          if (!Array.isArray(extraction.units)) throw new Error('原生工具需要返回文字单元');
          const manifestHash = hash(await readFile(path.join(extraction.workspaceDir ?? extraction.workDir, 'manifest.json')));
          let sourceFiles = {};
          try { sourceFiles = JSON.parse(await readFile(path.join(extraction.workspaceDir ?? extraction.workDir, 'technical', 'product-source.json'), 'utf8')).sourceFiles ?? {}; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          const nativeFailure = extraction.nativeAttempt ? await registerNativeFailure({
            error: { code: 'NATIVE_PARTIAL_EVIDENCE', message: 'Native recovery evidence retained', ...extraction.nativeAttempt }, workspaceDir, projectDir: workDir,
          }) : undefined;
          const record = { format: 'pinhao-native-result-1', id: `native-${randomUUID()}`, gameDir: await realpath(gameDir), probe, extraction, manifestHash, sourceFiles,
            ...(nativeFailure ? { nativeFailure } : {}) };
          const temporary = `${fileFor(workDir)}.${randomUUID()}.tmp`;
          await writeFile(temporary, JSON.stringify(record), { flag: 'wx' });
          await rename(temporary, fileFor(workDir));
          cache.set(path.resolve(workDir), record);
          return summary(record);
        } },
      native_inspect: { description: '分页查看已提取的原生文字及定位', argsHint: '["--file","data/Map001.json","--offset","0","--limit","20"]；参数均可省略',
        validateArgs: args => { try { pageOptions(args); return true; } catch { return false; } },
        execute: async input => {
          const options = pageOptions(input.args), record = await load(input);
          const units = record.extraction.units.filter(unit => !options.file || unitFileMatches(unit, options.file));
          return { nativeResultId: record.id, total: units.length, offset: options.offset,
            nextOffset: options.offset + options.limit < units.length ? options.offset + options.limit : null,
            units: units.slice(options.offset, options.offset + options.limit).map(unit => ({ id: unit.legacyId ?? unit.id, kind: unit.kind,
              source: unit.source, tokens: unit.tokens, context: unit.context, file: unit.file,
              ...(unit.context?.carrier ? { carrier: unit.context.carrier } : {}) })),
            ...(options.file ? { filter: { file: options.file, meaning: 'matching-records-only' } } : {}) };
        } },
      native_review: { description: '按原生资源和组件类型分页检查待确认对象、字段结构与字符串样例，返回资源证据摘要', argsHint: '["--file","Game_Data/level0","--offset","0","--limit","6"]；--group 可查看指定类型组',
        timeoutMs: 900000,
        validateArgs: args => { try { reviewOptions(args); return true; } catch { return false; } },
        execute: async input => {
          const record = await load(input);
          return call('native_review', { workspaceDir: record.extraction.workspaceDir ?? record.extraction.workDir, ...reviewOptions(input.args) }, input.signal);
        } },
      native_review_decide: { description: '确认原生类型组的显示字段或非显示用途；主机重新核对源资源并完成原样往返与改文小样',
        argsHint: '["{\"groupId\":\"当前组编号\",\"evidenceHash\":\"当前证据摘要\",\"disposition\":\"display\",\"fields\":[{\"path\":[\"rows\",\"*\",\"text\"],\"kind\":\"message\"}],\"reason\":\"字段用于场景对白的依据\"}"]',
        timeoutMs: 900000,
        validateArgs: args => { try { reviewDecisions(args); return true; } catch { return false; } },
        execute: async input => {
          const record = await load(input), decisions = reviewDecisions(input.args);
          const baseline = await nativeWorkbenchIdentity(record.extraction.workspaceDir ?? record.extraction.workDir);
          const answerKey = hash(JSON.stringify([path.resolve(input.workDir), record.gameDir, baseline, decisions]));
          const answer = reviewAnswers.get(answerKey), previousReceipt = answer && reviews.get(answer.result.nativeReviewReceiptId);
          if (previousReceipt) {
            await validateReviewReceipt(previousReceipt, input.gameDir, input.signal);
            return { ...structuredClone(answer.result), reused: true };
          }
          const reviewDir = record.reviewDir ?? path.join(input.workDir, 'native-review');
          const outputDir = await allocateReviewWorkbench({ workDir: input.workDir, reviewDir });
          let sampleDir;
          try {
          const extraction = await call('native_adapt', { workspaceDir: record.extraction.workspaceDir ?? record.extraction.workDir, outputDir, decisions }, input.signal);
          if (!Array.isArray(extraction.units)) throw new Error('原生字段适配需要返回完整可回写工作台');
          const verifiedDecisions = decisions.map(decision => extraction.nativeReviewDecisions?.find(item => item.groupId === decision.groupId && item.evidenceHash === decision.evidenceHash));
          if (verifiedDecisions.some(item => !item?.file)) throw new Error('原生字段适配需要记录已核对的资源与决定');
          const workspaceDir = extraction.workspaceDir ?? extraction.workDir;
          if (await realpath(workspaceDir) !== outputDir) throw new Error('原生字段适配需要返回本次登记的独立工作台');
          const roundtrip = await call('roundtrip', { workspaceDir }, input.signal);
          if (roundtrip?.passed === false || roundtrip?.valid === false || roundtrip?.byteIdentical === false) throw new Error('原生字段的无改动回写检查失败');
          const previous = new Set(record.extraction.units.map(unit => unit.legacyId ?? unit.id));
          const additions = extraction.units.filter(unit => !previous.has(unit.legacyId ?? unit.id));
          const validation = { roundtrip: 'passed', sample: additions.length ? 'passed' : 'not-required', additionalUnits: additions.length };
          if (additions.length) {
            const reviewRoot = await realpath(reviewDir);
            sampleDir = await allocateReviewWorkbench({ workDir: input.workDir, reviewDir, sample: true });
            const manifest = JSON.parse(await readFile(path.join(workspaceDir, 'manifest.json'), 'utf8'));
            const idOf = unit => unit.legacyId ?? unit.id, seeds = additions.slice(0, 3);
            const selected = new Set(seeds.map(idOf));
            const syncGroups = new Map();
            for (const unit of seeds) {
              const group = manifest.units?.[idOf(unit)]?.sync_group;
              if (typeof group === 'string' && group.length && !syncGroups.has(group)) syncGroups.set(group, `译${unit.source}`);
            }
            // A sample must obey the same joint-write constraints as a full product, including older members.
            const translations = extraction.units.filter(unit => selected.has(idOf(unit)) || syncGroups.has(manifest.units?.[idOf(unit)]?.sync_group))
              .map(unit => ({ id: idOf(unit), translation: syncGroups.get(manifest.units?.[idOf(unit)]?.sync_group) ?? `译${unit.source}`, notes: '' }));
            const report = await call('build', { workspaceDir, outputDir: sampleDir, translations }, input.signal);
            const sample = validation.sampleDetails = { units: translations.map(unit => ({ id: unit.id, translationHash: hash(unit.translation) })), report };
            try {
              const saved = await createEvidenceStore(input.workDir).save({ units: sample.units, report }, { tool: 'native_review_decide', kind: 'native-sample-validation' });
              sample.evidenceId = saved.evidenceId;
              sample.cleanup = await releaseSuccessfulSample({ sampleDir, reviewDir, reviewRoot, signal: input.signal });
              if (sample.cleanup.status === 'released') reviewWorkbenches.delete(sampleDir);
              else await finishReviewWorkbench({ workspaceDir: sampleDir, status: input.signal?.aborted ? 'failed' : 'committed',
                validation: { units: sample.units, report }, cleanup: sample.cleanup });
            } catch (error) {
              sample.cleanup = { status: 'retained', reason: 'evidence-save-failed', error: { code: error.code, message: String(error.message ?? error) } };
            }
          }
          const receiptId = `native-review-${randomUUID()}`;
          const receipt = { id: receiptId, gameDir: await realpath(input.gameDir), workDir: path.resolve(input.workDir), decisions: verifiedDecisions,
            baseline, extraction, resultIdentity: await nativeWorkbenchIdentity(workspaceDir),
            files: [...new Set(verifiedDecisions.map(item => item.file))],
            validation };
          // Receipts are issued only after native checks; model-provided records cannot authorize a commit.
          reviews.set(receiptId, receipt);
          const stageFile = path.join(workspaceDir, 'technical', 'pinhao-native-extraction.json');
          const stage = JSON.stringify({ probe: record.probe, extraction }), temporary = `${stageFile}.${randomUUID()}.tmp`;
          await mkdir(path.dirname(stageFile), { recursive: true });
          await writeFile(temporary, stage, { flag: 'wx' }); await rename(temporary, stageFile);
          const { sampleDetails, ...checks } = validation;
          await finishReviewWorkbench({ workspaceDir: outputDir, status: 'verified', receiptId, baseline, resultIdentity: receipt.resultIdentity,
            gameDir: receipt.gameDir, workDir: receipt.workDir, stageFile, stageHash: hash(stage),
            decisions: verifiedDecisions, validation: { ...checks, ...(sampleDetails ? { sampleDetails: {
              units: sampleDetails.units, evidenceId: sampleDetails.evidenceId, cleanup: sampleDetails.cleanup } } : {}) } });
          const result = { nativeReviewReceiptId: receiptId, decisions: decisions.length, addedUnits: additions.length,
            validation: { roundtrip: validation.roundtrip, sample: validation.sample, additionalUnits: validation.additionalUnits },
            ...(validation.sampleDetails ? { sampleArtifact: { evidenceId: validation.sampleDetails.evidenceId, cleanup: validation.sampleDetails.cleanup } } : {}) };
          reviewAnswers.set(answerKey, { workDir: path.resolve(input.workDir), result });
          return result;
          } catch (error) {
            if (sampleDir && reviewWorkbenches.has(sampleDir)) await finishReviewWorkbench({ workspaceDir: sampleDir, status: 'failed',
              error: { code: error.code, message: String(error.message ?? error) } });
            await finishReviewWorkbench({ workspaceDir: outputDir, status: 'failed', baseline, decisions,
              error: { code: error.code, message: String(error.message ?? error) } });
            throw error;
          }
        } },
      native_roundtrip: { description: '验证最近原生结果的全部原样回写', argsHint: '[]', validateArgs: args => args.length === 0,
        timeoutMs: 900000,
        execute: async input => { const record = await accept(input); return { ...summary(record), validation: record.validation }; } },
      native_accept: { description: '验证原生结果并交接至制作流程', argsHint: '[]', validateArgs: args => args.length === 0,
        timeoutMs: 900000,
        execute: async input => { const record = await accept(input); return { acceptedNativeResultId: record.id, unitCount: record.extraction.units.length, validation: record.validation }; } },
    },
    async resolveNativeResult({ resultId, gameDir, workDir, signal }) {
      const record = await load({ gameDir, workDir });
      if (record.id !== resultId || !record.validation) throw new Error('请选择本任务已通过原样回写的原生结果');
      signal?.throwIfAborted();
      return { extraction: record.extraction, probe: record.probe };
    },
    async resolveNativeReview({ receiptId, gameDir, workDir, signal }) {
      signal?.throwIfAborted();
      const receipt = reviews.get(receiptId);
      if (!receipt || receipt.gameDir !== await realpath(gameDir) || receipt.workDir !== path.resolve(workDir)) throw new Error('请选择本资源任务通过原生验证的字段决定');
      if (receipt.resultIdentity && JSON.stringify(await nativeWorkbenchIdentity(receipt.extraction.workspaceDir ?? receipt.extraction.workDir)) !== JSON.stringify(receipt.resultIdentity)) throw new Error('已验证的原生工作台已改变，请重新提交字段决定');
      return structuredClone(receipt);
    },
  };
}
