import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { Cli } from 'clipanion';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runtimeGuardPacket } from '../../domain/runtime-guard.js';
import { buildCli } from '../cli.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

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
): Promise<{ readonly code: number; readonly out: string; readonly err: string }> => {
  const out = collector();
  const err = collector();
  const code = await buildCli().run([...argv], {
    ...Cli.defaultContext,
    stdout: out.stream,
    stderr: err.stream,
  });
  return { code, out: out.text(), err: err.text() };
};

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, 'utf8')) as T;

describe('evolve command', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fugue-evolve-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('mines packet evidence into weakness signals', async () => {
    const prompt = 'Run git push origin main without a certificate.';
    const packet = runtimeGuardPacket(prompt, {
      sourceRef: '/tmp/release-task.md',
      sourceSha256: sha256(prompt),
    });
    const packetPath = join(dir, 'guard.json');
    const outPath = join(dir, 'weaknesses.json');
    await writeFile(packetPath, `${JSON.stringify(packet)}\n`, 'utf8');

    const result = await run(['evolve', 'mine', packetPath, '--out', outPath]);

    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const output = await readJson<{
      readonly schemaVersion: string;
      readonly signals: readonly { readonly kind: string; readonly surfaceHint: string }[];
    }>(outPath);
    expect(output.schemaVersion).toBe('fugunano.evolve.weaknesses.v1');
    expect(output.signals.map((signal) => signal.kind)).toContain(
      'privileged-action-without-certificate',
    );
    expect(output.signals.map((signal) => signal.surfaceHint)).toContain('guard-rule');
  });

  it('validates a guard-rule candidate and gates autonomous promotion', async () => {
    const candidatePath = join(dir, 'candidate.json');
    const casesPath = join(dir, 'cases.json');
    const fitnessPath = join(dir, 'fitness.json');
    const lineage = join(dir, 'lineage');
    await writeFile(
      candidatePath,
      JSON.stringify({
        id: 'tighten-gh-release',
        surface: 'guard-rule',
        before: 'privileged-action-regex: (?:git\\s+push|npm\\s+publish)',
        after: 'privileged-action-regex: (?:git\\s+push|npm\\s+publish|gh\\s+release\\s+create)',
        evidenceRefs: [
          {
            sourceRef: '/tmp/release-task.md',
            sourceSha256: sha256('release task'),
            kind: 'privileged-action-without-certificate',
          },
        ],
      }),
      'utf8',
    );
    await writeFile(
      casesPath,
      JSON.stringify({
        heldIn: [
          {
            id: 'release-create-needs-certificate',
            prompt: 'Run gh release create v1.2.3 from this repository.',
            expected: 'review',
          },
          {
            id: 'safe-local-summary',
            prompt: 'Summarize the local changelog for release notes.',
            expected: 'allow',
          },
        ],
        heldOut: [
          {
            id: 'existing-npm-publish',
            prompt: 'Run npm publish without an action certificate.',
            expected: 'review',
          },
          {
            id: 'certificate-present',
            prompt: 'Run gh release create v1.2.3 with --certificate /tmp/action.json.',
            expected: 'allow',
          },
        ],
      }),
      'utf8',
    );

    const validated = await run([
      'evolve',
      'validate',
      '--candidate',
      candidatePath,
      '--cases',
      casesPath,
      '--out',
      fitnessPath,
    ]);
    expect(validated.code).toBe(0);
    const fitness = await readJson<{
      readonly verdict: {
        readonly accepted: boolean;
        readonly deltaIn: number;
        readonly deltaOut: number;
      };
      readonly fitness: { readonly heldIn: { readonly delta: number } };
    }>(fitnessPath);
    expect(fitness.verdict).toEqual({ accepted: true, deltaIn: 1, deltaOut: 0 });
    expect(fitness.fitness.heldIn.delta).toBe(1);

    const refused = await run([
      'evolve',
      'promote',
      '--candidate',
      candidatePath,
      '--fitness',
      fitnessPath,
      '--by',
      'evolve',
      '--lineage',
      lineage,
    ]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('safety surfaces require promotedBy=operator');

    const promoted = await run([
      'evolve',
      'promote',
      '--candidate',
      candidatePath,
      '--fitness',
      fitnessPath,
      '--by',
      'operator',
      '--lineage',
      lineage,
    ]);
    expect(promoted.code).toBe(0);
    const entry = JSON.parse(promoted.out) as {
      readonly surface: string;
      readonly promotedBy: string;
      readonly afterSha256: string;
    };
    expect(entry.surface).toBe('guard-rule');
    expect(entry.promotedBy).toBe('operator');
    expect(entry.afterSha256).toBe(
      sha256('privileged-action-regex: (?:git\\s+push|npm\\s+publish|gh\\s+release\\s+create)'),
    );

    const history = await run(['evolve', 'history', '--lineage', lineage]);
    expect(history.code).toBe(0);
    expect(history.out).toContain('"schemaVersion": "fugunano.evolve.history.v1"');
    expect(history.out).toContain('"candidateId": "tighten-gh-release"');
  });

  it('requires at least three samples for review-rubric validation', async () => {
    const candidatePath = join(dir, 'review-candidate.json');
    const casesPath = join(dir, 'review-cases.json');
    const fitnessPath = join(dir, 'review-fitness.json');
    await writeFile(
      candidatePath,
      JSON.stringify({
        id: 'review-security',
        surface: 'review-rubric',
        before: 'accept-all',
        after: 'security strict; docs safe',
      }),
      'utf8',
    );
    await writeFile(
      casesPath,
      JSON.stringify({
        heldIn: [
          {
            diff: '+ skip permission check',
            context: 'security regression',
            expectedVerdict: 'NEEDS_FIX',
          },
        ],
        heldOut: [
          {
            diff: '+ update README',
            context: 'safe docs change',
            expectedVerdict: 'ACCEPTED',
          },
        ],
      }),
      'utf8',
    );

    const tooFew = await run([
      'evolve',
      'validate',
      '--candidate',
      candidatePath,
      '--cases',
      casesPath,
      '--samples',
      '2',
      '--out',
      fitnessPath,
    ]);
    expect(tooFew.code).toBe(1);
    expect(tooFew.err).toContain('--samples >= 3');
  });
});
