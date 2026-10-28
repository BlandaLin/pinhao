export interface CommandErrorRecord {
  name: string; message: string; code?: string; category?: string; statusCode?: number; retryAfterMs?: number;
  retryable?: boolean; candidateId?: string; validationId?: string; stopReasonCode?: string;
  blockedNeeds?: { requirementRef: string; kind: string; missingEvidence?: Record<string, string>; nextActions?: string[]; satisfiedBy?: string }[];
}
export function commandErrorRecord(error: unknown): CommandErrorRecord;
export function restoreCommandError(value: unknown): Error & CommandErrorRecord;
