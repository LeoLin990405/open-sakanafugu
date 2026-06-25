import { describe, expect, it } from 'vitest';

import type {
  DispatchError,
  DispatchRequest,
  DispatchResult,
  HealthStatus,
} from '../../domain/dispatch.js';
import type { Harness } from '../../domain/ports/harness.js';
import { err, ok } from '../../domain/result.js';
import type { Result } from '../../domain/result.js';
import type { HarnessConfig, WeaknessCluster } from '../../domain/self-harness.js';
import { HarnessBackedProposer } from './harness-proposer.js';

const config: HarnessConfig = {
  'system-prompt': 'Be concise.',
  'memory-sources': 'Use run notes.',
  subagents: 'Reviewer only.',
  skills: 'Load matching skills.',
  bootstrap: 'Start by reading the task.',
  execution: 'Run focused commands.',
  verification: 'Run tests.',
  'failure-recovery': 'Retry once with context.',
  'runtime-policy': 'No Gemini.',
};

const clusters: readonly WeaknessCluster[] = [
  {
    signature: {
      cause: 'tests skipped',
      causalStatus: 'causal',
      mechanism: 'weak verification gate',
    },
    count: 4,
    taskKeys: ['t1', 't2', 't3', 't4'],
  },
  {
    signature: {
      cause: 'large speculative edits',
      causalStatus: 'contributing',
      mechanism: 'over-broad execution plan',
    },
    count: 2,
    taskKeys: ['t5', 't6'],
  },
];

class FakeHarness implements Harness {
  readonly name = 'codex';
  readonly requests: DispatchRequest[] = [];

  constructor(
    private readonly result: Result<DispatchResult, DispatchError>,
    private readonly rejectDispatch = false,
  ) {}

  dispatch(request: DispatchRequest): Promise<Result<DispatchResult, DispatchError>> {
    this.requests.push(request);
    if (this.rejectDispatch) return Promise.reject(new Error('dispatch rejected'));
    return Promise.resolve(this.result);
  }

  health(): Promise<HealthStatus> {
    return Promise.resolve({ healthy: true, detail: 'ok' });
  }
}

const harnessOk = (output: string): FakeHarness =>
  new FakeHarness(ok({ agent: 'agent-1', output, exitCode: 0 }));

describe('HarnessBackedProposer', () => {
  it('parses clean JSON and sends the prompt through the configured harness task', async () => {
    const harness = harnessOk(
      JSON.stringify([
        {
          surface: 'verification',
          mechanism: 'weak verification gate',
          after: 'Always run the narrowest relevant test and report the result.',
          rationale: 'Tightens the verifier loop.',
        },
      ]),
    );

    const edits = await new HarnessBackedProposer(harness, {
      agent: 'agent-1',
    }).propose(config, clusters, 3);

    expect(edits).toEqual([
      {
        surface: 'verification',
        mechanism: 'weak verification gate',
        after: 'Always run the narrowest relevant test and report the result.',
        rationale: 'Tightens the verifier loop.',
      },
    ]);
    expect(harness.requests[0]?.agent).toBe('agent-1');
    expect(harness.requests[0]?.taskType).toBe('self-harness-propose');
    expect(harness.requests[0]?.prompt).toContain('weak verification gate');
    expect(harness.requests[0]?.prompt).toContain('system-prompt');
    expect(harness.requests[0]?.prompt).toContain('at most 4000 characters');
  });

  it('extracts JSON from fenced output with surrounding prose', async () => {
    const harness = harnessOk(`Here is the proposal:
\`\`\`json
[
  {
    "surface": "execution",
    "mechanism": "over-broad execution plan",
    "after": "Make the smallest code change that addresses the observed failure.",
    "rationale": "Bounds edit scope."
  }
]
\`\`\`
Done.`);

    const edits = await new HarnessBackedProposer(harness, { agent: 'agent-1' }).propose(
      config,
      clusters,
      2,
    );

    expect(edits.map((edit) => edit.surface)).toEqual(['execution']);
  });

  it('drops edits with invalid surfaces', async () => {
    const harness = harnessOk(
      JSON.stringify([
        {
          surface: 'made-up-surface',
          mechanism: 'weak verification gate',
          after: 'Run tests.',
          rationale: 'Invalid surface.',
        },
        {
          surface: 'verification',
          mechanism: 'weak verification gate',
          after: 'Run tests before finishing.',
          rationale: 'Valid surface.',
        },
      ]),
    );

    const edits = await new HarnessBackedProposer(harness, { agent: 'agent-1' }).propose(
      config,
      clusters,
      2,
    );

    expect(edits).toHaveLength(1);
    expect(edits[0]?.surface).toBe('verification');
  });

  it('drops edits whose mechanism is not one of the mined clusters', async () => {
    const harness = harnessOk(
      JSON.stringify([
        {
          surface: 'verification',
          mechanism: 'invented mechanism',
          after: 'Run tests.',
          rationale: 'Invalid mechanism.',
        },
        {
          surface: 'execution',
          mechanism: 'over-broad execution plan',
          after: 'Keep edits narrow.',
          rationale: 'Valid mechanism.',
        },
      ]),
    );

    const edits = await new HarnessBackedProposer(harness, { agent: 'agent-1' }).propose(
      config,
      clusters,
      2,
    );

    expect(edits).toHaveLength(1);
    expect(edits[0]?.mechanism).toBe('over-broad execution plan');
  });

  it('caps valid edits to k', async () => {
    const harness = harnessOk(
      JSON.stringify([
        {
          surface: 'verification',
          mechanism: 'weak verification gate',
          after: 'Run tests.',
          rationale: '',
        },
        {
          surface: 'execution',
          mechanism: 'over-broad execution plan',
          after: 'Keep edits narrow.',
          rationale: '',
        },
      ]),
    );

    const edits = await new HarnessBackedProposer(harness, { agent: 'agent-1' }).propose(
      config,
      clusters,
      1,
    );

    expect(edits).toHaveLength(1);
    expect(edits[0]?.surface).toBe('verification');
  });

  it('truncates oversized after text to maxAfterChars', async () => {
    const harness = harnessOk(
      JSON.stringify([
        {
          surface: 'verification',
          mechanism: 'weak verification gate',
          after: 'abcdef',
          rationale: '',
        },
      ]),
    );

    const edits = await new HarnessBackedProposer(harness, {
      agent: 'agent-1',
      maxAfterChars: 3,
    }).propose(config, clusters, 1);

    expect(edits[0]?.after).toBe('abc');
    expect(harness.requests[0]?.prompt).toContain('at most 3 characters');
  });

  it('drops empty after text and defaults non-string rationales', async () => {
    const harness = harnessOk(
      JSON.stringify([
        {
          surface: 'verification',
          mechanism: 'weak verification gate',
          after: '   ',
          rationale: 'empty after',
        },
        {
          surface: 'execution',
          mechanism: 'over-broad execution plan',
          after: 'Keep the change small.',
          rationale: 123,
        },
      ]),
    );

    const edits = await new HarnessBackedProposer(harness, { agent: 'agent-1' }).propose(
      config,
      clusters,
      2,
    );

    expect(edits).toEqual([
      {
        surface: 'execution',
        mechanism: 'over-broad execution plan',
        after: 'Keep the change small.',
        rationale: '',
      },
    ]);
  });

  it('returns empty without dispatching for empty work', async () => {
    const harness = harnessOk('[]');
    const proposer = new HarnessBackedProposer(harness, { agent: 'agent-1' });

    await expect(proposer.propose(config, clusters, 0)).resolves.toEqual([]);
    await expect(proposer.propose(config, clusters, -1)).resolves.toEqual([]);
    await expect(proposer.propose(config, clusters, Number.NaN)).resolves.toEqual([]);
    await expect(proposer.propose(config, [], 1)).resolves.toEqual([]);
    expect(harness.requests).toHaveLength(0);
  });

  it('returns an empty list on dispatch errors', async () => {
    const harness = new FakeHarness(
      err({
        agent: 'agent-1',
        kind: 'unavailable',
        detail: 'offline',
      }),
    );

    const edits = await new HarnessBackedProposer(harness, { agent: 'agent-1' }).propose(
      config,
      clusters,
      1,
    );

    expect(edits).toEqual([]);
  });

  it('returns an empty list on dispatch rejections', async () => {
    const harness = new FakeHarness(ok({ agent: 'agent-1', output: '[]', exitCode: 0 }), true);

    const edits = await new HarnessBackedProposer(harness, { agent: 'agent-1' }).propose(
      config,
      clusters,
      1,
    );

    expect(edits).toEqual([]);
    expect(harness.requests).toHaveLength(1);
  });

  it('returns an empty list on non-JSON output', async () => {
    const edits = await new HarnessBackedProposer(harnessOk('no proposals today'), {
      agent: 'agent-1',
    }).propose(config, clusters, 1);

    expect(edits).toEqual([]);
  });
});
