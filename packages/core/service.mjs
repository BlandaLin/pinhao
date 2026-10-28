import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, readFile, writeFile, readdir, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { createStore } from './workspace-store.mjs';
import { createAdaptationBudget, recoverAdaptationBudget } from './adaptation-budget.mjs';
import { createAcceptanceLedger, persistAcceptedBatch, readAcceptedBatch, discoverAcceptedBatches } from './accepted-batches.mjs';
import { createLogStorageBudget } from './log-storage-budget.mjs';
import { PROJECT_LAYOUT, createProjectWorkspace, createProductDirectory, releaseProductDirectory, ownsProjectWorkspace } from './project-layout.mjs';
import { taskPrompt, rebindTextPrompt, repairTextPrompt, sdkProvider, PROMPT_VERSION, configureRequestSlots, compactEvidenceHistory } from './provider.mjs';
import { sha256, validateTranslation, writePackage, readPackage, threeWay } from '../exchange/index.mjs';
import { scanTerminology, terminologyUpdates, terminologyHints, terminologyReviewStamp, relevantGlossary, glossaryConflicts, incrementalTerminologyCandidates } from './glossary.mjs';
import { removeArtifact, managedBuildOwner } from './artifacts.mjs';
import { createRecollectionManager } from './recollection.mjs';
import { createAdaptiveWorker, createAdaptationSource, registerSupplement, prepareSupplement, readSupplementManifest, applySupplementalText } from './adaptive-worker.mjs';
import { planAdaptationJobs, runAdaptationPool } from '../technical/adaptation-pool.mjs';
import { createCoverageBatcher } from '../technical/coverage-batcher.mjs';
import { readJson as readAdapterRecord, checkedPath as checkedAdapterPath } from '../technical/adaptation/paths.mjs';
import { createDisplaySourceResolver } from '../technical/adaptation/source-origins.mjs';
import { selectSupplementalUnits, adaptationLocationKey } from './adaptation-results.mjs';
import { createNativeTools, nativeWorkbenchIdentity, passedNativeRoundtrip } from './native-tools.mjs';
import { nativeWorkerError, isNativeDependencyFailure, registerNativeFailure } from '../technical/adaptation/native-failure.mjs';
import { createTaskIndex } from './task-index.mjs';
import { packRequestBatches, collectRequestReferences, createRequestReferenceSelector, requestPromptCharacters, REQUEST_BATCH_LIMITS } from './request-batches.mjs';
import { createRecordCheckpoint } from './request-checkpoint.mjs';
import { reconcileCandidates } from './result-acceptance.mjs';
import { providerFailure, createRequestCooldown, isTransientRequestFailure } from './request-recovery.mjs';
import { outputManifest, verifyOutput } from './output-manifest.mjs';
import { retainBuildArtifacts } from './build-repair.mjs';
import { estimateProgress, progressLine } from './progress.mjs';
import { buildCompletionReport, completionReportText } from './completion-report.mjs';
import { createDependencySnapshot, dependencyHash, dependenciesFresh, retainDependencySnapshot, createSemanticState, createSemanticContext, freshSemanticPreparation, publishSemanticDecisions, semanticReuseRecords, createReadReceipt } from './semantic-state.mjs';
import { materializePartialReviewResponse } from './review-contract.mjs';
import { textRequestLimits, assertTextRequestCapacity } from './text-capacity.mjs';
import { resolveEvidenceRequests } from './semantic-tools.mjs';
import { createReviewRound, prepareReviewTransport, refreshReviewRound, reviewScopes, reviewView, reviewScopeVersion, currentReviewTasks,
  reviewStageComplete, reviewRoundProgress, savedSceneReviewUnits, reviewGlossary, reviewResolutionScopes, reviewOutcome, changedReviewIds } from './review-round.mjs';
import { buildStoryContext, storyMaterialEntrypoints } from '../exchange/story.mjs';
import { createRequestArtifact, loadRequestUsageSummary } from './request-artifacts.mjs';
import { REVIEW_DIAGNOSTICS_VERSION, groupReviewDiagnostics, describeRemainingCoverage, markCoverageStale } from '../technical/review-diagnostics.mjs';
import { applyModelReasoning, reasoningPreference } from './model-reasoning.mjs';

const now = () => new Date().toISOString();
const roles = ['technical', 'translation', 'proofreading'];
const defaultConnection = () => ({ baseUrl: 'https://api.openai.com/v1', model: '', hasKey: false });
const connectionCapacity = connection => Object.fromEntries(['contextWindow', 'maxOutputTokens'].flatMap(key => {
  const value = connection?.[key];
  if (value == null || value === '') return [];
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('模型上下文与最大输出需要填写正整数，留空使用程序默认容量');
  return [[key, value]];
}));
// Local validation asks for one vocabulary edit; three failures mean the text, not the request, must change.
const skipRetryLimit = 3;
// Retry format repairs, not another full timeout with identical input.
const textWindowLimit = 3;
const storageFailure = error => error?.storageFailure || ['ACCEPTANCE_STORAGE_FAILED', 'LOG_WRITE_FAILED', 'DISK_SPACE', 'ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM', 'EBUSY'].includes(error?.code)
  || /no space left|not enough (?:disk )?space|disk (?:is )?full|WinError 112/i.test(error?.message ?? '');
const hostFailure = error => Boolean(error?.hostFailure || storageFailure(error)
  || ['INTEGRATION_PENDING', 'ACCEPTANCE_RECEIPT_CONFLICT'].includes(error?.code));
const storageFailureMessage = '工作文件被占用，或工作磁盘空间不足、不可写。已保存的成果仍保留，请解除文件占用或检查磁盘后，从已保存进度继续；新工程也可以选择其他工作位置。';
// 这几类错误重试没有收益：超时要真等满超时，截断要真花掉输出预算。它们的重试上限是 1 次；
// 只有「模型返回了但不合协议」这类很快的失败才值得用完整个窗口。
const fastFailCodes = Object.freeze(['MODEL_OUTPUT_TRUNCATED', 'READ_NO_PROGRESS', 'ETIMEDOUT', 'TECHNICAL_REQUEST_TIMEOUT', 'MODEL_REASONING_ONLY']);
const stopsTextWindow = error => fastFailCodes.includes(asError(error).code)
  || error?.name === 'TimeoutError' || /timed? ?out|timeout/i.test(error?.message ?? '');
const textWindowStopMessage = remaining => `本批已重试 ${textWindowLimit} 次仍未通过${remaining ? `，剩余 ${remaining} 条` : ''}，已暂停并保留当前译文，可手工处理后继续`;
const windowStopMessage = remaining => `技术适配累计预算已用完，剩余 ${remaining} 项资源未解决；已有成果保留，继续执行需要明确追加预算`;
export const defaultSettings = () => ({ connection: defaultConnection(), roles: Object.fromEntries(roles.map((role) => [role, { useShared: true, connection: defaultConnection() }])), concurrency: 3, pauseOnLocalFailure: false, processImages: false, proofreading: true, targetLanguage: 'zh-Hans', fontPath: '' });
const capabilityFallback = [
  ['mv', 'RPG Maker MV', true], ['mz', 'RPG Maker MZ', true], ['vxace', 'RPG Maker VX Ace', true],
  ['vx', 'RPG Maker VX', true], ['xp', 'RPG Maker XP', true], ['rpg2000', 'RPG Maker 2000/2003', false], ['wolf', 'WOLF RPG Editor', false],
].map(([id, name, supported]) => ({ id, name, extract: supported, build: supported, assist: false, detail: supported ? '原生文本提取与独立副本构建' : '待接入原生适配器' }));
const clone = (value) => structuredClone(value);
const modelNotes = (unit, notes) => typeof notes === 'string'
  && (['human', 'external'].includes(unit?.notesOrigin) || notes === '' && unit?.notes)
  ? unit.notes : notes;
const assistanceProjection = (project, installation) => {
  const capability = project.inventory?.capabilities;
  if (!installation) return typeof capability?.assist === 'boolean'
    ? { supported: capability.assist, modes: capability.assistModes ?? [], detail: capability.assistDetail } : undefined;
  if (['disabled', 'install_failed'].includes(installation.status) && typeof capability?.assist === 'boolean') {
    return { ...installation, supported: capability.assist, modes: capability.assist ? capability.assistModes ?? [] : [] };
  }
  return installation;
};
const publicSettings = (value) => {
  const settings = clone(value);
  for (const conn of [settings.connection, ...roles.map((r) => settings.roles[r].connection)]) {
    conn.hasKey = Boolean(conn.keyCipher);
    delete conn.keyCipher;
    delete conn.apiKey;
  }
  return settings;
};
const asError = (error) => {
  let code = error?.code ?? '';
  let status = error?.statusCode ?? error?.status;
  for (let cause = error?.cause; cause; cause = cause.cause) { status ||= cause.statusCode ?? cause.status; code ||= cause.code ?? ''; }
  const unavailable = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EACCES', 'ABORT_ERR', 'ERR_MODULE_NOT_FOUND'].includes(code) || /fetch failed|network|timed? ?out|terminated|response stream ended without a finish reason|cannot connect to API|API key is missing|model.*not found/i.test(error?.message ?? '');
  return { status, code, global: isTransientRequestFailure(error) || [401, 402, 403].includes(status) || status >= 500 || unavailable };
};

function sceneKey(unit) {
  const context = unit.context ?? {};
  return JSON.stringify([context.file ?? context.map ?? '', context.event ?? '', context.page ?? '', context.scene ?? '']);
}

export function groupUnits(units) {
  const groups = new Map();
  for (const unit of units) {
    const c = unit.context ?? {};
    const key = c.syncGroup ? `sync:${c.syncGroup}` : c.file || c.map || c.event !== undefined || c.scene !== undefined || c.page !== undefined
      ? `scene:${sceneKey(unit)}` : `unit:${unit.id}`;
    const group = groups.get(key) ?? []; group.push(unit); groups.set(key, group);
  }
  return [...groups.values()];
}

function retainTaskUnits(task, eligible, allUnits, indexes = {}) {
  const current = indexes.current ?? new Map(allUnits.map(unit => [unit.id, unit]));
  const available = indexes.available ?? new Map(eligible.map(unit => [unit.id, unit]));
  const matches = input => {
    if (indexes.reserved?.has(input.id)) return false;
    const unit = available.get(input.id);
    return unit && unit.revision === input.revision && unit.sourceHash === input.sourceHash;
  };
  const changedGroups = new Set(task.input.filter(input => !matches(input)).map(input => current.get(input.id)?.context?.syncGroup).filter(Boolean));
  return task.input.filter(matches).map(input => available.get(input.id)).filter(unit => !changedGroups.has(unit.context?.syncGroup));
}

function extractedUnit(projectId, raw) {
  const legacyId = raw.legacyId ?? raw.id;
  if (typeof legacyId !== 'string' || typeof raw.source !== 'string') throw new Error('适配器需要稳定 ID 与有效源文');
  return { id: `u-${sha256(`${projectId}:${legacyId}`).slice(0, 24)}`, legacyId, kind: raw.kind ?? 'text', source: raw.source,
    translation: typeof raw.translation === 'string' ? raw.translation : raw.source, notes: typeof raw.notes === 'string' ? raw.notes : '', tokens: raw.tokens ?? [],
    context: { ...(raw.file ? { file: raw.file } : {}), ...raw.context,
      ...(raw.locator ? { adaptationLocator: raw.locator, adaptationSourceHash: sha256(raw.rawSource ?? raw.source) } : {}),
      ...(raw.controls ? { controlFingerprint: sha256(raw.controls) } : {}), protectedControlSyntax: 'rpgmaker-v1' },
    sourceHash: sha256(raw.source), revision: 0, status: 'pending' };
}

function compactReviewItems(items) {
  const groups = groupReviewDiagnostics(items);
  return [...groups.nativeReviewIssues, ...groups.extractionIssues, ...groups.presentationItems,
    ...groups.nonTextReviewItems, ...groups.informationalItems];
}

export function createRunScope(scopeUnitIds) {
  const ids = scopeUnitIds ? new Set(scopeUnitIds) : undefined;
  return unit => !ids || ids.has(unit.id);
}

/** Persistent domain service. Filesystem and model transports are injected by the desktop host. */
export async function createService({ dataDir, worker, secrets, provider = sdkProvider, adaptationProvider, adapterLab, displayVerifier, formatCapabilities, coverageScanner, scriptTools, imageTools, recollectionTools, runtimeVerifier, adaptationLimits = {}, defaultFontPath = '', deferCatalog = false, onChanged = () => {} }) {
  if (!dataDir || typeof worker !== 'function') throw new Error('dataDir 和 worker 为必需参数');
  const technicalLimits = { maxHttpAttempts: adaptationLimits.maxHttpAttempts ?? null, maxWindows: adaptationLimits.maxWindows ?? null };
  for (const value of Object.values(technicalLimits)) if (value !== null && (!Number.isSafeInteger(value) || value < 1)) throw new Error('显式技术测试限额需要正整数');
  const enforceTechnicalLimits = Object.values(technicalLimits).some(value => value !== null);
  const adaptationWindowLimit = technicalLimits.maxWindows;
  await mkdir(dataDir, { recursive: true });
  const store = createStore(dataDir);
  const diagnostics = await stat(path.join(dataDir, 'diagnostics.on')).then(info => info.isFile(), () => false);
  const projectSnapshots = new Map(), textSnapshots = new Map();
  const storyCache = new Map(), roundCache = new Map(), roundChecks = new Map(), planning = new Map();
  const textSnapshot = id => {
    const version = store.unitVersion(id);
    let snapshot = textSnapshots.get(id);
    if (!snapshot || snapshot.version !== version) {
      let units, positions, structureVersion;
      const changed = snapshot && store.unitChangesSince(id, snapshot.version);
      if (changed) {
        positions = snapshot.positions ??= new Map(snapshot.units.map((unit, index) => [unit.id, index]));
        const updates = changed.map(key => [positions.get(key), store.unit(id, key)]);
        if (updates.every(([index, unit]) => index !== undefined && unit)) {
          units = snapshot.units.slice();
          if (updates.every(([index, unit]) => unit.sourceHash === snapshot.units[index].sourceHash && sha256(unit.context) === sha256(snapshot.units[index].context))) structureVersion = snapshot.structureVersion;
          for (const [index, unit] of updates) units[index] = unit;
        }
      }
      if (!units) { units = store.units(id); positions = undefined; }
      structureVersion ??= sha256(units.map(unit => [unit.id, unit.sourceHash, unit.context]));
      snapshot = { version, structureVersion, units, context: createSemanticContext(units),
        positions,
        get references() { return this.selector ??= createRequestReferenceSelector(units, { story: projectStory(id, units) }); } };
      textSnapshots.set(id, snapshot);
    }
    return snapshot;
  };
  let settings = store.one('settings', 'global') ?? { id: 'global', ...defaultSettings(), fontPath: defaultFontPath };
  configureRequestSlots(settings.concurrency);
  let closed = false;
  let closing = false;
  let scheduled = false;
  const active = new Map();
  const taskSlotWaiters = new Set();
  const building = new Map();
  const preparing = new Map();
  const buildControllers = new Map();
  const operations = new Map();
  const cleaning = new Set();
  const refusals = new Map();
  const secretValues = new Set();
  const cooldown = createRequestCooldown();
  const textRecovery = new Map();
  const recoveryFor = projectId => {
    if (!textRecovery.has(projectId)) textRecovery.set(projectId, { controller: new AbortController() });
    return textRecovery.get(projectId);
  };
  const textPausePending = projectId => textRecovery.get(projectId)?.pause;
  const connectionKey = connection => sha256([connection.baseUrl, connection.model, connection.apiKey]);
  let engines = capabilityFallback;
  let nativeRevision = 'pinhao-native-pipeline-2';
  let nativeSourceRevision = nativeRevision, catalogAvailable = false;
  const applyNativeCatalog = catalog => {
    catalogAvailable = true;
    if (Array.isArray(catalog?.engines) && catalog.engines.length) engines = catalog.engines;
    if (typeof catalog?.nativeRevision === 'string' && catalog.nativeRevision) nativeSourceRevision = catalog.nativeRevision;
    nativeRevision = catalog?.dependencyHealth?.fingerprint ? sha256([nativeSourceRevision, catalog.dependencyHealth.fingerprint]) : nativeSourceRevision;
  };
  const updateCapability = (engine, capability, detail) => {
    if (!capability) return;
    engines = engines.map((item) => item.name === engine || item.name.endsWith(` ${engine}`) || (engine === 'WOLF' && item.id === 'wolf') ? { ...item, extract: Boolean(capability.extract), build: Boolean(capability.nativeBuild ?? capability.build), detail: detail ?? (capability.extract ? '原生提取、回写与独立成品输出' : '需要安装对应原生适配工具') } : item);
  };
  const nativeTools = createNativeTools({ worker });
  const reviewProject = ({ projectId, candidate }) => availableProject(projectId ?? candidate.executionContext?.projectId);
  const technicalReadRoots = project => [...new Set([project.imageReadRoot, path.resolve(project.gameDir, project.resourceRoot ?? '.'), ...(project.technicalSourceRoots ?? [])].filter(Boolean))];
  const sourceOriginsFor = async ({ input, roots, project = reviewProject(input) }) => {
    let sourceCopyPath;
    const technical = path.join(project.workspaceDir, 'technical');
    const relative = path.relative(technical, path.resolve(input.gameDir));
    const parts = relative.split(path.sep);
    if (parts.length === 2 && parts[0] !== '..' && parts[1] === 'source' && !path.isAbsolute(relative)) {
      sourceCopyPath = await checkedAdapterPath(technical, parts.join('/'));
    }
    return createDisplaySourceResolver({ projectId: project.id, roots, sourceCopyPath, allowedSourceRoots: technicalReadRoots(project) });
  };
  let lab;
  const getLab = async () => {
    lab ??= adapterLab ?? import('../technical/adaptation/adapter-lab.mjs').then(async module => module.createAdapterLab({
      dataDir: path.join(dataDir, 'technical-recipes'),
      workspaceFor: ({ projectId }) => availableProject(projectId).workspaceDir,
      trustedTools: nativeTools.trustedTools,
      nativeResultResolver: nativeTools.resolveNativeResult,
      nativeReviewResolver: nativeTools.resolveNativeReview,
      archiveResolver: nativeTools,
      formatCapabilities,
      runtimeVerifier,
      representationSourceFor: async input => {
        const project = reviewProject(input), roots = [...new Set([input.gameDir, ...technicalReadRoots(project)])];
        return { root: await (await sourceOriginsFor({ input, roots, project })).resolveRoot({ files: input.candidate.manifest.scope.files }) };
      },
      displayVerifier: displayVerifier ?? (await import('../technical/adaptation/display-review.mjs')).createDisplayVerifier({
        projectFor: reviewProject,
        connectionFor: input => connectionFor('technical', reviewProject(input).runConfig?.connections?.technical),
        readRootsFor: input => technicalReadRoots(reviewProject(input)),
        sourceResolverFor: sourceOriginsFor,
      }),
      execution: { ...worker.executionRuntime,
        reserveLogBytes: input => logStorage.reserve(input), settleLogBytes: input => logStorage.settle(input),
        authorize: async ({ projectId }) => Boolean(projectId && requiredProject(projectId).workspaceExecution?.granted) },
    }));
    const pending = lab;
    try { return await pending; }
    catch (error) { if (lab === pending) lab = undefined; throw error; }
  };
  const adaptiveWorker = createAdaptiveWorker({ nativeWorker: worker, getLab });
  const scanResources = coverageScanner ?? (async args => {
    const adapter = await getLab();
    const saved = await adapter.listCoverageDecisions?.({ projectId: args.projectId }) ?? [];
    return (await import('../technical/coverage.mjs')).scanCoverage({ ...args,
      scanCacheFile: args.scanCache === false ? undefined : path.join(availableProject(args.projectId).workspaceDir, 'coverage-index.json'),
      decisions: [...saved, ...(args.decisions ?? [])] });
  });
  const adaptResources = adaptationProvider ?? (async () => {
    throw Object.assign(new Error('技术运行环境未接入，请检查当前程序的 DSH 运行文件'), { code: 'DSH_RUNTIME_NOT_CONFIGURED' });
  });
  let scripts;
  const loadScripts = async () => {
    if (scriptTools === null) return null;
    scripts ??= scriptTools ?? await import('../technical/scripts.mjs');
    return scripts;
  };
  let images;
  const loadImages = async () => {
    if (imageTools === null) return null;
    images ??= imageTools ?? await import('../images/index.mjs');
    return images;
  };
  const emit = () => { if (!closed) onChanged(); };
  const requiredProject = id => {
    const version = store.rowVersion('projects', id);
    let snapshot = projectSnapshots.get(id);
    if (!snapshot || snapshot.version !== version) {
      const project = store.one('projects', id);
      if (!project) { projectSnapshots.delete(id); throw new Error('请从项目列表重新选择项目'); }
      snapshot = { version, project }; projectSnapshots.set(id, snapshot);
    }
    return snapshot.project;
  };
  const availableProject = id => {
    const project = requiredProject(id);
    if (project.unavailable) throw Object.assign(new Error(project.lastError), { code: 'PROJECT_LOCATION_UNAVAILABLE' });
    return project;
  };
  const projects = () => store.ids('projects').map(requiredProject);
  const updateProject = (id, patch) => {
    const changes = { ...patch, updatedAt: now() };
    if (changes.adaptationRequest?.id) {
      const previous = requiredProject(id).adaptationRequest;
      changes.adaptationRequest = { ...changes.adaptationRequest,
        ...(previous?.id !== changes.adaptationRequest.id ? { accountingVersion: 1 }
          : previous.accountingVersion ? { accountingVersion: previous.accountingVersion } : {}) };
    }
    const p = { ...requiredProject(id), ...changes };
    store.patchProject(id, changes); projectSnapshots.set(id, { version: store.rowVersion('projects', id), project: p });
    if (['paused', 'completed', 'failed', 'cancelled'].includes(patch.status)) textSnapshots.delete(id);
    emit(); return p;
  };
  const adaptationBudget = createAdaptationBudget({ readProject: requiredProject, patchProject: updateProject,
    transaction: (id, action) => store.transaction(id, action) });
  const logStorage = createLogStorageBudget({ readProject: requiredProject, patchProject: updateProject,
    transaction: (id, action) => store.transaction(id, action), maxRequestBytes: adaptationLimits.maxLogBytes ?? 512 * 1024 * 1024 });
  const budgetFor = project => adaptationBudget.forRequest(project.id, project.adaptationRequest.id,
    { limits: technicalLimits, enforceLimits: enforceTechnicalLimits,
      historyCoverage: project.adaptationRequest.accountingVersion === 1 ? 'complete' : 'partial' });
  const assertAdaptationAllowance = project => {
    if (!project.adaptationRequest || project.status === 'running') return;
    const accounting = budgetFor(project).snapshot();
    const carriedWindow = store.tasks(project.id).some(task => task.kind === 'adaptation' && task.admissionWindowId
      && project.adaptationAccounting?.[project.adaptationRequest.id]?.windows?.includes(task.admissionWindowId));
    if ((!accounting.canOpenWindow && !carriedWindow) || !accounting.canReserveHttp) throw Object.assign(new Error(
      '技术适配累计预算已用完，制作保持暂停；请明确追加预算后再继续'), { code: 'ADAPTATION_BUDGET_EXHAUSTED' });
  };
  const adaptationRetryContext = project => {
    const selected = settings.roles.technical.useShared ? settings.connection : settings.roles.technical.connection;
    return sha256(['adaptation-flow-4', nativeRevision, project.sourceFingerprint, project.verificationCapabilityFingerprint,
      selected.baseUrl, selected.model, selected.keyCipher, selected.contextWindow, selected.maxOutputTokens,
      ...Object.values(reasoningPreference(selected))]);
  };
  const refreshVerificationCapabilities = async project => {
    if (!project.adaptationRequest) return project;
    const descriptor = await (await getLab()).describeVerificationCapabilities?.();
    return descriptor?.fingerprint && descriptor.fingerprint !== project.verificationCapabilityFingerprint
      ? updateProject(project.id, { verificationCapabilityFingerprint: descriptor.fingerprint }) : project;
  };
  const errorMessage = (error) => {
    let message = error instanceof Error ? error.message : String(error);
    // Provider exceptions can echo request headers. A log never becomes a secret store.
    message = message.replace(/(?:Bearer\s+|sk-)[a-z0-9._-]+/ig, '[redacted]').replace(/(["']?(?:api.?key|authorization)["']?\s*[:=]\s*)[^,\n]+/ig, '$1[redacted]');
    for (const key of secretValues) if (key) message = message.split(key).join('[redacted]');
    return message.slice(0, 1800);
  };
  const addIssue = (projectId, category, message, unitId, severity = 'warning', details) => {
    const existing = store.all('issues', projectId).find((i) => i.category === category && i.message === message && i.unitId === unitId && i.taskId === details?.taskId);
    if (existing) {
      if (existing.resolvedAt) { store.put('issues', { ...existing, resolvedAt: undefined, createdAt: now() }, projectId); emit(); }
      return existing;
    }
    const issue = { id: randomUUID(), category, message, severity, createdAt: now(), ...(unitId ? { unitId } : {}), ...(details ?? {}) };
    store.put('issues', issue, projectId); emit(); return issue;
  };
  const discardArtifact = async (projectId, directory, owner) => {
    try {
      const result = await removeArtifact(directory, owner);
      if (!result.removed) addIssue(projectId, 'cache-cleanup', '临时目录含有链接，已保留，可在工作目录中查看。');
      return result;
    } catch (error) {
      addIssue(projectId, 'cache-cleanup', `临时目录暂时保留：${errorMessage(error)}`);
      return { removed: false, bytes: 0 };
    }
  };
  const pruneOldBuilds = async projectId => {
    const project = requiredProject(projectId), builds = store.all('builds', projectId);
    const result = { removed: 0, retained: 0, freedBytes: 0 };
    for (const build of builds.slice(0, -1)) {
      const owner = managedBuildOwner(project, build), relative = path.relative(project.gameDir, build.path);
      if (!owner || build.outputModified || relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) { result.retained++; continue; }
      const proof = await verifyOutput(build.path, build.outputManifest);
      if (!proof.valid) { result.retained++; continue; }
      try {
        const cleaned = await removeArtifact(build.path, owner, { protectSaves: true });
        if (cleaned.removed) { store.removeBuild(projectId, build.id); result.removed++; result.freedBytes += cleaned.bytes; }
        else result.retained++;
      } catch { result.retained++; }
    }
    return result;
  };
  const resolveIssues = (projectId, categories, unitIds) => {
    for (const issue of store.all('issues', projectId)) {
      if (!issue.resolvedAt && categories.includes(issue.category) && (!unitIds || unitIds.includes(issue.unitId))) store.put('issues', { ...issue, resolvedAt: now() }, projectId);
    }
  };
  // Only the failures that belong to the batch which just succeeded become resolved; older evidence stays visible.
  const resolveTaskIssues = (projectId, taskId) => {
    if (!taskId) return;
    for (const issue of store.all('issues', projectId)) if (!issue.resolvedAt && issue.taskId === taskId) store.put('issues', { ...issue, resolvedAt: now() }, projectId);
  };
  // Structured evidence lives next to the human string so the UI keeps reading lastError/error unchanged.
  const failureDetails = (error, record = {}) => {
    const info = asError(error);
    const usage = record.usage ? Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens'].filter((key) => Number.isFinite(record.usage[key])).map((key) => [key, record.usage[key]])) : undefined;
    const category = error?.category ?? record.category ?? (record.status === 'cancelled' ? 'cancelled' : undefined);
    return { ...(info.code ? { code: info.code } : {}), ...(info.status ? { httpStatus: info.status } : {}),
      ...(category ? { category } : {}), ...(record.finishReason ? { finishReason: record.finishReason } : {}),
      ...(record.elapsedMs !== undefined ? { elapsedMs: record.elapsedMs } : {}), ...(record.requestId ? { requestId: record.requestId } : {}),
      ...(usage && Object.keys(usage).length ? { usage } : {}), at: now() };
  };
  // A unit that keeps failing local validation records how often it was skipped for the same revision and role.
  const skipKeyFor = (projectId, unit, role) => {
    const project = requiredProject(projectId);
    const connection = project.status === 'running' ? project.runConfig?.connections?.[role]
      : undefined;
    const selected = connection ?? (settings.roles[role]?.useShared ? settings.connection : settings.roles[role]?.connection);
    return sha256([role ?? '', unit.revision, unit.sourceHash, project.nameGlossary?.hash,
      project.status === 'running' ? project.runConfig?.targetLanguage : settings.targetLanguage,
      selected?.baseUrl, selected?.model, selected?.keyCipher, ...Object.values(reasoningPreference(selected))]);
  };
  const skipCycle = (projectId, unit, role) => {
    const key = skipKeyFor(projectId, unit, role);
    return { skipRole: role, skipKey: key, skipCount: unit.skipKey === key ? (unit.skipCount ?? 0) + 1 : 1 };
  };
  const skipRecord = (projectId, unit, role) => ({ status: 'skipped', ...skipCycle(projectId, unit, role) });
  function reviewMessage(diagnostics) {
    const counts = diagnostics.summary, parts = [];
    if (counts.nativeReviewObjects) parts.push(`${counts.nativeReviewResources} 个资源中的 ${counts.nativeReviewObjects} 个原生组件等待检查文字字段，可点击“提取剩余文字”继续`);
    if (diagnostics.extractionIssues.length) parts.push(`${diagnostics.extractionIssues.length} 项资源提取检查等待处理`);
    if (counts.presentationItems) parts.push(`${counts.presentationItems} 项字体或排版记录已保存`);
    return parts.join('；');
  }
  function updateReviewIssue(id, diagnostics) {
    const message = reviewMessage(diagnostics);
    resolveIssues(id, ['technical-review']);
    if (message) addIssue(id, 'technical-review', message, undefined, 'info');
  }
  const summary = (project) => {
    const counts = store.counts(project.id);
    // "Handled" means the unit was processed, not that it was reviewed. `translated` and `proofread`
    // are mutually exclusive statuses (store.counts sums each separately), so adding them never
    // double counts. The old formula counted only proofread whenever the proofreading switch was on,
    // which reported 0 handled for a fully translated project whose review never committed.
    return { id: project.id, name: project.name, gameDir: project.gameDir, workspaceDir: project.workspaceDir, engine: project.engine, status: project.status, stage: project.stage, runMode: project.runConfig?.mode ?? 'all', textVersion: store.unitVersion(project.id), total: counts.total, done: counts.translated + counts.proofread, translated: counts.translated, proofread: counts.proofread, needsEvidence: counts.needsEvidence ?? 0, pending: counts.total - counts.translated - counts.proofread - counts.skipped, skipped: counts.skipped, createdAt: project.createdAt, updatedAt: project.updatedAt, ...(project.lastError ? { lastError: project.lastError } : {}) };
  };
  const projectContext = id => {
    const project = requiredProject(id);
    return { ...summary(project), assistEnabled: project.assistEnabled !== false, builds: store.buildSummaries(id) };
  };
  const progressSnapshots = new Map();
  // 进度只接收 id 与有效显示状态；待核对不冒充已校对，调度仍使用原始终态。
  // 与 textSnapshot 同样按 unitVersion 做增量快照，只有真的动过的单元才用单行查询补齐。
  const progressUnits = id => {
    const version = store.unitVersion(id);
    const cached = progressSnapshots.get(id);
    if (cached?.version === version) return cached.units;
    let units, positions;
    const changed = cached ? store.unitChangesSince(id, cached.version) : null;
    if (changed) {
      units = cached.units.slice(); positions = cached.positions;
      for (const key of changed) {
        const position = positions.get(key), unit = position === undefined ? undefined : store.unitProgress(id, key);
        if (!unit) { units = undefined; break; }
        units[position] = { id: key, status: unit.status };
      }
    }
    if (!units) { units = store.unitProgress(id); positions = new Map(units.map((unit, position) => [unit.id, position])); }
    progressSnapshots.set(id, { version, units, positions });
    return units;
  };
  // skipped 在两个模块里口径相反（progress 算进 done，完整清单单列），模块本身不改，只在文本层补一句说明。
  const progressText = progress => {
    const line = progressLine(progress), skipped = progress?.phases?.skipped ?? 0;
    return skipped ? `${line} · 其中 ${skipped} 条已跳过` : line;
  };
  const progressFor = (id, tasks, { summaryOnly = false } = {}) => {
    const project = requiredProject(id);
    const estimated = estimateProgress(progressUnits(id), tasks, { taskStats: store.taskStats(id),
      phase: project.textRound?.phase, projectStatus: project.status, runMode: project.runConfig?.mode,
      proofreadingEnabled: project.runConfig?.proofreading ?? settings.proofreading });
    return { ...estimated, partial: false, line: progressText(estimated) };
  };
  // 完整清单要遍历全部单元与译文做术语检索（21k 单元实测 42 ms），只随构建返回，不进 detail()。
  const completionFor = (projectId, { units, glossary, builds }) => buildCompletionReport(units, {
    glossary: glossary?.entries ?? [], issues: store.all('issues', projectId), builds,
    targetLanguage: requiredProject(projectId).runConfig?.targetLanguage ?? requiredProject(projectId).targetLanguage ?? settings.targetLanguage });
  // 运行态投影：技术适配作业与翻译/校对任务合并成同一个形状，界面只读这一份，不再各自拼装。
  const runtimeFor = (project, tasks, { summaryOnly = false } = {}) => {
    const list = tasks ?? [];
    const { counts } = store.taskStats(project.id);
    const runtime = { active: active.size, limit: settings.concurrency,
      queued: counts.queued ?? 0, running: counts.running ?? 0, jobs: [] };
    if (summaryOnly) return runtime;
    const adaptation = (project.adaptationProgress?.jobs ?? [])
      .filter(job => job.status === 'running')
      .map(job => ({ id: job.id, role: 'technical', kind: 'adaptation',
        label: job.tool ?? '准备资源任务',
        resource: job.resource ?? job.files?.join('、') ?? undefined, phase: job.phase }));
    const text = list
      .filter(task => task.status === 'running' && task.role !== 'technical')
      .map(task => ({ id: task.id, role: task.role, kind: task.kind ?? 'text',
        label: `${task.role === 'proofreading' ? '校对' : '翻译'} · ${(task.input ?? task.unitIds ?? []).length} 条`,
        resource: undefined, phase: task.phase }));
    return { ...runtime, jobs: [...adaptation, ...text] };
  };
  const detail = (id, { summaryOnly = false } = {}) => {
    const project = requiredProject(id);
    const capability = project.inventory?.capabilities;
    const builds = (summaryOnly ? store.buildSummaries(id) : store.all('builds', id)).map(build => build.assistance
      ? { ...build, assistance: assistanceProjection(project, build.assistance) } : build);
    // 全量任务记录只读一次：进度的吞吐/ETA 与返回的 tasks 投影共用同一份，不再二次查库。
    const taskRecords = summaryOnly ? undefined : store.all('tasks', id);
    const taskView = summaryOnly ? store.taskSummaries(id) : undefined;
    const laneCounts = store.taskStats(id).lanes;
    const progress = progressFor(id, taskView?.tasks ?? taskRecords, { summaryOnly });
    const assistance = assistanceProjection(project, builds.at(-1)?.assistance);
    const adaptation = project.adaptationProgress?.blocked && project.adaptationRequest?.retryContext !== adaptationRetryContext(project)
      ? { ...project.adaptationProgress, blocked: false, retryable: true, retryContextChanged: true } : project.adaptationProgress;
    return { ...summary(project), assistEnabled: project.assistEnabled !== false, runtime: runtimeFor(project, taskView?.tasks ?? taskRecords, { summaryOnly }),
      publication: { generation: project.publication?.generation ?? 0, ...(project.acceptance ?? {}),
        status: project.acceptance?.pendingIntegration ? 'pending-integration' : 'published',
        materialReady: Boolean(project.prepared && project.workbenchDir && !project.roundtripError && !project.acceptance?.pendingIntegration) },
      lanes: { adaptation: { status: laneCounts.adaptation.running ? 'running'
          : project.adaptationRequest && !project.adaptationDeferred ? project.status === 'running' ? 'queued' : 'paused' : 'idle' },
        text: { status: laneCounts.text.running ? 'running' : laneCounts.text.queued ? 'queued' : 'idle' },
        build: { status: building.has(id) ? 'running' : 'idle' } },
      adaptationPending: Boolean(project.adaptationRequest && !project.adaptationDeferred),
      workspaceExecution: project.workspaceExecution ?? { granted: false, mode: 'current-user' },
      reviewRound: project.textRound ? { id: project.textRound.id, stage: project.textRound.phase,
        total: project.textRound.targetCount, candidates: project.textRound.candidates ?? 0, progress: project.textRound.progress,
        ...(project.textRound.committedAt ? { committedAt: project.textRound.committedAt } : {}) } : undefined,
      adaptationAvailable: Boolean(project.adaptationRequest), adaptationDeferred: Boolean(project.adaptationDeferred),
      canContinueAvailableText: Boolean((project.prepared || project.nativePrepared) && store.hasUnits(id)),
      extractedTotal: project.nativeStage?.unitCount,
      ...(project.nativeDependencyFailure ? { nativeDependencyFailure: {
        code: project.nativeDependencyFailure.code, message: project.nativeDependencyFailure.message,
        ...(project.nativeDependencyFailure.diagnostic ? { diagnostic: project.nativeDependencyFailure.diagnostic } : {}),
        ...(project.nativeDependencyFailure.attemptId ? { attemptId: project.nativeDependencyFailure.attemptId } : {}),
      } } : {}),
      coverage: project.coverage ? summaryOnly
        ? Object.fromEntries(['format', 'summary', 'unitCount', 'sampledResources', 'truncated', 'needsAdaptation', 'triggers', 'completeness', 'runtime', 'structuralRecoveryWarnings', 'scannedAt', 'stale', 'addedUnitsSinceScan'].map(key => [key, project.coverage[key]]))
        : { ...project.coverage, resources: undefined, reviewItems: undefined, dynamicCandidates: undefined, imageCandidates: undefined }
        : undefined, adaptation, glossaryProgress: project.nameGlossary ? { total: project.nameGlossary.entries.length,
          completed: project.nameGlossary.entries.filter(entry => entry.status === 'confirmed').length,
          conflicts: project.nameGlossary.entries.filter(entry => entry.needsReview).length } : undefined, issues: store.all('issues', id), builds, progress,
      ...(assistance ? { assistance } : {}),
      ...(taskView ? { taskTotal: taskView.total } : {}),
      tasks: taskView?.tasks ?? taskRecords.map(({ id, role, kind, status, unitIds, input, attempts, error, requestHistory, candidateRecords }) => ({ id, role, kind, status, unitIds, attempts,
        ...(['running', 'paused'].includes(status) && requestHistory?.length ? { progress: { receivedCharacters: requestHistory.at(-1).receivedCharacters ?? 0,
          textCharacters: requestHistory.at(-1).textCharacters, reasoningCharacters: requestHistory.at(-1).reasoningCharacters,
          checkpointed: candidateRecords?.length ?? 0, requested: unitIds.length || input.length } } : {}), ...(error ? { error } : {}) })) };
  };
  const commitUnit = (projectId, unit, patch, expectedRevision, { semanticIntent = false } = {}) => {
    const current = store.unit(projectId, unit.id);
    if (!current || current.revision !== expectedRevision) { const error = new Error(`文字已更新，请重新载入：${unit.id}`); error.code = 'REVISION_CONFLICT'; throw error; }
    const changed = semanticIntent || patch.translation !== current.translation || (patch.notes ?? current.notes) !== current.notes;
    const next = Object.fromEntries(Object.entries({ ...current, ...patch, revision: current.revision + (changed ? 1 : 0) }).filter(([, value]) => value !== undefined));
    if (patch.translation !== undefined && patch.translation !== current.translation) {
      if (!Object.hasOwn(patch, 'termChoices')) delete next.termChoices;
      if (!Object.hasOwn(patch, 'terminologyNormalization')) delete next.terminologyNormalization;
      if (!Object.hasOwn(patch, 'terminologyReview')) delete next.terminologyReview;
    }
    store.putUnit(projectId, next);
    if (changed) store.addRevision(projectId, next);
    return next;
  };
  const connectionFor = async (role, fixed) => {
    const connectionRole = role === 'proofreading' ? 'translation' : role;
    const selected = fixed ?? (settings.roles[connectionRole].useShared ? settings.connection : settings.roles[connectionRole].connection);
    const connection = { baseUrl: selected.baseUrl, model: selected.model, ...reasoningPreference(selected), ...connectionCapacity(selected) };
    if (!connection.model.trim()) throw new Error('请在设置中填写模型名称');
    const url = new URL(connection.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API 地址需要 HTTP 或 HTTPS');
    if (selected.keyCipher) {
      if (!secrets?.decrypt) throw new Error('请重启工作台，恢复密钥保护服务后重试');
      connection.apiKey = await secrets.decrypt(selected.keyCipher);
      secretValues.add(connection.apiKey);
    }
    return connection;
  };
  const workerCall = async (command, args, signal) => {
    signal?.throwIfAborted();
    if (args.projectId && args.workspaceDir && args.compositeManifestRef === undefined && ['roundtrip', 'build', 'assemble'].includes(command)) {
      const current = requiredProject(args.projectId);
      if (current.workbenchDir === args.workspaceDir && current.publication?.compositeManifestRef) args = { ...args, compositeManifestRef: current.publication.compositeManifestRef };
    }
    const result = await adaptiveWorker(command, args, { signal });
    signal?.throwIfAborted();
    if (result?.ok === false) throw nativeWorkerError(result.error);
    const value = result?.ok === true && Object.hasOwn(result, 'result') ? result.result : result;
    if (command === 'roundtrip' && !passedNativeRoundtrip(value)
        || command === 'validate' && (value?.valid === false || value?.passed === false || value?.byteIdentical === false)) throw new Error(value.error?.message ?? '文字结构与原样回写检查待通过');
    return value;
  };
  const recollection = createRecollectionManager({ projectFor: projectContext, worker: workerCall, connectionFor: () => connectionFor('technical'), onChanged: emit, tools: recollectionTools, diagnostics });
  async function withControlEvidence(units, workbenchDir, scriptBinding) {
    let nativeUnits = {};
    if (workbenchDir) {
      try { nativeUnits = JSON.parse(await readFile(path.join(workbenchDir, 'manifest.json'), 'utf8')).units ?? {}; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const scriptControls = new Map((scriptBinding?.files ?? []).flatMap((file) => file.candidates.map((candidate) => [candidate.id, candidate.controls])));
    return units.map((unit) => {
      const nativeUnit = nativeUnits[unit.legacyId ?? unit.id];
      const controls = scriptControls.get(unit.legacyId ?? unit.id) ?? nativeUnit?.controls;
      const fingerprint = controls && typeof controls === 'object' ? sha256(Object.fromEntries(Object.entries(controls).sort(([a], [b]) => a.localeCompare(b)))) : unit.context?.controlFingerprint ?? ((unit.tokens?.length ?? 0) ? undefined : sha256({}));
      return { ...unit, context: { ...unit.context, ...(fingerprint ? { controlFingerprint: fingerprint } : {}), ...(controls ? { controlBindings: controls } : {}), ...(nativeUnit?.sync_group ? { syncGroup: nativeUnit.sync_group } : {}) } };
    });
  }

  // Running requests are uncertain after process termination; accepted revisions remain authoritative.
  function pauseInterruptedWork(projectId) {
    for (const task of store.tasks(projectId, { statuses: ['running', 'queued'] })) store.putTask(task.projectId, { ...task, status: 'paused', error: task.status === 'running' ? '上次进程已结束；可从已提交批次继续' : undefined });
    for (const project of projectId ? [requiredProject(projectId)] : projects()) if (project.status === 'running' || project.status === 'preparing') store.put('projects', { ...project, status: 'paused', stage: '等待继续', updatedAt: now() });
  }
  pauseInterruptedWork();
  const catalogController = new AbortController();
  const catalogReady = (async () => {
    try {
      const catalog = await workerCall('catalog', {}, catalogController.signal);
      if (closing || closed) return;
      applyNativeCatalog(catalog);
    } catch { /* Older adapters declare their capability on probe. */ }
    if (closing || closed) return;
    for (const project of projects()) updateCapability(project.engine, project.inventory?.capabilities);
    if (deferCatalog) emit();
  })();
  if (!deferCatalog) await catalogReady;

  function queue(project, index, role, units, kind, allUnits) {
    const projectId = project.id;
    const selected = project.runConfig?.connections[role] ?? (settings.roles[role].useShared ? settings.connection : settings.roles[role].connection);
    const targetLanguage = project.runConfig?.targetLanguage ?? settings.targetLanguage;
    const dependencies = units.length ? textDependencies(project, units, allUnits, undefined, kind) : undefined;
    const depsHash = dependencies ? dependencyHash(dependencies) : undefined;
    const fingerprint = sha256({ role, kind, adaptation: kind === 'adaptation' ? project.adaptationRequest?.id : undefined, prompt: PROMPT_VERSION, source: project.sourceFingerprint, targetLanguage, endpoint: selected.baseUrl, model: selected.model, dependencyHash: depsHash, units: units.map((u) => [u.id, u.revision, u.sourceHash, u.translation, u.notes]) });
    const input = units.map(u => ({ id: u.id, revision: u.revision, sourceHash: u.sourceHash }));
    const existing = index.find({ fingerprint, role, kind, targetLanguage, input, dependencyHash: depsHash, promptVersion: PROMPT_VERSION }) ?? index.byFingerprint(fingerprint);
    if (existing) {
      if (['paused', 'stale', 'queued', 'succeeded'].includes(existing.status) && existing.status !== 'queued') {
        const hasEvidence = Boolean(existing.evidenceReplies?.length);
        const preserveEvidence = hasEvidence && taskDependenciesFresh(existing);
        const changedModel = existing.connection?.baseUrl !== selected.baseUrl || existing.connection?.model !== selected.model
          || (existing.connection?.reasoning ?? 'auto') !== (selected.reasoning ?? 'auto');
        const nextDependencies = preserveEvidence ? retainDependencySnapshot(existing.dependencies, units.map(unit => unit.id)) : dependencies;
        const next = { ...existing, dependencies: nextDependencies, dependencyHash: nextDependencies ? dependencyHash(nextDependencies) : depsHash,
          ...(hasEvidence && !preserveEvidence ? { candidateRecords: undefined, semanticCandidates: undefined, reviewCandidate: undefined,
            evidenceReplies: undefined, evidenceReferences: undefined, evidenceRounds: 0, evidenceExhausted: undefined } : {}),
          ...(preserveEvidence && changedModel ? { evidenceRounds: 0, evidenceExhausted: undefined } : {}),
          status: 'queued', connection: clone(selected), targetLanguage, promptVersion: PROMPT_VERSION, attempts: existing.attempts, windowAttempts: 0, transportWindowAttempts: 0, error: undefined };
        store.putTask(projectId, next); index.set(next);
        return next;
      }
      return existing;
    }
    const next = { id: randomUUID(), projectId, role, ...(kind ? { kind } : {}), status: 'queued', fingerprint, dependencies, dependencyHash: depsHash, connection: clone(selected), targetLanguage, unitIds: units.map((u) => u.id), input, attempts: 0, promptVersion: PROMPT_VERSION, createdAt: now() };
    store.putTask(projectId, next); index.set(next);
    return next;
  }
  function textDependencies(project, units, allUnits = textSnapshot(project.id).units, references, kind) {
    const snapshot = textSnapshot(project.id);
    references ??= collectRequestReferences(allUnits, groupUnits(units), snapshot.units === allUnits ? snapshot.references : undefined);
    const preparation = freshSemanticPreparation(project.semanticPreparation, { units: allUnits, context: snapshot.context });
    const material = taskPrompt(kind ?? 'translation', units, project.runConfig?.targetLanguage ?? project.targetLanguage ?? settings.targetLanguage,
      references, relevantGlossary(project.nameGlossary, units), { preparation }).material;
    return createDependencySnapshot({ units, referenceUnits: references, glossary: project.nameGlossary,
      preparation, modelMaterial: material, promptVersion: PROMPT_VERSION,
      targetLanguage: project.runConfig?.targetLanguage ?? project.targetLanguage ?? settings.targetLanguage });
  }
  function taskDependenciesFresh(task) {
    if (task.reviewRoundId) return !['stale', 'cancelled'].includes(store.one('tasks', task.id)?.status);
    if (!task.dependencies) return true;
    const project = requiredProject(task.projectId);
    const { units, context } = textSnapshot(task.projectId);
    const eligible = task.input.filter(input => { const current = context.unitById(input.id); return current?.revision === input.revision && current.sourceHash === input.sourceHash; }).map(input => input.id);
    const snapshot = retainDependencySnapshot(task.dependencies, eligible);
    return dependenciesFresh(snapshot, { units, context, glossary: project.nameGlossary,
      candidateRecords: task.candidateRecords,
      preparation: freshSemanticPreparation(project.semanticPreparation, { units, context }), promptVersion: PROMPT_VERSION,
      targetLanguage: project.runConfig?.targetLanguage ?? project.targetLanguage ?? settings.targetLanguage });
  }
  // Paid output is unusable only when the batch's own targets, a query answer or the shared material
  // moved on; plain reference reads change whenever a parallel batch commits.
  function taskMaterialFresh(task) {
    if (!task.dependencies) return true;
    const project = requiredProject(task.projectId);
    const { units, context } = textSnapshot(task.projectId);
    const eligible = task.input.filter(input => { const current = context.unitById(input.id); return current?.revision === input.revision && current.sourceHash === input.sourceHash; }).map(input => input.id);
    const retained = retainDependencySnapshot(task.dependencies, eligible);
    const targets = new Set(eligible);
    const receipts = retained.receipts.filter(receipt => receipt.kind === 'query' || targets.has(receipt.id));
    const ids = new Set(receipts.filter(receipt => receipt.kind !== 'query').map(receipt => receipt.id));
    const decisions = retained.decisions.filter(stamp => !stamp.unitIds || stamp.unitIds.some(id => ids.has(id)));
    return dependenciesFresh({ ...retained, receipts, decisions }, { units, context, glossary: project.nameGlossary,
      preparation: freshSemanticPreparation(project.semanticPreparation, { units, context }), promptVersion: PROMPT_VERSION,
      targetLanguage: project.runConfig?.targetLanguage ?? project.targetLanguage ?? settings.targetLanguage, candidateRecords: task.candidateRecords });
  }
  function queueImages(projectId) {
    const project = requiredProject(projectId);
    const offset = project.imageOffset ?? 0;
    const connection = project.runConfig?.connections.technical ?? (settings.roles.technical.useShared ? settings.connection : settings.roles.technical.connection);
    const fingerprint = sha256({ kind: 'image-ocr', source: project.imageSourceBase ?? project.sourceFingerprint, offset, model: connection.model, endpoint: connection.baseUrl });
    const existing = store.taskByFingerprint(projectId, fingerprint);
    if (existing) {
      if (['paused', 'stale', 'queued'].includes(existing.status)) store.putTask(projectId, { ...existing, status: 'queued', connection: clone(connection), attempts: existing.status === 'stale' ? 0 : existing.attempts, error: undefined });
      return;
    }
    store.putTask(projectId, { id: randomUUID(), projectId, role: 'technical', kind: 'image-ocr', status: 'queued', fingerprint, connection: clone(connection), offset, unitIds: [], input: [], attempts: 0, createdAt: now() });
  }
  function projectStory(projectId, units = textSnapshot(projectId).units) {
    const project = requiredProject(projectId);
    const snapshot = textSnapshot(projectId);
    const key = sha256([project.sourceFingerprint, snapshot.units === units ? snapshot.structureVersion : units.map(unit => [unit.id, unit.sourceHash])]);
    let entry = storyCache.get(projectId);
    if (entry?.key !== key) { entry = { key, story: buildStoryContext(units, { sourceRevision: project.sourceFingerprint }) }; storyCache.set(projectId, entry); }
    return entry.story;
  }
  async function persistRound(projectId, round) {
    const project = requiredProject(projectId), directory = path.join(project.workspaceDir, 'rounds', round.id);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${round.revision ?? 0}.json`), temporary = `${file}.${randomUUID()}.tmp`;
    const cached = roundCache.get(projectId);
    const sameMaterial = cached?.path === file && cached.round.format === round.format && cached.round.revision === round.revision;
    if (!sameMaterial) { await writeFile(temporary, JSON.stringify(round), 'utf8'); await rename(temporary, file); }
    roundCache.set(projectId, { path: file, round });
    const tasks = store.tasks(projectId, { reviewRoundId: round.id });
    updateProject(projectId, { textRound: { id: round.id, path: file, phase: round.stage ?? 'translation',
      targetCount: round.targetIds.length, ...(round.committedAt ? { committedAt: round.committedAt } : {}),
      candidates: tasks.filter(task => task.status === 'succeeded').length, progress: reviewRoundProgress(round, tasks) } });
    if (round.stage === 'committed') { roundCache.delete(projectId); roundChecks.delete(projectId); }
    return round;
  }
  function saveReviewProgress(projectId, round) {
    const pointer = requiredProject(projectId).textRound;
    if (pointer?.id !== round.id || pointer.phase !== round.stage) return;
    const tasks = store.tasks(projectId, { reviewRoundId: round.id });
    updateProject(projectId, { textRound: { ...pointer, progress: reviewRoundProgress(round, tasks),
      candidates: tasks.filter(task => task.status === 'succeeded').length } });
  }
  async function loadRound(projectId) {
    const pointer = requiredProject(projectId).textRound;
    if (!pointer) return undefined;
    if (roundCache.get(projectId)?.path === pointer.path) return roundCache.get(projectId).round;
    const round = JSON.parse(await readFile(pointer.path, 'utf8'));
    if (round.projectId !== projectId || round.id !== pointer.id) throw new Error('校对轮次与项目不匹配，请保留工作目录并检查轮次材料');
    round.stage = pointer.phase;
    roundCache.set(projectId, { path: pointer.path, round }); return round;
  }
  function finishTerminology(projectId, canWrite = () => true) {
    const project = requiredProject(projectId);
    let units = textSnapshot(projectId).units;
    let glossary = scanTerminology(units, project.nameGlossary, project.runConfig?.targetLanguage ?? project.targetLanguage);
    const byId = new Map(units.map(unit => [unit.id, unit]));
    store.transaction(projectId, () => {
      for (const patch of terminologyUpdates(units, glossary)) {
        const unit = byId.get(patch.id);
        if (!unit || !canWrite(unit) || unit.locked || unit.manualLock) continue;
        try {
          validateTranslation(unit, patch.translation, { submitted: true, targetLanguage: project.runConfig?.targetLanguage ?? project.targetLanguage });
          const previous = unit.terminologyNormalization;
          commitUnit(projectId, unit, { translation: patch.translation, terminologyNormalization: {
            sourceHash: unit.sourceHash,
            originalTranslation: previous?.sourceHash === unit.sourceHash && previous.appliedTranslation === unit.translation
              ? previous.originalTranslation : unit.translation,
            appliedTranslation: patch.translation,
          } }, unit.revision);
        } catch (error) { addIssue(projectId, 'terminology', `姓名字段保留现有译文：${errorMessage(error)}`, unit.id, 'warning'); }
      }
    });
    units = textSnapshot(projectId).units;
    glossary = scanTerminology(units, glossary, project.runConfig?.targetLanguage ?? project.targetLanguage);
    if (glossary.hash !== project.nameGlossary?.hash) updateProject(projectId, { nameGlossary: glossary });
    return { units, glossary };
  }
  async function planReview(projectId, round) {
    if (!round.scopeTransport) round = await persistRound(projectId,
      prepareReviewTransport(round, store.tasks(projectId, { reviewRoundId: round.id })));
    const current = textSnapshot(projectId).units;
    const glossary = requiredProject(projectId).nameGlossary;
    const check = { id: round.id, version: store.unitVersion(projectId), glossaryHash: glossary?.hash };
    const previousCheck = roundChecks.get(projectId);
    const refreshed = previousCheck?.id === check.id && previousCheck.version === check.version && previousCheck.glossaryHash === check.glossaryHash
      ? { round, changedIds: [] } : refreshReviewRound(round, current, undefined, glossary);
    roundChecks.set(projectId, check);
    if (refreshed.round !== round) {
      round = refreshed.round;
      const affected = new Set(refreshed.changedIds);
      for (const task of store.tasks(projectId, { reviewRoundId: round.id })) {
        if (task.reviewReadIds?.some(id => affected.has(id))) {
          active.get(task.id)?.controller.abort(); store.putTask(projectId, { ...task, status: 'stale' });
        }
      }
      await persistRound(projectId, round);
    }
    let tasks = store.tasks(projectId, { reviewRoundId: round.id });
    for (const stage of ['scene', 'consistency']) {
      if (stage === 'consistency' && round.stage === 'scene' && !tasks.some(task => task.reviewStage === stage)) continue;
      const valid = new Set(currentReviewTasks(round, tasks, stage).map(task => task.id));
      const planned = new Set(reviewScopes(round, stage, tasks).map(scope => scope.id));
      for (const task of tasks.filter(task => task.reviewStage === stage && task.status !== 'stale')) {
        if (valid.has(task.id)) {
          if (!planned.has(task.reviewScopeId) && ['queued', 'running'].includes(task.status)) {
            active.get(task.id)?.controller.abort(); store.putTask(projectId, { ...task, status: 'paused' }); task.status = 'paused';
          }
          continue;
        }
        active.get(task.id)?.controller.abort(); store.putTask(projectId, { ...task, status: 'stale' }); task.status = 'stale';
      }
    }
    if (round.stage === 'scene' && reviewStageComplete(round, tasks, 'scene')) {
      round = await persistRound(projectId, { ...round, stage: 'consistency' });
    }
    if (round.stage === 'consistency' && reviewStageComplete(round, tasks, 'consistency')) {
      round = await persistRound(projectId, { ...round, stage: 'resolve' });
    }
    const scopes = round.stage === 'resolve' ? reviewOutcome(round, tasks).unresolved : reviewScopes(round, round.stage, tasks);
    const view = reviewView(round, tasks), byId = new Map(view.units.map(unit => [unit.id, unit]));
    const selected = requiredProject(projectId).runConfig.connections.proofreading;
    let capacity = Math.max(0, Math.max(16, settings.concurrency * 4) - tasks.filter(task => ['running', 'queued'].includes(task.status)).length);
    for (const scope of scopes) {
      if (!capacity) break;
      const version = reviewScopeVersion(round, scope, tasks, round.stage, byId);
      const existing = tasks.findLast(task => task.reviewStage === round.stage && task.reviewScopeId === scope.id && task.reviewScopeVersion === version);
      if (existing && ['queued', 'running', 'succeeded', 'skipped'].includes(existing.status)) continue;
      const task = { ...existing, id: existing?.id ?? randomUUID(), projectId, role: 'proofreading', kind: `review-${round.stage}`,
        reviewRoundId: round.id, reviewStage: round.stage, reviewScopeId: scope.id, reviewScopeVersion: version,
        fingerprint: sha256([round.id, round.stage, scope.id, version]), promptVersion: PROMPT_VERSION,
        reviewReadIds: scope.readIds, unitIds: scope.unitIds, input: scope.unitIds.map(id => byId.get(id)).filter(Boolean).map(({ id, revision, sourceHash }) => ({ id, revision, sourceHash })),
        status: 'queued', connection: clone(selected), targetLanguage: requiredProject(projectId).runConfig.targetLanguage,
        attempts: existing?.attempts ?? 0, ...(existing?.status === 'stale' ? { windowAttempts: 0, transportWindowAttempts: 0, error: undefined } : {}), createdAt: existing?.createdAt ?? now() };
      store.putTask(projectId, task); tasks.push(task); capacity--;
    }
    if (scopes.length || tasks.some(task => ['running', 'queued'].includes(task.status))) {
      updateProject(projectId, { stage: { scene: '逐场景校对', consistency: '核对译名与疑点', resolve: '核对修改分歧' }[round.stage] }); return;
    }
    if (round.stage !== 'resolve') return;
    const outcome = reviewOutcome(round, tasks), baseline = new Map(round.units.map(unit => [unit.id, unit]));
    const proposals = new Map(outcome.units.map(unit => [unit.id, unit]));
    const accepted = reconcileCandidates({ units: outcome.units, allUnits: round.units, candidates: proposals,
      validate: (unit, translation) => validateTranslation(unit, translation, { submitted: translation !== baseline.get(unit.id)?.translation,
        targetLanguage: requiredProject(projectId).runConfig?.targetLanguage }), requireComplete: true });
    if (accepted.remaining.length) {
      updateProject(projectId, { status: 'paused', stage: '校对修改待确认', lastError: accepted.errors.join('；') || '关联显示字段需保持一致，候选已保存' }); return;
    }
    const latest = new Map(textSnapshot(projectId).units.map(unit => [unit.id, unit]));
    if (round.targetIds.some(id => latest.get(id)?.revision !== baseline.get(id)?.revision || latest.get(id)?.sourceHash !== baseline.get(id)?.sourceHash)) { wake(); return; }
    store.transaction(projectId, () => {
      for (const proposal of outcome.units) {
        const unit = latest.get(proposal.id);
        if (unit.locked || unit.manualLock) continue;
        const skipped = outcome.skippedIds.includes(unit.id);
        const open = outcome.issues.some(issue => issue.unitId === unit.id && issue.resolution === 'open');
        commitUnit(projectId, unit, { translation: proposal.translation, notes: proposal.notes,
          ...(!skipped && !open ? { terminologyNormalization: undefined, terminologyReview: {
            sourceHash: unit.sourceHash, translation: proposal.translation,
            decisions: (round.glossary?.entries ?? []).filter(entry => entry.unitIds?.includes(unit.id)).map(terminologyReviewStamp),
          } } : {}), ...(skipped ? skipRecord(projectId, unit, 'proofreading') : { status: 'proofread' }), review: skipped
            ? proposal.translation === unit.translation && proposal.sourceHash === unit.sourceHash ? unit.review : undefined
            : { roundId: round.id, reviewedAt: now(),
            reviewId: `round-${round.id}-${round.revision}`, status: outcome.issues.some(issue => issue.unitId === unit.id && issue.resolution === 'open') ? 'needs_evidence' : 'proofread',
            issues: outcome.issues.filter(issue => issue.unitId === unit.id), sourceRevision: unit.revision } }, unit.revision);
      }
    });
    const resolvedIds = outcome.units.filter(unit => !outcome.skippedIds.includes(unit.id)
      && !outcome.issues.some(issue => issue.unitId === unit.id && issue.resolution === 'open')).map(unit => unit.id);
    resolveIssues(projectId, ['review-evidence', 'text-question'], resolvedIds);
    for (const issue of outcome.issues.filter(issue => issue.resolution === 'open')) addIssue(projectId, 'review-evidence', issue.message, issue.unitId);
    await persistRound(projectId, { ...round, stage: 'committed', committedAt: now() });
    updateProject(projectId, { nameGlossary: scanTerminology(textSnapshot(projectId).units,
      requiredProject(projectId).nameGlossary, requiredProject(projectId).runConfig?.targetLanguage) });
    wake();
  }
  function plan(projectId) {
    if (planning.has(projectId)) return planning.get(projectId);
    const promise = planProject(projectId).finally(() => planning.delete(projectId));
    planning.set(projectId, promise); return promise;
  }
  async function planProject(projectId) {
    if (closing || textPausePending(projectId)) return;
    let project = requiredProject(projectId);
    const inScope = createRunScope(project.runConfig?.scopeUnitIds);
    const tasks = store.tasks(projectId, { statuses: ['paused', 'queued', 'running'] }).filter(task => {
      if (!['glossary', 'glossary-repair'].includes(task.kind)) return true;
      store.putTask(projectId, { ...task, status: 'cancelled', replacementReason: 'post-translation-terminology' });
      return false;
    });
    const index = createTaskIndex(tasks, {
      lookupFingerprint: fingerprint => store.taskByFingerprint(projectId, fingerprint),
      orderFor: task => store.taskOrder(task.id),
    });
    const queueWindow = Math.max(16, settings.concurrency * 4);
    let planningUnits;
    const enqueue = (role, units, kind) => queue(project, index, role, units, kind, planningUnits);
    const adapting = project.adaptationRequest && !project.adaptationDeferred;
    if (adapting) {
      enqueue('technical', [], 'adaptation');
      if (!project.prepared || !project.workbenchDir || project.roundtripError || project.acceptance?.pendingIntegration) return;
    }
    if (['all', 'translation'].includes(project.runConfig?.mode ?? 'all') && (project.runConfig?.processImages ?? settings.processImages) && !project.imagesPrepared) { queueImages(projectId); return; }
    let units = planningUnits = textSnapshot(projectId).units;
    let glossary = project.nameGlossary ?? scanTerminology([], undefined, project.runConfig?.targetLanguage ?? settings.targetLanguage);
    const preparation = freshSemanticPreparation(project.semanticPreparation, { units, context: textSnapshot(projectId).context });
    if (!['proofreading', 'review-issues'].includes(project.runConfig?.mode)) for (const decision of preparation.decisions.filter(decision => decision.equivalence)) {
      try {
        const records = semanticReuseRecords(decision, { units, context: textSnapshot(projectId).context, validate: validateTranslation }).filter(record => {
          const unit = units.find(unit => unit.id === record.id);
          return unit?.status === 'pending' && inScope(unit) && !glossaryConflicts(unit, record.translation, glossary).length;
        });
        const candidates = new Map(records.map(record => [record.id, record]));
        const selected = units.filter(unit => candidates.has(unit.id));
        const accepted = reconcileCandidates({ units: selected, allUnits: units, candidates, validate: validateTranslation }).accepted;
        store.transaction(projectId, () => { for (const unit of accepted) {
          const record = candidates.get(unit.id);
          commitUnit(projectId, unit, { translation: record.translation, status: 'translated', semanticDecision: record.semanticDecision }, record.expectedRevision);
        } });
        if (accepted.length) units = planningUnits = textSnapshot(projectId).units;
      } catch (error) { if (!['SEMANTIC_CONFLICT', 'REVISION_CONFLICT'].includes(error.code)) throw error; }
    }
    let round = project.textRound?.phase === 'committed' ? { id: project.textRound.id, stage: 'committed' } : await loadRound(projectId);
    if (round?.format && round.stage !== 'committed') { await planReview(projectId, round); return; }
    if (!round || round.stage === 'committed') {
      const needsReview = project.runConfig?.proofreading ?? settings.proofreading;
      const targets = units.filter(unit => inScope(unit) && (unit.status === 'pending' || needsReview && unit.status === 'translated'));
      if (targets.length) round = await persistRound(projectId, { id: randomUUID(), projectId, targetIds: targets.map(unit => unit.id), stage: 'translation', revision: 0, runId: project.runConfig.runId });
    }
    const roundIds = round && round.stage !== 'committed' ? new Set(round.targetIds) : undefined;
    const scopedUnits = units.filter(unit => inScope(unit) && (!roundIds || roundIds.has(unit.id)));
    const enqueueText = (role, selected, kind) => {
      const available = new Map(selected.map(unit => [unit.id, unit]));
      const reserved = new Set();
      let capacity = queueWindow;
      // Existing batches own their inputs until completion, even after a single manual edit.
      for (const task of tasks.filter(task => task.role === role && task.kind === kind && ['running', 'queued'].includes(task.status))) {
        capacity = Math.max(0, capacity - 1);
        for (const id of task.unitIds) if (available.has(id)) reserved.add(id);
      }
      for (const task of tasks.filter(task => task.role === role && task.kind === kind && task.status === 'paused' && task.targetLanguage === (project.runConfig?.targetLanguage ?? settings.targetLanguage))) {
        if (!capacity) break;
        const reusable = retainTaskUnits(task, [], units, { current: { get: textSnapshot(projectId).context.unitById }, available, reserved });
        if (!reusable.length) continue;
        const resumed = enqueue(role, reusable, kind);
        if (resumed.id !== task.id && (task.candidateRecords?.length || task.evidenceReplies?.length || task.nativeRepair) && taskDependenciesFresh(task)) {
          const ids = new Set(reusable.map(unit => unit.id));
          const dependencies = task.dependencies ? retainDependencySnapshot(task.dependencies, [...ids]) : resumed.dependencies;
          const changedModel = task.connection?.baseUrl !== resumed.connection?.baseUrl || task.connection?.model !== resumed.connection?.model
            || (task.connection?.reasoning ?? 'auto') !== (resumed.connection?.reasoning ?? 'auto');
          store.putTask(projectId, { ...resumed, candidateRecords: task.candidateRecords?.filter(record => ids.has(record.id)),
            dependencies, dependencyHash: dependencies ? dependencyHash(dependencies) : resumed.dependencyHash,
            semanticCandidates: task.semanticCandidates, reviewCandidate: task.reviewCandidate, evidenceReplies: task.evidenceReplies,
            nativeRejections: task.nativeRejections,
            ...(task.nativeRepair ? { nativeRepair: { ...task.nativeRepair, unitIds: task.nativeRepair.unitIds.filter(id => ids.has(id)) } } : {}),
            evidenceReferences: task.evidenceReferences, evidenceRounds: changedModel ? 0 : task.evidenceRounds,
            readingNotes: task.readingNotes, readUnitIds: task.readUnitIds, storyReadingReceipts: task.storyReadingReceipts,
            evidenceExhausted: changedModel ? undefined : task.evidenceExhausted });
        }
        for (const unit of reusable) reserved.add(unit.id);
        capacity--;
      }
      if (!capacity) return;
      const groups = groupUnits(selected.filter(unit => !reserved.has(unit.id))).flatMap(group => group[0]?.context?.syncGroup ? [group] : group.map(unit => [unit]));
      let batches;
      try { batches = packRequestBatches(groups, { role: kind ?? role, targetLanguage: project.runConfig?.targetLanguage ?? settings.targetLanguage,
        maxBatches: capacity, connection: project.runConfig?.connections?.[role],
        allUnits: units, referenceSelector: textSnapshot(projectId).references, glossaryForUnits: batch => relevantGlossary(glossary, batch),
        story: projectStory(projectId, units),
        promptOptions: batch => ({ reviewProtocol: role === 'proofreading', preparation,
          terminologyCandidates: incrementalTerminologyCandidates(units, batch, glossary, project.runConfig?.targetLanguage ?? settings.targetLanguage) }) }); }
      catch (error) {
        if (error.code !== 'TEXT_GROUP_CAPACITY_EXCEEDED') throw error;
        addIssue(projectId, 'text-capacity', errorMessage(error), error.unitIds?.[0], 'warning');
        updateProject(projectId, { status: 'paused', stage: '完整文字组超出模型容量', lastError: errorMessage(error) }); return;
      }
      for (const group of batches) enqueue(role, group, kind);
    };
    const pendingGroups = groupUnits(scopedUnits.filter((u) => u.status === 'pending' && !['proofreading', 'review-issues'].includes(project.runConfig?.mode)));
    const readyGroups = pendingGroups;
    if (!project.sampleValidation && pendingGroups.length) {
      const sample = readyGroups.find((group) => group.some((u) => u.kind === 'message')) ?? readyGroups[0];
      if (sample) enqueueText('translation', sample);
      return;
    }
    enqueueText('translation', readyGroups.flat());
    const proofreading = requiredProject(projectId).runConfig?.proofreading ?? settings.proofreading;
    if (round?.stage === 'translation' && !pendingGroups.length
        && !store.tasks(projectId, { statuses: ['queued', 'running'] }).some(task => task.role === 'translation')) {
      ({ units, glossary } = finishTerminology(projectId, unit => inScope(unit) && (!roundIds || roundIds.has(unit.id))));
    }
    const toProofread = proofreading ? units.filter(u => inScope(u) && (!roundIds || roundIds.has(u.id)) && u.status === 'translated') : [];
    if (proofreading && round?.stage === 'translation' && !pendingGroups.length
        && !store.tasks(projectId, { statuses: ['queued', 'running'] }).some(task => task.role === 'translation')) {
      if (!toProofread.length && round.targetIds.length) {
        updateProject(projectId, { status: 'paused', stage: '本轮文字等待重试', lastError: '本轮尚未取得有效译文，已保留当前成果，可重试问题文字或导出工作包' }); return;
      }
      round = await persistRound(projectId, createReviewRound({ id: round.id, projectId, units,
        targetIds: toProofread.map(unit => unit.id), story: buildStoryContext(units, { sourceRevision: project.sourceFingerprint }), glossary }));
      await planReview(projectId, round); return;
    }
    if (!proofreading && round?.stage === 'translation' && !pendingGroups.length
        && !store.tasks(projectId, { statuses: ['queued', 'running'] }).some(task => task.role === 'translation')) {
      await persistRound(projectId, { ...round, stage: 'committed' }); wake();
    }
  }
  function wake() {
    if (scheduled || closing || closed) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      // Normal queued tasks retain admission priority; technical children fill only the spare slots.
      void pump().finally(() => { for (const attempt of [...taskSlotWaiters]) attempt(); });
    });
  }
  function pauseAfterTextResponses(task, error) {
    const state = recoveryFor(task.projectId);
    state.pause ??= { stage: '接口暂未恢复，稍后继续', lastError: errorMessage(error),
      lastFailure: { taskId: task.id, ...failureDetails(error, task.requestHistory?.at(-1)) } };
    // Stop unpaid admission only. Already sent transports retain their original user signal.
    state.controller.abort(Object.assign(new Error('正在保存其余任务结果'), { code: 'TEXT_RECOVERY_DRAIN' }));
    updateProject(task.projectId, { stage: '正在保存其余任务结果', lastError: state.pause.lastError });
  }
  // A project that still owns an adaptation request but no runnable task retries on a bounded
  // backoff; the previous self-immediate retry burned CPU for hours without changing state.
  const adaptationWakes = new Map(), adaptationDelays = new Map();
  const clearAdaptationWake = projectId => {
    const timer = adaptationWakes.get(projectId);
    if (timer) clearTimeout(timer);
    adaptationWakes.delete(projectId);
  };
  const clearAdaptationWakes = () => {
    for (const timer of adaptationWakes.values()) clearTimeout(timer);
    adaptationWakes.clear(); adaptationDelays.clear();
  };
  function scheduleAdaptationWake(projectId) {
    if (closed || closing || adaptationWakes.has(projectId)) return;
    const delay = adaptationDelays.get(projectId) ?? 2000;
    const timer = setTimeout(() => {
      adaptationWakes.delete(projectId);
      adaptationDelays.set(projectId, Math.min(30000, delay * 2));
      if (closed || closing || requiredProject(projectId).status !== 'running') { adaptationDelays.delete(projectId); return; }
      wake();
    }, delay);
    timer.unref?.();
    adaptationWakes.set(projectId, timer);
  }
  async function pump() {
    if (closing || closed) return;
    for (const project of projects().filter((p) => p.status === 'running')) {
      const pendingPause = textPausePending(project.id);
      if (pendingPause) {
        if (![...active.values()].some(job => job.projectId === project.id)) {
          textRecovery.delete(project.id);
          updateProject(project.id, { status: 'paused', ...pendingPause });
        }
        continue;
      }
      try { await plan(project.id); }
      catch (error) {
        if (closing || closed) return;
        updateProject(project.id, { status: 'paused', stage: '制作进度已保存', lastError: errorMessage(error) });
        addIssue(project.id, 'planning', errorMessage(error), undefined, 'error');
        for (const job of active.values()) if (job.projectId === project.id) job.controller.abort();
        continue;
      }
      if (closing || requiredProject(project.id).status !== 'running' || textPausePending(project.id)) continue;
      const tasks = store.tasks(project.id, { statuses: ['queued'] });
      const lastLane = requiredProject(project.id).executionLanes?.lastServed;
      tasks.sort((left, right) => Number((left.kind === 'adaptation' ? 'technical' : 'text') === lastLane)
        - Number((right.kind === 'adaptation' ? 'technical' : 'text') === lastLane));
      if (tasks.length) adaptationDelays.delete(project.id);
      for (const task of tasks) {
        if (active.has(task.id)) continue;
        if (active.size >= settings.concurrency) return;
        const controller = new AbortController();
        active.set(task.id, { controller, projectId: project.id });
        updateProject(project.id, { executionLanes: { ...requiredProject(project.id).executionLanes, lastServed: task.kind === 'adaptation' ? 'technical' : 'text' } });
        void executeTask(task, controller.signal).catch((error) => {
          if (!closed) {
            const current = store.one('tasks', task.id) ?? task;
            store.putTask(project.id, { ...current, status: 'paused', error: errorMessage(error) });
            addIssue(project.id, 'execution', errorMessage(error), undefined, 'error'); updateProject(project.id, { status: 'paused', stage: '等待继续', lastError: errorMessage(error) });
          }
        }).finally(() => { active.delete(task.id); wake(); });
      }
      if (!tasks.length && ![...active.values()].some((job) => job.projectId === project.id) && !building.has(project.id)) {
        const current = requiredProject(project.id);
        if (current.adaptationRequest && !current.adaptationDeferred) { scheduleAdaptationWake(project.id); continue; }
        if (active.size >= settings.concurrency) return;
        const inScope = createRunScope(project.runConfig?.scopeUnitIds);
        const unfinished = store.units(project.id).some((u) => inScope(u) && ((u.status === 'pending' && !['proofreading', 'review-issues'].includes(project.runConfig?.mode)) || ((project.runConfig?.proofreading ?? settings.proofreading) && u.status === 'translated')));
        if (!unfinished) {
          const counts = store.counts(project.id);
          if (counts.total && counts.skipped === counts.total) {
            updateProject(project.id, { status: 'paused', stage: '文字任务待处理', lastError: '本轮文字任务均未取得有效返回。已保留基线，请检查模型后继续，或导出文字工作包。' });
            continue;
          }
          const taskId = `build:${project.id}`;
          const controller = new AbortController();
          active.set(taskId, { controller, projectId: project.id });
          void api.buildProject({ projectId: project.id, signal: controller.signal }).catch((error) => {
            if (!closed) { addIssue(project.id, 'build', errorMessage(error), undefined, 'error'); updateProject(project.id, { status: error.repairQueued ? 'running' : 'paused', stage: error.repairQueued ? '技术 Agent 正在修复构建' : '构建待处理', lastError: errorMessage(error) }); }
          }).finally(() => { active.delete(taskId); wake(); });
        }
      }
    }
  }
  async function requestRecords({ task, pending, candidates, validate, connection, prompt, signal, onTask, allUnits = pending, semanticReceipts = [], requestContext }) {
    const queueSignal = AbortSignal.any([signal, recoveryFor(task.projectId).controller.signal]);
    queueSignal.throwIfAborted();
    if (task.evidenceExhausted) return ['本轮证据查询已完成，当前疑点与有效成果已保存'];
    prompt = rebindTextPrompt(prompt, task.textWireState);
    const nativeRepair = task.nativeRepair?.unitIds.some(id => pending.some(unit => unit.id === id)) ? task.nativeRepair.message : undefined;
    const feedback = { ...task.lastFailure, message: nativeRepair ?? task.error };
    if (feedback.message && task.requestHistory?.at(-1)?.status !== 'cancelled' && (!feedback.category || feedback.category === 'response_structure')
        && !asError(feedback).global && !stopsTextWindow(feedback)) prompt = repairTextPrompt(prompt, feedback.message);
    const started = Date.now();
    let lastProgress = started;
    const request = { id: randomUUID(), startedAt: now(), requested: pending.length,
      inputCharacters: requestPromptCharacters(prompt), status: 'receiving',
      ...(prompt.budget ? { budget: { ...prompt.budget, characters: requestPromptCharacters(prompt),
        overLimit: Number.isFinite(prompt.budget.limit) && requestPromptCharacters(prompt) > prompt.budget.limit } } : {}) };
    const artifact = await createRequestArtifact({ directory: path.join(requiredProject(task.projectId).workspaceDir, 'requests'), requestId: request.id, diagnostics,
      request: { system: prompt.system, prompt: prompt.prompt, role: task.role, model: connection.model, baseUrl: connection.baseUrl,
        projectId: task.projectId, taskId: task.id, targetUnitIds: pending.map(unit => unit.id),
        requestContext: { projectId: task.projectId, taskId: task.id, purpose: task.role } }, secrets: [...secretValues] });
    await artifact.observe({ type: 'queued' });
    const previous = (task.requestHistory ?? []).slice(-19);
    const save = patch => {
      task = { ...task, ...patch, requestHistory: [...previous, { ...request }] };
      store.putTask(task.projectId, task); onTask(task); emit();
    };
    save({ requestCount: (task.requestCount ?? 0) + 1, ...(prompt.wire ? { textWireState: prompt.wire.state } : {}) });
    const checkpoint = createRecordCheckpoint({ pending, candidates, validate, onChange: summary => {
      Object.assign(request, { returned: summary.returned, checkpointed: summary.accepted });
      for (const unit of pending) if (candidates.has(unit.id)) candidates.set(unit.id, { ...candidates.get(unit.id), requestId: request.id });
      save({ candidateRecords: [...candidates.values()], responseSummary: { requested: pending.length, ...summary } });
    } });
    const preserveNotes = records => Array.isArray(records) ? records.map(record => ({ ...record,
      ...(Object.hasOwn(record ?? {}, 'notes') ? { notes: modelNotes(pending.find(unit => unit.id === record.id), record.notes) } : {}) })) : records;
    let response;
    try {
      await artifact.observe({ type: 'cooldown' });
      await cooldown.wait(connectionKey(connection), queueSignal);
      queueSignal.throwIfAborted();
      // Nothing is bought for stale material: the last gate before the transport call re-checks it
      // and hands the batch back for a replan instead of paying for output that cannot be used.
      // Review scopes carry their own version and read fresh text per page, so they keep their path.
      if (!task.reviewRoundId && !taskMaterialFresh(task)) throw Object.assign(new Error('共享术语、查询结果或目标文字在发送前已更新，本批已重新规划'), { code: 'PRESEND_STALE' });
      if (!task.reviewRoundId && task.input.some(input => { const current = store.unit(task.projectId, input.id); return current && (current.revision !== input.revision || current.sourceHash !== input.sourceHash); })) {
        throw Object.assign(new Error('本批目标文字在发送前已被修改，已按最新版本重新规划'), { code: 'PRESEND_STALE' });
      }
      assertTextRequestCapacity({ connection, system: prompt.system, prompt: prompt.prompt, unitIds: pending.map(unit => unit.id) });
      response = await provider({ role: task.role, connection, ...prompt, signal, queueSignal,
        onTransport: event => artifact.observe(event),
        onRecords: records => checkpoint.append(preserveNotes(records)),
        onProgress: progress => {
          request.receivedCharacters = progress.receivedCharacters;
          request.textCharacters = progress.textCharacters ?? 0;
          request.reasoningCharacters = progress.reasoningCharacters ?? 0;
          if (Date.now() - lastProgress < 1000) return;
          lastProgress = Date.now();
          save({});
        } });
      // A paid response keeps its accounting even when the host rejects its text afterwards.
      Object.assign(request, providerFailure(response));
      save({});
      const readIds = new Set([...(task.readUnitIds ?? []), ...(prompt.material?.unitIds ?? []), ...(prompt.material?.referenceIds ?? [])]);
      if (response?.evidenceRequests?.length && requestContext) {
        // A request for more evidence is provisional; earlier independent candidates stay saved.
        for (const unit of pending) candidates.delete(unit.id);
        Object.assign(request, { status: 'received', elapsedMs: Date.now() - started, finishedAt: now(), evidenceQuery: true });
        request.artifact = await artifact.finish(response);
        const reading = response.evidenceRequests.every(item => item.query?.story || item.reason === 'read-scope');
        if (!reading && (task.evidenceRounds ?? 0) >= 4) {
          for (const unit of pending) addIssue(task.projectId, 'semantic-evidence', '本轮证据查询已保存，当前文字保留，可补充资料后继续核对', unit.id);
          save({ evidenceExhausted: true, candidateRecords: [...candidates.values()] });
          return ['本轮已完成四轮证据补查，剩余含义作为待补证据保存'];
        }
        const actualUnits = task.reviewRoundId ? allUnits : textSnapshot(task.projectId).units;
        const basePrompt = taskPrompt(requestContext.role, pending, task.targetLanguage, [], requestContext.glossary,
          { ...requestContext.promptOptions, wireState: task.textWireState, evidenceResults: [], evidenceHistory: compactEvidenceHistory(task.evidenceReplies ?? []),
            readingNotes: response.readingNotes ?? task.readingNotes });
        const resolved = resolveEvidenceRequests(response.evidenceRequests, actualUnits, {
          story: requestContext.story ?? projectStory(task.projectId, actualUnits),
          maxCharacters: Math.max(1000, textRequestLimits(connection).maxCharacters - requestPromptCharacters(basePrompt) - 500) });
        const newlyRead = resolved.units.filter(unit => !readIds.has(unit.id));
        const previousPages = new Set((task.storyReadingReceipts ?? []).map(receipt => sha256(receipt)));
        const readingProgress = newlyRead.length || resolved.storyReceipts.some(receipt => receipt.unitIds?.length && !previousPages.has(sha256(receipt)));
        if (reading && !readingProgress && (task.readNoProgress ?? 0) >= 2) throw Object.assign(new Error('阅读请求连续返回相同材料，已保存当前阅读位置'), { code: 'READ_NO_PROGRESS' });
        const compactReading = reading && typeof response.readingNotes === 'string' && response.readingNotes.trim().length;
        const previousEvidence = new Set((task.evidenceReplies ?? []).flatMap(answer => answer.returnedIds ?? []));
        const baseReferences = requestContext.references.filter(unit => !previousEvidence.has(unit.id));
        const references = [...new Map([...resolved.units, ...baseReferences].map(unit => [unit.id, unit])).values()];
        const evidenceReplies = [...(task.evidenceReplies ?? []), ...resolved.answers];
        const added = createDependencySnapshot({ units: [], referenceUnits: resolved.units, receipts: resolved.receipts,
          preparation: requestContext.promptOptions.preparation, promptVersion: PROMPT_VERSION, targetLanguage: task.targetLanguage });
        const base = task.dependencies ?? textDependencies(requiredProject(task.projectId), pending);
        const dependencies = { ...base, receipts: [...new Map([...base.receipts, ...added.receipts].map(receipt => [sha256(receipt), receipt])).values()],
          decisions: [...new Map([...base.decisions, ...added.decisions].map(decision => [decision.id, decision])).values()] };
        save({ dependencies, dependencyHash: dependencyHash(dependencies), evidenceReplies,
          evidenceReferences: references.filter(unit => !pending.some(target => target.id === unit.id)), evidenceRounds: (task.evidenceRounds ?? 0) + (reading ? 0 : 1),
          readUnitIds: [...new Set([...readIds, ...resolved.units.map(unit => unit.id)])],
          ...(compactReading ? { readingNotes: response.readingNotes } : {}),
          storyReadingReceipts: [...(task.storyReadingReceipts ?? []), ...resolved.storyReceipts],
          readNoProgress: reading && !readingProgress ? (task.readNoProgress ?? 0) + 1 : 0,
          candidateRecords: [...candidates.values()] });
        // An evidence round is only usable while every read stays valid: a query answer can change when
        // new project material appears, so this check stays project-wide.
        if (!taskDependenciesFresh(task)) throw Object.assign(new Error('补查期间文字资料已有更新，正在按最新资料重新安排'), { code: 'REVISION_CONFLICT' });
        const nextContext = { ...requestContext, references, promptOptions: { ...requestContext.promptOptions, wireState: task.textWireState, evidenceResults: evidenceReplies, readingNotes: task.readingNotes } };
        const nextPrompt = taskPrompt(nextContext.role, pending, task.targetLanguage, references, nextContext.glossary, nextContext.promptOptions);
        return requestRecords({ task, pending, candidates, validate, connection, prompt: nextPrompt, signal, onTask, allUnits: actualUnits,
          semanticReceipts: [...semanticReceipts, ...resolved.receipts], requestContext: nextContext });
      }
      let review;
      if (response?.review) {
        for (const unit of pending) candidates.delete(unit.id);
        // Revision ownership belongs to the captured request, not a number copied by the model.
        const captured = new Map(pending.map(unit => [unit.id, unit.revision]));
        const bound = Array.isArray(response.review.edits) ? { ...response.review,
          edits: response.review.edits.map(edit => ({ ...edit, expectedRevision: captured.get(edit?.id),
            ...(Object.hasOwn(edit ?? {}, 'notes') ? { notes: modelNotes(pending.find(unit => unit.id === edit?.id), edit.notes) } : {}) })) } : response.review;
        review = materializePartialReviewResponse(bound, { units: pending, allUnits, validate });
        response.records = review.records.map(({ id, translation, notes }) => ({ id, translation, notes }));
      }
      checkpoint.finish(preserveNotes(response?.records));
      request.artifact = await artifact.finish(response);
      Object.assign(request, { status: 'received', elapsedMs: Date.now() - started, finishedAt: now() });
      const semanticCandidate = response.semanticDecisions?.length ? { requestId: request.id,
        decisions: clone(response.semanticDecisions), receipts: clone(semanticReceipts),
        inputRevisions: pending.map(unit => ({ id: unit.id, revision: unit.revision, sourceHash: unit.sourceHash })) } : undefined;
      save({ responseSummary: { ...task.responseSummary, finishReason: response.finishReason },
        ...(review ? { reviewCandidate: review } : {}),
        ...(semanticCandidate ? { semanticCandidates: [...(task.semanticCandidates ?? []), semanticCandidate] } : {}) });
      return [...checkpoint.errors, ...(review?.errors ?? []).map(error => error.message)];
    } catch (error) {
      const info = asError(error);
      request.artifact = await artifact.fail(error, response);
      Object.assign(request, { status: signal.aborted || textPausePending(task.projectId) ? 'cancelled' : 'failed', elapsedMs: Date.now() - started,
        finishedAt: now(), error: errorMessage(error), ...(info.code ? { code: info.code } : {}), ...(info.status ? { httpStatus: info.status } : {}),
        ...providerFailure(error) });
      if (isTransientRequestFailure(error)) cooldown.defer(connectionKey(connection), error, task.transportWindowAttempts ?? 0);
      save({ candidateRecords: [...candidates.values()], error: errorMessage(error), lastFailure: failureDetails(error, request) });
      throw error;
    }
  }
  async function executeReviewTask(initial, signal) {
    const projectId = initial.projectId;
    let task = { ...initial, status: 'running' };
    const round = await loadRound(projectId);
    if (!round || round.id !== task.reviewRoundId || round.stage !== task.reviewStage) { store.putTask(projectId, { ...task, status: 'stale' }); return; }
    const tasks = store.tasks(projectId, { reviewRoundId: round.id });
    const scope = (task.reviewStage === 'resolve' ? reviewResolutionScopes(round, tasks) : reviewScopes(round, task.reviewStage, tasks)).find(item => item.id === task.reviewScopeId);
    if (!scope || reviewScopeVersion(round, scope, tasks, task.reviewStage) !== task.reviewScopeVersion) { store.putTask(projectId, { ...task, status: 'stale' }); return; }
    const view = reviewView(round, tasks, task.reviewStage), byId = new Map(view.units.map(unit => [unit.id, unit]));
    const reviewTerms = task.reviewStage === 'scene' ? round.glossary : reviewGlossary(round, tasks);
    const scopeUnits = task.unitIds.map(id => byId.get(id)).filter(Boolean), targets = new Set(task.unitIds);
    const references = scope.readIds.filter(id => !targets.has(id)).slice(0, 32).map(id => byId.get(id)).filter(Boolean);
    const reviewedUnitIds = new Set(task.reviewedUnitIds ?? task.reviewCandidate?.reviewedIds ?? []);
    const candidates = new Map((task.candidateRecords ?? []).filter(record => reviewedUnitIds.has(record.id)).map(record => [record.id, record]));
    const connection = await connectionFor('proofreading', task.connection);
    const validate = (unit, translation) => validateTranslation(unit, translation, { submitted: translation !== unit.translation, targetLanguage: task.targetLanguage });
    while ((task.windowAttempts ?? 0) < textWindowLimit) {
      const attempt = task.windowAttempts ?? 0;
      if (signal.aborted || textPausePending(projectId) || requiredProject(projectId).status !== 'running') { store.putTask(projectId, { ...task, status: 'paused' }); return; }
      task = { ...task, attempts: (task.attempts ?? 0) + 1, windowAttempts: attempt + 1, startedAt: now() }; store.putTask(projectId, task);
      try {
        const remaining = scopeUnits.filter(unit => !candidates.has(unit.id));
        const groups = groupUnits(remaining).flatMap(group => group[0]?.context?.syncGroup ? [group] : group.map(unit => [unit]));
        // Estimate and send with the identical options. Estimating with a thin option set let the
        // real request carry reviewer scope, story material and notes on top — 90,948 characters
        // against a 14,000 budget, which timed out the first wave and stalled the whole round.
        const material = [...new Map([...references, ...(task.evidenceReferences ?? [])].map(unit => [unit.id, unit])).values()];
        const limits = textRequestLimits(connection);
        const referencesForUnits = batch => {
          const ids = new Set(batch.map(unit => unit.id));
          return [...new Map([...collectRequestReferences(view.units, [batch]), ...material].map(unit => [unit.id, unit])).values()].filter(unit => !ids.has(unit.id));
        };
        const priorQuestions = batch => [...new Set(batch.flatMap(unit => [
          ...(unit.review?.status === 'needs_evidence' ? (unit.review.issues ?? []).map(issue => issue.message) : []),
          ...store.all('issues', projectId).filter(issue => !issue.resolvedAt && issue.unitId === unit.id && ['review-evidence', 'text-question'].includes(issue.category)).map(issue => issue.message),
        ]).filter(Boolean))];
        const optionsForUnits = batch => ({ reviewProtocol: true, maxCharacters: limits.maxCharacters,
          reviewScope: { id: scope.id, stage: task.reviewStage, version: task.reviewScopeVersion, title: scope.title,
            readCount: scope.readIds.length, ...((scope.reason || priorQuestions(batch).length) ? { reason: [scope.reason, ...priorQuestions(batch)].filter(Boolean).join('；') } : {}), alternatives: scope.alternatives ?? view.alternatives },
          story: storyMaterialEntrypoints(round.story, batch.map(unit => unit.id)),
          terminologyHints: terminologyHints(reviewTerms, batch),
          evidenceResults: task.evidenceReplies, readingNotes: task.readingNotes });
        const units = packRequestBatches(groups, { role: 'proofreading', targetLanguage: task.targetLanguage, allUnits: view.units,
          connection, maxUnits: task.retryMaxUnits ?? limits.maxUnits,
          referenceSelector: groups => referencesForUnits(groups.flat()), glossaryForUnits: batch => relevantGlossary(reviewTerms, batch),
          promptOptions: optionsForUnits, maxBatches: 1 })[0] ?? [];
        if (!units.length) { store.putTask(projectId, { ...task, status: 'succeeded' }); saveReviewProgress(projectId, round); return; }
        const promptOptions = optionsForUnits(units);
        const glossary = relevantGlossary(reviewTerms, units);
        const pageReferences = referencesForUnits(units);
        const prompt = taskPrompt('proofreading', units, task.targetLanguage, pageReferences, glossary, promptOptions);
        const invalid = await requestRecords({ task, pending: units, candidates, validate, connection, prompt, signal, allUnits: view.units,
          requestContext: { role: 'proofreading', references: pageReferences, glossary, promptOptions, story: round.story }, onTask: next => { task = next; } });
        if (signal.aborted || requiredProject(projectId).status !== 'running') { store.putTask(projectId, { ...task, status: 'paused' }); return; }
        const pageCandidates = new Map(units.filter(unit => candidates.has(unit.id)).map(unit => [unit.id, candidates.get(unit.id)]));
        const reconciled = reconcileCandidates({ units, allUnits: view.units, candidates: pageCandidates, validate });
        for (const unit of units) if (!pageCandidates.has(unit.id)) candidates.delete(unit.id);
        const acceptedIds = new Set(reconciled.accepted.map(unit => unit.id));
        for (const id of task.reviewCandidate?.reviewedIds ?? []) if (acceptedIds.has(id)) reviewedUnitIds.add(id);
        task = { ...task, reviewedUnitIds: [...reviewedUnitIds], candidateRecords: [...candidates.values()] };
        store.putTask(projectId, task);
        if (!acceptedIds.size && (reconciled.remaining.length || invalid.length)) throw new Error([...invalid, ...reconciled.errors, '校对结果尚未覆盖本页目标'].join('；'));
        if (store.one('tasks', task.id)?.status === 'stale') return;
        const issues = [...new Map([...(task.reviewIssues ?? []), ...(task.reviewCandidate?.issues ?? [])].map(issue => [sha256([issue.unitId, issue.kind, issue.message]), issue])).values()];
        const complete = scopeUnits.every(unit => candidates.has(unit.id));
        store.putTask(projectId, { ...task, status: complete ? 'succeeded' : 'queued', candidateRecords: [...candidates.values()],
          reviewedUnitIds: [...reviewedUnitIds],
          reviewIssues: issues, reviewCandidate: { ...task.reviewCandidate, issues }, windowAttempts: 0, transportWindowAttempts: 0,
          reviewChangedIds: changedReviewIds([...candidates.values()], scopeUnits), ...(complete ? { finishedAt: now() } : {}), acceptedAt: undefined });
        saveReviewProgress(projectId, round); emit(); return;
      } catch (error) {
        if (store.one('tasks', task.id)?.status === 'stale') return;
        for (const id of candidates.keys()) if (!reviewedUnitIds.has(id)) candidates.delete(id);
        task = { ...task, error: errorMessage(error), candidateRecords: [...candidates.values()], reviewedUnitIds: [...reviewedUnitIds],
          reviewChangedIds: (task.reviewChangedIds ?? []).filter(id => reviewedUnitIds.has(id)),
          reviewIssues: (task.reviewIssues ?? []).filter(issue => reviewedUnitIds.has(issue.unitId)),
          ...(task.reviewCandidate ? { reviewCandidate: { ...task.reviewCandidate,
            reviewedIds: [...reviewedUnitIds], issues: (task.reviewCandidate.issues ?? []).filter(issue => reviewedUnitIds.has(issue.unitId)) } } : {}) };
        if (signal.aborted || textPausePending(projectId)) { store.putTask(projectId, { ...task, status: 'paused' }); return; }
        const info = asError(error);
        if (isTransientRequestFailure(error)) {
          task = { ...task, windowAttempts: attempt, transportWindowAttempts: (task.transportWindowAttempts ?? 0) + 1 };
          store.putTask(projectId, task);
          if (task.transportWindowAttempts < textWindowLimit) continue;
          store.putTask(projectId, { ...task, status: 'paused' });
          pauseAfterTextResponses(task, error); saveReviewProgress(projectId, round); return;
        }
        if (!info.global && attempt + 1 < textWindowLimit && !stopsTextWindow(error)
            && !['TEXT_GROUP_CAPACITY_EXCEEDED', 'TEXT_REQUEST_CAPACITY_EXCEEDED'].includes(error.code)) { store.putTask(projectId, task); continue; }
        if (error.code === 'MODEL_OUTPUT_TRUNCATED' && attempt + 1 < textWindowLimit && (task.retryMaxUnits ?? scopeUnits.length) > 1) {
          task = { ...task, retryMaxUnits: Math.max(1, Math.floor((task.retryMaxUnits ?? scopeUnits.length) / 2)) };
          store.putTask(projectId, task); continue;
        }
        if (info.global || settings.pauseOnLocalFailure || stopsTextWindow(error) || ['TEXT_GROUP_CAPACITY_EXCEEDED', 'TEXT_REQUEST_CAPACITY_EXCEEDED'].includes(error.code)) {
          store.putTask(projectId, { ...task, status: 'paused' });
          pauseAfterTextResponses(task, error);
        } else {
          store.putTask(projectId, { ...task, status: 'skipped', finishedAt: now() });
          for (const unit of scopeUnits) if (!reviewedUnitIds.has(unit.id)) addIssue(projectId, 'review-evidence', task.error, unit.id);
        }
        saveReviewProgress(projectId, round);
        return;
      }
    }
  }
  async function executeTask(initial, signal) {
    const projectId = initial.projectId;
    const material = requiredProject(projectId);
    let task = { ...initial, status: 'running', productionInput: initial.productionInput ?? {
      generation: material.publication?.generation ?? 0, workbenchDir: material.workbenchDir,
      compositeManifestRef: material.publication?.compositeManifestRef } };
    store.putTask(projectId, task); emit();
    if (task.kind === 'image-ocr') return executeImages(task, signal);
    if (task.role === 'technical') return executeTechnical(task, signal);
    if (task.reviewRoundId) return executeReviewTask(task, signal);
    const initialSnapshot = textSnapshot(projectId), allUnits = initialSnapshot.units;
    const inputs = task.input.map(input => initialSnapshot.context.unitById(input.id)).filter(Boolean);
    const eligible = inputs.filter(unit => unit.status === (task.role === 'proofreading' ? 'translated' : 'pending'));
    let units = retainTaskUnits(task, eligible, allUnits, { current: { get: initialSnapshot.context.unitById } });
    if (!units.length) { store.putTask(projectId, { ...task, status: 'stale' }); return; }
    const connection = await connectionFor(task.role, task.connection);
    const referenceUnits = collectRequestReferences(allUnits, groupUnits(units), textSnapshot(projectId).references);
    const candidates = new Map((task.candidateRecords ?? []).map((record) => [record.id, record]));
    const refreshUnits = () => {
      const current = task.input.map(input => store.unit(projectId, input.id)).filter(Boolean);
units = retainTaskUnits(task, current.filter(unit => unit.status === (task.role === 'proofreading' ? 'translated' : 'pending')), current);
    };
    const validateRecord = (unit, translation) => {
      validateTranslation(unit, translation, { submitted: task.role === 'translation' || translation !== unit.translation,
        targetLanguage: task.targetLanguage ?? settings.targetLanguage });
    };
    const refreshCandidates = (requireComplete = false) => reconcileCandidates({ units, allUnits: textSnapshot(projectId).units, candidates, validate: validateRecord, requireComplete });
    if (!taskDependenciesFresh(task)) {
      task = { ...task, candidateRecords: undefined, reviewCandidate: undefined, semanticDecisions: undefined, semanticCandidates: undefined,
        evidenceReplies: undefined, evidenceReferences: undefined, evidenceRounds: 0, evidenceExhausted: undefined,
        dependencies: textDependencies(requiredProject(projectId), units, allUnits, referenceUnits, task.kind) };
      task.dependencyHash = dependencyHash(task.dependencies);
      candidates.clear(); store.putTask(projectId, task);
    }
    refreshCandidates();
    const pauseSample = (error) => {
      const message = errorMessage(error);
      store.putTask(projectId, { ...task, status: 'paused', error: message });
      updateProject(projectId, { status: 'paused', stage: '首批原生回写待处理', lastError: message });
      addIssue(projectId, 'native-sample', message, undefined, 'error');
      for (const job of active.values()) if (job.projectId === projectId) job.controller.abort();
    };
    const commitCandidates = async (message) => {
      const currentCandidates = () => {
        refreshUnits();
        // Paid tokens stay usable as long as the shared material is unchanged; per-unit CAS and the
        // glossary validator still decide what may be committed.
        if (!taskMaterialFresh(task)) {
          candidates.clear();
          throw Object.assign(new Error('共享资料已更新，正在按最新资料重新安排本批文字'), { code: 'REVISION_CONFLICT' });
        }
        return refreshCandidates(true);
      };
      let { accepted, remaining } = currentCandidates();
      let sampleValidation;
      const project = requiredProject(projectId);
      if (accepted.length && task.role === 'translation' && !project.sampleValidation) {
        updateProject(projectId, { stage: '首批原生回写小样' });
        const sampleDir = path.join(project.workspaceDir, 'samples', randomUUID(), 'data');
        const translations = accepted.filter((u) => !u.legacyId.startsWith('script:') && !u.legacyId.startsWith('image:')).map((u) => ({ id: u.legacyId, legacyId: u.legacyId, translation: candidates.get(u.id).translation, notes: candidates.get(u.id).notes ?? u.notes }));
        let sample;
        const sampleInput = task.productionInput ?? { workbenchDir: project.workbenchDir, ...project.publication };
        try { sample = await workerCall('build', { projectId, workspaceDir: sampleInput.workbenchDir, compositeManifestRef: sampleInput.compositeManifestRef,
          outputDir: sampleDir, translations, fontPath: settings.fontPath || undefined }, signal); }
        catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          failure.stage = 'native-sample';
          const rejected = failure.rejectedTranslations;
          const submitted = new Map(accepted.filter(unit => !unit.legacyId.startsWith('script:') && !unit.legacyId.startsWith('image:')).map(unit => [unit.legacyId, unit]));
          if (failure.code === 'NATIVE_TEXT_REJECTED' && Array.isArray(rejected) && rejected.length && rejected.length <= 256
              && rejected.every(row => submitted.has(row.legacyId) && typeof row.reason === 'string' && row.reason.length)) {
            const rejectedIds = new Set(rejected.map(row => submitted.get(row.legacyId).id));
            const groups = new Set(accepted.filter(unit => rejectedIds.has(unit.id)).map(unit => unit.context?.syncGroup).filter(Boolean));
            const retryIds = new Set(units.filter(unit => rejectedIds.has(unit.id) || groups.has(unit.context?.syncGroup)).map(unit => unit.id));
            const evidence = rejected.map(row => { const unit = submitted.get(row.legacyId), record = candidates.get(unit.id); return {
              unitId: unit.id, legacyId: row.legacyId, reason: row.reason.slice(0, 1024),
              translationHash: sha256(record.translation), ...(record.requestId ? { requestId: record.requestId } : {}), at: now() }; });
            for (const id of retryIds) candidates.delete(id);
            const dependencies = task.dependencies ? { ...task.dependencies,
              receipts: task.dependencies.receipts.filter(receipt => receipt.kind !== 'candidate' || !retryIds.has(receipt.id)) } : undefined;
            const message = `原生文字校验拒绝了以下译文，请按原生原因修正，不得新增引擎语法：${rejected.map(row => `${row.legacyId}：${row.reason}`).join('；')}`.slice(0, 4096);
            task = { ...task, candidateRecords: [...candidates.values()], dependencies,
              dependencyHash: dependencies ? dependencyHash(dependencies) : undefined,
              nativeRejections: [...(task.nativeRejections ?? []), ...evidence].slice(-768),
              nativeRepair: { unitIds: [...retryIds], message }, error: message,
              lastFailure: { code: failure.code, category: 'response_structure', at: now() } };
            store.putTask(projectId, task);
            failure.nativeTextRetryable = true;
          }
          throw failure;
        }
        if (signal.aborted) throw new Error('小样验证已暂停');
        sampleValidation = { path: sample.buildDir ?? sampleDir, unitIds: accepted.map((u) => u.id), productionInput: sampleInput, inputHash: sha256([...candidates.values()]), validatedAt: now(), nativeStructure: 'passed', runtime: 'pending' };
        ({ accepted, remaining } = currentCandidates());
      }
      store.transaction(projectId, () => {
        for (const unit of accepted) {
          const record = candidates.get(unit.id);
          validateRecord(unit, record.translation);
          commitUnit(projectId, unit, { translation: record.translation, notes: modelNotes(unit, record.notes) ?? unit.notes,
            ...(record.termChoices ? { termChoices: record.termChoices } : {}), status: task.role === 'proofreading' ? 'proofread' : 'translated', skipRole: undefined,
            // A paid answer replaces a fanned-out one, so the provenance marker must not outlive it.
            ...(unit.context?.translationSource ? { context: { ...unit.context, translationSource: undefined, translationSourceUnitId: undefined, fannedOutAt: undefined } } : {}),
            ...(task.reviewCandidate ? { review: { reviewId: task.reviewCandidate.reviewId, reviewedAt: now(),
              status: task.reviewCandidate.states.find(state => state.id === unit.id)?.status ?? 'proofread',
              issues: task.reviewCandidate.issues.filter(issue => issue.unitId === unit.id || issue.unitIds?.includes(unit.id)) } } : {}) }, unit.revision);
        }
        if (task.reviewCandidate) resolveIssues(projectId, ['review-evidence'], accepted.map(unit => unit.id));
        if (task.reviewCandidate) for (const issue of task.reviewCandidate.issues) {
          const ids = issue.unitIds ?? [issue.unitId ?? issue.id].filter(Boolean);
          for (const id of ids.filter(id => accepted.some(unit => unit.id === id))) {
            if (!issue.resolved && !['resolved', 'retained_ambiguity'].includes(issue.status)) addIssue(projectId, 'review-evidence', issue.message ?? issue.description ?? '此处含义已保留，补充上下文后可继续核对', id);
          }
        }
        if (task.semanticCandidates?.length) {
          const current = requiredProject(projectId);
          const { units: actualUnits, context } = textSnapshot(projectId);
          const actualById = new Map(actualUnits.map(unit => [unit.id, unit]));
          let preparation = createSemanticState(current.semanticPreparation);
          for (const batch of task.semanticCandidates) try {
            const used = new Set(batch.decisions.flatMap(decision => [...(decision.scope?.unitIds ?? []), ...(decision.evidenceIds ?? [])]));
            for (const input of batch.inputRevisions.filter(input => used.has(input.id))) {
              const committed = accepted.find(unit => unit.id === input.id);
              const record = committed && candidates.get(input.id);
              const changed = committed && (record.translation !== committed.translation || (record.notes ?? committed.notes) !== committed.notes);
              const actual = actualById.get(input.id);
              if (!actual || actual.revision !== input.revision + (changed ? 1 : 0) || actual.sourceHash !== input.sourceHash) {
                throw new Error('语义资料中的文字已由用户更新，已保留当前文字和最新修改。');
              }
            }
            preparation = publishSemanticDecisions(preparation, batch.decisions, { units: actualUnits, context, receipts: batch.receipts, actor: 'agent' });
          } catch (error) { addIssue(projectId, 'semantic-evidence', errorMessage(error)); }
          updateProject(projectId, { semanticPreparation: preparation });
        }
        if (!settings.pauseOnLocalFailure) for (const unit of remaining) {
          const latest = store.unit(projectId, unit.id);
          if (latest.revision === unit.revision) store.putUnit(projectId, { ...latest, ...skipRecord(projectId, latest, task.role) });
        }
        store.putTask(projectId, { ...task, candidateRecords: undefined, commitSummary: { committed: accepted.length, remaining: remaining.length, committedAt: now() }, status: remaining.length ? (settings.pauseOnLocalFailure ? 'paused' : 'skipped') : 'succeeded', finishedAt: now(), error: remaining.length ? message : undefined });
        if (sampleValidation) updateProject(projectId, { sampleValidation });
      });
      if (sampleValidation) { resolveIssues(projectId, ['native-sample']); addIssue(projectId, 'native-sample', '首批文字已通过原生回写与结构验证；继续处理其余场景。实机游玩验收另行记录。', undefined, 'info'); }
      if (accepted.length) {
        refusals.set(projectId, 0);
        resolveIssues(projectId, ['local-skip'], accepted.map(unit => unit.id));
        // Only this batch's own provider/execution evidence is closed; earlier failures stay in the list.
        resolveTaskIssues(projectId, task.id);
      }
      for (const unit of remaining) addIssue(projectId, 'local-skip', message, unit.id);
      if (remaining.length && settings.pauseOnLocalFailure) {
        updateProject(projectId, { status: 'paused', stage: '等待重试', lastError: message });
        for (const job of active.values()) if (job.projectId === projectId) job.controller.abort();
      } else if (requiredProject(projectId).status === 'running') updateProject(projectId, { stage: task.role === 'translation' ? '翻译' : '校对', lastError: undefined });
    };
    // `attempts` stays cumulative for diagnosis; the paid retry loop runs on a per-continuation window.
    while ((task.windowAttempts ?? 0) < textWindowLimit) {
      const attempt = task.windowAttempts ?? 0;
      if (signal.aborted || closed || textPausePending(projectId) || requiredProject(projectId).status !== 'running') { store.putTask(projectId, { ...task, status: 'paused' }); return; }
      task = { ...task, attempts: (task.attempts ?? 0) + 1, windowAttempts: attempt + 1, startedAt: now() };
      store.putTask(projectId, task); emit();
      try {
        refreshUnits();
        if (!units.length) { store.putTask(projectId, { ...task, status: 'stale' }); return; }
        if (!taskDependenciesFresh(task)) {
          candidates.clear();
          const dependencies = textDependencies(requiredProject(projectId), units, undefined, undefined, task.kind);
          task = { ...task, dependencies, dependencyHash: dependencyHash(dependencies), candidateRecords: undefined, reviewCandidate: undefined, semanticDecisions: undefined, semanticCandidates: undefined,
            evidenceReplies: undefined, evidenceReferences: undefined, evidenceRounds: 0, evidenceExhausted: undefined };
          store.putTask(projectId, task);
        }
        refreshCandidates();
        const remainingUnits = units.filter((unit) => !candidates.has(unit.id));
        const limits = textRequestLimits(connection);
        const remainingGroups = groupUnits(remainingUnits).flatMap(group => group[0]?.context?.syncGroup ? [group] : group.map(unit => [unit]));
        const context = [...new Map([...referenceUnits.map(unit => store.unit(projectId, unit.id) ?? unit),
          ...(task.evidenceReferences ?? []), ...units.filter((unit) => candidates.has(unit.id)).map((unit) => ({ ...unit, translation: candidates.get(unit.id).translation, notes: candidates.get(unit.id).notes ?? unit.notes }))]
          .map(unit => [unit.id, unit])).values()];
        const sharedGlossary = relevantGlossary(requiredProject(projectId).nameGlossary, units);
        const optionsForUnits = batch => ({ reviewProtocol: task.role === 'proofreading', maxCharacters: limits.maxCharacters,
          story: storyMaterialEntrypoints(projectStory(projectId), batch.map(unit => unit.id)),
          preparation: freshSemanticPreparation(requiredProject(projectId).semanticPreparation, textSnapshot(projectId)),
          terminologyCandidates: incrementalTerminologyCandidates(textSnapshot(projectId).units, batch, requiredProject(projectId).nameGlossary, task.targetLanguage),
          evidenceResults: task.evidenceReplies, readingNotes: task.readingNotes });
        const pending = remainingUnits.length ? packRequestBatches(remainingGroups, { connection, role: task.role,
          targetLanguage: task.targetLanguage ?? settings.targetLanguage, allUnits: textSnapshot(projectId).units,
          maxUnits: task.retryMaxUnits ?? limits.maxUnits, maxBatches: 1,
          referenceSelector: () => context, glossaryForUnits: () => sharedGlossary, promptOptions: optionsForUnits })[0] : [];
        const semanticReceipts = [...pending.map(unit => createReadReceipt(unit, { translation: unit.translation !== unit.source, notes: Boolean(unit.notes) })),
          ...context.map(unit => {
            const candidate = candidates.get(unit.id), original = units.find(original => original.id === unit.id);
            const changed = candidate && original && (unit.translation !== original.translation || unit.notes !== original.notes);
            return createReadReceipt(changed ? { ...unit, revision: original.revision + 1 } : unit,
              { translation: unit.translation !== unit.source, notes: Boolean(unit.notes) });
          }), ...(task.dependencies?.receipts ?? []).filter(receipt => receipt.kind === 'query')];
        const promptOptions = optionsForUnits(pending);
        const promptRole = task.role;
        const prompt = taskPrompt(promptRole, pending, task.targetLanguage ?? settings.targetLanguage, context, sharedGlossary, promptOptions);
        const dependencies = createDependencySnapshot({ units, referenceUnits: context, candidateRecords: [...candidates.values()], glossary: requiredProject(projectId).nameGlossary,
          preparation: promptOptions.preparation, modelMaterial: prompt.material, promptVersion: PROMPT_VERSION, targetLanguage: task.targetLanguage });
        task = { ...task, dependencies, dependencyHash: dependencyHash(dependencies) }; store.putTask(projectId, task);
        const invalid = pending.length ? await requestRecords({ task, pending, candidates, validate: validateRecord, connection,
          prompt, signal, allUnits: textSnapshot(projectId).units, semanticReceipts,
          requestContext: { role: promptRole, references: context, glossary: sharedGlossary, promptOptions }, onTask: next => { task = next; } }) : [];
        if (signal.aborted || requiredProject(projectId).status !== 'running') { store.putTask(projectId, { ...task, status: 'paused' }); return; }
        refreshUnits(); invalid.push(...refreshCandidates().errors);
        task = { ...task, candidateRecords: [...candidates.values()] };
        store.putTask(projectId, task);
        const missing = units.filter((unit) => !candidates.has(unit.id));
        const message = missing.length ? `本批还需补齐 ${missing.length} 个 ID：${missing.map((u) => u.id).join('、')}${invalid.length ? `。待修正条目：${invalid.join('；')}` : ''}` : undefined;
        if (missing.length && pending.length < remainingUnits.length && pending.every(unit => candidates.has(unit.id))) {
          task = { ...task, windowAttempts: 0, transportWindowAttempts: 0 }; store.putTask(projectId, task); continue;
        }
        if (missing.length && attempt + 1 < textWindowLimit) throw new Error(message);
        await commitCandidates(message);
        return;
      } catch (error) {
        if (signal.aborted || closed || textPausePending(projectId)) { store.putTask(projectId, { ...task, status: 'paused', error: '任务已暂停' }); return; }
        if (error.code === 'PRESEND_STALE' && attempt + 1 < textWindowLimit) {
          // Nothing was sent: replan this batch against the state that changed and try again.
          candidates.clear();
          task = { ...task, dependencies: undefined, candidateRecords: undefined, error: undefined };
          store.putTask(projectId, task); continue;
        }
        if (error.code === 'REVISION_CONFLICT' || error.code === 'PRESEND_STALE') {
          store.putTask(projectId, { ...task, status: 'stale', error: errorMessage(error) });
          return;
        }
        if (error.stage === 'native-sample') {
          if (error.nativeTextRetryable && attempt + 1 < textWindowLimit) continue;
          pauseSample(error);
          return;
        }
        const info = asError(error);
        const message = errorMessage(error);
        task = { ...task, error: message }; store.putTask(projectId, task);
        if (error.code === 'MODEL_OUTPUT_TRUNCATED') {
          const remainingCount = units.filter(unit => !candidates.has(unit.id)).length;
          if (remainingCount && attempt + 1 < textWindowLimit && (remainingCount < (task.truncatedPending ?? units.length) || (task.retryMaxUnits ?? units.length) > 1)) {
            task = { ...task, truncatedPending: remainingCount,
              retryMaxUnits: Math.max(1, Math.floor(Math.min(task.retryMaxUnits ?? units.length, remainingCount) / 2)) }; store.putTask(projectId, task); continue;
          }
          if (candidates.size) {
            try { await commitCandidates(message); }
            catch (failure) { if (failure.stage === 'native-sample') { pauseSample(failure); return; } throw failure; }
          }
          store.putTask(projectId, { ...(store.one('tasks', task.id) ?? task), status: 'paused', error: message, candidateRecords: [...candidates.values()] });
          pauseAfterTextResponses(task, error); return;
        }
        if (isTransientRequestFailure(error)) {
          task = { ...task, windowAttempts: attempt, transportWindowAttempts: (task.transportWindowAttempts ?? 0) + 1 };
          store.putTask(projectId, task);
          if (task.transportWindowAttempts < textWindowLimit) continue;
          store.putTask(projectId, { ...task, status: 'paused', candidateRecords: [...candidates.values()] });
          pauseAfterTextResponses(task, error); return;
        }
        const refused = info.code === 'MODEL_REFUSAL';
        const refusalCount = refused && attempt >= 2 ? (refusals.get(projectId) ?? 0) + 1 : 0;
        if (refused && attempt >= 2) refusals.set(projectId, refusalCount);
        const allTasksRefused = refused && !store.units(projectId).some((unit) => !task.unitIds.includes(unit.id) && (unit.status === 'pending' || (task.role === 'proofreading' && unit.status === 'translated')));
        if (info.global || ['TEXT_GROUP_CAPACITY_EXCEEDED', 'TEXT_REQUEST_CAPACITY_EXCEEDED'].includes(error.code) || (stopsTextWindow(error) && info.code !== 'READ_NO_PROGRESS') || (refused && attempt >= 2 && (refusalCount >= 3 || allTasksRefused))) {
          const failure = { taskId: task.id, ...failureDetails(error, task.requestHistory?.at(-1)) };
          // Provider and refusal pauses are environmental, not textual: the next continue may retry them.
          store.putTask(projectId, { ...task, status: 'paused', error: message, lastFailure: failure });
          addIssue(projectId, info.code === 'MODEL_REFUSAL' ? 'model-refusal' : 'provider', message, undefined, 'error', failure);
          pauseAfterTextResponses(task, error);
          return;
        }
        task = { ...task, error: message };
        store.putTask(projectId, task);
        if (attempt + 1 < textWindowLimit && info.code !== 'READ_NO_PROGRESS') continue;
        if (candidates.size) {
          try { await commitCandidates(message); }
          catch (failure) { if (failure.stage === 'native-sample') pauseSample(failure); else throw failure; }
          return;
        }
        if (settings.pauseOnLocalFailure) {
          // The unit stays pending for retry, but the failed cycle is counted so that repeated
          // continuations cannot bill the same unchanged text without bound.
          store.transaction(projectId, () => {
            for (const unit of units) { const latest = store.unit(projectId, unit.id); if (latest?.revision === unit.revision) store.putUnit(projectId, { ...latest, ...skipCycle(projectId, latest, task.role) }); }
            store.putTask(projectId, { ...task, status: 'paused', error: message, lastFailure: failureDetails(error, task.requestHistory?.at(-1)) });
          });
          updateProject(projectId, { status: 'paused', stage: '等待重试', lastError: message });
          for (const job of active.values()) if (job.projectId === projectId) job.controller.abort();
        } else {
          store.transaction(projectId, () => {
            for (const unit of units) { const latest = store.unit(projectId, unit.id); if (latest.revision === unit.revision) store.putUnit(projectId, { ...latest, ...skipRecord(projectId, latest, task.role) }); }
            store.putTask(projectId, { ...task, status: 'skipped', error: message, finishedAt: now() });
          });
        }
        for (const unit of units) addIssue(projectId, 'local-skip', message, unit.id, 'warning', failureDetails(error, task.requestHistory?.at(-1)));
        return;
      }
    }
  }


  async function deferRemainingAdaptation(projectId, signal) {
    const project = requiredProject(projectId);
    if (!(project.prepared || project.nativePrepared) || !store.counts(projectId).total) throw new Error('请先完成可用文字的提取与原样回写检查');
    try { await workerCall('roundtrip', { projectId, workspaceDir: project.workbenchDir }, signal); }
    catch (error) {
      if (!signal?.aborted) updateProject(projectId, { roundtripError: errorMessage(error) });
      throw error;
    }
    updateProject(projectId, { prepared: true, adaptationDeferred: true, roundtripError: undefined,
      technicalPlan: project.technicalPlan ?? { decision: 'verified-partial', summary: '已验证文字继续制作，剩余资源保留原文', selectedCandidateIds: [] },
      stage: '使用已验证文字继续制作', lastError: undefined });
    addIssue(projectId, 'coverage-deferred', `已验证文字继续制作；${describeRemainingCoverage(project.coverage)}。尚未处理的内容保留原文，可继续补漏。`, undefined, 'warning');
  }

  async function executeAdaptation(initial, signal) {
    const projectId = initial.projectId;
    const task = { ...initial, status: 'running', attempts: initial.attempts + 1 };
    if (!initial.reconciliationOnly) store.putTask(projectId, task);
    // Coverage is settled when the ledger itself reports a terminal state; a ledger that still lists
    // a trigger or an unresolved candidate keeps adapting whatever the per-job outcomes say.
    const coverageSettled = coverage => {
      if (!coverage) return false;
      if (!coverage.needsAdaptation || coverage.completeness === 'complete') return true;
      return !(coverage.triggers?.length) && (coverage.summary?.unresolvedCandidates ?? 0) === 0;
    };
    // Adapter-required candidates are kept out of the trigger list on purpose, so a settled ledger can still
    // hide an unresolved expression. They buy one planned attempt instead of owed coverage: this widens only
    // "should a job be planned", never "is the project settled", so an unsolvable adapter cannot pin a stage.
    const adapterAttemptPending = coverage => (coverage?.summary?.adapterCandidates ?? 0) > 0;
    let project = requiredProject(projectId);
    const reservations = new Set();
    const acquireSlot = ({ worker: slot, signal: admissionSignal }) => {
      if (slot === 0) { admissionSignal.throwIfAborted(); return () => {}; }
      return new Promise((resolve, reject) => {
        const id = `adaptation:${task.id}:${slot}`;
        const clean = () => { taskSlotWaiters.delete(attempt); admissionSignal.removeEventListener('abort', cancel); };
        const cancel = () => { clean(); reject(admissionSignal.reason ?? Object.assign(new Error('技术任务已停止'), { name: 'AbortError' })); };
        const attempt = () => {
          if (admissionSignal.aborted || closing || closed || !active.has(task.id)) { cancel(); return; }
          if (active.size >= settings.concurrency) return;
          clean();
          active.set(id, { projectId, controller: active.get(task.id).controller }); reservations.add(id);
          let released = false;
          resolve(() => {
            if (released) return;
            released = true; reservations.delete(id); active.delete(id); wake();
          });
        };
        taskSlotWaiters.add(attempt); admissionSignal.addEventListener('abort', cancel, { once: true });
        if (admissionSignal.aborted) cancel(); else wake();
      });
    };
    let nativeWorkDir;
    const repairRequired = project.adaptationRequest?.kind === 'build-repair';
    let commit = Promise.resolve(), roundAdded = 0, writerReplaced = false, budgetOwner;
    try {
      budgetOwner = budgetFor(project);
      budgetOwner.reconcile();
      const connection = initial.reconciliationOnly ? undefined : await connectionFor('technical', task.connection);
      const technicalDir = path.join(project.workspaceDir, 'technical', project.adaptationRequest.id);
      await recoverAdaptationBudget({ owner: budgetOwner, directory: technicalDir, signal });
      nativeWorkDir = path.join(technicalDir, 'adapter-workbench');
      const sourceRoot = project.prepared || project.nativePrepared ? (project.imageReadRoot ?? path.resolve(project.gameDir, project.resourceRoot ?? '.')) : project.gameDir;
      const sourceRoots = [...new Set([sourceRoot, path.resolve(project.gameDir, project.resourceRoot ?? '.'), ...(project.technicalSourceRoots ?? [])])];
      const sourceCopyPath = path.join(technicalDir, 'source');
      const resourceJobs = repairRequired ? [] : planAdaptationJobs(project.coverage, { partition: Boolean(project.prepared || project.nativePrepared),
        scopeRequests: project.adaptationRequest.scopeRequests ?? [] });
      const files = resourceJobs.length && resourceJobs.every(job => job.files?.length)
        ? [...new Set(resourceJobs.flatMap(job => job.files))] : undefined;
      const copySourceFiles = (files, { workDir } = {}) => createAdaptationSource({ gameDir: sourceRoot, sourceRoots,
        outputDir: sourceCopyPath, files, dependencyWorkDir: workDir, returnDetails: true, signal });
      if (!initial.reconciliationOnly) updateProject(projectId, { stage: '核对技术资源', adaptationProgress: { ...project.adaptationProgress, status: 'copying', attempts: 0, addedUnits: 0, blocked: false } });
      const sourceDir = await createAdaptationSource({ gameDir: sourceRoot, sourceRoots, outputDir: sourceCopyPath, files, signal,
        onProgress: ({ copied, reused = 0, processed, total }) => { if (!signal.aborted && !closed) updateProject(projectId, { stage: `技术资源 ${processed ?? copied} / ${total ?? copied} · 复用 ${reused} · 补齐 ${copied}` }); },
      });
      const checkOriginalSources = async writeSet => {
        const sources = JSON.parse(await readFile(`${sourceCopyPath}.snapshot.json`, 'utf8'));
        for (const file of writeSet) {
          const original = sources.files.find(row => row.relative === file);
          if (!original) throw Object.assign(new Error('接入资源缺少真实来源绑定'), { code: 'INTEGRATION_SOURCE_STALE', hostFailure: true });
          const root = (sources.sourceRoots ?? [sources.source])[original.sourceIndex ?? 0];
          const digest = createHash('sha256');
          for await (const chunk of createReadStream(await checkedAdapterPath(root, file))) { signal.throwIfAborted(); digest.update(chunk); }
          if (digest.digest('hex') !== original.sha256) throw Object.assign(new Error('原版资源在接受后已变化，保留配方等待重验'), { code: 'INTEGRATION_SOURCE_STALE', hostFailure: true });
        }
      };
      if (project.nativeStage?.path) {
        const relative = path.relative(project.workspaceDir, project.nativeStage.path);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('原生暂存结果需要位于当前项目内');
        const staged = JSON.parse(await readFile(project.nativeStage.path, 'utf8'));
        await nativeTools.seed({ gameDir: sourceDir, workDir: nativeWorkDir, reviewDir: path.join(project.workspaceDir, 'nr'), ...staged });
      }
      const acceptanceDirectory = path.join(technicalDir, 'accepted-receipts');
      const capabilities = await (await getLab()).describeVerificationCapabilities?.();
      if (capabilities?.fingerprint) updateProject(projectId, { verificationCapabilityFingerprint: capabilities.fingerprint });
      const acceptance = createAcceptanceLedger({ store, projectId, adaptationRequestId: project.adaptationRequest.id });
      const publication = () => requiredProject(projectId).publication ?? { generation: 0, workbenchDir: requiredProject(projectId).workbenchDir };
      const nextPublication = patch => ({ ...publication(), ...patch, generation: publication().generation + 1 });
      let lastCoverage;
      const refreshCoverage = async (extraUnits = [], decisions = requiredProject(projectId).coverageDecisions ?? []) => {
        const current = requiredProject(projectId), snapshot = textSnapshot(projectId);
        const existing = snapshot.legacyById ??= new Map(snapshot.units.map(unit => [unit.legacyId ?? unit.id, unit]));
        const additional = extraUnits.filter(unit => {
          const previous = existing.get(unit.legacyId ?? unit.id);
          return !previous || previous.source !== unit.source
            || adaptationLocationKey(previous.context?.adaptationLocator) !== adaptationLocationKey(unit.locator ?? unit.context?.adaptationLocator);
        });
        const coverage = { ...await scanResources({ projectId, rootDir: sourceRoot, sourceRoots: sourceRoots.slice(1), decisions,
          inventory: { ...current.inventory, coverage: current.inventory?.nativeCoverage },
          units: [...snapshot.units, ...additional], signal }), stale: false, addedUnitsSinceScan: 0 };
        lastCoverage = { coverage, version: snapshot.version, inventory: current.inventory, decisionsHash: sha256(decisions) };
        return coverage;
      };
      const checkCoverage = createCoverageBatcher(extraction => refreshCoverage(extraction.units,
        extraction.coverageDecisions ?? requiredProject(projectId).coverageDecisions ?? []));
      const integratedReviews = new Set();
      const integrateNativeReviews = async inputs => {
        const receipts = [];
        for (const input of inputs) {
          if (!integratedReviews.has(input.id) && !receipts.some(receipt => receipt.id === input.id)) receipts.push(await nativeTools.resolveNativeReview({ receiptId: input.id, gameDir: sourceDir, workDir: input.workDir, signal }));
        }
        if (!receipts.length) return;
        const receipt = receipts[0], decisions = new Map();
        for (const item of receipts) {
          if (sha256(item.baseline) !== sha256(receipt.baseline)) throw new Error('原生字段合批需要相同的验证基线');
          for (const decision of item.decisions) {
            if (decisions.has(decision.groupId) && sha256(decisions.get(decision.groupId)) !== sha256(decision)) throw new Error('同一原生类型组包含冲突决定，已有成果保持原样');
            decisions.set(decision.groupId, decision);
          }
        }
        const current = requiredProject(projectId);
        const nativePublicationVersion = sha256([current.adaptationRequest?.id, current.adaptationRequest?.jobs,
          current.adaptationRequest?.ownerTransfers, current.sourceFingerprint, current.publication?.generation ?? 0, current.workbenchDir]);
        const sameBaseline = receipts.length === 1 && receipt.extraction && receipt.baseline
          && sha256(await nativeWorkbenchIdentity(current.workbenchDir)) === sha256(receipt.baseline);
        // A receipt already validated this result. Rebase only when an earlier concurrent
        // receipt advanced the main workbench, so its accepted bindings cannot be lost.
        let extraction = receipt.extraction;
        if (!sameBaseline) {
          const outputDir = await nativeTools.allocateReviewWorkbench({ workDir: nativeWorkDir, reviewDir: path.join(current.workspaceDir, 'nf') });
          try {
            extraction = await workerCall('native_adapt', { projectId, workspaceDir: current.workbenchDir, outputDir, decisions: [...decisions.values()] }, signal);
            for (const expected of decisions.values()) {
              const accepted = extraction.nativeReviewDecisions?.find(item => item.groupId === expected.groupId && item.evidenceHash === expected.evidenceHash
                && item.file === expected.file && item.disposition === expected.disposition);
              if (!accepted || (expected.fields ?? []).some(field => !(accepted.fields ?? []).some(actual => sha256(actual.path) === sha256(field.path)
                && actual.kind === field.kind && (field.displaySites ?? []).every(site => actual.displaySites?.includes(site))))) throw new Error('原生字段合批需要保留全部已验证字段及显示绑定');
            }
            const check = await workerCall('roundtrip', { projectId, workspaceDir: extraction.workspaceDir ?? extraction.workDir }, signal);
            if (check?.passed === false || check?.valid === false || check?.byteIdentical === false) throw new Error('原生字段合批的无改动回写检查失败');
            await nativeTools.finishReviewWorkbench({ workspaceDir: outputDir, status: 'verified', receipts: receipts.map(item => item.id),
              baseline: await nativeWorkbenchIdentity(current.workbenchDir), decisions: [...decisions.values()], validation: check });
          } catch (error) {
            await nativeTools.finishReviewWorkbench({ workspaceDir: outputDir, status: 'failed', receipts: receipts.map(item => item.id),
              error: { code: error.code, message: String(error.message ?? error) } });
            throw error;
          }
        }
        const workbenchDir = extraction.workspaceDir ?? extraction.workDir;
        if (!workbenchDir || !Array.isArray(extraction.units)) throw new Error('原生字段接入需要完整可回写的文字工作台');
        try { await writeFile(path.join(workbenchDir, 'pinhao-composite-adapter.json'), await readFile(path.join(current.workbenchDir, 'pinhao-composite-adapter.json'))); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (current.publication?.compositeManifestRef) {
          const file = current.publication.compositeManifestRef.file;
          await mkdir(path.dirname(path.join(workbenchDir, file)), { recursive: true });
          await writeFile(path.join(workbenchDir, file), await readFile(path.join(current.workbenchDir, file)));
        }
        const incoming = await withControlEvidence(extraction.units.map(raw => extractedUnit(projectId, raw)), workbenchDir, current.scriptBinding);
        const existing = new Map(store.units(projectId).map(unit => [unit.id, unit]));
        const seen = new Set(), additions = [];
        for (const unit of incoming) {
          if (seen.has(unit.id)) throw new Error('原生字段接入发现重复文字 ID');
          seen.add(unit.id);
          const previous = existing.get(unit.id);
          if (previous) {
            if (previous.sourceHash !== unit.sourceHash || sha256(previous.tokens) !== sha256(unit.tokens)
                || previous.context?.controlFingerprint !== unit.context?.controlFingerprint) throw new Error('原生字段接入的基线已变化，已有译文保持原样');
          } else { validateTranslation(unit, unit.translation); additions.push(unit); }
        }
        const stagedFile = path.join(workbenchDir, 'technical', 'pinhao-native-extraction.json');
        const staged = JSON.parse(await readFile(current.nativeStage.path, 'utf8'));
        if (staged.extraction.units.some(raw => !seen.has(extractedUnit(projectId, raw).id))) throw new Error('原生字段接入需要保留已有原生文字与回写定位');
        await writeFile(stagedFile, JSON.stringify({ probe: staged.probe, extraction }));
        signal.throwIfAborted();
        const diagnostics = groupReviewDiagnostics(extraction.reviewItems ?? []);
        await checkOriginalSources([...new Set(receipts.flatMap(item => item.files ?? item.decisions.map(decision => decision.file)))]);
        store.transaction(projectId, () => {
          signal.throwIfAborted();
          const latest = requiredProject(projectId);
          if (sha256([latest.adaptationRequest?.id, latest.adaptationRequest?.jobs, latest.adaptationRequest?.ownerTransfers,
            latest.sourceFingerprint, latest.publication?.generation ?? 0, latest.workbenchDir]) !== nativePublicationVersion)
            throw Object.assign(new Error('原生接入版本已变化，保留成果等待重新对账'), { code: 'INTEGRATION_PENDING', hostFailure: true });
          const position = store.counts(projectId).total;
          additions.forEach((unit, index) => { store.putUnit(projectId, unit, position + index); store.addRevision(projectId, unit); });
          updateProject(projectId, { workbenchDir, publication: nextPublication({ workbenchDir }), coverage: markCoverageStale(latest.coverage, additions.length), nativeStage: { ...latest.nativeStage, path: stagedFile, unitCount: incoming.length, status: 'verified',
            initialWorkbenchDir: latest.nativeStage.initialWorkbenchDir ?? project.workbenchDir, previousWorkbenchDir: current.workbenchDir },
            sourceFingerprint: additions.length ? sha256([...existing.values(), ...additions]
              .map(unit => [unit.legacyId, unit.sourceHash, unit.tokens, unit.context?.controlFingerprint,
                adaptationLocationKey(unit.context?.adaptationLocator, unit.context?.file)])
              .sort(([left], [right]) => left.localeCompare(right))) : latest.sourceFingerprint,
            inventory: { ...latest.inventory, nativeManifestPath: path.join(workbenchDir, 'manifest.json'), reviewItems: compactReviewItems(extraction.reviewItems ?? []),
              nativeCoverage: extraction.coverage, processedResources: extraction.processedResources ?? latest.inventory.processedResources,
              unitCount: position + additions.length, kinds: [...new Set([...existing.values(), ...additions].map(unit => unit.kind))] },
            adaptationRequest: { ...latest.adaptationRequest, integratedUnitIds: [...(latest.adaptationRequest?.integratedUnitIds ?? []), ...additions.map(unit => unit.id)] } });
        });
        nativeTools.commitReviewWorkbenches({ workspaceDirs: [...receipts.map(item => item.extraction.workspaceDir ?? item.extraction.workDir), workbenchDir] });
        roundAdded += additions.length;
        updateReviewIssue(projectId, diagnostics);
        await nativeTools.seed({ gameDir: sourceDir, workDir: nativeWorkDir, reviewDir: path.join(current.workspaceDir, 'nr'), probe: staged.probe, extraction });
        receipts.forEach(item => integratedReviews.add(item.id));
      };
      let pendingReviews = [], reviewFlush;
      const enqueueNativeReviews = inputs => new Promise((resolve, reject) => {
        pendingReviews.push({ inputs, resolve, reject });
        if (reviewFlush) return;
        reviewFlush = commit.then(async () => {
          // Join receipts already arriving in this turn; independent validation remains concurrent.
          await new Promise(setImmediate);
          const requests = pendingReviews; pendingReviews = []; reviewFlush = undefined;
          const groups = new Map();
          try {
            for (const request of requests) for (const input of request.inputs) {
              if (integratedReviews.has(input.id)) continue;
              const receipt = await nativeTools.resolveNativeReview({ receiptId: input.id, gameDir: sourceDir, workDir: input.workDir, signal });
              const key = sha256(receipt.baseline), groupsForBaseline = groups.get(key) ?? [];
              let group = groupsForBaseline.at(-1);
              if (!group || group.decisions + receipt.decisions.length > 100) { group = { inputs: [], decisions: 0 }; groupsForBaseline.push(group); groups.set(key, groupsForBaseline); }
              if (!group.inputs.some(item => item.id === input.id)) { group.inputs.push(input); group.decisions += receipt.decisions.length; }
            }
            for (const groupsForBaseline of groups.values()) for (const group of groupsForBaseline) await integrateNativeReviews(group.inputs);
            requests.forEach(request => request.resolve());
          } catch (error) { requests.forEach(request => request.reject(error)); }
        });
        commit = reviewFlush.catch(() => {});
      });
      const verifyCoverage = async extraction => {
        if (extraction.nativeReviews?.length) {
          await enqueueNativeReviews(extraction.nativeReviews);
        }
        return checkCoverage(extraction);
      };
      if (project.nativeStage?.retainedWorkbenches?.length) {
        const restored = await nativeTools.restoreNativeReviews({ gameDir: sourceDir, workDir: nativeWorkDir,
          projectDir: project.workspaceDir, retained: project.nativeStage.retainedWorkbenches, signal });
        if (restored.receipts.length) {
          try { await enqueueNativeReviews(restored.receipts); }
          catch (error) {
            signal.throwIfAborted();
            restored.failures.push({ code: error.code ?? 'NATIVE_REVIEW_REBASE_PENDING', message: errorMessage(error) });
          }
        }
        const current = requiredProject(projectId);
        updateProject(projectId, { nativeStage: { ...current.nativeStage, reviewRestore: {
          restored: restored.receipts.length, failures: restored.failures } } });
        for (const failure of restored.failures) addIssue(projectId, 'adaptation', `待接入候选已保留：${failure.message}`, undefined, 'warning', failure);
      }
      // Restored receipts can carry older diagnostics; project coverage from the latest accepted workbench.
      const currentStage = requiredProject(projectId);
      if (currentStage.nativeStage?.path) {
        const staged = JSON.parse(await readFile(currentStage.nativeStage.path, 'utf8'));
        if (staged.probe?.engine === 'Unity') {
          const projected = await workerCall('native_review', { projectId, workspaceDir: currentStage.workbenchDir, acceptedOnly: true, coverageOnly: true }, signal);
          if (!Array.isArray(projected?.reviewItems)) throw new Error('原生显示覆盖检查需要返回完整待处理清单');
          staged.extraction.reviewItems = projected.reviewItems;
          updateProject(projectId, { inventory: { ...currentStage.inventory, reviewItems: compactReviewItems(projected.reviewItems) } });
          updateReviewIssue(projectId, groupReviewDiagnostics(projected.reviewItems));
          await nativeTools.seed({ gameDir: sourceDir, workDir: nativeWorkDir, reviewDir: path.join(project.workspaceDir, 'nr'), ...staged });
        }
      }
      const initialCoverage = await refreshCoverage();
      const integrate = async (item, acceptedRecord, { bootstrapAdded = 0 } = {}) => {
        const current = requiredProject(projectId);
        if (!(current.prepared || current.nativePrepared)) throw Object.assign(new Error('已接受成果等待首次工作台准备'), { code: 'INTEGRATION_PENDING', hostFailure: true });
        const baseGeneration = publication().generation;
        const baseSource = current.sourceFingerprint;
        const writeSet = [...new Set([...(item.units ?? []).map(unit => unit.context?.carrier ?? unit.locator?.file),
          ...(item.binding?.verificationPlan?.writeGroups ?? []).flatMap(group => group.writeSet)].filter(Boolean))];
        const ownerFingerprint = () => {
          const request = requiredProject(projectId).adaptationRequest;
          if (!acceptedRecord) return sha256(request?.jobs);
          const origin = acceptedRecord.payload.originOwnerId;
          const owner = (request?.jobs ?? []).find(job => (job.ownerId ?? job.id) === origin
            && (job.assignmentRevision ?? 0) === acceptedRecord.payload.assignmentRevision
            && (!job.files || writeSet.every(file => job.files.includes(file))));
          const transfer = (request?.ownerTransfers ?? []).find(row => row.originOwnerId === origin
            && row.originRevision === acceptedRecord.payload.assignmentRevision
            && writeSet.every(file => row.files.includes(file)) && request.jobs.some(job => job.id === row.targetOwnerId));
          if (!owner && !transfer && !(origin === 'coordinator' && request?.jobs?.some(job => !job.files))) throw Object.assign(new Error('已接受成果的写入归属已改变，保留回执等待对账'), { code: 'INTEGRATION_OWNER_STALE', hostFailure: true });
          return sha256([owner ?? transfer, request?.ownerTransfers]);
        };
        const ownerRevision = ownerFingerprint();
        const checkProof = async () => {
          const adapter = await getLab();
          if (adapter.assertAcceptedFresh) await adapter.assertAcceptedFresh({ extraction: item, gameDir: sourceDir, projectId, signal });
          await checkOriginalSources(writeSet);
        };
        await checkProof();
        const assertPublication = () => {
          const latest = requiredProject(projectId);
          signal.throwIfAborted();
          if (latest.adaptationRequest?.id !== project.adaptationRequest.id || publication().generation !== baseGeneration
              || latest.sourceFingerprint !== baseSource || ownerFingerprint() !== ownerRevision) throw Object.assign(new Error('接入版本已改变，保留成果等待重新对账'), { code: 'INTEGRATION_PENDING', hostFailure: true });
        };
        const publish = async (action, result) => {
          const commitPublication = () => acceptedRecord ? acceptance.commit(acceptedRecord.id, () => { assertPublication(); action(); return result; })
            : store.transaction(projectId, () => { assertPublication(); action(); return result; });
          const adapter = await getLab();
          return adapter.withAcceptedPublication ? adapter.withAcceptedPublication({ extraction: item, projectId, gameDir: sourceDir, signal, commit: commitPublication }) : commitPublication();
        };
        if (!item.workspaceDir || !Array.isArray(item.units)) throw new Error('已验证配方需要独立工作台和文字定位');
        if (current.adaptationRequest?.kind === 'build-repair') {
          const sameIdentity = (raw, previous) => previous && raw.source === previous.source
            && adaptationLocationKey(raw.locator, raw.locator?.file, raw.context?.formatBinding)
            && adaptationLocationKey(raw.locator, raw.locator?.file, raw.context?.formatBinding)
              === adaptationLocationKey(previous.context?.adaptationLocator, previous.context?.file, previous.context?.formatBinding)
            && sha256(raw.tokens ?? []) === sha256(previous.tokens ?? [])
            && sha256(Object.fromEntries(Object.entries(raw.controls ?? {}).sort(([a], [b]) => a.localeCompare(b)))) === (previous.context?.controlFingerprint ?? sha256({}));
          const existing = new Map(store.units(projectId).map(unit => [unit.legacyId, unit]));
          let binding;
          try { binding = await readAdapterRecord(path.join(current.workbenchDir, 'pinhao-adapter-binding.json')); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (binding && item.units.length === binding.units.length && item.units.every(raw => binding.units.some(previous => previous.id === (raw.legacyId ?? raw.id)) && sameIdentity(raw, existing.get(raw.legacyId ?? raw.id)))) {
            try {
              const composite = await readFile(path.join(current.workbenchDir, 'pinhao-composite-adapter.json'));
              await writeFile(path.join(item.workspaceDir, 'pinhao-composite-adapter.json'), composite);
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (current.publication?.compositeManifestRef) {
              const file = current.publication.compositeManifestRef.file;
              await mkdir(path.dirname(path.join(item.workspaceDir, file)), { recursive: true });
              await writeFile(path.join(item.workspaceDir, file), await readFile(path.join(current.workbenchDir, file)));
            }
            await workerCall('roundtrip', { projectId, workspaceDir: item.workspaceDir }, signal);
            await checkProof();
            await publish(() => updateProject(projectId, { workbenchDir: item.workspaceDir,
              publication: nextPublication({ workbenchDir: item.workspaceDir }),
              inventory: { ...current.inventory, nativeManifestPath: path.join(item.workspaceDir, 'manifest.json') } }), { addedUnits: 0, registryChanged: true, generation: baseGeneration + 1 });
            writerReplaced = true;
            return 0;
          }
          let composite;
          try { composite = await readSupplementManifest(current.workbenchDir, current.publication?.compositeManifestRef); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          const repairable = new Set(composite?.adapters?.flatMap(adapter => adapter.unitIds) ?? []);
          const replacements = item.units.filter(raw => repairable.has(raw.legacyId ?? raw.id) && sameIdentity(raw, existing.get(raw.legacyId ?? raw.id)));
          if (replacements.length) {
            const registry = await prepareSupplement({ workspaceDir: current.workbenchDir, adapterWorkspaceDir: item.workspaceDir,
              unitIds: replacements.map(raw => raw.legacyId ?? raw.id), units: replacements,
              files: [...new Set([...replacements.map(raw => raw.locator.file), ...(item.binding?.verificationPlan?.writeGroups ?? []).flatMap(group => group.writeSet)])],
              baselineDir: sourceDir, sourceRoot, resourceRoot: current.resourceRoot, replaceVerified: true,
              currentManifestRef: current.publication?.compositeManifestRef, verificationPlan: item.binding?.verificationPlan });
            await checkProof();
            await publish(() => { if (registry.registryChanged) updateProject(projectId, { publication: nextPublication({ compositeManifestRef: registry.manifestRef }) }); },
              { addedUnits: 0, registryChanged: registry.registryChanged, generation: baseGeneration + Number(registry.registryChanged) });
            writerReplaced = true;
            return 0;
          }
        }
        const nativeLocations = await (await import('../technical/coverage.mjs')).resolveNativeLocations({ inventory: current.inventory, units: textSnapshot(projectId).units, roots: [sourceDir], signal });
        const selected = selectSupplementalUnits({ projectId, incoming: item.units, existing: store.units(projectId), nativeLocations });
        if (!selected.units.length) {
          await checkProof(); assertPublication();
          if (acceptedRecord) await publish(() => {
            if (bootstrapAdded) updateProject(projectId, { publication: nextPublication({ workbenchDir: current.workbenchDir }),
              adaptationRequest: { ...current.adaptationRequest, integratedUnitIds: [...new Set([...(current.adaptationRequest?.integratedUnitIds ?? []), ...store.units(projectId).map(unit => unit.id)])] } });
          }, { addedUnits: bootstrapAdded, registryChanged: bootstrapAdded > 0, generation: baseGeneration + Number(bootstrapAdded > 0) });
          roundAdded += bootstrapAdded;
          return bootstrapAdded;
        }
        const registry = await prepareSupplement({ workspaceDir: current.workbenchDir, adapterWorkspaceDir: item.workspaceDir,
          unitIds: selected.rawUnits.map(unit => unit.legacyId ?? unit.id), units: selected.rawUnits,
          files: [...new Set([...selected.rawUnits.map(unit => unit.locator.file), ...(item.binding?.verificationPlan?.writeGroups ?? []).flatMap(group => group.writeSet)])], baselineDir: sourceDir, sourceRoot, resourceRoot: current.resourceRoot,
          currentManifestRef: current.publication?.compositeManifestRef, verificationPlan: item.binding?.verificationPlan });
        await checkProof();
        await publish(() => {
          const position = store.counts(projectId).total;
          selected.units.forEach((unit, index) => { store.putUnit(projectId, unit, position + index); store.addRevision(projectId, unit); });
          const latest = requiredProject(projectId);
          updateProject(projectId, { publication: nextPublication({ compositeManifestRef: registry.manifestRef }), coverage: markCoverageStale(latest.coverage, selected.units.length), inventory: { ...latest.inventory, unitCount: position + selected.units.length },
            adaptationRequest: { ...latest.adaptationRequest, integratedUnitIds: [...(latest.adaptationRequest?.integratedUnitIds ?? []), ...selected.units.map(unit => unit.id)] } });
        }, { addedUnits: selected.units.length, registryChanged: registry.registryChanged, generation: baseGeneration + 1 });
        roundAdded += selected.units.length;
        return selected.units.length;
      };
      const consumeAccepted = async record => {
        const saved = acceptance.enqueue(record);
        if (saved.status === 'integrated') return { ...saved.result, reused: true };
        updateProject(projectId, { acceptance: acceptance.summary() });
        try {
          const item = await readAcceptedBatch({ directory: acceptanceDirectory, record });
          const current = requiredProject(projectId);
          let bootstrapAdded = 0;
          if (!(current.prepared || current.nativePrepared)) {
            if (!item.workspaceDir || !item.units?.length) throw Object.assign(new Error('首次工作台材料尚未准备好'), { code: 'INTEGRATION_PENDING', hostFailure: true });
            const prepared = await prepareProject({ gameDir: current.gameDir, name: current.name, outputDir: current.outputDir }, projectId, undefined,
              { probe: { engine: item.engine ?? current.engine, root: '.', capabilities: { extract: true, nativeBuild: true, assist: false } },
                extraction: item, scripts: { units: [], binding: current.scriptBinding ?? null }, allowAdditional: true });
            if (!requiredProject(projectId).prepared) throw Object.assign(new Error(prepared.lastError ?? '首次工作台验证待继续'), { code: 'INTEGRATION_PENDING', hostFailure: true });
            const latest = requiredProject(projectId);
            bootstrapAdded = Math.max(0, store.counts(projectId).total - (current.inventory?.unitCount ?? 0));
            updateProject(projectId, { status: current.status, runConfig: current.runConfig,
              adaptationRequest: { ...current.adaptationRequest, ...latest.adaptationRequest } });
          }
          const addedUnits = await integrate(item, record, { bootstrapAdded });
          const latest = requiredProject(projectId);
          updateProject(projectId, { acceptance: acceptance.summary(), adaptationProgress: { ...latest.adaptationProgress,
            addedUnits: roundAdded, integratedUnits: latest.adaptationRequest?.integratedUnitIds?.length ?? 0 } });
          if (latest.status === 'running') await plan(projectId);
          wake();
          return { addedUnits, generation: publication().generation };
        } catch (error) {
          const stale = error.code?.includes('STALE') || error.code === 'FORMAT_QUALIFICATION_REVOKED';
          acceptance.mark(record.id, stale ? 'stale' : 'pending', error);
          updateProject(projectId, { acceptance: acceptance.summary() });
          if (saved.status === 'stale' && stale) return { addedUnits: 0, generation: publication().generation, stale: true };
          error.hostFailure = true;
          throw error;
        }
      };
      const enqueueAccepted = record => {
        acceptance.enqueue(record);
        updateProject(projectId, { acceptance: acceptance.summary() });
        const operation = commit.then(() => consumeAccepted(record));
        commit = operation.catch(() => {});
        return operation;
      };
      for (const record of await discoverAcceptedBatches(acceptanceDirectory)) await enqueueAccepted(record);
      if (initial.reconciliationOnly) return;
      project = requiredProject(projectId);
      const retryContext = adaptationRetryContext(project);
      const previousRequest = project.adaptationRequest;
      updateProject(projectId, { coverage: initialCoverage, adaptationRequest: { ...previousRequest, retryContext,
        noProgressRounds: previousRequest.noProgressRounds ?? 0,
        integratedUnitIds: previousRequest.integratedUnitIds ?? [], outcomes: previousRequest.outcomes ?? {} } });
      const jobsFor = coverage => {
        const request = requiredProject(projectId).adaptationRequest;
        if (request.kind === 'build-repair') return [{ id: `build-repair-${request.id}`, kind: 'build-repair', files: null }];
        const scopeRequests = [...(request.scopeRequests ?? []), ...(request.jobs ?? []).filter(job => job.files?.length > 1)];
        const requested = coverageSettled(coverage) && !adapterAttemptPending(coverage) ? [] : planAdaptationJobs(coverage, { partition: Boolean(project.prepared || project.nativePrepared), scopeRequests });
        if (scopeRequests.length || requested.some(job => !job.files)) return requested;
        return [...new Map([...(requiredProject(projectId).adaptationRequest.jobs ?? []).filter(job => job.files), ...requested].map(job => [job.id, job])).values()];
      };
      let jobs = jobsFor(initialCoverage);
      let previousJobs = previousRequest.jobs ?? [];
      let result;
      const existingTechnicalUnits = () => {
        const snapshot = textSnapshot(projectId);
        return snapshot.technicalUnits ??= snapshot.units.map(unit => ({ id: unit.legacyId, kind: unit.kind,
          file: unit.file ?? unit.context?.file, locator: unit.locator ?? unit.context?.adaptationLocator,
          source: unit.source, tokens: unit.tokens, context: unit.context }));
      };
      const windowId = task.admissionWindowId ?? `${task.id}:${task.attempts}`;
      const servedInWindow = new Set(task.admissionCompletedJobs ?? []);
      budgetOwner.openWindow({ windowId });
      for (let round = task.admissionPass ?? 0; round < 2; round++) {
      const concurrency = Math.min(Math.max(1, jobs.length), settings.concurrency);
      const beforeCount = store.counts(projectId).total;
      project = requiredProject(projectId);
      const inheritStatesByJob = {};
      for (const job of jobs) if (job.files) {
        const transfers = [];
        for (const old of previousJobs) if (old.files && old.id !== job.id && old.files.some(file => job.files.includes(file))) {
          const statePath = path.join(technicalDir, 'jobs', old.id, 'progress.jsonl');
          try { await stat(statePath); }
          catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          transfers.push({ transferId: sha256([project.adaptationRequest.id, old.id, job.id]), statePath,
            workspaceDir: path.join(technicalDir, 'adapter-workbench', 'jobs', old.id), jobId: old.id, files: old.files });
        }
        inheritStatesByJob[job.id] = transfers;
      }
      const ownerTransfers = [...new Map([...(project.adaptationRequest.ownerTransfers ?? []), ...jobs.flatMap(job =>
        (inheritStatesByJob[job.id] ?? []).map(transfer => ({ transferId: transfer.transferId, originOwnerId: transfer.jobId,
          originRevision: previousJobs.find(old => old.id === transfer.jobId)?.assignmentRevision ?? 0,
          targetOwnerId: job.id, files: job.files, assignmentRevision: job.assignmentRevision ?? 0 })))].map(row => [row.transferId, row])).values()];
      updateProject(projectId, { adaptationRequest: { ...project.adaptationRequest, jobs, ownerTransfers } });
      const admittedJobs = jobs.filter(job => !servedInWindow.has(job.id));
      result = admittedJobs.length ? await runAdaptationPool({ run: adaptResources, jobs: admittedJobs, concurrency, acquireSlot, connection, diagnostics, project: { ...project, sourceDir }, gameDir: sourceDir, readDir: sourceRoot, readRoots: sourceRoots, copySourceFiles,
        requestContext: { owner: budgetOwner, projectId, adaptationRequestId: project.adaptationRequest.id, windowId, taskId: task.id, purpose: 'adaptation',
          controlGrantId: project.adaptationRequest.controlGrantId },
        inheritStatesByJob,
        getExistingUnits: existingTechnicalUnits,
        workspaceDir: path.join(technicalDir, 'adapter-workbench'), lab: await getLab(), inventory: { ...project.inventory,
          existingUnits: existingTechnicalUnits(),
        },
        coverage: project.coverage, failure: project.adaptationRequest.failure, statePath: path.join(technicalDir, 'progress.jsonl'), signal,
        verifyCoverage, hostFailure,
        onAcceptedBatch: (_job, record) => enqueueAccepted(record),
        shouldYield: () => store.tasks(projectId, { statuses: ['queued'] }).some(item => ['translation', 'proofreading'].includes(item.role)),
        lessons: project.technicalLessons ?? [],
        onLessons: lessons => { if (!closed) updateProject(projectId, { technicalLessons: lessons }); },
        onResult: (job, outcome) => {
          const operation = commit.then(async () => {
            if (outcome.coverageDecisions?.length) {
              const current = requiredProject(projectId);
              const decisions = [...new Map([...(current.coverageDecisions ?? []), ...outcome.coverageDecisions].map(decision => [decision.id, decision])).values()];
              if (sha256(decisions) !== sha256(current.coverageDecisions ?? [])) {
                updateProject(projectId, { coverageDecisions: decisions, coverage: markCoverageStale(current.coverage) });
              }
            }
            const additions = [...new Map([...(outcome.extractions ?? (outcome.extraction ? [outcome.extraction] : [])), ...(outcome.partialExtractions ?? [])].map(item => [item.workspaceDir, item])).values()];
            let added = 0;
            for (const item of additions) {
              const record = acceptance.findExtraction(item) ?? await persistAcceptedBatch({ directory: acceptanceDirectory, projectId,
                adaptationRequestId: requiredProject(projectId).adaptationRequest.id,
                assignment: job, extraction: item, candidateId: item.binding?.candidateId, validationId: item.binding?.validationId });
              const committed = await consumeAccepted(record);
              added += committed.reused ? 0 : committed.addedUnits;
            }
            const current = requiredProject(projectId), integratedUnits = current.adaptationRequest.integratedUnitIds.length;
            updateProject(projectId, { adaptationRequest: { ...current.adaptationRequest, outcomes: { ...current.adaptationRequest.outcomes,
              [job.id]: { id: job.id, files: job.files, status: outcome.status, recipeId: outcome.recipe?.recipeId ?? outcome.state?.recipeId,
                reason: outcome.reason ?? outcome.error?.message, stopReason: outcome.stopReason, addedUnits: added,
                continuation: outcome.continuation, stopReasonCode: outcome.stopReasonCode ?? outcome.stopReason,
                blockedNeeds: outcome.blockedNeeds, candidateId: outcome.candidateId, validationId: outcome.validationId } },
              sinceIntegratedOrResolved: added || ['verified', 'resolved'].includes(outcome.status) ? 0 : current.adaptationRequest.sinceIntegratedOrResolved ?? 0 } });
            if (outcome.status !== 'cancelled') servedInWindow.add(job.id);
            return { addedUnits: added, integratedUnits };
          });
          commit = operation.catch(() => {});
          return operation;
        },
        onProgress: progress => { if (!signal.aborted && !closed) updateProject(projectId, { stage: `技术资源已处理 ${progress.processedJobs ?? 0} / ${progress.totalJobs ?? jobs.length} · 通过 ${progress.verifiedJobs ?? 0}`,
          adaptationProgress: { ...progress, addedUnits: roundAdded, integratedUnits: requiredProject(projectId).adaptationRequest.integratedUnitIds.length,
            ...(progress.error ? { error: errorMessage(progress.error) } : {}) } }); },
      }) : { status: 'verified', extractions: [], processedJobs: 0, verifiedJobs: 0, resolvedJobs: 0, pendingJobs: 0, totalJobs: 0, jobs: [] };
      await commit;
      if (result.yielded) {
        store.putTask(projectId, { ...task, status: 'queued', admissionWindowId: windowId, admissionPass: round, admissionCompletedJobs: [...servedInWindow] });
        return;
      }
      delete task.admissionWindowId;
      delete task.admissionPass;
      delete task.admissionCompletedJobs;
      servedInWindow.clear();
      if (result.nativeExtraction) {
        const prepared = await prepareProject({ gameDir: project.gameDir, name: project.name, outputDir: project.outputDir }, projectId, undefined,
          { probe: result.nativeProbe, extraction: result.nativeExtraction, allowAdditional: true });
        const accepted = requiredProject(projectId);
        if (!accepted.prepared) throw new Error(prepared.lastError ?? '原生提取结果正在等待回写验证');
        store.putTask(projectId, { ...task, status: 'succeeded', finishedAt: now() });
        updateProject(projectId, { status: 'running', stage: '原生提取已接入，继续制作', lastError: undefined });
        return;
      }
      const verified = [...new Map([...(result.extractions ?? (result.extraction ? [result.extraction] : [])), ...(result.partialExtractions ?? [])].map(item => [item.workspaceDir, item])).values()];
      if (!(requiredProject(projectId).prepared || requiredProject(projectId).nativePrepared) && verified.length) {
        const extraction = verified[0];
        if (!extraction?.workspaceDir || !extraction.units?.length) throw new Error('已验证配方需要可回写的文字工作台');
        const probe = { engine: extraction.engine ?? project.engine, root: '.', capabilities: { extract: true, nativeBuild: true, assist: false } };
        const checkpoint = requiredProject(projectId);
        const prepared = await prepareProject({ gameDir: project.gameDir, name: project.name, outputDir: project.outputDir }, projectId, undefined,
          { probe, extraction, scripts: { units: [], binding: project.scriptBinding ?? null }, allowAdditional: true });
        project = requiredProject(projectId);
        if (!project.prepared) throw new Error(prepared.lastError ?? '适配成果接入检查待继续');
        roundAdded += extraction.units.length;
        updateProject(projectId, { status: 'running', runConfig: checkpoint.runConfig,
          adaptationRequest: { ...checkpoint.adaptationRequest, ...project.adaptationRequest,
            integratedUnitIds: [...(checkpoint.adaptationRequest?.integratedUnitIds ?? []), ...store.units(projectId).map(unit => unit.id)], retryContext } });
        for (const item of verified.slice(1)) await integrate(item);
      }
      const current = requiredProject(projectId);
      const coverage = result.coverage && lastCoverage?.coverage === result.coverage
        && lastCoverage.version === store.unitVersion(projectId) && lastCoverage.inventory === current.inventory
        && lastCoverage.decisionsHash === sha256(current.coverageDecisions ?? []) ? result.coverage : await refreshCoverage();
      updateProject(projectId, { coverage });
      await writeFile(path.join(technicalDir, 'extraction-coverage.json'), JSON.stringify(coverage, null, 2));
      result.coverage = coverage;
      if (result.scopeRequests?.length) {
        const current = requiredProject(projectId);
        updateProject(projectId, { adaptationRequest: { ...current.adaptationRequest, scopeRequests: result.scopeRequests } });
      }
      if (!repairRequired && coverageSettled(coverage) && (requiredProject(projectId).prepared || requiredProject(projectId).nativePrepared)) result.status = 'verified';
      if (result.status === 'verified' || store.counts(projectId).total === beforeCount && !result.scopeRequests?.length || round === 1) break;
      if (round === 0 && result.status !== 'verified' && store.tasks(projectId, { statuses: ['queued'] }).some(item => ['translation', 'proofreading'].includes(item.role))) {
        store.putTask(projectId, { ...task, status: 'queued', admissionWindowId: windowId, admissionPass: 1, admissionCompletedJobs: [] });
        return;
      }
      previousJobs = [...new Map([...previousJobs, ...jobs].map(job => [job.id, job])).values()];
      jobs = jobsFor(coverage);
      }
      signal.throwIfAborted();
      if (repairRequired && !writerReplaced) {
        const cause = requiredProject(projectId).buildRepair?.error;
        throw Object.assign(new Error(`${cause ? `${cause}。` : ''}构建所需的回写配方仍待修复，诊断与全部译文已保存，可调整技术模型后继续`), { code: 'ADAPTATION_PENDING' });
      }
      const extractions = result.extractions ?? (result.extraction ? [result.extraction] : []);
      if (result.status !== 'verified') {
        const current = requiredProject(projectId);
        const integratedOrResolved = Boolean(roundAdded || result.resolvedJobs || result.verifiedJobs);
        const noProgressRounds = integratedOrResolved ? 0 : (current.adaptationRequest.noProgressRounds ?? 0) + 1;
        const accounting = budgetOwner.snapshot();
        const windowExhausted = !accounting.canOpenWindow || !accounting.canReserveHttp;
        const continuation = result.continuation ?? { action: 'pause', reasonCode: 'NO_HOST_CONTINUATION_DECISION' };
        const automaticContinuation = ['continue', 'replan', 'wait'].includes(continuation.action);
        const blocked = result.retryable === false || (result.retryable !== true && !automaticContinuation);
        const windows = accounting.windowsUsed, remaining = result.coverage?.summary?.unresolvedCandidates ?? 0;
        updateProject(projectId, { adaptationRequest: { ...current.adaptationRequest, noProgressRounds,
          sinceIntegratedOrResolved: integratedOrResolved ? 0 : (current.adaptationRequest.sinceIntegratedOrResolved ?? 0) + 1,
          scopeRequests: result.scopeRequests ?? current.adaptationRequest.scopeRequests }, adaptationProgress: {
          ...current.adaptationProgress, blocked: blocked || windowExhausted, retryable: !blocked && !windowExhausted,
          continuationNeeded: automaticContinuation && !blocked && !windowExhausted,
          continuation, accounting,
          reason: result.reason,
          stopReasonCode: windowExhausted ? 'ADAPTATION_BUDGET_EXHAUSTED' : result.stopReasonCode ?? result.stopReason ?? continuation.reasonCode,
          blockedNeeds: result.blockedNeeds, candidateId: result.candidateId, validationId: result.validationId,
          stopReason: windowExhausted ? windowStopMessage(remaining) : result.reason ?? continuation.reasonCode ?? result.stopReason,
          remainingCandidates: remaining, continuationWindows: windows, windowLimit: adaptationWindowLimit,
        } });
        if (automaticContinuation && !blocked && !windowExhausted) {
          updateProject(projectId, { stage: `调查记录已保存，继续处理剩余资源（已执行 ${windows} 轮）` });
          store.putTask(projectId, { ...task, status: 'queued', continuationWindows: windows });
          return;
        }
        if (windowExhausted) {
          const message = windowStopMessage(remaining);
          store.putTask(projectId, { ...task, status: 'paused', error: message, finishedAt: now() });
          updateProject(projectId, { status: 'paused', stage: '技术适配累计预算已用完', lastError: message });
          addIssue(projectId, 'adaptation', message, undefined, 'warning', { taskId: task.id });
          return;
        }
        if (!settings.pauseOnLocalFailure && (current.prepared || current.nativePrepared) && store.counts(projectId).total) {
          await deferRemainingAdaptation(projectId, signal);
          store.putTask(projectId, { ...task, status: 'succeeded', finishedAt: now(), partial: true });
          return;
        }
        const error = new Error(result.reason ?? result.error?.message ?? '剩余资源与处理原因已保存');
        error.code = 'ADAPTATION_PENDING'; throw error;
      }
      if (requiredProject(projectId).prepared || requiredProject(projectId).nativePrepared) {
        if (!store.counts(projectId).total) throw new Error('资源核对已完成，文字提取仍需要有效定位');
        await workerCall('roundtrip', { projectId, workspaceDir: requiredProject(projectId).workbenchDir }, signal);
      } else {
        const extraction = extractions[0];
        if (!extraction?.workspaceDir || !extraction.units?.length) throw new Error('已验证配方需要可回写的文字工作台');
        const probe = { engine: extraction.engine ?? result.recipe?.manifest?.engine ?? project.engine, root: '.', capabilities: { extract: true, nativeBuild: true, assist: false } };
        const prepared = await prepareProject({ gameDir: project.gameDir, name: project.name, outputDir: project.outputDir }, projectId, undefined,
          { probe, extraction, scripts: { units: [], binding: project.scriptBinding ?? null }, allowAdditional: true, verifiedAdaptation: true });
        if (!requiredProject(projectId).prepared) throw new Error(prepared.lastError ?? '适配成果接入检查待继续');
      }
      if (!coverageSettled(requiredProject(projectId).coverage)) {
        if (!settings.pauseOnLocalFailure) {
          await deferRemainingAdaptation(projectId, signal);
          store.putTask(projectId, { ...task, status: 'succeeded', finishedAt: now(), partial: true });
          return;
        }
        throw new Error('已验证当前配方，资源覆盖仍有待处理项，技术进度已保存');
      }
      budgetOwner.close('verified-and-integrated');
      store.transaction(projectId, () => {
        store.putTask(projectId, { ...task, status: 'succeeded', finishedAt: now() });
        const current = requiredProject(projectId);
        updateProject(projectId, { prepared: true, adaptationRequest: undefined, adaptationDeferred: false, adaptationProgress: { ...current.adaptationProgress, status: 'verified', retryable: false, blocked: false,
          reason: '资源适配已接入，继续文字制作', stopReason: '适配完成', remainingCandidates: 0,
          recipeId: result.recipe?.recipeId, reused: Boolean(result.reused), runtime: result.validation?.runtime ?? { status: 'pending' } },
          technicalPlan: { decision: 'verified-adapter', summary: '技术配方已完成原样回写与改文小样', selectedCandidateIds: [] },
          nameGlossary: scanTerminology(store.units(projectId), current.nameGlossary, current.targetLanguage),
          status: current.status === 'running' ? current.runConfig ? 'running' : 'ready' : current.status,
          runConfig: current.runConfig, stage: current.status === 'running' ? '适配完成，继续文字制作' : current.stage, lastError: undefined,
          inventory: { ...current.inventory, adaptationRecipe: result.recipe?.recipeId },
        });
      });
      resolveIssues(projectId, ['adapter', 'adaptation', 'coverage']);
      addIssue(projectId, 'adaptation-recipe', '已保存可复用技术配方；结构检查和实机游玩记录分别显示。', undefined, 'info');
    } catch (error) {
      await commit;
      if (closed) return;
      const cancelled = signal.aborted;
      const localStorageFailure = !cancelled && ['DISK_SPACE', 'ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM', 'EBUSY', 'ACCEPTANCE_STORAGE_FAILED'].includes(error.code);
      const integrationPending = !cancelled && !localStorageFailure && error.hostFailure;
      const current = requiredProject(projectId);
      const message = cancelled ? undefined : localStorageFailure ? storageFailureMessage : errorMessage(error);
      const failure = { taskId: task.id, ...failureDetails(error) };
      const accounting = budgetOwner?.snapshot();
      // Exceptions do not create a second automatic continuation route. Only a host job decision
      // evaluated above may open a new pool window; accepted data remains recoverable on pause.
      store.putTask(projectId, { ...task, status: 'paused', error: message, ...(cancelled ? {} : { lastFailure: failure }) });
      updateProject(projectId, { status: 'paused',
        stage: localStorageFailure ? '工作文件或磁盘需要处理' : error.code === 'HOST_VALIDATION_OUTPUT_UNAVAILABLE' ? '技术工作目录需要核对' : integrationPending ? '已接受成果需要核对' : cancelled ? '技术适配已暂停' : '技术适配待处理', lastError: message,
        adaptationProgress: { ...current.adaptationProgress, status: cancelled ? 'cancelled' : integrationPending ? 'integration-pending' : 'needs-review', workers: 0, addedUnits: roundAdded,
          jobs: current.adaptationProgress?.jobs?.map(job => ['running', 'queued'].includes(job.status) ? { ...job, status: cancelled ? 'cancelled' : 'needs-review', reason: cancelled ? '任务已暂停，成果持续保留' : errorMessage(error) } : job),
          integratedUnits: current.adaptationRequest?.integratedUnitIds?.length ?? current.adaptationProgress?.integratedUnits ?? 0,
          continuationWindows: accounting?.windowsUsed ?? 0, windowLimit: adaptationWindowLimit, accounting,
          ...(cancelled ? { retryable: true, blocked: false, continuationNeeded: false }
            : localStorageFailure ? { retryable: true, blocked: false, continuationNeeded: false, reason: message, stopReason: message }
            : { continuationNeeded: false, reason: errorMessage(error), stopReason: current.adaptationProgress?.stopReason ?? errorMessage(error) }) } });
      if (!cancelled) addIssue(projectId, 'adaptation', errorMessage(error), undefined, 'error', failure);
    } finally {
      await commit;
      if (nativeWorkDir && store.one('projects', projectId)?.nativeStage?.path) {
        const current = requiredProject(projectId), keep = [project.workbenchDir, current.workbenchDir,
          current.nativeStage?.initialWorkbenchDir, current.nativeStage?.previousWorkbenchDir,
          ...store.tasks(projectId).map(task => task.productionInput?.workbenchDir)];
        for (const workbench of [...new Set(keep.filter(Boolean))]) {
          try {
            const metadata = JSON.parse(await readFile(path.join(workbench, 'technical', 'product-source.json'), 'utf8'));
            if (metadata.nativeSource) keep.push(metadata.nativeSource);
            if (Array.isArray(metadata.additionalSourceRoots)) keep.push(...metadata.additionalSourceRoots);
          } catch (error) { if (error.code !== 'ENOENT') keep.push(path.join(current.workspaceDir, 'nr'), path.join(current.workspaceDir, 'nf')); }
          try {
            const composite = JSON.parse(await readFile(path.join(workbench, 'pinhao-composite-adapter.json'), 'utf8'));
            keep.push(...(composite.adapters ?? []).map(adapter => adapter.workspaceDir).filter(Boolean));
          } catch (error) { if (error.code !== 'ENOENT') keep.push(path.join(current.workspaceDir, 'nr'), path.join(current.workspaceDir, 'nf')); }
        }
        try {
          const cleanup = await nativeTools.settleReviewWorkbenches({ workDir: path.dirname(nativeWorkDir), projectDir: current.workspaceDir,
            keep, retained: current.nativeStage?.retainedWorkbenches ?? [] });
          updateProject(projectId, { nativeStage: { ...current.nativeStage, retainedWorkbenches: cleanup.retained, workbenchCleanup: cleanup.results } });
        } catch (error) { addIssue(projectId, 'adaptation', `临时工作副本已保留：${errorMessage(error)}`, undefined, 'warning'); }
      }
      for (const id of reservations) active.delete(id);
      reservations.clear(); wake();
      if (nativeWorkDir) nativeTools.release({ workDir: path.dirname(nativeWorkDir) });
    }
  }

  async function executeTechnical(initial, signal) {
    if (initial.kind === 'adaptation') return executeAdaptation(initial, signal);
    const projectId = initial.projectId;
    signal.throwIfAborted();
    store.putTask(projectId, { ...initial, status: 'skipped', finishedAt: now(), error: '原生校验结果直接用于制作，无需重复请求技术方案' });
  }

  async function executeImages(initial, signal) {
    const projectId = initial.projectId;
    const task = { ...initial, status: 'running', attempts: initial.attempts + 1 };
    store.putTask(projectId, task); emit();
    try {
      const project = requiredProject(projectId);
      const imageAdapter = await loadImages();
      if (!imageAdapter) {
        updateProject(projectId, { imagesPrepared: true });
        store.putTask(projectId, { ...task, status: 'skipped', error: '图片处理模块未启用' });
        return;
      }
      const connection = await connectionFor('technical', task.connection);
      const result = await imageAdapter.prepareImages({ gameDir: project.imageReadRoot ?? path.resolve(project.gameDir, project.resourceRoot ?? '.'), inventory: project.inventory?.images ?? [], connection, fontPath: settings.fontPath, signal, offset: task.offset, limit: 1,
        materialize: project.workbenchDir ? files => nativeTools.materializeSource({ gameDir: project.gameDir, workspaceDir: project.workbenchDir, files, signal }) : undefined,
        artifactDir: path.join(project.workspaceDir, 'requests', 'images'),
        onProgress: ({ completed, total }) => { if (!closed && !signal.aborted) updateProject(projectId, { stage: `识别图片文字 ${completed}/${total}` }); },
      });
      if (signal.aborted) throw new Error('图片识别已暂停');
      if (!Array.isArray(result.units) || result.binding?.format !== 'pinhao-images-1' || !Array.isArray(result.binding.files) || !Number.isInteger(result.nextOffset) || typeof result.done !== 'boolean' || (!result.done && result.nextOffset <= task.offset)) throw new Error('图片模块返回无效检查点');
      const ids = new Set(store.units(projectId).map((unit) => unit.legacyId));
      const units = [];
      for (const raw of result.units) {
        if (typeof raw.id !== 'string' || !raw.id.startsWith('image:') || ids.has(raw.id) || typeof raw.source !== 'string') throw new Error('图片模块返回重复或无效 ID');
        const unit = { id: `u-${sha256(`${projectId}:${raw.id}`).slice(0, 24)}`, legacyId: raw.id, kind: 'image_text', source: raw.source, sourceHash: sha256(raw.source), translation: raw.source, notes: raw.notes ?? '', tokens: raw.tokens ?? [], context: { ...raw.context, controlFingerprint: sha256({}) }, revision: 0, status: 'pending' };
        try { validateTranslation(unit, unit.source); units.push(unit); ids.add(raw.id); }
        catch (error) { addIssue(projectId, 'image-text', errorMessage(error)); }
      }
      const currentFiles = project.imageBinding?.files ?? [];
      const incomingFiles = new Set(result.binding.files.map((file) => file.relative));
      const binding = { ...result.binding, files: [...currentFiles.filter((file) => !incomingFiles.has(file.relative)), ...result.binding.files] };
      store.transaction(projectId, () => {
        const position = store.counts(projectId).total;
        units.forEach((unit, index) => { store.putUnit(projectId, unit, position + index); store.addRevision(projectId, unit); });
        const base = project.imageSourceBase ?? project.sourceFingerprint;
        const imageIdentity = binding.files.map((file) => [file.relative, file.sourceHash, file.regions]).sort(([a], [b]) => a.localeCompare(b));
        const patch = { imageBinding: binding, imageSourceBase: base, imageOffset: result.nextOffset, imagesPrepared: result.done, sourceFingerprint: sha256({ base, images: imageIdentity }), stage: result.done ? '图片文字已整理' : '继续识别图片文字' };
        updateProject(projectId, patch);
        store.putTask(projectId, { ...task, status: 'succeeded', requestArtifacts: result.requestArtifacts, finishedAt: now() });
      });
      for (const issue of result.issues ?? []) addIssue(projectId, 'image-text', `${issue.file ? `${issue.file}：` : ''}${issue.message}`);
    } catch (error) {
      if (signal.aborted || closed) { if (!closed) store.putTask(projectId, { ...task, status: 'paused' }); return; }
      store.putTask(projectId, { ...task, status: 'skipped', error: errorMessage(error), finishedAt: now() });
      addIssue(projectId, 'image-text', `本轮图片处理保留原图：${errorMessage(error)}`);
      updateProject(projectId, { imagesPrepared: true, stage: '图片原图已保留，继续文字制作' });
    }
  }

  async function prepareProject({ gameDir, name, outputDir, workspaceParent }, retryId, onStarted, supplied) {
      if (!(await stat(gameDir)).isDirectory()) throw new Error('请选择游戏文件夹');
      if (closing || closed) throw new Error('工作台正在关闭');
      const id = retryId ?? randomUUID();
      if (retryId && preparing.has(id)) return detail(id);
      const previous = retryId ? availableProject(retryId) : undefined;
      const workspaceDir = previous?.workspaceDir ?? await createProjectWorkspace({ id, gameDir, workspaceParent });
      const attemptDir = previous ? path.join(workspaceDir, 'preparation', randomUUID()) : workspaceDir;
      await mkdir(attemptDir, { recursive: true });
      if (closing || closed) throw new Error('工作台正在关闭');
      const project = { ...previous, id, name: name?.trim() || previous?.name || path.basename(gameDir), gameDir: path.resolve(gameDir), workspaceDir, storageLayout: PROJECT_LAYOUT,
        outputDir: outputDir ?? previous?.outputDir ?? path.dirname(workspaceDir), engine: previous?.engine ?? '识别中', prepared: false, nativeAttemptRevision: nativeRevision, status: 'preparing', stage: '识别引擎', createdAt: previous?.createdAt ?? now(), updatedAt: now(), targetLanguage: settings.targetLanguage };
      const controller = new AbortController();
      const { signal } = controller;
      let settled;
      preparing.set(id, { controller, done: new Promise((resolve) => { settled = resolve; }) });
      try {
      store.put('projects', project); emit();
      onStarted?.(detail(id));
      let nativePartial;
      try {
        const probe = supplied?.probe ?? await workerCall('probe', { gameDir: project.gameDir, projectId: id }, signal);
        const engine = typeof probe.engine === 'string' ? probe.engine : probe.engine?.id ?? probe.id ?? 'unknown';
        if (Array.isArray(probe.engines)) engines = probe.engines;
        updateCapability(engine, probe.capabilities);
        updateProject(id, { engine, stage: '提取文字' });
        const extraction = supplied?.extraction ?? await workerCall('extract', { gameDir: project.gameDir, projectId: id,
          workspaceDir: path.join(attemptDir, 'workbench'), nativeRecoveryCacheDir: path.join(workspaceDir, 'technical', 'native-recovery-cache'), allowEmpty: true }, signal);
        if (!Array.isArray(extraction.units)) throw new Error('适配器未提供可回写的文字单元');
        const stagedWorkbench = extraction.workspaceDir ?? extraction.workDir;
        nativePartial = extraction.nativeAttempt ? await registerNativeFailure({
          error: { code: 'NATIVE_PARTIAL_EVIDENCE', message: '原生提取保留了部分诊断材料，仍须正式回写验证', ...extraction.nativeAttempt },
          workspaceDir: stagedWorkbench ?? path.join(attemptDir, 'workbench'), projectDir: workspaceDir }) : undefined;
        if (stagedWorkbench) {
          const stagedFile = path.join(stagedWorkbench, 'technical', 'pinhao-native-extraction.json');
          await mkdir(path.dirname(stagedFile), { recursive: true });
          await writeFile(stagedFile, JSON.stringify({ probe, extraction }));
          updateProject(id, { nativeStage: { path: stagedFile, unitCount: extraction.units.length, revision: nativeRevision, status: 'extracted', ...(nativePartial ? { nativePartial } : {}) } });
        }
        const resourceRoot = typeof probe.root === 'string' ? probe.root : '.';
        if (path.isAbsolute(resourceRoot) || resourceRoot.split(/[\\/]/).includes('..')) throw new Error('适配器资源目录定位无效');
        let imageReadRoot = path.resolve(project.gameDir, resourceRoot);
        let technicalSourceRoots = [];
        const extractedWorkbench = extraction.workspaceDir ?? extraction.workDir ?? path.join(attemptDir, 'workbench');
        try {
          const sourceInfo = JSON.parse(await readFile(path.join(extractedWorkbench, 'technical', 'product-source.json'), 'utf8'));
          if (sourceInfo.nativeSource) {
            const relative = path.relative(workspaceDir, sourceInfo.nativeSource);
            if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) imageReadRoot = sourceInfo.nativeSource;
          }
          if (sourceInfo.additionalSourceRoots !== undefined) {
            if (!Array.isArray(sourceInfo.additionalSourceRoots)) throw new Error('技术源目录清单无效');
            const owner = await realpath(workspaceDir);
            technicalSourceRoots = await Promise.all(sourceInfo.additionalSourceRoots.map(async value => {
              if (typeof value !== 'string') throw new Error('技术源目录定位无效');
              let root;
              try { root = await realpath(value); }
              catch (error) { throw new Error('技术源目录不可读取，请重新提取当前工程的资源', { cause: error }); }
              const relative = path.relative(owner, root);
              if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('技术源目录须位于当前工程内');
              return root;
            }));
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        updateProject(id, { technicalSourceRoots });
        const scriptAdapter = await loadScripts();
        const extractedScripts = supplied?.scripts ?? (scriptAdapter ? await scriptAdapter.extractDisplayText(project.gameDir) : { units: [], binding: null });
        const seen = new Set();
        const rawUnits = [...extraction.units, ...(extractedScripts.units ?? [])].map((raw) => {
          const legacyId = raw.legacyId ?? raw.id;
          if (typeof legacyId !== 'string' || seen.has(legacyId) || typeof raw.source !== 'string') throw new Error('适配器返回重复 ID 或无效源文');
          seen.add(legacyId);
          return extractedUnit(id, raw);
        });
        const units = await withControlEvidence(rawUnits, extraction.workspaceDir ?? extraction.workDir ?? path.join(attemptDir, 'workbench'), extractedScripts.binding);
        signal.throwIfAborted();
        const previousUnits = store.units(id);
        const previousIndex = new Map(previousUnits.map((u) => [u.id, u]));
        const incomingIndex = new Map(units.map(unit => [unit.id, unit]));
        if (previousUnits.length && ((!supplied?.allowAdditional && previousUnits.length !== units.length) || previousUnits.some(unit => incomingIndex.get(unit.id)?.sourceHash !== unit.sourceHash))) throw new Error('原版源文已改变，请建立新项目以保留现有文字成果');
        updateProject(id, { workbenchDir: extraction.workspaceDir ?? extraction.workDir ?? path.join(attemptDir, 'workbench'), resourceRoot, imageReadRoot, scriptBinding: extractedScripts.binding, inventory: { nativeManifestPath: path.join(extractedWorkbench, 'manifest.json'), reviewItems: compactReviewItems(extraction.reviewItems ?? []).map((item) => ({ ...item, id: item.id ?? `candidate-${sha256(item).slice(0, 24)}` })), images: extraction.images ?? [], dynamicCandidates: extraction.dynamicCandidates ?? [], nativeCoverage: extraction.coverage, processedResources: extraction.processedResources ?? [], unitCount: units.length, kinds: [...new Set(units.map((u) => u.kind))], capabilities: probe.capabilities, scriptUnits: extractedScripts.units?.length ?? 0 }, sourceFingerprint: sha256({ native: extraction.sourceFingerprint ?? sha256(units.map((u) => [u.legacyId, u.sourceHash])), scripts: (extractedScripts.units ?? []).map((u) => [u.id, sha256(u.source)]) }), stage: '无改动回写验证' });
        const current = requiredProject(id);
        await workerCall('roundtrip', { projectId: id, workspaceDir: current.workbenchDir }, signal);
        const coverage = await scanResources({ projectId: id, rootDir: path.resolve(project.gameDir, resourceRoot), decisions: current.coverageDecisions ?? [], sourceRoots: [...(imageReadRoot !== path.resolve(project.gameDir, resourceRoot) ? [imageReadRoot] : []), ...technicalSourceRoots], inventory: { ...extraction, nativeManifestPath: path.join(extractedWorkbench, 'manifest.json'), reviewItems: current.inventory.reviewItems, images: extraction.images ?? [] }, units, signal });
        await writeFile(path.join(current.workbenchDir, 'extraction-coverage.json'), JSON.stringify(coverage, null, 2));
        // Adapter-required candidates never set needsAdaptation, so they request their own bounded window
        // instead of leaving the derived adapter job plan unreachable.
        const adapterPending = (coverage.summary?.adapterCandidates ?? 0) > 0;
        updateProject(id, { coverage, reviewDiagnosticsVersion: REVIEW_DIAGNOSTICS_VERSION, adaptationRequest: coverage.needsAdaptation || adapterPending
          ? { id: previous?.adaptationRequest?.id ?? randomUUID(), nativeRevision, failure: { code: 'EXTRACTION_COVERAGE', message: adapterPending && !coverage.needsAdaptation ? '资源覆盖记录发现需要外部适配器的显示文字' : '资源覆盖记录发现显示文字缺口', triggers: coverage.triggers, ...(nativePartial?.repairBundle ? { repairBundle: nativePartial.repairBundle } : {}) } }
          : undefined });
        if (!units.length) {
          updateProject(id, { nativePrepared: true });
          throw Object.assign(new Error('原生资源往返已完成，技术 Agent 继续定位显示文字'), { code: 'ZERO_TEXT_UNITS' });
        }
        store.transaction(id, () => {
          units.forEach((unit, index) => {
            const old = store.unit(id, unit.id);
            const next = old ? { ...unit, translation: old.translation, notes: old.notes, revision: old.revision, status: old.status } : unit;
            validateTranslation(next, next.translation); store.putUnit(id, next, index);
            if (!old) store.addRevision(id, next);
          });
        });
        const story = projectStory(id);
        const contextDirectory = path.join(workspaceDir, 'context');
        await mkdir(contextDirectory, { recursive: true });
        await writeFile(path.join(contextDirectory, 'story.json'), JSON.stringify(story), 'utf8');
        updateProject(id, { storyMaterial: { schema: story.schema, version: story.version, sourceRevision: story.sourceRevision,
          scenes: story.scenes.length, characters: story.characters.length, path: path.join(contextDirectory, 'story.json') } });
        for (const issue of extractedScripts.issues ?? []) addIssue(id, 'script-review', `${issue.file}${issue.line ? `:${issue.line}` : ''}：${issue.message}`);
        updateReviewIssue(id, groupReviewDiagnostics(extraction.reviewItems ?? []));
        if (extraction.images?.length) addIssue(id, 'image-text', settings.processImages ? `记录 ${extraction.images.length} 项图片候选；开始制作后识别界面文字，可重绘区域进入文字工作台。` : `保留 ${extraction.images.length} 项图片候选。`, undefined, 'info');
        resolveIssues(id, ['adapter']);
        updateProject(id, { prepared: true, nativePrepared: true, nativeStage: { ...requiredProject(id).nativeStage, status: 'verified' },
          adaptationDeferred: false, nativeDependencyFailure: undefined, roundtripError: undefined, status: 'ready', stage: '文字工作台就绪', lastError: undefined });
      } catch (error) {
        let nativeFailure;
        try { nativeFailure = await registerNativeFailure({ error, workspaceDir: path.join(attemptDir, 'workbench'), projectDir: workspaceDir }); }
        catch (invalidArtifact) { error = invalidArtifact; nativeFailure = { code: error.code, message: errorMessage(error) }; }
        if (nativePartial?.repairBundle && !nativeFailure.repairBundle) nativeFailure = { ...nativeFailure, repairBundle: nativePartial.repairBundle };
        if (!signal.aborted && !isNativeDependencyFailure(error)) {
          updateProject(id, { nativeDependencyFailure: undefined });
          resolveIssues(id, ['native-dependency']);
        }
        if (signal.aborted) updateProject(id, { status: 'paused', stage: '准备已取消', lastError: undefined });
        else if (isNativeDependencyFailure(error)) {
          updateProject(id, { status: 'paused', stage: '原生工具需要处理', lastError: errorMessage(error),
            nativeDependencyFailure: { ...nativeFailure, environmentFingerprint: nativeRevision }, adaptationRequest: previous?.adaptationRequest });
          addIssue(id, 'native-dependency', errorMessage(error), undefined, 'error');
        }
        else if (storageFailure(error)) {
          updateProject(id, { status: 'paused', stage: '工作磁盘需要处理', lastError: storageFailureMessage });
        } else if (hostFailure(error)) {
          updateProject(id, { status: 'paused', stage: '已保存材料需要核对', lastError: errorMessage(error) });
        } else {
          updateProject(id, { status: 'failed', stage: '技术适配就绪', lastError: errorMessage(error), adaptationRequest: { id: previous?.adaptationRequest?.id ?? randomUUID(), nativeRevision, failure: nativeFailure } });
          addIssue(id, 'adapter', errorMessage(error), undefined, 'error');
        }
      }
      return detail(id);
      } finally { preparing.delete(id); settled(); }
  }

  const api = {
    async setAssistEnabled({ projectId, enabled }) {
      requiredProject(projectId);
      if (typeof enabled !== 'boolean') throw new Error('请选择开启或关闭实时辅助');
      updateProject(projectId, { assistEnabled: enabled });
      return detail(projectId);
    },
    async setWorkspaceExecution({ projectId, granted }) {
      const project = requiredProject(projectId);
      if (typeof granted !== 'boolean') throw new Error('请选择允许或撤销本地技术脚本执行');
      if (!granted && (project.status === 'running' || [...active.values()].some(job => job.projectId === projectId))) throw new Error('请先暂停项目，等待技术脚本结束后撤销授权');
      updateProject(projectId, { workspaceExecution: { granted, mode: 'current-user', ...(granted ? { grantedAt: now() } : {}) } });
      return detail(projectId);
    },
    async grantAdaptationBudget({ projectId, grantId, httpAttempts, windows = 1, reason }) {
      const project = availableProject(projectId);
      if (!project.adaptationRequest || project.status === 'running') throw new Error('请先暂停尚未完成的技术任务，再明确追加预算');
      const owner = budgetFor(project);
      owner.grantAdditional({ grantId, httpAttempts, windows, reason });
      updateProject(projectId, { adaptationRequest: { ...project.adaptationRequest, controlGrantId: grantId },
        adaptationProgress: { ...project.adaptationProgress, accounting: owner.snapshot(),
        blocked: false, retryable: true, continuationNeeded: false } });
      return detail(projectId);
    },
    async getRecollection(input) { return recollection.get(input); },
    async scanRecollection(input) {
      try { return await recollection.scan(input); }
      catch (error) { throw Object.assign(new Error(errorMessage(error)), { name: error.name, code: error.code }); }
    },
    async prepareRecollection(input) { return recollection.selection(input); },
    async captureRecollection(input) { return recollection.capture(input); },
    async getRecollectionBackup(input) { return recollection.backup(input); },
    async updateRecollectionBackup(input) { return recollection.update(input); },
    async snapshot() { return { projects: projects().map(summary), settings: publicSettings(settings), engines }; },
    async getProjectContext({ projectId }) { return projectContext(projectId); },
    async getProject({ projectId, summaryOnly = false }) {
      const project = requiredProject(projectId);
      if (project.adaptationProgress?.blocked) await refreshVerificationCapabilities(project);
      const pointer = requiredProject(projectId).textRound;
      if (pointer && ['scene', 'consistency', 'resolve'].includes(pointer.phase) && !pointer.progress) {
        saveReviewProgress(projectId, await loadRound(projectId));
      }
      return detail(projectId, { summaryOnly });
    },
    async diagnosticSnapshot({ projectId } = {}) {
      const head = project => ({ id: project.id, status: project.status, stage: project.stage,
        createdAt: project.createdAt, updatedAt: project.updatedAt, workspaceDir: project.workspaceDir,
        runId: project.runConfig?.runId, runMode: project.runConfig?.mode,
        inFlight: [...active.values()].filter(job => job.projectId === project.id).length });
      if (!projectId) return projects().map(head);
      return { ...head(requiredProject(projectId)), ...store.diagnosticStats(projectId) };
    },
    async listText({ projectId, offset = 0, limit = 100, search = '', filter = '', reviewRoundId }) {
      const project = availableProject(projectId);
      offset = Math.max(0, Math.floor(offset)); limit = Math.max(1, Math.min(1000, Math.floor(limit)));
      if (filter === 'reviewed') {
        const pointer = project.textRound;
        if (reviewRoundId && reviewRoundId !== pointer?.id) return { total: 0, units: [], sceneReview: { state: 'changed', committed: false } };
        if (!pointer || !['scene', 'consistency', 'resolve', 'commit', 'committed'].includes(pointer.phase)) {
          return { total: 0, units: [], sceneReview: { state: 'none', committed: false } };
        }
        let round = await loadRound(projectId);
        if (requiredProject(projectId).textRound?.path !== pointer.path || requiredProject(projectId).textRound?.id !== round.id) return { total: 0, units: [], sceneReview: { state: 'changed', committed: false } };
        if (!round.format) return { total: 0, units: [], sceneReview: { state: 'none', committed: false } };
        const committed = Boolean(pointer.committedAt ?? round.committedAt);
        if (!committed) round = refreshReviewRound(round, textSnapshot(projectId).units, undefined, project.nameGlossary).round;
        const tasks = store.tasks(projectId, { reviewRoundId: round.id, sceneResultsOnly: true });
        const query = search.toLowerCase();
        const units = savedSceneReviewUnits(round, tasks).filter(unit => !query
          || [unit.source, unit.translation, unit.notes, unit.id].some(value => String(value ?? '').toLowerCase().includes(query)));
        return { total: units.length, units: units.slice(offset, offset + limit), sceneReview: { roundId: round.id, state: 'saved', committed } };
      }
      return store.page(projectId, { offset, limit, search, filter });
    },
    async createProject(input) { return prepareProject(input); },
    async reconnectProject({ workspaceDir }) {
      if (closing || closed) throw new Error('工作台正在关闭');
      const project = await store.reconnectProject({ workspaceDir });
      const id = project.id;
      if (preparing.has(id) || building.has(id) || cleaning.has(id) || [...active.values(), ...operations.values()].some(job => job.projectId === id)) throw new Error('该工程正在处理中，请暂停后重新打开');
      projectSnapshots.delete(id); textSnapshots.delete(id);
      pauseInterruptedWork(id);
      emit();
      return detail(id);
    },
    async beginProject(input) {
      return new Promise((resolve, reject) => { void prepareProject(input, undefined, resolve).catch(reject); });
    },
    async saveSettings(input) {
      if (!input || !Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 32) throw new Error('并发数范围为 1 到 32');
      const next = { id: 'global', ...defaultSettings(), concurrency: input.concurrency };
      const persistConnection = async (incoming, previous) => {
        const result = { baseUrl: String(incoming?.baseUrl ?? '').trim(), model: String(incoming?.model ?? '').trim(), ...reasoningPreference(incoming), ...connectionCapacity(incoming) };
        const url = new URL(result.baseUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('API 地址格式无效');
        applyModelReasoning({}, result);
        if (incoming?.apiKey) {
          if (!secrets?.encrypt) throw new Error('请通过桌面主机保存密钥');
          secretValues.add(incoming.apiKey);
          result.keyCipher = await secrets.encrypt(incoming.apiKey);
        } else if (previous?.keyCipher) result.keyCipher = previous.keyCipher;
        return result;
      };
      next.connection = await persistConnection(input.connection, settings.connection);
      next.roles = {};
      for (const role of roles) next.roles[role] = { useShared: input.roles?.[role]?.useShared !== false, connection: await persistConnection(input.roles?.[role]?.connection ?? defaultConnection(), settings.roles[role].connection) };
      next.pauseOnLocalFailure = Boolean(input.pauseOnLocalFailure);
      next.processImages = Boolean(input.processImages);
      next.proofreading = input.proofreading !== false;
      next.targetLanguage = input.targetLanguage?.trim() || 'zh-Hans';
      next.fontPath = typeof input.fontPath === 'string' ? input.fontPath : '';
      settings = next; configureRequestSlots(settings.concurrency); store.put('settings', settings); emit(); wake(); return publicSettings(settings);
    },
    async testConnection({ role = 'translation' } = {}) {
      if (active.size >= settings.concurrency) return { ok: false, message: '任务池正在处理模型请求，请稍后测试连接。' };
      const jobId = `connection:${randomUUID()}`;
      const controller = new AbortController();
      active.set(jobId, { controller });
      try {
        const taskRole = role === 'shared' ? 'translation' : role;
        const connection = await connectionFor(taskRole, role === 'shared' ? settings.connection : undefined);
        const result = await provider({ role: taskRole, connection, system: 'Reply only with JSON: {"records":[]}', prompt: '连接测试。请返回 {"records":[]}。', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
        if (!Array.isArray(result?.records)) throw new Error('接口已响应，返回内容需要符合 records JSON 文字协议，请检查模型配置后重试');
        return { ok: true, message: '接口连接与 JSON 返回测试通过' };
      } catch (error) {
        const statusCode = Number(error?.statusCode);
        const retryAfterMs = Number(error?.retryAfterMs);
        const categories = ['cancelled', 'provider_capacity', 'rate_limit', 'authentication', 'output_truncated', 'response_structure', 'model_refusal', 'reasoning_only', 'empty_response', 'timeout', 'transport'];
        const category = error?.name === 'TimeoutError' ? 'timeout' : error?.category;
        return {
          ok: false, message: errorMessage(error),
          ...(Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? { statusCode } : {}),
          ...(categories.includes(category) ? { category } : {}),
          ...(error?.retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? { retryAfterMs } : {}),
        };
      }
      finally { active.delete(jobId); wake(); }
    },
    async continueAvailableText({ projectId, mode }) {
      const project = availableProject(projectId);
      if (project.status === 'running' || preparing.has(projectId)) throw new Error('请先暂停当前制作，再切换处理阶段');
      while ([...active.values()].some(job => job.projectId === projectId) || building.has(projectId)) await new Promise(resolve => setTimeout(resolve, 10));
      await deferRemainingAdaptation(projectId);
      return api.startProject({ projectId, mode });
    },
    async retryAdaptation({ projectId }) {
      let project = availableProject(projectId);
      if (project.status === 'running' || preparing.has(projectId)) throw new Error('请先暂停当前制作，再补充剩余资源');
      project = await refreshVerificationCapabilities(project);
      assertAdaptationAllowance(project);
      if (!project.adaptationRequest) {
        if (project.engine !== 'Unity' || !(project.prepared || project.nativePrepared) || !project.nativeStage?.path || !project.workbenchDir) throw new Error('当前资源适配已完成');
        const workbenchDir = project.workbenchDir;
        const projected = await workerCall('native_review', { projectId, workspaceDir: workbenchDir, acceptedOnly: true, coverageOnly: true });
        if (!Array.isArray(projected?.reviewItems)) throw new Error('原生显示覆盖检查需要返回完整待处理清单');
        const inventory = { ...project.inventory, reviewItems: compactReviewItems(projected.reviewItems) };
        const coverage = await scanResources({ projectId, rootDir: project.imageReadRoot ?? path.resolve(project.gameDir, project.resourceRoot ?? '.'),
          sourceRoots: [...(project.imageReadRoot ? [path.resolve(project.gameDir, project.resourceRoot ?? '.')] : []), ...(project.technicalSourceRoots ?? [])],
          inventory: { ...inventory, coverage: inventory.nativeCoverage }, units: textSnapshot(projectId).units,
          decisions: project.coverageDecisions ?? [], scanCache: false });
        project = requiredProject(projectId);
        if (project.workbenchDir !== workbenchDir || project.status === 'running' || preparing.has(projectId)) throw new Error('项目已开始其他制作，请暂停后重新检查遗漏文字');
        const needsAdaptation = coverage.needsAdaptation || (coverage.summary?.adapterCandidates ?? 0) > 0;
        store.transaction(projectId, () => {
          updateProject(projectId, { inventory, coverage, ...(needsAdaptation ? {
            adaptationRequest: { id: randomUUID(), nativeRevision, failure: { code: 'EXTRACTION_COVERAGE', message: '资源覆盖记录发现显示文字缺口', triggers: coverage.triggers } },
            adaptationProgress: { status: 'needs-review', retryable: true, blocked: false, reason: '发现尚未提取的文字，准备继续处理' }, adaptationDeferred: false,
          } : {}) });
          updateReviewIssue(projectId, groupReviewDiagnostics(projected.reviewItems));
        });
        if (!needsAdaptation) return detail(projectId);
        project = requiredProject(projectId);
      }
      if (project.adaptationProgress?.blocked && project.adaptationRequest.retryContext === adaptationRetryContext(project)) throw Object.assign(new Error(project.adaptationProgress.reason ?? '已保存具体阻碍，请先补充所需条件'), {
        code: project.adaptationProgress.stopReasonCode ?? 'ADAPTATION_PENDING', blockedNeeds: project.adaptationProgress.blockedNeeds,
        candidateId: project.adaptationProgress.candidateId, validationId: project.adaptationProgress.validationId });
      updateProject(projectId, { adaptationDeferred: false });
      return api.startProject({ projectId, retryAdaptation: true });
    },
    async startProject({ projectId, mode, retryAdaptation = false }) {
      if (cleaning.has(projectId)) throw new Error('项目正在清理，请稍后开始');
      let project = availableProject(projectId);
      if (preparing.has(projectId)) return detail(projectId);
      if (project.nativeDependencyFailure || catalogAvailable && (project.prepared === false || retryAdaptation)) {
        applyNativeCatalog(await workerCall('catalog', {}));
      }
      if (project.nativeDependencyFailure) {
        if (project.nativeDependencyFailure.environmentFingerprint === nativeRevision) throw nativeWorkerError(project.nativeDependencyFailure);
        updateProject(projectId, { nativeRetryRevision: nativeRevision });
        return prepareProject({ gameDir: project.gameDir, name: project.name, outputDir: project.outputDir }, projectId);
      }
      const nativeRetryConsumed = project.nativeRetryRevision === nativeRevision || project.nativeStage?.revision === nativeRevision
        || (project.nativeRetried === true && project.nativeAttemptRevision === nativeRevision);
      if (project.prepared === false && !project.nativePrepared && project.nativeStage?.revision === nativeRevision && project.nativeRetryRevision !== nativeRevision) {
        const relative = path.relative(project.workspaceDir, project.nativeStage.path);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('原生暂存结果需要位于当前项目内');
        const staged = JSON.parse(await readFile(project.nativeStage.path, 'utf8'));
        updateProject(projectId, { nativeRetryRevision: nativeRevision });
        const retried = await prepareProject({ gameDir: project.gameDir, name: project.name, outputDir: project.outputDir }, projectId, undefined, staged);
        project = requiredProject(projectId);
        if (project.prepared) return retried;
      }
      if (project.prepared === false && project.adaptationRequest && (project.adaptationRequest.nativeRevision !== nativeRevision || (!project.nativePrepared && !nativeRetryConsumed))) {
        updateProject(projectId, { nativeRetryRevision: nativeRevision, adaptationRequest: { ...project.adaptationRequest, nativeRevision } });
        const retried = await prepareProject({ gameDir: project.gameDir, name: project.name, outputDir: project.outputDir }, projectId);
        project = requiredProject(projectId);
        if (project.prepared) return retried;
      }
      if (!project.adaptationRequest && (project.prepared === false || !project.workbenchDir || !store.counts(projectId).total)) return prepareProject({ gameDir: project.gameDir, name: project.name, outputDir: project.outputDir }, projectId);
      project = await refreshVerificationCapabilities(project);
      if (!project.adaptationDeferred && project.adaptationProgress?.blocked && project.adaptationRequest?.retryContext === adaptationRetryContext(project)) throw Object.assign(new Error(project.adaptationProgress.reason ?? '已保存具体阻碍，请先补充所需条件'), {
        code: project.adaptationProgress.stopReasonCode ?? 'ADAPTATION_PENDING', blockedNeeds: project.adaptationProgress.blockedNeeds,
        candidateId: project.adaptationProgress.candidateId, validationId: project.adaptationProgress.validationId });
      const continuing = project.status === 'paused' || Boolean(project.textRound && project.textRound.phase !== 'committed');
      mode ??= continuing ? project.runConfig?.mode ?? 'all' : 'all';
      if (!['all', 'translation', 'proofreading', 'review-issues', 'repair'].includes(mode)) throw new Error('制作阶段无效');
      if (project.status === 'running') {
        if (mode !== (project.runConfig?.mode ?? 'all')) throw new Error('请先暂停当前阶段');
        return detail(projectId);
      }
      while ([...active.values()].some((job) => job.projectId === projectId) || building.has(projectId)) await new Promise((resolve) => setTimeout(resolve, 10));
      textRecovery.delete(projectId);
      if (cleaning.has(projectId)) throw new Error('项目正在清理，请稍后开始');
      requiredProject(projectId);
      const reviewOnly = ['proofreading', 'review-issues'].includes(mode);
      const proofreading = reviewOnly || (mode !== 'translation' && settings.proofreading);
      if (!reviewOnly) await connectionFor('translation');
      if (proofreading || mode === 'repair') await connectionFor('proofreading');
      if (project.adaptationRequest && !project.adaptationDeferred) await connectionFor('technical');
      refusals.set(projectId, 0);
      const languageChanged = (project.runConfig?.targetLanguage ?? project.targetLanguage) !== settings.targetLanguage;
      if (languageChanged && ['proofreading', 'review-issues', 'repair'].includes(mode)) throw new Error('目标语言已改变，请先翻译当前项目');
      const resuming = continuing && mode === (project.runConfig?.mode ?? 'all') && !languageChanged;
      const glossary = resuming && project.nameGlossary ? project.nameGlossary : scanTerminology(store.units(projectId), project.nameGlossary, settings.targetLanguage);
      const allText = store.units(projectId);
      const questionIds = new Set(store.all('issues', projectId).filter(issue => !issue.resolvedAt && ['review-evidence', 'text-question'].includes(issue.category)).map(issue => issue.unitId));
      const eligibleReview = unit => ['translated', 'proofread'].includes(unit.status) || (unit.status === 'skipped' && unit.skipRole === 'proofreading');
      const questionTargets = allText.filter(unit => eligibleReview(unit) && (unit.review?.status === 'needs_evidence' || questionIds.has(unit.id)));
      const questionGroups = new Set(questionTargets.map(unit => unit.context?.syncGroup).filter(Boolean));
      const scopeUnitIds = resuming ? project.runConfig?.scopeUnitIds : mode === 'review-issues'
        ? allText.filter(unit => questionTargets.some(target => target.id === unit.id) || questionGroups.has(unit.context?.syncGroup)).map(unit => unit.id)
        : mode === 'proofreading' ? allText.filter(eligibleReview).map(unit => unit.id) : mode === 'repair' ? allText.filter((unit) => unit.status === 'skipped' || glossaryConflicts(unit, unit.translation, glossary).length).map((unit) => unit.id) : undefined;
      const inScope = createRunScope(scopeUnitIds);
      if (reviewOnly && !scopeUnitIds?.length) throw new Error(mode === 'review-issues' ? '当前项目没有待定向重审的文字疑点' : '当前项目尚无可校对的译文');
      const skippedExhausted = [], parked = [];
      store.transaction(projectId, () => {
        const failedTasks = store.tasks(projectId, { statuses: ['skipped', 'paused'] });
        for (const unit of store.units(projectId)) if (inScope(unit) && (languageChanged || unit.status === 'skipped' || (reviewOnly && !resuming))) {
          const failed = failedTasks.findLast((task) => task.input?.some((input) => input.id === unit.id && input.revision === unit.revision));
          const role = unit.skipRole ?? failed?.role;
          const status = !languageChanged && (reviewOnly || role === 'proofreading') ? 'translated' : 'pending';
          // A unit whose own text keeps failing the same local check is not bought again; an edited
          // revision, a new role or a new target language starts a fresh count through skipRecord.
          const exhausted = status === 'pending' && !languageChanged && unit.status === 'skipped'
            && (unit.skipCount ?? 0) >= skipRetryLimit && unit.skipKey === skipKeyFor(projectId, unit, role);
          if (exhausted) { if (!unit.skipExhausted) store.putUnit(projectId, { ...unit, skipExhausted: true }); skippedExhausted.push({ id: unit.id }); continue; }
          store.putUnit(projectId, { ...unit, status, skipRole: undefined, skipExhausted: undefined });
        }
        // A pending unit that already spent its failure cycles is parked for the same reason: a
        // continuation may not bill identical work again. Editing it or the glossary clears the tally.
        for (const unit of store.units(projectId)) {
          if (unit.status !== 'pending' || !inScope(unit) || languageChanged || reviewOnly) continue;
          if ((unit.skipCount ?? 0) < skipRetryLimit || unit.skipKey !== skipKeyFor(projectId, unit, unit.skipRole)) continue;
          store.putUnit(projectId, { ...unit, status: 'skipped', skipExhausted: true });
          parked.push({ id: unit.id });
        }
        // `attempts` is a cumulative record of spent model retries and is never zeroed; only the
        // per-continuation window is renewed, so the history stays visible while paid work is bounded.
        for (const task of store.tasks(projectId, { statuses: ['skipped', 'failed', 'paused', 'queued', 'stale'] })) {
          store.putTask(projectId, { ...task, status: ['glossary', 'glossary-repair'].includes(task.kind) ? 'cancelled' : 'paused', windowAttempts: 0, transportWindowAttempts: 0 });
        }
        updateProject(projectId, { status: 'running', stage: { all: '翻译与校对', translation: '翻译', proofreading: '校对', 'review-issues': '定向重审疑点', repair: '定向补漏' }[mode], lastError: undefined, targetLanguage: settings.targetLanguage,
          semanticPreparation: languageChanged ? undefined : project.semanticPreparation,
          textRound: resuming ? project.textRound : undefined,
          nameGlossary: glossary, runConfig: { runId: resuming ? project.runConfig?.runId ?? randomUUID() : randomUUID(), mode, ...(scopeUnitIds ? { scopeUnitIds } : {}), targetLanguage: settings.targetLanguage, proofreading, processImages: settings.processImages, connections: Object.fromEntries(roles.map((role) => [role, clone(settings.roles[role === 'proofreading' ? 'translation' : role].useShared ? settings.connection : settings.roles[role === 'proofreading' ? 'translation' : role].connection)])) } });
      });
      for (const unit of [...skippedExhausted, ...parked]) addIssue(projectId, 'local-skip', `该条文字已连续 ${skipRetryLimit} 次未通过本地校验，本次继续保留原状、不再重复请求；请手动修改译文、术语或更换模型后再试`, unit.id);
      await plan(projectId); wake(); return detail(projectId);
    },
    async pauseProject({ projectId }) {
      if (preparing.has(projectId)) return api.cancelProject({ projectId });
      clearAdaptationWake(projectId);
      textRecovery.delete(projectId);
      updateProject(projectId, { status: 'paused', stage: '已暂停' });
      for (const job of active.values()) if (job.projectId === projectId) job.controller.abort();
      for (const task of store.tasks(projectId, { statuses: ['queued'] })) store.putTask(projectId, { ...task, status: 'paused' });
      return detail(projectId);
    },
    async cancelProject({ projectId }) {
      requiredProject(projectId);
      clearAdaptationWake(projectId);
      textRecovery.delete(projectId);
      const preparation = preparing.get(projectId);
      updateProject(projectId, { status: 'paused', stage: preparation ? '正在取消准备' : '正在暂停', lastError: undefined });
      preparation?.controller.abort();
      recollection.cancel(projectId);
      buildControllers.get(projectId)?.abort();
      for (const job of active.values()) if (job.projectId === projectId) job.controller.abort();
      for (const task of store.tasks(projectId, { statuses: ['queued'] })) store.putTask(projectId, { ...task, status: 'paused' });
      await preparation?.done;
      await Promise.allSettled([...operations.values()].filter((operation) => operation.projectId === projectId).map((operation) => operation.promise));
      while ([...active.values()].some((job) => job.projectId === projectId) || building.has(projectId)) await new Promise((resolve) => setTimeout(resolve, 10));
      updateProject(projectId, { status: 'paused', stage: preparation ? '准备已取消' : '已暂停', lastError: undefined });
      return detail(projectId);
    },
    async deleteProject({ projectId, removeWorkspace = false }) {
      const project = requiredProject(projectId);
      if (cleaning.has(projectId)) throw new Error('项目正在清理，请稍后删除');
      cleaning.add(projectId);
      try {
        await api.cancelProject({ projectId });
        const retained = new Set(store.all('builds', projectId).map((build) => build.path));
        if (removeWorkspace && !await ownsProjectWorkspace(project)) throw new Error('项目工作目录定位无效，未删除任何文件');
        const containsOutput = [...retained].some(output => {
          const relative = path.relative(project.workspaceDir, output);
          return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        });
        // Close the project database before filesystem cleanup; removing an index entry alone keeps its data.
        store.removeProject(projectId);
        if (removeWorkspace && !containsOutput) {
          const result = await removeArtifact(project.workspaceDir, path.dirname(project.workspaceDir), { protectSaves: true });
          if (!result.removed) retained.add(project.workspaceDir);
        } else retained.add(project.workspaceDir);
        projectSnapshots.delete(projectId); textSnapshots.delete(projectId);
        storyCache.delete(projectId); roundCache.delete(projectId); roundChecks.delete(projectId);
        refusals.delete(projectId); emit();
        return { deleted: true, retainedPaths: [...retained] };
      } finally { cleaning.delete(projectId); }
    },
    async saveText({ projectId, unitId, translation, notes, expectedRevision, action = 'save' }) {
      const project = availableProject(projectId);
      const unit = store.unit(projectId, unitId);
      if (!unit) throw new Error('请刷新文字工作台后重新选择条目');
      if (!['save', 'confirm'].includes(action)) throw new Error('未知的文字保存动作');
      if (notes !== undefined && typeof notes !== 'string') throw new Error('备注须为文字');
      const validation = { submitted: true, allowUnchanged: true,
        targetLanguage: project.runConfig?.targetLanguage ?? project.targetLanguage ?? settings.targetLanguage };
      validateTranslation(unit, translation, validation);
      const linked = unit.context?.syncGroup ? store.units(projectId).filter((other) => other.context?.syncGroup === unit.context.syncGroup) : [unit];
      for (const other of linked) validateTranslation(other, translation, validation);
      const next = store.transaction(projectId, () => {
        let selected;
        for (const other of linked) {
          const confirmed = action === 'confirm' && other.id === unit.id;
          const textChanged = translation !== other.translation;
          const updated = commitUnit(projectId, other, { translation, notes: other.id === unit.id ? notes ?? unit.notes : other.notes,
            ...(other.id === unit.id && notes !== undefined && notes !== unit.notes ? { notesOrigin: 'human' } : {}),
            status: confirmed ? 'proofread' : textChanged ? 'translated' : other.status,
            review: confirmed ? undefined : textChanged && other.review?.status !== 'needs_evidence' ? undefined : other.review,
            ...(confirmed ? { confirmation: { source: 'human', confirmedAt: now() } } : textChanged ? { confirmation: undefined } : {}) }, other.id === unit.id ? expectedRevision : other.revision, { semanticIntent: confirmed });
          if (other.id === unit.id) selected = updated;
        }
        return selected;
      });
      if (unit.translation !== translation) {
        const project = requiredProject(projectId);
        if (project.nameGlossary) updateProject(projectId, { nameGlossary: scanTerminology(store.units(projectId), project.nameGlossary, project.runConfig?.targetLanguage ?? project.targetLanguage) });
      }
      if (action === 'confirm') resolveIssues(projectId, ['review-evidence', 'text-question'], [unit.id]);
      emit(); wake(); return next;
    },
    async exportPackage({ projectId, filePath, profile = 'json', taskStage }) {
      const project = availableProject(projectId);
      const stage = taskStage ?? (['proofreading', 'review-issues'].includes(project.runConfig?.mode) ? 'proofreading' : 'translation');
      if (!['translation', 'proofreading'].includes(stage)) throw new Error('文字工作包需要明确的初翻或校对阶段');
      const units = store.units(projectId);
      const inScope = createRunScope(project.runConfig?.scopeUnitIds);
      const reviewEligible = unit => ['translated', 'proofread'].includes(unit.status) || unit.status === 'skipped' && unit.skipRole === 'proofreading';
      const targets = units.filter(unit => inScope(unit) && (stage !== 'proofreading' || reviewEligible(unit)));
      if (stage === 'proofreading') {
        if (!targets.length) throw new Error('当前项目尚无可导出校对的译文，请先完成初翻或导入初翻成果');
        const groups = new Set(targets.map(unit => unit.context?.syncGroup).filter(Boolean));
        if (units.some(unit => groups.has(unit.context?.syncGroup) && !reviewEligible(unit))) throw new Error('关联显示组仍有未完成初翻的文字，请先完成整组初翻再导出校对包');
      }
      const directory = path.join(project.workspaceDir, 'exchange', randomUUID());
      const additionalFiles = {};
      for (const file of project.exchangeFiles ?? []) {
        const content = await readFile(file.path);
        if (sha256(content) !== file.sha256) throw new Error(`保留的扩展材料已改变：${file.name}`);
        additionalFiles[file.name] = content;
      }
      const glossary = scanTerminology(units, project.nameGlossary, project.targetLanguage ?? settings.targetLanguage);
      try {
        await writePackage(directory, { project, units, profile, targetUnitIds: targets.map(unit => unit.id), stage,
          glossary: glossary.entries.map(({ id, source, translation, category, aliases, status, unitIds, notes }) => ({ id, source, translation, category, aliases, status, unitIds, notes })), issues: store.all('issues', projectId), extensions: project.exchangeExtensions ?? {}, additionalFiles });
        await workerCall('zip', { projectId, sourceDir: directory, filePath });
      } finally { await discardArtifact(projectId, directory, path.join(project.workspaceDir, 'exchange')); }
      return { path: filePath };
    },
    async importPackage({ projectId, filePath }) {
      const project = availableProject(projectId);
      const directory = path.join(project.workspaceDir, 'exchange', `import-${randomUUID()}`);
      let retainedMaterials = false;
      try {
      await workerCall('unzip', { projectId, filePath, outputDir: directory });
      const { manifest, prepared, root, supplementalFiles, taskStage } = await readPackage(directory, { project, units: store.units(projectId) });
      for (const row of prepared) {
        const known = store.revision(projectId, row.unit.id, row.baseline.revision);
        if (!known || known.translation !== row.baseline.translation || known.notes !== row.baseline.notes || known.sourceHash !== row.unit.sourceHash) throw new Error(`导出基础版本校验失败，请重新导出工作包：${row.unit.id}`);
      }
      const patches = [], conflicts = [];
      const intentKey = row => sha256([manifest.packageId, row.unit.id, row.baseline.revision, taskStage, row.intent, row.returned, row.notes]);
      const appliedIntents = new Set(store.all('imports', projectId).flatMap(record => record.intentReceipts ?? []).map(receipt => receipt.hash));
      const replayed = new Set();
      let unchanged = 0;
      for (const row of prepared) {
        if (appliedIntents.has(intentKey(row))) { replayed.add(row.unit.id); unchanged++; continue; }
        const translation = threeWay(row.baseline.translation, row.unit.translation, row.returned);
        const notes = threeWay(row.baseline.notes, row.unit.notes, row.notes);
        if (translation.conflict || notes.conflict) conflicts.push({ id: row.unit.id, baseline: row.baseline.translation, current: row.unit.translation, returned: row.returned, ...(notes.conflict ? { field: 'notes', baselineNotes: row.baseline.notes, currentNotes: row.unit.notes, returnedNotes: row.notes } : {}) });
        else {
          const state = {};
          if (row.intent === 'pending') {
            const reviewId = `external-question-${manifest.packageId}-${row.unit.id}`;
            state.review = { reviewId, reviewedAt: row.unit.review?.reviewId === reviewId ? row.unit.review.reviewedAt : now(),
              status: 'needs_evidence', issues: [{ unitId: row.unit.id, kind: 'needs_evidence',
                message: notes.value || '回包将此文字标记为待确认，已保留当前文字。', resolved: false }] };
          } else if (row.intent !== 'keep' && taskStage === 'proofreading'
              && translation.value === row.returned && notes.value === row.notes) {
            state.status = 'proofread'; state.review = undefined;
            state.confirmation = { source: 'external', packageId: manifest.packageId, stage: taskStage };
          } else if (translation.changed) {
            state.status = 'translated'; state.confirmation = undefined;
            state.review = row.unit.review?.status === 'needs_evidence' ? row.unit.review : undefined;
          }
          const stateChanged = Object.entries(state).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(row.unit[key]));
          if (translation.changed || notes.changed || stateChanged) patches.push({ row, translation: translation.value, notes: notes.value, state, stateChanged });
          else unchanged++;
        }
      }
      // A task package is one atomic handoff. A conflicting candidate never partially replaces a scene.
      if (conflicts.length) {
        for (const conflict of conflicts) addIssue(projectId, 'merge-conflict', `回包与工程当前文字同时改动：${conflict.id}`, conflict.id);
        return { accepted: 0, unchanged, conflicts };
      }
      const mergedTranslations = new Map(patches.map(patch => [patch.row.unit.id, patch.translation]));
      const synchronized = new Map();
      for (const unit of store.units(projectId)) if (unit.context?.syncGroup) {
        const group = unit.context.syncGroup;
        const translation = mergedTranslations.get(unit.id) ?? unit.translation;
        if (synchronized.has(group) && synchronized.get(group) !== translation) throw new Error(`关联显示字段须使用相同译文：${group}`);
        synchronized.set(group, translation);
      }
      store.transaction(projectId, () => {
        for (const patch of patches) commitUnit(projectId, patch.row.unit,
          { translation: patch.translation, notes: patch.notes,
            ...(patch.notes !== patch.row.unit.notes ? { notesOrigin: 'external' } : {}), ...patch.state }, patch.row.unit.revision, { semanticIntent: patch.stateChanged });
        for (const row of prepared) if (row.intent === 'pending' && !replayed.has(row.unit.id)) addIssue(projectId, 'text-question', row.notes || '回包将此文字标记为待确认，已保留当前文字。', row.unit.id);
        if (replayed.size !== prepared.length) store.put('imports', { id: randomUUID(), packageId: manifest.packageId, accepted: patches.length, importedAt: now(),
          intentReceipts: prepared.filter(row => !replayed.has(row.unit.id)).map(row => ({ unitId: row.unit.id, hash: intentKey(row) })) }, projectId);
        const current = requiredProject(projectId);
        const textChanged = current.nameGlossary && patches.some((patch) => patch.row.unit.translation !== patch.translation);
        store.put('projects', { ...current, ...(textChanged ? { nameGlossary: scanTerminology(store.units(projectId), current.nameGlossary, current.runConfig?.targetLanguage ?? current.targetLanguage) } : {}), exchangeExtensions: manifest.extensions ?? {}, exchangeFiles: supplementalFiles.map((name) => ({ name, path: path.join(root, name), sha256: manifest.files[name].sha256 })), updatedAt: now() });
      });
      retainedMaterials = supplementalFiles.length > 0;
      resolveIssues(projectId, ['merge-conflict']);
      resolveIssues(projectId, ['review-evidence', 'text-question'], patches.filter((patch) => patch.row.intent !== 'pending' && patch.state.confirmation?.stage === 'proofreading').map((patch) => patch.row.unit.id));
      emit(); wake(); return { accepted: patches.length, unchanged, conflicts: [] };
      } finally { if (!retainedMaterials) await discardArtifact(projectId, directory, path.join(project.workspaceDir, 'exchange')); }
    },
    async buildProject({ projectId, outputDir, outputParent, signal }) {
      if (cleaning.has(projectId)) throw new Error('项目正在清理，请稍后生成成品');
      availableProject(projectId);
      const currentProduction = requiredProject(projectId);
      if (currentProduction.status === 'running' && currentProduction.adaptationRequest && !currentProduction.adaptationDeferred) {
        throw Object.assign(new Error('技术资源仍在接入。已就绪文字可继续翻译；暂停技术制作后可生成当前部分成品。'), { code: 'ADAPTATION_BUILD_BUSY' });
      }
      if (building.has(projectId)) {
        const pending = await building.get(projectId);
        if ((await verifyOutput(pending.path, pending.outputManifest)).valid) return pending;
        return api.buildProject({ projectId, outputDir, outputParent, signal });
      }
      const controller = new AbortController();
      buildControllers.set(projectId, controller);
      signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const run = (async () => {
        const project = requiredProject(projectId);
        if (!project.workbenchDir || project.prepared === false) throw new Error('请继续准备项目，完成文本提取与原样回写检查后生成成品');
        if (project.roundtripError) throw new Error(`原样回写检查待通过：${project.roundtripError}`);
        const units = store.units(projectId);
        const generation = project.publication?.generation ?? 0;
        const unitsDigest = sha256(units.map(unit => [unit.id, unit.revision, unit.sourceHash, unit.translation]));
        const publishBuild = async (proofs, action) => {
          const adapter = await getLab();
          try {
            if (!adapter.withBuildPublication) return action(proofs);
            return (await adapter.withBuildPublication({ builds: proofs, projectId, signal,
              commit: sealed => store.transaction(projectId, () => { signal.throwIfAborted(); return action(sealed); }) })).result;
          } catch (error) {
            if (/^(?:FORMAT_.*(?:REQUIRED|REVOKED|STALE)|DISPLAY_(?:FACT|SOURCE)_STALE|ADAPTER_ACCEPTED_STALE)$/.test(error.code ?? '')) {
              error.hostFailure = true;
              updateProject(projectId, { status: 'paused', stage: '已验证材料需要重新核对', lastError: errorMessage(error) });
              addIssue(projectId, 'build-validation', errorMessage(error), undefined, 'warning', { code: error.code });
            }
            throw error;
          }
        };
        const currentInputs = () => {
          const current = requiredProject(projectId);
          return (current.publication?.generation ?? 0) === generation && current.workbenchDir === project.workbenchDir
            && sha256(store.units(projectId).map(unit => [unit.id, unit.revision, unit.sourceHash, unit.translation])) === unitsDigest;
        };
        units.forEach((u) => validateTranslation(u, u.translation));
        const glossary = project.nameGlossary ?? scanTerminology(units, undefined, project.targetLanguage ?? settings.targetLanguage);
        const termConflicts = units.filter((unit) => glossaryConflicts(unit, unit.translation, glossary).length);
        const unconfirmed = glossary.entries.filter((entry) => entry.needsReview).length;
        const skipped = units.filter((unit) => unit.status === 'skipped').length;
        const reviewPending = units.filter(unit => unit.review?.status === 'needs_evidence'
          || unit.status === 'skipped' && unit.skipRole === 'proofreading').length;
        const coveragePending = project.coverage?.needsAdaptation || project.coverage?.stale;
        const coverageCheck = { name: '资源文字覆盖', status: coveragePending ? 'pending' : 'passed',
          detail: coveragePending ? `${describeRemainingCoverage(project.coverage)}。尚未处理的内容保留原文，可继续补漏` : '已记录资源覆盖与文字定位' };
        const textStage = termConflicts.length || unconfirmed ? `成品已生成 · ${termConflicts.length} 条文字、${unconfirmed} 项术语待核对` : skipped ? `成品已生成 · ${skipped} 条待重试，保留已有文字` : '成品已生成';
        const completedStage = coveragePending ? `${textStage} · 剩余资源保留原文` : textStage;
        const fontHash = settings.fontPath ? sha256(await readFile(settings.fontPath)) : null;
        const adapterBindings = [];
        for (const name of ['pinhao-composite-adapter.json', 'pinhao-adapter-binding.json']) {
          try { adapterBindings.push([name, sha256(await readFile(path.join(project.workbenchDir, name)))]); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const inputHash = sha256({ recipe: 6, nativeRevision, adapterBindings, generation,
          compositeManifestRef: project.publication?.compositeManifestRef, workbenchDir: project.workbenchDir,
          source: project.sourceFingerprint, units: units.map((u) => [u.legacyId, u.translation]), fontHash, assistEnabled: project.assistEnabled !== false, processImages: project.runConfig?.processImages ?? settings.processImages });
        const latest = store.all('builds', projectId).at(-1);
        const requestedParent = outputParent ? await realpath(outputParent) : undefined;
        const runnable = latest?.launchPath && await stat(latest.launchPath).then((info) => info.isFile(), () => false);
        const sameLocation = !requestedParent || latest && path.dirname(path.resolve(latest.path)) === requestedParent;
        const outputProof = !outputDir && sameLocation && latest?.inputHash === inputHash && runnable ? await verifyOutput(latest.path, latest.outputManifest) : undefined;
        if (outputProof && !outputProof.valid) {
          store.put('builds', { ...latest, outputModified: true, runtimeVerified: false,
            checks: [...latest.checks.filter(check => check.name !== '成品内容核验'), { name: '成品内容核验', status: 'pending', detail: outputProof.reason }] }, projectId);
          addIssue(projectId, 'output-modified', outputProof.reason);
        }
        if (outputProof?.valid) {
          const reused = { ...latest, checks: [coverageCheck, ...latest.checks.filter(check => check.name !== coverageCheck.name).map((check) => check.name === '专名与术语一致性' ? { ...check, status: termConflicts.length || unconfirmed ? 'pending' : 'passed', detail: `统一 ${glossary.entries.length - unconfirmed} 项；${termConflicts.length} 条文字、${unconfirmed} 项术语待核对` }
            : check.name === '校对证据' ? { ...check, status: reviewPending ? 'pending' : 'passed', detail: reviewPending ? `${reviewPending} 条文字校对未完成，保留已有文字；可在文字工作台重试或查看待补证据` : '当前审阅问题已分别记录' } : check)] };
          return publishBuild(latest.validationProofs ?? [], proofs => {
            reused.validationProofs = proofs;
            store.put('builds', reused, projectId);
            if (currentInputs()) updateProject(projectId, { status: 'completed', stage: completedStage, lastError: undefined });
            return { ...reused, completion: completionFor(projectId, { units, glossary, builds: [reused] }) };
          });
        }
        const id = randomUUID();
        const buildDir = path.join(project.workspaceDir, 'builds', id, 'data');
        const output = outputDir ? path.resolve(outputDir) : await createProductDirectory(project, requestedParent);
        const outputOwner = outputDir ? undefined : path.dirname(output);
        const relative = path.relative(project.gameDir, output);
        if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('成品目录需要位于原版目录之外');
        updateProject(projectId, { stage: '校验与构建' });
        let completed = false, outputCollision = false, phase = 'build', buildResult;
        try {
        const translations = units.filter((u) => !u.legacyId.startsWith('script:') && !u.legacyId.startsWith('image:')).map((u) => ({ id: u.legacyId, legacyId: u.legacyId, translation: u.translation, notes: u.notes }));
        const data = await workerCall('build', { projectId, workspaceDir: project.workbenchDir, outputDir: buildDir, translations, fontPath: settings.fontPath || undefined }, signal);
        buildResult = data;
        const packImages = ['KiriKiri/KAG', 'Godot', 'SMILE GAME BUILDER', 'RPG Developer Bakin', 'Pixel Game Maker MV'].includes(project.engine);
        let imageOverlay = {};
        if (packImages && project.imageBinding && (project.runConfig?.processImages ?? settings.processImages)) {
          try {
            const imageAdapter = await loadImages();
            if (imageAdapter) {
              const directory = path.join(buildDir, 'pinhao-image-overlay');
              const redraw = await imageAdapter.stageImageText({ sourceDir: project.imageReadRoot ?? path.resolve(project.gameDir, project.resourceRoot ?? '.'), outputDir: directory, binding: project.imageBinding, translations: units.filter(unit => unit.legacyId.startsWith('image:')).map(unit => ({ id: unit.legacyId, translation: unit.translation })), fontPath: settings.fontPath,
                materialize: project.workbenchDir ? files => nativeTools.materializeSource({ gameDir: project.gameDir, workspaceDir: project.workbenchDir, files, signal }) : undefined });
              imageOverlay = { assetOverlayDir: directory, assetOverlayFiles: redraw.files };
              for (const issue of redraw.issues ?? []) addIssue(projectId, 'image-redraw', `${issue.file ? `${issue.file}：` : ''}${issue.message}`, units.find(unit => unit.legacyId === issue.unitId)?.id);
            }
          } catch (error) { addIssue(projectId, 'image-redraw', `图片重绘保留原图：${errorMessage(error)}`); }
        }
        phase = 'assemble';
        const assembly = await workerCall('assemble', { projectId, gameDir: project.gameDir, workspaceDir: project.workbenchDir, buildDir: data.buildDir ?? buildDir, adapterBuilds: data.adapterBuilds, deferSupplementalText: true, outputDir: output, fontPath: settings.fontPath || undefined, assistEnabled: project.assistEnabled !== false, ...imageOverlay }, signal);
        if (signal?.aborted) throw new Error('构建已暂停');
        const resultPath = assembly.outputDir ?? output;
        phase = 'supplemental-text';
        const scriptAdapter = await loadScripts();
        if (scriptAdapter && project.scriptBinding) await scriptAdapter.applyDisplayText({ outputDir: resultPath, binding: project.scriptBinding, translations: units.filter((u) => u.legacyId.startsWith('script:')).map((u) => ({ id: u.legacyId, translation: u.translation })) });
        await applySupplementalText({ adapterBuilds: data.adapterBuilds, gameDir: project.gameDir, buildDir: data.buildDir ?? buildDir, outputDir: resultPath, signal });
        if (!packImages && project.imageBinding && (project.runConfig?.processImages ?? settings.processImages)) {
          try {
            const imageAdapter = await loadImages();
            if (imageAdapter) {
              const redraw = await imageAdapter.applyImageText({ outputDir: path.resolve(resultPath, project.resourceRoot ?? '.'), binding: project.imageBinding, translations: units.filter((u) => u.legacyId.startsWith('image:')).map((u) => ({ id: u.legacyId, translation: u.translation })), fontPath: settings.fontPath });
              for (const issue of redraw.issues ?? []) addIssue(projectId, 'image-redraw', `${issue.file ? `${issue.file}：` : ''}${issue.message}`, units.find((unit) => unit.legacyId === issue.unitId)?.id);
            }
          } catch (error) { addIssue(projectId, 'image-redraw', `图片重绘保留原图：${errorMessage(error)}`); }
        }
        const launchPath = assembly.launchPath ?? assembly.report?.launchPath;
        const checks = [
          { name: '结构与保护标记', status: 'passed' },
          coverageCheck,
          { name: assembly.sourceOnly ? '源码工程副本' : '独立副本组装', status: 'passed', detail: '原版资源与当前文字已写入新副本' },
          { name: '专名与术语一致性', status: termConflicts.length || unconfirmed ? 'pending' : 'passed', detail: `统一 ${glossary.entries.length - unconfirmed} 项；${termConflicts.length} 条文字、${unconfirmed} 项术语待核对` },
          { name: '校对证据', status: reviewPending ? 'pending' : 'passed', detail: reviewPending ? `${reviewPending} 条文字校对未完成，保留已有文字；可在文字工作台重试或查看待补证据` : '当前审阅问题已分别记录' },
          { name: '实机游玩验收', status: 'pending', detail: '请启动成品检查对话、分支、存档与布局' },
        ];
        if (assembly.report?.checks) checks.push(...assembly.report.checks);
        if (assembly.checks) checks.push(...assembly.checks);
        for (const check of assembly.pendingChecks ?? []) checks.push({ name: check.kind, status: 'pending', detail: check.message });
        for (const warning of assembly.warnings ?? []) checks.push({ name: '引擎适配提醒', status: 'warning', detail: warning });
        if (settings.fontPath) {
          try {
            const coverage = await workerCall('fontCoverage', { projectId, fontPath: settings.fontPath, texts: units.map(unit => unit.translation) }, signal);
            checks.push({ name: '所选字体字形覆盖', status: coverage.status === 'passed' ? 'passed' : 'pending',
              detail: coverage.missing?.length ? `${coverage.missing.length} 个字符待核对，请试运行查看字体回退显示` : '已检查当前译文字形；实际界面随试运行核对' });
          } catch (error) { if (signal?.aborted) throw error; checks.push({ name: '所选字体字形覆盖', status: 'pending', detail: '请试运行核对当前字体显示' }); }
        }
        phase = 'output-proof';
        const finalManifest = await outputManifest(resultPath);
        checks.push({ name: '成品内容核验', status: 'passed', detail: `已核对 ${finalManifest.files.length} 个成品文件` });
        let runtime;
        if (runtimeVerifier) {
          phase = 'runtime';
          runtime = await runtimeVerifier({ phase: 'product', gameDir: resultPath, outputDir: resultPath, launchPath,
            outputHash: finalManifest.hash, project: { id: projectId, engine: project.engine }, signal });
          if (runtime && ['passed', 'failed', 'pending'].includes(runtime.status)) checks.push({ name: '运行观察', status: runtime.status, detail: runtime.detail ?? '运行观察已记录' });
          if (runtime?.blocking && runtime.status === 'failed') throw new Error(runtime.detail ?? '成品运行检查待修复');
        }
        const assistModes = assembly.assist?.supported ? ['live'] : assembly.assist?.modes?.filter(mode => mode === 'save') ?? [];
        const build = { id, path: resultPath, launchPath, ...(assembly.launchArgs ? { launchArgs: assembly.launchArgs } : {}),
          snapshotId: sha256([generation, project.workbenchDir, project.publication?.compositeManifestRef, unitsDigest, fontHash]),
          integrationGeneration: generation, unitsDigest, snapshotComplete: true,
          ...(assembly.assist ? { assistance: assistanceProjection(project, { supported: assistModes.length > 0, modes: assistModes, detail: assembly.assist.detail, ...(assembly.assist.status ? { status: assembly.assist.status } : {}) }) } : {}),
          createdAt: now(), changed: units.filter((u) => u.translation !== u.source).length, checks, inputHash,
          ...(outputOwner && path.resolve(resultPath) === output ? { managedOwner: outputOwner } : {}),
          outputManifest: finalManifest, runtimeVerified: runtime?.kind === 'gameplay' && runtime.status === 'passed', ...(runtime ? { runtime } : {}) };
        const buildProofs = [
          ...(data.buildReceiptId ? [{ workspaceDir: project.workbenchDir, buildDir: data.buildDir ?? buildDir, buildReceiptId: data.buildReceiptId,
            gameDir: project.gameDir, outputDir: path.resolve(resultPath, project.resourceRoot ?? '.'), finalGameDir: resultPath }] : []),
          ...(data.adapterBuilds ?? []).filter(item => item.buildReceiptId).map(item => ({ workspaceDir: item.workspaceDir, buildDir: item.buildDir,
            buildReceiptId: item.buildReceiptId, unitIds: item.unitIds, sourceRoot: item.sourceRoot, resourceRoot: item.resourceRoot,
            gameDir: project.gameDir, nativeWorkspaceDir: project.workbenchDir,
            outputDir: path.resolve(resultPath, item.resourceRoot ?? '.'), finalGameDir: resultPath })),
        ];
        await publishBuild(buildProofs, proofs => {
          build.validationProofs = proofs;
          store.put('builds', build, projectId);
          if (currentInputs()) updateProject(projectId, { status: 'completed', stage: completedStage, lastError: undefined });
        });
        await pruneOldBuilds(projectId);
        for (const directory of project.buildRepair?.artifactDirs ?? (project.buildRepair?.artifactDir ? [project.buildRepair.artifactDir] : [])) await discardArtifact(projectId, directory, path.join(project.workspaceDir, 'technical', 'build-repairs', 'artifacts'));
        resolveIssues(projectId, ['build']);
        completed = true;
        return { ...build, completion: completionFor(projectId, { units, glossary, builds: [build] }) };
        } catch (error) {
          if (['OUTPUT_EXISTS', 'EEXIST'].includes(error.code)) {
            outputCollision = true;
            error.message = '成品位置已有其他文件，未覆盖或移动。请重新选择保存位置后再生成。';
            throw error;
          }
          if (storageFailure(error)) {
            updateProject(projectId, { status: 'paused', stage: '工作磁盘需要处理', lastError: storageFailureMessage });
            error.message = storageFailureMessage;
            throw error;
          }
          if (error.hostFailure) {
            const retained = await retainBuildArtifacts({ workspaceDir: project.workspaceDir, attemptId: id, buildDir,
              outputDir: output, outputOwner, retainOutput: Boolean(outputOwner) });
            addIssue(projectId, 'build-validation-artifacts', '待验证产物已保留在工作目录；不会为宿主验证缺口自动购买修复请求',
              undefined, 'warning', { code: error.code, artifactDir: retained.directory, artifacts: retained.artifacts });
            throw error;
          }
          if (!signal?.aborted) {
            const retained = await retainBuildArtifacts({ workspaceDir: project.workspaceDir, attemptId: id, buildDir,
              outputDir: output, outputOwner, retainOutput: Boolean(outputOwner) });
            const repairBundle = { schema: 'pinhao-build-repair-1', createdAt: now(), phase, error: errorMessage(error),
              sourceFingerprint: project.sourceFingerprint, nativeRevision, workbenchDir: project.workbenchDir,
              units: units.map(({ id, legacyId, source, translation, context, revision }) => ({ id, legacyId, source, translation, context, revision })),
              scriptBinding: project.scriptBinding, buildResult, artifacts: retained.artifacts };
            const directory = path.join(project.workspaceDir, 'technical', 'build-repairs');
            await mkdir(directory, { recursive: true });
            const bundlePath = path.join(directory, `${inputHash}.json`);
            await writeFile(bundlePath, JSON.stringify(repairBundle));
            const current = requiredProject(projectId), previous = current.buildRepair;
            const attempts = previous?.inputHash === inputHash ? previous.attempts + 1 : 1;
            updateProject(projectId, { buildRepair: { inputHash, attempts, path: bundlePath, artifactDir: retained.directory,
              artifactDirs: [...(previous?.artifactDirs ?? (previous?.artifactDir ? [previous.artifactDir] : [])), retained.directory], phase, error: repairBundle.error },
              adaptationRequest: { id: current.adaptationRequest?.kind === 'build-repair' ? current.adaptationRequest.id : randomUUID(),
                kind: 'build-repair', nativeRevision, failure: { code: 'NATIVE_BUILD_FAILED', message: repairBundle.error, repairBundle } },
              adaptationDeferred: false, adaptationProgress: { status: 'needs-review', retryable: attempts < 3, blocked: attempts >= 3,
                reason: attempts >= 3 ? '同一构建问题已保存，请调整技术模型后继续修复' : '构建诊断已保存，技术 Agent 将继续修复' } });
            error.repairQueued = attempts < 3 && project.status === 'running';
          }
          throw error;
        } finally {
          await discardArtifact(projectId, path.dirname(buildDir), path.join(project.workspaceDir, 'builds'));
          if (!completed && outputOwner && !outputCollision) await discardArtifact(projectId, output, outputOwner);
          if (outputOwner) await releaseProductDirectory(output, projectId);
        }
      })();
      building.set(projectId, run);
      try { return await run; }
      finally { building.delete(projectId); buildControllers.delete(projectId); }
    },
    // 按需清单：UI 点“查看完整清单”时才调用，构建路径的返回值里已经带了同一份报告。
    async completionReport({ projectId }) {
      const project = availableProject(projectId);
      const units = store.units(projectId);
      const glossary = project.nameGlossary?.entries
        ?? (units.length ? scanTerminology(units, undefined, project.targetLanguage ?? settings.targetLanguage).entries : []);
      const latest = store.latestBuild(projectId);
      const report = buildCompletionReport(units, { glossary, issues: store.all('issues', projectId), builds: latest ? [latest] : [] });
      const textUsage = await loadRequestUsageSummary(path.join(project.workspaceDir, 'requests'), { roles: ['translation', 'proofreading'] });
      const acceptedSourceCharacters = units.filter(unit => ['translated', 'proofread'].includes(unit.status))
        .reduce((count, unit) => count + [...unit.source].length, 0);
      textUsage.delivery = { acceptedSourceCharacters,
        knownCostPerThousandSourceCharacters: acceptedSourceCharacters && textUsage.total.knownCost != null
          ? textUsage.total.knownCost * 1000 / acceptedSourceCharacters : null };
      const value = number => number == null ? '未知' : String(number);
      const totals = textUsage.total;
      const usageText = `\n文字请求用量（持久请求工件，非最近任务投影）：\n`
        + `  请求 ${totals.requests}；实际 HTTP 尝试 ${totals.httpAttempts}；费用未知请求 ${totals.unknownCostRequests}\n`
        + `  提供方报告已知费用（原计价口径）${value(totals.knownCost)}；每千已接纳源字符的已知部分 ${value(textUsage.delivery.knownCostPerThousandSourceCharacters)}\n`
        + `  输入 ${value(totals.promptTokens)}；输出 ${value(totals.completionTokens)}；推理 ${value(totals.reasoningTokens)}；缓存读取 ${value(totals.cacheReadTokens)}；缓存写入 ${value(totals.cacheWriteTokens)}\n`
        + `  已接纳源字符 ${acceptedSourceCharacters}（Unicode 码点）；候选/未提交校对不计入。未知费用不按免费处理。`
        + (textUsage.warnings.length ? `\n  ${textUsage.warnings.length} 份用量证据不完整，汇总不是完整账单。` : '');
      return { report, text: completionReportText(report) + usageText, textUsage };
    },
    async cleanupProject({ projectId }) {
      const project = requiredProject(projectId);
      if (cleaning.has(projectId) || building.has(projectId) || project.status === 'running' || project.status === 'preparing' || [...active.values()].some((job) => job.projectId === projectId)) throw new Error('请等待项目处理完成后清理');
      cleaning.add(projectId);
      let result;
      try {
        result = await pruneOldBuilds(projectId);
        const builds = store.all('builds', projectId);
        // These are rebuildable native overlays, not the frozen source or current text.
        for (const build of builds) {
          const cleaned = await discardArtifact(projectId, path.join(project.workspaceDir, 'builds', build.id), path.join(project.workspaceDir, 'builds'));
          result.freedBytes += cleaned.bytes;
        }
        emit();
        return result;
      } finally { cleaning.delete(projectId); }
    },
    async exportRelease({ projectId, filePath, buildId, target = 'windows' }) {
      const project = requiredProject(projectId);
      if (!['windows', 'joiplay'].includes(target)) throw new Error('请选择 Windows 分享包或 JoiPlay 手机包');
      const builds = store.all('builds', projectId);
      const build = buildId ? builds.find((b) => b.id === buildId) : builds.at(-1);
      if (!build) throw new Error('请先生成独立汉化版');
      const proof = await verifyOutput(build.path, build.outputManifest);
      if (!proof.valid) throw new Error('成品内容已有更新，请先重新生成成品，再导出分享包。现有副本和存档继续保留。');
      if (target === 'joiplay') {
        if (!['MV', 'MZ'].includes(project.engine)) throw new Error('JoiPlay 手机包当前接入 RPG Maker MV 和 MZ 成品');
        const result = await workerCall('mobileZip', { sourceDir: build.path, filePath, engine: project.engine, name: project.name, projectId });
        return { path: filePath, warnings: result.warnings ?? [] };
      }
      await workerCall('zip', { projectId, sourceDir: build.path, filePath, release: true, excludeSaves: true });
      return { path: filePath };
    },
    async recordRuntimeObservation({ projectId, buildId, kind, status, detail: observation }) {
      requiredProject(projectId);
      if (!['launch', 'process-exit'].includes(kind) || !['passed', 'failed', 'pending'].includes(status)) throw new Error('运行观察需要有效的进程状态');
      const build = store.all('builds', projectId).find(build => build.id === buildId);
      if (!build) return { recorded: false };
      const proof = await verifyOutput(build.path, build.outputManifest);
      if (!proof.valid) return { recorded: false, reason: proof.reason };
      const entry = { kind, status, detail: String(observation ?? '').slice(0, 500), outputHash: build.outputManifest.hash, observedAt: now() };
      const runtimeObservations = [...(build.runtimeObservations ?? []).filter(value => value.kind !== kind), entry];
      store.put('builds', { ...build, runtimeObservations,
        checks: [...build.checks.filter(check => check.name !== '游戏启动观察'), { name: '游戏启动观察', status, detail: entry.detail }] }, projectId);
      emit(); return { recorded: true };
    },
    async close() {
      if (closed) return;
      closing = true;
      textRecovery.clear();
      clearAdaptationWakes();
      catalogController.abort();
      await catalogReady;
      recollection.close();
      for (const project of projects()) if (project.status === 'running') updateProject(project.id, { status: 'paused', stage: '等待继续' });
      for (const job of active.values()) job.controller.abort();
      for (const job of preparing.values()) job.controller.abort();
      for (const controller of buildControllers.values()) controller.abort();
      if (lab) await (await lab)?.closeExecution?.();
      await worker.closeExecution?.();
      // Wait for transports to finish their cancellation handlers before closing SQLite.
      const deadline = Date.now() + 5000;
      while ((active.size || building.size || preparing.size || operations.size) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      await Promise.allSettled([...planning.values()]);
      closed = true;
      projectSnapshots.clear(); textSnapshots.clear(); storyCache.clear(); roundCache.clear(); roundChecks.clear();
      nativeTools.release();
      store.close();
    },
  };
  for (const method of ['buildProject', 'exportPackage', 'importPackage', 'exportRelease', 'scanRecollection']) {
    const execute = api[method];
    api[method] = async (input) => {
      if (cleaning.has(input.projectId)) throw new Error('项目正在清理，请稍后操作');
      const id = randomUUID();
      const promise = execute(input);
      operations.set(id, { projectId: input.projectId, promise });
      try { return await promise; }
      finally { operations.delete(id); }
    };
  }
  // The desktop can paint while capabilities load; actual production still uses the fresh native revision.
  if (deferCatalog) for (const method of ['createProject', 'beginProject', 'startProject', 'continueAvailableText', 'retryAdaptation', 'buildProject']) {
    const execute = api[method];
    api[method] = async input => {
      await catalogReady;
      if (closing || closed) throw new Error('工作台正在关闭');
      return execute(input);
    };
  }
  for (const project of projects()) {
    if (!project.unavailable) await logStorage.reconcile(project.id);
    if (!project.adaptationRequest || project.unavailable) continue;
    const directory = path.join(project.workspaceDir, 'technical', project.adaptationRequest.id, 'accepted-receipts');
    let records;
    try { records = await discoverAcceptedBatches(directory); }
    catch (error) {
      updateProject(project.id, { status: 'paused', stage: '技术成果记录需要处理', lastError: errorMessage(error) });
      addIssue(project.id, 'acceptance-recovery', errorMessage(error), undefined, 'error');
      continue;
    }
    if (!records.some(record => !['integrated', 'stale'].includes(store.one('acceptance_receipts', record.id)?.status))) continue;
    const task = store.tasks(project.id).find(task => task.kind === 'adaptation');
    if (task) await executeAdaptation({ ...task, reconciliationOnly: true }, new AbortController().signal);
  }
  return api;
}
