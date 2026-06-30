#!/usr/bin/env python3
"""Prepare one SWE-bench instance in a target repo worktree (harness-free core).

Usage:
  prepare_instance.py <dataset.jsonl> <instance_id> <repo_dir>

Does:
  1. checkout the instance's base_commit in <repo_dir> (must be the right repo, already cloned)
  2. apply the instance's test_patch (brings the repo to the post-PR test state)
  3. report the FAIL_TO_PASS set

NOTE: assumes the repo's test environment is already runnable in <repo_dir>
(install deps yourself, or use the official swebench harness for full fidelity).
All subprocess calls use argv lists (no shell=True) — dataset fields are data.
"""
import json
import subprocess
import sys
from pathlib import Path


def sh(argv, cwd, check=True):
    return subprocess.run(argv, cwd=str(cwd), check=check, capture_output=True, text=True)


def find_instance(dataset_path, instance_id):
    with open(dataset_path) as fh:
        for line in fh:
            rec = json.loads(line)
            if rec["instance_id"] == instance_id:
                return rec
    raise SystemExit(f"instance {instance_id} not in {dataset_path}")


def main():
    dataset_path, instance_id, repo = sys.argv[1], sys.argv[2], Path(sys.argv[3])
    rec = find_instance(dataset_path, instance_id)
    print(f"repo={rec['repo']} base={rec['base_commit'][:10]}")

    sh(["git", "checkout", "-q", rec["base_commit"]], repo)
    sh(["git", "clean", "-fdq"], repo)
    # apply the test patch (the tests added/changed by the gold PR)
    tp = repo / "_swebench_test.patch"
    tp.write_text(rec["test_patch"])
    applied = sh(["git", "apply", "--whitespace=nowarn", "_swebench_test.patch"], repo, check=False)
    if applied.returncode != 0:
        applied = sh(["git", "apply", "--3way", "--whitespace=nowarn", "_swebench_test.patch"], repo, check=False)
    tp.unlink(missing_ok=True)
    # If the gold test patch never applied, the instance is NOT ready — bailing
    # out here prevents the solver/eval from running against a repo with no gold
    # tests and reporting a silently wrong SWE-bench verdict.
    if applied.returncode != 0:
        print(json.dumps({
            "instance_id": instance_id,
            "ready": False,
            "error": "failed to apply gold test_patch (normal and --3way)",
            "stderr": applied.stderr[-2000:],
        }, indent=2))
        sys.exit(1)

    fail_to_pass = json.loads(rec["FAIL_TO_PASS"])
    pass_to_pass = json.loads(rec.get("PASS_TO_PASS", "[]"))
    print(json.dumps({
        "instance_id": instance_id,
        "FAIL_TO_PASS": fail_to_pass,
        "PASS_TO_PASS_count": len(pass_to_pass),
        "ready": True,
    }, indent=2))


if __name__ == "__main__":
    main()
