import type { GateCheck, GateResult } from './gate.js';

export const RUNTIME_GUARD_SCHEMA_VERSION = 'fugunano.runtime-guard.v1' as const;

export const RUNTIME_GUARD_FINDING_KINDS = [
  'prompt-injection',
  'untrusted-input',
  'untrusted-input-controls-action',
  'destructive-action',
  'privileged-action-without-certificate',
  'approval-missing',
  'secret-exfiltration',
  'source-provenance',
] as const;

export type RuntimeGuardFindingKind = (typeof RUNTIME_GUARD_FINDING_KINDS)[number];

export type RuntimeGuardSeverity = 'critical' | 'major' | 'minor';

export type RuntimeGuardDisposition = 'allow' | 'review' | 'block';

export interface RuntimeGuardEvidence {
  readonly line: number;
  readonly excerpt: string;
}

export interface RuntimeGuardFinding {
  readonly id: string;
  readonly kind: RuntimeGuardFindingKind;
  readonly severity: RuntimeGuardSeverity;
  readonly summary: string;
  readonly evidence: readonly RuntimeGuardEvidence[];
  readonly recommendedChecks: readonly string[];
}

export interface RuntimeGuardPacket {
  readonly schemaVersion: typeof RUNTIME_GUARD_SCHEMA_VERSION;
  readonly disposition: RuntimeGuardDisposition;
  readonly sourceRef: string;
  readonly sourceSha256: string;
  readonly sourceChars: number;
  readonly findingCount: number;
  readonly findings: readonly RuntimeGuardFinding[];
}

export interface RuntimeGuardOptions {
  readonly sourceRef: string;
  readonly sourceSha256: string;
  readonly sourceRefIsExternal?: boolean;
}

interface Candidate {
  readonly kind: RuntimeGuardFindingKind;
  readonly severity: RuntimeGuardSeverity;
  readonly summary: string;
  readonly evidence: readonly RuntimeGuardEvidence[];
  readonly recommendedChecks: readonly string[];
}

const PROMPT_INJECTION_RE =
  /\b(?:ignore|override|bypass|forget)\s+(?:all\s+)?(?:(?:previous|prior|above)(?:\s+(?:system|developer))?|system|developer)\s+instructions\b|\breveal\s+(?:the\s+)?system\s+prompt\b|\bdeveloper\s+mode\b|\bdo\s+not\s+(?:tell|notify)\s+(?:the\s+)?user\b/iu;
const UNTRUSTED_INPUT_RE =
  /\b(?:untrusted|external|third[-\s]?party|webpage|browser|email|inbox|issue|pull request|comment|ticket|pasted|downloaded|scraped|user[-\s]?provided)\b/iu;
const CONTROL_SEPARATION_RE =
  /\b(?:treat\s+(?:external|untrusted|retrieved|pasted)\s+(?:content|data)\s+as\s+data|do\s+not\s+follow\s+instructions\s+from\s+(?:external|untrusted|retrieved|pasted)\s+(?:content|data)|trusted\s+(?:control|query)|untrusted\s+data\s+block|data\s+flow|control\s+flow|capability)\b/iu;
const DESTRUCTIVE_ACTION_RE =
  /\b(?:rm\s+-rf|git\s+reset\s+--hard|git\s+clean\s+-f|drop\s+database|truncate\s+table|delete\s+production|wipe\s+|destroy\s+|terraform\s+destroy|kubectl\s+delete)\b/iu;
const PRIVILEGED_ACTION_RE =
  /\b(?:git\s+push|npm\s+publish|pnpm\s+publish|yarn\s+npm\s+publish|docker\s+push|deploy\b|terraform\s+apply|kubectl\s+apply|aws\s+|gcloud\s+|az\s+|ssh\s+|scp\s+|curl\s+https?:\/\/|wget\s+https?:\/\/|curl\s+[^\n]*\|\s*(?:sh|bash)|wget\s+[^\n]*\|\s*(?:sh|bash))\b/iu;
const APPROVAL_RE =
  /\b(?:approved|approval|operator-reviewed|operator reviewed|human-reviewed|human reviewed|confirmed by operator|external-approval)\b/iu;
const CERTIFICATE_RE =
  /\b(?:--certificate|certificate\s+(?:attached|enabled|required|path|sidecar)|proof-carrying|proof carrying|runtime-enforced)\b/iu;
const SECRET_TERM = String.raw`(?:\b(?:api[-_\s]?key|access[-_\s]?token|secret|password|credential|private\s+key)\b|(?:^|[^\w.])\.env(?:\b|$))`;
const SECRET_RE = new RegExp(SECRET_TERM, 'iu');
const SECRET_EXFIL_RE = new RegExp(
  String.raw`\b(?:send|upload|post|curl|wget|exfiltrate|leak|print|paste)\b[\s\S]{0,80}${SECRET_TERM}|${SECRET_TERM}[\s\S]{0,80}\b(?:send|upload|post|curl|wget|exfiltrate|leak|print|paste)\b`,
  'iu',
);
const SOURCE_REF_RE =
  /\b(?:source-ref|source ref|source|reference|ref)\s*[:=]\s*(?:https?:\/\/|\/|[A-Za-z0-9_.@~+-]+\/)|https?:\/\/(?:arxiv\.org|github\.com)\b/iu;

const redactExcerpt = (line: string): string =>
  line
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/[A-Za-z0-9_-]{24,}/gu, '<redacted-token>')
    .slice(0, 160);

const evidenceFor = (
  lines: readonly string[],
  patterns: readonly RegExp[],
): readonly RuntimeGuardEvidence[] => {
  const evidence: RuntimeGuardEvidence[] = [];
  for (const [index, line] of lines.entries()) {
    if (!patterns.some((pattern) => pattern.test(line))) continue;
    evidence.push({ line: index + 1, excerpt: redactExcerpt(line) });
    if (evidence.length >= 3) break;
  }
  return evidence;
};

const hasSourceRef = (
  sourceRef: string,
  content: string,
  sourceRefIsExternal: boolean | undefined,
): boolean => {
  const ref = sourceRef.trim();
  if (sourceRefIsExternal === true && ref.length > 0) return true;
  return SOURCE_REF_RE.test(content);
};

const checksFor = (kind: RuntimeGuardFindingKind): readonly string[] => {
  switch (kind) {
    case 'prompt-injection':
      return [
        'isolate quoted/retrieved text from executable instructions',
        're-run with a trusted-control/untrusted-data split before dispatch',
      ];
    case 'untrusted-input':
      return [
        'add an explicit source ref for the external input',
        'state that external content is evidence only, not instructions',
      ];
    case 'untrusted-input-controls-action':
      return [
        'separate trusted control flow from untrusted data before dispatch',
        'require operator review before any privileged tool action',
      ];
    case 'destructive-action':
      return [
        'replace destructive actions with a dry-run or scoped alternative',
        'capture an operator-reviewed approval before dispatch',
      ];
    case 'privileged-action-without-certificate':
      return [
        'add dispatch --certificate for replay-ready action provenance',
        'record externalities and assumptions before executing the action',
      ];
    case 'approval-missing':
      return [
        'add an explicit approval class such as operator-reviewed',
        'keep the approval evidence next to the TASK or action certificate',
      ];
    case 'secret-exfiltration':
      return [
        'remove secret material from the prompt',
        'route only metadata or hashes across the trust boundary',
      ];
    case 'source-provenance':
      return [
        'add --source-ref or an inline URL/path for the external material',
        'keep the source stable enough for an independent reviewer to replay',
      ];
  }
};

const dispositionFor = (findings: readonly RuntimeGuardFinding[]): RuntimeGuardDisposition => {
  if (findings.some((finding) => finding.severity === 'critical')) return 'block';
  if (findings.some((finding) => finding.severity === 'major')) return 'review';
  return 'allow';
};

const makeFindings = (candidates: readonly Candidate[]): readonly RuntimeGuardFinding[] =>
  candidates.map((candidate, index) => ({
    id: `G${String(index + 1)}`,
    ...candidate,
  }));

export const runtimeGuardPacket = (
  content: string,
  options: RuntimeGuardOptions,
): RuntimeGuardPacket => {
  const lines = content.split(/\r?\n/u);
  const hasInjection = PROMPT_INJECTION_RE.test(content);
  const hasUntrusted = UNTRUSTED_INPUT_RE.test(content);
  const hasSeparation = CONTROL_SEPARATION_RE.test(content);
  const hasDestructive = DESTRUCTIVE_ACTION_RE.test(content);
  const hasApproval = APPROVAL_RE.test(content);
  const hasCertificate = CERTIFICATE_RE.test(content);
  const hasSecret = SECRET_RE.test(content);
  const hasSecretExfil = SECRET_EXFIL_RE.test(content);
  const hasPrivileged = PRIVILEGED_ACTION_RE.test(content) || hasDestructive || hasSecretExfil;
  const hasStableSource = hasSourceRef(options.sourceRef, content, options.sourceRefIsExternal);

  const candidates: Candidate[] = [];

  if (hasInjection) {
    candidates.push({
      kind: 'prompt-injection',
      severity: 'critical',
      summary: 'prompt contains instruction-override language commonly used in prompt injection',
      evidence: evidenceFor(lines, [PROMPT_INJECTION_RE]),
      recommendedChecks: checksFor('prompt-injection'),
    });
  }
  if (hasSecretExfil) {
    candidates.push({
      kind: 'secret-exfiltration',
      severity: 'critical',
      summary: 'prompt appears to combine secret material with an outbound disclosure action',
      evidence: evidenceFor(lines, [SECRET_EXFIL_RE, SECRET_RE]),
      recommendedChecks: checksFor('secret-exfiltration'),
    });
  } else if (hasSecret && /(?:external|webhook|upload|send|curl|post)/iu.test(content)) {
    candidates.push({
      kind: 'secret-exfiltration',
      severity: 'major',
      summary: 'prompt mentions secrets near an external or outbound action',
      evidence: evidenceFor(lines, [SECRET_RE]),
      recommendedChecks: checksFor('secret-exfiltration'),
    });
  }
  if (hasUntrusted && hasPrivileged && !hasSeparation) {
    candidates.push({
      kind: 'untrusted-input-controls-action',
      severity: 'critical',
      summary: 'untrusted/external content is mixed with privileged action instructions',
      evidence: evidenceFor(lines, [
        UNTRUSTED_INPUT_RE,
        PRIVILEGED_ACTION_RE,
        DESTRUCTIVE_ACTION_RE,
      ]),
      recommendedChecks: checksFor('untrusted-input-controls-action'),
    });
  } else if (hasUntrusted) {
    candidates.push({
      kind: 'untrusted-input',
      severity: hasStableSource && hasSeparation ? 'minor' : 'major',
      summary: hasStableSource
        ? 'prompt includes external input; keep it separated from control flow'
        : 'prompt includes external input without stable provenance',
      evidence: evidenceFor(lines, [UNTRUSTED_INPUT_RE]),
      recommendedChecks: checksFor('untrusted-input'),
    });
  }
  if (hasDestructive) {
    candidates.push({
      kind: 'destructive-action',
      severity: hasApproval ? 'major' : 'critical',
      summary: hasApproval
        ? 'prompt requests a destructive action; approval is present but still requires review'
        : 'prompt requests a destructive action without operator approval',
      evidence: evidenceFor(lines, [DESTRUCTIVE_ACTION_RE]),
      recommendedChecks: checksFor('destructive-action'),
    });
  }
  if (hasDestructive && !hasApproval) {
    candidates.push({
      kind: 'approval-missing',
      severity: 'critical',
      summary: 'destructive action lacks an explicit operator-reviewed approval marker',
      evidence: evidenceFor(lines, [DESTRUCTIVE_ACTION_RE]),
      recommendedChecks: checksFor('approval-missing'),
    });
  }
  if (hasPrivileged && !hasCertificate) {
    candidates.push({
      kind: 'privileged-action-without-certificate',
      severity: hasDestructive ? 'critical' : 'major',
      summary: 'privileged runtime action lacks an action certificate marker',
      evidence: evidenceFor(lines, [PRIVILEGED_ACTION_RE, DESTRUCTIVE_ACTION_RE]),
      recommendedChecks: checksFor('privileged-action-without-certificate'),
    });
  }
  if (
    (hasUntrusted || /(?:webpage|browser|email|downloaded|pasted)/iu.test(content)) &&
    !hasStableSource
  ) {
    candidates.push({
      kind: 'source-provenance',
      severity: 'major',
      summary: 'external material lacks a stable source reference',
      evidence: evidenceFor(lines, [UNTRUSTED_INPUT_RE]),
      recommendedChecks: checksFor('source-provenance'),
    });
  }

  const findings = makeFindings(candidates);
  return {
    schemaVersion: RUNTIME_GUARD_SCHEMA_VERSION,
    disposition: dispositionFor(findings),
    sourceRef: options.sourceRef,
    sourceSha256: options.sourceSha256,
    sourceChars: content.length,
    findingCount: findings.length,
    findings,
  };
};

export const runtimeGuardGate = (packet: RuntimeGuardPacket): GateResult => {
  if (packet.findings.length === 0) {
    return {
      checks: [{ name: 'runtime-guard', severity: 'ok', detail: 'no runtime guard findings' }],
    };
  }
  const checks: GateCheck[] = packet.findings.map((finding) => ({
    name: `runtime-guard:${finding.kind}`,
    severity: finding.severity === 'critical' ? 'fail' : 'warn',
    detail: finding.summary,
  }));
  return { checks };
};

const evidenceText = (evidence: readonly RuntimeGuardEvidence[]): string =>
  evidence.length === 0
    ? 'no-line'
    : evidence.map((item) => `line ${String(item.line)} "${item.excerpt}"`).join('; ');

export const renderRuntimeGuardPacket = (packet: RuntimeGuardPacket): string => {
  const lines = [
    `[runtime-guard:packet] disposition=${packet.disposition.toUpperCase()} findings=${String(
      packet.findingCount,
    )}`,
    `[runtime-guard:packet:meta] ${JSON.stringify({
      schemaVersion: packet.schemaVersion,
      disposition: packet.disposition,
      sourceRef: packet.sourceRef,
      sourceSha256: packet.sourceSha256,
      sourceChars: packet.sourceChars,
      findingCount: packet.findingCount,
    })}`,
    '## Findings',
  ];
  if (packet.findings.length === 0) {
    lines.push('- finding: (none)');
  } else {
    for (const finding of packet.findings) {
      lines.push(
        `- ${finding.id} [${finding.severity}/${finding.kind}] ${evidenceText(
          finding.evidence,
        )} :: ${finding.summary}`,
      );
      for (const check of finding.recommendedChecks) {
        lines.push(`  - check: ${check}`);
      }
    }
  }
  lines.push('## Gate');
  for (const check of runtimeGuardGate(packet).checks) {
    lines.push(`- ${check.severity}: ${check.name} :: ${check.detail ?? ''}`);
  }
  lines.push('');
  return lines.join('\n');
};
