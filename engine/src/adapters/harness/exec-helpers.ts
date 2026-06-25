import type {
  DispatchError,
  DispatchRequest,
  DispatchResult,
  HealthStatus,
} from '../../domain/dispatch.js';
import { err, ok } from '../../domain/result.js';
import type { Result } from '../../domain/result.js';
import type { CommandOptions, CommandRunner } from '../../infra/command-runner.js';

/** Shared dispatch/health mapping for the blocking-CLI harnesses (fugue-cc/codex/opencode). */
export interface HarnessExecOptions {
  readonly bin?: string;
  readonly cwd?: string;
  /**
   * Extra CLI flags spliced into every dispatch. Lets a caller harden the
   * underlying tool per host — e.g. codex `-c mcp_servers={}` to skip a flaky
   * remote-MCP config that would otherwise hang `codex exec`.
   */
  readonly args?: readonly string[];
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const runDispatch = async (
  runner: CommandRunner,
  bin: string,
  args: readonly string[],
  request: DispatchRequest,
  options: CommandOptions = {},
): Promise<Result<DispatchResult, DispatchError>> => {
  try {
    const result = await runner.run(bin, args, options);
    if (result.code === 0) {
      return ok({ agent: request.agent, output: result.stdout, exitCode: 0 });
    }
    return err({
      agent: request.agent,
      kind: 'nonzero-exit',
      detail: result.stderr || result.stdout,
      exitCode: result.code,
    });
  } catch (error) {
    return err({ agent: request.agent, kind: 'spawn-failed', detail: message(error) });
  }
};

export const versionHealth = async (
  runner: CommandRunner,
  bin: string,
  options: CommandOptions = {},
): Promise<HealthStatus> => {
  try {
    const result = await runner.run(bin, ['--version'], options);
    return result.code === 0
      ? { healthy: true, detail: `${bin} ${result.stdout.trim()}`.trim() }
      : { healthy: false, detail: `${bin} --version exited ${result.code}` };
  } catch (error) {
    return { healthy: false, detail: message(error) };
  }
};
