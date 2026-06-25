# Self-Harness

Self-Harness is fugue's net-new loop for improving the harness itself, not the
model. It is our abstraction of arXiv 2606.09498: keep the model, evaluator, and
benchmark fixed; mine verifier-grounded weaknesses; ask a harness-backed agent
for bounded edits to declared harness surfaces; promote an edit only if it
improves at least one fixed split without regressing the other.

The implementation is split into pure domain logic, live adapters, and a CLI:

| Stage       | Port / adapter                   | Responsibility                                                                                                         |
| ----------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1. Mine     | `RunWeaknessMiner`               | Read failed `RunEvent`s, tag failures with model-backed signatures, cluster via the pure `clusterWeaknesses` function. |
| 2. Propose  | `HarnessBackedProposer`          | Prompt a configured harness agent for strict JSON replacement edits, then parse and sanitize them.                     |
| 3. Validate | `TaskListHarnessValidator`       | Re-run fixed held-in and held-out evaluation cases; shell gates decide pass/fail.                                      |
| Accept      | `acceptEdit` / `SelfHarnessLoop` | Promote only if `deltaIn >= 0`, `deltaOut >= 0`, and at least one delta is positive.                                   |

## CLI

Generate a starter JSON spec:

```bash
cd engine
npm run build
node dist/cli/main.js self-harness template > /tmp/self-harness.json
```

Run the loop:

```bash
node dist/cli/main.js self-harness run \
  --spec /tmp/self-harness.json \
  --state ~/.config/fugue \
  --cwd /path/to/workspace
```

`--cwd` is passed to both harness dispatches and shell gates. Use it whenever a
gate depends on relative paths.

## Spec Schema

The spec is strict JSON:

```json
{
  "agent": "cc-deepseek",
  "harness": "ccb",
  "k": 2,
  "rounds": 1,
  "runId": "source-run-id-mined-each-round",
  "config": {
    "system-prompt": "<system-prompt replacement text>",
    "memory-sources": "<memory-sources replacement text>",
    "subagents": "<subagents replacement text>",
    "skills": "<skills replacement text>",
    "bootstrap": "<bootstrap replacement text>",
    "execution": "<execution replacement text>",
    "verification": "<verification replacement text>",
    "failure-recovery": "<failure-recovery replacement text>",
    "runtime-policy": "<runtime-policy replacement text>"
  },
  "heldIn": [
    {
      "key": "held-in-example",
      "promptTemplate": "Use {{system-prompt}}\n\nTask: create /tmp/fugue-self-harness-held-in",
      "gate": "test -f /tmp/fugue-self-harness-held-in && rm -f /tmp/fugue-self-harness-held-in"
    }
  ],
  "heldOut": [
    {
      "key": "held-out-example",
      "promptTemplate": "Use {{verification}}\n\nTask: create /tmp/fugue-self-harness-held-out",
      "gate": "test -f /tmp/fugue-self-harness-held-out && rm -f /tmp/fugue-self-harness-held-out"
    }
  ]
}
```

Validation rules:

- `agent` and `runId` must be non-empty strings; identifier whitespace is
  trimmed during parsing.
- `harness`, if present, must be `ccb`, `codex`, or `opencode`; when omitted,
  CLI wiring dispatches through `ccb`.
- `k` and `rounds` must be positive integers.
- The top-level object is strict: unknown fields are rejected.
- `config` must contain exactly the editable surfaces declared by
  `EDITABLE_SURFACES`, all strings; unknown surfaces are rejected.
- `heldIn` and `heldOut` are arrays of `{ key, promptTemplate, gate }`; each
  object is strict, each field must be a non-empty string, and trimmed keys must
  be unique within a split. Empty splits are allowed, but they provide no useful
  validation signal.

## Prompt Rendering

Evaluation prompts use the normal `renderTemplate` substitution:

```text
{{system-prompt}} -> config["system-prompt"]
{{verification}}  -> config["verification"]
```

Unknown placeholders are left untouched. The validator dispatches the rendered
prompt to the configured harness/agent, then runs `sh -c <gate>`. A gate exit
code of `0` is a pass; dispatch errors and gate errors count as failures.
Prefer gates that clean up their own side effects, especially file-existence
checks, so one candidate cannot accidentally satisfy the next candidate's gate.

Treat a Self-Harness spec as trusted executable input: each `gate` runs through
`sh -c` in the selected working directory.

## Run Evidence

`runId` names the source run that Stage 1 mines. The CLI intentionally re-mines
the same run on every round:

```ts
(round) => spec.runId;
```

This is useful for "fixed-baseline" harness evolution where all candidate
configs are scored against the same weakness evidence and the same eval splits.
If you need fresh evidence between rounds, run the CLI again with a new source
run ID after executing the newly accepted harness.

Stage 1 reads only `RunEvent.kind` values `failed` and `no-agent`:

- `no-agent`: `detail = "<taskKey>"`
- `failed`: `detail = "<taskKey>: <reason>"`

Duplicate `taskKey`s are ignored after the first observation.

## Engineering Notes

- Expected failures never throw: harness dispatch errors, malformed model JSON,
  invalid proposal items, and gate failures are converted to empty results or
  failed cases.
- Model JSON is parsed through a shared balanced-array extractor that tolerates
  fenced output, prose around the payload, bracketed prose before the payload,
  and brackets inside JSON strings.
- Edits are full-surface replacements, not diffs. `applyEdit` replaces exactly
  one editable surface.
- The CLI prints one lineage row per candidate, then a compact per-surface
  `changed|same` summary and total promotions.

## Verification

Use the engine gates before relying on a change:

```bash
cd engine
npm run check
npm run build
node dist/cli/main.js self-harness template

# Error-path smoke: should exit 1 and print "no self-harness spec at /tmp/nope".
node dist/cli/main.js self-harness run --spec /tmp/nope
```

A successful `run` smoke needs a real source `RunStore` record under
`--state/runs` plus a reachable harness/agent. In normal use, create or select a
completed run first, put its ID in `runId`, then run:

```bash
node dist/cli/main.js self-harness run \
  --spec /tmp/self-harness.json \
  --state ~/.config/fugue \
  --cwd /path/to/workspace
```

The CLI unit suite also covers a no-weakness success path by writing a real
`FsRunStore` fixture and asserting the `changed|same` summary.
