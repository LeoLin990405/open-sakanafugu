import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { Cli } from 'clipanion';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { incidentPacket } from '../../domain/incident-packet.js';
import { buildCli } from '../cli.js';

const collector = (): { readonly stream: Writable; readonly text: () => string } => {
  let buf = '';
  const stream = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, text: () => buf };
};

const run = async (
  argv: readonly string[],
  options: { readonly stdin?: Readable } = {},
): Promise<{ readonly code: number; readonly out: string; readonly err: string }> => {
  const out = collector();
  const err = collector();
  const code = await buildCli().run([...argv], {
    ...Cli.defaultContext,
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    stdout: out.stream,
    stderr: err.stream,
  });
  return { code, out: out.text(), err: err.text() };
};

describe('incident packet command', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fugue-incident-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('prints a markdown packet for a failure log file', async () => {
    const file = join(dir, 'failure.log');
    await writeFile(file, 'VERDICT: NEEDS FIX\nFAIL src/foo.test.ts\n', 'utf8');

    const result = await run(['incident', 'packet', file]);

    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toContain('[incident:packet] incidents=2');
    expect(result.out).toContain('review-needs-fix');
    expect(result.out).toContain('verification-failure');
  });

  it('prints JSON for stdin and uses --source-ref in provenance', async () => {
    const result = await run(
      ['incident', 'packet', '-', '--json', '--source-ref', 'TASK-2026-06-29-036.md'],
      {
        stdin: Readable.from(['spawn cc-kimi ENOENT\n']),
      },
    );

    expect(result.code).toBe(0);
    const packet = JSON.parse(result.out) as {
      readonly sourceRef: string;
      readonly incidents: readonly {
        readonly kind: string;
        readonly failureCause: string;
      }[];
    };
    expect(packet.sourceRef).toBe('TASK-2026-06-29-036.md');
    expect(packet.incidents[0]).toMatchObject({
      kind: 'tooling-error',
      failureCause: 'tooling',
    });
  });

  it('fails cleanly for a missing incident input file', async () => {
    const result = await run(['incident', 'packet', join(dir, 'missing.log')]);

    expect(result.code).toBe(1);
    expect(result.err).toContain('no incident input file');
  });

  it('fails cleanly for empty input', async () => {
    const file = join(dir, 'empty.log');
    await writeFile(file, '  \n', 'utf8');

    const result = await run(['incident', 'packet', file]);

    expect(result.code).toBe(1);
    expect(result.err).toContain('incident input is empty');
  });
});

describe('incident recovery command', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fugue-incident-recovery-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('prints ready markdown recovery guidance for a failure log file', async () => {
    const file = join(dir, 'failure.log');
    await writeFile(file, 'VERDICT: NEEDS FIX\nFAIL src/foo.test.ts\n', 'utf8');

    const result = await run(['incident', 'recovery', file]);

    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toContain('[incident:recovery] disposition=READY steps=4');
    expect(result.out).toContain('## Guidance Gate');
    expect(result.out).toContain('## Recovery Steps');
  });

  it('prints blocked JSON and exits 2 when no incident evidence is detected', async () => {
    const result = await run(['incident', 'recovery', '-', '--json'], {
      stdin: Readable.from(['All checks passed.\n']),
    });

    expect(result.code).toBe(2);
    const packet = JSON.parse(result.out) as {
      readonly guidanceGate: { readonly disposition: string };
      readonly steps: readonly unknown[];
      readonly issues: readonly { readonly kind: string }[];
    };
    expect(packet.guidanceGate.disposition).toBe('blocked');
    expect(packet.steps).toEqual([]);
    expect(packet.issues[0]?.kind).toBe('no-incident-evidence');
  });

  it('accepts incident packet JSON as recovery input', async () => {
    const packet = incidentPacket('spawn cc-kimi ENOENT\n', {
      sourceRef: 'worker.log',
      sourceSha256: 'hash',
    });
    const file = join(dir, 'incident.json');
    await writeFile(file, JSON.stringify(packet), 'utf8');

    const result = await run(['incident', 'recovery', file, '--json', '--source-ref', 'TASK.md']);

    expect(result.code).toBe(0);
    const recovery = JSON.parse(result.out) as {
      readonly sourceRef: string;
      readonly stepCount: number;
      readonly steps: readonly { readonly failureCause: string }[];
    };
    expect(recovery.sourceRef).toBe('TASK.md');
    expect(recovery.stepCount).toBe(4);
    expect(recovery.steps[0]?.failureCause).toBe('tooling');
  });
});
