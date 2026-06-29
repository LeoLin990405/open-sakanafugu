import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join as joinPath } from 'node:path';
import { performance } from 'node:perf_hooks';

import { Command, Option, UsageError } from 'clipanion';

import { FsExperienceStore } from '../../adapters/experience/fs-experience-store.js';
import { CodexHarness } from '../../adapters/harness/codex-harness.js';
import { FugueCcHarness } from '../../adapters/harness/fugue-cc-harness.js';
import { AgyHarness } from '../../adapters/harness/agy-harness.js';
import { OpencodeHarness } from '../../adapters/harness/opencode-harness.js';
import { FsSkillCatalog } from '../../adapters/skills/fs-skill-catalog.js';
import { FsWorkspaceStore } from '../../adapters/workspace/fs-workspace-store.js';
import {
  buildActionCertificate,
  isActionApprovalClass,
  type ActionApprovalClass,
  type ActionCertificate,
} from '../../domain/action-certificate.js';
import {
  DEFAULT_ALLOCATION_PARAMS,
  type BenchTable,
  type StatEntry,
  type StrategyState,
} from '../../domain/allocation.js';
import { rankAgents } from '../../domain/allocation-score.js';
import {
  EXPERIENCE_SOURCE_KINDS,
  EXPERIENCE_TRUST_FILTERS,
  isExperienceSourceKind,
  isExperienceTrustFilter,
  packExperienceMethodsForPrompt,
} from '../../domain/experience.js';
import type {
  ExperienceSourceKind,
  ExperienceTrustFilter,
  RecallOptions,
} from '../../domain/experience.js';
import { HARNESS_NAMES, type Harness, type HarnessName } from '../../domain/ports/harness.js';
import { assembleContext, renderBundle, renderTemplate } from '../../domain/prompt-render.js';
import { isOk } from '../../domain/result.js';
import type { SkillSource } from '../../domain/skill.js';
import { systemClock } from '../../infra/clock.js';
import type { FileSystem } from '../../infra/file-system.js';
import { NodeCommandRunner } from '../../infra/node-command-runner.js';
import { NodeFileSystem } from '../../infra/node-file-system.js';
import {
  defaultAllocationLedger,
  defaultAllocationStats,
  defaultAllocationTable,
  defaultExperienceDir,
  defaultTemplatesDir,
  defaultWorkspacesDir,
} from '../default-paths.js';
import { appendTaskAuditLine } from '../task-audit.js';
const defaultSkillsRoot = (): string =>
  process.env.FUGUE_SKILLS_ROOT ?? joinPath(joinPath(homedir(), '.claude'), 'skills');
const defaultPluginsRoot = (): string =>
  process.env.FUGUE_PLUGINS_ROOT ??
  joinPath(joinPath(joinPath(homedir(), '.claude'), 'plugins'), 'marketplaces');

const splitCsv = (raw: string): readonly string[] =>
  raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const recallOptions = (
  query: string | undefined,
  sourceKind: ExperienceSourceKind | undefined,
  sourceRef: string | undefined,
  limit: number | undefined,
  trust: ExperienceTrustFilter,
  maxAgeSeconds: number | undefined,
): RecallOptions => {
  let options: RecallOptions =
    query === undefined || query.trim().length === 0
      ? { limit: limit ?? 3, trust }
      : { limit: limit ?? 3, query, trust };
  if (sourceKind !== undefined) {
    options = { ...options, sourceKind };
  }
  if (sourceRef !== undefined) {
    options = { ...options, sourceRef };
  }
  if (maxAgeSeconds !== undefined) {
    options = { ...options, maxAgeSeconds };
  }
  return options;
};

const normalizeExperienceSource = (raw: string | undefined): string | undefined =>
  raw?.trim().toLowerCase();

const parseExperienceSource = (
  raw: string | undefined,
): ExperienceSourceKind | null | undefined => {
  const source = normalizeExperienceSource(raw);
  if (raw === undefined) return undefined;
  if (source === undefined || source.length === 0 || !isExperienceSourceKind(source)) {
    return null;
  }
  return source;
};

const experienceSourceError = (raw: string | undefined): string => {
  const source = normalizeExperienceSource(raw);
  const rendered = source === undefined || source.length === 0 ? '<empty>' : source;
  return `unknown --experience-source ${rendered}; expected one of ${EXPERIENCE_SOURCE_KINDS.join(', ')}\n`;
};

const parseExperienceSourceRef = (raw: string | undefined): string | null | undefined => {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value.length === 0 ? null : value;
};

const experienceSourceRefError = (): string =>
  '--experience-source-ref must be a non-empty string\n';

const parseExperienceLimit = (raw: string | undefined): number | null | undefined => {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : null;
};

const experienceLimitError = (raw: string | undefined): string => {
  const rendered = raw === undefined || raw.trim().length === 0 ? '<empty>' : raw.trim();
  return `unknown --experience-limit ${rendered}; expected a positive integer\n`;
};

const parseExperienceBudgetChars = (raw: string | undefined): number | null | undefined => {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : null;
};

const experienceBudgetCharsError = (raw: string | undefined): string => {
  const rendered = raw === undefined || raw.trim().length === 0 ? '<empty>' : raw.trim();
  return `unknown --experience-budget-chars ${rendered}; expected a positive integer\n`;
};

const parseExperienceMaxAgeDays = (raw: string | undefined): number | null | undefined => {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!/^\d+$/u.test(value)) return null;
  const days = Number.parseInt(value, 10);
  if (days <= 0) return null;
  const seconds = days * 86_400;
  return Number.isSafeInteger(seconds) ? seconds : null;
};

const experienceMaxAgeDaysError = (raw: string | undefined): string => {
  const rendered = raw === undefined || raw.trim().length === 0 ? '<empty>' : raw.trim();
  return `unknown --experience-max-age-days ${rendered}; expected a positive integer\n`;
};

const parseAutomaticExperienceTrust = (
  raw: string | undefined,
): ExperienceTrustFilter | null | undefined => {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  return isExperienceTrustFilter(value) && value !== 'untrusted' ? value : null;
};

const automaticExperienceTrustError = (raw: string | undefined): string => {
  const rendered = raw === undefined || raw.trim().length === 0 ? '<empty>' : raw.trim();
  const filters = EXPERIENCE_TRUST_FILTERS.filter((filter) => filter !== 'untrusted');
  return `unknown --experience-trust ${rendered}; expected one of ${filters.join(', ')}\n`;
};

const parseSet = (raw: string): readonly [string, string] => {
  const eq = raw.indexOf('=');
  if (eq <= 0) throw new UsageError(`--set format should be KEY=VALUE, got '${raw}'`);
  return [raw.slice(0, eq), raw.slice(eq + 1)] as const;
};

const varsFromSets = (sets: readonly string[]): Readonly<Record<string, string>> => {
  const vars: Record<string, string> = {};
  for (const raw of sets) {
    const [key, value] = parseSet(raw);
    vars[key] = value;
  }
  return vars;
};

const parseBench = (content: string): BenchTable => {
  const table = new Map<string, readonly string[]>();
  for (const raw of content.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const [taskType, models] = line.split('\t');
    if (taskType === undefined || models === undefined) continue;
    table.set(taskType.trim(), splitCsv(models));
  }
  return table;
};

const numberOrZero = (value: string | undefined): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

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

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const failureFields = (kind: string | undefined): string =>
  kind === undefined ? '' : ` error=${kind}`;

const actionApprovalClassError = (raw: string): string =>
  `unknown --approval-class ${raw}; expected one of not-required, operator-reviewed, runtime-enforced, external-approval\n`;

const writeText = async (stream: NodeJS.WritableStream, text: string): Promise<void> =>
  new Promise((resolve, reject) => {
    stream.write(text, (error?: Error | null) => {
      if (error !== undefined && error !== null) reject(error);
      else resolve();
    });
  });

const parseStats = (content: string): StrategyState => {
  const state: StatEntry[] = [];
  for (const raw of content.split(/\r?\n/u)) {
    if (raw.trim().length === 0) continue;
    const [taskType, agent, s, f] = raw.split('\t');
    if (taskType === undefined || agent === undefined) continue;
    state.push({ taskType, agent, s: numberOrZero(s), f: numberOrZero(f) });
  }
  return state;
};

const resolveModels = async (
  fs: FileSystem,
  models: string,
  options: { readonly allocation: string; readonly stats: string },
): Promise<string> => {
  if (!models.startsWith('@bench:')) return models;
  const table = parseBench((await fs.read(options.allocation)) ?? '');
  const requested = models.slice('@bench:'.length);
  const taskType = table.has(requested) ? requested : 'fallback';
  const state = parseStats((await fs.read(options.stats)) ?? '');
  return rankAgents(taskType, table, state, DEFAULT_ALLOCATION_PARAMS, {
    sample: false,
    random: () => 0.5,
  })
    .map((entry) => entry.agent)
    .join(',');
};

const pluginSkillSources = async (root: string, maxDepth = 8): Promise<readonly SkillSource[]> => {
  const sources: SkillSource[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries: readonly Dirent<string>[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = joinPath(dir, entry.name);
      if (entry.name === 'skills') {
        sources.push({ kind: 'plugin', dir: path, idPrefix: basename(dirname(path)) });
      }
      await walk(path, depth + 1);
    }
  };
  await walk(root, 0);
  return sources;
};

const skillSources = async (): Promise<readonly SkillSource[]> => {
  const root = defaultSkillsRoot();
  const sources: SkillSource[] = [
    { kind: 'user', dir: root },
    { kind: 'system', dir: joinPath(root, '.system') },
  ];
  if (process.env.FUGUE_SKILLS_NO_PLUGINS !== '1') {
    sources.push(...(await pluginSkillSources(defaultPluginsRoot())));
  }
  return sources;
};

const isHarnessName = (value: string): value is HarnessName =>
  (HARNESS_NAMES as readonly string[]).includes(value);

const CODEX_CLEAN_ARGS = [
  '--ignore-user-config',
  '--ignore-rules',
  '--ephemeral',
  '--color',
  'never',
] as const;

export class DispatchCommand extends Command {
  static override paths = [['dispatch']];

  target = Option.String();
  harness = Option.String('--harness', process.env.FUGUE_DEFAULT_HARNESS ?? 'fugue-cc');
  template = Option.String('--template');
  sets = Option.Array('--set', []);
  promptFile = Option.String('--prompt-file');
  inlinePrompt = Option.String('--prompt');
  workspace = Option.String('--workspace');
  experienceQuery = Option.String('--experience-query');
  experienceSource = Option.String('--experience-source');
  experienceSourceRef = Option.String('--experience-source-ref');
  experienceLimit = Option.String('--experience-limit');
  experienceBudgetChars = Option.String('--experience-budget-chars');
  experienceTrust = Option.String('--experience-trust');
  experienceMaxAgeDays = Option.String('--experience-max-age-days');
  task = Option.String('--task');
  taskType = Option.String('--task-type');
  skills = Option.String('--skills');
  templates = Option.String('--templates', defaultTemplatesDir(import.meta.url));
  workspaces = Option.String('--workspaces', defaultWorkspacesDir(import.meta.url));
  allocation = Option.String('--allocation', defaultAllocationTable(import.meta.url));
  stats = Option.String('--stats', defaultAllocationStats());
  experience = Option.String('--experience', defaultExperienceDir());
  ledger = Option.String('--ledger', defaultAllocationLedger());
  timeoutMs = Option.String('--timeout-ms', process.env.FUGUE_DISPATCH_TIMEOUT_MS ?? '0');
  out = Option.String('--out');
  certificate = Option.String('--certificate');
  approvalClass = Option.String('--approval-class', 'not-required');
  certificateAssumptions = Option.Array('--certificate-assumption', []);
  certificateExternalities = Option.Array('--certificate-externality', []);
  requireOutput = Option.Boolean('--require-output', false);
  verbose = Option.Boolean('--verbose', false);
  harnessArgs = Option.Array('--harness-arg', []);
  codexClean = Option.Boolean('--codex-clean', process.env.FUGUE_CODEX_CLEAN === '1');

  private readonly fs = new NodeFileSystem();

  override async execute(): Promise<number> {
    if (!isHarnessName(this.harness)) {
      this.context.stderr.write(`unknown harness '${this.harness}' (${HARNESS_NAMES.join('|')})\n`);
      return 2;
    }
    if (this.codexClean && this.harness !== 'codex') {
      this.context.stderr.write('--codex-clean requires --harness codex\n');
      return 2;
    }
    if (!isActionApprovalClass(this.approvalClass)) {
      this.context.stderr.write(actionApprovalClassError(this.approvalClass));
      return 2;
    }
    if (this.certificate !== undefined && this.certificate.trim().length === 0) {
      this.context.stderr.write('--certificate must be a non-empty path\n');
      return 2;
    }
    if (
      this.certificate === undefined &&
      (this.approvalClass !== 'not-required' ||
        this.certificateAssumptions.length > 0 ||
        this.certificateExternalities.length > 0)
    ) {
      this.context.stderr.write(
        '--approval-class, --certificate-assumption, and --certificate-externality require --certificate\n',
      );
      return 2;
    }

    const experienceSource = parseExperienceSource(this.experienceSource);
    if (experienceSource === null) {
      this.context.stderr.write(experienceSourceError(this.experienceSource));
      return 2;
    }
    const experienceSourceRef = parseExperienceSourceRef(this.experienceSourceRef);
    if (experienceSourceRef === null) {
      this.context.stderr.write(experienceSourceRefError());
      return 2;
    }
    const experienceLimit = parseExperienceLimit(this.experienceLimit);
    if (experienceLimit === null) {
      this.context.stderr.write(experienceLimitError(this.experienceLimit));
      return 2;
    }
    const experienceBudgetChars = parseExperienceBudgetChars(this.experienceBudgetChars);
    if (experienceBudgetChars === null) {
      this.context.stderr.write(experienceBudgetCharsError(this.experienceBudgetChars));
      return 2;
    }
    const experienceTrust = parseAutomaticExperienceTrust(this.experienceTrust);
    if (experienceTrust === null) {
      this.context.stderr.write(automaticExperienceTrustError(this.experienceTrust));
      return 2;
    }
    const experienceMaxAgeSeconds = parseExperienceMaxAgeDays(this.experienceMaxAgeDays);
    if (experienceMaxAgeSeconds === null) {
      this.context.stderr.write(experienceMaxAgeDaysError(this.experienceMaxAgeDays));
      return 2;
    }
    if (experienceSource !== undefined && (this.workspace === undefined || this.workspace === '')) {
      this.context.stderr.write('--experience-source requires --workspace\n');
      return 2;
    }
    if (
      experienceSourceRef !== undefined &&
      (this.workspace === undefined || this.workspace === '')
    ) {
      this.context.stderr.write('--experience-source-ref requires --workspace\n');
      return 2;
    }
    if (experienceLimit !== undefined && (this.workspace === undefined || this.workspace === '')) {
      this.context.stderr.write('--experience-limit requires --workspace\n');
      return 2;
    }
    if (
      experienceBudgetChars !== undefined &&
      (this.workspace === undefined || this.workspace === '')
    ) {
      this.context.stderr.write('--experience-budget-chars requires --workspace\n');
      return 2;
    }
    if (experienceTrust !== undefined && (this.workspace === undefined || this.workspace === '')) {
      this.context.stderr.write('--experience-trust requires --workspace\n');
      return 2;
    }
    if (
      experienceMaxAgeSeconds !== undefined &&
      (this.workspace === undefined || this.workspace === '')
    ) {
      this.context.stderr.write('--experience-max-age-days requires --workspace\n');
      return 2;
    }

    const prompt = await this.prompt(
      experienceSource,
      experienceSourceRef,
      experienceLimit,
      experienceBudgetChars,
      experienceTrust ?? 'trusted',
      experienceMaxAgeSeconds,
    );
    if (prompt === null) return 2;
    const timeoutMs = parseTimeoutMs(this.timeoutMs);
    if (timeoutMs === null) {
      this.context.stderr.write(
        `invalid --timeout-ms '${this.timeoutMs}' (expected positive ms)\n`,
      );
      return 2;
    }

    const openedAt = new Date().toISOString();
    await this.appendTaskStart({
      ...(this.out !== undefined ? { outputPath: this.out } : {}),
      ...(this.certificate !== undefined ? { certificatePath: this.certificate } : {}),
    });
    const startedAt = performance.now();
    const result = await this.harnessFor(this.harness, timeoutMs).dispatch({
      agent: this.target,
      prompt,
      ...(this.workspace !== undefined ? { workspace: this.workspace } : {}),
      ...(this.taskType !== undefined ? { taskType: this.taskType } : {}),
    });
    const elapsedMs = performance.now() - startedAt;
    const rc = isOk(result) ? result.value.exitCode : (result.error.exitCode ?? 1);
    let finalRc = rc;
    let output = '';
    let outputChars = 0;
    let separateVerboseObservation = false;
    let failureKind: string | undefined = isOk(result) ? undefined : result.error.kind;
    if (isOk(result)) {
      output = result.value.output;
      outputChars = output.length;
      if (this.requireOutput && output.trim().length === 0) {
        this.context.stderr.write('empty dispatch output (--require-output)\n');
        finalRc = 1;
        failureKind = 'empty-output';
      } else if (this.out !== undefined) {
        try {
          await this.fs.write(this.out, output);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.context.stderr.write(`failed to write --out ${this.out}: ${message}\n`);
          finalRc = 1;
          failureKind = 'artifact-write-failed';
        }
      }
      if (output.length > 0) {
        await writeText(this.context.stdout, output);
        separateVerboseObservation = !output.endsWith('\n');
      }
    } else {
      this.context.stderr.write(`${result.error.detail}\n`);
    }
    const closedAt = new Date().toISOString();

    if (this.certificate !== undefined) {
      const certificate = this.actionCertificate({
        openedAt,
        closedAt,
        elapsedMs,
        finalRc,
        ...(failureKind === undefined ? {} : { failureKind }),
        output,
        outputChars,
        prompt,
      });
      try {
        await this.fs.write(this.certificate, `${JSON.stringify(certificate, null, 2)}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.context.stderr.write(
          `failed to write --certificate ${this.certificate}: ${message}\n`,
        );
        finalRc = 1;
        failureKind = 'certificate-write-failed';
      }
    }

    if (this.verbose) {
      this.context.stderr.write(
        `${separateVerboseObservation ? '\n' : ''}[obs] dispatch harness=${
          this.harness
        } agent=${this.target} rc=${String(
          finalRc,
        )} took=${formatDurationMs(elapsedMs)} output_chars=${String(outputChars)}\n`,
      );
    }

    await this.appendTaskLog(finalRc, {
      elapsedMs,
      ...(failureKind !== undefined ? { errorKind: failureKind } : {}),
      outputChars,
      ...(this.out !== undefined ? { outputPath: this.out } : {}),
      ...(this.certificate !== undefined ? { certificatePath: this.certificate } : {}),
    });
    await this.appendAllocationLedger();
    return finalRc;
  }

  private async appendTaskStart(metrics: {
    readonly outputPath?: string;
    readonly certificatePath?: string;
  }): Promise<void> {
    const outputPath = metrics.outputPath === undefined ? '' : ` out=${metrics.outputPath}`;
    const certificatePath =
      metrics.certificatePath === undefined ? '' : ` cert=${metrics.certificatePath}`;
    await this.appendTaskLine(
      `dispatch → ${this.target} [${this.harness}] (status=started${outputPath}${certificatePath})`,
    );
  }

  private actionCertificate(input: {
    readonly openedAt: string;
    readonly closedAt: string;
    readonly elapsedMs: number;
    readonly finalRc: number;
    readonly failureKind?: string;
    readonly output: string;
    readonly outputChars: number;
    readonly prompt: string;
  }): ActionCertificate {
    const promptSha256 = sha256(input.prompt);
    const outputSha256 = sha256(input.output);
    const status = input.finalRc === 0 ? 'ok' : 'failed';
    const actionSeed = JSON.stringify({
      schemaVersion: 'fugunano.action-certificate.v1',
      harness: this.harness,
      target: this.target,
      promptSha256,
      outputSha256,
      rc: input.finalRc,
      taskRef: this.task ?? null,
      taskType: this.taskType ?? null,
      workspace: this.workspace ?? null,
    });
    return buildActionCertificate({
      actionId: sha256(actionSeed),
      issuedAt: input.closedAt,
      openedAt: input.openedAt,
      closedAt: input.closedAt,
      runtime: { harness: this.harness, target: this.target },
      action: {
        promptSha256,
        promptChars: input.prompt.length,
        ...(this.task === undefined ? {} : { taskRef: this.task }),
        ...(this.taskType === undefined ? {} : { taskType: this.taskType }),
        ...(this.workspace === undefined ? {} : { workspace: this.workspace }),
      },
      approvalClass: this.approvalClass as ActionApprovalClass,
      assumptions: this.certificateAssumptions,
      externalities: this.certificateExternalities,
      outcome: {
        status,
        exitCode: input.finalRc,
        durationMs: Math.max(0, Math.round(input.elapsedMs)),
        outputChars: input.outputChars,
        outputSha256,
        ...(this.out === undefined ? {} : { outputPath: this.out }),
        ...(input.failureKind === undefined ? {} : { errorKind: input.failureKind }),
      },
    });
  }

  private harnessFor(name: HarnessName, timeoutMs: number | undefined): Harness {
    const runner = new NodeCommandRunner();
    const codexArgs = this.codexClean
      ? [...CODEX_CLEAN_ARGS, ...this.harnessArgs]
      : this.harnessArgs;
    switch (name) {
      case 'fugue-cc':
        return new FugueCcHarness(runner, {
          bin: process.env.FUGUE_CC_BIN ?? 'fugue-cc',
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(this.harnessArgs.length > 0 ? { args: this.harnessArgs } : {}),
        });
      case 'codex':
        return new CodexHarness(runner, {
          bin: process.env.FUGUE_CODEX ?? 'codex',
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(codexArgs.length > 0 ? { args: codexArgs } : {}),
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

  private async prompt(
    experienceSource: ExperienceSourceKind | undefined,
    experienceSourceRef: string | undefined,
    experienceLimit: number | undefined,
    experienceBudgetChars: number | undefined,
    experienceTrust: ExperienceTrustFilter,
    experienceMaxAgeSeconds: number | undefined,
  ): Promise<string | null> {
    const body = await this.promptBody();
    if (body === null) return null;
    let prefix = '';
    if (this.skills !== undefined && this.skills.length > 0) {
      prefix += `${await new FsSkillCatalog(this.fs, await skillSources()).inject(
        splitCsv(this.skills),
      )}\n`;
    }
    if (this.workspace !== undefined && this.workspace.length > 0) {
      const query = this.experienceQuery ?? (body.trim().length > 0 ? body : undefined);
      const context = await this.workspaceContext(
        this.workspace,
        query,
        experienceSource,
        experienceSourceRef,
        experienceLimit,
        experienceBudgetChars,
        experienceTrust,
        experienceMaxAgeSeconds,
      );
      if (context === null) return null;
      prefix += context;
    }
    return `${prefix}${body}`;
  }

  private async promptBody(): Promise<string | null> {
    if (this.promptFile !== undefined) {
      const body = await this.fs.read(this.promptFile);
      if (body !== null) return body;
      this.context.stderr.write(`no prompt file ${this.promptFile}\n`);
      return null;
    }
    if (this.inlinePrompt !== undefined) return this.inlinePrompt;
    if (this.template !== undefined) {
      const file = joinPath(this.templates, `${this.template}.md`);
      const template = await this.fs.read(file);
      if (template !== null) return renderTemplate(template, varsFromSets(this.sets));
      this.context.stderr.write(`no template '${this.template}' (in ${this.templates})\n`);
      return null;
    }
    if (this.workspace !== undefined && this.workspace.length > 0) return '';
    this.context.stderr.write(
      'need --template <name> / --prompt-file <f> / --prompt <text> / --workspace <name>\n',
    );
    return null;
  }

  private async workspaceContext(
    name: string,
    query: string | undefined,
    experienceSource: ExperienceSourceKind | undefined,
    experienceSourceRef: string | undefined,
    experienceLimit: number | undefined,
    experienceBudgetChars: number | undefined,
    experienceTrust: ExperienceTrustFilter,
    experienceMaxAgeSeconds: number | undefined,
  ): Promise<string | null> {
    const store = new FsWorkspaceStore(this.fs, this.workspaces);
    const workspace = await store.get(name);
    if (workspace === null) {
      this.context.stderr.write(`no workspace '${name}' (see list)\n`);
      return null;
    }
    const methods = await new FsExperienceStore(this.fs, systemClock, this.experience).recall(
      name,
      recallOptions(
        query,
        experienceSource,
        experienceSourceRef,
        experienceLimit,
        experienceTrust,
        experienceMaxAgeSeconds,
      ),
    );
    return renderBundle(
      assembleContext({
        workspace: {
          ...workspace,
          models: await resolveModels(this.fs, workspace.models, {
            allocation: this.allocation,
            stats: this.stats,
          }),
        },
        system: await store.systemPrompt(),
        experience: packExperienceMethodsForPrompt(methods, experienceBudgetChars).rendered,
      }),
    );
  }

  private async appendTaskLog(
    rc: number,
    metrics: {
      readonly elapsedMs: number;
      readonly errorKind?: string;
      readonly outputChars: number;
      readonly outputPath?: string;
      readonly certificatePath?: string;
    },
  ): Promise<void> {
    const outputPath = metrics.outputPath === undefined ? '' : ` out=${metrics.outputPath}`;
    const certificatePath =
      metrics.certificatePath === undefined ? '' : ` cert=${metrics.certificatePath}`;
    const status = rc === 0 ? 'ok' : 'failed';
    await this.appendTaskLine(
      `dispatch → ${this.target} [${this.harness}] (status=${status} rc=${String(
        rc,
      )}${failureFields(metrics.errorKind)} took=${formatDurationMs(metrics.elapsedMs)} output_chars=${String(
        metrics.outputChars,
      )}${outputPath}${certificatePath})`,
    );
  }

  private async appendTaskLine(message: string): Promise<void> {
    if (this.task === undefined) return;
    await appendTaskAuditLine(this.fs, this.task, message);
  }

  private async appendAllocationLedger(): Promise<void> {
    if (this.taskType === undefined || this.taskType.length === 0) return;
    const current = (await this.fs.read(this.ledger)) ?? '';
    await this.fs.write(this.ledger, `${current}${this.taskType}\t${this.target}\n`);
  }
}
