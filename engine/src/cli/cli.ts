import { Builtins, Cli } from 'clipanion';

import { VERSION } from '../index.js';
import { DoctorCommand } from './commands/doctor.js';
import { GoalCheckCommand } from './commands/goal.js';
import { SelfHarnessRunCommand, SelfHarnessTemplateCommand } from './commands/self-harness.js';
import { TaskDoneCommand, TaskLogCommand, TaskNewCommand } from './commands/task.js';
import { VersionCommand } from './commands/version.js';

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
  cli.register(TaskNewCommand);
  cli.register(TaskLogCommand);
  cli.register(TaskDoneCommand);
  cli.register(GoalCheckCommand);
  cli.register(SelfHarnessTemplateCommand);
  cli.register(SelfHarnessRunCommand);
  return cli;
};
