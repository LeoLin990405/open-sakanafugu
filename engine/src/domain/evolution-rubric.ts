import type { ReviewVerdict } from './review-packet.js';
import type { SplitScores } from './self-harness.js';

export interface ReviewRubricCase {
  readonly diff: string;
  readonly context: string;
  readonly expectedVerdict: ReviewVerdict;
}

export interface ReviewRubricSplitCases {
  readonly heldIn: readonly ReviewRubricCase[];
  readonly heldOut: readonly ReviewRubricCase[];
}

export type RubricEvaluator = (rubric: string, testCase: ReviewRubricCase) => ReviewVerdict;

const scoreCases = (
  evaluator: RubricEvaluator,
  rubric: string,
  cases: readonly ReviewRubricCase[],
  samples: number,
): { readonly pass: number; readonly total: number } => {
  let pass = 0;
  for (const testCase of cases) {
    for (let sample = 0; sample < samples; sample += 1) {
      if (evaluator(rubric, testCase) === testCase.expectedVerdict) pass += 1;
    }
  }
  return { pass, total: cases.length * samples };
};

export const scoreRubric = (
  evaluator: RubricEvaluator,
  rubric: string,
  cases: ReviewRubricSplitCases,
  samples: number,
): SplitScores => {
  if (!Number.isInteger(samples) || samples <= 0) {
    throw new Error('scoreRubric: samples must be a positive integer');
  }
  const heldIn = scoreCases(evaluator, rubric, cases.heldIn, samples);
  const heldOut = scoreCases(evaluator, rubric, cases.heldOut, samples);
  return {
    inPass: heldIn.pass,
    inTotal: heldIn.total,
    outPass: heldOut.pass,
    outTotal: heldOut.total,
  };
};
