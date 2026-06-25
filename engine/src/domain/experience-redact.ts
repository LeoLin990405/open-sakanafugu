/**
 * Redaction + slug helpers for experience memory (pure).
 *
 * `containsSecret` uses the same fingerprint as scripts/scan-secrets.ts — a
 * plaintext key must never enter the experience store.
 */
const SECRET_RE = /sk-[A-Za-z0-9_-]{20,}|tp-[a-z0-9]{30,}|[0-9a-f]{32}\.[A-Za-z0-9]{16}/u;

export const containsSecret = (text: string): boolean => SECRET_RE.test(text);

/** space/slash → '-', drop quotes/backticks (bash `slugify`). */
export const slugify = (title: string): string =>
  title.replace(/[ /]/gu, '-').replace(/["'`]/gu, '');
