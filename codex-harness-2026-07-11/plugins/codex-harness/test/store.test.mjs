import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyPlannerOutputForTest } from "../runtime/autonomy.js";
import {
  effectiveRunMode,
  TOUGH_MODE_ACCEPTANCE_CRITERION,
  TOUGH_MODE_NON_GOAL,
} from "../runtime/domain.js";
import { hashObject } from "../runtime/hash.js";
import {
  applyPlan,
  finishAgentAttempt,
  recordNonGoals,
  reopenTaskForRemediation,
  setTaskStatus,
  startAgentAttempt,
} from "../runtime/operations.js";
import { RunStore, retryTransientLockIoForTest } from "../runtime/store.js";

async function withTempStore(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-harness-store-"));
  try {
    return await callback(new RunStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

async function exitedPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.ok(child.pid);
  const pid = child.pid;
  await once(child, "exit");
  return pid;
}

function lockRecord(pid, ownerId, host = os.hostname()) {
  return JSON.stringify({
    pid,
    host,
    acquiredAt: new Date().toISOString(),
    ...(ownerId ? { ownerId } : {}),
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    assert.equal(loaded.mode, "standard");
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

test("journal overwrites a forged snapshot at the same sequence", async () => {
  await withTempStore(async (store, root) => {
    const created = await store.create({
      goal: "journal owns truth",
      lane: "build",
      repoRoot: "/repo",
      gitCommonDir: "/repo/.git",
    });
    const planned = await applyPlan(store, created.id, plan());
    const snapshotPath = path.join(root, "runs", created.id, "snapshot.json");
    const forged = JSON.parse(await readFile(snapshotPath, "utf8"));
    forged.goal = "forged snapshot";
    assert.equal(forged.sequence, planned.sequence);
    await writeFile(snapshotPath, JSON.stringify(forged), "utf8");

    const recovered = await store.load(created.id);
    assert.equal(recovered.goal, "journal owns truth");
    assert.equal(recovered.sequence, planned.sequence);
    const rewritten = JSON.parse(await readFile(snapshotPath, "utf8"));
    assert.equal(rewritten.goal, "journal owns truth");
  });
});

test("controller lock reclaims a dead same-host owner", async () => {
  await withTempStore(async (store, root) => {
    const created = await store.create({
      goal: "dead controller",
      lane: "build",
      repoRoot: "/repo",
      gitCommonDir: "/repo/.git",
    });
    await writeFile(
      path.join(root, "controller.lock"),
      lockRecord(await exitedPid()),
      "utf8",
    );

    const planned = await applyPlan(store, created.id, plan());
    assert.equal(planned.tasks.length, 2);
  });
});

test("controller recovers abandoned reclaim guards and legacy invalid locks", async () => {
  await withTempStore(async (store, root) => {
    const created = await store.create({
      goal: "recover lock windows",
      lane: "build",
      repoRoot: "/repo",
      gitCommonDir: "/repo/.git",
    });
    const controller = path.join(root, "controller.lock");
    await writeFile(`${controller}.reclaim`, lockRecord(await exitedPid(), "dead-reclaimer"), "utf8");
    let state = await applyPlan(store, created.id, plan());
    assert.equal(state.tasks.length, 2);

    for (const invalid of ["", "{truncated"]) {
      await writeFile(controller, invalid, "utf8");
      const old = new Date(Date.now() - 31 * 60 * 1_000);
      await utimes(controller, old, old);
      state = await store.update(state.id, "test.invalid-lock-recovered", (current) => current, {});
      assert.ok(state.sequence > 0);
    }
  });
});

test("createOrReuse atomically deduplicates concurrent identical goals", async () => {
  await withTempStore(async (store) => {
    const states = await Promise.all(
      Array.from({ length: 12 }, () =>
        store.createOrReuse({
          goal: "one autonomous goal",
          lane: "autonomous",
          repoRoot: "/repo",
          gitCommonDir: "/repo/.git",
        }),
      ),
    );
    assert.equal(new Set(states.map((state) => state.id)).size, 1);
  });
});

test("createOrReuse requires matching lane and effective mode", async () => {
  await withTempStore(async (store) => {
    const input = {
      goal: "same goal",
      lane: "build",
      repoRoot: "/repo",
      gitCommonDir: "/repo/.git",
    };
    const standard = await store.createOrReuse(input);
    const sameStandard = await store.createOrReuse(input);
    assert.equal(sameStandard.id, standard.id);

    const differentLane = await store.createOrReuse({ ...input, lane: "deep" });
    assert.notEqual(differentLane.id, standard.id);

    const tough = await store.createOrReuse({ ...input, lane: "deep", mode: "tough" });
    assert.notEqual(tough.id, differentLane.id);
    const sameTough = await store.createOrReuse({ ...input, lane: "deep", mode: "tough" });
    assert.equal(sameTough.id, tough.id);
  });
});

test("store rejects invalid modes before writing a run or changing current", async () => {
  await withTempStore(async (store, root) => {
    await store.initialize();
    const invalid = {
      goal: "invalid mode",
      lane: "build",
      mode: "reckless",
      repoRoot: "/repo",
      gitCommonDir: "/repo/.git",
    };
    await assert.rejects(() => store.create(invalid), /invalid run mode: reckless/);
    assert.equal(await store.currentRunId(), undefined);
    assert.deepEqual(await readdir(path.join(root, "runs")), []);

    const valid = await store.create({ ...invalid, mode: "standard" });
    await assert.rejects(() => store.createOrReuse(invalid), /invalid run mode: reckless/);
    assert.equal(await store.currentRunId(), valid.id);
    assert.equal((await store.load(valid.id)).mode, "standard");
    assert.deepEqual(await readdir(path.join(root, "runs")), [valid.id]);
  });
});

test("run mode is immutable after creation", async () => {
  await withTempStore(async (store) => {
    const created = await store.create({
      goal: "immutable mode",
      lane: "build",
      mode: "standard",
      repoRoot: "/repo",
      gitCommonDir: "/repo/.git",
    });
    await assert.rejects(
      () => store.update(created.id, "test.change-mode", (state) => {
        state.mode = "tough";
        return state;
      }, {}),
      /run mode is immutable/,
    );
    const loaded = await store.load(created.id);
    assert.equal(loaded.mode, "standard");
    assert.equal(loaded.sequence, created.sequence);
  });
});

test("store loads a legacy schema-version-1 journal without mode as standard", async () => {
  await withTempStore(async (store, root) => {
    const created = await store.create({
      goal: "legacy",
      lane: "build",
      repoRoot: "/repo",
      gitCommonDir: "/repo/.git",
    });
    const journalPath = path.join(root, "runs", created.id, "events.jsonl");
    const event = JSON.parse((await readFile(journalPath, "utf8")).trim());
    delete event.payload.detail.mode;
    delete event.payload.state.mode;
    const { hash: _oldHash, ...withoutHash } = event;
    event.hash = hashObject(withoutHash);
    await writeFile(journalPath, `${JSON.stringify(event)}\n`, "utf8");

    const loaded = await store.load(created.id);
    assert.equal(loaded.mode, undefined);
    assert.equal(effectiveRunMode(loaded), "standard");
    const reused = await store.createOrReuse({
      goal: "legacy",
      lane: "build",
      repoRoot: "/repo",
      gitCommonDir: "/repo/.git",
    });
    assert.equal(reused.id, created.id);
  });
});

test("tough plans receive a deterministic criterion and non-goal", async () => {
  await withTempStore(async (store) => {
    const created = await store.create({
      goal: "exact scope",
      lane: "build",
      mode: "tough",
      repoRoot: "/repo",
      gitCommonDir: "/repo/.git",
    });
    let state = await applyPlan(store, created.id, plan());
    assert.ok(state.tasks.every((task) =>
      task.acceptanceCriteria.at(-1) === TOUGH_MODE_ACCEPTANCE_CRITERION));
    assert.equal(state.nonGoals[0], TOUGH_MODE_NON_GOAL);

    const supplied = Array.from({ length: 19 }, (_, index) => `planner non-goal ${index}`);
    state = await recordNonGoals(store, created.id, supplied);
    assert.equal(state.nonGoals.length, 20);
    assert.equal(state.nonGoals[0], TOUGH_MODE_NON_GOAL);
    assert.deepEqual(state.nonGoals.slice(1), supplied);

    await assert.rejects(
      () => recordNonGoals(
        store,
        created.id,
        Array.from({ length: 20 }, (_, index) => `overflow non-goal ${index}`),
      ),
      /requires room for its deterministic non-goal/,
    );
    const unchanged = await store.load(created.id);
    assert.equal(unchanged.sequence, state.sequence);
    assert.deepEqual(unchanged.nonGoals, state.nonGoals);
  });
});

test("Tough planner overflow is rejected before plan metadata is written", async () => {
  await withTempStore(async (store) => {
    const created = await store.create({
      goal: "atomic planner output",
      lane: "build",
      mode: "tough",
      repoRoot: "/repo",
      gitCommonDir: "/repo/.git",
    });
    await assert.rejects(
      () => applyPlannerOutputForTest(store, created, {
        summary: "A valid plan whose non-goal list has no reserved Tough slot.",
        assumptions: ["an assumption that must not be partially persisted"],
        nonGoals: Array.from({ length: 20 }, (_, index) => `planner exclusion ${index}`),
        tasks: plan(),
      }),
      /requires room for its deterministic non-goal/,
    );
    const unchanged = await store.load(created.id);
    assert.equal(unchanged.sequence, created.sequence);
    assert.equal(unchanged.status, "created");
    assert.deepEqual(unchanged.tasks, []);
    assert.deepEqual(unchanged.assumptions, []);
    assert.deepEqual(unchanged.nonGoals, []);
  });
});

test("completed Tough worker attempts retain their user-facing reports", async () => {
  await withTempStore(async (store) => {
    const created = await store.create({
      goal: "report concerns",
      lane: "build",
      mode: "tough",
      repoRoot: "/repo",
      gitCommonDir: "/repo/.git",
    });
    const attempt = await startAgentAttempt(store, created.id, {
      role: "adversarial-reviewer",
      sandbox: "read-only",
      cwd: "/repo",
    });
    const state = await finishAgentAttempt(store, created.id, attempt.id, {
      status: "complete",
      exitCode: 0,
      summary: "No unrequested mitigation was implemented.",
      residualRisks: ["A product concern remains outside the requested scope."],
    });
    const recorded = state.attempts.find((candidate) => candidate.id === attempt.id);
    assert.equal(recorded?.summary, "No unrequested mitigation was implemented.");
    assert.deepEqual(recorded?.residualRisks, [
      "A product concern remains outside the requested scope.",
    ]);
    assert.deepEqual((await store.load(created.id)).attempts, state.attempts);

    await assert.rejects(
      () => finishAgentAttempt(store, created.id, attempt.id, {
        status: "complete",
        exitCode: 0,
        residualRisks: [42],
      }),
      /residual risks must be an array of strings/,
    );
    assert.equal((await store.load(created.id)).sequence, state.sequence);
  });
});

test("tough criterion fills the 100-item limit and rejects overflow atomically", async () => {
  await withTempStore(async (store) => {
    const input = {
      goal: "criterion boundary",
      lane: "build",
      mode: "tough",
      repoRoot: "/repo",
      gitCommonDir: "/repo/.git",
    };
    const fits = await store.create(input);
    const base = plan()[0];
    const planned = await applyPlan(store, fits.id, [{
      ...base,
      acceptanceCriteria: Array.from({ length: 99 }, (_, index) => `AC${index}`),
    }]);
    assert.equal(planned.tasks[0].acceptanceCriteria.length, 100);
    assert.equal(planned.tasks[0].acceptanceCriteria.at(-1), TOUGH_MODE_ACCEPTANCE_CRITERION);

    const overflows = await store.create(input);
    await assert.rejects(
      () => applyPlan(store, overflows.id, [{
        ...base,
        acceptanceCriteria: Array.from({ length: 100 }, (_, index) => `AC${index}`),
      }]),
      /no room for the tough-mode acceptance criterion/,
    );
    const unchanged = await store.load(overflows.id);
    assert.equal(unchanged.sequence, overflows.sequence);
    assert.equal(unchanged.status, "created");
    assert.deepEqual(unchanged.tasks, []);
  });
});

test("run leases recover dead owners and serialize live contenders", async () => {
  await withTempStore(async (store, root) => {
    const created = await store.create({
      goal: "lease",
      lane: "deep",
      repoRoot: "/repo",
      gitCommonDir: "/repo/.git",
    });
    const leasePath = path.join(root, "runs", created.id, "orchestrator.lease");
    await writeFile(leasePath, lockRecord(await exitedPid(), "dead-lease"), "utf8");
    await store.withRunLease(created.id, async () => undefined);

    const firstEntered = deferred();
    const releaseFirst = deferred();
    let secondEntered = false;
    const first = store.withRunLease(created.id, async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;
    const second = store.withRunLease(created.id, async () => {
      secondEntered = true;
    });
    try {
      await delay(100);
      assert.equal(secondEntered, false);
    } finally {
      releaseFirst.resolve();
    }
    await Promise.all([first, second]);
    assert.equal(secondEntered, true);
  });
});

test("run lease never steals an other-host lock", async () => {
  await withTempStore(async (store, root) => {
    const created = await store.create({
      goal: "remote lease",
      lane: "deep",
      repoRoot: "/repo",
      gitCommonDir: "/repo/.git",
    });
    const leasePath = path.join(root, "runs", created.id, "orchestrator.lease");
    await writeFile(
      leasePath,
      lockRecord(await exitedPid(), "remote-owner", "definitely-another-host"),
      "utf8",
    );
    let entered = false;
    const waiting = store.withRunLease(created.id, async () => {
      entered = true;
    });
    await delay(100);
    assert.equal(entered, false);
    await rm(leasePath);
    await waiting;
    assert.equal(entered, true);
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

test("lock reads retry bounded transient Windows EPERM failures", async () => {
  let attempts = 0;
  const value = await retryTransientLockIoForTest(async () => {
    attempts += 1;
    if (attempts < 3) {
      throw Object.assign(new Error("synthetic transient lock contention"), {
        code: "EPERM",
      });
    }
    return "acquired";
  });
  assert.equal(value, "acquired");
  assert.equal(attempts, 3);

  attempts = 0;
  await assert.rejects(
    retryTransientLockIoForTest(async () => {
      attempts += 1;
      throw Object.assign(new Error("synthetic persistent lock denial"), {
        code: "EPERM",
      });
    }),
    { code: "EPERM" },
  );
  assert.equal(attempts, 5);
});

test("remediating a prerequisite makes its dependent wait again", async () => {
  await withTempStore(async (store) => {
    const created = await store.create({
      goal: "repair dependency",
      lane: "deep",
      repoRoot: "/repo",
      gitCommonDir: "/repo/.git",
    });
    let state = await applyPlan(store, created.id, plan());
    assert.equal(state.tasks[1].status, "pending");
    for (const taskId of ["one", "two"]) {
      state = await setTaskStatus(store, created.id, taskId, "running");
      state = await setTaskStatus(store, created.id, taskId, "verifying");
      state = await setTaskStatus(store, created.id, taskId, "committed");
      state = await setTaskStatus(store, created.id, taskId, "reviewed");
      state = await setTaskStatus(store, created.id, taskId, "complete");
    }
    state = await reopenTaskForRemediation(store, created.id, "one", "integration failed");
    state = await reopenTaskForRemediation(store, created.id, "two", "dependency changed");
    assert.equal(state.tasks[0].status, "ready");
    assert.equal(state.tasks[1].status, "pending");
  });
});
