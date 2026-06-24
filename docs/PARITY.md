# Parity tracker — bash `fanout` → TypeScript engine

Tracks the incremental migration (see [ARCHITECTURE.md](ARCHITECTURE.md) §5). The bash `fanout` stays green at every step; a capability only cuts over once its TS slice meets or beats the bash suite's coverage. Until then the engine is opt-in (`FUGUE_ENGINE=1`).

Legend: `bash ✓` shipped in shell · `ts …` engine status (`◐ core` = ports+adapters landed & tested, CLI surface not yet wired) · **cutover** = bash retired/shimmed.

| # | Capability (bash subcommand) | Primary port | bash | ts | cutover |
|---|---|---|---|---|---|
| 1 | `allocate` (+ record/feed/stats/decay) | `AllocationStrategy` | ✓ | ◐ core (iter3) | ☐ |
| 2 | `cache` (+ barrier/collect/resume) | `ResultStore` / `Barrier` | ✓ | ◐ core (iter1) | ☐ |
| 3 | `loop` (record/decide/status) | `ReviewLoop` | ✓ | ◐ core (iter2) | ☐ |
| 4 | `preflight` (+ --probe) | `QualityGate` + `Policy` (no-Gemini/gen≠review) | ✓ | ◐ core (iter4, deterministic) | ☐ |
| 5 | `goal` (template/show/check) | `GoalSpec` + acceptance gate | ✓ | ◐ core (iter10) | ☐ |
| 6 | `integrate` (+ --ownership) | `Integrator` + `VcsPort` + ownership | ✓ | ◐ core (iter8) | ☐ |
| 7 | `workspace` (list/show/model/context) | `Workspace` / `ContextAssembler` | ✓ | ◐ core (iter6) | ☐ |
| 8 | `experience` (add/recall/...) | `ExperienceStore` | ✓ | ◐ core (iter7) | ☐ |
| 9 | `skills` (index/match/inject) | `SkillCatalog` | ✓ | ◐ core (iter9) | ☐ |
| 10 | `dispatch` (--harness ...) | `Harness` + `Phase` | ✓ | ◐ core (iter5) | ☐ |
| 11 | `fleet` (status/up/down) | `Harness.health` + launcher | ✓ | ◐ health (iter5) | ☐ |
| 12 | `doctor` | recon + recommend | ✓ | ◐ core (iter11) | ☐ |
| 13 | `plan` (multi-model panel) | planPanel (Harness fan-out) | ✓ | ◐ core (iter11) | ☐ |
| 14 | `run` (set/round/status/next) | `RunState` facade (`RunStore`) | ✓ | ◐ core (iter1) | ☐ |
| 15 | `summary` | observability over `RunState`/`ResultCache` | ✓ | ◐ core (iter10) | ☐ |
| 16 | `task` (new/log/done) | `TaskStore` audit trail | ✓ | ◐ core (iter10) | ☐ |
| 17 | `template` (render) | `ContextAssembler` (template part) | ✓ | ◐ core (iter6) | ☐ |
| 18 | `ccb-sync` (check/adapt) | CcbSync (drift detect) | ✓ | ◐ core (iter11) | ☐ |
| — | `(coordinator)` — wires the 5-phase pipeline | `Coordinator` | n/a (driver) | ☐ last | ☐ |

Migration order (riskiest-last): pure strategies/state first (`allocate`, `loop`, `cache`, gates), then stores (`workspace`/`experience`/`skills`), then IO-heavy adapters (`harness`/`fleet`/`dispatch`), then the `Coordinator`.
