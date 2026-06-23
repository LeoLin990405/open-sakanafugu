import type { LoopDecision, LoopRound } from '../loop.js';

/**
 * The bounded review-fix loop (Phase 5) as a durable state machine: record each
 * round, decide the single next exit state, keep the best round (fewest
 * findings) auto-maintained. The decision logic itself is a pure function over
 * the recorded rounds (see domain/loop-decide); this port just persists them.
 */
export interface ReviewLoop {
  /** Append one round and refresh the keep-best baseline. */
  record(round: LoopRound): Promise<void>;
  /** Resolve the next exit state from the recorded history. Throws if no round recorded. */
  decide(): Promise<LoopDecision>;
  /** The best round so far (fewest findings), or null if none recorded. */
  best(): Promise<LoopRound | null>;
  /** All recorded rounds in order. */
  rounds(): Promise<readonly LoopRound[]>;
}
