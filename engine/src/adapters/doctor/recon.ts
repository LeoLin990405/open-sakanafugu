import type { BackendStatus, DoctorReport, RoleStatus } from '../../domain/doctor.js';
import type { CommandRunner } from '../../infra/command-runner.js';

export interface BackendSpec {
  readonly launcher: string;
  /** Candidate env var names; the backend's key counts as configured if any is present. */
  readonly keys: readonly string[];
}

export interface ReconOptions {
  /** Role CLIs to probe (default: the parallel dispatch roles). */
  readonly roles?: readonly string[];
  /** Backends to probe. */
  readonly backends?: readonly BackendSpec[];
  /** Env snapshot used to decide whether a key is configured (default process.env). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_ROLES = [
  'claude',
  'codex',
  'fugue-cc',
  'agy',
  'opencode',
  'node',
  'git',
  'tmux',
] as const;

/** Probe the environment (via `command -v`) and assemble a DoctorReport. */
export const runRecon = async (
  runner: CommandRunner,
  options: ReconOptions = {},
): Promise<DoctorReport> => {
  const env = options.env ?? process.env;
  const has = async (cli: string): Promise<boolean> =>
    (await runner.run('sh', ['-c', `command -v ${cli}`])).code === 0;

  const roleNames = options.roles ?? DEFAULT_ROLES;
  const roles: RoleStatus[] = [];
  for (const cli of roleNames) roles.push({ cli, present: await has(cli) });

  const backends: BackendStatus[] = [];
  for (const spec of options.backends ?? []) {
    backends.push({
      launcher: spec.launcher,
      installed: await has(spec.launcher),
      keyConfigured: spec.keys.some((k) => (env[k] ?? '').length > 0),
    });
  }
  return { roles, backends };
};
