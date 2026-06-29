import { describe, expect, it } from 'vitest';

import {
  TASK_CONTEXT_DIGEST_SCHEMA_VERSION,
  renderTaskContextDigest,
  taskContextDigest,
} from './task-context-digest.js';

const sampleTask = (): string =>
  [
    '# TASK-2026-06-29-028: Add research-backed context digest cards',
    'Status: IN_PROGRESS',
    'Priority: P1',
    '',
    '## Requirements',
    '- Preserve original task constraints.',
    '- Keep the digest bounded.',
    '',
    '## Subtasks',
    '- [x] Research papers',
    '- [ ] Implement digest command',
    '- [ ] Final Review (Reviewer: coder)',
    '',
    '## Output files',
    '- engine/src/domain/task-context-digest.ts',
    '- README.md',
    '',
    '## Log',
    '- [2026-06-29 11:20] First evidence.',
    '- [2026-06-29 11:21] Second evidence.',
    '- [2026-06-29 11:22] Third evidence.',
  ].join('\n');

describe('taskContextDigest', () => {
  it('builds a provenance-bearing bounded digest from a task file', () => {
    const digest = taskContextDigest(sampleTask(), {
      sourceRef: '/tmp/TASK.md',
      sourceSha256: 'abc123',
      budgetChars: 1_000,
      maxEvidence: 2,
    });

    expect(digest.schemaVersion).toBe(TASK_CONTEXT_DIGEST_SCHEMA_VERSION);
    expect(digest).toMatchObject({
      taskId: 'TASK-2026-06-29-028',
      title: 'Add research-backed context digest cards',
      status: 'IN_PROGRESS',
      sourceRef: '/tmp/TASK.md',
      sourceSha256: 'abc123',
      budgetChars: 1_000,
      maxEvidence: 2,
    });
    expect(digest.sourceChars).toBe(sampleTask().length);
    expect(digest.units.map((unit) => unit.kind)).toEqual([
      'goal',
      'requirement',
      'requirement',
      'open-subtask',
      'open-subtask',
      'handoff-object',
      'handoff-object',
      'recent-evidence',
      'recent-evidence',
    ]);
    expect(digest.units.some((unit) => unit.text.includes('First evidence'))).toBe(false);
    expect(digest.units.some((unit) => unit.text.includes('Second evidence'))).toBe(true);
  });

  it('omits whole context units when the budget is exhausted', () => {
    const digest = taskContextDigest(sampleTask(), {
      sourceRef: '/tmp/TASK.md',
      sourceSha256: 'abc123',
      budgetChars: 700,
      maxEvidence: 3,
    });
    const rendered = renderTaskContextDigest(digest);

    expect(rendered.length).toBeLessThanOrEqual(700);
    expect(digest.units.length).toBeGreaterThan(0);
    expect(digest.units.map((unit) => unit.kind)).toContain('goal');
    expect(digest.omitted.units).toBeGreaterThan(0);
  });
});

describe('renderTaskContextDigest', () => {
  it('renders parse-stable markdown cards with source hash evidence', () => {
    const digest = taskContextDigest(sampleTask(), {
      sourceRef: '/tmp/TASK.md',
      sourceSha256: 'abc123',
      budgetChars: 900,
      maxEvidence: 1,
    });
    const rendered = renderTaskContextDigest(digest);

    expect(rendered.length).toBeLessThanOrEqual(900);
    expect(rendered).toContain(
      '[task:digest] TASK-2026-06-29-028: Add research-backed context digest cards',
    );
    expect(rendered).toContain('"schemaVersion":"fugunano.task-context-digest.v1"');
    expect(rendered).toContain('"sourceSha256":"abc123"');
    expect(rendered).toContain('- goal: TASK-2026-06-29-028');
    expect(rendered).toContain('## Omitted Trace');
    expect(rendered).toContain('- sourceSha256: abc123');
  });
});
