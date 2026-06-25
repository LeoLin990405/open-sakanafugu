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

  describe('loop command', () => {
    let dir: string;
    let cache: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'fugue-loop-'));
      cache = join(dir, 'cache');
    });

    afterEach(async () => {
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
