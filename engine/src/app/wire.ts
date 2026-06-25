import { createHash } from 'node:crypto';

import { BetaBernoulliAllocator } from '../adapters/allocation/beta-bernoulli-allocator.js';
import { PersistentBarrier } from '../adapters/barrier/persistent-barrier.js';
import { FugueCcHarness } from '../adapters/harness/fugue-cc-harness.js';
import { CodexHarness } from '../adapters/harness/codex-harness.js';
import type { HarnessExecOptions } from '../adapters/harness/exec-helpers.js';
import { OpencodeHarness } from '../adapters/harness/opencode-harness.js';
import { HarnessBackedProposer } from '../adapters/self-harness/harness-proposer.js';
import { RunWeaknessMiner } from '../adapters/self-harness/run-weakness-miner.js';
import { TaskListHarnessValidator } from '../adapters/self-harness/task-list-validator.js';
import { FsResultStore } from '../adapters/store/fs-result-store.js';
import { FsRunStore } from '../adapters/store/fs-run-store.js';
import { joinPath } from '../adapters/store/paths.js';
import { DEFAULT_ALLOCATION_PARAMS, type BenchTable } from '../domain/allocation.js';
import type { AgentRegistry } from '../domain/agent-registry.js';
import { DEFAULT_POLICIES } from '../domain/policy-eval.js';
import { HARNESS_NAMES, type Harness, type HarnessName } from '../domain/ports/harness.js';
import { renderTemplate } from '../domain/prompt-render.js';
import type { EvalCase, SelfHarnessSpec } from '../domain/self-harness-spec.js';
import { systemClock } from '../infra/clock.js';
import type { CommandRunner } from '../infra/command-runner.js';
import { NodeCommandRunner } from '../infra/node-command-runner.js';
import { NodeFileSystem } from '../infra/node-file-system.js';
import { systemRng } from '../infra/rng.js';
import { Coordinator, type CoordinatorDeps } from './coordinator.js';
import { SelfHarnessLoop } from './self-harness-loop.js';

export interface WireConfig {
  /** Root dir for the engine's durable state (allocation/barrier/results/runs). */
  readonly stateDir: string;
  /** Which dispatch harness to use (default fugue-cc). */
  readonly harness?: HarnessName;
  /** Allocation bench prior (default: empty → unlisted prior for everyone). */
  readonly bench?: BenchTable;
  /** Working directory for harness commands. */
  readonly cwd?: string;
  /** Extra flags spliced into every harness dispatch (e.g. codex MCP-disable on flaky hosts). */
  readonly harnessArgs?: readonly string[];
  /** Optional logical-agent registry; enables per-agent harness/runtime routing. */
  readonly agentRegistry?: AgentRegistry;
}

export interface WireSelfHarnessConfig {
  readonly spec: SelfHarnessSpec;
  readonly cwd?: string;
  readonly stateDir: string;
}

const buildHarness = (
  name: HarnessName,
  runner: CommandRunner,
  cwd?: string,
  args?: readonly string[],
): Harness => {
  const options: HarnessExecOptions = {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(args !== undefined ? { args } : {}),
  };
  switch (name) {
    case 'fugue-cc':
      return new FugueCcHarness(runner, options);
    case 'codex':
      return new CodexHarness(runner, options);
    case 'opencode':
      return new OpencodeHarness(runner, options);
  }
};

const buildHarnessMap = (
  runner: CommandRunner,
  cwd?: string,
  args?: readonly string[],
): ReadonlyMap<HarnessName, Harness> =>
  new Map(
    HARNESS_NAMES.map((name): readonly [HarnessName, Harness] => [
      name,
      buildHarness(name, runner, cwd, args),
    ]),
  );

/**
 * The single composition root: assemble a Coordinator from the real
 * filesystem/CLI adapters. Nothing else in the codebase `new`s an adapter.
 */
export const wireCoordinator = (config: WireConfig): Coordinator => {
  const fs = new NodeFileSystem();
  const runner = new NodeCommandRunner();
  const harnesses = buildHarnessMap(runner, config.cwd, config.harnessArgs);
  const defaultHarness = harnesses.get(config.harness ?? 'fugue-cc');
  if (defaultHarness === undefined) throw new Error('default harness was not constructed');

  const baseDeps = {
    policies: DEFAULT_POLICIES,
    allocator: new BetaBernoulliAllocator(
      fs,
      joinPath(config.stateDir, 'allocation'),
      config.bench ?? new Map(),
      {
        params: DEFAULT_ALLOCATION_PARAMS,
        rng: systemRng,
      },
    ),
    harness: defaultHarness,
    harnesses,
    barrier: new PersistentBarrier(fs, joinPath(config.stateDir, 'barrier')),
    resultStore: new FsResultStore(fs, joinPath(config.stateDir, 'results')),
    runStore: new FsRunStore(fs, joinPath(config.stateDir, 'runs')),
    clock: systemClock,
    hash: (content: string) => createHash('sha256').update(content).digest('hex'),
  };
  const deps: CoordinatorDeps =
    config.agentRegistry === undefined
      ? baseDeps
      : { ...baseDeps, agentRegistry: config.agentRegistry };
  return new Coordinator(deps);
};

export const wireSelfHarness = (cfg: WireSelfHarnessConfig): SelfHarnessLoop => {
  const fs = new NodeFileSystem();
  const runner = new NodeCommandRunner();
  const harness = buildHarness(
    cfg.spec.harness ?? 'fugue-cc',
    runner,
    cfg.cwd,
    cfg.spec.harnessArgs,
  );
  const runStore = new FsRunStore(fs, joinPath(cfg.stateDir, 'runs'));

  return new SelfHarnessLoop({
    miner: new RunWeaknessMiner(runStore, harness, { agent: cfg.spec.agent }),
    proposer: new HarnessBackedProposer(harness, { agent: cfg.spec.agent }),
    validator: new TaskListHarnessValidator<EvalCase>(harness, {
      heldIn: cfg.spec.heldIn,
      heldOut: cfg.spec.heldOut,
      agent: cfg.spec.agent,
      renderPrompt: (config, testCase) => renderTemplate(testCase.promptTemplate, config),
      verify: async (testCase) => {
        // CLI specs use shell gates as side-effect checks. Custom validators can still
        // inspect DispatchResult directly by constructing TaskListHarnessValidator themselves.
        try {
          const options = cfg.cwd !== undefined ? { cwd: cfg.cwd } : {};
          return (await runner.run('sh', ['-c', testCase.gate], options)).code === 0;
        } catch {
          return false;
        }
      },
    }),
    k: cfg.spec.k,
  });
};
