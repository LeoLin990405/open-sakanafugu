import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join as joinPath } from 'node:path';

import { Command, Option } from 'clipanion';

import type { LoopRound, VerdictKind } from '../../domain/loop.js';
import { adviceFor, decideLoop } from '../../domain/loop-decide.js';
import { reviewPacket } from '../../domain/review-packet.js';
import { NodeFileSystem } from '../../infra/node-file-system.js';
import { defaultCacheRoot } from '../default-paths.js';

interface ParsedArgs {
  readonly ok: true;
  readonly cache: string | null;
  readonly rest: readonly string[];
}

interface ParseError {
  readonly ok: false;
  readonly message: string;
}

interface LoopMeta {
  readonly maxRounds: number;
  readonly taskFile: string;
  readonly bestSha: string;
  readonly bestN: number;
}

interface RecordOptions {
  readonly round: number;
  readonly gate: LoopRound['gate'];
  readonly verdict: VerdictKind;
  readonly findings: number;
  readonly askUser: number;
  readonly sha: string;
  readonly sameClass: boolean;
  readonly note: string;
}

type ParseResult = ParsedArgs | ParseError;

const parseArgs = (args: readonly string[]): ParseResult => {
  let cache: string | null = null;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === '--cache') {
      const next = args[index + 1];
      if (next === undefined)
        return { ok: false, message: 'usage: loop --cache <dir> <subcommand>' };
      cache = next;
      index += 1;
    } else if (arg.startsWith('--cache=')) {
      cache = arg.slice('--cache='.length);
    } else {
      rest.push(arg);
    }
  }
  return { ok: true, cache, rest };
};

const parseFields = (content: string): Readonly<Record<string, string>> => {
  const fields: Record<string, string> = {};
  for (const line of content.split(/\r?\n/u)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return fields;
};

const parsePositiveInteger = (raw: string): number | null => {
  if (!/^[1-9][0-9]*$/u.test(raw)) return null;
  return Number.parseInt(raw, 10);
};

const parseNonNegativeInteger = (raw: string): number | null => {
  if (!/^[0-9]+$/u.test(raw)) return null;
  return Number.parseInt(raw, 10);
};

const parseInteger = (raw: string | undefined): number | null => {
  if (raw === undefined || !/^-?[0-9]+$/u.test(raw)) return null;
  return Number.parseInt(raw, 10);
};

const verdictForInput = (raw: string): VerdictKind | null => {
  const normalized = raw.toUpperCase().replace(/ /gu, '_');
  switch (normalized) {
    case 'ACCEPTED':
    case 'ACCEPT':
      return 'ACCEPTED';
    case 'NEEDSFIX':
    case 'NEEDS_FIX':
    case 'NEEDS':
      return 'NEEDS_FIX';
    default:
      return null;
  }
};

const storedVerdict = (verdict: VerdictKind): string =>
  verdict === 'ACCEPTED' ? 'ACCEPTED' : 'NEEDSFIX';

const parseRoundLine = (line: string): LoopRound | null => {
  const [rawRound, gate, verdict, rawFindings, rawAsk, rawSame, sha, note] = line.split('\t');
  const round = parsePositiveInteger(rawRound ?? '');
  const findings = parseNonNegativeInteger(rawFindings ?? '');
  const intentFindings =
    rawAsk === undefined || rawAsk.length === 0 ? 0 : parseNonNegativeInteger(rawAsk);
  if (round === null || findings === null || intentFindings === null) return null;
  if (gate !== 'pass' && gate !== 'fail') return null;
  if (verdict !== 'ACCEPTED' && verdict !== 'NEEDSFIX') return null;
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
    round,
    gate,
    verdict: verdict === 'ACCEPTED' ? 'ACCEPTED' : 'NEEDS_FIX',
    findings,
    intentFindings,
    sameClass: rawSame === '1',
  };
  if (sha !== undefined && sha.length > 0) value.sha = sha;
  if (note !== undefined && note.length > 0) value.note = note;
  return value;
};

class LegacyLoopStore {
  private readonly fs = new NodeFileSystem();

  constructor(private readonly cacheRoot: string) {}

  async init(meta: LoopMeta): Promise<void> {
    await rm(this.loopDir(), { recursive: true, force: true });
    await this.fs.write(this.roundsPath(), '');
    await this.saveMeta(meta);
  }

  async meta(): Promise<LoopMeta | null> {
    const content = await this.fs.read(this.metaPath());
    if (content === null) return null;
    const fields = parseFields(content);
    return {
      maxRounds: parsePositiveInteger(fields.max_rounds ?? '') ?? 3,
      taskFile: fields.task_file ?? '',
      bestSha: fields.best_sha ?? '',
      bestN: parseInteger(fields.best_n) ?? -1,
    };
  }

  async rounds(): Promise<readonly LoopRound[]> {
    const content = await this.fs.read(this.roundsPath());
    if (content === null) return [];
    const rounds: LoopRound[] = [];
    for (const line of content.split(/\r?\n/u)) {
      if (line.length === 0) continue;
      const round = parseRoundLine(line);
      if (round !== null) rounds.push(round);
    }
    return rounds;
  }

  async record(
    options: RecordOptions,
  ): Promise<{ readonly kept: 'updated' | 'kept'; readonly meta: LoopMeta }> {
    const meta = await this.requireMeta();
    let nextMeta = meta;
    let kept: 'updated' | 'kept' = 'kept';
    if (meta.bestN < 0 || options.findings < meta.bestN) {
      nextMeta = {
        ...meta,
        bestN: options.findings,
        bestSha: options.sha.length > 0 ? options.sha : meta.bestSha,
      };
      kept = 'updated';
      await this.saveMeta(nextMeta);
    }
    const existing = (await this.fs.read(this.roundsPath())) ?? '';
    await this.fs.write(
      this.roundsPath(),
      `${existing}${String(options.round)}\t${options.gate}\t${storedVerdict(options.verdict)}\t${String(
        options.findings,
      )}\t${String(options.askUser)}\t${options.sameClass ? '1' : '0'}\t${options.sha}\t${options.note}\n`,
    );
    return { kept, meta: nextMeta };
  }

  async requireMeta(): Promise<LoopMeta> {
    const meta = await this.meta();
    if (meta === null) throw new Error('loop not init (run fuguectl loop init first)');
    return meta;
  }

  private loopDir(): string {
    return joinPath(this.cacheRoot, 'loop');
  }

  private metaPath(): string {
    return joinPath(this.loopDir(), 'meta');
  }

  private roundsPath(): string {
    return joinPath(this.loopDir(), 'rounds.tsv');
  }

  private async saveMeta(meta: LoopMeta): Promise<void> {
    await this.fs.write(
      this.metaPath(),
      [
        `max_rounds=${String(meta.maxRounds)}`,
        `task_file=${meta.taskFile}`,
        `best_sha=${meta.bestSha}`,
        `best_n=${String(meta.bestN)}`,
        '',
      ].join('\n'),
    );
  }
}

export class LoopCommand extends Command {
  static override paths = [['loop']];

  args = Option.Proxy();

  override async execute(): Promise<number> {
    const parsed = parseArgs(this.args);
    if (!parsed.ok) return this.error(parsed.message);

    const [sub, ...subArgs] = parsed.rest;
    if (sub === undefined || sub === '-h' || sub === '--help') {
      this.context.stdout.write(
        [
          'fugue loop init [--max N] [--task F] [--best-sha SHA] [--best-n N]',
          'fugue loop record <round> --gate pass|fail --verdict ACCEPTED|NEEDSFIX --findings N [--ask-user K] [--sha SHA] [--same-class] [--note "..."]',
          'fugue loop decide|next',
          'fugue loop status',
          '',
        ].join('\n'),
      );
      return 0;
    }

    const store = new LegacyLoopStore(parsed.cache ?? defaultCacheRoot(import.meta.url));
    try {
      switch (sub) {
        case 'init':
          return await this.init(store, subArgs);
        case 'record':
          return await this.record(store, subArgs);
        case 'decide':
        case 'next':
          return await this.decide(store);
        case 'status':
          return await this.status(store);
        default:
          return this.error(`unknown subcommand '${sub}' (init|record|decide|next|status)`);
      }
    } catch (error) {
      return this.error(error instanceof Error ? error.message : String(error));
    }
  }

  private async init(store: LegacyLoopStore, args: readonly string[]): Promise<number> {
    const parsed = this.parseInitOptions(args);
    if (!parsed.ok) return this.error(parsed.message);
    await store.init(parsed.meta);
    this.context.stdout.write(
      `✓ loop init: max=${String(parsed.meta.maxRounds)} best_sha=${
        parsed.meta.bestSha.length > 0 ? parsed.meta.bestSha : '(unset)'
      } best_n=${String(parsed.meta.bestN)}\n`,
    );
    return 0;
  }

  /**
   * Derive `--verdict`/`--findings` from a structured review packet so the loop
   * consumes review output instead of the operator hand-typing the verdict.
   * `--review <file>` reads a review (raw or already-rendered), runs reviewPacket,
   * and injects the verdict + finding count — unless the operator passed them
   * explicitly, in which case the manual values win. Gate stays manual (it is the
   * build/test result, orthogonal to the review verdict).
   */
  private async augmentWithReview(
    args: readonly string[],
  ): Promise<{ readonly ok: true; readonly args: readonly string[] } | { readonly ok: false; readonly message: string }> {
    const reviewIndex = args.indexOf('--review');
    if (reviewIndex === -1) return { ok: true, args };
    const file = args[reviewIndex + 1];
    if (file === undefined || file.length === 0)
      return { ok: false, message: '--review needs a file path' };
    const content = await new NodeFileSystem().read(file);
    if (content === null) return { ok: false, message: `--review file not found: ${file}` };
    const packet = reviewPacket(content, {
      sourceRef: file,
      sourceSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    });
    if (packet.verdict === 'UNKNOWN')
      return {
        ok: false,
        message: 'review packet verdict is UNKNOWN; pass --verdict explicitly',
      };
    const rest = [...args.slice(0, reviewIndex), ...args.slice(reviewIndex + 2)];
    const injected: string[] = [];
    if (!rest.includes('--verdict')) {
      injected.push('--verdict', packet.verdict === 'ACCEPTED' ? 'ACCEPTED' : 'NEEDSFIX');
    }
    if (!rest.includes('--findings')) {
      injected.push('--findings', String(packet.findingCount));
    }
    return { ok: true, args: [...rest, ...injected] };
  }

  private async record(store: LegacyLoopStore, args: readonly string[]): Promise<number> {
    const augmented = await this.augmentWithReview(args);
    if (!augmented.ok) return this.error(augmented.message);
    const parsed = this.parseRecordOptions(augmented.args);
    if (!parsed.ok) return this.error(parsed.message);
    const result = await store.record(parsed.options);
    this.context.stdout.write(
      `✓ round ${String(parsed.options.round)}: gate=${parsed.options.gate} verdict=${storedVerdict(
        parsed.options.verdict,
      )} findings=${String(parsed.options.findings)} ask-user=${String(parsed.options.askUser)} (best ${
        result.kept
      } → n=${String(result.meta.bestN)} sha=${result.meta.bestSha.length > 0 ? result.meta.bestSha : '—'})\n`,
    );
    if (
      result.kept === 'kept' &&
      parsed.options.verdict === 'NEEDS_FIX' &&
      parsed.options.findings > result.meta.bestN
    ) {
      this.context.stdout.write(
        `  ⚠ this round worse than best (findings ${String(
          parsed.options.findings,
        )} > best ${String(result.meta.bestN)}) → consider git reset --hard ${
          result.meta.bestSha.length > 0 ? result.meta.bestSha : '<best_sha>'
        } (keep-best rollback)\n`,
      );
    }
    return 0;
  }

  private async decide(store: LegacyLoopStore): Promise<number> {
    const meta = await store.requireMeta();
    const rounds = await store.rounds();
    if (rounds.length === 0) return this.error('no round recorded yet');
    const decision = decideLoop(rounds, { maxRounds: meta.maxRounds });
    const last = rounds[rounds.length - 1];
    if (last === undefined) return this.error('no round recorded yet');
    this.context.stdout.write(
      [
        decision.state,
        `round ${String(last.round)}/${String(meta.maxRounds)} | last verdict=${storedVerdict(
          last.verdict,
        )} findings=${String(last.findings)} | best n=${String(meta.bestN)} sha=${
          meta.bestSha.length > 0 ? meta.bestSha : '—'
        }`,
        `→ ${adviceFor(decision.state, last, meta.bestSha)}`,
        '',
      ].join('\n'),
    );
    return decision.exitCode;
  }

  private async status(store: LegacyLoopStore): Promise<number> {
    const meta = await store.requireMeta();
    const rounds = await store.rounds();
    this.context.stdout.write(
      `── fuguectl loop ── max=${String(meta.maxRounds)}  best n=${String(meta.bestN)} sha=${
        meta.bestSha.length > 0 ? meta.bestSha : '—'
      }  task=${meta.taskFile.length > 0 ? meta.taskFile : '—'}\n`,
    );
    if (rounds.length === 0) {
      this.context.stdout.write('  (no round recorded yet)\n');
      return 0;
    }
    this.context.stdout.write(
      `  ${'round'.padEnd(6)} ${'gate'.padEnd(5)} ${'verdict'.padEnd(9)} ${'findings'.padEnd(
        9,
      )} ${'ask-user'.padEnd(8)} note\n`,
    );
    for (const round of rounds) {
      const note = `${round.sameClass ? '[same-class] ' : ''}${round.note ?? ''}`;
      this.context.stdout.write(
        `  ${String(round.round).padEnd(6)} ${round.gate.padEnd(5)} ${storedVerdict(
          round.verdict,
        ).padEnd(9)} ${String(round.findings).padEnd(9)} ${String(round.intentFindings).padEnd(
          8,
        )} ${note}\n`,
      );
    }
    return 0;
  }

  private parseInitOptions(
    args: readonly string[],
  ):
    | { readonly ok: true; readonly meta: LoopMeta }
    | { readonly ok: false; readonly message: string } {
    let maxRounds = 3;
    let taskFile = '';
    let bestSha = '';
    let bestN = -1;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      const value = args[index + 1] ?? '';
      if (arg === '--max') {
        const parsed = parsePositiveInteger(value);
        if (parsed === null) return { ok: false, message: '--max needs integer ≥1' };
        maxRounds = parsed;
        index += 1;
      } else if (arg === '--task') {
        taskFile = value;
        index += 1;
      } else if (arg === '--best-sha') {
        bestSha = value;
        index += 1;
      } else if (arg === '--best-n') {
        const parsed = parseInteger(value);
        if (parsed === null) return { ok: false, message: '--best-n needs integer' };
        bestN = parsed;
        index += 1;
      } else {
        return { ok: false, message: `unknown argument '${arg ?? ''}'` };
      }
    }
    return { ok: true, meta: { maxRounds, taskFile, bestSha, bestN } };
  }

  private parseRecordOptions(
    args: readonly string[],
  ):
    | { readonly ok: true; readonly options: RecordOptions }
    | { readonly ok: false; readonly message: string } {
    const round = parsePositiveInteger(args[0] ?? '');
    if (round === null)
      return { ok: false, message: 'usage: record <round≥1> --gate .. --verdict .. --findings N' };
    let gate: LoopRound['gate'] | null = null;
    let verdict: VerdictKind | null = null;
    let findings: number | null = null;
    let askUser = 0;
    let sha = '';
    let sameClass = false;
    let note = '';
    for (let index = 1; index < args.length; index += 1) {
      const arg = args[index];
      const value = args[index + 1] ?? '';
      if (arg === '--gate') {
        if (value !== 'pass' && value !== 'fail')
          return { ok: false, message: '--gate must be pass|fail' };
        gate = value;
        index += 1;
      } else if (arg === '--verdict') {
        verdict = verdictForInput(value);
        if (verdict === null) return { ok: false, message: '--verdict must be ACCEPTED|NEEDSFIX' };
        index += 1;
      } else if (arg === '--findings') {
        findings = parseNonNegativeInteger(value);
        if (findings === null) return { ok: false, message: '--findings must be integer ≥0' };
        index += 1;
      } else if (arg === '--ask-user') {
        const parsed = parseNonNegativeInteger(value);
        if (parsed === null) return { ok: false, message: '--ask-user must be integer ≥0' };
        askUser = parsed;
        index += 1;
      } else if (arg === '--sha') {
        sha = value;
        index += 1;
      } else if (arg === '--same-class') {
        sameClass = true;
      } else if (arg === '--note') {
        note = value;
        index += 1;
      } else {
        return { ok: false, message: `unknown argument '${arg ?? ''}'` };
      }
    }
    if (gate === null) return { ok: false, message: '--gate must be pass|fail' };
    if (verdict === null) return { ok: false, message: '--verdict must be ACCEPTED|NEEDSFIX' };
    if (findings === null) return { ok: false, message: '--findings must be integer ≥0' };
    if (askUser > findings)
      return {
        ok: false,
        message: `--ask-user(${String(askUser)}) cannot be > --findings(${String(findings)})`,
      };
    return {
      ok: true,
      options: { round, gate, verdict, findings, askUser, sha, sameClass, note },
    };
  }

  private error(message: string): number {
    this.context.stderr.write(`${message}\n`);
    return 2;
  }
}
