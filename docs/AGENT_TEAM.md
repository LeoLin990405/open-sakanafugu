# Agent Team — multi-model planning + hierarchical sub-agents

Two plays: (1) use multiple models to **plan in parallel**, and (2) split into **sub-agents** under a team. Both are workable; the key is **picking the right substrate**.

## Two Substrates

| Substrate                                      | Top-level cross-model                                            | Hierarchy / sub-agent                                                                                        | Multi-model source                                                      | Practicality                                    |
| ---------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------- |
| **fugue runtime profiles** (parallel dispatch) | Yes — each logical profile resolves to `fugue-cc`/Codex/OpenCode | Members can spawn their own sub-agents only if their native runtime supports it; provider nesting is fragile | `AgentRegistry`, `--harness`, and provider config                       | Strong at deterministic top-level orchestration |
| **Native subagent route**                      | Custom agents through the host agent's tool system               | The host agent's native subagent feature may support hierarchy                                               | Existing custom agents like `cn-dispatch` or `codex-rescue`, if present | Best when the host agent owns team hierarchy    |

**Key**: if a machine already has custom subagent types such as `cn-dispatch` or `codex-rescue`, the host agent's native team system can be a natural "multi-model + hierarchical" route. fugue stays strongest as the deterministic execution layer: dispatch, cache, integrate, review, and loop state.

## (1) Multi-Model Planning (planning panel)

Send "decompose the goal" to several vendors at once, get different perspectives, then synthesize. Two routes:

- **fuguectl route** (this repo's tooling):
  ```bash
  fuguectl plan "<goal>" --harness fugue-cc --models cc-deepseek,cc-kimi,coder --out <dir> --timeout-ms 120000 --allow-partial --harness-arg x --codex-arg x --opencode-arg x --agy-arg x --task TASK.md
  fuguectl plan "<goal>" --harness lite --out <dir> --timeout-ms 120000 --allow-partial --codex-clean --codex-arg=-c --codex-arg=mcp_servers={} --task TASK.md
  # Each target writes its decomposition to <dir>/<sanitized-target-label>.plan.md; the planner synthesizes into Phase 1
  ```
- **Native route** (host agent subagent tool): the planner spawns N subagents in parallel, each with a different custom agent or model hint, each producing one decomposition, and the planner synthesizes.

Synthesis = the planner (you/Claude) reads the N plans, takes the intersection + fills the blind spots, and sets the final plan. This is the **design panel** pattern (research shows it is more complete than single-track planning).

## (2) Sub-Agents Under a Team (hierarchy)

**The realistic 2-layer structure** (strong enough; don't chase arbitrary nesting):

```
Top team:   planner
            |- Member A = cn-dispatch -> provider-backed model profile (implements subtasks)
            |- Member B = codex-rescue -> Codex (review/hard problems)
            \- Member C = Explore -> read-only search
   When a member's task is complex (the member is itself a full agent loop):
            Member A -- spawns its own sub-agent for further decomposition
```

- The top level uses the host agent's subagent tool to spawn members (`subagent_type` picks cn-dispatch / codex-rescue / Explore / general-purpose where available).
- If a member is a full agent, it can spawn sub-agents internally (hierarchy +1).
- For **deterministic orchestration** (parallel dispatch/pipeline/loop) use the `Workflow` tool: `agent(prompt, {agentType:'cn-dispatch'})` points a member at a provider-backed model profile; `pipeline()` chains "implement -> review".

## Honest Constraints (avoid the traps)

1. **Native subagents usually inherit the host model by default**; for multi-model you need explicit custom agents, a Bash bridge, or fugue runtime profiles.
2. **Some workflow engines allow only shallow nesting**. For deeper teams, use the host agent's native subagent-spawning-subagent path when it exists.
3. **Provider nesting** (dispatching again through the fugue-cc provider from inside a fugue-cc agent) is unverified and fragile — don't use it.
4. **Keep review independent**: `agy`/Antigravity is supported for frontend implementation, but the reviewer should be a separate path such as Codex.

## Which to Pick

| Scenario                                                                              | Use                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real parallel **implementation** (multi-file, each with its own worktree, persistent) | **fugue runtime profiles** (`fugue-cc` worktrees plus Codex/OpenCode where useful)                                                                                                                                                                      |
| **Hierarchical team / sub-agent orchestration**                                       | Host-native subagents plus custom model bridges, when available                                                                                                                                                                                         |
| Multi-model **planning**                                                              | Either works (`fuguectl plan --harness <runtime\|lite> [--models a,b] [--out <dir>] [--timeout-ms n] [--allow-partial] [--codex-clean] [--harness-arg x] [--codex-arg x] [--opencode-arg x] [--agy-arg x] --task TASK.md` or native parallel subagents) |
| Cross-model **review**                                                                | independent Codex or other reviewer profile                                                                                                                                                                                                             |

> See the example in `orchestration/agent-team/team-review.workflow.mjs` (a Workflow script: plan panel -> cross-model implementation -> Codex review, deterministic orchestration).

## Landed: Workspace context isolation (inspired by Zleap-Agent)

Zleap's "don't feed a small model all the context" has landed in this repo: `orchestration/fuguectl/workspaces/*.workspace` define workstations (main/code/sql/chinese/review/web), and `fuguectl workspace context <name>` assembles, per **Context = System + Workspace + Tools + Memory + History**, the layered context that workstation **and only it should see**:

```bash
fuguectl workspace list                       # list workstations
fuguectl workspace context code --task "..."   # view the code workstation's layered context
fuguectl dispatch cc-minimax --workspace code --template impl --set ...  # prefix-inject on dispatch
```

Each workstation binds: a dedicated prompt + enabled tools + memory scope + bench-recommended model (`models: @bench:code` auto-routes through allocation). This upgrades `allocation.tsv` (model mapping only) into a full **context profile** — a weak model is no longer drowned by the full tool/memory/rule set on each subtask. Zleap has no license + a heterogeneous stack, so **we only borrow the idea, implementing the code independently**.

### Experience memory (the "experience" of Zleap's tripartite memory)

Task completes -> distill the reusable method -> sanitize -> store per workstation -> **audit the store** -> auto-replay into the Memory segment of future similar tasks' workspace context:

```bash
echo "use a defensive copy to avoid mutating the input range" | fuguectl experience add code "defensive-copy trick"   # sanitization gate (plaintext keys rejected, trusted by default)
cat web-note.md | fuguectl experience add code "browser memory import" --trust untrusted --source-ref https://example.com/original-note # imported notes keep origin metadata and are not auto-injected by default
fuguectl experience promote code browser-memory-import --source-ref https://example.com/original-note --confirm-source-ref https://example.com/operator-review # origin-bound confirmation gate before imported memory becomes trusted
printf "Use the corrected dispatch route." | fuguectl experience add code "new dispatch route" --supersedes old-dispatch-route # deterministic conflict maintenance: new records can hide stale/conflicting old records
fuguectl experience learn code "dispatch-observability retro" --task ~/.claude/tasks/TASK-2026-06-28-050.md
fuguectl experience learn code "failed-query retro" --task ~/.claude/tasks/TASK-2026-06-28-055.md --allow-failure --lesson "Score relevance on title/body tokens only" --failure-cause retrieval --supersedes old-query-retro
fuguectl experience recall code --query "dispatch output anchors"  # query-rank this workstation's experience
fuguectl experience recall code --failure-cause retrieval --source task --source-ref ~/.claude/tasks/TASK-2026-06-28-055.md --trust trusted --query "dispatch output" --min-score 2 --max-age-days 30 --explain  # cause/source/source-ref/trust/superseded/freshness filters + utility gate + evidence
fuguectl experience recall code --query "dispatch output" --min-score 2 --json # machine-readable recalled set + match evidence for retrieval-quality audits
fuguectl experience policy code dispatch-observability-retro # exact memory -> provenance-bearing policy checklist
fuguectl experience policy code --query "dispatch output" --json # recalled memories -> machine-readable policy cards
fuguectl task handoff ~/.claude/tasks/TASK-2026-06-29-023.md --json --tail 8 --require-done # compact acceptance/object/evidence packet for the next reviewer/agent
fuguectl guard prompt /tmp/fugunano-impl-prompt.md --source-ref ~/.claude/tasks/TASK-2026-06-29-023.md # pre-dispatch runtime guard packet for high-risk prompts
fuguectl dispatch gpt-5.5 --harness codex --prompt "review this diff" --certificate /tmp/review.cert.json --approval-class operator-reviewed --certificate-assumption "reviewer is independent" # action-level proof sidecar with five checkpoints
fuguectl experience recall code --query "dispatch output" --min-score 2 --json --metadata-only # shareable audit: metadata + body hash, no raw memory body
fuguectl experience eval code --cases recall-cases.jsonl --json # precision/recall/F1/MRR over expected recall slugs, no downstream LLM answer involved
fuguectl experience audit code --json --max-age-days 30 # governance gate over source/trust/confirmation/supersession/freshness metadata
fuguectl experience recall code --query "dispatch route" --include-superseded --explain # audit hidden superseded records explicitly
fuguectl workspace context code --experience-source task --experience-source-ref ~/.claude/tasks/TASK-2026-06-28-055.md --experience-limit 3 --experience-budget-chars 1200 --experience-max-age-days 30 --task "fix dispatch output anchors" # exact-source-filtered, trusted-only, budgeted, freshness-gated auto-injection
fuguectl dispatch cc-deepseek --workspace code --experience-source task --experience-source-ref ~/.claude/tasks/TASK-2026-06-28-055.md --experience-limit 3 --experience-budget-chars 1200 --experience-trust all --experience-max-age-days 30 --prompt "fix dispatch output anchors" # explicitly widen trust before prompt assembly
```

The store lives in `${FUGUNANO_STATE:-~/.config/fugunano}/experience/<ws>/` (not in the repo, accumulated at runtime). This is isomorphic to Leo's habit of "distilling skills" — completed work settles into a reusable method. `task handoff <TASK.md> [--json] [--tail n] [--require-done]` is the pre-memory handoff packet: it exposes the TASK's acceptance conditions, output objects, checklist state, recent evidence, issues, and source provenance before another reviewer/agent/learner consumes it. `dispatch --certificate <file>` is the action-level companion: it writes a PCAA-style proof sidecar with harness/target, prompt/output hashes, approval class, assumptions, externality facts, and five checkpoints, so runtime evidence is not trapped inside a vendor session or mutable prose log. `experience add` records `source=manual`; add `--source-ref <url|path|note>` for imported/browser/model/file-derived notes so their origin is bound at write time and remains visible in `--explain`. `experience learn` turns a completed TASK audit into reusable memory with `source=task:<TASK.md>`, including the task's output-file anchors, so Reflexion-style trace learning becomes part of the normal operator loop. Failed or blocked terminal TASKs are still rejected by default; learning from them requires `--allow-failure` plus a human-written `--lesson`, so the failed trajectory is relabeled before it enters memory. Relabeled failures may also include `--failure-cause` from the bounded taxonomy `planning|context|retrieval|tooling|implementation|verification|integration|runtime|policy|other`, making the recovered experience easier to search and route. `experience recall --failure-cause <cause>` applies that cause as a first-pass filter before query ranking, `--source manual|task` can keep operator notes separate from task-derived memories, and `--source-ref <ref>` can route by one exact write-time origin before ranking; this reduces accidental replay from unrelated memories without pretending to be a complete trust boundary. `experience add --trust untrusted` gives imported/browser/model-derived notes a write-time trust mark; `experience promote <ws> <slug> --source-ref <ref> --confirm-source-ref <ref>` is the explicit origin-bound confirmation gate that rewrites an imported memory to trusted and records `confirmedBy` metadata. This follows the memory-poisoning literature's warning that content and lineage can be laundered; FuguNano therefore elevates by stored source binding plus independent confirmation, not by model-scored content. `--supersedes <slug>` is a localized memory-maintenance primitive: a newer trusted candidate can hide stale/conflicting older records before ranking and prompt assembly, while `--include-superseded` preserves manual audit. `experience recall --trust trusted|untrusted|all --explain` prints stored trust plus the active trust filter. Add `--min-score <n>` to drop weak matches from manual recall results, and add `--max-age-days <n>` when old experience should be ignored after a model, dependency, API, or workflow change. `--explain` prints the score, matched query terms, stored failure cause, active cause/source/source-ref/trust/superseded/freshness filters, utility gate, and provenance source in the audit trail. Add `--json` when the recall set itself must be evaluated: it emits the same post-filter results as a stable array with method metadata, body, score, matched terms, failure cause, and confirmation metadata, so retrieval quality can be checked independently of the downstream LLM answer. Add `experience policy <ws> (<slug>|--query <q>) [--json]` when a reviewer or downstream agent needs the compact policy/checklist view instead of the full body: it deterministically emits `[experience:policy]` plus `[experience:policy:meta]` and extracted requirement/output/audit checklist items without mutating the store. Add `--metadata-only` with recall `--json` when that recall audit leaves the local trust boundary; it replaces the raw body with `bodySha256` and `bodyChars`, reducing memory-membership leakage while preserving reproducible evidence. Add `experience eval <ws> --cases <json|jsonl> --json` when you need a local recall benchmark; each case declares a query, expected slugs, and optional filters, and the command reports precision, recall, F1, hit, MRR, and aggregate pass counts without invoking a downstream LLM. `experience audit [workspace] --json [--max-age-days <n>]` scans the same store/list path before replay and reports structured governance issues: untrusted memories without write-time source refs, trusted imported/manual source-ref memories without independent confirmations, untrusted replacement claims, missing supersession targets, confirmation/source conflicts, and stale trusted memories under an explicit retention window. Recall is task-aware: `workspace context --task/--query` and `dispatch --workspace` rank experience by the current task or prompt body, while `--experience-query` can override the dispatch query explicitly. Add `--experience-source manual|task` to either automatic injection path when the prompt should receive only manual notes or only task-derived memory; add `--experience-source-ref <ref>` when automatic injection should replay only memory from one exact origin; add `--experience-limit <n>` when that prompt should receive fewer recalled candidate records; add `--experience-budget-chars <n>` when the rendered memory block must fit a hard prompt budget; add `--experience-max-age-days <n>` when automatic injection should replay only recent experience. Automatic injection is trusted-only by default; `--experience-trust all` is the explicit opt-in for replaying untrusted records. Injected experience is rendered as a provenance-bearing evidence block with parse-stable JSON `[experience:meta] {"slug":...,"sourceKind":...,"trustKind":...,"created":...}` plus `sourceRef`/`confirmedBy`/`failureCause`/`supersedes` when present, so reviewers and logs can inspect why memory entered a prompt. This handoff, action-certificate, audit, policy-card, and budget layer is grounded in PCAA (2606.04104), Agentic EDA Handoff (2606.19795), HarnessFix (2606.06324), Traversal-as-Policy (2603.05517), the Memory Lifecycle Framework (2604.16548), Governed Memory (2603.17787), MEMFLOW (2603.15125), evidence/provenance tracing (2606.04990), MemRefine (2606.13177), Decision-Aware Memory Cards (2606.08151), Useful Memories Become Faulty (2605.12978), and Memory for Autonomous LLM Agents (2603.07670). `FUGUE_STATE` remains a compatibility fallback for existing local setups.
