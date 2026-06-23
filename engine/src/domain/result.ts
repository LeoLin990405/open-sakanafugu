/**
 * Result<T, E> — explicit success/failure at port boundaries.
 *
 * Expected failure is a value, not an exception (see docs/ARCHITECTURE.md §8).
 * Exceptions are reserved for programmer error. Every `Harness`/IO port returns
 * a `Result` so callers must handle the failure path.
 */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

/** Map the success branch, leaving an error untouched. */
export const mapOk = <T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> =>
  r.ok ? ok(f(r.value)) : r;

/** Unwrap, or return a fallback for the error branch. */
export const unwrapOr = <T, E>(r: Result<T, E>, fallback: T): T => (r.ok ? r.value : fallback);
