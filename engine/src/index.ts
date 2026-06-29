/**
 * @bicamindlabs/fugunano-engine — public surface.
 *
 * The typed multi-agent orchestration engine (ports & adapters).
 * See docs/ARCHITECTURE.md and docs/PARITY.md.
 */
export const VERSION = '0.0.0';

export type { Result, Ok, Err } from './domain/result.js';
export { ok, err, isOk, isErr, mapOk, unwrapOr } from './domain/result.js';

// Domain — value objects
export type { TaskState, TerminalState } from './domain/task.js';
export { TERMINAL_STATES, isTerminal } from './domain/task.js';
export type { Artifact, ArtifactKind } from './domain/artifact.js';
export type { Deadline, RoundManifest } from './domain/round.js';
export { stateOf, isComplete, pendingKeys, tally } from './domain/round.js';
export type { PhaseName, RunEvent, Run } from './domain/run.js';
export type {
  VerdictKind,
  LoopState,
  LoopRound,
  LoopConfig,
  LoopDecision,
  LoopExitCode,
} from './domain/loop.js';
export { decideLoop, bestRound } from './domain/loop-decide.js';
export type {
  TaskProfile,
  AllocationOutcome,
  BenchTable,
  StatEntry,
  StrategyState,
  RankedAgent,
  Ranking,
  AllocationParams,
} from './domain/allocation.js';
export { DEFAULT_ALLOCATION_PARAMS, UNLISTED_RANK } from './domain/allocation.js';
export type { AgentProfile, AgentRegistry, AgentRole } from './domain/agent-registry.js';
export {
  AGENT_ROLES,
  parseAgentRegistryJson,
  renderAgentRegistryTemplate,
  findAgentProfile,
  resolveAgentTarget,
  agentHasRole,
  agentsForRole,
  agentPolicyLabel,
} from './domain/agent-registry.js';
export type { GateSeverity, GateCheck, GateResult } from './domain/gate.js';
export { isGo, failures, warnings, mergeGates } from './domain/gate.js';
export type { Selection, PolicyViolation, PolicyResult, Policy } from './domain/policy.js';
export {
  legacyGeminiCliPolicy,
  generationNotReviewPolicy,
  reviewerRequiredPolicy,
  DEFAULT_POLICIES,
  evaluatePolicies,
  policyResultToGate,
} from './domain/policy-eval.js';
export { checkProviderConfig } from './domain/preflight-checks.js';
export type {
  ActionApprovalClass,
  ActionCertificate,
  ActionCertificateAction,
  ActionCertificateApproval,
  ActionCertificateCheckpoint,
  ActionCertificateOutcome,
  ActionCertificateRuntime,
  ActionCheckpointKind,
  ActionCheckpointStatus,
  BuildActionCertificateInput,
} from './domain/action-certificate.js';
export {
  ACTION_APPROVAL_CLASSES,
  ACTION_CERTIFICATE_SCHEMA_VERSION,
  ACTION_CHECKPOINT_KINDS,
  buildActionCertificate,
  isActionApprovalClass,
} from './domain/action-certificate.js';
export type {
  TaskContextDigest,
  TaskContextDigestOmitted,
  TaskContextDigestOptions,
  TaskContextDigestUnit,
  TaskContextDigestUnitKind,
} from './domain/task-context-digest.js';
export {
  TASK_CONTEXT_DIGEST_SCHEMA_VERSION,
  renderTaskContextDigest,
  taskContextDigest,
} from './domain/task-context-digest.js';
export type {
  ReviewEvidence,
  ReviewFinding,
  ReviewFindingSeverity,
  ReviewPacket,
  ReviewPacketIssue,
  ReviewPacketOptions,
  ReviewRubric,
  ReviewVerdict,
} from './domain/review-packet.js';
export {
  REVIEW_PACKET_SCHEMA_VERSION,
  renderReviewPacket,
  reviewPacket,
} from './domain/review-packet.js';
export type {
  RuntimeGuardDisposition,
  RuntimeGuardEvidence,
  RuntimeGuardFinding,
  RuntimeGuardFindingKind,
  RuntimeGuardOptions,
  RuntimeGuardPacket,
  RuntimeGuardSeverity,
} from './domain/runtime-guard.js';
export {
  RUNTIME_GUARD_FINDING_KINDS,
  RUNTIME_GUARD_SCHEMA_VERSION,
  renderRuntimeGuardPacket,
  runtimeGuardGate,
  runtimeGuardPacket,
} from './domain/runtime-guard.js';
export type {
  DispatchRequest,
  DispatchResult,
  DispatchError,
  DispatchErrorKind,
  HealthStatus,
} from './domain/dispatch.js';
export type { Workspace } from './domain/workspace.js';
export type { PromptBundle, AssembleInput } from './domain/prompt.js';
export { assembleContext, renderBundle, renderTemplate } from './domain/prompt-render.js';
export type {
  Method,
  AddMethod,
  ExperienceError,
  ExperienceErrorKind,
  ExperienceSourceKind,
  ExperienceTrustFilter,
  ExperienceTrustKind,
  FailureCause,
  RecallOptions,
} from './domain/experience.js';
export {
  EXPERIENCE_SOURCE_KINDS,
  EXPERIENCE_TRUST_FILTERS,
  EXPERIENCE_TRUST_KINDS,
  FAILURE_CAUSES,
  explainRecallMatch,
  experienceFailureCause,
  experienceMatchedTerms,
  experienceQueryTerms,
  experienceScore,
  isExperienceSourceKind,
  isExperienceTrustFilter,
  isExperienceTrustKind,
  isFailureCause,
} from './domain/experience.js';
export { containsSecret, slugify } from './domain/experience-redact.js';
export type { OwnershipRule, Ownership } from './domain/ownership.js';
export { matchGlob, violatingFiles, checkOwnership } from './domain/ownership-check.js';
export type {
  Identity,
  Worktree,
  VcsError,
  VcsErrorKind,
  IntegrationOutcome,
  AgentIntegration,
  IntegrationReport,
} from './domain/vcs.js';
export { allClean } from './domain/vcs.js';
export type { SkillType, SkillSourceKind, SkillRef, Catalog, SkillSource } from './domain/skill.js';
export { DEFAULT_NOTE_RE } from './domain/skill.js';
export {
  parseDescription,
  classifyType,
  matchSkills,
  renderInjection,
  type MatchOptions,
} from './domain/skill-parse.js';
export type { GoalSpec } from './domain/goal.js';
export { parseGoalSpec, renderGoalTemplate } from './domain/goal-parse.js';
export { renderSummary } from './domain/summary.js';
export type { TaskPriority, TaskRef } from './domain/task-file.js';
export { renderTaskFile } from './domain/task-file.js';
export type {
  TaskHandoffChecklistItem,
  TaskHandoffEvidence,
  TaskHandoffIssue,
  TaskHandoffIssueKind,
  TaskHandoffOptions,
  TaskHandoffPacket,
  TaskHandoffReadiness,
} from './domain/task-handoff.js';
export { renderTaskHandoffPacket, taskHandoffPacket } from './domain/task-handoff.js';
export { renderPlanPrompt, DEFAULT_PLAN_AGENTS } from './domain/plan.js';
export type { VersionDrift } from './domain/runtime-sync.js';
export { detectDrift } from './domain/runtime-sync.js';
export type { RoleStatus, BackendStatus, DoctorReport } from './domain/doctor.js';
export { readyBackends, recommend } from './domain/doctor.js';
export type {
  EditableSurface,
  HarnessConfig,
  FailureSignature,
  TaggedFailure,
  WeaknessCluster,
  HarnessEdit,
  SplitScores,
  ValidationVerdict,
  LineageEntry,
} from './domain/self-harness.js';
export { EDITABLE_SURFACES } from './domain/self-harness.js';
export type { EvalCase, SelfHarnessSpec } from './domain/self-harness-spec.js';
export { parseSelfHarnessSpec, renderSelfHarnessSpecTemplate } from './domain/self-harness-spec.js';
export {
  acceptEdit,
  applyEdit,
  clusterWeaknesses,
  mergeAccepted,
  totalDelta,
} from './domain/self-harness-accept.js';
export {
  rankAgents,
  applyOutcome,
  decayState,
  betaPrior,
  thompsonScore,
} from './domain/allocation-score.js';

// Domain — ports
export type { ResultStore } from './domain/ports/result-store.js';
export type { Barrier } from './domain/ports/barrier.js';
export type { RunStore, RunPatch } from './domain/ports/run-store.js';
export type { ReviewLoop } from './domain/ports/review-loop.js';
export type { AllocationStrategy, RankOptions } from './domain/ports/allocation-strategy.js';
export type { QualityGate } from './domain/ports/quality-gate.js';
export { HARNESS_NAMES } from './domain/ports/harness.js';
export type { Harness, HarnessName } from './domain/ports/harness.js';
export type { WorkspaceStore } from './domain/ports/workspace-store.js';
export type { ExperienceStore } from './domain/ports/experience-store.js';
export type { VcsPort } from './domain/ports/vcs.js';
export type { Integrator, IntegrateOptions } from './domain/ports/integrator.js';
export type { SkillCatalog } from './domain/ports/skill-catalog.js';
export type { TaskStore } from './domain/ports/task-store.js';
export type {
  WeaknessMiner,
  HarnessProposer,
  HarnessValidator,
} from './domain/ports/self-harness.js';

// Infra — injected IO
export type { Clock } from './infra/clock.js';
export { systemClock } from './infra/clock.js';
export type { FileSystem } from './infra/file-system.js';
export type { CommandRunner, CommandResult, CommandOptions } from './infra/command-runner.js';
export type { Rng } from './infra/rng.js';
export { systemRng } from './infra/rng.js';
export { seededRng } from './infra/seeded-rng.js';
export { NodeFileSystem } from './infra/node-file-system.js';
export { MemoryFileSystem } from './infra/memory-file-system.js';
export { NodeCommandRunner } from './infra/node-command-runner.js';

// Adapters
export { InMemoryResultStore } from './adapters/store/in-memory-result-store.js';
export { FsResultStore } from './adapters/store/fs-result-store.js';
export { InMemoryRunStore } from './adapters/store/in-memory-run-store.js';
export { FsRunStore } from './adapters/store/fs-run-store.js';
export { PersistentBarrier } from './adapters/barrier/persistent-barrier.js';
export { PersistentReviewLoop } from './adapters/loop/persistent-review-loop.js';
export { BetaBernoulliAllocator } from './adapters/allocation/beta-bernoulli-allocator.js';
export { FugueCcHarness } from './adapters/harness/fugue-cc-harness.js';
export { CodexHarness } from './adapters/harness/codex-harness.js';
export { OpencodeHarness } from './adapters/harness/opencode-harness.js';
export { AgyHarness } from './adapters/harness/agy-harness.js';
export type { HarnessExecOptions } from './adapters/harness/exec-helpers.js';
export {
  HarnessBackedProposer,
  type HarnessBackedProposerOptions,
} from './adapters/self-harness/harness-proposer.js';
export {
  RunWeaknessMiner,
  type RunWeaknessMinerOptions,
} from './adapters/self-harness/run-weakness-miner.js';
export {
  TaskListHarnessValidator,
  type TaskListHarnessValidatorOptions,
} from './adapters/self-harness/task-list-validator.js';
export { FsWorkspaceStore } from './adapters/workspace/fs-workspace-store.js';
export { FsExperienceStore } from './adapters/experience/fs-experience-store.js';
export { GitVcsPort } from './adapters/integrate/git-vcs.js';
export { DefaultIntegrator } from './adapters/integrate/default-integrator.js';
export { FsSkillCatalog } from './adapters/skills/fs-skill-catalog.js';
export { FsTaskStore } from './adapters/task/fs-task-store.js';
export { runGoalGate, type GoalCheckOptions } from './adapters/goal/goal-gate.js';
export { RuntimeSync, type RuntimeSyncOptions } from './adapters/runtime/runtime-sync.js';
export { runRecon, type BackendSpec, type ReconOptions } from './adapters/doctor/recon.js';

// App helpers
export { waitForRound } from './app/wait-for-round.js';
export { planPanel, type PlanEntry } from './app/plan-panel.js';

// Coordinator — the composition that wires the ports into the join pipeline
export {
  Coordinator,
  type CoordinatorDeps,
  type DispatchTask,
  type RunReport,
} from './app/coordinator.js';
export { wireCoordinator, type WireConfig } from './app/wire.js';
export { wireSelfHarness, type WireSelfHarnessConfig } from './app/wire.js';

// Self-Harness — engine-native harness evolution, inspired by Shanghai AI Lab's arXiv 2606.09498.
export {
  SelfHarnessLoop,
  type SelfHarnessDeps,
  type RoundResult,
} from './app/self-harness-loop.js';
