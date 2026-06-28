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

  it('recall ranks query token matches before newer unrelated methods', async () => {
    const clock = fakeClock(1_000);
    const store = make(clock);
    await store.add({
      workspace: 'code',
      title: 'dispatch observations',
      body: 'Fix dispatch verbose boundary and output file anchors.',
    });
    clock.set(2_000);
    await store.add({
      workspace: 'code',
      title: 'recent unrelated',
      body: 'Refresh docs for onboarding.',
    });

    const recalled = await store.recall('code', { query: 'dispatch output anchors', limit: 2 });
    expect(recalled.map((m) => m.title)).toEqual(['dispatch observations']);
  });

  it('recall filters by failure cause before query ranking', async () => {
    const clock = fakeClock(1_000);
    const store = make(clock);
    await store.add({
      workspace: 'code',
      title: 'retrieval failure',
      body: [
        'Failure cause:',
        'retrieval',
        '',
        'Relabeled lesson:',
        'Score dispatch output retrieval by title/body tokens.',
      ].join('\n'),
    });
    clock.set(2_000);
    await store.add({
      workspace: 'code',
      title: 'verification failure',
      body: [
        'Failure cause:',
        'verification',
        '',
        'Relabeled lesson:',
        'Add a deterministic dispatch output gate.',
      ].join('\n'),
    });
    clock.set(3_000);
    await store.add({
      workspace: 'code',
      title: 'success path',
      body: 'dispatch output gate without a failure cause',
    });

    const recalled = await store.recall('code', {
      failureCause: 'retrieval',
      query: 'dispatch output gate retrieval',
      limit: 3,
    });
    expect(recalled.map((m) => m.title)).toEqual(['retrieval failure']);
  });

  it('recall ignores query stop words instead of treating them as relevance', async () => {
    const clock = fakeClock(1_000);
    const store = make(clock);
    await store.add({ workspace: 'code', title: 'one', body: 'first method' });
    clock.set(2_000);
    await store.add({ workspace: 'code', title: 'two', body: 'second method' });

    const recalled = await store.recall('code', { query: 'the and to', limit: 2 });
    expect(recalled.map((m) => m.title)).toEqual(['two', 'one']);
  });

  it('recall does not score workspace frontmatter as relevant content', async () => {
    const store = make(fakeClock(1_000));
    await store.add({
      workspace: 'code',
      title: 'unrelated',
      body: 'Refresh onboarding prose.',
    });

    expect(await store.recall('code', { query: 'code' })).toEqual([]);
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
