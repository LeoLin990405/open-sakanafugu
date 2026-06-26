# Using Fugunano as an execution engine

Fugunano is built to be **consumed by higher-level frameworks** as their multi-agent _execution layer_, while the framework on top owns the _orchestration patterns_ and UX. The first such consumer is [**CivAgent**](https://github.com/LeoLin990405/civagent) — a research framework that encodes multi-agent orchestration as 57 historical governance regimes; civagent stays the foundation/umbrella, Fugunano is the engine it calls.

This doc is the **stable contract** downstream depends on.

## What downstream gets

| Capability                  | Interface                                                        | Notes                                                                        |
| --------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Runtime profiles            | `fuguectl agents template\|validate\|list\|resolve`              | `AgentRegistry` maps logical ids to harness-native targets                   |
| Harness-agnostic dispatch   | `fuguectl dispatch <target> --harness fugue-cc\|codex\|opencode` | one call dispatches an implementer on any supported harness                  |
| Bench-driven model choice   | `fuguectl allocate <task-type> [--top]`                          | task-type → recommended model                                                |
| Result cache + join barrier | `fuguectl cache …`                                               | dispatch N ⇒ return N before next round                                      |
| Fleet lifecycle             | `fuguectl fleet status\|up\|down`                                | strips `CLAUDE_CODE_*` + detached tmux / pty.fork for the `fugue-cc` runtime |
| Preflight gate              | `fuguectl preflight`                                             | deps · provider mount/config sanity · **no-Gemini guard**                    |

All of the above are plain CLI commands on `$PATH` (install the skill or add `orchestration/fuguectl/` to `$PATH`) — language-agnostic, callable from a Node/Go/Python framework via `child_process`/`exec`.

## Shared policy

- **No Gemini** in the review path (both projects enforce this — civagent's `engine/models/providers.json` `_policy` matches Fugunano's no-Gemini guard).
- **Keys never in either repo** — only `~/.config/cc-model-secrets.env`.

## How CivAgent consumes it

CivAgent's `engine/v5/backends.mjs` already maps its backend ids to Fugunano's launchers (`cn:doubao → cc-doubao`, …) — so it is **already an implicit consumer**. The integration roadmap makes that dependency explicit:

1. **Now (foundation)** — Fugunano is a stable, harness-agnostic engine (`fuguectl` CLI + `AGENTS.md` + `--harness`). ✅
2. **Next** — civagent declares Fugunano as a dependency (README/CREDITS + a presence check that the `cn:*` backends resolve to installed `cc-*` launchers).
3. **Future** — civagent routes implementer dispatch through `fuguectl dispatch --harness` to inherit the cache + join barrier + review-fix loop, instead of spawning `cc-*` directly. Best landed **after** civagent's in-flight `refactor/backend-arg-contract` merges (it touches the same `backends.mjs`).

> Two repos, clean dependency (civagent → Fugunano). Not a flat merge: licenses differ (Fugunano Apache-2.0, civagent MIT) and civagent carries a large frontend — a documented dependency keeps both clean and reversible.
