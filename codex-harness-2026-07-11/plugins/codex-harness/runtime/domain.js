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
export const RUN_MODES = ["standard", "tough"];
export const TOUGH_MODE_NON_GOAL = "Inventing or implementing product security, safety, protective behavior, or operational constraints that the user did not request and the repository does not already require.";
export const TOUGH_MODE_ACCEPTANCE_CRITERION = "No unrequested product security, safety, protective behavior, or operational constraint is added; identified concerns are reported without implementing them.";
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
    blocked: new Set(["planning", "issue_sync", "executing", "verifying", "reviewing", "remediating", "integrating", "cancelled"]),
    cancelled: new Set(),
};
export function assertRunTransition(from, to) {
    if (!transitions[from].has(to)) {
        throw new Error(`invalid run transition: ${from} -> ${to}`);
    }
}
export function effectiveRunMode(state) {
    return state.mode ?? "standard";
}
export function applyRunModeToPlanTasks(state, tasks) {
    if (effectiveRunMode(state) !== "tough")
        return tasks;
    return tasks.map((task) => {
        if (task.acceptanceCriteria.includes(TOUGH_MODE_ACCEPTANCE_CRITERION))
            return task;
        if (task.acceptanceCriteria.length >= 100) {
            throw new Error(`task ${task.id} has no room for the tough-mode acceptance criterion`);
        }
        return {
            ...task,
            acceptanceCriteria: [...task.acceptanceCriteria, TOUGH_MODE_ACCEPTANCE_CRITERION],
        };
    });
}
export function normalizeNonGoalsForRunMode(state, nonGoals) {
    const normalized = [...new Set(nonGoals.map((value) => value.trim()).filter(Boolean))];
    if (effectiveRunMode(state) !== "tough")
        return normalized.slice(0, 20);
    const otherNonGoals = normalized.filter((nonGoal) => nonGoal !== TOUGH_MODE_NON_GOAL);
    if (otherNonGoals.length > 19) {
        throw new Error("tough mode requires room for its deterministic non-goal");
    }
    return [TOUGH_MODE_NON_GOAL, ...otherNonGoals];
}
export function currentConfigHash(state) {
    const normalized = {
        lane: state.lane,
        ...(state.mode === undefined ? {} : { mode: state.mode }),
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
    for (const task of state.tasks) {
        const taskEvidence = currentEvidence.filter((evidence) => evidence.taskId === task.id);
        if (!taskEvidence.some((evidence) => evidence.kind === "verification" && evidence.status === "pass")) {
            reasons.push(`task lacks passing current-tree verification: ${task.id}`);
        }
        for (const criterionId of task.acceptanceCriteria) {
            const covered = taskEvidence.some((evidence) => evidence.kind === "acceptance" &&
                evidence.status === "pass" &&
                evidence.criterionId === criterionId);
            if (!covered)
                reasons.push(`acceptance criterion lacks current evidence: ${task.id}/${criterionId}`);
        }
        for (const check of task.checks.filter((candidate) => candidate.required !== false)) {
            const covered = taskEvidence.some((evidence) => evidence.kind === "verification" &&
                evidence.status === "pass" &&
                evidence.exitCode === 0 &&
                evidence.command !== undefined &&
                JSON.stringify(evidence.command.argv) === JSON.stringify(check.argv) &&
                (evidence.command.cwd ?? "") === (check.cwd ?? ""));
            if (!covered)
                reasons.push(`required check lacks current evidence: ${task.id}/${check.argv.join(" ")}`);
        }
        const commitRecorded = taskEvidence.some((evidence) => evidence.kind === "commit" && evidence.status === "pass");
        if (!commitRecorded)
            reasons.push(`task lacks current commit evidence: ${task.id}`);
        const requiredReviews = effectiveRunMode(state) === "tough" ||
            task.ownedPaths.some((ownedPath) => !ownedPath.endsWith(".md"))
            ? 2
            : 1;
        const distinctReviewers = new Set(taskEvidence
            .filter((evidence) => evidence.kind === "review" && evidence.status === "approved")
            .map((evidence) => evidence.reviewer)
            .filter(Boolean));
        if (distinctReviewers.size < requiredReviews) {
            const reviewLabel = requiredReviews === 1 ? "review" : "reviews";
            reasons.push(`task ${task.id} requires ${requiredReviews} independent current-tree ${reviewLabel}`);
        }
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