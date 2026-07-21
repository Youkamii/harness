export declare const RUN_STATUSES: readonly ["created", "planning", "issue_sync", "executing", "verifying", "reviewing", "remediating", "integrating", "complete", "failed", "blocked", "cancelled"];
export type RunStatus = (typeof RUN_STATUSES)[number];
export type Lane = "fast" | "build" | "deep" | "autonomous";
export declare const RUN_MODES: readonly ["standard", "tough"];
export type RunMode = (typeof RUN_MODES)[number];
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
    branch?: string;
    worktreePath?: string;
    baseSha?: string;
    commitSha?: string;
    lastFailure?: string;
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
export interface ExternalEffect {
    id: string;
    key: string;
    kind: "github.issue.create" | "github.issue.comment" | "github.issue.close" | "git.commit";
    status: "pending" | "complete" | "failed";
    createdAt: string;
    completedAt?: string;
    result?: Record<string, unknown>;
}
export interface AgentAttempt {
    id: string;
    role: "planner" | "builder" | "acceptance-auditor" | "adversarial-reviewer";
    status: "starting" | "running" | "complete" | "failed" | "timed-out";
    sandbox: "read-only" | "workspace-write";
    cwd: string;
    startedAt: string;
    completedAt?: string;
    taskId?: string;
    threadId?: string;
    exitCode?: number;
    failureFingerprint?: string;
    /** Tough-mode planner or builder report, redacted before it enters the ledger. */
    summary?: string;
    /** Tough-mode reviewer concerns that are reported without becoming requirements. */
    residualRisks?: string[];
}
export interface RunState {
    schemaVersion: 1;
    id: string;
    goal: string;
    lane: Lane;
    /** Missing on legacy schemaVersion 1 runs and interpreted as standard. */
    mode?: RunMode;
    status: RunStatus;
    repoRoot: string;
    gitCommonDir: string;
    createdAt: string;
    updatedAt: string;
    sequence: number;
    assumptions: string[];
    nonGoals: string[];
    tasks: HarnessTask[];
    evidence: EvidenceRecord[];
    outbox: ExternalEffect[];
    attempts: AgentAttempt[];
    issue?: GitHubIssue;
    baseSha?: string;
    integrationBranch?: string;
    integrationWorktreePath?: string;
    integrationSha?: string;
    blockedReason?: string;
    blockedFrom?: RunStatus;
    remediation?: {
        taskId: string;
        reason: string;
        startedAt: string;
    };
}
export declare const TOUGH_MODE_NON_GOAL = "Inventing or implementing product security, safety, protective behavior, or operational constraints that the user did not request and the repository does not already require.";
export declare const TOUGH_MODE_ACCEPTANCE_CRITERION = "No unrequested product security, safety, protective behavior, or operational constraint is added; identified concerns are reported without implementing them.";
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
export declare function effectiveRunMode(state: Pick<RunState, "mode">): RunMode;
export declare function applyRunModeToPlanTasks(state: Pick<RunState, "mode">, tasks: PlannedTask[]): PlannedTask[];
export declare function normalizeNonGoalsForRunMode(state: Pick<RunState, "mode">, nonGoals: string[]): string[];
export declare function currentConfigHash(state: Pick<RunState, "lane" | "mode" | "tasks" | "nonGoals">): string;
export interface CompletionResult {
    allowed: boolean;
    reasons: string[];
}
export declare function evaluateCompletion(state: RunState, currentTreeHash: string, configHash: string): CompletionResult;
