import { describe, expect, it } from 'vitest';

import type { ReviewVerdict } from './review-packet.js';
import {
  scoreRubric,
  type ReviewRubricSplitCases,
  type RubricEvaluator,
} from './evolution-rubric.js';

const cases: ReviewRubricSplitCases = {
  heldIn: [
    {
      diff: '+ fix authorization branch',
      context: 'security regression',
      expectedVerdict: 'NEEDS_FIX',
    },
  ],
  heldOut: [
    {
      diff: '+ add docs for CLI option',
      context: 'safe docs change',
      expectedVerdict: 'ACCEPTED',
    },
  ],
};

describe('scoreRubric', () => {
  it('samples every held-in and held-out rubric case', () => {
    const evaluator: RubricEvaluator = (_rubric, testCase) => testCase.expectedVerdict;

    expect(scoreRubric(evaluator, 'strict review rubric', cases, 3)).toEqual({
      inPass: 3,
      inTotal: 3,
      outPass: 3,
      outTotal: 3,
    });
  });

  it('aggregates pass counts from evaluator verdicts', () => {
    const evaluator: RubricEvaluator = (rubric, testCase): ReviewVerdict =>
      rubric.includes('security') && testCase.context === 'security regression'
        ? 'NEEDS_FIX'
        : 'UNKNOWN';

    expect(scoreRubric(evaluator, 'security-aware rubric', cases, 2)).toEqual({
      inPass: 2,
      inTotal: 2,
      outPass: 0,
      outTotal: 2,
    });
  });

  it('rejects invalid sample counts as programmer errors', () => {
    const evaluator: RubricEvaluator = (_rubric, testCase) => testCase.expectedVerdict;

    expect(() => scoreRubric(evaluator, 'rubric', cases, 0)).toThrow(/positive integer/u);
  });
});
