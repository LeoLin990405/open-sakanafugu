import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { acceptEdit } from './self-harness-accept.js';
import type { ReviewVerdict } from './review-packet.js';
import {
  scoreRubric,
  type ReviewRubricCase,
  type ReviewRubricSplitCases,
  type RubricEvaluator,
} from './evolution-rubric.js';
import type { EvolutionLineageEntry } from './evolution-lineage.js';
import {
  gatePromotion,
  parseEvolutionLineageEntry,
  renderEvolutionLineageEntry,
} from './evolution-lineage.js';
import { isOk } from './result.js';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const nextScriptedVerdict = (
  table: ReadonlyMap<string, readonly ReviewVerdict[]>,
  counts: Map<string, number>,
  rubric: string,
  testCase: ReviewRubricCase,
): ReviewVerdict => {
  const key = `${rubric}:${testCase.context}`;
  const script = table.get(key) ?? ['UNKNOWN'];
  const count = counts.get(key) ?? 0;
  counts.set(key, count + 1);
  return script[count % script.length] ?? 'UNKNOWN';
};

const scriptedEvaluator = (
  table: ReadonlyMap<string, readonly ReviewVerdict[]>,
): RubricEvaluator => {
  const counts = new Map<string, number>();
  return (rubric, testCase) => nextScriptedVerdict(table, counts, rubric, testCase);
};

describe('review-rubric evolution e2e', () => {
  it('uses repeated rubric samples to avoid a noisy single-sample rejection', () => {
    const rubricCases: ReviewRubricSplitCases = {
      heldIn: [
        {
          diff: '+ return err when privileged action lacks certificate',
          context: 'security regression',
          expectedVerdict: 'NEEDS_FIX',
        },
      ],
      heldOut: [
        {
          diff: '+ clarify README setup wording',
          context: 'safe docs change',
          expectedVerdict: 'ACCEPTED',
        },
      ],
    };
    const currentRubric = 'current review rubric';
    const candidateRubric = 'candidate review rubric';
    const script = new Map<string, readonly ReviewVerdict[]>([
      [`${currentRubric}:security regression`, ['ACCEPTED', 'ACCEPTED', 'ACCEPTED']],
      [`${currentRubric}:safe docs change`, ['ACCEPTED', 'ACCEPTED', 'NEEDS_FIX']],
      [`${candidateRubric}:security regression`, ['NEEDS_FIX', 'NEEDS_FIX', 'NEEDS_FIX']],
      [`${candidateRubric}:safe docs change`, ['NEEDS_FIX', 'ACCEPTED', 'ACCEPTED']],
    ]);

    const noisyCurrent = scoreRubric(scriptedEvaluator(script), currentRubric, rubricCases, 1);
    const noisyCandidate = scoreRubric(scriptedEvaluator(script), candidateRubric, rubricCases, 1);
    expect(acceptEdit(noisyCurrent, noisyCandidate)).toEqual({
      deltaIn: 1,
      deltaOut: -1,
      accepted: false,
    });

    const current = scoreRubric(scriptedEvaluator(script), currentRubric, rubricCases, 3);
    const candidate = scoreRubric(scriptedEvaluator(script), candidateRubric, rubricCases, 3);
    const verdict = acceptEdit(current, candidate);

    expect(current).toEqual({ inPass: 0, inTotal: 3, outPass: 2, outTotal: 3 });
    expect(candidate).toEqual({ inPass: 3, inTotal: 3, outPass: 2, outTotal: 3 });
    expect(verdict).toEqual({ deltaIn: 3, deltaOut: 0, accepted: true });

    const lineage: EvolutionLineageEntry = {
      id: 'evo-review-rubric-001',
      surface: 'review-rubric',
      candidateId: 'candidate-security-aware-review',
      evidenceRefs: [
        {
          sourceRef: '/tmp/review-regression.md',
          sourceSha256: 'sha-review-regression',
          kind: 'review-missed-security-finding',
        },
      ],
      beforeContent: currentRubric,
      afterSha256: sha256(candidateRubric),
      validationSpecSnapshot: {
        heldIn: rubricCases.heldIn.map((testCase) => testCase.context),
        heldOut: rubricCases.heldOut.map((testCase) => testCase.context),
        samples: 3,
      },
      fitness: {
        heldIn: { pass: candidate.inPass, total: candidate.inTotal, delta: verdict.deltaIn },
        heldOut: { pass: candidate.outPass, total: candidate.outTotal, delta: verdict.deltaOut },
        regressions: 0,
        cost: { evaluator: 'scripted-review-rubric', samples: 6 },
      },
      promotedBy: 'self-harness',
      rollbackHint: 'restore beforeContent into the review-rubric surface',
    };

    const gated = gatePromotion(lineage);
    const parsed = parseEvolutionLineageEntry(renderEvolutionLineageEntry(lineage));

    expect(isOk(gated)).toBe(true);
    expect(parsed.ok ? parsed.value : parsed.error).toEqual(lineage);
  });
});
