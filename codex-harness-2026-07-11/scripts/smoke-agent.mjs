import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCodexWorker } from "../plugins/codex-harness/runtime/codex-worker.js";
import { discoverRepo } from "../plugins/codex-harness/runtime/repo.js";
import { RunStore } from "../plugins/codex-harness/runtime/store.js";

const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-harness-agent-smoke-"));
const repo = path.join(temporary, "repo");
await mkdir(repo);

function git(...args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(result.stderr.trim());
}

try {
  git("init", "-b", "main");
  git("config", "user.name", "Codex Harness Smoke");
  git("config", "user.email", "harness@example.test");
  await writeFile(path.join(repo, "README.md"), "smoke fixture\n", "utf8");
  git("add", "--", "README.md");
  git("commit", "-m", "fixture");

  const context = await discoverRepo(repo);
  const store = new RunStore(context.stateRoot);
  const state = await store.create({
    goal: "Plan one bounded README update without editing files",
    lane: "build",
    repoRoot: context.root,
    gitCommonDir: context.gitCommonDir,
  });
  const output = await runCodexWorker({
    store,
    runId: state.id,
    role: "planner",
    cwd: context.root,
    prompt: [
      "Read the repository without editing it.",
      "Return the required JSON plan with exactly one task.",
      "Use task id docs, owned path README.md, one acceptance criterion, and check argv [\"node\",\"--version\"]. Set that check's cwd, timeoutMs, and required fields to null.",
      "Include at least one explicit non-goal.",
    ].join("\n"),
  });
  assert.equal(output.tasks.length, 1);
  assert.equal(output.tasks[0].id, "docs");
  assert.deepEqual(output.tasks[0].checks[0].argv, ["node", "--version"]);
  process.stdout.write(JSON.stringify({ passed: true, task: output.tasks[0].id }, null, 2) + "\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
