const stringFields = ['name', 'code', 'category', 'candidateId', 'validationId', 'stopReasonCode'];
const safeString = (value, limit = 2000) => typeof value === 'string' ? value
  .replace(/\bsk-[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[密钥已隐藏]')
  .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [已隐藏]')
  .replace(/((?:api[_-]?key|authorization|password|access[_-]?token)["']?\s*[:=]\s*["']?)[^\s"'}&,;]+/gi, '$1[已隐藏]')
  .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[已隐藏]@')
  .replace(/([?&](?:api[_-]?key|token|secret|access_token)=)[^\s&#"']+/gi, '$1[已隐藏]')
  .slice(0, limit) : undefined;

/** Only user-facing classification and recovery facts cross the renderer boundary. */
export function commandErrorRecord(error) {
  if (typeof error === 'string') return { name: 'Error', message: safeString(error) };
  const record = { name: 'Error', message: safeString(error?.message) || '工作台操作失败，请稍后重试。' };
  for (const key of stringFields) {
    const value = safeString(error?.[key], 300);
    if (value) record[key] = value;
  }
  for (const key of ['statusCode', 'retryAfterMs']) {
    if (typeof error?.[key] === 'number' && Number.isFinite(error[key]) && error[key] >= 0) record[key] = error[key];
  }
  if (typeof error?.retryable === 'boolean') record.retryable = error.retryable;
  if (Array.isArray(error?.blockedNeeds)) record.blockedNeeds = error.blockedNeeds.slice(0, 100).map(need => ({
    requirementRef: safeString(need?.requirementRef, 300) || '', kind: safeString(need?.kind, 100) || 'UNKNOWN',
    ...(Array.isArray(need?.nextActions) ? { nextActions: need.nextActions.slice(0, 8).map(value => safeString(value, 500)).filter(Boolean) } : {}),
    ...(typeof need?.satisfiedBy === 'string' ? { satisfiedBy: safeString(need.satisfiedBy, 300) } : {}),
    ...(need?.missingEvidence && typeof need.missingEvidence === 'object' ? { missingEvidence: Object.fromEntries(
      ['format', 'status', 'unitId', 'locatorType', 'capabilityId', 'profileFamily', 'file'].flatMap(key => {
        const value = safeString(need.missingEvidence[key], 500);
        return value === undefined ? [] : [[key, value]];
      })) } : {}),
  }));
  return record;
}

export function restoreCommandError(value) {
  const record = commandErrorRecord(value);
  return Object.assign(new Error(record.message), record);
}
