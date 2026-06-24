import type { DispatchError, DispatchResult } from '../domain/dispatch.js';
import type { Harness } from '../domain/ports/harness.js';
import { renderPlanPrompt } from '../domain/plan.js';
import type { Result } from '../domain/result.js';

export interface PlanEntry {
  readonly agent: string;
  readonly outcome: Result<DispatchResult, DispatchError>;
}

/**
 * Fan the decomposition prompt out to several planning models in parallel (the
 * design panel) — the planner then synthesizes. App-layer glue over a Harness.
 */
export const planPanel = async (
  harness: Harness,
  goal: string,
  agents: readonly string[],
): Promise<readonly PlanEntry[]> => {
  const prompt = renderPlanPrompt(goal);
  return Promise.all(
    agents.map(async (agent) => ({ agent, outcome: await harness.dispatch({ agent, prompt }) })),
  );
};
