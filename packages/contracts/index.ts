export type Role = 'technical' | 'translation' | 'proofreading';
export type ProjectStatus = 'preparing' | 'ready' | 'running' | 'paused' | 'completed' | 'failed';
export type RunMode = 'all' | 'translation' | 'proofreading' | 'repair' | 'review-issues';
export interface ModelConnection { baseUrl: string; model: string; apiKey?: string; hasKey?: boolean; reasoning?: 'auto' | 'enabled' | 'disabled'; contextWindow?: number; maxOutputTokens?: number; }
export interface TechnicalBlockedNeed {
  requirementRef: string; kind: string; missingEvidence?: Record<string, unknown>;
  nextActions?: string[]; satisfiedBy?: string | null;
}
export interface NativeDiagnostic {
  category: 'dependency' | 'format' | 'native'; phase: string; engine: string;
  dependencyId?: string; state?: 'ready' | 'missing' | 'invalid' | 'unsupported';
  expectedVersion?: string; detail?: string;
}
export interface AssistanceCapability {
  supported: boolean; modes: ('live' | 'save')[]; detail?: string;
  status?: 'installed' | 'disabled' | 'unsupported' | 'install_failed';
}
export interface Settings {
  connection: ModelConnection;
  roles: Record<Role, { useShared: boolean; connection: ModelConnection }>;
  concurrency: number;
  pauseOnLocalFailure: boolean;
  processImages: boolean;
  proofreading: boolean;
  targetLanguage: string;
  fontPath: string;
}
export interface EngineCapability {
  id: string; name: string; extract: boolean; build: boolean; assist: boolean; detail: string;
  assistModes?: ('live' | 'save')[];
}
export interface ProjectSummary {
  id: string; name: string; gameDir: string; workspaceDir: string; engine: string;
  status: ProjectStatus; stage: string; total: number; done: number; skipped: number;
  runMode?: RunMode; translated: number; proofread: number; pending: number; needsEvidence?: number;
  createdAt: string; updatedAt: string; textVersion?: number; lastError?: string;
}
export interface TextUnit {
  id: string; legacyId: string; kind: string; source: string; translation: string;
  notes: string; tokens: string[]; context: Record<string, unknown>;
  revision: number; sourceHash: string;
  status: 'pending' | 'translated' | 'proofread' | 'skipped';
  review?: { reviewId: string; reviewedAt: string; status: 'proofread' | 'needs_evidence'; issues: { unitId: string; kind: string; message: string; resolved: boolean }[] };
}
export interface Issue {
  id: string; unitId?: string; category: string; message: string;
  severity: 'info' | 'warning' | 'error'; createdAt: string;
  resolvedAt?: string;
}
export interface Build {
  id: string; path: string; createdAt: string; changed: number;
  launchPath?: string; checks: { name: string; status: string; detail?: string }[];
  launchArgs?: string[];
  assistance?: AssistanceCapability;
  runtimeVerified?: boolean; outputModified?: boolean;
  completion?: CompletionReport;
}
export interface CompletionReport {
  summary: { total: number; translated: number; untranslated: number; skipped: number; completeness: number;
    verdict: 'complete' | 'mostly-complete' | 'partial' | 'unfinished' };
  blockers: { kind: string; count: number; samples: { id: string; source: string; where: string }[] }[];
  sections: { kind: string; total: number; untranslated: number; names: string[] }[];
  glossaryUsage: { entries: number; missing: { source: string; translation: string; category: string }[] };
  latestBuild: { id: string; createdAt: string; runtimeVerified: boolean; outputModified: boolean } | null;
}
export interface TaskRecord {
  id: string; role: Role; kind?: string; status: string; unitIds: string[]; attempts: number; error?: string;
  progress?: { receivedCharacters: number; textCharacters?: number; reasoningCharacters?: number; checkpointed: number; requested: number };
}
export interface ProjectDetail extends ProjectSummary {
  issues: Issue[]; builds: Build[]; tasks: TaskRecord[]; taskTotal?: number;
  publication?: { generation: number; status?: string; accepted?: number; integrated?: number; pendingIntegration?: number; stale?: number;
    materialReady?: boolean; lastError?: string };
  lanes?: { adaptation?: { status: string }; text?: { status: string }; build?: { status: string } };
  assistEnabled?: boolean;
  nativeDependencyFailure?: { code: string; message: string; diagnostic?: NativeDiagnostic; attemptId?: string };
  workspaceExecution?: { granted: boolean; mode: 'current-user'; grantedAt?: string };
  reviewRound?: { id: string; stage: string; status?: string; total?: number; reviewed?: number; candidates?: number; scopes?: number; completedScopes?: number; unresolved?: number;
    progress?: { total: number; reviewed: number; skipped: number }; committedAt?: string };
  adaptationPending?: boolean;
  adaptationAvailable?: boolean;
  adaptationDeferred?: boolean;
  canContinueAvailableText?: boolean;
  extractedTotal?: number;
  adaptation?: {
    status: string; attempts?: number; recipeId?: string; reused?: boolean; tool?: string; error?: string;
    phase?: string; resource?: string; workers?: number; completedJobs?: number; totalJobs?: number; elapsedMs?: number;
    processedJobs?: number; verifiedJobs?: number; pendingJobs?: number; resolvedJobs?: number;
    remainingCandidates?: number; addedUnits?: number; integratedUnits?: number;
    stopReason?: string; stopReasonCode?: string; reason?: string; retryable?: boolean; blocked?: boolean; continuationNeeded?: boolean; retryContextChanged?: boolean;
    candidateId?: string; validationId?: string; blockedNeeds?: TechnicalBlockedNeed[];
    jobs?: {
      id: string; files?: string[]; resource?: string; status: string; tool?: string; phase?: string;
      reason?: string; stopReason?: string; stopReasonCode?: string; unitCount?: number; reused?: boolean;
      candidateId?: string; validationId?: string; blockedNeeds?: TechnicalBlockedNeed[];
    }[];
  };
  glossaryProgress?: { total: number; completed: number; conflicts: number };
  coverage?: {
    unitCount: number;
    stale?: boolean; addedUnitsSinceScan?: number; truncated?: boolean;
    summary: Record<string, number> & {
      nativeReviewObjects?: number; nativeReviewResources?: number;
      nativeReviewGroups?: number; presentationItems?: number;
    };
    completeness: string; needsAdaptation: boolean; triggers: string[]; runtime?: { status: string };
  };
  assistance?: AssistanceCapability;
}
export interface TextPage {
  units: TextUnit[]; total: number;
  sceneReview?: { roundId?: string; state: 'saved' | 'changed' | 'none'; committed: boolean };
}
export interface FontPreset {
  id: 'kai' | 'song' | 'hei'; style: string; name: string;
  description: string; path: string; license: string;
  previewUrl: string; family: string;
}
export interface Snapshot { projects: ProjectSummary[]; settings: Settings; engines: EngineCapability[]; fonts?: FontPreset[]; }
export interface ImportResult { accepted: number; unchanged: number; conflicts: { id: string; baseline: string; current: string; returned: string }[]; }
export type AssistAction = 'setGold' | 'setItem' | 'setSwitch' | 'setVariable' | 'heal' | 'setLevel' | 'setExp' | 'setHp' | 'setMp' |
  'setThrough' | 'setMoveSpeed' | 'setEncounter' | 'jump' | 'transfer' | 'restoreMovement' |
  'captureRecollection' | 'applyRecollection' | 'restoreRecollection' | 'setNamedVariable';
export interface AssistNamedVariable {
  scope: 'store' | 'persistent'; store?: string; name: string;
  type: 'boolean' | 'number' | 'string'; value: boolean | number | string;
  label?: string; min?: number; max?: number; integer?: boolean;
  persistence?: 'game-save' | 'persistent' | 'volatile' | 'unknown';
}
export type RecollectionOperation =
  { type: 'switch'; id: number; value: boolean } |
  { type: 'variable'; id: number; value: number; mode?: 'min' | 'max' | 'set' } |
  { type: 'selfSwitch'; mapId: number; eventId: number; key: 'A' | 'B' | 'C' | 'D'; value: boolean } |
  { type: 'recollectionMode'; plugin: 'RecollectionMode'; switchIds: number[] };
export interface RecollectionEvidence { file: string; location: string; sourceHash: string; detail: string; }
export interface RecollectionCandidate {
  id: string; kind: 'switch' | 'variable' | 'selfSwitch' | 'plugin-display'; label: string;
  confidence: 'confirmed' | 'review'; operation: RecollectionOperation; evidence: RecollectionEvidence[];
  mapId?: number; eventId?: number; recipeId?: string; selectable?: boolean;
}
export interface RecollectionRecipe {
  id: string; label: string; kind: 'event-conditions' | 'plugin-display'; confidence: 'confirmed' | 'review';
  candidateIds: string[]; fingerprint: string; mapId?: number; evidence: RecollectionEvidence[]; blocked?: boolean;
}
export interface AssistMap { id: number; name: string; width: number; height: number; }
export interface RecollectionScan {
  schemaVersion: 1; fingerprint: string; engine: string; scannedAt: string; maps: AssistMap[];
  analysisRulesVersion?: string;
  analysisNotice?: string;
  candidates: RecollectionCandidate[]; recipes: RecollectionRecipe[];
  issues: { code: string; message: string; file?: string }[];
  analysis?: { fingerprint: string; selectedCandidateIds: string[]; summary: string; promptVersion: string; analysisRulesVersion?: string; steps?: unknown[] };
}
export interface RecollectionCapture {
  recipeId: string; gameSessionId: string;
  entries: { operation: RecollectionOperation; original: boolean | number | boolean[]; applied: boolean | number | boolean[] }[];
}
export interface RecollectionBackup {
  id: string; recipeIds: string[]; labels: string[]; fingerprint: string; createdAt: string;
  status: 'captured' | 'applied' | 'restored' | 'failed'; capture: RecollectionCapture;
  error?: string; restoredAt?: string;
}
export interface AssistCommandParams {
  dx?: number; dy?: number; mapId?: number; x?: number; y?: number; direction?: number;
  recipeId?: string; operations?: RecollectionOperation[]; backup?: RecollectionCapture;
  gameSessionId?: string;
  scope?: 'store' | 'persistent'; store?: string; name?: string;
}
export interface AssistState {
  connected: boolean; ready?: boolean; gold?: number;
  engine?: string; mode?: 'live' | 'save'; actions?: AssistAction[];
  detail?: string;
  catalogComplete?: boolean; truncated?: boolean; limitReason?: string;
  changed?: boolean; backupCreated?: boolean;
  saveFile?: { path: string; sha256: string; backupPath?: string; backupDir?: string };
  limits?: { gold?: { min: number; max: number; integer: boolean } };
  editLimits?: { hp?: { min: number; max: number; integer: boolean }; mp?: { min: number; max: number; integer: boolean } };
  gameSessionId?: string;
  movement?: { through: boolean; moveSpeed: number; encounterEnabled: boolean; mapId: number; mapName: string; x: number; y: number; direction: number; canTransfer: boolean; modified?: boolean };
  recollectionBackup?: RecollectionCapture;
  recollectionResult?: { action?: string; recipeId?: string; restored?: number; skipped?: number; applied?: number };
  items?: { id: number; type: 'item' | 'weapon' | 'armor'; name: string; count: number; min?: number; max?: number; integer?: boolean }[];
  switches?: { id: number; name: string; value: boolean }[];
  variables?: { id: number; name: string; value: string | number | boolean; min?: number; max?: number; integer?: boolean }[];
  namedVariables?: AssistNamedVariable[];
  actors?: { id: number; name: string; hp: number; mp: number; level: number; exp?: number; maxHp?: number; maxMp?: number; maxLevel?: number }[];
}
export interface AssistSaveBackups {
  saveFile?: { path: string; sha256: string };
  backups: { id: string; filePath?: string; createdAt?: string; bytes?: number; sha256?: string;
    status: 'available' | 'unavailable'; error?: string; currentSha256?: string; targetAbsent?: boolean }[];
}
export interface DesktopApi {
  snapshot(): Promise<Snapshot>;
  createProject(input: { gameDir: string; name?: string; outputDir?: string; workspaceParent?: string }): Promise<ProjectDetail>;
  beginProject(input: { gameDir: string; name?: string; outputDir?: string; workspaceParent?: string }): Promise<ProjectDetail>;
  reconnectProject(input: { workspaceDir: string }): Promise<ProjectDetail>;
  getProject(input: { projectId: string; summaryOnly?: boolean }): Promise<ProjectDetail>;
  listText(input: { projectId: string; offset?: number; limit?: number; search?: string; filter?: string; reviewRoundId?: string }): Promise<TextPage>;
  saveSettings(input: Settings): Promise<Settings>;
  testConnection(input: { role?: Role | 'shared' }): Promise<{ ok: boolean; message: string; statusCode?: number; category?: string; retryAfterMs?: number }>;
  startProject(input: { projectId: string; mode?: RunMode }): Promise<ProjectDetail>;
  continueAvailableText(input: { projectId: string; mode?: RunMode }): Promise<ProjectDetail>;
  retryAdaptation(input: { projectId: string }): Promise<ProjectDetail>;
  setWorkspaceExecution(input: { projectId: string; granted: boolean }): Promise<ProjectDetail>;
  pauseProject(input: { projectId: string }): Promise<ProjectDetail>;
  cancelProject(input: { projectId: string }): Promise<ProjectDetail>;
  deleteProject(input: { projectId: string; removeWorkspace?: boolean }): Promise<{ deleted: true; retainedPaths: string[] }>;
  saveText(input: { projectId: string; unitId: string; translation: string; notes?: string; expectedRevision: number; action?: 'save' | 'confirm' }): Promise<TextUnit>;
  exportPackage(input: { projectId: string; filePath: string; profile?: 'json' | 'text'; taskStage?: 'translation' | 'proofreading' }): Promise<{ path: string }>;
  importPackage(input: { projectId: string; filePath: string }): Promise<ImportResult>;
  buildProject(input: { projectId: string; outputDir?: string; outputParent?: string }): Promise<Build>;
  completionReport(input: { projectId: string }): Promise<{ report: CompletionReport; text: string }>;
  exportRelease(input: { projectId: string; filePath: string; buildId?: string; target?: 'windows' | 'joiplay' }): Promise<{ path: string; warnings?: string[] }>;
  cleanupProject(input: { projectId: string }): Promise<{ removed: number; retained: number; freedBytes: number }>;
  chooseDirectory(input?: { title?: string }): Promise<string | null>;
  resolveDroppedGame?(file: File): Promise<{ gameDir: string }>;
  chooseFile(input?: { title?: string; kind?: 'package' | 'font' }): Promise<string | null>;
  chooseSaveFile(input?: { title?: string; defaultPath?: string; kind?: 'zip' | 'rga' }): Promise<string | null>;
  openPath(input: { path: string }): Promise<void>;
  setAppearance?(input: { theme: 'light' | 'dark' | 'system' }): Promise<void>;
  revealPath(input: { path: string }): Promise<void>;
  launchGame(input: { projectId: string; buildId?: string }): Promise<void>;
  assistSnapshot(input: { projectId: string; mode?: 'live' | 'save' }): Promise<AssistState>;
  openAssistSave(input: { projectId: string }): Promise<AssistState | null>;
  listAssistSaveBackups(input: { projectId: string }): Promise<AssistSaveBackups>;
  restoreAssistSave(input: { projectId: string; backupId: string; expectedSaveSha256?: string; expectedAbsent?: boolean }): Promise<AssistState>;
  configureAssist(input: { projectId: string; enabled: boolean }): Promise<ProjectDetail>;
  assistCommand(input: { projectId: string; mode?: 'live' | 'save'; expectedSaveSha256?: string; action: AssistAction; id?: number; type?: string; value?: number | string | boolean; params?: AssistCommandParams }): Promise<AssistState>;
  scanRecollection(input: { projectId: string; analyze?: boolean }): Promise<RecollectionScan>;
  getRecollection(input: { projectId: string }): Promise<{ scan: RecollectionScan | null; backups: RecollectionBackup[] }>;
  applyRecollection(input: { projectId: string; recipeIds: string[]; gameSessionId?: string }): Promise<{ state: AssistState; backup: RecollectionBackup }>;
  restoreRecollection(input: { projectId: string; backupId: string }): Promise<{ state: AssistState; backup: RecollectionBackup }>;
  onChanged?(callback: () => void): () => void;
}
