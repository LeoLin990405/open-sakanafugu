import type {
  DispatchError,
  DispatchRequest,
  DispatchResult,
  HealthStatus,
} from '../../domain/dispatch.js';
import type { Harness } from '../../domain/ports/harness.js';
import { err, isOk, ok } from '../../domain/result.js';
import type { Result } from '../../domain/result.js';

export type AcpMethod = 'initialize' | 'prompt' | 'result';

export interface AcpTransportError {
  readonly message: string;
  readonly code?: number;
}

export interface AcpAgentTransport {
  request(method: AcpMethod, params: unknown): Promise<Result<unknown, AcpTransportError>>;
}

export interface AcpAgentHarnessOptions {
  readonly transport?: AcpAgentTransport;
  readonly clientName?: string;
  readonly protocolVersion?: string;
}

const DEFAULT_CLIENT_NAME = 'fugunano';
const DEFAULT_PROTOCOL_VERSION = '0.1';

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const transportDetail = (error: AcpTransportError): string =>
  error.code === undefined ? error.message : `${error.message} (code=${String(error.code)})`;

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const stringField = (
  record: Readonly<Record<string, unknown>>,
  names: readonly string[],
): string | undefined => {
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
};

const integerField = (
  record: Readonly<Record<string, unknown>>,
  names: readonly string[],
): number | undefined => {
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return undefined;
};

const promptId = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  const record = asRecord(value);
  return record === undefined ? undefined : stringField(record, ['id', 'promptId', 'requestId']);
};

const resultOutput = (
  value: unknown,
): { readonly output: string; readonly exitCode: number } | null => {
  if (typeof value === 'string') return { output: value, exitCode: 0 };
  const record = asRecord(value);
  if (record === undefined) return null;
  const output = stringField(record, ['output', 'text', 'completion']);
  if (output === undefined) return null;
  return { output, exitCode: integerField(record, ['exitCode', 'code']) ?? 0 };
};

class UnconfiguredAcpTransport implements AcpAgentTransport {
  request(): Promise<Result<unknown, AcpTransportError>> {
    return Promise.resolve(
      err({
        message: 'ACP transport not configured [真机TODO: wire real ZCode/GLM transport]',
      }),
    );
  }
}

/**
 * Agent Client Protocol harness.
 *
 * ACP is protocol-shaped rather than argv-shaped, so it deliberately does not
 * use InvocationDescriptor. A real transport can be stdio, socket, or IDE-owned;
 * this adapter only depends on initialize -> prompt -> result request ordering.
 */
export class AcpAgentHarness implements Harness {
  readonly name = 'acp-agent';
  private readonly transport: AcpAgentTransport;
  private readonly clientName: string;
  private readonly protocolVersion: string;

  constructor(options: AcpAgentHarnessOptions = {}) {
    this.transport = options.transport ?? new UnconfiguredAcpTransport();
    this.clientName = options.clientName ?? DEFAULT_CLIENT_NAME;
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
  }

  private async request(
    method: AcpMethod,
    params: unknown,
    agent: string,
  ): Promise<Result<unknown, DispatchError>> {
    try {
      const result = await this.transport.request(method, params);
      return isOk(result)
        ? ok(result.value)
        : err({ agent, kind: 'unavailable', detail: transportDetail(result.error) });
    } catch (error) {
      return err({ agent, kind: 'unavailable', detail: message(error) });
    }
  }

  private initialize(agent: string): Promise<Result<unknown, DispatchError>> {
    return this.request(
      'initialize',
      { client: this.clientName, protocolVersion: this.protocolVersion },
      agent,
    );
  }

  async dispatch(request: DispatchRequest): Promise<Result<DispatchResult, DispatchError>> {
    const initialized = await this.initialize(request.agent);
    if (!isOk(initialized)) return initialized;

    const prompted = await this.request(
      'prompt',
      {
        agent: request.agent,
        prompt: request.prompt,
        ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
        ...(request.taskType === undefined ? {} : { taskType: request.taskType }),
      },
      request.agent,
    );
    if (!isOk(prompted)) return prompted;

    const id = promptId(prompted.value);
    if (id === undefined) {
      return err({
        agent: request.agent,
        kind: 'unavailable',
        detail: 'ACP prompt response did not include an id',
      });
    }

    const completed = await this.request('result', { id }, request.agent);
    if (!isOk(completed)) return completed;
    const output = resultOutput(completed.value);
    if (output === null) {
      return err({
        agent: request.agent,
        kind: 'unavailable',
        detail: 'ACP result response did not include output',
      });
    }
    if (output.exitCode !== 0) {
      return err({
        agent: request.agent,
        kind: 'nonzero-exit',
        detail: output.output,
        exitCode: output.exitCode,
      });
    }
    return ok({ agent: request.agent, output: output.output, exitCode: 0 });
  }

  async health(): Promise<HealthStatus> {
    const initialized = await this.initialize(this.name);
    return isOk(initialized)
      ? { healthy: true, detail: `${this.name} initialized` }
      : { healthy: false, detail: initialized.error.detail };
  }
}
