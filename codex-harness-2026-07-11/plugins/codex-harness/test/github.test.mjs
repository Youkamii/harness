import assert from "node:assert/strict";
import test from "node:test";
import { markerFor, renderTaskIssueBody } from "../runtime/github.js";

function state(mode) {
  const task = {
    id: "feature",
    title: "Feature",
    dependencies: [],
    acceptanceCriteria: ["requested behavior works"],
    ownedPaths: ["src/feature.ts"],
    checks: [{ argv: ["npm", "test"] }],
    risk: "medium",
    status: "ready",
    attempts: 0,
  };
  return {
    value: {
      schemaVersion: 1,
      id: "11111111-1111-1111-1111-111111111111",
      goal: "Implement only the requested feature",
      lane: "build",
      ...(mode ? { mode } : {}),
      status: "planning",
      repoRoot: "/repo",
      gitCommonDir: "/repo/.git",
      createdAt: "now",
      updatedAt: "now",
      sequence: 1,
      assumptions: [],
      nonGoals: [],
      tasks: [task],
      evidence: [],
      outbox: [],
      attempts: [],
    },
    task,
  };
}

test("GitHub task metadata displays the effective run mode", () => {
  const tough = state("tough");
  const toughBody = renderTaskIssueBody(tough.value, tough.task, true);
  assert.match(toughBody, /- Mode: tough/);
  assert.match(toughBody, new RegExp(markerFor(tough.value.id, tough.task.id)));

  const legacy = state();
  const legacyBody = renderTaskIssueBody(legacy.value, legacy.task, false);
  assert.match(legacyBody, /- Mode: standard/);
});
