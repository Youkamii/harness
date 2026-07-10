import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = path.join(root, "plugins", "codex-harness", "test");
const tests = (await readdir(testRoot))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(testRoot, name));

if (tests.length === 0) throw new Error("no Codex harness tests were found");

const result = spawnSync(process.execPath, ["--test", ...tests], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  shell: false,
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
