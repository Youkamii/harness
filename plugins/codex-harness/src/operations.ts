import { randomUUID } from "node:crypto";
import {
  assertRunTransition,
  currentConfigHash,
  evaluateCompletion,
  type AgentAttempt,
  type EvidenceRecord,
  type ExternalEffect,
  type GitHubIssue,
  type PlannedTask,
  type RunState,
  type RunStatus,
  type TaskStatus,
} from "./domain.js";
import { materializeTasks, refreshReadyTasks } from "./graph.js";
import { RunStore } from "./store.js";

const taskTransitions: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  pending: new Set(["ready", "blocked"]),
  ready: new Set(["running", "blocked"]),
  running: new Set(["verifying", "failed", "blocked"]),
  verifying: new Set(["committed", "failed", "blocked"]),
  committed: new Set(["reviewed", "failed", "blocked"]),
  reviewed: new Set(["complete", "failed", "blocked"]),
  complete: new Set(),
  failed: new Set(["ready", "blocked"]),
  blocked: new Set(["ready", "failed"]),
};

export async function applyPlan(store: RunStore, runId: string, tasks: PlannedTask[]): Promise<RunState> {
  const materialized = materializeTasks(tasks);
  return await store.update(
    runId,
    "plan.applied",
    (state) => {
      if (state.status === "created") {
        assertRunTransition(state.status, "planning");
        state.status = "planning";
      } else if (state.status !== "planning" && state.status !== "failed") {
        throw new Error(`cannot apply a plan while run is ${state.status}`);
      } else if (state.status === "failed") {
        assertRunTransition(state.status, "planning");
        state.status = "planning";
      }
      state.tasks = materialized;
      state.evidence = [];
      return state;
    },
    { taskIds: materialized.map((task) => task.id) },
  );
}

export async function transitionRun(
  store: RunStore,
  runId: string,
  to: RunStatus,
  options: { treeHash?: string } = {},
): Promise<RunState> {
  return await store.update(
    runId,
    "run.transitioned",
    (state) => {
      assertRunTransition(state.status, to);
      if (to === "complete") {
        if (!options.treeHash) throw new Error("completion requires the current tree hash");
        const result = evaluateCompletion(state, options.treeHash, currentConfigHash(state));
        if (!result.allowed) throw new Error(`completion gate rejected: ${result.reasons.join("; ")}`);
      }
      state.status = to;
      if (to !== "blocked") delete state.blockedReason;
      return state;
    },
    { to },
  );
}

export async function blockRun(store: RunStore, runId: string, reason: string): Promise<RunState> {
  const boundedReason = reason.trim().slice(0, 2_000) || "Run is blocked without a recorded reason.";
  return await store.update(
    runId,
    "run.blocked",
    (state) => {
      if (state.status === "blocked") {
        state.blockedReason = boundedReason;
        return state;
      }
      assertRunTransition(state.status, "blocked");
      state.status = "blocked";
      state.blockedReason = boundedReason;
      return state;
    },
    { reason: boundedReason },
  );
}

export async function setTaskStatus(
  store: RunStore,
  runId: string,
  taskId: string,
  to: TaskStatus,
): Promise<RunState> {
  return await store.update(
    runId,
    "task.transitioned",
    (state) => {
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`unknown task: ${taskId}`);
      if (!taskTransitions[task.status].has(to)) {
        throw new Error(`invalid task transition: ${task.status} -> ${to}`);
      }
      task.status = to;
      if (to === "running") task.attempts += 1;
      state.tasks = refreshReadyTasks(state.tasks);
      return state;
    },
    { taskId, to },
  );
}

export async function addEvidence(
  store: RunStore,
  runId: string,
  evidence: Omit<EvidenceRecord, "id" | "recordedAt">,
): Promise<RunState> {
  const record: EvidenceRecord = {
    ...evidence,
    id: randomUUID(),
    recordedAt: new Date().toISOString(),
  };
  return await store.update(
    runId,
    "evidence.recorded",
    (state) => {
      state.evidence.push(record);
      return state;
    },
    { evidenceId: record.id, kind: record.kind, status: record.status },
  );
}

export async function setTaskIssue(
  store: RunStore,
  runId: string,
  taskId: string,
  issue: GitHubIssue,
): Promise<RunState> {
  return await store.update(
    runId,
    "task.issue.synchronized",
    (state) => {
      requireTask(state, taskId).issue = issue;
      return state;
    },
    { taskId, issueNumber: issue.number, marker: issue.marker },
  );
}

export async function setTaskWorktree(
  store: RunStore,
  runId: string,
  taskId: string,
  worktree: { branch: string; worktreePath: string; baseSha: string },
): Promise<RunState> {
  return await store.update(
    runId,
    "task.worktree.prepared",
    (state) => {
      const task = requireTask(state, taskId);
      task.branch = worktree.branch;
      task.worktreePath = worktree.worktreePath;
      task.baseSha = worktree.baseSha;
      return state;
    },
    { taskId, ...worktree },
  );
}

export async function recordTaskCommit(
  store: RunStore,
  runId: string,
  taskId: string,
  commitSha: string,
  evidence: Omit<EvidenceRecord, "id" | "recordedAt">,
): Promise<RunState> {
  return await store.update(
    runId,
    "task.committed",
    (state) => {
      const task = requireTask(state, taskId);
      if (task.status !== "verifying") {
        throw new Error(`task ${taskId} must be verifying before commit, got ${task.status}`);
      }
      task.status = "committed";
      task.commitSha = commitSha;
      state.evidence.push({
        ...evidence,
        id: randomUUID(),
        recordedAt: new Date().toISOString(),
      });
      return state;
    },
    { taskId, commitSha },
  );
}

export async function beginEffect(
  store: RunStore,
  runId: string,
  input: Pick<ExternalEffect, "key" | "kind">,
): Promise<{ state: RunState; effect: ExternalEffect }> {
  let effect: ExternalEffect | undefined;
  const state = await store.update(
    runId,
    "effect.pending",
    (current) => {
      effect = current.outbox.find((candidate) => candidate.key === input.key);
      if (!effect) {
        effect = {
          id: randomUUID(),
          key: input.key,
          kind: input.kind,
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        current.outbox.push(effect);
      }
      return current;
    },
    input,
  );
  if (!effect) throw new Error("failed to create effect");
  return { state, effect };
}

export async function completeEffect(
  store: RunStore,
  runId: string,
  effectId: string,
  result: Record<string, unknown>,
): Promise<RunState> {
  return await store.update(
    runId,
    "effect.completed",
    (state) => {
      const effect = state.outbox.find((candidate) => candidate.id === effectId);
      if (!effect) throw new Error(`unknown effect: ${effectId}`);
      effect.status = "complete";
      effect.completedAt = new Date().toISOString();
      effect.result = result;
      return state;
    },
    { effectId, result },
  );
}

function requireTask(state: RunState, taskId: string) {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  return task;
}

export async function startAgentAttempt(
  store: RunStore,
  runId: string,
  input: Pick<AgentAttempt, "role" | "sandbox" | "cwd"> & { taskId?: string },
): Promise<AgentAttempt> {
  const attempt: AgentAttempt = {
    id: randomUUID(),
    role: input.role,
    sandbox: input.sandbox,
    cwd: input.cwd,
    status: "starting",
    startedAt: new Date().toISOString(),
    ...(input.taskId ? { taskId: input.taskId } : {}),
  };
  await store.update(
    runId,
    "agent.started",
    (state) => {
      state.attempts.push(attempt);
      return state;
    },
    { attemptId: attempt.id, role: attempt.role, taskId: attempt.taskId },
  );
  return attempt;
}

export async function recordAssumptions(
  store: RunStore,
  runId: string,
  assumptions: string[],
): Promise<RunState> {
  const normalized = [...new Set(assumptions.map((value) => value.trim()).filter(Boolean))].slice(0, 20);
  return await store.update(
    runId,
    "run.assumptions.recorded",
    (state) => {
      state.assumptions = normalized;
      return state;
    },
    { count: normalized.length },
  );
}

export async function recordNonGoals(
  store: RunStore,
  runId: string,
  nonGoals: string[],
): Promise<RunState> {
  const normalized = [...new Set(nonGoals.map((value) => value.trim()).filter(Boolean))].slice(0, 20);
  return await store.update(
    runId,
    "run.non-goals.recorded",
    (state) => {
      state.nonGoals = normalized;
      return state;
    },
    { count: normalized.length },
  );
}

export async function resetTaskForRetry(
  store: RunStore,
  runId: string,
  taskId: string,
  reason: string,
): Promise<RunState> {
  return await store.update(
    runId,
    "task.retry.prepared",
    (state) => {
      const task = requireTask(state, taskId);
      if (task.status !== "failed" && task.status !== "blocked") {
        throw new Error(`task ${taskId} cannot retry from ${task.status}`);
      }
      task.status = "ready";
      delete task.commitSha;
      return state;
    },
    { taskId, reason },
  );
}

export async function recordIntegration(
  store: RunStore,
  runId: string,
  integration: { branch: string; worktreePath: string; sha: string },
): Promise<RunState> {
  return await store.update(
    runId,
    "run.integration.recorded",
    (state) => {
      state.integrationBranch = integration.branch;
      state.integrationWorktreePath = integration.worktreePath;
      state.integrationSha = integration.sha;
      return state;
    },
    integration,
  );
}

export async function recordAgentThread(
  store: RunStore,
  runId: string,
  attemptId: string,
  threadId: string,
): Promise<RunState> {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error("invalid Codex thread id");
  return await store.update(
    runId,
    "agent.thread.recorded",
    (state) => {
      const attempt = requireAttempt(state, attemptId);
      if (attempt.threadId && attempt.threadId !== threadId) {
        throw new Error("agent thread id is immutable");
      }
      attempt.threadId = threadId;
      attempt.status = "running";
      return state;
    },
    { attemptId, threadId },
  );
}

export async function finishAgentAttempt(
  store: RunStore,
  runId: string,
  attemptId: string,
  result: {
    status: "complete" | "failed" | "timed-out";
    exitCode: number;
    failureFingerprint?: string;
  },
): Promise<RunState> {
  return await store.update(
    runId,
    "agent.finished",
    (state) => {
      const attempt = requireAttempt(state, attemptId);
      attempt.status = result.status;
      attempt.exitCode = result.exitCode;
      attempt.completedAt = new Date().toISOString();
      if (result.failureFingerprint) attempt.failureFingerprint = result.failureFingerprint;
      return state;
    },
    { attemptId, ...result },
  );
}

function requireAttempt(state: RunState, attemptId: string): AgentAttempt {
  const attempt = state.attempts.find((candidate) => candidate.id === attemptId);
  if (!attempt) throw new Error(`unknown agent attempt: ${attemptId}`);
  return attempt;
}
