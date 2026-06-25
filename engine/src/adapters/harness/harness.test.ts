import { describe, expect, it } from 'vitest';

import { isErr, isOk } from '../../domain/result.js';
import type { CommandOptions, CommandResult, CommandRunner } from '../../infra/command-runner.js';
import { FugueCcHarness } from './fugue-cc-harness.js';
import { CodexHarness } from './codex-harness.js';
import { OpencodeHarness } from './opencode-harness.js';

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: CommandOptions | undefined;
}

class FakeRunner implements CommandRunner {
  readonly calls: Call[] = [];
  constructor(
    private readonly result: CommandResult,
    private readonly shouldThrow = false,
  ) {}
  run(command: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult> {
    this.calls.push({ command, args, options });
    if (this.shouldThrow) return Promise.reject(new Error('spawn ENOENT'));
    return Promise.resolve(this.result);
  }
}

const res = (over: Partial<CommandResult> = {}): CommandResult => ({
  code: 0,
  stdout: '',
  stderr: '',
  ...over,
});

describe('FugueCcHarness', () => {
  it('dispatch builds `fugue-cc ask <agent> --compact` and pipes the prompt on stdin', async () => {
    const runner = new FakeRunner(res({ code: 0, stdout: 'done' }));
    const result = await new FugueCcHarness(runner).dispatch({
      agent: 'cc-deepseek',
      prompt: 'hi',
    });

    expect(runner.calls[0]?.command).toBe('fugue-cc');
    expect(runner.calls[0]?.args).toEqual(['ask', 'cc-deepseek', '--compact']);
    expect(runner.calls[0]?.options?.stdin).toBe('hi\n');
    expect(isOk(result) && result.value.output).toBe('done');
  });

  it('maps a nonzero exit to a nonzero-exit error', async () => {
    const runner = new FakeRunner(res({ code: 2, stderr: 'boom' }));
    const result = await new FugueCcHarness(runner).dispatch({ agent: 'cc-glm', prompt: 'x' });
    expect(isErr(result) && result.error.kind).toBe('nonzero-exit');
    expect(isErr(result) && result.error.exitCode).toBe(2);
  });

  it('maps a spawn failure to a spawn-failed error', async () => {
    const runner = new FakeRunner(res(), true);
    const result = await new FugueCcHarness(runner).dispatch({ agent: 'cc-kimi', prompt: 'x' });
    expect(isErr(result) && result.error.kind).toBe('spawn-failed');
  });

  it('health is ready only when provider reports mount_state: mounted', async () => {
    const mounted = await new FugueCcHarness(
      new FakeRunner(res({ stdout: 'mount_state: mounted\nhealth: alive' })),
    ).health();
    expect(mounted.healthy).toBe(true);

    const unmounted = await new FugueCcHarness(
      new FakeRunner(res({ stdout: 'mount_state: unmounted' })),
    ).health();
    expect(unmounted.healthy).toBe(false);
  });

  it('health requires provider ping to exit 0 (pipefail parity), not just the mounted line', async () => {
    const result = await new FugueCcHarness(
      new FakeRunner(res({ code: 1, stdout: 'mount_state: mounted' })),
    ).health();
    expect(result.healthy).toBe(false);
  });

  it('uses the fugue-native harness name', () => {
    const harness = new FugueCcHarness(new FakeRunner(res()));
    expect(harness.name).toBe('fugue-cc');
  });

  it('splices extra args after the --compact flag', async () => {
    const runner = new FakeRunner(res());
    await new FugueCcHarness(runner, { args: ['--profile', 'fast'] }).dispatch({
      agent: 'cc-deepseek',
      prompt: 'hi',
    });
    expect(runner.calls[0]?.args).toEqual(['ask', 'cc-deepseek', '--compact', '--profile', 'fast']);
  });
});

describe('CodexHarness', () => {
  it('dispatch builds `codex exec --model <model> <prompt>`', async () => {
    const runner = new FakeRunner(res({ stdout: 'ok' }));
    await new CodexHarness(runner).dispatch({ agent: 'gpt-5.5', prompt: 'review this' });
    expect(runner.calls[0]?.args).toEqual(['exec', '--model', 'gpt-5.5', 'review this']);
  });

  it('health uses --version exit code', async () => {
    expect((await new CodexHarness(new FakeRunner(res({ code: 0 }))).health()).healthy).toBe(true);
    expect((await new CodexHarness(new FakeRunner(res({ code: 1 }))).health()).healthy).toBe(false);
  });

  it('splices extra args after exec (e.g. MCP-disable for flaky hosts)', async () => {
    const runner = new FakeRunner(res({ stdout: 'ok' }));
    await new CodexHarness(runner, { args: ['-c', 'mcp_servers={}'] }).dispatch({
      agent: 'gpt-5.5',
      prompt: 'review this',
    });
    expect(runner.calls[0]?.args).toEqual([
      'exec',
      '-c',
      'mcp_servers={}',
      '--model',
      'gpt-5.5',
      'review this',
    ]);
  });
});

describe('OpencodeHarness', () => {
  it('dispatch builds `opencode run -m <provider/model> <prompt>`', async () => {
    const runner = new FakeRunner(res());
    await new OpencodeHarness(runner).dispatch({ agent: 'volcengine/doubao', prompt: 'go' });
    expect(runner.calls[0]?.args).toEqual(['run', '-m', 'volcengine/doubao', 'go']);
  });

  it('splices extra args after run', async () => {
    const runner = new FakeRunner(res());
    await new OpencodeHarness(runner, { args: ['--agent', 'build'] }).dispatch({
      agent: 'volcengine/doubao',
      prompt: 'go',
    });
    expect(runner.calls[0]?.args).toEqual([
      'run',
      '--agent',
      'build',
      '-m',
      'volcengine/doubao',
      'go',
    ]);
  });
});
