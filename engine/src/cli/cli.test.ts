import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { Cli } from 'clipanion';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsRunStore } from '../adapters/store/fs-run-store.js';
import { parseAgentRegistryJson } from '../domain/agent-registry.js';
import type { HarnessConfig } from '../domain/self-harness.js';
import { EDITABLE_SURFACES } from '../domain/self-harness.js';
import { parseSelfHarnessSpec } from '../domain/self-harness-spec.js';
import { NodeFileSystem } from '../infra/node-file-system.js';
import { buildCli } from './cli.js';

const collector = (): { stream: Writable; text: () => string } => {
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
): Promise<{ code: number; out: string; err: string }> => {
  const out = collector();
  const err = collector();
  const code = await buildCli().run([...argv], {
    ...Cli.defaultContext,
    stdout: out.stream,
    stderr: err.stream,
  });
  return { code, out: out.text(), err: err.text() };
};

describe('fugue CLI', () => {
  it('prints the version', async () => {
    const { code, out } = await run(['version']);
    expect(code).toBe(0);
    expect(out).toContain('0.0.0');
  });

  it('prints the doctor quiet summary', async () => {
    const { code, out } = await run(['doctor', '--quiet']);
    expect(code).toBe(0);
    expect(out).toContain('agents=');
    expect(out).toContain('backends_ready=');
  });

  it('errors with exit 1 on a missing goal spec', async () => {
    const { code, err } = await run(['goal', 'check', '/no/such/spec.txt']);
    expect(code).toBe(1);
    expect(err).toContain('no goal spec');
  });

  it('prints a goal template', async () => {
    const { code, out } = await run(['goal', 'template']);
    expect(code).toBe(0);
    expect(out).toContain('outcome:');
    expect(out).toContain('gate:');
  });

  describe('goal check against a real spec', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-cli-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('reports GOAL MET when the gate command exits 0', async () => {
      const spec = join(dir, 'goal.txt');
      await writeFile(spec, 'outcome: ship it\ngate: true\nrounds: 1\n', 'utf8');
      const { code, out } = await run(['goal', 'check', spec]);
      expect(code).toBe(0);
      expect(out).toContain('GOAL MET');
    });

    it('reports GOAL NOT MET when the gate command fails', async () => {
      const spec = join(dir, 'goal.txt');
      await writeFile(spec, 'outcome: ship it\ngate: false\nrounds: 1\n', 'utf8');
      const { code, out } = await run(['goal', 'check', spec]);
      expect(code).toBe(1);
      expect(out).toContain('GOAL NOT MET');
    });

    it('never reports MET for a spec with no gate command', async () => {
      const spec = join(dir, 'goal.txt');
      await writeFile(spec, 'outcome: ship it\nrounds: 1\n', 'utf8');
      const { code, out } = await run(['goal', 'check', spec]);
      expect(code).toBe(1);
      expect(out).toContain('GOAL NOT MET');
    });

    it('shows the parsed goal fields', async () => {
      const spec = join(dir, 'goal.txt');
      await writeFile(
        spec,
        'outcome: ship it\ngate: true\nrubric: no regression\nrounds: 2\nallocate: manual\n',
        'utf8',
      );
      const { code, out } = await run(['goal', 'show', spec]);
      expect(code).toBe(0);
      expect(out).toContain('outcome:  ship it');
      expect(out).toContain('rounds:   2');
      expect(out).toContain('allocate: manual');
    });
  });

  describe('task new --priority validation', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-task-'));
      process.env.TASKS = dir;
    });
    afterEach(async () => {
      delete process.env.TASKS;
      await rm(dir, { recursive: true, force: true });
    });

    it('rejects an invalid --priority instead of silently defaulting', async () => {
      // clipanion renders a thrown UsageError to stdout as "Usage Error: ..."
      const { code, out } = await run(['task', 'new', 'a task', '--priority', 'P9']);
      expect(code).not.toBe(0);
      expect(out).toContain('invalid --priority');
    });

    it('accepts P0 and writes the TASK file', async () => {
      const { code, out } = await run(['task', 'new', 'a task', '--priority', 'P0']);
      expect(code).toBe(0);
      expect(out).toContain('TASK-');
    });
  });

  describe('template rendering', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-template-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('renders a template with --set variables and leaves unknown placeholders intact', async () => {
      await writeFile(join(dir, 'impl.md'), 'Role: {{ROLE}}\nScope: {{SCOPE}}\n', 'utf8');
      const { code, out } = await run(['template', 'impl', '--dir', dir, '--set', 'ROLE=backend']);

      expect(code).toBe(0);
      expect(out).toContain('Role: backend');
      expect(out).toContain('Scope: {{SCOPE}}');
    });

    it('rejects malformed --set values', async () => {
      await writeFile(join(dir, 'impl.md'), 'Role: {{ROLE}}\n', 'utf8');
      const { code, out } = await run(['template', 'impl', '--dir', dir, '--set', 'BAD']);

      expect(code).not.toBe(0);
      expect(out).toContain('--set format should be KEY=VALUE');
    });
  });

  describe('agent-registry', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-agent-registry-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('template prints parseable registry JSON', async () => {
      const { code, out } = await run(['agent-registry', 'template']);

      expect(code).toBe(0);
      expect(out).toContain('"agents"');
      expect(out).toContain('"codex"');
      expect(parseAgentRegistryJson(out).ok).toBe(true);
    });

    it('validates, lists, and resolves a registry file', async () => {
      const template = await run(['agent-registry', 'template']);
      const registry = join(dir, 'agents.json');
      await writeFile(registry, template.out, 'utf8');

      const valid = await run(['agent-registry', 'validate', registry]);
      const list = await run(['agent-registry', 'list', registry]);
      const resolved = await run(['agent-registry', 'resolve', registry, 'coder']);

      expect(valid.code).toBe(0);
      expect(valid.out).toContain('OK agent registry valid');
      expect(list.code).toBe(0);
      expect(list.out).toContain('coder\tcodex\tgpt-5.5');
      expect(resolved.code).toBe(0);
      expect(resolved.out).toContain('harness\tcodex');
      expect(resolved.out).toContain('target\tgpt-5.5');
    });

    it('rejects invalid registry JSON', async () => {
      const registry = join(dir, 'bad.json');
      await writeFile(registry, '{ nope', 'utf8');

      const { code, err } = await run(['agent-registry', 'validate', registry]);

      expect(code).toBe(1);
      expect(err).toContain('invalid JSON:');
    });
  });

  describe('self-harness', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-self-harness-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('template prints parseable JSON containing all editable surfaces', async () => {
      const { code, out } = await run(['self-harness', 'template']);

      expect(code).toBe(0);
      for (const surface of EDITABLE_SURFACES) {
        expect(out).toContain(`"${surface}"`);
      }
      const parsed = parseSelfHarnessSpec(out);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(parsed.error);
      expect(parsed.value.heldIn[0]?.gate).toContain('rm -f /tmp/fugue-self-harness-held-in');
      expect(parsed.value.heldOut[0]?.gate).toContain('rm -f /tmp/fugue-self-harness-held-out');
    });

    it('run exits 1 with a clear error for a missing spec', async () => {
      const { code, err } = await run(['self-harness', 'run', '--spec', '/no/such/spec.json']);

      expect(code).toBe(1);
      expect(err).toContain('no self-harness spec');
    });

    it('run exits 1 for an invalid JSON spec', async () => {
      const spec = join(dir, 'bad.json');
      await writeFile(spec, '{ nope', 'utf8');

      const { code, err } = await run(['self-harness', 'run', '--spec', spec]);

      expect(code).toBe(1);
      expect(err).toContain('invalid JSON:');
    });

    it('run reads the run store and reports same surfaces when no weaknesses are mined', async () => {
      const runId = 'run-without-failures';
      const state = join(dir, 'state');
      const runs = join(state, 'runs');
      const runStore = new FsRunStore(new NodeFileSystem(), runs);
      await runStore.create(runId, 'dispatch');
      await runStore.appendEvent(runId, {
        at: 1,
        phase: 'dispatch',
        kind: 'dispatched',
        detail: 'task-a -> agent',
      });

      const config: HarnessConfig = {
        'system-prompt': 'sys',
        'memory-sources': 'mem',
        subagents: 'subs',
        skills: 'skills',
        bootstrap: 'boot',
        execution: 'exec',
        verification: 'verify',
        'failure-recovery': 'recover',
        'runtime-policy': 'policy',
      };
      const spec = join(dir, 'self-harness.json');
      await writeFile(
        spec,
        `${JSON.stringify({
          agent: 'unused-agent',
          k: 1,
          rounds: 1,
          runId,
          config,
          heldIn: [],
          heldOut: [],
        })}\n`,
        'utf8',
      );

      const { code, out } = await run([
        'self-harness',
        'run',
        '--spec',
        spec,
        '--state',
        state,
        '--cwd',
        dir,
      ]);

      expect(code).toBe(0);
      expect(out).toContain('system-prompt = same');
      expect(out).toContain('runtime-policy = same');
      expect(out).toContain('rounds: 1, promoted: 0');
    });

    it('runs from the generated template when the source run has no weaknesses', async () => {
      const template = await run(['self-harness', 'template']);
      expect(template.code).toBe(0);

      const parsed = parseSelfHarnessSpec(template.out);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(parsed.error);

      const state = join(dir, 'state-from-template');
      const runStore = new FsRunStore(new NodeFileSystem(), join(state, 'runs'));
      await runStore.create(parsed.value.runId, 'dispatch');
      await runStore.appendEvent(parsed.value.runId, {
        at: 1,
        phase: 'dispatch',
        kind: 'dispatched',
        detail: 'task-a -> agent',
      });

      const spec = join(dir, 'generated-self-harness.json');
      await writeFile(spec, template.out, 'utf8');

      const { code, out, err } = await run([
        'self-harness',
        'run',
        '--spec',
        spec,
        '--state',
        state,
        '--cwd',
        dir,
      ]);

      expect(err).toBe('');
      expect(code).toBe(0);
      expect(out).toContain('system-prompt = same');
      expect(out).toContain('runtime-policy = same');
      expect(out).toContain('rounds: 1, promoted: 0');
    });
  });
});
