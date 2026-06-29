export const TASK_CONTEXT_DIGEST_SCHEMA_VERSION = 'fugunano.task-context-digest.v1';

export type TaskContextDigestUnitKind =
  | 'goal'
  | 'requirement'
  | 'open-subtask'
  | 'handoff-object'
  | 'recent-evidence';

export interface TaskContextDigestUnit {
  readonly kind: TaskContextDigestUnitKind;
  readonly text: string;
  readonly at?: string;
}

export interface TaskContextDigestOmitted {
  readonly units: number;
  readonly chars: number;
  readonly byKind: Readonly<Partial<Record<TaskContextDigestUnitKind, number>>>;
}

export interface TaskContextDigest {
  readonly schemaVersion: typeof TASK_CONTEXT_DIGEST_SCHEMA_VERSION;
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly sourceRef: string;
  readonly sourceSha256: string;
  readonly sourceChars: number;
  readonly budgetChars: number;
  readonly usedChars: number;
  readonly maxEvidence: number;
  readonly units: readonly TaskContextDigestUnit[];
  readonly omitted: TaskContextDigestOmitted;
}

export interface TaskContextDigestOptions {
  readonly sourceRef: string;
  readonly sourceSha256: string;
  readonly budgetChars?: number;
  readonly maxEvidence?: number;
}

const DEFAULT_BUDGET_CHARS = 2_400;
const DEFAULT_MAX_EVIDENCE = 6;

const field = (content: string, name: string): string | undefined => {
  const match = new RegExp(`^${name}:[ \\t]*(.*)$`, 'mu').exec(content);
  const value = match?.[1]?.trim();
  return value === undefined || value.length === 0 || value === '-' ? undefined : value;
};

const taskHeading = (content: string): { readonly taskId: string; readonly title: string } => {
  const heading = /^#\s+([^:\n]+)(?::\s*(.*))?$/mu.exec(content);
  const taskId = heading?.[1]?.trim() ?? 'TASK-unknown';
  const title = heading?.[2]?.trim() ?? taskId;
  return { taskId, title: title.length === 0 ? taskId : title };
};

const sectionLines = (content: string, heading: string): readonly string[] => {
  const lines = content.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/u.test(line)) break;
    out.push(line);
  }
  return out;
};

const cleanListLine = (line: string): string =>
  line
    .trim()
    .replace(/^[-*]\s+/u, '')
    .replace(/^\d+[.)]\s+/u, '')
    .replace(/^\[[ xX]\]\s+/u, '')
    .trim();

const nonPlaceholder = (line: string): boolean =>
  line.length > 0 && line !== '...' && !/^<.*>$/u.test(line);

const sectionItems = (content: string, heading: string): readonly string[] =>
  sectionLines(content, heading)
    .map((line) => cleanListLine(line))
    .filter(nonPlaceholder);

const checklistItem = (
  line: string,
): { readonly text: string; readonly checked: boolean | null } | null => {
  const trimmed = line.trim();
  const checked = /^(?:[-*]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/u.exec(trimmed);
  if (checked !== null) {
    const marker = checked[1] ?? ' ';
    const text = checked[2]?.trim() ?? '';
    return nonPlaceholder(text) ? { text, checked: marker.toLowerCase() === 'x' } : null;
  }

  const text = cleanListLine(line);
  return nonPlaceholder(text) ? { text, checked: null } : null;
};

const openChecklistItems = (content: string): readonly string[] =>
  sectionLines(content, 'Subtasks').flatMap((line) => {
    const item = checklistItem(line);
    if (item === null || item.checked === true) return [];
    return [item.text];
  });

const parseLogEvidence = (
  content: string,
  maxEvidence: number,
): readonly TaskContextDigestUnit[] => {
  const entries = sectionLines(content, 'Log')
    .map((line) => {
      const match = /^-\s+\[([^\]]+)\]\s+(.*)$/u.exec(line.trim());
      if (match === null) return { kind: 'recent-evidence' as const, text: cleanListLine(line) };
      const at = match[1] ?? '';
      const text = match[2]?.trim() ?? '';
      return at.length === 0
        ? { kind: 'recent-evidence' as const, text }
        : { kind: 'recent-evidence' as const, text, at };
    })
    .filter((entry) => entry.text.length > 0);
  return entries.slice(Math.max(0, entries.length - maxEvidence));
};

const unitChars = (unit: TaskContextDigestUnit): number =>
  `${unit.kind}:${unit.at === undefined ? '' : `${unit.at}:`}${unit.text}`.length;

const omitSummary = (units: readonly TaskContextDigestUnit[]): TaskContextDigestOmitted => {
  const byKind: Partial<Record<TaskContextDigestUnitKind, number>> = {};
  for (const unit of units) {
    byKind[unit.kind] = (byKind[unit.kind] ?? 0) + 1;
  }
  return {
    units: units.length,
    chars: units.reduce((sum, unit) => sum + unitChars(unit), 0),
    byKind,
  };
};

const allUnits = (
  content: string,
  heading: { readonly taskId: string; readonly title: string },
  status: string,
  maxEvidence: number,
): readonly TaskContextDigestUnit[] => [
  { kind: 'goal', text: `${heading.taskId}: ${heading.title} (status: ${status})` },
  ...sectionItems(content, 'Requirements').map(
    (text): TaskContextDigestUnit => ({
      kind: 'requirement',
      text,
    }),
  ),
  ...openChecklistItems(content).map(
    (text): TaskContextDigestUnit => ({
      kind: 'open-subtask',
      text,
    }),
  ),
  ...sectionItems(content, 'Output files').map(
    (text): TaskContextDigestUnit => ({
      kind: 'handoff-object',
      text,
    }),
  ),
  ...parseLogEvidence(content, maxEvidence),
];

export const taskContextDigest = (
  content: string,
  options: TaskContextDigestOptions,
): TaskContextDigest => {
  const budgetChars = options.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const maxEvidence = options.maxEvidence ?? DEFAULT_MAX_EVIDENCE;
  const heading = taskHeading(content);
  const status = field(content, 'Status') ?? 'UNKNOWN';
  const units = allUnits(content, heading, status, maxEvidence);
  const selected: TaskContextDigestUnit[] = [];
  let omitted: readonly TaskContextDigestUnit[] = units;
  let usedChars = 0;

  const digestOf = (
    chosen: readonly TaskContextDigestUnit[],
    skipped: readonly TaskContextDigestUnit[],
    chosenChars: number,
  ): TaskContextDigest => ({
    schemaVersion: TASK_CONTEXT_DIGEST_SCHEMA_VERSION,
    taskId: heading.taskId,
    title: heading.title,
    status,
    sourceRef: options.sourceRef,
    sourceSha256: options.sourceSha256,
    sourceChars: content.length,
    budgetChars,
    usedChars: chosenChars,
    maxEvidence,
    units: chosen,
    omitted: omitSummary(skipped),
  });

  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (unit === undefined) continue;
    const chars = unitChars(unit);
    const candidateSelected = [...selected, unit];
    const candidateOmitted = units.slice(index + 1);
    const candidate = digestOf(candidateSelected, candidateOmitted, usedChars + chars);
    if (renderTaskContextDigest(candidate).length <= budgetChars) {
      selected.push(unit);
      usedChars += chars;
      omitted = candidateOmitted;
    } else {
      omitted = units.slice(index);
      break;
    }
  }

  return digestOf(selected, omitted, usedChars);
};

function renderUnit(unit: TaskContextDigestUnit): string {
  const prefix = unit.at === undefined ? unit.kind : `${unit.kind} ${unit.at}`;
  return `- ${prefix}: ${unit.text}`;
}

export function renderTaskContextDigest(digest: TaskContextDigest): string {
  const metadata = {
    schemaVersion: digest.schemaVersion,
    taskId: digest.taskId,
    status: digest.status,
    sourceRef: digest.sourceRef,
    sourceSha256: digest.sourceSha256,
    sourceChars: digest.sourceChars,
    budgetChars: digest.budgetChars,
    usedChars: digest.usedChars,
    omittedUnits: digest.omitted.units,
  };
  return [
    `[task:digest] ${digest.taskId}: ${digest.title}`,
    `[task:digest:meta] ${JSON.stringify(metadata)}`,
    '## Context Cards',
    ...(digest.units.length === 0
      ? ['- card: (none within budget)']
      : digest.units.map(renderUnit)),
    '## Omitted Trace',
    `- omitted: ${digest.omitted.units} unit${digest.omitted.units === 1 ? '' : 's'} / ${digest.omitted.chars} chars`,
    `- source: ${digest.sourceRef}`,
    `- sourceSha256: ${digest.sourceSha256}`,
    '',
  ].join('\n');
}
