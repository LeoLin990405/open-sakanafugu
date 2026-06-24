import { describe, expect, it } from 'vitest';

import { recommend } from '../../domain/doctor.js';
import type { CommandResult, CommandRunner } from '../../infra/command-runner.js';
import { runRecon } from './recon.js';

// `command -v <cli>` exits 0 iff cli is "installed". The fake says yes for a set.
class WhichRunner implements CommandRunner {
  constructor(private readonly installed: ReadonlySet<string>) {}
  run(_command: string, args: readonly string[]): Promise<CommandResult> {
    const cli = (args[1] ?? '').replace('command -v ', '');
    return Promise.resolve({ code: this.installed.has(cli) ? 0 : 1, stdout: '', stderr: '' });
  }
}

describe('runRecon', () => {
  it('probes role CLIs and backends, honoring the env for keys', async () => {
    const runner = new WhichRunner(new Set(['claude', 'codex', 'ccb', 'cc-deepseek']));
    const report = await runRecon(runner, {
      roles: ['claude', 'codex', 'ccb', 'agy'],
      backends: [
        { launcher: 'cc-deepseek', keys: ['DEEPSEEK_API_KEY'] },
        { launcher: 'cc-glm', keys: ['GLM_API_KEY'] },
      ],
      env: { DEEPSEEK_API_KEY: 'x' },
    });

    expect(report.roles.find((r) => r.cli === 'claude')?.present).toBe(true);
    expect(report.roles.find((r) => r.cli === 'agy')?.present).toBe(false);
    expect(report.backends.find((b) => b.launcher === 'cc-deepseek')).toEqual({
      launcher: 'cc-deepseek',
      installed: true,
      keyConfigured: true,
    });
    expect(report.backends.find((b) => b.launcher === 'cc-glm')?.keyConfigured).toBe(false);
    // and the report feeds the recommender
    expect(recommend(report).length).toBeGreaterThan(0);
  });
});
