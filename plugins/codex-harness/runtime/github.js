import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./hash.js";
import { beginEffect, completeEffect, setTaskIssue, transitionRun } from "./operations.js";
import { boundedRemoteText, githubControllerEnvironment } from "./redact.js";
import { runChecked } from "./process.js";
export async function syncTaskIssues(store, runId, repoRoot) {
    let state = await store.load(runId);
    if (state.status === "planning")
        state = await transitionRun(store, runId, "issue_sync");
    if (state.status !== "issue_sync") {
        throw new Error(`issue sync requires issue_sync state, got ${state.status}`);
    }
    const repo = await getRepoInfo(repoRoot);
    const issues = await listIssues(repoRoot, repo.nameWithOwner, runId);
    for (const task of state.tasks) {
        if (task.issue?.number)
            continue;
        const marker = markerFor(runId, task.id);
        const { effect } = await beginEffect(store, runId, {
            key: `issue:${task.id}`,
            kind: "github.issue.create",
        });
        const existing = issues.find((issue) => issue.body?.includes(marker));
        const issue = existing
            ? normalizeIssue(existing, marker)
            : await createIssue(store, state, task, repo, marker, effect.id);
        await completeEffect(store, runId, effect.id, {
            number: issue.number,
            url: issue.url,
        });
        state = await setTaskIssue(store, runId, task.id, issue);
        if (!existing) {
            issues.push({
                number: issue.number,
                title: task.title,
                body: marker,
                url: issue.url,
                state: "OPEN",
            });
        }
    }
    return await transitionRun(store, runId, "executing");
}
async function getRepoInfo(repoRoot) {
    const result = await runChecked({
        executable: "gh",
        args: ["repo", "view", "--json", "nameWithOwner,isPrivate,url"],
        cwd: repoRoot,
        env: githubControllerEnvironment(),
    });
    const value = JSON.parse(result.stdout);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.nameWithOwner)) {
        throw new Error("gh returned an invalid repository name");
    }
    return value;
}
async function listIssues(repoRoot, repository, runId) {
    const result = await runChecked({
        executable: "gh",
        args: [
            "issue",
            "list",
            "--repo",
            repository,
            "--state",
            "all",
            "--search",
            `\"codex-harness:run=${runId}\" in:body`,
            "--limit",
            "100",
            "--json",
            "number,title,body,url,state",
        ],
        cwd: repoRoot,
        env: githubControllerEnvironment(),
        maxOutputBytes: 4 * 1024 * 1024,
    });
    const value = JSON.parse(result.stdout);
    return Array.isArray(value) ? value : [];
}
async function createIssue(store, state, task, repo, marker, effectId) {
    const ordinal = state.tasks.findIndex((candidate) => candidate.id === task.id) + 1;
    const body = [
        marker,
        "",
        "## Goal",
        boundedRemoteText(state.goal, repo.isPrivate ? 1_500 : 500),
        "",
        "## Local task reference",
        `- Task ${ordinal} of ${state.tasks.length}`,
        `- Acceptance criteria: ${task.acceptanceCriteria.length} (details remain in the local tamper-evident ledger)`,
        "",
        "## Harness metadata",
        `- Run: ${state.id}`,
        `- Lane: ${state.lane}`,
        "- Completion requires current-tree verification and independent adversarial review.",
    ].join("\n");
    const outbox = path.join(store.root, "outbox");
    await mkdir(outbox, { recursive: true, mode: 0o700 });
    const bodyFile = path.join(outbox, `${effectId}.issue.md`);
    await writeFile(bodyFile, body, { encoding: "utf8", mode: 0o600 });
    try {
        const result = await runChecked({
            executable: "gh",
            args: [
                "issue",
                "create",
                "--repo",
                repo.nameWithOwner,
                "--title",
                `Harness task ${ordinal}: ${boundedRemoteText(state.goal, 80)}`,
                "--body-file",
                bodyFile,
            ],
            cwd: state.repoRoot,
            env: githubControllerEnvironment(),
        });
        const url = result.stdout.trim();
        const number = Number.parseInt(url.split("/").at(-1) ?? "", 10);
        if (!Number.isSafeInteger(number) || number <= 0 || !url.startsWith("https://github.com/")) {
            throw new Error("gh returned an invalid issue URL");
        }
        return {
            number,
            url,
            marker,
            syncedAt: new Date().toISOString(),
            state: "open",
        };
    }
    finally {
        await rm(bodyFile, { force: true });
    }
}
function normalizeIssue(issue, marker) {
    return {
        number: issue.number,
        url: issue.url,
        marker,
        syncedAt: new Date().toISOString(),
        state: issue.state.toLocaleLowerCase("en-US") === "closed" ? "closed" : "open",
    };
}
export function markerFor(runId, taskId) {
    const opaqueTask = sha256(taskId).slice(0, 24);
    return `<!-- codex-harness:run=${runId};task=${opaqueTask} -->`;
}
//# sourceMappingURL=github.js.map