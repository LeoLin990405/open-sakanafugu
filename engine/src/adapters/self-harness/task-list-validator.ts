import type { DispatchError, DispatchResult } from '../../domain/dispatch.js';
import type { Harness } from '../../domain/ports/harness.js';
import type { HarnessValidator } from '../../domain/ports/self-harness.js';
import { isOk } from '../../domain/result.js';
import type { Result } from '../../domain/result.js';
import type { HarnessConfig, SplitScores } from '../../domain/self-harness.js';

export interface TaskListHarnessValidatorOptions<TCase> {
  readonly heldIn: readonly TCase[];
  readonly heldOut: readonly TCase[];
  readonly renderPrompt: (config: HarnessConfig, testCase: TCase) => string;
  readonly verify: (testCase: TCase, result: DispatchResult) => boolean | Promise<boolean>;
  readonly agent: string;
  readonly taskType?: string;
}

const DEFAULT_TASK_TYPE = 'self-harness-eval';

/** Harness-backed Stage-3 validator over fixed held-in and held-out task lists. */
export class TaskListHarnessValidator<TCase> implements HarnessValidator {
  private readonly heldIn: readonly TCase[];
  private readonly heldOut: readonly TCase[];
  private readonly renderPrompt: (config: HarnessConfig, testCase: TCase) => string;
  private readonly verify: (testCase: TCase, result: DispatchResult) => boolean | Promise<boolean>;
  private readonly agent: string;
  private readonly taskType: string;

  constructor(
    private readonly harness: Harness,
    options: TaskListHarnessValidatorOptions<TCase>,
  ) {
    this.heldIn = options.heldIn;
    this.heldOut = options.heldOut;
    this.renderPrompt = options.renderPrompt;
    this.verify = options.verify;
    this.agent = options.agent;
    this.taskType = options.taskType ?? DEFAULT_TASK_TYPE;
  }

  async score(config: HarnessConfig): Promise<SplitScores> {
    const inPass = await this.scoreSplit(config, this.heldIn);
    const outPass = await this.scoreSplit(config, this.heldOut);
    return {
      inPass,
      inTotal: this.heldIn.length,
      outPass,
      outTotal: this.heldOut.length,
    };
  }

  private async scoreSplit(config: HarnessConfig, cases: readonly TCase[]): Promise<number> {
    let passes = 0;
    for (const testCase of cases) {
      if (await this.scoreCase(config, testCase)) passes += 1;
    }
    return passes;
  }

  private async scoreCase(config: HarnessConfig, testCase: TCase): Promise<boolean> {
    let prompt: string;
    try {
      prompt = this.renderPrompt(config, testCase);
    } catch {
      return false;
    }

    const result = await this.dispatch(prompt);
    if (result === undefined || !isOk(result)) return false;

    try {
      return (await this.verify(testCase, result.value)) === true;
    } catch {
      return false;
    }
  }

  private async dispatch(
    prompt: string,
  ): Promise<Result<DispatchResult, DispatchError> | undefined> {
    try {
      return await this.harness.dispatch({
        agent: this.agent,
        prompt,
        taskType: this.taskType,
      });
    } catch {
      return undefined;
    }
  }
}
