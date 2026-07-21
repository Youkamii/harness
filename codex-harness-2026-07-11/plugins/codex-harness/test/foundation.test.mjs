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
  assert.match(result.stdout, /--mode standard\|tough/);
});

test("CLI route reports explicit tough mode and defaults to standard", () => {
  const tough = spawnSync(
    process.execPath,
    [cli, "route", "--goal", "add JSON output", "--mode", "tough"],
    { encoding: "utf8", shell: false },
  );
  assert.equal(tough.status, 0, tough.stderr);
  assert.deepEqual(JSON.parse(tough.stdout), { lane: "build", mode: "tough" });

  const standard = spawnSync(
    process.execPath,
    [cli, "route", "--goal", "add JSON output"],
    { encoding: "utf8", shell: false },
  );
  assert.equal(standard.status, 0, standard.stderr);
  assert.deepEqual(JSON.parse(standard.stdout), { lane: "build", mode: "standard" });
});

test("CLI rejects unknown run modes", () => {
  const result = spawnSync(
    process.execPath,
    [cli, "route", "--goal", "add JSON output", "--mode", "reckless"],
    { encoding: "utf8", shell: false },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid mode: reckless/);
});
