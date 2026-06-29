#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createSuite, here, makeTempDir, run } from "./fuguectl-testlib.mjs";

const suite = createSuite("fuguectl-experience");
const experience = join(here, "fuguectl-experience");
const workspace = join(here, "fuguectl-workspace");
const tmp = makeTempDir();

process.env.FUGUE_EXPERIENCE = join(tmp, "exp");
process.env.FUGUE_ENGINE_CLI = join(tmp, "fugue-engine");
process.env.FUGUE_EXPERIENCE_CALLS = join(tmp, "experience-calls.txt");

writeFileSync(
  process.env.FUGUE_ENGINE_CLI,
  [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(process.env.FUGUE_EXPERIENCE_CALLS, args.join(' ') + '\\n');",
    "const root = args[0];",
    "const cmd = args[1];",
    "const die = (message) => { console.error(message); process.exit(1); };",
    "const readStdin = () => fs.readFileSync(0, 'utf8').replace(/\\n$/u, '');",
    "const slugify = (title) => title.replace(/[ /]/g, '-').replace(/[\"'\\`]/g, '');",
    "const field = (text, key) => {",
    "  const line = text.split(/\\r?\\n/u).find((item) => item.startsWith(key + ': '));",
    "  return line === undefined ? '' : line.slice(key.length + 2);",
    "};",
    "const bodyOf = (text) => text.replace(/^---\\n[\\s\\S]*?\\n---\\n/u, '').replace(/\\n+$/u, '');",
    "const parseExperienceArgs = () => {",
    "  const storeIndex = args.indexOf('--store');",
    "  if (storeIndex === -1) return { store: process.env.FUGUE_EXPERIENCE, rest: args.slice(2) };",
    "  return { store: args[storeIndex + 1], rest: args.slice(2).filter((_, index) => index !== storeIndex - 2 && index !== storeIndex - 1) };",
    "};",
    "if (root === 'workspace' && cmd === 'context') {",
    "  const store = process.env.FUGUE_EXPERIENCE;",
    "  let injected = '';",
    "  const dir = path.join(store, 'code');",
    "  if (fs.existsSync(dir)) {",
    "    for (const name of fs.readdirSync(dir).filter((item) => item.endsWith('.md'))) injected += fs.readFileSync(path.join(dir, name), 'utf8') + '\\n';",
    "  }",
    "  process.stdout.write('## Context - workspace: code\\n\\n' + injected);",
    "  process.exit(0);",
    "}",
    "if (root !== 'experience') die('expected experience');",
    "const parsed = parseExperienceArgs();",
    "const store = parsed.store;",
    "const rest = parsed.rest;",
    "if (cmd === 'add') {",
    "  const ws = rest[0];",
    "  const title = rest[1];",
    "  const tail = rest.slice(2);",
    "  if (!ws || !title) die('usage: add <ws> <title>');",
    "  const fromIndex = tail.indexOf('--from');",
    "  const body = fromIndex === -1 ? readStdin() : fs.readFileSync(tail[fromIndex + 1], 'utf8').replace(/\\n$/u, '');",
    "  if (body.length === 0) die('experience body is empty');",
    "  if (/sk-[A-Za-z0-9_-]{20,}|tp-[a-z0-9]{30,}|[0-9a-f]{32}\\.[A-Za-z0-9]{16}/u.test(body)) die('body contains a suspected key; redact first');",
    "  const dir = path.join(store, ws);",
    "  fs.mkdirSync(dir, { recursive: true });",
    "  const slug = slugify(title);",
    "  const file = path.join(dir, slug + '.md');",
    "  fs.writeFileSync(file, '---\\nworkspace: ' + ws + '\\ntitle: ' + title + '\\ncreated: 1\\n---\\n' + body + '\\n');",
    "  process.stdout.write('experience stored: ' + file + '\\n');",
    "} else if (cmd === 'learn') {",
    "  const ws = rest[0];",
    "  const title = rest[1];",
    "  const taskIndex = rest.indexOf('--task');",
    "  if (!ws || !title || taskIndex === -1) die('usage: learn <ws> <title> --task <file>');",
    "  const task = rest[taskIndex + 1];",
    "  const body = 'Source task: ' + task + '\\n\\n' + fs.readFileSync(task, 'utf8');",
    "  const dir = path.join(store, ws);",
    "  fs.mkdirSync(dir, { recursive: true });",
    "  const slug = slugify(title);",
    "  const file = path.join(dir, slug + '.md');",
    "  fs.writeFileSync(file, '---\\nworkspace: ' + ws + '\\ntitle: ' + title + '\\ncreated: 1\\n---\\n' + body + '\\n');",
    "  process.stdout.write('experience learned: ' + file + '\\n');",
    "} else if (cmd === 'list') {",
    "  const ws = rest[0];",
    "  const base = ws === undefined ? store : path.join(store, ws);",
    "  if (!fs.existsSync(base)) { process.stdout.write('(no experiences yet)\\n'); process.exit(0); }",
    "  const files = [];",
    "  const visit = (dir) => {",
    "    for (const name of fs.readdirSync(dir)) {",
    "      const file = path.join(dir, name);",
    "      if (fs.statSync(file).isDirectory()) visit(file);",
    "      else if (name.endsWith('.md')) files.push(file);",
    "    }",
    "  };",
    "  visit(base);",
    "  for (const file of files.sort()) {",
    "    const text = fs.readFileSync(file, 'utf8');",
    "    process.stdout.write('  ' + path.basename(path.dirname(file)).padEnd(12) + ' ' + field(text, 'title') + '\\n');",
    "  }",
    "} else if (cmd === 'recall') {",
    "  const ws = rest[0];",
    "  const queryIndex = rest.indexOf('--query');",
    "  const query = queryIndex === -1 ? '' : rest[queryIndex + 1];",
    "  const dir = path.join(store, ws);",
    "  if (!fs.existsSync(dir)) process.exit(0);",
    "  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => path.join(dir, name));",
    "  for (const file of files) {",
    "    const text = fs.readFileSync(file, 'utf8');",
    "    if (query && !text.includes(query)) continue;",
    "    process.stdout.write('[experience] ' + field(text, 'title') + '\\n' + bodyOf(text) + '\\n\\n');",
    "  }",
    "} else if (cmd === 'policy') {",
    "  const ws = rest[0];",
    "  const slug = rest[1];",
    "  const dir = path.join(store, ws);",
    "  if (!fs.existsSync(dir)) process.exit(0);",
    "  const files = slug && !slug.startsWith('--') ? [path.join(dir, slug + '.md')] : fs.readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => path.join(dir, name));",
    "  for (const file of files) {",
    "    if (!fs.existsSync(file)) continue;",
    "    const text = fs.readFileSync(file, 'utf8');",
    "    process.stdout.write('[experience:policy] ' + field(text, 'title') + '\\n- body: ' + bodyOf(text).split(/\\r?\\n/u).filter(Boolean)[0] + '\\n');",
    "  }",
    "} else if (cmd === 'show') {",
    "  const ws = rest[0];",
    "  const slug = rest[1];",
    "  const file = path.join(store, ws, slug + '.md');",
    "  if (!fs.existsSync(file)) die('no experience ' + ws + '/' + slug);",
    "  process.stdout.write(fs.readFileSync(file, 'utf8'));",
    "} else {",
    "  die('unknown experience command ' + cmd);",
    "}",
    "",
  ].join("\n"),
);

run(experience, ["add", "code", "defensive-copy-trick"], {
  input:
    "use defensive copy(intervals[0][:]) to avoid mutating the input interval\n",
});
const defensiveRecord = join(
  process.env.FUGUE_EXPERIENCE,
  "code",
  "defensive-copy-trick.md",
);
suite.ok("add stored", () => existsSync(defensiveRecord));
suite.ok("record has body", () =>
  readFileSync(defensiveRecord, "utf8").includes("defensive copy"),
);
suite.ok("record has frontmatter", () =>
  /^workspace: code/mu.test(readFileSync(defensiveRecord, "utf8")),
);

const fakeKey = `sk-${"a".repeat(25)}`;
const bad = run(experience, ["add", "code", "bad-experience"], {
  input: `use this key ${fakeKey}\n`,
});
suite.ok("has key → reject(non-0)", () => bad.status !== 0);
suite.ok(
  "bad experience not stored",
  () =>
    !existsSync(
      join(process.env.FUGUE_EXPERIENCE, "code", "bad-experience.md"),
    ),
);

suite.ok("list has title", () =>
  run(experience, ["list", "code"]).stdout.includes("defensive-copy"),
);

const recalled = run(experience, ["recall", "code"]).stdout;
suite.ok("recall emits body", () => recalled.includes("defensive copy"));
suite.ok("recall has [experience] marker", () =>
  recalled.includes("[experience]"),
);
suite.ok(
  "recall drops frontmatter(no created:)",
  () => !/^created:/mu.test(recalled),
);

suite.ok(
  "recall empty ws → empty",
  () => run(experience, ["recall", "nonexistent"]).stdout === "",
);

run(experience, ["add", "sql", "sql-date-window"], {
  input: "qwen3 SQL last 30 days uses DATE_SUB(CURDATE(),INTERVAL 30 DAY)\n",
});
suite.ok("recall --query hits", () =>
  run(experience, ["recall", "sql", "--query", "DATE_SUB"]).stdout.includes(
    "DATE_SUB",
  ),
);

suite.ok("show prints record", () =>
  run(experience, ["show", "code", "defensive-copy-trick"]).stdout.includes(
    "title: defensive-copy-trick",
  ),
);

const task = join(tmp, "TASK.md");
writeFileSync(
  task,
  "# TASK-1: Runtime fix\nStatus: DONE\n\n## Requirements\nKeep observations separate.\n",
);
run(experience, ["learn", "code", "task-retro", "--task", task]);
suite.ok("learn stores task-derived experience", () =>
  existsSync(join(process.env.FUGUE_EXPERIENCE, "code", "task-retro.md")),
);
suite.ok("learned task can be recalled", () =>
  run(experience, ["recall", "code", "--query", "Source task"]).stdout.includes(
    task,
  ),
);
suite.ok("policy renders learned task as a card", () =>
  run(experience, ["policy", "code", "task-retro"]).stdout.includes(
    "[experience:policy] task-retro",
  ),
);
suite.ok("workspace context injects experience", () =>
  run(workspace, ["context", "code"]).stdout.includes("defensive copy"),
);
suite.ok("wrapper delegates to engine CLI", () =>
  readFileSync(process.env.FUGUE_EXPERIENCE_CALLS, "utf8").includes(
    "experience add code defensive-copy-trick\n",
  ),
);
suite.ok("wrapper delegates learn to engine CLI", () =>
  readFileSync(process.env.FUGUE_EXPERIENCE_CALLS, "utf8").includes(
    `experience learn code task-retro --task ${task}\n`,
  ),
);
suite.ok("wrapper delegates policy to engine CLI", () =>
  readFileSync(process.env.FUGUE_EXPERIENCE_CALLS, "utf8").includes(
    "experience policy code task-retro\n",
  ),
);

suite.done();
