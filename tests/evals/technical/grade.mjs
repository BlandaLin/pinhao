import { EVALUATION_SCHEMA, REQUIRED_GATES, artifactRecord, canonical, digest, locationKey, summarizeAttempts } from './events.mjs';
import { gradeFixtureRuntime, gradeDeliveryPipeline } from './runtime-grader.mjs';

const same = (left, right) => canonical(left) === canonical(right);
const nonempty = value => value && typeof value === 'object' && Object.keys(value).length > 0;

function milestone(evidence, records, reached, observedAt, observedTiming = 'poll-observed-upper-bound') {
  if (!reached) return null;
  const times = records.map(record => record?.createdAt ?? record?.finishedAt ?? record?.at).filter(value => Number.isFinite(Date.parse(value))).sort();
  const at = observedAt ?? times[0] ?? null;
  const cost = at ? summarizeAttempts((evidence.attempts ?? []).filter(attempt => Date.parse(attempt.fetchStartedAt ?? attempt.sendIntentAt) <= Date.parse(at))) : null;
  return { at, timing: observedAt ? observedTiming : at ? 'host-artifact-time' : 'timestamp-unavailable',
    calendarElapsedMs: at && Number.isFinite(Date.parse(evidence.startedAt)) ? Date.parse(at) - Date.parse(evidence.startedAt) : null,
    sdkSteps: null, actualOrUncertainHttpAttempts: cost?.actualOrUncertainHttpAttempts ?? null,
    knownCostTotal: cost?.knownCostTotal ?? null, unknownCostRequests: cost?.unknownCostRequests ?? null };
}

export function gradeTechnicalRun(evidence, { expectations } = {}) {
  const reasons = [], artifacts = evidence?.artifacts ?? {};
  const records = kind => [...new Map((artifacts[kind] ?? []).map(artifact => {
    const record = artifactRecord(artifact), id = kind === 'candidates' ? record?.candidateId : kind === 'validations' ? record?.validationId
      : kind === 'recipes' ? record?.recipeId : kind === 'resolutions' ? record?.id : artifact.sha256;
    return [id ?? artifact.sha256, { artifact, record }];
  })).values()];
  const invalidArtifacts = Object.values(artifacts).flat().filter(artifact => !artifactRecord(artifact));
  const sourceFrozen = nonempty(evidence?.freeze?.sourceBefore) && same(evidence.freeze.sourceBefore, evidence.freeze.sourceAfter);
  const originalUnchanged = nonempty(evidence?.freeze?.originalBefore) && same(evidence.freeze.originalBefore, evidence.freeze.originalAfter);
  const route = evidence?.route;
  const normalRoute = route?.service === 'createService' && route.worker === 'productWorker' && route.defaultDisplayVerifier === true
    && route.injectedComponents?.length === 0 && route.preseededRecipes === false && route.focused === false;
  if (evidence?.schema !== EVALUATION_SCHEMA) reasons.push('unsupported-evidence-schema');
  if (!sourceFrozen) reasons.push('source-or-dependencies-not-frozen');
  if (!originalUnchanged) reasons.push('original-integrity-not-proven');
  if (!normalRoute) reasons.push('normal-product-route-not-proven');
  if (invalidArtifacts.length) reasons.push('artifact-integrity-failed');
  if (evidence?.evidenceTier === 'contract') reasons.push('contract-is-not-autonomy');
  const eligible = reasons.length === 0;
  const candidates = records('candidates').filter(({ record }) => record?.candidateId && record.codeHash === digest(record.code ?? '')
    && record.candidateId === `candidate-${digest({ manifest: record.manifest, codeHash: record.codeHash }).slice(0, 40)}`);
  const candidateById = new Map(candidates.map(item => [item.record.candidateId, item.record]));
  const validations = records('validations').filter(({ record }) => {
    const candidate = candidateById.get(record?.candidateId), check = evidence?.freshness?.[record?.validationId];
    const units = record?.extraction?.units;
    return candidate && record.codeHash === candidate.codeHash && record.passed === true && Array.isArray(units) && units.length > 0
      && REQUIRED_GATES.every(gate => record.checks?.[gate] === 'passed')
      && record.runtime?.status !== 'failed' && nonempty(record.resourceHashes)
      && same(Object.keys(record.resourceHashes).sort(), [...candidate.manifest.scope.files].sort())
      && record.displayReview?.status === 'passed' && record.displayReview.identity?.candidate === candidate.candidateId
      && record.displayReview.identity.code === candidate.codeHash
      && record.displayReview.identity.units === digest(units.map(unit => [unit.id, unit.rawSource ?? unit.source, unit.locator ?? unit.context?.adaptationLocator]))
      && record.displayReview.decisions?.length === units.length && record.displayReview.decisions.every(item => item.status === 'display-supported')
      && same(record.displayReview.decisions.map(item => item.id).sort(), units.map(unit => unit.id).sort())
      && check?.files?.length > 0 && check.files.every(file => file.expected === file.actual)
      && Object.entries(record.resourceHashes).every(([file, expected]) => check.files.some(item => item.file === file && item.expected === expected && item.actual === expected))
      && check.roundtripFiles?.length === Object.keys(record.resourceHashes).length && check.roundtripFiles.every(file => file.expected === file.actual)
      && Object.entries(record.resourceHashes).every(([file, expected]) => check.roundtripFiles.some(item => item.file === file && item.expected === expected && item.actual === expected))
      && check.sampleFiles?.length > 0 && check.sampleFiles.some(file => file.actual && file.actual !== file.original)
      && Object.entries(record.dependencies?.listings ?? {}).every(([directory, expected]) => check.listings?.some(item => item.directory === directory && item.expected === expected && item.actual === expected))
      && check.displayFresh === true
      && check.complete === true;
  });
  const validationById = new Map(validations.map(item => [item.record.validationId, item.record]));
  const recipes = records('recipes').filter(({ record }) => {
    const candidate = candidateById.get(record?.candidateId), validation = validationById.get(record?.validationId);
    return candidate && validation && validation.candidateId === candidate.candidateId && record.codeHash === candidate.codeHash
      && record.recipeId === `recipe-${digest({ candidateId: candidate.candidateId, scope: candidate.manifest.scope }).slice(0, 40)}`;
  });
  const recipeById = new Map(recipes.map(item => [item.record.recipeId, item.record]));
  const acceptedUnits = new Map(), boundUnits = new Map();
  for (const { record: recipe } of recipes) for (const unit of validationById.get(recipe.validationId).extraction.units) {
    acceptedUnits.set(`${unit.id}:${locationKey(unit)}`, unit);
  }
  for (const { record: binding } of records('bindings')) {
    const recipe = recipeById.get(binding?.recipeId), validation = validationById.get(binding?.validationId);
    if (!recipe || !validation || binding.candidateId !== recipe.candidateId || binding.codeHash !== recipe.codeHash
      || !same(binding.resourceHashes, validation.resourceHashes)) continue;
    for (const unit of binding.units ?? []) {
      if (!(validation.extraction?.units ?? []).some(item => item.id === unit.id && locationKey(item) === locationKey(unit)
        && item.source === unit.source)) continue;
      boundUnits.set(`${unit.id}:${locationKey(unit)}`, unit);
    }
  }
  const initialIds = new Set(evidence?.database?.initialUnitIds ?? []);
  const integrated = (evidence?.database?.units ?? []).filter(unit => !initialIds.has(unit.id)
    && [...boundUnits.values()].some(raw => (unit.legacyId ?? unit.id) === (raw.legacyId ?? raw.id)
      && locationKey(unit) === locationKey(raw) && unit.source === raw.source));
  const observedDatabaseAdditions = (evidence?.database?.units ?? []).filter(unit => !initialIds.has(unit.id)).length;
  const unscoredIntegrationCount = observedDatabaseAdditions - integrated.length;
  const resolutions = records('resolutions').filter(({ artifact, record }) => {
    const fresh = evidence?.resolutionFreshness?.[record?.id];
    const independentRequired = record?.kind === 'display-candidate' || record?.disposition === 'non-linguistic';
    return fresh?.artifactSha256 === artifact.sha256 && fresh.protocolVerified === true && fresh.fresh === true
      && ['non-display', 'bound-reference', 'non-linguistic'].includes(record?.disposition)
      && (!independentRequired || record.independentReview?.status === 'non-display');
  });
  const expectedTargets = expectations?.targets;
  const integratedKeys = new Set(integrated.map(unit => `${locationKey(unit)}:${digest(unit.source)}`));
  const targetMatches = Array.isArray(expectedTargets) ? expectedTargets.filter(target => integratedKeys.has(`${canonical(target.locator)}:${target.sourceSha256}`)) : [];
  const forbiddenKeys = new Set((expectations?.forbidden ?? []).map(item => canonical(item.locator)));
  const added = [...new Map([...acceptedUnits.values(), ...integrated].map(unit => [locationKey(unit), unit])).values()];
  const falsePositives = added.filter(unit => forbiddenKeys.has(locationKey(unit)));
  const reviewedKeys = new Set([...(expectedTargets ?? []), ...(expectations?.allowedLocations ?? [])]
    .map(target => `${canonical(target.locator)}:${target.sourceSha256}`));
  const unreviewedAddedCount = added.filter(unit => !reviewedKeys.has(`${locationKey(unit)}:${digest(unit.source)}`)).length;
  const reviewedIntegrated = integrated.filter(unit => reviewedKeys.has(`${locationKey(unit)}:${digest(unit.source)}`) && !forbiddenKeys.has(locationKey(unit)));
  const remainingUnknown = evidence?.coverage?.remainingUnknown ?? null;
  const buildArtifact = artifactRecord(evidence?.build?.artifact);
  const buildPassed = eligible && evidence?.build?.reachedThroughService === true && evidence.build.partial !== true
    && buildArtifact?.outputManifest?.files?.length > 0 && evidence.build.outputFiles?.length === buildArtifact.outputManifest.files.length
    && evidence.build.outputFiles.every(file => file.expected === file.actual)
    && buildArtifact.outputManifest.files.every(file => evidence.build.outputFiles.some(item => item.file === file.path && item.expected === file.sha256 && item.actual === file.sha256))
    && ['结构与保护标记', '成品内容核验'].every(name => buildArtifact.checks?.some(check => check.name === name && check.status === 'passed'))
    && !buildArtifact.checks.some(check => check.status === 'failed');
  const fixtureRuntime = gradeFixtureRuntime(evidence?.fixtureRuntime, expectations?.runtime);
  const delivery = gradeDeliveryPipeline(evidence, { qualifiedRecipeIds: recipes.map(item => item.record.recipeId) });
  const accepted = eligible && (recipes.length > 0 || resolutions.length > 0);
  const hasIntegration = eligible && integrated.length > 0;
  const targetsComplete = Array.isArray(expectedTargets) && expectedTargets.length > 0 && targetMatches.length === expectedTargets.length;
  const resolvedOnlyComplete = expectations?.allowZeroAdded === true && resolutions.length >= (expectations.minResolutions ?? 1) && remainingUnknown === 0;
  const complete = delivery.status !== 'evidence-incomplete' && accepted && (targetsComplete || resolvedOnlyComplete) && falsePositives.length === 0 && unreviewedAddedCount === 0 && unscoredIntegrationCount === 0 && remainingUnknown === 0;
  const autonomy = !eligible ? 'evidence-incomplete' : complete ? 'passed' : accepted ? 'accepted-partial' : unscoredIntegrationCount ? 'evidence-incomplete' : 'not-achieved';
  return {
    schema: `${EVALUATION_SCHEMA}-grade`, runId: evidence?.runId, pairId: evidence?.pairId, caseId: evidence?.caseId,
    evidenceTier: evidence?.evidenceTier, answerIsolation: evidence?.answerIsolation ?? 'unisolated-development',
    eligible, reasons, autonomyStatus: autonomy,
    productIntegrationStatus: !eligible || delivery.status === 'evidence-incomplete' ? 'evidence-incomplete' : complete && buildPassed && fixtureRuntime.status === 'passed'
      ? 'fixture-product-passed' : hasIntegration ? 'integrated-partial' : resolutions.length && eligible ? 'resolved-zero-added' : unscoredIntegrationCount ? 'evidence-incomplete' : 'not-achieved',
    acceptedArtifactCount: eligible ? recipes.length : 0, validatedArtifactCount: validations.length, candidateArtifactCount: candidates.length,
    integratedUnitCount: eligible ? integrated.length : 0, reviewedIntegratedUnitCount: eligible ? reviewedIntegrated.length : 0,
    legalResolutionCount: eligible ? resolutions.length : 0,
    resolutionCountsByKind: Object.fromEntries([...new Set(resolutions.map(item => item.record.kind ?? 'legacy-cluster'))]
      .map(kind => [kind, eligible ? resolutions.filter(item => (item.record.kind ?? 'legacy-cluster') === kind).length : 0])),
    observedDatabaseAdditions, unscoredIntegrationCount,
    targetRecall: Array.isArray(expectedTargets) && expectedTargets.length ? targetMatches.length / expectedTargets.length : null,
    falsePositiveCount: falsePositives.length, unreviewedAddedCount, remainingUnknown,
    buildStatus: !evidence?.build ? 'not-reached' : buildPassed ? 'passed' : 'not-proven',
    fixtureRuntimeStatus: fixtureRuntime.status, authenticGameRuntimeStatus: 'not-run',
    delivery,
    firstMilestones: {
      candidate: milestone(evidence, candidates.map(item => item.record), candidates.length > 0),
      validation: milestone(evidence, records('validations').map(item => item.record), records('validations').length > 0),
      validated: milestone(evidence, validations.map(item => ({ ...item.record, createdAt: item.record.finishedAt })), validations.length > 0),
      acceptedOrResolved: milestone(evidence, [...recipes, ...resolutions].map(item => item.record), accepted),
      integrated: milestone(evidence, [], hasIntegration, evidence?.states?.find(state => state.project?.total > (evidence.initial?.total ?? Infinity))?.at),
      acceptedReceipt: milestone(evidence, [], delivery.acceptedBatchCount > 0, delivery.firstAcceptedAt, 'host-ledger-time'),
      hostIntegrationReceipt: milestone(evidence, [], delivery.integratedBatchCount > 0, delivery.firstIntegratedAt, 'host-ledger-time'),
    },
    logicalToolCallCount: evidence?.observer?.toolCallIds?.length ?? null,
    cost: summarizeAttempts(evidence?.attempts), terminal: evidence?.terminal ?? null,
    caveat: 'Fixture execution is not authentic gameplay. Native handoffs outside the lab chain remain unscored, not model failures. Model text, process exit 0 and earlier stopping are not delivery evidence.',
  };
}
