import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { Cli } from 'clipanion';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsRunStore } from '../adapters/store/fs-run-store.js';
import { parseAgentRegistryJson } from '../domain/agent-registry.js';
import type { HarnessConfig } from '../domain/self-harness.js';
import { EDITABLE_SURFACES } from '../domain/self-harness.js';
import { parseSelfHarnessSpec } from '../domain/self-harness-spec.js';
import { NodeFileSystem } from '../infra/node-file-system.js';
import { NodeCommandRunner } from '../infra/node-command-runner.js';
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
  options: { readonly stdin?: Readable } = {},
): Promise<{ code: number; out: string; err: string }> => {
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

  describe('experience commands', () => {
    let dir: string;
    let store: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-experience-'));
      store = join(dir, 'experience');
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('adds from stdin, lists, recalls, and shows an experience', async () => {
      const add = await run(['experience', 'add', '--store', store, 'code', 'cache first'], {
        stdin: Readable.from(['check cache before curl']),
      });
      const list = await run(['experience', 'list', '--store', store, 'code']);
      const recall = await run(['experience', 'recall', '--store', store, 'code']);
      const show = await run(['experience', 'show', '--store', store, 'code', 'cache-first']);

      expect(add.code).toBe(0);
      expect(add.out).toContain('cache-first.md');
      expect(list.out).toContain('cache first');
      expect(recall.out).toContain('[experience] cache first');
      expect(recall.out).toContain('check cache before curl');
      expect(show.out).toContain('workspace: code');
      expect(show.out).toContain('title: cache first');
    });

    it('adds from --from and rejects suspected secrets', async () => {
      const source = join(dir, 'source.txt');
      await writeFile(source, 'qwen SQL window', 'utf8');
      const fromFile = await run([
        'experience',
        'add',
        '--store',
        store,
        'sql',
        'sql date window',
        '--from',
        source,
      ]);
      const rejected = await run(['experience', 'add', '--store', store, 'code', 'bad'], {
        stdin: Readable.from([`token sk-${'a'.repeat(25)}`]),
      });

      expect(fromFile.code).toBe(0);
      expect(rejected.code).toBe(1);
      expect(rejected.err).toContain('suspected key');
    });
  });

  describe('summary command', () => {
    let dir: string;
    let cache: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-summary-'));
      cache = join(dir, 'cache');
      const round = join(cache, 'round-1');
      await mkdir(round, { recursive: true });
      await writeFile(join(round, 'manifest.tsv'), 't1\tcc-deepseek\nt2\tcc-glm\n', 'utf8');
      await writeFile(
        join(round, '.started'),
        `${String(Math.floor(Date.now() / 1000) - 5)}\n`,
        'utf8',
      );
      await writeFile(join(round, 't1.status'), 'done\n', 'utf8');
      await writeFile(join(round, 't2.status'), 'fail\n', 'utf8');
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('renders a legacy cache summary and appends it to a task file', async () => {
      const task = join(dir, 'TASK.md');
      await writeFile(task, '## Log\n', 'utf8');
      const summary = await run(['summary', '1', '--cache', cache, '--task', task]);
      const taskContent = await readFile(task, 'utf8');

      expect(summary.code).toBe(0);
      expect(summary.out).toContain('### Round 1 summary');
      expect(summary.out).toContain('round-1: total=2 done=1 fail=1 pending=0');
      expect(summary.out).toContain('t1');
      expect(summary.out).toContain('cc-glm');
      expect(summary.err).toContain('written to');
      expect(taskContent).toContain('Round 1 summary');
    });

    it('returns non-zero when the round was not initialized', async () => {
      const summary = await run(['summary', '9', '--cache', cache]);

      expect(summary.code).toBe(2);
      expect(summary.err).toContain('round-9 not init');
    });
  });

  describe('plan command', () => {
    let dir: string;
    let bin: string;
    let out: string;
    let calls: string;
    let prompts: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-plan-'));
      bin = join(dir, 'fugue-cc');
      out = join(dir, 'plans');
      calls = join(dir, 'calls.txt');
      prompts = join(dir, 'prompts.txt');
      await writeFile(
        bin,
        ['#!/usr/bin/env bash', `echo "$2" >> "${calls}"`, `cat >> "${prompts}"`, ''].join('\n'),
        'utf8',
      );
      await chmod(bin, 0o755);
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('dispatches the planning prompt to selected models and lists output files', async () => {
      const planned = await run([
        'plan',
        'build a login feature',
        '--models',
        'cc-a,cc-b',
        '--out',
        out,
        '--bin',
        bin,
      ]);
      const called = await readFile(calls, 'utf8');
      const prompt = await readFile(prompts, 'utf8');

      expect(planned.code).toBe(0);
      expect(called).toContain('cc-a');
      expect(called).toContain('cc-b');
      expect(planned.out).toContain('cc-a.plan.md');
      expect(prompt).toContain('build a login feature');
      expect(prompt).toContain(`write to ${join(out, 'cc-a.plan.md')}`);
    });

    it('uses the cross-family default model set', async () => {
      await run(['plan', 'default models test', '--out', out, '--bin', bin]);
      const called = await readFile(calls, 'utf8');

      expect(called.trim().split(/\r?\n/u)).toHaveLength(3);
      expect(called).toContain('cc-deepseek');
      expect(called).toContain('cc-kimi');
      expect(called).toContain('coder');
    });
  });

  describe('preflight command', () => {
    let dir: string;
    let clean: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-preflight-'));
      clean = join(dir, 'clean.config');
      await writeFile(
        clean,
        [
          '[agents.cc-deepseek]',
          'url = "https://api.deepseek.com/anthropic"',
          'model = "deepseek-v4-pro"',
          '[agents.coder]',
          'model = "gpt-5.5"',
          '',
        ].join('\n'),
        'utf8',
      );
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('runs deterministic provider config checks in config-only mode', async () => {
      const gemini = join(dir, 'gemini.config');
      const comment = join(dir, 'comment.config');
      const empty = join(dir, 'empty.config');
      await writeFile(gemini, '[agents.cc-x]\nmodel = "gemini-3.5-flash"\n', 'utf8');
      await writeFile(comment, '# do not use gemini\n[agents.cc-z]\nmodel = "glm-5.2"\n', 'utf8');
      await writeFile(empty, '[agents.cc-w]\nmodel = ""\n', 'utf8');

      const cleanResult = await run(['preflight', '--config-only', clean]);
      const geminiResult = await run(['preflight', '--config-only', gemini]);
      const commentResult = await run(['preflight', '--config-only', comment]);
      const emptyResult = await run(['preflight', '--config-only', empty]);

      expect(cleanResult.code).toBe(0);
      expect(cleanResult.out).toContain('preflight GO');
      expect(geminiResult.code).toBe(1);
      expect(geminiResult.out).toContain('no-Gemini hard rule');
      expect(commentResult.code).toBe(0);
      expect(emptyResult.code).toBe(1);
      expect(emptyResult.out).toContain('empty model value');
    });

    it('reports the provider worktree gitignore guard as warn-only', async () => {
      const work = join(dir, 'provider-work');
      await mkdir(work, { recursive: true });
      await new NodeCommandRunner().run('git', ['-C', work, 'init', '-q']);

      const notIgnored = await run(['preflight', '--config-only', clean, '--work', work]);
      await writeFile(join(work, '.gitignore'), '.fugue-cc/\n', 'utf8');
      const ignored = await run(['preflight', '--config-only', clean, '--work', work]);

      expect(notIgnored.code).toBe(0);
      expect(notIgnored.out).toContain('not gitignored');
      expect(ignored.code).toBe(0);
      expect(ignored.out).toContain('gitignored');
    });
  });

  describe('runtime commands', () => {
    let dir: string;
    let bin: string;
    let install: string;
    let state: string;
    let work: string;
    let preflight: string;
    let calls: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-runtime-'));
      bin = join(dir, 'fugue-cc');
      install = join(dir, 'install');
      state = join(dir, 'state');
      work = join(dir, 'work');
      preflight = join(dir, 'preflight.sh');
      calls = join(dir, 'calls.txt');
      await mkdir(join(install, 'lib/provider_profiles'), { recursive: true });
      await mkdir(join(work, '.fugue-cc'), { recursive: true });
      await writeFile(join(install, 'lib/provider_profiles/api_shortcuts.py'), '', 'utf8');
      await writeFile(
        join(work, '.fugue-cc/provider.config'),
        '[agents.cc]\nmodel = "deepseek"\n',
        'utf8',
      );
      await writeFile(
        bin,
        [
          '#!/usr/bin/env bash',
          'case "$1" in',
          `  version) echo "fugue-cc runtime v9.9.9 abc"; echo "Install path: ${install}";;`,
          `  kill) echo "kill:$PWD" >> "${calls}";;`,
          '  *) exit 0;;',
          'esac',
          '',
        ].join('\n'),
        'utf8',
      );
      await chmod(bin, 0o755);
      await writeFile(preflight, '#!/usr/bin/env bash\necho "config OK: $3"\n', 'utf8');
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('checks drift, adapts, records the stamp, and reports grafting loss', async () => {
      const check = await run([
        'runtime',
        'check',
        '--bin',
        bin,
        '--state',
        state,
        '--install',
        install,
      ]);
      const dry = await run([
        'runtime',
        'adapt',
        '--bin',
        bin,
        '--state',
        state,
        '--install',
        install,
      ]);
      const apply = await run([
        'runtime',
        'adapt',
        '--bin',
        bin,
        '--state',
        state,
        '--install',
        install,
        '--work',
        work,
        '--preflight-script',
        preflight,
        '--apply',
      ]);
      const stamp = await readFile(join(state, 'runtime-version'), 'utf8');
      const killCalls = await readFile(calls, 'utf8');
      const check2 = await run([
        'runtime',
        'check',
        '--bin',
        bin,
        '--state',
        state,
        '--install',
        install,
      ]);

      await rm(join(install, 'lib/provider_profiles/api_shortcuts.py'));
      const missingGrafting = await run([
        'runtime',
        'check',
        '--bin',
        bin,
        '--state',
        state,
        '--install',
        install,
      ]);

      expect(check.code).toBe(0);
      expect(check.out).toContain('version drift');
      expect(check.out).toContain('grafting api_shortcuts.py present');
      expect(dry.out).toContain('[dry-run]');
      expect(dry.out).toContain('stamp not written');
      expect(apply.out).toContain('config validation');
      expect(apply.out).toContain('recorded v9.9.9');
      expect(stamp.trim()).toBe('v9.9.9');
      expect(killCalls).toContain('kill:');
      expect(killCalls).toContain('/work');
      expect(check2.out).toContain('no drift');
      expect(missingGrafting.out).toContain('api_shortcuts.py is gone');
    });
  });

  describe('workspace commands', () => {
    let dir: string;
    let workspaces: string;
    let allocation: string;
    let stats: string;
    let experience: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-workspace-'));
      workspaces = join(dir, 'workspaces');
      allocation = join(dir, 'allocation.tsv');
      stats = join(dir, 'allocation-stats.tsv');
      experience = join(dir, 'experience');
      await mkdir(workspaces, { recursive: true });
      await mkdir(join(experience, 'code'), { recursive: true });
      await writeFile(
        join(workspaces, 'code.workspace'),
        [
          'prompt: You are at the code station.',
          'models: @bench:code',
          'tools: read,edit,write,bash',
          'skills:',
          'memory: event,experience',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(workspaces, 'review.workspace'),
        'prompt: review\nmodels: coder\n',
        'utf8',
      );
      await writeFile(join(workspaces, '_system.md'), 'Do not call Gemini.\n', 'utf8');
      await writeFile(
        allocation,
        'code\tminimax,doubao,glm\nreview\tcoder\nfallback\tmimo\n',
        'utf8',
      );
      await writeFile(stats, '', 'utf8');
      await writeFile(
        join(experience, 'code', 'fast-path.md'),
        [
          '---',
          'workspace: code',
          'title: Fast path',
          'created: 2',
          '---',
          'Reuse this method.',
        ].join('\n'),
        'utf8',
      );
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const wsArgs = (): readonly string[] => ['--dir', workspaces];
    const modelArgs = (): readonly string[] => ['--allocation', allocation, '--stats', stats];

    it('lists, shows, resolves models, and renders layered context', async () => {
      const list = await run(['workspace', 'list', ...wsArgs()]);
      const show = await run(['workspace', 'show', ...wsArgs(), 'code']);
      const model = await run(['workspace', 'model', ...wsArgs(), ...modelArgs(), 'code']);
      const context = await run([
        'workspace',
        'context',
        ...wsArgs(),
        ...modelArgs(),
        '--experience',
        experience,
        'code',
        '--task',
        'do X',
      ]);

      expect(list.code).toBe(0);
      expect(list.out).toContain('code');
      expect(show.out).toContain('models: @bench:code');
      expect(model.out.trim()).toBe('minimax,doubao,glm');
      expect(context.code).toBe(0);
      expect(context.out).toContain('Do not call Gemini.');
      expect(context.out).toContain('[experience] Fast path');
      expect(context.out).toContain('do X');
      expect(context.out).toContain('> suggested model(bench): minimax,doubao,glm');
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
