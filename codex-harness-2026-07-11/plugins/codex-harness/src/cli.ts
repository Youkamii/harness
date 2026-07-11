#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  currentConfigHash,
  evaluateCompletion,
  RUN_STATUSES,
  type Lane,
  type PlannedTask,
  type RunStatus,
} from "./domain.js";
import { applyPlan, transitionRun } from "./operations.js";
import { syncTaskIssues } from "./github.js";
import { commitTask, prepareTaskWorktree } from "./git.js";
import { buildTask, planRun, reviewTask, routeLane } from "./autonomy.js";
import { resumeAutonomously, runAutonomously } from "./orchestrator.js";
import { runDoctor } from "./doctor.js";
import { assertWithin, discoverRepo, workspaceFingerprint } from "./repo.js";
import { RunStore } from "./store.js";

const VERSION = "0.1.0";
const lanes = new Set<Lane>(["fast", "build", "deep", "autonomous"]);

interface ParsedArguments {
  command?: string;
  positionals: string[];
  options: Map<string, string[]>;
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.options.has("version") || parsed.command === "version") return print(VERSION);
  if (!parsed.command || parsed.options.has("help")) return printHelp();

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
    case "doctor": {
      const result = await runDoctor(repo.root);
      printJson(result);
      if (!result.passed) process.exitCode = 2;
      return;
    }
    case "start": {
      const goal = requiredOption(parsed, "goal");
      const lane = (option(parsed, "lane") ?? routeLane(goal)) as Lane;
      if (!lanes.has(lane)) throw new Error(`invalid lane: ${lane}`);
      const state = await store.create({
        goal,
        lane,
        repoRoot: repo.root,
        gitCommonDir: repo.gitCommonDir,
      });
      return printJson(state);
    }
    case "auto": {
      const goal = requiredOption(parsed, "goal");
      const lane = (option(parsed, "lane") ?? routeLane(goal)) as Lane;
      if (!lanes.has(lane)) throw new Error(`invalid lane: ${lane}`);
      const reusable = await store.createOrReuse({
        goal,
        lane,
        repoRoot: repo.root,
        gitCommonDir: repo.gitCommonDir,
      });
      return printJson(
        await (reusable.status === "blocked"
          ? resumeAutonomously(store, reusable.id)
          : runAutonomously(store, reusable.id)),
      );
    }
    case "resume": {
      const runId = await resolveRunId(store, parsed);
      return printJson(await resumeAutonomously(store, runId));
    }
    case "status": {
      const runId = await resolveRunId(store, parsed);
      return printJson(await store.load(runId));
    }
    case "route": {
      const goal = requiredOption(parsed, "goal");
      return printJson({ lane: routeLane(goal) });
    }
    case "agent-plan": {
      const runId = await resolveRunId(store, parsed);
      return printJson(
        await store.withRunLease(runId, async () => await planRun(store, await store.load(runId))),
      );
    }
    case "agent-build": {
      const runId = await resolveRunId(store, parsed);
      return printJson(
        await store.withRunLease(
          runId,
          async () => await buildTask(store, runId, requiredOption(parsed, "task")),
        ),
      );
    }
    case "agent-review": {
      const runId = await resolveRunId(store, parsed);
      return printJson(
        await store.withRunLease(
          runId,
          async () => await reviewTask(store, runId, requiredOption(parsed, "task")),
        ),
      );
    }
    case "plan": {
      const runId = await resolveRunId(store, parsed);
      const planPath = path.resolve(repo.root, requiredOption(parsed, "file"));
      assertWithin(repo.root, planPath);
      const value = JSON.parse(await readFile(planPath, "utf8")) as { tasks?: PlannedTask[] };
      if (!Array.isArray(value.tasks)) throw new Error("plan file must contain a tasks array");
      return printJson(
        await store.withRunLease(runId, async () => await applyPlan(store, runId, value.tasks ?? [])),
      );
    }
    case "issues": {
      if (parsed.positionals[0] !== "sync") throw new Error("usage: issues sync [--run ID]");
      const runId = await resolveRunId(store, parsed);
      return printJson(
        await store.withRunLease(runId, async () => await syncTaskIssues(store, runId, repo.root)),
      );
    }
    case "worktree": {
      const runId = await resolveRunId(store, parsed);
      return printJson(
        await store.withRunLease(
          runId,
          async () => await prepareTaskWorktree(store, runId, requiredOption(parsed, "task")),
        ),
      );
    }
    case "commit": {
      const runId = await resolveRunId(store, parsed);
      return printJson(await store.withRunLease(runId, async () =>
        await commitTask(
          store,
          runId,
          requiredOption(parsed, "task"),
          requiredOption(parsed, "message"),
        )));
    }
    case "transition": {
      const runId = await resolveRunId(store, parsed);
      const to = requiredOption(parsed, "to") as RunStatus;
      if (!RUN_STATUSES.includes(to)) throw new Error(`invalid run status: ${to}`);
      return printJson(
        await store.withRunLease(
          runId,
          async () => {
            const state = await store.load(runId);
            const treeRoot = state.integrationWorktreePath ?? repo.root;
            const treeHash = to === "complete" ? await workspaceFingerprint(treeRoot) : undefined;
            return await transitionRun(store, runId, to, treeHash ? { treeHash } : {});
          },
        ),
      );
    }
    case "gate": {
      const runId = await resolveRunId(store, parsed);
      const state = await store.load(runId);
      const treeHash = await workspaceFingerprint(state.integrationWorktreePath ?? repo.root);
      const result = evaluateCompletion(state, treeHash, currentConfigHash(state));
      printJson({ ...result, runId, treeHash });
      if (!result.allowed) process.exitCode = 2;
      return;
    }
    default:
      throw new Error(`unknown command: ${parsed.command}`);
  }
}

function parseArguments(args: string[]): ParsedArguments {
  const options = new Map<string, string[]>();
  const positionals: string[] = [];
  let command: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === undefined) continue;
    if (value.startsWith("--")) {
      const [rawName, inlineValue] = value.slice(2).split("=", 2);
      if (!rawName) throw new Error("empty option name");
      const values = options.get(rawName) ?? [];
      if (inlineValue !== undefined) values.push(inlineValue);
      else if (args[index + 1] !== undefined && !args[index + 1]?.startsWith("--")) {
        values.push(args[index + 1] ?? "");
        index += 1;
      } else values.push("true");
      options.set(rawName, values);
    } else if (!command) command = value;
    else positionals.push(value);
  }
  return { ...(command ? { command } : {}), positionals, options };
}

function option(parsed: ParsedArguments, name: string): string | undefined {
  return parsed.options.get(name)?.at(-1);
}

function requiredOption(parsed: ParsedArguments, name: string): string {
  const value = option(parsed, name);
  if (!value || value === "true") throw new Error(`--${name} is required`);
  return value;
}

async function resolveRunId(store: RunStore, parsed: ParsedArguments): Promise<string> {
  const runId = option(parsed, "run") ?? (await store.currentRunId());
  if (!runId) throw new Error("no current run; use start first");
  return runId;
}

function print(value: string): void {
  process.stdout.write(value + "\n");
}

function printJson(value: unknown): void {
  print(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  print(
    [
      "Codex Harness",
      "",
      "Usage: codex-harness <command> [options]",
      "",
      "Commands:",
      "  init [--repo PATH]",
      "  doctor [--repo PATH]",
      "  start --goal TEXT [--lane fast|build|deep|autonomous]",
      "  auto --goal TEXT [--lane fast|build|deep|autonomous]",
      "  resume [--run ID]",
      "  status [--run ID]",
      "  route --goal TEXT",
      "  agent-plan [--run ID]",
      "  agent-build --task TASK [--run ID]",
      "  agent-review --task TASK [--run ID]",
      "  plan --file PLAN.json [--run ID]",
      "  issues sync [--run ID]",
      "  worktree --task TASK [--run ID]",
      "  commit --task TASK --message TEXT [--run ID]",
      "  transition --to STATUS [--run ID]",
      "  gate [--run ID]",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`codex-harness: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
