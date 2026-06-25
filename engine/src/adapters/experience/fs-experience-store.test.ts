import { describe, expect, it } from 'vitest';

import { isErr, isOk } from '../../domain/result.js';
import { MemoryFileSystem } from '../../infra/memory-file-system.js';
import type { Clock } from '../../infra/clock.js';
import { FsExperienceStore } from './fs-experience-store.js';

// Mutable fake clock (ms) so we can give each experience a distinct created time.
const fakeClock = (start: number): Clock & { set: (t: number) => void } => {
  let t = start;
  return { now: () => t, set: (next: number) => (t = next) };
};

const make = (clock: Clock): FsExperienceStore =>
  new FsExperienceStore(new MemoryFileSystem(clock), clock, '/exp');

describe('FsExperienceStore', () => {
  it('adds and reads back a method (round-trip)', async () => {
    const store = make(fakeClock(5_000));
    const added = await store.add({
      workspace: 'code',
      title: 'cache first',
      body: 'check cache before curl',
    });
    expect(isOk(added)).toBe(true);

    const got = await store.get('code', 'cache-first');
    expect(got).toEqual({
      workspace: 'code',
      title: 'cache first',
      slug: 'cache-first',
      created: 5, // seconds
      body: 'check cache before curl',
    });
  });

  it('rejects a body containing a suspected key (redaction gate)', async () => {
    const result = await make(fakeClock(0)).add({
      workspace: 'code',
      title: 'leak',
      body: `token sk-${'abcdefghijklmnopqrstuvwxyz'} here`, // split so scan-secrets.ts ignores the source
    });
    expect(isErr(result) && result.error.kind).toBe('contains-secret');
  });

  it('rejects an empty body', async () => {
    const result = await make(fakeClock(0)).add({ workspace: 'code', title: 't', body: '' });
    expect(isErr(result) && result.error.kind).toBe('empty-body');
  });

  it('recall returns most-recent-first, capped at the limit', async () => {
    const clock = fakeClock(1_000);
    const store = make(clock);
    await store.add({ workspace: 'code', title: 'one', body: 'first' });
    clock.set(2_000);
    await store.add({ workspace: 'code', title: 'two', body: 'second' });
    clock.set(3_000);
    await store.add({ workspace: 'code', title: 'three', body: 'third' });

    const recalled = await store.recall('code', { limit: 2 });
    expect(recalled.map((m) => m.title)).toEqual(['three', 'two']);
  });

  it('recall filters by a fixed-substring query', async () => {
    const clock = fakeClock(1_000);
    const store = make(clock);
    await store.add({ workspace: 'code', title: 'alpha', body: 'uses redis' });
    clock.set(2_000);
    await store.add({ workspace: 'code', title: 'beta', body: 'uses postgres' });

    const recalled = await store.recall('code', { query: 'redis' });
    expect(recalled.map((m) => m.title)).toEqual(['alpha']);
  });

  it('recall on an unknown workspace is empty', async () => {
    expect(await make(fakeClock(0)).recall('nope')).toEqual([]);
  });

  it('list scopes to a workspace or spans all', async () => {
    const clock = fakeClock(1_000);
    const store = make(clock);
    await store.add({ workspace: 'code', title: 'a', body: 'x' });
    await store.add({ workspace: 'review', title: 'b', body: 'y' });

    expect((await store.list('code')).map((m) => m.workspace)).toEqual(['code']);
    expect((await store.list()).map((m) => m.workspace).sort()).toEqual(['code', 'review']);
  });
});
