import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, appendFile, mkdir, open, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { adaptationInstructions, createAdaptationStateWriter, finishAdaptationBusinessResult,
  readAdaptationState, sanitizeTechnicalData } from './adaptation.mjs';
import { accumulateVerifiedExtractions } from './adaptation/verified-batches.mjs';
import { inheritAdaptationStates } from './adaptation/transfer-state.mjs';
import { engineOperations, renderEngineOperations } from './engine-operations.mjs';
import { createDshToolBridge, isDshReadOnlyTool } from './dsh-tool-bridge.mjs';
import { createDshRuntimeBridgeServer } from './dsh-runtime-bridge-server.mjs';
import { createDshModelRelay } from './dsh-model-relay.mjs';
import { reasoningPreference } from '../core/model-reasoning.mjs';

export const DSH_BACKEND_VERSION = '22ddee3792402c3e70ec5f86a63c3e3e895a2f60';
export const DSH_PROFILE = 'sdk-minimal';
const patchFile = fileURLToPath(new URL('./dsh-profile.patch.yml', import.meta.url));
const pluginFile = fileURLToPath(new URL('./dsh-tools-plugin/index.mjs', import.meta.url));
const runtimeEntry = fileURLToPath(new URL('./dsh-runtime-entry.mjs', import.meta.url));
const stamp = () => new Date().toISOString();
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const hashFile = async file => { const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex'); };
const fault = (code, message) => Object.assign(new Error(message), { code });
const adapterPending = coverage => (coverage?.summary?.adapterCandidates ?? 0) > 0;
const activeJobs = new Set();
const runtimeInspections = new Map();
const exists = async file => { try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const runtimeRoot = async sourceRoot => {
  if (sourceRoot) return sourceRoot;
  const artifact = fileURLToPath(new URL('../../local/dsh-runtime', import.meta.url));
  return await exists(path.join(artifact, 'pinhao-runtime-provenance.json')) ? artifact
    : fileURLToPath(new URL('../../local/upstream/deepseek-harness', import.meta.url));
};
const modelProfile = ({ model, contextWindow, maxTokens, baseUrl = 'host-owned-loopback' }) => ({ providers: {
  'pinhao-relay': { api: 'openai-completions', apiKeyEnv: 'PINHAO_DSH_MODEL_TOKEN', baseURL: baseUrl,
    defaultContextWindow: contextWindow, defaultMaxTokens: maxTokens,
    retryPolicy: { mode: 'normal', maxRetries: 0 },
    compat: { supportsDeveloperRole: false, supportsStore: false, supportsStrictMode: false,
      supportsUsageInStreaming: true, maxTokensField: 'max_tokens', thinkingFormat: 'deepseek' },
    models: [{ id: model, contextWindow, maxTokens }],
  },
} });

export async function inspectDshRuntime({ sourceRoot } = {}) {
  sourceRoot = await runtimeRoot(sourceRoot);
  const provenanceFile = path.join(sourceRoot, 'pinhao-runtime-provenance.json');
  let provenance;
  if (await exists(provenanceFile)) {
    provenance = JSON.parse(await readFile(provenanceFile, 'utf8'));
    if (provenance.schema !== 'pinhao-dsh-runtime-1' || provenance.commit !== DSH_BACKEND_VERSION) throw fault('DSH_RUNTIME_VERSION', 'Runtime artifact provenance differs from the fixed DSH commit');
  } else {
    const head = (await readFile(path.join(sourceRoot, '.git/HEAD'), 'utf8')).trim();
    const commit = head.startsWith('ref: ') ? (await readFile(path.join(sourceRoot, '.git', head.slice(5)), 'utf8')).trim() : head;
    if (commit !== DSH_BACKEND_VERSION) throw fault('DSH_RUNTIME_VERSION', 'Runtime checkout differs from the fixed DSH commit');
  }
  const fromManifest = relative => {
    if (typeof relative !== 'string' || path.isAbsolute(relative)) throw fault('DSH_RUNTIME_PROVENANCE', 'Runtime entry must be relative to its artifact root');
    const file = path.resolve(sourceRoot, relative), inside = path.relative(sourceRoot, file);
    if (inside.startsWith('..') || path.isAbsolute(inside)) throw fault('DSH_RUNTIME_PROVENANCE', 'Runtime entry escapes its artifact root');
    return file;
  };
  const sdkEntry = provenance ? fromManifest(provenance.sdkEntry) : path.join(sourceRoot, 'packages/sdk/client/lib/index.js');
  const runtimeEntry = provenance ? fromManifest(provenance.runtimeEntry) : path.join(sourceRoot, 'apps/cli/lib/bin.js');
  const modelProviderEntry = provenance ? fromManifest(provenance.modelProviderEntry) : path.join(sourceRoot, 'packages/llm/llm-pi-ai/lib/index.js');
  let nodeExecutable, nodeDigest, nodeProvenance;
  if (provenance) {
    if (!provenance.nodeExecutable || !provenance.nodeProvenance) throw fault('DSH_RUNTIME_NODE_REQUIRED', 'Runtime artifact requires its own standard Node executable');
    nodeExecutable = fromManifest(provenance.nodeExecutable);
    const nodeMetadata = fromManifest(provenance.nodeProvenance);
    for (const [entry, file] of [[provenance.nodeExecutable, nodeExecutable], [provenance.nodeProvenance, nodeMetadata]]) {
      const digest = await hashFile(file);
      if (provenance.files?.find(row => row.path === entry)?.sha256 !== digest) throw fault('DSH_RUNTIME_PROVENANCE', `Runtime artifact hash changed: ${entry}`);
      if (file === nodeExecutable) nodeDigest = digest;
    }
    nodeProvenance = JSON.parse(await readFile(nodeMetadata, 'utf8'));
    if (nodeProvenance.schema !== 'pinhao-managed-node-1' || nodeProvenance.sha256 !== nodeDigest) throw fault('DSH_RUNTIME_PROVENANCE', 'Runtime Node differs from its recorded official asset');
    if (nodeProvenance.platform !== process.platform || nodeProvenance.arch !== process.arch) throw fault('DSH_RUNTIME_NODE_PLATFORM', 'Runtime Node platform differs from the host');
  } else {
    if (process.versions.electron) throw fault('DSH_RUNTIME_NODE_REQUIRED', 'Electron must launch DSH with a packaged standard Node executable');
    nodeExecutable = process.execPath;
    nodeDigest = await hashFile(nodeExecutable);
  }
  if (await exists(sdkEntry) && await exists(runtimeEntry)) {
    const sdkHash = hash(await readFile(sdkEntry)), runtimeHash = hash(await readFile(runtimeEntry)), providerHash = hash(await readFile(modelProviderEntry));
    if (provenance) for (const [entry, digest] of [[provenance.sdkEntry, sdkHash], [provenance.runtimeEntry, runtimeHash], [provenance.modelProviderEntry, providerHash]]) {
      if (provenance.files?.find(row => row.path === entry)?.sha256 !== digest) throw fault('DSH_RUNTIME_PROVENANCE', `Runtime artifact hash changed: ${entry}`);
    }
    return { sourceRoot, mode: 'compiled', sdkEntry, runtimeEntry, modelProviderEntry, nodeExecutable, nodeDigest, nodeProvenance,
      artifactDigest: hash([sdkHash, runtimeHash, providerHash, nodeDigest, provenance ?? null]) };
  }
  if (provenance) throw fault('DSH_RUNTIME_PROVENANCE', 'Compiled runtime artifact is incomplete');
  return { sourceRoot, mode: 'source', nodeExecutable, nodeDigest, sdkEntry: path.join(sourceRoot, 'packages/sdk/client/src/index.ts'),
    runtimeEntry: path.join(sourceRoot, 'apps/cli/src/bin.ts'), modelProviderEntry: path.join(sourceRoot, 'packages/llm/llm-pi-ai/src/index.ts'), artifactDigest: hash([
      await readFile(path.join(sourceRoot, 'packages/sdk/client/src/index.ts'), 'utf8'),
      await readFile(path.join(sourceRoot, 'apps/cli/src/bin.ts'), 'utf8')]) };
}

/** A process lifecycle shares immutable carrier validation, not a path-only trust cache. */
export async function verifiedDshRuntime({ sourceRoot } = {}) {
  sourceRoot = await runtimeRoot(sourceRoot);
  const key = await realpath(sourceRoot);
  const signature = async files => Promise.all(files.map(async file => {
    const info = await stat(file, { bigint: true });
    return [file, String(info.dev), String(info.ino), String(info.size), String(info.mtimeNs), String(info.ctimeNs)];
  }));
  const prior = runtimeInspections.get(key);
  if (prior) {
    const saved = await prior;
    if (hash(await signature(saved.files)) === saved.signature) return saved.runtime;
    runtimeInspections.delete(key);
  }
  const pending = (async () => {
    const runtime = await inspectDshRuntime({ sourceRoot });
    const files = [...new Set([runtime.nodeExecutable, runtime.sdkEntry, runtime.runtimeEntry, runtime.modelProviderEntry,
      path.join(runtime.sourceRoot, 'pinhao-runtime-provenance.json'),
      ...(runtime.nodeProvenance ? [path.join(runtime.sourceRoot, 'node/provenance.json')] : [])])];
    const available = [];
    for (const file of files) if (await exists(file)) available.push(file);
    const head = path.join(runtime.sourceRoot, '.git/HEAD');
    if (await exists(head)) {
      available.push(head);
      const value = (await readFile(head, 'utf8')).trim();
      if (value.startsWith('ref: ')) available.push(path.join(runtime.sourceRoot, '.git', value.slice(5)));
    }
    return { runtime: Object.freeze(runtime), files: available, signature: hash(await signature(available)) };
  })();
  runtimeInspections.set(key, pending);
  try { return (await pending).runtime; }
  catch (error) { if (runtimeInspections.get(key) === pending) runtimeInspections.delete(key); throw error; }
}

export function dshModelCapacity(connection, overrides = {}) {
  const contextWindow = overrides.contextWindow ?? connection.contextWindow ?? 32768;
  const maxTokens = overrides.maxTokens ?? connection.maxOutputTokens ?? Math.min(4096, Math.floor(contextWindow / 4));
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1 || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens >= contextWindow) {
    throw fault('TECHNICAL_CONFIGURATION_ERROR', '请填写有效模型容量：上下文容量必须大于单次输出上限');
  }
  return { contextWindow, maxTokens, capacitySource: { contextWindow: overrides.contextWindow != null || connection.contextWindow != null ? 'configured' : 'conservative-default',
    maxOutputTokens: overrides.maxTokens != null || connection.maxOutputTokens != null ? 'configured' : 'conservative-default' } };
}

export async function createFixedDshHarness(launch, config = {}) {
  const runtime = config.runtime ?? await inspectDshRuntime(config);
  const { sourceRoot } = runtime;
  if (runtime.mode === 'compiled') {
    const { DeepSeekHarness, HarnessClient } = await import(pathToFileURL(runtime.sdkEntry).href);
    if (!runtime.nodeExecutable) throw fault('DSH_RUNTIME_NODE_REQUIRED', 'Compiled DSH requires a verified standard Node executable');
    const env = { ...(launch.env ?? process.env), PINHAO_DSH_SOURCE_ROOT: sourceRoot,
      ...(launch.dshHome === undefined ? {} : { DSH_HOME: path.resolve(launch.dshHome) }) };
    delete env.ELECTRON_RUN_AS_NODE;
    // Fixed SDK's generic factory seam changes only the process command, not its transport or lifecycle.
    const processSpec = { command: runtime.nodeExecutable,
      args: [runtime.runtimeEntry, '--profile', launch.profile ?? 'sdk',
        ...(launch.patches ?? []).flatMap(file => ['--patch', path.resolve(file)])],
      ...(launch.processCwd === undefined ? {} : { cwd: launch.processCwd }),
      environment: () => ({ ...env }), description: `dsh profile ${JSON.stringify(launch.profile ?? 'sdk')}`,
      initializeTimeoutMs: launch.initializeTimeoutMs ?? 10000,
      ...Object.fromEntries(['requestTimeoutMs', 'shutdownTimeoutMs', 'disposeEofGraceMs', 'disposeGraceMs']
        .filter(key => launch[key] !== undefined).map(key => [key, launch[key]])) };
    return new DeepSeekHarness(launch, () => new HarnessClient({}, processSpec));
  }
  const require = createRequire(path.join(sourceRoot, 'package.json'));
  const { tsImport } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
  const { DeepSeekHarness } = await tsImport(pathToFileURL(runtime.sdkEntry).href, {
    parentURL: import.meta.url, tsconfig: path.join(sourceRoot, 'apps/cli/tsconfig.json'),
  });
  return new DeepSeekHarness({ ...launch, dshBin: runtimeEntry,
    env: { ...launch.env, PINHAO_DSH_SOURCE_ROOT: sourceRoot } });
}

function runtimeEnvironment({ relay, server, sessionId, instructions, contextWindow, maxTokens, pendingPromptDigest }) {
  // No provider credential or unrelated application secret enters the child.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/key|secret|token|password|credential/i.test(key)
    && !/^(?:DSH_|PINHAO_DSH_)/.test(key)));
  return { ...env, DSH_TELEMETRY_DISABLED: '1',
    DSH_SYSTEM_PROMPT: instructions, PINHAO_DSH_MODEL_URL: relay.baseUrl,
    PINHAO_DSH_MODEL_TOKEN: relay.apiKey, PINHAO_DSH_MODEL: relay.model,
    PINHAO_DSH_CONTEXT_WINDOW: String(contextWindow), PINHAO_DSH_MAX_TOKENS: String(maxTokens),
    PINHAO_DSH_TOOL_URL: server.url, PINHAO_DSH_TOOL_TOKEN: server.token,
    PINHAO_DSH_SESSION_ID: sessionId, PINHAO_DSH_PLUGIN: pluginFile,
    PINHAO_DSH_PENDING_PROMPT_HASH: pendingPromptDigest ?? '' };
}

async function lockRuntime(directory) {
  const file = path.join(directory, 'runner.lock');
  const claim = async () => {
    const handle = await open(file, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: stamp() }));
    return async () => { await handle.close(); await unlink(file); };
  };
  try { return await claim(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let saved;
    try { saved = JSON.parse(await readFile(file, 'utf8')); }
    catch { throw fault('DSH_RUNTIME_OCCUPIED', 'Runtime lock is unreadable; reconcile the previous process first'); }
    if (!Number.isSafeInteger(saved.pid) || saved.pid < 1) throw fault('DSH_RUNTIME_OCCUPIED', 'Runtime has an invalid saved owner');
    try { process.kill(saved.pid, 0); }
    catch (probe) {
      if (probe.code !== 'ESRCH') throw fault('DSH_RUNTIME_OCCUPIED', 'Cannot confirm that the previous runtime owner exited');
      await unlink(file);
      return claim();
    }
    throw fault('DSH_RUNTIME_OCCUPIED', 'This job already has an active runtime');
  }
}

/** The service keeps its existing queue. One invocation owns one DSH process. */
export function createDshAdaptationProvider(defaults = {}) {
  return options => runDshAdaptation({ ...options, dsh: { ...defaults, ...options.dsh } });
}

export async function runDshAdaptation(options) {
  const { connection, project, inventory = {}, coverage: initialCoverage, failure, lab,
    gameDir = project.sourceDir, readDir = gameDir, readRoots = [], copySourceFiles,
    workspaceDir, statePath, resume = true, signal: userSignal,
    onProgress = () => {}, onAcceptedBatch, onLessons, getLessons = () => [],
    assignment, requestContext, verifyCoverage, requestScopeChange, getExistingUnits,
    research, diagnostics = false, requestTimeoutMs = 300000, dsh = {} } = options;
  if (!lab || !gameDir || !workspaceDir) throw fault('DSH_CONTEXT_REQUIRED', 'Technical adaptation needs a source, workspace and adapter laboratory');
  if (!connection?.model || !connection?.baseUrl || !connection?.apiKey) throw fault('TECHNICAL_CONNECTION_REQUIRED', 'Configure the technical model before starting');
  const jobId = assignment?.id ?? requestContext?.jobId ?? 'coordinator', requestId = requestContext?.adaptationRequestId ?? 'local';
  const jobKey = hash([project.id, requestId, jobId]);
  if (activeJobs.has(jobKey)) throw fault('DSH_RUNTIME_OCCUPIED', 'This job already has an active runner');
  activeJobs.add(jobKey);
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, userSignal].filter(Boolean));
  const clean = value => sanitizeTechnicalData(value, [connection.apiKey]);
  const writeState = createAdaptationStateWriter(statePath), persist = state => writeState(clean(state));
  let state, bridge, relay, server, harness, session, releaseLock, runtimeFailure, ownsState = false;
  let coverage = initialCoverage, result, events = Promise.resolve(), windowMaterial = 0;
  const hostLab = lab;
  const boundLab = new Proxy(hostLab, { get(target, key) { const value = target[key]; return typeof value === 'function'
    ? (input = {}, ...rest) => value.call(target, { ...input, requestContext }, ...rest) : value; } });
  let quiescence;
  const quiesce = () => quiescence ??= (async () => {
    if (!ownsState) return;
    // Stop admission before taking the final business snapshot. Accepted
    // receipts and their already-started commit callbacks are then drained.
    const closingServer = server?.close();
    if (!controller.signal.aborted) controller.abort(fault('DSH_RUNTIME_STOPPED', 'Runtime execution ended'));
    await harness?.close();
    await closingServer;
    await boundLab.settleWorkspaceRuns?.({ workDir: workspaceDir, cancelled: true });
    await bridge?.flush();
    await events;
    await relay?.close();
  })();
  const stopRuntime = error => {
    runtimeFailure ??= error;
    if (!signal.aborted) controller.abort(error);
    void harness?.close().catch(() => {});
  };
  const finish = async result => {
    await quiesce();
    coverage = bridge?.session.coverage() ?? coverage;
    return finishAdaptationBusinessResult({ state, session: bridge?.session,
      result: { ...result, coverage }, coverage, windowMaterial, continuation: result.continuation, persist, onProgress });
  };
  try {
    userSignal?.throwIfAborted();
    await mkdir(workspaceDir, { recursive: true });
    const runtime = dsh.harnessFactory ? { mode: 'injected-test', artifactDigest: dsh.runtimeDigest ?? 'injected-test' }
      : await verifiedDshRuntime({ sourceRoot: dsh.sourceRoot });
    const { contextWindow, maxTokens, capacitySource } = dshModelCapacity(connection, dsh);
    const profileDigest = hash([await readFile(patchFile, 'utf8'), await readFile(pluginFile, 'utf8'), DSH_BACKEND_VERSION,
      runtime.mode, runtime.artifactDigest, connection.baseUrl, reasoningPreference(connection),
      modelProfile({ model: connection.model, contextWindow, maxTokens })]);
    const sourceIdentity = project.sourceFingerprint ?? initialCoverage?.sourceContextHash;
    if (!sourceIdentity) throw fault('DSH_SOURCE_IDENTITY_REQUIRED', 'The host must bind a real source fingerprint before a runtime can start');
    const sourceFingerprint = hash(sourceIdentity);
    const assignmentRevision = hash(assignment ?? { files: [] });
    const previous = resume ? await readAdaptationState(statePath) : null;
    const priorCheckpoint = previous ? structuredClone(previous) : null;
    const legacy = previous && previous.backend?.name !== 'dsh';
    const legacyIdentities = [hash([project.id ?? project.name, requestId === 'local' ? project.adaptationRequest?.id ?? null : requestId, gameDir, assignment?.id ?? null]),
      hash([project.id ?? project.name, project.sourceFingerprint ?? null, gameDir, ...(assignment ? [assignment.id, assignment.files] : [])])];
    state = previous ?? { format: 'pinhao-adaptation-task-1', id: randomUUID(), identity: jobKey,
      createdAt: stamp(), attempts: 0, failures: {}, events: [], executionWindow: 0 };
    if (state.identity !== jobKey && !(legacy && legacyIdentities.includes(state.identity))) throw fault('DSH_SESSION_IDENTITY', 'Checkpoint belongs to another technical job');
    if (!legacy && state.backend && (state.backend.sourceFingerprint !== sourceFingerprint || state.backend.assignmentRevision !== assignmentRevision)) {
      throw fault('DSH_SESSION_SOURCE_CHANGED', 'Source or assignment changed; reconcile the saved execution before restarting');
    }
    const rotation = legacy ? 'legacy-runtime-upgrade' : state.backend && (state.backend.profileDigest !== profileDigest || state.backend.backendVersion !== DSH_BACKEND_VERSION) ? 'model-or-runtime-configuration-changed' : null;
    const oldBackend = state.backend;
    const backend = () => ({ name: 'dsh', backendVersion: DSH_BACKEND_VERSION, profileDigest,
      projectId: project.id, adaptationRequestId: requestId, jobId, jobExecutionId: randomUUID(), sourceFingerprint,
      assignmentRevision, runtimeMode: runtime.mode, runtimeArtifactDigest: runtime.artifactDigest, sessionId: `pinhao-${randomUUID()}`,
      runtimeHome: oldBackend?.runtimeHome ?? path.join(workspaceDir, 'dsh-runtime'), workspace: path.resolve(workspaceDir),
      model: connection.model, capacity: { contextWindow, maxOutputTokens: maxTokens, source: capacitySource },
      startMaterial: state.control?.materialSerial ?? 0 });
    state.backend ??= backend();
    windowMaterial = state.control?.materialSerial ?? 0;
    await mkdir(state.backend.runtimeHome, { recursive: true });
    releaseLock = await lockRuntime(state.backend.runtimeHome);
    ownsState = true;
    let archiveRecord;
    if (rotation) {
      const archive = path.join(workspaceDir, 'executions');
      await mkdir(archive, { recursive: true });
      archiveRecord = path.join(archive, `${hash([priorCheckpoint.id, oldBackend?.jobExecutionId ?? 'legacy', profileDigest]).slice(0, 40)}.json`);
      try { await writeFile(archiveRecord, JSON.stringify(clean(priorCheckpoint)), { flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    state.identity = jobKey;
    if (options.inheritStates?.length) await inheritAdaptationStates(state, {
      projectId: project.id, assignment, transfers: options.inheritStates,
    });
    windowMaterial = state.control?.materialSerial ?? 0;
    state.executionWindow++; state.status = 'running'; state.assignment = assignment;
    delete state.error; delete state.windowStop; delete state.blocked; delete state.blockedReason;
    state.updatedAt = stamp();
    let binding = { projectId: project.id, adaptationRequestId: requestId, jobId,
      jobExecutionId: state.backend.jobExecutionId, sessionId: state.backend.sessionId };
    const trustedCatalog = await boundLab.listTools?.() ?? [];
    let restored = [];
    for (const batch of state.acceptedBatches ?? []) {
      signal.throwIfAborted();
      const extraction = await boundLab.extractRecipe({ projectId: project.id, workDir: workspaceDir,
        recipeId: batch.recipeId, gameDir, workspaceDir: path.join(workspaceDir, 'restored', batch.recipeId), signal, requestContext });
      restored = accumulateVerifiedExtractions(restored, [extraction]);
    }
    if (!previous) {
      const reused = failure?.repairBundle ? null : await boundLab.tryRecipes({ projectId: project.id, workDir: workspaceDir,
        gameDir, workspaceDir: path.join(workspaceDir, 'reused'), engine: project.engine, files: assignment?.files,
        evaluateCoverage: verifyCoverage ? extraction => verifyCoverage({ ...extraction, preview: true, coverageDecisions: state.coverageDecisions }) : undefined,
        signal, requestContext });
      if (reused) restored = accumulateVerifiedExtractions(restored, [reused]);
    }
    if (restored.length && verifyCoverage) coverage = await verifyCoverage({ units: restored.flatMap(item => item.units), coverageDecisions: state.coverageDecisions });
    const businessOptions = { ...options, project, inventory, coverage, lab: boundLab, gameDir, readDir, readRoots,
      copySourceFiles, workspaceDir, state, signal, persist, onProgress, onLessons, onAcceptedBatch,
      verifyCoverage, assignment, requestScopeChange, getExistingUnits, research, requestContext,
      initialExtractions: restored, secrets: [connection.apiKey], binding,
      trustedToolNames: trustedCatalog.map(item => item.name), trustedToolCatalog: trustedCatalog };
    bridge = await createDshToolBridge(businessOptions);
    const recoveredControl = await bridge.session.control.restore();
    if (previous && recoveredControl.environmentChanged) throw fault('DSH_SESSION_SOURCE_CHANGED', 'The actual source receipts changed; reconcile the saved execution before continuing');
    await persist(state);
    const unknownOperations = Object.values(state.dshToolBridge?.operations ?? {}).filter(row => ['executing', 'pending-reconciliation'].includes(row.status));
    for (const operation of unknownOperations) {
      const recovered = await bridge.reconcile(operation.operationId);
      if (recovered.status === 'pending-reconciliation' && !recovered.readOnly) throw fault('DSH_OPERATION_RECONCILIATION', `Operation ${operation.operationId} has an unknown side effect`);
    }
    const unknownLegacy = Object.entries(state.pendingOperations ?? {}).filter(([id, operation]) =>
      !isDshReadOnlyTool(operation.tool) && operation.tool !== 'host-control' && !state.dshToolBridge.operations[id]);
    if (unknownLegacy.length) throw Object.assign(fault('DSH_OPERATION_RECONCILIATION', '旧操作缺少终态证据，已保留历史；请先核对候选、进程和接受回执，不能重复执行未知写入'),
      { details: { operations: unknownLegacy.map(([operationId, operation]) => ({ operationId, tool: operation.tool, receiptId: operation.receiptId })) } });
    if (rotation) {
      await bridge.close();
      state.backend = backend();
      state.backend.transition = { reason: rotation, archive: archiveRecord, previousSessionId: oldBackend?.sessionId, at: stamp() };
      delete state.dshToolBridge; delete state.messages;
      binding = { ...binding, jobExecutionId: state.backend.jobExecutionId, sessionId: state.backend.sessionId };
      bridge = await createDshToolBridge({ ...businessOptions, binding });
      await bridge.session.control.restore();
      await persist(state);
      await onProgress({ status: 'running', phase: 'runtime-reconfigured', reason: '模型或运行环境已更新，保留成果并建立新的技术会话' });
    }
    coverage = bridge.session.coverage();
    if (coverage && coverage.needsAdaptation === false && !adapterPending(coverage) && !failure?.repairBundle) {
      return await finish(bridge.session.result() ?? { status: 'verified', kind: 'coverage-review', reused: restored.length > 0,
        extractions: restored, units: restored.flatMap(item => item.units), coverage });
    }
    server = await createDshRuntimeBridgeServer({ bridge, state, signal, persist, lab: boundLab, project, getLessons, onFatal: stopRuntime,
      gameDir, workspaceDir, initialWaitMs: dsh.initialWaitMs ?? 1000 });
    relay = await (dsh.relayFactory ?? createDshModelRelay)({ connection, requestContext,
      directory: path.join(workspaceDir, 'requests'), contentDirectory: path.join(workspaceDir, 'request-content'),
      signal, diagnostics, requestTimeoutMs, onFailure: stopRuntime,
      onWait: details => onProgress({ status: 'running', phase: details.phase, ...details }),
      onModelPresented: async details => { await bridge.session.control.modelPresented(details); await server.modelPresented(details); } });
    const instructions = `${adaptationInstructions()}\n\nOnly host acceptance receipts establish completion. Ordinary final text is not a verified result. You may investigate across files, write scripts and use all registered business tools.\n\n${renderEngineOperations(engineOperations(project.engine, trustedCatalog))}`;
    const env = runtimeEnvironment({ relay, server, sessionId: binding.sessionId, instructions, contextWindow, maxTokens,
      pendingPromptDigest: state.backend.pendingPrompt?.settled === false ? state.backend.pendingPrompt.digest : undefined });
    const pluginPatch = path.join(state.backend.runtimeHome, 'pinhao-plugin.patch.json');
    await writeFile(pluginPatch, JSON.stringify([{ id: 'compaction-basic', config: { maxTokens: Math.min(8192, maxTokens) } }, { insert: [
      { id: 'pinhao-llm-relay', name: runtime.modelProviderEntry ?? '@deepseek-ai/dsh-llm-pi-ai',
        config: modelProfile({ model: connection.model, contextWindow, maxTokens, baseUrl: relay.baseUrl }) },
      { id: 'pinhao-business-tools', name: pluginFile },
    ] }]));
    const launch = { profile: DSH_PROFILE, patches: [patchFile, pluginPatch], dshHome: state.backend.runtimeHome,
      cwd: path.resolve(workspaceDir), processCwd: process.platform === 'win32' ? path.toNamespacedPath(path.resolve(workspaceDir)) : path.resolve(workspaceDir),
      provider: 'pinhao-relay', model: connection.model,
      maxTokens, env, initializeTimeoutMs: dsh.initializeTimeoutMs ?? 30000,
      shutdownTimeoutMs: 1000, disposeEofGraceMs: 6000, disposeGraceMs: 3000,
      ...dsh.launch };
    const factory = dsh.harnessFactory ?? (args => createFixedDshHarness(args, { runtime }));
    harness = await factory(launch);
    const onAbort = () => { void harness.close().catch(error => { runtimeFailure ??= error; }); };
    signal.addEventListener('abort', onAbort, { once: true });
    const started = Date.now();
    await harness.start();
    signal.throwIfAborted();
    state.backend.readyMs = Date.now() - started;
    session = state.backend.sessionStarted ? await harness.resumeSession(binding.sessionId) : harness.session(binding.sessionId);
    await onProgress({ status: 'running', phase: 'runtime-ready', backend: 'dsh', sessionId: binding.sessionId, readyMs: state.backend.readyMs });
    const record = notification => {
      events = events.then(async () => {
        const event = notification.params.event;
        const indexed = diagnostics ? clean(notification) : { schema: 'pinhao-dsh-event-reference-1',
          method: notification.method, sessionId: notification.params.sessionId, status: notification.params.status,
          ...(event ? { event: { type: event.type, seq: event.seq, time: event.time } } : {}),
          payloadHash: hash(clean(notification)), sessionLogRoot: path.join(state.backend.runtimeHome, 'sessions') };
        await appendFile(path.join(state.backend.runtimeHome, 'events.jsonl'), `${JSON.stringify(indexed)}\n`);
        if (notification.method === 'session.event') {
          const firstSessionEvent = !state.backend.sessionStarted;
          state.backend.sessionStarted = true;
          if (event?.type === 'step/start') {
            state.backend.modelSteps = (state.backend.modelSteps ?? 0) + 1;
            await onProgress({ status: 'running', tool: 'model_step', phase: 'requesting', step: state.backend.modelSteps });
          }
          if (firstSessionEvent) await persist(state);
        }
      });
      void events.catch(stopRuntime);
    };
    let prompt = rotation
      ? `A new runtime execution continues this same business task after ${rotation}. Existing evidence, candidate and acceptance receipts remain authoritative. Inspect the saved context before doing new work; do not rerun completed scripts or resubmit accepted text.\n${JSON.stringify({ candidateId: state.candidateId, validationId: state.validationId, previousSessionId: oldBackend?.sessionId })}`
      : previous
      ? 'Continue this same technical job from its durable session and business receipts. Reconcile pending operations first. Do not rerun completed scripts or resubmit accepted text.'
      : JSON.stringify(clean({ task: '自主修复游戏提取与原生回写适配', project: { name: project.name, engine: project.engine }, assignment,
        failure: failure ? { ...failure, ...(failure.repairBundle ? { repairBundle: {
          available: true, phase: failure.repairBundle.phase, error: failure.repairBundle.error, nextAction: 'read_failure',
        } } : {}) } : null, sourceContext: { sourceDir: gameDir, workDir: workspaceDir },
        objective: 'Find the real display text source, deliver a safe adapter or evidence-based coverage disposition, and use the host validation and acceptance tools.' }));
    if (state.backend.pendingPrompt && !state.backend.pendingPrompt.settled) {
      const restored = state.backend.restoredSession;
      if (restored?.source !== 'resume' || restored.pendingPromptDigest !== state.backend.pendingPrompt.digest) {
        throw fault('DSH_PROMPT_RECONCILIATION', 'Saved session did not reconcile the previous prompt');
      }
      state.backend.pendingPrompt.reconciledAt = stamp();
      state.backend.pendingPrompt.presentInSession = restored.pendingPromptPresent;
      state.backend.pendingPrompt.settled = true;
      await persist(state);
    }
    while (!bridge.session.done()) {
      signal.throwIfAborted();
      const completed = await server.completedRuns();
      if (completed.length) prompt += `\n\nCompleted original processes (do not restart):\n${JSON.stringify(completed)}`;
      state.backend.pendingPrompt = { at: stamp(), digest: hash(prompt), settled: false };
      await persist(state);
      const interval = await session.run(prompt, { onNotification: record });
      await events;
      state.backend.pendingPrompt.settled = true;
      state.backend.lastIdleAt = stamp();
      await persist(state);
      signal.throwIfAborted();
      if (relay.failure()) throw relay.failure();
      const turnError = interval.events?.findLast(event => event.type === 'turn/end' && event.data?.reason?.kind === 'error')?.data.reason.error;
      if (turnError) throw fault(turnError.code ?? 'DSH_MODEL_FAILED', turnError.message ?? 'Runtime model turn failed');
      if (bridge.session.done()) break;
      if (state.validation?.error?.code === 'DISPLAY_REVIEW_UNAVAILABLE') {
        return await finish({ status: 'needs-review', stopReason: 'DISPLAY_REVIEW_UNAVAILABLE',
          reason: '显示用途复核接口暂不可用，候选已保留；接口恢复后继续验证，无需重写适配器',
          error: state.validation.error, candidateId: state.candidateId, validationId: state.validationId });
      }
      if (state.validationId && state.validationId === state.validation?.validationId
        && state.validation.passed === false && state.validation.blockedNeeds?.some(need => need.requirementRef && !need.satisfiedBy)) {
        const blocked = state.validation.blockedNeeds.filter(need => need.requirementRef && !need.satisfiedBy);
        return await finish({ status: 'needs-review', stopReason: 'HOST_VERIFICATION_BLOCKED',
          stopReasonCode: 'HOST_VERIFICATION_BLOCKED', candidateId: state.candidateId, validationId: state.validationId,
          retryable: false,
          reason: '主机验证仍缺少明确条件，候选和验证证据已保存',
          blockedNeeds: blocked, coverage: bridge.session.coverage() });
      }
      // Idle is a transport fact. Consume any finishing process before the
      // next turn, including completion after DSH's final inbox check.
      let notices = await server.completedRuns({ wait: true });
      while (server.hasPendingRuns() && !notices.length) {
        signal.throwIfAborted(); notices = await server.completedRuns({ wait: true });
      }
      const openItems = Object.values(state.workItems ?? {}).filter(item => !['accepted', 'closed_non_display', 'stale'].includes(item.status));
      if (!server.hasPendingRuns() && !state.candidateId && openItems.length && openItems.every(item =>
        item.readiness?.status === 'blocked' && item.sourceEvidenceRefs?.length && !item.unverifiedEvidenceRefs?.length
          && item.blockers?.length && item.blockers.every(blocker => typeof blocker.code === 'string' && blocker.code.trim()
            && typeof blocker.message === 'string' && blocker.message.trim()))) {
        return await finish({ status: 'needs-review', stopReason: 'SAVED_EVIDENCE_BLOCKER',
          reason: '技术 Agent 已保存具体阻碍和来源证据，等待补充条件后继续',
          reportedBlockers: { claimStatus: 'agent-reported-not-host-verified', items: openItems.map(item => ({
            itemId: item.itemId, file: item.resource.path, sourceEvidenceRefs: item.sourceEvidenceRefs,
            blockers: item.blockers, proposedNextAction: item.proposedNextAction,
          })) }, coverage: bridge.session.coverage() });
      }
      await onProgress({ status: 'running', phase: 'session-idle', sessionId: binding.sessionId });
      prompt = notices.length
        ? 'The original background processes have finished. Continue with their saved evidence below, not another process run.'
        : `The business task is not yet complete. Continue in this session using saved evidence and the registered tools. A final explanation alone does not accept an adapter. If a necessary fact is missing, save its concrete blocker.\n${JSON.stringify({ candidateId: state.candidateId, validationId: state.validationId })}`;
    }
    coverage = bridge.session.coverage();
    result = bridge.session.result() ?? { status: 'needs-review', stopReason: state.coordinationPending ? 'scope-change' : 'runtime-yield', coverage };
    if (state.coordinationPending) result.continuation = { action: 'replan', reasonCode: 'SCOPE_CHANGE' };
    return await finish(result);
  } catch (error) {
    error = runtimeFailure ?? relay?.failure() ?? error;
    if (!state || !ownsState) throw error;
    coverage = bridge?.session.coverage() ?? coverage;
    const cancelled = Boolean(userSignal?.aborted);
    state.error = cancelled ? undefined : clean({ code: error.code ?? 'DSH_RUNTIME_FAILED', message: String(error.message) });
    const stopped = await finish({ status: cancelled ? 'cancelled' : 'needs-review',
      stopReason: cancelled ? 'cancelled' : error.code ?? 'DSH_RUNTIME_FAILED',
      reason: cancelled ? '技术任务已取消，进度已保存' : String(error.message), ...(state.error ? { error: state.error } : {}), coverage });
    if (error.hostFailure && !cancelled) throw error;
    return stopped;
  } finally {
    const failures = [];
    for (const close of [quiesce, () => bridge?.close(), releaseLock]) {
      try { await close?.(); } catch (error) { failures.push(error); }
    }
    activeJobs.delete(jobKey);
    if (failures.length) throw new AggregateError(failures, 'DSH runtime cleanup failed');
  }
}
