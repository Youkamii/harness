import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { currentConfigHash } from "../runtime/domain.js";
import { commitTask, prepareTaskWorktree } from "../runtime/git.js";
import { assertSafeGitConfiguration } from "../runtime/git-policy.js";
import { assertIntegrationState, integrateRun } from "../runtime/integration.js";
import {
  addEvidence,
  applyPlan,
  resetTaskForRetry,
  setTaskIssue,
  setTaskStatus,
  transitionRun,
} from "../runtime/operations.js";
import { discoverRepo, workspaceFingerprint } from "../runtime/repo.js";
import { RunStore } from "../runtime/store.js";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(callback) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-harness-git-"));
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

test("controller prepares an issue branch and commits only owned paths", async () => {
  await fixture(async (repo) => {
    const context = await discoverRepo(repo);
    const store = new RunStore(context.stateRoot);
    let state = await store.create({
      goal: "add a feature",
      lane: "build",
      repoRoot: context.root,
      gitCommonDir: context.gitCommonDir,
    });
    state = await applyPlan(store, state.id, [
      {
        id: "feature",
        title: "Add feature",
        dependencies: [],
        acceptanceCriteria: ["AC1"],
        ownedPaths: ["feature.txt"],
        checks: [{ argv: ["node", "--version"], required: true }],
        risk: "low",
      },
    ]);
    state = await setTaskIssue(store, state.id, "feature", {
      number: 42,
      url: "https://github.com/example/repo/issues/42",
      marker: "<!-- marker -->",
      syncedAt: new Date().toISOString(),
      state: "open",
    });
    state = await transitionRun(store, state.id, "issue_sync");
    state = await transitionRun(store, state.id, "executing");
    state = await prepareTaskWorktree(store, state.id, "feature");
    const task = state.tasks[0];
    assert.equal(task.status, "running");
    assert.match(task.branch, /^forge\/42-feature$/);
    assert.ok(task.worktreePath);

    await writeFile(path.join(task.worktreePath, "feature.txt"), "done\n", "utf8");
    state = await setTaskStatus(store, state.id, "feature", "verifying");
    const treeHash = await workspaceFingerprint(task.worktreePath);
    const configHash = currentConfigHash(state);
    state = await addEvidence(store, state.id, {
      kind: "acceptance",
      status: "pass",
      treeHash,
      configHash,
      taskId: "feature",
      criterionId: "AC1",
      summary: "feature exists",
    });
    state = await addEvidence(store, state.id, {
      kind: "verification",
      status: "pass",
      treeHash,
      configHash,
      taskId: "feature",
      command: { argv: ["node", "--version"], required: true },
      exitCode: 0,
      summary: "node check passed",
    });

    state = await commitTask(store, state.id, "feature", "feat: add feature");
    assert.equal(state.tasks[0].status, "committed");
    assert.match(state.tasks[0].commitSha, /^[0-9a-f]{40}$/);
    const body = git(task.worktreePath, "log", "-1", "--format=%B");
    assert.match(body, /Refs #42/);
    assert.match(body, new RegExp(`Harness-Run: ${state.id}`));
    assert.match(body, /Harness-Task: feature/);
    assert.equal(git(repo, "status", "--porcelain"), "");
  });
});

test("commit refuses changes outside task ownership", async () => {
  await fixture(async (repo) => {
    const context = await discoverRepo(repo);
    const store = new RunStore(context.stateRoot);
    let state = await store.create({
      goal: "stay scoped",
      lane: "build",
      repoRoot: context.root,
      gitCommonDir: context.gitCommonDir,
    });
    state = await applyPlan(store, state.id, [
      {
        id: "owned",
        title: "Owned",
        dependencies: [],
        acceptanceCriteria: ["AC1"],
        ownedPaths: ["owned.txt"],
        checks: [{ argv: ["node", "--version"] }],
        risk: "low",
      },
    ]);
    state = await setTaskIssue(store, state.id, "owned", {
      number: 7,
      url: "https://github.com/example/repo/issues/7",
      marker: "<!-- marker -->",
      syncedAt: new Date().toISOString(),
      state: "open",
    });
    state = await transitionRun(store, state.id, "issue_sync");
    state = await transitionRun(store, state.id, "executing");
    state = await prepareTaskWorktree(store, state.id, "owned");
    const task = state.tasks[0];
    await writeFile(path.join(task.worktreePath, "owned.txt"), "owned\n", "utf8");
    await writeFile(path.join(task.worktreePath, ".env"), "TOKEN=should-not-stage\n", "utf8");
    state = await setTaskStatus(store, state.id, "owned", "verifying");
    const treeHash = await workspaceFingerprint(task.worktreePath);
    const configHash = currentConfigHash(state);
    await addEvidence(store, state.id, {
      kind: "acceptance",
      status: "pass",
      treeHash,
      configHash,
      taskId: "owned",
      criterionId: "AC1",
    });
    await addEvidence(store, state.id, {
      kind: "verification",
      status: "pass",
      treeHash,
      configHash,
      taskId: "owned",
      command: { argv: ["node", "--version"] },
      exitCode: 0,
    });
    await assert.rejects(
      () => commitTask(store, state.id, "owned", "feat: owned"),
      /unowned paths: \.env/,
    );
    assert.equal(git(task.worktreePath, "status", "--porcelain").includes(".env"), true);
  });
});

test("integration replays every retry commit and is idempotent", async () => {
  await fixture(async (repo) => {
    const context = await discoverRepo(repo);
    const store = new RunStore(context.stateRoot);
    let state = await store.create({
      goal: "integrate fixes",
      lane: "deep",
      repoRoot: context.root,
      gitCommonDir: context.gitCommonDir,
    });
    state = await applyPlan(store, state.id, [{
      id: "retry-feature",
      title: "Retry feature",
      dependencies: [],
      acceptanceCriteria: ["AC1"],
      ownedPaths: ["feature.txt"],
      checks: [{ argv: ["node", "--version"] }],
      risk: "medium",
    }]);
    state = await setTaskIssue(store, state.id, "retry-feature", {
      number: 9,
      url: "https://github.com/example/repo/issues/9",
      marker: "<!-- marker -->",
      syncedAt: new Date().toISOString(),
      state: "open",
    });
    state = await transitionRun(store, state.id, "issue_sync");
    state = await transitionRun(store, state.id, "executing");
    state = await prepareTaskWorktree(store, state.id, "retry-feature");

    const recordVerification = async () => {
      state = await setTaskStatus(store, state.id, "retry-feature", "verifying");
      const current = state.tasks[0];
      const treeHash = await workspaceFingerprint(current.worktreePath);
      state = await addEvidence(store, state.id, {
        kind: "verification",
        status: "pass",
        treeHash,
        configHash: currentConfigHash(state),
        taskId: "retry-feature",
        command: { argv: ["node", "--version"] },
        exitCode: 0,
      });
      state = await commitTask(store, state.id, "retry-feature", "feat: retry feature");
    };

    await writeFile(path.join(state.tasks[0].worktreePath, "feature.txt"), "first\n", "utf8");
    await recordVerification();
    state = await setTaskStatus(store, state.id, "retry-feature", "failed");
    state = await resetTaskForRetry(store, state.id, "retry-feature", "review found a defect");
    state = await prepareTaskWorktree(store, state.id, "retry-feature");
    await writeFile(path.join(state.tasks[0].worktreePath, "feature.txt"), "first\nsecond\n", "utf8");
    await recordVerification();
    state = await setTaskStatus(store, state.id, "retry-feature", "reviewed");
    state = await setTaskStatus(store, state.id, "retry-feature", "complete");

    state = await integrateRun(store, state.id);
    assert.equal((await (await import("node:fs/promises")).readFile(path.join(state.integrationWorktreePath, "feature.txt"), "utf8")).replaceAll("\r\n", "\n"), "first\nsecond\n");
    assert.equal(git(state.integrationWorktreePath, "log", "--format=%B", "--grep", "Harness-Task: retry-feature", "--fixed-strings").match(/Harness-Task: retry-feature/g)?.length, 2);
    const replayed = await integrateRun(store, state.id);
    assert.equal(replayed.integrationSha, state.integrationSha);
    await writeFile(path.join(state.integrationWorktreePath, "feature.txt"), "uncommitted\n", "utf8");
    await assert.rejects(() => assertIntegrationState(state), /uncommitted changes/);
  });
});

test("dependent task worktree includes prerequisite commits", async () => {
  await fixture(async (repo) => {
    const context = await discoverRepo(repo);
    const store = new RunStore(context.stateRoot);
    let state = await store.create({
      goal: "build dependency chain",
      lane: "deep",
      repoRoot: context.root,
      gitCommonDir: context.gitCommonDir,
    });
    state = await applyPlan(store, state.id, [
      {
        id: "provider",
        title: "Provider",
        dependencies: [],
        acceptanceCriteria: ["provider exists"],
        ownedPaths: ["provider.txt"],
        checks: [{ argv: ["node", "--version"] }],
        risk: "medium",
      },
      {
        id: "consumer",
        title: "Consumer",
        dependencies: ["provider"],
        acceptanceCriteria: ["consumer sees provider"],
        ownedPaths: ["consumer.txt"],
        checks: [{ argv: ["node", "--version"] }],
        risk: "medium",
      },
    ]);
    for (const [taskId, number] of [["provider", 10], ["consumer", 11]]) {
      state = await setTaskIssue(store, state.id, taskId, {
        number,
        url: `https://github.com/example/repo/issues/${number}`,
        marker: `<!-- ${taskId} -->`,
        syncedAt: new Date().toISOString(),
        state: "open",
      });
    }
    state = await transitionRun(store, state.id, "issue_sync");
    state = await transitionRun(store, state.id, "executing");
    state = await prepareTaskWorktree(store, state.id, "provider");
    await writeFile(path.join(state.tasks[0].worktreePath, "provider.txt"), "provider-api\n", "utf8");
    state = await setTaskStatus(store, state.id, "provider", "verifying");
    let treeHash = await workspaceFingerprint(state.tasks[0].worktreePath);
    state = await addEvidence(store, state.id, {
      kind: "verification",
      status: "pass",
      treeHash,
      configHash: currentConfigHash(state),
      taskId: "provider",
      command: { argv: ["node", "--version"] },
      exitCode: 0,
    });
    state = await commitTask(store, state.id, "provider", "feat: provider");
    state = await setTaskStatus(store, state.id, "provider", "reviewed");
    state = await setTaskStatus(store, state.id, "provider", "complete");

    state = await prepareTaskWorktree(store, state.id, "consumer");
    const consumer = state.tasks.find((task) => task.id === "consumer");
    const provider = state.tasks.find((task) => task.id === "provider");
    assert.equal((await (await import("node:fs/promises")).readFile(path.join(consumer.worktreePath, "provider.txt"), "utf8")).replaceAll("\r\n", "\n"), "provider-api\n");
    assert.notEqual(consumer.baseSha, state.baseSha);
    assert.ok(provider.commitSha);
  });
});

test("controller rejects external Git filter drivers", async () => {
  await fixture(async (repo) => {
    git(repo, "config", "filter.exfil.clean", "node steal-secrets.js");
    await writeFile(path.join(repo, ".gitattributes"), "*.secret filter=exfil\n", "utf8");
    await assert.rejects(
      () => assertSafeGitConfiguration(repo, ["payload.secret"]),
      /external Git clean\/smudge\/process filters/,
    );
  });
});
