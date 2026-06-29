import { describe, expect, it } from 'vitest';

import {
  ACTION_CHECKPOINT_KINDS,
  buildActionCertificate,
  isActionApprovalClass,
} from './action-certificate.js';

describe('buildActionCertificate', () => {
  it('builds a PCAA-style dispatch certificate with five checkpoints', () => {
    const certificate = buildActionCertificate({
      actionId: 'act-123',
      issuedAt: '2026-06-29T10:50:00.000Z',
      openedAt: '2026-06-29T10:49:58.000Z',
      closedAt: '2026-06-29T10:50:00.000Z',
      runtime: { harness: 'codex', target: 'gpt-5.5' },
      action: {
        promptSha256: 'p'.repeat(64),
        promptChars: 42,
        taskRef: '/tmp/TASK.md',
        taskType: 'review',
        workspace: 'code',
      },
      approvalClass: 'operator-reviewed',
      assumptions: ['reviewer is independent'],
      externalities: ['destination=local-file'],
      outcome: {
        status: 'ok',
        exitCode: 0,
        durationMs: 1200,
        outputChars: 18,
        outputSha256: 'o'.repeat(64),
        outputPath: '/tmp/out.txt',
      },
    });

    expect(certificate.schemaVersion).toBe('fugunano.action-certificate.v1');
    expect(certificate.runtime).toEqual({ harness: 'codex', target: 'gpt-5.5' });
    expect(certificate.action.taskRef).toBe('/tmp/TASK.md');
    expect(certificate.approval.class).toBe('operator-reviewed');
    expect(certificate.assumptions).toEqual(['reviewer is independent']);
    expect(certificate.externalities).toEqual(['destination=local-file']);
    expect(certificate.checkpoints.map((checkpoint) => checkpoint.kind)).toEqual(
      ACTION_CHECKPOINT_KINDS,
    );
    expect(certificate.checkpoints[2]).toMatchObject({
      kind: 'assumption-capture',
      status: 'recorded',
      evidence: ['reviewer is independent', 'externality: destination=local-file'],
    });
    expect(certificate.checkpoints[3]).toMatchObject({
      kind: 'approval',
      status: 'recorded',
      evidence: ['approval class: operator-reviewed'],
    });
    expect(certificate.checkpoints[4]).toMatchObject({
      kind: 'outcome-closure',
      status: 'passed',
    });
  });

  it('marks empty assumptions and no approval as not required', () => {
    const certificate = buildActionCertificate({
      actionId: 'act-empty',
      issuedAt: '2026-06-29T10:50:00.000Z',
      openedAt: '2026-06-29T10:49:58.000Z',
      closedAt: '2026-06-29T10:50:00.000Z',
      runtime: { harness: 'fugue-cc', target: 'cc-deepseek' },
      action: {
        promptSha256: 'p'.repeat(64),
        promptChars: 42,
      },
      approvalClass: 'not-required',
      assumptions: ['  ', ''],
      externalities: [],
      outcome: {
        status: 'failed',
        exitCode: 1,
        durationMs: 10,
        outputChars: 0,
        errorKind: 'timeout',
      },
    });

    expect(certificate.assumptions).toEqual([]);
    expect(certificate.checkpoints[2]).toMatchObject({
      kind: 'assumption-capture',
      status: 'not-required',
    });
    expect(certificate.checkpoints[3]).toMatchObject({
      kind: 'approval',
      status: 'not-required',
    });
    expect(certificate.checkpoints[4]).toMatchObject({
      kind: 'outcome-closure',
      status: 'failed',
      evidence: ['rc=1', 'output_chars=0', 'error=timeout'],
    });
  });
});

describe('isActionApprovalClass', () => {
  it('recognizes the bounded approval taxonomy', () => {
    expect(isActionApprovalClass('runtime-enforced')).toBe(true);
    expect(isActionApprovalClass('reviewed')).toBe(false);
  });
});
