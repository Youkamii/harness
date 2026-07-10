import { type EvidenceRecord, type PlannedTask, type RunState, type RunStatus, type TaskStatus } from "./domain.js";
import { RunStore } from "./store.js";
export declare function applyPlan(store: RunStore, runId: string, tasks: PlannedTask[]): Promise<RunState>;
export declare function transitionRun(store: RunStore, runId: string, to: RunStatus, options?: {
    treeHash?: string;
}): Promise<RunState>;
export declare function setTaskStatus(store: RunStore, runId: string, taskId: string, to: TaskStatus): Promise<RunState>;
export declare function addEvidence(store: RunStore, runId: string, evidence: Omit<EvidenceRecord, "id" | "recordedAt">): Promise<RunState>;
