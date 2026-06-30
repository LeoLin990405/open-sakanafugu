#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  countLines,
  createSuite,
  here,
  makeTempDir,
  run,
} from "./fuguectl-testlib.mjs";

const suite = createSuite("fuguectl-loop");
const loop = join(here, "fuguectl-loop");
const tmp = makeTempDir();
const calls = join(tmp, "loop-calls.txt");

process.env.FUGUE_CACHE = join(tmp, "cache");
process.env.FUGUE_ENGINE_CLI = join(tmp, "fugue-engine");
process.env.FUGUE_LOOP_CALLS = calls;

writeFileSync(
  process.env.FUGUE_ENGINE_CLI,
  [
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.FUGUE_LOOP_CALLS, `${process.argv.slice(2).join(' ')}\\n`);",
    "const args = process.argv.slice(2);",
    "if (args[0] !== 'loop') {",
    "  console.error('expected loop root command');",
    "  process.exit(2);",
    "}",
    "process.exit(0);",
    "",
  ].join("\n"),
);

run(loop, ["init", "--max", "3", "--best-sha", "sha0"]);
suite.ok("loop shim forwards init", () =>
  readFileSync(calls, "utf8").includes("loop init --max 3 --best-sha sha0\n"),
);

run(loop, [
  "record",
  "1",
  "--gate",
  "pass",
  "--verdict",
  "NEEDSFIX",
  "--findings",
  "2",
  "--ask-user",
  "1",
]);
suite.ok("loop shim preserves record flags", () =>
  readFileSync(calls, "utf8").includes(
    "loop record 1 --gate pass --verdict NEEDSFIX --findings 2 --ask-user 1\n",
  ),
);

run(loop, ["decide"]);
suite.ok("loop shim forwards decide", () =>
  readFileSync(calls, "utf8").includes("loop decide\n"),
);

const help = run(loop, ["--help"]).stdout;
suite.ok("help prints loop commands", () => help.includes("record <round>"));
suite.ok(
  "help does not call engine",
  () => countLines(readFileSync(calls, "utf8")) === 3,
);

// review → loop verdict: `record --review <file>` derives verdict + finding count
// from a review packet so the loop consumes review output instead of the operator
// hand-typing the verdict. Exercised against the real engine CLI (not the shim).
const engineMain = resolve(here, "..", "..", "engine", "dist", "cli", "main.js");
const rcache = join(tmp, "review-cache");
run(process.execPath, [engineMain, "loop", "--cache", rcache, "init", "--max", "3"]);

const needsFixReview = join(tmp, "review-needsfix.md");
writeFileSync(needsFixReview, "VERDICT: NEEDS_FIX\n- F1: bug in foo\n- F2: missing test\n");
const recNeedsFix = run(process.execPath, [
  engineMain, "loop", "--cache", rcache, "record", "1", "--gate", "fail", "--review", needsFixReview,
]);
suite.ok("--review derives NEEDSFIX verdict and finding count", () =>
  recNeedsFix.stdout.includes("verdict=NEEDSFIX") &&
  recNeedsFix.stdout.includes("findings=2"),
);

const acceptReview = join(tmp, "review-accept.md");
writeFileSync(acceptReview, "VERDICT: ACCEPTED\n");
const recAccept = run(process.execPath, [
  engineMain, "loop", "--cache", rcache, "record", "2", "--gate", "pass", "--review", acceptReview,
]);
suite.ok("--review derives ACCEPTED verdict with zero findings", () =>
  recAccept.stdout.includes("verdict=ACCEPTED") &&
  recAccept.stdout.includes("findings=0"),
);

const recOverride = run(process.execPath, [
  engineMain, "loop", "--cache", rcache, "record", "3", "--gate", "pass",
  "--review", needsFixReview, "--verdict", "ACCEPTED",
]);
suite.ok("explicit --verdict overrides the review-derived verdict", () =>
  recOverride.stdout.includes("verdict=ACCEPTED"),
);

const unknownReview = join(tmp, "review-unknown.md");
writeFileSync(unknownReview, "some review text with no verdict line\n");
const recUnknown = run(process.execPath, [
  engineMain, "loop", "--cache", rcache, "record", "4", "--gate", "pass", "--review", unknownReview,
]);
suite.ok("--review with UNKNOWN verdict → non-0 (asks for explicit --verdict)", () =>
  recUnknown.status !== 0,
);

// fast-path-clean (opt-in): a clean first pass (gate pass + ACCEPTED + 0 findings)
// finishes in one round (DONE, exit 0) instead of forcing a confirmation pass —
// removing the orchestration overhead on simple tasks. Off by default.
const fastCache = join(tmp, "fast-cache");
run(process.execPath, [engineMain, "loop", "--cache", fastCache, "init", "--max", "3", "--fast-path-clean"]);
run(process.execPath, [
  engineMain, "loop", "--cache", fastCache, "record", "1", "--gate", "pass", "--verdict", "ACCEPTED", "--findings", "0",
]);
const fastDecide = run(process.execPath, [engineMain, "loop", "--cache", fastCache, "decide"]);
suite.ok("--fast-path-clean: clean first pass → DONE (exit 0)", () =>
  fastDecide.status === 0 && fastDecide.stdout.includes("DONE"),
);

const slowCache = join(tmp, "slow-cache");
run(process.execPath, [engineMain, "loop", "--cache", slowCache, "init", "--max", "3"]);
run(process.execPath, [
  engineMain, "loop", "--cache", slowCache, "record", "1", "--gate", "pass", "--verdict", "ACCEPTED", "--findings", "0",
]);
const slowDecide = run(process.execPath, [engineMain, "loop", "--cache", slowCache, "decide"]);
suite.ok("default (no flag): same clean first pass → CONFIRM, not DONE", () =>
  slowDecide.stdout.includes("CONFIRM"),
);

suite.done();
