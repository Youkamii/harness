import { hashObject } from "./hash.js";
export const RUN_STATUSES = [
    "created",
    "planning",
    "issue_sync",
    "executing",
    "verifying",
    "reviewing",
    "remediating",
    "integrating",
    "complete",
    "failed",
    "blocked",
    "cancelled",
];
const transitions = {
    created: new Set(["planning", "blocked", "cancelled"]),
    planning: new Set(["issue_sync", "executing", "blocked", "failed", "cancelled"]),
    issue_sync: new Set(["executing", "blocked", "failed", "cancelled"]),
    executing: new Set(["verifying", "remediating", "blocked", "failed", "cancelled"]),
    verifying: new Set(["reviewing", "remediating", "blocked", "failed", "cancelled"]),
    reviewing: new Set(["integrating", "remediating", "blocked", "failed", "cancelled"]),
    remediating: new Set(["executing", "verifying", "blocked", "failed", "cancelled"]),
    integrating: new Set(["complete", "remediating", "blocked", "failed", "cancelled"]),
    complete: new Set(),
    failed: new Set(["planning", "cancelled"]),
    blocked: new Set(["planning", "issue_sync", "executing", "verifying", "reviewing", "cancelled"]),
    cancelled: new Set(),
};
export function assertRunTransition(from, to) {
    if (!transitions[from].has(to)) {
        throw new Error(`invalid run transition: ${from} -> ${to}`);
    }
}
export function currentConfigHash(state) {
    const normalized = {
        lane: state.lane,
        nonGoals: state.nonGoals,
        tasks: state.tasks.map(({ id, dependencies, acceptanceCriteria, ownedPaths, checks, risk }) => ({
            id,
            dependencies,
            acceptanceCriteria,
            ownedPaths,
            checks,
            risk,
        })),
    };
    return hashObject(normalized);
}
export function evaluateCompletion(state, currentTreeHash, configHash) {
    const reasons = [];
    if (state.tasks.length === 0)
        reasons.push("no planned tasks");
    const incomplete = state.tasks.filter((task) => task.status !== "complete");
    if (incomplete.length > 0)
        reasons.push(`incomplete tasks: ${incomplete.map((task) => task.id).join(", ")}`);
    const tasksWithoutIssue = state.tasks.filter((task) => !task.issue?.number);
    if (tasksWithoutIssue.length > 0) {
        reasons.push(`tasks without synchronized GitHub issues: ${tasksWithoutIssue.map((task) => task.id).join(", ")}`);
    }
    const currentEvidence = state.evidence.filter((evidence) => evidence.treeHash === currentTreeHash && evidence.configHash === configHash);
    if (!currentEvidence.some((evidence) => evidence.kind === "verification" && evidence.status === "pass")) {
        reasons.push("missing passing verification for current tree");
    }
    for (const task of state.tasks) {
        for (const criterionId of task.acceptanceCriteria) {
            const covered = currentEvidence.some((evidence) => evidence.kind === "acceptance" &&
                evidence.status === "pass" &&
                evidence.taskId === task.id &&
                evidence.criterionId === criterionId);
            if (!covered)
                reasons.push(`acceptance criterion lacks current evidence: ${task.id}/${criterionId}`);
        }
        for (const check of task.checks.filter((candidate) => candidate.required !== false)) {
            const covered = currentEvidence.some((evidence) => evidence.kind === "verification" &&
                evidence.status === "pass" &&
                evidence.exitCode === 0 &&
                evidence.taskId === task.id &&
                evidence.command !== undefined &&
                JSON.stringify(evidence.command.argv) === JSON.stringify(check.argv) &&
                (evidence.command.cwd ?? "") === (check.cwd ?? ""));
            if (!covered)
                reasons.push(`required check lacks current evidence: ${task.id}/${check.argv.join(" ")}`);
        }
        const commitRecorded = currentEvidence.some((evidence) => evidence.kind === "commit" && evidence.status === "pass" && evidence.taskId === task.id);
        if (!commitRecorded)
            reasons.push(`task lacks current commit evidence: ${task.id}`);
    }
    const reviews = currentEvidence.filter((evidence) => evidence.kind === "review" && evidence.status === "approved");
    const requiredReviews = state.tasks.some((task) => task.ownedPaths.some((ownedPath) => !ownedPath.endsWith(".md")))
        ? 2
        : 1;
    const distinctReviewers = new Set(reviews.map((evidence) => evidence.reviewer).filter(Boolean));
    if (distinctReviewers.size < requiredReviews) {
        reasons.push(`requires ${requiredReviews} independent current-tree review(s)`);
    }
    const unresolved = currentEvidence
        .flatMap((evidence) => evidence.findings ?? [])
        .filter((finding) => (finding.severity === "critical" || finding.severity === "high") &&
        finding.disposition !== "fixed" &&
        finding.disposition !== "rejected");
    if (unresolved.length > 0)
        reasons.push("unresolved critical or high review findings");
    const undisposedMedium = currentEvidence
        .flatMap((evidence) => evidence.findings ?? [])
        .filter((finding) => finding.severity === "medium" &&
        !["fixed", "rejected", "accepted-risk"].includes(finding.disposition ?? ""));
    if (undisposedMedium.length > 0)
        reasons.push("medium review findings require dispositions");
    return { allowed: reasons.length === 0, reasons };
}
//# sourceMappingURL=domain.js.map