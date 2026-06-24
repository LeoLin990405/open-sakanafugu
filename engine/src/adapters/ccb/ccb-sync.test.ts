import { describe, expect, it } from 'vitest';

import { detectDrift } from '../../domain/ccb-sync.js';
import { systemClock } from '../../infra/clock.js';
import type { CommandResult, CommandRunner } from '../../infra/command-runner.js';
import { MemoryFileSystem } from '../../infra/memory-file-system.js';
import { CcbSync } from './ccb-sync.js';

class VersionRunner implements CommandRunner {
  constructor(private readonly version: string) {}
  run(): Promise<CommandResult> {
    return Promise.resolve({ code: 0, stdout: this.version, stderr: '' });
  }
}

describe('detectDrift', () => {
  it('drifts only when a recorded version differs from current', () => {
    expect(detectDrift('2.0', null).drifted).toBe(false);
    expect(detectDrift('2.0', '2.0').drifted).toBe(false);
    expect(detectDrift('2.1', '2.0').drifted).toBe(true);
  });
});

describe('CcbSync', () => {
  it('compares `ccb --version` against the recorded stamp and can re-record', async () => {
    const fs = new MemoryFileSystem(systemClock);
    await fs.write('/state/ccb-version', '2.0\n');
    const sync = new CcbSync(fs, new VersionRunner('2.1\n'), { stampPath: '/state/ccb-version' });

    expect(await sync.check()).toEqual({ current: '2.1', last: '2.0', drifted: true });

    await sync.record('2.1');
    expect((await fs.read('/state/ccb-version'))?.trim()).toBe('2.1');
  });
});
