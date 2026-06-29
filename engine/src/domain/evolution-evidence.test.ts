import { describe, expect, it } from 'vitest';

import { buildActionCertificate } from './action-certificate.js';
import { incidentPacket, incidentRecoveryPacket } from './incident-packet.js';
import type { ReviewPacket } from './review-packet.js';
import { reviewPacket } from './review-packet.js';
import { runtimeGuardPacket } from './runtime-guard.js';
import { taskContextDigest } from './task-context-digest.js';
import { taskHandoffPacket } from './task-handoff.js';
import {
  guardPacketWeaknessSignals,
  mapActionCertificate,
  mapIncidentPacket,
  mapIncidentRecoveryPacket,
  mapReviewPacket,
  mapRuntimeGuardPacket,
  mapTaskContextDigest,
  mapTaskHandoffPacket,
  packetWeaknessSignals,
} from './evolution-evidence.js';

const sampleTask = (): string =>
  [
    '# TASK-2026-06-29-001: Example',
    'Status: IN_PROGRESS',
    'Priority: P1',
    '',
    '## Requirements',
    '- Ship the adapter.',
    '',
    '## Subtasks',
    '- [ ] Implement mapping',
    '',
    '## Output files',
    '- engine/src/domain/evolution-evidence.ts',
    '',
    '## Log',
    '- [2026-06-29 12:00] Evidence line.',
  ].join('\n');

describe('evolution evidence packet mappers', () => {
  it('maps runtime guard findings into guard-rule weakness signals', () => {
    const packet = runtimeGuardPacket('Run npm publish without an action certificate.', {
      sourceRef: '/tmp/release-task.md',
      sourceSha256: 'sha-release',
    });

    const mapped = mapRuntimeGuardPacket(packet);

    expect(mapped.warnings).toEqual([]);
    expect(mapped.signals).toEqual([
      {
        sourceRef: '/tmp/release-task.md',
        sourceSha256: 'sha-release',
        kind: 'privileged-action-without-certificate',
        surfaceHint: 'guard-rule',
        cause: 'privileged runtime action lacks an action certificate marker',
        severity: 'major',
        evidenceLines: [{ line: 1, excerpt: 'Run npm publish without an action certificate.' }],
        suggestedChecks: [
          'add dispatch --certificate for replay-ready action provenance',
          'record externalities and assumptions before executing the action',
        ],
      },
    ]);
    expect(guardPacketWeaknessSignals(packet)).toEqual(mapped.signals);
  });

  it('maps review findings into review-rubric weakness signals', () => {
    const packet = reviewPacket('VERDICT: NEEDS FIX\n- security bug in src/auth.ts:12', {
      sourceRef: '/tmp/review.md',
      sourceSha256: 'sha-review',
    });

    const mapped = mapReviewPacket(packet);

    expect(mapped.signals[0]).toMatchObject({
      sourceRef: '/tmp/review.md',
      sourceSha256: 'sha-review',
      kind: 'review-security',
      surfaceHint: 'review-rubric',
      severity: 'critical',
      evidenceLines: [{ line: 12, excerpt: 'src/auth.ts:12' }],
    });
  });

  it('maps incident records into repair-strategy weakness signals', () => {
    const packet = incidentPacket('VERDICT: NEEDS FIX\nTests: 1 failed', {
      sourceRef: '/tmp/failure.log',
      sourceSha256: 'sha-incident',
    });

    const mapped = mapIncidentPacket(packet);

    expect(mapped.signals.map((signal) => signal.surfaceHint)).toEqual([
      'repair-strategy',
      'repair-strategy',
    ]);
    expect(mapped.signals[0]?.kind).toBe('incident-review-needs-fix');
  });

  it('maps incident recovery guidance into repair-strategy weakness signals', () => {
    const incidents = incidentPacket('VERDICT: NEEDS FIX', {
      sourceRef: '/tmp/review.log',
      sourceSha256: 'sha-recovery',
    });
    const recovery = incidentRecoveryPacket(incidents);

    const mapped = mapIncidentRecoveryPacket(recovery);

    expect(mapped.signals.length).toBeGreaterThan(0);
    expect(mapped.signals[0]).toMatchObject({
      sourceRef: '/tmp/review.log',
      sourceSha256: 'sha-recovery',
      surfaceHint: 'repair-strategy',
      kind: 'recovery-containment',
    });
  });

  it('maps task handoff issues into handoff-contract weakness signals', () => {
    const packet = taskHandoffPacket(
      sampleTask().replace('- engine/src/domain/evolution-evidence.ts', ''),
      {
        sourceRef: '/tmp/TASK.md',
      },
    );

    const mapped = mapTaskHandoffPacket(packet);

    expect(mapped.signals.some((signal) => signal.kind === 'handoff-missing-output-files')).toBe(
      true,
    );
    expect(mapped.signals[0]?.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('maps failed action certificates into action-provenance weakness signals', () => {
    const packet = buildActionCertificate({
      actionId: 'act-1',
      issuedAt: '2026-06-29T12:00:00.000Z',
      openedAt: '2026-06-29T11:59:00.000Z',
      closedAt: '2026-06-29T12:00:00.000Z',
      runtime: { harness: 'codex', target: 'gpt-5.5' },
      action: {
        promptSha256: 'p'.repeat(64),
        promptChars: 10,
        taskRef: '/tmp/TASK.md',
      },
      approvalClass: 'operator-reviewed',
      outcome: {
        status: 'failed',
        exitCode: 1,
        durationMs: 10,
        outputChars: 0,
        errorKind: 'nonzero-exit',
      },
    });

    const mapped = mapActionCertificate(packet);

    expect(mapped.signals).toEqual([
      expect.objectContaining({
        sourceRef: '/tmp/TASK.md',
        sourceSha256: 'p'.repeat(64),
        kind: 'certificate-outcome-closure',
        surfaceHint: 'action-provenance',
      }),
    ]);
  });

  it('maps task context omissions into context-selection weakness signals', () => {
    const packet = taskContextDigest(sampleTask(), {
      sourceRef: '/tmp/TASK.md',
      sourceSha256: 'sha-task',
      budgetChars: 430,
      maxEvidence: 1,
    });

    const mapped = mapTaskContextDigest(packet);

    expect(mapped.signals[0]).toMatchObject({
      sourceRef: '/tmp/TASK.md',
      sourceSha256: 'sha-task',
      kind: 'context-digest-omitted-trace',
      surfaceHint: 'context-selection',
    });
  });

  it('dispatches by packet shape and warns on bad evidence instead of throwing', () => {
    const badReview: ReviewPacket = {
      schemaVersion: 'fugunano.review-packet.v1',
      verdict: 'NEEDS_FIX',
      sourceRef: '/tmp/review.md',
      sourceSha256: 'sha-review',
      sourceChars: 10,
      findingCount: 1,
      findings: [
        {
          id: 'F1',
          severity: 'major',
          rubric: 'correctness',
          summary: 'finding without evidence',
          evidence: [],
          recommendedChecks: ['rerun review'],
        },
      ],
      issues: [],
    };

    const mapped = packetWeaknessSignals(badReview);
    const unknown = packetWeaknessSignals({ schemaVersion: 'example.unknown' });

    expect(mapped.signals).toEqual([]);
    expect(mapped.warnings).toEqual(['review F1: dropped signal with no valid evidence']);
    expect(unknown.signals).toEqual([]);
    expect(unknown.warnings).toEqual([
      'unknown packet shape: no evolution evidence mapper matched',
    ]);
  });
});
