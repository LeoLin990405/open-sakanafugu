import { createHash } from 'node:crypto';

import { Command, Option } from 'clipanion';

import { renderRuntimeGuardPacket, runtimeGuardPacket } from '../../domain/runtime-guard.js';
import { NodeFileSystem } from '../../infra/node-file-system.js';

const fs = (): NodeFileSystem => new NodeFileSystem();

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const readStream = async (stream: AsyncIterable<Buffer | string>): Promise<string> => {
  let out = '';
  for await (const chunk of stream) {
    out += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }
  return out;
};

/** `fugue guard prompt <file|->` — pre-dispatch runtime guard packet for prompt safety. */
export class GuardPromptCommand extends Command {
  static override paths = [['guard', 'prompt']];

  file = Option.String();
  sourceRef = Option.String('--source-ref');
  json = Option.Boolean('--json', false);

  override async execute(): Promise<number> {
    const content =
      this.file === '-'
        ? await readStream(this.context.stdin as AsyncIterable<Buffer | string>)
        : await fs().read(this.file);
    if (content === null) {
      this.context.stderr.write(`no prompt file ${this.file}\n`);
      return 1;
    }
    if (content.trim().length === 0) {
      this.context.stderr.write('prompt input is empty\n');
      return 1;
    }
    const sourceRef = this.sourceRef ?? (this.file === '-' ? 'stdin' : this.file);
    const sourceSha256 = sha256(content);
    const packet =
      this.sourceRef === undefined
        ? runtimeGuardPacket(content, { sourceRef, sourceSha256 })
        : runtimeGuardPacket(content, {
            sourceRef,
            sourceSha256,
            sourceRefIsExternal: true,
          });
    this.context.stdout.write(
      this.json ? `${JSON.stringify(packet, null, 2)}\n` : renderRuntimeGuardPacket(packet),
    );
    return packet.disposition === 'block' ? 2 : 0;
  }
}
