#!/usr/bin/env node
import { buildCli } from './cli.js';

const ignoreEpipe = (error: unknown): void => {
  if (error instanceof Error && 'code' in error && error.code === 'EPIPE') process.exit(0);
  throw error;
};

process.stdout.on('error', ignoreEpipe);
process.stderr.on('error', ignoreEpipe);

await buildCli().runExit(process.argv.slice(2));
