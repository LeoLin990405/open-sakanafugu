/**
 * Experience memory (Zleap): a completed task → a reusable, redacted method,
 * bucketed by workspace, recalled into context for future similar tasks.
 */
export interface Method {
  readonly workspace: string;
  readonly title: string;
  readonly slug: string;
  readonly created: number; // epoch seconds (bash `date +%s`)
  readonly body: string;
}

export interface AddMethod {
  readonly workspace: string;
  readonly title: string;
  readonly body: string;
}

export const FAILURE_CAUSES = [
  'planning',
  'context',
  'retrieval',
  'tooling',
  'implementation',
  'verification',
  'integration',
  'runtime',
  'policy',
  'other',
] as const;

export type FailureCause = (typeof FAILURE_CAUSES)[number];

export const isFailureCause = (value: string): value is FailureCause =>
  (FAILURE_CAUSES as readonly string[]).includes(value);

export type ExperienceErrorKind = 'empty-body' | 'contains-secret';

export interface ExperienceError {
  readonly kind: ExperienceErrorKind;
  readonly detail: string;
}

export interface RecallOptions {
  readonly query?: string;
  readonly limit?: number;
  readonly failureCause?: FailureCause;
}
