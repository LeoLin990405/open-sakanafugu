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

export const AGY_INVOCATION_DESCRIPTOR = {
  bin: 'agy',
  promptMode: 'flag',
  flagName: '--prompt',
  modelArg: 'omit-when-default',
  dynamicArgOrder: 'prompt-then-model',
  extraArgsPlacement: 'after-dynamic',
  healthCmd: ['--version'],
  failureMode: 'exit-code',
} as const satisfies InvocationDescriptor;

/** Dispatch via `agy --prompt <prompt> [--model <model>]` (target = model or `default`). */
export class AgyHarness implements Harness {
  readonly name = 'agy';
  private readonly delegate: AgentCliHarness;

  constructor(runner: CommandRunner, options: HarnessExecOptions = {}) {
    this.delegate = new AgentCliHarness(runner, AGY_INVOCATION_DESCRIPTOR, options, this.name);
  }

  dispatch(request: DispatchRequest): Promise<Result<DispatchResult, DispatchError>> {
    return this.delegate.dispatch(request);
  }

  health(): Promise<HealthStatus> {
    return this.delegate.health();
  }
}
