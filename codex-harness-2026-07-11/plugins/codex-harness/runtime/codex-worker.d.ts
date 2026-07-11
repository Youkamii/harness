import type { AgentAttempt, PlannedTask, ReviewFinding } from "./domain.js";
import { RunStore } from "./store.js";
export interface PlanOutput {
    summary: string;
    assumptions: string[];
    nonGoals: string[];
    tasks: PlannedTask[];
}
export interface BuilderOutput {
    status: "implemented" | "blocked";
    summary: string;
    changedPaths: string[];
    checksAttempted: string[];
    blockers: string[];
}
export interface ReviewOutput {
    verdict: "approved" | "blocked";
    commands: Array<{
        argv: string[];
        exitCode: number;
    }>;
    criteria: Array<{
        id: string;
        status: "pass" | "fail" | "unknown";
        evidence: string;
    }>;
    findings: ReviewFinding[];
    residualRisks: string[];
}
export type WorkerOutput = PlanOutput | BuilderOutput | ReviewOutput;
interface WorkerRequest {
    store: RunStore;
    runId: string;
    role: AgentAttempt["role"];
    cwd: string;
    prompt: string;
    taskId?: string;
    timeoutMs?: number;
    resumeThreadId?: string;
}
export declare function runCodexWorker(request: WorkerRequest): Promise<WorkerOutput>;
export declare function codexArgumentsForTest(role: AgentAttempt["role"], cwd: string, schema: string, output: string): string[];
export declare function validateWorkerOutputForTest(role: AgentAttempt["role"], value: unknown): asserts value is WorkerOutput;
export {};
