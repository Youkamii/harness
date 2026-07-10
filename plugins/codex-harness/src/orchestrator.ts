import type { HarnessTask, RunState, TaskStatus } from "./domain.js";
import { currentConfigHash, evaluateCompletion } from "./domain.js";
import { buildTask, planRun } from "./autonomy.js";
import { commitTask, prepareTaskWorktree } from "./git.js";
import { syncTaskIssues } from "./github.js";
import { integrateRun } from "./integration.js";
import {
  blockRun,
  resetTaskForRetry,
  setTaskStatus,
  transitionRun,
} from "./operations.js";
import { redactSecrets } from "./redact.js";
import { workspaceFingerprint } from "./repo.js";
import { RunStore } from "./store.js";
import {
  captureBaseline,
  recordIntegratedCommitEvidence,
  reviewAndRecordTask,
  verifyTask,
} from "./verification.js";

const MAX_TASK_ATTEMPTS = 3;

export async function runAutonomously(store: RunStore, runId: string): Promise<RunState> {
  try {
    while (true) {
      let state = await store.load(runId);
      if (isTerminal(state)) return state;

      if (state.status === "created" || (state.status === "planning" && state.tasks.length === 0)) {
        await planRun(store, state);
        continue;
      }
      if (state.status === "planning" || state.status === "issue_sync") {
        await syncTaskIssues(store, runId, state.repoRoot);
        continue;
      }
      if (state.status === "executing") {
        const incomplete = state.tasks.filter((task) => task.status !== "complete");
        if (incomplete.length > 0) {
          const actionable = incomplete.find((task) => task.status !== "pending");
          if (!actionable) throw new Error("all incomplete tasks are waiting on unsatisfied dependencies");
          await advanceTask(store, runId, actionable);
          continue;
        }
        state = await integrateRun(store, runId);
        await transitionRun(store, runId, "verifying");
        continue;
      }
      if (state.status === "verifying") {
        const worktree = requireIntegrationWorktree(state);
        for (const task of state.tasks) {
          const result = await verifyTask(store, runId, task.id, {
            worktree,
            allowCompleted: true,
          });
          if (!result.passed) {
            return await blockRun(store, runId, `Integrated verification failed for task ${task.id}.`);
          }
        }
        await transitionRun(store, runId, "reviewing");
        continue;
      }
      if (state.status === "reviewing") {
        const worktree = requireIntegrationWorktree(state);
        const commitSha = state.integrationSha;
        if (!commitSha) throw new Error("integration SHA is missing");
        for (const task of state.tasks) {
          const review = await reviewAndRecordTask(store, runId, task.id, {
            cwd: worktree,
            commitSha,
            finalTree: true,
          });
          if (!review.passed) {
            return await blockRun(store, runId, `Integrated adversarial review blocked task ${task.id}.`);
          }
        }
        await recordIntegratedCommitEvidence(store, runId, worktree);
        await transitionRun(store, runId, "integrating");
        continue;
      }
      if (state.status === "integrating") {
        const worktree = requireIntegrationWorktree(state);
        const treeHash = await workspaceFingerprint(worktree);
        const gate = evaluateCompletion(state, treeHash, currentConfigHash(state));
        if (!gate.allowed) {
          return await blockRun(store, runId, `Completion gate rejected the run: ${gate.reasons.join("; ")}`);
        }
        return await transitionRun(store, runId, "complete", { treeHash });
      }

      return await blockRun(store, runId, `No autonomous handler exists for run state ${state.status}.`);
    }
  } catch (error) {
    const state = await store.load(runId);
    if (isTerminal(state)) return state;
    const reason = redactSecrets(error instanceof Error ? error.message : String(error));
    return await blockRun(store, runId, reason);
  }
}

async function advanceTask(store: RunStore, runId: string, observed: HarnessTask): Promise<void> {
  let state = await store.load(runId);
  let task = requireTask(state, observed.id);
  if (task.status === "pending") {
    throw new Error(`task ${task.id} is pending while no earlier actionable task was selected`);
  }
  if (task.status === "failed" || task.status === "blocked") {
    await retryOrExhaust(store, runId, task, "previous attempt failed");
    return;
  }
  if (task.status === "ready") {
    state = await prepareTaskWorktree(store, runId, task.id);
    task = requireTask(state, task.id);
  }
  if (task.status === "running") {
    const builderAttempts = state.attempts.filter(
      (attempt) => attempt.taskId === task.id && attempt.role === "builder",
    ).length;
    if (builderAttempts < task.attempts) await captureBaseline(store, runId, task.id);
    try {
      const build = await buildTask(store, runId, task.id);
      if (build.output.status === "blocked") {
        await retryOrExhaust(store, runId, requireTask(build.state, task.id), build.output.blockers.join("; "));
      }
    } catch (error) {
      await failAndRetry(store, runId, task.id, error);
    }
    return;
  }
  if (task.status === "verifying") {
    try {
      const verification = await verifyTask(store, runId, task.id);
      if (!verification.passed) {
        await setTaskStatus(store, runId, task.id, "failed");
        await retryOrExhaust(store, runId, requireTask(await store.load(runId), task.id), "required check failed");
        return;
      }
      await commitTask(store, runId, task.id, `feat: ${task.title}`);
    } catch (error) {
      await failAndRetry(store, runId, task.id, error);
    }
    return;
  }
  if (task.status === "committed") {
    try {
      const review = await reviewAndRecordTask(store, runId, task.id);
      if (!review.passed) {
        await retryOrExhaust(store, runId, requireTask(await store.load(runId), task.id), "independent review failed");
      }
    } catch (error) {
      await failAndRetry(store, runId, task.id, error);
    }
    return;
  }
  if (task.status === "reviewed") {
    await setTaskStatus(store, runId, task.id, "complete");
    return;
  }
  if (task.status !== "complete") throw new Error(`task ${task.id} cannot advance from ${task.status}`);
}

async function failAndRetry(
  store: RunStore,
  runId: string,
  taskId: string,
  error: unknown,
): Promise<void> {
  let state = await store.load(runId);
  let task = requireTask(state, taskId);
  if (canFail(task.status)) {
    state = await setTaskStatus(store, runId, taskId, "failed");
    task = requireTask(state, taskId);
  }
  const reason = redactSecrets(error instanceof Error ? error.message : String(error));
  await retryOrExhaust(store, runId, task, reason);
}

async function retryOrExhaust(
  store: RunStore,
  runId: string,
  task: HarnessTask,
  reason: string,
): Promise<void> {
  if (task.attempts < MAX_TASK_ATTEMPTS) {
    await resetTaskForRetry(store, runId, task.id, redactSecrets(reason));
    return;
  }
  if (task.status === "failed") await setTaskStatus(store, runId, task.id, "blocked");
  await blockRun(
    store,
    runId,
    `Task ${task.id} exhausted ${MAX_TASK_ATTEMPTS} attempts: ${redactSecrets(reason)}`,
  );
}

function canFail(status: TaskStatus): boolean {
  return status === "running" || status === "verifying" || status === "committed" || status === "reviewed";
}

function requireTask(state: RunState, taskId: string): HarnessTask {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  return task;
}

function requireIntegrationWorktree(state: RunState): string {
  if (!state.integrationWorktreePath) throw new Error("integration worktree is missing");
  return state.integrationWorktreePath;
}

function isTerminal(state: RunState): boolean {
  return ["complete", "failed", "blocked", "cancelled"].includes(state.status);
}
