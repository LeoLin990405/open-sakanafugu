import { describe, expect, it } from 'vitest';

import {
  auditExperienceMethods,
  explainRecallMatch,
  experiencePolicyCard,
  packExperienceMethodsForPrompt,
  renderExperienceMethod,
  renderExperiencePolicyCard,
} from './experience.js';
import type { Method } from './experience.js';

describe('explainRecallMatch', () => {
  it('reports query score, matched terms, and stored failure cause', () => {
    const explanation = explainRecallMatch(
      {
        title: 'retrieval relabel',
        body: [
          'Failure cause:',
          'retrieval',
          '',
          'Relabeled lesson:',
          'Score dispatch output retrieval by title/body tokens.',
        ].join('\n'),
      },
      { query: 'dispatch output', failureCause: 'retrieval' },
    );

    expect(explanation).toEqual({
      score: 2,
      matchedTerms: ['dispatch', 'output'],
      sourceKind: 'manual',
      trustKind: 'trusted',
      failureCause: 'retrieval',
    });
  });

  it('does not treat query stop words as matched evidence', () => {
    const explanation = explainRecallMatch(
      {
        title: 'recent unrelated',
        body: 'Refresh onboarding prose.',
      },
      { query: 'the and to' },
    );

    expect(explanation).toEqual({
      score: 0,
      matchedTerms: [],
      sourceKind: 'manual',
      trustKind: 'trusted',
    });
  });

  it('includes the active minimum score gate when provided', () => {
    const explanation = explainRecallMatch(
      {
        title: 'dispatch retrieval',
        body: 'Use dispatch output anchors.',
      },
      { query: 'dispatch output anchors', minScore: 2 },
    );

    expect(explanation).toEqual({
      score: 3,
      matchedTerms: ['dispatch', 'output', 'anchors'],
      sourceKind: 'manual',
      trustKind: 'trusted',
      minScore: 2,
    });
  });

  it('reports stored provenance when available', () => {
    const explanation = explainRecallMatch(
      {
        title: 'task-derived retro',
        body: 'Use source task provenance in recall audits.',
        sourceKind: 'task',
        sourceRef: '/tmp/TASK.md',
        trustKind: 'trusted',
      },
      { query: 'source task provenance' },
    );

    expect(explanation).toEqual({
      score: 3,
      matchedTerms: ['source', 'task', 'provenance'],
      sourceKind: 'task',
      sourceRef: '/tmp/TASK.md',
      trustKind: 'trusted',
    });
  });

  it('includes the active source filter when provided', () => {
    const explanation = explainRecallMatch(
      {
        title: 'task-derived retro',
        body: 'Use task provenance in recall audits.',
        sourceKind: 'task',
        sourceRef: '/tmp/TASK.md',
        trustKind: 'trusted',
      },
      { query: 'task provenance', sourceKind: 'task' },
    );

    expect(explanation).toEqual({
      score: 2,
      matchedTerms: ['task', 'provenance'],
      sourceKind: 'task',
      sourceRef: '/tmp/TASK.md',
      trustKind: 'trusted',
      sourceFilter: 'task',
    });
  });

  it('includes the active source reference filter when provided', () => {
    const explanation = explainRecallMatch(
      {
        title: 'task-derived retro',
        body: 'Use task provenance in recall audits.',
        sourceKind: 'task',
        sourceRef: '/tmp/TASK.md',
        trustKind: 'trusted',
      },
      { query: 'task provenance', sourceKind: 'task', sourceRef: '/tmp/TASK.md' },
    );

    expect(explanation).toEqual({
      score: 2,
      matchedTerms: ['task', 'provenance'],
      sourceKind: 'task',
      sourceRef: '/tmp/TASK.md',
      trustKind: 'trusted',
      sourceFilter: 'task',
      sourceRefFilter: '/tmp/TASK.md',
    });
  });

  it('reports stored trust and the active trust filter', () => {
    const explanation = explainRecallMatch(
      {
        title: 'web imported note',
        body: 'Treat browser-provided memory as untrusted until reviewed.',
        sourceKind: 'manual',
        trustKind: 'untrusted',
      },
      { query: 'browser memory', trust: 'untrusted' },
    );

    expect(explanation).toEqual({
      score: 2,
      matchedTerms: ['browser', 'memory'],
      sourceKind: 'manual',
      trustKind: 'untrusted',
      trustFilter: 'untrusted',
    });
  });

  it('includes the active max-age gate when provided', () => {
    const explanation = explainRecallMatch(
      {
        title: 'fresh route',
        body: 'Prefer recent routing lessons.',
      },
      { query: 'recent routing', maxAgeSeconds: 86_400 },
    );

    expect(explanation).toEqual({
      score: 2,
      matchedTerms: ['recent', 'routing'],
      sourceKind: 'manual',
      trustKind: 'trusted',
      maxAgeSeconds: 86_400,
    });
  });

  it('includes the active superseded audit mode when provided', () => {
    const explanation = explainRecallMatch(
      {
        title: 'fresh route',
        body: 'Prefer corrected routing lessons.',
      },
      { query: 'corrected routing', includeSuperseded: true },
    );

    expect(explanation).toEqual({
      score: 2,
      matchedTerms: ['corrected', 'routing'],
      sourceKind: 'manual',
      trustKind: 'trusted',
      includeSuperseded: true,
    });
  });
});

describe('renderExperienceMethod', () => {
  it('renders provenance-bearing metadata before the recalled body', () => {
    expect(
      renderExperienceMethod({
        workspace: 'code',
        title: 'retrieval relabel',
        slug: 'retrieval-relabel',
        created: 123,
        sourceKind: 'task',
        sourceRef: '/tmp/TASK.md',
        trustKind: 'trusted',
        supersedes: ['old-route'],
        body: ['Failure cause:', 'retrieval', '', 'Prefer title/body query terms.'].join('\n'),
      }),
    ).toBe(
      [
        '[experience] retrieval relabel',
        '[experience:meta] {"slug":"retrieval-relabel","sourceKind":"task","sourceRef":"/tmp/TASK.md","trustKind":"trusted","created":123,"failureCause":"retrieval","supersedes":["old-route"]}',
        'Failure cause:',
        'retrieval',
        '',
        'Prefer title/body query terms.',
        '',
      ].join('\n'),
    );
  });

  it('uses manual source metadata for legacy-style records', () => {
    expect(
      renderExperienceMethod({
        workspace: 'code',
        title: 'fast path',
        slug: 'fast-path',
        created: 7,
        sourceKind: 'manual',
        trustKind: 'trusted',
        body: 'Reuse this method.',
      }),
    ).toContain(
      '[experience:meta] {"slug":"fast-path","sourceKind":"manual","trustKind":"trusted","created":7}',
    );
  });

  it('keeps source references parse-stable when they contain spaces or key-like text', () => {
    const rendered = renderExperienceMethod({
      workspace: 'code',
      title: 'browser note',
      slug: 'browser-note',
      created: 9,
      sourceKind: 'manual',
      sourceRef: 'browser note trust=untrusted',
      trustKind: 'untrusted',
      body: 'Treat as imported.',
    });

    expect(rendered).toContain(
      '[experience:meta] {"slug":"browser-note","sourceKind":"manual","sourceRef":"browser note trust=untrusted","trustKind":"untrusted","created":9}',
    );
  });
});

describe('packExperienceMethodsForPrompt', () => {
  const method = (overrides: Partial<Method> = {}): Method => ({
    workspace: 'code',
    title: 'memory',
    slug: 'memory',
    created: 10,
    sourceKind: 'manual',
    trustKind: 'trusted',
    body: 'Use this method.',
    ...overrides,
  });
  const renderedBlockChars = (rendered: readonly string[]): number =>
    Array.from(rendered.join('\n').replace(/\s+$/u, '')).length;

  it('keeps all rendered memory when no budget is set', () => {
    const packed = packExperienceMethodsForPrompt([
      method({ title: 'one', slug: 'one', body: 'First method.' }),
      method({ title: 'two', slug: 'two', body: 'Second method.' }),
    ]);

    expect(packed.rendered).toHaveLength(2);
    expect(packed.omitted).toBe(0);
    expect(packed.totalChars).toBe(renderedBlockChars(packed.rendered));
  });

  it('packs whole provenance-bearing memory units within a hard character budget', () => {
    const first = method({ title: 'short', slug: 'short', body: 'Short.' });
    const second = method({ title: 'long', slug: 'long', body: 'Long '.repeat(40) });
    const firstRendered = renderExperienceMethod(first);
    const budget = renderedBlockChars([firstRendered]);
    const packed = packExperienceMethodsForPrompt([first, second], budget);

    expect(packed.rendered).toEqual([firstRendered]);
    expect(packed.omitted).toBe(1);
    expect(packed.totalChars).toBe(budget);
    expect(packed.maxChars).toBe(budget);
  });

  it('accounts for renderer separators between packed memory units', () => {
    const methods = [
      method({ title: 'one', slug: 'one', body: 'One.' }),
      method({ title: 'two', slug: 'two', body: 'Two.' }),
      method({ title: 'three', slug: 'three', body: 'Three.' }),
    ];
    const rendered = methods.map(renderExperienceMethod);
    const budgetMissingThirdSeparator = rendered.reduce(
      (total, entry) => total + Array.from(entry).length,
      0,
    );
    const packed = packExperienceMethodsForPrompt(methods, budgetMissingThirdSeparator);

    expect(packed.rendered).toEqual(rendered.slice(0, 2));
    expect(packed.omitted).toBe(1);
    expect(packed.totalChars).toBeLessThanOrEqual(budgetMissingThirdSeparator);
  });

  it('omits every memory when none fit the budget instead of truncating bodies', () => {
    const packed = packExperienceMethodsForPrompt(
      [method({ title: 'short', slug: 'short', body: 'Short.' })],
      10,
    );

    expect(packed.rendered).toEqual([]);
    expect(packed.omitted).toBe(1);
    expect(packed.totalChars).toBe(0);
  });
});

describe('experiencePolicyCard', () => {
  it('extracts a provenance-bearing policy checklist from task-learned experience', () => {
    const method: Method = {
      workspace: 'code',
      title: 'dispatch retro',
      slug: 'dispatch-retro',
      created: 42,
      sourceKind: 'task',
      sourceRef: '/tmp/TASK.md',
      trustKind: 'trusted',
      supersedes: ['old-retro'],
      body: [
        'Source task: /tmp/TASK.md',
        'Task: TASK: dispatch retro',
        'Status: DONE (completed 2026-06-29)',
        '',
        'Requirements:',
        '- Preserve source provenance.',
        '- Run independent review.',
        '',
        'Output files:',
        '- engine/src/domain/experience.ts',
        '',
        'Reusable audit notes:',
        '- Independent review found a separator-counting bug.',
        '- Full retest green.',
      ].join('\n'),
    };

    const card = experiencePolicyCard(method);

    expect(card).toEqual({
      workspace: 'code',
      title: 'dispatch retro',
      slug: 'dispatch-retro',
      created: 42,
      sourceKind: 'task',
      sourceRef: '/tmp/TASK.md',
      trustKind: 'trusted',
      supersedes: ['old-retro'],
      items: [
        { kind: 'requirement', text: 'Preserve source provenance.' },
        { kind: 'requirement', text: 'Run independent review.' },
        { kind: 'output', text: 'engine/src/domain/experience.ts' },
        { kind: 'audit', text: 'Independent review found a separator-counting bug.' },
        { kind: 'audit', text: 'Full retest green.' },
      ],
    });
    expect(renderExperiencePolicyCard(card)).toContain('[experience:policy] dispatch retro');
    expect(renderExperiencePolicyCard(card)).toContain(
      '- requirement: Preserve source provenance.',
    );
  });

  it('falls back to compact body lines when no known task sections exist', () => {
    const card = experiencePolicyCard({
      workspace: 'code',
      title: 'manual note',
      slug: 'manual-note',
      created: 7,
      sourceKind: 'manual',
      trustKind: 'trusted',
      body: 'Check cache before curl.\nThen update docs.',
    });

    expect(card.items).toEqual([
      { kind: 'body', text: 'Check cache before curl.' },
      { kind: 'body', text: 'Then update docs.' },
    ]);
  });
});

describe('auditExperienceMethods', () => {
  const method = (overrides: Partial<Method> = {}): Method => ({
    workspace: 'code',
    title: 'memory',
    slug: 'memory',
    created: 190,
    sourceKind: 'manual',
    trustKind: 'trusted',
    body: 'Use a stable method.',
    ...overrides,
  });

  it('reports governance issues over the memory lifecycle', () => {
    const summary = auditExperienceMethods(
      [
        method({
          title: 'untrusted import',
          slug: 'untrusted-import',
          trustKind: 'untrusted',
        }),
        method({
          title: 'trusted imported',
          slug: 'trusted-imported',
          sourceRef: 'https://example.test/source',
        }),
        method({
          title: 'untrusted replacement',
          slug: 'untrusted-replacement',
          sourceRef: 'https://example.test/untrusted',
          trustKind: 'untrusted',
          supersedes: ['trusted-imported'],
        }),
        method({
          title: 'missing target',
          slug: 'missing-target',
          supersedes: ['not-present'],
        }),
        method({
          title: 'bad confirmation',
          slug: 'bad-confirmation',
          sourceRef: 'https://example.test/original',
          confirmedBy: ['https://example.test/original'],
        }),
        method({
          title: 'duplicate confirmation',
          slug: 'duplicate-confirmation',
          sourceRef: 'https://example.test/other',
          confirmedBy: ['https://example.test/review', 'https://example.test/review'],
        }),
        method({
          title: 'stale trusted',
          slug: 'stale-trusted',
          created: 10,
        }),
      ],
      { now: 200, maxAgeSeconds: 50 },
    );

    expect(summary).toEqual({
      checked: 7,
      issueCount: 7,
      errorCount: 3,
      warningCount: 4,
      issues: [
        {
          workspace: 'code',
          slug: 'untrusted-import',
          title: 'untrusted import',
          severity: 'error',
          kind: 'untrusted-without-source-ref',
          detail:
            'untrusted memory needs a write-time sourceRef before it can be audited or promoted',
        },
        {
          workspace: 'code',
          slug: 'trusted-imported',
          title: 'trusted imported',
          severity: 'warning',
          kind: 'trusted-source-ref-without-confirmation',
          detail: 'trusted imported/manual memory with sourceRef has no confirmedBy audit metadata',
        },
        {
          workspace: 'code',
          slug: 'untrusted-replacement',
          title: 'untrusted replacement',
          severity: 'warning',
          kind: 'untrusted-supersedes',
          detail: 'untrusted memory should not be used as the active replacement for older memory',
        },
        {
          workspace: 'code',
          slug: 'missing-target',
          title: 'missing target',
          severity: 'warning',
          kind: 'missing-supersedes-target',
          detail: 'supersedes target not-present does not exist in workspace code',
        },
        {
          workspace: 'code',
          slug: 'bad-confirmation',
          title: 'bad confirmation',
          severity: 'error',
          kind: 'confirmation-source-conflict',
          detail: 'confirmedBy sources must be distinct and cannot repeat the original sourceRef',
        },
        {
          workspace: 'code',
          slug: 'duplicate-confirmation',
          title: 'duplicate confirmation',
          severity: 'error',
          kind: 'confirmation-source-conflict',
          detail: 'confirmedBy sources must be distinct and cannot repeat the original sourceRef',
        },
        {
          workspace: 'code',
          slug: 'stale-trusted',
          title: 'stale trusted',
          severity: 'warning',
          kind: 'stale-trusted',
          detail: 'trusted memory is older than the active max-age policy',
        },
      ],
    });
  });

  it('accepts task-derived trusted memories and confirmed imported memories', () => {
    const summary = auditExperienceMethods(
      [
        method({
          sourceKind: 'task',
          sourceRef: '/tmp/TASK.md',
        }),
        method({
          slug: 'confirmed-import',
          sourceRef: 'https://example.test/original',
          confirmedBy: ['https://example.test/review'],
        }),
      ],
      { now: 200 },
    );

    expect(summary).toEqual({
      checked: 2,
      issueCount: 0,
      errorCount: 0,
      warningCount: 0,
      issues: [],
    });
  });
});
