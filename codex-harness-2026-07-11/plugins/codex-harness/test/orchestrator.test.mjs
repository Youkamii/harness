import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { currentConfigHash } from "../runtime/domain.js";
import { applyPlan, beginRemediation, reopenTaskForRemediation } from "../runtime/operations.js";
import { executePendingRemediation, resumeAutonomously, runAutonomously } from "../runtime/orchestrator.js";
import { discoverRepo, workspaceFingerprint } from "../runtime/repo.js";
import { RunStore } from "../runtime/store.js";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(callback) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-harness-orchestrator-"));
  const repo = path.join(temporary, "repo");
  await mkdir(repo);
  try {
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "Harness Test");
    git(repo, "config", "user.email", "harness@example.test");
    await writeFile(path.join(repo, "README.md"), "fixture\n", "utf8");
    git(repo, "add", "--", "README.md");
    git(repo, "commit", "-m", "fixture");
    await callback(repo);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function readyAtGate(repo, blocked) {
  const context = await discoverRepo(repo);
  const store = new RunStore(context.stateRoot);
  let state = await store.create({
    goal: "finish from durable evidence",
    lane: "build",
    repoRoot: context.root,
    gitCommonDir: context.gitCommonDir,
  });
  state = await applyPlan(store, state.id, [{
    id: "feature",
    title: "Feature",
    dependencies: [],
    acceptanceCriteria: ["AC1"],
    ownedPaths: ["README.md"],
    checks: [{ argv: ["node", "--version"] }],
    risk: "low",
  }]);
  const treeHash = await workspaceFingerprint(repo);
  const configHash = currentConfigHash(state);
  const sha = git(repo, "rev-parse", "HEAD");
  state = await store.update(state.id, "test.gate-ready", (current) => {
    current.status = blocked ? "blocked" : "integrating";
    if (blocked) {
      current.blockedFrom = "integrating";
      current.blockedReason = "temporary environment failure";
    }
    current.baseSha = sha;
    current.integrationBranch = "forge/run-test";
    current.integrationWorktreePath = repo;
    current.integrationSha = sha;
    current.tasks[0].status = "complete";
    current.tasks[0].attempts = 1;
    current.tasks[0].baseSha = sha;
    current.tasks[0].commitSha = sha;
    current.tasks[0].issue = {
      number: 1,
      url: "https://github.com/example/repo/issues/1",
      marker: "marker",
      syncedAt: new Date().toISOString(),
      state: "open",
    };
    current.evidence = [
      { id: "v", kind: "verification", status: "pass", treeHash, configHash, recordedAt: "now", taskId: "feature", command: { argv: ["node", "--version"] }, exitCode: 0 },
      { id: "a", kind: "acceptance", status: "pass", treeHash, configHash, recordedAt: "now", taskId: "feature", criterionId: "AC1" },
      { id: "c", kind: "commit", status: "pass", treeHash, configHash, recordedAt: "now", taskId: "feature" },
      { id: "r1", kind: "review", status: "approved", treeHash, configHash, recordedAt: "now", taskId: "feature", reviewer: "acceptance-auditor", findings: [] },
      { id: "r2", kind: "review", status: "approved", treeHash, configHash, recordedAt: "now", taskId: "feature", reviewer: "adversarial-reviewer", findings: [] },
    ];
    return current;
  }, {});
  return { store, state };
}

test("autonomous controller completes only from current-tree evidence", async () => {
  await fixture(async (repo) => {
    const { store, state } = await readyAtGate(repo, false);
    const completed = await runAutonomously(store, state.id);
    assert.equal(completed.status, "complete");
  });
});

test("resume re-enters the recorded blocked stage", async () => {
  await fixture(async (repo) => {
    const { store, state } = await readyAtGate(repo, true);
    const completed = await resumeAutonomously(store, state.id);
    assert.equal(completed.status, "complete");
    assert.equal(completed.blockedReason, undefined);
  });
});

test("a partially applied remediation intent replays idempotently after a crash", async () => {
  await fixture(async (repo) => {
    const context = await discoverRepo(repo);
    const store = new RunStore(context.stateRoot);
    let state = await store.create({
      goal: "replay interrupted remediation",
      lane: "build",
      repoRoot: context.root,
      gitCommonDir: context.gitCommonDir,
    });
    state = await applyPlan(store, state.id, [
      {
        id: "foundation",
        title: "Foundation",
        dependencies: [],
        acceptanceCriteria: ["foundation works"],
        ownedPaths: ["README.md"],
        checks: [{ argv: ["node", "--version"] }],
        risk: "low",
      },
      {
        id: "consumer",
        title: "Consumer",
        dependencies: ["foundation"],
        acceptanceCriteria: ["consumer works"],
        ownedPaths: ["docs/**"],
        checks: [{ argv: ["node", "--version"] }],
        risk: "low",
      },
    ]);
    state = await store.update(state.id, "test.remediation-ready", (current) => {
      current.status = "integrating";
      for (const [index, task] of current.tasks.entries()) {
        task.status = "complete";
        task.attempts = 1;
        task.commitSha = git(repo, "rev-parse", "HEAD");
        task.issue = {
          number: index + 1,
          url: `https://github.com/example/repo/issues/${index + 1}`,
          marker: `marker-${index + 1}`,
          syncedAt: new Date().toISOString(),
          state: "open",
        };
      }
      return current;
    }, {});

    await beginRemediation(store, state.id, "foundation", "integrated verification failed");
    await reopenTaskForRemediation(store, state.id, "foundation", "integrated verification failed");

    const replayed = await executePendingRemediation(store, state.id);
    assert.equal(replayed.status, "executing");
    assert.equal(replayed.remediation, undefined);
    assert.equal(replayed.tasks.find((task) => task.id === "foundation").status, "ready");
    assert.equal(replayed.tasks.find((task) => task.id === "consumer").status, "pending");
  });
});
