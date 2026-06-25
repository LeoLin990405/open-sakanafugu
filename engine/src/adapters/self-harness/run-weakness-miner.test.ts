import { describe, expect, it } from 'vitest';

import type {
  DispatchError,
  DispatchRequest,
  DispatchResult,
  HealthStatus,
} from '../../domain/dispatch.js';
import type { Harness } from '../../domain/ports/harness.js';
import type { RunPatch, RunStore } from '../../domain/ports/run-store.js';
import { err, ok } from '../../domain/result.js';
import type { Result } from '../../domain/result.js';
import type { PhaseName, Run, RunEvent } from '../../domain/run.js';
import { RunWeaknessMiner } from './run-weakness-miner.js';

class FakeHarness implements Harness {
  readonly name = 'codex';
  readonly requests: DispatchRequest[] = [];

  constructor(
    private readonly result: Result<DispatchResult, DispatchError>,
    private readonly rejectDispatch = false,
  ) {}

  dispatch(request: DispatchRequest): Promise<Result<DispatchResult, DispatchError>> {
    this.requests.push(request);
    if (this.rejectDispatch) return Promise.reject(new Error('dispatch rejected'));
    return Promise.resolve(this.result);
  }

  health(): Promise<HealthStatus> {
    return Promise.resolve({ healthy: true, detail: 'ok' });
  }
}

class FakeRunStore implements RunStore {
  constructor(
    private readonly run: Run | null,
    private readonly rejectGet = false,
  ) {}

  create(id: string, phase: PhaseName): Promise<Run> {
    return Promise.resolve({ id, phase, round: 1, events: [] });
  }

  get(_id: string): Promise<Run | null> {
    void _id;
    if (this.rejectGet) return Promise.reject(new Error('run store rejected'));
    return Promise.resolve(this.run);
  }

  patch(id: string, _patch: RunPatch): Promise<Run> {
    void _patch;
    return Promise.resolve({ id, phase: 'dispatch', round: 1, events: [] });
  }

  appendEvent(id: string, event: RunEvent): Promise<Run> {
    return Promise.resolve({ id, phase: event.phase, round: 1, events: [event] });
  }
}

const harnessOk = (output: string): FakeHarness =>
  new FakeHarness(ok({ agent: 'agent-1', output, exitCode: 0 }));

const runWith = (events: readonly RunEvent[]): Run => ({
  id: 'run-1',
  phase: 'dispatch',
  round: 1,
  events,
});

const event = (kind: string, detail?: string): RunEvent =>
  detail === undefined
    ? { at: 0, phase: 'dispatch', kind }
    : { at: 0, phase: 'dispatch', kind, detail };

describe('RunWeaknessMiner', () => {
  it('returns an empty list for a missing run', async () => {
    const harness = harnessOk('[]');

    const clusters = await new RunWeaknessMiner(new FakeRunStore(null), harness, {
      agent: 'agent-1',
    }).mine('run-1');

    expect(clusters).toEqual([]);
    expect(harness.requests).toHaveLength(0);
  });

  it('parses failed and no-agent details, dedups by taskKey, and prompts with the task keys', async () => {
    const harness = harnessOk(
      JSON.stringify([
        {
          taskKey: 'task-a',
          cause: 'test failure',
          causalStatus: 'causal',
          mechanism: 'weak verification gate',
        },
        {
          taskKey: 'task-b',
          cause: 'no eligible agent',
          causalStatus: 'causal',
          mechanism: 'allocation gap',
        },
      ]),
    );
    const store = new FakeRunStore(
      runWith([
        event('failed', 'task-a: expected artifact missing: retry exhausted'),
        event('no-agent', 'task-b'),
        event('failed', 'task-a: duplicate should be ignored'),
        event('dispatched', 'task-c -> agent'),
      ]),
    );

    const clusters = await new RunWeaknessMiner(store, harness, { agent: 'agent-1' }).mine('run-1');

    expect(clusters.map((cluster) => cluster.signature.mechanism)).toEqual([
      'allocation gap',
      'weak verification gate',
    ]);
    expect(harness.requests[0]?.prompt).toContain('task-a');
    expect(harness.requests[0]?.prompt).toContain('"kind": "failed"');
    expect(harness.requests[0]?.prompt).toContain('expected artifact missing: retry exhausted');
    expect(harness.requests[0]?.prompt).toContain('task-b');
    expect(harness.requests[0]?.prompt).toContain('"kind": "no-agent"');
    expect(harness.requests[0]?.prompt).not.toContain('duplicate should be ignored');
    expect(harness.requests[0]?.taskType).toBe('self-harness-mine');
  });

  it('returns an empty list without dispatching when a run has no failed tasks', async () => {
    const harness = harnessOk('[]');
    const store = new FakeRunStore(runWith([event('dispatched', 'task-a -> agent')]));

    const clusters = await new RunWeaknessMiner(store, harness, { agent: 'agent-1' }).mine('run-1');

    expect(clusters).toEqual([]);
    expect(harness.requests).toHaveLength(0);
  });

  it('uses a custom task type for mining dispatches', async () => {
    const harness = harnessOk('[]');
    const store = new FakeRunStore(runWith([event('failed', 'task-a: boom')]));

    await new RunWeaknessMiner(store, harness, {
      agent: 'agent-1',
      taskType: 'custom-mine',
    }).mine('run-1');

    expect(harness.requests[0]?.taskType).toBe('custom-mine');
  });

  it('returns an empty list on dispatch errors', async () => {
    const harness = new FakeHarness(
      err({
        agent: 'agent-1',
        kind: 'unavailable',
        detail: 'offline',
      }),
    );
    const store = new FakeRunStore(runWith([event('failed', 'task-a: boom')]));

    const clusters = await new RunWeaknessMiner(store, harness, { agent: 'agent-1' }).mine('run-1');

    expect(clusters).toEqual([]);
  });

  it('returns an empty list on run store rejections', async () => {
    const clusters = await new RunWeaknessMiner(new FakeRunStore(null, true), harnessOk('[]'), {
      agent: 'agent-1',
    }).mine('run-1');

    expect(clusters).toEqual([]);
  });

  it('returns an empty list on dispatch rejections', async () => {
    const harness = new FakeHarness(ok({ agent: 'agent-1', output: '[]', exitCode: 0 }), true);
    const store = new FakeRunStore(runWith([event('failed', 'task-a: boom')]));

    const clusters = await new RunWeaknessMiner(store, harness, { agent: 'agent-1' }).mine('run-1');

    expect(clusters).toEqual([]);
    expect(harness.requests).toHaveLength(1);
  });

  it('returns an empty list on non-JSON output', async () => {
    const clusters = await new RunWeaknessMiner(
      new FakeRunStore(runWith([event('failed', 'task-a: boom')])),
      harnessOk('not json'),
      { agent: 'agent-1' },
    ).mine('run-1');

    expect(clusters).toEqual([]);
  });

  it('clusters valid tags with count-desc ordering from the shared domain function', async () => {
    const harness = harnessOk(
      JSON.stringify([
        {
          taskKey: 'task-a',
          cause: 'missing artifact',
          causalStatus: 'causal',
          mechanism: 'weak verification gate',
        },
        {
          taskKey: 'task-b',
          cause: 'missing artifact',
          causalStatus: 'causal',
          mechanism: 'weak verification gate',
        },
        {
          taskKey: 'task-c',
          cause: 'no eligible agent',
          causalStatus: 'causal',
          mechanism: 'allocation gap',
        },
      ]),
    );
    const store = new FakeRunStore(
      runWith([
        event('failed', 'task-a: missing artifact'),
        event('failed', 'task-b: missing artifact'),
        event('no-agent', 'task-c'),
      ]),
    );

    const clusters = await new RunWeaknessMiner(store, harness, { agent: 'agent-1' }).mine('run-1');

    expect(clusters.map((cluster) => [cluster.signature.mechanism, cluster.count])).toEqual([
      ['weak verification gate', 2],
      ['allocation gap', 1],
    ]);
    expect(clusters[0]?.taskKeys).toEqual(['task-a', 'task-b']);
  });

  it('drops tags for task keys that were not among the failures', async () => {
    const harness = harnessOk(
      JSON.stringify([
        {
          taskKey: 'task-a',
          cause: 'missing artifact',
          causalStatus: 'causal',
          mechanism: 'weak verification gate',
        },
        {
          taskKey: 'task-z',
          cause: 'hallucinated task',
          causalStatus: 'incidental',
          mechanism: 'unknown lever',
        },
      ]),
    );
    const store = new FakeRunStore(runWith([event('failed', 'task-a: missing artifact')]));

    const clusters = await new RunWeaknessMiner(store, harness, { agent: 'agent-1' }).mine('run-1');

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.taskKeys).toEqual(['task-a']);
  });

  it('dedups duplicate model tags by task key before clustering', async () => {
    const harness = harnessOk(
      JSON.stringify([
        {
          taskKey: 'task-a',
          cause: 'missing artifact',
          causalStatus: 'causal',
          mechanism: 'weak verification gate',
        },
        {
          taskKey: 'task-a',
          cause: 'missing artifact',
          causalStatus: 'causal',
          mechanism: 'weak verification gate',
        },
      ]),
    );
    const store = new FakeRunStore(runWith([event('failed', 'task-a: missing artifact')]));

    const clusters = await new RunWeaknessMiner(store, harness, { agent: 'agent-1' }).mine('run-1');

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.count).toBe(1);
    expect(clusters[0]?.taskKeys).toEqual(['task-a']);
  });
});
