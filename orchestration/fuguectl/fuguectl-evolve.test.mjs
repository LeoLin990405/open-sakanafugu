#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createSuite, here, makeTempDir, run } from "./fuguectl-testlib.mjs";

const suite = createSuite("fuguectl-evolve");
const evolve = join(here, "fuguectl-evolve");
const tmp = makeTempDir();
const calls = join(tmp, "evolve-calls.txt");

process.env.FUGUE_ENGINE_CLI = join(tmp, "fugue-engine");
process.env.FUGUE_EVOLVE_CALLS = calls;

writeFileSync(
  process.env.FUGUE_ENGINE_CLI,
  [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(process.env.FUGUE_EVOLVE_CALLS, args.join(' ') + '\\n');",
    "const root = args[0];",
    "const sub = args[1];",
    "if (root !== 'evolve') { console.error('expected evolve'); process.exit(9); }",
    "if (sub === 'promote' && args.includes('--by') && args[args.indexOf('--by') + 1] === 'evolve') {",
    "  console.error(\"refusing autonomous promotion of safety surface 'guard-rule' by 'evolve'; safety surfaces require promotedBy=operator\");",
    "  process.exit(1);",
    "}",
    "if (sub === 'mine') { process.stdout.write('wrote 1 weakness signal(s)\\n'); process.exit(0); }",
    "if (sub === 'validate') { process.stdout.write('validated guard-rule/x: accepted=true dIn=1 dOut=0\\n'); process.exit(0); }",
    'if (sub === \'promote\') { process.stdout.write(\'{"surface":"guard-rule","promotedBy":"operator"}\\n\'); process.exit(0); }',
    'if (sub === \'history\') { process.stdout.write(\'{"schemaVersion":"fugunano.evolve.history.v1","entries":[]}\\n\'); process.exit(0); }',
    "console.error('unknown evolve command ' + sub);",
    "process.exit(1);",
    "",
  ].join("\n"),
);

suite.ok("help lists promote gate surface", () =>
  run(evolve, ["--help"]).stdout.includes("--by operator|self-harness|evolve"),
);

run(evolve, ["mine", "packet.json", "--out", "weaknesses.json"]);
suite.ok("mine delegates to engine CLI", () =>
  /^evolve mine packet\.json --out weaknesses\.json$/mu.test(
    readFileSync(calls, "utf8"),
  ),
);

run(evolve, [
  "validate",
  "--candidate",
  "c.json",
  "--cases",
  "cases.json",
  "--samples",
  "3",
  "--out",
  "fitness.json",
]);
suite.ok("validate delegates samples", () =>
  readFileSync(calls, "utf8").includes(
    "evolve validate --candidate c.json --cases cases.json --samples 3 --out fitness.json\n",
  ),
);

const refused = run(evolve, [
  "promote",
  "--candidate",
  "c.json",
  "--fitness",
  "fitness.json",
  "--by",
  "evolve",
  "--lineage",
  "lineage",
]);
suite.ok(
  "autonomous guard-rule promote refusal propagates non-0",
  () => refused.status !== 0,
);
suite.ok("autonomous guard-rule promote refusal keeps safety message", () =>
  refused.stderr.includes("safety surfaces require promotedBy=operator"),
);

const promoted = run(evolve, [
  "promote",
  "--candidate",
  "c.json",
  "--fitness",
  "fitness.json",
  "--by",
  "operator",
  "--lineage",
  "lineage",
]);
suite.ok(
  "operator promote delegates successfully",
  () => promoted.status === 0,
);

suite.ok("history prints schema", () =>
  run(evolve, ["history", "--lineage", "lineage"]).stdout.includes(
    "fugunano.evolve.history.v1",
  ),
);

suite.ok(
  "unknown subcommand → non-0",
  () => run(evolve, ["bogus"]).status !== 0,
);

suite.done();
