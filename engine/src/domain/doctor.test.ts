import { describe, expect, it } from 'vitest';

import type { DoctorReport } from './doctor.js';
import { fanoutReadiness, readyBackends, recommend } from './doctor.js';

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
  it('recommends the full fleet workflow with the fugue-cc provider + 2 ready backends + codex', () => {
    const r = report(
      [
        ['fugue-cc', true],
        ['codex', true],
        ['claude', true],
      ],
      [
        ['a', true, true],
        ['b', true, true],
      ],
    );
    expect(recommend(r)[0]).toContain('fugue-cc fleet');
  });

  it('warns to use an independent backend when codex is missing', () => {
    const r = report(
      [
        ['fugue-cc', true],
        ['claude', true],
      ],
      [
        ['a', true, true],
        ['b', true, true],
      ],
    );
    expect(recommend(r).some((x) => /independent backend/u.test(x))).toBe(true);
  });

  it('recommends one lite preflight when all lite harnesses are available without fugue-cc', () => {
    const r = report(
      [
        ['claude', true],
        ['codex', true],
        ['opencode', true],
        ['agy', true],
        ['fugue-cc', false],
      ],
      [['a', true, true]],
    );

    expect(recommend(r)[0]).toContain('fuguectl preflight --harness lite');
    expect(recommend(r)[0]).not.toContain('fuguectl preflight --harness codex');
    expect(recommend(r)[0]).not.toContain('codex|opencode|agy');
    expect(recommend(r)[0]).not.toContain('/cn:*');
  });

  it('recommends a lite Codex harness even before backend launchers are configured', () => {
    const r = report(
      [
        ['claude', true],
        ['codex', true],
        ['fugue-cc', false],
      ],
      [['a', false, false]],
    );

    expect(recommend(r)[0]).toContain('--harness codex');
  });

  it('flags when no backend is ready', () => {
    expect(recommend(report([['claude', true]], [['a', false, false]]))[0]).toContain(
      'no ready backend',
    );
  });
});

describe('fanoutReadiness', () => {
  it('is ready with the fugue-cc provider, >=2 ready backends, and codex', () => {
    const r = report(
      [
        ['fugue-cc', true],
        ['codex', true],
      ],
      [
        ['a', true, true],
        ['b', true, true],
      ],
    );
    const fanout = fanoutReadiness(r);
    expect(fanout.ready).toBe(true);
    expect(fanout.blockers).toHaveLength(0);
    expect(fanout.readyBackends).toBe(2);
  });

  it('reports each missing piece with a concrete fix', () => {
    const fanout = fanoutReadiness(report([], [['a', true, true]]));
    expect(fanout.ready).toBe(false);
    const kinds = fanout.blockers.map((blocker) => blocker.kind);
    expect(kinds).toContain('no-fugue-cc-provider');
    expect(kinds).toContain('too-few-backends'); // 1/2 ready
    expect(kinds).toContain('no-reviewer');
    expect(fanout.blockers.every((blocker) => blocker.fix.length > 0)).toBe(true);
  });

  it('blocks on too-few-backends even when fugue-cc and codex are present', () => {
    const r = report(
      [
        ['fugue-cc', true],
        ['codex', true],
      ],
      [['a', true, true]],
    );
    const fanout = fanoutReadiness(r);
    expect(fanout.ready).toBe(false);
    expect(fanout.blockers.map((blocker) => blocker.kind)).toEqual(['too-few-backends']);
  });
});
