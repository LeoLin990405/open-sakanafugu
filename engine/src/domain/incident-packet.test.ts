import { describe, expect, it } from 'vitest';

import {
  INCIDENT_PACKET_SCHEMA_VERSION,
  INCIDENT_RECOVERY_PACKET_SCHEMA_VERSION,
  incidentRecoveryPacket,
  incidentPacket,
  renderIncidentRecoveryPacket,
  renderIncidentPacket,
} from './incident-packet.js';

describe('incidentPacket', () => {
  it('classifies review, verification, build, and integration incidents with provenance', () => {
    const content = [
      'VERDICT: NEEDS FIX',
      '- [P1] engine/src/domain/foo.ts:7 has a regression.',
      'FAIL src/domain/foo.test.ts > parses edge cases',
      'error TS2322: Type string is not assignable to type number.',
      'CONFLICT (content): Merge conflict in engine/src/index.ts',
    ].join('\n');

    const packet = incidentPacket(content, {
      sourceRef: '/tmp/fugunano-review.txt',
      sourceSha256: 'abc123',
    });

    expect(packet.schemaVersion).toBe(INCIDENT_PACKET_SCHEMA_VERSION);
    expect(packet.sourceRef).toBe('/tmp/fugunano-review.txt');
    expect(packet.sourceChars).toBe(content.length);
    expect(packet.incidentCount).toBe(4);
    expect(packet.incidents.map((incident) => incident.kind)).toEqual([
      'review-needs-fix',
      'verification-failure',
      'build-failure',
      'integration-conflict',
    ]);
    expect(packet.incidents[0]).toMatchObject({
      id: 'I1',
      severity: 'major',
      failureCause: 'verification',
      mastCategory: 'task-verification',
      harnessLayer: 'verification',
      evidence: [{ line: 1, excerpt: 'VERDICT: NEEDS FIX' }],
    });
    expect(packet.incidents[3]).toMatchObject({
      failureCause: 'integration',
      mastCategory: 'inter-agent-misalignment',
      harnessLayer: 'lifecycle',
    });
    expect(packet.issues).toEqual([]);
  });

  it('classifies policy, runtime, tooling, missing output, context, and planning evidence', () => {
    const packet = incidentPacket(
      [
        '[runtime-guard:packet] disposition=BLOCK findings=2',
        'dispatch timed out after 120000ms',
        'spawn cc-kimi ENOENT',
        'require-output: no output file was written by the agent',
        'source-provenance: external issue lacks stable source ref',
        'requirement unclear: acceptance gate was missing',
      ].join('\n'),
      { sourceRef: 'TASK.md', sourceSha256: 'def456' },
    );

    expect(packet.incidents.map((incident) => incident.kind)).toEqual([
      'policy-violation',
      'runtime-failure',
      'tooling-error',
      'missing-output',
      'context-provenance',
      'planning-error',
    ]);
    expect(packet.incidents[0]).toMatchObject({
      severity: 'critical',
      failureCause: 'policy',
      mastCategory: 'system-design',
      harnessLayer: 'governance',
    });
    expect(packet.incidents[1]?.recommendedChecks).toContain(
      'rerun with a captured artifact and explicit timeout',
    );
    expect(packet.incidents[4]).toMatchObject({
      failureCause: 'context',
      harnessLayer: 'context',
    });
  });

  it('limits evidence per incident and redacts long token-like strings', () => {
    const token = 'sk_' + 'a'.repeat(40);
    const packet = incidentPacket(
      [`FAIL test one ${token}`, 'FAIL test two', 'FAIL test three', 'FAIL test four'].join('\n'),
      { sourceRef: 'stdin', sourceSha256: 'ghi789' },
    );

    expect(packet.incidents).toHaveLength(1);
    expect(packet.incidents[0]?.evidence).toHaveLength(3);
    expect(packet.incidents[0]?.evidence[0]?.excerpt).toContain('<redacted-token>');
  });

  it('classifies common Node dependency resolution failures as tooling errors', () => {
    const packet = incidentPacket("Error: Cannot find module '@example/missing'\n", {
      sourceRef: 'ci.log',
      sourceSha256: 'hash',
    });

    expect(packet.incidents).toHaveLength(1);
    expect(packet.incidents[0]).toMatchObject({
      kind: 'tooling-error',
      failureCause: 'tooling',
      harnessLayer: 'tools',
    });
  });

  it('records an audit issue when no incident pattern is detected', () => {
    const packet = incidentPacket('All checks passed.\n', {
      sourceRef: 'stdin',
      sourceSha256: 'hash',
    });

    expect(packet.incidentCount).toBe(0);
    expect(packet.incidents).toEqual([]);
    expect(packet.issues).toEqual([
      {
        kind: 'no-incident-detected',
        detail: 'input did not match any known incident pattern',
      },
    ]);
  });
});

describe('renderIncidentPacket', () => {
  it('renders parse-stable markdown with metadata, incidents, checks, and issues', () => {
    const packet = incidentPacket('VERDICT: NEEDS_FIX\n', {
      sourceRef: '/tmp/review.txt',
      sourceSha256: 'hash',
    });

    expect(renderIncidentPacket(packet)).toBe(
      [
        '[incident:packet] incidents=1',
        `[incident:packet:meta] {"schemaVersion":"fugunano.incident-packet.v1","sourceRef":"/tmp/review.txt","sourceSha256":"hash","sourceChars":${String(
          packet.sourceChars,
        )},"incidentCount":1}`,
        '## Incidents',
        '- I1 [major/verification/review-needs-fix] MAST=task-verification layer=verification line 1 "VERDICT: NEEDS_FIX" :: independent review reported NEEDS FIX',
        '  - check: rerun the exact failing check locally',
        '  - check: turn the failure into a regression test or review packet before re-review',
        '## Issues',
        '- issue: (none)',
        '',
      ].join('\n'),
    );
  });

  it('JSON-escapes evidence excerpts in rendered packets', () => {
    const packet = incidentPacket('FAIL test "quoted" \\\\ path\n', {
      sourceRef: '/tmp/failure.log',
      sourceSha256: 'hash',
    });
    const excerpt = packet.incidents[0]?.evidence[0]?.excerpt;

    expect(excerpt).toBeDefined();

    expect(renderIncidentPacket(packet)).toContain(`line 1 ${JSON.stringify(excerpt)}`);
  });
});

describe('incidentRecoveryPacket', () => {
  it('turns evidence-grounded incidents into ordered recovery guidance', () => {
    const incidents = incidentPacket(
      [
        'VERDICT: NEEDS FIX',
        'spawn cc-kimi ENOENT',
        '[runtime-guard:packet] disposition=BLOCK findings=1',
      ].join('\n'),
      { sourceRef: '/tmp/failure.log', sourceSha256: 'hash' },
    );

    const recovery = incidentRecoveryPacket(incidents);

    expect(recovery.schemaVersion).toBe(INCIDENT_RECOVERY_PACKET_SCHEMA_VERSION);
    expect(recovery.guidanceGate).toEqual({
      disposition: 'ready',
      reasons: ['all recovery steps are grounded in incident line evidence'],
    });
    expect(recovery.stepCount).toBe(12);
    expect(recovery.steps.map((step) => step.phase).slice(0, 4)).toEqual([
      'containment',
      'repair',
      'validation',
      'learning',
    ]);
    expect(recovery.steps[0]).toMatchObject({
      id: 'R1',
      phase: 'containment',
      scope: 'harness',
      failureCause: 'policy',
      evidenceIncidentIds: ['I1'],
    });
    expect(recovery.steps[4]).toMatchObject({
      phase: 'containment',
      failureCause: 'verification',
      evidenceIncidentIds: ['I2'],
    });
    expect(recovery.steps[8]).toMatchObject({
      phase: 'containment',
      failureCause: 'tooling',
      evidenceIncidentIds: ['I3'],
    });
    expect(recovery.steps[9]?.checks).toContain('run fuguectl preflight for the affected runtime');
    expect(recovery.steps[11]?.checks).toEqual([
      'if reusable, record the relabeled lesson with --allow-failure --failure-cause tooling',
    ]);
  });

  it('blocks recovery guidance when no incident evidence exists', () => {
    const incidents = incidentPacket('All checks passed.\n', {
      sourceRef: 'stdin',
      sourceSha256: 'hash',
    });

    const recovery = incidentRecoveryPacket(incidents);

    expect(recovery.guidanceGate.disposition).toBe('blocked');
    expect(recovery.steps).toEqual([]);
    expect(recovery.issues).toEqual([
      {
        kind: 'no-incident-evidence',
        detail: 'recovery guidance is blocked because no incident evidence was detected',
      },
    ]);
  });

  it('blocks recovery guidance for externally supplied evidence-free incidents', () => {
    const incidents = incidentPacket('VERDICT: NEEDS FIX\n', {
      sourceRef: 'review.txt',
      sourceSha256: 'hash',
    });
    const incident = incidents.incidents[0];
    if (incident === undefined) throw new Error('expected an incident');
    const recovery = incidentRecoveryPacket({
      ...incidents,
      incidents: [{ ...incident, evidence: [] }],
    });

    expect(recovery.guidanceGate.disposition).toBe('blocked');
    expect(recovery.steps).toEqual([]);
    expect(recovery.issues).toEqual([
      {
        kind: 'incident-without-evidence',
        detail: 'I1 has no line evidence, so guidance is blocked',
      },
    ]);
  });
});

describe('renderIncidentRecoveryPacket', () => {
  it('renders parse-stable recovery markdown', () => {
    const incidents = incidentPacket('FAIL tests vitest assertion\n', {
      sourceRef: '/tmp/failure.log',
      sourceSha256: 'hash',
    });
    const recovery = incidentRecoveryPacket(incidents);

    expect(renderIncidentRecoveryPacket(recovery)).toContain(
      '[incident:recovery] disposition=READY steps=4',
    );
    expect(renderIncidentRecoveryPacket(recovery)).toContain(
      '- R1 [containment/operator/verification] incidents=I1 :: treat the red check or reviewer verdict as the active gate for the next attempt',
    );
    expect(renderIncidentRecoveryPacket(recovery)).toContain('- issue: (none)');
  });
});
