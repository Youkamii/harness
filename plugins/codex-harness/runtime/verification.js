import { mkdir } from "node:fs/promises";
import path from "node:path";
import { currentConfigHash } from "./domain.js";
import { resolveCodexExecutable } from "./executables.js";
import { reviewTask } from "./autonomy.js";
import { addEvidence, setTaskStatus } from "./operations.js";
import { sanitizedEnvironment, redactSecrets } from "./redact.js";
import { assertWithin, workspaceFingerprint } from "./repo.js";
import { runProcess } from "./process.js";
export async function captureBaseline(store, runId, taskId) {
    return await runChecks(store, runId, taskId, "baseline");
}
export async function verifyTask(store, runId, taskId, options = {}) {
    const results = await runChecks(store, runId, taskId, "verification", options);
    const state = await store.load(runId);
    const task = requireTask(state, taskId);
    const treeHash = await workspaceFingerprint(options.worktree ?? requireWorktree(task));
    const required = results.filter((_, index) => task.checks[index]?.required !== false);
    return {
        passed: required.every((result) => result.exitCode === 0 && !result.timedOut),
        results,
        treeHash,
    };
}
async function runChecks(store, runId, taskId, phase, options = {}) {
    let state = await store.load(runId);
    const task = requireTask(state, taskId);
    const worktree = options.worktree ?? requireWorktree(task);
    if (phase === "baseline" && task.status !== "running") {
        throw new Error(`baseline requires running task, got ${task.status}`);
    }
    if (phase === "verification" &&
        task.status !== "verifying" &&
        !(options.allowCompleted && task.status === "complete")) {
        throw new Error(`verification requires verifying task, got ${task.status}`);
    }
    const before = await workspaceFingerprint(worktree);
    const configHash = currentConfigHash(state);
    const home = path.join(store.root, "sandbox-home", runId, taskId);
    await mkdir(home, { recursive: true, mode: 0o700 });
    const environment = {
        ...sanitizedEnvironment(),
        HOME: home,
        USERPROFILE: home,
        GH_CONFIG_DIR: path.join(home, ".config", "gh"),
        GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        NPM_CONFIG_USERCONFIG: path.join(home, ".npmrc"),
        NODE_OPTIONS: "",
        CI: "true",
        NO_COLOR: "1",
    };
    const results = [];
    const codexExecutable = await resolveCodexExecutable();
    for (const command of task.checks) {
        const cwd = path.resolve(worktree, command.cwd ?? ".");
        assertWithin(worktree, cwd);
        const executable = await resolveExecutable(command.argv[0] ?? "", cwd, environment);
        const result = await runProcess({
            executable: codexExecutable,
            args: [
                "sandbox",
                "--sandbox-state-disable-network",
                "-P",
                ":workspace",
                "-C",
                cwd,
                "--",
                executable,
                ...command.argv.slice(1),
            ],
            cwd,
            env: environment,
            timeoutMs: command.timeoutMs ?? 10 * 60 * 1_000,
            maxOutputBytes: 4 * 1024 * 1024,
        });
        results.push({
            command,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            summary: redactSecrets([result.stdout, result.stderr].filter(Boolean).join("\n")).slice(0, 4_000),
        });
    }
    const after = await workspaceFingerprint(worktree);
    const mutated = before !== after;
    for (const result of results) {
        state = await addEvidence(store, runId, {
            kind: phase,
            status: result.exitCode === 0 && !result.timedOut && !mutated ? "pass" : "fail",
            treeHash: after,
            configHash,
            taskId,
            command: result.command,
            exitCode: result.exitCode,
            summary: mutated
                ? "Verification command changed non-ignored repository content; evidence rejected."
                : result.summary,
        });
    }
    return results.map((result) => mutated ? { ...result, exitCode: result.exitCode === 0 ? -2 : result.exitCode } : result);
}
export async function reviewAndRecordTask(store, runId, taskId, options = {}) {
    const result = await reviewTask(store, runId, taskId, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.commitSha ? { commitSha: options.commitSha } : {}),
        ...(options.finalTree ? { allowCompleted: true } : {}),
    });
    let state = await store.load(runId);
    const task = requireTask(state, taskId);
    const configHash = currentConfigHash(state);
    const acceptanceFindings = result.acceptance.findings;
    const adversarialFindings = result.adversarial.findings;
    const acceptanceBlocked = result.acceptance.verdict !== "approved" || hasBlockingFinding(acceptanceFindings);
    const adversarialBlocked = result.adversarial.verdict !== "approved" || hasBlockingFinding(adversarialFindings);
    state = await addEvidence(store, runId, {
        kind: "review",
        status: acceptanceBlocked ? "blocked" : "approved",
        treeHash: result.treeHash,
        configHash,
        taskId,
        reviewer: "acceptance-auditor",
        findings: acceptanceFindings,
        summary: `Acceptance verdict: ${result.acceptance.verdict}`,
    });
    state = await addEvidence(store, runId, {
        kind: "review",
        status: adversarialBlocked ? "blocked" : "approved",
        treeHash: result.treeHash,
        configHash,
        taskId,
        reviewer: "adversarial-reviewer",
        findings: adversarialFindings,
        summary: `Adversarial verdict: ${result.adversarial.verdict}`,
    });
    const criteria = new Map(result.acceptance.criteria.map((criterion) => [criterion.id, criterion]));
    let criteriaPass = true;
    for (const criterionId of task.acceptanceCriteria) {
        const criterion = criteria.get(criterionId);
        if (criterion?.status !== "pass") {
            criteriaPass = false;
            continue;
        }
        state = await addEvidence(store, runId, {
            kind: "acceptance",
            status: "pass",
            treeHash: result.treeHash,
            configHash,
            taskId,
            criterionId,
            reviewer: "acceptance-auditor",
            summary: criterion.evidence,
        });
    }
    const passed = !acceptanceBlocked && !adversarialBlocked && criteriaPass;
    if (options.finalTree)
        return { passed, findings: [...acceptanceFindings, ...adversarialFindings] };
    if (passed) {
        state = await setTaskStatus(store, runId, taskId, "reviewed");
        await setTaskStatus(store, runId, taskId, "complete");
    }
    else {
        await setTaskStatus(store, runId, taskId, "failed");
    }
    return { passed, findings: [...acceptanceFindings, ...adversarialFindings] };
}
export async function recordIntegratedCommitEvidence(store, runId, worktree) {
    let state = await store.load(runId);
    const treeHash = await workspaceFingerprint(worktree);
    const configHash = currentConfigHash(state);
    for (const task of state.tasks) {
        state = await addEvidence(store, runId, {
            kind: "commit",
            status: "pass",
            treeHash,
            configHash,
            taskId: task.id,
            summary: `Integrated task commit ${task.commitSha ?? "unknown"} into ${state.integrationSha ?? "current tree"}`,
        });
    }
    return state;
}
function hasBlockingFinding(findings) {
    return findings.some((finding) => ["critical", "high", "medium"].includes(finding.severity));
}
async function resolveExecutable(executable, cwd, env) {
    if (!executable || executable.startsWith("-"))
        throw new Error("invalid verification executable");
    if (executable.includes("/") || executable.includes("\\")) {
        const resolved = path.resolve(cwd, executable);
        assertWithin(cwd, resolved);
        return resolved;
    }
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const located = await runProcess({
        executable: locator,
        args: [executable],
        cwd,
        env,
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
    });
    if (located.exitCode !== 0)
        throw new Error(`verification executable not found: ${executable}`);
    const candidates = located.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (process.platform === "win32") {
        const candidate = candidates.find((value) => /\.(?:exe|com|cmd|bat)$/i.test(value));
        if (!candidate)
            throw new Error(`verification executable has no runnable Windows shim: ${executable}`);
        return candidate;
    }
    const candidate = candidates[0];
    if (!candidate)
        throw new Error(`verification executable not found: ${executable}`);
    return candidate;
}
function requireTask(state, taskId) {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task)
        throw new Error(`unknown task: ${taskId}`);
    return task;
}
function requireWorktree(task) {
    if (!task.worktreePath)
        throw new Error(`task ${task.id} has no worktree`);
    return task.worktreePath;
}
//# sourceMappingURL=verification.js.map