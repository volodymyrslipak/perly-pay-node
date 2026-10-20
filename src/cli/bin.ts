#!/usr/bin/env node
/** `npx perly-pay …` lands here. */
import { main, nodeIO } from "./main.js";

main({ argv: process.argv.slice(2), cwd: process.cwd(), io: nodeIO() }).then(
  // exitCode, not exit(): on macOS a piped stdout is written asynchronously, and exit() would cut it short.
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`perly-pay: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  },
);
