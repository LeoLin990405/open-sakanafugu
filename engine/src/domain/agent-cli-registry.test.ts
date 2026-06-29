import { describe, expect, it } from 'vitest';

import {
  AGENT_CLI_IDS,
  KIMI_CODE_INVOCATION_DESCRIPTOR,
  MIMO_CODE_INVOCATION_DESCRIPTOR,
  QODER_CLI_INVOCATION_DESCRIPTOR,
  QWEN_CODE_INVOCATION_DESCRIPTOR,
  TRAE_AGENT_INVOCATION_DESCRIPTOR,
  agentCliEntries,
  lookupAgentCliDescriptor,
  lookupAgentCliEntry,
} from './agent-cli-registry.js';
import { buildArgv } from './invocation-descriptor.js';

describe('agent-cli registry', () => {
  it('lists descriptor-backed coding runtimes without adding harness names', () => {
    expect(AGENT_CLI_IDS).toEqual([
      'qwen-code',
      'kimi-code',
      'mimo-code',
      'trae-agent',
      'qoder-cli',
    ]);
    expect(agentCliEntries().map((entry) => entry.modelFamily)).toEqual([
      'qwen',
      'kimi',
      'mimo',
      'trae',
      'qoder',
    ]);
    expect(lookupAgentCliEntry('unknown')).toBeUndefined();
  });

  it('looks up qwen-code and preserves its existing argv shape', () => {
    expect(lookupAgentCliDescriptor('qwen-code')).toEqual(QWEN_CODE_INVOCATION_DESCRIPTOR);
    expect(
      buildArgv(QWEN_CODE_INVOCATION_DESCRIPTOR, {
        agent: 'qwen3-coder-plus',
        prompt: 'fix it',
      }),
    ).toEqual(['--model', 'qwen3-coder-plus', '-p', 'fix it']);
  });

  it('declares Kimi Code as a flag-prompt agent-cli runtime', () => {
    expect(lookupAgentCliDescriptor('kimi-code')).toEqual(KIMI_CODE_INVOCATION_DESCRIPTOR);
    expect(KIMI_CODE_INVOCATION_DESCRIPTOR.bin).toBe('kimi');
    expect(KIMI_CODE_INVOCATION_DESCRIPTOR.healthCmd).toEqual(['--version']);
    expect(
      buildArgv(KIMI_CODE_INVOCATION_DESCRIPTOR, {
        agent: 'default',
        prompt: 'implement task',
      }),
    ).toEqual(['-p', 'implement task']);
  });

  it('declares MiMo Code as a flag-prompt agent-cli runtime', () => {
    expect(lookupAgentCliDescriptor('mimo-code')).toEqual(MIMO_CODE_INVOCATION_DESCRIPTOR);
    expect(MIMO_CODE_INVOCATION_DESCRIPTOR.bin).toBe('mimo');
    expect(MIMO_CODE_INVOCATION_DESCRIPTOR.healthCmd).toEqual(['--version']);
    expect(
      buildArgv(MIMO_CODE_INVOCATION_DESCRIPTOR, {
        agent: 'default',
        prompt: 'implement task',
      }),
    ).toEqual(['-p', 'implement task']);
  });

  it('declares Trae Agent as a prompt-first run descriptor', () => {
    expect(lookupAgentCliDescriptor('trae-agent')).toEqual(TRAE_AGENT_INVOCATION_DESCRIPTOR);
    expect(TRAE_AGENT_INVOCATION_DESCRIPTOR.bin).toBe('trae-cli');
    expect(TRAE_AGENT_INVOCATION_DESCRIPTOR.healthCmd).toEqual(['--version']);
    expect(
      buildArgv(
        TRAE_AGENT_INVOCATION_DESCRIPTOR,
        {
          agent: 'claude-sonnet-4',
          prompt: 'implement task',
        },
        { extraArgs: ['--provider', 'anthropic'] },
      ),
    ).toEqual(['run', 'implement task', '--model', 'claude-sonnet-4', '--provider', 'anthropic']);
  });

  it('declares Qoder CLI as a print-mode flag-prompt descriptor', () => {
    expect(lookupAgentCliDescriptor('qoder-cli')).toEqual(QODER_CLI_INVOCATION_DESCRIPTOR);
    expect(QODER_CLI_INVOCATION_DESCRIPTOR.bin).toBe('qodercli');
    expect(QODER_CLI_INVOCATION_DESCRIPTOR.healthCmd).toEqual(['--version']);
    expect(
      buildArgv(QODER_CLI_INVOCATION_DESCRIPTOR, {
        agent: 'default',
        prompt: 'implement task',
      }),
    ).toEqual(['--print', '-p', 'implement task']);
  });
});
