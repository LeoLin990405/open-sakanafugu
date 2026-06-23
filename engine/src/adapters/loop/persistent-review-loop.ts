import { bestRound, decideLoop } from '../../domain/loop-decide.js';
import type { LoopConfig, LoopDecision, LoopRound, VerdictKind } from '../../domain/loop.js';
import type { ReviewLoop } from '../../domain/ports/review-loop.js';
import type { FileSystem } from '../../infra/file-system.js';
import { Mutex } from '../store/mutex.js';
import { joinPath } from '../store/paths.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isGate = (value: unknown): value is LoopRound['gate'] => {
  switch (value) {
    case 'pass':
    case 'fail':
      return true;
    default:
      return false;
  }
};

const isVerdictKind = (value: unknown): value is VerdictKind => {
  switch (value) {
    case 'ACCEPTED':
    case 'NEEDS_FIX':
      return true;
    default:
      return false;
  }
};

const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value);

const isLoopRound = (value: unknown): value is LoopRound => {
  if (!isRecord(value)) return false;
  if (!isInteger(value.round)) return false;
  if (!isGate(value.gate)) return false;
  if (!isVerdictKind(value.verdict)) return false;
  if (!isInteger(value.findings)) return false;
  if (!isInteger(value.intentFindings)) return false;
  if (typeof value.sameClass !== 'boolean') return false;
  if (value.sha !== undefined && typeof value.sha !== 'string') return false;
  return value.note === undefined || typeof value.note === 'string';
};

const copyRound = (round: LoopRound): LoopRound => {
  const copy: {
    round: number;
    gate: LoopRound['gate'];
    verdict: VerdictKind;
    findings: number;
    intentFindings: number;
    sameClass: boolean;
    sha?: string;
    note?: string;
  } = {
    round: round.round,
    gate: round.gate,
    verdict: round.verdict,
    findings: round.findings,
    intentFindings: round.intentFindings,
    sameClass: round.sameClass,
  };

  if (round.sha !== undefined) copy.sha = round.sha;
  if (round.note !== undefined) copy.note = round.note;
  return copy;
};

const copyRounds = (rounds: readonly LoopRound[]): readonly LoopRound[] => rounds.map(copyRound);

const parseRounds = (content: string, path: string): readonly LoopRound[] => {
  const parsed = JSON.parse(content) as unknown;
  if (!Array.isArray(parsed) || !parsed.every(isLoopRound)) {
    throw new Error(`Invalid review loop rounds at ${path}`);
  }
  return copyRounds(parsed);
};

export class PersistentReviewLoop implements ReviewLoop {
  private readonly mutex = new Mutex();

  constructor(
    private readonly fs: FileSystem,
    private readonly rootDir: string,
    private readonly config: LoopConfig,
  ) {}

  record(round: LoopRound): Promise<void> {
    return this.mutex.run(async () => {
      const rounds = await this.load();
      await this.save([...rounds, copyRound(round)]);
    });
  }

  async decide(): Promise<LoopDecision> {
    return decideLoop(await this.load(), this.config);
  }

  async best(): Promise<LoopRound | null> {
    return bestRound(await this.load());
  }

  async rounds(): Promise<readonly LoopRound[]> {
    return await this.load();
  }

  private path(): string {
    return joinPath(this.rootDir, 'rounds.json');
  }

  private async load(): Promise<readonly LoopRound[]> {
    const path = this.path();
    const content = await this.fs.read(path);
    if (content === null) return [];
    return parseRounds(content, path);
  }

  private async save(rounds: readonly LoopRound[]): Promise<void> {
    await this.fs.write(this.path(), `${JSON.stringify(copyRounds(rounds), null, 2)}\n`);
  }
}
