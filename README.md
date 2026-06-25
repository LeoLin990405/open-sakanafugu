# fugue

[![CI](https://github.com/BicaMindLabs/fugue/actions/workflows/ci.yml/badge.svg)](https://github.com/BicaMindLabs/fugue/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.18-339933.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-317%20passing-success.svg)](orchestration/fanout)

**English | [简体中文](README_ZH.md)**

**fugue** is a training-free, self-hostable multi-agent coding harness. It puts
many models behind one operator surface, lets cheaper specialized workers
implement in isolated contexts, and asks an independent reviewer to judge before
anything is trusted.

The public control plane is [`fuguectl`](#fuguectl-cli). The historical
`fanout` name remains as a compatibility alias for old scripts and the installed
Claude Code skill, but new docs and commands use `fuguectl`.

## What It Is

fugue takes inspiration from [Sakana AI's Fugu](https://sakana.ai/fugu/): the
useful trick is not one larger model, but orchestration over a diverse model
pool. Fugu trains a coordinator; fugue builds the same shape with ordinary
engineering:

- **One interface** - `fuguectl` drives dispatch, cache, integration, review,
  loop state, routing, skills, and fleet maintenance.
- **Separated roles** - Chinese-model Claude Code workers implement; Codex
  reviews; the operator remains the final authority.
- **Bounded correction** - review-fix is an explicit state machine with
  keep-best, confirmation, and escalation instead of an infinite loop.
- **Context isolation** - each workspace exposes only the prompt, tools, memory,
  history, and skills needed for that task.
- **Learning without training** - allocation is a transparent
  Beta-Bernoulli/Thompson-Sampling router updated from review outcomes.
- **Harness evolution** - the TypeScript engine includes a Self-Harness loop
  that mines failed runs, proposes bounded harness edits, and promotes only
  non-regressing changes.

## Current Shape

There are two layers in this repository:

| Layer                   | Status                                                                                                 | What to use it for                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `orchestration/fanout/` | Production operator layer: `fuguectl`, legacy `fanout`, 18 subcommands, 18 test suites, 317 assertions | Day-to-day multi-agent coding workflow                                     |
| `engine/`               | Strict TypeScript ports-and-adapters engine, opt-in while parity grows                                 | Typed integrations, the `fugue` CLI, and net-new Self-Harness capabilities |

The bash operator remains green while capabilities migrate into the typed engine.
Parity is tracked in [`docs/PARITY.md`](docs/PARITY.md).

## Architecture

<img src="docs/architecture.svg" alt="fugue architecture" width="760">

```
Planner / operator
      |
      v
fuguectl control plane
      |
      +--> dispatch workers in isolated worktrees
      +--> cache every result and wait at a fan-in barrier
      +--> integrate only reviewed work onto main
      +--> ask an independent reviewer for a VERDICT
      +--> drive a bounded review-fix loop
      +--> feed outcomes back into allocation and skills
```

| Role                         | Concrete implementation                                                                                                                                                                                   | Responsibility                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Planner / integrator / fixer | Claude Desktop, Claude Code, or a human operator                                                                                                                                                          | Split work, choose when to accept risk, integrate and patch |
| Implementers                 | `cc-deepseek`, `cc-glm`, `cc-kimi`, `cc-qwen`, `cc-doubao`, `cc-minimax`, `cc-mimo`, `cc-stepfun`, `cc-longcat`, plus optional `cc-claude` through [ccb](https://github.com/SeemSeam/claude_codex_bridge) | Write code in isolated worktrees                            |
| Reviewer                     | Codex (`coder` / `codex`)                                                                                                                                                                                 | Independent ACCEPTED / NEEDS FIX verdict                    |
| Optional frontend worker     | Antigravity (`agy`)                                                                                                                                                                                       | UI/frontend work only; not used as reviewer                 |

## Quick Start

Requirements: macOS or Linux, Node >= 18.18, `git`, `tmux`,
[ccb](https://github.com/SeemSeam/claude_codex_bridge) for the full fleet,
Codex for review, and optional `agy` for frontend work.

```bash
git clone https://github.com/BicaMindLabs/fugue
cd fugue

# Inspect this machine and get a recommended workflow.
make doctor

# Install model launchers. Put real keys in ~/.config/cc-model-secrets.env.
make install
make verify

# Run the local gates once on a fresh clone.
make ci-clean
```

For a full ccb fleet:

```bash
cp orchestration/ccb/ccb.config.example /path/to/project/.ccb/ccb.config
cd /path/to/project
ccb

# In another shell or agent session:
/path/to/fugue/orchestration/fanout/fuguectl preflight
/path/to/fugue/orchestration/fanout/fuguectl fleet status
```

API keys stay outside the repo. The launchers read
`~/.config/cc-model-secrets.env`; project-local ccb config lives under a
git-ignored `.ccb/`.

## Install As A Claude Code Skill

```bash
make install-skill
```

This installs to `~/.claude/skills/fanout` and backs up any previous copy. After
restarting Claude Code, invoke it with `/fanout` or by describing a multi-agent
task. The installed skill contains both `fuguectl` and the compatibility
`fanout` alias:

```bash
~/.claude/skills/fanout/fuguectl selftest
```

## Daily Workflow

The operator loop is five phases:

1. **Plan** - run preflight, create a TASK file, split work by ownership.
2. **Dispatch** - send scoped prompts to workers; cache every terminal result.
3. **Integrate** - cherry-pick worktrees onto `main`; isolate conflicts and
   ownership violations.
4. **Review** - ask an independent reviewer for a verdict.
5. **Fix or finish** - use the loop state machine to continue, confirm, ask the
   user, or escalate.

The core commands are:

```bash
fuguectl preflight
fuguectl task new "implement feature"
fuguectl dispatch cc-deepseek --template impl --task TASK.md --task-type backend
fuguectl cache barrier <round>
fuguectl integrate --work /path/to/project --agents "cc-deepseek cc-kimi"
fuguectl loop record --verdict NEEDS_FIX --round 1
fuguectl loop decide
```

For the full process, see [`docs/WORKFLOW.md`](docs/WORKFLOW.md).

## fuguectl CLI

`orchestration/fanout/fuguectl` is the primary operator entry point. Run
`fuguectl help` for exact syntax. The 18 subcommands are grouped below by where
they sit in the workflow.

### Setup And Recon

| Command                           | Use                                                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `fuguectl doctor`                 | Probe installed CLIs, configured APIs, and recommend an operating mode.                                                    |
| `fuguectl fleet status\|up\|down` | Check, start, or stop the ccb worker fleet; strips `CLAUDE_CODE_*` before launch to avoid OAuth false-401s.                |
| `fuguectl preflight [cfg]`        | Go/no-go gate for dependencies, ccbd mount, ccb config, no-Gemini policy, `.ccb/` gitignore, and optional endpoint probes. |

### Plan And Route

| Command                                                             | Use                                                                                                                                     |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `fuguectl task new\|log\|done`                                      | Create, update, and close the TASK audit trail.                                                                                         |
| `fuguectl plan "<goal>" [--models a,b,c]`                           | Ask several models for decomposition plans before choosing the work split.                                                              |
| `fuguectl allocate <type> [--top] [--sample]`                       | Rank workers from the benchmark prior plus live review posterior; `record`, `feed`, `stats`, `reset`, and `decay` maintain the router.  |
| `fuguectl workspace list\|show\|model\|context <ws>`                | Assemble the scoped context for a workspace.                                                                                            |
| `fuguectl skills index\|list\|match\|show\|inject\|validate\|forge` | Build the local skill catalog, inject only selected skills, validate authored skills, and settle learned methods back into the catalog. |
| `fuguectl template <name> [--set K=V]`                              | Render an implementation, analysis, or review prompt template.                                                                          |
| `fuguectl goal template\|show\|check <spec>`                        | Run declarative acceptance gates.                                                                                                       |

### Dispatch And Gather

| Command                                                                                                       | Use                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `fuguectl dispatch <target> [--harness ccb\|codex\|opencode] [--workspace ws] [--task-type T] [--skills a,b]` | Render or load a prompt, optionally prepend workspace and skill context, dispatch through ccb/Codex/OpenCode, and log routing data. |
| `fuguectl cache init\|put\|fail\|barrier\|collect\|resume`                                                    | Durable result cache, fan-in barrier, timing, and resume support.                                                                   |

### Integrate, Review, Loop

| Command                                                                | Use                                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `fuguectl integrate --work <repo> --agents "a b" [--ownership <file>]` | Cherry-pick worker worktrees onto `main`; conflicts and ownership violations are isolated per agent.    |
| `fuguectl loop init\|record\|decide\|status`                           | Phase 5 review-fix state machine: DONE, CONFIRM, CONTINUE, ASK_USER, ESCALATE_MAX, or ESCALATE_NONCONV. |
| `fuguectl run set\|round\|status\|next\|clear`                         | Machine-readable run facade over task, cache, loop, best result, and next action.                       |
| `fuguectl summary <round> [--task f]`                                  | Human-readable round status and elapsed-time summary.                                                   |

### Observe And Maintain

| Command                                            | Use                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `fuguectl experience add\|list\|recall\|show <ws>` | Store sanitized reusable methods and recall them into future workspace context. |
| `fuguectl ccb-sync check\|adapt [--apply]`         | Detect and adapt to ccb/Claude Code version drift.                              |
| `fuguectl selftest`                                | Run the full operator suite: 18 test suites, 317 assertions.                    |

## TypeScript Engine

The `engine/` package is the typed version of fugue's orchestration model:
strict TypeScript, ports-and-adapters layering, pure domain policies, and
injected adapters for real harnesses and storage.

```bash
cd engine
npm run check
npm run build
node dist/cli/main.js version
```

Today the engine CLI exposes:

```bash
fugue version
fugue doctor
fugue task new|log|done
fugue goal check <spec>
fugue self-harness template|run
```

The bash `fuguectl` layer remains the daily operator surface until each command
has a typed equivalent with equal or better coverage.

## Self-Harness

Self-Harness improves the harness configuration itself, not the model. A run
does four things:

1. Mine verifier-grounded weaknesses from failed run events.
2. Ask a configured harness agent to propose bounded full-surface replacement
   edits.
3. Validate each candidate against fixed held-in and held-out task lists.
4. Promote only if the edit does not regress either split and improves at least
   one.

```bash
cd engine
npm run build
node dist/cli/main.js self-harness template > /tmp/self-harness.json
node dist/cli/main.js self-harness run \
  --spec /tmp/self-harness.json \
  --state ~/.config/fugue \
  --cwd /path/to/workspace
```

See [`docs/SELF_HARNESS.md`](docs/SELF_HARNESS.md) for the strict JSON spec,
editable surfaces, validation rules, and smoke tests.

## Repository Layout

| Path                           | Contents                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `backends/bin/`                | Model launchers, registry, `cc-models`, and `cc-sync`.                                               |
| `backends/{install,verify}.sh` | Local install and launcher verification.                                                             |
| `orchestration/fanout/`        | `fuguectl`, legacy `fanout`, shared shell libraries, templates, workspaces, skill bundle, and tests. |
| `orchestration/ccb/`           | Sanitized ccb configuration template.                                                                |
| `orchestration/cn-plugin/`     | Claude Code `/cn:*` plugin and dispatch agent derived from `openai/codex-plugin-cc`.                 |
| `orchestration/agent-team/`    | Higher-level multi-model planning example.                                                           |
| `engine/`                      | TypeScript package, domain ports, adapters, CLI, and Self-Harness loop.                              |
| `scripts/`                     | Secret scan, shell lint, docs drift check, and skill installer.                                      |
| `docs/`                        | Workflow, architecture, parity, integrations, and Self-Harness operator guide.                       |
| `AGENTS.md`                    | Cross-harness operator entry read by Claude Code, Codex, and OpenCode.                               |

## Design Rules

- **Generation is not review** - workers and reviewers are different model
  families.
- **`main` is the truth source** - workers edit isolated worktrees; integration
  is explicit.
- **Never trust self-reporting** - deterministic gates and reviewer verdicts
  drive the loop.
- **Bound every loop** - continue, confirm, ask the user, or escalate; never spin
  forever.
- **Cache before advancing** - N dispatched tasks must produce N terminal
  results before the round moves on.
- **Show weak models less** - workspaces and skill injection keep context small.
- **Learn from outcomes** - allocation and skill precipitation feed future
  rounds.
- **Keep secrets out of git** - keys live in local config, and CI scans for
  leaks.
- **Make docs executable enough to fail** - `check-docs` verifies README command
  coverage, counts, and the Self-Harness operator guide.

## Development

Local gates reuse the same scripts as CI:

```bash
make ci          # scan + shell lint + docs + plugin/fuguectl + engine checks
make ci-clean    # same, but clean-installs engine dependencies first
make scan        # secret-leak gate
make lint        # bash -n + shellcheck
make check-docs  # README + Self-Harness docs drift gate
make test        # cn-plugin + fuguectl/fanout selftest
make test-engine # TypeScript engine typecheck + lint + vitest
make doctor      # local environment recon
make help        # list all make targets
```

The root npm scripts mirror these gates:

```bash
npm run ci
npm run ci:clean
npm run test:fuguectl
npm run test:engine
```

CI runs secret scanning, shell checks, docs drift checks, the Node/plugin tests,
and the engine typecheck/lint/vitest suite. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Security

This workflow handles API keys. Hard rules:

- Store real keys only in `~/.config/cc-model-secrets.env` or a project-local,
  git-ignored `.ccb/ccb.config`.
- Keep only sanitized examples in the repository.
- Let `.gitignore`, the custom scanner, and gitleaks block accidental leaks.
- Report vulnerabilities privately through GitHub Security Advisory.

See [`SECURITY.md`](SECURITY.md) for the full policy.

## Acknowledgements

- [Sakana AI Fugu](https://sakana.ai/fugu/) for the many-models-behind-one-interface framing.
- [trotsky1997/OpenFugu](https://github.com/trotsky1997/OpenFugu) for the complementary faithful training-based reconstruction.
- [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) for the plugin architecture that the `/cn:*` layer derives from.
- [Zleap-AI/Zleap-Agent](https://github.com/Zleap-AI/Zleap-Agent) for workspace isolation and experience-memory inspiration.
- [kunchenguid/no-mistakes](https://github.com/kunchenguid/no-mistakes) and [lavish-axi](https://github.com/kunchenguid/lavish-axi) for loop-state and docs-drift ideas.
- [merkyor/Lynn](https://gitee.com/merkyor/Lynn) for orchestrator-side ownership enforcement inspiration.
- Anthropic's official `skill-creator` meta-skill for the skill authoring and validation flow.

See [`NOTICE`](NOTICE) for attribution detail.

## License

[Apache-2.0](LICENSE) © 2026 BicaMind Labs.
