import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("Windows npm-prefix installs resolve the native Codex binary", { skip: process.platform !== "win32" }, async () => {
  const prefix = await mkdtemp(path.join(os.tmpdir(), "codex-harness-npm-prefix-"));
  try {
    const triple = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    const packageName = process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
    const binary = path.join(
      prefix,
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      packageName,
      "vendor",
      triple,
      "bin",
      "codex.exe",
    );
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(binary, "fixture", "utf8");
    await writeFile(path.join(prefix, "codex.cmd"), "@echo off\r\nnode missing-wrapper.js %*\r\n", "utf8");

    const moduleUrl = pathToFileURL(path.resolve("plugins/codex-harness/runtime/executables.js")).href;
    const script = `import { resolveCodexExecutable } from ${JSON.stringify(moduleUrl)}; process.stdout.write(await resolveCodexExecutable());`;
    const env = { ...process.env, PATH: `${prefix}${path.delimiter}${process.env.PATH ?? ""}`, APPDATA: prefix };
    delete env.CODEX_HARNESS_CODEX_BINARY;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
      shell: false,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await realpath(result.stdout), await realpath(binary));
  } finally {
    await rm(prefix, { recursive: true, force: true });
  }
});
