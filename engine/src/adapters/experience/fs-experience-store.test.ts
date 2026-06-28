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
      sourceKind: 'manual',
      trustKind: 'trusted',
      body: 'check cache before curl',
    });
  });

  it('persists task provenance/trust and defaults old records to manual trusted provenance', async () => {
    const clock = fakeClock(5_000);
    const fs = new MemoryFileSystem(clock);
    const store = new FsExperienceStore(fs, clock, '/exp');
    await store.add({
      workspace: 'code',
      title: 'task retro',
      sourceKind: 'task',
      sourceRef: '/tmp/TASK.md',
      trustKind: 'untrusted',
      body: 'learned from a completed task',
    });
    await fs.write(
      '/exp/code/old.md',
      ['---', 'workspace: code', 'title: old', 'created: 4', '---', 'legacy body', ''].join('\n'),
    );

    expect(await store.get('code', 'task-retro')).toEqual({
      workspace: 'code',
      title: 'task retro',
      slug: 'task-retro',
      created: 5,
      sourceKind: 'task',
      sourceRef: '/tmp/TASK.md',
      trustKind: 'untrusted',
      body: 'learned from a completed task',
    });
    expect(await store.get('code', 'old')).toEqual({
      workspace: 'code',
      title: 'old',
      slug: 'old',
      created: 4,
      sourceKind: 'manual',
      trustKind: 'trusted',
      body: 'legacy body',
    });
  });

  it('normalizes source references when reading existing records', async () => {
    const clock = fakeClock(5_000);
    const fs = new MemoryFileSystem(clock);
    const store = new FsExperienceStore(fs, clock, '/exp');
    await fs.write(
      '/exp/code/imported.md',
      [
        '---',
        'workspace: code',
        'title: imported',
        'created: 4',
        'sourceKind: task',
        'sourceRef: /tmp/TASK.md\roverwrite: nope',
        '---',
        'legacy body',
        '',
      ].join('\n'),
    );

    expect(await store.get('code', 'imported')).toEqual({
      workspace: 'code',
      title: 'imported',
      slug: 'imported',
      created: 4,
      sourceKind: 'task',
      sourceRef: '/tmp/TASK.md overwrite: nope',
      trustKind: 'trusted',
      body: 'legacy body',
    });
  });

  it('keeps source references on one frontmatter line', async () => {
    const clock = fakeClock(5_000);
    const fs = new MemoryFileSystem(clock);
    const store = new FsExperienceStore(fs, clock, '/exp');
    await store.add({
      workspace: 'code',
      title: 'task retro',
      sourceKind: 'task',
      sourceRef: '/tmp/TASK.md\rinjected: nope\nstill: nope',
      trustKind: 'untrusted',
      body: 'learned from a completed task',
    });

    const raw = await fs.read('/exp/code/task-retro.md');
    expect(raw).toContain('sourceRef: /tmp/TASK.md injected: nope still: nope\n');
    expect(raw).toContain('trustKind: untrusted\n');
    expect(raw).not.toContain('\ninjected: nope\n');
    expect(raw).not.toContain('\r');
  });

  it('rejects a body containing a suspected key (redaction gate)', async () => {
    const result = await make(fakeClock(0)).add({
      workspace: 'code',
      title: 'leak',
      body: `token sk-${'abcdefghijklmnopqrstuvwxyz'} here`, // split so scan-secrets.ts ignores the source
    });
    expect(isErr(result) && result.error.kind).toBe('contains-secret');
  });

  it('rejects a source reference containing a suspected key', async () => {
    const result = await make(fakeClock(0)).add({
      workspace: 'code',
      title: 'leaky source ref',
      sourceRef: `https://example.test/?token=sk-${'abcdefghijklmnopqrstuvwxyz'}`,
      body: 'safe body',
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

  it('recall can filter stale methods before query ranking', async () => {
    const clock = fakeClock(1_000);
    const store = make(clock);
    await store.add({
      workspace: 'code',
      title: 'old stronger dispatch',
      body: 'dispatch output anchors with extra dispatch evidence',
    });
    clock.set(91_000_000);
    await store.add({
      workspace: 'code',
      title: 'fresh dispatch',
      body: 'dispatch output anchors',
    });

    const recalled = await store.recall('code', {
      query: 'dispatch output anchors evidence',
      maxAgeSeconds: 86_400,
      limit: 3,
    });

    expect(recalled.map((m) => m.title)).toEqual(['fresh dispatch']);
  });

  it('recall can filter by source kind before query ranking', async () => {
    const clock = fakeClock(1_000);
    const store = make(clock);
    await store.add({
      workspace: 'code',
      title: 'manual dispatch output',
      sourceKind: 'manual',
      body: 'Manual dispatch output anchors.',
    });
    clock.set(2_000);
    await store.add({
      workspace: 'code',
      title: 'task dispatch output',
      sourceKind: 'task',
      sourceRef: '/tmp/TASK.md',
      body: 'Task dispatch output anchors.',
    });

    const taskOnly = await store.recall('code', {
      query: 'dispatch output anchors',
      sourceKind: 'task',
      limit: 3,
    });
    const manualOnly = await store.recall('code', {
      query: 'dispatch output anchors',
      sourceKind: 'manual',
      limit: 3,
    });

    expect(taskOnly.map((m) => m.title)).toEqual(['task dispatch output']);
    expect(manualOnly.map((m) => m.title)).toEqual(['manual dispatch output']);
  });

  it('recall can filter by trust before query ranking', async () => {
    const clock = fakeClock(1_000);
    const store = make(clock);
    await store.add({
      workspace: 'code',
      title: 'trusted dispatch output',
      trustKind: 'trusted',
      body: 'Trusted dispatch output anchors.',
    });
    clock.set(2_000);
    await store.add({
      workspace: 'code',
      title: 'untrusted dispatch output',
      trustKind: 'untrusted',
      body: 'Untrusted dispatch output anchors.',
    });

    const trustedOnly = await store.recall('code', {
      query: 'dispatch output anchors',
      trust: 'trusted',
      limit: 3,
    });
    const untrustedOnly = await store.recall('code', {
      query: 'dispatch output anchors',
      trust: 'untrusted',
      limit: 3,
    });
    const all = await store.recall('code', {
      query: 'dispatch output anchors',
      trust: 'all',
      limit: 3,
    });

    expect(trustedOnly.map((m) => m.title)).toEqual(['trusted dispatch output']);
    expect(untrustedOnly.map((m) => m.title)).toEqual(['untrusted dispatch output']);
    expect(all.map((m) => m.title)).toEqual([
      'untrusted dispatch output',
      'trusted dispatch output',
    ]);
  });

  it('recall can reject weak query matches with a minimum score gate', async () => {
    const clock = fakeClock(1_000);
    const store = make(clock);
    await store.add({
      workspace: 'code',
      title: 'one-token dispatch',
      body: 'Only mentions dispatch.',
    });
    clock.set(2_000);
    await store.add({
      workspace: 'code',
      title: 'strong dispatch output anchors',
      body: 'Fix dispatch verbose boundary and output file anchors.',
    });

    const recalled = await store.recall('code', {
      query: 'dispatch output anchors',
      minScore: 2,
      limit: 3,
    });
    expect(recalled.map((m) => m.title)).toEqual(['strong dispatch output anchors']);
  });

  it('recall clamps a zero minimum score so query recall cannot broaden', async () => {
    const clock = fakeClock(1_000);
    const store = make(clock);
    await store.add({ workspace: 'code', title: 'match', body: 'dispatch output' });
    clock.set(2_000);
    await store.add({ workspace: 'code', title: 'unrelated', body: 'Refresh docs.' });

    const recalled = await store.recall('code', {
      query: 'dispatch output',
      minScore: 0,
      limit: 3,
    });
    expect(recalled.map((m) => m.title)).toEqual(['match']);
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
