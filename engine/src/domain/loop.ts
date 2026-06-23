/** A reviewer's verdict on one round. */
export type VerdictKind = 'ACCEPTED' | 'NEEDS_FIX';

/** The one exit state `decide` resolves to each round (bounded review-fix loop, never hard-marks DONE). */
export type LoopState =
  | 'DONE'
  | 'CONFIRM'
  | 'CONTINUE'
  | 'ASK_USER'
  | 'ESCALATE_MAX'
  | 'ESCALATE_NONCONV';

/**
 * One recorded round of the review-fix loop. Mirrors the bash `loop` ledger so
 * the TS decision stays at parity: gate is recorded for observability/keep-best
 * but does NOT drive the decision (a failing gate yields NEEDS_FIX by process).
 */
export interface LoopRound {
  readonly round: number;
  readonly gate: 'pass' | 'fail';
  readonly verdict: VerdictKind;
  /** Total findings raised this round. */
  readonly findings: number;
  /** Of `findings`, how many touch intent (need human judgment); the rest are mechanical/auto-fixable. */
  readonly intentFindings: number;
  /** Explicit non-convergence signal (the same class of finding is recurring). */
  readonly sameClass: boolean;
  /** Commit sha for keep-best rollback. */
  readonly sha?: string;
  readonly note?: string;
}

export interface LoopConfig {
  /** Hard cap on rounds before ESCALATE_MAX. */
  readonly maxRounds: number;
  /** Independent ACCEPTED passes required to reach DONE (default 2 — verification is probabilistic). */
  readonly confirmations?: number;
}

/** The outcome of a decision: the state, its process exit code, and human-facing advice. */
export interface LoopDecision {
  readonly state: LoopState;
  readonly exitCode: LoopExitCode;
  readonly advice: string;
}

/** 0 = DONE · 10 = auto-work (CONTINUE/CONFIRM) · 11 = need human (ASK_USER) · 20 = escalate. */
export type LoopExitCode = 0 | 10 | 11 | 20;
