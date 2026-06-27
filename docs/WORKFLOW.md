# End-to-End Workflow Walkthrough

The complete pipeline that takes a requirement from "one sentence" all the way to "reviewed and merged into the main branch."
Four roles, seven phases — fully replayable, interruptible, and auditable.

---

## Roles

| Layer                  | Who                                                                                            | Does                                                                     | Does not do                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Strategy / Planner     | Human operator or a frontier planning agent                                                    | Write requirements, split tasks, set acceptance criteria                 | Does not enter a worker runtime pane, does not write bulk implementation code     |
| Execution + Supervisor | Any operator agent that can run fugue commands: Claude Code, Codex, OpenCode, or a human shell | Dispatch profiles, integrate, run the quality gate, run tests, log TASKs | Does not hand-write large blocks of implementation except focused Phase 5 patches |
| Implementers           | Agent runtime profiles backed by `fugue-cc`, Codex, OpenCode, or future harnesses              | Write subtasks each in their own worktree or scoped runtime              | Do not read each other's code, do not touch the main branch                       |
| Frontend (opt-in)      | Frontend-capable implementer profile such as Antigravity (`agy` CLI), when policy permits      | Frontend/UI subtasks, manual IDE or headless `agy --prompt`              | **Does not enter the Phase 5 loop; normally never acts as reviewer**              |
| Reviewer               | Independent review profile, usually Codex or another configured reviewer                       | Adversarial review, gives VERDICT + Findings                             | Does not write implementation (keeps generation != review independence)           |

> The maintenance layer **cc-sync** is not on the request path; it is a background launchd daemon: CC upgrade tracking + model refresh + monthly rebuild.

---

## The Seven-Phase Pipeline

### Phase 0 — Open the Task (Planner)

The planner writes the requirement into a task file such as `~/.claude/tasks/TASK-YYYY-MM-DD-NNN.md`: requirements / subtasks (annotated with the logical agent profile) / acceptance criteria / output files. This is the single source of intent for the whole pipeline.
When using the planning panel, pass `fuguectl plan "<goal>" --task <file>` so planner start/completion status, output size or error kind/exit code, and artifact paths are written into the same audit trail.

### Phase 1 — Split and Assign (fuguectl)

The operator reads the task, splits it into parallelizable subtasks, and picks logical agent profiles by the decision tree:

- Chinese-language scenario / provider-specific API / SQL -> matching model profile (doubao/qwen/glm/kimi...)
- English / algorithms / refactoring -> Codex or a strong-reasoning profile (deepseek/minimax)
- Math and logic -> stepfun
- One subtask = one independent, copy-ready prompt (**no broadcasting a single generic prompt to everyone**).

### Phase 2 — Parallel Implementation + Cache + join barrier (Implementers)

After the selected runtimes pass preflight (`fuguectl doctor`, `fuguectl preflight --harness <name>`, and `fuguectl fleet status` when using the `fugue-cc` worktree fleet):

1. **Open this round's cache**: `fuguectl cache init <round> t1:cc-deepseek t2:cc-glm t3:agy ...` — declare the N tasks dispatched this round (the parallel dispatch manifest).
2. **Dispatch**: `fuguectl dispatch <agent> --harness fugue-cc|codex|opencode|agy --prompt-file <prompt>` (or `--prompt <text>` for a quick smoke check; add `--verbose` to print timing/output-size observability to stderr; pass `--task <file>` to persist runtime metadata plus any `--out` artifact path into the audit log) or use an engine `AgentRegistry` so the coordinator resolves the harness from the logical profile; each implementer edits in its own worktree or scoped runtime.
3. **Results land in the cache first**: each agent's output goes to `fuguectl cache put <round> <task_id> <file>` (dead/timed-out -> `fail`, which also counts as "returned"). **Never read from volatile chat/scrollback.**
4. **join barrier (hard gate)**: `fuguectl cache barrier <round> --wait 600` — **if N were dispatched, N must come back** (all terminal) for exit 0; otherwise Phase 3 is not allowed. Stuck tasks surface here and are never silently dropped.

> Logical contract: however many tasks Claude Desktop dispatched, that many must come back before entering the next round. Every round (including each loop of Phase 5) passes this barrier.

### Phase 3 — Integration (fuguectl)

Once the barrier passes (all N returned), the operator pulls outputs from the cache (`fuguectl cache collect <round>`) + cherry-picks each implementer's worktree changes onto the main working branch,
resolves conflicts, unifies style, and runs a local sanity baseline (build/test/lint).

### Phase 4 — Review (Reviewer)

`fuguectl dispatch gpt-5.5 --harness codex --prompt-file <review-prompt> --out <verdict-file> --require-output` or a registry-backed reviewer profile gives a `VERDICT` (ACCEPTED / NEEDS FIX) + `Findings`.
Generation != review: implementation and review must resolve to independent model families / runtime paths. Antigravity (`agy`) is supported for implementation; legacy `gemini` CLI is retired.

### Phase 5 — Review-Fix Loop (bounded closed loop, upgraded per 2026-06 loop engineering research)

Automatically iterate **fix -> re-review** until it passes review, with a capped fallback. See `orchestration/fuguectl/SKILL.md` Phase 5 for details; key points:

1. **Deterministic gate first** — each round runs build/test/lint first (objective pass/fail); red must be fixed, don't waste Codex.
2. **Codex subjective review (incremental)** — from round 2 on, review only this round's diff (saves tokens + stays focused).
3. **keep-best anti-regression** — if a round is worse than the previous one / introduces new problems -> `git reset` back to the best version, discarding the bad change (prevents degeneration of thought).
4. **>=2 confirmation passes** — even after the first ACCEPTED, add one independent confirmation (verification is probabilistic).
5. **Fix = operator patch** (v4 hard rule, no bouncing back to the implementer for a rewrite) + write each round into the TASK file for the audit trail.
6. **Three exit states**: ACCEPTED -> DONE / over MAX_ROUNDS(3) -> escalate to a human / **non-converging -> Meta-Reflector** (first reflect on "why it won't fix" with diagnosis + suggestions, then escalate — not a plain retry).

Research basis: 1-2 rounds capture ~75% of the improvement, a hard cap of 5-6 rounds prevents oscillation, generation != review adds ~+20%.
sources: [LLM Verification Loops](https://timjwilliams.medium.com/llm-verification-loops-best-practices-and-patterns-07541c854fd8) · [Loop Engineering 2026](https://shaam.blog/articles/loop-engineering-ai-agents) · Reflexion / Self-Refine.

### Phase 6 — Wrap-up (fuguectl)

Review passes -> merge into the main branch, mark the TASK file `DONE`, clean up worktrees, write memory (non-obvious gotchas/decisions).

---

## Three Ways to Run

|             | Lightweight plugin route                | Worktree fleet route                           | Engine registry route                                          |
| ----------- | --------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| When to use | One or two subtasks, quick validation   | Real parallel dispatch with isolated worktrees | Mixed runtimes in one typed coordinator round                  |
| Startup     | `/cn:team` `/cn:ask` inside Claude Code | mount provider, then `fuguectl fleet status`   | `wireCoordinator({ agentRegistry })`                           |
| Isolation   | Same process, no worktree               | Each `fugue-cc` profile gets its own worktree  | Per profile: `fugue-cc`, Codex, OpenCode, or future harness    |
| Review      | Manual                                  | Phase 4-5 automatic loop                       | Independent reviewer profile, policy checked by model family   |
| Config      | No provider config needed               | Needs provider config under `.fugue-cc/`       | JSON `AgentRegistry`; see [AGENT_RUNTIME.md](AGENT_RUNTIME.md) |

---

## Maintenance Layer: cc-sync (background launchd)

```bash
cc-sync cli              # Upgrade all envs + the main claude to the latest @anthropic-ai/claude-code
cc-sync models [--apply] # Probe each provider's /v1/models, report/append new models (default profile untouched)
cc-sync research         # agent: read each vendor's official docs -> learn -> rebuild launchers -> live verification
cc-sync all              # cli + models
```

- `WatchPaths` pins the global claude-code `package.json` -> follows upstream the moment it upgrades.
- Monthly `cc-sync research` (launchd `StartCalendarInterval`, the 1st of each month at 05:00) -> doc-driven rebuild.
- **Default/flagship profile changes are always manual** — model fit needs human judgment; automation only "proposes," never "swaps the default."

---

## Security Boundary

- Keys live only in `~/.config/cc-model-secrets.env` (read by the launcher, highest priority); the repo only has a provider config example.
- `.gitignore` ignores `.fugue-cc/` / `**/.fugue-cc/` / `*secrets*.env` / `.env*`; a hard secret scan runs before push, only 0 hits gets pushed.
- Personal paths are generalized into `$FUGUE_CC_WORK` / `$FUGUE_CC_CLAUDE` / `$TASKS` placeholders + the `~/...` convention — substitute for your own environment; a hard secret scan runs before commit, only 0 hits gets pushed.
- Review/second opinion goes through **Codex or another independent reviewer**; do not collapse implementation and review into the same runtime path.
