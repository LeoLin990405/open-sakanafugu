# AGENTS.md — fugue

Cross-harness entry for any coding agent (**Claude Code / Codex / OpenCode** all read this file). This repo is a multi-agent coding workflow driven by one harness-agnostic bash CLI — so the same workflow runs no matter which agent you are.

## One entry point

```
orchestration/fanout/fuguectl help
```

Unified driver (18 subcommands): `doctor` · `fleet` · `preflight` · `task` · `template` · `dispatch` · `cache` · `integrate` · `allocate` · `skills` · `workspace` · `experience` · `plan` · `goal` · `loop` · `run` · `summary` · `ccb-sync`. Every subcommand is plain bash — callable from any shell / harness. `orchestration/fanout/fanout` remains a backward-compatible alias.

## The workflow (5 phases)

Plan → Dispatch → Integrate → Review → **bounded Review-Fix Loop**. Full spec: [`orchestration/fanout/SKILL.md`](orchestration/fanout/SKILL.md) · [`docs/WORKFLOW.md`](docs/WORKFLOW.md). Higher-level entry modes: `goal` (declarative target + gate), `plan` (multi-model planning panel), `workspace` (per-task context isolation).

## Multi-harness dispatch

The implementer backend is selected by `--harness`:

```
fuguectl dispatch <target> --harness ccb|codex|opencode [--workspace ws] [--template impl --set ...]
```

| harness         | runs                                                   | `<target>` is                                |
| --------------- | ------------------------------------------------------ | -------------------------------------------- |
| `ccb` (default) | Claude Code instances — the `cc-*` Chinese-model fleet | a ccb agent (e.g. `cc-deepseek`)             |
| `codex`         | `codex exec`                                           | a Codex model (e.g. `gpt-5.5`)               |
| `opencode`      | `opencode run`                                         | `provider/model` (e.g. `doubao/doubao-code`) |

Reviewer (`coder`) and planner are likewise harness-agnostic.

## Hard rules (apply to every harness)

- **`main` is the single source of truth** — implementers work in worktree sandboxes; only reviewed changes are cherry-picked back.
- **Generation ≠ review** — implementers and the reviewer must be different model families.
- **Bounded loop** — deterministic gate first, keep-best, meta-reflect on non-convergence; capped then escalate. Never loops forever, never hard-marks DONE.
- **Fan-in barrier** — dispatch N ⇒ N must return before the next round.
- **Keys only in `~/.config/cc-model-secrets.env`** — never in the repo (CI + pre-commit scan blocks leaks).
- **No Gemini in the review path** — review / second opinions go to Codex or a Chinese backend.

## Before dispatching

```
fuguectl preflight        # go/no-go gate (deps · ccbd · ccb.config sanity · no-Gemini guard)
fuguectl fleet status     # is the backend fleet up? (if down → fuguectl fleet up)
```

Never dispatch when preflight is NO-GO.

## Dev

`make ci` (secret scan + shellcheck + tests). See [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`SECURITY.md`](SECURITY.md).
