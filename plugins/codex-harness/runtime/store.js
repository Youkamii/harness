import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat, writeFile, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashObject } from "./hash.js";
export class RunStore {
    root;
    runsRoot;
    lockPath;
    constructor(root) {
        this.root = path.resolve(root);
        this.runsRoot = path.join(this.root, "runs");
        this.lockPath = path.join(this.root, "controller.lock");
    }
    async initialize() {
        await mkdir(this.runsRoot, { recursive: true, mode: 0o700 });
    }
    async create(input) {
        return await this.withLock(async () => await this.createUnlocked(input));
    }
    async createOrReuse(input) {
        return await this.withLock(async () => {
            const currentId = await this.currentRunId();
            if (currentId) {
                const current = await this.load(currentId);
                if (current.goal === input.goal &&
                    current.repoRoot === input.repoRoot &&
                    !["complete", "failed", "cancelled"].includes(current.status)) {
                    return current;
                }
            }
            return await this.createUnlocked(input);
        });
    }
    async load(runId) {
        assertRunId(runId);
        const journalState = await this.verifyJournal(runId);
        let snapshot;
        try {
            snapshot = JSON.parse(await readFile(path.join(this.runDir(runId), "snapshot.json"), "utf8"));
            validateSnapshot(snapshot, runId);
        }
        catch (error) {
            if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
                snapshot = undefined;
            }
        }
        if (!snapshot || hashObject(snapshot) !== hashObject(journalState)) {
            await atomicWriteJson(path.join(this.runDir(runId), "snapshot.json"), journalState);
        }
        return journalState;
    }
    async currentRunId() {
        try {
            const value = JSON.parse(await readFile(path.join(this.root, "current.json"), "utf8"));
            if (!value.runId)
                return undefined;
            assertRunId(value.runId);
            return value.runId;
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw error;
        }
    }
    async update(runId, type, mutate, payload) {
        return await this.withLock(async () => {
            const current = await this.load(runId);
            const next = mutate(structuredClone(current));
            if (next.id !== current.id)
                throw new Error("run id is immutable");
            next.updatedAt = new Date().toISOString();
            await this.persist(next, type, payload);
            return next;
        });
    }
    async withRunLease(runId, operation) {
        assertRunId(runId);
        await this.initialize();
        await stat(this.runDir(runId));
        return await this.withFileLock(path.join(this.runDir(runId), "orchestrator.lease"), `run ${runId}`, operation);
    }
    async persist(state, type, payload) {
        const eventPath = path.join(this.runDir(state.id), "events.jsonl");
        const previous = await lastEventHash(eventPath);
        const sequence = state.sequence + 1;
        const nextState = structuredClone(state);
        nextState.sequence = sequence;
        const withoutHash = {
            schemaVersion: 1,
            eventId: randomUUID(),
            runId: state.id,
            sequence,
            previousHash: previous,
            type,
            recordedAt: new Date().toISOString(),
            payload: { detail: payload, state: nextState },
        };
        const event = { ...withoutHash, hash: hashObject(withoutHash) };
        const line = JSON.stringify(event) + "\n";
        const handle = await open(eventPath, "a", 0o600);
        try {
            await handle.writeFile(line, "utf8");
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        state.sequence = sequence;
        await atomicWriteJson(path.join(this.runDir(state.id), "snapshot.json"), state);
    }
    async createUnlocked(input) {
        const now = (input.now ?? new Date()).toISOString();
        const state = {
            schemaVersion: 1,
            id: randomUUID(),
            goal: input.goal,
            lane: input.lane,
            status: "created",
            repoRoot: input.repoRoot,
            gitCommonDir: input.gitCommonDir,
            createdAt: now,
            updatedAt: now,
            sequence: 0,
            assumptions: [],
            nonGoals: [],
            tasks: [],
            evidence: [],
            outbox: [],
            attempts: [],
        };
        await mkdir(this.runDir(state.id), { recursive: false, mode: 0o700 });
        await this.persist(state, "run.created", { goal: state.goal, lane: state.lane });
        await atomicWriteJson(path.join(this.root, "current.json"), { runId: state.id });
        return state;
    }
    async verifyJournal(runId) {
        const eventPath = path.join(this.runDir(runId), "events.jsonl");
        const text = await readFile(eventPath, "utf8");
        const rawLines = text.split("\n");
        if (rawLines.at(-1) === "")
            rawLines.pop();
        const lines = rawLines;
        let previousHash = "GENESIS";
        let sequence = 0;
        let latestState;
        for (const [index, line] of lines.entries()) {
            let event;
            try {
                event = JSON.parse(line);
            }
            catch (error) {
                if (index === lines.length - 1 && !text.endsWith("\n"))
                    break;
                throw error;
            }
            const { hash, ...withoutHash } = event;
            sequence += 1;
            if (event.sequence !== sequence || event.previousHash !== previousHash) {
                throw new Error(`journal chain is invalid at sequence ${sequence}`);
            }
            if (hashObject(withoutHash) !== hash)
                throw new Error(`journal hash mismatch at sequence ${sequence}`);
            previousHash = hash;
            const payload = event.payload;
            if (!payload.state)
                throw new Error(`journal event ${sequence} lacks resulting state`);
            validateSnapshot(payload.state, runId);
            latestState = payload.state;
        }
        if (!latestState)
            throw new Error("journal contains no recoverable state");
        if (latestState.sequence !== sequence)
            throw new Error("journal state sequence mismatch");
        return latestState;
    }
    runDir(runId) {
        return path.join(this.runsRoot, runId);
    }
    async withLock(operation) {
        await this.initialize();
        return await this.withFileLock(this.lockPath, "harness", operation);
    }
    async withFileLock(lockPath, label, operation) {
        const deadline = Date.now() + 30_000;
        let waitMs = 20;
        let existing;
        const record = {
            pid: process.pid,
            host: os.hostname(),
            acquiredAt: new Date().toISOString(),
            ownerId: randomUUID(),
        };
        let acquired = false;
        while (!acquired) {
            const reclaimPath = `${lockPath}.reclaim`;
            if (await pathExists(reclaimPath)) {
                await recoverAbandonedLockFile(reclaimPath);
            }
            if (await pathExists(reclaimPath)) {
                if (Date.now() >= deadline)
                    throw lockedError(label, existing);
                await delay(waitMs);
                waitMs = Math.min(waitMs * 2, 250);
                continue;
            }
            acquired = await tryAcquireLock(lockPath, record);
            if (acquired)
                break;
            existing = await readLock(lockPath);
            if (existing && (await reclaimDeadSameHostLock(lockPath, existing)))
                continue;
            if (!existing && (await removeStaleInvalidLock(lockPath)))
                continue;
            if (Date.now() >= deadline)
                throw lockedError(label, existing);
            await delay(waitMs);
            waitMs = Math.min(waitMs * 2, 250);
        }
        try {
            if (await pathExists(`${lockPath}.reclaim`)) {
                await removeOwnedLock(lockPath, record);
                return await this.withFileLock(lockPath, label, operation);
            }
            return await operation();
        }
        finally {
            await removeOwnedLock(lockPath, record);
        }
    }
}
async function atomicWriteJson(target, value) {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const data = JSON.stringify(value, null, 2) + "\n";
    const handle = await open(temporary, "wx", 0o600);
    try {
        await handle.writeFile(data, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await rename(temporary, target);
            return;
        }
        catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        }
    }
    await rm(temporary, { force: true });
    throw lastError;
}
async function lastEventHash(eventPath) {
    try {
        const text = await readFile(eventPath, "utf8");
        const rawLines = text.split("\n");
        const hasPartialTail = rawLines.at(-1) !== "";
        if (!hasPartialTail)
            rawLines.pop();
        if (hasPartialTail) {
            rawLines.pop();
            const repaired = rawLines.length > 0 ? rawLines.join("\n") + "\n" : "";
            await writeFile(eventPath, repaired, { encoding: "utf8", mode: 0o600 });
        }
        const lines = rawLines.filter(Boolean);
        if (lines.length === 0)
            return "GENESIS";
        return JSON.parse(lines.at(-1) ?? "").hash;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return "GENESIS";
        throw error;
    }
}
async function readLock(lockPath) {
    try {
        const value = JSON.parse(await readFile(lockPath, "utf8"));
        if (!Number.isSafeInteger(value.pid) ||
            (value.pid ?? 0) <= 0 ||
            typeof value.host !== "string" ||
            typeof value.acquiredAt !== "string") {
            return undefined;
        }
        const identity = {
            pid: value.pid,
            host: value.host,
            acquiredAt: value.acquiredAt,
        };
        return {
            ...identity,
            ownerId: typeof value.ownerId === "string" && value.ownerId.length > 0
                ? value.ownerId
                : `legacy:${hashObject(identity)}`,
        };
    }
    catch (error) {
        if (error.code === "ENOENT" ||
            error instanceof SyntaxError) {
            return undefined;
        }
        throw error;
    }
}
async function reclaimDeadSameHostLock(lockPath, observed) {
    if (observed.host !== os.hostname() || isProcessAlive(observed.pid))
        return false;
    const reclaimPath = `${lockPath}.reclaim`;
    const guardRecord = {
        pid: process.pid,
        host: os.hostname(),
        acquiredAt: new Date().toISOString(),
        ownerId: randomUUID(),
    };
    if (!(await tryAcquireLock(reclaimPath, guardRecord)))
        return false;
    try {
        const current = await readLock(lockPath);
        if (!current ||
            current.ownerId !== observed.ownerId ||
            current.host !== os.hostname() ||
            isProcessAlive(current.pid)) {
            return false;
        }
        await rm(lockPath, { force: true });
        return true;
    }
    finally {
        await removeOwnedLock(reclaimPath, guardRecord);
    }
}
async function tryAcquireLock(lockPath, record) {
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    const candidate = `${lockPath}.${record.ownerId}.candidate`;
    const handle = await open(candidate, "wx", 0o600);
    try {
        await handle.writeFile(JSON.stringify(record), "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await link(candidate, lockPath);
        return true;
    }
    catch (error) {
        if (error.code === "EEXIST")
            return false;
        throw error;
    }
    finally {
        await rm(candidate, { force: true });
    }
}
async function recoverAbandonedLockFile(lockPath) {
    const owner = await readLock(lockPath);
    if (owner && owner.host === os.hostname() && !isProcessAlive(owner.pid)) {
        await removeOwnedLock(lockPath, owner);
        return;
    }
    if (!owner)
        await removeStaleInvalidLock(lockPath);
}
async function removeStaleInvalidLock(lockPath) {
    let metadata;
    try {
        metadata = await stat(lockPath);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return true;
        throw error;
    }
    if (Date.now() - metadata.mtimeMs < 30 * 60 * 1_000)
        return false;
    if (await readLock(lockPath))
        return false;
    await rm(lockPath, { force: true });
    return true;
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== "ESRCH";
    }
}
async function removeOwnedLock(lockPath, owner) {
    const current = await readLock(lockPath);
    if (current?.ownerId === owner.ownerId)
        await rm(lockPath, { force: true });
}
async function pathExists(target) {
    try {
        await stat(target);
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
function lockedError(label, owner) {
    if (!owner)
        return new Error(`${label} is locked by an unknown owner`);
    return new Error(`${label} is locked by pid ${owner.pid} on ${owner.host}`);
}
async function delay(milliseconds) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function assertRunId(runId) {
    if (!/^[0-9a-f-]{36}$/.test(runId))
        throw new Error(`invalid run id: ${runId}`);
}
function validateSnapshot(state, expectedId) {
    if (state.schemaVersion !== 1)
        throw new Error("unsupported state schema");
    if (state.id !== expectedId)
        throw new Error("snapshot run id mismatch");
    if (!Array.isArray(state.tasks) ||
        !Array.isArray(state.evidence) ||
        !Array.isArray(state.outbox) ||
        !Array.isArray(state.attempts)) {
        throw new Error("invalid snapshot arrays");
    }
}
//# sourceMappingURL=store.js.map