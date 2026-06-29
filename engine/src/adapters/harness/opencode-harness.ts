import type {
  DispatchError,
  DispatchRequest,
  DispatchResult,
  HealthStatus,
} from '../../domain/dispatch.js';
import type { InvocationDescriptor } from '../../domain/invocation-descriptor.js';
import type { Harness } from '../../domain/ports/harness.js';
import type { Result } from '../../domain/result.js';
import type { CommandRunner } from '../../infra/command-runner.js';
import { AgentCliHarness } from './agent-cli-harness.js';
import type { HarnessExecOptions } from './exec-helpers.js';

export const OPENCODE_INVOCATION_DESCRIPTOR = {
  bin: 'opencode',
  subcommand: ['run'],
  promptMode: 'positional',
  modelArg: '-m',
  healthCmd: ['--version'],
  failureMode: 'zero-exit-stderr',
} as const satisfies InvocationDescriptor;

/** Dispatch via `opencode run -m <provider/model> <prompt>` (target = provider/model). */
export class OpencodeHarness implements Harness {
  readonly name = 'opencode';
  private readonly delegate: AgentCliHarness;

  constructor(runner: CommandRunner, options: HarnessExecOptions = {}) {
    this.delegate = new AgentCliHarness(runner, OPENCODE_INVOCATION_DESCRIPTOR, options, this.name);
  }

  dispatch(request: DispatchRequest): Promise<Result<DispatchResult, DispatchError>> {
    return this.delegate.dispatch(request);
  }

  health(): Promise<HealthStatus> {
    return this.delegate.health();
  }
}
