import { EDITABLE_SURFACES } from '../../domain/self-harness.js';
import type {
  EditableSurface,
  HarnessConfig,
  HarnessEdit,
  WeaknessCluster,
} from '../../domain/self-harness.js';
import type { Harness } from '../../domain/ports/harness.js';
import type { HarnessProposer } from '../../domain/ports/self-harness.js';
import { isOk } from '../../domain/result.js';
import { parseJsonArray } from './json-extract.js';

export interface HarnessBackedProposerOptions {
  readonly agent: string;
  readonly taskType?: string;
  readonly maxAfterChars?: number;
}

const DEFAULT_TASK_TYPE = 'self-harness-propose';
const DEFAULT_MAX_AFTER_CHARS = 4000;
const EDITABLE_SURFACE_SET: ReadonlySet<string> = new Set(EDITABLE_SURFACES);

const normalizeLimit = (k: number): number => (Number.isFinite(k) ? Math.max(0, Math.trunc(k)) : 0);

const normalizeMaxAfterChars = (value: number | undefined): number => {
  if (value === undefined) return DEFAULT_MAX_AFTER_CHARS;
  if (!Number.isFinite(value) || value < 1) return DEFAULT_MAX_AFTER_CHARS;
  return Math.trunc(value);
};

const isEditableSurface = (value: unknown): value is EditableSurface =>
  typeof value === 'string' && EDITABLE_SURFACE_SET.has(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Model-backed Stage-2 proposer: asks a harness agent for bounded, weakness-anchored edits. */
export class HarnessBackedProposer implements HarnessProposer {
  private readonly agent: string;
  private readonly taskType: string;
  private readonly maxAfterChars: number;

  constructor(
    private readonly harness: Harness,
    options: HarnessBackedProposerOptions,
  ) {
    this.agent = options.agent;
    this.taskType = options.taskType ?? DEFAULT_TASK_TYPE;
    this.maxAfterChars = normalizeMaxAfterChars(options.maxAfterChars);
  }

  async propose(
    config: HarnessConfig,
    clusters: readonly WeaknessCluster[],
    k: number,
  ): Promise<readonly HarnessEdit[]> {
    const limit = normalizeLimit(k);
    if (limit === 0 || clusters.length === 0) return [];

    const mechanisms = new Set(clusters.map((cluster) => cluster.signature.mechanism));
    if (mechanisms.size === 0) return [];

    const prompt = this.buildPrompt(config, clusters, limit);
    let result: Awaited<ReturnType<Harness['dispatch']>>;
    try {
      result = await this.harness.dispatch({
        agent: this.agent,
        prompt,
        taskType: this.taskType,
      });
    } catch {
      return [];
    }

    if (!isOk(result)) return [];

    const parsed = parseJsonArray(result.value.output);
    if (parsed === undefined) return [];

    const edits: HarnessEdit[] = [];
    for (const item of parsed) {
      const edit = this.sanitizeEdit(item, mechanisms);
      if (edit === undefined) continue;
      edits.push(edit);
      if (edits.length >= limit) break;
    }

    return edits;
  }

  private buildPrompt(
    config: HarnessConfig,
    clusters: readonly WeaknessCluster[],
    k: number,
  ): string {
    const currentConfig = EDITABLE_SURFACES.map((surface) => ({
      surface,
      current: config[surface],
    }));
    const clusterSummaries = clusters.map((cluster) => ({
      cause: cluster.signature.cause,
      causalStatus: cluster.signature.causalStatus,
      mechanism: cluster.signature.mechanism,
      count: cluster.count,
    }));

    return [
      'You are Stage 2 of fugue Self-Harness: Harness Proposal.',
      `Return STRICT JSON: an array of at most ${String(k)} objects.`,
      'Each object must have exactly these fields: { "surface", "mechanism", "after", "rationale" }.',
      `Allowed surface values (${String(EDITABLE_SURFACES.length)}): ${EDITABLE_SURFACES.join(', ')}`,
      'Allowed mechanism values are exactly the mined cluster signature.mechanism values below.',
      'For every edit, mechanism must anchor the change to one mined weakness.',
      'after must be the FULL replacement text for that surface, not a diff or patch.',
      `Keep after minimal and bounded: at most ${String(this.maxAfterChars)} characters.`,
      'Prefer diverse edits across different surfaces and mechanisms.',
      '',
      'Current harness config, by editable surface:',
      JSON.stringify(currentConfig, null, 2),
      '',
      'Mined weakness clusters:',
      JSON.stringify(clusterSummaries, null, 2),
      '',
      'Output ONLY the JSON array, no prose, no fences.',
    ].join('\n');
  }

  private sanitizeEdit(item: unknown, mechanisms: ReadonlySet<string>): HarnessEdit | undefined {
    if (!isRecord(item)) return undefined;

    const rawSurface = item.surface;
    if (!isEditableSurface(rawSurface)) return undefined;

    const rawMechanism = item.mechanism;
    if (typeof rawMechanism !== 'string' || !mechanisms.has(rawMechanism)) return undefined;

    const rawAfter = item.after;
    if (typeof rawAfter !== 'string') return undefined;

    const after = rawAfter.trim();
    if (after.length === 0) return undefined;

    const rawRationale = item.rationale;
    return {
      surface: rawSurface,
      mechanism: rawMechanism,
      after: after.slice(0, this.maxAfterChars),
      rationale: typeof rawRationale === 'string' ? rawRationale : '',
    };
  }
}
