import { describe, expect, it } from 'vitest';

import { err, isErr, isOk, ok } from '../../domain/result.js';
import type { Result } from '../../domain/result.js';
import {
  AcpAgentHarness,
  type AcpAgentTransport,
  type AcpMethod,
  type AcpTransportError,
} from './acp-agent-harness.js';

interface AcpCall {
  readonly method: AcpMethod;
  readonly params: unknown;
}

class ScriptedAcpTransport implements AcpAgentTransport {
  readonly calls: AcpCall[] = [];

  constructor(private readonly responses: readonly Result<unknown, AcpTransportError>[]) {}

  request(method: AcpMethod, params: unknown): Promise<Result<unknown, AcpTransportError>> {
    this.calls.push({ method, params });
    const response = this.responses[this.calls.length - 1];
    return Promise.resolve(response ?? err({ message: `unexpected ${method}` }));
  }
}

describe('AcpAgentHarness', () => {
  it('dispatches through initialize -> prompt -> result', async () => {
    const transport = new ScriptedAcpTransport([
      ok({ server: 'stub-acp' }),
      ok({ id: 'prompt-1' }),
      ok({ output: 'done' }),
    ]);
    const result = await new AcpAgentHarness({ transport }).dispatch({
      agent: 'zcode/glm',
      prompt: 'fix this',
      workspace: 'code',
      taskType: 'impl',
    });

    expect(isOk(result) && result.value.output).toBe('done');
    expect(transport.calls).toEqual([
      { method: 'initialize', params: { client: 'fugunano', protocolVersion: '0.1' } },
      {
        method: 'prompt',
        params: {
          agent: 'zcode/glm',
          prompt: 'fix this',
          workspace: 'code',
          taskType: 'impl',
        },
      },
      { method: 'result', params: { id: 'prompt-1' } },
    ]);
  });

  it('maps initialize failures to unavailable dispatch errors', async () => {
    const transport = new ScriptedAcpTransport([err({ message: 'server missing', code: -32000 })]);
    const result = await new AcpAgentHarness({ transport }).dispatch({
      agent: 'zcode/glm',
      prompt: 'fix this',
    });

    expect(isErr(result) && result.error.kind).toBe('unavailable');
    expect(isErr(result) && result.error.detail).toContain('server missing');
  });

  it('drops malformed prompt acknowledgements', async () => {
    const transport = new ScriptedAcpTransport([ok({}), ok({})]);
    const result = await new AcpAgentHarness({ transport }).dispatch({
      agent: 'zcode/glm',
      prompt: 'fix this',
    });

    expect(isErr(result) && result.error.kind).toBe('unavailable');
    expect(isErr(result) && result.error.detail).toContain('did not include an id');
  });

  it('maps nonzero ACP results to nonzero-exit dispatch errors', async () => {
    const transport = new ScriptedAcpTransport([
      ok({}),
      ok({ promptId: 'p-1' }),
      ok({ output: 'tests failed', exitCode: 2 }),
    ]);
    const result = await new AcpAgentHarness({ transport }).dispatch({
      agent: 'zcode/glm',
      prompt: 'fix this',
    });

    expect(isErr(result) && result.error.kind).toBe('nonzero-exit');
    expect(isErr(result) && result.error.exitCode).toBe(2);
  });

  it('reports health from initialize', async () => {
    const healthy = await new AcpAgentHarness({
      transport: new ScriptedAcpTransport([ok({ server: 'stub-acp' })]),
    }).health();
    const unhealthy = await new AcpAgentHarness({
      transport: new ScriptedAcpTransport([err({ message: 'offline' })]),
    }).health();

    expect(healthy.healthy).toBe(true);
    expect(unhealthy.healthy).toBe(false);
    expect(unhealthy.detail).toContain('offline');
  });
});
