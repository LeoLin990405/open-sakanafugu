import { describe, expect, it } from 'vitest';

import type {
  DispatchError,
  DispatchRequest,
  DispatchResult,
  HealthStatus,
} from '../domain/dispatch.js';
import type { Harness } from '../domain/ports/harness.js';
import { renderPlanPrompt } from '../domain/plan.js';
import { ok } from '../domain/result.js';
import type { Result } from '../domain/result.js';
import { planPanel } from './plan-panel.js';

class FakeHarness implements Harness {
  readonly name = 'ccb';
  readonly prompts: string[] = [];
  dispatch(request: DispatchRequest): Promise<Result<DispatchResult, DispatchError>> {
    this.prompts.push(request.prompt);
    return Promise.resolve(
      ok({ agent: request.agent, output: `plan from ${request.agent}`, exitCode: 0 }),
    );
  }
  health(): Promise<HealthStatus> {
    return Promise.resolve({ healthy: true, detail: 'ok' });
  }
}

describe('renderPlanPrompt', () => {
  it('includes the goal and asks for a file-level plan', () => {
    const p = renderPlanPrompt('add auth');
    expect(p).toContain('add auth');
    expect(p).toContain('file-level');
  });
});

describe('planPanel', () => {
  it('dispatches the plan prompt to every agent', async () => {
    const harness = new FakeHarness();
    const entries = await planPanel(harness, 'add auth', ['a', 'b']);
    expect(entries.map((e) => e.agent)).toEqual(['a', 'b']);
    expect(entries.every((e) => e.outcome.ok)).toBe(true);
    expect(harness.prompts).toHaveLength(2);
    expect(harness.prompts[0]).toContain('add auth');
  });
});
