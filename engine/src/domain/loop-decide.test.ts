import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import type { LoopConfig, LoopDecision, LoopRound, LoopState, VerdictKind } from './loop.js';
import { bestRound, decideLoop } from './loop-decide.js';

interface RoundOverrides {
  readonly round?: number;
  readonly gate?: LoopRound['gate'];
  readonly verdict?: VerdictKind;
  readonly findings?: number;
  readonly intentFindings?: number;
  readonly sameClass?: boolean;
  readonly sha?: string;
  readonly note?: string;
}

const round = (overrides: RoundOverrides = {}): LoopRound => {
  const value: {
    round: number;
    gate: LoopRound['gate'];
    verdict: VerdictKind;
    findings: number;
    intentFindings: number;
    sameClass: boolean;
    sha?: string;
    note?: string;
  } = {
    round: overrides.round ?? 1,
    gate: overrides.gate ?? 'pass',
    verdict: overrides.verdict ?? 'NEEDS_FIX',
    findings: overrides.findings ?? 0,
    intentFindings: overrides.intentFindings ?? 0,
    sameClass: overrides.sameClass ?? false,
  };

  if (overrides.sha !== undefined) value.sha = overrides.sha;
  if (overrides.note !== undefined) value.note = overrides.note;
  return value;
};

const expectDecision = (
  decision: LoopDecision,
  state: LoopState,
  exitCode: LoopDecision['exitCode'],
): void => {
  expect(decision.state).toBe(state);
  expect(decision.exitCode).toBe(exitCode);
  expect(decision.advice.length).toBeGreaterThan(0);
};

const loopRoundArbitrary: fc.Arbitrary<LoopRound> = fc
  .record({
    round: fc.integer({ min: 0, max: 20 }),
    gate: fc.constantFrom<LoopRound['gate']>('pass', 'fail'),
    verdict: fc.constantFrom<VerdictKind>('ACCEPTED', 'NEEDS_FIX'),
    findings: fc.integer({ min: 0, max: 20 }),
    intentFindings: fc.integer({ min: 0, max: 20 }),
    sameClass: fc.boolean(),
  })
  .map((value): LoopRound => value);

const configArbitrary: fc.Arbitrary<LoopConfig> = fc.oneof(
  fc.integer({ min: 0, max: 20 }).map((maxRounds): LoopConfig => ({ maxRounds })),
  fc
    .record({
      maxRounds: fc.integer({ min: 0, max: 20 }),
      confirmations: fc.integer({ min: 1, max: 5 }),
    })
    .map((value): LoopConfig => value),
);

describe('decideLoop', () => {
  it('maps DONE when cumulative ACCEPTED confirmations pass', () => {
    expectDecision(
      decideLoop(
        [round({ round: 1, verdict: 'ACCEPTED' }), round({ round: 2, verdict: 'ACCEPTED' })],
        { maxRounds: 5 },
      ),
      'DONE',
      0,
    );
  });

  it('maps CONFIRM for the first ACCEPTED', () => {
    expectDecision(decideLoop([round({ verdict: 'ACCEPTED' })], { maxRounds: 5 }), 'CONFIRM', 10);
  });

  it('maps CONTINUE for mechanical NEEDS_FIX findings', () => {
    expectDecision(
      decideLoop([round({ verdict: 'NEEDS_FIX', findings: 2 })], { maxRounds: 5 }),
      'CONTINUE',
      10,
    );
  });

  it('maps ASK_USER for intent findings after higher-priority exits are clear', () => {
    expectDecision(
      decideLoop([round({ verdict: 'NEEDS_FIX', findings: 3, intentFindings: 1 })], {
        maxRounds: 5,
      }),
      'ASK_USER',
      11,
    );
  });

  it('maps ESCALATE_MAX before ASK_USER and non-convergence', () => {
    expectDecision(
      decideLoop(
        [
          round({ round: 1, verdict: 'NEEDS_FIX', findings: 1 }),
          round({
            round: 3,
            verdict: 'NEEDS_FIX',
            findings: 3,
            intentFindings: 2,
            sameClass: true,
          }),
        ],
        { maxRounds: 3 },
      ),
      'ESCALATE_MAX',
      20,
    );
  });

  it('maps ESCALATE_NONCONV before ASK_USER when sameClass is true', () => {
    expectDecision(
      decideLoop(
        [round({ verdict: 'NEEDS_FIX', findings: 2, intentFindings: 1, sameClass: true })],
        { maxRounds: 5 },
      ),
      'ESCALATE_NONCONV',
      20,
    );
  });

  it('maps ESCALATE_NONCONV on non-decreasing positive findings over two rounds', () => {
    expectDecision(
      decideLoop(
        [
          round({ round: 1, verdict: 'NEEDS_FIX', findings: 2 }),
          round({ round: 2, verdict: 'NEEDS_FIX', findings: 2 }),
        ],
        { maxRounds: 5 },
      ),
      'ESCALATE_NONCONV',
      20,
    );
  });

  it('counts ACCEPTED cumulatively, not consecutively', () => {
    expectDecision(
      decideLoop(
        [
          round({ round: 1, verdict: 'ACCEPTED' }),
          round({ round: 2, verdict: 'NEEDS_FIX', findings: 1 }),
          round({ round: 3, verdict: 'ACCEPTED' }),
        ],
        { maxRounds: 5 },
      ),
      'DONE',
      0,
    );
  });

  it('throws when no rounds are recorded', () => {
    expect(() => decideLoop([], { maxRounds: 5 })).toThrow('no rounds recorded');
  });

  it('is total and deterministic for any non-empty generated history', () => {
    fc.assert(
      fc.property(
        fc.array(loopRoundArbitrary, { minLength: 1 }),
        configArbitrary,
        (rounds, config) => {
          const first = decideLoop(rounds, config);
          const second = decideLoop(rounds, config);
          expect(second).toEqual(first);
        },
      ),
    );
  });

  it('DONE implies last verdict ACCEPTED and enough cumulative confirmations', () => {
    fc.assert(
      fc.property(
        fc.array(loopRoundArbitrary, { minLength: 1 }),
        configArbitrary,
        (rounds, config) => {
          const result = decideLoop(rounds, config);
          if (result.state !== 'DONE') return;

          const last = rounds[rounds.length - 1];
          if (last === undefined) throw new Error('property generated an empty history');

          const confirmations = config.confirmations ?? 2;
          const accepted = rounds.filter((candidate) => candidate.verdict === 'ACCEPTED').length;
          expect(last.verdict).toBe('ACCEPTED');
          expect(accepted).toBeGreaterThanOrEqual(confirmations);
        },
      ),
    );
  });

  it('any NEEDS_FIX at or beyond maxRounds escalates by max before other exits', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }).chain((maxRounds) =>
          fc.record({
            maxRounds: fc.constant(maxRounds),
            prefix: fc.array(loopRoundArbitrary, { maxLength: 5 }),
            lastRound: fc.integer({ min: maxRounds, max: maxRounds + 20 }),
            findings: fc.integer({ min: 0, max: 20 }),
            intentFindings: fc.integer({ min: 0, max: 20 }),
            sameClass: fc.boolean(),
          }),
        ),
        ({ maxRounds, prefix, lastRound, findings, intentFindings, sameClass }) => {
          const last = round({
            round: lastRound,
            verdict: 'NEEDS_FIX',
            findings,
            intentFindings,
            sameClass,
          });
          expect(decideLoop([...prefix, last], { maxRounds }).state).toBe('ESCALATE_MAX');
        },
      ),
    );
  });
});

describe('bestRound', () => {
  it('returns null when no rounds are recorded', () => {
    expect(bestRound([])).toBeNull();
  });

  it('returns the round with the fewest findings', () => {
    const best = round({ round: 2, findings: 1 });

    expect(
      bestRound([round({ round: 1, findings: 4 }), best, round({ round: 3, findings: 3 })]),
    ).toBe(best);
  });

  it('keeps the earlier round on a findings tie', () => {
    const firstMinimum = round({ round: 2, findings: 1 });

    expect(
      bestRound([round({ round: 1, findings: 4 }), firstMinimum, round({ round: 3, findings: 1 })]),
    ).toBe(firstMinimum);
  });

  it('always returns a round with minimum findings (property)', () => {
    fc.assert(
      fc.property(fc.array(loopRoundArbitrary, { minLength: 1 }), (rounds) => {
        const best = bestRound(rounds);
        if (best === null) throw new Error('property generated an empty history');

        const minimum = Math.min(...rounds.map((candidate) => candidate.findings));
        expect(best.findings).toBe(minimum);
      }),
    );
  });
});
