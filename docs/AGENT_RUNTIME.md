# Agent Runtime Profiles

fugue no longer treats a single provider-backed clone fleet as the workflow
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
      "target": "kimi/latest",
      "modelFamily": "kimi",
      "roles": ["implementer"],
      "canEditFiles": true
    }
  ]
}
```

| Field         | Meaning                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| `id`          | Stable logical agent name used by plans, task files, and allocation tables.                                 |
| `harness`     | Runtime adapter: `fugue-cc`, `codex`, or `opencode`.                                                        |
| `target`      | Optional harness-native agent/model. If omitted, `id` is dispatched directly.                               |
| `modelFamily` | Policy label used for bans and generation-versus-review checks.                                             |
| `roles`       | Optional role allow-list: `planner`, `implementer`, `reviewer`, `fixer`. Omitted means legacy unrestricted. |
| `workspace`   | Optional workspace/context label carried into `DispatchRequest`.                                            |

The TypeScript parser is `parseAgentRegistryJson`; the starter JSON is generated
by `renderAgentRegistryTemplate`. Both are exported from `@bicamindlabs/fugue-engine`.

## Shell Bridge

The production shell operator exposes the same registry shape while the CLI
surface migrates command by command:

```bash
fuguectl agents template > agents.json
fuguectl agents validate agents.json
fuguectl agents list agents.json
fuguectl agents resolve agents.json coder
```

The shell helper is intentionally small: it gives operators a durable `.sh`
entry point for registry files, while the engine remains the canonical place for
typed routing and coordinator behavior. The `agents`, `task`, `template`,
`workspace`, `experience`, `summary`, `runtime`, `run`, `loop`, `allocate`,
`dispatch`, `integrate`, `fleet`, `preflight`, `cache`, `plan`, `doctor`, and `goal` operator scripts now delegate to the built engine CLI at
`engine/dist/cli/main.js`; set `FUGUE_ENGINE_CLI` to override that path.

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
Codex reviewers, and OpenCode providers.

## Policy

Policies evaluate the resolved profile label, not just the raw id. For example,
an innocuous id with `"modelFamily": "gemini"` is still blocked by the
no-Gemini rule. This matters because runtime-specific target strings are often
too short or too provider-shaped to carry policy safely by themselves.

## Shell Migration

The bash `fuguectl` surface remains the stable operator layer until each command
has a tested TypeScript slice. New orchestration primitives should be added to
the engine first:

- registry parsing and validation in pure domain code;
- runtime selection in `Coordinator`;
- CLI commands as thin wrappers over tested engine functions;
- shell scripts only as compatibility shims, local installers, or provider
  launchers where the runtime itself is shell-native.

The goal is not to delete useful scripts prematurely. The goal is to make the
state machine, policy, routing, and dispatch semantics replayable from typed
code, then retire bash where the engine has equal or better coverage.
