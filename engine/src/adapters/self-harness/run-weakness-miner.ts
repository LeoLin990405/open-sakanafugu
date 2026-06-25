import type { Harness } from '../../domain/ports/harness.js';
import type { RunStore } from '../../domain/ports/run-store.js';
import type { WeaknessMiner } from '../../domain/ports/self-harness.js';
import { isOk } from '../../domain/result.js';
import { clusterWeaknesses } from '../../domain/self-harness-accept.js';
import type { TaggedFailure, WeaknessCluster } from '../../domain/self-harness.js';
import { parseJsonArray } from './json-extract.js';

export interface RunWeaknessMinerOptions {
  readonly agent: string;
  readonly taskType?: string;
}

interface FailedTask {
  readonly kind: 'failed' | 'no-agent';
  readonly taskKey: string;
  readonly reason: string;
}

const DEFAULT_TASK_TYPE = 'self-harness-mine';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseFailedTask = (
  kind: FailedTask['kind'],
  detail: string | undefined,
): FailedTask | undefined => {
  const text = detail?.trim() ?? '';
  if (text.length === 0) return undefined;

  const delimiter = text.indexOf(': ');
  const taskKey = (delimiter === -1 ? text : text.slice(0, delimiter)).trim();
  if (taskKey.length === 0) return undefined;

  return {
    kind,
    taskKey,
    reason: delimiter === -1 ? '' : text.slice(delimiter + 2).trim(),
  };
};

const extractFailedTasks = (
  events: readonly { kind: string; detail?: string }[],
): readonly FailedTask[] => {
  const byTaskKey = new Map<string, FailedTask>();
  for (const event of events) {
    if (event.kind !== 'failed' && event.kind !== 'no-agent') continue;
    const task = parseFailedTask(event.kind, event.detail);
    if (task === undefined || byTaskKey.has(task.taskKey)) continue;
    byTaskKey.set(task.taskKey, task);
  }
  return [...byTaskKey.values()];
};

/** Model-backed Stage-1 miner: tags failed run events, then delegates grouping to the domain. */
export class RunWeaknessMiner implements WeaknessMiner {
  private readonly agent: string;
  private readonly taskType: string;

  constructor(
    private readonly runStore: RunStore,
    private readonly harness: Harness,
    options: RunWeaknessMinerOptions,
  ) {
    this.agent = options.agent;
    this.taskType = options.taskType ?? DEFAULT_TASK_TYPE;
  }

  async mine(runId: string): Promise<readonly WeaknessCluster[]> {
    let run: Awaited<ReturnType<RunStore['get']>>;
    try {
      run = await this.runStore.get(runId);
    } catch {
      return [];
    }
    if (run === null) return [];

    const failedTasks = extractFailedTasks(run.events);
    if (failedTasks.length === 0) return [];

    let result: Awaited<ReturnType<Harness['dispatch']>>;
    try {
      result = await this.harness.dispatch({
        agent: this.agent,
        prompt: this.buildPrompt(failedTasks),
        taskType: this.taskType,
      });
    } catch {
      return [];
    }
    if (!isOk(result)) return [];

    const parsed = parseJsonArray(result.value.output);
    if (parsed === undefined) return [];

    const knownTaskKeys = new Set(failedTasks.map((task) => task.taskKey));
    const tagged = new Map<string, TaggedFailure>();
    for (const item of parsed) {
      const failure = this.sanitizeTaggedFailure(item, knownTaskKeys);
      if (failure === undefined || tagged.has(failure.taskKey)) continue;
      tagged.set(failure.taskKey, failure);
    }

    return clusterWeaknesses([...tagged.values()]);
  }

  private buildPrompt(failedTasks: readonly FailedTask[]): string {
    return [
      'You are Stage 1 of fugue Self-Harness: Weakness Mining.',
      'Tag each failed task with a verifier-grounded failure signature.',
      'Return STRICT JSON: an array aligned to the failed tasks below.',
      'Each object must have exactly these fields: { "taskKey", "cause", "causalStatus", "mechanism" }.',
      'cause = what failed; causalStatus = e.g. "causal" | "incidental".',
      'mechanism = the harness-addressable lever to fix it, as a short phrase.',
      '',
      'Failed tasks:',
      JSON.stringify(failedTasks, null, 2),
      '',
      'Output ONLY the JSON array, no prose, no code fences.',
    ].join('\n');
  }

  private sanitizeTaggedFailure(
    item: unknown,
    knownTaskKeys: ReadonlySet<string>,
  ): TaggedFailure | undefined {
    if (!isRecord(item)) return undefined;

    const taskKey = item.taskKey;
    if (typeof taskKey !== 'string' || !knownTaskKeys.has(taskKey)) return undefined;

    const cause = typeof item.cause === 'string' ? item.cause.trim() : '';
    const causalStatus = typeof item.causalStatus === 'string' ? item.causalStatus.trim() : '';
    const mechanism = typeof item.mechanism === 'string' ? item.mechanism.trim() : '';
    if (cause.length === 0 || causalStatus.length === 0 || mechanism.length === 0) {
      return undefined;
    }

    return {
      taskKey,
      signature: { cause, causalStatus, mechanism },
    };
  }
}
