import { describe, expect, it } from 'vitest';

import { EDITABLE_SURFACES } from './self-harness.js';
import { parseSelfHarnessSpec, renderSelfHarnessSpecTemplate } from './self-harness-spec.js';

const validObject = (): Record<string, unknown> => ({
  agent: 'cc-deepseek',
  harness: 'ccb',
  k: 2,
  rounds: 3,
  runId: 'run-1',
  config: Object.fromEntries(EDITABLE_SURFACES.map((surface) => [surface, `${surface} text`])),
  heldIn: [{ key: 'in-1', promptTemplate: 'do {{execution}}', gate: 'true' }],
  heldOut: [{ key: 'out-1', promptTemplate: 'verify {{verification}}', gate: 'true' }],
});

const parseObject = (value: unknown) => parseSelfHarnessSpec(JSON.stringify(value));

const expectError = (value: unknown): string => {
  const result = typeof value === 'string' ? parseSelfHarnessSpec(value) : parseObject(value);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected parse failure');
  return result.error;
};

describe('parseSelfHarnessSpec', () => {
  it('parses a valid spec', () => {
    const result = parseObject(validObject());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.agent).toBe('cc-deepseek');
    expect(result.value.harness).toBe('ccb');
    expect(result.value.config.execution).toBe('execution text');
    expect(result.value.heldIn[0]?.key).toBe('in-1');
  });

  it('trims identifier fields but preserves executable strings', () => {
    const spec = validObject();
    spec.agent = ' cc-deepseek ';
    spec.runId = ' run-1 ';
    spec.heldIn = [{ key: ' in-1 ', promptTemplate: '  do {{execution}}  ', gate: '  true  ' }];

    const result = parseObject(spec);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.agent).toBe('cc-deepseek');
    expect(result.value.runId).toBe('run-1');
    expect(result.value.heldIn[0]?.key).toBe('in-1');
    expect(result.value.heldIn[0]?.promptTemplate).toBe('  do {{execution}}  ');
    expect(result.value.heldIn[0]?.gate).toBe('  true  ');
  });

  it('reports invalid JSON', () => {
    expect(expectError('{ nope')).toContain('invalid JSON:');
  });

  it('reports an extra top-level field', () => {
    const spec = validObject();
    spec.round = 99;

    expect(expectError(spec)).toBe('spec has extra field "round"');
  });

  it('reports a missing surface', () => {
    const spec = validObject();
    const config = { ...(spec.config as Record<string, unknown>) };
    delete config.execution;
    spec.config = config;

    expect(expectError(spec)).toBe('config missing surface "execution"');
  });

  it('reports a non-object config', () => {
    const spec = validObject();
    spec.config = [];

    expect(expectError(spec)).toBe('config must be an object');
  });

  it('reports an extra surface', () => {
    const spec = validObject();
    spec.config = { ...(spec.config as Record<string, unknown>), extra: 'nope' };

    expect(expectError(spec)).toBe('config has extra surface "extra"');
  });

  it('reports a non-string surface value', () => {
    const spec = validObject();
    spec.config = {
      ...(spec.config as Record<string, unknown>),
      execution: 123,
    };

    expect(expectError(spec)).toBe('config.execution must be a string');
  });

  it('reports non-positive k', () => {
    const spec = validObject();
    spec.k = 0;

    expect(expectError(spec)).toBe('k must be a positive integer');
  });

  it('reports non-integer k', () => {
    const spec = validObject();
    spec.k = 1.5;

    expect(expectError(spec)).toBe('k must be a positive integer');
  });

  it('reports non-positive rounds', () => {
    const spec = validObject();
    spec.rounds = 0;

    expect(expectError(spec)).toBe('rounds must be a positive integer');
  });

  it('reports non-integer rounds', () => {
    const spec = validObject();
    spec.rounds = 2.5;

    expect(expectError(spec)).toBe('rounds must be a positive integer');
  });

  it('reports an empty agent', () => {
    const spec = validObject();
    spec.agent = ' ';

    expect(expectError(spec)).toBe('agent must be a non-empty string');
  });

  it('reports an empty runId', () => {
    const spec = validObject();
    spec.runId = ' ';

    expect(expectError(spec)).toBe('runId must be a non-empty string');
  });

  it('reports a non-object spec', () => {
    expect(expectError('[]')).toBe('spec must be an object');
  });

  it('reports a non-array heldIn split', () => {
    const spec = validObject();
    spec.heldIn = 'not an array';

    expect(expectError(spec)).toBe('heldIn must be an array');
  });

  it('reports a non-string gate', () => {
    const spec = validObject();
    spec.heldIn = [{ key: 'in-1', promptTemplate: 'do it', gate: 123 }];

    expect(expectError(spec)).toBe('heldIn[0].gate must be a non-empty string');
  });

  it('reports an empty prompt template', () => {
    const spec = validObject();
    spec.heldIn = [{ key: 'in-1', promptTemplate: ' ', gate: 'true' }];

    expect(expectError(spec)).toBe('heldIn[0].promptTemplate must be a non-empty string');
  });

  it('reports a bad harness', () => {
    const spec = validObject();
    spec.harness = 'gemini';

    expect(expectError(spec)).toBe('harness must be one of ccb, codex, opencode');
  });

  it('allows harness to be omitted', () => {
    const spec = validObject();
    delete spec.harness;

    const result = parseObject(spec);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.harness).toBeUndefined();
  });

  it('reports a non-object eval case', () => {
    const spec = validObject();
    spec.heldIn = [42];

    expect(expectError(spec)).toBe('heldIn[0] must be an object');
  });

  it('reports an eval case with an extra field', () => {
    const spec = validObject();
    spec.heldIn = [{ key: 'in-1', promptTemplate: 'do it', gate: 'true', timeoutSeconds: 10 }];

    expect(expectError(spec)).toBe('heldIn[0] has extra field "timeoutSeconds"');
  });

  it('reports duplicate eval case keys within a split', () => {
    const spec = validObject();
    spec.heldOut = [
      { key: 'out-1', promptTemplate: 'do it', gate: 'true' },
      { key: 'out-1', promptTemplate: 'do something else', gate: 'true' },
    ];

    expect(expectError(spec)).toBe('heldOut has duplicate key "out-1"');
  });

  it('reports duplicate eval case keys after trimming', () => {
    const spec = validObject();
    spec.heldOut = [
      { key: 'out-1', promptTemplate: 'do it', gate: 'true' },
      { key: ' out-1 ', promptTemplate: 'do something else', gate: 'true' },
    ];

    expect(expectError(spec)).toBe('heldOut has duplicate key "out-1"');
  });

  it('reports a heldOut case with a missing key', () => {
    const spec = validObject();
    spec.heldOut = [{ promptTemplate: 'do it', gate: 'true' }];

    expect(expectError(spec)).toBe('heldOut[0].key must be a non-empty string');
  });
});

describe('renderSelfHarnessSpecTemplate', () => {
  it('round-trips through the parser', () => {
    const result = parseSelfHarnessSpec(renderSelfHarnessSpecTemplate());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    for (const surface of EDITABLE_SURFACES) {
      expect(result.value.config[surface]).toContain(surface);
    }
    expect(result.value.heldIn[0]?.promptTemplate).toContain('\n\nTask:');
    expect(result.value.heldIn[0]?.promptTemplate).not.toContain('\\n');
    expect(result.value.heldIn[0]?.promptTemplate).toContain('/tmp/fugue-self-harness-held-in');
    expect(result.value.heldIn[0]?.gate).toContain('rm -f /tmp/fugue-self-harness-held-in');
    expect(result.value.heldOut[0]?.promptTemplate).toContain('/tmp/fugue-self-harness-held-out');
    expect(result.value.heldOut[0]?.gate).toContain('rm -f /tmp/fugue-self-harness-held-out');
    expect(result.value.heldIn[0]?.gate).not.toBe(result.value.heldOut[0]?.gate);
  });
});
