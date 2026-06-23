# Parity tracker — bash `fanout` → TypeScript engine

Tracks the incremental migration (see [ARCHITECTURE.md](ARCHITECTURE.md) §5). The bash `fanout` stays green at every step; a capability only cuts over once its TS slice meets or beats the bash suite's coverage. Until then the engine is opt-in (`FUGUE_ENGINE=1`).

Legend: `bash ✓` shipped in shell · `ts …` engine status · **cutover** = bash retired/shimmed.

| # | Capability (bash subcommand) | Primary port | bash | ts | cutover |
|---|---|---|---|---|---|
| 1 | `allocate` (+ record/feed/stats/decay) | `AllocationStrategy` | ✓ | ☐ iter1.5 | ☐ |
| 2 | `cache` (+ barrier/collect/resume) | `ResultStore` / `Barrier` | ✓ | ☐ iter1 | ☐ |
| 3 | `loop` (record/decide/status) | `ReviewLoop` | ✓ | ☐ | ☐ |
| 4 | `preflight` (+ --probe) | `QualityGate` (Preflight/NoGemini) | ✓ | ☐ | ☐ |
| 5 | `goal` (template/show/check) | `QualityGate` (acceptance) | ✓ | ☐ | ☐ |
| 6 | `integrate` (+ --ownership) | `IntegrationGuard` | ✓ | ☐ | ☐ |
| 7 | `workspace` (list/show/model/context) | `Workspace` / `ContextAssembler` | ✓ | ☐ | ☐ |
| 8 | `experience` (add/recall/...) | `ExperienceStore` | ✓ | ☐ | ☐ |
| 9 | `skills` (index/match/inject/forge/validate) | `SkillCatalog` | ✓ | ☐ | ☐ |
| 10 | `dispatch` (--harness ...) | `Harness` + `Phase` | ✓ | ☐ | ☐ |
| 11 | `fleet` (status/up/down) | `Harness.health` + launcher | ✓ | ☐ | ☐ |
| 12 | `doctor` | recon (composition of `Harness.health`/gates) | ✓ | ☐ | ☐ |
| 13 | `plan` (multi-model panel) | `Phase` (planning) | ✓ | ☐ | ☐ |
| 14 | `run` (set/round/status/next) | `RunState` facade | ✓ | ☐ iter1 | ☐ |
| 15 | `summary` | observability over `RunState`/`ResultCache` | ✓ | ☐ | ☐ |
| 16 | `task` (new/log/done) | `Task` audit trail | ✓ | ☐ | ☐ |
| 17 | `template` (render) | `ContextAssembler` (template part) | ✓ | ☐ | ☐ |
| 18 | `ccb-sync` (check/adapt) | `Harness` (ccb) maintenance | ✓ | ☐ | ☐ |
| — | `(coordinator)` — wires the 5-phase pipeline | `Coordinator` | n/a (driver) | ☐ last | ☐ |

Migration order (riskiest-last): pure strategies/state first (`allocate`, `loop`, `cache`, gates), then stores (`workspace`/`experience`/`skills`), then IO-heavy adapters (`harness`/`fleet`/`dispatch`), then the `Coordinator`.
