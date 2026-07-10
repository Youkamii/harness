import type { HarnessTask, RunState, TaskStatus } from "./domain.js";
import { currentConfigHash, evaluateCompletion } from "./domain.js";
import { buildTask, planRun } from "./autonomy.js";
import { commitTask, discardTaskWorktree, prepareTaskWorktree } from "./git.js";
import { syncTaskIssues } from "./github.js";
import {
  assertIntegrationState,
  discardIntegration,
  integrateRun,
} from "./integration.js";
import {
  blockRun,
  beginRemediation,
  completeRemediation,
  reopenTaskForRemediation,
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
  return await store.withRunLease(runId, async () => await runLoop(store, runId));
}

export async function resumeAutonomously(store: RunStore, runId: string): Promise<RunState> {
  return await store.withRunLease(runId, async () => {
    let state = await store.load(runId);
    if (state.status === "blocked") {
      for (const task of state.tasks.filter((candidate) => candidate.status === "blocked")) {
        state = await resetTaskForRetry(store, runId, task.id, state.blockedReason ?? "blocked run resumed");
      }
      const target = resumableStatus(state);
      state = await transitionRun(store, runId, target);
    }
    return await runLoop(store, runId);
  });
}

async function runLoop(store: RunStore, runId: string): Promise<RunState> {
  try {
    run: while (true) {
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
      if (state.status === "remediating") {
        await executePendingRemediation(store, runId);
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
        await assertIntegrationState(state);
        const worktree = requireIntegrationWorktree(state);
        for (const task of state.tasks) {
          const result = await verifyTask(store, runId, task.id, {
            worktree,
            allowCompleted: true,
          });
          if (!result.passed) {
            if (await prepareIntegratedRemediation(store, runId, task, "integrated verification failed")) {
              continue run;
            }
            return await blockRun(store, runId, `Integrated verification failed for task ${task.id}.`);
          }
        }
        await assertIntegrationState(await store.load(runId));
        await transitionRun(store, runId, "reviewing");
        continue;
      }
      if (state.status === "reviewing") {
        await assertIntegrationState(state);
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
            if (await prepareIntegratedRemediation(store, runId, task, "integrated adversarial review failed")) {
              continue run;
            }
            return await blockRun(store, runId, `Integrated adversarial review blocked task ${task.id}.`);
          }
        }
        await assertIntegrationState(await store.load(runId));
        await recordIntegratedCommitEvidence(store, runId, worktree);
        await transitionRun(store, runId, "integrating");
        continue;
      }
      if (state.status === "integrating") {
        await assertIntegrationState(state);
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

async function prepareIntegratedRemediation(
  store: RunStore,
  runId: string,
  task: HarnessTask,
  reason: string,
): Promise<boolean> {
  const state = await store.load(runId);
  const affected = remediationTasks(state, task.id);
  if (affected.some((candidate) => candidate.attempts >= MAX_TASK_ATTEMPTS)) return false;
  await beginRemediation(store, runId, task.id, reason);
  return true;
}

export async function executePendingRemediation(store: RunStore, runId: string): Promise<RunState> {
  const state = await store.load(runId);
  if (state.status !== "remediating" || !state.remediation) {
    throw new Error("remediation intent is missing");
  }
  const affected = remediationTasks(state, state.remediation.taskId);
  await discardIntegration(store, runId);
  for (const candidate of [...affected].reverse()) {
    await discardTaskWorktree(store, runId, candidate.id);
  }
  for (const candidate of affected) {
    await reopenTaskForRemediation(
      store,
      runId,
      candidate.id,
      candidate.id === state.remediation.taskId
        ? state.remediation.reason
        : `dependency ${state.remediation.taskId} is being remediated`,
    );
  }
  return await completeRemediation(store, runId);
}

function remediationTasks(state: RunState, rootTaskId: string): HarnessTask[] {
  const affected = new Set([rootTaskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of state.tasks) {
      if (!affected.has(task.id) && task.dependencies.some((dependency) => affected.has(dependency))) {
        affected.add(task.id);
        changed = true;
      }
    }
  }
  const pending = new Map(state.tasks.filter((task) => affected.has(task.id)).map((task) => [task.id, task]));
  const result: HarnessTask[] = [];
  const emitted = new Set<string>();
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((candidate) =>
      candidate.dependencies.filter((dependency) => affected.has(dependency)).every((dependency) => emitted.has(dependency)),
    );
    if (ready.length === 0) throw new Error("remediation task graph cannot be ordered");
    for (const candidate of ready) {
      result.push(candidate);
      emitted.add(candidate.id);
      pending.delete(candidate.id);
    }
  }
  return result;
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
    if (builderAttempts < task.attempts) {
      const baseline = await captureBaseline(store, runId, task.id);
      if (baseline.some((result) => result.mutated)) {
        await discardTaskWorktree(store, runId, task.id);
        await failAndRetry(store, runId, task.id, new Error("baseline checks mutated repository content"));
        return;
      }
    }
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

function resumableStatus(state: RunState): Exclude<RunState["status"], "blocked"> {
  const previous = state.blockedFrom;
  if (previous && !["created", "complete", "failed", "blocked", "cancelled"].includes(previous)) {
    return previous as Exclude<RunState["status"], "blocked">;
  }
  if (state.tasks.length === 0) return "planning";
  if (state.integrationWorktreePath) return "verifying";
  return state.tasks.every((task) => task.issue?.number) ? "executing" : "issue_sync";
}
