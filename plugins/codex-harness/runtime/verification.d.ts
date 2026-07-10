import type { CommandSpec, ReviewFinding, RunState } from "./domain.js";
import { RunStore } from "./store.js";
interface CheckResult {
    command: CommandSpec;
    exitCode: number;
    timedOut: boolean;
    summary: string;
}
interface VerificationOptions {
    worktree?: string;
    allowCompleted?: boolean;
}
interface ReviewOptions {
    cwd?: string;
    commitSha?: string;
    finalTree?: boolean;
}
export declare function captureBaseline(store: RunStore, runId: string, taskId: string): Promise<CheckResult[]>;
export declare function verifyTask(store: RunStore, runId: string, taskId: string, options?: VerificationOptions): Promise<{
    passed: boolean;
    results: CheckResult[];
    treeHash: string;
}>;
export declare function reviewAndRecordTask(store: RunStore, runId: string, taskId: string, options?: ReviewOptions): Promise<{
    passed: boolean;
    findings: ReviewFinding[];
}>;
export declare function recordIntegratedCommitEvidence(store: RunStore, runId: string, worktree: string): Promise<RunState>;
export {};
