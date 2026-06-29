# FuguNano engine — architecture

> Status: **design v2 + Node cutover**. This began as the target for the TypeScript rewrite; today the repo has no tracked `.sh` scripts, `fuguectl` is a Node wrapper surface, and the strict TypeScript engine is the source of truth for orchestration behavior.

## 1. Vision

Sakana Fugu puts _many models behind one API_ and lets a **trained** coordinator (TRINITY / Conductor) decide who does what. FuguNano is the **training-free, self-hostable** analogue: many agents behind **one typed engine**, orchestrated by **composable strategies** instead of a learned 0.6B model.

The rewrite makes that literally true in code. Borrowed ideas stop being ad-hoc scripts and become **first-class, swappable abstractions**. "Our own thing" is the _composition_: a Coordinator wiring ports together, any one replaceable without touching the rest.

## 2. Layering (ports & adapters, corrected)

Ports are carved by **volatility and enforceable boundaries**, not "one borrowed idea = one port."

```
cli/        clipanion commands — thin; parse args, call application
   │
app/        Coordinator + Phases — compose ports, emit RunEvents (NOT domain)
   │
domain/     value objects + ports + policies — pure, no IO
   │
adapters/   concrete implementations of ports (one per reference, where it earns it)
infra/      narrow injected IO: Clock, FileSystem, Rng (not a service locator)
```

Rule: `domain` imports nothing outward. `app` imports only `domain`. `adapters`/`infra` implement `domain` ports and are injected at one composition root (`app/wire.ts`). Adapters never import each other.

## 3. The synthesis — references → where they live

| Reference                                                                                                                     | What we take                                                                                                        | Lives as                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fugu **TRINITY** (learned selector)                                                                                           | role pipeline + a coordinator that picks the worker                                                                 | `AllocationStrategy` (port) + role `Phase`s (app)                                                                                                                                               |
| Fugu **Conductor** (action={model,subtask,access-list}, recursive)                                                            | recursive decomposition with per-step access scope                                                                  | `PlanGraph`/`TaskNode` (value) + `DispatchScope`/`CapabilityGrant` (value)                                                                                                                      |
| **OpenFugu** (trained, OpenAI-compatible server)                                                                              | a _remote_ coordinator we could call                                                                                | **out of scope now**; future `OpenAICompatibleHarness` adapter — never import its training stack                                                                                                |
| **bandit** lit (Beta-Bernoulli/Thompson/discounted)                                                                           | training-free adaptive routing                                                                                      | `AllocationStrategy` adapters, composable                                                                                                                                                       |
| **Zleap** (context isolation, experience)                                                                                     | station-scoped context; reusable methods                                                                            | `ContextAssembler`→`PromptBundle` + `ExperienceStore`                                                                                                                                           |
| **no-mistakes** (auto-fix/ask-user, run facade)                                                                               | bounded loop, finding triage, machine state                                                                         | `ReviewLoop` + `Run`/`RoundManifest` (value)                                                                                                                                                    |
| **lavish-axi** (`build:skill --check`)                                                                                        | docs-drift gate                                                                                                     | a `QualityGate` adapter                                                                                                                                                                         |
| our **preflight** + legacy CLI guard + gen≠review                                                                             | deterministic go/no-go AND run policy                                                                               | `QualityGate` (deterministic) + `Policy`/`PolicyEvaluator` (selection-time)                                                                                                                     |
| **Lynn** (orchestrator-side ownership)                                                                                        | enforce ownership on integration                                                                                    | `Integrator` + `VcsPort` + `OwnershipPolicy`                                                                                                                                                    |
| our **join barrier**                                                                                                          | dispatch N ⇒ N terminal, durable, resumable                                                                         | `ResultStore` + `Barrier`/`RoundManifest`                                                                                                                                                       |
| **skills catalog**                                                                                                            | one catalog over all sources; inject only needed                                                                    | `SkillCatalog` (search) + `SkillInjector`                                                                                                                                                       |
| **codex-plugin-cc** (multi-harness)                                                                                           | one dispatch model over fugue-cc/codex/opencode; fugue-cc is one provider-runtime adapter                           | `Harness` + `AgentRegistry` (logical agent → runtime target)                                                                                                                                    |
| **AgentSpec / AgentVisor / CaMeL** (runtime rules, privilege separation, trusted-control/untrusted-data split)                | deterministic pre-dispatch prompt inspection before high-risk runtime actions                                       | `runtimeGuardPacket` (pure domain) + `fuguectl guard prompt`                                                                                                                                    |
| **HarnessFix / MAST / execution provenance** (failed trajectories, failure taxonomy, evidence tracing)                        | normalize raw failure logs before repair, learning, or harness evolution                                            | `incidentPacket` (pure domain) + `fuguectl incident packet`                                                                                                                                     |
| **PROBE / AIR / failure-aware observability / silent-failure postmortems** (evidence-gated incident response)                 | turn incident evidence into bounded containment, repair, validation, and learning guidance                          | `incidentRecoveryPacket` (pure domain) + `fuguectl incident recovery`                                                                                                                           |
| **Self-Harness** (Shanghai AI Lab, [arXiv 2606.09498](https://arxiv.org/abs/2606.09498); evolve the _harness_, not the model) | mine verifier-grounded weaknesses → propose bounded single-surface edits → promote only under a non-regression gate | `SelfHarnessLoop` (app) + `WeaknessMiner`/`HarnessProposer`/`HarnessValidator` (ports) + live self-harness adapters + `fuguectl self-harness` CLI + pure `acceptEdit` (`Δin≥0 ∧ Δho≥0 ∧ max>0`) |

> **These packets are FuguNano's own online decision boundaries, not just offline reports.** Each pure-domain packet above (and `reviewPacket` / `taskHandoffPacket` / `action-certificate` / `taskContextDigest`) is wired into the engine's own pipeline, not only reachable via its `fuguectl <cmd>`: `dispatch` runs `runtimeGuardPacket` as a pre-dispatch gate (`--guard strict` refuses block dispositions and privileged actions with no `--certificate`), auto-derives `incidentPacket`/`incidentRecoveryPacket` on failure, and prefixes the prompt with a `taskContextDigest` under `--task-digest`; `integrate --strict-handoff` refuses a blocked `taskHandoffPacket`; `loop record --review` derives the verdict from a `reviewPacket`. A higher-level framework _may_ also consume the same packets, but the primary consumer is the engine itself.

The Evo Engineering loop closes that boundary: `EvolutionLoop` maps those packets into weakness signals, scores `guard-rule` / `review-rubric` candidates against fixed splits, and records accepted promotions in `.fugunano/evolution` through the same lineage gate.

## 4. Domain — value objects

Pure data (readonly, no behavior beyond constructors/guards). The vocabulary the whole engine speaks:

```ts
type Verdict = {
  kind: "ACCEPTED" | "NEEDS_FIX";
  findings: Finding[];
  reviewer: string;
};
type Finding = {
  id: string;
  severity: "block" | "warn" | "nit";
  file?: string;
  line?: number;
  title: string;
  class: FindingClass;
};
type Artifact = {
  id: string;
  kind: "diff" | "file" | "log" | "plan";
  uri: string;
  sha256: string;
};
type TaskProfile = { taskType: string; size?: "S" | "M" | "L"; tags: string[] }; // routing input
type AllocationOutcome = {
  profile: TaskProfile;
  agent: string;
  model?: string;
  harness: string;
  verdict: Verdict["kind"];
  gate: boolean;
  durationMs: number;
  tokens?: number;
  failClass?: string;
}; // routing feedback
type TaskNode = {
  id: string;
  goal: string;
  deps: string[];
  visibility: Glob[];
  scope: DispatchScope;
  status: NodeStatus;
};
type PlanGraph = { nodes: TaskNode[]; root: string }; // Conductor recursion
type DispatchScope = { workspace: string; grants: CapabilityGrant[] }; // runtime access boundary
type CapabilityGrant = {
  resource: "fs" | "net" | "tool";
  allow: Glob[];
  deny: Glob[];
};
type RoundManifest = {
  round: number;
  expected: string[];
  terminal: Record<string, TaskState>;
}; // N-of-N
type TaskState = "pending" | "done" | "fail" | "timeout" | "canceled";
type Run = {
  id: string;
  phase: PhaseName;
  round: number;
  best?: string;
  events: RunEvent[];
};
type Policy = { id: string; evaluate(sel: Selection): PolicyResult }; // legacy CLI guard, gen≠review
type AgentProfile = {
  id: string;
  harness: "fugue-cc" | "codex" | "opencode" | "agy";
  target?: string; // harness-native agent/model; defaults to id
  modelFamily?: string; // policy label
  roles?: ("planner" | "implementer" | "reviewer" | "fixer")[];
};
```

## 5. Domain — ports

`async` at the world's edge, pure otherwise. No `any`; expected failure is a typed `Result<T,E>`, exceptions only for programmer error.

```ts
// dispatch work to an agent over a fleet (fugue-cc/codex/opencode/agy). NOT "returns a Verdict".
// Revised from the iter0 submit/status/collect/cancel job model (iter5): every
// harness we target is a blocking CLI (`fugue-cc`, `codex exec`, `opencode run`, `agy --prompt`),
// so one async dispatch + Result is exact; an async job machine over a synchronous
// tool was unjustified. Parallel dispatch parallelism + resume live in Barrier/ResultStore,
// not here. A future remote-queue harness can poll internally and still resolve one Promise.
interface Harness {
  readonly name: "fugue-cc" | "codex" | "opencode" | "agy";
  dispatch(
    req: DispatchRequest,
  ): Promise<Result<DispatchResult, DispatchError>>;
  health(): Promise<HealthStatus>;
}

// training-free learned routing (our TRINITY) — rich in/out
interface AllocationStrategy {
  rank(profile: TaskProfile, candidates: Agent[]): Ranking; // pure
  update(outcome: AllocationOutcome): void; // the flywheel
  snapshot(): StrategyState; // persistable
}

// durable outputs + the join invariant, split
interface ResultStore {
  put(key: string, a: Artifact[]): Promise<void>;
  get(key: string): Promise<Artifact[] | null>;
}
interface Barrier {
  open(m: RoundManifest): Promise<void>;
  mark(key: string, s: TaskState): Promise<void>;
  await(round: number, deadline: Deadline): Promise<RoundManifest>;
} // preserves done|fail|timeout|canceled

// give each station only what it should see; produce a structured bundle, not string concat
interface ContextAssembler {
  assemble(ws: Workspace, node: TaskNode, run: Run): PromptBundle;
} // budgeted + redacted
interface ExperienceStore {
  add(m: Method): Promise<void>;
  recall(scope: string, limit: number): Promise<Method[]>;
}

// deterministic go/no-go vs selection-time policy — different things
interface QualityGate {
  readonly name: string;
  check(run: Run): Promise<GateResult>;
}
interface PolicyEvaluator {
  evaluate(sel: Selection): PolicyResult[];
} // legacy CLI guard, gen≠review, role rules

// the bounded review-fix loop as an explicit state machine
type LoopState =
  | "DONE"
  | "CONFIRM"
  | "CONTINUE"
  | "ASK_USER"
  | "ESCALATE_MAX"
  | "ESCALATE_NONCONV";
interface ReviewLoop {
  record(round: RoundResult): void;
  decide(): LoopState;
  best(): RoundResult | null;
}

// version control + integration with ownership/conflict isolation/rollback (Lynn + our integrate)
interface VcsPort {
  cherryPick(
    worktree: string,
    onto: string,
    id: Identity,
  ): Promise<Result<void, MergeConflict>>;
  abort(): Promise<void>;
  diff(worktree: string): Promise<FileDiff[]>;
}
interface Integrator {
  integrate(
    worktrees: Worktree[],
    ownership: OwnershipPolicy,
  ): Promise<IntegrationReport>;
} // isolates conflicts + violations

// progressive disclosure: search vs injection are different responsibilities
interface SkillCatalog {
  index(sources: SkillSource[]): Promise<Catalog>;
  match(q: string): SkillRef[];
}
interface SkillInjector {
  inject(ids: string[]): ContextFragment;
}

// narrow injected IO (infra) — deterministic tests, no service locator
interface Clock {
  now(): number;
}
interface Rng {
  next(): number;
} // deterministic Thompson Sampling under test
interface FileSystem {
  read(p): Promise<string | null>;
  write(p, s): Promise<void>;
  mtime(p): Promise<number>; /* … */
}
```

## 6. Application — Coordinator & Phases

`Phase`/`Coordinator` are **application** (not domain). They consume ports + values and emit `RunEvent`s; the Coordinator never `new`s an adapter (that's `wire.ts`).

```ts
interface Phase<I, O> {
  readonly name: PhaseName;
  run(ctx: AppContext, input: I): Promise<O>;
}
```

Pipeline (today's 5 phases, now typed): **Plan → Dispatch → Integrate → Review → Loop**.

- _Plan_ — gates + policy eval; build a `PlanGraph` (recursive decomposition = nodes/deps/visibility).
- _Dispatch_ — `AllocationStrategy.rank` picks agents; `ContextAssembler` builds the `PromptBundle`; `Harness.submit` in parallel; `Barrier` opens a `RoundManifest`.
- _Integrate_ — `Barrier.await` (N terminal), then `Integrator` (ownership + conflict isolation).
- _Review_ — a reviewer agent (via a `Harness`) yields a `Verdict`; `AllocationStrategy.update(outcome)`.
- _Loop_ — `ReviewLoop.decide()` → one `LoopState`; keep-best; capped → escalate.

Higher modes (goal-mode, planning-panel, Conductor-style recursion) are other Phase compositions over the same ports — not special branches.

CLI-surface homes for the rest: `task`→audit/`Run` facade · `template`→`ContextAssembler` · `run`/`summary`→`Run`/`RunEvent` projections · `fleet`→`Harness.health` + launcher adapter · `doctor`→recon over `Harness.health`+gates · `runtime`→provider maintenance (`runtime` alias) · `self-harness`→spec-driven harness evolution.

## 7. Migration plan (cut over)

The migration was done **capability by capability** (port + adapter + tests + CLI), keeping the operator green at every step. [PARITY.md](PARITY.md) now tracks the post-cutover status: every production `fuguectl` command is a Node wrapper over the tested engine CLI, and `npm run lint:launchers` fails if a tracked shell script returns.

1. **iter0** — this doc + skeleton (strict tsconfig, tsup, vitest, eslint, clipanion; `domain/` values+ports compiling; CI `test:engine`).
2. **iter1** — **`RunState + ResultStore + Barrier`** (proves durable state, injected IO, timeout/cancel semantics, and the central join invariant against the legacy operator). Property-tested with fast-check.
3. **iter1.5** — `AllocationStrategy` (+ all three adapters) with full `record/feed/stats/decay --sample` parity; property tests for ranking invariants.
4. **iter2+** — `ReviewLoop`, `QualityGate`/`PolicyEvaluator`, `Integrator`/`VcsPort`, `Workspace`/`ContextAssembler`, `ExperienceStore`, `SkillCatalog`/`Injector`, `Harness` adapters, then the `Coordinator`.
5. **cutover** — legacy shell scripts removed; selftest/check-docs now use the Node suite.

## 8. Engineering standards (the "deep" in deeply engineered)

- **Strict TS** — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`; **zero `any`** (lint-enforced); `import type`; ESM + `NodeNext`.
- **Layering enforced** — `domain` imports nothing outward; one composition root; adapters isolated. (lint `no-restricted-imports`.)
- **Result types at edges**; no throwing across a port for expected failure.
- **Pure core, injected IO** — `Clock`/`FileSystem`/`Rng` injected and narrow, so Thompson Sampling and barrier timeouts are deterministically testable.
- **Tests co-located** (vitest), **property tests** (fast-check) for strategies/barrier/loop invariants; Node selftests cover the operator surface after cutover.
- **Secrets unchanged** — keys only in `~/.config/cc-model-secrets.env`; scan gate covers `engine/`.
- **Legacy Gemini CLI guard + review independence** — a `Policy`, not a convention.

## 9. Tooling (locked, Codex-reviewed)

| Concern        | Choice                                         | Why                                                                          |
| -------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| Package shape  | single `engine/`, no workspaces yet            | one CLI/engine; no package graph until adapters are independently reusable   |
| Build          | **tsup** (+ `tsc --noEmit` typecheck)          | simple ESM CLI bundling, sourcemaps, shebang                                 |
| Test           | **vitest**                                     | first-class TS/ESM, watch, coverage, mocks                                   |
| Property tests | **fast-check**                                 | invariants for ranking/barrier/loop state machines                           |
| Lint/format    | **ESLint flat + typescript-eslint + Prettier** | type-aware: zero `any`, no-floating-promises, import-type, exhaustive switch |
| CLI args       | **clipanion**                                  | typed nested subcommands, validation, generated help                         |
| Runtime        | Node ≥18.18, ESM, `NodeNext`                   | matches current baseline                                                     |
