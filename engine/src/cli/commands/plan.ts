import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import { performance } from 'node:perf_hooks';

import { Command, Option } from 'clipanion';

import { CodexHarness } from '../../adapters/harness/codex-harness.js';
import { FugueCcHarness } from '../../adapters/harness/fugue-cc-harness.js';
import { AgyHarness } from '../../adapters/harness/agy-harness.js';
import { OpencodeHarness } from '../../adapters/harness/opencode-harness.js';
import { DEFAULT_PLAN_AGENTS } from '../../domain/plan.js';
import { HARNESS_NAMES, type Harness, type HarnessName } from '../../domain/ports/harness.js';
import { isOk } from '../../domain/result.js';
import { NodeCommandRunner } from '../../infra/node-command-runner.js';
import { defaultCacheRoot } from '../default-paths.js';

const parseModels = (raw: string): readonly string[] =>
  raw
    .split(',')
    .map((model) => model.trim())
    .filter((model) => model.length > 0);

const parseTimeoutMs = (raw: string): number | null | undefined => {
  const value = raw.trim();
  if (value.length === 0 || value === '0') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
};

const formatDurationMs = (ms: number): string => {
  if (ms < 1000) return `${String(Math.max(0, Math.round(ms)))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

const failureFields = (kind: string, exitCode: number | undefined): string =>
  `error=${kind} rc=${String(exitCode ?? 1)}`;

const shanghaiTimestamp = (date = new Date()): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`;
};

const defaultPlanOut = (): string => joinPath(defaultCacheRoot(import.meta.url), 'plans');

const DEFAULT_CODEX_PLAN_AGENTS = ['gpt-5.5'] as const;
const DEFAULT_OPENCODE_PLAN_AGENTS = ['opencode/deepseek-v4-flash-free'] as const;
const DEFAULT_AGY_PLAN_AGENTS = ['default'] as const;

const isHarnessName = (value: string): value is HarnessName =>
  (HARNESS_NAMES as readonly string[]).includes(value);

const planFilename = (agent: string): string => {
  const slug = agent.replace(/[^A-Za-z0-9._-]+/gu, '_').replace(/^_+|_+$/gu, '');
  return `${slug.length > 0 ? slug : 'agent'}.plan.md`;
};

const promptFor = (model: string, goal: string, outfile: string): string =>
  [
    `Your role: planner (${model}). Decompose the goal below into a plan of subtasks that can run in parallel.`,
    '',
    `Goal: ${goal}`,
    '',
    'Requirements:',
    "1. List 3-6 subtasks, each annotated: scope (one sentence) + suggested implementer model (by each model's strength) + files to change",
    '2. Mark dependencies/ordering (write out what must be serial); the rest defaults to parallel',
    '3. Give 1 acceptance point per subtask',
    '4. End with one "overall acceptance gate" (a runnable command, e.g. `pytest -q && npm run build`)',
    '',
    `Output: **must use the Write tool to write to ${outfile}** (NOT chat! chat gets lost), Markdown.`,
  ].join('\n');

const ensurePlanArtifact = async (
  outfile: string,
  harnessOutput: string,
): Promise<'written' | 'captured' | null> => {
  try {
    const existing = await readFile(outfile, 'utf8');
    if (existing.trim().length > 0) return 'written';
  } catch {
    // Missing files are expected when a harness returns its plan on stdout.
  }

  const captured = harnessOutput.trim();
  if (captured.length === 0) return null;
  await writeFile(outfile, `${captured}\n`, 'utf8');
  return 'captured';
};

const defaultAgentsFor = (harness: HarnessName): readonly string[] => {
  switch (harness) {
    case 'fugue-cc':
      return DEFAULT_PLAN_AGENTS;
    case 'codex':
      return DEFAULT_CODEX_PLAN_AGENTS;
    case 'opencode':
      return DEFAULT_OPENCODE_PLAN_AGENTS;
    case 'agy':
      return DEFAULT_AGY_PLAN_AGENTS;
  }
};

export class PlanCommand extends Command {
  static override paths = [['plan']];

  goal = Option.String();
  harness = Option.String('--harness', process.env.FUGUE_DEFAULT_HARNESS ?? 'fugue-cc');
  models = Option.String('--models');
  out = Option.String('--out');
  task = Option.String('--task');
  bin = Option.String('--bin', process.env.FUGUE_CC_BIN ?? 'fugue-cc');
  timeoutMs = Option.String('--timeout-ms', process.env.FUGUE_PLAN_TIMEOUT_MS ?? '0');
  harnessArgs = Option.Array('--harness-arg', []);

  private taskLogQueue: Promise<void> = Promise.resolve();

  override async execute(): Promise<number> {
    if (!isHarnessName(this.harness)) {
      this.context.stderr.write(`unknown harness '${this.harness}' (${HARNESS_NAMES.join('|')})\n`);
      return 2;
    }
    const agents = parseModels(this.models ?? defaultAgentsFor(this.harness).join(','));
    if (agents.length === 0) {
      this.context.stderr.write('no planning models specified\n');
      return 2;
    }
    const timeoutMs = parseTimeoutMs(this.timeoutMs);
    if (timeoutMs === null) {
      this.context.stderr.write(
        `invalid --timeout-ms '${this.timeoutMs}' (expected positive ms)\n`,
      );
      return 2;
    }
    const outDir = this.out ?? defaultPlanOut();
    await mkdir(outDir, { recursive: true });

    const harness = this.harnessFor(this.harness, timeoutMs);
    const requests = agents.map((agent) => ({
      agent,
      outfile: joinPath(outDir, planFilename(agent)),
    }));
    for (const request of requests) {
      await this.appendTaskLog(
        `plan → ${request.agent} [${this.harness}] (status=started out=${request.outfile})`,
      );
    }
    const results = await Promise.all(
      requests.map(async ({ agent, outfile }) => {
        const startedAt = performance.now();
        const result = await harness.dispatch({
          agent,
          prompt: promptFor(agent, this.goal, outfile),
        });
        const artifact = isOk(result)
          ? await ensurePlanArtifact(outfile, result.value.output)
          : null;
        const elapsedMs = performance.now() - startedAt;
        const status = !isOk(result) ? 'failed' : (artifact ?? 'missing');
        const detail = isOk(result)
          ? `output_chars=${String(result.value.output.length)}`
          : failureFields(result.error.kind, result.error.exitCode);
        await this.appendTaskLog(
          `plan → ${agent} [${this.harness}] (status=${status} took=${formatDurationMs(
            elapsedMs,
          )} ${detail} out=${outfile})`,
        );
        return { agent, outfile, result, artifact, elapsedMs };
      }),
    );

    const lines = [
      `── planning panel: goal decomposition (${this.harness}) → ${agents.join(' ')} ──`,
    ];
    for (const entry of results) {
      const duration = ` (took ${formatDurationMs(entry.elapsedMs)})`;
      if (!isOk(entry.result)) {
        lines.push(`  ✗ ${entry.agent} dispatch failed${duration}`);
      } else if (entry.artifact === 'written') {
        lines.push(`  → dispatched to ${entry.agent}, plan written to ${entry.outfile}${duration}`);
      } else if (entry.artifact === 'captured') {
        lines.push(
          `  → dispatched to ${entry.agent}, captured stdout to ${entry.outfile}${duration}`,
        );
      } else {
        lines.push(`  ✗ ${entry.agent} produced no plan artifact at ${entry.outfile}${duration}`);
      }
    }

    lines.push(
      '',
      'collect: after each model finishes writing, the planner reads these plans and synthesizes the final plan:',
    );
    for (const entry of requests) lines.push(`  ${entry.outfile}`);
    this.context.stdout.write(`${lines.join('\n')}\n`);
    return results.every((entry) => isOk(entry.result) && entry.artifact !== null) ? 0 : 1;
  }

  private appendTaskLog(message: string): Promise<void> {
    if (this.task === undefined) return Promise.resolve();
    const write = async (): Promise<void> => {
      if (this.task === undefined) return;
      let current: string;
      try {
        current = await readFile(this.task, 'utf8');
      } catch {
        return;
      }
      await writeFile(this.task, `${current}- [${shanghaiTimestamp()}] ${message}\n`, 'utf8');
    };
    this.taskLogQueue = this.taskLogQueue.then(write, write);
    return this.taskLogQueue;
  }

  private harnessFor(name: HarnessName, timeoutMs: number | undefined): Harness {
    const runner = new NodeCommandRunner();
    switch (name) {
      case 'fugue-cc':
        return new FugueCcHarness(runner, {
          bin: this.bin,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(this.harnessArgs.length > 0 ? { args: this.harnessArgs } : {}),
        });
      case 'codex':
        return new CodexHarness(runner, {
          bin: process.env.FUGUE_CODEX ?? 'codex',
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(this.harnessArgs.length > 0 ? { args: this.harnessArgs } : {}),
        });
      case 'opencode':
        return new OpencodeHarness(runner, {
          bin: process.env.FUGUE_OPENCODE ?? 'opencode',
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(this.harnessArgs.length > 0 ? { args: this.harnessArgs } : {}),
        });
      case 'agy':
        return new AgyHarness(runner, {
          bin: process.env.FUGUE_AGY ?? 'agy',
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(this.harnessArgs.length > 0 ? { args: this.harnessArgs } : {}),
        });
    }
  }
}
