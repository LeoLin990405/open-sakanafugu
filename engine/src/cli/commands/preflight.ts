import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join as joinPath } from 'node:path';

import { Command, Option } from 'clipanion';

import { checkProviderConfig } from '../../domain/preflight-checks.js';
import type { GateCheck } from '../../domain/gate.js';
import { NodeCommandRunner } from '../../infra/node-command-runner.js';
import { NodeFileSystem } from '../../infra/node-file-system.js';
import type { CommandRunner } from '../../infra/command-runner.js';

interface MutableStatus {
  fail: boolean;
  warn: boolean;
}

interface ProbeTarget {
  readonly agent: string;
  readonly url: string;
  readonly key: string;
}

const fs = (): NodeFileSystem => new NodeFileSystem();

const shellQuote = (value: string): string => `'${value.replace(/'/gu, "'\\''")}'`;

const commandExists = async (runner: CommandRunner, command: string): Promise<boolean> => {
  try {
    return (
      (await runner.run('bash', ['-lc', `command -v ${shellQuote(command)} >/dev/null 2>&1`]))
        .code === 0
    );
  } catch {
    return false;
  }
};

const executable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const ok = (lines: string[], message: string): void => {
  lines.push(`  ✓ ${message}`);
};

const warn = (lines: string[], status: MutableStatus, message: string): void => {
  status.warn = true;
  lines.push(`  ⚠ ${message}`);
};

const fail = (lines: string[], status: MutableStatus, message: string): void => {
  status.fail = true;
  lines.push(`  ✗ ${message}`);
};

const renderConfigCheck = (check: GateCheck, lines: string[], status: MutableStatus): void => {
  if (check.name === 'no-gemini') {
    if (check.severity === 'fail') {
      fail(
        lines,
        status,
        'provider config model/url contains gemini/antigravity — violates the no-Gemini hard rule',
      );
    } else ok(lines, 'no-Gemini guard passed');
    return;
  }
  if (check.name === 'model-configured') {
    if (check.severity === 'ok') ok(lines, `provider config: ${check.detail ?? ''}`);
    else warn(lines, status, 'provider config has no model line?');
    return;
  }
  if (check.name === 'model-nonempty' && check.severity === 'fail') {
    fail(lines, status, 'provider config has an empty model value');
  }
};

const quotedValue = (line: string): string => {
  const eq = line.indexOf('=');
  if (eq === -1) return '';
  return line
    .slice(eq + 1)
    .trim()
    .replace(/^"/u, '')
    .replace(/"$/u, '');
};

const probeTargets = (configText: string): readonly ProbeTarget[] => {
  const targets: ProbeTarget[] = [];
  let agent = '';
  let url = '';
  let key = '';
  const flush = (): void => {
    if (agent.length > 0 && url.length > 0) targets.push({ agent, url, key });
  };
  for (const line of configText.split(/\r?\n/u)) {
    const section = /^\[agents\.(.+)\]/u.exec(line);
    if (section !== null) {
      flush();
      agent = section[1] ?? '';
      url = '';
      key = '';
    } else if (/^\s*url\s*=/u.test(line)) {
      url = quotedValue(line);
    } else if (/^\s*key\s*=/u.test(line)) {
      key = quotedValue(line);
    }
  }
  flush();
  return targets;
};

const probeEndpoint = async (
  runner: CommandRunner,
  target: ProbeTarget,
): Promise<string | null> => {
  try {
    const result = await runner.run('curl', [
      '-sS',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '--max-time',
      '12',
      `${target.url}/v1/models`,
      '-H',
      `x-api-key: ${target.key}`,
      '-H',
      `authorization: Bearer ${target.key}`,
    ]);
    return result.stdout.trim();
  } catch {
    return null;
  }
};

export class PreflightCommand extends Command {
  static override paths = [['preflight']];

  config = Option.String({ required: false });
  configOnly = Option.Boolean('--config-only', false);
  probe = Option.Boolean('--probe', false);
  work = Option.String('--work');
  bin = Option.String('--bin', 'fugue-cc');
  cacheScript = Option.String('--cache-script');

  override async execute(): Promise<number> {
    const runner = new NodeCommandRunner();
    const fileSystem = fs();
    const status: MutableStatus = { fail: false, warn: false };
    const lines = ['── parallel dispatch preflight ──'];

    if (!this.configOnly) await this.runDependencyChecks(lines, status, runner);

    const configPath =
      this.config ??
      (this.work !== undefined ? joinPath(this.work, '.fugue-cc/provider.config') : undefined);
    if (configPath !== undefined) {
      const configText = await fileSystem.read(configPath);
      if (configText !== null) {
        for (const check of checkProviderConfig(configText).checks) {
          renderConfigCheck(check, lines, status);
        }
        if (this.probe) await this.runProbes(configText, lines, status, runner);
      } else {
        warn(
          lines,
          status,
          'provider config not located — skip config checks (pass a path or set FUGUE_CC_WORK)',
        );
      }
    } else {
      warn(
        lines,
        status,
        'provider config not located — skip config checks (pass a path or set FUGUE_CC_WORK)',
      );
    }

    await this.runGitignoreCheck(lines, status, runner);

    lines.push(
      '',
      status.fail
        ? '✗ preflight NO-GO  (1 hard failure(s))'
        : `✓ preflight GO  (warn=${status.warn ? '1' : '0'})`,
    );
    this.context.stdout.write(`${lines.join('\n')}\n`);
    return status.fail ? 1 : 0;
  }

  private async runDependencyChecks(
    lines: string[],
    status: MutableStatus,
    runner: CommandRunner,
  ): Promise<void> {
    if (await commandExists(runner, this.bin)) ok(lines, this.bin);
    else fail(lines, status, `missing ${this.bin}`);

    if (await commandExists(runner, 'git')) ok(lines, 'git');
    else fail(lines, status, 'missing git');

    if (await commandExists(runner, 'codex')) ok(lines, 'codex (reviewer)');
    else {
      warn(
        lines,
        status,
        'no codex — review must fall back to a Chinese-model agent (cross-vendor, not Gemini)',
      );
    }

    if (await commandExists(runner, 'tmux')) ok(lines, 'tmux');
    else warn(lines, status, 'no tmux (fugue-cc panes need it)');

    if (this.cacheScript !== undefined && (await executable(this.cacheScript))) {
      ok(lines, 'fuguectl-cache.sh');
    } else if (this.cacheScript !== undefined) {
      fail(lines, status, 'missing fuguectl-cache.sh (join barrier depends on it)');
    }

    if (this.work !== undefined) {
      try {
        const ping = await runner.run(this.bin, ['ping', 'daemon'], { cwd: this.work });
        if (/^mount_state:\s*mounted/mu.test(ping.stdout))
          ok(lines, `provider mounted (${this.work})`);
        else
          fail(
            lines,
            status,
            `provider not mounted/unreachable (${this.work}) — cd project && fugue-cc to mount (or fuguectl fleet up)`,
          );
      } catch {
        fail(
          lines,
          status,
          `provider not mounted/unreachable (${this.work}) — cd project && fugue-cc to mount (or fuguectl fleet up)`,
        );
      }
    } else {
      warn(lines, status, 'FUGUE_CC_WORK unset — skip provider mount check');
    }
  }

  private async runProbes(
    configText: string,
    lines: string[],
    status: MutableStatus,
    runner: CommandRunner,
  ): Promise<void> {
    lines.push('  endpoint liveness probe:');
    for (const target of probeTargets(configText)) {
      if (target.key.length === 0 || target.key.startsWith('<')) {
        warn(lines, status, `probe ${target.agent}: no real key, skip`);
        continue;
      }
      const code = await probeEndpoint(runner, target);
      if (code === '200') ok(lines, `probe ${target.agent}: 200 alive`);
      else
        fail(
          lines,
          status,
          `probe ${target.agent}: HTTP ${code ?? 'timeout'} (endpoint/key error)`,
        );
    }
  }

  private async runGitignoreCheck(
    lines: string[],
    status: MutableStatus,
    runner: CommandRunner,
  ): Promise<void> {
    if (this.work === undefined) return;
    try {
      if ((await runner.run('git', ['-C', this.work, 'rev-parse', '--git-dir'])).code !== 0) return;
      const ignored = await runner.run('git', [
        '-C',
        this.work,
        'check-ignore',
        '-q',
        '.fugue-cc/provider.config',
      ]);
      if (ignored.code === 0)
        ok(lines, ".fugue-cc/ gitignored (integrate won't be polluted by worktree)");
      else
        warn(
          lines,
          status,
          `.fugue-cc/ not gitignored — on integrate the main repo git may absorb the worktree(embedded repo); fix: echo '.fugue-cc/' >> ${this.work}/.gitignore`,
        );
    } catch {
      return;
    }
  }
}
