import { describe, expect, it } from 'vitest';

import type { LoopConfig, LoopRound, VerdictKind } from '../../domain/loop.js';
import { bestRound, decideLoop } from '../../domain/loop-decide.js';
import { MemoryFileSystem } from '../../infra/memory-file-system.js';
import type { FileSystem } from '../../infra/file-system.js';
import { PersistentReviewLoop } from './persistent-review-loop.js';

const clock = { now: (): number => 1_000 };
const config: LoopConfig = { maxRounds: 5 };

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

const makeLoop = (
  fs: FileSystem = new MemoryFileSystem(clock),
  loopConfig: LoopConfig = config,
): PersistentReviewLoop => new PersistentReviewLoop(fs, '/loops', loopConfig);

describe('PersistentReviewLoop', () => {
  it('round-trips recorded rounds', async () => {
    const loop = makeLoop();
    const rounds = [
      round({ round: 1, findings: 3, sha: 'a' }),
      round({ round: 2, findings: 1, note: 'best so far' }),
    ];

    for (const entry of rounds) await loop.record(entry);

    expect(await loop.rounds()).toEqual(rounds);
  });

  it('decide matches the pure decision function on loaded rounds', async () => {
    const loop = makeLoop();
    const rounds = [
      round({ round: 1, verdict: 'ACCEPTED' }),
      round({ round: 2, verdict: 'ACCEPTED' }),
    ];

    for (const entry of rounds) await loop.record(entry);

    expect(await loop.decide()).toEqual(decideLoop(rounds, config));
  });

  it('best matches the pure keep-best function on loaded rounds', async () => {
    const loop = makeLoop();
    const rounds = [
      round({ round: 1, findings: 3 }),
      round({ round: 2, findings: 1 }),
      round({ round: 3, findings: 1 }),
    ];

    for (const entry of rounds) await loop.record(entry);

    expect(await loop.best()).toEqual(bestRound(rounds));
  });

  it('decide throws when nothing has been recorded', async () => {
    await expect(makeLoop().decide()).rejects.toThrow('no rounds recorded');
  });

  it('rounds returns an empty list when nothing has been recorded', async () => {
    await expect(makeLoop().rounds()).resolves.toEqual([]);
  });

  it('concurrent record calls do not lose rounds', async () => {
    const loop = makeLoop();
    const rounds = Array.from({ length: 12 }, (_unused, index) =>
      round({ round: index + 1, findings: index }),
    );

    await Promise.all(rounds.map((entry) => loop.record(entry)));

    const persisted = await loop.rounds();
    expect(persisted.length).toBe(rounds.length);
    expect(new Set(persisted.map((entry) => entry.round))).toEqual(
      new Set(rounds.map((entry) => entry.round)),
    );
  });

  it('rejects malformed persisted JSON', async () => {
    const fs = new MemoryFileSystem(clock);
    await fs.write('/loops/rounds.json', JSON.stringify([{ round: 1 }]));

    await expect(makeLoop(fs).rounds()).rejects.toThrow(/Invalid review loop rounds/u);
  });
});
