import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import path from "node:path";

const cli = path.resolve("plugins/codex-harness/runtime/cli.js");

test("CLI reports its version", () => {
  const result = spawnSync(process.execPath, [cli, "--version"], {
    encoding: "utf8",
    shell: false,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "0.1.0");
});

test("CLI prints help without a command", () => {
  const result = spawnSync(process.execPath, [cli], {
    encoding: "utf8",
    shell: false,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: codex-harness/);
});

