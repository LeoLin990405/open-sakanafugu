import { chmod, cp, readFile as readNodeFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  delimiter as pathDelimiter,
  dirname,
  join as joinPath,
  relative,
  resolve,
  sep as pathSeparator,
} from 'node:path';

import { Command, Option } from 'clipanion';

import {
  parseProviderInstallPath,
  parseProviderVersion,
  RuntimeSync,
} from '../../adapters/runtime/runtime-sync.js';
import type { CommandRunner } from '../../infra/command-runner.js';
import type { FileSystem } from '../../infra/file-system.js';
import { NodeCommandRunner } from '../../infra/node-command-runner.js';
import { NodeFileSystem } from '../../infra/node-file-system.js';
import { defaultStateDir, fuguectlFile, fuguectlScript } from '../default-paths.js';

const fs = (): NodeFileSystem => new NodeFileSystem();

const nonEmptyEnv = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

const stampPath = (state: string): string => joinPath(state, 'runtime-version');

const defaultRepoSkillPath = (): string =>
  nonEmptyEnv(process.env.FUGUNANO_REPO_SKILL) ??
  nonEmptyEnv(process.env.FUGUE_REPO_SKILL) ??
  fuguectlFile(import.meta.url, 'SKILL.md');

const canonicalInstalledSkillPath = (): string =>
  joinPath(homedir(), '.claude', 'skills', 'fugunano', 'SKILL.md');

const legacyInstalledSkillPath = (): string =>
  joinPath(homedir(), '.claude', 'skills', 'fugue', 'SKILL.md');

const envInstalledSkillPath = (): string | undefined =>
  nonEmptyEnv(process.env.FUGUNANO_SKILL) ??
  nonEmptyEnv(process.env.FUGUE_WORKFLOW_SKILL) ??
  nonEmptyEnv(process.env.FUGUE_SKILL);

const defaultInstalledSkillPath = (): string =>
  envInstalledSkillPath() ?? canonicalInstalledSkillPath();

const splitPathList = (value: string): string[] =>
  value
    .split(pathDelimiter)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const defaultAliasSkillPaths = (): string[] => {
  const configured = nonEmptyEnv(process.env.FUGUNANO_ALIAS_SKILLS);
  if (configured !== undefined) return splitPathList(configured);
  const primary = envInstalledSkillPath() ?? canonicalInstalledSkillPath();
  return resolve(primary) === resolve(canonicalInstalledSkillPath())
    ? [legacyInstalledSkillPath()]
    : [];
};

const providerOutput = async (runner: CommandRunner, bin: string): Promise<string> => {
  try {
    const result = await runner.run(bin, ['version']);
    return result.code === 0 ? result.stdout : '';
  } catch {
    return '';
  }
};

const defaultInstallPath = (): string =>
  joinPath(process.env.HOME ?? '', '.local/share/codex-dual');

const resolveInstallPath = (output: string, override: string | undefined): string =>
  override ?? parseProviderInstallPath(output) ?? defaultInstallPath();

const graftingPresent = async (fileSystem: FileSystem, installPath: string): Promise<boolean> =>
  (await fileSystem.read(joinPath(installPath, 'lib/provider_profiles/api_shortcuts.py'))) !== null;

const existingFile = async (fileSystem: FileSystem, path: string): Promise<boolean> =>
  (await fileSystem.read(path)) !== null;

const nonEmpty = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0;

const indent = (text: string): string =>
  text
    .replace(/\s+$/u, '')
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => `    ${line}`)
    .join('\n');

interface WorkflowSkillStatus {
  readonly repoSkill: string;
  readonly installedSkill: string;
  readonly repoExists: boolean;
  readonly installedExists: boolean;
  readonly driverExists: boolean;
  readonly legacyShellFiles: readonly string[];
  readonly repoRootPointerOk: boolean;
  readonly bundleFilesMatch: boolean;
  readonly targetOnlyFiles: readonly string[];
  readonly upToDate: boolean;
}

const isLegacyShellWrapper = (file: string): boolean => /^fuguectl.*\.sh$/u.test(file);

const chmodExecutable = async (path: string): Promise<void> => {
  try {
    await chmod(path, 0o755);
  } catch {
    // Best-effort parity with scripts/install-skill.ts. Missing optional files are not fatal.
  }
};

const skillDir = (skill: string): string => dirname(resolve(skill));

const repoRootForSkill = (repoSkill: string): string => {
  const sourceDir = skillDir(repoSkill);
  return sourceDir.endsWith(`${pathSeparator}orchestration${pathSeparator}fuguectl`)
    ? dirname(dirname(sourceDir))
    : sourceDir;
};

const repoRootPointerPath = (installedSkill: string): string =>
  joinPath(skillDir(installedSkill), '.fugunano-repo-root');

const listBundleFiles = async (dir: string): Promise<readonly string[]> => {
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const path = joinPath(current, entry.name);
        if (entry.isDirectory()) {
          await visit(path);
          return;
        }
        if (entry.isFile()) files.push(relative(dir, path));
      }),
    );
  };
  await visit(dir);
  return files.sort();
};

const filesEqual = async (left: string, right: string): Promise<boolean> => {
  try {
    const [leftBytes, rightBytes] = await Promise.all([readNodeFile(left), readNodeFile(right)]);
    return leftBytes.equals(rightBytes);
  } catch {
    return false;
  }
};

const ignoredTargetOnlyFile = (file: string): boolean =>
  file === '.fugunano-repo-root' || file === '.DS_Store';

interface BundleFileComparison {
  readonly matches: boolean;
  readonly targetOnlyFiles: readonly string[];
}

const compareBundleFiles = async (
  repoSkill: string,
  installedSkill: string,
): Promise<BundleFileComparison> => {
  const sourceDir = skillDir(repoSkill);
  const targetDir = skillDir(installedSkill);
  const sourceFiles = await listBundleFiles(sourceDir);
  const targetFiles = await listBundleFiles(targetDir);
  const sourceSet = new Set(sourceFiles);
  const targetOnlyFiles = targetFiles.filter(
    (file) => !sourceSet.has(file) && !ignoredTargetOnlyFile(file),
  );
  if (sourceFiles.length === 0 || targetOnlyFiles.length > 0) {
    return { matches: false, targetOnlyFiles };
  }
  const matches = await Promise.all(
    sourceFiles.map(async (file) =>
      filesEqual(joinPath(sourceDir, file), joinPath(targetDir, file)),
    ),
  );
  return { matches: matches.every(Boolean), targetOnlyFiles };
};

const syncWorkflowBundle = async (repoSkill: string, installedSkill: string): Promise<void> => {
  const sourceDir = skillDir(repoSkill);
  const targetDir = skillDir(installedSkill);
  await cp(sourceDir, targetDir, { recursive: true, force: true });
  await fs().write(repoRootPointerPath(installedSkill), `${repoRootForSkill(repoSkill)}\n`);
  const entries = await fs().list(targetDir);
  await Promise.all(
    entries.filter(isLegacyShellWrapper).map(async (entry) => {
      await rm(joinPath(targetDir, entry), { force: true });
    }),
  );
  await Promise.all(
    entries
      .filter((entry) => entry === 'fuguectl' || /^fuguectl-[a-z]+$/u.test(entry))
      .map(async (entry) => {
        await chmodExecutable(joinPath(targetDir, entry));
      }),
  );
  const targetOnlyFiles = (await compareBundleFiles(repoSkill, installedSkill)).targetOnlyFiles;
  await Promise.all(
    targetOnlyFiles.map(async (file) => {
      await rm(joinPath(targetDir, file), { force: true });
    }),
  );
};

const workflowSkillStatus = async (
  fileSystem: FileSystem,
  repoSkill: string,
  installedSkill: string,
): Promise<WorkflowSkillStatus> => {
  const repo = await fileSystem.read(repoSkill);
  const installed = await fileSystem.read(installedSkill);
  const installedDir = skillDir(installedSkill);
  const installedDriver = await fileSystem.read(joinPath(installedDir, 'fuguectl'));
  const expectedRepoRoot = repoRootForSkill(repoSkill);
  const pointerRequired = skillDir(repoSkill) !== installedDir;
  const repoRootPointer = await fileSystem.read(repoRootPointerPath(installedSkill));
  const repoRootPointerOk = !pointerRequired || repoRootPointer?.trim() === expectedRepoRoot;
  const bundleComparison = await compareBundleFiles(repoSkill, installedSkill);
  const legacyShellFiles = (await fileSystem.list(installedDir)).filter(isLegacyShellWrapper);
  return {
    repoSkill,
    installedSkill,
    repoExists: repo !== null,
    installedExists: installed !== null,
    driverExists: installedDriver !== null,
    legacyShellFiles,
    repoRootPointerOk,
    bundleFilesMatch: bundleComparison.matches,
    targetOnlyFiles: bundleComparison.targetOnlyFiles,
    upToDate:
      repo !== null &&
      installed !== null &&
      installedDriver !== null &&
      bundleComparison.matches &&
      repoRootPointerOk &&
      legacyShellFiles.length === 0,
  };
};

const workflowSkillCheckLinesForStatus = (
  status: WorkflowSkillStatus,
  repoSkill: string,
  installedSkill: string,
  driverName: string,
): readonly string[] => {
  if (!status.repoExists) return [`  ⚠ workflow bundle source missing (${repoSkill})`];
  if (status.upToDate) return [`  ✓ workflow bundle up-to-date (${skillDir(installedSkill)})`];
  if (!status.installedExists) {
    return [
      `  → workflow bundle not installed (${skillDir(installedSkill)}): run '${driverName} runtime adapt --apply' to sync`,
    ];
  }
  if (!status.driverExists || status.legacyShellFiles.length > 0) {
    const reason = !status.driverExists
      ? 'missing fuguectl entrypoint'
      : `legacy shell wrappers present (${status.legacyShellFiles.length})`;
    return [
      `  → workflow bundle drift (${skillDir(installedSkill)}; ${reason}): run '${driverName} runtime adapt --apply' to sync`,
    ];
  }
  if (!status.repoRootPointerOk) {
    return [
      `  → workflow bundle drift (${skillDir(installedSkill)}; missing repo root pointer): run '${driverName} runtime adapt --apply' to sync`,
    ];
  }
  if (status.targetOnlyFiles.length > 0) {
    return [
      `  → workflow bundle drift (${skillDir(installedSkill)}; target-only files present (${String(status.targetOnlyFiles.length)})): run '${driverName} runtime adapt --apply' to sync`,
    ];
  }
  if (!status.bundleFilesMatch) {
    return [
      `  → workflow bundle drift (${skillDir(installedSkill)}; bundle file mismatch): run '${driverName} runtime adapt --apply' to sync`,
    ];
  }
  return [
    `  → workflow bundle drift (${skillDir(installedSkill)}): run '${driverName} runtime adapt --apply' to sync`,
  ];
};

const uniqueSkillTargets = (primary: string, aliases: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const target of [primary, ...aliases]) {
    const key = resolve(target);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  return targets;
};

const workflowSkillStatuses = async (
  fileSystem: FileSystem,
  repoSkill: string,
  primarySkill: string,
  aliasSkills: readonly string[],
): Promise<readonly WorkflowSkillStatus[]> =>
  Promise.all(
    uniqueSkillTargets(primarySkill, aliasSkills).map((target) =>
      workflowSkillStatus(fileSystem, repoSkill, target),
    ),
  );

const workflowSkillCheckLinesForStatuses = (
  statuses: readonly WorkflowSkillStatus[],
  repoSkill: string,
  driverName: string,
): readonly string[] =>
  statuses.flatMap((status) =>
    workflowSkillCheckLinesForStatus(status, repoSkill, status.installedSkill, driverName),
  );

const workflowBundlesAdaptLines = async (
  fileSystem: FileSystem,
  repoSkill: string,
  primarySkill: string,
  aliasSkills: readonly string[],
  apply: boolean,
): Promise<readonly string[]> => {
  const targets = uniqueSkillTargets(primarySkill, aliasSkills);
  const lines = await Promise.all(
    targets.map((target) => workflowBundleAdaptLines(fileSystem, repoSkill, target, apply)),
  );
  return lines.flat();
};

const workflowBundleAdaptLines = async (
  fileSystem: FileSystem,
  repoSkill: string,
  installedSkill: string,
  apply: boolean,
): Promise<readonly string[]> => {
  const repo = await fileSystem.read(repoSkill);
  if (repo === null) return [`  ✗ workflow bundle source missing (${repoSkill})`];

  const status = await workflowSkillStatus(fileSystem, repoSkill, installedSkill);
  if (status.upToDate && !apply) {
    return [`  ✓ workflow bundle up-to-date (${skillDir(installedSkill)})`];
  }

  if (!apply) {
    const verb = status.installedExists ? 'refresh' : 'install';
    return [
      `  [dry] would ${verb} workflow bundle (${skillDir(repoSkill)} → ${skillDir(installedSkill)})`,
    ];
  }

  await syncWorkflowBundle(repoSkill, installedSkill);
  return [`  ✓ synced workflow bundle (${skillDir(repoSkill)} → ${skillDir(installedSkill)})`];
};

abstract class RuntimeCommand extends Command {
  bin = Option.String('--bin', process.env.FUGUE_CC_BIN ?? 'fugue-cc');
  state = Option.String('--state', defaultStateDir());
  install = Option.String('--install');
  driverName = Option.String('--driver-name', process.env.FUGUE_DRIVER_NAME ?? 'fuguectl');
  repoSkill = Option.String('--repo-skill', defaultRepoSkillPath());
  skill = Option.String('--skill', defaultInstalledSkillPath());
  aliasSkills = Option.Array('--alias-skill', defaultAliasSkillPaths());

  protected installOverride(): string | undefined {
    return this.install ?? nonEmptyEnv(process.env.FUGUE_CC_INSTALL);
  }

  protected sync(fileSystem: FileSystem, runner: CommandRunner): RuntimeSync {
    return new RuntimeSync(fileSystem, runner, {
      bin: this.bin,
      stampPath: stampPath(this.state),
    });
  }
}

export class RuntimeCheckCommand extends RuntimeCommand {
  static override paths = [['runtime', 'check']];

  strict = Option.Boolean('--strict', false);

  override async execute(): Promise<number> {
    const fileSystem = fs();
    const runner = new NodeCommandRunner();
    const output = await providerOutput(runner, this.bin);
    const current = parseProviderVersion(output);
    const last = (await fileSystem.read(stampPath(this.state)))?.trim() ?? '(none)';
    const workflowStatuses = await workflowSkillStatuses(
      fileSystem,
      this.repoSkill,
      this.skill,
      this.aliasSkills,
    );
    const workflowLines = workflowSkillCheckLinesForStatuses(
      workflowStatuses,
      this.repoSkill,
      this.driverName,
    );
    const strictExitCode =
      this.strict && workflowStatuses.some((status) => !status.upToDate) ? 1 : 0;
    const lines = [
      `fugue-cc provider current: ${current.length > 0 ? current : 'unknown'}   last recorded: ${last}`,
    ];
    if (current.length === 0) {
      lines.push('  ⚠ cannot get fugue-cc provider version (fugue-cc not installed?)');
      lines.push(...workflowLines);
      this.context.stdout.write(`${lines.join('\n')}\n`);
      return strictExitCode;
    }
    if (current !== last) {
      lines.push(
        `  → version drift (${last} → ${current}): run '${this.driverName} runtime adapt --apply' to adapt`,
      );
    } else {
      lines.push('  ✓ no drift');
    }

    const installPath = resolveInstallPath(output, this.installOverride());
    if (await graftingPresent(fileSystem, installPath)) {
      lines.push(`  ✓ grafting api_shortcuts.py present (${installPath})`);
    } else {
      lines.push(
        '  ✗ grafting api_shortcuts.py is gone — claude+url grafting may break, check the new fugue-cc version manually',
      );
    }
    lines.push(...workflowLines);
    this.context.stdout.write(`${lines.join('\n')}\n`);
    return strictExitCode;
  }
}

export class RuntimeAdaptCommand extends RuntimeCommand {
  static override paths = [['runtime', 'adapt']];

  apply = Option.Boolean('--apply', false);
  work = Option.String('--work');
  claude = Option.String('--claude');
  preflightScript = Option.String(
    '--preflight-script',
    fuguectlScript(import.meta.url, 'preflight'),
  );

  override async execute(): Promise<number> {
    const fileSystem = fs();
    const runner = new NodeCommandRunner();
    const output = await providerOutput(runner, this.bin);
    const current = parseProviderVersion(output);
    const last = (await fileSystem.read(stampPath(this.state)))?.trim() ?? '';
    const lines = [
      `── fugue-cc runtime adapt (${last.length > 0 ? last : 'none'} → ${current.length > 0 ? current : 'unknown'})${this.apply ? '' : ' [dry-run]'} ──`,
    ];
    if (current.length === 0) {
      lines.push(
        '  ⚠ cannot get fugue-cc provider version — skipped provider restart and version stamp',
      );
      lines.push(
        ...(await workflowBundlesAdaptLines(
          fileSystem,
          this.repoSkill,
          this.skill,
          this.aliasSkills,
          this.apply,
        )),
      );
      this.context.stdout.write(`${lines.join('\n')}\n`);
      return 2;
    }

    const installPath = resolveInstallPath(output, this.installOverride());
    if (await graftingPresent(fileSystem, installPath)) {
      lines.push('  ✓ grafting api_shortcuts.py present');
    } else {
      lines.push(
        '  ✗ grafting dependency lost — new fugue-cc may have changed provider_profiles, grafting scheme needs manual adaptation',
      );
    }

    lines.push(
      ...(await workflowBundlesAdaptLines(
        fileSystem,
        this.repoSkill,
        this.skill,
        this.aliasSkills,
        this.apply,
      )),
    );

    const work = this.work ?? nonEmptyEnv(process.env.FUGUE_CC_WORK);
    const claude = this.claude ?? nonEmptyEnv(process.env.FUGUE_CC_CLAUDE);
    const projects = [work, claude].filter(nonEmpty);
    for (const project of projects) {
      if (this.apply) {
        try {
          const killed = await runner.run(this.bin, ['kill'], { cwd: project });
          if (killed.code === 0) {
            lines.push(
              `  ✓ stopped provider daemon @ ${project} — next 'cd ${project} && fugue-cc' starts it and loads new code (claude-only uses env CLAUDE_START_CMD=claude)`,
            );
          }
        } catch {
          // Match the shell behavior: a missing project or kill failure is non-fatal here.
        }
      } else {
        lines.push(
          `  [dry] need to restart provider daemon @ ${project} (provider update does not auto-restart, old code keeps running)`,
        );
      }
    }
    if (projects.length === 0) {
      lines.push(
        '  ⚠ FUGUE_CC_WORK/FUGUE_CC_CLAUDE unset — skip provider restart (set them and re-run)',
      );
    }

    lines.push(...(await this.runPreflightIfNeeded(fileSystem, runner, work)));

    if (this.apply) {
      await this.sync(fileSystem, runner).record(current);
      lines.push(`  ✓ recorded ${current} → ${stampPath(this.state)}`);
    } else {
      lines.push('  [dry] stamp not written; add --apply to commit');
    }
    this.context.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }

  private async runPreflightIfNeeded(
    fileSystem: FileSystem,
    runner: CommandRunner,
    work: string | undefined,
  ): Promise<readonly string[]> {
    if (!this.apply || work === undefined) return [];
    const config = joinPath(work, '.fugue-cc/provider.config');
    if (!(await existingFile(fileSystem, config))) return [];
    const lines = ['  config validation (legacy CLI + sound):'];
    try {
      const result = await runner.run(this.preflightScript, ['--config-only', config]);
      const output = indent(`${result.stdout}${result.stderr}`);
      if (output.length > 0) lines.push(output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`    ${message}`);
    }
    return lines;
  }
}
