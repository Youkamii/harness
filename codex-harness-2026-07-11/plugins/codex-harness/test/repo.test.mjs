import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { workspaceFingerprint } from "../runtime/repo.js";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function withSubmodule(callback) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-harness-submodule-"));
  const child = path.join(temporary, "child");
  const parent = path.join(temporary, "parent");
  await mkdir(child);
  await mkdir(parent);
  try {
    for (const repo of [child, parent]) {
      git(repo, "init", "-b", "main");
      git(repo, "config", "user.name", "Harness Test");
      git(repo, "config", "user.email", "harness@example.test");
    }
    await writeFile(path.join(child, "tracked.txt"), "one\n", "utf8");
    git(child, "add", "--", "tracked.txt");
    git(child, "commit", "-m", "child fixture");
    git(parent, "-c", "protocol.file.allow=always", "submodule", "add", child, "dep");
    git(parent, "commit", "-am", "parent fixture");
    await callback({ child, parent, dep: path.join(parent, "dep") });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test("workspace fingerprint includes dirty and untracked submodule content", async () => {
  await withSubmodule(async ({ parent, dep }) => {
    const initial = await workspaceFingerprint(parent);
    await writeFile(path.join(dep, "tracked.txt"), "two\n", "utf8");
    const dirty = await workspaceFingerprint(parent);
    assert.notEqual(dirty, initial);
    await writeFile(path.join(dep, "untracked.txt"), "new\n", "utf8");
    const untracked = await workspaceFingerprint(parent);
    assert.notEqual(untracked, dirty);
  });
});

test("workspace fingerprint rejects submodule realpath cycles and escapes", async () => {
  await withSubmodule(async ({ child, parent, dep }) => {
    await rm(dep, { recursive: true, force: true });
    await symlink(parent, dep, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => workspaceFingerprint(parent), /submodule cycle detected/);

    await unlink(dep);
    await symlink(child, dep, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => workspaceFingerprint(parent), /path escapes repository/);
  });
});
