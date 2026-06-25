import { describe, expect, it } from 'vitest';

import type { HarnessConfig } from '../../domain/self-harness.js';
import type { SelfHarnessSpec } from '../../domain/self-harness-spec.js';
import { formatSelfHarnessRunReport } from './self-harness.js';

const config: HarnessConfig = {
  'system-prompt': 'sys',
  'memory-sources': 'mem',
  subagents: 'subs',
  skills: 'skills',
  bootstrap: 'boot',
  execution: 'exec',
  verification: 'verify',
  'failure-recovery': 'recover',
  'runtime-policy': 'policy',
};

describe('formatSelfHarnessRunReport', () => {
  it('prints lineage rows, per-surface changes, and promotion totals', () => {
    const spec: SelfHarnessSpec = {
      agent: 'agent-1',
      k: 1,
      rounds: 2,
      runId: 'run-1',
      config,
      heldIn: [],
      heldOut: [],
    };

    const report = formatSelfHarnessRunReport(spec, {
      config: { ...config, verification: 'verify harder' },
      lineage: [
        {
          round: 1,
          surface: 'verification',
          mechanism: 'weak verification gate',
          verdict: { deltaIn: 1, deltaOut: 0, accepted: true },
          decision: 'accepted',
        },
        {
          round: 1,
          surface: 'execution',
          mechanism: 'over-broad execution plan',
          verdict: { deltaIn: 0, deltaOut: 0, accepted: false },
          decision: 'rejected',
        },
      ],
    });

    expect(report).toContain(
      'round 1 surface=verification mechanism=weak verification gate decision=accepted dIn=1 dOut=0',
    );
    expect(report).toContain(
      'round 1 surface=execution mechanism=over-broad execution plan decision=rejected dIn=0 dOut=0',
    );
    expect(report).toContain('system-prompt = same');
    expect(report).toContain('verification = changed');
    expect(report).toContain('rounds: 2, promoted: 1');
  });
});
