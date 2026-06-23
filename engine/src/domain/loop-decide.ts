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

const adviceFor = (state: LoopState, last: LoopRound): string => {
  switch (state) {
    case 'DONE':
      return 'second confirmation passed, finish and deliver';
    case 'CONFIRM':
      return 'first ACCEPTED, run one more independent confirmation pass';
    case 'CONTINUE':
      return 'all findings mechanical, operator patches then next round';
    case 'ASK_USER':
      return `${last.intentFindings} findings touch intent, escalate those to a human, auto-fix the rest`;
    case 'ESCALATE_MAX':
      return 'hit the cap still NEEDS_FIX, escalate best diff and remaining findings';
    case 'ESCALATE_NONCONV':
      return 'two rounds not converging, meta-reflect then escalate';
    default:
      return assertNever(state);
  }
};

const decision = (state: LoopState, last: LoopRound): LoopDecision => ({
  state,
  exitCode: exitCodeFor(state),
  advice: adviceFor(state, last),
});

export function decideLoop(rounds: readonly LoopRound[], config: LoopConfig): LoopDecision {
  const last = rounds[rounds.length - 1];
  if (last === undefined) throw new Error('no rounds recorded');

  const confirmations = config.confirmations ?? 2;
  const accepted = rounds.filter((round) => round.verdict === 'ACCEPTED').length;

  if (last.verdict === 'ACCEPTED') {
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
