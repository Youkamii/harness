import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCompletion } from "../runtime/domain.js";
import { materializeTasks, refreshReadyTasks, validatePlan } from "../runtime/graph.js";

function task(overrides = {}) {
  return {
    id: "foundation",
    title: "Build foundation",
    dependencies: [],
    acceptanceCriteria: ["AC1"],
    ownedPaths: ["src"],
    checks: [{ argv: ["npm", "test"], required: true }],
    risk: "medium",
    ...overrides,
  };
}

test("plan validation rejects missing dependencies", () => {
  assert.throws(
    () => validatePlan([task({ dependencies: ["missing"] })]),
    /missing dependency/,
  );
});

test("plan validation rejects cycles", () => {
  assert.throws(
    () =>
      validatePlan([
        task({ id: "one", dependencies: ["two"], ownedPaths: ["one"] }),
        task({ id: "two", dependencies: ["one"], ownedPaths: ["two"] }),
      ]),
    /cycle/,
  );
});

test("plan validation rejects case-insensitive path overlap", () => {
  assert.throws(
    () =>
      validatePlan([
        task({ id: "one", ownedPaths: ["src/Auth"] }),
        task({ id: "two", ownedPaths: ["SRC/auth/token.ts"] }),
      ]),
    /overlap/,
  );
});

test("dependent tasks become ready after dependencies complete", () => {
  const tasks = materializeTasks([
    task({ id: "one", ownedPaths: ["src/one"] }),
    task({ id: "two", dependencies: ["one"], ownedPaths: ["src/two"] }),
  ]);
  tasks[0].status = "complete";
  const refreshed = refreshReadyTasks(tasks);
  assert.equal(refreshed[1].status, "ready");
});

test("completion rejects agent claims without current evidence", () => {
  const state = {
    schemaVersion: 1,
    id: "11111111-1111-1111-1111-111111111111",
    goal: "finish",
    lane: "build",
    status: "integrating",
    repoRoot: "/repo",
    gitCommonDir: "/repo/.git",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    sequence: 1,
    assumptions: [],
    tasks: [{ ...task(), status: "complete", attempts: 1 }],
    evidence: [],
    issue: {
      number: 1,
      url: "https://example.test/1",
      marker: "marker",
      syncedAt: "2026-07-11T00:00:00.000Z",
      state: "open",
    },
  };
  const result = evaluateCompletion(state, "tree", "config");
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join("\n"), /missing passing verification/);
  assert.match(result.reasons.join("\n"), /acceptance criterion/);
  assert.match(result.reasons.join("\n"), /independent current-tree review/);
});

test("completion requires distinct reviewers and dispositions medium findings", () => {
  const treeHash = "tree";
  const configHash = "config";
  const planned = task();
  const state = {
    schemaVersion: 1,
    id: "11111111-1111-1111-1111-111111111111",
    goal: "finish",
    lane: "build",
    status: "integrating",
    repoRoot: "/repo",
    gitCommonDir: "/repo/.git",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    sequence: 1,
    assumptions: [],
    nonGoals: [],
    tasks: [{
      ...planned,
      status: "complete",
      attempts: 1,
      issue: { number: 1, url: "https://example.test/1", marker: "m", syncedAt: "now", state: "open" },
    }],
    evidence: [
      { id: "v", kind: "verification", status: "pass", treeHash, configHash, recordedAt: "now", taskId: "foundation", command: planned.checks[0], exitCode: 0 },
      { id: "a", kind: "acceptance", status: "pass", treeHash, configHash, recordedAt: "now", taskId: "foundation", criterionId: "AC1" },
      { id: "c", kind: "commit", status: "pass", treeHash, configHash, recordedAt: "now", taskId: "foundation" },
      { id: "r1", kind: "review", status: "approved", treeHash, configHash, recordedAt: "now", reviewer: "same", findings: [{ severity: "medium", file: "x", line: 1, evidence: "risk", confidence: 1, suggestedTest: "test" }] },
      { id: "r2", kind: "review", status: "approved", treeHash, configHash, recordedAt: "now", reviewer: "same", findings: [] },
    ],
    outbox: [],
    attempts: [],
  };
  const result = evaluateCompletion(state, treeHash, configHash);
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join("\n"), /2 independent/);
  assert.match(result.reasons.join("\n"), /medium review findings require dispositions/);
});
