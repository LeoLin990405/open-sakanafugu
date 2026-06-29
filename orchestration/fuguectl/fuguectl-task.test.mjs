#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createSuite, here, makeTempDir, run } from "./fuguectl-testlib.mjs";

const suite = createSuite("fuguectl-task");
const task = join(here, "fuguectl-task");
const tmp = makeTempDir();
const calls = join(tmp, "task-calls.txt");

process.env.TASKS = join(tmp, "tasks");
process.env.FUGUE_ENGINE_CLI = join(tmp, "fugue-engine");
process.env.FUGUE_TASK_CALLS = calls;

writeFileSync(
  process.env.FUGUE_ENGINE_CLI,
  [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const argv = process.argv.slice(2);",
    "fs.appendFileSync(process.env.FUGUE_TASK_CALLS, argv.join(' ') + '\\n');",
    "const root = argv[0];",
    "const cmd = argv[1];",
    "const args = argv.slice(2);",
    "if (root !== 'task') {",
    "  console.error('expected task');",
    "  process.exit(9);",
    "}",
    "const tasks = process.env.TASKS || path.join(process.env.HOME || '.', '.claude/tasks');",
    "const stamp = '2026-06-25 12:00';",
    "const day = '2026-06-25';",
    "const die = (message) => { console.error(message); process.exit(1); };",
    "if (cmd === 'new') {",
    "  const title = args[0];",
    "  if (!title) die('missing title');",
    "  let priority = 'P1';",
    "  const idx = args.indexOf('--priority');",
    "  if (idx !== -1) priority = args[idx + 1] || '';",
    "  else if (args[1]) priority = args[1];",
    "  if (!['P0', 'P1', 'P2'].includes(priority)) die('invalid --priority');",
    "  fs.mkdirSync(tasks, { recursive: true });",
    "  let n = 1;",
    "  let file = '';",
    "  while (true) {",
    "    file = path.join(tasks, 'TASK-' + day + '-' + String(n).padStart(3, '0') + '.md');",
    "    if (!fs.existsSync(file)) break;",
    "    n += 1;",
    "  }",
    "  const id = 'TASK-' + day + '-' + String(n).padStart(3, '0');",
    "  fs.writeFileSync(file, [",
    "    '# ' + id + ': ' + title,",
    "    'Status: IN_PROGRESS',",
    "    'Priority: ' + priority,",
    "    'Created: ' + stamp,",
    "    'Completed: -',",
    "    '',",
    "    '## Requirements',",
    "    title,",
    "    '',",
    "    '## Subtasks',",
    "    '- [ ] (task1) - <scope> (Implementer: cc-xxx, file: ...)',",
    "    '- [ ] Final Review (Reviewer: coder)',",
    "    '',",
    "    '## Output files',",
    "    '- ...',",
    "    '',",
    "    '## Log',",
    "    '',",
    "  ].join('\\n'));",
    "  process.stdout.write(file + '\\n');",
    "} else if (cmd === 'log') {",
    "  const file = args[0];",
    "  const messageParts = args.slice(1);",
    "  if (!file || !fs.existsSync(file)) die('no task file');",
    "  fs.appendFileSync(file, '- [' + stamp + '] ' + messageParts.join(' ') + '\\n');",
    "  process.stdout.write('logged -> ' + file + '\\n');",
    "} else if (cmd === 'done') {",
    "  const file = args[0];",
    "  if (!file || !fs.existsSync(file)) die('no task file');",
    "  const next = fs.readFileSync(file, 'utf8').replace(/^Status: .*$/m, 'Status: DONE').replace(/^Completed: .*$/m, 'Completed: ' + stamp);",
    "  fs.writeFileSync(file, next);",
    "  process.stdout.write('done -> ' + file + '\\n');",
    "} else if (cmd === 'handoff') {",
    "  const file = args[0];",
    "  if (!file || !fs.existsSync(file)) die('no task file');",
    "  const text = fs.readFileSync(file, 'utf8');",
    "  process.stdout.write('[task:handoff] ' + text.split('\\n')[0].replace(/^# /, '') + '\\n');",
    "} else if (cmd === 'digest') {",
    "  const file = args[0];",
    "  if (!file || !fs.existsSync(file)) die('no task file');",
    "  const text = fs.readFileSync(file, 'utf8');",
    "  process.stdout.write('[task:digest] ' + text.split('\\n')[0].replace(/^# /, '') + '\\n');",
    "} else {",
    "  die('unknown task command ' + (cmd || ''));",
    "}",
    "",
  ].join("\n"),
);

const first = run(task, ["new", "test task title", "P0"]).stdout.trim();
suite.ok("new returns path and file exists", () => existsSync(first));
suite.ok("new filename like TASK-<date>-NNN.md", () =>
  /TASK-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{3}\.md$/u.test(first),
);
suite.ok("Status: IN_PROGRESS", () =>
  /^Status: IN_PROGRESS$/mu.test(readFileSync(first, "utf8")),
);
suite.ok("Priority written P0", () =>
  /^Priority: P0$/mu.test(readFileSync(first, "utf8")),
);
suite.ok("title goes into title line", () =>
  readFileSync(first, "utf8").includes("test task title"),
);
suite.ok("has Log section", () =>
  /^## Log$/mu.test(readFileSync(first, "utf8")),
);
suite.ok("help lists task digest", () =>
  run(task, ["--help"]).stdout.includes("digest  <task-file>"),
);

const second = run(task, ["new", "second"]).stdout.trim();
suite.ok("second new different file", () => first !== second);

run(task, ["log", first, "first log entry"]);
suite.ok("log appends to file", () =>
  readFileSync(first, "utf8").includes("first log entry"),
);
suite.ok("log has timestamp", () =>
  /^- \[[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}\] first log entry$/mu.test(
    readFileSync(first, "utf8"),
  ),
);
run(task, ["log", first, "first", "second"]);
suite.ok("log forwards multi-word message for TS joining", () =>
  readFileSync(first, "utf8").includes("first second"),
);

run(task, ["done", first]);
suite.ok("done → Status: DONE", () =>
  /^Status: DONE$/mu.test(readFileSync(first, "utf8")),
);
suite.ok("done wrote Completed time", () =>
  /^Completed: [0-9]{4}-/mu.test(readFileSync(first, "utf8")),
);
suite.ok(
  "done no longer IN_PROGRESS",
  () => !/^Status: IN_PROGRESS$/mu.test(readFileSync(first, "utf8")),
);

suite.ok(
  "new without title → non-0 exit",
  () => run(task, ["new"]).status !== 0,
);
suite.ok(
  "log nonexistent file → non-0",
  () => run(task, ["log", "/no/such/file", "x"]).status !== 0,
);
suite.ok("handoff renders task packet", () =>
  run(task, ["handoff", first]).stdout.includes("[task:handoff]"),
);
suite.ok("digest renders task context packet", () =>
  run(task, ["digest", first]).stdout.includes("[task:digest]"),
);
suite.ok("wrapper delegates positional priority to engine CLI", () =>
  readFileSync(calls, "utf8").includes("task new test task title P0\n"),
);
suite.ok("wrapper delegates split log words to engine CLI", () =>
  /^task log .* first second$/mu.test(readFileSync(calls, "utf8")),
);
suite.ok("wrapper delegates handoff to engine CLI", () =>
  /^task handoff /mu.test(readFileSync(calls, "utf8")),
);
suite.ok("wrapper delegates digest to engine CLI", () =>
  /^task digest /mu.test(readFileSync(calls, "utf8")),
);

suite.done();
