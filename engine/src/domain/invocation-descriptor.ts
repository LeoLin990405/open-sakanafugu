import type { DispatchRequest } from './dispatch.js';

export const PROMPT_MODES = ['positional', 'flag', 'stdin'] as const;
export type PromptMode = (typeof PROMPT_MODES)[number];

export const MODEL_ARG_MODES = ['--model', '-m', 'omit-when-default', 'positional'] as const;
export type ModelArgMode = (typeof MODEL_ARG_MODES)[number];

export const FAILURE_MODES = ['exit-code', 'zero-exit-stderr'] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];

export const DYNAMIC_ARG_ORDERS = ['model-then-prompt', 'prompt-then-model'] as const;
export type DynamicArgOrder = (typeof DYNAMIC_ARG_ORDERS)[number];

export const EXTRA_ARG_PLACEMENTS = ['after-subcommand', 'after-dynamic'] as const;
export type ExtraArgPlacement = (typeof EXTRA_ARG_PLACEMENTS)[number];

/**
 * A deliberately closed runtime contract: known prompt/model/health/failure
 * shapes only. This keeps new agent CLIs declarative instead of template-like.
 */
export interface InvocationDescriptor {
  /** Default executable. Callers may override the bin at the adapter boundary. */
  readonly bin?: string;
  /** Fixed argv prefix after the executable, e.g. `exec` or `run`. */
  readonly subcommand?: readonly string[];
  readonly promptMode: PromptMode;
  /** Required only when promptMode is `flag`, e.g. `-p` or `--prompt`. */
  readonly flagName?: string;
  readonly modelArg: ModelArgMode;
  /** Dynamic argv order. Defaults to `model-then-prompt`. */
  readonly dynamicArgOrder?: DynamicArgOrder;
  /** Extra arg splice point. Defaults to `after-subcommand`. */
  readonly extraArgsPlacement?: ExtraArgPlacement;
  /** Health argv after the executable, e.g. `--version`. */
  readonly healthCmd: readonly string[];
  readonly failureMode: FailureMode;
}

export interface BuildArgvOptions {
  /** Fixed per-host flags spliced after subcommands and before dynamic args. */
  readonly extraArgs?: readonly string[];
}

const requireFlagName = (descriptor: InvocationDescriptor): string => {
  const flag = descriptor.flagName?.trim();
  if (descriptor.promptMode === 'flag' && flag !== undefined && flag.length > 0) return flag;
  throw new Error('InvocationDescriptor with promptMode=flag requires flagName');
};

const pushModelArgs = (
  argv: string[],
  descriptor: InvocationDescriptor,
  request: DispatchRequest,
): void => {
  switch (descriptor.modelArg) {
    case '--model':
      argv.push('--model', request.agent);
      return;
    case '-m':
      argv.push('-m', request.agent);
      return;
    case 'omit-when-default':
      if (request.agent !== 'default') argv.push('--model', request.agent);
      return;
    case 'positional':
      argv.push(request.agent);
      return;
  }
};

const pushPromptArgs = (
  argv: string[],
  descriptor: InvocationDescriptor,
  request: DispatchRequest,
): void => {
  switch (descriptor.promptMode) {
    case 'positional':
      argv.push(request.prompt);
      return;
    case 'flag':
      argv.push(requireFlagName(descriptor), request.prompt);
      return;
    case 'stdin':
      return;
  }
};

export const buildArgv = (
  descriptor: InvocationDescriptor,
  request: DispatchRequest,
  options: BuildArgvOptions = {},
): string[] => {
  const argv: string[] = [];
  const extraArgs = options.extraArgs ?? [];
  argv.push(...(descriptor.subcommand ?? []));
  if ((descriptor.extraArgsPlacement ?? 'after-subcommand') === 'after-subcommand') {
    argv.push(...extraArgs);
  }
  if ((descriptor.dynamicArgOrder ?? 'model-then-prompt') === 'model-then-prompt') {
    pushModelArgs(argv, descriptor, request);
    pushPromptArgs(argv, descriptor, request);
  } else {
    pushPromptArgs(argv, descriptor, request);
    pushModelArgs(argv, descriptor, request);
  }
  if (descriptor.extraArgsPlacement === 'after-dynamic') {
    argv.push(...extraArgs);
  }
  return argv;
};
