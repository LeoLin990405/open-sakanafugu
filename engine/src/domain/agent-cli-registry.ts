import type { AgentRole } from './agent-registry.js';
import type { InvocationDescriptor } from './invocation-descriptor.js';

export const QWEN_CODE_INVOCATION_DESCRIPTOR = {
  bin: 'qwen',
  promptMode: 'flag',
  flagName: '-p',
  modelArg: 'omit-when-default',
  healthCmd: ['--version'],
  failureMode: 'exit-code',
} as const satisfies InvocationDescriptor;

export const KIMI_CODE_INVOCATION_DESCRIPTOR = {
  bin: 'kimi',
  promptMode: 'flag',
  flagName: '-p',
  modelArg: 'omit-when-default',
  healthCmd: ['--version'],
  failureMode: 'exit-code',
} as const satisfies InvocationDescriptor;

export const MIMO_CODE_INVOCATION_DESCRIPTOR = {
  bin: 'mimo',
  promptMode: 'flag',
  flagName: '-p',
  modelArg: 'omit-when-default',
  healthCmd: ['--version'],
  failureMode: 'exit-code',
} as const satisfies InvocationDescriptor;

// [真机TODO] Verify installed Trae binary aliases and provider flag ordering.
// Public Trae Agent docs use: trae-cli run "<task>" --provider <provider> --model <model>.
export const TRAE_AGENT_INVOCATION_DESCRIPTOR = {
  bin: 'trae-cli',
  subcommand: ['run'],
  promptMode: 'positional',
  modelArg: 'omit-when-default',
  dynamicArgOrder: 'prompt-then-model',
  extraArgsPlacement: 'after-dynamic',
  healthCmd: ['--version'],
  failureMode: 'exit-code',
} as const satisfies InvocationDescriptor;

// [真机TODO] Verify Qoder print-mode flag interactions on a logged-in local install.
// Public Qoder CLI docs use qodercli --version, --print, -p, and --model.
export const QODER_CLI_INVOCATION_DESCRIPTOR = {
  bin: 'qodercli',
  subcommand: ['--print'],
  promptMode: 'flag',
  flagName: '-p',
  modelArg: 'omit-when-default',
  healthCmd: ['--version'],
  failureMode: 'exit-code',
} as const satisfies InvocationDescriptor;

export const AGENT_CLI_IDS = [
  'qwen-code',
  'kimi-code',
  'mimo-code',
  'trae-agent',
  'qoder-cli',
] as const;
export type AgentCliId = (typeof AGENT_CLI_IDS)[number];

export interface AgentCliRegistryEntry {
  readonly id: AgentCliId;
  readonly descriptor: InvocationDescriptor;
  readonly modelFamily: string;
  readonly roles: readonly AgentRole[];
}

export const AGENT_CLI_ENTRIES: readonly AgentCliRegistryEntry[] = [
  {
    id: 'qwen-code',
    descriptor: QWEN_CODE_INVOCATION_DESCRIPTOR,
    modelFamily: 'qwen',
    roles: ['implementer', 'fixer'],
  },
  {
    id: 'kimi-code',
    descriptor: KIMI_CODE_INVOCATION_DESCRIPTOR,
    modelFamily: 'kimi',
    roles: ['implementer', 'fixer'],
  },
  {
    id: 'mimo-code',
    descriptor: MIMO_CODE_INVOCATION_DESCRIPTOR,
    modelFamily: 'mimo',
    roles: ['implementer', 'fixer'],
  },
  {
    id: 'trae-agent',
    descriptor: TRAE_AGENT_INVOCATION_DESCRIPTOR,
    modelFamily: 'trae',
    roles: ['implementer', 'fixer'],
  },
  {
    id: 'qoder-cli',
    descriptor: QODER_CLI_INVOCATION_DESCRIPTOR,
    modelFamily: 'qoder',
    roles: ['implementer', 'fixer'],
  },
] as const;

const AGENT_CLI_ENTRY_MAP: ReadonlyMap<string, AgentCliRegistryEntry> = new Map(
  AGENT_CLI_ENTRIES.map((entry): readonly [string, AgentCliRegistryEntry] => [entry.id, entry]),
);

export const agentCliEntries = (): readonly AgentCliRegistryEntry[] => AGENT_CLI_ENTRIES;

export const lookupAgentCliEntry = (agentId: string): AgentCliRegistryEntry | undefined =>
  AGENT_CLI_ENTRY_MAP.get(agentId);

export const lookupAgentCliDescriptor = (agentId: string): InvocationDescriptor | undefined =>
  lookupAgentCliEntry(agentId)?.descriptor;
