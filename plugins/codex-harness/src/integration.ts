import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { HarnessTask, RunState } from "./domain.js";
import { recordIntegration } from "./operations.js";
import { runChecked, runProcess } from "./process.js";
import { RunStore } from "./store.js";

export async function integrateRun(store: RunStore, runId: string): Promise<RunState> {
  let state = await store.load(runId);
  if (state.integrationWorktreePath && state.integrationSha) return state;
  if (state.tasks.length === 0 || state.tasks.some((task) => task.status !== "complete" || !task.commitSha)) {
    throw new Error("all tasks must be complete and committed before integration");
  }
  const bases = new Set(state.tasks.map((task) => task.baseSha));
  if (bases.size !== 1 || bases.has(undefined)) throw new Error("task worktrees do not share one base SHA");
  const baseSha = [...bases][0];
  if (!baseSha) throw new Error("integration base SHA is missing");

  const branch = `forge/run-${runId.slice(0, 8)}`;
  const worktreePath = path.resolve(
    path.dirname(state.repoRoot),
    `${path.basename(state.repoRoot)}.codex-harness-integration`,
    runId,
  );
  await mkdir(path.dirname(worktreePath), { recursive: true });
  if (!(await pathExists(worktreePath))) {
    const branchExists = await runProcess({
      executable: "git",
      args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      cwd: state.repoRoot,
    });
    await runChecked({
      executable: "git",
      args:
        branchExists.exitCode === 0
          ? ["worktree", "add", worktreePath, branch]
          : ["worktree", "add", "-b", branch, worktreePath, baseSha],
      cwd: state.repoRoot,
      timeoutMs: 60_000,
    });
  }
  await assertClean(worktreePath);

  const ordered = topologicalTasks(state.tasks);
  for (const task of ordered) {
    const commits = await taskCommits(state.repoRoot, baseSha, task);
    for (const commit of commits) {
      const effectId = await effectForCommit(state.repoRoot, commit, task.id);
      if (await commitForEffect(worktreePath, baseSha, effectId)) continue;
      const result = await runProcess({
        executable: "git",
        args: ["cherry-pick", commit],
        cwd: worktreePath,
        timeoutMs: 120_000,
        maxOutputBytes: 4 * 1024 * 1024,
      });
      if (result.exitCode !== 0) {
        await runProcess({ executable: "git", args: ["cherry-pick", "--abort"], cwd: worktreePath });
        throw new Error(`integration conflict for task ${task.id}: ${result.stderr.trim()}`);
      }
    }
  }
  await assertClean(worktreePath);

  const sha = (
    await runChecked({ executable: "git", args: ["rev-parse", "HEAD"], cwd: worktreePath })
  ).stdout.trim();
  state = await recordIntegration(store, runId, { branch, worktreePath, sha });
  return state;
}

function topologicalTasks(tasks: HarnessTask[]): HarnessTask[] {
  const pending = new Map(tasks.map((task) => [task.id, task]));
  const emitted = new Set<string>();
  const result: HarnessTask[] = [];
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((task) =>
      task.dependencies.every((dependency) => emitted.has(dependency)),
    );
    if (ready.length === 0) throw new Error("task graph cannot be topologically ordered");
    for (const task of ready) {
      result.push(task);
      emitted.add(task.id);
      pending.delete(task.id);
    }
  }
  return result;
}

async function taskCommits(
  repoRoot: string,
  baseSha: string,
  task: HarnessTask,
): Promise<string[]> {
  if (!task.commitSha) throw new Error(`task ${task.id} has no commit SHA`);
  const result = await runChecked({
    executable: "git",
    args: ["rev-list", "--reverse", `${baseSha}..${task.commitSha}`],
    cwd: repoRoot,
  });
  const commits = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (commits.length === 0) throw new Error(`task ${task.id} has no commits after its base`);
  return commits;
}

async function effectForCommit(repoRoot: string, commit: string, taskId: string): Promise<string> {
  const body = (
    await runChecked({ executable: "git", args: ["show", "-s", "--format=%B", commit], cwd: repoRoot })
  ).stdout;
  if (!body.includes(`Harness-Task: ${taskId}`)) {
    throw new Error(`commit ${commit} does not belong to task ${taskId}`);
  }
  const effectId = body.match(/^Harness-Effect:\s*([0-9a-f-]{36})\s*$/im)?.[1];
  if (!effectId) throw new Error(`commit ${commit} lacks a Harness-Effect trailer`);
  return effectId;
}

async function commitForEffect(
  worktreePath: string,
  baseSha: string,
  effectId: string,
): Promise<string | undefined> {
  const result = await runChecked({
    executable: "git",
    args: [
      "log",
      `${baseSha}..HEAD`,
      "--format=%H%x1f%B%x1e",
      "--grep",
      `Harness-Effect: ${effectId}`,
      "--fixed-strings",
    ],
    cwd: worktreePath,
  });
  for (const record of result.stdout.split("\u001e")) {
    const [sha, body = ""] = record.split("\u001f", 2);
    if (body.includes(`Harness-Effect: ${effectId}`) && /^[0-9a-f]{40,64}$/.test(sha?.trim() ?? "")) {
      return sha?.trim();
    }
  }
  return undefined;
}

async function assertClean(worktreePath: string): Promise<void> {
  const status = await runChecked({
    executable: "git",
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd: worktreePath,
  });
  if (status.stdout.trim()) throw new Error("integration worktree contains uncommitted changes");
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
