#!/usr/bin/env node
/**
 * fugue CLI entry.
 *
 * clipanion commands are wired capability-by-capability as the engine reaches
 * parity with the bash `fanout` (see docs/PARITY.md). Scaffold stage: no
 * commands yet.
 */
import { VERSION } from '../index.js';

function main(argv: readonly string[]): number {
  void argv;
  process.stdout.write(
    `fugue engine v${VERSION} (scaffold) — no commands wired yet; see docs/ARCHITECTURE.md\n`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
