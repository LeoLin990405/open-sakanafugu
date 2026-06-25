import { describe, expect, it } from 'vitest';

import { parseJsonArray } from './json-extract.js';

describe('parseJsonArray', () => {
  it('extracts a fenced array with brackets inside JSON strings', () => {
    const parsed = parseJsonArray(`before
\`\`\`json
[
  { "text": "literal [brackets] stay in the string" }
]
\`\`\`
after`);

    expect(parsed).toEqual([{ text: 'literal [brackets] stay in the string' }]);
  });

  it('skips invalid bracketed prose and parses the first valid array', () => {
    const parsed = parseJsonArray('Note: [not json]. Payload: [{"ok": true}]');

    expect(parsed).toEqual([{ ok: true }]);
  });

  it('returns undefined when no valid JSON array is present', () => {
    expect(parseJsonArray('plain text [still not json]')).toBeUndefined();
  });
});
