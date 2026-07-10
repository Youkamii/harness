import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { currentConfigHash, type HarnessTask, type RunState } from "./domain.js";
import {
  beginEffect,
  completeEffect,
  recordTaskCommit,
  setTaskStatus,
  setTaskWorktree,
} from "./operations.js";
import { containsLikelySecret, boundedRemoteText } from "./redact.js";
import { runChecked, runProcess } from "./process.js";
import { workspaceFingerprint } from "./repo.js";
import { RunStore } from "./store.js";

export async function prepareTaskWorktree(
  store: RunStore,
  runId: string,
  taskId: string,
): Promise<RunState> {
  let state = await store.load(runId);
  if (state.status !== "executing") {
    throw new Error(`worktree preparation requires executing state, got ${state.status}`);
  }
  const task = requireTask(state, taskId);
  if (!task.issue?.number) throw new Error(`task ${taskId} has no GitHub issue`);
  if (task.worktreePath && task.branch) return state;
  if (task.status !== "ready") throw new Error(`task ${taskId} is not ready`);

  const branch = `forge/${task.issue.number}-${slug(task.id)}`;
  await runChecked({
    executable: "git",
    args: ["check-ref-format", "--branch", branch],
    cwd: state.repoRoot,
  });
  const baseSha = (
    await runChecked({
      executable: "git",
      args: ["rev-parse", "HEAD"],
      cwd: state.repoRoot,
    })
  ).stdout.trim();
  const worktreePath = path.resolve(
    path.dirname(state.repoRoot),
    `${path.basename(state.repoRoot)}.codex-harness-worktrees`,
    runId,
    task.id,
  );
  await mkdir(path.dirname(worktreePath), { recursive: true });

  const exists = await pathExists(worktreePath);
  if (!exists) {
    const branchExists = await runProcess({
      executable: "git",
      args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      cwd: state.repoRoot,
    });
    const args =
      branchExists.exitCode === 0
        ? ["worktree", "add", worktreePath, branch]
        : ["worktree", "add", "-b", branch, worktreePath, baseSha];
    await runChecked({ executable: "git", args, cwd: state.repoRoot, timeoutMs: 60_000 });
  } else {
    await runChecked({
      executable: "git",
      args: ["rev-parse", "--is-inside-work-tree"],
      cwd: worktreePath,
    });
    const actualBranch = (
      await runChecked({
        executable: "git",
        args: ["branch", "--show-current"],
        cwd: worktreePath,
      })
    ).stdout.trim();
    if (actualBranch !== branch) {
      throw new Error(`existing worktree uses ${actualBranch}, expected ${branch}`);
    }
  }

  state = await setTaskWorktree(store, runId, taskId, { branch, worktreePath, baseSha });
  return await setTaskStatus(store, runId, taskId, "running");
}

export async function commitTask(
  store: RunStore,
  runId: string,
  taskId: string,
  message: string,
): Promise<RunState> {
  let state = await store.load(runId);
  let task = requireTask(state, taskId);
  if (!task.worktreePath || !task.issue?.number) {
    throw new Error(`task ${taskId} has no prepared worktree or issue`);
  }

  const { effect } = await beginEffect(store, runId, {
    key: `commit:${taskId}`,
    kind: "git.commit",
  });
  state = await store.load(runId);
  task = requireTask(state, taskId);
  if (!task.worktreePath || !task.issue?.number) {
    throw new Error(`task ${taskId} lost its prepared worktree or issue`);
  }
  const worktreePath = task.worktreePath;
  const issueNumber = task.issue.number;
  if (task.commitSha) {
    if (effect.status !== "complete") {
      return await completeEffect(store, runId, effect.id, { commitSha: task.commitSha });
    }
    return state;
  }

  const existing = await findExistingCommit(worktreePath, runId, taskId);
  const treeHash = await workspaceFingerprint(worktreePath);
  const configHash = currentConfigHash(state);
  assertTaskCommitEvidence(state, task, treeHash, configHash);

  let commitSha = existing;
  if (!commitSha) {
    const changed = await changedPaths(worktreePath);
    const unexpected = changed.filter((candidate) => !isOwned(candidate, task.ownedPaths));
    if (unexpected.length > 0) {
      throw new Error(`task modified unowned paths: ${unexpected.join(", ")}`);
    }
    if (changed.length === 0) throw new Error(`task ${taskId} has no changes to commit`);

    await runChecked({
      executable: "git",
      args: ["add", "--", ...task.ownedPaths],
      cwd: worktreePath,
    });
    const staged = await stagedPaths(worktreePath);
    if (staged.length === 0) throw new Error("no task-owned changes were staged");
    const stagedUnexpected = staged.filter((candidate) => !isOwned(candidate, task.ownedPaths));
    if (stagedUnexpected.length > 0) {
      throw new Error(`staged paths exceed task ownership: ${stagedUnexpected.join(", ")}`);
    }

    const stagedDiff = (
      await runChecked({
        executable: "git",
        args: ["diff", "--cached", "--no-ext-diff", "--"],
        cwd: worktreePath,
        maxOutputBytes: 8 * 1024 * 1024,
      })
    ).stdout;
    if (containsLikelySecret(stagedDiff)) throw new Error("staged diff contains a likely secret");

    const outbox = path.join(store.root, "outbox");
    await mkdir(outbox, { recursive: true, mode: 0o700 });
    const messageFile = path.join(outbox, `${effect.id}.commit.txt`);
    const body = [
      boundedRemoteText(message, 100),
      "",
      `Refs #${issueNumber}`,
      "",
      `Harness-Run: ${runId}`,
      `Harness-Task: ${taskId}`,
      `Harness-Issue: ${issueNumber}`,
      `Harness-Effect: ${effect.id}`,
    ].join("\n");
    await writeFile(messageFile, body, { encoding: "utf8", mode: 0o600 });
    try {
      await runChecked({
        executable: "git",
        args: ["commit", "-F", messageFile],
        cwd: worktreePath,
        timeoutMs: 120_000,
      });
    } finally {
      await rm(messageFile, { force: true });
    }
    commitSha = (
      await runChecked({
        executable: "git",
        args: ["rev-parse", "HEAD"],
        cwd: worktreePath,
      })
    ).stdout.trim();
    const after = await workspaceFingerprint(worktreePath);
    if (after !== treeHash) {
      throw new Error("commit hooks changed the verified tree; fresh verification is required");
    }
  }
  if (!commitSha) throw new Error("commit did not produce a SHA");

  state = await recordTaskCommit(store, runId, taskId, commitSha, {
    kind: "commit",
    status: "pass",
    treeHash,
    configHash,
    taskId,
    summary: `Committed ${commitSha}`,
  });
  return await completeEffect(store, runId, effect.id, { commitSha });
}

function assertTaskCommitEvidence(
  state: RunState,
  task: HarnessTask,
  treeHash: string,
  configHash: string,
): void {
  if (task.status !== "verifying") throw new Error(`task ${task.id} must be verifying before commit`);
  const evidence = state.evidence.filter(
    (record) =>
      record.taskId === task.id &&
      record.treeHash === treeHash &&
      record.configHash === configHash,
  );
  for (const criterion of task.acceptanceCriteria) {
    if (
      !evidence.some(
        (record) =>
          record.kind === "acceptance" &&
          record.status === "pass" &&
          record.criterionId === criterion,
      )
    ) {
      throw new Error(`missing acceptance evidence for ${task.id}/${criterion}`);
    }
  }
  for (const check of task.checks.filter((candidate) => candidate.required !== false)) {
    if (
      !evidence.some(
        (record) =>
          record.kind === "verification" &&
          record.status === "pass" &&
          record.exitCode === 0 &&
          record.command !== undefined &&
          JSON.stringify(record.command.argv) === JSON.stringify(check.argv) &&
          (record.command.cwd ?? "") === (check.cwd ?? ""),
      )
    ) {
      throw new Error(`missing verification evidence for ${task.id}/${check.argv.join(" ")}`);
    }
  }
}

async function findExistingCommit(
  worktreePath: string,
  runId: string,
  taskId: string,
): Promise<string | undefined> {
  const result = await runChecked({
    executable: "git",
    args: ["log", "--all", "--format=%H%x1f%B%x1e", "--grep", `Harness-Run: ${runId}`, "--fixed-strings"],
    cwd: worktreePath,
  });
  for (const record of result.stdout.split("\u001e")) {
    const [sha, body = ""] = record.split("\u001f", 2);
    if (body.includes(`Harness-Task: ${taskId}`) && /^[0-9a-f]{40,64}$/.test(sha?.trim() ?? "")) {
      return sha?.trim();
    }
  }
  return undefined;
}

async function changedPaths(worktreePath: string): Promise<string[]> {
  const result = await runChecked({
    executable: "git",
    args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd: worktreePath,
  });
  return parsePorcelainPaths(result.stdout);
}

async function stagedPaths(worktreePath: string): Promise<string[]> {
  const result = await runChecked({
    executable: "git",
    args: ["diff", "--cached", "--name-only", "-z", "--"],
    cwd: worktreePath,
  });
  return result.stdout.split("\u0000").filter(Boolean);
}

function parsePorcelainPaths(value: string): string[] {
  const records = value.split("\u0000").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    const status = record.slice(0, 2);
    const candidate = record.slice(3);
    if (candidate) paths.push(candidate);
    if (status.includes("R") || status.includes("C")) {
      const second = records[index + 1];
      if (second) paths.push(second);
      index += 1;
    }
  }
  return [...new Set(paths)];
}

function isOwned(candidate: string, ownedPaths: string[]): boolean {
  const normalized = candidate.replaceAll("\\", "/").toLocaleLowerCase("en-US");
  return ownedPaths.some((ownedPath) => {
    const owned = ownedPath.replaceAll("\\", "/").replace(/\/$/, "").toLocaleLowerCase("en-US");
    return normalized === owned || normalized.startsWith(owned + "/");
  });
}

function slug(value: string): string {
  const result = value
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return result || "task";
}

function requireTask(state: RunState, taskId: string): HarnessTask {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  return task;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
