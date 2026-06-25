import { describe, expect, it } from 'vitest';

import type {
  DispatchError,
  DispatchRequest,
  DispatchResult,
  HealthStatus,
} from '../../domain/dispatch.js';
import type { Harness } from '../../domain/ports/harness.js';
import { err, ok } from '../../domain/result.js';
import type { Result } from '../../domain/result.js';
import type { HarnessConfig } from '../../domain/self-harness.js';
import { TaskListHarnessValidator } from './task-list-validator.js';

interface Case {
  readonly id: string;
  readonly expected: string;
}

class SequencedHarness implements Harness {
  readonly name = 'codex';
  readonly requests: DispatchRequest[] = [];
  private index = 0;

  constructor(private readonly results: readonly Result<DispatchResult, DispatchError>[]) {}

  dispatch(request: DispatchRequest): Promise<Result<DispatchResult, DispatchError>> {
    this.requests.push(request);
    const result =
      this.results[this.index] ??
      err({
        agent: request.agent,
        kind: 'unavailable',
        detail: 'missing fake result',
      });
    this.index += 1;
    return Promise.resolve(result);
  }

  health(): Promise<HealthStatus> {
    return Promise.resolve({ healthy: true, detail: 'ok' });
  }
}

class RejectingOnceHarness implements Harness {
  readonly name = 'codex';
  readonly requests: DispatchRequest[] = [];
  private calls = 0;

  dispatch(request: DispatchRequest): Promise<Result<DispatchResult, DispatchError>> {
    this.requests.push(request);
    this.calls += 1;
    if (this.calls === 1) return Promise.reject(new Error('dispatch rejected'));
    return Promise.resolve(pass('ok'));
  }

  health(): Promise<HealthStatus> {
    return Promise.resolve({ healthy: true, detail: 'ok' });
  }
}

const config: HarnessConfig = {
  'system-prompt': 'Be precise.',
  'memory-sources': 'Use notes.',
  subagents: 'none',
  skills: 'none',
  bootstrap: 'start',
  execution: 'execute',
  verification: 'verify',
  'failure-recovery': 'recover',
  'runtime-policy': 'policy',
};

const pass = (output: string): Result<DispatchResult, DispatchError> =>
  ok({ agent: 'agent-1', output, exitCode: 0 });

const failDispatch = (): Result<DispatchResult, DispatchError> =>
  err({ agent: 'agent-1', kind: 'unavailable', detail: 'offline' });

const renderPrompt = (harnessConfig: HarnessConfig, testCase: Case): string =>
  `${harnessConfig['system-prompt']} :: ${testCase.id}`;

describe('TaskListHarnessValidator', () => {
  it('counts passes per split with a verify predicate', async () => {
    const harness = new SequencedHarness([pass('yes'), pass('no'), pass('ok')]);
    const validator = new TaskListHarnessValidator(harness, {
      heldIn: [
        { id: 'in-1', expected: 'yes' },
        { id: 'in-2', expected: 'yes' },
      ],
      heldOut: [{ id: 'out-1', expected: 'ok' }],
      renderPrompt,
      verify: (testCase, result) => result.output === testCase.expected,
      agent: 'agent-1',
    });

    const scores = await validator.score(config);

    expect(scores).toEqual({ inPass: 1, inTotal: 2, outPass: 1, outTotal: 1 });
    expect(harness.requests.map((request) => request.prompt)).toEqual([
      'Be precise. :: in-1',
      'Be precise. :: in-2',
      'Be precise. :: out-1',
    ]);
    expect(harness.requests.every((request) => request.agent === 'agent-1')).toBe(true);
    expect(harness.requests.every((request) => request.taskType === 'self-harness-eval')).toBe(
      true,
    );
  });

  it('uses a custom task type for dispatches', async () => {
    const harness = new SequencedHarness([pass('ok')]);

    await new TaskListHarnessValidator(harness, {
      heldIn: [{ id: 'in-1', expected: 'ok' }],
      heldOut: [],
      renderPrompt,
      verify: (testCase, result) => result.output === testCase.expected,
      agent: 'agent-1',
      taskType: 'custom-eval',
    }).score(config);

    expect(harness.requests[0]?.taskType).toBe('custom-eval');
  });

  it('counts dispatch errors as failures', async () => {
    const harness = new SequencedHarness([failDispatch(), pass('ok')]);
    const scores = await new TaskListHarnessValidator(harness, {
      heldIn: [{ id: 'in-1', expected: 'ok' }],
      heldOut: [{ id: 'out-1', expected: 'ok' }],
      renderPrompt,
      verify: (testCase, result) => result.output === testCase.expected,
      agent: 'agent-1',
    }).score(config);

    expect(scores).toEqual({ inPass: 0, inTotal: 1, outPass: 1, outTotal: 1 });
  });

  it('counts dispatch promise rejections as failures and continues', async () => {
    const harness = new RejectingOnceHarness();
    const scores = await new TaskListHarnessValidator(harness, {
      heldIn: [
        { id: 'in-1', expected: 'ok' },
        { id: 'in-2', expected: 'ok' },
      ],
      heldOut: [],
      renderPrompt,
      verify: (testCase, result) => result.output === testCase.expected,
      agent: 'agent-1',
    }).score(config);

    expect(scores).toEqual({ inPass: 1, inTotal: 2, outPass: 0, outTotal: 0 });
    expect(harness.requests).toHaveLength(2);
  });

  it('counts verifier exceptions as failures and continues', async () => {
    const harness = new SequencedHarness([pass('boom'), pass('yes'), pass('ok')]);
    const scores = await new TaskListHarnessValidator(harness, {
      heldIn: [
        { id: 'in-1', expected: 'yes' },
        { id: 'in-2', expected: 'yes' },
      ],
      heldOut: [{ id: 'out-1', expected: 'ok' }],
      renderPrompt,
      verify: (testCase, result) => {
        if (testCase.id === 'in-1') throw new Error('bad verifier');
        return result.output === testCase.expected;
      },
      agent: 'agent-1',
    }).score(config);

    expect(scores).toEqual({ inPass: 1, inTotal: 2, outPass: 1, outTotal: 1 });
    expect(harness.requests).toHaveLength(3);
  });

  it('counts verifier promise rejections as failures and continues', async () => {
    const harness = new SequencedHarness([pass('boom'), pass('yes')]);
    const scores = await new TaskListHarnessValidator(harness, {
      heldIn: [
        { id: 'in-1', expected: 'yes' },
        { id: 'in-2', expected: 'yes' },
      ],
      heldOut: [],
      renderPrompt,
      verify: async (testCase, result) => {
        if (testCase.id === 'in-1') throw new Error('bad async verifier');
        return Promise.resolve(result.output === testCase.expected);
      },
      agent: 'agent-1',
    }).score(config);

    expect(scores).toEqual({ inPass: 1, inTotal: 2, outPass: 0, outTotal: 0 });
    expect(harness.requests).toHaveLength(2);
  });

  it('counts renderPrompt exceptions as failures and continues', async () => {
    const harness = new SequencedHarness([pass('yes')]);
    const scores = await new TaskListHarnessValidator(harness, {
      heldIn: [
        { id: 'in-1', expected: 'yes' },
        { id: 'in-2', expected: 'yes' },
      ],
      heldOut: [],
      renderPrompt: (harnessConfig, testCase) => {
        if (testCase.id === 'in-1') throw new Error('bad template');
        return renderPrompt(harnessConfig, testCase);
      },
      verify: (testCase, result) => result.output === testCase.expected,
      agent: 'agent-1',
    }).score(config);

    expect(scores).toEqual({ inPass: 1, inTotal: 2, outPass: 0, outTotal: 0 });
    expect(harness.requests.map((request) => request.prompt)).toEqual(['Be precise. :: in-2']);
  });

  it('awaits an async verify predicate', async () => {
    const harness = new SequencedHarness([pass('async-pass')]);
    const scores = await new TaskListHarnessValidator(harness, {
      heldIn: [{ id: 'in-1', expected: 'async-pass' }],
      heldOut: [],
      renderPrompt,
      verify: async (testCase, result) => Promise.resolve(result.output === testCase.expected),
      agent: 'agent-1',
    }).score(config);

    expect(scores).toEqual({ inPass: 1, inTotal: 1, outPass: 0, outTotal: 0 });
  });

  it('reports split sizes as totals', async () => {
    const scores = await new TaskListHarnessValidator(new SequencedHarness([]), {
      heldIn: [
        { id: 'in-1', expected: 'x' },
        { id: 'in-2', expected: 'x' },
        { id: 'in-3', expected: 'x' },
      ],
      heldOut: [
        { id: 'out-1', expected: 'x' },
        { id: 'out-2', expected: 'x' },
      ],
      renderPrompt,
      verify: () => false,
      agent: 'agent-1',
    }).score(config);

    expect(scores).toEqual({ inPass: 0, inTotal: 3, outPass: 0, outTotal: 2 });
  });

  it('returns zeros for empty splits', async () => {
    const harness = new SequencedHarness([]);
    const scores = await new TaskListHarnessValidator<Case>(harness, {
      heldIn: [],
      heldOut: [],
      renderPrompt,
      verify: () => true,
      agent: 'agent-1',
    }).score(config);

    expect(scores).toEqual({ inPass: 0, inTotal: 0, outPass: 0, outTotal: 0 });
    expect(harness.requests).toHaveLength(0);
  });
});
