import { describe, expect, it } from 'vitest';

import { containsSecret, slugify } from './experience-redact.js';

describe('containsSecret', () => {
  it('flags plaintext key fingerprints', () => {
    // Built by concatenation so this source file itself doesn't trip scan-secrets.ts.
    expect(containsSecret(`here is sk-${'abcdefghijklmnopqrstuvwxyz'} key`)).toBe(true);
    expect(containsSecret(`tp-${'abcdefghij0123456789abcdefghij01'}`)).toBe(true);
    expect(containsSecret(`${'0123456789abcdef0123456789abcdef'}.${'ABCDEFGHIJ012345'}`)).toBe(
      true,
    );
  });

  it('passes clean text', () => {
    expect(containsSecret('a reusable method: cache the probe result')).toBe(false);
  });
});

describe('slugify', () => {
  it('turns spaces/slashes into dashes and drops quotes/backticks', () => {
    expect(slugify('fix the cache/probe "bug" `now`')).toBe('fix-the-cache-probe-bug-now');
  });
});
