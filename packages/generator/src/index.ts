export {
  generateLab,
  type GenerateLabConfig,
  type GenerateLabResult,
} from './generateLab.js';
export {
  generateLabPass1,
  type GenerateLabPass1Config,
  type GenerateLabPass1Result,
  type Pass1Timing,
  type StageTiming,
} from './pass1.js';
export {
  FlagshipSelectionError,
  selectFlagshipModule,
  selectTraceFlagship,
  type FlagshipBasis,
  type FlagshipSelection,
} from './flagship.js';
export { hasIntakeAnswers, renderIntakeSection, type LeadIntake } from './intake.js';
export type {
  GenerationPass,
  GenerationProgressEvent,
  ProgressCallback,
} from './progress.js';
export {
  DEFAULT_STAGE_MODEL,
  GENERATION_STAGES,
  MAP_STAGE_MODEL,
  mapWithConcurrency,
  resolveStageModels,
  type GenerationStageName,
  type ModelRunner,
  type StageModelConfig,
  type StageRequest,
  type StageResponse,
} from './pipeline.js';
export {
  MapStageError,
  extractJson,
  inPayloadCoordinates,
  parseTraceCandidates,
  runMapStage,
  traceCandidateSchema,
  type MapStageOptions,
  type MapStageResult,
  type TraceCandidate,
} from './mapStage.js';
export {
  DEFAULT_MAX_MODULES,
  LANDING_MODULE_ID,
  PlanStageError,
  curriculumPlanSchema,
  parsePlan,
  plannedModuleSchema,
  runPlanStage,
  type CurriculumBudget,
  type CurriculumPlan,
  type PlanStageOptions,
  type PlanStageResult,
  type PlannedModule,
} from './planStage.js';
export {
  AuthorStageError,
  DEFAULT_AUTHOR_CONCURRENCY,
  runAuthorStage,
  type AuthorModuleFailure,
  type AuthorStageOptions,
  type AuthorStageResult,
  type AuthoredModule,
} from './authorStage.js';
export {
  assembleLab,
  type AssembleOptions,
  type AssembleResult,
} from './assembleStage.js';
export {
  DEFAULT_VERIFY_CONCURRENCY,
  VerifyStageError,
  collectModuleClaims,
  runVerifyStage,
  type ClaimVerdict,
  type ClaimVerdictValue,
  type VerificationClaim,
  type VerificationDroppedQuestion,
  type VerificationDroppedWidget,
  type VerificationDrops,
  type VerificationReport,
  type VerificationSummary,
  type VerifyBatchFailure,
  type VerifyStageOptions,
  type VerifyStageResult,
} from './verifyStage.js';
export {
  createAgentSdkRunner,
  createStallWatchdog,
  DEFAULT_MAX_TURNS,
  describeAuth,
  DEFAULT_STALL_TIMEOUT_MS,
  type AgentSdkRunnerOptions,
  type AuthDescription,
  type AuthMode,
  type StallWatchdog,
} from './agentSdkRunner.js';
export {
  createAnchorFileCache,
  readAnchorRegion,
  resolveAnchors,
  type AnchorFileCache,
  type AnchorRegion,
  type AnchorResolution,
  type AnchorStatus,
  type LoadedFile,
  type ResolutionPolicy,
  type ResolutionReport,
  type ResolutionSummary,
  type ResolveAnchorsOptions,
  type ResolveAnchorsResult,
  type UnitOutcome,
  type UnitResolution,
} from './resolveAnchors.js';
export { isRepoDirty, readRepoCommit, readRepoRemote } from './repoCommit.js';
export { normalizeModelJson } from './normalizeModelJson.js';
export {
  dropUnanchoredProse,
  fromSource,
  type ProseDrop,
  type ProseDropResult,
} from './dropUnanchoredProse.js';
/**
 * Cloning a repository, shared by the worker (which clones untrusted URLs on
 * our own infrastructure) and the CLI (which clones onto the reader's machine
 * at their request). One validated implementation rather than two, because URL
 * validation is the last thing to have two versions of.
 */
export {
  cloneRepo,
  CloneTimeoutError,
  parseGitProgress,
  validateRepoUrl,
  type CloneOptions,
  type CloneResult,
  type ExecFn,
  type ExecResult,
  type UrlCheck,
} from './cloneRepo.js';
