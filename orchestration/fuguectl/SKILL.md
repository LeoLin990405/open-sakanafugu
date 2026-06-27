---
name: fugunano
description: Use this skill for a multi-agent collaborative coding task. Triggers (CN/EN): "/fugunano" · "/fugue" · "run the fuguectl flow" · "use fuguectl to do X" · "use cc clones + codex to write Y" · "multi-agent collaboration to do Z" · "frontend + backend + review to do W" · "split across multiple agents in parallel" · "parallelize X" · "use the model fleet + a reviewer to build Y" · "split this across multiple agents" · "frontend + backend + review". Use whenever a request benefits from 2+ fugue-cc agents (implementer backends + an independent reviewer). Implements a Planner / Implementers / Reviewer matrix: Planner = your strategic layer (e.g. Claude Desktop), Backend Implementers = the fugue-cc model fleet (Claude plus provider-backed profiles such as deepseek/glm/kimi/minimax/mimo/stepfun/doubao/ark-auto, with room for community-added providers), Reviewer/Judge = an independent frontier model (e.g. Codex). Auto-creates a TASK file, dispatches via `fuguectl dispatch`, integrates via git worktree cherry-pick to the main branch, runs reviewer with a VERDICT, then a bounded review-fix loop (NEEDS FIX → operator patches → re-review, capped then escalate; never loops forever / never hard-marks DONE). Always uses each provider's latest model.
metadata:
  short-description: FuguNano multi-agent coding workflow
---

# FuguNano — multi-agent coding workflow

Invoke when the request is **"build X via parallel dispatch" / "use the fleet to write Y" / "multi-agent collaboration" / "code + tests + review"**.

Three roles, five phases. Planner orchestrates, the implementer fleet writes code in isolated worktrees, an independent reviewer is the quality gate, and a bounded loop drives fixes to acceptance. The single source of truth is the **main branch**; each implementer works in a worktree sandbox and the integrator cherry-picks only reviewed changes back.

> Conventions used below — adapt to your setup:
>
> - `$FUGUE_CC_WORK` = your fugue-cc provider project root for the fleet (where provider config lives under `.fugue-cc/`). See `orchestration/fugue-cc/provider.config.example`.
> - `$FUGUE_CC_CLAUDE` = an optional second provider project pinned to the Claude backend (OAuth/keychain), if you run `cc-claude` separately.
> - `$TASKS` = where you keep task files (e.g. `~/.claude/tasks/`).

---

## Roles

| Role                                              | Agent                                                                                                                                                                                                                                  | Call                                                                                                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Planner / Integrator / Fixer**                  | You (your strategic layer — e.g. Claude Desktop)                                                                                                                                                                                       | Direct shell + `"$FO" dispatch`; **not itself in a provider pane**                                                                                       |
| **Backend Implementers** (auto parallel dispatch) | `cc-claude` (Claude, in `$FUGUE_CC_CLAUDE`) + provider-backed profiles such as `cc-deepseek` `cc-glm` `cc-kimi` `cc-minimax` `cc-mimo` `cc-stepfun` `cc-doubao` `cc-ark-auto` (in `$FUGUE_CC_WORK`), plus any community-added profiles | `"$FO" dispatch cc-X --harness fugue-cc ...`                                                                                                             |
| **Frontend Implementer** (opt-in)                 | **Antigravity (`agy` CLI)**                                                                                                                                                                                                            | manual in the IDE, or headless `agy --print "<prompt>"`; commit/paste output, integrator merges. Supported implementer runtime; keep review independent. |
| **Reviewer / Final Judge**                        | Codex or `coder` (an independent frontier model)                                                                                                                                                                                       | `"$FO" dispatch <reviewer> --harness codex\|fugue-cc` → VERDICT: ACCEPTED or NEEDS FIX                                                                   |

> Generation ≠ review: implementers and the reviewer must be **different model families** (research shows ~+20% over self-review).

---

## 5-phase workflow (follow strictly)

> Plan → Dispatch → Integrate → Review → **Review-Fix Loop** (NEEDS FIX iterates to ACCEPTED, bounded then escalate)

**Higher-level entry points** (optional, layered on the 5 phases):

- **Goal mode** — declarative target with a deterministic gate: `"$FO" goal template` → fill `outcome/gate/rubric/rounds` → `"$FO" goal check <spec>` runs the gate (the loop drives to it). Goal met = gate 0 + reviewer ACCEPTED.
- **First-run onboarding** — `"$FO" help quickstart` prints the safe local path, and `"$FO" init --dry-run` reports Codex/OpenCode/fugue-cc readiness plus missing local templates. Only `"$FO" init --write` creates local secrets/provider config templates.
- **Planning panel** — multi-model decomposition: `"$FO" plan "<goal>" --harness fugue-cc --models cc-deepseek,cc-kimi,coder` asks several models to decompose the goal (each Writes its plan); use `--harness codex|opencode` for a lite planning pass when the worktree fleet is not installed. You synthesize the returned plans into Phase 1.
- **Allocation (adaptive)** — `"$FO" allocate <task-type> --top` → recommended model; a **bench-prior + battle-experience blend** (Beta-Bernoulli): the static `allocation.tsv` is the prior, and `"$FO" allocate record <task-type> <agent> ok|fail` (call after each verdict — ACCEPTED→`ok`, NEEDS FIX→`fail`) updates the posterior. **Cold-start == the static bench order**; it drifts only once you've recorded outcomes (KAPPA pseudo-counts gate how much), with Laplace smoothing so no agent is starved by one failure. `"$FO" allocate stats <type>` shows scores; `reset` clears. **Auto-feed (data flywheel)**: dispatch with `"$FO" dispatch <agent> --task-type <T> ...` so it logs `(T, agent)` to a ledger; after the round's verdict, `"$FO" allocate feed --from-ledger --result ok [--fail <agents-that-needed-fixing>]` feeds the whole round at once (the `cc-` prefix is normalized to the bench's bare name, so experience lands on the same key it ranks). Routing self-improves from verdicts without per-agent manual calls — but it plateaus at "best-in-pool per coarse task-type", and old stats decay when you upgrade a provider's model. **Iterations**: `--sample` switches ranking from greedy posterior-mean to **Thompson Sampling** (Gaussian-approx Beta sample → explores under-sampled agents, won't lock onto an early winner; Agrawal-Goyal 2012). `"$FO" allocate decay --gamma G [--type T]` discounts counts (`s,f ×G`) to forget stale stats after a model upgrade (discounted bandit; Garivier-Moulines 2011).
- **Workspace isolation** (inspired by Zleap-Agent) — `"$FO" workspace context <ws>` assembles layered context per station (System + Workspace + Tools + Memory + History); `"$FO" dispatch <agent> --workspace <ws> ...` injects it as a prefix, so a (weak) model sees only what this station should see, not drowned in the full context. Stations: main/code/sql/chinese/review/web.
- **Skills mother-catalog (progressive disclosure)** — 3 steps: ① `"$FO" skills index` scans **3 sources** (user `~/.claude/skills` + `.system` meta-skills incl. the official `skill-creator`/`plugin-creator` + plugin marketplaces, `plugin:skill` ids) into one compact catalog (source·functional/note·path) = the mother index; ② the Planner reads it (or `"$FO" skills match "<subtask>"`) and assigns skills per subtask/agent; ③ `"$FO" dispatch <agent> --skills "a,b"` injects _only_ those skills into that agent's context — a weak model crawls just what it needs, not all 500+. This is fuguectl's isolation philosophy applied to the skill dimension. ④ **Close the loop (precipitate→create→re-classify)**: `"$FO" skills forge --name X (--from-experience <ws/slug> | --source <f>) [--agent A]` gathers material → candidate gate → dispatches a worker (with `skill-creator` injected) to author a proper skill → `"$FO" skills validate <name>` quality gate (mirrors the official `quick_validate.py`; `--official` uses it) → on pass, `"$FO" skills index --refresh` folds it back into the catalog for next time. **Authoring is delegated to the official `skill-creator`** (not re-implemented).

### Phase 1: Plan

> Tooling: `FO=orchestration/fuguectl/fuguectl` — unified driver: `doctor` `init` `preflight` `task` `template` `dispatch` `cache` `integrate` `allocate` `skills` `workspace` `plan` `goal` `loop` `run` `summary` `runtime` `selftest`.

0. **Decide the mode** — small/focused task (1–2 files, one fix)? Skip the fleet: implement directly + Codex review (the high-value generation≠review gate). Fleet-shaped work (≥3–4 parallel subtasks / bulk / cost-sensitive)? Bring up the fleet:
   ```bash
   "$FO" fleet status      # ready? (no tmux server / panes down = stuck-in-queue risk)
   "$FO" fleet up          # strips CLAUDE_CODE_* (OAuth false-401) + starts panes in detached tmux
   ```
1. **Preflight (go/no-go gate)** — deps / provider mounted / provider config sanity + selected runtime readiness, all as code:

   ```bash
   "$FO" help quickstart                         # safe first-run path
   "$FO" init --dry-run                          # local readiness, no writes
     "$FO" preflight --harness codex                    # lite reviewer path
     "$FO" preflight --harness opencode --target opencode/deepseek-v4-flash-free
   FUGUE_CC_WORK=<provider project> "$FO" preflight --harness fugue-cc   # full fleet path
   ```

   `"$FO" doctor` shows the full environment + recommendation. **Never dispatch when preflight is NO-GO** — that's how tasks get stuck in an empty queue.

2. **Scaffold the TASK file** — don't hand-write boilerplate: `F=$("$FO" task new "<title>" P1)` → `$TASKS/TASK-{date}-{NNN}.md`; `"$FO" task log "$F" "<note>"` to append, `"$FO" task done "$F"` to close. Structure:

   ```markdown
   # TASK-{date}-{n}: {title}

   Status: IN_PROGRESS
   Priority: P0 | P1 | P2
   Created: {time}
   Completed: -

   ## Requirements

   ...

   ## Subtasks

   - [ ] Task 1 — <scope> (Implementer: cc-doubao, file: src/foo.py)
   - [ ] Task 2 — <scope> (Implementer: cc-deepseek, file: tests/test_foo.py)
   - [ ] Task 3 — <scope> (Implementer: cc-claude, file: src/bar.py)
   - [ ] Final Review (Reviewer: coder)

   ## Output files

   - src/foo.py
   - src/bar.py
   - tests/test_foo.py

   ## Matrix

   | Task  | Implementer | Reviewer | Fixer               |
   | ----- | ----------- | -------- | ------------------- |
   | 1     | cc-doubao   | coder    | operator Edit patch |
   | 2     | cc-deepseek | coder    | operator Edit patch |
   | 3     | cc-claude   | coder    | operator Edit patch |
   | Final | —           | coder    | operator Edit patch |

   ## Log

   (append in real time)
   ```

3. **File-level split** — each agent edits _different_ files to avoid worktree conflicts. If the same file must change, **serialize** (A done → cherry-pick → B continues), never concurrently.

### Phase 2: Dispatch + cache + join barrier (parallel `fuguectl dispatch`)

**① Open the round cache** — declare the N tasks this round dispatches (the parallel dispatch manifest), so the join barrier can later require all N back. `CACHE=orchestration/fuguectl/fuguectl-cache`:

```bash
ROUND=1   # bump per round (including each Phase 5 loop round)
"$CACHE" init "$ROUND" t1:cc-deepseek t2:cc-glm t3:agy   # task_id:agent ...
```

**② Dispatch** each subtask. `"$FO" dispatch <agent> --harness fugue-cc --template impl --set ROLE=.. --set SCOPE=.. --set FILES=.. [--task "$F"]` wraps template-render + provider dispatch + TASK-log (templates: `impl`/`analysis`/`review`). The prompt must **mandate worktree edits to real files**:

```bash
cat > /tmp/fugunano-impl-prompt.md <<'EOF'
Your role: <role>, working inside a git worktree (cwd is already the worktree).

Task: <scope description>

Hard requirements:
1. **Use Read/Edit/Write tools to actually modify files** — do not just print code blocks in chat
2. Files in scope: <list> (do not touch others)
3. When done, print one line "DONE: <list-of-files>"
4. If a requirement is unclear, make a reasonable call — don't ask back

If you only print code in chat, integration cannot pick it up and the task fails.
EOF
"$FO" dispatch <agent> --harness fugue-cc --prompt-file /tmp/fugunano-impl-prompt.md --task "$F"
```

For **review/analysis (non-coding) tasks**, the prompt must order the agent to **Write the artifact to a file**, never chat-only — provider scrollback is volatile and concurrent output can overwrite chat output. Template:

```bash
cat > /tmp/fugunano-analysis-prompt.md <<'EOF'
Your role: <role>
Task: <review/analysis scope>
Input files: <list> (Read them)
Output: **Write to /tmp/<task-dir>/<artifact>.md with the Write tool** (NOT chat — chat gets truncated/lost)
Output schema:
  <structured fields, e.g. VERDICT / Confidence / Findings (file:line)>
Hard: 1. Read inputs; 2. Write the output file; 3. no chat output
EOF
"$FO" dispatch <agent> --harness fugue-cc --prompt-file /tmp/fugunano-analysis-prompt.md --task "$F"
```

- Backend implementers (the clones + optional `coder`) live in `$FUGUE_CC_WORK`; `cc-claude` in `$FUGUE_CC_CLAUDE`.
- Frontend / UI work (if any) goes to **Antigravity (`agy`)** — either manual in the IDE, or headless:
  ```bash
  agy --print --print-timeout 5m "<frontend task prompt>"   # add --dangerously-skip-permissions only in a sandbox
  ```
  Commit/paste its output; the integrator merges to main. **`agy` is supported as a frontend implementer runtime; keep review on an independent path such as Codex.**

Dispatch is **fire-and-forget** (don't block chat).

**③ Cache every return** — every agent's artifact goes into the cache _first_ (durable; not read from ephemeral chat/scrollback). As each task finishes, the operator records it under its task id:

```bash
"$CACHE" put  "$ROUND" t1 /tmp/<task-dir>/t1.md   # success → cached + marked done
"$CACHE" fail "$ROUND" t3 "agy timed out"          # died/timed out → still counts as "returned"
```

**④ Join barrier (HARD GATE)** — dispatched N ⇒ must collect N back before advancing. The round does **not** proceed to Integrate on partial results:

```bash
"$CACHE" barrier "$ROUND" --wait 600   # exit 0 ONLY when all N are terminal (done|fail)
```

The barrier passes only when **every dispatched task has returned** (`done` or `fail`); a stuck task that never returns is surfaced here (`status`/`list`), never silently dropped. This gate applies to **every round**, including each Phase 5 loop round.

### Phase 3: Integrate (operator = Integrator)

Only after the **join barrier passes** (all N returned). `"$FO" summary "$ROUND" --task "$F"` logs a round summary (per-task status). Read cached artifacts via `"$CACHE" collect "$ROUND"`, then **`fuguectl integrate`** cherry-picks each worktree onto `main` — a conflict is isolated to that single agent (`cherry-pick --abort` keeps `main` clean) and the rest still integrate, instead of a bare loop that `break`s on the first conflict:

```bash
"$FO" integrate --work "$FUGUE_CC_WORK" --agents "cc-deepseek cc-glm cc-doubao" --task "$F"
# cc-claude in a separate provider project ($FUGUE_CC_CLAUDE) → one more call for that repo:
"$FO" integrate --work "$FUGUE_CC_CLAUDE" --agents "cc-claude" --task "$F"
# exit 0 = no conflicts; exit 1 = some conflicts (each listed with its SHA for manual cherry-pick/rebase)

pytest tests/ -q   # or the project's own deterministic sanity command
```

> **Prereq**: the work repo must **gitignore `.fugue-cc/`** — current provider-managed worktrees live under `$FUGUE_CC_WORK/.fugue-cc/workspaces/`, _inside_ the main worktree; without the ignore a `git add -A` swallows them as embedded repos and poisons `status`. `fuguectl integrate` only `add`s inside each worktree (never `add -A` on `main`) and passes an explicit committer identity to `cherry-pick` (so it works on machines/CI with no global git config), but the project itself must ignore `.fugue-cc/`.

Each agent edits _different_ files (Phase 1 split), so conflicts are rare; when one happens the report names the agent + SHA and you resolve it manually, the others already landed. **The integrate summary + sanity result go to the TASK log** (`--task`).

**Enforce, don't trust** (borrowed from Lynn's orchestrator-side ownership): the file-split is only a _prompt_ — a weak model may stray. Pass `--ownership <file>` (TSV `agent⇥owned-globs⇥forbidden-globs`, comma-separated; owned empty/`*` = unrestricted) and `integrate` validates each worker's diff _before_ cherry-picking: a worker that touched files outside its `owned` set or matching a `forbidden` glob is flagged **`violation`** and held back whole (isolated like a conflict, exit non-zero), instead of blindly merged. Agents not in the manifest stay unrestricted.

### Phase 4: Review (coder = independent reviewer)

```bash
cd "$FUGUE_CC_WORK"
DIFF=$(git diff main...HEAD)
cat > /tmp/fugunano-review-prompt.md <<EOF
Your role: independent reviewer, the final quality gate.

Review the integrated change (git diff main...HEAD):
\`\`\`
$DIFF
\`\`\`

Focus: correctness / security / perf / test coverage
List only real problems; if none, output VERDICT: ACCEPTED
If problems exist, output VERDICT: NEEDS FIX plus a problem list
Be concise.
EOF
"$FO" dispatch gpt-5.5 --harness codex --codex-clean --timeout-ms 600000 --prompt-file /tmp/fugunano-review-prompt.md --out /tmp/fugunano-review-verdict.txt --require-output --task "$F"
# If local Codex MCP startup is still flaky, add:
#   --harness-arg=-c --harness-arg=mcp_servers={}
```

- `VERDICT: ACCEPTED` → wrap up (TASK → Status: DONE + Completed, push / deliver).
- `VERDICT: NEEDS FIX` → enter **Phase 5 review-fix loop**.

### Phase 5: Review-Fix Loop (bounded · loop engineering v2)

**Research basis** (Self-Refine / Reflexion / 2026 loop-engineering — see sources):

- Rounds 1-2 capture **~75%** of reachable improvement; **hard-cap at 5-6 rounds** to avoid oscillation (the model "fixes" things that weren't broken).
- Generation ≠ review (two agents) beats self-review by **~20%** — parallel dispatch satisfies this natively (implementer ≠ reviewer).
- **Deterministic gate first**: run build/test/lint (objective pass/fail) before the subjective review; the gate must be trustworthy (weak tests just ship bad code faster).
- **Incremental review**: from round 2, review only the round's diff (cheaper + focused).
- **Keep-best**: retain the best version across rounds; revert if a round regresses (guards against degeneration of thought).
- **At least 2 review passes**: even a first ACCEPTED gets one independent confirmation (verification is probabilistic).
- **Non-convergence → meta-reflect, then escalate** — don't keep retrying blindly.

**Driven by the `fuguectl loop` state machine** — the exit-state logic is code, not hand-run pseudocode. `init` once, then per round: run the gate → reviewer → `record` the round → `decide` returns the next move. keep-best (best_sha/best_n) is auto-maintained; a round worse than best is flagged for `git reset`.

```bash
"$FO" loop init --max 3 --best-sha "$(git rev-parse HEAD)" --task "$F"   # research ceiling 5-6; rounds 1-2 do the bulk

round=1
while :; do
  # 1) deterministic gate FIRST (objective, before the subjective reviewer) — build + test + lint
  GATE=pass; "$FO" goal check <spec> || GATE=fail        # red → fix without wasting the reviewer this round
  # 2) reviewer pass (incremental: from round 2 send only this round's diff) → VERDICT + Findings count N
  #    (skip the reviewer when GATE=fail; go straight to fix)
  # 3) record the round — classify Findings (borrowed from no-mistakes): --ask-user K = how many of the N
  #    touch intent / need human judgment; the rest are mechanical. keep-best auto-maintained; --same-class if repeats
  "$FO" loop record $round --gate $GATE --verdict <ACCEPTED|NEEDSFIX> --findings <N> --ask-user <K> \
        --sha "$(git rev-parse HEAD)" [--same-class] [--note "..."]
  # 4) ask the state machine (token on stdout; exit 0=DONE / 10=auto / 11=ask-user / 20=escalate)
  case "$("$FO" loop decide | head -1)" in
    DONE)                          break ;;   # ≥2 ACCEPTED (2nd independent confirmation) → wrap up
    CONFIRM)                       : ;;       # 1st ACCEPTED → run ONE more independent confirm pass
    CONTINUE)                      : ;;       # all Findings mechanical → operator Edit-patch (NOT re-dispatch)
    ASK_USER)                      : ;;       # some Findings touch intent → escalate THOSE to human (approve/fix/skip), auto-patch the rest
    ESCALATE_MAX|ESCALATE_NONCONV) break ;;   # stop — escalate (see exit states below)
  esac
  "$FO" loop status >> "$F"                                # log the round table to the TASK file
  # operator fixes Findings (Edit patch), commits; if worse-than-best was flagged → git reset --hard <best_sha>
  round=$((round+1))
done
```

**Three exit states (must reach exactly one; never hard-mark DONE)**:

1. `ACCEPTED` (after the 2nd independent confirmation) → wrap up DONE.
2. `round > MAX_ROUNDS` still NEEDS FIX → **stop, escalate** (post the best-version diff + remaining Findings + your judgment).
3. **Non-convergence** → **Meta-Reflector**: first reflect on _why it won't converge_ (reviewer too strict? requirement unclear? wrong approach to swap? fix→break→fix thrash?), output a diagnosis + recommendation (different implementation, re-split subtasks, refocus the reviewer), **then** escalate — not a blind retry.

> sources: [LLM Verification Loops (Williams)](https://timjwilliams.medium.com/llm-verification-loops-best-practices-and-patterns-07541c854fd8) · [Loop Engineering 2026 (Shaam)](https://shaam.blog/articles/loop-engineering-ai-agents) · Reflexion / Self-Refine

---

## Models — always latest

The fleet's models are pinned in the provider config under `.fugue-cc/` (see `orchestration/fugue-cc/provider.config.example`) and in `backends/bin/cc-model-registry.tsv`. Change models there, not in this skill. The Volcengine Ark "Coding Plan" aggregation layer (`cc-doubao` / `cc-ark-auto` share one ARK key) lets the console switch among `ark-code-latest` / `doubao-seed-code` / `deepseek-v4` / `kimi` / `glm` / `minimax` — endpoint `/api/coding` (**not** `/api/v3`). Re-verify each provider's listing endpoint periodically; the auto-refresh is handled by `backends/bin/cc-sync`.

---

## Choosing an implementer

| Subtask type                   | Preferred implementer                         |
| ------------------------------ | --------------------------------------------- |
| Frontier reasoning + coding    | `cc-claude`                                   |
| Reasoning + complex algorithms | `cc-deepseek`                                 |
| Chinese docs / docstrings      | `cc-glm`                                      |
| Long context (>50K)            | `cc-kimi`                                     |
| Math / step-by-step thinking   | `cc-stepfun` / `cc-minimax`                   |
| Volcengine ecosystem           | `cc-doubao`                                   |
| General coding / fallback      | `cc-mimo` / `cc-ark-auto`                     |
| Frontend / UI / visual         | `agy` (Antigravity — manual or `agy --print`) |
| Final review / verdict         | `coder`                                       |

**Do not override the model in provider calls** — the model is fixed per agent in provider config; select by _agent_, not by model.

---

## Design principles (hard rules)

- **TASK file is mandatory** — never dispatch without one; it's the audit trail.
- **Cache-first + join barrier** — every agent result is cached durably _before_ use (never read from ephemeral chat); a round that dispatched N must collect N back (`fuguectl-cache barrier` exits 0) before advancing. Applies to every round, including Phase 5 loop rounds.
- **One independent prompt per agent** — never broadcast one prompt to N agents.
- **NEEDS FIX → operator patches** (Edit), never re-dispatch the implementer to rewrite.
- **Latest model always**; ground truth is provider config, not strings in this skill.
- **`"$FO" dispatch` is the only sanctioned dispatch channel** — don't spawn sub-agents by other means.
- **Second opinions go to `coder` or another fleet clone**, never to an excluded provider.
- **Implementers must Write artifacts to files**, never chat-only (async output is lossy).

---

## Anti-patterns (DON'T)

- ❌ Using parallel dispatch for a single simple Q&A — overkill; answer directly or use one explicit `"$FO" dispatch`, no TASK file.
- ❌ Dispatching without a TASK file.
- ❌ Broadcasting one prompt to N agents.
- ❌ Re-dispatching the implementer after NEEDS FIX — operator must Edit-patch.
- ❌ Overriding the model in provider calls.
- ❌ Concurrent edits to the same file — split by file or serialize.
- ❌ Letting an implementer output chat-only (no Write) — async truncation + scrollback overwrite loses the artifact; write to `/tmp/<task-dir>/<file>.md`.
- ❌ Trusting provider reply metadata for completion — verify by reading the file the agent wrote.
- ❌ Collapsing implementation and review into the same runtime path — `agy` (Antigravity) is supported for implementation, but keep the reviewer independent (`coder`/Codex by default).
- ❌ Advancing to Integrate or the next round on **partial join** — if N tasks were dispatched, all N must be cached back (barrier exits 0) first. Never proceed with 5/8 results.
