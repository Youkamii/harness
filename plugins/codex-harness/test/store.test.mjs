import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyPlan, setTaskStatus } from "../runtime/operations.js";
import { RunStore } from "../runtime/store.js";

async function withTempStore(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-harness-store-"));
  try {
    return await callback(new RunStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function plan() {
  return [
    {
      id: "one",
      title: "One",
      dependencies: [],
      acceptanceCriteria: ["AC1"],
      ownedPaths: ["src/one"],
      checks: [{ argv: ["node", "--version"] }],
      risk: "low",
    },
    {
      id: "two",
      title: "Two",
      dependencies: ["one"],
      acceptanceCriteria: ["AC2"],
      ownedPaths: ["src/two"],
      checks: [{ argv: ["node", "--version"] }],
      risk: "low",
    },
  ];
}

test("store persists runs outside a worktree and replays the hash chain", async () => {
  await withTempStore(async (store, root) => {
    const created = await store.create({
      goal: "test",
      lane: "build",
      repoRoot: "C:\\repo",
      gitCommonDir: "C:\\repo\\.git",
    });
    const planned = await applyPlan(store, created.id, plan());
    assert.equal(planned.tasks[0].status, "ready");
    assert.equal(planned.tasks[1].status, "pending");

    let state = await setTaskStatus(store, created.id, "one", "running");
    state = await setTaskStatus(store, created.id, "one", "verifying");
    state = await setTaskStatus(store, created.id, "one", "committed");
    state = await setTaskStatus(store, created.id, "one", "reviewed");
    state = await setTaskStatus(store, created.id, "one", "complete");
    assert.equal(state.tasks[1].status, "ready");

    const loaded = await store.load(created.id);
    assert.equal(loaded.sequence, state.sequence);
    assert.equal(loaded.repoRoot, "C:\\repo");
    assert.match(path.join(root, "runs", created.id), new RegExp(created.id));
  });
});

test("store rejects a modified journal", async () => {
  await withTempStore(async (store, root) => {
    const created = await store.create({
      goal: "tamper",
      lane: "fast",
      repoRoot: "/repo",
      gitCommonDir: "/repo/.git",
    });
    const journal = path.join(root, "runs", created.id, "events.jsonl");
    const original = await readFile(journal, "utf8");
    await writeFile(journal, original.replace('"goal":"tamper"', '"goal":"owned"'), "utf8");
    await assert.rejects(() => store.load(created.id), /hash mismatch/);
  });
});

test("store recovers a snapshot that lags the journal", async () => {
  await withTempStore(async (store, root) => {
    const created = await store.create({
      goal: "recover",
      lane: "build",
      repoRoot: "/repo",
      gitCommonDir: "/repo/.git",
    });
    const planned = await applyPlan(store, created.id, plan());
    const snapshot = path.join(root, "runs", created.id, "snapshot.json");
    await writeFile(snapshot, JSON.stringify(created), "utf8");

    const recovered = await store.load(created.id);
    assert.equal(recovered.sequence, planned.sequence);
    assert.equal(recovered.tasks.length, 2);
    const persisted = JSON.parse(await readFile(snapshot, "utf8"));
    assert.equal(persisted.sequence, planned.sequence);
  });
});

test("store serializes concurrent agent updates without losing events", async () => {
  await withTempStore(async (store) => {
    const created = await store.create({
      goal: "parallel review",
      lane: "deep",
      repoRoot: "/repo",
      gitCommonDir: "/repo/.git",
    });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.update(
          created.id,
          "test.concurrent",
          (state) => {
            state.assumptions.push(`agent-${index}`);
            return state;
          },
          { index },
        ),
      ),
    );
    const state = await store.load(created.id);
    assert.equal(state.assumptions.length, 12);
    assert.equal(new Set(state.assumptions).size, 12);
  });
});
