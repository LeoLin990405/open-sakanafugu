import { createHash } from 'node:crypto';
import { join as joinPath } from 'node:path';

import { Command, Option } from 'clipanion';

import { FsExperienceStore } from '../../adapters/experience/fs-experience-store.js';
import {
  EXPERIENCE_SOURCE_KINDS,
  EXPERIENCE_TRUST_FILTERS,
  EXPERIENCE_TRUST_KINDS,
  FAILURE_CAUSES,
  auditExperienceMethods,
  explainRecallMatch,
  experiencePolicyCard,
  isExperienceSourceKind,
  isFailureCause,
  isExperienceTrustFilter,
  isExperienceTrustKind,
  renderExperiencePolicyCard,
} from '../../domain/experience.js';
import type {
  ExperienceSourceKind,
  ExperienceTrustFilter,
  FailureCause,
  Method,
  RecallOptions,
} from '../../domain/experience.js';
import { isOk } from '../../domain/result.js';
import { systemClock } from '../../infra/clock.js';
import { NodeFileSystem } from '../../infra/node-file-system.js';
import { defaultExperienceDir } from '../default-paths.js';

const fs = (): NodeFileSystem => new NodeFileSystem();

const readStream = async (stream: NodeJS.ReadableStream): Promise<string> => {
  let out = '';
  for await (const chunk of stream) {
    out += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  }
  return out.replace(/\n$/u, '');
};

const renderRecall = (title: string, body: string): string => `[experience] ${title}\n${body}\n\n`;

const renderRecallExplanation = (
  method: Pick<Method, 'title' | 'body' | 'sourceKind' | 'sourceRef' | 'trustKind'>,
  options: RecallOptions,
): string => {
  const explanation = explainRecallMatch(method, options);
  const matched = explanation.matchedTerms.length === 0 ? '-' : explanation.matchedTerms.join(',');
  const failureCause = explanation.failureCause ?? '-';
  const filter = options.failureCause ?? '-';
  const minScore = explanation.minScore ?? '-';
  const sourceFilter = explanation.sourceFilter ?? '-';
  const sourceRefFilter = explanation.sourceRefFilter ?? '-';
  const trustFilter = explanation.trustFilter ?? '-';
  const supersededFilter = explanation.includeSuperseded === true ? 'include' : 'hide';
  const maxAgeDays =
    explanation.maxAgeSeconds === undefined ? '-' : String(explanation.maxAgeSeconds / 86_400);
  const source =
    explanation.sourceRef === undefined
      ? explanation.sourceKind
      : `${explanation.sourceKind}:${explanation.sourceRef}`;
  return `[experience:explain] score=${explanation.score} minScore=${minScore} maxAgeDays=${maxAgeDays} matched=${matched} failureCause=${failureCause} filter=${filter} sourceFilter=${sourceFilter} sourceRefFilter=${sourceRefFilter} trustFilter=${trustFilter} supersededFilter=${supersededFilter} source=${source} trust=${explanation.trustKind}\n`;
};

interface RecallJsonBaseEntry {
  readonly workspace: string;
  readonly title: string;
  readonly slug: string;
  readonly created: number;
  readonly sourceKind: ExperienceSourceKind;
  readonly sourceRef?: string;
  readonly trustKind: Method['trustKind'];
  readonly confirmedBy?: readonly string[];
  readonly supersedes?: readonly string[];
  readonly failureCause?: FailureCause;
  readonly score: number;
  readonly matchedTerms: readonly string[];
}

interface RecallJsonBodyEntry extends RecallJsonBaseEntry {
  readonly body: string;
}

interface RecallJsonMetadataOnlyEntry extends RecallJsonBaseEntry {
  readonly bodySha256: string;
  readonly bodyChars: number;
}

type RecallJsonEntry = RecallJsonBodyEntry | RecallJsonMetadataOnlyEntry;

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const recallJsonEntry = (
  method: Method,
  options: RecallOptions,
  metadataOnly: boolean,
): RecallJsonEntry => {
  const explanation = explainRecallMatch(method, options);
  const base = {
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
    ...(explanation.failureCause === undefined ? {} : { failureCause: explanation.failureCause }),
    score: explanation.score,
    matchedTerms: explanation.matchedTerms,
  };
  if (metadataOnly) {
    return {
      ...base,
      bodySha256: sha256(method.body),
      bodyChars: Array.from(method.body).length,
    };
  }
  return {
    ...base,
    body: method.body,
  };
};

const parseLimit = (raw: string): number => {
  const limit = Number.parseInt(raw, 10);
  return Number.isFinite(limit) ? limit : 3;
};

const parseMinScore = (raw: string | undefined): number | null | undefined => {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : null;
};

const parseMaxAgeDays = (raw: string | undefined): number | null | undefined => {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!/^\d+$/u.test(value)) return null;
  const days = Number.parseInt(value, 10);
  if (days <= 0) return null;
  const seconds = days * 86_400;
  return Number.isSafeInteger(seconds) ? seconds : null;
};

const parsePositiveIntegerValue = (value: unknown): number | null | undefined => {
  if (value === undefined) return undefined;
  return Number.isInteger(value) && typeof value === 'number' && value > 0 ? value : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type JsonParseResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

const parseJsonUnknown = (content: string): JsonParseResult => {
  try {
    return { ok: true, value: JSON.parse(content) as unknown };
  } catch {
    return { ok: false };
  }
};

const field = (content: string, key: string): string => {
  const prefix = `${key}:`;
  const line = content.split(/\r?\n/u).find((entry) => entry.startsWith(prefix));
  return line === undefined ? '' : line.slice(prefix.length).trim();
};

const section = (content: string, name: string): string => {
  const lines = content.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `## ${name}`);
  if (start === -1) return '';
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    body.push(line);
  }
  return body.join('\n').trim();
};

const meaningfulLogLines = (log: string): readonly string[] => {
  const lines = log
    .split(/\r?\n/u)
    .map((line) => line.replace(/^- /u, '').trim())
    .filter((line) => line.length > 0);
  const preferred = lines.filter((line) =>
    /accepted|ci|failed|fix|green|review|selected|verification|verified/u.test(line.toLowerCase()),
  );
  return (preferred.length > 0 ? preferred : lines).slice(-12);
};

const renderTaskExperience = (
  path: string,
  content: string,
  options: { readonly lesson?: string; readonly failureCause?: string } = {},
): string => {
  const taskTitle = content.split(/\r?\n/u).find((line) => line.startsWith('# ')) ?? '# TASK';
  const status = field(content, 'Status');
  const completed = field(content, 'Completed');
  const requirements = section(content, 'Requirements');
  const outputFiles = section(content, 'Output files');
  const log = meaningfulLogLines(section(content, 'Log'));
  const completion =
    completed.length > 0 && completed !== '-'
      ? `Status: ${status} (completed ${completed})`
      : `Status: ${status}`;
  const notes =
    log.length === 0
      ? '- No audit log lines were present.'
      : log.map((line) => `- ${line}`).join('\n');
  return [
    `Source task: ${path}`,
    `Task: ${taskTitle.replace(/^#\s*/u, '')}`,
    completion,
    '',
    'Requirements:',
    requirements.length > 0 ? requirements : '(none recorded)',
    '',
    'Output files:',
    outputFiles.length > 0 ? outputFiles : '(none recorded)',
    '',
    ...(options.failureCause === undefined ? [] : ['Failure cause:', options.failureCause, '']),
    ...(options.lesson === undefined ? [] : ['Relabeled lesson:', options.lesson, '']),
    'Reusable audit notes:',
    notes,
  ].join('\n');
};

const isCompletedTask = (content: string): boolean =>
  field(content, 'Status') === 'DONE' && !['', '-'].includes(field(content, 'Completed'));

const TERMINAL_FAILURE_STATUSES = new Set(['NEEDS_FIX', 'FAILED', 'BLOCKED']);

const isTerminalFailedTask = (content: string): boolean => {
  const status = field(content, 'Status');
  return TERMINAL_FAILURE_STATUSES.has(status) && !['', '-'].includes(field(content, 'Completed'));
};

const normalizeFailureCause = (raw: string | undefined): string | undefined =>
  raw?.trim().toLowerCase();

const failureCauseError = (cause: string | undefined): string => {
  const rendered = cause === undefined || cause.length === 0 ? '<empty>' : cause;
  return `unknown --failure-cause ${rendered}; expected one of ${FAILURE_CAUSES.join(', ')}\n`;
};

const normalizeSourceKind = (raw: string | undefined): string | undefined =>
  raw?.trim().toLowerCase();

const sourceKindError = (sourceKind: string | undefined): string => {
  const rendered = sourceKind === undefined || sourceKind.length === 0 ? '<empty>' : sourceKind;
  return `unknown --source ${rendered}; expected one of ${EXPERIENCE_SOURCE_KINDS.join(', ')}\n`;
};

const sourceRefError = (): string => '--source-ref must be a non-empty string\n';

const singleLine = (value: string): string => value.replace(/[\r\n]+/gu, ' ').trim();

const parseSupersedes = (raw: readonly string[]): readonly string[] | null => {
  const slugs: string[] = [];
  for (const value of raw) {
    const parts = singleLine(value)
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length === 0) return null;
    slugs.push(...parts);
  }
  return [...new Set(slugs)];
};

const supersedesError = (): string => '--supersedes must be a non-empty slug\n';

const parseConfirmationRefs = (raw: readonly string[]): readonly string[] | null => {
  const refs: string[] = [];
  for (const value of raw) {
    const ref = singleLine(value);
    if (ref.length === 0) return null;
    refs.push(ref);
  }
  return refs;
};

const confirmationRefsError = (): string =>
  '--confirm-source-ref must be a non-empty source reference\n';

const normalizeTrustKind = (raw: string | undefined): string | undefined =>
  raw?.trim().toLowerCase();

const trustKindError = (trustKind: string | undefined): string => {
  const rendered = trustKind === undefined || trustKind.length === 0 ? '<empty>' : trustKind;
  return `unknown --trust ${rendered}; expected one of ${EXPERIENCE_TRUST_KINDS.join(', ')}\n`;
};

const trustFilterError = (trustFilter: string | undefined): string => {
  const rendered = trustFilter === undefined || trustFilter.length === 0 ? '<empty>' : trustFilter;
  return `unknown --trust ${rendered}; expected one of ${EXPERIENCE_TRUST_FILTERS.join(', ')}\n`;
};

interface ExperienceEvalCase {
  readonly id: string;
  readonly query: string;
  readonly expectedSlugs: readonly string[];
  readonly limit?: number;
  readonly minScore?: number;
  readonly failureCause?: FailureCause;
  readonly sourceKind?: ExperienceSourceKind;
  readonly sourceRef?: string;
  readonly trust?: ExperienceTrustFilter;
  readonly maxAgeSeconds?: number;
  readonly includeSuperseded?: boolean;
}

interface ExperienceEvalCaseResult {
  readonly id: string;
  readonly query: string;
  readonly expectedSlugs: readonly string[];
  readonly retrievedSlugs: readonly string[];
  readonly relevantRetrieved: readonly string[];
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly hit: boolean;
  readonly mrr: number;
  readonly passed: boolean;
}

interface ExperienceEvalSummary {
  readonly workspace: string;
  readonly caseCount: number;
  readonly passed: number;
  readonly failed: number;
  readonly meanPrecision: number;
  readonly meanRecall: number;
  readonly meanF1: number;
  readonly hitRate: number;
  readonly meanMrr: number;
  readonly cases: readonly ExperienceEvalCaseResult[];
}

const parseStringList = (value: unknown): readonly string[] | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const values = value.map((entry) => (typeof entry === 'string' ? entry.trim() : ''));
  return values.every((entry) => entry.length > 0) ? [...new Set(values)] : null;
};

const parseEvalCase = (value: unknown, index: number): ExperienceEvalCase | string => {
  if (!isRecord(value)) return `case ${index + 1} must be an object`;
  const idValue = value.id;
  if (idValue !== undefined && (typeof idValue !== 'string' || idValue.trim().length === 0)) {
    return `case ${index + 1} id must be a non-empty string`;
  }
  const queryValue = value.query;
  if (typeof queryValue !== 'string' || queryValue.trim().length === 0) {
    return `case ${index + 1} query must be a non-empty string`;
  }
  const expectedSlugs = parseStringList(value.expectedSlugs);
  if (expectedSlugs === null) {
    return `case ${index + 1} expectedSlugs must be a non-empty string array`;
  }
  const limit = parsePositiveIntegerValue(value.limit);
  if (limit === null) return `case ${index + 1} limit must be a positive integer`;
  const minScore = parsePositiveIntegerValue(value.minScore);
  if (minScore === null) return `case ${index + 1} minScore must be a positive integer`;
  const maxAgeDays = parsePositiveIntegerValue(value.maxAgeDays);
  if (maxAgeDays === null) return `case ${index + 1} maxAgeDays must be a positive integer`;
  const maxAgeSeconds = maxAgeDays === undefined ? undefined : maxAgeDays * 86_400;
  if (maxAgeSeconds !== undefined && !Number.isSafeInteger(maxAgeSeconds)) {
    return `case ${index + 1} maxAgeDays is too large`;
  }
  const failureCause = normalizeFailureCause(
    typeof value.failureCause === 'string' ? value.failureCause : undefined,
  );
  if (
    value.failureCause !== undefined &&
    (failureCause === undefined || !isFailureCause(failureCause))
  ) {
    return `case ${index + 1} failureCause must be one of ${FAILURE_CAUSES.join(', ')}`;
  }
  const sourceKind = normalizeSourceKind(
    typeof value.source === 'string' ? value.source : undefined,
  );
  if (
    value.source !== undefined &&
    (sourceKind === undefined || !isExperienceSourceKind(sourceKind))
  ) {
    return `case ${index + 1} source must be one of ${EXPERIENCE_SOURCE_KINDS.join(', ')}`;
  }
  const sourceRef = typeof value.sourceRef === 'string' ? value.sourceRef.trim() : undefined;
  if (value.sourceRef !== undefined && (sourceRef === undefined || sourceRef.length === 0)) {
    return `case ${index + 1} sourceRef must be a non-empty string`;
  }
  const trust = normalizeTrustKind(typeof value.trust === 'string' ? value.trust : undefined);
  if (value.trust !== undefined && (trust === undefined || !isExperienceTrustFilter(trust))) {
    return `case ${index + 1} trust must be one of ${EXPERIENCE_TRUST_FILTERS.join(', ')}`;
  }
  if (value.includeSuperseded !== undefined && typeof value.includeSuperseded !== 'boolean') {
    return `case ${index + 1} includeSuperseded must be a boolean`;
  }
  return {
    id: idValue === undefined ? `case-${index + 1}` : idValue.trim(),
    query: queryValue,
    expectedSlugs,
    ...(limit === undefined ? {} : { limit }),
    ...(minScore === undefined ? {} : { minScore }),
    ...(failureCause !== undefined && isFailureCause(failureCause) ? { failureCause } : {}),
    ...(sourceKind !== undefined && isExperienceSourceKind(sourceKind) ? { sourceKind } : {}),
    ...(sourceRef === undefined ? {} : { sourceRef }),
    ...(trust !== undefined && isExperienceTrustFilter(trust) ? { trust } : {}),
    ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds }),
    ...(value.includeSuperseded === undefined
      ? {}
      : { includeSuperseded: value.includeSuperseded }),
  };
};

const parseEvalCases = (content: string): readonly ExperienceEvalCase[] | string => {
  const trimmed = content.trim();
  if (trimmed.length === 0) return 'cases file is empty';
  const parsed: unknown[] = [];
  if (trimmed.startsWith('[')) {
    const result = parseJsonUnknown(trimmed);
    if (!result.ok) return 'cases file is not valid JSON or JSONL';
    if (!Array.isArray(result.value)) return 'cases file must be a JSON array or JSONL records';
    const values: readonly unknown[] = result.value;
    for (const value of values) parsed.push(value);
  } else {
    const lines = trimmed.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    for (const [index, line] of lines.entries()) {
      const result = parseJsonUnknown(line);
      if (!result.ok) return `case ${index + 1} is not valid JSON`;
      parsed.push(result.value);
    }
  }
  const cases: ExperienceEvalCase[] = [];
  for (const [index, value] of parsed.entries()) {
    const parsedCase = parseEvalCase(value, index);
    if (typeof parsedCase === 'string') return parsedCase;
    cases.push(parsedCase);
  }
  return cases.length === 0 ? 'cases file has no cases' : cases;
};

const evalCaseOptions = (evalCase: ExperienceEvalCase): RecallOptions => ({
  query: evalCase.query,
  ...(evalCase.limit === undefined ? {} : { limit: evalCase.limit }),
  ...(evalCase.minScore === undefined ? {} : { minScore: evalCase.minScore }),
  ...(evalCase.failureCause === undefined ? {} : { failureCause: evalCase.failureCause }),
  ...(evalCase.sourceKind === undefined ? {} : { sourceKind: evalCase.sourceKind }),
  ...(evalCase.sourceRef === undefined ? {} : { sourceRef: evalCase.sourceRef }),
  ...(evalCase.trust === undefined ? {} : { trust: evalCase.trust }),
  ...(evalCase.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: evalCase.maxAgeSeconds }),
  ...(evalCase.includeSuperseded === undefined
    ? {}
    : { includeSuperseded: evalCase.includeSuperseded }),
});

const roundMetric = (value: number): number => Number(value.toFixed(6));

const evalCaseResult = (
  evalCase: ExperienceEvalCase,
  methods: readonly Method[],
): ExperienceEvalCaseResult => {
  const expected = new Set(evalCase.expectedSlugs);
  const retrievedSlugs = methods.map((method) => method.slug);
  const relevantRetrieved = retrievedSlugs.filter((slug) => expected.has(slug));
  const precision =
    retrievedSlugs.length === 0 ? 0 : relevantRetrieved.length / retrievedSlugs.length;
  const recall = relevantRetrieved.length / expected.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const firstRelevantIndex = retrievedSlugs.findIndex((slug) => expected.has(slug));
  const mrr = firstRelevantIndex === -1 ? 0 : 1 / (firstRelevantIndex + 1);
  return {
    id: evalCase.id,
    query: evalCase.query,
    expectedSlugs: evalCase.expectedSlugs,
    retrievedSlugs,
    relevantRetrieved,
    precision: roundMetric(precision),
    recall: roundMetric(recall),
    f1: roundMetric(f1),
    hit: relevantRetrieved.length > 0,
    mrr: roundMetric(mrr),
    passed: precision === 1 && recall === 1,
  };
};

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const evalSummary = (
  workspace: string,
  cases: readonly ExperienceEvalCaseResult[],
): ExperienceEvalSummary => {
  const passed = cases.filter((entry) => entry.passed).length;
  return {
    workspace,
    caseCount: cases.length,
    passed,
    failed: cases.length - passed,
    meanPrecision: roundMetric(mean(cases.map((entry) => entry.precision))),
    meanRecall: roundMetric(mean(cases.map((entry) => entry.recall))),
    meanF1: roundMetric(mean(cases.map((entry) => entry.f1))),
    hitRate: roundMetric(mean(cases.map((entry) => (entry.hit ? 1 : 0)))),
    meanMrr: roundMetric(mean(cases.map((entry) => entry.mrr))),
    cases,
  };
};

abstract class ExperienceCommand extends Command {
  store = Option.String('--store', defaultExperienceDir());

  protected experienceStore(): FsExperienceStore {
    return new FsExperienceStore(fs(), systemClock, this.store);
  }
}

export class ExperienceAuditCommand extends ExperienceCommand {
  static override paths = [['experience', 'audit']];

  workspace = Option.String({ required: false });
  maxAgeDays = Option.String('--max-age-days');
  json = Option.Boolean('--json', false);

  override async execute(): Promise<number> {
    const maxAgeSeconds = parseMaxAgeDays(this.maxAgeDays);
    if (maxAgeSeconds === null) {
      this.context.stderr.write('unknown --max-age-days; expected a positive integer\n');
      return 1;
    }
    const methods = await this.experienceStore().list(this.workspace);
    const summary = auditExperienceMethods(methods, {
      now: Math.floor(systemClock.now() / 1000),
      ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds }),
    });
    if (this.json) {
      this.context.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else if (summary.issueCount === 0) {
      this.context.stdout.write(`experience audit ok: checked=${summary.checked}\n`);
    } else {
      for (const issue of summary.issues) {
        this.context.stdout.write(
          `[experience:audit] severity=${issue.severity} kind=${issue.kind} memory=${issue.workspace}/${issue.slug} ${issue.detail}\n`,
        );
      }
      this.context.stdout.write(
        `experience audit checked=${summary.checked} issues=${summary.issueCount} errors=${summary.errorCount} warnings=${summary.warningCount}\n`,
      );
    }
    return summary.errorCount > 0 ? 1 : 0;
  }
}

export class ExperienceAddCommand extends ExperienceCommand {
  static override paths = [['experience', 'add']];

  workspace = Option.String();
  title = Option.String();
  from = Option.String('--from');
  trustKind = Option.String('--trust');
  sourceRef = Option.String('--source-ref');
  supersedes = Option.Array('--supersedes', []);

  override async execute(): Promise<number> {
    const trustKind = normalizeTrustKind(this.trustKind);
    if (this.trustKind !== undefined) {
      if (trustKind === undefined || trustKind.length === 0 || !isExperienceTrustKind(trustKind)) {
        this.context.stderr.write(trustKindError(trustKind));
        return 1;
      }
    }
    const sourceRef = this.sourceRef?.trim();
    if (this.sourceRef !== undefined && (sourceRef === undefined || sourceRef.length === 0)) {
      this.context.stderr.write(sourceRefError());
      return 1;
    }
    const supersedes = parseSupersedes(this.supersedes);
    if (supersedes === null) {
      this.context.stderr.write(supersedesError());
      return 1;
    }
    const body =
      this.from === undefined ? await readStream(this.context.stdin) : await fs().read(this.from);
    if (body === null) {
      this.context.stderr.write(`no --from file ${this.from ?? ''}\n`);
      return 1;
    }
    const result = await this.experienceStore().add({
      workspace: this.workspace,
      title: this.title,
      sourceKind: 'manual',
      ...(sourceRef === undefined ? {} : { sourceRef }),
      ...(trustKind !== undefined && isExperienceTrustKind(trustKind) ? { trustKind } : {}),
      ...(supersedes.length === 0 ? {} : { supersedes }),
      body,
    });
    if (!isOk(result)) {
      this.context.stderr.write(`${result.error.detail}\n`);
      return 1;
    }
    this.context.stdout.write(
      `✓ experience stored: ${joinPath(this.store, result.value.workspace, `${result.value.slug}.md`)}\n`,
    );
    return 0;
  }
}

export class ExperienceLearnCommand extends ExperienceCommand {
  static override paths = [['experience', 'learn']];

  workspace = Option.String();
  title = Option.String();
  task = Option.String('--task');
  allowFailure = Option.Boolean('--allow-failure', false);
  lesson = Option.String('--lesson');
  failureCause = Option.String('--failure-cause');
  supersedes = Option.Array('--supersedes', []);

  override async execute(): Promise<number> {
    if (this.task === undefined || this.task.length === 0) {
      this.context.stderr.write('need --task <TASK.md>\n');
      return 1;
    }
    const content = await fs().read(this.task);
    if (content === null) {
      this.context.stderr.write(`no --task file ${this.task}\n`);
      return 1;
    }
    const completed = isCompletedTask(content);
    const supersedes = parseSupersedes(this.supersedes);
    if (supersedes === null) {
      this.context.stderr.write(supersedesError());
      return 1;
    }
    const lesson = this.lesson?.trim();
    const failureCauseProvided = this.failureCause !== undefined;
    const failureCause = normalizeFailureCause(this.failureCause);
    if (completed && failureCauseProvided) {
      this.context.stderr.write(
        '--failure-cause is only supported with --allow-failure relabeling\n',
      );
      return 1;
    }
    if (!completed && !this.allowFailure) {
      this.context.stderr.write(
        'task is not DONE with a completion timestamp; run task done first\n',
      );
      return 1;
    }
    if (!completed) {
      if (!isTerminalFailedTask(content)) {
        this.context.stderr.write(
          'failed task learning requires a terminal non-DONE status with a completion timestamp\n',
        );
        return 1;
      }
      if (lesson === undefined || lesson.length === 0) {
        this.context.stderr.write(
          'failed task learning requires --allow-failure and --lesson <reusable lesson>\n',
        );
        return 1;
      }
      if (
        failureCauseProvided &&
        (failureCause === undefined || failureCause.length === 0 || !isFailureCause(failureCause))
      ) {
        this.context.stderr.write(failureCauseError(failureCause));
        return 1;
      }
    }
    let body = renderTaskExperience(this.task, content);
    if (!completed) {
      const relabeledLesson = lesson;
      const relabeledFailureCause =
        failureCause !== undefined && isFailureCause(failureCause) ? failureCause : undefined;
      if (relabeledLesson === undefined || relabeledLesson.length === 0) {
        this.context.stderr.write(
          'failed task learning requires --allow-failure and --lesson <reusable lesson>\n',
        );
        return 1;
      }
      body = renderTaskExperience(
        this.task,
        content,
        relabeledFailureCause === undefined
          ? { lesson: relabeledLesson }
          : { lesson: relabeledLesson, failureCause: relabeledFailureCause },
      );
    }
    const result = await this.experienceStore().add({
      workspace: this.workspace,
      title: this.title,
      sourceKind: 'task',
      sourceRef: this.task,
      ...(supersedes.length === 0 ? {} : { supersedes }),
      body,
    });
    if (!isOk(result)) {
      this.context.stderr.write(`${result.error.detail}\n`);
      return 1;
    }
    this.context.stdout.write(
      `✓ experience learned: ${joinPath(this.store, result.value.workspace, `${result.value.slug}.md`)}\n`,
    );
    return 0;
  }
}

export class ExperiencePromoteCommand extends ExperienceCommand {
  static override paths = [['experience', 'promote']];

  workspace = Option.String();
  slug = Option.String();
  sourceRef = Option.String('--source-ref');
  confirmSourceRefs = Option.Array('--confirm-source-ref', []);

  override async execute(): Promise<number> {
    const sourceRef = this.sourceRef?.trim();
    if (this.sourceRef === undefined || sourceRef === undefined || sourceRef.length === 0) {
      this.context.stderr.write(sourceRefError());
      return 1;
    }
    const confirmSourceRefs = parseConfirmationRefs(this.confirmSourceRefs);
    if (confirmSourceRefs === null || confirmSourceRefs.length === 0) {
      this.context.stderr.write(confirmationRefsError());
      return 1;
    }
    const result = await this.experienceStore().promote({
      workspace: this.workspace,
      slug: this.slug,
      sourceRef,
      confirmSourceRefs,
    });
    if (!isOk(result)) {
      this.context.stderr.write(`${result.error.detail}\n`);
      return 1;
    }
    this.context.stdout.write(
      `✓ experience promoted: ${joinPath(this.store, result.value.workspace, `${result.value.slug}.md`)}\n`,
    );
    return 0;
  }
}

export class ExperienceListCommand extends ExperienceCommand {
  static override paths = [['experience', 'list']];

  workspace = Option.String({ required: false });

  override async execute(): Promise<void> {
    const methods = await this.experienceStore().list(this.workspace);
    if (methods.length === 0) {
      this.context.stdout.write('(no experiences yet)\n');
      return;
    }
    for (const method of methods) {
      this.context.stdout.write(`  ${method.workspace.padEnd(12)} ${method.title}\n`);
    }
  }
}

export class ExperiencePolicyCommand extends ExperienceCommand {
  static override paths = [['experience', 'policy']];

  workspace = Option.String();
  slug = Option.String({ required: false });
  query = Option.String('--query');
  limit = Option.String('--limit', '3');
  failureCause = Option.String('--failure-cause');
  sourceKind = Option.String('--source');
  sourceRef = Option.String('--source-ref');
  trust = Option.String('--trust');
  minScore = Option.String('--min-score');
  maxAgeDays = Option.String('--max-age-days');
  includeSuperseded = Option.Boolean('--include-superseded', false);
  json = Option.Boolean('--json', false);

  override async execute(): Promise<number> {
    const query = this.query?.trim();
    if (this.query !== undefined && (query === undefined || query.length === 0)) {
      this.context.stderr.write('experience policy needs non-empty --query <text>\n');
      return 1;
    }
    if (this.slug !== undefined && this.query !== undefined) {
      this.context.stderr.write('experience policy accepts either <slug> or --query, not both\n');
      return 1;
    }
    if ((this.slug === undefined || this.slug.trim().length === 0) && query === undefined) {
      this.context.stderr.write('experience policy needs <slug> or --query <text>\n');
      return 1;
    }
    const cause = normalizeFailureCause(this.failureCause);
    if (this.failureCause !== undefined) {
      if (cause === undefined || cause.length === 0 || !isFailureCause(cause)) {
        this.context.stderr.write(failureCauseError(cause));
        return 1;
      }
    }
    const sourceKind = normalizeSourceKind(this.sourceKind);
    if (this.sourceKind !== undefined) {
      if (
        sourceKind === undefined ||
        sourceKind.length === 0 ||
        !isExperienceSourceKind(sourceKind)
      ) {
        this.context.stderr.write(sourceKindError(sourceKind));
        return 1;
      }
    }
    const trustFilter = normalizeTrustKind(this.trust);
    if (this.trust !== undefined) {
      if (
        trustFilter === undefined ||
        trustFilter.length === 0 ||
        !isExperienceTrustFilter(trustFilter)
      ) {
        this.context.stderr.write(trustFilterError(trustFilter));
        return 1;
      }
    }
    const sourceRef = this.sourceRef?.trim();
    if (this.sourceRef !== undefined && (sourceRef === undefined || sourceRef.length === 0)) {
      this.context.stderr.write(sourceRefError());
      return 1;
    }
    const minScore = parseMinScore(this.minScore);
    if (minScore === null) {
      this.context.stderr.write('unknown --min-score; expected a positive integer\n');
      return 1;
    }
    if (minScore !== undefined && query === undefined) {
      this.context.stderr.write('--min-score requires a non-empty --query\n');
      return 1;
    }
    const maxAgeSeconds = parseMaxAgeDays(this.maxAgeDays);
    if (maxAgeSeconds === null) {
      this.context.stderr.write('unknown --max-age-days; expected a positive integer\n');
      return 1;
    }
    let options: RecallOptions = { limit: parseLimit(this.limit) };
    if (query !== undefined) {
      options = { ...options, query };
    }
    const recallFailureCause: FailureCause | undefined =
      cause !== undefined && isFailureCause(cause) ? cause : undefined;
    if (recallFailureCause !== undefined) {
      options = { ...options, failureCause: recallFailureCause };
    }
    const recallSourceKind: ExperienceSourceKind | undefined =
      sourceKind !== undefined && isExperienceSourceKind(sourceKind) ? sourceKind : undefined;
    if (recallSourceKind !== undefined) {
      options = { ...options, sourceKind: recallSourceKind };
    }
    if (sourceRef !== undefined) {
      options = { ...options, sourceRef };
    }
    const recallTrustFilter: ExperienceTrustFilter | undefined =
      trustFilter !== undefined && isExperienceTrustFilter(trustFilter) ? trustFilter : undefined;
    if (recallTrustFilter !== undefined) {
      options = { ...options, trust: recallTrustFilter };
    }
    if (minScore !== undefined) {
      options = { ...options, minScore };
    }
    if (maxAgeSeconds !== undefined) {
      options = { ...options, maxAgeSeconds };
    }
    if (this.includeSuperseded) {
      options = { ...options, includeSuperseded: true };
    }
    const store = this.experienceStore();
    let missingExact = false;
    const methods: readonly Method[] =
      this.slug === undefined
        ? await store.recall(this.workspace, options)
        : await (async (): Promise<readonly Method[]> => {
            const method = await store.get(this.workspace, this.slug ?? '');
            if (method === null) {
              missingExact = true;
              this.context.stderr.write(`no experience ${this.workspace}/${this.slug ?? ''}\n`);
              return [];
            }
            const workspaceMethods = await store.list(this.workspace);
            const filtered = await store.recall(this.workspace, {
              ...options,
              limit: Math.max(1, workspaceMethods.length),
            });
            return filtered.some((entry) => entry.slug === method.slug) ? [method] : [];
          })();
    if (missingExact) return 1;
    const cards = methods.map(experiencePolicyCard);
    if (this.json) {
      this.context.stdout.write(`${JSON.stringify(cards, null, 2)}\n`);
    } else {
      for (const card of cards) {
        this.context.stdout.write(renderExperiencePolicyCard(card));
      }
    }
    return 0;
  }
}

export class ExperienceRecallCommand extends ExperienceCommand {
  static override paths = [['experience', 'recall']];

  workspace = Option.String();
  query = Option.String('--query');
  limit = Option.String('--limit', '3');
  failureCause = Option.String('--failure-cause');
  sourceKind = Option.String('--source');
  sourceRef = Option.String('--source-ref');
  trust = Option.String('--trust');
  minScore = Option.String('--min-score');
  maxAgeDays = Option.String('--max-age-days');
  includeSuperseded = Option.Boolean('--include-superseded', false);
  explain = Option.Boolean('--explain', false);
  json = Option.Boolean('--json', false);
  metadataOnly = Option.Boolean('--metadata-only', false);

  override async execute(): Promise<number> {
    const cause = normalizeFailureCause(this.failureCause);
    if (this.failureCause !== undefined) {
      if (cause === undefined || cause.length === 0 || !isFailureCause(cause)) {
        this.context.stderr.write(failureCauseError(cause));
        return 1;
      }
    }
    const sourceKind = normalizeSourceKind(this.sourceKind);
    if (this.sourceKind !== undefined) {
      if (
        sourceKind === undefined ||
        sourceKind.length === 0 ||
        !isExperienceSourceKind(sourceKind)
      ) {
        this.context.stderr.write(sourceKindError(sourceKind));
        return 1;
      }
    }
    const trustFilter = normalizeTrustKind(this.trust);
    if (this.trust !== undefined) {
      if (
        trustFilter === undefined ||
        trustFilter.length === 0 ||
        !isExperienceTrustFilter(trustFilter)
      ) {
        this.context.stderr.write(trustFilterError(trustFilter));
        return 1;
      }
    }
    const sourceRef = this.sourceRef?.trim();
    if (this.sourceRef !== undefined && (sourceRef === undefined || sourceRef.length === 0)) {
      this.context.stderr.write(sourceRefError());
      return 1;
    }
    const minScore = parseMinScore(this.minScore);
    if (minScore === null) {
      this.context.stderr.write('unknown --min-score; expected a positive integer\n');
      return 1;
    }
    if (minScore !== undefined && (this.query === undefined || this.query.trim().length === 0)) {
      this.context.stderr.write('--min-score requires a non-empty --query\n');
      return 1;
    }
    const maxAgeSeconds = parseMaxAgeDays(this.maxAgeDays);
    if (maxAgeSeconds === null) {
      this.context.stderr.write('unknown --max-age-days; expected a positive integer\n');
      return 1;
    }
    let options: RecallOptions = { limit: parseLimit(this.limit) };
    if (this.query !== undefined) {
      options = { ...options, query: this.query };
    }
    const recallFailureCause: FailureCause | undefined =
      cause !== undefined && isFailureCause(cause) ? cause : undefined;
    if (recallFailureCause !== undefined) {
      options = { ...options, failureCause: recallFailureCause };
    }
    const recallSourceKind: ExperienceSourceKind | undefined =
      sourceKind !== undefined && isExperienceSourceKind(sourceKind) ? sourceKind : undefined;
    if (recallSourceKind !== undefined) {
      options = { ...options, sourceKind: recallSourceKind };
    }
    if (sourceRef !== undefined) {
      options = { ...options, sourceRef };
    }
    const recallTrustFilter: ExperienceTrustFilter | undefined =
      trustFilter !== undefined && isExperienceTrustFilter(trustFilter) ? trustFilter : undefined;
    if (recallTrustFilter !== undefined) {
      options = { ...options, trust: recallTrustFilter };
    }
    if (minScore !== undefined) {
      options = { ...options, minScore };
    }
    if (maxAgeSeconds !== undefined) {
      options = { ...options, maxAgeSeconds };
    }
    if (this.includeSuperseded) {
      options = { ...options, includeSuperseded: true };
    }
    const methods = await this.experienceStore().recall(this.workspace, options);
    if (this.json) {
      this.context.stdout.write(
        `${JSON.stringify(
          methods.map((method) => recallJsonEntry(method, options, this.metadataOnly)),
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    for (const method of methods) {
      if (this.explain) {
        this.context.stdout.write(renderRecallExplanation(method, options));
      }
      this.context.stdout.write(renderRecall(method.title, method.body));
    }
    return 0;
  }
}

export class ExperienceEvalCommand extends ExperienceCommand {
  static override paths = [['experience', 'eval']];

  workspace = Option.String();
  casesPath = Option.String('--cases');
  json = Option.Boolean('--json', false);

  override async execute(): Promise<number> {
    if (this.casesPath === undefined || this.casesPath.trim().length === 0) {
      this.context.stderr.write('need --cases <file>\n');
      return 1;
    }
    if (!this.json) {
      this.context.stderr.write('experience eval currently requires --json\n');
      return 1;
    }
    const content = await fs().read(this.casesPath);
    if (content === null) {
      this.context.stderr.write(`no --cases file ${this.casesPath}\n`);
      return 1;
    }
    const cases = parseEvalCases(content);
    if (typeof cases === 'string') {
      this.context.stderr.write(`invalid --cases: ${cases}\n`);
      return 1;
    }
    const results: ExperienceEvalCaseResult[] = [];
    const store = this.experienceStore();
    for (const evalCase of cases) {
      const methods = await store.recall(this.workspace, evalCaseOptions(evalCase));
      results.push(evalCaseResult(evalCase, methods));
    }
    this.context.stdout.write(`${JSON.stringify(evalSummary(this.workspace, results), null, 2)}\n`);
    return 0;
  }
}

export class ExperienceShowCommand extends ExperienceCommand {
  static override paths = [['experience', 'show']];

  workspace = Option.String();
  slug = Option.String();

  override async execute(): Promise<number> {
    const path = joinPath(this.store, this.workspace, `${this.slug}.md`);
    const content = await fs().read(path);
    if (content === null) {
      this.context.stderr.write(`no experience ${this.workspace}/${this.slug}\n`);
      return 1;
    }
    this.context.stdout.write(content);
    return 0;
  }
}
