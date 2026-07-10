#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { currentConfigHash, evaluateCompletion, RUN_STATUSES, } from "./domain.js";
import { applyPlan, transitionRun } from "./operations.js";
import { syncTaskIssues } from "./github.js";
import { commitTask, prepareTaskWorktree } from "./git.js";
import { assertWithin, discoverRepo, workspaceFingerprint } from "./repo.js";
import { RunStore } from "./store.js";
const VERSION = "0.1.0";
const lanes = new Set(["fast", "build", "deep", "autonomous"]);
async function main() {
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed.options.has("version") || parsed.command === "version")
        return print(VERSION);
    if (!parsed.command || parsed.options.has("help"))
        return printHelp();
    const cwd = path.resolve(option(parsed, "repo") ?? process.cwd());
    const repo = await discoverRepo(cwd);
    const store = new RunStore(repo.stateRoot);
    await store.initialize();
    switch (parsed.command) {
        case "init":
            return printJson({
                repoRoot: repo.root,
                gitCommonDir: repo.gitCommonDir,
                stateRoot: repo.stateRoot,
            });
        case "start": {
            const goal = requiredOption(parsed, "goal");
            const lane = (option(parsed, "lane") ?? "build");
            if (!lanes.has(lane))
                throw new Error(`invalid lane: ${lane}`);
            const state = await store.create({
                goal,
                lane,
                repoRoot: repo.root,
                gitCommonDir: repo.gitCommonDir,
            });
            return printJson(state);
        }
        case "status": {
            const runId = await resolveRunId(store, parsed);
            return printJson(await store.load(runId));
        }
        case "plan": {
            const runId = await resolveRunId(store, parsed);
            const planPath = path.resolve(repo.root, requiredOption(parsed, "file"));
            assertWithin(repo.root, planPath);
            const value = JSON.parse(await readFile(planPath, "utf8"));
            if (!Array.isArray(value.tasks))
                throw new Error("plan file must contain a tasks array");
            return printJson(await applyPlan(store, runId, value.tasks));
        }
        case "issues": {
            if (parsed.positionals[0] !== "sync")
                throw new Error("usage: issues sync [--run ID]");
            const runId = await resolveRunId(store, parsed);
            return printJson(await syncTaskIssues(store, runId, repo.root));
        }
        case "worktree": {
            const runId = await resolveRunId(store, parsed);
            return printJson(await prepareTaskWorktree(store, runId, requiredOption(parsed, "task")));
        }
        case "commit": {
            const runId = await resolveRunId(store, parsed);
            return printJson(await commitTask(store, runId, requiredOption(parsed, "task"), requiredOption(parsed, "message")));
        }
        case "transition": {
            const runId = await resolveRunId(store, parsed);
            const to = requiredOption(parsed, "to");
            if (!RUN_STATUSES.includes(to))
                throw new Error(`invalid run status: ${to}`);
            const treeHash = to === "complete" ? await workspaceFingerprint(repo.root) : undefined;
            return printJson(await transitionRun(store, runId, to, treeHash ? { treeHash } : {}));
        }
        case "gate": {
            const runId = await resolveRunId(store, parsed);
            const state = await store.load(runId);
            const treeHash = await workspaceFingerprint(repo.root);
            const result = evaluateCompletion(state, treeHash, currentConfigHash(state));
            printJson({ ...result, runId, treeHash });
            if (!result.allowed)
                process.exitCode = 2;
            return;
        }
        default:
            throw new Error(`unknown command: ${parsed.command}`);
    }
}
function parseArguments(args) {
    const options = new Map();
    const positionals = [];
    let command;
    for (let index = 0; index < args.length; index += 1) {
        const value = args[index];
        if (value === undefined)
            continue;
        if (value.startsWith("--")) {
            const [rawName, inlineValue] = value.slice(2).split("=", 2);
            if (!rawName)
                throw new Error("empty option name");
            const values = options.get(rawName) ?? [];
            if (inlineValue !== undefined)
                values.push(inlineValue);
            else if (args[index + 1] !== undefined && !args[index + 1]?.startsWith("--")) {
                values.push(args[index + 1] ?? "");
                index += 1;
            }
            else
                values.push("true");
            options.set(rawName, values);
        }
        else if (!command)
            command = value;
        else
            positionals.push(value);
    }
    return { ...(command ? { command } : {}), positionals, options };
}
function option(parsed, name) {
    return parsed.options.get(name)?.at(-1);
}
function requiredOption(parsed, name) {
    const value = option(parsed, name);
    if (!value || value === "true")
        throw new Error(`--${name} is required`);
    return value;
}
async function resolveRunId(store, parsed) {
    const runId = option(parsed, "run") ?? (await store.currentRunId());
    if (!runId)
        throw new Error("no current run; use start first");
    return runId;
}
function print(value) {
    process.stdout.write(value + "\n");
}
function printJson(value) {
    print(JSON.stringify(value, null, 2));
}
function printHelp() {
    print([
        "Codex Harness",
        "",
        "Usage: codex-harness <command> [options]",
        "",
        "Commands:",
        "  init [--repo PATH]",
        "  start --goal TEXT [--lane fast|build|deep|autonomous]",
        "  status [--run ID]",
        "  plan --file PLAN.json [--run ID]",
        "  issues sync [--run ID]",
        "  worktree --task TASK [--run ID]",
        "  commit --task TASK --message TEXT [--run ID]",
        "  transition --to STATUS [--run ID]",
        "  gate [--run ID]",
    ].join("\n"));
}
main().catch((error) => {
    process.stderr.write(`codex-harness: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map