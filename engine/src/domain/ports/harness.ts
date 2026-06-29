import type { Result } from '../result.js';
import type { DispatchError, DispatchRequest, DispatchResult, HealthStatus } from '../dispatch.js';

export const HARNESS_NAMES = ['fugue-cc', 'codex', 'opencode', 'agy'] as const;
export type CoreHarnessName = (typeof HARNESS_NAMES)[number];

export const EXPERIMENTAL_HARNESS_NAMES = ['agent-cli', 'acp-agent'] as const;
export type ExperimentalHarnessName = (typeof EXPERIMENTAL_HARNESS_NAMES)[number];

export const ALL_HARNESS_NAMES = [...HARNESS_NAMES, ...EXPERIMENTAL_HARNESS_NAMES] as const;
export type HarnessName = (typeof ALL_HARNESS_NAMES)[number];

/**
 * One job model over a fleet of executors. Adapters wrap the corresponding
 * blocking CLI (`fugue-cc` / `codex exec` / `opencode run` / `agy --prompt` /
 * descriptor-backed agent CLIs) or protocol transport (ACP); a remote harness
 * may poll internally and still resolve a single Promise.
 */
export interface Harness {
  readonly name: HarnessName;
  /** Run the prompt on the target agent; resolve with the output or a typed error. */
  dispatch(request: DispatchRequest): Promise<Result<DispatchResult, DispatchError>>;
  /** Whether this harness is ready to accept dispatches (for fugue-cc, provider mounted). */
  health(): Promise<HealthStatus>;
}
