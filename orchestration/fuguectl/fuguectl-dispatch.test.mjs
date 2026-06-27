#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  countLines,
  createSuite,
  here,
  makeTempDir,
  run,
  writeExecutable,
} from "./fuguectl-testlib.mjs";

const suite = createSuite("fuguectl-dispatch");
const dispatch = join(here, "fuguectl-dispatch");
const tmp = makeTempDir();
const called = join(tmp, "called");

const help = run(dispatch, ["--help"]).stdout;
suite.ok("help lists dispatch timeout", () => help.includes("--timeout-ms n"));
suite.ok("help lists dispatch harness args", () =>
  help.includes("--harness-arg x"),
);

writeExecutable(join(tmp, "fugue-cc"), [
  "#!/usr/bin/env node",
  "const fs = require('node:fs');",
  `fs.writeFileSync(${JSON.stringify(called)}, 'ARGV: ' + process.argv.slice(2).join(' ') + '\\n' + fs.readFileSync(0, 'utf8'));`,
]);
process.env.FUGUE_CC_BIN = join(tmp, "fugue-cc");
process.env.FUGUE_ALLOCATION_LEDGER = join(tmp, "ledger.tsv");

run(dispatch, [
  "cc-deepseek",
  "--template",
  "impl",
  "--set",
  "ROLE=BACKEND-ROLE",
  "--set",
  "SCOPE=SCOPE-MARK",
  "--set",
  "FILES=a.py",
]);
suite.ok("fugue-cc provider invoked", () => existsSync(called));
suite.ok("argv has agent + --compact + ask", () =>
  readFileSync(called, "utf8").includes("ARGV: ask cc-deepseek --compact"),
);
suite.ok("prompt(rendered) passed via stdin", () => {
  const text = readFileSync(called, "utf8");
  return text.includes("BACKEND-ROLE") && text.includes("SCOPE-MARK");
});

const promptFile = join(tmp, "p.md");
writeFileSync(promptFile, "custom prompt content\n");
run(dispatch, ["cc-glm", "--prompt-file", promptFile]);
suite.ok("prompt-file content via stdin", () =>
  readFileSync(called, "utf8").includes("custom prompt content"),
);
run(dispatch, ["cc-inline", "--prompt", "inline prompt content"]);
suite.ok("inline prompt content via stdin", () =>
  readFileSync(called, "utf8").includes("inline prompt content"),
);
run(dispatch, [
  "cc-deepseek",
  "--harness",
  "fugue-cc",
  "--prompt-file",
  promptFile,
]);
suite.ok("explicit fugue-cc harness dispatches", () =>
  readFileSync(called, "utf8").includes("ARGV: ask cc-deepseek --compact"),
);

const taskFile = join(tmp, "task.md");
writeFileSync(taskFile, "## Execution log\n");
run(dispatch, ["cc-kimi", "--prompt-file", promptFile, "--task", taskFile]);
suite.ok("--task appends dispatch log", () =>
  readFileSync(taskFile, "utf8").includes("dispatch → cc-kimi"),
);

const codexCalled = join(tmp, "codex.called");
writeExecutable(join(tmp, "codex"), [
  "#!/usr/bin/env node",
  "const fs = require('node:fs');",
  `fs.writeFileSync(${JSON.stringify(codexCalled)}, 'ARGV: ' + process.argv.slice(2).join(' ') + '\\n');`,
]);
process.env.FUGUE_CODEX = join(tmp, "codex");
run(dispatch, ["gpt-5.5", "--harness", "codex", "--prompt-file", promptFile]);
suite.ok("codex harness → codex exec --model <model>", () =>
  readFileSync(codexCalled, "utf8").includes("ARGV: exec --model gpt-5.5"),
);
suite.ok("codex harness: prompt passed as arg", () =>
  readFileSync(codexCalled, "utf8").includes("custom prompt content"),
);
run(dispatch, [
  "gpt-5.5",
  "--harness",
  "codex",
  "--harness-arg=-c",
  "--harness-arg=mcp_servers={}",
  "--prompt-file",
  promptFile,
]);
suite.ok("codex harness args are preserved through wrapper", () =>
  readFileSync(codexCalled, "utf8").includes(
    "ARGV: exec -c mcp_servers={} --model gpt-5.5",
  ),
);

const opencodeCalled = join(tmp, "oc.called");
writeExecutable(join(tmp, "opencode"), [
  "#!/usr/bin/env node",
  "const fs = require('node:fs');",
  `fs.writeFileSync(${JSON.stringify(opencodeCalled)}, 'ARGV: ' + process.argv.slice(2).join(' ') + '\\n');`,
]);
process.env.FUGUE_OPENCODE = join(tmp, "opencode");
run(dispatch, [
  "doubao/doubao-code",
  "--harness",
  "opencode",
  "--prompt-file",
  promptFile,
]);
suite.ok("opencode harness → opencode run -m <provider/model>", () =>
  readFileSync(opencodeCalled, "utf8").includes(
    "ARGV: run -m doubao/doubao-code",
  ),
);

const skillsRoot = join(tmp, "skills");
const injectedSkill = join(skillsRoot, "inj-tool");
writeFileSync(promptFile, "custom prompt content\n");
mkdirSync(injectedSkill, { recursive: true });
writeFileSync(
  join(injectedSkill, "SKILL.md"),
  [
    "---",
    "name: inj-tool",
    "description: INJECTED-SKILL-DESC for testing",
    "---",
    "body",
    "",
  ].join("\n"),
);
process.env.FUGUE_SKILLS_ROOT = skillsRoot;
process.env.FUGUE_SKILLS_CATALOG = join(tmp, "skcat.tsv");
process.env.FUGUE_SKILLS_NO_PLUGINS = "1";
run(dispatch, ["cc-x", "--prompt-file", promptFile, "--skills", "inj-tool"]);
suite.ok("--skills injects skill desc into prompt(via stdin)", () =>
  readFileSync(called, "utf8").includes("INJECTED-SKILL-DESC"),
);
suite.ok("--skills body still present after inject", () =>
  readFileSync(called, "utf8").includes("custom prompt content"),
);

rmSync(process.env.FUGUE_ALLOCATION_LEDGER, { force: true });
run(dispatch, [
  "cc-doubao",
  "--prompt-file",
  promptFile,
  "--task-type",
  "code",
]);
suite.ok("--task-type appends (type,agent) into ledger", () =>
  readFileSync(process.env.FUGUE_ALLOCATION_LEDGER, "utf8").includes(
    "code\tcc-doubao",
  ),
);
run(dispatch, ["cc-glm", "--prompt-file", promptFile]);
suite.ok(
  "no --task-type does not write ledger (line count unchanged)",
  () =>
    countLines(readFileSync(process.env.FUGUE_ALLOCATION_LEDGER, "utf8")) === 1,
);

suite.ok(
  "unknown harness → non-0",
  () =>
    run(dispatch, ["x", "--harness", "bogus", "--prompt-file", promptFile])
      .status !== 0,
);
suite.ok("no agent → non-0", () => run(dispatch, []).status !== 0);
suite.ok(
  "no prompt source → non-0",
  () => run(dispatch, ["cc-x"]).status !== 0,
);

suite.done();
