import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { currentConfigHash } from "./domain.js";
import { assertSafeGitConfiguration } from "./git-policy.js";
import { beginEffect, clearTaskWorktree, completeEffect, recordRunBase, recordTaskCommit, setTaskStatus, setTaskWorktree, } from "./operations.js";
import { containsLikelySecret, boundedRemoteText, sanitizedEnvironment } from "./redact.js";
import { runChecked, runProcess } from "./process.js";
import { workspaceFingerprint } from "./repo.js";
export async function prepareTaskWorktree(store, runId, taskId) {
    let state = await store.load(runId);
    if (state.status !== "executing") {
        throw new Error(`worktree preparation requires executing state, got ${state.status}`);
    }
    let task = requireTask(state, taskId);
    await assertSafeGitConfiguration(state.repoRoot);
    if (!task.issue?.number)
        throw new Error(`task ${taskId} has no GitHub issue`);
    if (task.worktreePath && task.branch) {
        return task.status === "ready" ? await setTaskStatus(store, runId, taskId, "running") : state;
    }
    if (task.status !== "ready")
        throw new Error(`task ${taskId} is not ready`);
    const branch = `forge/${task.issue.number}-${slug(task.id)}`;
    await runChecked({
        executable: "git",
        args: ["check-ref-format", "--branch", branch],
        cwd: state.repoRoot,
    });
    if (!state.baseSha) {
        const discoveredBase = (await runChecked({ executable: "git", args: ["rev-parse", "HEAD"], cwd: state.repoRoot })).stdout.trim();
        state = await recordRunBase(store, runId, discoveredBase);
        task = requireTask(state, taskId);
    }
    const runBaseSha = state.baseSha;
    if (!runBaseSha)
        throw new Error("run base SHA is missing");
    const worktreePath = path.resolve(path.dirname(state.repoRoot), `${path.basename(state.repoRoot)}.codex-harness-worktrees`, runId, task.id);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    const hooks = await hooklessDirectory(store);
    const exists = await pathExists(worktreePath);
    if (!exists) {
        const branchExists = await runProcess({
            executable: "git",
            args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
            cwd: state.repoRoot,
        });
        const args = branchExists.exitCode === 0
            ? ["-c", `core.hooksPath=${hooks}`, "worktree", "add", worktreePath, branch]
            : ["-c", `core.hooksPath=${hooks}`, "worktree", "add", "-b", branch, worktreePath, runBaseSha];
        await runChecked({
            executable: "git",
            args,
            cwd: state.repoRoot,
            env: sanitizedEnvironment(),
            timeoutMs: 60_000,
        });
    }
    else {
        await runChecked({
            executable: "git",
            args: ["rev-parse", "--is-inside-work-tree"],
            cwd: worktreePath,
        });
        const actualBranch = (await runChecked({
            executable: "git",
            args: ["branch", "--show-current"],
            cwd: worktreePath,
        })).stdout.trim();
        if (actualBranch !== branch) {
            throw new Error(`existing worktree uses ${actualBranch}, expected ${branch}`);
        }
    }
    await recoverInterruptedCherryPick(store, worktreePath);
    for (const dependency of dependencyClosure(state, task)) {
        for (const commit of await taskCommits(state.repoRoot, dependency)) {
            const effectId = await effectForCommit(state.repoRoot, commit, dependency.id);
            if (await commitForEffect(worktreePath, runBaseSha, effectId))
                continue;
            const result = await runProcess({
                executable: "git",
                args: ["-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgSign=false", "cherry-pick", commit],
                cwd: worktreePath,
                env: sanitizedEnvironment(),
                timeoutMs: 120_000,
                maxOutputBytes: 4 * 1024 * 1024,
            });
            if (result.exitCode !== 0) {
                await runProcess({
                    executable: "git",
                    args: ["-c", `core.hooksPath=${hooks}`, "cherry-pick", "--abort"],
                    cwd: worktreePath,
                    env: sanitizedEnvironment(),
                });
                throw new Error(`dependency integration conflict for ${taskId}/${dependency.id}`);
            }
        }
    }
    const taskBaseSha = (await runChecked({ executable: "git", args: ["rev-parse", "HEAD"], cwd: worktreePath })).stdout.trim();
    state = await setTaskWorktree(store, runId, taskId, { branch, worktreePath, baseSha: taskBaseSha });
    return await setTaskStatus(store, runId, taskId, "running");
}
export async function commitTask(store, runId, taskId, message) {
    let state = await store.load(runId);
    let task = requireTask(state, taskId);
    await assertSafeGitConfiguration(state.repoRoot);
    if (!task.worktreePath || !task.issue?.number) {
        throw new Error(`task ${taskId} has no prepared worktree or issue`);
    }
    const { effect } = await beginEffect(store, runId, {
        key: `commit:${taskId}:${task.attempts}`,
        kind: "git.commit",
    });
    state = await store.load(runId);
    task = requireTask(state, taskId);
    if (!task.worktreePath || !task.issue?.number) {
        throw new Error(`task ${taskId} lost its prepared worktree or issue`);
    }
    const worktreePath = task.worktreePath;
    const issueNumber = task.issue.number;
    if (task.commitSha) {
        if (effect.status !== "complete") {
            return await completeEffect(store, runId, effect.id, { commitSha: task.commitSha });
        }
        return state;
    }
    const existing = await findExistingCommit(worktreePath, effect.id);
    const treeHash = await workspaceFingerprint(worktreePath);
    const configHash = currentConfigHash(state);
    assertTaskCommitEvidence(state, task, treeHash, configHash);
    let commitSha = existing;
    if (!commitSha) {
        const changed = await changedPaths(worktreePath);
        await assertSafeGitConfiguration(worktreePath, changed);
        const unexpected = changed.filter((candidate) => !isOwned(candidate, task.ownedPaths));
        if (unexpected.length > 0) {
            throw new Error(`task modified unowned paths: ${unexpected.join(", ")}`);
        }
        if (changed.length === 0)
            throw new Error(`task ${taskId} has no changes to commit`);
        await runChecked({
            executable: "git",
            args: ["add", "--", ...task.ownedPaths],
            cwd: worktreePath,
        });
        const staged = await stagedPaths(worktreePath);
        if (staged.length === 0)
            throw new Error("no task-owned changes were staged");
        const stagedUnexpected = staged.filter((candidate) => !isOwned(candidate, task.ownedPaths));
        if (stagedUnexpected.length > 0) {
            throw new Error(`staged paths exceed task ownership: ${stagedUnexpected.join(", ")}`);
        }
        const stagedDiff = (await runChecked({
            executable: "git",
            args: ["diff", "--cached", "--no-ext-diff", "--"],
            cwd: worktreePath,
            maxOutputBytes: 8 * 1024 * 1024,
        })).stdout;
        if (containsLikelySecret(stagedDiff))
            throw new Error("staged diff contains a likely secret");
        const outbox = path.join(store.root, "outbox");
        await mkdir(outbox, { recursive: true, mode: 0o700 });
        const messageFile = path.join(outbox, `${effect.id}.commit.txt`);
        const body = [
            boundedRemoteText(message, 100),
            "",
            `Refs #${issueNumber}`,
            "",
            `Harness-Run: ${runId}`,
            `Harness-Task: ${taskId}`,
            `Harness-Issue: ${issueNumber}`,
            `Harness-Effect: ${effect.id}`,
        ].join("\n");
        await writeFile(messageFile, body, { encoding: "utf8", mode: 0o600 });
        try {
            const hooks = await hooklessDirectory(store);
            await runChecked({
                executable: "git",
                args: ["-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgSign=false", "commit", "-F", messageFile],
                cwd: worktreePath,
                env: sanitizedEnvironment(),
                timeoutMs: 120_000,
            });
        }
        finally {
            await rm(messageFile, { force: true });
        }
        commitSha = (await runChecked({
            executable: "git",
            args: ["rev-parse", "HEAD"],
            cwd: worktreePath,
        })).stdout.trim();
        const after = await workspaceFingerprint(worktreePath);
        if (after !== treeHash) {
            throw new Error("commit hooks changed the verified tree; fresh verification is required");
        }
    }
    if (!commitSha)
        throw new Error("commit did not produce a SHA");
    state = await recordTaskCommit(store, runId, taskId, commitSha, {
        kind: "commit",
        status: "pass",
        treeHash,
        configHash,
        taskId,
        summary: `Committed ${commitSha}`,
    });
    return await completeEffect(store, runId, effect.id, { commitSha });
}
export async function discardTaskWorktree(store, runId, taskId) {
    const state = await store.load(runId);
    const task = requireTask(state, taskId);
    const issueNumber = task.issue?.number;
    if (!issueNumber)
        throw new Error(`task ${taskId} has no issue`);
    const expectedBranch = `forge/${issueNumber}-${slug(task.id)}`;
    const expectedPath = path.resolve(path.dirname(state.repoRoot), `${path.basename(state.repoRoot)}.codex-harness-worktrees`, runId, task.id);
    if (task.branch && task.branch !== expectedBranch)
        throw new Error("unexpected task branch");
    if (task.worktreePath && path.resolve(task.worktreePath) !== expectedPath) {
        throw new Error("unexpected task worktree path");
    }
    const hooks = await hooklessDirectory(store);
    if (await pathExists(expectedPath)) {
        await runChecked({
            executable: "git",
            args: ["-c", `core.hooksPath=${hooks}`, "worktree", "remove", "--force", expectedPath],
            cwd: state.repoRoot,
            env: sanitizedEnvironment(),
            timeoutMs: 120_000,
        });
    }
    const branchExists = await runProcess({
        executable: "git",
        args: ["show-ref", "--verify", "--quiet", `refs/heads/${expectedBranch}`],
        cwd: state.repoRoot,
        env: sanitizedEnvironment(),
    });
    if (branchExists.exitCode === 0) {
        await runChecked({
            executable: "git",
            args: ["branch", "-D", expectedBranch],
            cwd: state.repoRoot,
            env: sanitizedEnvironment(),
        });
    }
    return await clearTaskWorktree(store, runId, taskId);
}
function dependencyClosure(state, task) {
    const byId = new Map(state.tasks.map((candidate) => [candidate.id, candidate]));
    const emitted = new Set();
    const result = [];
    const visit = (taskId) => {
        const dependency = byId.get(taskId);
        if (!dependency)
            throw new Error(`missing dependency task ${taskId}`);
        for (const nested of dependency.dependencies)
            visit(nested);
        if (emitted.has(dependency.id))
            return;
        if (dependency.status !== "complete" || !dependency.commitSha || !dependency.baseSha) {
            throw new Error(`dependency ${dependency.id} is not complete and committed`);
        }
        emitted.add(dependency.id);
        result.push(dependency);
    };
    for (const dependency of task.dependencies)
        visit(dependency);
    return result;
}
async function taskCommits(repoRoot, task) {
    const result = await runChecked({
        executable: "git",
        args: ["rev-list", "--reverse", `${task.baseSha}..${task.commitSha}`],
        cwd: repoRoot,
    });
    return result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}
async function effectForCommit(repoRoot, commit, taskId) {
    const body = (await runChecked({ executable: "git", args: ["show", "-s", "--format=%B", commit], cwd: repoRoot })).stdout;
    if (!body.includes(`Harness-Task: ${taskId}`))
        throw new Error(`dependency commit ${commit} has wrong task trailer`);
    const effectId = body.match(/^Harness-Effect:\s*([0-9a-f-]{36})\s*$/im)?.[1];
    if (!effectId)
        throw new Error(`dependency commit ${commit} lacks an effect trailer`);
    return effectId;
}
async function commitForEffect(worktreePath, runBaseSha, effectId) {
    const result = await runChecked({
        executable: "git",
        args: ["log", `${runBaseSha}..HEAD`, "--format=%H%x1f%B%x1e", "--grep", `Harness-Effect: ${effectId}`, "--fixed-strings"],
        cwd: worktreePath,
    });
    for (const record of result.stdout.split("\u001e")) {
        const [sha, body = ""] = record.split("\u001f", 2);
        if (body.includes(`Harness-Effect: ${effectId}`) && /^[0-9a-f]{40,64}$/i.test(sha?.trim() ?? "")) {
            return sha?.trim();
        }
    }
    return undefined;
}
async function recoverInterruptedCherryPick(store, worktreePath) {
    const interrupted = await runProcess({
        executable: "git",
        args: ["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"],
        cwd: worktreePath,
        env: sanitizedEnvironment(),
    });
    if (interrupted.exitCode !== 0)
        return;
    const hooks = await hooklessDirectory(store);
    await runChecked({
        executable: "git",
        args: ["-c", `core.hooksPath=${hooks}`, "cherry-pick", "--abort"],
        cwd: worktreePath,
        env: sanitizedEnvironment(),
    });
}
async function hooklessDirectory(store) {
    const directory = path.join(store.root, "disabled-git-hooks");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
}
function assertTaskCommitEvidence(state, task, treeHash, configHash) {
    if (task.status !== "verifying")
        throw new Error(`task ${task.id} must be verifying before commit`);
    const evidence = state.evidence.filter((record) => record.taskId === task.id &&
        record.treeHash === treeHash &&
        record.configHash === configHash);
    for (const check of task.checks.filter((candidate) => candidate.required !== false)) {
        if (!evidence.some((record) => record.kind === "verification" &&
            record.status === "pass" &&
            record.exitCode === 0 &&
            record.command !== undefined &&
            JSON.stringify(record.command.argv) === JSON.stringify(check.argv) &&
            (record.command.cwd ?? "") === (check.cwd ?? ""))) {
            throw new Error(`missing verification evidence for ${task.id}/${check.argv.join(" ")}`);
        }
    }
}
async function findExistingCommit(worktreePath, effectId) {
    const result = await runChecked({
        executable: "git",
        args: [
            "log",
            "--all",
            "--format=%H%x1f%B%x1e",
            "--grep",
            `Harness-Effect: ${effectId}`,
            "--fixed-strings",
        ],
        cwd: worktreePath,
    });
    for (const record of result.stdout.split("\u001e")) {
        const [sha, body = ""] = record.split("\u001f", 2);
        if (body.includes(`Harness-Effect: ${effectId}`) && /^[0-9a-f]{40,64}$/.test(sha?.trim() ?? "")) {
            return sha?.trim();
        }
    }
    return undefined;
}
async function changedPaths(worktreePath) {
    const result = await runChecked({
        executable: "git",
        args: ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        cwd: worktreePath,
    });
    return parsePorcelainPaths(result.stdout);
}
async function stagedPaths(worktreePath) {
    const result = await runChecked({
        executable: "git",
        args: ["diff", "--cached", "--name-only", "-z", "--"],
        cwd: worktreePath,
    });
    return result.stdout.split("\u0000").filter(Boolean);
}
function parsePorcelainPaths(value) {
    const records = value.split("\u0000").filter(Boolean);
    const paths = [];
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index] ?? "";
        const status = record.slice(0, 2);
        const candidate = record.slice(3);
        if (candidate)
            paths.push(candidate);
        if (status.includes("R") || status.includes("C")) {
            const second = records[index + 1];
            if (second)
                paths.push(second);
            index += 1;
        }
    }
    return [...new Set(paths)];
}
function isOwned(candidate, ownedPaths) {
    const normalized = candidate.replaceAll("\\", "/").toLocaleLowerCase("en-US");
    return ownedPaths.some((ownedPath) => {
        const owned = ownedPath.replaceAll("\\", "/").replace(/\/$/, "").toLocaleLowerCase("en-US");
        return normalized === owned || normalized.startsWith(owned + "/");
    });
}
function slug(value) {
    const result = value
        .toLocaleLowerCase("en-US")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48);
    return result || "task";
}
function requireTask(state, taskId) {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task)
        throw new Error(`unknown task: ${taskId}`);
    return task;
}
async function pathExists(candidate) {
    try {
        await stat(candidate);
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
//# sourceMappingURL=git.js.map