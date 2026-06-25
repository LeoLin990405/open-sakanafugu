import { Command, Option } from 'clipanion';

import { wireSelfHarness } from '../../app/wire.js';
import { isOk } from '../../domain/result.js';
import { EDITABLE_SURFACES } from '../../domain/self-harness.js';
import type { HarnessConfig, LineageEntry } from '../../domain/self-harness.js';
import {
  parseSelfHarnessSpec,
  renderSelfHarnessSpecTemplate,
} from '../../domain/self-harness-spec.js';
import type { SelfHarnessSpec } from '../../domain/self-harness-spec.js';
import { NodeFileSystem } from '../../infra/node-file-system.js';
import { stateDir } from '../state-dir.js';

interface SelfHarnessRunOutput {
  readonly config: HarnessConfig;
  readonly lineage: readonly LineageEntry[];
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const formatSelfHarnessRunReport = (
  spec: SelfHarnessSpec,
  result: SelfHarnessRunOutput,
): string => {
  const lines: string[] = [];

  for (const entry of result.lineage) {
    lines.push(
      [
        `round ${String(entry.round)}`,
        `surface=${entry.surface}`,
        `mechanism=${entry.mechanism}`,
        `decision=${entry.decision}`,
        `dIn=${String(entry.verdict.deltaIn)}`,
        `dOut=${String(entry.verdict.deltaOut)}`,
      ].join(' '),
    );
  }

  for (const surface of EDITABLE_SURFACES) {
    const changed = result.config[surface] === spec.config[surface] ? 'same' : 'changed';
    lines.push(`${surface} = ${changed}`);
  }

  const promoted = result.lineage.filter((entry) => entry.decision === 'accepted').length;
  lines.push(`rounds: ${String(spec.rounds)}, promoted: ${String(promoted)}`);
  return `${lines.join('\n')}\n`;
};

/** `fugue self-harness run --spec <file>` — run the Self-Harness loop from a JSON spec. */
export class SelfHarnessRunCommand extends Command {
  static override paths = [['self-harness', 'run']];

  spec = Option.String('--spec', {
    required: true,
    description: 'Path to a self-harness JSON spec; runId is mined every round',
  });
  state = Option.String('--state', stateDir(), {
    description: 'Durable state root (default: FUGUE_STATE or ~/.config/fugue)',
  });
  cwd = Option.String('--cwd', {
    description: 'Working directory for harness dispatches and shell gates',
  });

  override async execute(): Promise<number> {
    const text = await new NodeFileSystem().read(this.spec);
    if (text === null) {
      this.context.stderr.write(`no self-harness spec at ${this.spec}\n`);
      return 1;
    }

    const parsed = parseSelfHarnessSpec(text);
    if (!isOk(parsed)) {
      this.context.stderr.write(`${parsed.error}\n`);
      return 1;
    }

    const wireConfig =
      this.cwd === undefined
        ? { spec: parsed.value, stateDir: this.state }
        : { spec: parsed.value, stateDir: this.state, cwd: this.cwd };
    const loop = wireSelfHarness(wireConfig);
    // The JSON spec names one source run; each round re-mines that same run. For fresh
    // evidence between rounds, invoke the CLI again with a new spec/runId.
    let result: Awaited<ReturnType<typeof loop.run>>;
    try {
      result = await loop.run(parsed.value.rounds, parsed.value.config, () => parsed.value.runId);
    } catch (error) {
      this.context.stderr.write(`self-harness run failed: ${message(error)}\n`);
      return 1;
    }

    this.context.stdout.write(formatSelfHarnessRunReport(parsed.value, result));
    return 0;
  }
}

/** `fugue self-harness template` — print a starter JSON spec. */
export class SelfHarnessTemplateCommand extends Command {
  static override paths = [['self-harness', 'template']];

  override execute(): Promise<number> {
    this.context.stdout.write(renderSelfHarnessSpecTemplate());
    return Promise.resolve(0);
  }
}
