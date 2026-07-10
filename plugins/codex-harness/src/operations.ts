import { randomUUID } from "node:crypto";
import {
  assertRunTransition,
  currentConfigHash,
  evaluateCompletion,
  type EvidenceRecord,
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

