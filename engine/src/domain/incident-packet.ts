import type { FailureCause } from './experience.js';

export const INCIDENT_PACKET_SCHEMA_VERSION = 'fugunano.incident-packet.v1' as const;

export const INCIDENT_KINDS = [
  'review-needs-fix',
  'verification-failure',
  'build-failure',
  'integration-conflict',
  'runtime-failure',
  'tooling-error',
  'missing-output',
  'context-provenance',
  'planning-error',
  'policy-violation',
] as const;

export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export type IncidentSeverity = 'critical' | 'major' | 'minor' | 'unknown';

export const INCIDENT_MAST_CATEGORIES = [
  'system-design',
  'inter-agent-misalignment',
  'task-verification',
  'unknown',
] as const;

export type IncidentMastCategory = (typeof INCIDENT_MAST_CATEGORIES)[number];

export const INCIDENT_HARNESS_LAYERS = [
  'environment',
  'tools',
  'context',
  'lifecycle',
  'observability',
  'verification',
  'governance',
  'unknown',
] as const;

export type IncidentHarnessLayer = (typeof INCIDENT_HARNESS_LAYERS)[number];

export interface IncidentEvidence {
  readonly line: number;
  readonly excerpt: string;
}

export interface IncidentRecord {
  readonly id: string;
  readonly kind: IncidentKind;
  readonly severity: IncidentSeverity;
  readonly failureCause: FailureCause;
  readonly mastCategory: IncidentMastCategory;
  readonly harnessLayer: IncidentHarnessLayer;
  readonly summary: string;
  readonly evidence: readonly IncidentEvidence[];
  readonly recommendedChecks: readonly string[];
}

export interface IncidentPacketIssue {
  readonly kind: 'no-incident-detected' | 'incident-without-evidence';
  readonly detail: string;
}

export interface IncidentPacket {
  readonly schemaVersion: typeof INCIDENT_PACKET_SCHEMA_VERSION;
  readonly sourceRef: string;
  readonly sourceSha256: string;
  readonly sourceChars: number;
  readonly incidentCount: number;
  readonly incidents: readonly IncidentRecord[];
  readonly issues: readonly IncidentPacketIssue[];
}

export interface IncidentPacketOptions {
  readonly sourceRef: string;
  readonly sourceSha256: string;
}

export const INCIDENT_RECOVERY_PACKET_SCHEMA_VERSION = 'fugunano.incident-recovery.v1' as const;

export type IncidentRecoveryPhase = 'containment' | 'repair' | 'validation' | 'learning';

export type IncidentRecoveryScope = 'agent' | 'operator' | 'harness';

export type IncidentRecoveryDisposition = 'ready' | 'blocked';

export interface IncidentRecoveryGate {
  readonly disposition: IncidentRecoveryDisposition;
  readonly reasons: readonly string[];
}

export interface IncidentRecoveryStep {
  readonly id: string;
  readonly phase: IncidentRecoveryPhase;
  readonly scope: IncidentRecoveryScope;
  readonly failureCause: FailureCause;
  readonly action: string;
  readonly rationale: string;
  readonly evidenceIncidentIds: readonly string[];
  readonly checks: readonly string[];
}

export interface IncidentRecoveryIssue {
  readonly kind: 'no-incident-evidence' | 'incident-without-evidence';
  readonly detail: string;
}

export interface IncidentRecoveryPacket {
  readonly schemaVersion: typeof INCIDENT_RECOVERY_PACKET_SCHEMA_VERSION;
  readonly sourceRef: string;
  readonly sourceSha256: string;
  readonly sourceChars: number;
  readonly incidentCount: number;
  readonly guidanceGate: IncidentRecoveryGate;
  readonly stepCount: number;
  readonly steps: readonly IncidentRecoveryStep[];
  readonly issues: readonly IncidentRecoveryIssue[];
}

interface IncidentSpec {
  readonly kind: IncidentKind;
  readonly severity: IncidentSeverity;
  readonly failureCause: FailureCause;
  readonly mastCategory: IncidentMastCategory;
  readonly harnessLayer: IncidentHarnessLayer;
  readonly summary: string;
  readonly patterns: readonly RegExp[];
}

const MAX_EVIDENCE_PER_INCIDENT = 3;
const MAX_EXCERPT_CHARS = 180;

const REVIEW_NEEDS_FIX_RE = /\bVERDICT\s*:\s*(?:NEEDS[\s_-]*FIX|NEEDSFIX)\b/iu;
const VERIFICATION_FAILURE_RE =
  /\b(?:FAIL|FAILED|failed)\b.*\b(?:test|tests|spec|vitest|pytest|assertion)\b|\bAssertionError\b|\bexpected\b.{0,80}\b(?:received|to\s+(?:be|equal|contain|match))\b|\bTests?\s*:\s*[1-9]\d*\s+failed\b|\bcheck\b.{0,80}\bfailed\b/iu;
const BUILD_FAILURE_RE =
  /\bTS\d{4}\b|\b(?:TypeError|ReferenceError|SyntaxError)\b|\b(?:typecheck|tsc|eslint|prettier|build|compile|compilation)\b.{0,80}\b(?:failed|error|errors)\b|\b(?:failed|error|errors)\b.{0,80}\b(?:typecheck|tsc|eslint|prettier|build|compile|compilation)\b/iu;
const INTEGRATION_CONFLICT_RE =
  /\b(?:CONFLICT|merge conflict|integration conflict|ownership violation|cherry-pick\b.{0,80}\b(?:failed|abort)|worktree\b.{0,80}\bdirty)\b/iu;
const RUNTIME_FAILURE_RE =
  /\b(?:timed out|timeout|ETIMEDOUT|exit code 124|SIGTERM|SIGKILL|OOM|out of memory|process exited with code [1-9]\d*)\b/iu;
const TOOLING_ERROR_RE =
  /\b(?:spawn\b.{0,80}\bENOENT|command not found|ENOENT|EACCES|permission denied|No such file or directory|(?:cannot find module|module not found)|npm ERR!|ECONNRESET|EPIPE)\b/iu;
const MISSING_OUTPUT_RE =
  /\b(?:missing output|require-output|no output|artifact missing|did not write|output file\b.{0,80}\bmissing|expected artifact\b.{0,80}\bnot found)\b/iu;
const CONTEXT_PROVENANCE_RE =
  /\b(?:source-provenance|missing source|no source ref|without stable provenance|context overflow|omitted\b.{0,80}\bcontext|lost context|stale context|not enough context)\b/iu;
const PLANNING_ERROR_RE =
  /\b(?:requirement unclear|ambiguous requirement|wrong scope|out of scope|misunderstood|plan\b.{0,80}\bwrong|acceptance\b.{0,80}\bmissing)\b/iu;
const POLICY_VIOLATION_RE =
  /\b(?:runtime-guard:packet\b.{0,80}\bdisposition=BLOCK|disposition\s*[:=]\s*block|prompt-injection|secret-exfiltration|approval-missing|policy violation|blocked by guard|destructive action)\b/iu;

const SPECS: readonly IncidentSpec[] = [
  {
    kind: 'policy-violation',
    severity: 'critical',
    failureCause: 'policy',
    mastCategory: 'system-design',
    harnessLayer: 'governance',
    summary: 'runtime or governance policy blocked the trajectory',
    patterns: [POLICY_VIOLATION_RE],
  },
  {
    kind: 'review-needs-fix',
    severity: 'major',
    failureCause: 'verification',
    mastCategory: 'task-verification',
    harnessLayer: 'verification',
    summary: 'independent review reported NEEDS FIX',
    patterns: [REVIEW_NEEDS_FIX_RE],
  },
  {
    kind: 'verification-failure',
    severity: 'major',
    failureCause: 'verification',
    mastCategory: 'task-verification',
    harnessLayer: 'verification',
    summary: 'tests or verification checks failed',
    patterns: [VERIFICATION_FAILURE_RE],
  },
  {
    kind: 'build-failure',
    severity: 'major',
    failureCause: 'implementation',
    mastCategory: 'task-verification',
    harnessLayer: 'verification',
    summary: 'build, typecheck, lint, or syntax failure detected',
    patterns: [BUILD_FAILURE_RE],
  },
  {
    kind: 'integration-conflict',
    severity: 'major',
    failureCause: 'integration',
    mastCategory: 'inter-agent-misalignment',
    harnessLayer: 'lifecycle',
    summary: 'integration, ownership, or worktree conflict detected',
    patterns: [INTEGRATION_CONFLICT_RE],
  },
  {
    kind: 'runtime-failure',
    severity: 'major',
    failureCause: 'runtime',
    mastCategory: 'system-design',
    harnessLayer: 'environment',
    summary: 'runtime process failed, timed out, or was killed',
    patterns: [RUNTIME_FAILURE_RE],
  },
  {
    kind: 'tooling-error',
    severity: 'major',
    failureCause: 'tooling',
    mastCategory: 'system-design',
    harnessLayer: 'tools',
    summary: 'tooling, binary, path, permission, or dependency error detected',
    patterns: [TOOLING_ERROR_RE],
  },
  {
    kind: 'missing-output',
    severity: 'major',
    failureCause: 'integration',
    mastCategory: 'system-design',
    harnessLayer: 'observability',
    summary: 'expected artifact or model output was missing',
    patterns: [MISSING_OUTPUT_RE],
  },
  {
    kind: 'context-provenance',
    severity: 'major',
    failureCause: 'context',
    mastCategory: 'system-design',
    harnessLayer: 'context',
    summary: 'context, source provenance, or trace freshness problem detected',
    patterns: [CONTEXT_PROVENANCE_RE],
  },
  {
    kind: 'planning-error',
    severity: 'minor',
    failureCause: 'planning',
    mastCategory: 'system-design',
    harnessLayer: 'lifecycle',
    summary: 'planning or acceptance-contract problem detected',
    patterns: [PLANNING_ERROR_RE],
  },
];

const redactExcerpt = (line: string): string =>
  line
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/[A-Za-z0-9_-]{24,}/gu, '<redacted-token>')
    .slice(0, MAX_EXCERPT_CHARS);

const evidenceFor = (
  lines: readonly string[],
  patterns: readonly RegExp[],
): readonly IncidentEvidence[] => {
  const evidence: IncidentEvidence[] = [];
  for (const [index, line] of lines.entries()) {
    if (!patterns.some((pattern) => pattern.test(line))) continue;
    evidence.push({ line: index + 1, excerpt: redactExcerpt(line) });
    if (evidence.length >= MAX_EVIDENCE_PER_INCIDENT) break;
  }
  return evidence;
};

const recommendedChecksFor = (
  kind: IncidentKind,
  failureCause: FailureCause,
): readonly string[] => {
  switch (failureCause) {
    case 'planning':
      return [
        'rewrite the task contract with explicit acceptance checks',
        'run fuguectl task handoff before redispatch',
      ];
    case 'context':
    case 'retrieval':
      return [
        'regenerate a bounded task digest before redispatch',
        'attach stable source refs for external evidence',
      ];
    case 'tooling':
      return [
        'run fuguectl preflight for the affected runtime',
        'capture tool versions, binary paths, and permissions before retrying',
      ];
    case 'implementation':
      return [
        'fix the smallest implicated code path',
        'run npm run check and add a focused regression test',
      ];
    case 'verification':
      return [
        'rerun the exact failing check locally',
        'turn the failure into a regression test or review packet before re-review',
      ];
    case 'integration':
      return [
        'inspect ownership boundaries and the integrated diff',
        'rerun integration after resolving conflicts or missing artifacts',
      ];
    case 'runtime':
      return [
        'rerun with a captured artifact and explicit timeout',
        'separate nondeterministic runtime failure from deterministic test failure',
      ];
    case 'policy':
      return [
        'run fuguectl guard prompt on the next dispatch prompt',
        kind === 'policy-violation'
          ? 'add approval or an action certificate before privileged runtime actions'
          : 'record the policy decision next to the TASK',
      ];
    case 'other':
      return ['capture more line evidence before relabeling this failure'];
  }
};

const packetIssues = (incidents: readonly IncidentRecord[]): readonly IncidentPacketIssue[] => {
  if (incidents.length === 0) {
    return [
      {
        kind: 'no-incident-detected',
        detail: 'input did not match any known incident pattern',
      },
    ];
  }
  return incidents
    .filter((incident) => incident.evidence.length === 0)
    .map((incident) => ({
      kind: 'incident-without-evidence' as const,
      detail: `${incident.id} has no line evidence`,
    }));
};

export const incidentPacket = (content: string, options: IncidentPacketOptions): IncidentPacket => {
  const lines = content.split(/\r?\n/u);
  const incidents = SPECS.flatMap((spec): readonly IncidentRecord[] => {
    const evidence = evidenceFor(lines, spec.patterns);
    if (evidence.length === 0) return [];
    return [
      {
        id: '',
        kind: spec.kind,
        severity: spec.severity,
        failureCause: spec.failureCause,
        mastCategory: spec.mastCategory,
        harnessLayer: spec.harnessLayer,
        summary: spec.summary,
        evidence,
        recommendedChecks: recommendedChecksFor(spec.kind, spec.failureCause),
      },
    ];
  }).map((incident, index) => ({
    ...incident,
    id: `I${String(index + 1)}`,
  }));

  return {
    schemaVersion: INCIDENT_PACKET_SCHEMA_VERSION,
    sourceRef: options.sourceRef,
    sourceSha256: options.sourceSha256,
    sourceChars: content.length,
    incidentCount: incidents.length,
    incidents,
    issues: packetIssues(incidents),
  };
};

const evidenceText = (evidence: readonly IncidentEvidence[]): string =>
  evidence.length === 0
    ? 'no-line'
    : evidence
        .map((item) => `line ${String(item.line)} ${JSON.stringify(item.excerpt)}`)
        .join('; ');

export const renderIncidentPacket = (packet: IncidentPacket): string => {
  const metadata = {
    schemaVersion: packet.schemaVersion,
    sourceRef: packet.sourceRef,
    sourceSha256: packet.sourceSha256,
    sourceChars: packet.sourceChars,
    incidentCount: packet.incidentCount,
  };
  const incidentLines =
    packet.incidents.length === 0
      ? ['- incident: (none)']
      : packet.incidents.flatMap((incident) => [
          `- ${incident.id} [${incident.severity}/${incident.failureCause}/${incident.kind}] MAST=${incident.mastCategory} layer=${incident.harnessLayer} ${evidenceText(
            incident.evidence,
          )} :: ${incident.summary}`,
          ...incident.recommendedChecks.map((check) => `  - check: ${check}`),
        ]);
  return [
    `[incident:packet] incidents=${String(packet.incidentCount)}`,
    `[incident:packet:meta] ${JSON.stringify(metadata)}`,
    '## Incidents',
    ...incidentLines,
    '## Issues',
    ...(packet.issues.length === 0
      ? ['- issue: (none)']
      : packet.issues.map((issue) => `- issue: ${issue.kind}: ${issue.detail}`)),
    '',
  ].join('\n');
};

interface CauseGroup {
  readonly failureCause: FailureCause;
  readonly incidents: readonly IncidentRecord[];
}

interface RecoveryTemplate {
  readonly containment: string;
  readonly containmentScope: IncidentRecoveryScope;
  readonly containmentRationale: string;
  readonly repair: string;
  readonly repairScope: IncidentRecoveryScope;
  readonly repairRationale: string;
}

const recoveryTemplateFor = (failureCause: FailureCause): RecoveryTemplate => {
  switch (failureCause) {
    case 'planning':
      return {
        containment: 'pause redispatch until the task contract has explicit acceptance checks',
        containmentScope: 'operator',
        containmentRationale:
          'planning failures repeat when the next attempt inherits the same ambiguous contract',
        repair: 'rewrite Requirements and acceptance criteria, then regenerate the handoff packet',
        repairScope: 'operator',
        repairRationale: 'a bounded task contract gives the next agent executable guidance',
      };
    case 'context':
    case 'retrieval':
      return {
        containment:
          'freeze the current prompt inputs and preserve source provenance before retrying',
        containmentScope: 'operator',
        containmentRationale:
          'context failures are not recoverable if the evidence source changes silently',
        repair: 'attach stable source refs and regenerate a bounded task digest',
        repairScope: 'operator',
        repairRationale:
          'source-bound context keeps the next attempt grounded without replaying stale trace',
      };
    case 'tooling':
      return {
        containment: 'stop retrying the same runtime until preflight and dependency checks pass',
        containmentScope: 'operator',
        containmentRationale: 'tooling failures usually persist across blind retries',
        repair:
          'fix the binary, path, permission, or dependency issue, or route to a healthy runtime',
        repairScope: 'operator',
        repairRationale:
          'the next agent attempt should not spend budget rediscovering broken local tools',
      };
    case 'implementation':
      return {
        containment: 'isolate the failing code path and avoid broad unrelated refactors',
        containmentScope: 'agent',
        containmentRationale:
          'implementation failures should be repaired at the smallest implicated surface',
        repair: 'patch the smallest implicated code path and add a regression test',
        repairScope: 'agent',
        repairRationale: 'small evidence-grounded patches are easier to validate and review',
      };
    case 'verification':
      return {
        containment:
          'treat the red check or reviewer verdict as the active gate for the next attempt',
        containmentScope: 'operator',
        containmentRationale:
          'verification failures need an objective gate before another subjective review',
        repair:
          'fix the behavior behind the failing check and keep the review finding as a checklist',
        repairScope: 'agent',
        repairRationale: 'turning the failure into a checklist narrows the repair loop',
      };
    case 'integration':
      return {
        containment:
          'hold the affected integration path until ownership and artifacts are inspected',
        containmentScope: 'operator',
        containmentRationale: 'integration failures can contaminate main if merged speculatively',
        repair:
          'resolve conflicts, missing artifacts, or ownership violations before rerunning integration',
        repairScope: 'operator',
        repairRationale: 'integration should resume only after the affected boundary is explicit',
      };
    case 'runtime':
      return {
        containment: 'capture runtime artifacts and timeout metadata before retrying',
        containmentScope: 'operator',
        containmentRationale:
          'runtime failures need observability before a retry can be distinguished from noise',
        repair: 'rerun with explicit timeout, smaller scope, or a healthier runtime target',
        repairScope: 'operator',
        repairRationale:
          'bounded runtime changes reduce wasted computation after the first warning',
      };
    case 'policy':
      return {
        containment:
          'block privileged action until the prompt has guard evidence and approval context',
        containmentScope: 'harness',
        containmentRationale: 'policy failures should be contained before tool execution resumes',
        repair:
          'separate trusted control from untrusted data and add approval or an action certificate',
        repairScope: 'harness',
        repairRationale:
          'governed recovery prevents the same incident from re-entering the runtime',
      };
    case 'other':
      return {
        containment: 'collect more evidence before issuing recovery guidance',
        containmentScope: 'operator',
        containmentRationale:
          'unclassified failures are too easy to overfit without more trace evidence',
        repair: 'add line evidence and relabel the incident with a more specific failure cause',
        repairScope: 'operator',
        repairRationale: 'specific relabeling makes future recovery guidance actionable',
      };
  }
};

const unique = (values: readonly string[]): readonly string[] => [...new Set(values)];

const causeGroups = (incidents: readonly IncidentRecord[]): readonly CauseGroup[] => {
  const groups: CauseGroup[] = [];
  for (const incident of incidents) {
    const existing = groups.find((group) => group.failureCause === incident.failureCause);
    if (existing === undefined) {
      groups.push({ failureCause: incident.failureCause, incidents: [incident] });
    } else {
      groups.splice(groups.indexOf(existing), 1, {
        failureCause: existing.failureCause,
        incidents: [...existing.incidents, incident],
      });
    }
  }
  return groups;
};

const recoveryChecksFor = (incidents: readonly IncidentRecord[]): readonly string[] =>
  unique([
    ...incidents.flatMap((incident) => incident.recommendedChecks),
    're-run the objective gate that exposed this incident',
    're-run independent review after the repair',
  ]);

const learningCheckFor = (failureCause: FailureCause): string =>
  `if reusable, record the relabeled lesson with --allow-failure --failure-cause ${failureCause}`;

const recoveryIssues = (packet: IncidentPacket): readonly IncidentRecoveryIssue[] => {
  if (packet.incidents.length === 0) {
    return [
      {
        kind: 'no-incident-evidence',
        detail: 'recovery guidance is blocked because no incident evidence was detected',
      },
    ];
  }
  return packet.incidents
    .filter((incident) => incident.evidence.length === 0)
    .map((incident) => ({
      kind: 'incident-without-evidence' as const,
      detail: `${incident.id} has no line evidence, so guidance is blocked`,
    }));
};

const recoveryGate = (issues: readonly IncidentRecoveryIssue[]): IncidentRecoveryGate =>
  issues.length === 0
    ? {
        disposition: 'ready',
        reasons: ['all recovery steps are grounded in incident line evidence'],
      }
    : {
        disposition: 'blocked',
        reasons: issues.map((issue) => issue.detail),
      };

export const incidentRecoveryPacket = (packet: IncidentPacket): IncidentRecoveryPacket => {
  const issues = recoveryIssues(packet);
  const guidanceGate = recoveryGate(issues);
  const steps =
    guidanceGate.disposition === 'blocked'
      ? []
      : causeGroups(packet.incidents)
          .flatMap((group): readonly Omit<IncidentRecoveryStep, 'id'>[] => {
            const template = recoveryTemplateFor(group.failureCause);
            const incidentIds = group.incidents.map((incident) => incident.id);
            return [
              {
                phase: 'containment',
                scope: template.containmentScope,
                failureCause: group.failureCause,
                action: template.containment,
                rationale: template.containmentRationale,
                evidenceIncidentIds: incidentIds,
                checks: ['preserve the current incident packet next to the TASK log'],
              },
              {
                phase: 'repair',
                scope: template.repairScope,
                failureCause: group.failureCause,
                action: template.repair,
                rationale: template.repairRationale,
                evidenceIncidentIds: incidentIds,
                checks: recoveryChecksFor(group.incidents),
              },
              {
                phase: 'validation',
                scope: 'operator',
                failureCause: group.failureCause,
                action: 'prove the repair with the objective gate before another broad attempt',
                rationale:
                  'diagnosis only becomes recovery when the next attempt can verify the change',
                evidenceIncidentIds: incidentIds,
                checks: recoveryChecksFor(group.incidents),
              },
              {
                phase: 'learning',
                scope: 'operator',
                failureCause: group.failureCause,
                action: 'distill the reusable lesson only after validation passes',
                rationale: 'failed traces should enter memory as relabeled lessons, not raw logs',
                evidenceIncidentIds: incidentIds,
                checks: [learningCheckFor(group.failureCause)],
              },
            ];
          })
          .map((step, index) => ({
            ...step,
            id: `R${String(index + 1)}`,
          }));

  return {
    schemaVersion: INCIDENT_RECOVERY_PACKET_SCHEMA_VERSION,
    sourceRef: packet.sourceRef,
    sourceSha256: packet.sourceSha256,
    sourceChars: packet.sourceChars,
    incidentCount: packet.incidentCount,
    guidanceGate,
    stepCount: steps.length,
    steps,
    issues,
  };
};

const stepEvidenceText = (ids: readonly string[]): string =>
  ids.length === 0 ? 'incidents=(none)' : `incidents=${ids.join(',')}`;

export const renderIncidentRecoveryPacket = (packet: IncidentRecoveryPacket): string => {
  const metadata = {
    schemaVersion: packet.schemaVersion,
    sourceRef: packet.sourceRef,
    sourceSha256: packet.sourceSha256,
    sourceChars: packet.sourceChars,
    incidentCount: packet.incidentCount,
    disposition: packet.guidanceGate.disposition,
    stepCount: packet.stepCount,
  };
  const stepLines =
    packet.steps.length === 0
      ? ['- step: (none)']
      : packet.steps.flatMap((step) => [
          `- ${step.id} [${step.phase}/${step.scope}/${step.failureCause}] ${stepEvidenceText(
            step.evidenceIncidentIds,
          )} :: ${step.action}`,
          `  - rationale: ${step.rationale}`,
          ...step.checks.map((check) => `  - check: ${check}`),
        ]);
  return [
    `[incident:recovery] disposition=${packet.guidanceGate.disposition.toUpperCase()} steps=${String(
      packet.stepCount,
    )}`,
    `[incident:recovery:meta] ${JSON.stringify(metadata)}`,
    '## Guidance Gate',
    ...packet.guidanceGate.reasons.map(
      (reason) => `- ${packet.guidanceGate.disposition}: ${reason}`,
    ),
    '## Recovery Steps',
    ...stepLines,
    '## Issues',
    ...(packet.issues.length === 0
      ? ['- issue: (none)']
      : packet.issues.map((issue) => `- issue: ${issue.kind}: ${issue.detail}`)),
    '',
  ].join('\n');
};
