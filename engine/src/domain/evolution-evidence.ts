import { createHash } from 'node:crypto';

import type { ActionCertificate } from './action-certificate.js';
import type { IncidentPacket, IncidentRecoveryPacket } from './incident-packet.js';
import type { ReviewPacket } from './review-packet.js';
import type { RuntimeGuardPacket } from './runtime-guard.js';
import type { TaskContextDigest } from './task-context-digest.js';
import type { TaskHandoffPacket } from './task-handoff.js';

export type EvolutionSurfaceHint = string;

export type WeaknessSeverity =
  | 'critical'
  | 'major'
  | 'minor'
  | 'nit'
  | 'warning'
  | 'error'
  | 'unknown';

export interface WeaknessEvidenceLine {
  readonly line: number;
  readonly excerpt: string;
}

export interface WeaknessSignal {
  readonly sourceRef: string;
  readonly sourceSha256: string;
  readonly kind: string;
  readonly surfaceHint: EvolutionSurfaceHint;
  readonly cause: string;
  readonly severity: WeaknessSeverity;
  readonly evidenceLines: readonly WeaknessEvidenceLine[];
  readonly suggestedChecks: readonly string[];
}

export interface WeaknessSignalMapping {
  readonly signals: readonly WeaknessSignal[];
  readonly warnings: readonly string[];
}

type PacketMapper = (packet: unknown) => WeaknessSignalMapping | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

const hasSchemaVersion = (value: unknown, schemaVersion: string): boolean =>
  isRecord(value) && value.schemaVersion === schemaVersion;

const stablePacketSha = (packet: unknown): string => {
  const json = JSON.stringify(packet);
  return createHash('sha256').update(json, 'utf8').digest('hex');
};

const validEvidence = (
  evidence: readonly WeaknessEvidenceLine[],
  label: string,
  warnings: string[],
): readonly WeaknessEvidenceLine[] => {
  const lines = evidence.filter((item) => item.line > 0 && item.excerpt.trim().length > 0);
  if (lines.length === 0) warnings.push(`${label}: dropped signal with no valid evidence`);
  return lines;
};

const appendSignal = (
  signals: WeaknessSignal[],
  warnings: string[],
  label: string,
  signal: WeaknessSignal,
): void => {
  const evidenceLines = validEvidence(signal.evidenceLines, label, warnings);
  if (evidenceLines.length === 0) return;
  signals.push({ ...signal, evidenceLines });
};

export const mapRuntimeGuardPacket = (packet: RuntimeGuardPacket): WeaknessSignalMapping => {
  const signals: WeaknessSignal[] = [];
  const warnings: string[] = [];
  packet.findings.forEach((finding) => {
    appendSignal(signals, warnings, `runtime-guard ${finding.id}`, {
      sourceRef: packet.sourceRef,
      sourceSha256: packet.sourceSha256,
      kind: finding.kind,
      surfaceHint: 'guard-rule',
      cause: finding.summary,
      severity: finding.severity,
      evidenceLines: finding.evidence.map((item) => ({
        line: item.line,
        excerpt: item.excerpt,
      })),
      suggestedChecks: finding.recommendedChecks,
    });
  });
  return { signals, warnings };
};

export const guardPacketWeaknessSignals = (packet: RuntimeGuardPacket): readonly WeaknessSignal[] =>
  mapRuntimeGuardPacket(packet).signals;

export const mapReviewPacket = (packet: ReviewPacket): WeaknessSignalMapping => {
  const signals: WeaknessSignal[] = [];
  const warnings: string[] = [];
  packet.findings.forEach((finding) => {
    appendSignal(signals, warnings, `review ${finding.id}`, {
      sourceRef: packet.sourceRef,
      sourceSha256: packet.sourceSha256,
      kind: `review-${finding.rubric}`,
      surfaceHint: 'review-rubric',
      cause: finding.summary,
      severity: finding.severity,
      evidenceLines: finding.evidence.map((item, index) => ({
        line: item.line ?? index + 1,
        excerpt: item.line === undefined ? item.file : `${item.file}:${String(item.line)}`,
      })),
      suggestedChecks: finding.recommendedChecks,
    });
  });
  for (const issue of packet.issues) {
    warnings.push(`review issue ${issue.kind}: ${issue.detail}`);
  }
  return { signals, warnings };
};

export const mapIncidentPacket = (packet: IncidentPacket): WeaknessSignalMapping => {
  const signals: WeaknessSignal[] = [];
  const warnings: string[] = [];
  packet.incidents.forEach((incident) => {
    appendSignal(signals, warnings, `incident ${incident.id}`, {
      sourceRef: packet.sourceRef,
      sourceSha256: packet.sourceSha256,
      kind: `incident-${incident.kind}`,
      surfaceHint: 'repair-strategy',
      cause: incident.summary,
      severity: incident.severity,
      evidenceLines: incident.evidence.map((item) => ({
        line: item.line,
        excerpt: item.excerpt,
      })),
      suggestedChecks: incident.recommendedChecks,
    });
  });
  for (const issue of packet.issues) {
    warnings.push(`incident issue ${issue.kind}: ${issue.detail}`);
  }
  return { signals, warnings };
};

export const mapIncidentRecoveryPacket = (
  packet: IncidentRecoveryPacket,
): WeaknessSignalMapping => {
  const signals: WeaknessSignal[] = [];
  const warnings: string[] = [];
  packet.steps.forEach((step, index) => {
    appendSignal(signals, warnings, `incident-recovery ${step.id}`, {
      sourceRef: packet.sourceRef,
      sourceSha256: packet.sourceSha256,
      kind: `recovery-${step.phase}`,
      surfaceHint: 'repair-strategy',
      cause: step.action,
      severity: packet.guidanceGate.disposition === 'blocked' ? 'major' : 'minor',
      evidenceLines: [
        {
          line: index + 1,
          excerpt: `${step.phase}/${step.scope}: ${step.rationale}`,
        },
      ],
      suggestedChecks: step.checks,
    });
  });
  for (const issue of packet.issues) {
    warnings.push(`incident-recovery issue ${issue.kind}: ${issue.detail}`);
  }
  return { signals, warnings };
};

export const mapTaskHandoffPacket = (packet: TaskHandoffPacket): WeaknessSignalMapping => {
  const signals: WeaknessSignal[] = [];
  const warnings: string[] = [];
  const sourceSha256 = stablePacketSha(packet);
  packet.issues.forEach((issue, index) => {
    appendSignal(signals, warnings, `task-handoff ${issue.kind}`, {
      sourceRef: packet.sourceRef,
      sourceSha256,
      kind: `handoff-${issue.kind}`,
      surfaceHint: 'handoff-contract',
      cause: issue.detail,
      severity: issue.severity,
      evidenceLines:
        packet.evidence.length === 0
          ? [{ line: index + 1, excerpt: issue.detail }]
          : packet.evidence.map((item, evidenceIndex) => ({
              line: evidenceIndex + 1,
              excerpt: item.at === undefined ? item.text : `${item.at} ${item.text}`,
            })),
      suggestedChecks: [
        'regenerate fuguectl task handoff before redispatch',
        'repair the task contract before another agent consumes it',
      ],
    });
  });
  if (packet.issues.length === 0) warnings.push('task-handoff: no weaknesses detected');
  return { signals, warnings };
};

export const mapActionCertificate = (packet: ActionCertificate): WeaknessSignalMapping => {
  const signals: WeaknessSignal[] = [];
  const warnings: string[] = [];
  packet.checkpoints
    .filter((checkpoint) => checkpoint.status === 'failed')
    .forEach((checkpoint, index) => {
      appendSignal(signals, warnings, `action-certificate ${checkpoint.kind}`, {
        sourceRef: packet.action.taskRef ?? packet.actionId,
        sourceSha256: packet.action.promptSha256,
        kind: `certificate-${checkpoint.kind}`,
        surfaceHint: 'action-provenance',
        cause: `action certificate checkpoint failed: ${checkpoint.kind}`,
        severity: 'major',
        evidenceLines: checkpoint.evidence.map((excerpt, evidenceIndex) => ({
          line: evidenceIndex + 1,
          excerpt,
        })),
        suggestedChecks: [
          'rerun with a successful action certificate outcome closure',
          'keep approval, assumptions, and externalities next to the dispatch',
        ],
      });
      if (checkpoint.evidence.length === 0) {
        warnings.push(`action-certificate ${checkpoint.kind}: failed checkpoint lacks evidence`);
      }
      if (index === 0 && packet.outcome.status === 'failed') {
        warnings.push(
          `action-certificate outcome failed with rc=${String(packet.outcome.exitCode)}`,
        );
      }
    });
  return { signals, warnings };
};

export const mapTaskContextDigest = (packet: TaskContextDigest): WeaknessSignalMapping => {
  const signals: WeaknessSignal[] = [];
  const warnings: string[] = [];
  if (packet.omitted.units > 0) {
    appendSignal(signals, warnings, 'task-context-digest omitted-trace', {
      sourceRef: packet.sourceRef,
      sourceSha256: packet.sourceSha256,
      kind: 'context-digest-omitted-trace',
      surfaceHint: 'context-selection',
      cause: `task digest omitted ${String(packet.omitted.units)} context units`,
      severity: 'minor',
      evidenceLines: [
        {
          line: 1,
          excerpt: `omitted=${String(packet.omitted.units)} units/${String(
            packet.omitted.chars,
          )} chars`,
        },
      ],
      suggestedChecks: [
        'increase digest budget or split the TASK before redispatch',
        'verify omitted trace is not part of the active acceptance contract',
      ],
    });
  } else {
    warnings.push('task-context-digest: no omitted trace weakness detected');
  }
  return { signals, warnings };
};

const schemaMapper =
  <T>(schemaVersion: string, mapper: (packet: T) => WeaknessSignalMapping): PacketMapper =>
  (packet) =>
    hasSchemaVersion(packet, schemaVersion) ? mapper(packet as T) : undefined;

const isTaskHandoffPacket = (packet: unknown): packet is TaskHandoffPacket =>
  isRecord(packet) &&
  isString(packet.taskId) &&
  isString(packet.sourceRef) &&
  Array.isArray(packet.issues) &&
  Array.isArray(packet.evidence);

const PACKET_MAPPERS: readonly PacketMapper[] = [
  schemaMapper<RuntimeGuardPacket>('fugunano.runtime-guard.v1', mapRuntimeGuardPacket),
  schemaMapper<ReviewPacket>('fugunano.review-packet.v1', mapReviewPacket),
  schemaMapper<IncidentPacket>('fugunano.incident-packet.v1', mapIncidentPacket),
  schemaMapper<IncidentRecoveryPacket>('fugunano.incident-recovery.v1', mapIncidentRecoveryPacket),
  schemaMapper<ActionCertificate>('fugunano.action-certificate.v1', mapActionCertificate),
  schemaMapper<TaskContextDigest>('fugunano.task-context-digest.v1', mapTaskContextDigest),
  (packet) => (isTaskHandoffPacket(packet) ? mapTaskHandoffPacket(packet) : undefined),
];

export const packetWeaknessSignals = (packet: unknown): WeaknessSignalMapping => {
  for (const mapper of PACKET_MAPPERS) {
    const mapped = mapper(packet);
    if (mapped !== undefined) return mapped;
  }
  return {
    signals: [],
    warnings: ['unknown packet shape: no evolution evidence mapper matched'],
  };
};

export const packetsWeaknessSignals = (packets: readonly unknown[]): WeaknessSignalMapping => {
  const mapped = packets.map(packetWeaknessSignals);
  return {
    signals: mapped.flatMap((item) => item.signals),
    warnings: mapped.flatMap((item) => item.warnings),
  };
};
