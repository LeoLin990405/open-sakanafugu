/**
 * @bicamindlabs/fugue-engine — public surface.
 *
 * The typed multi-agent orchestration engine (ports & adapters). During the
 * bash → TS migration this barrel grows capability by capability; see
 * docs/ARCHITECTURE.md and docs/PARITY.md.
 */
export const VERSION = '0.0.0';

export type { Result, Ok, Err } from './domain/result.js';
export { ok, err, isOk, isErr, mapOk, unwrapOr } from './domain/result.js';
