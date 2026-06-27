<div align="center">

[![English](https://img.shields.io/badge/Language-English-2ea44f?style=for-the-badge)](README.md) &nbsp; [![中文](https://img.shields.io/badge/%E8%AF%AD%E8%A8%80-%E4%B8%AD%E6%96%87-555555?style=for-the-badge)](README.zh-CN.md)

# FuguNano

### Open & light-weight version reimplementation of Sakana Fugu.

<p align="center">
  <img src="https://img.shields.io/badge/Runtime-Node%20%E2%89%A518.18-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js >= 18.18" />
  <img src="https://img.shields.io/badge/Engine-TypeScript-3178c6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript engine" />
  <img src="https://img.shields.io/badge/fuguectl-23%20suites-7c3aed?style=for-the-badge" alt="23 fuguectl test suites" />
  <img src="https://img.shields.io/badge/assertions-310-brightgreen?style=for-the-badge" alt="310 fuguectl assertions" />
  <a href="https://github.com/BicaMindLabs/FuguNano/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/BicaMindLabs/FuguNano/ci.yml?branch=main&style=for-the-badge&label=CI" alt="CI status" /></a>
  <img src="https://img.shields.io/badge/license-Apache--2.0-yellowgreen?style=for-the-badge" alt="Apache-2.0 license" />
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="docs/AGENT_RUNTIME.md">Agent Runtime</a> ·
  <a href="docs/WORKFLOW.md">Workflow</a> ·
  <a href="docs/SELF_HARNESS.md">Self-Harness</a> ·
  <a href="docs/PARITY.md">Engine Parity</a> ·
  <a href="NOTICE">Attribution</a>
</p>

<p align="center">
  <img src="docs/readme-overview-en.svg" alt="FuguNano governed multi-agent coding overview" width="920">
</p>

</div>

> A repo-native, multi-agent coding loop powered by 9+ LLMs (isolated via
> Claude Code) and an independent Codex reviewer. Lightweight, bounded, and
> self-improving (Self-Harness) - no coordinator training required.
> It is intentionally provider-neutral: use the accessible models you trust
> today, add more runtimes tomorrow, and keep the engineering loop the same.

## Highlights

- **One operator surface** - `fuguectl` drives preflight, dispatch, cache,
  integration, review, loop state, routing, skills, and runtime maintenance.
- **Runtime-neutral agents** - logical agent profiles route work to Claude Code
  provider instances, Codex models, OpenCode providers, or future harnesses
  without changing the loop.
- **Extensible model pool** - current profiles are just starting points.
  Community adapters can add accessible commercial, open, private, local, or
  self-hosted models without changing FuguNano's core contract.
- **Real isolation** - workers edit separate worktrees with scoped workspaces,
  selected skills, and optional ownership enforcement.
- **Review stays independent** - implementers write, while Codex or another
  configured independent reviewer returns `ACCEPTED` or `NEEDS FIX`.
- **No lost outputs** - dispatch can persist reviewer/agent output with `--out`,
  and the join barrier still enforces N sent, N returned.
- **Bounded repair** - keep-best, confirmation passes, user escalation, and
  non-convergence states keep the loop from spinning forever.
- **Learning without training** - allocation blends benchmark priors with live
  review outcomes, then feeds better routes into later rounds.
- **Self-Harness ready** - the TypeScript engine can mine failed runs, propose
  bounded harness edits, and promote only non-regressing changes.

## Quick Start

Requirements: macOS or Linux, Node.js >= 18.18, `git`, `tmux`, and the model/API
credentials you choose to use. Codex is recommended for review.

```bash
git clone https://github.com/BicaMindLabs/FuguNano fugunano
cd fugunano

/path/to/fugunano/orchestration/fuguectl/fuguectl help quickstart
/path/to/fugunano/orchestration/fuguectl/fuguectl init --dry-run
make doctor       # inspect local CLIs and provider readiness
make install      # install model launchers
make verify       # verify launcher wiring
make ci-clean     # run the full local gate from a clean engine install
```

Real keys stay outside the repository:

```bash
mkdir -p ~/.config
$EDITOR ~/.config/cc-model-secrets.env
```

Choose the runtimes you want to use. The TypeScript engine now models agents as
profiles: a logical id, a harness (`fugue-cc`, `codex`, `opencode`), an optional
harness-native target, and a model family used by policy. See
[docs/AGENT_RUNTIME.md](docs/AGENT_RUNTIME.md).

For the optional `fugue-cc` worktree fleet, add a provider config to the project
you want the fleet to edit:

```bash
cp orchestration/fugue-cc/provider.config.example /path/to/project/.fugue-cc/provider.config
cd /path/to/project
fugue-cc
```

Then run the operator from another shell:

```bash
/path/to/fugunano/orchestration/fuguectl/fuguectl preflight --harness fugue-cc
/path/to/fugunano/orchestration/fuguectl/fuguectl fleet status
```

## Operator Skill

```bash
make install-skill
```

This installs `/fugunano` to `~/.claude/skills/fugunano` as a convenience operator
entry for Claude Code. The workflow itself is not Claude Code-specific: Codex,
OpenCode, Antigravity, and other agents can follow [AGENTS.md](AGENTS.md) and
dispatch through the same agent profiles. Smoke-test the installed bundle:

```bash
~/.claude/skills/fugunano/fuguectl selftest
```

## How The Loop Works

```bash
fuguectl preflight --harness codex        # lite reviewer path
fuguectl preflight --harness agy
fuguectl preflight --harness fugue-cc     # full worktree fleet path
fuguectl task new "implement feature"
fuguectl dispatch cc-deepseek --template impl --task TASK.md --task-type backend
fuguectl cache barrier <round>
fuguectl integrate --work /path/to/project --agents "cc-deepseek cc-kimi"
fuguectl loop record --verdict NEEDS_FIX --round 1
fuguectl loop decide
```

| Phase     | What FuguNano does                                                                      |
| --------- | --------------------------------------------------------------------------------------- |
| Plan      | Run preflight, create a TASK file, split ownership, and pick workers.                   |
| Dispatch  | Send scoped prompts through `fuguectl dispatch`.                                        |
| Gather    | Cache every terminal result and wait at the join barrier.                               |
| Integrate | Cherry-pick reviewed worktrees onto `main`; isolate conflicts and ownership violations. |
| Review    | Ask an independent reviewer for an `ACCEPTED` / `NEEDS FIX` verdict.                    |
| Repair    | Use the bounded loop state machine until accepted or escalated.                         |

Read the full walkthrough in [docs/WORKFLOW.md](docs/WORKFLOW.md).

## Fugu, OpenFugu, And FuguNano

Sakana Fugu, OpenFugu, and FuguNano share the same direction: when a
single frontier model or hardware path is expensive, unavailable, or hard to
govern, coordination becomes the system capability. The difference is where
that coordination layer lives.

<p align="center">
  <img src="docs/readme-fugu-comparison-en.svg" alt="Fugu, OpenFugu, and FuguNano comparison" width="920">
</p>

| System      | Coordination layer              | What it opens                                                                 | Adoption shape                                                           |
| ----------- | ------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Sakana Fugu | Learned conductor behind an API | Frontier-style multi-model synthesis without binding the user to one model    | Managed / closed service; conductor training and access live elsewhere   |
| OpenFugu    | Open training and serving stack | A readable route to rebuild Fugu-style conductor training and OpenAI serving  | Best for teams that want to train, inspect, and serve the conductor path |
| FuguNano    | Repo-native engineering loop    | Multi-agent coding, independent review, and Self-Harness without training one | Cloneable, auditable, and light enough to run before training a router   |

FuguNano is not a replacement for Fugu or OpenFugu. It is the lightest open
entry point on the same road: use policies, ports, review gates, and harness
improvement first, then decide whether a learned conductor is worth the cost.

The planning panel prints per-agent dispatch duration and, with `--task`,
persists planner status, output size or error kind/exit code, plus artifact
paths in the TASK log. `dispatch
--verbose` prints an obs line to stderr, and dispatches with `--task` persist
duration / output size / optional `--out` artifact path in the TASK log, so live
Codex/OpenCode/AGY runs leave an observable trace without contaminating model
stdout or durable artifacts.

## Command Surface

`orchestration/fuguectl/fuguectl` is the production operator entry point. It has
21 subcommands and 23 test suites.

| Area                   | Commands                                                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup and recon        | `fuguectl doctor`, `fuguectl init --dry-run\|--write`, `fuguectl preflight --harness fugue-cc\|codex\|opencode\|agy\|all`, `fuguectl fleet status\|up\|down`                                          |
| Planning               | `fuguectl task new\|log\|done`, `fuguectl template <name>`, `fuguectl plan "<goal>" [--harness h] [--timeout-ms n] [--harness-arg x] [--task f]`, `fuguectl goal template\|show\|check`               |
| Routing and context    | `fuguectl allocate <type>`, `fuguectl workspace list\|show\|model\|context`, `fuguectl agents template\|validate\|list\|resolve`, `fuguectl skills index\|list\|match\|show\|inject\|validate\|forge` |
| Dispatch and gather    | `fuguectl dispatch <target>`, `fuguectl cache init\|put\|fail\|barrier\|collect\|resume`                                                                                                              |
| Integration and loop   | `fuguectl integrate --work <repo>`, `fuguectl loop init\|record\|decide\|status`, `fuguectl run set\|round\|status\|next\|clear`, `fuguectl summary <round>`                                          |
| Memory and maintenance | `fuguectl experience add\|list\|recall\|show`, `fuguectl self-harness template\|run`, `fuguectl runtime check\|adapt` (provider + installed workflow bundle drift), `fuguectl selftest`               |

## TypeScript Engine

`engine/` is the typed implementation: strict TypeScript, ports-and-adapters
layering, pure domain policy, and real harness/storage adapters.
`AgentRegistry` is the engine-native step away from script-first orchestration:
the coordinator can dispatch one round across `fugue-cc`, Codex, and OpenCode
by resolving logical agent ids to runtime profiles.

```bash
cd engine
npm run check
npm run build
node dist/cli/main.js version
```

The engine CLI currently exposes:

```bash
fugue version
fugue doctor
fugue init [--dry-run|--write]
fugue fleet status|up|down
fugue allocate <task-type>|list|record|feed|stats|reset|decay
fugue dispatch <target> --harness fugue-cc|codex|opencode|agy [--timeout-ms n] [--codex-clean] [--harness-arg x] [--out <file>] [--require-output] [--verbose] --template <name>|--prompt-file <file>|--prompt <text>
fugue integrate --work <repo> --agents "a b" [--ownership file] [--dry]
fugue skills index|list|match|show|inject|validate|forge
fugue preflight [--harness fugue-cc|codex|opencode|agy|all] [--model provider/model|--target provider/model] [--config-only] [provider.config]
fugue cache init|put|fail|status|barrier|collect|list|resume --cache <dir>
fugue plan "<goal>" --harness fugue-cc|codex|opencode|agy --out <dir> [--models m1,m2] [--timeout-ms n] [--harness-arg x] [--task <file>]
fugue task new|log|done
fugue template <name> --dir <templates> [--set KEY=VALUE ...]
fugue workspace list|show|model|context
fugue experience add|list|recall|show --store <dir>
fugue summary <round> --cache <dir> [--task <file>]
fugue runtime check|adapt --state <dir> [--skill <installed SKILL.md>] [--repo-skill <repo SKILL.md>]
fugue run set|round|status|next|clear
fugue loop init|record|decide|next|status
fugue goal template|show|check
fugue agent-registry template|validate|list|resolve
fugue self-harness template|run
```

For OpenCode, `preflight --target <provider/model>` checks the local
`opencode models` registry before dispatch, so a stale or unavailable model is
caught before the run starts.
For Antigravity, `--harness agy` dispatches through `agy --prompt`; target
`default` uses the current Antigravity settings, while any other target is passed
as `--model`.

`runtime check` also compares the repo's `orchestration/fuguectl/` bundle with
the installed workflow bundle. `runtime adapt --apply` syncs it, so local agent
instructions and helper entrypoints do not drift behind the repo after the
workflow evolves. If `fugue-cc` is unavailable, adapt still syncs the bundle but
exits non-zero so provider automation can detect the skipped runtime
restart/stamp.

## Self-Harness

Self-Harness improves the harness configuration, not the base model. FuguNano's
implementation is an engine-native abstraction inspired by Shanghai Artificial
Intelligence Laboratory's paper
[Self-Harness: Harnesses That Improve Themselves](https://arxiv.org/abs/2606.09498).

<p align="center">
  <img src="docs/readme-self-harness-en.svg" alt="Self-Harness loop in FuguNano" width="920">
</p>

```bash
orchestration/fuguectl/fuguectl self-harness template > /tmp/self-harness.json
orchestration/fuguectl/fuguectl self-harness run \
  --spec /tmp/self-harness.json \
  --state ~/.config/fugunano \
  --cwd /path/to/workspace
```

The strict JSON spec, editable surfaces, validation rules, and smoke tests are in
[docs/SELF_HARNESS.md](docs/SELF_HARNESS.md).

## Repository Map

| Path                           | Contents                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `backends/bin/`                | Model launchers, registry, `cc-models`, and `cc-sync`.                               |
| `backends/{install,verify}.ts` | Local install and launcher verification.                                             |
| `orchestration/fuguectl/`      | Node `fuguectl` wrappers, templates, workspaces, skill bundle, and tests.            |
| `orchestration/fugue-cc/`      | Sanitized provider configuration template for the runtime bridge.                    |
| `orchestration/cn-plugin/`     | Claude Code `/cn:*` plugin and dispatch agent.                                       |
| `orchestration/agent-team/`    | Higher-level multi-model planning example.                                           |
| `engine/`                      | TypeScript package, domain ports, adapters, CLI, and Self-Harness loop.              |
| `scripts/`                     | Secret scan, launcher lint, docs drift check, and skill installer.                   |
| `docs/`                        | Agent runtime, workflow, architecture, parity, integrations, and Self-Harness guide. |
| `AGENTS.md`                    | Cross-harness operator entry read by Claude Code, Codex, and OpenCode.               |

## Safety Model

- Keep real keys in `~/.config/cc-model-secrets.env` or ignored local config.
- Keep `.fugue-cc/` out of git.
- Route review to Codex or another independent reviewer. Antigravity (`agy`) is supported as an implementer runtime; legacy `gemini` CLI is retired.
- Never advance a round until the join barrier has all terminal results.
- Let deterministic gates fail before spending reviewer tokens.
- Run `npm run ci` before pushing.

## Development

```bash
make ci          # scan + launcher lint + docs + plugin/fuguectl + engine checks
make ci-clean    # same, but clean-installs engine dependencies first
make scan        # secret-leak gate
make lint        # Node launcher syntax check
make check-docs  # README + Self-Harness docs drift gate
make test        # cn-plugin + fuguectl selftest
make test-engine # TypeScript engine typecheck + lint + vitest
make doctor      # local environment recon
make help        # list all make targets
```

Root npm scripts mirror the same gates:

```bash
npm run ci
npm run ci:clean
npm run lint:launchers
npm run test:fuguectl
npm run test:engine
```

## Security

See [SECURITY.md](SECURITY.md). The repository contains only sanitized examples,
CI scans for leaks, and vulnerabilities should be reported privately through
GitHub Security Advisory.

## Acknowledgements

- [Sakana AI Fugu](https://sakana.ai/fugu/) for the diverse-model orchestration framing.
- [trotsky1997/OpenFugu](https://github.com/trotsky1997/OpenFugu) for the complementary training-based reconstruction.
- [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) for the plugin architecture that the `/cn:*` layer derives from.
- [Zleap-AI/Zleap-Agent](https://github.com/Zleap-AI/Zleap-Agent) for workspace isolation and experience-memory inspiration.
- [SeemSeam/claude_codex_bridge](https://github.com/SeemSeam/claude_codex_bridge) as a reference for the provider-runtime bridge.
- Shanghai Artificial Intelligence Laboratory's [Self-Harness paper](https://arxiv.org/abs/2606.09498) for the harness-improvement loop that inspired `fuguectl self-harness`.
- [kunchenguid/no-mistakes](https://github.com/kunchenguid/no-mistakes) and [lavish-axi](https://github.com/kunchenguid/lavish-axi) for loop-state and docs-drift ideas.
- [merkyor/Lynn](https://gitee.com/merkyor/Lynn) for orchestrator-side ownership enforcement inspiration.
- Anthropic's official `skill-creator` meta-skill for the skill authoring and validation flow.

See [NOTICE](NOTICE) for attribution detail.

## License

[Apache-2.0](LICENSE) © 2026 BicaMind Labs.
