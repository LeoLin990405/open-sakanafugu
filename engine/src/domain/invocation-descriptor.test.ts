import { describe, expect, it } from 'vitest';

import type { InvocationDescriptor } from './invocation-descriptor.js';
import { buildArgv } from './invocation-descriptor.js';

const codexDescriptor: InvocationDescriptor = {
  bin: 'codex',
  subcommand: ['exec'],
  promptMode: 'positional',
  modelArg: '--model',
  healthCmd: ['--version'],
  failureMode: 'exit-code',
};

describe('buildArgv', () => {
  it('builds the Codex argv shape with prompt as a positional arg', () => {
    expect(
      buildArgv(codexDescriptor, {
        agent: 'gpt-5.5',
        prompt: 'review this',
      }),
    ).toEqual(['exec', '--model', 'gpt-5.5', 'review this']);
  });

  it('splices extra args after fixed subcommands', () => {
    expect(
      buildArgv(
        codexDescriptor,
        {
          agent: 'gpt-5.5',
          prompt: 'review this',
        },
        { extraArgs: ['-c', 'mcp_servers={}'] },
      ),
    ).toEqual(['exec', '-c', 'mcp_servers={}', '--model', 'gpt-5.5', 'review this']);
  });

  it('omits the model for default agent CLIs and passes prompt by flag', () => {
    const descriptor: InvocationDescriptor = {
      bin: 'qwen',
      promptMode: 'flag',
      flagName: '-p',
      modelArg: 'omit-when-default',
      healthCmd: ['--version'],
      failureMode: 'exit-code',
    };

    expect(buildArgv(descriptor, { agent: 'default', prompt: 'implement it' })).toEqual([
      '-p',
      'implement it',
    ]);
  });

  it('uses a positional model without adding prompt args for stdin mode', () => {
    const descriptor: InvocationDescriptor = {
      bin: 'fugue-like',
      subcommand: ['ask'],
      promptMode: 'stdin',
      modelArg: 'positional',
      healthCmd: ['ping'],
      failureMode: 'exit-code',
    };

    expect(buildArgv(descriptor, { agent: 'cc-deepseek', prompt: 'stdin body' })).toEqual([
      'ask',
      'cc-deepseek',
    ]);
  });

  it('throws only for programmer-invalid flag descriptors', () => {
    const descriptor: InvocationDescriptor = {
      promptMode: 'flag',
      modelArg: 'omit-when-default',
      healthCmd: ['--version'],
      failureMode: 'exit-code',
    };

    expect(() => buildArgv(descriptor, { agent: 'default', prompt: 'x' })).toThrow(/flagName/u);
  });

  it('supports OpenCode run args with -m and a positional prompt', () => {
    const descriptor: InvocationDescriptor = {
      bin: 'opencode',
      subcommand: ['run'],
      promptMode: 'positional',
      modelArg: '-m',
      healthCmd: ['--version'],
      failureMode: 'zero-exit-stderr',
    };

    expect(
      buildArgv(
        descriptor,
        {
          agent: 'opencode/deepseek-v4-flash-free',
          prompt: 'plan this',
        },
        { extraArgs: ['--agent', 'review'] },
      ),
    ).toEqual(['run', '--agent', 'review', '-m', 'opencode/deepseek-v4-flash-free', 'plan this']);
  });

  it('supports Agy prompt-first args with optional model and trailing extra args', () => {
    const descriptor: InvocationDescriptor = {
      bin: 'agy',
      promptMode: 'flag',
      flagName: '--prompt',
      modelArg: 'omit-when-default',
      dynamicArgOrder: 'prompt-then-model',
      extraArgsPlacement: 'after-dynamic',
      healthCmd: ['--version'],
      failureMode: 'exit-code',
    };

    expect(
      buildArgv(
        descriptor,
        {
          agent: 'Gemini 3.5 Flash (Medium)',
          prompt: 'go',
        },
        { extraArgs: ['--new-project'] },
      ),
    ).toEqual(['--prompt', 'go', '--model', 'Gemini 3.5 Flash (Medium)', '--new-project']);
  });
});
