import { createHash } from 'node:crypto';

import { Command, Option } from 'clipanion';

import { FsLineageStore } from '../../adapters/evolution/fs-lineage-store.js';
import type {
  EvidenceRef,
  EvolvableSurface,
  EvolutionFitness,
  EvolutionLineageEntry,
  EvolutionPromoter,
  JsonValue,
} from '../../domain/evolution-lineage.js';
import { packetWeaknessSignals } from '../../domain/evolution-evidence.js';
import type { WeaknessSignal } from '../../domain/evolution-evidence.js';
import { scoreRubric } from '../../domain/evolution-rubric.js';
import type {
  ReviewRubricCase,
  ReviewRubricSplitCases,
  RubricEvaluator,
} from '../../domain/evolution-rubric.js';
import type { Result } from '../../domain/result.js';
import { err, ok } from '../../domain/result.js';
import type { ReviewVerdict } from '../../domain/review-packet.js';
import type { RuntimeGuardDisposition } from '../../domain/runtime-guard.js';
import { runtimeGuardPacket } from '../../domain/runtime-guard.js';
import { acceptEdit } from '../../domain/self-harness-accept.js';
import type { SplitScores, ValidationVerdict } from '../../domain/self-harness.js';
import { NodeFileSystem } from '../../infra/node-file-system.js';

const WEAKNESSES_SCHEMA_VERSION = 'fugunano.evolve.weaknesses.v1' as const;
const FITNESS_SCHEMA_VERSION = 'fugunano.evolve.fitness.v1' as const;
const HISTORY_SCHEMA_VERSION = 'fugunano.evolve.history.v1' as const;

interface EvolveCandidate {
  readonly id: string;
  readonly surface: EvolvableSurface;
  readonly before: string;
  readonly after: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly validationSpecSnapshot?: JsonValue;
  readonly rollbackHint?: string;
  readonly supersedes?: readonly string[];
}

interface EvolveMineOutput {
  readonly schemaVersion: typeof WEAKNESSES_SCHEMA_VERSION;
  readonly signals: readonly WeaknessSignal[];
  readonly warnings: readonly string[];
}

interface EvolveFitnessFile {
  readonly schemaVersion: typeof FITNESS_SCHEMA_VERSION;
  readonly surface: EvolvableSurface;
  readonly candidateId: string;
  readonly current: SplitScores;
  readonly candidate: SplitScores;
  readonly verdict: ValidationVerdict;
  readonly fitness: EvolutionFitness;
  readonly validationSpecSnapshot: JsonValue;
}

interface GuardCase {
  readonly id: string;
  readonly prompt: string;
  readonly expected: RuntimeGuardDisposition;
}

interface GuardSplitCases {
  readonly heldIn: readonly GuardCase[];
  readonly heldOut: readonly GuardCase[];
}

const fs = (): NodeFileSystem => new NodeFileSystem();

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
};

const readJson = async (path: string): Promise<Result<unknown, string>> => {
  const text = await fs().read(path);
  if (text === null) return err(`no JSON file ${path}`);
  try {
    return ok(JSON.parse(text) as unknown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`invalid JSON in ${path}: ${message}`);
  }
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await fs().write(path, `${JSON.stringify(value, null, 2)}\n`);
};

const stringField = (
  record: Record<string, unknown>,
  key: string,
  options: { readonly allowEmpty?: boolean } = {},
): Result<string, string> => {
  const value = record[key];
  const allowEmpty = options.allowEmpty ?? false;
  if (typeof value !== 'string') return err(`${key} must be a string`);
  if (!allowEmpty && value.trim().length === 0) return err(`${key} must be a non-empty string`);
  return ok(value);
};

const isSurface = (value: string): value is EvolvableSurface =>
  value === 'guard-rule' || value === 'review-rubric';

const isPromoter = (value: string): value is EvolutionPromoter =>
  value === 'operator' || value === 'self-harness' || value === 'evolve';

const isDisposition = (value: string): value is RuntimeGuardDisposition =>
  value === 'allow' || value === 'review' || value === 'block';

const isReviewVerdict = (value: string): value is ReviewVerdict =>
  value === 'ACCEPTED' || value === 'NEEDS_FIX' || value === 'UNKNOWN';

const parseStringArray = (value: unknown, label: string): Result<readonly string[], string> => {
  if (!isUnknownArray(value)) return err(`${label} must be an array`);
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== 'string' || item.trim().length === 0) {
      return err(`${label}[${String(index)}] must be a non-empty string`);
    }
    items.push(item.trim());
  }
  return ok(items);
};

const integerField = (
  record: Record<string, unknown>,
  key: string,
  label: string,
  options: { readonly nonNegative?: boolean } = {},
): Result<number, string> => {
  const value = record[key];
  if (!Number.isInteger(value)) return err(`${label}.${key} must be an integer`);
  const parsed = value as number;
  if ((options.nonNegative ?? false) && parsed < 0) return err(`${label}.${key} must be >= 0`);
  return ok(parsed);
};

const parseEvidenceRefs = (value: unknown): Result<readonly EvidenceRef[], string> => {
  if (value === undefined) return ok([]);
  if (!isUnknownArray(value)) return err('evidenceRefs must be an array');
  const refs: EvidenceRef[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isRecord(item)) return err(`evidenceRefs[${String(index)}] must be an object`);
    const sourceRef = stringField(item, 'sourceRef');
    if (!sourceRef.ok) return err(`evidenceRefs[${String(index)}].${sourceRef.error}`);
    const sourceSha256 = stringField(item, 'sourceSha256');
    if (!sourceSha256.ok) return err(`evidenceRefs[${String(index)}].${sourceSha256.error}`);
    const kind = stringField(item, 'kind');
    if (!kind.ok) return err(`evidenceRefs[${String(index)}].${kind.error}`);
    refs.push({ sourceRef: sourceRef.value, sourceSha256: sourceSha256.value, kind: kind.value });
  }
  return ok(refs);
};

const parseCandidate = (value: unknown): Result<EvolveCandidate, string> => {
  if (!isRecord(value)) return err('candidate must be an object');
  const id = stringField(value, 'id');
  if (!id.ok) return id;
  const surface = stringField(value, 'surface');
  if (!surface.ok) return surface;
  if (!isSurface(surface.value)) return err('surface must be guard-rule or review-rubric');
  const before = stringField(value, 'before');
  if (!before.ok) return before;
  const after = stringField(value, 'after');
  if (!after.ok) return after;
  const evidenceRefs = parseEvidenceRefs(value.evidenceRefs);
  if (!evidenceRefs.ok) return evidenceRefs;
  const validationSpecSnapshot = value.validationSpecSnapshot;
  if (validationSpecSnapshot !== undefined && !isJsonValue(validationSpecSnapshot)) {
    return err('validationSpecSnapshot must be JSON-serializable');
  }
  const rollbackHint = value.rollbackHint;
  if (
    rollbackHint !== undefined &&
    (typeof rollbackHint !== 'string' || rollbackHint.length === 0)
  ) {
    return err('rollbackHint must be a non-empty string');
  }
  const supersedes = value.supersedes;
  if (supersedes !== undefined) {
    const parsed = parseStringArray(supersedes, 'supersedes');
    if (!parsed.ok) return parsed;
    return ok({
      id: id.value,
      surface: surface.value,
      before: before.value,
      after: after.value,
      evidenceRefs: evidenceRefs.value,
      ...(validationSpecSnapshot === undefined ? {} : { validationSpecSnapshot }),
      ...(rollbackHint === undefined ? {} : { rollbackHint }),
      supersedes: parsed.value,
    });
  }
  return ok({
    id: id.value,
    surface: surface.value,
    before: before.value,
    after: after.value,
    evidenceRefs: evidenceRefs.value,
    ...(validationSpecSnapshot === undefined ? {} : { validationSpecSnapshot }),
    ...(rollbackHint === undefined ? {} : { rollbackHint }),
  });
};

const parsePositiveInteger = (raw: string, label: string): Result<number, string> => {
  if (!/^\d+$/u.test(raw)) return err(`${label} must be a positive integer`);
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0
    ? ok(value)
    : err(`${label} must be a positive integer`);
};

const parseGuardCase = (value: unknown, label: string): Result<GuardCase, string> => {
  if (!isRecord(value)) return err(`${label} must be an object`);
  const id = stringField(value, 'id');
  if (!id.ok) return err(`${label}.${id.error}`);
  const prompt = stringField(value, 'prompt');
  if (!prompt.ok) return err(`${label}.${prompt.error}`);
  const expected = stringField(value, 'expected');
  if (!expected.ok) return err(`${label}.${expected.error}`);
  if (!isDisposition(expected.value)) {
    return err(`${label}.expected must be allow, review, or block`);
  }
  return ok({ id: id.value, prompt: prompt.value, expected: expected.value });
};

const parseReviewCase = (value: unknown, label: string): Result<ReviewRubricCase, string> => {
  if (!isRecord(value)) return err(`${label} must be an object`);
  const diff = stringField(value, 'diff', { allowEmpty: true });
  if (!diff.ok) return err(`${label}.${diff.error}`);
  const context = stringField(value, 'context', { allowEmpty: true });
  if (!context.ok) return err(`${label}.${context.error}`);
  const expected = stringField(value, 'expectedVerdict');
  if (!expected.ok) return err(`${label}.${expected.error}`);
  if (!isReviewVerdict(expected.value)) {
    return err(`${label}.expectedVerdict must be ACCEPTED, NEEDS_FIX, or UNKNOWN`);
  }
  return ok({ diff: diff.value, context: context.value, expectedVerdict: expected.value });
};

const parseSplit = <T>(
  value: unknown,
  label: string,
  parseItem: (item: unknown, itemLabel: string) => Result<T, string>,
): Result<readonly T[], string> => {
  if (!isUnknownArray(value)) return err(`${label} must be an array`);
  const parsed: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = parseItem(value[index], `${label}[${String(index)}]`);
    if (!item.ok) return item;
    parsed.push(item.value);
  }
  return ok(parsed);
};

const parseGuardCases = (value: unknown): Result<GuardSplitCases, string> => {
  if (!isRecord(value)) return err('cases must be an object');
  const heldIn = parseSplit(value.heldIn, 'heldIn', parseGuardCase);
  if (!heldIn.ok) return heldIn;
  const heldOut = parseSplit(value.heldOut, 'heldOut', parseGuardCase);
  if (!heldOut.ok) return heldOut;
  return ok({ heldIn: heldIn.value, heldOut: heldOut.value });
};

const parseReviewCases = (value: unknown): Result<ReviewRubricSplitCases, string> => {
  if (!isRecord(value)) return err('cases must be an object');
  const heldIn = parseSplit(value.heldIn, 'heldIn', parseReviewCase);
  if (!heldIn.ok) return heldIn;
  const heldOut = parseSplit(value.heldOut, 'heldOut', parseReviewCase);
  if (!heldOut.ok) return heldOut;
  return ok({ heldIn: heldIn.value, heldOut: heldOut.value });
};

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
    sourceRef: 'evolve-validate',
    sourceSha256: sha256(prompt),
  });
  if (packet.disposition !== 'allow') return packet.disposition;
  return rule.test(prompt) && !hasActionCertificate(prompt) ? 'review' : 'allow';
};

const scoreGuardCases = (
  cases: readonly GuardCase[],
  rule: RegExp,
): { readonly pass: number; readonly total: number } => ({
  pass: cases.filter((item) => dispositionWithRule(item.prompt, rule) === item.expected).length,
  total: cases.length,
});

const guardScores = (cases: GuardSplitCases, ruleText: string): Result<SplitScores, string> => {
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

const deterministicRubricEvaluator: RubricEvaluator = (rubric, testCase): ReviewVerdict => {
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

const guardSnapshot = (cases: GuardSplitCases): JsonValue => ({
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
  candidate: EvolveCandidate,
  cases: unknown,
  samples: number,
): Result<EvolveFitnessFile, string> => {
  if (candidate.surface === 'guard-rule') {
    const parsedCases = parseGuardCases(cases);
    if (!parsedCases.ok) return parsedCases;
    const current = guardScores(parsedCases.value, candidate.before);
    if (!current.ok) return current;
    const next = guardScores(parsedCases.value, candidate.after);
    if (!next.ok) return next;
    const verdict = acceptEdit(current.value, next.value);
    const snapshot = candidate.validationSpecSnapshot ?? guardSnapshot(parsedCases.value);
    return ok({
      schemaVersion: FITNESS_SCHEMA_VERSION,
      surface: candidate.surface,
      candidateId: candidate.id,
      current: current.value,
      candidate: next.value,
      verdict,
      fitness: toFitness(next.value, verdict, {
        evaluator: 'runtimeGuardPacket+privileged-action-regex',
        samples: parsedCases.value.heldIn.length + parsedCases.value.heldOut.length,
      }),
      validationSpecSnapshot: snapshot,
    });
  }

  const parsedCases = parseReviewCases(cases);
  if (!parsedCases.ok) return parsedCases;
  if (samples < 3) return err('review-rubric validation requires --samples >= 3');
  const current = scoreRubric(
    deterministicRubricEvaluator,
    candidate.before,
    parsedCases.value,
    samples,
  );
  const next = scoreRubric(
    deterministicRubricEvaluator,
    candidate.after,
    parsedCases.value,
    samples,
  );
  const verdict = acceptEdit(current, next);
  const snapshot = candidate.validationSpecSnapshot ?? reviewSnapshot(parsedCases.value);
  return ok({
    schemaVersion: FITNESS_SCHEMA_VERSION,
    surface: candidate.surface,
    candidateId: candidate.id,
    current,
    candidate: next,
    verdict,
    fitness: toFitness(next, verdict, {
      evaluator: 'deterministic-rule-evaluator',
      samples,
    }),
    validationSpecSnapshot: snapshot,
  });
};

const parseSplitScores = (value: unknown, label: string): Result<SplitScores, string> => {
  if (!isRecord(value)) return err(`${label} must be an object`);
  const inPass = integerField(value, 'inPass', label, { nonNegative: true });
  if (!inPass.ok) return inPass;
  const inTotal = integerField(value, 'inTotal', label, { nonNegative: true });
  if (!inTotal.ok) return inTotal;
  const outPass = integerField(value, 'outPass', label, { nonNegative: true });
  if (!outPass.ok) return outPass;
  const outTotal = integerField(value, 'outTotal', label, { nonNegative: true });
  if (!outTotal.ok) return outTotal;
  return ok({
    inPass: inPass.value,
    inTotal: inTotal.value,
    outPass: outPass.value,
    outTotal: outTotal.value,
  });
};

const parseVerdict = (value: unknown): Result<ValidationVerdict, string> => {
  if (!isRecord(value)) return err('verdict must be an object');
  const deltaIn = integerField(value, 'deltaIn', 'verdict');
  if (!deltaIn.ok) return deltaIn;
  const deltaOut = integerField(value, 'deltaOut', 'verdict');
  if (!deltaOut.ok) return deltaOut;
  const accepted = value.accepted;
  if (typeof accepted !== 'boolean') return err('verdict.accepted must be boolean');
  return ok({ deltaIn: deltaIn.value, deltaOut: deltaOut.value, accepted });
};

const parseFitnessSplit = (
  value: unknown,
  label: string,
): Result<EvolutionFitness['heldIn'], string> => {
  if (!isRecord(value)) return err(`${label} must be an object`);
  const pass = integerField(value, 'pass', label, { nonNegative: true });
  if (!pass.ok) return pass;
  const total = integerField(value, 'total', label, { nonNegative: true });
  if (!total.ok) return total;
  const delta = integerField(value, 'delta', label);
  if (!delta.ok) return delta;
  return ok({ pass: pass.value, total: total.value, delta: delta.value });
};

const parseFitness = (value: unknown): Result<EvolutionFitness, string> => {
  if (!isRecord(value)) return err('fitness must be an object');
  const heldIn = parseFitnessSplit(value.heldIn, 'fitness.heldIn');
  if (!heldIn.ok) return heldIn;
  const heldOut = parseFitnessSplit(value.heldOut, 'fitness.heldOut');
  if (!heldOut.ok) return heldOut;
  const regressions = integerField(value, 'regressions', 'fitness', { nonNegative: true });
  if (!regressions.ok) return regressions;
  if (!isJsonValue(value.cost)) return err('fitness.cost must be JSON-serializable');
  return ok({
    heldIn: heldIn.value,
    heldOut: heldOut.value,
    regressions: regressions.value,
    cost: value.cost,
  });
};

const parseFitnessFile = (value: unknown): Result<EvolveFitnessFile, string> => {
  if (!isRecord(value)) return err('fitness file must be an object');
  const schemaVersion = stringField(value, 'schemaVersion');
  if (!schemaVersion.ok) return schemaVersion;
  if (schemaVersion.value !== FITNESS_SCHEMA_VERSION) {
    return err(`schemaVersion must be ${FITNESS_SCHEMA_VERSION}`);
  }
  const surface = stringField(value, 'surface');
  if (!surface.ok) return surface;
  if (!isSurface(surface.value)) return err('surface must be guard-rule or review-rubric');
  const candidateId = stringField(value, 'candidateId');
  if (!candidateId.ok) return candidateId;
  const current = parseSplitScores(value.current, 'current');
  if (!current.ok) return current;
  const candidate = parseSplitScores(value.candidate, 'candidate');
  if (!candidate.ok) return candidate;
  const verdict = parseVerdict(value.verdict);
  if (!verdict.ok) return verdict;
  const fitness = parseFitness(value.fitness);
  if (!fitness.ok) return fitness;
  if (!isJsonValue(value.validationSpecSnapshot)) {
    return err('validationSpecSnapshot must be JSON-serializable');
  }
  return ok({
    schemaVersion: FITNESS_SCHEMA_VERSION,
    surface: surface.value,
    candidateId: candidateId.value,
    current: current.value,
    candidate: candidate.value,
    verdict: verdict.value,
    fitness: fitness.value,
    validationSpecSnapshot: value.validationSpecSnapshot,
  });
};

const slug = (value: string): string => {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return cleaned.length === 0 ? 'candidate' : cleaned;
};

const lineageIdFor = (candidate: EvolveCandidate): string =>
  candidate.id.startsWith('evo-')
    ? slug(candidate.id)
    : `evo-${candidate.surface}-${slug(candidate.id)}`;

/** `fugue evolve mine <packet.json...> --out weaknesses.json` — map packet evidence to weakness signals. */
export class EvolveMineCommand extends Command {
  static override paths = [['evolve', 'mine']];

  out = Option.String('--out', { required: true });
  packets = Option.Rest({ name: 'packet.json', required: 1 });

  override async execute(): Promise<number> {
    const signals: WeaknessSignal[] = [];
    const warnings: string[] = [];

    for (const packetPath of this.packets) {
      const parsed = await readJson(packetPath);
      if (!parsed.ok) {
        this.context.stderr.write(`${parsed.error}\n`);
        return 1;
      }
      const mapped = packetWeaknessSignals(parsed.value);
      signals.push(...mapped.signals);
      warnings.push(...mapped.warnings.map((warning) => `${packetPath}: ${warning}`));
    }

    const output: EvolveMineOutput = {
      schemaVersion: WEAKNESSES_SCHEMA_VERSION,
      signals,
      warnings,
    };
    await writeJson(this.out, output);
    this.context.stdout.write(
      `wrote ${String(signals.length)} weakness signal(s) -> ${this.out}\n`,
    );
    return 0;
  }
}

/** `fugue evolve validate --candidate c.json --cases cases.json --out fitness.json` — local candidate scoring. */
export class EvolveValidateCommand extends Command {
  static override paths = [['evolve', 'validate']];

  candidatePath = Option.String('--candidate', { required: true });
  casesPath = Option.String('--cases', { required: true });
  samples = Option.String('--samples', '3');
  out = Option.String('--out', { required: true });

  override async execute(): Promise<number> {
    const parsedSamples = parsePositiveInteger(this.samples, '--samples');
    if (!parsedSamples.ok) {
      this.context.stderr.write(`${parsedSamples.error}\n`);
      return 1;
    }

    const candidateJson = await readJson(this.candidatePath);
    if (!candidateJson.ok) {
      this.context.stderr.write(`${candidateJson.error}\n`);
      return 1;
    }
    const candidate = parseCandidate(candidateJson.value);
    if (!candidate.ok) {
      this.context.stderr.write(`${candidate.error}\n`);
      return 1;
    }

    const casesJson = await readJson(this.casesPath);
    if (!casesJson.ok) {
      this.context.stderr.write(`${casesJson.error}\n`);
      return 1;
    }
    const result = validateCandidate(candidate.value, casesJson.value, parsedSamples.value);
    if (!result.ok) {
      this.context.stderr.write(`${result.error}\n`);
      return 1;
    }

    await writeJson(this.out, result.value);
    this.context.stdout.write(
      `validated ${candidate.value.surface}/${candidate.value.id}: accepted=${String(
        result.value.verdict.accepted,
      )} dIn=${String(result.value.verdict.deltaIn)} dOut=${String(
        result.value.verdict.deltaOut,
      )} -> ${this.out}\n`,
    );
    return result.value.verdict.accepted ? 0 : 1;
  }
}

/** `fugue evolve promote --candidate c.json --fitness f.json --by ... --lineage <dir>` — audited promotion. */
export class EvolvePromoteCommand extends Command {
  static override paths = [['evolve', 'promote']];

  candidatePath = Option.String('--candidate', { required: true });
  fitnessPath = Option.String('--fitness', { required: true });
  by = Option.String('--by', { required: true });
  lineage = Option.String('--lineage', { required: true });

  override async execute(): Promise<number> {
    if (!isPromoter(this.by)) {
      this.context.stderr.write('--by must be operator, self-harness, or evolve\n');
      return 1;
    }

    const candidateJson = await readJson(this.candidatePath);
    if (!candidateJson.ok) {
      this.context.stderr.write(`${candidateJson.error}\n`);
      return 1;
    }
    const candidate = parseCandidate(candidateJson.value);
    if (!candidate.ok) {
      this.context.stderr.write(`${candidate.error}\n`);
      return 1;
    }

    const fitnessJson = await readJson(this.fitnessPath);
    if (!fitnessJson.ok) {
      this.context.stderr.write(`${fitnessJson.error}\n`);
      return 1;
    }
    const fitness = parseFitnessFile(fitnessJson.value);
    if (!fitness.ok) {
      this.context.stderr.write(`${fitness.error}\n`);
      return 1;
    }
    if (fitness.value.surface !== candidate.value.surface) {
      this.context.stderr.write('fitness.surface must match candidate.surface\n');
      return 1;
    }
    if (fitness.value.candidateId !== candidate.value.id) {
      this.context.stderr.write('fitness.candidateId must match candidate.id\n');
      return 1;
    }
    if (!fitness.value.verdict.accepted) {
      this.context.stderr.write('candidate fitness was not accepted; refusing promotion\n');
      return 1;
    }

    const entry: EvolutionLineageEntry = {
      id: lineageIdFor(candidate.value),
      surface: candidate.value.surface,
      candidateId: candidate.value.id,
      evidenceRefs: candidate.value.evidenceRefs,
      beforeContent: candidate.value.before,
      afterSha256: sha256(candidate.value.after),
      validationSpecSnapshot:
        candidate.value.validationSpecSnapshot ?? fitness.value.validationSpecSnapshot,
      fitness: fitness.value.fitness,
      promotedBy: this.by,
      rollbackHint:
        candidate.value.rollbackHint ??
        `restore beforeContent into the ${candidate.value.surface} surface`,
      ...(candidate.value.supersedes === undefined
        ? {}
        : { supersedes: candidate.value.supersedes }),
    };

    const store = new FsLineageStore(fs(), this.lineage);
    const saved = await store.put(entry);
    if (!saved.ok) {
      this.context.stderr.write(`${saved.error.detail}\n`);
      return 1;
    }

    await writeJson(`${this.lineage}/last-promotion.json`, entry);
    this.context.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
    return 0;
  }
}

/** `fugue evolve history --lineage <dir>` — read promotion lineage as deterministic JSON. */
export class EvolveHistoryCommand extends Command {
  static override paths = [['evolve', 'history']];

  lineage = Option.String('--lineage', { required: true });

  override async execute(): Promise<number> {
    const store = new FsLineageStore(fs(), this.lineage);
    const listed = await store.list();
    if (!listed.ok) {
      this.context.stderr.write(`${listed.error.detail}\n`);
      return 1;
    }
    await writeJson(`${this.lineage}/last-history.json`, {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      entries: listed.value,
    });
    this.context.stdout.write(
      `${JSON.stringify({ schemaVersion: HISTORY_SCHEMA_VERSION, entries: listed.value }, null, 2)}\n`,
    );
    return 0;
  }
}
