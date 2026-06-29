import { Builtins, Cli } from 'clipanion';

import { VERSION } from '../index.js';
import {
  AgentRegistryListCommand,
  AgentRegistryResolveCommand,
  AgentRegistryTemplateCommand,
  AgentRegistryValidateCommand,
} from './commands/agent-registry.js';
import { AllocateCommand } from './commands/allocate.js';
import { CacheCommand } from './commands/cache.js';
import { DispatchCommand } from './commands/dispatch.js';
import { DoctorCommand } from './commands/doctor.js';
import {
  ExperienceAddCommand,
  ExperienceAuditCommand,
  ExperienceEvalCommand,
  ExperienceLearnCommand,
  ExperienceListCommand,
  ExperiencePolicyCommand,
  ExperiencePromoteCommand,
  ExperienceRecallCommand,
  ExperienceShowCommand,
} from './commands/experience.js';
import {
  EvolveHistoryCommand,
  EvolveMineCommand,
  EvolvePromoteCommand,
  EvolveValidateCommand,
} from './commands/evolve.js';
import { FleetCommand } from './commands/fleet.js';
import { GuardPromptCommand } from './commands/guard.js';
import { GoalCheckCommand, GoalShowCommand, GoalTemplateCommand } from './commands/goal.js';
import { InitCommand } from './commands/init.js';
import { IncidentPacketCommand, IncidentRecoveryCommand } from './commands/incident.js';
import { IntegrateCommand } from './commands/integrate.js';
import { LoopCommand } from './commands/loop.js';
import { PlanCommand } from './commands/plan.js';
import { PreflightCommand } from './commands/preflight.js';
import { ReviewPacketCommand } from './commands/review.js';
import { RuntimeAdaptCommand, RuntimeCheckCommand } from './commands/runtime.js';
import { RunCommand } from './commands/run.js';
import { SelfHarnessRunCommand, SelfHarnessTemplateCommand } from './commands/self-harness.js';
import { SkillsCommand } from './commands/skills.js';
import { SmokeCommand } from './commands/smoke.js';
import { SummaryCommand } from './commands/summary.js';
import {
  TaskDigestCommand,
  TaskDoneCommand,
  TaskHandoffCommand,
  TaskLogCommand,
  TaskNewCommand,
} from './commands/task.js';
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
  cli.register(InitCommand);
  cli.register(AllocateCommand);
  cli.register(DispatchCommand);
  cli.register(FleetCommand);
  cli.register(GuardPromptCommand);
  cli.register(ExperienceAddCommand);
  cli.register(ExperienceAuditCommand);
  cli.register(ExperienceEvalCommand);
  cli.register(ExperienceLearnCommand);
  cli.register(ExperienceListCommand);
  cli.register(ExperiencePolicyCommand);
  cli.register(ExperiencePromoteCommand);
  cli.register(ExperienceRecallCommand);
  cli.register(ExperienceShowCommand);
  cli.register(EvolveMineCommand);
  cli.register(EvolveValidateCommand);
  cli.register(EvolvePromoteCommand);
  cli.register(EvolveHistoryCommand);
  cli.register(TaskNewCommand);
  cli.register(TaskLogCommand);
  cli.register(TaskDoneCommand);
  cli.register(TaskHandoffCommand);
  cli.register(TaskDigestCommand);
  cli.register(GoalTemplateCommand);
  cli.register(GoalShowCommand);
  cli.register(GoalCheckCommand);
  cli.register(IncidentPacketCommand);
  cli.register(IncidentRecoveryCommand);
  cli.register(IntegrateCommand);
  cli.register(LoopCommand);
  cli.register(PlanCommand);
  cli.register(PreflightCommand);
  cli.register(ReviewPacketCommand);
  cli.register(CacheCommand);
  cli.register(RuntimeCheckCommand);
  cli.register(RuntimeAdaptCommand);
  cli.register(RunCommand);
  cli.register(TemplateRenderCommand);
  cli.register(WorkspaceListCommand);
  cli.register(WorkspaceShowCommand);
  cli.register(WorkspaceModelCommand);
  cli.register(WorkspaceContextCommand);
  cli.register(AgentRegistryTemplateCommand);
  cli.register(AgentRegistryValidateCommand);
  cli.register(AgentRegistryListCommand);
  cli.register(AgentRegistryResolveCommand);
  cli.register(SkillsCommand);
  cli.register(SelfHarnessTemplateCommand);
  cli.register(SelfHarnessRunCommand);
  cli.register(SmokeCommand);
  cli.register(SummaryCommand);
  return cli;
};
