import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join as joinPath } from 'node:path';

import { Command, Option } from 'clipanion';

import { NodeCommandRunner } from '../../infra/node-command-runner.js';

const MOUNTED = /^mount_state:\s*mounted/mu;

const defaultWork = (): string =>
  process.env.FUGUE_CC_WORK ?? joinPath(joinPath(homedir(), 'Projects'), 'fugue-cc-test');

const defaultClaudeProject = (): string =>
  process.env.FUGUE_CC_CLAUDE ?? joinPath(joinPath(homedir(), 'Projects'), 'fugue-cc-claude-only');

const defaultClaudePrefix = (): string =>
  process.env.FUGUE_CC_CLAUDE_PREFIX ?? 'CLAUDE_START_CMD=claude ';

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const stripArgs = (): string =>
  Object.keys(process.env)
    .filter((key) => key.startsWith('CLAUDE_CODE'))
    .sort()
    .map((key) => `-u ${key}`)
    .join(' ');

export class FleetCommand extends Command {
  static override paths = [['fleet']];

  args = Option.Proxy();

  private readonly runner = new NodeCommandRunner();
  private readonly bin = process.env.FUGUE_CC_BIN ?? 'fugue-cc';
  private readonly work = defaultWork();
  private readonly claudeProject = defaultClaudeProject();
  private readonly claudePrefix = defaultClaudePrefix();
  private readonly cliName = process.env.FUGUE_DRIVER_NAME ?? 'fuguectl';
  private readonly launcher =
    process.env.FUGUE_FLEET_LAUNCHER ??
    joinPath(process.cwd(), 'orchestration/fuguectl/fleet-launch.py');

  override async execute(): Promise<number> {
    const [sub, ...rest] = this.args;
    switch (sub) {
      case undefined:
      case '-h':
      case '--help':
        return this.renderFleetHelp();
      case 'status':
        return await this.status(rest);
      case 'up':
        return await this.up(rest);
      case 'down':
        return await this.down(rest);
      default:
        this.context.stderr.write(`unknown subcommand '${sub}' (status|up|down)\n`);
        return 2;
    }
  }

  private renderFleetHelp(): number {
    this.context.stdout.write(
      [
        'fugue fleet status [proj...]',
        'fugue fleet up [--dry] [--pty] [proj...]',
        'fugue fleet down [proj...]',
        '',
      ].join('\n'),
    );
    return 0;
  }

  private defaultProjects(): readonly string[] {
    return [this.work, this.claudeProject];
  }

  private prefixFor(project: string): string {
    return project === this.claudeProject ? this.claudePrefix : '';
  }

  private async hasProvider(project: string): Promise<boolean> {
    return await pathExists(joinPath(project, '.fugue-cc'));
  }

  private async isReady(project: string): Promise<boolean> {
    try {
      const result = await this.runner.run(this.bin, ['ping', 'daemon'], { cwd: project });
      return result.code === 0 && MOUNTED.test(result.stdout);
    } catch {
      return false;
    }
  }

  private async status(projects: readonly string[]): Promise<number> {
    const projs = projects.length === 0 ? this.defaultProjects() : projects;
    let ready = 0;
    for (const project of projs) {
      if (!(await this.hasProvider(project))) {
        this.context.stdout.write(`  —  ${project} (no .fugue-cc)\n`);
        continue;
      }
      if (await this.isReady(project)) {
        this.context.stdout.write(`  ✓ ready   ${project}\n`);
        ready += 1;
      } else {
        this.context.stdout.write(`  ✗ down    ${project}  → ${this.cliName} fleet up\n`);
      }
    }
    return ready > 0 ? 0 : 1;
  }

  private async up(args: readonly string[]): Promise<number> {
    let dry = false;
    let pty = false;
    const projects: string[] = [];
    for (const arg of args) {
      if (arg === '--dry') dry = true;
      else if (arg === '--pty') pty = true;
      else projects.push(arg);
    }

    const projs = projects.length === 0 ? this.defaultProjects() : projects;
    const stripped = stripArgs();
    for (const project of projs) {
      if (!(await this.hasProvider(project))) {
        this.context.stdout.write(`  ✗ ${project} no .fugue-cc, skip\n`);
        continue;
      }
      if (await this.isReady(project)) {
        this.context.stdout.write(`  ✓ already running: ${project}\n`);
        continue;
      }
      const prefix = this.prefixFor(project);
      if (pty) {
        const command =
          prefix.length > 0
            ? ['python3', this.launcher, project, 'env', prefix.trimEnd(), this.bin, '-s']
            : ['python3', this.launcher, project, this.bin, '-s'];
        if (dry) {
          this.context.stdout.write(`  [dry-pty] ${command.join(' ')}\n`);
          continue;
        }
        await this.startPty(command, project);
      } else {
        const session = `fugue-cc-${basename(project)}`;
        const envParts = ['env'];
        if (stripped.length > 0) envParts.push(stripped);
        if (prefix.length > 0) envParts.push(prefix.trimEnd());
        envParts.push(this.bin, '-s');
        const command = envParts.join(' ');
        if (dry) {
          this.context.stdout.write(
            `  [dry] tmux new-session -d -s ${session} -c ${project} "${command}"\n`,
          );
          continue;
        }
        await this.startTmux(session, project, command);
      }
    }

    if (dry) return 0;
    this.context.stdout.write('  —— self-verify after a few seconds ——\n');
    await sleep(5000);
    const status = await this.status(projs);
    if (status !== 0) {
      this.context.stdout.write('  ⚠ still not ready.\n');
      if (!pty)
        this.context.stdout.write(
          `    detached tmux did not attach → try pty.fork fallback: ${this.cliName} fleet up --pty\n`,
        );
      this.context.stdout.write('    or do it manually in a real terminal:\n');
      for (const project of projs) {
        if (await this.hasProvider(project)) {
          this.context.stdout.write(
            `      cd ${project} && ${this.prefixFor(project)}${this.bin} -s\n`,
          );
        }
      }
    }
    return 0;
  }

  private async startPty(command: readonly string[], project: string): Promise<void> {
    try {
      const result = await this.runner.run(command[0] ?? 'python3', command.slice(1));
      this.context.stdout.write(
        result.code === 0
          ? `  ▸ pty.fork started: ${project}\n`
          : `  ✗ pty.fork start failed: ${project}\n`,
      );
    } catch {
      this.context.stderr.write('no python3\n');
    }
  }

  private async startTmux(session: string, project: string, command: string): Promise<void> {
    try {
      const result = await this.runner.run('tmux', [
        'new-session',
        '-d',
        '-s',
        session,
        '-c',
        project,
        command,
      ]);
      this.context.stdout.write(
        result.code === 0
          ? `  ▸ detached tmux '${session}' started: ${project}\n`
          : `  ✗ tmux start failed: ${project}\n`,
      );
    } catch {
      this.context.stderr.write('no tmux\n');
    }
  }

  private async down(projects: readonly string[]): Promise<number> {
    const projs = projects.length === 0 ? this.defaultProjects() : projects;
    for (const project of projs) {
      if (!(await this.hasProvider(project))) continue;
      try {
        const result = await this.runner.run(this.bin, ['kill'], { cwd: project });
        this.context.stdout.write(
          result.code === 0 ? `  ✓ killed: ${project}\n` : `  — not running: ${project}\n`,
        );
      } catch {
        this.context.stdout.write(`  — not running: ${project}\n`);
      }
    }
    return 0;
  }
}
