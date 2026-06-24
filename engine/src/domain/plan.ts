/** Multi-model planning panel (bash `plan`): fan a goal decomposition out to several models. */
export const renderPlanPrompt = (goal: string): string =>
  [
    'Decompose this goal into a concrete, file-level implementation plan:',
    '',
    goal,
    '',
    'Output: ordered steps, each naming the files to change and its acceptance check.',
    'Be specific and self-contained; no preamble.',
  ].join('\n');

/** Cross-family default planners (different perspectives). */
export const DEFAULT_PLAN_AGENTS: readonly string[] = ['cc-deepseek', 'cc-kimi', 'coder'];
