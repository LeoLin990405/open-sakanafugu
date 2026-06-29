# Parity tracker — Node `fuguectl` → TypeScript engine

Tracks the migration described in [ARCHITECTURE.md](ARCHITECTURE.md) §5. The
repository has now cut over: there are no tracked `.sh` scripts, `fuguectl` is a
set of small Node wrappers, and the strict TypeScript engine owns the tested
domain behavior.

Legend: `operator` = production `fuguectl` wrapper status · `engine` = typed
core/CLI status (`◐ core` = ports+adapters landed and tested; `+ cli` = the
`fugue` CLI command drives that core) · `cutover` = legacy script retired.

The TS CLI (`fugue`, clipanion) exposes `fugue version`, `fugue doctor`,
`fugue fleet`, `fugue allocate`, `fugue dispatch`, `fugue integrate`,
`fugue skills`, `fugue preflight`,
`fugue cache init|put|fail|status|barrier|collect|list|resume`, `fugue plan`,
`fugue task new|log|done|handoff`, `fugue template`,
`fugue workspace list|show|model|context`,
`fugue experience add|audit|eval|learn|list|policy|promote|recall|show`, `fugue summary`,
`fugue runtime check|adapt`, `fugue run set|round|status|next|clear`,
`fugue loop init|record|decide|next|status`, `fugue goal template|show|check`,
`fugue agent-registry template|validate|list|resolve`, and
`fugue self-harness template|run`. Build emits `dist/cli/main.js` (shebang
preserved → `npx fugue`).

| #   | Capability                                                   | Primary port                                                             | operator       | engine                                | cutover |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------ | -------------- | ------------------------------------- | ------- |
| 1   | `allocate` (+ record/feed/stats/decay)                       | `AllocationStrategy`                                                     | ✓ Node wrapper | ◐ core + cli (iter16)                 | ☑       |
| 2   | `cache` (+ barrier/collect/resume)                           | `ResultStore` / `Barrier`                                                | ✓ Node wrapper | ◐ core + cli (iter16)                 | ☑       |
| 3   | `loop` (record/decide/status)                                | `ReviewLoop`                                                             | ✓ Node wrapper | ◐ core + cli (iter16)                 | ☑       |
| 4   | `preflight` (+ --probe)                                      | `QualityGate` + `Policy` (legacy CLI/gen≠review)                         | ✓ Node wrapper | ◐ core + cli (iter16)                 | ☑       |
| 5   | `goal` (template/show/check)                                 | `GoalSpec` + acceptance gate                                             | ✓ Node wrapper | ◐ core + cli (iter13)                 | ☑       |
| 6   | `integrate` (+ --ownership)                                  | `Integrator` + `VcsPort` + ownership                                     | ✓ Node wrapper | ◐ core + cli (iter16)                 | ☑       |
| 7   | `workspace` (list/show/model/context)                        | `Workspace` / `ContextAssembler`                                         | ✓ Node wrapper | ◐ core + cli (iter16)                 | ☑       |
| 8   | `experience` (add/audit/recall/...)                          | `ExperienceStore`                                                        | ✓ Node wrapper | ◐ core + cli (iter16)                 | ☑       |
| 9   | `skills` (index/list/match/show/inject/validate/forge)       | `SkillCatalog`                                                           | ✓ Node wrapper | ◐ core + cli (iter16)                 | ☑       |
| 10  | `dispatch` (--harness ...)                                   | `Harness` + `Phase`                                                      | ✓ Node wrapper | ◐ core + cli (iter16)                 | ☑       |
| 11  | `fleet` (status/up/down)                                     | `Harness.health` + launcher                                              | ✓ Node wrapper | ◐ health + cli (iter16)               | ☑       |
| 12  | `doctor`                                                     | recon + recommend                                                        | ✓ Node wrapper | ◐ core + cli (iter13)                 | ☑       |
| 13  | `plan` (multi-model panel)                                   | planPanel (Harness parallel dispatch)                                    | ✓ Node wrapper | ◐ core + cli (iter16)                 | ☑       |
| 14  | `run` (set/round/status/next)                                | `RunState` facade (`RunStore`)                                           | ✓ Node wrapper | ◐ core + cli (iter16)                 | ☑       |
| 15  | `summary`                                                    | observability over `RunState`/`ResultCache`                              | ✓ Node wrapper | ◐ core + cli (iter16)                 | ☑       |
| 16  | `task` (new/log/done)                                        | `TaskStore` audit trail                                                  | ✓ Node wrapper | ◐ core + cli (iter13)                 | ☑       |
| 17  | `template` (render)                                          | `ContextAssembler` (template part)                                       | ✓ Node wrapper | ◐ core + cli (iter16)                 | ☑       |
| 18  | `runtime` (check/adapt)                                      | Runtime/provider sync + installed workflow bundle drift                  | ✓ Node wrapper | ◐ core + cli (iter16)                 | ☑       |
| 19  | `agents` / `(agent-registry)` — logical agents over runtimes | `AgentRegistry` + `Coordinator` harness map                              | ✓ Node wrapper | ◐ core + cli `agent-registry`         | ☑       |
| —   | `(coordinator)` — wires the ports into the pipeline          | `Coordinator` + `wire.ts`                                                | n/a            | ◐ core (iter12)                       | n/a     |
| —   | `(self-harness)` — self-improving harness loop               | `SelfHarnessLoop` + `WeaknessMiner`/`HarnessProposer`/`HarnessValidator` | n/a (net-new)  | ◐ core + live adapters + cli (iter15) | n/a     |

Migration order (riskiest-last): pure strategies/state first (`allocate`, `loop`, `cache`, gates), then stores (`workspace`/`experience`/`skills`), then IO-heavy adapters (`harness`/`fleet`/`dispatch`), then the `Coordinator`.

Beyond parity — **net-new capabilities** that abstract a studied reference into the engine ("our own thing", not a port). `(agent-registry)` is the first runtime-neutral orchestration slice: logical ids now resolve to a harness (`fugue-cc`, `codex`, `opencode`), a harness-native target, workspace metadata, and a model-family policy label, so Codex/Claude Code/OpenCode can share one dispatch flow instead of living in separate runtime conventions. The `fuguectl agents` Node wrapper exposes template/validate/list/resolve for operators, while the strict TS engine owns coordinator routing. `(runtime guard packets)` adapt AgentSpec ([arXiv 2503.18666](https://arxiv.org/abs/2503.18666)), AgentVisor ([arXiv 2604.24118](https://arxiv.org/abs/2604.24118)), and CaMeL ([arXiv 2503.18813](https://arxiv.org/abs/2503.18813)) into `guard prompt <file|->`: a deterministic pre-dispatch packet that flags prompt-injection language, untrusted input mixed with privileged actions, destructive commands without approval, missing source refs, secret-exfiltration risk, and missing action-certificate markers. `(incident packets)` adapt HarnessFix ([arXiv 2606.06324](https://arxiv.org/abs/2606.06324)), MAST ([arXiv 2503.13657](https://arxiv.org/abs/2503.13657)), and execution provenance ([arXiv 2606.04990](https://arxiv.org/abs/2606.04990)) into `incident packet <file|->`: a deterministic failure packet that labels raw logs with local cause, MAST category, harness layer, source hash, line evidence, and recovery checks before repair/learning. `(incident recovery packets)` adapt PROBE ([arXiv 2605.08717](https://arxiv.org/abs/2605.08717)), AIR ([arXiv 2602.11749](https://arxiv.org/abs/2602.11749)), failure-aware observability ([arXiv 2606.01365](https://arxiv.org/abs/2606.01365)), and silent-failure postmortems ([arXiv 2606.14589](https://arxiv.org/abs/2606.14589)) into `incident recovery <file|incident-json|->`: a deterministic evidence gate plus containment, repair, validation, and learning steps that block when no line evidence exists. `(dispatch action certificates)` adapt Proof-Carrying Agent Actions ([arXiv 2606.04104](https://arxiv.org/abs/2606.04104)) into `dispatch --certificate <file>`: a runtime-neutral JSON sidecar with harness/target, prompt/output hashes, approval class, assumptions, externality facts, outcome, and five checkpoints. `(self-harness)` realizes Shanghai Artificial Intelligence Laboratory's Self-Harness paper ([arXiv 2606.09498](https://arxiv.org/abs/2606.09498)): with the model/evaluator/benchmark held fixed, only the harness config evolves — each round mines verifier-grounded weaknesses, proposes bounded single-surface edits, and promotes one only under the non-regression gate `Δin ≥ 0 ∧ Δho ≥ 0 ∧ max > 0`. Iter15 adds the live model-backed miner/proposer, task-list validator, JSON spec parser, `wireSelfHarness`, and `fugue self-harness template|run` in the TS CLI; `fuguectl self-harness template|run` is the stable operator surface for that engine capability. See [SELF_HARNESS.md](SELF_HARNESS.md) for the operator guide. It composes with the bandit `AllocationStrategy` (which picks _who_ runs) by learning _how the harness is configured_.
