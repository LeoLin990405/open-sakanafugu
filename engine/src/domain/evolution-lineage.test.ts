import { describe, expect, it } from 'vitest';

import { isErr, isOk } from './result.js';
import {
  gatePromotion,
  isSafetySurface,
  parseEvolutionLineageEntry,
  renderEvolutionLineageEntry,
  type EvolutionLineageEntry,
} from './evolution-lineage.js';

const entry: EvolutionLineageEntry = {
  id: 'evo-001',
  surface: 'guard-rule',
  candidateId: 'cand-tighten-release',
  evidenceRefs: [
    {
      sourceRef: '/tmp/release-task.md',
      sourceSha256: 'sha-release',
      kind: 'privileged-action-without-certificate',
    },
  ],
  beforeContent: 'privileged-action-regex: (?:git push|npm publish)\nkeep this full text',
  afterSha256: 'sha-after',
  validationSpecSnapshot: {
    heldIn: ['release-create', 'npm-publish'],
    heldOut: ['safe-task', 'git-push'],
  },
  fitness: {
    heldIn: { pass: 2, total: 2, delta: 1 },
    heldOut: { pass: 2, total: 2, delta: 0 },
    regressions: 0,
    cost: { samples: 4, evaluator: 'runtimeGuardPacket' },
  },
  promotedBy: 'operator',
  rollbackHint: 'restore beforeContent into the guard-rule surface',
  supersedes: ['evo-000'],
};

describe('evolution lineage', () => {
  it('round-trips JSON while preserving the full beforeContent', () => {
    const parsed = parseEvolutionLineageEntry(renderEvolutionLineageEntry(entry));

    expect(isOk(parsed)).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(entry);
  });

  it('normalizes duplicate supersedes entries', () => {
    const parsed = parseEvolutionLineageEntry(
      JSON.stringify({
        ...entry,
        supersedes: ['evo-000', 'evo-000\n', 'evo-001'],
      }),
    );

    expect(isOk(parsed)).toBe(true);
    if (parsed.ok) expect(parsed.value.supersedes).toEqual(['evo-000', 'evo-001']);
  });

  it('rejects invalid records as expected failures', () => {
    const parsed = parseEvolutionLineageEntry(
      JSON.stringify({
        ...entry,
        surface: 'system-prompt',
      }),
    );

    expect(isErr(parsed)).toBe(true);
    if (!parsed.ok) expect(parsed.error).toBe('surface must be guard-rule or review-rubric');
  });

  it('accepts review-rubric as a non-safety surface', () => {
    const parsed = parseEvolutionLineageEntry(
      JSON.stringify({
        ...entry,
        surface: 'review-rubric',
        promotedBy: 'self-harness',
        rollbackHint: 'restore beforeContent into the review-rubric surface',
      }),
    );

    expect(isOk(parsed)).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.surface).toBe('review-rubric');
      expect(isSafetySurface(parsed.value.surface)).toBe(false);
      expect(isOk(gatePromotion(parsed.value))).toBe(true);
    }
  });

  it('treats guard-rule as a safety surface', () => {
    expect(isSafetySurface('guard-rule')).toBe(true);
  });

  it('gates autonomous promotion of a safety surface', () => {
    expect(isErr(gatePromotion({ ...entry, promotedBy: 'self-harness' }))).toBe(true);
    expect(isErr(gatePromotion({ ...entry, promotedBy: 'evolve' }))).toBe(true);
  });

  it('allows an operator promotion of a safety surface', () => {
    expect(isOk(gatePromotion({ ...entry, promotedBy: 'operator' }))).toBe(true);
  });
});
