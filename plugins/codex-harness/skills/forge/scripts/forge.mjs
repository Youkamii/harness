#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../../../runtime/cli.js");
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  process.stderr.write(`codex-harness failed to start: ${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);

