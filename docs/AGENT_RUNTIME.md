# Agent Runtime Profiles

FuguNano no longer treats a single provider-backed clone fleet as the workflow
boundary. That fleet is one supported runtime behind the same port. The engine
names a logical agent, then resolves it to a concrete harness and target at
dispatch time.

## Model

```json
{
  "agents": [
    {
      "id": "cc-deepseek",
      "harness": "fugue-cc",
      "modelFamily": "deepseek",
      "roles": ["implementer", "fixer"],
      "canEditFiles": true
    },
    {
      "id": "coder",
      "harness": "codex",
      "target": "gpt-5.5",
      "modelFamily": "openai",
      "roles": ["reviewer", "implementer"],
      "reviewAllowed": true,
      "workspace": "review"
    },
    {
      "id": "opencode-kimi",
      "harness": "opencode",
      "target": "kimi-for-coding/k2p5",
      "modelFamily": "kimi",
      "roles": ["implementer"],
      "canEditFiles": true
    },
    {
      "id": "agy-ui",
      "harness": "agy",
      "target": "default",
      "modelFamily": "gemini",
      "roles": ["implementer"],
      "canEditFiles": true,
      "workspace": "code"
    }
  ]
}
```

| Field         | Meaning                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| `id`          | Stable logical agent name used by plans, task files, and allocation tables.                                 |
| `harness`     | Runtime adapter: `fugue-cc`, `codex`, `opencode`, or `agy`.                                                 |
| `target`      | Optional harness-native agent/model. If omitted, `id` is dispatched directly.                               |
| `modelFamily` | Policy label used for bans and generation-versus-review checks.                                             |
| `roles`       | Optional role allow-list: `planner`, `implementer`, `reviewer`, `fixer`. Omitted means legacy unrestricted. |
| `workspace`   | Optional workspace/context label carried into `DispatchRequest`.                                            |

The TypeScript parser is `parseAgentRegistryJson`; the starter JSON is generated
by `renderAgentRegistryTemplate`. Both are exported from `@bicamindlabs/fugunano-engine`.

## Operator Bridge

The production `fuguectl` operator exposes the same registry shape as the
engine:

```bash
fuguectl agents template > agents.json
fuguectl agents validate agents.json
fuguectl agents list agents.json
fuguectl agents resolve agents.json coder
```

For a quick smoke check, omit `agents.json` to use the starter registry:

```bash
fuguectl agents list
fuguectl agents resolve coder
```

The wrappers are intentionally small Node entry points. They give operators a
stable `fuguectl` command surface, while the engine remains the canonical place
for typed routing and coordinator behavior. The `agents`, `task`, `template`,
`workspace`, `experience`, `summary`, `runtime`, `run`, `loop`, `allocate`,
`dispatch`, `integrate`, `fleet`, `skills`, `preflight`, `cache`, `plan`,
`doctor`, and `goal` operator wrappers delegate to the built engine CLI at
`engine/dist/cli/main.js`; set `FUGUE_ENGINE_CLI` to override that path.

Use `fuguectl runtime check --strict --skill <installed SKILL.md> --alias-skill <legacy SKILL.md> --repo-skill <repo SKILL.md>`
when automation needs installed workflow bundle drift to fail the gate instead
of remaining report-only. The default canonical install is
`~/.claude/skills/fugunano/SKILL.md`; runtime sync also checks the legacy
`~/.claude/skills/fugue/SKILL.md` alias unless the primary skill path is
explicitly overridden.

## Dispatch Semantics

`Coordinator` accepts the registry through `CoordinatorDeps.agentRegistry` or
`wireCoordinator({ agentRegistry })`.

1. If a task specifies `agent`, the coordinator treats it as a logical id.
2. If a task omits `agent`, the allocator ranks logical ids as before.
3. If the logical id exists in the registry, the coordinator dispatches through
   that profile's harness map entry and sends `target ?? id` as
   `DispatchRequest.agent`.
4. If the id is not in the registry, the old single-harness behavior remains.

This keeps existing `fuguectl dispatch cc-deepseek --harness fugue-cc` workflows
working, while allowing a single engine round to mix `fugue-cc` implementers,
Codex reviewers, OpenCode providers, and Antigravity implementers.

OpenCode currently can print provider/model errors to stderr while still
exiting 0. The OpenCode adapter treats an empty-stdout, error-looking stderr as
`unavailable`, so `fuguectl dispatch --harness opencode` fails visibly instead
of caching an empty "successful" artifact.

Antigravity uses the same harness port through `agy --prompt`. A target of
`default` uses the current Antigravity settings; any other target is passed as
`--model <target>`.

## Policy

Policies evaluate the resolved profile label, not just the raw id. The key rule
is review independence: implementation and review should not collapse into the
same generation path. Antigravity (`agy`) is supported as an implementer runtime;
legacy `gemini` CLI entrypoints are treated as retired.

## Cutover Status

The repository now has no tracked `.sh` scripts. New orchestration primitives
should continue to land in the engine first:

- registry parsing and validation in pure domain code;
- runtime selection in `Coordinator`;
- CLI commands as thin wrappers over tested engine functions;
- executable wrapper files only when they delegate to tested TypeScript.

The migration goal is now enforced by `npm run lint:launchers`: Node launchers
must parse, and any newly tracked shell script fails the gate.
