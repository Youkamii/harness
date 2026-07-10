import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexExecutable } from "./executables.js";
import { validatePlan } from "./graph.js";
import { sha256 } from "./hash.js";
import { finishAgentAttempt, recordAgentThread, startAgentAttempt, } from "./operations.js";
import { redactSecrets, sanitizedEnvironment } from "./redact.js";
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disabledFeatures = ["plugins", "apps", "browser_use", "computer_use", "multi_agent"];
export async function runCodexWorker(request) {
    const sandbox = request.role === "builder" ? "workspace-write" : "read-only";
    const attempt = await startAgentAttempt(request.store, request.runId, {
        role: request.role,
        sandbox,
        cwd: request.cwd,
        ...(request.taskId ? { taskId: request.taskId } : {}),
    });
    const outputRoot = path.join(request.store.root, "agents");
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    const outputFile = path.join(outputRoot, `${attempt.id}.json`);
    const schema = schemaFor(request.role);
    const args = [
        "-a",
        "never",
        "-s",
        sandbox,
        ...disabledFeatures.flatMap((feature) => ["--disable", feature]),
        "exec",
        ...(request.resumeThreadId ? ["resume"] : []),
        "--ignore-user-config",
        "--strict-config",
        "--json",
        "--output-schema",
        schema,
        "-o",
        outputFile,
        ...(request.role === "builder" ? [] : ["--ephemeral"]),
        ...(request.resumeThreadId ? [request.resumeThreadId, "-"] : ["-C", request.cwd, "-"]),
    ];
    let result;
    try {
        result = await spawnCodex({
            executable: await resolveCodexExecutable(),
            args,
            cwd: request.cwd,
            input: request.prompt,
            timeoutMs: request.timeoutMs ?? 30 * 60 * 1_000,
            onThreadId: async (threadId) => {
                await recordAgentThread(request.store, request.runId, attempt.id, threadId);
            },
        });
    }
    catch (error) {
        await finishAgentAttempt(request.store, request.runId, attempt.id, {
            status: "failed",
            exitCode: -1,
            failureFingerprint: sha256(redactSecrets(String(error))),
        });
        throw error;
    }
    if (result.exitCode !== 0 || result.timedOut) {
        await finishAgentAttempt(request.store, request.runId, attempt.id, {
            status: result.timedOut ? "timed-out" : "failed",
            exitCode: result.exitCode,
            failureFingerprint: sha256(redactSecrets(result.stderr)),
        });
        throw new Error(`Codex ${request.role} ${result.timedOut ? "timed out" : `exited with ${result.exitCode}`}: ${redactSecrets(result.stderr).slice(0, 2000)}`);
    }
    try {
        const output = JSON.parse(await readFile(outputFile, "utf8"));
        validateWorkerOutput(request.role, output);
        await finishAgentAttempt(request.store, request.runId, attempt.id, {
            status: "complete",
            exitCode: 0,
        });
        return output;
    }
    catch (error) {
        await finishAgentAttempt(request.store, request.runId, attempt.id, {
            status: "failed",
            exitCode: 0,
            failureFingerprint: sha256(redactSecrets(String(error))),
        });
        throw new Error(`invalid ${request.role} output: ${error instanceof Error ? error.message : String(error)}`);
    }
    finally {
        await rm(outputFile, { force: true });
    }
}
function schemaFor(role) {
    const file = role === "planner"
        ? "plan-output.json"
        : role === "builder"
            ? "builder-output.json"
            : "review-output.json";
    return path.join(pluginRoot, "schemas", file);
}
function validateWorkerOutput(role, value) {
    if (!value || typeof value !== "object")
        throw new Error("output is not an object");
    if (role === "planner") {
        const plan = value;
        if (typeof plan.summary !== "string" ||
            !Array.isArray(plan.assumptions) ||
            !Array.isArray(plan.nonGoals) ||
            !Array.isArray(plan.tasks)) {
            throw new Error("planner output is incomplete");
        }
        validatePlan(plan.tasks);
        return;
    }
    if (role === "builder") {
        const builder = value;
        if (!["implemented", "blocked"].includes(builder.status ?? "") ||
            typeof builder.summary !== "string" ||
            !Array.isArray(builder.changedPaths) ||
            !Array.isArray(builder.checksAttempted) ||
            !Array.isArray(builder.blockers)) {
            throw new Error("builder output is incomplete");
        }
        return;
    }
    const review = value;
    if (!["approved", "blocked"].includes(review.verdict ?? "") ||
        !Array.isArray(review.commands) ||
        !Array.isArray(review.criteria) ||
        !Array.isArray(review.findings) ||
        !Array.isArray(review.residualRisks)) {
        throw new Error("review output is incomplete");
    }
    for (const finding of review.findings) {
        if (!["critical", "high", "medium", "low"].includes(finding.severity) ||
            typeof finding.file !== "string" ||
            !Number.isInteger(finding.line) ||
            finding.line < 1 ||
            typeof finding.evidence !== "string" ||
            typeof finding.confidence !== "number" ||
            finding.confidence < 0 ||
            finding.confidence > 1 ||
            typeof finding.suggestedTest !== "string") {
            throw new Error("review finding is malformed");
        }
    }
}
async function spawnCodex(input) {
    return await new Promise((resolve, reject) => {
        const child = spawn(input.executable, input.args, {
            cwd: input.cwd,
            env: sanitizedEnvironment(),
            shell: false,
            windowsHide: true,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
        });
        const stderrChunks = [];
        let stdoutBuffer = "";
        let outputBytes = 0;
        let timedOut = false;
        let settled = false;
        let threadQueue = Promise.resolve();
        let threadRecorded = false;
        const finish = (callback) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            callback();
        };
        const fail = (error) => finish(() => reject(error));
        const account = (chunk) => {
            outputBytes += chunk.byteLength;
            if (outputBytes > 8 * 1024 * 1024) {
                killProcessTree(child.pid);
                fail(new Error("Codex output exceeded 8 MiB"));
                return false;
            }
            return true;
        };
        child.stdout.on("data", (chunk) => {
            if (!account(chunk))
                return;
            stdoutBuffer += chunk.toString("utf8");
            let newline = stdoutBuffer.indexOf("\n");
            while (newline >= 0) {
                const line = stdoutBuffer.slice(0, newline);
                stdoutBuffer = stdoutBuffer.slice(newline + 1);
                const threadId = extractThreadId(line);
                if (threadId && !threadRecorded) {
                    threadRecorded = true;
                    threadQueue = threadQueue.then(() => input.onThreadId(threadId));
                }
                newline = stdoutBuffer.indexOf("\n");
            }
        });
        child.stderr.on("data", (chunk) => {
            if (account(chunk))
                stderrChunks.push(chunk);
        });
        child.on("error", (error) => fail(error));
        child.on("close", (code) => {
            void threadQueue
                .then(() => finish(() => resolve({
                exitCode: code ?? -1,
                timedOut,
                stderr: redactSecrets(Buffer.concat(stderrChunks).toString("utf8")),
            })))
                .catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
        });
        child.stdin.end(input.input);
        const timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child.pid);
        }, input.timeoutMs);
        timer.unref();
    });
}
function extractThreadId(line) {
    if (!line.trim())
        return undefined;
    try {
        const value = JSON.parse(line);
        const candidate = value.type === "thread.started"
            ? value.thread_id
            : value.threadId ?? value.thread_id ?? value.session_id;
        return typeof candidate === "string" && /^[0-9a-f-]{36}$/i.test(candidate)
            ? candidate
            : undefined;
    }
    catch {
        return undefined;
    }
}
function killProcessTree(pid) {
    if (!pid)
        return;
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
        });
        return;
    }
    try {
        process.kill(-pid, "SIGTERM");
        setTimeout(() => {
            try {
                process.kill(-pid, "SIGKILL");
            }
            catch {
                // The process group has already exited.
            }
        }, 2_000).unref();
    }
    catch {
        // The process group has already exited.
    }
}
export function codexArgumentsForTest(role, cwd, schema, output) {
    const sandbox = role === "builder" ? "workspace-write" : "read-only";
    return [
        "-a",
        "never",
        "-s",
        sandbox,
        ...disabledFeatures.flatMap((feature) => ["--disable", feature]),
        "exec",
        "--ignore-user-config",
        "--strict-config",
        "--json",
        "--output-schema",
        schema,
        "-o",
        output,
        ...(role === "builder" ? [] : ["--ephemeral"]),
        "-C",
        cwd,
        "-",
    ];
}
export function validateWorkerOutputForTest(role, value) {
    validateWorkerOutput(role, value);
}
//# sourceMappingURL=codex-worker.js.map