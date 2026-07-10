#!/usr/bin/env node

const VERSION = "0.1.0";
const args = process.argv.slice(2);

if (args.includes("--version") || args[0] === "version") {
  process.stdout.write(VERSION + "\n");
  process.exit(0);
}

process.stdout.write(
  [
    "Codex Harness",
    "",
    "Usage: codex-harness <command> [options]",
    "",
    "Commands are added by the tracked implementation issues.",
  ].join("\n") + "\n",
);

