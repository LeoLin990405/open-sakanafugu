import { err, ok } from './result.js';
import type { Result } from './result.js';

export type EvolvableSurface = 'guard-rule' | 'review-rubric';

export type EvolutionPromoter = 'operator' | 'self-harness' | 'evolve';

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface EvidenceRef {
  readonly sourceRef: string;
  readonly sourceSha256: string;
  readonly kind: string;
}

export interface EvolutionSplitFitness {
  readonly pass: number;
  readonly total: number;
  readonly delta: number;
}

export interface EvolutionFitness {
  readonly heldIn: EvolutionSplitFitness;
  readonly heldOut: EvolutionSplitFitness;
  readonly regressions: number;
  readonly cost: JsonValue;
}

export interface EvolutionLineageEntry {
  readonly id: string;
  readonly surface: EvolvableSurface;
  readonly candidateId: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly beforeContent: string;
  readonly afterSha256: string;
  readonly validationSpecSnapshot: JsonValue;
  readonly fitness: EvolutionFitness;
  readonly promotedBy: EvolutionPromoter;
  readonly rollbackHint: string;
  readonly supersedes?: readonly string[];
}

/**
 * Surfaces that are themselves safety controls. Evolving one is not a normal
 * optimization: a guard-rule decides what dispatch refuses, so an agent that
 * could autonomously promote a guard-rule edit could evolve the very rule that
 * blocks prompt-injection / privileged actions into not blocking. These must be
 * promoted by an operator, never by `self-harness` / `evolve`.
 */
export const SAFETY_SURFACES: readonly EvolvableSurface[] = ['guard-rule'];

export const isSafetySurface = (surface: EvolvableSurface): boolean =>
  SAFETY_SURFACES.includes(surface);

/**
 * Promotion gate: returns the entry unchanged when the promotion is allowed, or
 * a typed error refusing an autonomous promotion of a safety surface. This is
 * the one rule that keeps the evolution loop from neutering its own guardrails;
 * the lineage store enforces it on write so nothing illegal is ever recorded.
 */
export const gatePromotion = (
  entry: EvolutionLineageEntry,
): Result<EvolutionLineageEntry, string> =>
  isSafetySurface(entry.surface) && entry.promotedBy !== 'operator'
    ? err(
        `refusing autonomous promotion of safety surface '${entry.surface}' by '${entry.promotedBy}'; safety surfaces require promotedBy=operator`,
      )
    : ok(entry);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const stringField = (record: Record<string, unknown>, key: string): Result<string, string> => {
  const value = record[key];
  return typeof value === 'string' && value.length > 0
    ? ok(value)
    : err(`${key} must be a non-empty string`);
};

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

const isSurface = (value: string): value is EvolvableSurface =>
  value === 'guard-rule' || value === 'review-rubric';

const isPromoter = (value: string): value is EvolutionPromoter =>
  value === 'operator' || value === 'self-harness' || value === 'evolve';

const isInteger = (value: unknown): value is number => Number.isInteger(value);

const parseEvidenceRefs = (value: unknown): Result<readonly EvidenceRef[], string> => {
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

const parseSplitFitness = (
  value: unknown,
  label: string,
): Result<EvolutionSplitFitness, string> => {
  if (!isRecord(value)) return err(`${label} must be an object`);
  const pass = value.pass;
  const total = value.total;
  const delta = value.delta;
  if (!isInteger(pass) || pass < 0) return err(`${label}.pass must be a non-negative integer`);
  if (!isInteger(total) || total < 0) return err(`${label}.total must be a non-negative integer`);
  if (!isInteger(delta)) return err(`${label}.delta must be an integer`);
  return ok({ pass, total, delta });
};

const parseFitness = (value: unknown): Result<EvolutionFitness, string> => {
  if (!isRecord(value)) return err('fitness must be an object');
  const heldIn = parseSplitFitness(value.heldIn, 'fitness.heldIn');
  if (!heldIn.ok) return heldIn;
  const heldOut = parseSplitFitness(value.heldOut, 'fitness.heldOut');
  if (!heldOut.ok) return heldOut;
  const regressions = value.regressions;
  if (!isInteger(regressions) || regressions < 0) {
    return err('fitness.regressions must be a non-negative integer');
  }
  if (!isJsonValue(value.cost)) return err('fitness.cost must be JSON-serializable');
  return ok({ heldIn: heldIn.value, heldOut: heldOut.value, regressions, cost: value.cost });
};

const normalizeSupersedes = (value: unknown): Result<readonly string[] | undefined, string> => {
  if (value === undefined) return ok(undefined);
  if (!isUnknownArray(value)) return err('supersedes must be an array');
  const seen = new Set<string>();
  const supersedes: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== 'string' || item.trim().length === 0) {
      return err(`supersedes[${String(index)}] must be a non-empty string`);
    }
    const normalized = item.replace(/[\r\n]+/gu, ' ').trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      supersedes.push(normalized);
    }
  }
  return ok(supersedes);
};

export const renderEvolutionLineageEntry = (entry: EvolutionLineageEntry): string =>
  `${JSON.stringify(entry, null, 2)}\n`;

export const parseEvolutionLineageEntry = (text: string): Result<EvolutionLineageEntry, string> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`invalid JSON: ${message}`);
  }
  if (!isRecord(parsed)) return err('lineage entry must be an object');

  const id = stringField(parsed, 'id');
  if (!id.ok) return id;
  const surface = stringField(parsed, 'surface');
  if (!surface.ok) return surface;
  if (!isSurface(surface.value)) return err('surface must be guard-rule or review-rubric');
  const candidateId = stringField(parsed, 'candidateId');
  if (!candidateId.ok) return candidateId;
  const evidenceRefs = parseEvidenceRefs(parsed.evidenceRefs);
  if (!evidenceRefs.ok) return evidenceRefs;
  const beforeContent = stringField(parsed, 'beforeContent');
  if (!beforeContent.ok) return beforeContent;
  const afterSha256 = stringField(parsed, 'afterSha256');
  if (!afterSha256.ok) return afterSha256;
  if (!isJsonValue(parsed.validationSpecSnapshot)) {
    return err('validationSpecSnapshot must be JSON-serializable');
  }
  const fitness = parseFitness(parsed.fitness);
  if (!fitness.ok) return fitness;
  const promotedBy = stringField(parsed, 'promotedBy');
  if (!promotedBy.ok) return promotedBy;
  if (!isPromoter(promotedBy.value)) {
    return err('promotedBy must be operator, self-harness, or evolve');
  }
  const rollbackHint = stringField(parsed, 'rollbackHint');
  if (!rollbackHint.ok) return rollbackHint;
  const supersedes = normalizeSupersedes(parsed.supersedes);
  if (!supersedes.ok) return supersedes;

  return ok({
    id: id.value,
    surface: surface.value,
    candidateId: candidateId.value,
    evidenceRefs: evidenceRefs.value,
    beforeContent: beforeContent.value,
    afterSha256: afterSha256.value,
    validationSpecSnapshot: parsed.validationSpecSnapshot,
    fitness: fitness.value,
    promotedBy: promotedBy.value,
    rollbackHint: rollbackHint.value,
    ...(supersedes.value === undefined ? {} : { supersedes: supersedes.value }),
  });
};
