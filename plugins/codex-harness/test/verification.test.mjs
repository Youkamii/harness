import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareTaskWorktree } from "../runtime/git.js";
import { resolveCodexExecutable } from "../runtime/executables.js";
import {
  applyPlan,
  setTaskIssue,
  setTaskStatus,
  transitionRun,
} from "../runtime/operations.js";
import { discoverRepo } from "../runtime/repo.js";
import { RunStore } from "../runtime/store.js";
import { verifyTask } from "../runtime/verification.js";

let hasCodex = true;
try {
  await resolveCodexExecutable();
} catch {
  hasCodex = false;
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  assert.equal(result.status, 0, result.stderr);
}

async function withTask(checks, callback) {
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
    state = await setTaskStatus(store, state.id, "safe-check", "verifying");
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
    const loaded = await store.load(state.id);
    assert.match(loaded.evidence.at(-1).summary, /evidence rejected/);
  });
});
