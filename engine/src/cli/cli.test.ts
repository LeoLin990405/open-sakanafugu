import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const waitFor = async (
  predicate: () => Promise<boolean>,
  options: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? 2000;
  const pollMs = options.pollMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(pollMs);
  }
  throw new Error(`timed out after ${String(timeoutMs)}ms`);
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

  it('counts launcher alternate API keys as configured in doctor output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fugue-doctor-path-'));
    const originalEnv = {
      PATH: process.env.PATH,
      BIGMODEL_API_KEY: process.env.BIGMODEL_API_KEY,
      BAILIAN_API_KEY: process.env.BAILIAN_API_KEY,
      VOLC_API_KEY: process.env.VOLC_API_KEY,
      XIAOMI_API_KEY: process.env.XIAOMI_API_KEY,
      STEP_API_KEY: process.env.STEP_API_KEY,
      GLM_API_KEY: process.env.GLM_API_KEY,
      ZAI_API_KEY: process.env.ZAI_API_KEY,
      QWEN_API_KEY: process.env.QWEN_API_KEY,
      DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
      DOUBAO_API_KEY: process.env.DOUBAO_API_KEY,
      ARK_API_KEY: process.env.ARK_API_KEY,
      MIMO_API_KEY: process.env.MIMO_API_KEY,
      STEPFUN_API_KEY: process.env.STEPFUN_API_KEY,
    };
    const restore = (): void => {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };

    try {
      for (const launcher of ['cc-glm', 'cc-qwen', 'cc-doubao', 'cc-mimo', 'cc-stepfun']) {
        const file = join(dir, launcher);
        await writeFile(file, '#!/bin/sh\nexit 0\n', 'utf8');
        await chmod(file, 0o755);
      }

      process.env.PATH = `${dir}:/bin:/usr/bin`;
      for (const key of Object.keys(originalEnv)) {
        if (key !== 'PATH') delete process.env[key];
      }
      process.env.BIGMODEL_API_KEY = 'x';
      process.env.BAILIAN_API_KEY = 'x';
      process.env.VOLC_API_KEY = 'x';
      process.env.XIAOMI_API_KEY = 'x';
      process.env.STEP_API_KEY = 'x';

      const { code, out } = await run(['doctor']);

      expect(code).toBe(0);
      expect(out).toContain('✓ cc-glm (ready)');
      expect(out).toContain('✓ cc-qwen (ready)');
      expect(out).toContain('✓ cc-doubao (ready)');
      expect(out).toContain('✓ cc-mimo (ready)');
      expect(out).toContain('✓ cc-stepfun (ready)');
    } finally {
      restore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('init command', () => {
    let dir: string;
    let secrets: string;
    let providerConfig: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-init-'));
      secrets = join(dir, 'cc-model-secrets.env');
      providerConfig = join(dir, '.fugue-cc', 'provider.config');
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('prints a dry-run readiness report without creating local templates', async () => {
      const { code, out } = await run([
        'init',
        '--dry-run',
        '--project',
        dir,
        '--secrets',
        secrets,
      ]);

      expect(code).toBe(0);
      expect(out).toContain('FuguNano init (dry-run)');
      expect(out).toContain('would create secrets template');
      expect(out).toContain('would copy provider config example');
      expect(out).toContain('fuguectl preflight --harness codex');
      expect(out).toContain('fuguectl preflight --harness agy');
      await expect(readFile(secrets, 'utf8')).rejects.toThrow();
      await expect(readFile(providerConfig, 'utf8')).rejects.toThrow();
    });

    it('creates missing local templates only when --write is explicit', async () => {
      await writeFile(join(dir, '.gitignore'), '.fugue-cc/\n', 'utf8');

      const { code, out } = await run(['init', '--write', '--project', dir, '--secrets', secrets]);

      expect(code).toBe(0);
      expect(out).toContain('FuguNano init (write)');
      expect(out).toContain('created secrets template');
      expect(out).toContain('copied provider config example');
      expect(await readFile(secrets, 'utf8')).toContain('DEEPSEEK_API_KEY=');
      expect(await readFile(providerConfig, 'utf8')).toContain('version = 2');
    });

    it('rejects mutually exclusive dry-run and write modes', async () => {
      const { code, err } = await run([
        'init',
        '--dry-run',
        '--write',
        '--project',
        dir,
        '--secrets',
        secrets,
      ]);

      expect(code).toBe(2);
      expect(err).toContain('choose either --dry-run or --write');
    });
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

    it('accepts the legacy positional priority', async () => {
      const { code, out } = await run(['task', 'new', 'legacy priority', 'P0']);
      expect(code).toBe(0);
      const file = out.trim();
      expect(await readFile(file, 'utf8')).toContain('Priority: P0');
    });

    it('creates unique task files under concurrent task new calls', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) => run(['task', 'new', `parallel ${String(index)}`])),
      );
      const paths = results.map((result) => result.out.trim());

      expect(results.every((result) => result.code === 0)).toBe(true);
      expect(new Set(paths).size).toBe(paths.length);
      for (const path of paths) {
        expect(await readFile(path, 'utf8')).toContain('Status: IN_PROGRESS');
      }
    });

    it('joins split log words into one message', async () => {
      const created = await run(['task', 'new', 'log target']);
      const file = created.out.trim();

      const { code } = await run(['task', 'log', file, 'first', 'second']);

      expect(code).toBe(0);
      expect(await readFile(file, 'utf8')).toContain('first second');
    });

    it('preserves concurrent task log entries', async () => {
      const created = await run(['task', 'new', 'concurrent log target']);
      const file = created.out.trim();
      const messages = Array.from({ length: 8 }, (_, index) => `audit-${String(index + 1)}`);

      const results = await Promise.all(
        messages.map((message) => run(['task', 'log', file, message])),
      );
      const content = await readFile(file, 'utf8');

      expect(results.every((result) => result.code === 0)).toBe(true);
      for (const message of messages) expect(content).toContain(message);
    });

    it('preserves logs written while task done is running', async () => {
      const created = await run(['task', 'new', 'done log target']);
      const file = created.out.trim();
      const messages = Array.from({ length: 8 }, (_, index) => `done-race-${String(index + 1)}`);

      const results = await Promise.all([
        run(['task', 'done', file]),
        ...messages.map((message) => run(['task', 'log', file, message])),
      ]);
      const content = await readFile(file, 'utf8');

      expect(results.every((result) => result.code === 0)).toBe(true);
      expect(content).toContain('Status: DONE');
      for (const message of messages) expect(content).toContain(message);
    });
  });

  describe('template rendering', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-template-'));
    });
    afterEach(async () => {
      delete process.env.FUGUE_TEMPLATES;
      await rm(dir, { recursive: true, force: true });
    });

    it('renders a template with --set variables and leaves unknown placeholders intact', async () => {
      await writeFile(join(dir, 'impl.md'), 'Role: {{ROLE}}\nScope: {{SCOPE}}\n', 'utf8');
      const { code, out } = await run(['template', 'impl', '--dir', dir, '--set', 'ROLE=backend']);

      expect(code).toBe(0);
      expect(out).toContain('Role: backend');
      expect(out).toContain('Scope: {{SCOPE}}');
    });

    it('uses FUGUE_TEMPLATES when --dir is omitted', async () => {
      process.env.FUGUE_TEMPLATES = dir;
      await writeFile(join(dir, 'impl.md'), 'Role: {{ROLE}}\n', 'utf8');

      const { code, out } = await run(['template', 'impl', '--set', 'ROLE=backend']);

      expect(code).toBe(0);
      expect(out).toContain('Role: backend');
    });

    it('rejects malformed --set values', async () => {
      await writeFile(join(dir, 'impl.md'), 'Role: {{ROLE}}\n', 'utf8');
      const { code, out } = await run(['template', 'impl', '--dir', dir, '--set', 'BAD']);

      expect(code).not.toBe(0);
      expect(out).toContain('--set format should be KEY=VALUE');
    });
  });

  describe('dispatch command', () => {
    let dir: string;
    let templates: string;
    let workspaces: string;
    let allocation: string;
    let stats: string;
    let experience: string;
    let ledger: string;
    let promptFile: string;
    let codexBin: string;
    let opencodeBin: string;
    let fugueCcCalled: string;
    let codexCalled: string;
    let opencodeCalled: string;
    let agyCalled: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-dispatch-'));
      templates = join(dir, 'templates');
      workspaces = join(dir, 'workspaces');
      allocation = join(dir, 'allocation.tsv');
      stats = join(dir, 'allocation-stats.tsv');
      experience = join(dir, 'experience');
      ledger = join(dir, 'alloc-ledger.tsv');
      promptFile = join(dir, 'prompt.md');
      fugueCcCalled = join(dir, 'fugue-cc.called');
      codexCalled = join(dir, 'codex.called');
      opencodeCalled = join(dir, 'opencode.called');
      agyCalled = join(dir, 'agy.called');
      await mkdir(templates, { recursive: true });
      await mkdir(workspaces, { recursive: true });
      await writeFile(join(templates, 'impl.md'), 'Role={{ROLE}}\nScope={{SCOPE}}\n', 'utf8');
      await writeFile(join(workspaces, '_system.md'), 'global review independence rule\n', 'utf8');
      await writeFile(
        join(workspaces, 'code.workspace'),
        [
          'prompt: Code station prompt',
          'tools: read,edit',
          'skills: existing',
          'memory: experience',
          'models: @bench:code',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(allocation, 'code\tminimax,doubao,glm\nfallback\tmimo\n', 'utf8');
      await writeFile(promptFile, 'custom prompt content', 'utf8');

      const fugueCc = join(dir, 'fugue-cc');
      const codex = join(dir, 'codex');
      const opencode = join(dir, 'opencode');
      const agy = join(dir, 'agy');
      codexBin = codex;
      opencodeBin = opencode;
      await writeFile(
        fugueCc,
        [
          '#!/usr/bin/env bash',
          `echo "ARGV: $*" > "${fugueCcCalled}"`,
          `cat >> "${fugueCcCalled}"`,
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        codex,
        ['#!/usr/bin/env bash', `echo "ARGV: $*" > "${codexCalled}"`, ''].join('\n'),
        'utf8',
      );
      await writeFile(
        opencode,
        ['#!/usr/bin/env bash', `echo "ARGV: $*" > "${opencodeCalled}"`, ''].join('\n'),
        'utf8',
      );
      await writeFile(
        agy,
        ['#!/usr/bin/env bash', `echo "ARGV: $*" > "${agyCalled}"`, ''].join('\n'),
        'utf8',
      );
      await chmod(fugueCc, 0o755);
      await chmod(codex, 0o755);
      await chmod(opencode, 0o755);
      await chmod(agy, 0o755);
      process.env.FUGUE_CC_BIN = fugueCc;
      process.env.FUGUE_CODEX = codex;
      process.env.FUGUE_OPENCODE = opencode;
      process.env.FUGUE_AGY = agy;
    });

    afterEach(async () => {
      delete process.env.FUGUE_CC_BIN;
      delete process.env.FUGUE_CODEX;
      delete process.env.FUGUE_OPENCODE;
      delete process.env.FUGUE_AGY;
      delete process.env.FUGUE_SKILLS_ROOT;
      delete process.env.FUGUE_PLUGINS_ROOT;
      delete process.env.FUGUE_TEMPLATES;
      delete process.env.FUGUE_WORKSPACES;
      delete process.env.FUGUE_ALLOCATION;
      delete process.env.FUGUE_ALLOCATION_STATS;
      delete process.env.FUGUE_EXPERIENCE;
      delete process.env.FUGUE_ALLOCATION_LEDGER;
      await rm(dir, { recursive: true, force: true });
    });

    const args = (...rest: readonly string[]): readonly string[] => [
      'dispatch',
      '--templates',
      templates,
      '--workspaces',
      workspaces,
      '--allocation',
      allocation,
      '--stats',
      stats,
      '--experience',
      experience,
      '--ledger',
      ledger,
      ...rest,
    ];

    it('renders templates, dispatches through fugue-cc, and records task/ledger side effects', async () => {
      const task = join(dir, 'TASK.md');
      await writeFile(task, '## Execution log\n', 'utf8');

      const dispatched = await run(
        args(
          'cc-deepseek',
          '--template',
          'impl',
          '--set',
          'ROLE=BACKEND-ROLE',
          '--set',
          'SCOPE=SCOPE-MARK',
          '--task',
          task,
          '--task-type',
          'code',
        ),
      );
      const called = await readFile(fugueCcCalled, 'utf8');
      const taskLog = await readFile(task, 'utf8');
      const ledgerLog = await readFile(ledger, 'utf8');

      expect(dispatched.code).toBe(0);
      expect(called).toContain('ARGV: ask cc-deepseek --compact');
      expect(called).toContain('BACKEND-ROLE');
      expect(called).toContain('SCOPE-MARK');
      expect(taskLog).toContain('dispatch → cc-deepseek');
      expect(taskLog).toContain('status=ok');
      expect(taskLog).toContain('took=');
      expect(taskLog).toContain('output_chars=0');
      expect(ledgerLog).toContain('code\tcc-deepseek');
    });

    it('records a started task log line before a long dispatch finishes', async () => {
      const task = join(dir, 'TASK-inflight.md');
      const marker = join(dir, 'harness-started');
      const outFile = join(dir, 'artifacts', 'slow.txt');
      const slowFugueCc = join(dir, 'slow-fugue-cc');
      await writeFile(task, '## Execution log\n', 'utf8');
      await writeFile(
        slowFugueCc,
        [
          '#!/usr/bin/env bash',
          `touch "${marker}"`,
          'cat >/dev/null',
          'sleep 1',
          'printf "slow-output\\n"',
          '',
        ].join('\n'),
        'utf8',
      );
      await chmod(slowFugueCc, 0o755);
      process.env.FUGUE_CC_BIN = slowFugueCc;

      const pending = run(
        args(
          'cc-slow',
          '--prompt',
          'slow dispatch',
          '--out',
          outFile,
          '--task',
          task,
          '--require-output',
        ),
      );
      try {
        await waitFor(async () =>
          readFile(marker, 'utf8').then(
            () => true,
            () => false,
          ),
        );
        const inFlightLog = await readFile(task, 'utf8');

        expect(inFlightLog).toContain(
          `dispatch → cc-slow [fugue-cc] (status=started out=${outFile})`,
        );
        expect(inFlightLog).not.toContain('status=ok rc=0');

        const dispatched = await pending;
        const finalLog = await readFile(task, 'utf8');

        expect(dispatched.code).toBe(0);
        expect(dispatched.out).toBe('slow-output\n');
        expect(finalLog).toContain('status=ok rc=0');
      } finally {
        await pending.catch(() => undefined);
      }
    });

    it('preserves task audit lines from concurrent dispatches', async () => {
      const task = join(dir, 'TASK-concurrent.md');
      const slowFugueCc = join(dir, 'concurrent-fugue-cc');
      await writeFile(task, '## Execution log\n', 'utf8');
      await writeFile(
        slowFugueCc,
        [
          '#!/usr/bin/env bash',
          'agent="$2"',
          'cat >/dev/null',
          'sleep 0.2',
          'printf "done:%s\\n" "$agent"',
          '',
        ].join('\n'),
        'utf8',
      );
      await chmod(slowFugueCc, 0o755);
      process.env.FUGUE_CC_BIN = slowFugueCc;

      const [first, second] = await Promise.all([
        run(args('cc-audit-a', '--prompt', 'a', '--task', task, '--require-output')),
        run(args('cc-audit-b', '--prompt', 'b', '--task', task, '--require-output')),
      ]);
      const taskLog = await readFile(task, 'utf8');

      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect(taskLog.match(/status=started/gu)?.length).toBe(2);
      expect(taskLog.match(/status=ok rc=0/gu)?.length).toBe(2);
      expect(taskLog).toContain('dispatch → cc-audit-a [fugue-cc] (status=started');
      expect(taskLog).toContain('dispatch → cc-audit-b [fugue-cc] (status=started');
      expect(taskLog).toContain('dispatch → cc-audit-a [fugue-cc] (status=ok rc=0');
      expect(taskLog).toContain('dispatch → cc-audit-b [fugue-cc] (status=ok rc=0');
    });

    it('uses env-backed default path options when dispatch paths are omitted', async () => {
      process.env.FUGUE_TEMPLATES = templates;
      process.env.FUGUE_WORKSPACES = workspaces;
      process.env.FUGUE_ALLOCATION = allocation;
      process.env.FUGUE_ALLOCATION_STATS = stats;
      process.env.FUGUE_EXPERIENCE = experience;
      process.env.FUGUE_ALLOCATION_LEDGER = ledger;

      const dispatched = await run([
        'dispatch',
        'cc-env',
        '--workspace',
        'code',
        '--template',
        'impl',
        '--set',
        'ROLE=ENV-ROLE',
        '--set',
        'SCOPE=ENV-SCOPE',
        '--task-type',
        'code',
      ]);
      const called = await readFile(fugueCcCalled, 'utf8');
      const ledgerLog = await readFile(ledger, 'utf8');

      expect(dispatched.code).toBe(0);
      expect(called).toContain('Code station prompt');
      expect(called).toContain('minimax,doubao,glm');
      expect(called).toContain('ENV-ROLE');
      expect(called).toContain('ENV-SCOPE');
      expect(ledgerLog).toContain('code\tcc-env');
    });

    it('dispatches prompt files through codex, opencode, and agy harnesses', async () => {
      const codexDispatch = await run(
        args('gpt-5.5', '--harness', 'codex', '--prompt-file', promptFile),
      );
      const opencodeDispatch = await run(
        args('doubao/doubao-code', '--harness', 'opencode', '--prompt-file', promptFile),
      );
      const agyDispatch = await run(
        args('default', '--harness', 'agy', '--prompt-file', promptFile),
      );
      const codexCall = await readFile(codexCalled, 'utf8');
      const opencodeCall = await readFile(opencodeCalled, 'utf8');
      const agyCall = await readFile(agyCalled, 'utf8');

      expect(codexDispatch.code).toBe(0);
      expect(opencodeDispatch.code).toBe(0);
      expect(agyDispatch.code).toBe(0);
      expect(codexCall).toContain('ARGV: exec --model gpt-5.5');
      expect(codexCall).toContain('custom prompt content');
      expect(opencodeCall).toContain('ARGV: run -m doubao/doubao-code');
      expect(opencodeCall).toContain('custom prompt content');
      expect(agyCall).toContain('ARGV: --prompt custom prompt content');
      expect(agyCall).not.toContain('--model');
    });

    it('passes harness args through to lite harnesses', async () => {
      const codexDispatch = await run(
        args(
          'gpt-5.5',
          '--harness',
          'codex',
          '--harness-arg=-c',
          '--harness-arg=mcp_servers={}',
          '--prompt-file',
          promptFile,
        ),
      );
      const opencodeDispatch = await run(
        args(
          'doubao/doubao-code',
          '--harness',
          'opencode',
          '--harness-arg=--agent',
          '--harness-arg=review',
          '--prompt-file',
          promptFile,
        ),
      );
      const agyDispatch = await run(
        args(
          'Gemini 3.5 Flash (Medium)',
          '--harness',
          'agy',
          '--harness-arg=--new-project',
          '--prompt-file',
          promptFile,
        ),
      );
      const codexCall = await readFile(codexCalled, 'utf8');
      const opencodeCall = await readFile(opencodeCalled, 'utf8');
      const agyCall = await readFile(agyCalled, 'utf8');

      expect(codexDispatch.code).toBe(0);
      expect(opencodeDispatch.code).toBe(0);
      expect(agyDispatch.code).toBe(0);
      expect(codexCall).toContain('ARGV: exec -c mcp_servers={} --model gpt-5.5');
      expect(opencodeCall).toContain('ARGV: run --agent review -m doubao/doubao-code');
      expect(agyCall).toContain(
        'ARGV: --prompt custom prompt content --model Gemini 3.5 Flash (Medium) --new-project',
      );
    });

    it('uses clean Codex exec flags for non-interactive reviewer dispatch', async () => {
      const dispatched = await run(
        args('gpt-5.5', '--harness', 'codex', '--codex-clean', '--prompt-file', promptFile),
      );
      const codexCall = await readFile(codexCalled, 'utf8');

      expect(dispatched.code).toBe(0);
      expect(codexCall).toContain(
        'ARGV: exec --ignore-user-config --ignore-rules --ephemeral --color never --model gpt-5.5',
      );
      expect(codexCall).toContain('custom prompt content');
    });

    it('rejects clean Codex mode on non-Codex harnesses', async () => {
      const dispatched = await run(
        args(
          'doubao/doubao-code',
          '--harness',
          'opencode',
          '--codex-clean',
          '--prompt-file',
          promptFile,
        ),
      );

      expect(dispatched.code).toBe(2);
      expect(dispatched.err).toContain('--codex-clean requires --harness codex');
    });

    it('dispatches an inline prompt for quick smoke checks', async () => {
      const dispatched = await run(
        args('gpt-5.5', '--harness', 'codex', '--prompt', 'inline smoke prompt'),
      );
      const codexCall = await readFile(codexCalled, 'utf8');

      expect(dispatched.code).toBe(0);
      expect(codexCall).toContain('ARGV: exec --model gpt-5.5');
      expect(codexCall).toContain('inline smoke prompt');
    });

    it('surfaces OpenCode zero-exit stderr errors as dispatch failures', async () => {
      await writeFile(
        opencodeBin,
        [
          '#!/usr/bin/env bash',
          `echo "ARGV: $*" > "${opencodeCalled}"`,
          'printf "ProviderModelNotFoundError: Model not found: kimi/latest\\n" >&2',
          '',
        ].join('\n'),
        'utf8',
      );
      await chmod(opencodeBin, 0o755);
      const task = join(dir, 'TASK-opencode-error.md');
      await writeFile(task, '## Execution log\n', 'utf8');

      const dispatched = await run(
        args(
          'kimi/latest',
          '--harness',
          'opencode',
          '--prompt',
          'review this change',
          '--task',
          task,
        ),
      );
      const taskLog = await readFile(task, 'utf8');

      expect(dispatched.code).toBe(1);
      expect(dispatched.err).toContain('ProviderModelNotFoundError');
      expect(taskLog).toContain('dispatch → kimi/latest [opencode] (status=failed rc=1');
      expect(taskLog).toContain('error=unavailable');
    });

    it('can require non-empty dispatch output before writing artifacts', async () => {
      const outFile = join(dir, 'artifacts', 'empty-review.txt');
      const task = join(dir, 'TASK-empty-review.md');
      await writeFile(task, '## Execution log\n', 'utf8');

      const dispatched = await run(
        args(
          'gpt-5.5',
          '--harness',
          'codex',
          '--prompt',
          'review this change',
          '--require-output',
          '--out',
          outFile,
          '--task',
          task,
        ),
      );
      const taskLog = await readFile(task, 'utf8');

      await expect(readFile(outFile, 'utf8')).rejects.toHaveProperty('code', 'ENOENT');
      expect(dispatched.code).toBe(1);
      expect(dispatched.err).toContain('empty dispatch output');
      expect(taskLog).toContain('status=failed rc=1 error=empty-output');
      expect(taskLog).toContain(`out=${outFile}`);
    });

    it('writes successful dispatch output to a durable artifact', async () => {
      const outFile = join(dir, 'artifacts', 'review.txt');
      const task = join(dir, 'TASK-out.md');
      await writeFile(
        codexBin,
        [
          '#!/usr/bin/env bash',
          `echo "ARGV: $*" > "${codexCalled}"`,
          'printf "VERDICT: ACCEPTED\\n"',
          '',
        ].join('\n'),
        'utf8',
      );
      await chmod(codexBin, 0o755);
      await writeFile(task, '## Execution log\n', 'utf8');

      const dispatched = await run(
        args(
          'gpt-5.5',
          '--harness',
          'codex',
          '--prompt',
          'review this change',
          '--out',
          outFile,
          '--task',
          task,
        ),
      );
      const artifact = await readFile(outFile, 'utf8');
      const taskLog = await readFile(task, 'utf8');

      expect(dispatched.code).toBe(0);
      expect(dispatched.out).toBe('VERDICT: ACCEPTED\n');
      expect(artifact).toBe('VERDICT: ACCEPTED\n');
      expect(taskLog).toContain('status=ok rc=0');
      expect(taskLog).toContain(`out=${outFile}`);
    });

    it('prints verbose dispatch observability to stderr without changing stdout', async () => {
      await writeFile(
        codexBin,
        [
          '#!/usr/bin/env bash',
          `echo "ARGV: $*" > "${codexCalled}"`,
          'printf "VERDICT: ACCEPTED\\n"',
          '',
        ].join('\n'),
        'utf8',
      );
      await chmod(codexBin, 0o755);

      const dispatched = await run(
        args('gpt-5.5', '--harness', 'codex', '--prompt', 'review this change', '--verbose'),
      );

      expect(dispatched.code).toBe(0);
      expect(dispatched.out).toBe('VERDICT: ACCEPTED\n');
      expect(dispatched.err).toContain('[obs] dispatch harness=codex agent=gpt-5.5 rc=0 took=');
      expect(dispatched.err).toContain('output_chars=18');
    });

    it('rejects invalid dispatch timeouts', async () => {
      const dispatched = await run(
        args('gpt-5.5', '--harness', 'codex', '--prompt', 'x', '--timeout-ms', 'abc'),
      );

      expect(dispatched.code).toBe(2);
      expect(dispatched.err).toContain("invalid --timeout-ms 'abc'");
    });

    it('prefixes selected skills and workspace context before the prompt body', async () => {
      const skillsRoot = join(dir, 'skills');
      const pluginsRoot = join(dir, 'plugins');
      await mkdir(join(skillsRoot, 'inj-tool'), { recursive: true });
      await mkdir(join(pluginsRoot, 'market', 'plugins', 'myplug', 'skills', 'plug-tool'), {
        recursive: true,
      });
      await writeFile(
        join(skillsRoot, 'inj-tool', 'SKILL.md'),
        '---\nname: inj-tool\ndescription: INJECTED-SKILL-DESC for testing\n---\nbody\n',
        'utf8',
      );
      await writeFile(
        join(pluginsRoot, 'market', 'plugins', 'myplug', 'skills', 'plug-tool', 'SKILL.md'),
        '---\nname: plug-tool\ndescription: PLUGIN-SKILL-DESC for testing\n---\nbody\n',
        'utf8',
      );
      process.env.FUGUE_SKILLS_ROOT = skillsRoot;
      process.env.FUGUE_PLUGINS_ROOT = pluginsRoot;

      await run(
        args(
          'cc-x',
          '--workspace',
          'code',
          '--prompt-file',
          promptFile,
          '--skills',
          'inj-tool,myplug:plug-tool',
        ),
      );
      const called = await readFile(fugueCcCalled, 'utf8');

      expect(called).toContain('INJECTED-SKILL-DESC');
      expect(called).toContain('PLUGIN-SKILL-DESC');
      expect(called).toContain('## Context — workspace: code');
      expect(called).toContain('global review independence rule');
      expect(called).toContain('Code station prompt');
      expect(called).toContain('minimax,doubao,glm');
      expect(called).toContain('custom prompt content');
    });

    it('rejects invalid harnesses and missing prompt sources', async () => {
      const unknownHarness = await run(
        args('cc-x', '--harness', 'bogus', '--prompt-file', promptFile),
      );
      const missingPrompt = await run(args('cc-x'));
      const missingPromptFile = await run(args('cc-x', '--prompt-file', join(dir, 'missing.md')));

      expect(unknownHarness.code).toBe(2);
      expect(unknownHarness.err).toContain('unknown harness');
      expect(missingPrompt.code).toBe(2);
      expect(missingPrompt.err).toContain('need --template');
      expect(missingPromptFile.code).toBe(2);
      expect(missingPromptFile.err).toContain('no prompt file');
    });
  });

  describe('integrate command', () => {
    let dir: string;
    let work: string;
    const runner = new NodeCommandRunner();
    const gitArgs = [
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'init.defaultBranch=main',
    ];

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-integrate-'));
      work = join(dir, 'work');
      await mkdir(work, { recursive: true });
    });

    afterEach(async () => {
      delete process.env.FUGUE_CACHE;
      await rm(dir, { recursive: true, force: true });
    });

    const git = async (...args: readonly string[]): Promise<string> => {
      const result = await runner.run('git', [...gitArgs, ...args]);
      if (result.code !== 0) throw new Error(result.stderr || result.stdout);
      return result.stdout.trim();
    };

    it('dry-runs and integrates a real agent worktree through the CLI', async () => {
      await git('-C', work, 'init', '-q');
      await writeFile(join(work, '.gitignore'), '.fugue-cc/\n', 'utf8');
      await writeFile(join(work, 'base.txt'), 'base\n', 'utf8');
      await git('-C', work, 'add', '-A');
      await git('-C', work, 'commit', '-qm', 'init');
      await git('-C', work, 'branch', '-M', 'main');

      const wt = join(work, '.fugue-cc', 'workspaces', 'cc-a');
      await git('-C', work, 'worktree', 'add', '-q', '-b', 'br-cc-a', wt, 'main');
      await writeFile(join(wt, 'a.ts'), 'export const a = 1;\n', 'utf8');

      const headBefore = await git('-C', work, 'rev-parse', 'HEAD');
      const dry = await run(['integrate', '--work', work, '--agents', 'cc-a', '--dry']);
      const headAfterDry = await git('-C', work, 'rev-parse', 'HEAD');
      const integrated = await run(['integrate', '--work', work, '--agents', 'cc-a']);

      expect(dry.code).toBe(0);
      expect(dry.out).toContain('would-pick cc-a');
      expect(headAfterDry).toBe(headBefore);
      expect(integrated.code).toBe(0);
      expect(integrated.out).toContain('1 picked');
      expect(await readFile(join(work, 'a.ts'), 'utf8')).toContain('export const a');
    });

    it('preserves task audit lines from concurrent integrate summaries', async () => {
      await git('-C', work, 'init', '-q');
      const task = join(dir, 'TASK-integrate-concurrent.md');
      const agents = Array.from({ length: 8 }, (_, index) => `cc-missing-${String(index + 1)}`);
      await writeFile(task, '## Log\n', 'utf8');

      const results = await Promise.all(
        agents.map((agent) =>
          run(['integrate', '--work', work, '--agents', agent, '--task', task]),
        ),
      );
      const taskContent = await readFile(task, 'utf8');

      expect(results.every((result) => result.code === 0)).toBe(true);
      expect(taskContent.match(/### Integrate/gu)?.length).toBe(agents.length);
      for (const agent of agents) {
        expect(taskContent).toContain(`missing   ${agent}`);
      }
    });
  });

  describe('fleet command', () => {
    let dir: string;
    let work: string;
    let claude: string;
    let bin: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-fleet-'));
      work = join(dir, 'work');
      claude = join(dir, 'claude');
      bin = join(dir, 'fugue-cc');
      await mkdir(join(work, '.fugue-cc'), { recursive: true });
      await mkdir(join(claude, '.fugue-cc'), { recursive: true });
      process.env.FUGUE_CC_WORK = work;
      process.env.FUGUE_CC_CLAUDE = claude;
      process.env.FUGUE_CC_BIN = bin;
      process.env.CLAUDE_CODE_TEST_X = '1';
    });

    afterEach(async () => {
      delete process.env.FUGUE_CC_WORK;
      delete process.env.FUGUE_CC_CLAUDE;
      delete process.env.FUGUE_CC_BIN;
      delete process.env.CLAUDE_CODE_TEST_X;
      await rm(dir, { recursive: true, force: true });
    });

    const stub = async (body: string): Promise<void> => {
      await writeFile(bin, ['#!/usr/bin/env bash', body, ''].join('\n'), 'utf8');
      await chmod(bin, 0o755);
    };

    it('prints dry-run launch commands with stripped Claude Code env and claude prefix', async () => {
      await stub('exit 0');
      const dry = await run(['fleet', 'up', '--dry']);
      const ptyDry = await run(['fleet', 'up', '--pty', '--dry']);

      expect(dry.code).toBe(0);
      expect(dry.out).toContain('-u CLAUDE_CODE_TEST_X');
      expect(dry.out).toContain('fugue-cc -s');
      expect(dry.out).toContain('CLAUDE_START_CMD=claude');
      expect(ptyDry.out).toContain('fleet-launch.py');
      expect(ptyDry.out).toContain('fugue-cc -s');
    });

    it('treats only mount_state: mounted as ready', async () => {
      await stub('printf "mount_state: mounted\\nhealth: alive\\n"');
      const ready = await run(['fleet', 'status']);
      await stub('printf "mount_state: unmounted\\nhealth: unmounted\\n"');
      const unmounted = await run(['fleet', 'status']);
      await stub('printf "desired_state: running\\n"');
      const desiredOnly = await run(['fleet', 'status']);

      expect(ready.code).toBe(0);
      expect(ready.out).toContain('ready');
      expect(unmounted.code).toBe(1);
      expect(unmounted.out).toContain('down');
      expect(desiredOnly.code).toBe(1);
      expect(desiredOnly.out).toContain('down');
    });
  });

  describe('skills command', () => {
    let dir: string;
    let skillsRoot: string;
    let pluginsRoot: string;
    let catalog: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-skills-'));
      skillsRoot = join(dir, 'skills');
      pluginsRoot = join(dir, 'plugins');
      catalog = join(dir, 'catalog.tsv');
      await mkdir(join(skillsRoot, 'my-tool'), { recursive: true });
      await mkdir(join(skillsRoot, '.system', 'sys-tool'), { recursive: true });
      await mkdir(join(pluginsRoot, 'mp', 'plugins', 'plug', 'skills', 'plug-tool'), {
        recursive: true,
      });
      await writeFile(
        join(skillsRoot, 'my-tool', 'SKILL.md'),
        '---\nname: my-tool\ndescription: functional desc\n---\nbody\n',
        'utf8',
      );
      await writeFile(
        join(skillsRoot, '.system', 'sys-tool', 'SKILL.md'),
        '---\nname: sys-tool\ndescription: system creator desc\n---\nsys body\n',
        'utf8',
      );
      await writeFile(
        join(pluginsRoot, 'mp', 'plugins', 'plug', 'skills', 'plug-tool', 'SKILL.md'),
        '---\nname: plug-tool\ndescription: plugin desc\n---\nplug body\n',
        'utf8',
      );
      process.env.FUGUE_SKILLS_ROOT = skillsRoot;
      process.env.FUGUE_PLUGINS_ROOT = pluginsRoot;
      process.env.FUGUE_SKILLS_CATALOG = catalog;
    });

    afterEach(async () => {
      delete process.env.FUGUE_SKILLS_ROOT;
      delete process.env.FUGUE_PLUGINS_ROOT;
      delete process.env.FUGUE_SKILLS_CATALOG;
      await rm(dir, { recursive: true, force: true });
    });

    it('indexes, injects, shows, and validates skills from all sources', async () => {
      const indexed = await run(['skills', 'index', '--refresh']);
      const injected = await run(['skills', 'inject', 'sys-tool,plug:plug-tool']);
      const shown = await run(['skills', 'show', 'plug:plug-tool']);
      const valid = await run(['skills', 'validate', '--dir', join(skillsRoot, 'my-tool')]);

      expect(indexed.out).toContain('3 skills');
      expect(await readFile(catalog, 'utf8')).toContain('plug:plug-tool\tplugin');
      expect(injected.out).toContain('sys-tool');
      expect(injected.out).toContain('plug:plug-tool');
      expect(shown.out).toContain('plug body');
      expect(valid.code).toBe(0);
      expect(valid.out).toContain('✓ valid');
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
      delete process.env.FUGUE_EXPERIENCE;
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

    it('uses FUGUE_EXPERIENCE when --store is omitted', async () => {
      process.env.FUGUE_EXPERIENCE = store;

      const add = await run(['experience', 'add', 'code', 'env store'], {
        stdin: Readable.from(['stored through env default']),
      });
      const recall = await run(['experience', 'recall', 'code']);

      expect(add.code).toBe(0);
      expect(add.out).toContain('env-store.md');
      expect(recall.out).toContain('stored through env default');
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
      process.env.FUGUE_CACHE = cache;
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
      delete process.env.FUGUE_CACHE;
      await rm(dir, { recursive: true, force: true });
    });

    it('renders a legacy cache summary and appends it to a task file', async () => {
      const task = join(dir, 'TASK.md');
      await writeFile(task, '## Log\n', 'utf8');
      const summary = await run(['summary', '1', '--task', task]);
      const taskContent = await readFile(task, 'utf8');

      expect(summary.code).toBe(0);
      expect(summary.out).toContain('### Round 1 summary');
      expect(summary.out).toContain('round-1: total=2 done=1 fail=1 pending=0');
      expect(summary.out).toContain('t1');
      expect(summary.out).toContain('cc-glm');
      expect(summary.err).toContain('written to');
      expect(taskContent).toContain('Round 1 summary');
    });

    it('preserves task audit lines from concurrent summary commands', async () => {
      const task = join(dir, 'TASK-summary-concurrent.md');
      const runs = 8;
      await writeFile(task, '## Log\n', 'utf8');

      const results = await Promise.all(
        Array.from({ length: runs }, () => run(['summary', '1', '--task', task])),
      );
      const taskContent = await readFile(task, 'utf8');

      expect(results.every((result) => result.code === 0)).toBe(true);
      expect(taskContent.match(/### Round 1 summary/gu)?.length).toBe(runs);
    });

    it('returns non-zero when the round was not initialized', async () => {
      const summary = await run(['summary', '9']);

      expect(summary.code).toBe(2);
      expect(summary.err).toContain('round-9 not init');
    });
  });

  describe('cache command', () => {
    let dir: string;
    let cache: string;
    let a: string;
    let b: string;
    let c: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-cache-'));
      cache = join(dir, 'cache');
      a = join(dir, 'a.md');
      b = join(dir, 'b.md');
      c = join(dir, 'c.md');
      await writeFile(a, 'r1\n', 'utf8');
      await writeFile(b, 'r2\n', 'utf8');
      await writeFile(c, 'r3\n', 'utf8');
    });

    afterEach(async () => {
      delete process.env.FUGUE_CC_BIN;
      delete process.env.FUGUE_CC_WORK;
      await rm(dir, { recursive: true, force: true });
    });

    const args = (...rest: readonly string[]): readonly string[] => [
      'cache',
      '--cache',
      cache,
      ...rest,
    ];

    it('stores round results and enforces the join barrier', async () => {
      const init = await run(args('init', '1', 't1:cc-deepseek', 't2:cc-glm', 't3:agy'));
      const earlyBarrier = await run(args('barrier', '1'));
      const put1 = await run(args('put', '1', 't1', a));
      await run(args('put', '1', 't2', b));
      const resume = await run(args('resume', '1'));
      const list = await run(args('list', '1'));
      const rejected = await run(args('put', '1', 't9', c));
      const failed = await run(args('fail', '1', 't3', 'agy', 'timeout'));
      const barrier = await run(args('barrier', '1'));
      const requireSuccess = await run(args('barrier', '1', '--require-success'));
      const collect = await run(args('collect', '1'));
      const status = await run(args('status', '1'));

      expect(init.code).toBe(0);
      expect(await readFile(join(cache, 'round-1', 'manifest.tsv'), 'utf8')).toContain(
        't1\tcc-deepseek',
      );
      expect(earlyBarrier.code).toBe(1);
      expect(earlyBarrier.out).toContain('only 0/3 returned');
      expect(earlyBarrier.err).toContain('pending=3');
      expect(put1.out).toContain('cached t1');
      expect(await readFile(join(cache, 'round-1', 't1.result'), 'utf8')).toBe('r1\n');
      expect(resume.out).toBe('t3\tagy\n');
      expect(list.out).toContain('t3');
      expect(list.out).toContain('pending');
      expect(rejected.code).toBe(2);
      expect(rejected.err).toContain("task 't9' not in manifest");
      expect(failed.out).toContain('failed t3: agy timeout');
      expect(await readFile(join(cache, 'round-1', 't3.reason'), 'utf8')).toBe('agy timeout\n');
      expect(barrier.code).toBe(0);
      expect(requireSuccess.code).toBe(1);
      expect(requireSuccess.out).toContain('1 failed');
      expect(collect.out.trim().split(/\r?\n/u)).toHaveLength(2);
      expect(status.out).toContain('done=2 fail=1 pending=0');
    });

    it('passes --require-success when every task is done', async () => {
      await run(args('init', '2', 'x:cc-mimo'));
      await run(args('put', '2', 'x', a));
      const barrier = await run(args('barrier', '2', '--require-success'));

      expect(barrier.code).toBe(0);
      expect(barrier.out).toContain('all returned');
    });

    it('uses FUGUE_CACHE when --cache is omitted', async () => {
      process.env.FUGUE_CACHE = cache;

      const init = await run(['cache', 'init', '9', 'x:cc-mimo']);

      expect(init.code).toBe(0);
      expect(await readFile(join(cache, 'round-9', 'manifest.tsv'), 'utf8')).toContain(
        'x\tcc-mimo',
      );
    });

    it('prints non-zero usage errors for bad invocations', async () => {
      const missingRound = await run(args('status'));
      const missingFile = await run(args('init', '3', 'x:cc-mimo')).then(() =>
        run(args('put', '3', 'x', join(dir, 'missing.md'))),
      );

      expect(missingRound.code).toBe(2);
      expect(missingRound.err).toContain('usage: status <round>');
      expect(missingFile.code).toBe(2);
      expect(missingFile.err).toContain('result file does not exist');
    });
  });

  describe('allocate command', () => {
    let dir: string;
    let table: string;
    let stats: string;
    let ledger: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-allocate-'));
      table = join(dir, 'allocation.tsv');
      stats = join(dir, 'allocation-stats.tsv');
      ledger = join(dir, 'alloc-ledger.tsv');
      await writeFile(
        table,
        [
          'code\tminimax,doubao,glm',
          'logic\tkimi,mimo,doubao',
          'sql\tdoubao,glm,kimi',
          'docs\tkimi,glm,deepseek',
          'review\tcoder',
          'fallback\tmimo',
          '',
        ].join('\n'),
        'utf8',
      );
    });

    afterEach(async () => {
      delete process.env.FUGUE_ALLOCATE_SEED;
      delete process.env.FUGUE_ALLOCATION;
      delete process.env.FUGUE_ALLOCATION_STATS;
      delete process.env.FUGUE_ALLOCATION_LEDGER;
      delete process.env.FUGUE_ALLOCATE_KAPPA;
      await rm(dir, { recursive: true, force: true });
    });

    const args = (...rest: readonly string[]): readonly string[] => [
      'allocate',
      '--table',
      table,
      '--stats',
      stats,
      '--ledger',
      ledger,
      ...rest,
    ];

    it('ranks cold-start models, falls back for unknown task types, and lists the table', async () => {
      const code = await run(args('code'));
      const logicTop = await run(args('logic', '--top'));
      const sql = await run(args('sql'));
      const review = await run(args('review', '--top'));
      const list = await run(args('list'));
      const fallback = await run(args('bogusXYZ'));
      const noArgs = await run(args());

      expect(code.out.trim()).toBe('minimax,doubao,glm');
      expect(logicTop.out.trim()).toBe('kimi');
      expect(sql.out).toContain('doubao');
      expect(review.out.trim()).toBe('coder');
      expect(list.out.split(/\r?\n/u).filter(Boolean).length).toBeGreaterThanOrEqual(6);
      expect(fallback.out.trim()).toBe('mimo');
      expect(fallback.err).toContain('falling back to fallback');
      expect(noArgs.code).toBe(2);
    });

    it('uses env-backed paths when explicit allocation options are omitted', async () => {
      process.env.FUGUE_ALLOCATION = table;
      process.env.FUGUE_ALLOCATION_STATS = stats;
      process.env.FUGUE_ALLOCATION_LEDGER = ledger;
      process.env.FUGUE_ALLOCATE_KAPPA = '7';

      const top = await run(['allocate', 'code', '--top']);
      const recorded = await run(['allocate', 'record', 'code', 'cc-doubao', 'ok']);
      await writeFile(ledger, 'sql\tcc-glm\n', 'utf8');
      const fed = await run(['allocate', 'feed', '--from-ledger', '--result', 'ok']);
      const statsContent = await readFile(stats, 'utf8');

      expect(top.code).toBe(0);
      expect(top.out.trim()).toBe('minimax');
      expect(recorded.code).toBe(0);
      expect(recorded.out).toContain('code/doubao');
      expect(fed.code).toBe(0);
      expect(fed.out).toContain('recorded 1');
      expect(statsContent).toContain('code\tdoubao');
      expect(statsContent).toContain('sql\tglm');
    });

    it('updates posterior evidence, normalizes records, and renders stats', async () => {
      await run(args('reset'));
      for (let index = 0; index < 4; index += 1) {
        await run(args('record', 'code', 'doubao', 'ok'));
        await run(args('record', 'code', 'minimax', 'fail'));
      }
      const topAfterEvidence = await run(args('code', '--top'));
      const ranking = await run(args('code'));

      await run(args('reset', 'code'));
      const cold = await run(args('code'));

      await run(args('reset'));
      for (let index = 0; index < 5; index += 1) await run(args('record', 'code', 'claude', 'ok'));
      const unlisted = await run(args('code'));

      await run(args('reset'));
      await run(args('record', 'logic', 'kimi', 'needsfix'));
      await run(args('record', 'logic', 'kimi', '1'));
      const statsOut = await run(args('stats', 'logic'));
      const badResult = await run(args('record', 'code', 'doubao', 'bogus'));
      const unknownRecord = await run(args('record', 'noSuchType', 'cc-someagent', 'ok'));

      expect(topAfterEvidence.out.trim()).toBe('doubao');
      expect(ranking.out).toContain('minimax');
      expect(cold.out.trim()).toBe('minimax,doubao,glm');
      expect(unlisted.out).toContain('claude');
      expect(statsOut.out).toContain('score');
      expect(statsOut.out).toContain('kimi');
      expect(statsOut.out).toContain('1/1');
      expect(badResult.code).toBe(2);
      expect(unknownRecord.code).toBe(0);
      expect(unknownRecord.err).toContain('not in bench table');
    });

    it('feeds explicit tuples and ledger rows back into routing stats', async () => {
      await run(args('reset'));
      const explicit = await run(
        args('feed', 'code:cc-zeta:ok', 'code:cc-zeta:ok', 'logic:cc-omega:fail'),
      );
      const codeStats = await run(args('stats', 'code'));
      const logicStats = await run(args('stats', 'logic'));
      const badTuple = await run(args('feed', 'badtuple'));

      await run(args('reset'));
      await writeFile(ledger, 'code\tcc-doubao\nsql\tcc-glm\ncode\tcc-zeta\n', 'utf8');
      const ledgerFeed = await run(
        args('feed', '--from-ledger', '--result', 'ok', '--fail', 'cc-zeta'),
      );
      const ledgerCodeStats = await run(args('stats', 'code'));
      const ledgerSqlStats = await run(args('stats', 'sql'));
      const ledgerContent = await readFile(ledger, 'utf8');

      await writeFile(ledger, 'code\tcc-zeta\n', 'utf8');
      await run(args('feed', '--from-ledger', '--result', 'ok', '--keep'));
      const keptLedger = await readFile(ledger, 'utf8');
      const alternateLedger = join(dir, 'alternate-ledger.tsv');
      await writeFile(ledger, 'default\tcc-default\n', 'utf8');
      await writeFile(alternateLedger, 'docs\tcc-glm\n', 'utf8');
      await run(args('feed', '--from-ledger', '--ledger', alternateLedger, '--result', 'ok'));
      const defaultLedgerAfterAlternate = await readFile(ledger, 'utf8');
      const alternateLedgerAfterFeed = await readFile(alternateLedger, 'utf8');
      const missingResult = await run(args('feed', '--from-ledger'));

      expect(explicit.out).toContain('recorded 3');
      expect(codeStats.out).toContain('zeta');
      expect(codeStats.out).toContain('2/0');
      expect(logicStats.out).toContain('omega');
      expect(logicStats.out).toContain('0/1');
      expect(badTuple.code).toBe(2);
      expect(ledgerFeed.out).toContain('recorded 3');
      expect(ledgerCodeStats.out).toContain('doubao');
      expect(ledgerCodeStats.out).toContain('1/0');
      expect(ledgerCodeStats.out).toContain('zeta');
      expect(ledgerCodeStats.out).toContain('0/1');
      expect(ledgerSqlStats.out).toContain('glm');
      expect(ledgerSqlStats.out).toContain('1/0');
      expect(ledgerContent).toBe('');
      expect(keptLedger).toContain('cc-zeta');
      expect(defaultLedgerAfterAlternate).toContain('cc-default');
      expect(alternateLedgerAfterFeed).toBe('');
      expect(missingResult.code).toBe(2);
    });

    it('samples reproducibly with a seed and decays stale stats', async () => {
      await run(args('reset'));
      const greedy = await run(args('code'));
      process.env.FUGUE_ALLOCATE_SEED = '5';
      const sampled1 = await run(args('code', '--sample'));
      process.env.FUGUE_ALLOCATE_SEED = '5';
      const sampled2 = await run(args('code', '--sample'));
      const distinct = new Set<string>();
      for (let seed = 1; seed <= 20; seed += 1) {
        process.env.FUGUE_ALLOCATE_SEED = String(seed);
        distinct.add((await run(args('code', '--sample', '--top'))).out.trim());
      }
      delete process.env.FUGUE_ALLOCATE_SEED;

      await run(args('reset'));
      for (let index = 0; index < 4; index += 1) await run(args('record', 'code', 'doubao', 'ok'));
      await run(args('decay', '--gamma', '0.5'));
      const decayed = await run(args('stats', 'code'));
      const badHigh = await run(args('decay', '--gamma', '1.5'));
      const badZero = await run(args('decay', '--gamma', '0'));

      await run(args('reset'));
      await run(args('record', 'code', 'doubao', 'ok'));
      await run(args('record', 'code', 'doubao', 'ok'));
      await run(args('record', 'sql', 'glm', 'ok'));
      await run(args('record', 'sql', 'glm', 'ok'));
      await run(args('decay', '--gamma', '0.5', '--type', 'code'));
      const codeOnly = await run(args('stats', 'code'));
      const sqlUntouched = await run(args('stats', 'sql'));

      expect(greedy.out.trim()).toBe('minimax,doubao,glm');
      expect(sampled1.out).toBe(sampled2.out);
      expect(sampled1.out).toContain('minimax');
      expect(distinct.size).toBeGreaterThanOrEqual(2);
      expect(decayed.out).toContain('doubao');
      expect(decayed.out).toContain('2/0');
      expect(badHigh.code).toBe(2);
      expect(badZero.code).toBe(2);
      expect(codeOnly.out).toContain('1/0');
      expect(sqlUntouched.out).toContain('2/0');
    });
  });

  describe('loop command', () => {
    let dir: string;
    let cache: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-loop-'));
      cache = join(dir, 'cache');
    });

    afterEach(async () => {
      delete process.env.FUGUE_CACHE;
      await rm(dir, { recursive: true, force: true });
    });

    const args = (...rest: readonly string[]): readonly string[] => [
      'loop',
      '--cache',
      cache,
      ...rest,
    ];

    const token = async (): Promise<{ code: number; token: string; out: string; err: string }> => {
      const result = await run(args('decide'));
      return { ...result, token: result.out.split(/\r?\n/u)[0] ?? '' };
    };

    it('records rounds, maintains keep-best, and decides exit states', async () => {
      const notInit = await run(args('decide'));
      const recordBeforeInit = await run(
        args('record', '1', '--gate', 'pass', '--verdict', 'NEEDSFIX', '--findings', '1'),
      );

      const init = await run(args('init', '--max', '3', '--best-sha', 'sha0'));
      const noRound = await run(args('decide'));
      const round1 = await run(
        args(
          'record',
          '1',
          '--gate',
          'pass',
          '--verdict',
          'NEEDSFIX',
          '--findings',
          '3',
          '--sha',
          'sha1',
        ),
      );
      const continue1 = await token();
      const metaAfterRound1 = await readFile(join(cache, 'loop', 'meta'), 'utf8');
      const round2 = await run(
        args(
          'record',
          '2',
          '--gate',
          'pass',
          '--verdict',
          'NEEDSFIX',
          '--findings',
          '2',
          '--sha',
          'sha2',
        ),
      );
      const continue2 = await token();
      const metaAfterRound2 = await readFile(join(cache, 'loop', 'meta'), 'utf8');
      await run(
        args(
          'record',
          '3',
          '--gate',
          'fail',
          '--verdict',
          'NEEDSFIX',
          '--findings',
          '2',
          '--sha',
          'sha3',
        ),
      );
      const max = await token();
      const metaAfterRound3 = await readFile(join(cache, 'loop', 'meta'), 'utf8');

      expect(notInit.code).toBe(2);
      expect(notInit.err).toContain('loop not init');
      expect(recordBeforeInit.code).toBe(2);
      expect(init.code).toBe(0);
      expect(await readFile(join(cache, 'loop', 'meta'), 'utf8')).toContain('max_rounds=3');
      expect(noRound.code).toBe(2);
      expect(noRound.err).toContain('no round recorded yet');
      expect(round1.out).toContain('best updated');
      expect(continue1.token).toBe('CONTINUE');
      expect(continue1.code).toBe(10);
      expect(metaAfterRound1).toContain('best_n=3');
      expect(metaAfterRound1).toContain('best_sha=sha1');
      expect(round2.out).toContain('best updated');
      expect(continue2.token).toBe('CONTINUE');
      expect(metaAfterRound2).toContain('best_n=2');
      expect(metaAfterRound2).toContain('best_sha=sha2');
      expect(max.token).toBe('ESCALATE_MAX');
      expect(max.code).toBe(20);
      expect(metaAfterRound3).toContain('best_sha=sha2');
    });

    it('detects non-convergence, confirmation, done, and ask-user branches', async () => {
      await run(args('init', '--max', '5'));
      await run(args('record', '1', '--gate', 'pass', '--verdict', 'NEEDSFIX', '--findings', '3'));
      await run(args('record', '2', '--gate', 'pass', '--verdict', 'NEEDSFIX', '--findings', '3'));
      const nonconv = await token();

      await run(args('init', '--max', '5'));
      await run(args('record', '1', '--gate', 'pass', '--verdict', 'NEEDSFIX', '--findings', '5'));
      await run(
        args(
          'record',
          '2',
          '--gate',
          'pass',
          '--verdict',
          'NEEDSFIX',
          '--findings',
          '2',
          '--same-class',
        ),
      );
      const sameClass = await token();

      await run(args('init', '--max', '5'));
      await run(args('record', '1', '--gate', 'pass', '--verdict', 'NEEDSFIX', '--findings', '1'));
      await run(args('record', '2', '--gate', 'pass', '--verdict', 'ACCEPTED', '--findings', '0'));
      const confirm = await token();
      await run(args('record', '3', '--gate', 'pass', '--verdict', 'ACCEPTED', '--findings', '0'));
      const done = await token();

      await run(args('init', '--max', '5'));
      await run(
        args(
          'record',
          '1',
          '--gate',
          'pass',
          '--verdict',
          'NEEDSFIX',
          '--findings',
          '3',
          '--ask-user',
          '1',
        ),
      );
      const askUser = await token();

      expect(nonconv.token).toBe('ESCALATE_NONCONV');
      expect(nonconv.code).toBe(20);
      expect(sameClass.token).toBe('ESCALATE_NONCONV');
      expect(confirm.token).toBe('CONFIRM');
      expect(confirm.code).toBe(10);
      expect(done.token).toBe('DONE');
      expect(done.code).toBe(0);
      expect(askUser.token).toBe('ASK_USER');
      expect(askUser.code).toBe(11);
    });

    it('uses FUGUE_CACHE when --cache is omitted', async () => {
      process.env.FUGUE_CACHE = cache;

      const init = await run(['loop', 'init', '--max', '2', '--best-sha', 'sha0']);

      expect(init.code).toBe(0);
      expect(await readFile(join(cache, 'loop', 'meta'), 'utf8')).toContain('best_sha=sha0');
    });

    it('normalizes verdicts, validates inputs, and renders status', async () => {
      await run(args('init', '--max', '3'));
      await run(
        args(
          'record',
          '1',
          '--gate',
          'pass',
          '--verdict',
          'needs fix',
          '--findings',
          '2',
          '--ask-user',
          '1',
        ),
      );
      const rounds = await readFile(join(cache, 'loop', 'rounds.tsv'), 'utf8');
      const status = await run(args('status'));
      const badGate = await run(
        args('record', '1', '--gate', 'bogus', '--verdict', 'ACCEPTED', '--findings', '0'),
      );
      const badFindings = await run(
        args('record', '1', '--gate', 'pass', '--verdict', 'ACCEPTED', '--findings', '-1'),
      );
      const badAsk = await run(
        args(
          'record',
          '2',
          '--gate',
          'pass',
          '--verdict',
          'NEEDSFIX',
          '--findings',
          '1',
          '--ask-user',
          '2',
        ),
      );

      expect(rounds.split('\t')[2]).toBe('NEEDSFIX');
      expect(status.out).toContain('ask-user');
      expect(status.out).toContain('NEEDSFIX');
      expect(badGate.code).toBe(2);
      expect(badFindings.code).toBe(2);
      expect(badAsk.code).toBe(2);
      expect(badAsk.err).toContain('cannot be >');
    });
  });

  describe('run command', () => {
    let dir: string;
    let cache: string;
    let task: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-run-'));
      cache = join(dir, 'cache');
      task = join(dir, 'TASK.md');
    });

    afterEach(async () => {
      delete process.env.FUGUE_CACHE;
      await rm(dir, { recursive: true, force: true });
    });

    const args = (...rest: readonly string[]): readonly string[] => [
      'run',
      '--cache',
      cache,
      ...rest,
    ];

    it('aggregates task, cache, and loop state into JSON and human summaries', async () => {
      const noRun = await run(args('status'));
      const missingTask = await run(args('set', '--task', join(dir, 'missing.md')));

      await writeFile(task, '# TASK-test\nStatus: IN_PROGRESS\n', 'utf8');
      const set = await run(args('set', '--task', task, '--round', '2'));
      const runMeta = await readFile(join(cache, 'run.meta'), 'utf8');
      const initialStatus = await run(args('status'));
      let initialStatusIsJson = true;
      try {
        JSON.parse(initialStatus.out);
      } catch {
        initialStatusIsJson = false;
      }

      const round = join(cache, 'round-2');
      await mkdir(round, { recursive: true });
      await writeFile(join(round, 'manifest.tsv'), 't1\tcc-deepseek\nt2\tcc-glm\n', 'utf8');
      await writeFile(join(round, 't1.result'), 'r1\n', 'utf8');
      await writeFile(join(round, 't1.status'), 'done\n', 'utf8');
      const openStatus = await run(args('status'));
      const openNext = await run(args('next'));

      await writeFile(join(round, 't2.status'), 'fail\n', 'utf8');
      await writeFile(join(round, 't2.reason'), 'x\n', 'utf8');
      const passedStatus = await run(args('status'));

      const loop = join(cache, 'loop');
      await mkdir(loop, { recursive: true });
      await writeFile(
        join(loop, 'meta'),
        'max_rounds=3\ntask_file=\nbest_sha=sha1\nbest_n=2\n',
        'utf8',
      );
      await writeFile(join(loop, 'rounds.tsv'), '1\tpass\tNEEDSFIX\t2\t0\t0\tsha1\tnote\n', 'utf8');
      const loopStatus = await run(args('status'));
      const human = await run(args('status', '--human'));

      const roundUpdate = await run(args('round', '3'));
      const roundStatus = await run(args('status'));
      const clear = await run(args('clear'));
      const afterClear = await run(args('next'));

      expect(noRun.code).toBe(2);
      expect(missingTask.code).toBe(2);
      expect(missingTask.err).toContain('no TASK file');
      expect(set.code).toBe(0);
      expect(runMeta).toContain(`task=${task}`);
      expect(initialStatus.out).toContain('"round": 2');
      expect(initialStatus.out).toContain('"task_status": "IN_PROGRESS"');
      expect(initialStatus.out).toContain('"initialized": false');
      expect(initialStatusIsJson).toBe(true);
      expect(openStatus.out).toContain('"total": 2');
      expect(openStatus.out).toContain('"pending": 1');
      expect(openStatus.out).toContain('"barrier": "open"');
      expect(openNext.out).toContain('waiting on 1+0/2');
      expect(passedStatus.out).toContain('"barrier": "passed"');
      expect(loopStatus.out).toContain('"decision": "CONTINUE"');
      expect(human.out).toContain('-- run: TASK.md');
      expect(human.out).toContain('cache:');
      expect(human.out).toContain('loop:');
      expect(human.out).toContain('next:');
      expect(roundUpdate.out).toContain('round → 3');
      expect(roundStatus.out).toContain('"round": 3');
      expect(clear.out).toContain('cleared current run context');
      expect(afterClear.code).toBe(2);
    });

    it('rejects invalid round values', async () => {
      await writeFile(task, '# TASK-test\nStatus: IN_PROGRESS\n', 'utf8');
      const set = await run(args('set', '--task', task, '--round', '0'));
      const round = await run(args('round', 'abc'));

      expect(set.code).toBe(2);
      expect(set.err).toContain('--round must be');
      expect(round.code).toBe(2);
      expect(round.err).toContain('usage: round');
    });

    it('uses FUGUE_CACHE when --cache is omitted', async () => {
      process.env.FUGUE_CACHE = cache;
      await writeFile(task, '# TASK-test\nStatus: IN_PROGRESS\n', 'utf8');

      const set = await run(['run', 'set', '--task', task]);

      expect(set.code).toBe(0);
      expect(await readFile(join(cache, 'run.meta'), 'utf8')).toContain(`task=${task}`);
    });
  });

  describe('plan command', () => {
    let dir: string;
    let bin: string;
    let codexBin: string;
    let opencodeBin: string;
    let agyBin: string;
    let out: string;
    let calls: string;
    let prompts: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-plan-'));
      bin = join(dir, 'fugue-cc');
      codexBin = join(dir, 'codex');
      opencodeBin = join(dir, 'opencode');
      agyBin = join(dir, 'agy');
      out = join(dir, 'plans');
      calls = join(dir, 'calls.txt');
      prompts = join(dir, 'prompts.txt');
      await writeFile(
        bin,
        [
          '#!/usr/bin/env bash',
          `echo "$2" >> "${calls}"`,
          `cat >> "${prompts}"`,
          "printf '# stub plan\\n'",
          '',
        ].join('\n'),
        'utf8',
      );
      await chmod(bin, 0o755);
      await writeFile(
        codexBin,
        [
          '#!/usr/bin/env bash',
          `printf 'codex:%s\\n' "$3" >> "${calls}"`,
          `printf '%s\\n' "$4" >> "${prompts}"`,
          "printf '# stub plan\\n'",
          '',
        ].join('\n'),
        'utf8',
      );
      await chmod(codexBin, 0o755);
      await writeFile(
        opencodeBin,
        [
          '#!/usr/bin/env bash',
          `printf 'opencode:%s\\n' "$3" >> "${calls}"`,
          `printf '%s\\n' "$4" >> "${prompts}"`,
          "printf '# stub plan\\n'",
          '',
        ].join('\n'),
        'utf8',
      );
      await chmod(opencodeBin, 0o755);
      await writeFile(
        agyBin,
        [
          '#!/usr/bin/env bash',
          `printf 'agy:%s\\n' "$1" >> "${calls}"`,
          `printf '%s\\n' "$2" >> "${prompts}"`,
          "printf '# stub plan\\n'",
          '',
        ].join('\n'),
        'utf8',
      );
      await chmod(agyBin, 0o755);
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('dispatches the planning prompt to selected models and lists output files', async () => {
      const task = join(dir, 'TASK-plan.md');
      await writeFile(task, '## Log\n', 'utf8');

      const planned = await run([
        'plan',
        'build a login feature',
        '--models',
        'cc-a,cc-b',
        '--out',
        out,
        '--bin',
        bin,
        '--task',
        task,
      ]);
      const called = await readFile(calls, 'utf8');
      const prompt = await readFile(prompts, 'utf8');
      const captured = await readFile(join(out, 'cc-a.plan.md'), 'utf8');
      const taskLog = await readFile(task, 'utf8');

      expect(planned.code).toBe(0);
      expect(called).toContain('cc-a');
      expect(called).toContain('cc-b');
      expect(planned.out).toContain('cc-a.plan.md');
      expect(planned.out).toContain('captured stdout to');
      expect(planned.out).toContain('(took ');
      expect(prompt).toContain('build a login feature');
      expect(prompt).toContain(`write to ${join(out, 'cc-a.plan.md')}`);
      expect(captured).toContain('# stub plan');
      expect(taskLog).toContain('plan → cc-a [fugue-cc] (status=started');
      expect(taskLog).toContain('plan → cc-a [fugue-cc] (status=captured');
      expect(taskLog).toContain('output_chars=');
      expect(taskLog).toContain(`out=${join(out, 'cc-a.plan.md')}`);
    });

    it('dispatches planning through the selected lite harness', async () => {
      process.env.FUGUE_CODEX = codexBin;
      try {
        const planned = await run([
          'plan',
          'improve the dispatch smoke path',
          '--harness',
          'codex',
          '--models',
          'gpt-5.5',
          '--out',
          out,
        ]);
        const called = await readFile(calls, 'utf8');
        const prompt = await readFile(prompts, 'utf8');

        expect(planned.code).toBe(0);
        expect(planned.out).toContain('planning panel: goal decomposition (codex)');
        expect(called).toContain('codex:gpt-5.5');
        expect(prompt).toContain('improve the dispatch smoke path');
      } finally {
        delete process.env.FUGUE_CODEX;
      }
    });

    it('forwards planning runtime controls to the selected harness', async () => {
      await writeFile(
        codexBin,
        [
          '#!/usr/bin/env bash',
          `printf 'codex-argv:%s\\n' "$*" >> "${calls}"`,
          'prompt="${@: -1}"',
          `printf '%s\\n' "$prompt" >> "${prompts}"`,
          "printf '# arg plan\\n'",
          '',
        ].join('\n'),
        'utf8',
      );
      await chmod(codexBin, 0o755);
      process.env.FUGUE_CODEX = codexBin;
      try {
        const planned = await run([
          'plan',
          'plan with clean local codex args',
          '--harness',
          'codex',
          '--models',
          'gpt-5.5',
          '--out',
          out,
          '--timeout-ms',
          '5000',
          '--harness-arg=-c',
          '--harness-arg=mcp_servers={}',
        ]);
        const called = await readFile(calls, 'utf8');
        const prompt = await readFile(prompts, 'utf8');
        const captured = await readFile(join(out, 'gpt-5.5.plan.md'), 'utf8');

        expect(planned.code).toBe(0);
        expect(called).toContain('codex-argv:exec -c mcp_servers={} --model gpt-5.5');
        expect(prompt).toContain('plan with clean local codex args');
        expect(captured).toContain('# arg plan');
      } finally {
        delete process.env.FUGUE_CODEX;
      }
    });

    it('uses a codex default model for codex planning', async () => {
      process.env.FUGUE_CODEX = codexBin;
      try {
        const planned = await run([
          'plan',
          'default codex plan',
          '--harness',
          'codex',
          '--out',
          out,
        ]);
        const called = await readFile(calls, 'utf8');

        expect(planned.code).toBe(0);
        expect(called).toContain('codex:gpt-5.5');
        expect(planned.out).toContain('gpt-5.5.plan.md');
      } finally {
        delete process.env.FUGUE_CODEX;
      }
    });

    it('uses safe plan filenames for provider/model targets', async () => {
      process.env.FUGUE_OPENCODE = opencodeBin;
      try {
        const planned = await run([
          'plan',
          'plan through opencode',
          '--harness',
          'opencode',
          '--models',
          'opencode/deepseek-v4-flash-free',
          '--out',
          out,
        ]);
        const called = await readFile(calls, 'utf8');
        const prompt = await readFile(prompts, 'utf8');

        expect(planned.code).toBe(0);
        expect(called).toContain('opencode:opencode/deepseek-v4-flash-free');
        expect(planned.out).toContain('opencode_deepseek-v4-flash-free.plan.md');
        expect(prompt).toContain(join(out, 'opencode_deepseek-v4-flash-free.plan.md'));
      } finally {
        delete process.env.FUGUE_OPENCODE;
      }
    });

    it('uses an opencode provider/model default for opencode planning', async () => {
      process.env.FUGUE_OPENCODE = opencodeBin;
      try {
        const planned = await run([
          'plan',
          'default opencode plan',
          '--harness',
          'opencode',
          '--out',
          out,
        ]);
        const called = await readFile(calls, 'utf8');

        expect(planned.code).toBe(0);
        expect(called).toContain('opencode:opencode/deepseek-v4-flash-free');
        expect(planned.out).toContain('opencode_deepseek-v4-flash-free.plan.md');
      } finally {
        delete process.env.FUGUE_OPENCODE;
      }
    });

    it('uses the current Antigravity model by default for agy planning', async () => {
      process.env.FUGUE_AGY = agyBin;
      try {
        const planned = await run(['plan', 'default agy plan', '--harness', 'agy', '--out', out]);
        const called = await readFile(calls, 'utf8');
        const prompt = await readFile(prompts, 'utf8');

        expect(planned.code).toBe(0);
        expect(called).toContain('agy:--prompt');
        expect(planned.out).toContain('default.plan.md');
        expect(prompt).toContain('default agy plan');
      } finally {
        delete process.env.FUGUE_AGY;
      }
    });

    it('returns non-zero when a planning dispatch fails', async () => {
      const task = join(dir, 'TASK-plan-fail.md');
      await writeFile(task, '## Log\n', 'utf8');

      const missing = await run([
        'plan',
        'this should fail',
        '--models',
        'cc-missing',
        '--bin',
        join(dir, 'missing-fugue-cc'),
        '--task',
        task,
      ]);
      const taskLog = await readFile(task, 'utf8');

      expect(missing.code).toBe(1);
      expect(missing.out).toContain('dispatch failed');
      expect(missing.out).toContain('(took ');
      expect(taskLog).toContain('plan → cc-missing [fugue-cc] (status=started');
      expect(taskLog).toContain('plan → cc-missing [fugue-cc] (status=failed');
      expect(taskLog).toContain('error=spawn-failed');
      expect(taskLog).toContain('rc=1');
    });

    it('returns non-zero when a planner produces no durable artifact', async () => {
      const silentBin = join(dir, 'silent-fugue-cc');
      const task = join(dir, 'TASK-plan-missing.md');
      await writeFile(silentBin, '#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n', 'utf8');
      await writeFile(task, '## Log\n', 'utf8');
      await chmod(silentBin, 0o755);

      const planned = await run([
        'plan',
        'silent planner',
        '--models',
        'cc-silent',
        '--out',
        out,
        '--bin',
        silentBin,
        '--task',
        task,
      ]);
      const taskLog = await readFile(task, 'utf8');

      expect(planned.code).toBe(1);
      expect(planned.out).toContain('produced no plan artifact');
      expect(planned.out).toContain('(took ');
      expect(taskLog).toContain('plan → cc-silent [fugue-cc] (status=started');
      expect(taskLog).toContain('plan → cc-silent [fugue-cc] (status=missing');
      expect(taskLog).toContain('output_chars=0');
      await expect(readFile(join(out, 'cc-silent.plan.md'), 'utf8')).rejects.toThrow();
    });

    it('preserves task audit lines from concurrent plan commands', async () => {
      const task = join(dir, 'TASK-plan-concurrent.md');
      const agents = Array.from({ length: 8 }, (_, index) => `cc-audit-${String(index + 1)}`);
      await writeFile(task, '## Log\n', 'utf8');

      const results = await Promise.all(
        agents.map((agent) =>
          run([
            'plan',
            `audit ${agent}`,
            '--models',
            agent,
            '--out',
            join(out, agent),
            '--bin',
            bin,
            '--task',
            task,
          ]),
        ),
      );
      const taskLog = await readFile(task, 'utf8');

      expect(results.every((result) => result.code === 0)).toBe(true);
      expect(taskLog.match(/status=started/gu)?.length).toBe(agents.length);
      expect(taskLog.match(/status=captured/gu)?.length).toBe(agents.length);
      for (const agent of agents) {
        expect(taskLog).toContain(`plan → ${agent} [fugue-cc] (status=started`);
        expect(taskLog).toContain(`plan → ${agent} [fugue-cc] (status=captured`);
      }
    });

    it('rejects unknown planning harnesses', async () => {
      const planned = await run(['plan', 'bad harness', '--harness', 'bogus']);

      expect(planned.code).toBe(2);
      expect(planned.err).toContain('unknown harness');
    });

    it('rejects invalid planning timeout values', async () => {
      const planned = await run(['plan', 'bad timeout', '--timeout-ms', 'abc']);

      expect(planned.code).toBe(2);
      expect(planned.err).toContain("invalid --timeout-ms 'abc'");
    });

    it('uses the cross-family default model set and env-backed command defaults', async () => {
      process.env.FUGUE_CACHE = join(dir, 'cache');
      process.env.FUGUE_CC_BIN = bin;
      try {
        await run(['plan', 'default models test']);
      } finally {
        delete process.env.FUGUE_CACHE;
        delete process.env.FUGUE_CC_BIN;
      }
      const called = await readFile(calls, 'utf8');
      const prompt = await readFile(prompts, 'utf8');

      expect(called.trim().split(/\r?\n/u)).toHaveLength(3);
      expect(called).toContain('cc-deepseek');
      expect(called).toContain('cc-kimi');
      expect(called).toContain('coder');
      expect(prompt).toContain(join(dir, 'cache', 'plans', 'cc-deepseek.plan.md'));
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
      const legacyGemini = join(dir, 'legacy-gemini.config');
      const comment = join(dir, 'comment.config');
      const empty = join(dir, 'empty.config');
      await writeFile(
        legacyGemini,
        '[agents.cc-x]\ncommand = "gemini-cli"\nmodel = "gemini-3.5-flash"\n',
        'utf8',
      );
      await writeFile(comment, '# do not use gemini\n[agents.cc-z]\nmodel = "glm-5.2"\n', 'utf8');
      await writeFile(empty, '[agents.cc-w]\nmodel = ""\n', 'utf8');

      const cleanResult = await run(['preflight', '--config-only', clean]);
      const geminiResult = await run(['preflight', '--config-only', legacyGemini]);
      const commentResult = await run(['preflight', '--config-only', comment]);
      const emptyResult = await run(['preflight', '--config-only', empty]);

      expect(cleanResult.code).toBe(0);
      expect(cleanResult.out).toContain('preflight GO');
      expect(geminiResult.code).toBe(1);
      expect(geminiResult.out).toContain('retired Gemini CLI');
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

    it('can preflight the codex harness without requiring fugue-cc', async () => {
      const codex = join(dir, 'codex');
      await writeFile(codex, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
      await chmod(codex, 0o755);

      const result = await run(['preflight', '--harness', 'codex', '--codex-bin', codex]);

      expect(result.code).toBe(0);
      expect(result.out).toContain('harness=codex');
      expect(result.out).toContain(codex);
      expect(result.out).not.toContain('missing fugue-cc');
      expect(result.out).not.toContain('FUGUE_CC_WORK unset');
    });

    it('requires the selected opencode harness binary', async () => {
      const result = await run([
        'preflight',
        '--harness',
        'opencode',
        '--opencode-bin',
        join(dir, 'missing-opencode'),
      ]);

      expect(result.code).toBe(1);
      expect(result.out).toContain('harness=opencode');
      expect(result.out).toContain('missing');
      expect(result.out).toContain('missing-opencode');
    });

    it('validates an opencode target against the local model registry', async () => {
      const codex = join(dir, 'codex');
      const opencode = join(dir, 'opencode');
      await writeFile(codex, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
      await writeFile(
        opencode,
        [
          '#!/usr/bin/env bash',
          'if [ "$1" = "models" ]; then',
          '  printf "opencode/deepseek-v4-flash-free\\nalibaba/qwen3-coder-plus\\n"',
          '  exit 0',
          'fi',
          'exit 2',
          '',
        ].join('\n'),
        'utf8',
      );
      await chmod(codex, 0o755);
      await chmod(opencode, 0o755);

      const result = await run([
        'preflight',
        '--harness',
        'opencode',
        '--codex-bin',
        codex,
        '--opencode-bin',
        opencode,
        '--target',
        'opencode/deepseek-v4-flash-free',
      ]);

      expect(result.code).toBe(0);
      expect(result.out).toContain('opencode model available');
      expect(result.out).toContain('opencode/deepseek-v4-flash-free');
    });

    it('fails opencode preflight when the requested model is not listed locally', async () => {
      const codex = join(dir, 'codex');
      const opencode = join(dir, 'opencode');
      await writeFile(codex, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
      await writeFile(
        opencode,
        [
          '#!/usr/bin/env bash',
          'if [ "$1" = "models" ]; then',
          '  printf "opencode/deepseek-v4-flash-free\\n"',
          '  exit 0',
          'fi',
          'exit 2',
          '',
        ].join('\n'),
        'utf8',
      );
      await chmod(codex, 0o755);
      await chmod(opencode, 0o755);

      const result = await run([
        'preflight',
        '--harness',
        'opencode',
        '--codex-bin',
        codex,
        '--opencode-bin',
        opencode,
        '--model',
        'opencode/gpt-5.1-codex-mini',
      ]);

      expect(result.code).toBe(1);
      expect(result.out).toContain('opencode model not found');
      expect(result.out).toContain('opencode/gpt-5.1-codex-mini');
      expect(result.out).toContain('opencode models');
    });

    it('validates an agy target against the local model registry', async () => {
      const codex = join(dir, 'codex');
      const agy = join(dir, 'agy');
      await writeFile(codex, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
      await writeFile(
        agy,
        [
          '#!/usr/bin/env bash',
          'if [ "$1" = "models" ]; then',
          '  printf "Gemini 3.5 Flash (Medium)\\nClaude Opus 4.6 (Thinking)\\n"',
          '  exit 0',
          'fi',
          'exit 2',
          '',
        ].join('\n'),
        'utf8',
      );
      await chmod(codex, 0o755);
      await chmod(agy, 0o755);

      const result = await run([
        'preflight',
        '--harness',
        'agy',
        '--codex-bin',
        codex,
        '--agy-bin',
        agy,
        '--target',
        'Gemini 3.5 Flash (Medium)',
      ]);

      expect(result.code).toBe(0);
      expect(result.out).toContain('agy model available');
      expect(result.out).toContain('Gemini 3.5 Flash (Medium)');
    });

    it('fails agy preflight when the requested model is not listed locally', async () => {
      const codex = join(dir, 'codex');
      const agy = join(dir, 'agy');
      await writeFile(codex, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
      await writeFile(
        agy,
        [
          '#!/usr/bin/env bash',
          'if [ "$1" = "models" ]; then',
          '  printf "Gemini 3.5 Flash (Medium)\\n"',
          '  exit 0',
          'fi',
          'exit 2',
          '',
        ].join('\n'),
        'utf8',
      );
      await chmod(codex, 0o755);
      await chmod(agy, 0o755);

      const result = await run([
        'preflight',
        '--harness',
        'agy',
        '--codex-bin',
        codex,
        '--agy-bin',
        agy,
        '--target',
        'Missing Model',
      ]);

      expect(result.code).toBe(1);
      expect(result.out).toContain('agy model not found');
      expect(result.out).toContain('Missing Model');
      expect(result.out).toContain('agy models');
    });

    it('rejects conflicting preflight --model and --target values', async () => {
      const result = await run([
        'preflight',
        '--harness',
        'opencode',
        '--model',
        'opencode/deepseek-v4-flash-free',
        '--target',
        'opencode/other',
      ]);

      expect(result.code).toBe(1);
      expect(result.out).toContain('--model and --target disagree');
    });

    it('rejects an unknown preflight harness', async () => {
      const result = await run(['preflight', '--harness', 'gemini']);

      expect(result.code).toBe(1);
      expect(result.err).toContain("unknown --harness 'gemini'");
    });

    it('uses env-backed bin and work defaults when CLI options are omitted', async () => {
      const work = join(dir, 'provider-work-env');
      const bin = join(dir, 'fugue-cc');
      await mkdir(join(work, '.fugue-cc'), { recursive: true });
      await new NodeCommandRunner().run('git', ['-C', work, 'init', '-q']);
      await writeFile(join(work, '.gitignore'), '.fugue-cc/\n', 'utf8');
      await writeFile(
        join(work, '.fugue-cc/provider.config'),
        await readFile(clean, 'utf8'),
        'utf8',
      );
      await writeFile(
        bin,
        '#!/usr/bin/env bash\n[ "$1" = "ping" ] && [ "$2" = "daemon" ] && echo "mount_state: mounted"\n',
        'utf8',
      );
      await chmod(bin, 0o755);
      process.env.FUGUE_CC_BIN = bin;
      process.env.FUGUE_CC_WORK = work;

      const result = await run(['preflight']);

      expect(result.code).toBe(0);
      expect(result.out).toContain('fuguectl-cache');
      expect(result.out).toContain(`provider mounted (${work})`);
      expect(result.out).toContain('legacy Gemini CLI guard passed');
      expect(result.out).toContain('gitignored');
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
    let repoSkill: string;
    let installedSkill: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-runtime-'));
      bin = join(dir, 'fugue-cc');
      install = join(dir, 'install');
      state = join(dir, 'state');
      work = join(dir, 'work');
      preflight = join(dir, 'preflight');
      calls = join(dir, 'calls.txt');
      repoSkill = join(dir, 'repo-skill', 'SKILL.md');
      installedSkill = join(dir, 'installed-skill', 'SKILL.md');
      await mkdir(join(install, 'lib/provider_profiles'), { recursive: true });
      await mkdir(join(work, '.fugue-cc'), { recursive: true });
      await mkdir(join(dir, 'repo-skill'), { recursive: true });
      await mkdir(join(dir, 'installed-skill'), { recursive: true });
      await writeFile(join(install, 'lib/provider_profiles/api_shortcuts.py'), '', 'utf8');
      await writeFile(repoSkill, 'repo workflow skill\n', 'utf8');
      await writeFile(installedSkill, 'old workflow skill\n', 'utf8');
      await writeFile(join(dir, 'repo-skill', 'fuguectl'), '#!/usr/bin/env node\n', 'utf8');
      await writeFile(join(dir, 'repo-skill', 'fuguectl-runtime'), 'repo helper\n', 'utf8');
      await writeFile(join(dir, 'installed-skill', 'fuguectl'), '#!/usr/bin/env bash\n', 'utf8');
      await writeFile(join(dir, 'installed-skill', 'fuguectl-runtime'), 'old helper\n', 'utf8');
      await writeFile(join(dir, 'installed-skill', 'fuguectl-cache.sh'), 'old shell\n', 'utf8');
      await writeFile(join(dir, 'installed-skill', 'fuguectl-e2e.test.sh'), 'old test\n', 'utf8');
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
      await chmod(preflight, 0o755);
      process.env.FUGUNANO_REPO_SKILL = repoSkill;
      process.env.FUGUNANO_SKILL = installedSkill;
    });

    afterEach(async () => {
      delete process.env.FUGUE_CC_BIN;
      delete process.env.FUGUNANO_STATE;
      delete process.env.FUGUE_STATE;
      delete process.env.FUGUE_CC_INSTALL;
      delete process.env.FUGUE_CC_WORK;
      delete process.env.FUGUE_DRIVER_NAME;
      delete process.env.FUGUNANO_REPO_SKILL;
      delete process.env.FUGUE_REPO_SKILL;
      delete process.env.FUGUNANO_SKILL;
      delete process.env.FUGUE_WORKFLOW_SKILL;
      delete process.env.FUGUE_SKILL;
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
      const syncedSkill = await readFile(installedSkill, 'utf8');
      const syncedEntrypoint = await readFile(join(dir, 'installed-skill', 'fuguectl'), 'utf8');
      const syncedHelper = await readFile(join(dir, 'installed-skill', 'fuguectl-runtime'), 'utf8');
      const repoRootPointer = await readFile(
        join(dir, 'installed-skill', '.fugunano-repo-root'),
        'utf8',
      );
      const staleShellMissing = await readFile(
        join(dir, 'installed-skill', 'fuguectl-cache.sh'),
        'utf8',
      ).then(
        () => false,
        () => true,
      );
      const staleNumberedShellMissing = await readFile(
        join(dir, 'installed-skill', 'fuguectl-e2e.test.sh'),
        'utf8',
      ).then(
        () => false,
        () => true,
      );
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
      expect(check.out).toContain('workflow bundle drift');
      expect(dry.out).toContain('[dry-run]');
      expect(dry.out).toContain('stamp not written');
      expect(dry.out).toContain('would refresh workflow bundle');
      expect(apply.out).toContain('config validation');
      expect(apply.out).toContain('recorded v9.9.9');
      expect(apply.out).toContain('synced workflow bundle');
      expect(stamp.trim()).toBe('v9.9.9');
      expect(syncedSkill).toBe('repo workflow skill\n');
      expect(syncedEntrypoint).toBe('#!/usr/bin/env node\n');
      expect(syncedHelper).toBe('repo helper\n');
      expect(repoRootPointer.trim()).toBe(dirname(repoSkill));
      expect(staleShellMissing).toBe(true);
      expect(staleNumberedShellMissing).toBe(true);
      expect(killCalls).toContain('kill:');
      expect(killCalls).toContain('/work');
      expect(check2.out).toContain('no drift');
      expect(check2.out).toContain('workflow bundle up-to-date');
      expect(missingGrafting.out).toContain('api_shortcuts.py is gone');
    });

    it('uses env-backed runtime defaults when CLI options are omitted', async () => {
      process.env.FUGUE_CC_BIN = bin;
      process.env.FUGUNANO_STATE = state;
      process.env.FUGUE_CC_INSTALL = install;
      process.env.FUGUE_CC_WORK = work;
      process.env.FUGUE_DRIVER_NAME = 'fctl';

      const check = await run(['runtime', 'check']);
      const apply = await run(['runtime', 'adapt', '--apply', '--preflight-script', preflight]);
      const stamp = await readFile(join(state, 'runtime-version'), 'utf8');
      const killCalls = await readFile(calls, 'utf8');

      expect(check.code).toBe(0);
      expect(check.out).toContain("run 'fctl runtime adapt --apply'");
      expect(check.out).toContain('grafting api_shortcuts.py present');
      expect(check.out).toContain('workflow bundle drift');
      expect(apply.out).toContain(`stopped provider daemon @ ${work}`);
      expect(apply.out).toContain('synced workflow bundle');
      expect(apply.out).toContain('config validation');
      expect(stamp.trim()).toBe('v9.9.9');
      expect(killCalls).toContain('/work');
    });

    it('detects and refreshes non-entrypoint workflow bundle files', async () => {
      await writeFile(installedSkill, 'repo workflow skill\n', 'utf8');
      await writeFile(join(dir, 'installed-skill', 'fuguectl'), '#!/usr/bin/env node\n', 'utf8');
      await writeFile(join(dir, 'installed-skill', 'fuguectl-runtime'), 'old helper\n', 'utf8');
      await writeFile(
        join(dir, 'installed-skill', '.fugunano-repo-root'),
        `${dirname(repoSkill)}\n`,
        'utf8',
      );
      await rm(join(dir, 'installed-skill', 'fuguectl-cache.sh'));
      await rm(join(dir, 'installed-skill', 'fuguectl-e2e.test.sh'));

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
      const apply = await run([
        'runtime',
        'adapt',
        '--bin',
        bin,
        '--state',
        state,
        '--install',
        install,
        '--apply',
      ]);
      const syncedHelper = await readFile(join(dir, 'installed-skill', 'fuguectl-runtime'), 'utf8');

      expect(check.out).toContain('bundle file mismatch');
      expect(apply.out).toContain('synced workflow bundle');
      expect(syncedHelper).toBe('repo helper\n');
    });

    it('detects and prunes target-only workflow bundle files', async () => {
      await writeFile(installedSkill, 'repo workflow skill\n', 'utf8');
      await writeFile(join(dir, 'installed-skill', 'fuguectl'), '#!/usr/bin/env node\n', 'utf8');
      await writeFile(join(dir, 'installed-skill', 'fuguectl-runtime'), 'repo helper\n', 'utf8');
      await writeFile(
        join(dir, 'installed-skill', '.fugunano-repo-root'),
        `${dirname(repoSkill)}\n`,
        'utf8',
      );
      await writeFile(join(dir, 'installed-skill', 'removed-helper'), 'stale\n', 'utf8');
      await rm(join(dir, 'installed-skill', 'fuguectl-cache.sh'));
      await rm(join(dir, 'installed-skill', 'fuguectl-e2e.test.sh'));

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
      const apply = await run([
        'runtime',
        'adapt',
        '--bin',
        bin,
        '--state',
        state,
        '--install',
        install,
        '--apply',
      ]);
      const targetOnlyMissing = await readFile(
        join(dir, 'installed-skill', 'removed-helper'),
        'utf8',
      )
        .then(() => false)
        .catch(() => true);

      expect(check.out).toContain('target-only files present');
      expect(apply.out).toContain('synced workflow bundle');
      expect(targetOnlyMissing).toBe(true);
    });

    it('writes an absolute repo pointer for relative repo-skill paths', async () => {
      const oldCwd = process.cwd();
      const repoDir = join(dir, 'relative-repo');
      const sourceDir = join(repoDir, 'orchestration', 'fuguectl');
      const targetDir = join(repoDir, 'installed-skill');
      await mkdir(sourceDir, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await writeFile(join(sourceDir, 'SKILL.md'), 'relative repo skill\n', 'utf8');
      await writeFile(join(sourceDir, 'fuguectl'), '#!/usr/bin/env node\n', 'utf8');
      await writeFile(join(targetDir, 'SKILL.md'), 'old relative skill\n', 'utf8');

      try {
        process.chdir(repoDir);
        const apply = await run([
          'runtime',
          'adapt',
          '--bin',
          bin,
          '--state',
          state,
          '--install',
          install,
          '--repo-skill',
          join('orchestration', 'fuguectl', 'SKILL.md'),
          '--skill',
          join('installed-skill', 'SKILL.md'),
          '--apply',
        ]);
        const repoRootPointer = await readFile(join(targetDir, '.fugunano-repo-root'), 'utf8');

        expect(apply.out).toContain('synced workflow bundle');
        expect(await realpath(repoRootPointer.trim())).toBe(await realpath(repoDir));
      } finally {
        process.chdir(oldCwd);
      }
    });

    it('still syncs the workflow bundle when fugue-cc is unavailable', async () => {
      await writeFile(bin, '#!/usr/bin/env bash\nexit 127\n', 'utf8');
      await chmod(bin, 0o755);

      const apply = await run([
        'runtime',
        'adapt',
        '--bin',
        bin,
        '--state',
        state,
        '--install',
        install,
        '--apply',
      ]);
      const syncedSkill = await readFile(installedSkill, 'utf8');
      const syncedEntrypoint = await readFile(join(dir, 'installed-skill', 'fuguectl'), 'utf8');
      const repoRootPointer = await readFile(
        join(dir, 'installed-skill', '.fugunano-repo-root'),
        'utf8',
      );
      const stampMissing = await readFile(join(state, 'runtime-version'), 'utf8').then(
        () => false,
        () => true,
      );

      expect(apply.code).toBe(2);
      expect(apply.out).toContain('cannot get fugue-cc provider version');
      expect(apply.out).toContain('synced workflow bundle');
      expect(syncedSkill).toBe('repo workflow skill\n');
      expect(syncedEntrypoint).toBe('#!/usr/bin/env node\n');
      expect(repoRootPointer.trim()).toBe(dirname(repoSkill));
      expect(stampMissing).toBe(true);
    });

    it('keeps FUGUE_STATE as a compatibility fallback', async () => {
      process.env.FUGUE_CC_BIN = bin;
      process.env.FUGUE_STATE = state;
      process.env.FUGUE_CC_INSTALL = install;
      process.env.FUGUE_CC_WORK = work;

      const apply = await run(['runtime', 'adapt', '--apply', '--preflight-script', preflight]);
      const stamp = await readFile(join(state, 'runtime-version'), 'utf8');

      expect(apply.code).toBe(0);
      expect(stamp.trim()).toBe('v9.9.9');
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
      await writeFile(
        join(workspaces, '_system.md'),
        'Keep review independent from implementation.\n',
        'utf8',
      );
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
      delete process.env.FUGUE_WORKSPACES;
      delete process.env.FUGUE_ALLOCATION;
      delete process.env.FUGUE_ALLOCATION_STATS;
      delete process.env.FUGUE_EXPERIENCE;
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
      expect(context.out).toContain('Keep review independent from implementation.');
      expect(context.out).toContain('[experience] Fast path');
      expect(context.out).toContain('do X');
      expect(context.out).toContain('> suggested model(bench): minimax,doubao,glm');
    });

    it('uses env-backed workspace defaults when path options are omitted', async () => {
      process.env.FUGUE_WORKSPACES = workspaces;
      process.env.FUGUE_ALLOCATION = allocation;
      process.env.FUGUE_ALLOCATION_STATS = stats;
      process.env.FUGUE_EXPERIENCE = experience;

      const model = await run(['workspace', 'model', 'code']);
      const context = await run(['workspace', 'context', 'code']);

      expect(model.code).toBe(0);
      expect(model.out.trim()).toBe('minimax,doubao,glm');
      expect(context.code).toBe(0);
      expect(context.out).toContain('[experience] Fast path');
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

    it('lists and resolves the starter registry when no file is provided', async () => {
      const valid = await run(['agent-registry', 'validate']);
      const list = await run(['agent-registry', 'list']);
      const resolved = await run(['agent-registry', 'resolve', 'coder']);

      expect(valid.code).toBe(0);
      expect(valid.out).toContain('OK agent registry valid');
      expect(list.code).toBe(0);
      expect(list.out).toContain('coder\tcodex\tgpt-5.5');
      expect(resolved.code).toBe(0);
      expect(resolved.out).toContain('harness\tcodex');
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
      expect(parsed.value.heldIn[0]?.gate).toContain('rm -f /tmp/fugunano-self-harness-held-in');
      expect(parsed.value.heldOut[0]?.gate).toContain('rm -f /tmp/fugunano-self-harness-held-out');
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
