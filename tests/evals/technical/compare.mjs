import { canonical } from './events.mjs';
import { gradeTechnicalRun } from './grade.mjs';

const settings = run => {
  const config = run.configuration ?? {};
  return Object.fromEntries(['baseUrl', 'model', 'reasoning', 'concurrency', 'mode', 'limits'].map(key => [key, config[key]]));
};
const dependencies = run => Object.fromEntries(Object.entries(run.freeze?.sourceBefore ?? {})
  .filter(([key]) => key.startsWith('dependencies/') || key.startsWith('evaluator/') || ['source/package-lock.json', 'pythonExecutable', 'nodeExecutable'].includes(key)));

export function compareTechnicalRuns(before, after, { expectations } = {}) {
  const beforeGrade = gradeTechnicalRun(before, { expectations }), afterGrade = gradeTechnicalRun(after, { expectations });
  const reasons = [];
  if (!beforeGrade.eligible || !afterGrade.eligible) reasons.push('ineligible-evidence');
  if (!before.pairId || before.pairId !== after.pairId || before.caseId !== after.caseId) reasons.push('pair-identity-mismatch');
  if (canonical(settings(before)) !== canonical(settings(after))) reasons.push('model-or-budget-configuration-mismatch');
  if (canonical(dependencies(before)) !== canonical(dependencies(after))) reasons.push('runtime-or-lockfile-mismatch');
  if (canonical(before.freeze?.originalBefore) !== canonical(after.freeze?.originalBefore)) reasons.push('game-baseline-mismatch');
  if (!before.episodeDir || !after.episodeDir || before.episodeDir === after.episodeDir) reasons.push('not-independent-episodes');
  if (before.answerIsolation !== after.answerIsolation) reasons.push('answer-isolation-mismatch');
  const deliveryImproved = afterGrade.reviewedIntegratedUnitCount > beforeGrade.reviewedIntegratedUnitCount
    || afterGrade.legalResolutionCount > beforeGrade.legalResolutionCount;
  const costComplete = beforeGrade.cost.unknownCostRequests === 0 && afterGrade.cost.unknownCostRequests === 0;
  return {
    schema: 'pinhao-technical-eval-comparison-1', pairId: before.pairId, caseId: before.caseId,
    comparable: reasons.length === 0, reasons, before: beforeGrade, after: afterGrade,
    conclusion: reasons.length ? 'not-comparable' : deliveryImproved && afterGrade.falsePositiveCount <= beforeGrade.falsePositiveCount
      ? 'observed-delivery-gain-in-this-pair' : afterGrade.cost.actualOrUncertainHttpAttempts < beforeGrade.cost.actualOrUncertainHttpAttempts
        ? 'lower-spend-or-earlier-stop-without-proven-delivery-gain' : 'no-proven-delivery-gain',
    costComplete, reliableSuccessRateEstablished: false,
    caveat: 'All failed, paused and evidence-incomplete episodes remain reported. One pair is a pilot, not a reliability estimate; earlier stopping alone is not delivery improvement.',
  };
}
