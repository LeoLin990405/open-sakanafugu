import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { ok, err, isOk, isErr, mapOk, unwrapOr } from './result.js';

describe('Result', () => {
  it('ok carries its value', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it('err carries its error', () => {
    expect(err('boom')).toEqual({ ok: false, error: 'boom' });
  });

  it('ok and err are mutually exclusive (property)', () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        const o = ok(v);
        const e = err(v);
        return isOk(o) && !isErr(o) && isErr(e) && !isOk(e);
      }),
    );
  });

  it('mapOk transforms ok, passes err through', () => {
    expect(mapOk(ok(2), (n: number) => n * 3)).toEqual(ok(6));
    expect(mapOk(err<string>('e'), (n: number) => n * 3)).toEqual(err('e'));
  });

  it('unwrapOr returns value or fallback', () => {
    expect(unwrapOr(ok(1), 99)).toBe(1);
    expect(unwrapOr(err<string>('e'), 99)).toBe(99);
  });
});
