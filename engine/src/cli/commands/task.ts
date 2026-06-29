import { createHash } from 'node:crypto';

import { Command, Option, UsageError } from 'clipanion';

import { FsTaskStore } from '../../adapters/task/fs-task-store.js';
import { renderTaskContextDigest, taskContextDigest } from '../../domain/task-context-digest.js';
import { renderTaskHandoffPacket, taskHandoffPacket } from '../../domain/task-handoff.js';
import type { TaskPriority } from '../../domain/task-file.js';
import { systemClock } from '../../infra/clock.js';
import { NodeFileSystem } from '../../infra/node-file-system.js';
import { tasksDir } from '../state-dir.js';

const fs = (): NodeFileSystem => new NodeFileSystem();
const store = (): FsTaskStore => new FsTaskStore(fs(), systemClock, tasksDir());

/** Default an absent flag to P1; reject any other non-P0/P1/P2 value loudly. */
const asPriority = (raw: string | undefined): TaskPriority => {
  if (raw === undefined) return 'P1';
  if (raw === 'P0' || raw === 'P1' || raw === 'P2') return raw;
  throw new UsageError(`invalid --priority ${raw} (expected P0, P1, or P2)`);
};

/** `fugue task new <title> [--priority P0|P1|P2]` — create a TASK file, print its path. */
export class TaskNewCommand extends Command {
  static override paths = [['task', 'new']];

  title = Option.String();
  legacyPriority = Option.String({ required: false });
  priority = Option.String('--priority', { description: 'P0 | P1 | P2 (default P1)' });

  override async execute(): Promise<void> {
    if (this.priority !== undefined && this.legacyPriority !== undefined) {
      throw new UsageError('pass priority either as P0|P1|P2 or --priority, not both');
    }
    const ref = await store().create(this.title, asPriority(this.priority ?? this.legacyPriority));
    this.context.stdout.write(`${ref.path}\n`);
  }
}

/** `fugue task log <path> <message>` — append a timestamped log line to a TASK file. */
export class TaskLogCommand extends Command {
  static override paths = [['task', 'log']];

  file = Option.String();
  messageParts = Option.Rest({ name: 'message', required: 1 });

  override async execute(): Promise<void> {
    await store().log(this.file, this.messageParts.join(' '));
    this.context.stdout.write(`logged → ${this.file}\n`);
  }
}

/** `fugue task done <path>` — mark a TASK file DONE and stamp its completion time. */
export class TaskDoneCommand extends Command {
  static override paths = [['task', 'done']];

  file = Option.String();

  override async execute(): Promise<void> {
    await store().done(this.file);
    this.context.stdout.write(`done → ${this.file}\n`);
  }
}

const parseTail = (raw: string): number | null => {
  if (!/^\d+$/u.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const parseBudgetChars = (raw: string): number | null => {
  if (!/^\d+$/u.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** `fugue task handoff <path>` — render a provenance-bearing handoff packet. */
export class TaskHandoffCommand extends Command {
  static override paths = [['task', 'handoff']];

  file = Option.String();
  tail = Option.String('--tail', '12');
  requireDone = Option.Boolean('--require-done', false);
  json = Option.Boolean('--json', false);

  override async execute(): Promise<number> {
    const maxEvidence = parseTail(this.tail);
    if (maxEvidence === null) {
      this.context.stderr.write('unknown --tail; expected a non-negative integer\n');
      return 1;
    }
    const content = await fs().read(this.file);
    if (content === null) {
      this.context.stderr.write(`no task file ${this.file}\n`);
      return 1;
    }
    const packet = taskHandoffPacket(content, {
      sourceRef: this.file,
      maxEvidence,
    });
    if (this.requireDone && packet.status !== 'DONE') {
      this.context.stderr.write(`task handoff requires DONE status; got ${packet.status}\n`);
      return 1;
    }
    this.context.stdout.write(
      this.json ? `${JSON.stringify(packet, null, 2)}\n` : renderTaskHandoffPacket(packet),
    );
    return 0;
  }
}

/** `fugue task digest <path>` — render a bounded context card for prompts. */
export class TaskDigestCommand extends Command {
  static override paths = [['task', 'digest']];

  file = Option.String();
  tail = Option.String('--tail', '6');
  budgetChars = Option.String('--budget-chars', '2400');
  json = Option.Boolean('--json', false);

  override async execute(): Promise<number> {
    const maxEvidence = parseTail(this.tail);
    if (maxEvidence === null) {
      this.context.stderr.write('unknown --tail; expected a non-negative integer\n');
      return 1;
    }
    const budgetChars = parseBudgetChars(this.budgetChars);
    if (budgetChars === null) {
      this.context.stderr.write('unknown --budget-chars; expected a positive integer\n');
      return 1;
    }
    const content = await fs().read(this.file);
    if (content === null) {
      this.context.stderr.write(`no task file ${this.file}\n`);
      return 1;
    }
    const digest = taskContextDigest(content, {
      sourceRef: this.file,
      sourceSha256: sha256(content),
      budgetChars,
      maxEvidence,
    });
    const rendered = this.json ? `${JSON.stringify(digest)}\n` : renderTaskContextDigest(digest);
    if (rendered.length > budgetChars) {
      this.context.stderr.write(
        `task digest budget too small for required metadata; need at least ${String(rendered.length)} chars\n`,
      );
      return 1;
    }
    this.context.stdout.write(rendered);
    return 0;
  }
}
