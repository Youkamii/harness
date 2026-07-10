import assert from "node:assert/strict";
import test from "node:test";
import { routeLane } from "../runtime/autonomy.js";
import {
  codexArgumentsForTest,
  validateWorkerOutputForTest,
} from "../runtime/codex-worker.js";

test("lane router escalates autonomous and high-risk work", () => {
  assert.equal(routeLane("keep working autonomously until complete"), "autonomous");
  assert.equal(routeLane("migrate the authentication database"), "deep");
  assert.equal(routeLane("fix a typo in docs only"), "fast");
  assert.equal(routeLane("add JSON output"), "build");
});

test("worker arguments enforce least privilege without bypass flags", () => {
  const planner = codexArgumentsForTest("planner", "C:\\repo", "schema.json", "output.json");
  const builder = codexArgumentsForTest("builder", "C:\\repo", "schema.json", "output.json");

  assert.deepEqual(planner.slice(0, 4), ["-a", "never", "-s", "read-only"]);
  assert.deepEqual(builder.slice(0, 4), ["-a", "never", "-s", "workspace-write"]);
  for (const args of [planner, builder]) {
    assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
    assert.equal(args.includes("--dangerously-bypass-hook-trust"), false);
    assert.equal(args.includes("--search"), false);
    assert.equal(args.includes("--ignore-user-config"), true);
    assert.equal(args.includes("--strict-config"), true);
    assert.equal(args.includes("plugins"), true);
    assert.equal(args.includes("multi_agent"), true);
  }
  assert.equal(planner.includes("--ephemeral"), true);
  assert.equal(builder.includes("--ephemeral"), false);
});

test("planner output rejects a dangerous verification executable", () => {
  assert.throws(
    () =>
      validateWorkerOutputForTest("planner", {
        summary: "bad",
        assumptions: [],
        nonGoals: [],
        tasks: [
          {
            id: "bad",
            title: "Bad",
            dependencies: [],
            acceptanceCriteria: ["AC1"],
            ownedPaths: ["src"],
            checks: [{ argv: ["powershell", "-Command", "Remove-Item -Recurse ."] }],
            risk: "high",
          },
        ],
      }),
    /forbidden executable/,
  );
});

test("review output rejects malformed findings", () => {
  assert.throws(
    () =>
      validateWorkerOutputForTest("adversarial-reviewer", {
        verdict: "approved",
        commands: [],
        criteria: [],
        findings: [{ severity: "high", file: "x", line: 0 }],
        residualRisks: [],
      }),
    /malformed/,
  );
});
