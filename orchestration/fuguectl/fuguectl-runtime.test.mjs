#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { createSuite, here, makeTempDir, run } from "./fuguectl-testlib.mjs";

const suite = createSuite("fuguectl-runtime");
const runtime = join(here, "fuguectl-runtime");
const fuguectl = join(here, "fuguectl");
const tmp = makeTempDir();
const calls = join(tmp, "runtime-calls.txt");

process.env.FUGUE_ENGINE_CLI = join(tmp, "fugue-engine");
process.env.FUGUE_RUNTIME_CALLS = calls;

writeFileSync(
  process.env.FUGUE_ENGINE_CLI,
  [
    "const cp = require('node:child_process');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(process.env.FUGUE_RUNTIME_CALLS, args.join(' ') + '\\n');",
    "const die = (message) => { console.error(message); process.exit(2); };",
    "const opt = (name, fallback = '') => {",
    "  const index = args.indexOf(name);",
    "  return index === -1 ? fallback : args[index + 1] || fallback;",
    "};",
    "const has = (name) => args.includes(name);",
    "const versionOutput = (bin) => {",
    "  try { return cp.execFileSync(bin, ['version'], { encoding: 'utf8' }); } catch { return ''; }",
    "};",
    "const versionOf = (text) => (text.match(/v[0-9]+\\.[0-9]+\\.[0-9]+/u) || [''])[0];",
    "const graftingOk = (install) => fs.existsSync(path.join(install, 'lib/provider_profiles/api_shortcuts.py'));",
    "const root = args[0];",
    "const sub = args[1];",
    "if (root !== 'runtime') die('expected runtime');",
    "const bin = opt('--bin', process.env.FUGUE_CC_BIN || 'fugue-cc');",
    "const state = opt('--state', process.env.FUGUNANO_STATE || process.env.FUGUE_STATE || path.join(process.env.HOME || '', '.config/fugunano'));",
    "const driver = opt('--driver-name', process.env.FUGUE_DRIVER_NAME || 'fuguectl');",
    "const install = opt('--install', process.env.FUGUE_CC_INSTALL || path.join(process.env.HOME || '', '.local/share/codex-dual'));",
    "const stamp = path.join(state, 'runtime-version');",
    "const current = versionOf(versionOutput(bin));",
    "if (sub === 'check') {",
    "  const last = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : '(none)';",
    "  process.stdout.write('fugue-cc provider current: ' + (current || 'unknown') + '   last recorded: ' + last + '\\n');",
    "  if (!current) process.exit(0);",
    '  process.stdout.write(current !== last ? "  version drift (" + last + " -> " + current + "): run \'" + driver + " runtime adapt --apply\' to adapt\\n" : "  no drift\\n");',
    "  process.stdout.write(graftingOk(install) ? '  grafting api_shortcuts.py present (' + install + ')\\n' : '  grafting api_shortcuts.py is gone - claude+url grafting may break, check the new fugue-cc version manually\\n');",
    "} else if (sub === 'adapt') {",
    "  if (!current) die('cannot get fugue-cc provider version');",
    "  const apply = has('--apply');",
    "  const last = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : '';",
    "  process.stdout.write('fugue-cc runtime adapt (' + (last || 'none') + ' -> ' + current + ')' + (apply ? '' : ' [dry-run]') + '\\n');",
    "  process.stdout.write(graftingOk(install) ? '  grafting api_shortcuts.py present\\n' : '  grafting dependency lost - new fugue-cc may have changed provider_profiles, grafting scheme needs manual adaptation\\n');",
    "  const work = opt('--work', process.env.FUGUE_CC_WORK || '');",
    "  const claude = opt('--claude', process.env.FUGUE_CC_CLAUDE || '');",
    "  const projects = [work, claude].filter(Boolean);",
    "  if (projects.length === 0) process.stdout.write('  FUGUE_CC_WORK/FUGUE_CC_CLAUDE unset - skip provider restart (set them and re-run)\\n');",
    "  for (const project of projects) {",
    "    if (apply) process.stdout.write('  stopped provider daemon @ ' + project + ' - next cd starts it and loads new code\\n');",
    "    else process.stdout.write('  [dry] need to restart provider daemon @ ' + project + ' (provider update does not auto-restart, old code keeps running)\\n');",
    "  }",
    "  if (apply && work && fs.existsSync(path.join(work, '.fugue-cc/provider.config'))) process.stdout.write('  config validation (legacy CLI + sound):\\n    config OK\\n');",
    "  if (apply) {",
    "    fs.mkdirSync(state, { recursive: true });",
    "    fs.writeFileSync(stamp, current + '\\n');",
    "    process.stdout.write('  recorded ' + current + ' -> ' + stamp + '\\n');",
    "  } else {",
    "    process.stdout.write('  [dry] stamp not written; add --apply to commit\\n');",
    "  }",
    "} else {",
    "  die('unknown runtime command ' + sub);",
    "}",
    "",
  ].join("\n"),
);

const fakeProvider = join(tmp, "fugue-cc");
writeFileSync(
  fakeProvider,
  [
    "#!/usr/bin/env node",
    "if (process.argv[2] === 'version') {",
    "  console.log('fugue-cc runtime v9.9.9 abc 2026-01-01');",
    `  console.log('Install path: ${join(tmp, "install")}');`,
    "}",
    "",
  ].join("\n"),
  { mode: 0o755 },
);

process.env.FUGUE_CC_BIN = fakeProvider;
process.env.FUGUNANO_STATE = join(tmp, "state");
process.env.FUGUE_CC_INSTALL = join(tmp, "install");
delete process.env.FUGUE_CC_WORK;
delete process.env.FUGUE_CC_CLAUDE;

const graft = join(tmp, "install", "lib", "provider_profiles");
mkdirSync(graft, { recursive: true });
writeFileSync(join(graft, "api_shortcuts.py"), "");

const out = run(runtime, ["check"]).stdout;
suite.ok("check reports version drift (none → v9.9.9)", () =>
  out.includes("version drift"),
);
suite.ok("help lists strict workflow drift gate", () =>
  run(runtime, ["--help"]).stdout.includes("check [--strict]"),
);
suite.ok("help lists alias workflow skill option", () =>
  run(runtime, ["--help"]).stdout.includes("--alias-skill"),
);
suite.ok("check: grafting api_shortcuts.py present", () =>
  out.includes("grafting api_shortcuts.py present"),
);
const top = run(fuguectl, ["runtime", "check"]).stdout;
suite.ok("runtime entrypoint suggests fuguectl runtime adapt", () =>
  top.includes("fuguectl runtime adapt --apply"),
);

run(runtime, ["adapt"]);
suite.ok(
  "dry-run does not write stamp",
  () => !existsSync(join(process.env.FUGUNANO_STATE, "runtime-version")),
);

run(runtime, ["adapt", "--apply"]);
suite.ok("apply writes stamp=current version", () =>
  readFileSync(
    join(process.env.FUGUNANO_STATE, "runtime-version"),
    "utf8",
  ).includes("v9.9.9"),
);

const out2 = run(runtime, ["check"]).stdout;
suite.ok("after apply check shows no drift", () => out2.includes("no drift"));

rmSync(join(graft, "api_shortcuts.py"));
const out3 = run(runtime, ["check"]).stdout;
suite.ok("missing grafting is detected", () =>
  out3.includes("api_shortcuts.py is gone"),
);

writeFileSync(join(graft, "api_shortcuts.py"), "");
const work = join(tmp, "work");
mkdirSync(join(work, ".fugue-cc"), { recursive: true });
writeFileSync(
  join(work, ".fugue-cc", "provider.config"),
  '[agents.cc-deepseek]\nmodel = "deepseek-v4-pro"\n',
);
process.env.FUGUE_CC_WORK = work;
const out4 = run(runtime, ["adapt", "--apply"]).stdout;
suite.ok("adapt with FUGUE_CC_WORK runs config validation", () =>
  out4.includes("config validation"),
);
suite.ok("adapt with FUGUE_CC_WORK still records stamp", () =>
  readFileSync(
    join(process.env.FUGUNANO_STATE, "runtime-version"),
    "utf8",
  ).includes("v9.9.9"),
);

suite.ok(
  "unknown subcommand → nonzero",
  () => run(runtime, ["nope"]).status !== 0,
);
suite.ok("wrapper delegates to engine CLI", () =>
  readFileSync(calls, "utf8").includes("runtime check\n"),
);

run(runtime, [
  "check",
  "--strict",
  "--skill",
  join(tmp, "installed", "SKILL.md"),
  "--alias-skill",
  join(tmp, "legacy", "SKILL.md"),
  "--repo-skill",
  join(tmp, "repo", "SKILL.md"),
]);
suite.ok("wrapper forwards workflow skill options", () =>
  readFileSync(calls, "utf8").includes(
    `runtime check --strict --skill ${join(tmp, "installed", "SKILL.md")} --alias-skill ${join(tmp, "legacy", "SKILL.md")} --repo-skill ${join(tmp, "repo", "SKILL.md")}\n`,
  ),
);

suite.done();
