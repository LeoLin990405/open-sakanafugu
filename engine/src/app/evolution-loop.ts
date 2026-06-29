import { createHash } from 'node:crypto';

import type {
  EvidenceRef,
  EvolvableSurface,
  EvolutionFitness,
  EvolutionLineageEntry,
  EvolutionPromoter,
  JsonValue,
} from '../domain/evolution-lineage.js';
import { packetsWeaknessSignals } from '../domain/evolution-evidence.js';
import type { WeaknessSignal } from '../domain/evolution-evidence.js';
import { scoreRubric } from '../domain/evolution-rubric.js';
import type { ReviewRubricSplitCases, RubricEvaluator } from '../domain/evolution-rubric.js';
import type { Result } from '../domain/result.js';
import { err, ok } from '../domain/result.js';
import type { ReviewVerdict } from '../domain/review-packet.js';
import type { RuntimeGuardDisposition } from '../domain/runtime-guard.js';
import { runtimeGuardPacket } from '../domain/runtime-guard.js';
import { acceptEdit } from '../domain/self-harness-accept.js';
import type { SplitScores, ValidationVerdict } from '../domain/self-harness.js';

export interface EvolutionCandidate {
  readonly id: string;
  readonly surface: EvolvableSurface;
  readonly before: string;
  readonly after: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly validationSpecSnapshot?: JsonValue;
  readonly rollbackHint?: string;
  readonly supersedes?: readonly string[];
}

export interface GuardRuleCase {
  readonly id: string;
  readonly prompt: string;
  readonly expected: RuntimeGuardDisposition;
}

export interface GuardRuleSplitCases {
  readonly heldIn: readonly GuardRuleCase[];
  readonly heldOut: readonly GuardRuleCase[];
}

export interface EvolutionValidationCases {
  readonly guardRule?: GuardRuleSplitCases;
  readonly reviewRubric?: ReviewRubricSplitCases;
}

export interface EvolutionCandidateProposer {
  propose(signals: readonly WeaknessSignal[], k: number): Promise<readonly EvolutionCandidate[]>;
}

export interface EvolutionLineageWriterError {
  readonly detail: string;
}

export interface EvolutionLineageWriter {
  put(entry: EvolutionLineageEntry): Promise<Result<void, EvolutionLineageWriterError>>;
}

export interface EvolutionLoopDeps {
  readonly proposer: EvolutionCandidateProposer;
  readonly lineageStore: EvolutionLineageWriter;
  readonly cases: EvolutionValidationCases;
  readonly promotedBy: EvolutionPromoter;
  readonly k: number;
  /** Review-rubric repeated sampling; default 3 so noisy one-offs don't promote/reject alone. */
  readonly samples?: number;
  readonly rubricEvaluator?: RubricEvaluator;
  readonly hash?: (content: string) => string;
}

export type EvolutionDecision = 'promoted' | 'rejected' | 'blocked';

export interface EvolutionCandidateResult {
  readonly candidateId: string;
  readonly surface: EvolvableSurface;
  readonly decision: EvolutionDecision;
  readonly verdict?: ValidationVerdict;
  readonly fitness?: EvolutionFitness;
  readonly lineage?: EvolutionLineageEntry;
  readonly error?: string;
}

export interface EvolutionLoopResult {
  readonly signals: readonly WeaknessSignal[];
  readonly warnings: readonly string[];
  readonly candidates: readonly EvolutionCandidateResult[];
}

interface CandidateValidation {
  readonly current: SplitScores;
  readonly candidate: SplitScores;
  readonly verdict: ValidationVerdict;
  readonly fitness: EvolutionFitness;
  readonly validationSpecSnapshot: JsonValue;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const regexFromRule = (rule: string, label: string): Result<RegExp, string> => {
  const match = /^privileged-action-regex:\s*(.+)$/mu.exec(rule);
  const pattern = match?.[1];
  if (pattern === undefined || pattern.trim().length === 0) {
    return err(`${label} must contain 'privileged-action-regex: <pattern>'`);
  }
  try {
    return ok(new RegExp(pattern, 'iu'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`${label} has an invalid regular expression: ${message}`);
  }
};

const hasActionCertificate = (prompt: string): boolean =>
  /--certificate\b/iu.test(prompt) ||
  /\bcertificate\s+(?:attached|enabled|required|path|sidecar)\b/iu.test(prompt);

const dispositionWithRule = (prompt: string, rule: RegExp): RuntimeGuardDisposition => {
  const packet = runtimeGuardPacket(prompt, {
    sourceRef: 'evolution-loop',
    sourceSha256: sha256(prompt),
  });
  if (packet.disposition !== 'allow') return packet.disposition;
  return rule.test(prompt) && !hasActionCertificate(prompt) ? 'review' : 'allow';
};

const scoreGuardCases = (
  cases: readonly GuardRuleCase[],
  rule: RegExp,
): { readonly pass: number; readonly total: number } => ({
  pass: cases.filter((item) => dispositionWithRule(item.prompt, rule) === item.expected).length,
  total: cases.length,
});

const guardScores = (cases: GuardRuleSplitCases, ruleText: string): Result<SplitScores, string> => {
  const rule = regexFromRule(ruleText, 'guard-rule');
  if (!rule.ok) return rule;
  const heldIn = scoreGuardCases(cases.heldIn, rule.value);
  const heldOut = scoreGuardCases(cases.heldOut, rule.value);
  return ok({
    inPass: heldIn.pass,
    inTotal: heldIn.total,
    outPass: heldOut.pass,
    outTotal: heldOut.total,
  });
};

export const deterministicEvolutionRubricEvaluator: RubricEvaluator = (
  rubric,
  testCase,
): ReviewVerdict => {
  const ruleText = rubric.toLowerCase();
  const caseText = `${testCase.diff}\n${testCase.context}`.toLowerCase();
  if (ruleText.includes('needs-fix-all')) return 'NEEDS_FIX';
  if (ruleText.includes('accept-all')) return 'ACCEPTED';
  if (
    /\b(?:security|strict|injection|secret|credential|trust)\b/u.test(ruleText) &&
    /\b(?:security|injection|secret|credential|trust|permission)\b/u.test(caseText)
  ) {
    return 'NEEDS_FIX';
  }
  if (
    /\b(?:correctness|bug|regression|failure|fail)\b/u.test(ruleText) &&
    /\b(?:bug|regression|broken|incorrect|fail|failure)\b/u.test(caseText)
  ) {
    return 'NEEDS_FIX';
  }
  if (
    /\b(?:docs|documentation|readme|safe|accept-safe)\b/u.test(ruleText) &&
    /\b(?:docs|documentation|readme|typo|safe|local)\b/u.test(caseText)
  ) {
    return 'ACCEPTED';
  }
  return 'UNKNOWN';
};

const toFitness = (
  candidate: SplitScores,
  verdict: ValidationVerdict,
  cost: JsonValue,
): EvolutionFitness => ({
  heldIn: { pass: candidate.inPass, total: candidate.inTotal, delta: verdict.deltaIn },
  heldOut: { pass: candidate.outPass, total: candidate.outTotal, delta: verdict.deltaOut },
  regressions:
    (verdict.deltaIn < 0 ? -verdict.deltaIn : 0) + (verdict.deltaOut < 0 ? -verdict.deltaOut : 0),
  cost,
});

const guardSnapshot = (cases: GuardRuleSplitCases): JsonValue => ({
  kind: 'guard-rule',
  heldIn: cases.heldIn.map((item) => item.id),
  heldOut: cases.heldOut.map((item) => item.id),
});

const reviewSnapshot = (cases: ReviewRubricSplitCases): JsonValue => ({
  kind: 'review-rubric',
  heldIn: cases.heldIn.map((_item, index) => `heldIn-${String(index + 1)}`),
  heldOut: cases.heldOut.map((_item, index) => `heldOut-${String(index + 1)}`),
});

const validateCandidate = (
  candidate: EvolutionCandidate,
  cases: EvolutionValidationCases,
  samples: number,
  evaluator: RubricEvaluator,
): Result<CandidateValidation, string> => {
  if (candidate.surface === 'guard-rule') {
    if (cases.guardRule === undefined) return err('missing guard-rule validation cases');
    const current = guardScores(cases.guardRule, candidate.before);
    if (!current.ok) return current;
    const next = guardScores(cases.guardRule, candidate.after);
    if (!next.ok) return next;
    const verdict = acceptEdit(current.value, next.value);
    const snapshot = candidate.validationSpecSnapshot ?? guardSnapshot(cases.guardRule);
    return ok({
      current: current.value,
      candidate: next.value,
      verdict,
      fitness: toFitness(next.value, verdict, {
        evaluator: 'runtimeGuardPacket+privileged-action-regex',
        samples: cases.guardRule.heldIn.length + cases.guardRule.heldOut.length,
      }),
      validationSpecSnapshot: snapshot,
    });
  }

  if (cases.reviewRubric === undefined) return err('missing review-rubric validation cases');
  if (samples < 3) return err('review-rubric validation requires samples >= 3');
  const current = scoreRubric(evaluator, candidate.before, cases.reviewRubric, samples);
  const next = scoreRubric(evaluator, candidate.after, cases.reviewRubric, samples);
  const verdict = acceptEdit(current, next);
  const snapshot = candidate.validationSpecSnapshot ?? reviewSnapshot(cases.reviewRubric);
  return ok({
    current,
    candidate: next,
    verdict,
    fitness: toFitness(next, verdict, {
      evaluator: 'rubric-evaluator',
      samples,
    }),
    validationSpecSnapshot: snapshot,
  });
};

const slug = (value: string): string => {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return cleaned.length === 0 ? 'candidate' : cleaned;
};

const lineageIdFor = (candidate: EvolutionCandidate): string =>
  candidate.id.startsWith('evo-')
    ? slug(candidate.id)
    : `evo-${candidate.surface}-${slug(candidate.id)}`;

const evidenceRefsFor = (
  candidate: EvolutionCandidate,
  signals: readonly WeaknessSignal[],
): readonly EvidenceRef[] =>
  candidate.evidenceRefs ??
  signals.map((signal) => ({
    sourceRef: signal.sourceRef,
    sourceSha256: signal.sourceSha256,
    kind: signal.kind,
  }));

export class EvolutionLoop {
  constructor(private readonly deps: EvolutionLoopDeps) {}

  async run(packets: readonly unknown[]): Promise<EvolutionLoopResult> {
    const mapped = packetsWeaknessSignals(packets);
    const proposals = await this.deps.proposer.propose(mapped.signals, this.deps.k);
    const samples = this.deps.samples ?? 3;
    const evaluator = this.deps.rubricEvaluator ?? deterministicEvolutionRubricEvaluator;
    const hash = this.deps.hash ?? sha256;
    const candidates: EvolutionCandidateResult[] = [];

    for (const proposal of proposals.slice(0, this.deps.k)) {
      const validation = validateCandidate(proposal, this.deps.cases, samples, evaluator);
      if (!validation.ok) {
        candidates.push({
          candidateId: proposal.id,
          surface: proposal.surface,
          decision: 'blocked',
          error: validation.error,
        });
        continue;
      }

      if (!validation.value.verdict.accepted) {
        candidates.push({
          candidateId: proposal.id,
          surface: proposal.surface,
          decision: 'rejected',
          verdict: validation.value.verdict,
          fitness: validation.value.fitness,
        });
        continue;
      }

      const entry: EvolutionLineageEntry = {
        id: lineageIdFor(proposal),
        surface: proposal.surface,
        candidateId: proposal.id,
        evidenceRefs: evidenceRefsFor(proposal, mapped.signals),
        beforeContent: proposal.before,
        afterSha256: hash(proposal.after),
        validationSpecSnapshot: validation.value.validationSpecSnapshot,
        fitness: validation.value.fitness,
        promotedBy: this.deps.promotedBy,
        rollbackHint:
          proposal.rollbackHint ?? `restore beforeContent into the ${proposal.surface} surface`,
        ...(proposal.supersedes === undefined ? {} : { supersedes: proposal.supersedes }),
      };
      const saved = await this.deps.lineageStore.put(entry);
      if (!saved.ok) {
        candidates.push({
          candidateId: proposal.id,
          surface: proposal.surface,
          decision: 'blocked',
          verdict: validation.value.verdict,
          fitness: validation.value.fitness,
          error: saved.error.detail,
        });
        continue;
      }
      candidates.push({
        candidateId: proposal.id,
        surface: proposal.surface,
        decision: 'promoted',
        verdict: validation.value.verdict,
        fitness: validation.value.fitness,
        lineage: entry,
      });
    }

    return { signals: mapped.signals, warnings: mapped.warnings, candidates };
  }
}
