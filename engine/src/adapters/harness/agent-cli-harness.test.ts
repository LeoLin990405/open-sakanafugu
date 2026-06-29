import { describe, expect, it } from 'vitest';

import type { InvocationDescriptor } from '../../domain/invocation-descriptor.js';
import { isErr, isOk } from '../../domain/result.js';
import type { CommandOptions, CommandResult, CommandRunner } from '../../infra/command-runner.js';
import {
  AgentCliHarness,
  QWEN_CODE_INVOCATION_DESCRIPTOR,
  type AgentCliRegistrySource,
} from './agent-cli-harness.js';

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

describe('AgentCliHarness', () => {
  it('dispatches Qwen Code through the descriptor flag prompt shape', async () => {
    const runner = new FakeRunner(res({ stdout: 'ok' }));
    const result = await new AgentCliHarness(runner, QWEN_CODE_INVOCATION_DESCRIPTOR).dispatch({
      agent: 'default',
      prompt: 'implement this',
    });

    expect(runner.calls[0]?.command).toBe('qwen');
    expect(runner.calls[0]?.args).toEqual(['-p', 'implement this']);
    expect(isOk(result) && result.value.output).toBe('ok');
  });

  it('uses --model for non-default targets on omit-when-default descriptors', async () => {
    const runner = new FakeRunner(res({ stdout: 'ok' }));
    await new AgentCliHarness(runner, QWEN_CODE_INVOCATION_DESCRIPTOR).dispatch({
      agent: 'qwen3-coder-plus',
      prompt: 'implement this',
    });

    expect(runner.calls[0]?.args).toEqual(['--model', 'qwen3-coder-plus', '-p', 'implement this']);
  });

  it('selects Kimi Code through an agent-cli registry id', async () => {
    const runner = new FakeRunner(res({ stdout: 'ok' }));
    const source: AgentCliRegistrySource = { agentId: 'kimi-code' };
    await new AgentCliHarness(runner, source).dispatch({
      agent: 'default',
      prompt: 'implement this',
    });

    expect(runner.calls[0]?.command).toBe('kimi');
    expect(runner.calls[0]?.args).toEqual(['-p', 'implement this']);
  });

  it('selects MiMo Code through an agent-cli registry id', async () => {
    const runner = new FakeRunner(res({ stdout: 'ok' }));
    const source: AgentCliRegistrySource = { agentId: 'mimo-code' };
    await new AgentCliHarness(runner, source).dispatch({
      agent: 'default',
      prompt: 'implement this',
    });

    expect(runner.calls[0]?.command).toBe('mimo');
    expect(runner.calls[0]?.args).toEqual(['-p', 'implement this']);
  });

  it('selects Trae Agent through an agent-cli registry id', async () => {
    const runner = new FakeRunner(res({ stdout: 'ok' }));
    const source: AgentCliRegistrySource = { agentId: 'trae-agent' };
    await new AgentCliHarness(runner, source, { args: ['--provider', 'anthropic'] }).dispatch({
      agent: 'claude-sonnet-4',
      prompt: 'implement this',
    });

    expect(runner.calls[0]?.command).toBe('trae-cli');
    expect(runner.calls[0]?.args).toEqual([
      'run',
      'implement this',
      '--model',
      'claude-sonnet-4',
      '--provider',
      'anthropic',
    ]);
  });

  it('selects Qoder CLI through an agent-cli registry id', async () => {
    const runner = new FakeRunner(res({ stdout: 'ok' }));
    const source: AgentCliRegistrySource = { agentId: 'qoder-cli' };
    await new AgentCliHarness(runner, source).dispatch({
      agent: 'default',
      prompt: 'implement this',
    });

    expect(runner.calls[0]?.command).toBe('qodercli');
    expect(runner.calls[0]?.args).toEqual(['--print', '-p', 'implement this']);
  });

  it('rejects unknown agent-cli registry ids as programmer errors', () => {
    const runner = new FakeRunner(res({ stdout: 'ok' }));
    expect(() => new AgentCliHarness(runner, { agentId: 'missing-code' })).toThrow(/missing-code/u);
  });

  it('pipes stdin when promptMode is stdin', async () => {
    const descriptor: InvocationDescriptor = {
      bin: 'runner',
      subcommand: ['ask'],
      promptMode: 'stdin',
      modelArg: 'positional',
      healthCmd: ['ping'],
      failureMode: 'exit-code',
    };
    const runner = new FakeRunner(res({ stdout: 'done' }));
    await new AgentCliHarness(runner, descriptor).dispatch({
      agent: 'worker',
      prompt: 'stdin prompt',
    });

    expect(runner.calls[0]?.args).toEqual(['ask', 'worker']);
    expect(runner.calls[0]?.options?.stdin).toBe('stdin prompt\n');
  });

  it('runs descriptor healthCmd for health', async () => {
    const runner = new FakeRunner(res({ stdout: 'qwen 0.1.0\n' }));
    const health = await new AgentCliHarness(runner, QWEN_CODE_INVOCATION_DESCRIPTOR).health();

    expect(runner.calls[0]?.args).toEqual(['--version']);
    expect(health.healthy).toBe(true);
    expect(health.detail).toContain('qwen 0.1.0');
  });

  it('maps zero-exit stderr failures when the descriptor requests it', async () => {
    const descriptor: InvocationDescriptor = {
      bin: 'opencode-ish',
      subcommand: ['run'],
      promptMode: 'positional',
      modelArg: '-m',
      healthCmd: ['--version'],
      failureMode: 'zero-exit-stderr',
    };
    const runner = new FakeRunner(
      res({
        code: 0,
        stdout: '',
        stderr: 'ProviderModelNotFoundError: Model not found',
      }),
    );
    const result = await new AgentCliHarness(runner, descriptor).dispatch({
      agent: 'missing/model',
      prompt: 'go',
    });

    expect(isErr(result) && result.error.kind).toBe('unavailable');
    expect(isErr(result) && result.error.detail).toContain('Model not found');
  });

  it('lets options override the descriptor bin and command options', async () => {
    const runner = new FakeRunner(res({ stdout: 'ok' }));
    await new AgentCliHarness(runner, QWEN_CODE_INVOCATION_DESCRIPTOR, {
      bin: '/tmp/qwen',
      cwd: '/tmp/project',
      timeoutMs: 123,
      args: ['--approval-mode', 'readonly'],
    }).dispatch({ agent: 'default', prompt: 'go' });

    expect(runner.calls[0]?.command).toBe('/tmp/qwen');
    expect(runner.calls[0]?.args).toEqual(['--approval-mode', 'readonly', '-p', 'go']);
    expect(runner.calls[0]?.options?.cwd).toBe('/tmp/project');
    expect(runner.calls[0]?.options?.timeoutMs).toBe(123);
  });
});
