import { HARNESS_NAMES } from './ports/harness.js';
import type { HarnessName } from './ports/harness.js';
import { err, ok } from './result.js';
import type { Result } from './result.js';
import { EDITABLE_SURFACES } from './self-harness.js';
import type { EditableSurface, HarnessConfig } from './self-harness.js';

export interface EvalCase {
  readonly key: string;
  readonly promptTemplate: string;
  readonly gate: string;
}

export interface SelfHarnessSpec {
  readonly agent: string;
  readonly harness?: HarnessName;
  /** Extra flags spliced into every harness dispatch (e.g. codex `-c mcp_servers={}` on flaky-MCP hosts). */
  readonly harnessArgs?: readonly string[];
  readonly k: number;
  readonly rounds: number;
  /** Source run mined on every round; callers that need fresh evidence should run the CLI per source run. */
  readonly runId: string;
  readonly config: HarnessConfig;
  readonly heldIn: readonly EvalCase[];
  readonly heldOut: readonly EvalCase[];
}

const HARNESS_NAME_SET: ReadonlySet<string> = new Set(HARNESS_NAMES);
const HARNESS_NAMES_TEXT = HARNESS_NAMES.join(', ');
const SURFACE_SET: ReadonlySet<string> = new Set(EDITABLE_SURFACES);
const SPEC_KEY_SET: ReadonlySet<string> = new Set([
  'agent',
  'harness',
  'harnessArgs',
  'k',
  'rounds',
  'runId',
  'config',
  'heldIn',
  'heldOut',
]);
const CASE_KEY_SET: ReadonlySet<string> = new Set(['key', 'promptTemplate', 'gate']);

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const trimNonEmptyString = (value: unknown): string | undefined => {
  if (!isNonEmptyString(value)) return undefined;
  return value.trim();
};

const isHarnessName = (value: unknown): value is HarnessName =>
  typeof value === 'string' && HARNESS_NAME_SET.has(value);

const parseStringArray = (value: unknown, label: string): Result<readonly string[], string> => {
  if (!isUnknownArray(value)) return err(`${label} must be an array of strings`);
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== 'string') return err(`${label}[${String(index)}] must be a string`);
    out.push(item);
  }
  return ok(out);
};

const emptyConfig = (): Record<EditableSurface, string> => ({
  'system-prompt': '',
  'memory-sources': '',
  subagents: '',
  skills: '',
  bootstrap: '',
  execution: '',
  verification: '',
  'failure-recovery': '',
  'runtime-policy': '',
});

const parseConfig = (value: unknown): Result<HarnessConfig, string> => {
  if (!isRecord(value)) return err('config must be an object');

  for (const surface of EDITABLE_SURFACES) {
    if (!Object.prototype.hasOwnProperty.call(value, surface)) {
      return err(`config missing surface "${surface}"`);
    }
  }

  for (const key of Object.keys(value)) {
    if (!SURFACE_SET.has(key)) return err(`config has extra surface "${key}"`);
  }

  const config = emptyConfig();
  for (const surface of EDITABLE_SURFACES) {
    const surfaceValue = value[surface];
    if (typeof surfaceValue !== 'string') {
      return err(`config.${surface} must be a string`);
    }
    config[surface] = surfaceValue;
  }
  return ok(config);
};

const parseCases = (
  value: unknown,
  label: 'heldIn' | 'heldOut',
): Result<readonly EvalCase[], string> => {
  if (!isUnknownArray(value)) return err(`${label} must be an array`);

  const cases: EvalCase[] = [];
  const keys = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isRecord(item)) return err(`${label}[${String(index)}] must be an object`);
    for (const key of Object.keys(item)) {
      if (!CASE_KEY_SET.has(key)) return err(`${label}[${String(index)}] has extra field "${key}"`);
    }
    const key = trimNonEmptyString(item.key);
    if (key === undefined) {
      return err(`${label}[${String(index)}].key must be a non-empty string`);
    }
    if (keys.has(key)) return err(`${label} has duplicate key "${key}"`);
    keys.add(key);
    if (!isNonEmptyString(item.promptTemplate)) {
      return err(`${label}[${String(index)}].promptTemplate must be a non-empty string`);
    }
    if (!isNonEmptyString(item.gate)) {
      return err(`${label}[${String(index)}].gate must be a non-empty string`);
    }
    cases.push({
      key,
      promptTemplate: item.promptTemplate,
      gate: item.gate,
    });
  }
  return ok(cases);
};

export const parseSelfHarnessSpec = (text: string): Result<SelfHarnessSpec, string> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return err(`invalid JSON: ${message(error)}`);
  }

  if (!isRecord(parsed)) return err('spec must be an object');
  for (const key of Object.keys(parsed)) {
    if (!SPEC_KEY_SET.has(key)) return err(`spec has extra field "${key}"`);
  }
  const agent = trimNonEmptyString(parsed.agent);
  if (agent === undefined) return err('agent must be a non-empty string');
  if (!isPositiveInteger(parsed.k)) return err('k must be a positive integer');
  if (!isPositiveInteger(parsed.rounds)) return err('rounds must be a positive integer');
  const runId = trimNonEmptyString(parsed.runId);
  if (runId === undefined) return err('runId must be a non-empty string');
  if (parsed.harness !== undefined && !isHarnessName(parsed.harness)) {
    return err(`harness must be one of ${HARNESS_NAMES_TEXT}`);
  }

  let harnessArgs: readonly string[] | undefined;
  if (parsed.harnessArgs !== undefined) {
    const result = parseStringArray(parsed.harnessArgs, 'harnessArgs');
    if (!result.ok) return result;
    harnessArgs = result.value;
  }

  const config = parseConfig(parsed.config);
  if (!config.ok) return config;

  const heldIn = parseCases(parsed.heldIn, 'heldIn');
  if (!heldIn.ok) return heldIn;

  const heldOut = parseCases(parsed.heldOut, 'heldOut');
  if (!heldOut.ok) return heldOut;

  const base = {
    agent,
    k: parsed.k,
    rounds: parsed.rounds,
    runId,
    config: config.value,
    heldIn: heldIn.value,
    heldOut: heldOut.value,
  };
  const withHarness = parsed.harness === undefined ? base : { ...base, harness: parsed.harness };
  return ok(harnessArgs === undefined ? withHarness : { ...withHarness, harnessArgs });
};

export const renderSelfHarnessSpecTemplate = (): string => {
  const config = emptyConfig();
  for (const surface of EDITABLE_SURFACES) {
    config[surface] = `<${surface} replacement text>`;
  }

  return `${JSON.stringify(
    {
      agent: 'cc-deepseek',
      harness: 'fugue-cc',
      k: 2,
      rounds: 1,
      runId: 'source-run-id-mined-each-round',
      config,
      heldIn: [
        {
          key: 'held-in-example',
          promptTemplate: 'Use {{system-prompt}}\n\nTask: create /tmp/fugue-self-harness-held-in',
          gate: 'test -f /tmp/fugue-self-harness-held-in && rm -f /tmp/fugue-self-harness-held-in',
        },
      ],
      heldOut: [
        {
          key: 'held-out-example',
          promptTemplate: 'Use {{verification}}\n\nTask: create /tmp/fugue-self-harness-held-out',
          gate: 'test -f /tmp/fugue-self-harness-held-out && rm -f /tmp/fugue-self-harness-held-out',
        },
      ],
    },
    null,
    2,
  )}\n`;
};
