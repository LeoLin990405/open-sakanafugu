import { detectDrift, type VersionDrift } from '../../domain/ccb-sync.js';
import type { CommandRunner } from '../../infra/command-runner.js';
import type { FileSystem } from '../../infra/file-system.js';

export interface CcbSyncOptions {
  readonly bin?: string;
  /** Where the last-seen version is recorded. */
  readonly stampPath: string;
}

/** Detects + records ccb version drift (the trigger for re-adapting after a ccb upgrade). */
export class CcbSync {
  private readonly bin: string;
  private readonly stampPath: string;

  constructor(
    private readonly fs: FileSystem,
    private readonly runner: CommandRunner,
    options: CcbSyncOptions,
  ) {
    this.bin = options.bin ?? 'ccb';
    this.stampPath = options.stampPath;
  }

  async currentVersion(): Promise<string> {
    const result = await this.runner.run(this.bin, ['--version']);
    return result.stdout.trim();
  }

  async check(): Promise<VersionDrift> {
    const current = await this.currentVersion();
    const last = (await this.fs.read(this.stampPath))?.trim() ?? null;
    return detectDrift(current, last);
  }

  /** Record the current version as the new baseline (call after a successful adapt). */
  async record(version: string): Promise<void> {
    await this.fs.write(this.stampPath, `${version}\n`);
  }
}
