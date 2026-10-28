import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { checkedPath, describeReadSources, readSlice } from './paths.mjs';
import { migrateControl, normalizeObservation, normalizeFailure, reduceControl, decideContinuation } from './control-state.mjs';
import { migrateWorkItems, normalizeFinding, applyWorkItemEvent, reconcileDependencies, projectWorkItems } from './work-items.mjs';
import { createDisplayFactStore, normalizeDisplaySubject } from './display-facts.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = () => new Date().toISOString();
const failed = output => Boolean(output?.error || output?.passed === false || output?.exitCode != null && output.exitCode !== 0);
const writer = name => /^write_(?:text|literal|embedded_text|python)?_?adapter$/.test(name) || name === 'patch_adapter';

/** Small occurrence receipts feed the existing snapshot, not a second task scheduler. */
export function createSessionControl({ state, project, assignment, readDir, readRoots = [], gameDir, workspaceDir, evidence, persist, budget, limits, inspectCandidate, acceptedUnitsForRecipe, sanitize = value => value, isReadOnly = () => false }) {
  state.control = migrateControl(state.control, { legacy: Boolean(state.events?.length) });
  state.workItems = migrateWorkItems(state.workItems);
  state.pendingOperations ??= {};
  state.appliedReceiptPositions ??= {};
  state.candidateItems ??= {};
  const displayFacts = project.workspaceDir ? createDisplayFactStore({ directory: path.join(project.workspaceDir, 'display-facts'), projectId: project.id }) : null;
  let queue = Promise.resolve(), roots;
  const hashes = new Map();
  const commit = action => {
    const next = queue.then(action);
    queue = next.catch(() => {});
    return next;
  };
  const origin = directory => hash([project.id, process.platform === 'win32' ? path.resolve(directory).toLowerCase() : path.resolve(directory)]);
  const resource = async (file, sourceIndex, full = true, originId) => {
    roots ??= await describeReadSources(readDir, readRoots);
    const candidates = originId ? roots.filter(row => origin(row.directory) === originId)
      : sourceIndex == null ? roots : roots.filter(row => row.sourceIndex === sourceIndex);
    for (const row of candidates) {
      try {
        const target = await checkedPath(row.directory, file), info = await stat(target);
        if (!info.isFile()) continue;
        const epoch = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`, key = `${target}:${full}`;
        let baselineHash = hashes.get(key)?.epoch === epoch ? hashes.get(key).hash : null;
        if (!baselineHash) {
          if (full) {
            const digest = createHash('sha256');
            for await (const chunk of createReadStream(target)) digest.update(chunk);
            const after = await stat(target);
            if (`${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== epoch) throw new Error('资源在读取期间改变，请重新读取');
            baselineHash = digest.digest('hex');
          } else baselineHash = hash(['listing', info.size, info.mtimeMs]);
          hashes.set(key, { epoch, hash: baselineHash });
        }
        return { originId: origin(row.directory), path: file.replaceAll('\\', '/'), baselineHash, root: 'source', sourceIndex: row.sourceIndex };
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    }
    return null;
  };
  const apply = receipt => {
    if ((state.appliedReceiptPositions[receipt.namespaceId] ?? 0) >= receipt.seq) return;
    const events = receipt.hostEventPayload?.events ?? [];
    for (const event of events) {
      const fact = { ...event, receiptId: receipt.receiptId, at: receipt.occurredAt };
      state.control = reduceControl(state.control, fact);
      state.workItems = applyWorkItemEvent(state.workItems, fact);
      if (fact.type === 'candidate_written' && fact.itemId && fact.candidateId) {
        state.candidateItems[fact.candidateId] = [...new Set([...(state.candidateItems[fact.candidateId] ?? []), fact.itemId])];
      }
    }
    if (receipt.phase === 'started') state.pendingOperations[receipt.operationId] = { tool: receipt.tool, receiptId: receipt.receiptId, namespaceId: receipt.namespaceId, status: 'pending-reconciliation' };
    else delete state.pendingOperations[receipt.operationId];
    for (const event of events) if (event.type === 'interrupted_read_resolved') delete state.pendingOperations[event.operationId];
    state.appliedReceiptPositions[receipt.namespaceId] = receipt.seq;
  };
  const record = async record => {
    if (!record.inputEvidenceId) {
      record.inputEvidenceId = (await evidence.save({ host: record.tool, operationId: record.operationId })).evidenceId;
      const started = await evidence.recordReceipt({ operationId: record.operationId, tool: record.tool, phase: 'started', inputEvidenceId: record.inputEvidenceId, occurredAt: stamp() });
      apply(started);
    }
    const receipt = await evidence.recordReceipt({ occurredAt: stamp(), ...record });
    apply(receipt);
    // The durable start receipt is the intent journal; do not duplicate a full snapshot per read.
    if (record.phase !== 'started') await persist(state);
    return receipt;
  };
  const owner = () => ({ ownerId: assignment?.ownerId ?? assignment?.id ?? null, assignmentRevision: assignment?.assignmentRevision ?? 0 });
  const itemFor = (ref, details = {}) => normalizeFinding({ resource: ref, ...details },
    { projectId: project.id, owner: owner(), sequence: state.control.logicalSteps, at: stamp() });
  const workEvents = async (tool, input, output, operation) => {
    const events = [], refs = [], itemIds = [], items = [];
    const savedCandidate = writer(tool) && output?.candidateId && inspectCandidate ? await inspectCandidate(output.candidateId) : null;
    const files = [...new Set([...(tool === 'read_resource' ? [input.file] : []), ...(input.manifest?.scope?.files ?? []), input.manifest?.container?.file,
      ...(savedCandidate?.manifest?.container ? [savedCandidate.manifest.container.file] : savedCandidate?.manifest?.scope?.files ?? []),
      ...(input.selections ?? []).map(row => row.file)].filter(Boolean))];
    for (const id of input.itemIds ?? []) if (state.workItems[id]) itemIds.push(id);
    for (const file of files) {
      const ref = input.root === 'work' ? null : await resource(file, output?.sourceIndex ?? input.sourceIndex);
      if (!ref) continue;
      if (tool === 'read_resource' && !failed(output) && typeof output?.content === 'string' && Number.isSafeInteger(output.returnedBytes)) {
        const observed = await readSlice(roots[ref.sourceIndex].directory, file,
          { offset: output.offset ?? 0, length: Math.max(1, output.returnedBytes), encoding: output.encoding ?? input.encoding ?? 'utf8' });
        if (observed.returnedBytes !== output.returnedBytes || sanitize(observed.content) !== output.content) throw Object.assign(new Error('读取结果与当前来源不一致，请重新读取'), { code: 'RESOURCE_CHANGED' });
        if (observed.content !== output.content) ref.sourceRangeMappable = false;
      }
      refs.push(ref);
      if (assignment?.files && !assignment.files.includes(ref.path)) continue;
      const selected = (input.selections ?? []).filter(row => row.file === file);
      for (const selection of selected.length ? selected : [null]) {
        const finding = itemFor(ref, selection ? { claimKind: 'display-text', locator: selection.pointer ? { file, pointer: selection.pointer } : null,
          claim: selection.reason, selection } : {});
        items.push(finding); itemIds.push(finding.itemId);
        events.push({ type: 'finding_recorded', finding });
      }
    }
    const attached = output?.candidateId && state.candidateItems[output.candidateId] || input.candidateId && state.candidateItems[input.candidateId];
    for (const id of attached ?? []) if (!itemIds.includes(id)) itemIds.push(id);
    const itemEvents = (type, details) => {
      for (const itemId of itemIds) events.push({ type, itemId, sourceEpoch: (items.find(item => item.itemId === itemId) ?? state.workItems[itemId])?.sourceEpoch, ...details });
    };
    if (writer(tool) && output?.candidateId && !failed(output)) {
      state.candidateItems[output.candidateId] = itemIds;
      itemEvents('candidate_written', { candidateId: output.candidateId, targetItemIds: itemIds });
    }
    if (tool === 'validate_adapter') itemEvents('validation_completed', { candidateId: input.candidateId,
      validationId: output?.validationId, checks: output?.checks, passed: output?.passed === true, fresh: true });
    if (tool === 'submit_recipe' && output?.accepted === true) {
      const units = acceptedUnitsForRecipe?.(output.recipeId);
      if (units) {
        for (const unit of units) for (const itemId of itemIds) {
          const item = state.workItems[itemId], locator = unit.locator ?? unit.context?.adaptationLocator;
          if (!item || item.resource.path !== (locator?.file ?? unit.context?.file)) continue;
          if (!item.locator) {
            if (output.taskComplete !== true) continue;
          } else {
            const position = item.locator;
            if (position.pointer !== undefined && position.pointer !== locator?.pointer
                || position.byteStart !== undefined && (position.byteStart !== locator?.byteStart || position.byteEnd !== locator?.byteEnd)
                || position.nativePath !== undefined && hash(position.nativePath) !== hash(locator?.nativePath)
                || item.selection?.text && item.selection.text !== (unit.rawSource ?? unit.source)) continue;
          }
          events.push({ type: 'recipe_accepted', itemId, sourceEpoch: item.sourceEpoch, recipeId: output.recipeId,
            acceptedBatchId: output.acceptedBatchId, extractionReceiptId: output.extractionReceiptId,
            candidateId: input.candidateId, passed: true, fresh: true, key: hash([project.id, item.sourceEpoch, locator, unit.source]) });
        }
      } else itemEvents('recipe_accepted', { candidateId: input.candidateId, recipeId: output.recipeId, acceptedBatchId: output.acceptedBatchId,
        extractionReceiptId: output.extractionReceiptId, passed: true, fresh: true });
    }
    if (tool === 'record_coverage_decisions' && output?.accepted === true && Array.isArray(output.decisions)) {
      for (const decision of output.decisions.filter(row => row.disposition !== 'display')) {
        const details = { type: 'coverage_resolved', key: hash([project.id, decision.id, decision.evidenceHash, decision.disposition]),
          resolution: decision.disposition, passed: true, fresh: true };
        events.push(details);
        for (const item of Object.values(state.workItems)) if (item.resource.path === decision.file
          && (!decision.sourceHash || item.resource.baselineHash === decision.sourceHash)
          && (decision.kind === 'resource-file' && !item.locator || item.selection?.candidateId === decision.id)) {
          events.push({ ...details, itemId: item.itemId, sourceEpoch: item.sourceEpoch });
        }
      }
    } else if (tool === 'run_tool' && (output?.nativeReviewReceiptId || output?.acceptedNativeResultId) && !failed(output)) {
      events.push({ type: 'coverage_resolved', key: hash([tool, output.nativeReviewReceiptId, output.acceptedNativeResultId]), passed: true, fresh: true });
    }
    if (tool === 'list_files' || tool === 'search_files') {
      for (const row of output?.files ?? output?.items ?? []) {
        const file = row.file ?? row.path;
        if (!file || input.root === 'work') continue;
        const ref = await resource(file, row.sourceIndex ?? input.sourceIndex, false);
        if (ref) refs.push(ref);
      }
    }
    const observation = normalizeObservation({ tool, input, output, resourceRefs: refs, itemIds });
    // Captured data is not yet model-visible; only actual-send presentation records earn reading credit.
    observation.facts = [];
    events.push({ type: 'observation_recorded', observation });
    if (failed(output)) {
      const failures = itemIds.length ? itemIds.map(id => ({ itemId: id, ref: items.find(item => item.itemId === id)?.resource ?? state.workItems[id]?.resource })) : [{ ref: refs[0] }];
      const checks = Object.entries(output?.checks ?? {}).filter(([, value]) => value === false || value === 'failed').map(([key]) => key);
      for (const { itemId, ref } of failures) for (const checkId of checks.length ? checks : [undefined]) events.push({ type: 'tool_failed', itemId,
        sourceEpoch: ref?.baselineHash, failure: normalizeFailure({ tool, input, output, itemId, resourceRef: ref, sourceEpoch: ref?.baselineHash, checkId }) });
    }
    if (!failed(output)) {
      const causeKeys = Object.entries(state.control.failuresByCause).filter(([, failure]) => {
        if (failure.resolvedByReceiptId || failure.tool !== tool) return false;
        if (tool === 'read_resource' && refs.length) return failure.resourceRef
          ? refs.some(ref => ref.originId === failure.resourceRef.originId && ref.path === failure.resourceRef.path && ref.baselineHash === failure.resourceRef.baselineHash)
          : failure.target?.root === (input.root ?? 'source') && failure.target?.path === input.file
            && (failure.target.sourceIndex == null || failure.target.sourceIndex === (output.sourceIndex ?? input.sourceIndex ?? 0));
        return tool === 'validate_adapter' && itemIds.includes(failure.itemId)
          && failure.sourceEpoch === state.workItems[failure.itemId]?.sourceEpoch
          && (failure.checkId ? [true, 'passed'].includes(output?.checks?.[failure.checkId]) : output?.passed === true);
      }).map(([key]) => key);
      if (causeKeys.length) events.push({ type: 'failure_resolved', causeKeys });
    }
    return { events, resourceRefs: refs, itemIds, operationId: operation.operationId };
  };
  return {
    async restore() {
      const head = await evidence.readReceipts({ afterSeq: 0, limit: 1 });
      let afterSeq = state.appliedReceiptPositions[head.namespaceId] ?? 0;
      // Each namespace owns its own cursor; never take a maximum across different journals.
      for (;;) {
        const page = await evidence.readReceipts({ afterSeq, limit: 100 });
        if (!page.records.length) break;
        for (const receipt of page.records) { apply(receipt); afterSeq = receipt.seq; }
        if (!page.nextSeq) break;
      }
      for (const [operationId, pending] of Object.entries(state.pendingOperations)) {
        pending.status = 'pending-reconciliation';
        if (isReadOnly(pending.tool) || pending.tool === 'host-control') {
          if (pending.namespaceId && pending.namespaceId !== head.namespaceId) {
            await record({ operationId: `recovery:${operationId}`, tool: 'host-control', phase: 'completed',
              hostEventPayload: { events: [{ type: 'interrupted_read_resolved', operationId, originalReceiptId: pending.receiptId }] } });
            continue;
          }
          const started = await evidence.resolveReceipt(pending.receiptId);
          const output = await evidence.save({ interruptedRead: true, notReexecuted: true });
          await record({ operationId, tool: started.tool, toolCallId: started.toolCallId, phase: 'cancelled',
            inputEvidenceId: started.inputEvidenceId, outputEvidenceId: output.evidenceId });
        }
      }
      const refs = []; let environmentChanged = false;
      for (const item of Object.values(state.workItems)) {
        for (const previous of [item.resource, ...(item.dependencies ?? [])]) {
          const current = await resource(previous.path, previous.sourceIndex, true, previous.originId);
          environmentChanged ||= !current || current.baselineHash !== previous.baselineHash;
          refs.push(current ?? { ...previous, missing: true });
        }
      }
      state.workItems = reconcileDependencies(state.workItems, refs);
      await persist(state);
      return { environmentRevision: hash(refs.map(ref => [ref.originId, ref.path, ref.baselineHash, Boolean(ref.missing)]).sort()), environmentChanged };
    },
    begin(tool, input, options = {}) {
      return commit(async () => {
        const inputReceipt = await evidence.save(input, { tool, source: 'tool-input' });
        const operationId = options.operationId ?? `${state.id}:${state.executionWindow}:${state.modelStep?.number ?? 0}:${options.toolCallId ?? randomUUID()}`;
        const receipt = await record({ operationId, tool, toolCallId: options.toolCallId, phase: 'started', inputEvidenceId: inputReceipt.evidenceId });
        state.pendingOperations[operationId].status = 'running';
        return { operationId, tool, inputEvidenceId: inputReceipt.evidenceId, receiptId: receipt.receiptId };
      });
    },
    finish(operation, input, output, outputEvidenceId, phase = 'completed') {
      return commit(async () => {
        const details = await workEvents(operation.tool, input, output, operation);
        return record({ ...operation, phase, outputEvidenceId, resourceRefs: details.resourceRefs, itemIds: details.itemIds,
          ...(output?.runId ? { run: { runId: output.runId } } : {}), hostEventPayload: { events: details.events } });
      });
    },
    async step() { return commit(() => record({ operationId: `step:${state.id}:${state.executionWindow}:${state.control.logicalSteps + 1}`,
      tool: 'host-control', phase: 'completed', hostEventPayload: { events: [{ type: 'step_completed' }] } })); },
    decision({ complete = false, cancelled = false } = {}) {
      const snapshot = budget?.snapshot();
      return decideContinuation(state.control, { complete, cancelled, limits,
        budget: snapshot ? { allowed: snapshot.canReserveHttp, remainingHttp: snapshot.remainingHttpAttempts } : undefined,
        pendingOperations: state.pendingOperations, readyItemIds: projectWorkItems(state.workItems).readyItemIds });
    },
    async review(decision) { return commit(() => record({ operationId: `review:${state.id}:${decision.recoveryAllowanceId}`, tool: 'host-control', phase: 'completed',
      hostEventPayload: { events: [{ type: 'control_reviewed', ...decision }] } })); },
    async modelFailure(error, connectionFingerprint) {
      const failure = normalizeFailure({ tool: 'model-request', input: { connectionFingerprint }, error,
        sourceEpoch: hash([project.id, assignment?.id ?? null, assignment?.files ?? null]), checkId: hash([connectionFingerprint, error.status, error.causeCode, error.phase]) });
      return commit(() => record({ operationId: `model-failure:${randomUUID()}`, tool: 'host-control', phase: 'completed',
        hostEventPayload: { events: [{ type: 'tool_failed', failure }, { type: 'step_completed' }] } }));
    },
    async modelPresented({ modelRequestId, messages }) {
      if (!modelRequestId || !Array.isArray(messages)) throw new Error('Model presentation requires the actual request identity and messages');
      const views = [];
      const parse = value => {
        if (typeof value === 'string') { try { return parse(JSON.parse(value)); } catch { return; } }
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { for (const item of value) parse(item); return; }
        if (value.evidenceId && (value.receiptId || value.occurrenceId)) views.push(value);
        else if (value.output) parse(value.output);
        else if (value.value) parse(value.value);
        else if (value.text) parse(value.text);
      };
      for (const message of messages) if (message.role === 'tool') parse(message.content);
      const observations = [];
      for (const view of views) {
        let receipt;
        try { receipt = await evidence.resolveReceipt(view.occurrenceId ?? view.receiptId); }
        catch { continue; }
        if (receipt.phase !== 'completed' || !['read_resource', 'list_files', 'search_files'].includes(receipt.tool)
            || receipt.outputEvidenceId !== view.evidenceId) continue;
        const [saved, originalInput] = await Promise.all([evidence.load(view.evidenceId), evidence.load(receipt.inputEvidenceId)]);
        const raw = saved.value, input = originalInput.value, refs = receipt.resourceRefs ?? [];
        let output;
        if (receipt.tool === 'read_resource' && typeof view.content === 'string' && typeof raw.content === 'string') {
          const start = view.view?.offset ?? (view.pointer === '/content' ? view.offset ?? 0 : 0);
          if (!Number.isSafeInteger(start) || start < 0 || raw.content.slice(start, start + view.content.length) !== view.content) continue;
          if (/^[\uDC00-\uDFFF]/.test(view.content) || /[\uD800-\uDBFF]$/.test(view.content)) continue;
          if ((raw.encoding ?? input.encoding ?? 'utf8') !== 'utf8') continue;
          if (refs.some(ref => ref.sourceRangeMappable === false)) {
            const ref = refs[0];
            observations.push({ tool: receipt.tool, itemIds: receipt.itemIds ?? [], facts: view.content.length ? [{ kind: 'presented-view-range',
              key: hash([ref.originId, ref.path, ref.baselineHash, view.evidenceId, '/content']), start, end: start + view.content.length }] : [] });
            continue;
          }
          output = { ...raw, content: view.content, offset: (raw.offset ?? input.offset ?? 0) + Buffer.byteLength(raw.content.slice(0, start)), returnedBytes: Buffer.byteLength(view.content) };
        } else if (receipt.tool !== 'read_resource') {
          const key = Array.isArray(raw.files) ? 'files' : 'items', full = raw[key] ?? [];
          const shown = Array.isArray(view[key]) ? view[key] : view.pointer === `/${key}` && Array.isArray(view.items) ? view.items : [];
          output = { [key]: shown.filter(row => full.some(value => hash(value) === hash(row))) };
        } else continue;
        observations.push(normalizeObservation({ tool: receipt.tool, input, output, resourceRefs: refs, itemIds: receipt.itemIds ?? [] }));
      }
      if (!observations.length) return { observations: 0 };
      return commit(() => record({ operationId: `model-presented:${modelRequestId}:${hash(observations)}`, tool: 'host-control', phase: 'completed',
        hostEventPayload: { events: observations.map(observation => ({ type: 'model_presented', modelRequestId, observation })) } }));
    },
    projection(options) { return projectWorkItems(state.workItems, options); },
    workingSet({ limit = 12, maxCharacters = 8000 } = {}) {
      const page = projectWorkItems(state.workItems, { limit: 100 });
      const informative = page.items.filter(item => item.claim || item.blockers?.length || item.artifacts?.candidateIds?.length);
      const items = []; let characters = 0;
      for (const item of informative) {
        const view = { itemId: item.itemId, file: item.resource.path, sourceIndex: item.resource.sourceIndex, locator: item.locator,
          status: item.status, claim: item.claim?.slice(0, 400), nextAction: item.proposedNextAction,
          blockers: item.blockers?.slice(0, 3).map(blocker => ({ code: blocker.code, message: blocker.message?.slice(0, 200) })),
          candidateIds: item.artifacts?.candidateIds?.slice(-2), validationIds: item.artifacts?.validationIds?.slice(-1),
          readiness: item.readiness, ...(item.consumerEvidenceRefs?.length ? { consumerEvidenceRefs: item.consumerEvidenceRefs.slice(-2) } : {}) };
        const size = JSON.stringify(view).length;
        if (items.length >= limit || characters + size > maxCharacters) break;
        items.push(view); characters += size;
      }
      return { total: page.total, items, omitted: page.total - items.length,
        details: { tool: 'manage_work_items', input: { action: 'list', limit: 12 } } };
    },
    async recordFinding(finding, operationRefs = []) {
      const ref = await resource(finding.file ?? finding.resource?.path, finding.sourceIndex);
      if (!ref) throw new Error('发现记录需要实际存在的来源文件');
      const expected = finding.resource?.baselineHash ?? finding.sourceRef?.baselineHash ?? finding.sourceHash;
      if (expected && expected !== ref.baselineHash) throw Object.assign(new Error('发现工件对应的源文件已改变'), { code: 'FINDING_SOURCE_CHANGED' });
      let locatorVerified = false, rawSource;
      if (typeof finding.locator?.pointer === 'string') {
        roots ??= await describeReadSources(readDir, readRoots);
        const text = await readFile(await checkedPath(roots[ref.sourceIndex].directory, ref.path), 'utf8');
        let value = JSON.parse(text.replace(/^\uFEFF/, ''));
        for (const key of finding.locator.pointer.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'))) value = value?.[key];
        locatorVerified = typeof value === 'string' && (!finding.selection?.text || value.includes(finding.selection.text));
        if (locatorVerified) rawSource = finding.selection?.text ?? value;
      }
      const validReceiptIds = [], dependencies = [], consumerReceipts = [];
      for (const id of [...(finding.sourceEvidenceRefs ?? []), ...(finding.consumerEvidenceRefs ?? []), ...operationRefs]) {
        try {
          const receipt = await evidence.resolveReceipt(typeof id === 'string' ? id : id.receiptId);
          if (receipt.phase !== 'completed' || receipt.tool !== 'read_resource' || !receipt.resourceRefs?.length) continue;
          const isSource = (finding.sourceEvidenceRefs ?? []).some(row => (typeof row === 'string' ? row : row.receiptId) === receipt.receiptId);
          if (isSource && !receipt.resourceRefs.some(row => row.originId === ref.originId && row.path === ref.path && row.baselineHash === ref.baselineHash)) continue;
          validReceiptIds.push(receipt.receiptId); dependencies.push(...receipt.resourceRefs);
          if ((finding.consumerEvidenceRefs ?? []).some(row => (typeof row === 'string' ? row : row.receiptId) === receipt.receiptId)) {
            for (const resourceRef of receipt.resourceRefs) consumerReceipts.push({ receiptId: receipt.receiptId, resourceRef });
          }
        } catch {}
      }
      if (finding.selection?.file && finding.selection.file !== ref.path || finding.selection?.pointer && finding.selection.pointer !== finding.locator?.pointer) throw new Error('发现定位和writer选择必须指向同一来源');
      const normalized = normalizeFinding({ ...finding, resource: ref, sourceEpoch: ref.baselineHash, dependencies,
        ownerJobId: assignment?.id }, { projectId: project.id, owner: owner(), sequence: state.control.logicalSteps, sourceVerified: locatorVerified,
        scopeAuthorized: !assignment?.files || assignment.files.includes(ref.path), validReceiptIds, at: stamp() });
      await commit(() => record({ operationId: `finding:${randomUUID()}`, tool: 'manage_work_items', phase: 'completed',
        resourceRefs: [ref], itemIds: [normalized.itemId], hostEventPayload: { events: [{ type: 'finding_recorded', finding: normalized }] } }));
      if (displayFacts && locatorVerified && normalized.sourceEvidenceRefs.length && consumerReceipts.length) {
        const { subjectKey } = normalizeDisplaySubject({ projectId: project.id, originId: ref.originId, relativeFile: ref.path,
          baselineHash: ref.baselineHash, locator: normalized.locator, rawSource,
          sourceViewKey: ref.sourceViewKey, containerRef: ref.containerRef, claimKind: normalized.claimKind });
        await displayFacts.challengeSubject({ subjectKey, evidenceRefs: consumerReceipts,
          verifyEvidence: async ({ proof, evidenceRefs }) => proof.subjectKey === subjectKey && evidenceRefs.every(row => validReceiptIds.includes(row.receiptId)) });
      }
      return normalized;
    },
    async importFindings(file, expectedHash) {
      const bytes = await readFile(await checkedPath(workspaceDir, file));
      if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error('发现工件已改变，请读取当前哈希');
      const document = JSON.parse(bytes.toString('utf8'));
      if (document.format !== 'pinhao-investigation-findings-1' || !Array.isArray(document.findings) || document.findings.length > 2000) throw new Error('发现工件格式无效');
      const output = [];
      const rejected = [];
      for (const [index, finding] of document.findings.entries()) {
        try { output.push(await this.recordFinding(finding)); }
        catch (error) { rejected.push({ index, code: error.code ?? 'INVALID_FINDING', message: String(error.message) }); }
      }
      return { imported: output.length, itemIds: output.map(item => item.itemId), rejected };
    },
    async selections(itemIds) {
      const selections = [];
      for (const id of itemIds) {
        const item = state.workItems[id];
        if (!item || item.status === 'stale' || !item.selection) throw new Error('该发现尚无可用选择，请补查原文定位或直接使用原writer参数');
        const current = await resource(item.resource.path, item.resource.sourceIndex, true, item.resource.originId);
        if (!current || current.baselineHash !== item.resource.baselineHash) throw new Error('发现的源文件已改变，请重新调查');
        selections.push(item.selection);
      }
      return selections;
    },
    checkpoint: () => commit(() => persist(state)),
    flush: () => queue,
  };
}
