# fugue

[![CI](https://github.com/BicaMindLabs/open-sakanafugu/actions/workflows/ci.yml/badge.svg)](https://github.com/BicaMindLabs/open-sakanafugu/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.18-339933.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-322%20passing-success.svg)](orchestration/fuguectl)

**English | [简体中文](README_ZH.md)**

**fugue** is a training-free, self-hostable coding harness for running a fleet of
AI workers as one governed loop. It keeps implementation, review, integration,
and harness improvement separate enough that the system can be inspected, tested,
and stopped when it is wrong.

The daily operator surface is `fuguectl`. The Claude Code skill is `/fugue`.

<p align="center">
  <img src="docs/readme-overview.svg" alt="fugue overview" width="900">
</p>

## Why Fugue Exists

Single-agent coding works until the task needs breadth, adversarial review, or a
repeatable recovery path. fugue treats those as engineering problems:

- **Many workers, one control plane** - route work to specialized Claude Code
  clones and keep every output behind `fuguectl`.
- **Generation is not review** - implementers write; Codex or another configured
  independent reviewer gives the verdict.
- **Cache before trust** - a round that dispatches N tasks must collect N
  terminal results before integration.
- **Bounded repair** - the review-fix loop has keep-best, confirmation, user
  escalation, and non-convergence states.
- **Small context on purpose** - workspace and skill injection show each worker
  only the context it needs.
- **Learning without training** - allocation uses a benchmark prior plus live
  review outcomes to improve routing.
- **Harness self-improvement** - the typed engine can mine failed runs and test
  bounded changes to the harness itself.

## What You Get

| Layer | Status | Use it for |
| --- | --- | --- |
| `orchestration/fuguectl/` | Production shell operator: `fuguectl`, 18 subcommands, 18 test suites, 322 assertions | Day-to-day multi-agent coding |
| `engine/` | Strict TypeScript ports-and-adapters engine | Typed integrations, `fugue` CLI, Self-Harness |
| `orchestration/fugue-cc/` | Sanitized provider runtime template | Running Claude Code clones through model providers |
| `orchestration/cn-plugin/` | Claude Code `/cn:*` plugin | Lightweight single-machine model dispatch |

The shell operator stays green while capabilities graduate into the typed engine.
See [docs/PARITY.md](docs/PARITY.md) for migration status.

## Quick Start

Requirements: macOS or Linux, Node.js >= 18.18, `git`, `tmux`, and whichever
model/API credentials you choose to configure. Codex is recommended for review.

```bash
git clone https://github.com/BicaMindLabs/open-sakanafugu fugue
cd fugue

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

For a full `fugue-cc` fleet, put a sanitized provider config in the project you
want the fleet to edit:

```bash
cp orchestration/fugue-cc/provider.config.example /path/to/project/.fugue-cc/provider.config
cd /path/to/project
fugue-cc
```

Then run the operator from another shell:

```bash
/path/to/fugue/orchestration/fuguectl/fuguectl preflight
/path/to/fugue/orchestration/fuguectl/fuguectl fleet status
```

## Install The Claude Code Skill

```bash
make install-skill
```

This installs the skill to `~/.claude/skills/fugue`. Restart Claude Code, then
invoke `/fugue` or ask for a multi-agent coding workflow. Smoke-test the
installed bundle with:

```bash
~/.claude/skills/fugue/fuguectl selftest
```

## The Operator Loop

1. **Plan** - preflight, open a TASK file, assign ownership, and pick workers.
2. **Dispatch** - send scoped prompts through `fuguectl dispatch`.
3. **Gather** - cache every result and wait at the join barrier.
4. **Integrate** - cherry-pick reviewed worktrees onto `main`; isolate conflicts
   and ownership violations.
5. **Review** - get an independent ACCEPTED / NEEDS FIX verdict.
6. **Fix or finish** - run the bounded loop state machine until accepted or
   escalated.

```bash
fuguectl preflight
fuguectl task new "implement feature"
fuguectl dispatch cc-deepseek --template impl --task TASK.md --task-type backend
fuguectl cache barrier <round>
fuguectl integrate --work /path/to/project --agents "cc-deepseek cc-kimi"
fuguectl loop record --verdict NEEDS_FIX --round 1
fuguectl loop decide
```

The full walkthrough is in [docs/WORKFLOW.md](docs/WORKFLOW.md).

## Command Map

`orchestration/fuguectl/fuguectl` is the main operator entry point. Run
`fuguectl help` for exact syntax.

| Area | Commands |
| --- | --- |
| Setup and recon | `fuguectl doctor`, `fuguectl preflight`, `fuguectl fleet status\|up\|down` |
| Planning | `fuguectl task new\|log\|done`, `fuguectl template <name>`, `fuguectl plan "<goal>"`, `fuguectl goal template\|show\|check` |
| Routing and context | `fuguectl allocate <type>`, `fuguectl workspace list\|show\|model\|context`, `fuguectl skills index\|list\|match\|show\|inject\|validate\|forge` |
| Dispatch and gather | `fuguectl dispatch <target>`, `fuguectl cache init\|put\|fail\|barrier\|collect\|resume` |
| Integration and loop | `fuguectl integrate --work <repo>`, `fuguectl loop init\|record\|decide\|status`, `fuguectl run set\|round\|status\|next\|clear`, `fuguectl summary <round>` |
| Memory and maintenance | `fuguectl experience add\|list\|recall\|show`, `fuguectl runtime check\|adapt`, `fuguectl selftest` |

The current operator has 18 subcommands and 18 test suites.

## TypeScript Engine

The `engine/` package is the typed implementation of fugue's orchestration
model: strict TypeScript, ports-and-adapters layering, pure domain policy, and
adapters for real harnesses and stores.

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

## Self-Harness

Self-Harness improves the harness configuration, not the base model. fugue's
implementation is an engine-native abstraction inspired by Shanghai Artificial
Intelligence Laboratory's paper
[Self-Harness: Harnesses That Improve Themselves](https://arxiv.org/abs/2606.09498).

<p align="center">
  <img src="docs/readme-self-harness.svg" alt="Self-Harness loop" width="900">
</p>

```bash
cd engine
npm run build
node dist/cli/main.js self-harness template > /tmp/self-harness.json
node dist/cli/main.js self-harness run \
  --spec /tmp/self-harness.json \
  --state ~/.config/fugue \
  --cwd /path/to/workspace
```

The strict JSON spec, editable surfaces, validation rules, and smoke tests are in
[docs/SELF_HARNESS.md](docs/SELF_HARNESS.md).

## Repository Guide

| Path | Contents |
| --- | --- |
| `backends/bin/` | Model launchers, registry, `cc-models`, and `cc-sync`. |
| `backends/{install,verify}.sh` | Local install and launcher verification. |
| `orchestration/fuguectl/` | `fuguectl`, shared shell libraries, templates, workspaces, skill bundle, and tests. |
| `orchestration/fugue-cc/` | Sanitized provider configuration template for the runtime bridge. |
| `orchestration/cn-plugin/` | Claude Code `/cn:*` plugin and dispatch agent. |
| `orchestration/agent-team/` | Higher-level multi-model planning example. |
| `engine/` | TypeScript package, domain ports, adapters, CLI, and Self-Harness loop. |
| `scripts/` | Secret scan, shell lint, docs drift check, and skill installer. |
| `docs/` | Workflow, architecture, parity, integrations, and Self-Harness guide. |
| `AGENTS.md` | Cross-harness operator entry read by Claude Code, Codex, and OpenCode. |

## Safety Model

- Keep real keys in `~/.config/cc-model-secrets.env` or ignored local config.
- Keep `.fugue-cc/` out of git.
- Route review to Codex or another independent non-Gemini reviewer.
- Never advance a round until the join barrier has all terminal results.
- Let deterministic gates fail before spending reviewer tokens.
- Run `npm run ci` before pushing.

## Development

```bash
make ci          # scan + shell lint + docs + plugin/fuguectl + engine checks
make ci-clean    # same, but clean-installs engine dependencies first
make scan        # secret-leak gate
make lint        # bash -n + shellcheck
make check-docs  # README + Self-Harness docs drift gate
make test        # cn-plugin + fuguectl selftest
make test-engine # TypeScript engine typecheck + lint + vitest
make doctor      # local environment recon
make help        # list all make targets
```

The root npm scripts mirror the same gates:

```bash
npm run ci
npm run ci:clean
npm run test:fuguectl
npm run test:engine
```

## Security

See [SECURITY.md](SECURITY.md). In short: the repository contains only sanitized
examples, CI scans for leaks, and vulnerabilities should be reported privately
through GitHub Security Advisory.

## Acknowledgements

- [Sakana AI Fugu](https://sakana.ai/fugu/) for the diverse-model orchestration framing.
- [trotsky1997/OpenFugu](https://github.com/trotsky1997/OpenFugu) for the complementary training-based reconstruction.
- [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) for the plugin architecture that the `/cn:*` layer derives from.
- [Zleap-AI/Zleap-Agent](https://github.com/Zleap-AI/Zleap-Agent) for workspace isolation and experience-memory inspiration.
- [SeemSeam/claude_codex_bridge](https://github.com/SeemSeam/claude_codex_bridge) as a reference for the provider-runtime bridge.
- Shanghai Artificial Intelligence Laboratory's [Self-Harness paper](https://arxiv.org/abs/2606.09498) for the harness-improvement loop that inspired `fugue self-harness`.
- [kunchenguid/no-mistakes](https://github.com/kunchenguid/no-mistakes) and [lavish-axi](https://github.com/kunchenguid/lavish-axi) for loop-state and docs-drift ideas.
- [merkyor/Lynn](https://gitee.com/merkyor/Lynn) for orchestrator-side ownership enforcement inspiration.
- Anthropic's official `skill-creator` meta-skill for the skill authoring and validation flow.

See [NOTICE](NOTICE) for attribution detail.

## License

[Apache-2.0](LICENSE) © 2026 BicaMind Labs.
