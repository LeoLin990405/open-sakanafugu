import { Command, Option } from 'clipanion';

import { runRecon } from '../../adapters/doctor/recon.js';
import type { DoctorReport } from '../../domain/doctor.js';
import { recommend } from '../../domain/doctor.js';
import { NodeCommandRunner } from '../../infra/node-command-runner.js';

/** Backends probed by `fugue doctor` (launcher + the env vars that count as a configured key). */
const BACKENDS = [
  { launcher: 'cc-deepseek', keys: ['DEEPSEEK_API_KEY'] },
  { launcher: 'cc-glm', keys: ['GLM_API_KEY', 'ZAI_API_KEY'] },
  { launcher: 'cc-kimi', keys: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'] },
  { launcher: 'cc-qwen', keys: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'] },
  { launcher: 'cc-doubao', keys: ['DOUBAO_API_KEY', 'ARK_API_KEY'] },
  { launcher: 'cc-minimax', keys: ['MINIMAX_API_KEY'] },
  { launcher: 'cc-mimo', keys: ['MIMO_API_KEY'] },
  { launcher: 'cc-stepfun', keys: ['STEPFUN_API_KEY'] },
  { launcher: 'cc-longcat', keys: ['LONGCAT_API_KEY'] },
] as const;

const CORE_ROLE_NAMES = ['claude', 'codex', 'fugue-cc', 'agy', 'opencode'] as const;

const present = (report: DoctorReport, cli: string): boolean =>
  report.roles.find((role) => role.cli === cli)?.present ?? false;

/** `fugue doctor` — probe the environment and print roles, backends, and the recommended workflow. */
export class DoctorCommand extends Command {
  static override paths = [['doctor']];

  quiet = Option.Boolean('--quiet', false);

  override async execute(): Promise<void> {
    const report = await runRecon(new NodeCommandRunner(), { backends: BACKENDS });
    const out = this.context.stdout;

    if (this.quiet) {
      const ready = report.backends.filter(
        (backend) => backend.installed && backend.keyConfigured,
      ).length;
      const coreReady = CORE_ROLE_NAMES.filter((cli) => present(report, cli)).length;
      out.write(
        `agents=${String(coreReady)} backends_ready=${String(ready)}/${String(report.backends.length)} fugue-cc=${
          present(report, 'fugue-cc') ? '1' : '0'
        } codex=${
          present(report, 'codex') ? '1' : '0'
        } agy=${present(report, 'agy') ? '1' : '0'}\n`,
      );
      return;
    }

    out.write('roles:\n');
    for (const role of report.roles) {
      out.write(`  ${role.present ? '✓' : '✗'} ${role.cli}\n`);
    }

    out.write('backends:\n');
    for (const backend of report.backends) {
      const ready = backend.installed && backend.keyConfigured;
      const note = backend.installed
        ? backend.keyConfigured
          ? 'ready'
          : 'no key'
        : 'not installed';
      out.write(`  ${ready ? '✓' : '✗'} ${backend.launcher} (${note})\n`);
    }

    out.write('\nrecommended:\n');
    for (const rec of recommend(report)) {
      out.write(`  • ${rec}\n`);
    }
  }
}
