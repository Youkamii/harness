export declare const RUN_STATUSES: readonly ["created", "planning", "issue_sync", "executing", "verifying", "reviewing", "remediating", "integrating", "complete", "failed", "blocked", "cancelled"];
export type RunStatus = (typeof RUN_STATUSES)[number];
export type Lane = "fast" | "build" | "deep" | "autonomous";
export type TaskStatus = "pending" | "ready" | "running" | "verifying" | "committed" | "reviewed" | "complete" | "failed" | "blocked";
export interface CommandSpec {
    argv: string[];
    cwd?: string;
    timeoutMs?: number;
    required?: boolean;
}
export interface PlannedTask {
    id: string;
    title: string;
    dependencies: string[];
    acceptanceCriteria: string[];
    ownedPaths: string[];
    checks: CommandSpec[];
    risk: "low" | "medium" | "high";
}
export interface HarnessTask extends PlannedTask {
    status: TaskStatus;
    attempts: number;
    issue?: GitHubIssue;
}
export interface ReviewFinding {
    severity: "critical" | "high" | "medium" | "low";
    file: string;
    line: number;
    evidence: string;
    confidence: number;
    suggestedTest: string;
    disposition?: "confirmed" | "rejected" | "fixed" | "accepted-risk";
    dispositionReason?: string;
}
export interface EvidenceRecord {
    id: string;
    kind: "baseline" | "verification" | "acceptance" | "review" | "commit";
    status: "pass" | "fail" | "approved" | "blocked";
    treeHash: string;
    configHash: string;
    recordedAt: string;
    criterionId?: string;
    taskId?: string;
    command?: CommandSpec;
    exitCode?: number;
    reviewer?: string;
    findings?: ReviewFinding[];
    summary?: string;
}
export interface GitHubIssue {
    number: number;
    url: string;
    marker: string;
    syncedAt: string;
    state: "open" | "closed";
}
export interface RunState {
    schemaVersion: 1;
    id: string;
    goal: string;
    lane: Lane;
    status: RunStatus;
    repoRoot: string;
    gitCommonDir: string;
    createdAt: string;
    updatedAt: string;
    sequence: number;
    assumptions: string[];
    tasks: HarnessTask[];
    evidence: EvidenceRecord[];
    issue?: GitHubIssue;
    blockedReason?: string;
}
export interface JournalEvent {
    schemaVersion: 1;
    eventId: string;
    runId: string;
    sequence: number;
    previousHash: string;
    type: string;
    recordedAt: string;
    payload: unknown;
    hash: string;
}
export declare function assertRunTransition(from: RunStatus, to: RunStatus): void;
export declare function currentConfigHash(state: Pick<RunState, "lane" | "tasks">): string;
export interface CompletionResult {
    allowed: boolean;
    reasons: string[];
}
export declare function evaluateCompletion(state: RunState, currentTreeHash: string, configHash: string): CompletionResult;
