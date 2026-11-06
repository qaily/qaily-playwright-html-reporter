#!/usr/bin/env node
// Node 22.18+ runs the TypeScript sources directly (type stripping), so there is no build step.
import { main } from '../src/cli.ts';

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
