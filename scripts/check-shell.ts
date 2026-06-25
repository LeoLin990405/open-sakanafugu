#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(
  dirname(process.argv[1] ?? "scripts/check-shell.ts"),
  "..",
);

const collect = (dir, predicate) => {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(abs, predicate));
    else if (entry.isFile() && predicate(abs)) out.push(relative(root, abs));
  }
  return out;
};

const explicit = [
  ...collect(join(root, "backends", "bin"), (file) => /-code$/u.test(file)),
  "backends/bin/cc-models",
  "backends/bin/cc-sync",
  "orchestration/fuguectl/fuguectl",
].filter((file) => existsSync(join(root, file)));

const scripts = [
  ...explicit,
  ...collect(join(root, "backends"), (file) => file.endsWith(".sh")),
  ...collect(join(root, "scripts"), (file) => file.endsWith(".sh")),
  ...collect(join(root, "orchestration"), (file) => file.endsWith(".sh")),
].sort();

const uniqueScripts = [...new Set(scripts)];
let failed = false;
const shellScripts = [];
const nodeScripts = [];

for (const script of uniqueScripts) {
  const text = readFileSync(join(root, script), "utf8");
  const firstLine = text.split(/\r?\n/u, 1)[0] ?? "";
  if (firstLine.includes("node")) nodeScripts.push(script);
  else shellScripts.push(script);
}

console.log(`── syntax (${String(uniqueScripts.length)} scripts) ──`);
for (const script of shellScripts) {
  const result = spawnSync("bash", ["-n", script], {
    cwd: root,
    stdio: "ignore",
  });
  if (result.status !== 0) {
    console.log(`  ✗ syntax: ${script}`);
    failed = true;
  }
}
for (const script of nodeScripts) {
  const result = spawnSync(process.execPath, ["--check", script], {
    cwd: root,
    stdio: "ignore",
  });
  if (result.status !== 0) {
    console.log(`  ✗ node syntax: ${script}`);
    failed = true;
  }
}
if (!failed) console.log("  ✓ all pass");

const shellcheckProbe = spawnSync("shellcheck", ["--version"], {
  cwd: root,
  stdio: "ignore",
});
if (shellcheckProbe.status === 0) {
  console.log("── shellcheck -S warning (via .shellcheckrc) ──");
  const result = spawnSync("shellcheck", ["-S", "warning", ...shellScripts], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status === 0) console.log("  ✓ 0 warnings");
  else {
    console.log("  ✗ shellcheck has findings");
    failed = true;
  }
} else {
  console.log("── shellcheck not installed, skipping (CI will run it) ──");
}

process.exit(failed ? 1 : 0);
