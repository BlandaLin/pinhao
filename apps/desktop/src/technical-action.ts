import type { DesktopApi, ProjectDetail, TechnicalBlockedNeed } from '../../../packages/contracts/index';

export function technicalNeeds(project: ProjectDetail) {
  const adaptation = project.adaptation;
  const rows: { jobId?: string; resource?: string; candidateId?: string; validationId?: string; need: TechnicalBlockedNeed }[] = [];
  for (const job of adaptation?.jobs ?? []) for (const need of job.blockedNeeds ?? []) {
    if (!need.satisfiedBy) rows.push({ jobId: job.id, resource: job.resource ?? job.files?.join('、'), candidateId: job.candidateId,
      validationId: job.validationId, need });
  }
  const represented = new Set(rows.map(row => row.need.requirementRef));
  for (const need of adaptation?.blockedNeeds ?? []) if (!need.satisfiedBy && !represented.has(need.requirementRef)) {
    rows.push({ candidateId: adaptation?.candidateId, validationId: adaptation?.validationId, need });
    represented.add(need.requirementRef);
  }
  return rows;
}

export function primaryProjectAction(project: ProjectDetail): 'start' | 'retry-adaptation' | 'settings' | 'blocked' {
  if (!project.adaptationPending) return 'start';
  const adaptation = project.adaptation;
  if (adaptation?.retryContextChanged || !(adaptation?.blocked || adaptation?.retryable === false && !adaptation.continuationNeeded)) return 'retry-adaptation';
  const code = adaptation.stopReasonCode ?? adaptation.stopReason ?? '';
  if (technicalNeeds(project).length || code === 'HOST_VERIFICATION_BLOCKED') return 'blocked';
  return /^(?:MODEL_CAPACITY_REQUIRED|MODEL_CONFIG_INVALID|AUTHENTICATION_FAILED|MODEL_NOT_FOUND|HTTP_40[1345])$/.test(code) ? 'settings' : 'blocked';
}

/** Explicit extraction never takes the separate "continue existing text" route. */
export function requestProjectWork(api: Pick<DesktopApi, 'retryAdaptation' | 'startProject'>, project: ProjectDetail) {
  return project.adaptationPending ? api.retryAdaptation({ projectId: project.id }) : api.startProject({ projectId: project.id });
}
