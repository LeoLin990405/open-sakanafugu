import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join as joinPath } from 'node:path';

import { Command, Option } from 'clipanion';

import { checkProviderConfig } from '../../domain/preflight-checks.js';
import type { GateCheck } from '../../domain/gate.js';
import type { HarnessName } from '../../domain/ports/harness.js';
import { NodeCommandRunner } from '../../infra/node-command-runner.js';
import { NodeFileSystem } from '../../infra/node-file-system.js';
import type { CommandRunner } from '../../infra/command-runner.js';
import { fuguectlScript } from '../default-paths.js';

type PreflightHarness = HarnessName | 'all';

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

const nonEmptyEnv = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

const PREFLIGHT_HARNESSES: readonly PreflightHarness[] = ['fugue-cc', 'codex', 'opencode', 'all'];

const parseHarness = (value: string): PreflightHarness | null =>
  PREFLIGHT_HARNESSES.includes(value as PreflightHarness) ? (value as PreflightHarness) : null;

const includesFugueCc = (harness: PreflightHarness): boolean =>
  harness === 'fugue-cc' || harness === 'all';

const includesCodex = (harness: PreflightHarness): boolean =>
  harness === 'codex' || harness === 'all';

const includesOpencode = (harness: PreflightHarness): boolean =>
  harness === 'opencode' || harness === 'all';

const trimNonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

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

const cliExists = async (runner: CommandRunner, command: string): Promise<boolean> =>
  command.includes('/') ? executable(command) : commandExists(runner, command);

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
  if (check.name === 'legacy-gemini-cli') {
    if (check.severity === 'fail') {
      fail(
        lines,
        status,
        'provider config points at the retired Gemini CLI — use agy/Antigravity or another configured runtime',
      );
    } else ok(lines, 'legacy Gemini CLI guard passed');
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
  harness = Option.String('--harness', process.env.FUGUE_PREFLIGHT_HARNESS ?? 'fugue-cc');
  work = Option.String('--work');
  bin = Option.String('--bin', process.env.FUGUE_CC_BIN ?? 'fugue-cc');
  codexBin = Option.String('--codex-bin', process.env.FUGUE_CODEX ?? 'codex');
  opencodeBin = Option.String('--opencode-bin', process.env.FUGUE_OPENCODE ?? 'opencode');
  model = Option.String('--model');
  target = Option.String('--target');
  cacheScript = Option.String('--cache-script', fuguectlScript(import.meta.url, 'cache'));

  override async execute(): Promise<number> {
    const harness = parseHarness(this.harness);
    if (harness === null) {
      this.context.stderr.write(
        `unknown --harness '${this.harness}' (fugue-cc|codex|opencode|all)\n`,
      );
      return 1;
    }

    const runner = new NodeCommandRunner();
    const fileSystem = fs();
    const status: MutableStatus = { fail: false, warn: false };
    const lines = [`── parallel dispatch preflight (harness=${harness}) ──`];
    const work = this.work ?? nonEmptyEnv(process.env.FUGUE_CC_WORK);
    const checkProvider = this.configOnly || this.config !== undefined || includesFugueCc(harness);
    const requestedModel = trimNonEmpty(this.model);
    const requestedTarget = trimNonEmpty(this.target);
    const modelToCheck = this.resolveRequestedModel(requestedModel, requestedTarget, lines, status);

    if (!this.configOnly) await this.runDependencyChecks(lines, status, runner, work, harness);
    if (!this.configOnly && includesOpencode(harness) && modelToCheck !== undefined) {
      await this.runOpencodeModelCheck(modelToCheck, lines, status, runner);
    }

    const configPath =
      this.config ?? (work !== undefined ? joinPath(work, '.fugue-cc/provider.config') : undefined);
    if (checkProvider && configPath !== undefined) {
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
    } else if (checkProvider) {
      warn(
        lines,
        status,
        'provider config not located — skip config checks (pass a path or set FUGUE_CC_WORK)',
      );
    }

    if (includesFugueCc(harness) || this.configOnly) {
      await this.runGitignoreCheck(lines, status, runner, work);
    }

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
    work: string | undefined,
    harness: PreflightHarness,
  ): Promise<void> {
    if (includesFugueCc(harness)) {
      if (await cliExists(runner, this.bin)) ok(lines, this.bin);
      else fail(lines, status, `missing ${this.bin}`);
    }

    if (await commandExists(runner, 'git')) ok(lines, 'git');
    else fail(lines, status, 'missing git');

    if (includesCodex(harness)) {
      if (await cliExists(runner, this.codexBin)) ok(lines, this.codexBin);
      else fail(lines, status, `missing ${this.codexBin}`);
    } else {
      if (await cliExists(runner, this.codexBin)) ok(lines, `${this.codexBin} (reviewer)`);
      else {
        warn(
          lines,
          status,
          'no codex — review should fall back to another independent configured reviewer',
        );
      }
    }

    if (includesOpencode(harness)) {
      if (await cliExists(runner, this.opencodeBin)) ok(lines, this.opencodeBin);
      else fail(lines, status, `missing ${this.opencodeBin}`);
    }

    if (includesFugueCc(harness)) {
      if (await commandExists(runner, 'tmux')) ok(lines, 'tmux');
      else warn(lines, status, 'no tmux (fugue-cc panes need it)');
    }

    if (await executable(this.cacheScript)) {
      ok(lines, 'fuguectl-cache');
    } else {
      fail(lines, status, 'missing fuguectl-cache (join barrier depends on it)');
    }

    if (includesFugueCc(harness) && work !== undefined) {
      try {
        const ping = await runner.run(this.bin, ['ping', 'daemon'], { cwd: work });
        if (/^mount_state:\s*mounted/mu.test(ping.stdout)) ok(lines, `provider mounted (${work})`);
        else
          fail(
            lines,
            status,
            `provider not mounted/unreachable (${work}) — cd project && fugue-cc to mount (or fuguectl fleet up)`,
          );
      } catch {
        fail(
          lines,
          status,
          `provider not mounted/unreachable (${work}) — cd project && fugue-cc to mount (or fuguectl fleet up)`,
        );
      }
    } else if (includesFugueCc(harness)) {
      warn(lines, status, 'FUGUE_CC_WORK unset — skip provider mount check');
    }
  }

  private resolveRequestedModel(
    model: string | undefined,
    target: string | undefined,
    lines: string[],
    status: MutableStatus,
  ): string | undefined {
    if (model !== undefined && target !== undefined && model !== target) {
      fail(lines, status, `--model and --target disagree (${model} != ${target})`);
      return undefined;
    }
    return model ?? target;
  }

  private async runOpencodeModelCheck(
    model: string,
    lines: string[],
    status: MutableStatus,
    runner: CommandRunner,
  ): Promise<void> {
    try {
      const result = await runner.run(this.opencodeBin, ['models']);
      if (result.code !== 0) {
        fail(lines, status, `opencode models failed; cannot validate ${model}`);
        return;
      }
      const models = new Set(
        result.stdout
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      );
      if (models.has(model)) {
        ok(lines, `opencode model available (${model})`);
        return;
      }
      fail(lines, status, `opencode model not found (${model}); run: ${this.opencodeBin} models`);
    } catch {
      fail(lines, status, `opencode models failed; cannot validate ${model}`);
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
    work: string | undefined,
  ): Promise<void> {
    if (work === undefined) return;
    try {
      if ((await runner.run('git', ['-C', work, 'rev-parse', '--git-dir'])).code !== 0) return;
      const ignored = await runner.run('git', [
        '-C',
        work,
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
          `.fugue-cc/ not gitignored — on integrate the main repo git may absorb the worktree(embedded repo); fix: echo '.fugue-cc/' >> ${work}/.gitignore`,
        );
    } catch {
      return;
    }
  }
}
