import { join as joinPath } from 'node:path';

import { Command, Option, UsageError } from 'clipanion';

import { renderTemplate } from '../../domain/prompt-render.js';
import { NodeFileSystem } from '../../infra/node-file-system.js';

const parseSet = (raw: string): readonly [string, string] => {
  const eq = raw.indexOf('=');
  if (eq <= 0) throw new UsageError(`--set format should be KEY=VALUE, got '${raw}'`);
  return [raw.slice(0, eq), raw.slice(eq + 1)] as const;
};

const varsFromSets = (sets: readonly string[]): Readonly<Record<string, string>> => {
  const vars: Record<string, string> = {};
  for (const raw of sets) {
    const [key, value] = parseSet(raw);
    vars[key] = value;
  }
  return vars;
};

/** `fugue template <name> --dir <templates> [--set KEY=VALUE ...]` — render a prompt template. */
export class TemplateRenderCommand extends Command {
  static override paths = [['template']];

  name = Option.String();
  dir = Option.String('--dir', { required: true });
  sets = Option.Array('--set', []);

  override async execute(): Promise<number> {
    const file = joinPath(this.dir, `${this.name}.md`);
    const template = await new NodeFileSystem().read(file);
    if (template === null) {
      this.context.stderr.write(`no template '${this.name}' (in ${this.dir})\n`);
      return 1;
    }
    this.context.stdout.write(`${renderTemplate(template, varsFromSets(this.sets))}\n`);
    return 0;
  }
}
