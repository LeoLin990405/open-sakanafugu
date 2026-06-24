import { describe, expect, it } from 'vitest';

import type { DoctorReport } from './doctor.js';
import { readyBackends, recommend } from './doctor.js';

const report = (
  roles: ReadonlyArray<readonly [string, boolean]>,
  backends: ReadonlyArray<readonly [string, boolean, boolean]>,
): DoctorReport => ({
  roles: roles.map(([cli, present]) => ({ cli, present })),
  backends: backends.map(([launcher, installed, keyConfigured]) => ({
    launcher,
    installed,
    keyConfigured,
  })),
});

describe('readyBackends', () => {
  it('counts installed AND key-configured backends', () => {
    expect(
      readyBackends(
        report(
          [],
          [
            ['a', true, true],
            ['b', true, false],
            ['c', false, true],
          ],
        ),
      ),
    ).toBe(1);
  });
});

describe('recommend', () => {
  it('recommends full fan-out with ccb + 2 ready backends + codex', () => {
    const r = report(
      [
        ['ccb', true],
        ['codex', true],
        ['claude', true],
      ],
      [
        ['a', true, true],
        ['b', true, true],
      ],
    );
    expect(recommend(r)[0]).toContain('full fan-out');
  });

  it('warns to use a Chinese backend, not Gemini, when codex is missing', () => {
    const r = report(
      [
        ['ccb', true],
        ['claude', true],
      ],
      [
        ['a', true, true],
        ['b', true, true],
      ],
    );
    expect(recommend(r).some((x) => /do not use Gemini/u.test(x))).toBe(true);
  });

  it('flags when no backend is ready', () => {
    expect(recommend(report([['claude', true]], [['a', false, false]]))[0]).toContain(
      'no ready backend',
    );
  });
});
