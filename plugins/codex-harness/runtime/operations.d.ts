import { type AgentAttempt, type EvidenceRecord, type ExternalEffect, type GitHubIssue, type PlannedTask, type RunState, type RunStatus, type TaskStatus } from "./domain.js";
import { RunStore } from "./store.js";
export declare function applyPlan(store: RunStore, runId: string, tasks: PlannedTask[]): Promise<RunState>;
export declare function transitionRun(store: RunStore, runId: string, to: RunStatus, options?: {
    treeHash?: string;
}): Promise<RunState>;
export declare function blockRun(store: RunStore, runId: string, reason: string): Promise<RunState>;
export declare function setTaskStatus(store: RunStore, runId: string, taskId: string, to: TaskStatus): Promise<RunState>;
export declare function addEvidence(store: RunStore, runId: string, evidence: Omit<EvidenceRecord, "id" | "recordedAt">): Promise<RunState>;
export declare function setTaskIssue(store: RunStore, runId: string, taskId: string, issue: GitHubIssue): Promise<RunState>;
export declare function setTaskWorktree(store: RunStore, runId: string, taskId: string, worktree: {
    branch: string;
    worktreePath: string;
    baseSha: string;
}): Promise<RunState>;
export declare function recordTaskCommit(store: RunStore, runId: string, taskId: string, commitSha: string, evidence: Omit<EvidenceRecord, "id" | "recordedAt">): Promise<RunState>;
export declare function beginEffect(store: RunStore, runId: string, input: Pick<ExternalEffect, "key" | "kind">): Promise<{
    state: RunState;
    effect: ExternalEffect;
}>;
export declare function completeEffect(store: RunStore, runId: string, effectId: string, result: Record<string, unknown>): Promise<RunState>;
export declare function startAgentAttempt(store: RunStore, runId: string, input: Pick<AgentAttempt, "role" | "sandbox" | "cwd"> & {
    taskId?: string;
}): Promise<AgentAttempt>;
export declare function recordAssumptions(store: RunStore, runId: string, assumptions: string[]): Promise<RunState>;
export declare function recordNonGoals(store: RunStore, runId: string, nonGoals: string[]): Promise<RunState>;
export declare function resetTaskForRetry(store: RunStore, runId: string, taskId: string, reason: string): Promise<RunState>;
export declare function recordIntegration(store: RunStore, runId: string, integration: {
    branch: string;
    worktreePath: string;
    sha: string;
}): Promise<RunState>;
export declare function recordAgentThread(store: RunStore, runId: string, attemptId: string, threadId: string): Promise<RunState>;
export declare function finishAgentAttempt(store: RunStore, runId: string, attemptId: string, result: {
    status: "complete" | "failed" | "timed-out";
    exitCode: number;
    failureFingerprint?: string;
}): Promise<RunState>;
