// fuguectl command builders. `taskFile` is a real TASK file path produced by `fuguectl task new`.

// Create a real TASK file. stdout is the task file path (per fuguectl task new contract).
export const buildTaskNewCmd = (goal: string): string => `fuguectl task new "${goal}" P1`;

export const buildPlanCmd = (goal: string, taskFile: string): string =>
  `fuguectl plan "${goal}" --task ${taskFile}`;

// dispatch must carry an explicit prompt source (--prompt), not just --task.
export const buildDispatchCmd = (
  taskFile: string,
  agent: string,
  harness: string,
  goal: string,
): string => `fuguectl dispatch ${agent} --harness ${harness} --task ${taskFile} --prompt "${goal}"`;

// integrate requires both --work (the repo) and --agents (whose worktrees to pick); it exits 2 without them.
export const buildIntegrateCmd = (taskFile: string, work: string, agents: string): string =>
  `fuguectl integrate --work ${work} --agents "${agents}" --task ${taskFile}`;

export const buildReviewCmd = (taskFile: string): string =>
  `fuguectl dispatch coder --harness codex --task ${taskFile} --prompt "Independent review of the changes for this task"`;

export const buildLoopCmd = (taskFile: string): string => `fuguectl loop status --task ${taskFile}`;

// Parse the task file path from `fuguectl task new` stdout (last non-empty line).
export const parseTaskFile = (stdout: string): string => {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
};
