import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { prepareTaskWorktree } from "../runtime/git.js";
import { resolveCodexExecutable } from "../runtime/executables.js";
import {
  applyPlan,
  setTaskIssue,
  setTaskStatus,
  transitionRun,
} from "../runtime/operations.js";
import { discoverRepo } from "../runtime/repo.js";
import { runProcess } from "../runtime/process.js";
import { RunStore } from "../runtime/store.js";
import { captureBaseline, verifyTask } from "../runtime/verification.js";

let hasCodex = true;
try {
  await resolveCodexExecutable();
} catch {
  hasCodex = false;
}

if (process.env.CI) {
  test("CI provides a resolvable native Codex sandbox binary", () => {
    assert.equal(hasCodex, true, "CI must install Codex so sandbox integration tests cannot skip");
  });
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  assert.equal(result.status, 0, result.stderr);
}

async function withTask(checks, callback, { transitionToVerifying = true } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-harness-verify-"));
  const repo = path.join(temporary, "repo");
  await mkdir(repo);
  try {
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "Harness Test");
    git(repo, "config", "user.email", "harness@example.test");
    await writeFile(path.join(repo, "README.md"), "fixture\n", "utf8");
    git(repo, "add", "--", "README.md");
    git(repo, "commit", "-m", "fixture");
    const context = await discoverRepo(repo);
    const store = new RunStore(context.stateRoot);
    let state = await store.create({
      goal: "verify safely",
      lane: "deep",
      repoRoot: context.root,
      gitCommonDir: context.gitCommonDir,
    });
    state = await applyPlan(store, state.id, [{
      id: "safe-check",
      title: "Safe check",
      dependencies: [],
      acceptanceCriteria: ["Checks are isolated"],
      ownedPaths: ["result.txt"],
      checks,
      risk: "high",
    }]);
    state = await setTaskIssue(store, state.id, "safe-check", {
      number: 1,
      url: "https://github.com/example/repo/issues/1",
      marker: "<!-- marker -->",
      syncedAt: new Date().toISOString(),
      state: "open",
    });
    state = await transitionRun(store, state.id, "issue_sync");
    state = await transitionRun(store, state.id, "executing");
    state = await prepareTaskWorktree(store, state.id, "safe-check");
    if (transitionToVerifying) {
      state = await setTaskStatus(store, state.id, "safe-check", "verifying");
    }
    await callback(store, state);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test("verification sandbox strips credentials and disables network", { skip: !hasCodex }, async () => {
  const oldToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  try {
    await withTask([
      {
        argv: ["node", "-e", "process.exit(process.env.GH_TOKEN ? 9 : 0)"],
        required: true,
      },
      {
        argv: ["node", "-e", "fetch('https://example.com').then(()=>process.exit(8)).catch(()=>process.exit(0))"],
        timeoutMs: 30_000,
        required: true,
      },
    ], async (store, state) => {
      const result = await verifyTask(store, state.id, "safe-check");
      assert.equal(result.passed, true);
      assert.deepEqual(result.results.map((entry) => entry.exitCode), [0, 0]);
    });
  } finally {
    if (oldToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = oldToken;
  }
});

test("verification rejects a passing command that mutates tracked scope", { skip: !hasCodex }, async () => {
  await withTask([
    {
      argv: ["node", "-e", "require('fs').writeFileSync('mutated.txt','unexpected')"],
      required: true,
    },
  ], async (store, state) => {
    const result = await verifyTask(store, state.id, "safe-check");
    assert.equal(result.passed, false);
    assert.equal(result.results[0].exitCode, -2);
    assert.equal(result.results[0].mutated, true);
    const loaded = await store.load(state.id);
    assert.match(loaded.evidence.at(-1).summary, /evidence rejected/);
  });
});

test("baseline reports repository mutation to its caller", { skip: !hasCodex }, async () => {
  await withTask([
    {
      argv: ["node", "-e", "require('fs').writeFileSync('baseline-mutation.txt','unexpected')"],
      required: true,
    },
  ], async (store, state) => {
    const results = await captureBaseline(store, state.id, "safe-check");
    assert.equal(results[0].mutated, true);
    assert.equal(results[0].exitCode, -2);
  }, { transitionToVerifying: false });
});

test("verification rejects a symlink or junction cwd escape before spawning", { skip: !hasCodex }, async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "codex-harness-outside-"));
  try {
    await withTask([
      {
        argv: ["node", "-e", "process.exit(0)"],
        cwd: "escape",
        required: true,
      },
    ], async (store, state) => {
      const worktree = state.tasks[0].worktreePath;
      assert.ok(worktree);
      await symlink(outside, path.join(worktree, "escape"), process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(
        verifyTask(store, state.id, "safe-check"),
        /path escapes repository/,
      );
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("verification rejects a relative executable that resolves outside the worktree", { skip: !hasCodex }, async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "codex-harness-executable-outside-"));
  const executableName = process.platform === "win32" ? "outside.cmd" : "outside";
  try {
    await writeFile(path.join(outside, executableName), "must not execute\n", "utf8");
    await withTask([
      {
        argv: [`escape/${executableName}`],
        required: true,
      },
    ], async (store, state) => {
      const worktree = state.tasks[0].worktreePath;
      assert.ok(worktree);
      await symlink(outside, path.join(worktree, "escape"), process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(
        verifyTask(store, state.id, "safe-check"),
        /path escapes repository/,
      );
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("output-limit termination kills descendant processes and settles once", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-harness-process-"));
  const marker = path.join(temporary, "descendant-survived.txt");
  const childCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 700); setInterval(() => {}, 1000);`;
  const parentCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' }); process.stdout.write('x'.repeat(128 * 1024)); setInterval(() => {}, 1000);`;
  try {
    await assert.rejects(
      runProcess({
        executable: process.execPath,
        args: ["-e", parentCode],
        cwd: temporary,
        timeoutMs: 5_000,
        maxOutputBytes: 1_024,
      }),
      /process output exceeded 1024 bytes/,
    );
    await delay(1_000);
    await assert.rejects(access(marker));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("timeout termination kills descendant processes", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-harness-timeout-"));
  const marker = path.join(temporary, "timeout-descendant-survived.txt");
  const childCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 700); setInterval(() => {}, 1000);`;
  const parentCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;
  try {
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", parentCode],
      cwd: temporary,
      timeoutMs: 250,
      maxOutputBytes: 1_024,
    });
    assert.equal(result.timedOut, true);
    await delay(1_000);
    await assert.rejects(access(marker));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
