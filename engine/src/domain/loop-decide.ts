import type { LoopConfig, LoopDecision, LoopExitCode, LoopRound, LoopState } from './loop.js';

const assertNever = (value: never): never => {
  void value;
  throw new Error('Unhandled loop state');
};

const exitCodeFor = (state: LoopState): LoopExitCode => {
  switch (state) {
    case 'DONE':
      return 0;
    case 'CONFIRM':
    case 'CONTINUE':
      return 10;
    case 'ASK_USER':
      return 11;
    case 'ESCALATE_MAX':
    case 'ESCALATE_NONCONV':
      return 20;
    default:
      return assertNever(state);
  }
};

/**
 * The single source of loop advice. `LoopDecision.advice` carries the bestSha-free
 * form; the `loop` CLI passes the keep-best sha so the ESCALATE_MAX guidance can
 * name the diff to post. (Previously the CLI kept a richer private copy and
 * discarded `decision.advice`; this is that richer copy, promoted to the domain.)
 */
export const adviceFor = (state: LoopState, last: LoopRound, bestSha?: string): string => {
  switch (state) {
    case 'DONE':
      return 'second independent confirmation passed → finish: mark TASK DONE+Completed, push/deliver';
    case 'CONFIRM':
      return 'first ACCEPTED → run 1 more independent confirmation review pass (verification is probabilistic); only DONE if still ACCEPTED';
    case 'CONTINUE':
      return `this round findings all mechanical → operator Edit-patch(no rollback to implementer for rewrite), commit, run next round ${String(last.round + 1)}`;
    case 'ASK_USER':
      return `this round ${String(last.intentFindings)}/${String(last.findings)} findings touch intent(architecture/semantics/trade-off)→ first escalate these to human for approve/change/skip; the other ${String(last.findings - last.intentFindings)} mechanical ones Claude Edit-patches directly, then run next round`;
    case 'ESCALATE_MAX':
      return `reached cap still NEEDS FIX → stop and escalate: post best diff(sha ${bestSha !== undefined && bestSha.length > 0 ? bestSha : '—'}) + remaining findings + your judgment`;
    case 'ESCALATE_NONCONV':
      return 'two consecutive rounds same-class/not decreasing → first meta-reflect(reviewer too strict? requirement unclear? change implementation? fix→break thrashing?) for a diagnosis, then escalate';
    default:
      return assertNever(state);
  }
};

const decision = (state: LoopState, last: LoopRound): LoopDecision => ({
  state,
  exitCode: exitCodeFor(state),
  advice: adviceFor(state, last),
});

/**
 * A clean first pass: the only round so far, gate green, an ACCEPTED verdict with
 * zero findings. There is nothing for a second confirmation pass to catch, so
 * with `fastPathClean` enabled this can finish in one round (see LoopConfig).
 */
const isCleanFirstPass = (rounds: readonly LoopRound[]): boolean => {
  if (rounds.length !== 1) return false;
  const only = rounds[0];
  return (
    only !== undefined && only.gate === 'pass' && only.verdict === 'ACCEPTED' && only.findings === 0
  );
};

export function decideLoop(rounds: readonly LoopRound[], config: LoopConfig): LoopDecision {
  const last = rounds[rounds.length - 1];
  if (last === undefined) throw new Error('no rounds recorded');

  const confirmations = config.confirmations ?? 2;
  const accepted = rounds.filter((round) => round.verdict === 'ACCEPTED').length;

  if (last.verdict === 'ACCEPTED') {
    if (config.fastPathClean === true && isCleanFirstPass(rounds)) {
      return decision('DONE', last);
    }
    return decision(accepted >= confirmations ? 'DONE' : 'CONFIRM', last);
  }

  if (last.round >= config.maxRounds) return decision('ESCALATE_MAX', last);

  const previous = rounds.length >= 2 ? rounds[rounds.length - 2] : undefined;
  const nonConverging =
    last.sameClass ||
    (previous !== undefined &&
      previous.findings > 0 &&
      last.findings > 0 &&
      last.findings >= previous.findings);
  if (nonConverging) return decision('ESCALATE_NONCONV', last);

  if (last.intentFindings > 0) return decision('ASK_USER', last);

  return decision('CONTINUE', last);
}

export function bestRound(rounds: readonly LoopRound[]): LoopRound | null {
  const first = rounds[0];
  if (first === undefined) return null;

  let best = first;
  for (const round of rounds) {
    if (round.findings < best.findings) best = round;
  }
  return best;
}
