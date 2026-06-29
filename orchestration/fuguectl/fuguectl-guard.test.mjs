#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createSuite, here, makeTempDir, run } from "./fuguectl-testlib.mjs";

const suite = createSuite("fuguectl-guard");
const guard = join(here, "fuguectl-guard");
const tmp = makeTempDir();
const calls = join(tmp, "guard-calls.txt");

process.env.FUGUE_ENGINE_CLI = join(tmp, "fugue-engine");
process.env.FUGUE_GUARD_CALLS = calls;

writeFileSync(
  process.env.FUGUE_ENGINE_CLI,
  [
    "const fs = require('node:fs');",
    "const argv = process.argv.slice(2);",
    "fs.appendFileSync(process.env.FUGUE_GUARD_CALLS, argv.join(' ') + '\\n');",
    "if (argv[0] !== 'guard') {",
    "  console.error('expected guard');",
    "  process.exit(9);",
    "}",
    "if (argv[1] === 'prompt') {",
    "  process.stdout.write('[runtime-guard:packet] disposition=ALLOW findings=0\\n');",
    "  process.exit(0);",
    "}",
    "console.error('unknown guard command');",
    "process.exit(1);",
    "",
  ].join("\n"),
);

const promptFile = join(tmp, "prompt.md");
writeFileSync(promptFile, "Implement the task.\n");

suite.ok("help lists guard prompt", () =>
  run(guard, ["--help"]).stdout.includes("prompt <prompt-file|->"),
);
suite.ok("prompt delegates to engine CLI", () =>
  run(guard, ["prompt", promptFile, "--json"]).stdout.includes(
    "[runtime-guard:packet]",
  ),
);
suite.ok("fake engine was invoked", () => existsSync(calls));
suite.ok("prompt forwards file and json flag", () =>
  readFileSync(calls, "utf8").includes(`guard prompt ${promptFile} --json\n`),
);
suite.ok(
  "unknown subcommand is nonzero",
  () => run(guard, ["bogus"]).status !== 0,
);

suite.done();
