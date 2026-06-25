import { Builtins, Cli } from 'clipanion';

import { VERSION } from '../index.js';
import {
  AgentRegistryListCommand,
  AgentRegistryResolveCommand,
  AgentRegistryTemplateCommand,
  AgentRegistryValidateCommand,
} from './commands/agent-registry.js';
import { DoctorCommand } from './commands/doctor.js';
import {
  ExperienceAddCommand,
  ExperienceListCommand,
  ExperienceRecallCommand,
  ExperienceShowCommand,
} from './commands/experience.js';
import { GoalCheckCommand, GoalShowCommand, GoalTemplateCommand } from './commands/goal.js';
import { PlanCommand } from './commands/plan.js';
import { PreflightCommand } from './commands/preflight.js';
import { RuntimeAdaptCommand, RuntimeCheckCommand } from './commands/runtime.js';
import { SelfHarnessRunCommand, SelfHarnessTemplateCommand } from './commands/self-harness.js';
import { SummaryCommand } from './commands/summary.js';
import { TaskDoneCommand, TaskLogCommand, TaskNewCommand } from './commands/task.js';
import { TemplateRenderCommand } from './commands/template.js';
import { VersionCommand } from './commands/version.js';
import {
  WorkspaceContextCommand,
  WorkspaceListCommand,
  WorkspaceModelCommand,
  WorkspaceShowCommand,
} from './commands/workspace.js';

/**
 * Build the fugue CLI with every command registered. Pure construction (no IO,
 * no process side effects) so tests can drive it via `cli.run([...], context)`.
 */
export const buildCli = (): Cli => {
  const cli = new Cli({
    binaryName: 'fugue',
    binaryLabel: 'fugue engine',
    binaryVersion: VERSION,
  });
  cli.register(Builtins.HelpCommand);
  cli.register(Builtins.VersionCommand);
  cli.register(VersionCommand);
  cli.register(DoctorCommand);
  cli.register(ExperienceAddCommand);
  cli.register(ExperienceListCommand);
  cli.register(ExperienceRecallCommand);
  cli.register(ExperienceShowCommand);
  cli.register(TaskNewCommand);
  cli.register(TaskLogCommand);
  cli.register(TaskDoneCommand);
  cli.register(GoalTemplateCommand);
  cli.register(GoalShowCommand);
  cli.register(GoalCheckCommand);
  cli.register(PlanCommand);
  cli.register(PreflightCommand);
  cli.register(RuntimeCheckCommand);
  cli.register(RuntimeAdaptCommand);
  cli.register(TemplateRenderCommand);
  cli.register(WorkspaceListCommand);
  cli.register(WorkspaceShowCommand);
  cli.register(WorkspaceModelCommand);
  cli.register(WorkspaceContextCommand);
  cli.register(AgentRegistryTemplateCommand);
  cli.register(AgentRegistryValidateCommand);
  cli.register(AgentRegistryListCommand);
  cli.register(AgentRegistryResolveCommand);
  cli.register(SelfHarnessTemplateCommand);
  cli.register(SelfHarnessRunCommand);
  cli.register(SummaryCommand);
  return cli;
};
