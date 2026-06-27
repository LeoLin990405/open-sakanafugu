# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/), versioning [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **Stable `fuguectl self-harness` operator surface**: exposed the engine-native Self-Harness `template|run` commands through the production `fuguectl` entrypoint, added wrapper coverage, and extended docs drift checks so the operator guide keeps documenting the stable surface.
- **TypeScript engine Self-Harness loop (iter15)**: added the spec-driven `fugue self-harness template|run` CLI plus live Self-Harness adapters — `RunWeaknessMiner` mines `failed` / `no-agent` run events into verifier-grounded clusters, `HarnessBackedProposer` asks a configured harness agent for strict JSON full-surface replacement edits, and `TaskListHarnessValidator` re-runs fixed held-in / held-out cases with shell gates. Includes a strict JSON spec parser, `wireSelfHarness`, `docs/SELF_HARNESS.md`, robust balanced-array JSON extraction, defensive failure handling for expected harness/gate/model-output failures, and engine coverage for the live adapter edge cases.
- **Antigravity (`agy`) as a first-class harness**: added `AgyHarness` for `agy --prompt`, wired it through dispatch / plan / preflight / agent registry / docs, and made `target=default` use the current Antigravity settings while non-default targets pass through as `--model <target>`. `preflight --harness agy --target <model>` now validates against `agy models`, and the docs drift gate checks the canonical harness list plus rejects stale print-mode guidance.

### Changed

- **FuguNano repo identity cleanup**: the project and npm packages are now `FuguNano` / `@bicamindlabs/fugunano-engine`, and the product is presented as **FuguNano** — the lightweight, training-free engineering framework in the OpenFugu direction (Fugu and OpenFugu both train a coordinator; FuguNano replaces training with composable strategies). Updated project-name references, badges, install paths, default state paths, and hosting URLs to `BicaMindLabs/FuguNano`; the existing `fuguectl` operator command remains as the compatibility command surface.
- **Node-only operator cutover**: migrated the remaining `fuguectl` selftest suites from Bash to Node `.mjs`, deleted the retired shell launchers and shell-lint config, and made `fuguectl selftest` discover only `.test.mjs`. The launcher gate is now `npm run lint:launchers`: Node launchers must parse and any newly tracked shell script fails the gate. Current operator evidence: **20 test suites, 263 assertions**.
- **README and repo front door refresh**: renamed the Chinese mirror to `README.zh-CN.md`, added for-the-badge language/runtime/CI/license metrics, refreshed the bilingual overview diagrams, and updated docs/CI/pre-commit/package scripts to describe the Node wrapper + TypeScript engine architecture instead of the retired shell migration.
- **Runtime naming cleanup**: made `fugue-cc` the sole public provider-runtime name. The default dispatch harness is `fugue-cc`, `fuguectl runtime` is the maintenance command, provider config lives under `.fugue-cc/provider.config`, and docs/env vars now use only `FUGUE_CC_*`.
- **CI script split for the TypeScript engine**: root `make ci` / `npm run ci` now stay fast and use installed engine dependencies, while `make ci-clean` / `npm run ci:clean` run `npm ci` inside `engine/` before `npm run check`; README/PR guidance now points fresh clones at the clean path and documents the separate GitHub Actions engine job.
- **Interim operator refactors superseded by Node cutover**: the earlier shared-library cleanup removed duplicated helper logic and stabilized cached preflight probes; the final cutover now retires those shell helper files while keeping the behavior covered by the Node selftest suite.

### Fixed

- **Shell selftest stability under `pipefail`**: replaced the remaining `echo "$out" | grep -q ...` assertions in plan/skills/workspace tests with substring checks, removing SIGPIPE false negatives and bringing the operator selftest total to 322 passing assertions.
- **`fleet-launch.py` reports out-of-ptys to the caller**: a status pipe makes the launcher exit `127` with a clean message (no traceback) when the host is out of pty devices, instead of a silent `0`; the parent waits only for the 1-byte launch status, never for the long-running detached worker. The 3 pty-dependent fleet checks now auto-`skip` (rather than fail) when ptys are unavailable, so `fuguectl selftest` is deterministically green regardless of host pty pressure.

### Added

- **`docs/INTEGRATIONS.md`**: the **stable contract** for consuming fugue as an execution engine from a higher-level framework (fuguectl CLI / `--harness` dispatch / backends / allocate / cache / fleet / preflight / review independence); CivAgent integration roadmap (two repos with clean dependencies, not a flat merge).
- **Multi-harness adapters (the foundation for civagent dependency integration)**: `AGENTS.md` cross-harness entry point (read by Claude Code / Codex / OpenCode / Antigravity alike); `fuguectl dispatch --harness fugue-cc|codex|opencode|agy` — selectable dispatch executor (`fugue-cc` = Claude Code cc-\* clones through the configured provider runtime, codex=codex exec, opencode=opencode run, agy=agy --prompt), where `<target>` means different things per harness; `FUGUE_CODEX` / `FUGUE_OPENCODE` / `FUGUE_AGY` can be stubbed.
- Architecture SVG `docs/architecture.svg`, embedded in the README (image first + the text version tucked into `<details>`).
- GitHub repo About description + 12 topics + homepage.
- **Phase 5 `fuguectl loop` state machine**: turns the review-fix loop from SKILL.md pseudocode into an executable tool — `record` each round -> `decide` judges the 5 exit states (DONE / CONFIRM / CONTINUE / ESCALATE_MAX / ESCALATE_NONCONV), keep-best baseline maintained automatically, exit 0/10/20 graded. +24 self-tests.
- **Phase 3 `fuguectl integrate`**: worktree -> `main` cherry-pick tool, **conflict isolation** — a single-agent conflict does `cherry-pick --abort` to keep `main` clean while the rest land as usual (no longer `break`s the whole loop); carries an explicit committer identity, so it runs in environments/CI with no global git config. +19 self-tests.
- **Adaptive `fuguectl allocate`**: static lookup table -> **bench prior + battle-tested posterior, Bayesian blend** (Beta-Bernoulli; adds `record` / `stats` / `reset`; cold start == the old bench order, KAPPA controls drift, Laplace prevents starvation) = a training-free version of learned routing, fed by Phase 4/5 verdicts. allocate self-tests 8 -> 21.
- `fuguectl selftest` total assertions 119 -> 198 (16 test suites).
- **`scripts/check-docs.ts` docs-drift gate** (inspired by `kunchenguid/lavish-axi`'s `build:skill --check`, adapted for this repo's dual-variant SKILL.md without full generation): verifies the README documents every `fuguectl` subcommand, and that the subcommand-count / test-suite-count claims == the actual code. Goes into `make ci` / `npm run ci` / CI's launcher job. Catches "added a tool but the README numbers are stale" drift.

- **`fuguectl skills` local skills master directory + on-demand injection (progressive disclosure)**: `skills index` scans **3 sources** — user `~/.claude/skills` + `.system` meta-skills (incl. official `skill-creator`/`plugin-creator`/`skill-installer`) + plugin marketplace (`marketplaces/`, `plugin:skill` id, deduped by id to avoid cache duplicates) — parsing the SKILL.md frontmatter (inline + YAML folded `>-`) -> one compact catalog (`id·source·type·path·desc`, classified by functional/note prefix); `skills list/match/show/inject` (all support `--source` filtering); `dispatch --skills "a,b"` injects the selected skills into that agent's context — a weak model crawls only what it should, not drowned by 500+ skills. Three steps: index the master directory -> Planner reads the directory and assigns -> dispatch --skills injects each. Measured locally at 556 skills (user 364 / plugin 187 / system 5). **`skills forge` closed loop: settle -> create -> file back by category**: gather material (`--from-experience <ws/slug>` / `--source` / stdin) -> candidate gate (only settle if the material is thick enough) -> assemble an authoring brief -> (`--agent` dispatches a worker with `skill-creator` injected to write it, otherwise prints the brief) -> add the **`skills validate`** acceptance gate (mirrors the official `quick_validate.py` checks: SKILL.md/frontmatter/name hyphen-case<=64/description<=1024 with no angle brackets/valid keys; self-contained with no PyYAML dependency, `--official` prefers the official quick_validate.py when present locally; forge loop = write -> validate passes -> index --refresh) -> feed back into the master directory. **Authoring is delegated to the official skill-creator, not a re-invented distiller** (skills-master/Skill Forge is the same domain). +44 self-tests (skills 51 incl. the bidirectional loop + dispatch 2). subcommands 17 -> 18, test suites 17 -> 18, total assertions -> 312.
- **`fuguectl integrate` out-of-bounds detection (inspired by Lynn's orchestrator-side ownership)**: `--ownership <file>` (TSV `agent⇥owned-globs⇥forbidden-globs`) validates each worker's diff before cherry-pick — touched a file outside owned / matching a forbidden glob -> flagged `violation` and withheld entirely (isolated like a conflict, exit non-0), no blind merge. "Enforced on the orchestrator side, don't trust the prompt." Agents not on the list are unrestricted (backward compatible). integrate self-tests 19 -> 29, total assertions -> 259.
- **Adaptive allocation iteration: Thompson Sampling + discounted forgetting (bandit literature)**: `allocate <type> --sample` switches the ranking from greedy posterior mean to **Thompson Sampling** (Gaussian-approximated Beta sampling, exploring low-sample agents, not locking in a winner early; Agrawal-Goyal 2012, seed-fixable via `FUGUE_ALLOCATE_SEED`); `allocate decay --gamma G [--type T]` discounts stale stats (`s,f ×G`, used after a model upgrade; non-stationary bandit, Garivier-Moulines 2011). Default is still greedy mean (backward compatible). allocate self-tests 32 -> 41, total assertions -> 249.
- **Adaptive allocation data flywheel (verdicts auto-fed back)**: `fuguectl dispatch --task-type T` records `(T, agent)` into the alloc ledger; `fuguectl allocate feed --from-ledger --result ok [--fail <reworked agent>]` feeds a whole round's verdict into the posterior at once (also supports explicit batch `feed type:agent:result`). **Agent-name normalization** (`cc-doubao` -> bench's `doubao`) lands the experience on the same key as the ranking, truly closing the flywheel. allocate self-tests 21 -> 32, dispatch +2, total assertions -> 240.
- **`fuguectl run` cross-phase run-status facade (axi-inspired)**: inspired by `kunchenguid/no-mistakes`'s axi idea, but without copying the daemon model — introduces a lightweight 'current run' context (`.fuguectl-cache/run.meta` records the active TASK+round), `run status` aggregates TASK / cache barrier (M of N) / loop decision / best into **one machine-parseable JSON** object (`--human` emits a human-readable summary), `run next` emits a next-action hint. Makes a single parallel dispatch run structurally queryable/resumable without changing the operator orchestration model. Adds the `fuguectl run` wrapper + 21 self-tests (incl. JSON validity checks). subcommands 16 -> 17, test suites 16 -> 17, total assertions -> 227.
- **`fuguectl loop` finding bisection (auto-fix / ask-user)**: inspired by `kunchenguid/no-mistakes`'s finding model — `record --ask-user K` marks how many of N findings touch intent (architecture/semantics/trade-offs); `decide` adds the **`ASK_USER`** exit state (exit 11): the intent-touching ones escalate to a human for approve/fix/skip, the rest are mechanically Edit-patched directly by Claude. Lower priority than ESCALATE_MAX/NONCONV. loop self-tests 24 -> 32. selftest total assertions 198 -> 206.

### Changed

- **Renamed the public repo to FuguNano**: FuguNano keeps the multi-agent coordination metaphor while making the public repo name explicit and lightweight; the Sakana Fugu framing stays in the README as "inspired by." Updated project-name references and hosting URLs to BicaMindLabs/FuguNano.
- **Differentiate from OpenFugu**: the `Relation to Sakana Fugu` section (both READMEs) now points to [trotsky1997/OpenFugu](https://github.com/trotsky1997/OpenFugu) — a sibling open _reimplementation_ that actually trains TRINITY/Conductor and serves an API — and states plainly that FuguNano deliberately takes the training-free harness route. OpenFugu added to Acknowledgements.
- **Bilingual README restored (EN + 简体中文)**: keeps `README.md` and `README.zh-CN.md` as full, current mirrors. Added language switching to both, and restored bilingual enforcement in `check-docs.ts` (every `fuguectl <sub>` + the subcommand/test-suite counts must match the code in _both_ READMEs — EN "N subcommands"/"N test suites", ZH "N 个子命令"/"N 套测试"). The rest of the repo stays English-only; only the README is bilingual.
- **Repositioned the narrative around Sakana Fugu (the new name's framing)**: the README intro now leads with "many agents behind one interface, coordinated by orchestration not a bigger model," presents the 9-model fleet as the _workers_ under that lens, and adds a **Relation to Sakana Fugu** section mapping TRINITY/Conductor concepts to this repo's pieces (one `fuguectl` CLI = the interface; Codex = the verifier; the Beta-Bernoulli `allocate` bandit = a training-free analogue of the learned coordinator; workspace/skills/ownership isolation = access-lists) with an honest same/different (training-free, self-hostable, inspired-not-derived). Acknowledgements + NOTICE credit Sakana AI's Fugu.
- **Repo docs are English-first with bilingual README**: non-README project docs, comments, templates, and CI text are English; the README pair remains bilingual and enforced by `check-docs.ts`.
- **README restructure**: the `fuguectl` CLI table went from a flat 17 rows -> grouped by pipeline phase (Setup & recon / Plan & routing / Dispatch & collect / Integrate·review·loop / Observe & maintain), easier to scan; the "why" + design principles add **adaptive routing** (Bayesian bandit) and the **docs-match-code gate**; acknowledgements add `kunchenguid/no-mistakes`+`lavish-axi` (finding bisection/run facade/drift gate) and the multi-armed bandit literature (Thompson Sampling, discounted bandit). A fuguectl launcher audit confirmed consistent style and Node wrapper coverage. The README promotes the **skills master-directory loop** from a CLI table cell into the narrative — `Why` / `Workflow entry patterns` / `Design principles` each add a line (progressive disclosure + skills settling back into the master directory: index -> dispatch -> forge -> validate -> re-index). Full pass over the README to align with the real repo: fix the `scripts/` line, acknowledgements add **merkyor/Lynn** (ownership) + **Anthropic `skill-creator`** (forge authoring/validate mirror), and `NOTICE` synced into the full acknowledgement set (Zleap/no-mistakes/lavish-axi/Lynn/skill-creator/bandit literature).

### Fixed

- **`fuguectl fleet status` / `preflight` false readiness**: the old version only grep'd `health` / `state`, so `mount_state: unmounted` and `desired_state: running` (config intent != actual mount) would false-match -> false ready/GO -> dispatch stuck in an empty queue. Changed to require `^mount_state:[[:space:]]*mounted`, with unmounted / desired_state regression tests added.

## [1.0.0] - 2026-06-21

First public release — the provider-backed multi-agent coding workflow plus its full tooling and engineering layer.

### Added

**Foundation**

- `backends/` — provider-backed model profiles: `cc_model_launch` shared core + thin launchers + `cc-model-registry.tsv` + `cc-models` dispatcher + `cc-sync` (auto-follow Claude Code + model updates) + research-prompt + install/verify/prompts.
- `orchestration/fuguectl/SKILL.md` — 5-phase workflow + Phase 5 Review-Fix Loop v2 (deterministic gate first / keep-best / ≥2 confirmation passes / meta-reflect on non-convergence).
- `orchestration/fugue-cc/provider.config.example` — sanitized multi-window fugue-cc topology template.
- `orchestration/cn-plugin/cn/` — `/cn:*` commands + `cn-dispatch` (derived from openai/codex-plugin-cc).
- `docs/WORKFLOW.md` — end-to-end pipeline + two run modes + maintenance layer + security boundary.

**`fuguectl` CLI tooling layer** — unified driver `orchestration/fuguectl/fuguectl` (doctor/fleet/preflight/task/template/dispatch/cache/allocate/workspace/experience/plan/goal/summary/runtime/selftest):

- `fuguectl-doctor` — environment recon + workflow recommendation.
- `fuguectl-preflight` — go/no-go gate (deps / provider daemon / provider config sanity / **legacy Gemini CLI guard** / `--probe` endpoint liveness / `--config-only`).
- `fuguectl-fleet` + `fleet-launch.py` — bring up/check/stop the fugue-cc fleet; strips `CLAUDE_CODE_*` (OAuth false-401) + detached tmux, with `--pty` (pty.fork) fallback. Solves "stuck-in-queue, no worker".
- `fuguectl-cache` — result cache + **join barrier** (dispatch N ⇒ return N) + timing + resume.
- `fuguectl-task` — TASK scaffolder (new/log/done, cross GNU/BSD sed).
- `fuguectl-template` + `templates/` — externalized prompt templates (impl/analysis/review).
- `fuguectl-dispatch` — wraps `fugue-cc ask` (render → dispatch → log; `--workspace`), with `--verbose` stderr observability and TASK-log duration/output-size/optional artifact metadata for harness runs.
- `fuguectl-summary` — round observability summary (status + elapsed).
- `fuguectl-allocate` + `allocation.tsv` — bench-driven task-type → model allocation.
- `fuguectl-workspace` + `workspaces/` — per-task **context isolation** (`System + Workspace + Tools + Memory + History`), inspired by Zleap-Agent.
- `fuguectl-experience` — **experience memory** (completed work → reusable method → sanitized → recalled into workspace context), inspired by Zleap-Agent.
- `fuguectl-plan` — multi-model planning panel (design panel), with `--timeout-ms` / `--harness-arg` runtime controls, per-agent duration output, and optional `--task` audit lines for planner status, output size or error kind/exit code, plus artifact paths across Codex/OpenCode/AGY/fugue-cc planning.
- `fuguectl-goal` — **goal mode**: declarative spec + deterministic acceptance gate.
- `fuguectl runtime` + `launchd/com.user.fugunano-runtime-sync.plist.example` — runtime provider sync for version drift / grafting checks / daemon restart.

**Agent Team** — `docs/AGENT_TEAM.md` (multi-model planning + hierarchical sub-agents: fugue-cc fleet vs. native Claude Code subagents) + `orchestration/agent-team/team-review.workflow.mjs` (Workflow orchestration example).

**Frontend** — agy (Antigravity) as Frontend Implementer (manual, `--harness agy`, or headless `agy --prompt`); frontend-capable implementer runtime, while review stays independent.

**Install** — `scripts/install-skill.ts` + `make install-skill` → install as a Claude Code Skill (`~/.claude/skills/fugunano`, backs up existing); bilingual `/fugunano` triggers.

**Engineering** — CI (`secret-scan` + launcher lint + `node`), `scripts/scan-secrets.ts` + `scripts/check-launchers.ts` (shared by Make/CI/pre-commit), `.gitleaks.toml`, `.pre-commit-config.yaml`, `Makefile`, `.editorconfig`, `.gitattributes`, `package.json`, `SECURITY.md`, `CONTRIBUTING.md`, PR/issue templates. **14 test suites, 119 assertions; CI green.**

### Documentation

- Bilingual GitHub-standard README: English `README.md` + `README.zh-CN.md` (badges / TOC / architecture / CLI reference / workflow / security / acknowledgements). Acknowledges openai/codex-plugin-cc (Apache-2.0) + Zleap-Agent (concepts).

[Unreleased]: https://github.com/BicaMindLabs/FuguNano/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/BicaMindLabs/FuguNano/releases/tag/v1.0.0
