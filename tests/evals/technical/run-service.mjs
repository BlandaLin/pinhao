import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { EVALUATION_SCHEMA, canonical, digest, summarizeAttempts } from './events.mjs';
import { collectArtifacts, freezeEnvironment, loadSource, planTechnicalRun, tree, within } from './io.mjs';

const now = () => new Date().toISOString();
const asManifest = rows => Object.fromEntries(rows.map(row => [row.path, row.sha256]));
export async function readCredential(input = process.stdin) {
  const raw = input.isTTY && typeof input.setRawMode === 'function';
  if (raw) input.setRawMode(true);
  const reader = readline.createInterface({ input, terminal: false, crlfDelay: Infinity });
  try {
    const line = (await reader[Symbol.asyncIterator]().next()).value;
    let value; try { value = JSON.parse(String(line ?? '')); } catch { throw new Error('Supply {"apiKey":"..."} through private stdin.'); }
    if (typeof value.apiKey !== 'string' || !value.apiKey.trim() || /\s/.test(value.apiKey)) throw new Error('A nonempty API credential is required; no fake fallback is available.');
    return value.apiKey;
  } finally { reader.close(); if (raw) input.setRawMode(false); input.pause?.(); }
}

export function isModelEndpoint(resource, options, baseUrl) {
  const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
  const base = new URL(baseUrl), method = String(options?.method ?? resource?.method ?? 'GET').toUpperCase();
  return method === 'POST' && url.origin === base.origin
    && [`${base.pathname.replace(/\/+$/, '')}/chat/completions`, `${base.pathname.replace(/\/+$/, '')}/responses`].includes(url.pathname);
}

export function readEvaluationDatabase(databasePath, projectId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const hot = JSON.parse(database.prepare('SELECT body FROM projects WHERE id=?').get(projectId).body);
    const hasResources = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_resources'").get();
    const cold = hasResources ? database.prepare('SELECT body FROM project_resources WHERE id=?').get(projectId)?.body : undefined;
    const project = { ...hot, ...(cold ? JSON.parse(cold) : {}) };
    const units = database.prepare('SELECT body FROM units WHERE project_id=? ORDER BY position').all(projectId).map(row => JSON.parse(row.body));
    const tasks = database.prepare('SELECT body FROM tasks WHERE project_id=?').all(projectId).map(row => JSON.parse(row.body));
    const builds = database.prepare('SELECT body FROM builds WHERE project_id=? ORDER BY rowid').all(projectId).map(row => JSON.parse(row.body));
    const hasAcceptance = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='acceptance_receipts'").get();
    const acceptanceReceipts = hasAcceptance ? database.prepare('SELECT body FROM acceptance_receipts WHERE project_id=? ORDER BY rowid').all(projectId).map(row => JSON.parse(row.body)) : null;
    return { project, units, tasks, builds, acceptanceReceipts };
  } finally { database.close(); }
}
const snapshot = (workspaceDir, projectId) => readEvaluationDatabase(path.join(workspaceDir, 'pinhao.sqlite'), projectId);

const projectSummary = project => ({ ...Object.fromEntries(['id', 'engine', 'status', 'stage', 'total', 'pending', 'translated', 'proofread', 'lastError', 'adaptationPending', 'adaptationDeferred', 'adaptationRequest', 'adaptationAccounting', 'adaptationProgress', 'runtime', 'publication', 'acceptance', 'lanes'].map(key => [key, project?.[key]])),
  ...(project?.textRound ? { textRound: Object.fromEntries(['id', 'phase', 'stage', 'targetCount', 'createdAt', 'committedAt'].map(key => [key, project.textRound[key]])) } : {}) });

export async function runTechnicalService(config, { apiKey, resume, adaptationProvider } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Credential is required before any project or network work.');
  const plan = await planTechnicalRun(config);
  const previous = resume ? JSON.parse(await fs.readFile(path.join(path.resolve(resume), 'episode.json'), 'utf8')) : undefined;
  if (previous && canonical(previous.configuration) !== canonical(config)) throw new Error('Resume must preserve the same model, source, budget and episode configuration.');
  if (previous && canonical(previous.freeze.sourceBefore) !== canonical(plan.sourceAndDependencies)) throw new Error('Frozen source or dependencies changed; resume is not a comparable evaluation.');
  const episodeDir = previous ? path.resolve(resume) : path.join(config.outputRoot, `${config.caseId}-${randomUUID()}`);
  if (!within(config.outputRoot, episodeDir) || within(config.gameDir, episodeDir)) throw new Error('Episode must remain under the explicit independent output root.');
  await fs.mkdir(episodeDir, { recursive: true });
  const lock = await fs.open(path.join(episodeDir, 'runner.lock'), 'wx');
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: now() }));
  const dataDir = path.join(episodeDir, 'application-data'), workspaceParent = path.join(episodeDir, 'projects'), productParent = path.join(episodeDir, 'products');
  const report = previous ?? { schema: EVALUATION_SCHEMA, runId: path.basename(episodeDir), pairId: config.pairId, caseId: config.caseId,
    evidenceTier: 'autonomy', answerIsolation: 'unisolated-development', configuration: config, episodeDir, startedAt: now(),
    route: { service: 'createService', worker: 'productWorker', defaultDisplayVerifier: true, injectedComponents: adaptationProvider ? ['adaptationProvider'] : [], preseededRecipes: false, focused: Boolean(adaptationProvider) },
    freeze: { sourceBefore: plan.sourceAndDependencies }, attempts: [], segments: [], activeElapsedMs: 0, states: [] };
  const segment = { id: randomUUID(), startedAt: now(), firstAttemptIndex: report.attempts.length, resumed: Boolean(previous) };
  report.segments.push(segment);
  for (const attempt of report.attempts) if (!attempt.settledAt && !attempt.notSentAt) {
    if (attempt.sendIntentAt || attempt.fetchStartedAt) { attempt.sendUncertain = true; attempt.status = 'interrupted-outcome-unknown'; }
    else { attempt.notSentAt = now(); attempt.status = 'recovered-before-send'; }
    attempt.settledAt = now();
  }
  const clean = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'string' ? item.split(apiKey).join('[redacted]') : item));
  const errorRecord = error => clean({ name: error?.name, code: error?.code, message: error?.message ?? String(error) });
  let saveQueue = Promise.resolve();
  const save = () => saveQueue = saveQueue.catch(() => {}).then(async () => {
    const temporary = path.join(episodeDir, 'episode.json.pending');
    await fs.writeFile(temporary, JSON.stringify(clean(report), null, 2));
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, path.join(episodeDir, 'episode.json')); break; }
      catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
  });
  let service, worker, projectId = report.projectId, workspaceDir = report.workspaceDir;
  let activeHttp = 0, gatedReason, stopReason, closing = false;
  const abort = new AbortController(), realFetch = globalThis.fetch;
  const remainingMs = config.limits.maxMinutes * 60_000 - report.activeElapsedMs;
  const deadline = Date.now() + Math.max(0, remainingMs), segmentStarted = Date.now();
  const held = signal => new Promise((resolve, reject) => {
    const cancelled = () => reject(signal.reason ?? new DOMException('Evaluation stopped', 'AbortError'));
    if (signal.aborted) cancelled(); else signal.addEventListener('abort', cancelled, { once: true });
  });
  const pendingSettlements = new Set();
  globalThis.fetch = async (resource, options = {}) => {
    if (!isModelEndpoint(resource, options, config.baseUrl)) return realFetch(resource, options);
    const signal = options.signal ?? (resource instanceof Request ? resource.signal : undefined);
    const combinedSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    const spent = report.attempts.filter(attempt => !attempt.notSentAt).length;
    if (closing || spent >= config.limits.maxHttp || Date.now() >= deadline) {
      gatedReason ??= closing ? 'runner-closing' : Date.now() >= deadline ? 'wall-time-cap' : 'http-request-cap';
      return held(combinedSignal);
    }
    // Reservation is synchronous, so concurrent nested verifiers compete for the same final slot.
    const entry = { id: randomUUID(), sequence: report.attempts.length + 1, segmentId: segment.id, reservedAt: now(), purpose: 'unattributed-wire', status: 'reserved', usage: null };
    report.attempts.push(entry);
    const directory = path.join(episodeDir, 'http', entry.id);
    let finished = false, rawResponse = '', pendingLine = '', isSse = false;
    const observe = value => {
      if (!value || typeof value !== 'object') return;
      if (value.usage) entry.usage = normalizeUsage(value.usage, { cost: value.usage.cost ?? value.usage.total_cost }) ?? null;
      if (value.id) entry.providerCompletionId = String(value.id);
      if (value.error) entry.providerError = errorRecord(value.error);
    };
    const feed = (text, final = false) => {
      rawResponse += text; pendingLine += text;
      if (!isSse) { if (final) try { observe(JSON.parse(rawResponse)); } catch {} return; }
      const lines = pendingLine.split('\n'); pendingLine = lines.pop();
      if (final && pendingLine.trim()) { lines.push(pendingLine); pendingLine = ''; }
      for (const line of lines) if (line.trim().startsWith('data:') && line.trim() !== 'data: [DONE]') {
        try { observe(JSON.parse(line.trim().slice(5).trim())); } catch { entry.unparsedEvents = (entry.unparsedEvents ?? 0) + 1; }
      }
    };
    const finish = async status => {
      if (finished) return; finished = true;
      if (entry.fetchStartedAt) activeHttp--;
      entry.status = status; entry.settledAt = now();
      await fs.writeFile(path.join(directory, 'response.txt'), clean(rawResponse));
      await save();
    };
    try {
      await save();
      await fs.mkdir(directory, { recursive: true });
      let body = typeof options.body === 'string' ? options.body : '';
      if (!body && resource instanceof Request) body = await resource.clone().text();
      let payload; try { payload = JSON.parse(body); } catch {}
      entry.inputSha256 = digest(clean(body)); entry.model = payload?.model;
      entry.purposeAttribution = 'Not inferred from prompt wording; authoritative purpose is in product accounting/request artifacts.';
      entry.requestEvidence = path.relative(episodeDir, path.join(directory, 'request.json'));
      await fs.writeFile(path.join(directory, 'request.json'), typeof payload === 'object' ? JSON.stringify(clean(payload), null, 2) : clean(body));
      combinedSignal.throwIfAborted();
      entry.sendIntentAt = now(); await save();
      entry.fetchStartedAt = now(); activeHttp++; report.actualHttpPeak = Math.max(report.actualHttpPeak ?? 0, activeHttp);
      const response = await realFetch(resource, { ...options, signal: combinedSignal });
      entry.httpStatus = response.status; entry.responseAt = now();
      entry.providerRequestId = response.headers.get('x-request-id') ?? response.headers.get('x-openrouter-request-id');
      if (!response.body) { await finish('body-absent'); return response; }
      isSse = response.headers.get('content-type')?.includes('text/event-stream');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let consumerCancelled = false;
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await reader.read(); if (consumerCancelled) return;
            if (chunk.done) { feed(decoder.decode(), true); await finish('body-complete'); controller.close(); }
            else { feed(decoder.decode(chunk.value, { stream: true })); controller.enqueue(chunk.value); }
          } catch (error) { if (!consumerCancelled) { entry.error = errorRecord(error); await finish('stream-error'); controller.error(error); } }
        },
        async cancel(reason) { consumerCancelled = true; entry.cancelReason = errorRecord(reason); await reader.cancel(reason); await finish('consumer-cancelled'); },
      });
      const observed = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
      Object.defineProperty(observed, 'url', { value: response.url });
      return observed;
    } catch (error) {
      entry.error = errorRecord(error);
      if (!entry.fetchStartedAt) entry.notSentAt = now();
      const settlement = finish(entry.fetchStartedAt ? 'fetch-error' : 'not-sent').catch(settleError => { report.settlementError = errorRecord(settleError); });
      pendingSettlements.add(settlement); await settlement; pendingSettlements.delete(settlement);
      throw error;
    }
  };
  let normalizeUsage;
  const tokens = new Map();
  const pause = async reason => {
    closing = true; report.stopReason = reason;
    if (service && projectId) {
      await service.pauseProject({ projectId });
      abort.abort(new DOMException(`Evaluation ${reason}`, 'AbortError'));
      await service.cancelProject({ projectId });
    } else abort.abort(new DOMException(`Evaluation ${reason}`, 'AbortError'));
  };
  try {
    for (const directory of [dataDir, workspaceParent, productParent]) await fs.mkdir(directory, { recursive: true });
    report.freeze.originalBefore ??= asManifest(await tree(config.gameDir));
    await save();
    ({ normalizeUsage } = await loadSource(config.sourceRoot, 'packages/core/usage.mjs'));
    const { productWorker } = await loadSource(config.sourceRoot, 'apps/desktop/electron/host.mjs');
    const { createService, defaultSettings } = await loadSource(config.sourceRoot, 'packages/core/service.mjs');
    worker = productWorker({ pythonPath: config.pythonPath, dependencyDir: config.dependencyDir,
      workerPath: path.join(config.sourceRoot, 'adapters/python/worker.py'), toolkitPath: path.join(config.sourceRoot, 'kits/workbench-tutorial/toolkit') });
    service = await createService({ dataDir, worker, adaptationProvider, adaptationLimits: { maxHttpAttempts: config.limits.maxHttp, maxWindows: config.limits.maxWindows },
      secrets: { encrypt: async value => { const token = `eval-${randomUUID()}`; tokens.set(token, value); return token; },
        decrypt: async token => { if (!tokens.has(token)) throw new Error('An isolated credential must be supplied again on resume.'); return tokens.get(token); } } });
    const settings = defaultSettings();
    settings.connection = { ...settings.connection, baseUrl: config.baseUrl, model: config.model, reasoning: config.reasoning, apiKey };
    settings.concurrency = config.concurrency; settings.proofreading = true; settings.processImages = false;
    await service.saveSettings(settings);
    const initial = projectId ? await service.getProject({ projectId }) : await service.createProject({ gameDir: config.gameDir, workspaceParent, outputDir: productParent });
    projectId = initial.id; workspaceDir = initial.workspaceDir;
    if (!within(workspaceParent, workspaceDir)) throw new Error('Product workspace escaped the episode.');
    report.projectId = projectId; report.workspaceDir = workspaceDir;
    report.initialUnitIds ??= snapshot(workspaceDir, projectId).units.map(unit => unit.id);
    report.initial ??= projectSummary(initial);
    await service.setWorkspaceExecution({ projectId, granted: true });
    await save();
    if (report.attempts.filter(attempt => !attempt.notSentAt).length >= config.limits.maxHttp || Date.now() >= deadline) stopReason = 'cumulative-budget-exhausted';
    else if (config.mode === 'adaptation') {
      if (initial.adaptationPending || initial.adaptationRequest || initial.engine === 'Unity') await service.retryAdaptation({ projectId });
      else report.noAdaptationTask = true;
    } else await service.startProject({ projectId });
    while (!stopReason && !report.noAdaptationTask) {
      const project = await service.getProject({ projectId, summaryOnly: true });
      const summary = projectSummary(project), last = report.states.at(-1);
      if (!last || canonical(last.project) !== canonical(summary) || last.http !== report.attempts.length) report.states.push({ at: now(), http: report.attempts.length, project: summary });
      if (Date.now() >= deadline) stopReason = 'wall-time-cap';
      else if (gatedReason && activeHttp === 0) stopReason = gatedReason;
      else if (['completed', 'paused', 'failed', 'cancelled'].includes(project.status) && !(project.runtime?.active > 0) && activeHttp === 0) break;
      await save();
      if (!stopReason) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (stopReason) await pause(stopReason);
    report.terminal = projectSummary(await service.getProject({ projectId }));
    report.outcome = stopReason ? 'budget-stopped' : report.noAdaptationTask ? 'no-adaptation-task' : report.terminal.status === 'completed' ? 'product-reports-completed' : 'product-stopped';
  } catch (error) { report.error = errorRecord(error); report.outcome = 'runner-or-product-error'; }
  finally {
    try {
      if (service && projectId) {
        const current = await service.getProject({ projectId });
        if (current.status === 'running') await pause(stopReason ?? 'runner-finalize');
        report.terminal = projectSummary(await service.getProject({ projectId }));
      }
    } catch (error) { report.finalPauseError = errorRecord(error); }
    try { if (service) await service.close(); if (worker) await worker.closeExecution?.(); }
    catch (error) { report.closeError = errorRecord(error); }
    abort.abort(new DOMException('Evaluation finalized', 'AbortError'));
    await Promise.allSettled([...pendingSettlements]);
    globalThis.fetch = realFetch;
    segment.finishedAt = now(); segment.elapsedMs = Date.now() - segmentStarted;
    report.activeElapsedMs += segment.elapsedMs;
    try {
      if (workspaceDir) {
        const stored = snapshot(workspaceDir, projectId);
        report.database = { projectId, initialUnitIds: report.initialUnitIds, units: stored.units,
          publication: stored.project.publication ?? null, acceptanceReceipts: stored.acceptanceReceipts,
          tasks: stored.tasks.map(task => Object.fromEntries(['id', 'projectId', 'role', 'kind', 'status', 'createdAt', 'startedAt', 'finishedAt', 'productionInput', 'reviewRoundId', 'requestHistory', 'commitSummary'].filter(key => task[key] !== undefined).map(key => [key, task[key]]))),
          provenance: { source: 'read-only SQLite projects/project_resources/tasks/acceptance_receipts', capturedAt: now(), databaseFile: path.join(workspaceDir, 'pinhao.sqlite') } };
        report.productAccounting = stored.project.adaptationAccounting ?? null;
        const collected = await collectArtifacts({ config, dataDir, workspaceDir, database: stored, build: stored.builds.at(-1) });
        Object.assign(report, collected);
        const coverage = stored.project.coverage;
        report.coverage = { remainingUnknown: coverage?.stale || coverage?.truncated ? null
          : coverage?.completeness === 'complete' && coverage?.needsAdaptation === false ? 0 : null,
          summary: coverage?.summary, triggers: coverage?.triggers, stale: coverage?.stale ?? null,
          countNote: 'Unresolved summary categories overlap; absence of an exact independent count is null, not zero.' };
        await fs.writeFile(path.join(episodeDir, 'database-evidence.json'), JSON.stringify(clean(stored), null, 2));
      }
    } catch (error) { report.collectionError = errorRecord(error); }
    try { report.freeze.sourceAfter = await freezeEnvironment(config); report.freeze.originalAfter = asManifest(await tree(config.gameDir)); }
    catch (error) { report.freezeError = errorRecord(error); }
    report.finishedAt = now();
    report.cost = summarizeAttempts(report.attempts);
    try { await save(); }
    finally { await lock.close(); await fs.unlink(path.join(episodeDir, 'runner.lock')); }
  }
  return { episodeDir, report };
}
