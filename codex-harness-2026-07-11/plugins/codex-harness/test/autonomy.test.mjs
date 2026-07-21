import assert from "node:assert/strict";
import test from "node:test";
import { routeLane, runModeInstructions } from "../runtime/autonomy.js";
import {
  codexArgumentsForTest,
  validateWorkerOutputForTest,
  workerReportForTest,
} from "../runtime/codex-worker.js";

test("lane router escalates autonomous and high-risk work", () => {
  assert.equal(routeLane("keep working autonomously until complete"), "autonomous");
  assert.equal(routeLane("migrate the authentication database"), "deep");
  assert.equal(routeLane("fix a typo in docs only"), "fast");
  assert.equal(routeLane("add JSON output"), "build");
});

test("tough worker prompts enforce scope without weakening existing protections", () => {
  assert.deepEqual(runModeInstructions("standard", "builder"), []);
  for (const role of ["planner", "builder", "reviewer"]) {
    const prompt = runModeInstructions("tough", role).join("\n");
    assert.match(prompt, /absent from the user request and established repository contracts/i);
    assert.match(prompt, /not globally forbidden mechanisms/i);
    assert.match(prompt, /never remove or weaken existing protections/i);
    assert.match(prompt, /preserve the protection.*exact blocker or concern/i);
  }
  assert.match(
    runModeInstructions("tough", "builder").join("\n"),
    /report it in the structured summary without implementing/i,
  );
  assert.match(
    runModeInstructions("tough", "reviewer").join("\n"),
    /do not fail.*solely because an unrequested safeguard is absent/i,
  );
  assert.match(
    runModeInstructions("tough", "reviewer").join("\n"),
    /repository already requires.*blocking finding rather than a residual risk/i,
  );
  assert.match(
    runModeInstructions("tough", "planner").join("\n"),
    /at most 19 non-goals/i,
  );
});

test("tough worker reports retain summaries and residual concerns", () => {
  assert.deepEqual(
    workerReportForTest("builder", {
      status: "implemented",
      summary: "An unrequested trading cap was not implemented and remains a concern.",
      changedPaths: [],
      checksAttempted: [],
      blockers: [],
    }),
    { summary: "An unrequested trading cap was not implemented and remains a concern." },
  );

  assert.deepEqual(
    workerReportForTest("adversarial-reviewer", {
      verdict: "approved",
      commands: [],
      criteria: [],
      findings: [],
      residualRisks: ["No user-requested trading cap exists.", "No user-requested trading cap exists."],
    }),
    { residualRisks: ["No user-requested trading cap exists."] },
  );
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

test("planner output rejects task contracts that reviewers cannot represent", () => {
  const output = {
    summary: "oversized",
    assumptions: [],
    nonGoals: [],
    tasks: [
      {
        id: "oversized",
        title: "Oversized acceptance criterion",
        dependencies: [],
        acceptanceCriteria: ["x".repeat(201)],
        ownedPaths: ["src/oversized"],
        checks: [{ argv: ["node", "--version"] }],
        risk: "low",
      },
    ],
  };

  assert.throws(
    () => validateWorkerOutputForTest("planner", output),
    /longer than 200 characters/,
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
  assert.throws(
    () =>
      validateWorkerOutputForTest("adversarial-reviewer", {
        verdict: "approved",
        commands: [],
        criteria: [],
        findings: [],
        residualRisks: [42],
      }),
    /review output is incomplete/,
  );
});
