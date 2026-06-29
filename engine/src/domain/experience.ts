/**
 * Experience memory (Zleap): a completed task → a reusable, redacted method,
 * bucketed by workspace, recalled into context for future similar tasks.
 */
export interface Method {
  readonly workspace: string;
  readonly title: string;
  readonly slug: string;
  readonly created: number; // epoch seconds (bash `date +%s`)
  readonly sourceKind: ExperienceSourceKind;
  readonly sourceRef?: string;
  readonly trustKind: ExperienceTrustKind;
  readonly confirmedBy?: readonly string[];
  readonly supersedes?: readonly string[];
  readonly body: string;
}

export interface AddMethod {
  readonly workspace: string;
  readonly title: string;
  readonly sourceKind?: ExperienceSourceKind;
  readonly sourceRef?: string;
  readonly trustKind?: ExperienceTrustKind;
  readonly supersedes?: readonly string[];
  readonly body: string;
}

export interface PromoteMethod {
  readonly workspace: string;
  readonly slug: string;
  readonly sourceRef: string;
  readonly confirmSourceRefs: readonly string[];
}

export const EXPERIENCE_SOURCE_KINDS = ['manual', 'task'] as const;

export type ExperienceSourceKind = (typeof EXPERIENCE_SOURCE_KINDS)[number];

export const isExperienceSourceKind = (value: string): value is ExperienceSourceKind =>
  (EXPERIENCE_SOURCE_KINDS as readonly string[]).includes(value);

export const EXPERIENCE_TRUST_KINDS = ['trusted', 'untrusted'] as const;

export type ExperienceTrustKind = (typeof EXPERIENCE_TRUST_KINDS)[number];

export const isExperienceTrustKind = (value: string): value is ExperienceTrustKind =>
  (EXPERIENCE_TRUST_KINDS as readonly string[]).includes(value);

export const EXPERIENCE_TRUST_FILTERS = ['trusted', 'untrusted', 'all'] as const;

export type ExperienceTrustFilter = (typeof EXPERIENCE_TRUST_FILTERS)[number];

export const isExperienceTrustFilter = (value: string): value is ExperienceTrustFilter =>
  (EXPERIENCE_TRUST_FILTERS as readonly string[]).includes(value);

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

const QUERY_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'should',
  'that',
  'the',
  'this',
  'to',
  'use',
  'with',
]);

export const experienceQueryTerms = (query: string | undefined): readonly string[] => {
  if (query === undefined) return [];
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(terms.filter((term) => !QUERY_STOP_WORDS.has(term)))];
};

export const experienceMatchedTerms = (
  method: Pick<Method, 'title' | 'body'>,
  terms: readonly string[],
): readonly string[] => {
  const methodTerms = new Set(experienceQueryTerms(`${method.title}\n${method.body}`));
  return terms.filter((term) => methodTerms.has(term));
};

export const experienceScore = (
  method: Pick<Method, 'title' | 'body'>,
  terms: readonly string[],
): number => experienceMatchedTerms(method, terms).length;

export const experienceFailureCause = (method: Pick<Method, 'body'>): FailureCause | undefined => {
  const lines = method.body.split(/\r?\n/u);
  const index = lines.findIndex((line) => line === 'Failure cause:');
  const cause = index === -1 ? undefined : lines[index + 1]?.trim().toLowerCase();
  return cause !== undefined && isFailureCause(cause) ? cause : undefined;
};

interface ExperienceMethodAnnotation {
  readonly slug: string;
  readonly sourceKind: ExperienceSourceKind;
  readonly sourceRef?: string;
  readonly trustKind: ExperienceTrustKind;
  readonly confirmedBy?: readonly string[];
  readonly created: number;
  readonly failureCause?: FailureCause;
  readonly supersedes?: readonly string[];
}

export const renderExperienceMethod = (method: Method): string => {
  const failureCause = experienceFailureCause(method);
  const annotation: ExperienceMethodAnnotation = {
    slug: method.slug,
    sourceKind: method.sourceKind,
    ...(method.sourceRef === undefined || method.sourceRef.length === 0
      ? {}
      : { sourceRef: method.sourceRef }),
    trustKind: method.trustKind,
    ...(method.confirmedBy === undefined || method.confirmedBy.length === 0
      ? {}
      : { confirmedBy: method.confirmedBy }),
    created: method.created,
    ...(failureCause === undefined ? {} : { failureCause }),
    ...(method.supersedes === undefined || method.supersedes.length === 0
      ? {}
      : { supersedes: method.supersedes }),
  };
  return `[experience] ${method.title}\n[experience:meta] ${JSON.stringify(annotation)}\n${method.body}\n`;
};

export interface PackedExperienceMethods {
  readonly rendered: readonly string[];
  readonly totalChars: number;
  readonly omitted: number;
  readonly maxChars?: number;
}

export type ExperiencePolicyItemKind = 'requirement' | 'output' | 'audit' | 'lesson' | 'body';

export interface ExperiencePolicyItem {
  readonly kind: ExperiencePolicyItemKind;
  readonly text: string;
}

export interface ExperiencePolicyCard {
  readonly workspace: string;
  readonly title: string;
  readonly slug: string;
  readonly created: number;
  readonly sourceKind: ExperienceSourceKind;
  readonly sourceRef?: string;
  readonly trustKind: ExperienceTrustKind;
  readonly confirmedBy?: readonly string[];
  readonly supersedes?: readonly string[];
  readonly failureCause?: FailureCause;
  readonly items: readonly ExperiencePolicyItem[];
}

const charLength = (value: string): number => Array.from(value).length;

const renderedExperienceBlockChars = (rendered: readonly string[]): number =>
  charLength(rendered.join('\n').replace(/\s+$/u, ''));

export const packExperienceMethodsForPrompt = (
  methods: readonly Method[],
  maxChars?: number,
): PackedExperienceMethods => {
  const rendered = methods.map(renderExperienceMethod);
  if (maxChars === undefined) {
    return {
      rendered,
      totalChars: renderedExperienceBlockChars(rendered),
      omitted: 0,
    };
  }
  const packed: string[] = [];
  let omitted = 0;
  for (const entry of rendered) {
    const next = [...packed, entry];
    if (renderedExperienceBlockChars(next) <= maxChars) {
      packed.push(entry);
    } else {
      omitted += 1;
    }
  }
  const totalChars = renderedExperienceBlockChars(packed);
  return {
    rendered: packed,
    totalChars,
    omitted,
    maxChars,
  };
};

const policySections: Readonly<Record<string, ExperiencePolicyItemKind>> = {
  Requirements: 'requirement',
  'Output files': 'output',
  'Reusable audit notes': 'audit',
  'Relabeled lesson': 'lesson',
};

const cleanPolicyText = (value: string): string =>
  value
    .replace(/^[-*]\s+/u, '')
    .replace(/^\d+[.)]\s+/u, '')
    .replace(/^\[[ xX]\]\s+/u, '')
    .trim();

const isPolicyBullet = (line: string): boolean =>
  /^[-*]\s+\S/u.test(line) || /^\d+[.)]\s+\S/u.test(line);

const policySectionItems = (
  lines: readonly string[],
  start: number,
  kind: ExperiencePolicyItemKind,
): readonly ExperiencePolicyItem[] => {
  const items: ExperiencePolicyItem[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim().endsWith(':') && line.trim().length < 80) break;
    if (line.trim().length === 0) {
      if (items.length > 0) break;
      continue;
    }
    if (isPolicyBullet(line)) {
      const text = cleanPolicyText(line);
      if (text.length > 0 && text !== '(none recorded)') items.push({ kind, text });
    } else if (kind === 'lesson') {
      const text = cleanPolicyText(line);
      if (text.length > 0) items.push({ kind, text });
    }
  }
  return items;
};

const fallbackPolicyItems = (body: string): readonly ExperiencePolicyItem[] =>
  body
    .split(/\r?\n/u)
    .map((line) => cleanPolicyText(line))
    .filter((line) => line.length > 0 && !line.endsWith(':'))
    .slice(0, 8)
    .map((text) => ({ kind: 'body', text }));

export const experiencePolicyCard = (method: Method): ExperiencePolicyCard => {
  const lines = method.body.split(/\r?\n/u);
  const items: ExperiencePolicyItem[] = [];
  for (const [index, line] of lines.entries()) {
    const sectionKind = policySections[line.trim().replace(/:$/u, '')];
    if (sectionKind !== undefined) {
      items.push(...policySectionItems(lines, index, sectionKind));
    }
  }
  const uniqueItems: ExperiencePolicyItem[] = [];
  const seen = new Set<string>();
  for (const item of items.length === 0 ? fallbackPolicyItems(method.body) : items) {
    const key = `${item.kind}\t${item.text}`;
    if (!seen.has(key)) {
      uniqueItems.push(item);
      seen.add(key);
    }
  }
  const failureCause = experienceFailureCause(method);
  return {
    workspace: method.workspace,
    title: method.title,
    slug: method.slug,
    created: method.created,
    sourceKind: method.sourceKind,
    ...(method.sourceRef === undefined || method.sourceRef.length === 0
      ? {}
      : { sourceRef: method.sourceRef }),
    trustKind: method.trustKind,
    ...(method.confirmedBy === undefined || method.confirmedBy.length === 0
      ? {}
      : { confirmedBy: method.confirmedBy }),
    ...(method.supersedes === undefined || method.supersedes.length === 0
      ? {}
      : { supersedes: method.supersedes }),
    ...(failureCause === undefined ? {} : { failureCause }),
    items: uniqueItems.slice(0, 16),
  };
};

export const renderExperiencePolicyCard = (card: ExperiencePolicyCard): string => {
  const metadata = {
    slug: card.slug,
    sourceKind: card.sourceKind,
    ...(card.sourceRef === undefined ? {} : { sourceRef: card.sourceRef }),
    trustKind: card.trustKind,
    ...(card.confirmedBy === undefined || card.confirmedBy.length === 0
      ? {}
      : { confirmedBy: card.confirmedBy }),
    created: card.created,
    ...(card.failureCause === undefined ? {} : { failureCause: card.failureCause }),
    ...(card.supersedes === undefined || card.supersedes.length === 0
      ? {}
      : { supersedes: card.supersedes }),
  };
  const body =
    card.items.length === 0
      ? '- body: (no reusable checklist items extracted)'
      : card.items.map((item) => `- ${item.kind}: ${item.text}`).join('\n');
  return `[experience:policy] ${card.title}\n[experience:policy:meta] ${JSON.stringify(metadata)}\n${body}\n`;
};

export interface RecallMatchExplanation {
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly sourceKind: ExperienceSourceKind;
  readonly sourceRef?: string;
  readonly trustKind: ExperienceTrustKind;
  readonly failureCause?: FailureCause;
  readonly minScore?: number;
  readonly sourceFilter?: ExperienceSourceKind;
  readonly sourceRefFilter?: string;
  readonly trustFilter?: ExperienceTrustFilter;
  readonly maxAgeSeconds?: number;
  readonly includeSuperseded?: boolean;
}

export const explainRecallMatch = (
  method: Pick<Method, 'title' | 'body'> &
    Partial<Pick<Method, 'sourceKind' | 'sourceRef' | 'trustKind'>>,
  options: RecallOptions = {},
): RecallMatchExplanation => {
  const terms = experienceQueryTerms(options.query);
  const matchedTerms = experienceMatchedTerms(method, terms);
  const failureCause = experienceFailureCause(method);
  const sourceKind = method.sourceKind ?? 'manual';
  const trustKind = method.trustKind ?? 'trusted';
  return {
    score: matchedTerms.length,
    matchedTerms,
    sourceKind,
    ...(method.sourceRef === undefined || method.sourceRef.length === 0
      ? {}
      : { sourceRef: method.sourceRef }),
    trustKind,
    ...(failureCause === undefined ? {} : { failureCause }),
    ...(options.minScore === undefined ? {} : { minScore: options.minScore }),
    ...(options.sourceKind === undefined ? {} : { sourceFilter: options.sourceKind }),
    ...(options.sourceRef === undefined ? {} : { sourceRefFilter: options.sourceRef }),
    ...(options.trust === undefined ? {} : { trustFilter: options.trust }),
    ...(options.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: options.maxAgeSeconds }),
    ...(options.includeSuperseded === undefined
      ? {}
      : { includeSuperseded: options.includeSuperseded }),
  };
};

export type ExperienceErrorKind = 'empty-body' | 'contains-secret';
export type ExperiencePromotionErrorKind =
  | 'not-found'
  | 'already-trusted'
  | 'missing-source-ref'
  | 'source-ref-mismatch'
  | 'missing-confirmation'
  | 'confirmation-source-conflict';

export interface ExperienceError {
  readonly kind: ExperienceErrorKind | ExperiencePromotionErrorKind;
  readonly detail: string;
}

export interface RecallOptions {
  readonly query?: string;
  readonly limit?: number;
  readonly failureCause?: FailureCause;
  readonly minScore?: number;
  readonly sourceKind?: ExperienceSourceKind;
  readonly sourceRef?: string;
  readonly trust?: ExperienceTrustFilter;
  readonly maxAgeSeconds?: number;
  readonly includeSuperseded?: boolean;
}

export const EXPERIENCE_AUDIT_ISSUE_KINDS = [
  'untrusted-without-source-ref',
  'trusted-source-ref-without-confirmation',
  'untrusted-supersedes',
  'missing-supersedes-target',
  'confirmation-source-conflict',
  'stale-trusted',
] as const;

export type ExperienceAuditIssueKind = (typeof EXPERIENCE_AUDIT_ISSUE_KINDS)[number];

export type ExperienceAuditSeverity = 'error' | 'warning';

export interface ExperienceAuditIssue {
  readonly workspace: string;
  readonly slug: string;
  readonly title: string;
  readonly severity: ExperienceAuditSeverity;
  readonly kind: ExperienceAuditIssueKind;
  readonly detail: string;
}

export interface ExperienceAuditOptions {
  readonly now?: number;
  readonly maxAgeSeconds?: number;
}

export interface ExperienceAuditSummary {
  readonly checked: number;
  readonly issueCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly issues: readonly ExperienceAuditIssue[];
}

const uniqueSlugsByWorkspace = (methods: readonly Method[]): ReadonlySet<string> =>
  new Set(methods.map((method) => `${method.workspace}/${method.slug}`));

const auditIssue = (
  method: Method,
  kind: ExperienceAuditIssueKind,
  severity: ExperienceAuditSeverity,
  detail: string,
): ExperienceAuditIssue => ({
  workspace: method.workspace,
  slug: method.slug,
  title: method.title,
  severity,
  kind,
  detail,
});

const hasDuplicateStrings = (values: readonly string[]): boolean =>
  new Set(values).size !== values.length;

export const auditExperienceMethods = (
  methods: readonly Method[],
  options: ExperienceAuditOptions = {},
): ExperienceAuditSummary => {
  const issues: ExperienceAuditIssue[] = [];
  const slugs = uniqueSlugsByWorkspace(methods);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const staleBefore = options.maxAgeSeconds === undefined ? undefined : now - options.maxAgeSeconds;
  for (const method of methods) {
    const sourceRef = method.sourceRef;
    const hasSourceRef = sourceRef !== undefined && sourceRef.length > 0;
    const confirmedBy = method.confirmedBy ?? [];
    if (method.trustKind === 'untrusted' && !hasSourceRef) {
      issues.push(
        auditIssue(
          method,
          'untrusted-without-source-ref',
          'error',
          'untrusted memory needs a write-time sourceRef before it can be audited or promoted',
        ),
      );
    }
    if (
      method.trustKind === 'trusted' &&
      method.sourceKind === 'manual' &&
      hasSourceRef &&
      confirmedBy.length === 0
    ) {
      issues.push(
        auditIssue(
          method,
          'trusted-source-ref-without-confirmation',
          'warning',
          'trusted imported/manual memory with sourceRef has no confirmedBy audit metadata',
        ),
      );
    }
    if (method.trustKind === 'untrusted' && (method.supersedes ?? []).length > 0) {
      issues.push(
        auditIssue(
          method,
          'untrusted-supersedes',
          'warning',
          'untrusted memory should not be used as the active replacement for older memory',
        ),
      );
    }
    for (const target of method.supersedes ?? []) {
      if (!slugs.has(`${method.workspace}/${target}`)) {
        issues.push(
          auditIssue(
            method,
            'missing-supersedes-target',
            'warning',
            `supersedes target ${target} does not exist in workspace ${method.workspace}`,
          ),
        );
      }
    }
    if (
      confirmedBy.length > 0 &&
      (hasDuplicateStrings(confirmedBy) ||
        (hasSourceRef && confirmedBy.some((confirmation) => confirmation === sourceRef)))
    ) {
      issues.push(
        auditIssue(
          method,
          'confirmation-source-conflict',
          'error',
          'confirmedBy sources must be distinct and cannot repeat the original sourceRef',
        ),
      );
    }
    if (
      method.trustKind === 'trusted' &&
      staleBefore !== undefined &&
      method.created < staleBefore
    ) {
      issues.push(
        auditIssue(
          method,
          'stale-trusted',
          'warning',
          'trusted memory is older than the active max-age policy',
        ),
      );
    }
  }
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  return {
    checked: methods.length,
    issueCount: issues.length,
    errorCount,
    warningCount: issues.length - errorCount,
    issues,
  };
};
