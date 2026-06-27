import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join as joinPath } from 'node:path';

import { Command, Option, UsageError } from 'clipanion';

import { FsExperienceStore } from '../../adapters/experience/fs-experience-store.js';
import { CodexHarness } from '../../adapters/harness/codex-harness.js';
import { FugueCcHarness } from '../../adapters/harness/fugue-cc-harness.js';
import { OpencodeHarness } from '../../adapters/harness/opencode-harness.js';
import { FsSkillCatalog } from '../../adapters/skills/fs-skill-catalog.js';
import { FsWorkspaceStore } from '../../adapters/workspace/fs-workspace-store.js';
import {
  DEFAULT_ALLOCATION_PARAMS,
  type BenchTable,
  type StatEntry,
  type StrategyState,
} from '../../domain/allocation.js';
import { rankAgents } from '../../domain/allocation-score.js';
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

const isHarnessName = (value: string): value is HarnessName =>
  (HARNESS_NAMES as readonly string[]).includes(value);

export class DispatchCommand extends Command {
  static override paths = [['dispatch']];

  target = Option.String();
  harness = Option.String('--harness', process.env.FUGUE_DEFAULT_HARNESS ?? 'fugue-cc');
  template = Option.String('--template');
  sets = Option.Array('--set', []);
  promptFile = Option.String('--prompt-file');
  inlinePrompt = Option.String('--prompt');
  workspace = Option.String('--workspace');
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
  harnessArgs = Option.Array('--harness-arg', []);

  private readonly fs = new NodeFileSystem();

  override async execute(): Promise<number> {
    if (!isHarnessName(this.harness)) {
      this.context.stderr.write(`unknown harness '${this.harness}' (fugue-cc|codex|opencode)\n`);
      return 2;
    }

    const prompt = await this.prompt();
    if (prompt === null) return 2;
    const timeoutMs = parseTimeoutMs(this.timeoutMs);
    if (timeoutMs === null) {
      this.context.stderr.write(
        `invalid --timeout-ms '${this.timeoutMs}' (expected positive ms)\n`,
      );
      return 2;
    }

    const result = await this.harnessFor(this.harness, timeoutMs).dispatch({
      agent: this.target,
      prompt,
      ...(this.workspace !== undefined ? { workspace: this.workspace } : {}),
      ...(this.taskType !== undefined ? { taskType: this.taskType } : {}),
    });
    const rc = isOk(result) ? result.value.exitCode : (result.error.exitCode ?? 1);
    if (isOk(result)) {
      if (result.value.output.length > 0) this.context.stdout.write(result.value.output);
    } else {
      this.context.stderr.write(`${result.error.detail}\n`);
    }

    await this.appendTaskLog(rc);
    await this.appendAllocationLedger();
    return rc;
  }

  private harnessFor(name: HarnessName, timeoutMs: number | undefined): Harness {
    const runner = new NodeCommandRunner();
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
          ...(this.harnessArgs.length > 0 ? { args: this.harnessArgs } : {}),
        });
      case 'opencode':
        return new OpencodeHarness(runner, {
          bin: process.env.FUGUE_OPENCODE ?? 'opencode',
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(this.harnessArgs.length > 0 ? { args: this.harnessArgs } : {}),
        });
    }
  }

  private async prompt(): Promise<string | null> {
    let prefix = '';
    if (this.skills !== undefined && this.skills.length > 0) {
      prefix += `${await new FsSkillCatalog(this.fs, await skillSources()).inject(
        splitCsv(this.skills),
      )}\n`;
    }
    if (this.workspace !== undefined && this.workspace.length > 0) {
      const context = await this.workspaceContext(this.workspace);
      if (context === null) return null;
      prefix += context;
    }
    const body = await this.promptBody();
    return body === null ? null : `${prefix}${body}`;
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

  private async workspaceContext(name: string): Promise<string | null> {
    const store = new FsWorkspaceStore(this.fs, this.workspaces);
    const workspace = await store.get(name);
    if (workspace === null) {
      this.context.stderr.write(`no workspace '${name}' (see list)\n`);
      return null;
    }
    const methods = await new FsExperienceStore(this.fs, systemClock, this.experience).recall(
      name,
      {
        limit: 3,
      },
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
        experience: methods.map((method) => `[experience] ${method.title}\n${method.body}\n`),
      }),
    );
  }

  private async appendTaskLog(rc: number): Promise<void> {
    if (this.task === undefined) return;
    const current = await this.fs.read(this.task);
    if (current === null) return;
    await this.fs.write(
      this.task,
      `${current}- [${shanghaiTimestamp()}] dispatch → ${this.target} [${this.harness}] (rc=${String(
        rc,
      )})\n`,
    );
  }

  private async appendAllocationLedger(): Promise<void> {
    if (this.taskType === undefined || this.taskType.length === 0) return;
    const current = (await this.fs.read(this.ledger)) ?? '';
    await this.fs.write(this.ledger, `${current}${this.taskType}\t${this.target}\n`);
  }
}
