import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentAttempt, PlannedTask, ReviewFinding } from "./domain.js";
import { resolveCodexExecutable } from "./executables.js";
import { validatePlan } from "./graph.js";
import { sha256 } from "./hash.js";
import {
  finishAgentAttempt,
  recordAgentThread,
  startAgentAttempt,
} from "./operations.js";
import { codexControllerEnvironment, redactSecrets } from "./redact.js";
import { RunStore } from "./store.js";

export interface PlanOutput {
  summary: string;
  assumptions: string[];
  nonGoals: string[];
  tasks: PlannedTask[];
}

export interface BuilderOutput {
  status: "implemented" | "blocked";
  summary: string;
  changedPaths: string[];
  checksAttempted: string[];
  blockers: string[];
}

export interface ReviewOutput {
  verdict: "approved" | "blocked";
  commands: Array<{ argv: string[]; exitCode: number }>;
  criteria: Array<{ id: string; status: "pass" | "fail" | "unknown"; evidence: string }>;
  findings: ReviewFinding[];
  residualRisks: string[];
}

export type WorkerOutput = PlanOutput | BuilderOutput | ReviewOutput;

interface WorkerRequest {
  store: RunStore;
  runId: string;
  role: AgentAttempt["role"];
  cwd: string;
  prompt: string;
  taskId?: string;
  timeoutMs?: number;
  resumeThreadId?: string;
}

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disabledFeatures = ["plugins", "apps", "browser_use", "computer_use", "multi_agent"];

export async function runCodexWorker(request: WorkerRequest): Promise<WorkerOutput> {
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
    "-c",
    "shell_environment_policy.inherit=core",
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

  let result: { exitCode: number; timedOut: boolean; stdout: string; stderr: string };
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
  } catch (error) {
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
      failureFingerprint: sha256(redactSecrets(`${result.stdout}\n${result.stderr}`)),
    });
    throw new Error(
      `Codex ${request.role} ${result.timedOut ? "timed out" : `exited with ${result.exitCode}`}: ${redactSecrets([result.stdout, result.stderr].filter(Boolean).join("\n")).slice(0, 2000)}`,
    );
  }

  try {
    const output = JSON.parse(await readFile(outputFile, "utf8")) as unknown;
    normalizeWorkerOutput(request.role, output);
    validateWorkerOutput(request.role, output);
    await finishAgentAttempt(request.store, request.runId, attempt.id, {
      status: "complete",
      exitCode: 0,
    });
    return output;
  } catch (error) {
    await finishAgentAttempt(request.store, request.runId, attempt.id, {
      status: "failed",
      exitCode: 0,
      failureFingerprint: sha256(redactSecrets(String(error))),
    });
    throw new Error(`invalid ${request.role} output: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(outputFile, { force: true });
  }
}

function normalizeWorkerOutput(role: AgentAttempt["role"], value: unknown): void {
  if (role !== "planner" || !value || typeof value !== "object") return;
  const tasks = (value as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return;
  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    const checks = (task as { checks?: unknown }).checks;
    if (!Array.isArray(checks)) continue;
    for (const check of checks) {
      if (!check || typeof check !== "object") continue;
      const record = check as Record<string, unknown>;
      for (const key of ["cwd", "timeoutMs", "required"]) {
        if (record[key] === null) delete record[key];
      }
    }
  }
}

function schemaFor(role: AgentAttempt["role"]): string {
  const file =
    role === "planner"
      ? "plan-output.json"
      : role === "builder"
        ? "builder-output.json"
        : "review-output.json";
  return path.join(pluginRoot, "schemas", file);
}

function validateWorkerOutput(role: AgentAttempt["role"], value: unknown): asserts value is WorkerOutput {
  if (!value || typeof value !== "object") throw new Error("output is not an object");
  if (role === "planner") {
    const plan = value as Partial<PlanOutput>;
    if (
      typeof plan.summary !== "string" ||
      !Array.isArray(plan.assumptions) ||
      !Array.isArray(plan.nonGoals) ||
      !Array.isArray(plan.tasks)
    ) {
      throw new Error("planner output is incomplete");
    }
    validatePlan(plan.tasks);
    return;
  }
  if (role === "builder") {
    const builder = value as Partial<BuilderOutput>;
    if (
      !["implemented", "blocked"].includes(builder.status ?? "") ||
      typeof builder.summary !== "string" ||
      !Array.isArray(builder.changedPaths) ||
      !Array.isArray(builder.checksAttempted) ||
      !Array.isArray(builder.blockers)
    ) {
      throw new Error("builder output is incomplete");
    }
    return;
  }
  const review = value as Partial<ReviewOutput>;
  if (
    !["approved", "blocked"].includes(review.verdict ?? "") ||
    !Array.isArray(review.commands) ||
    !Array.isArray(review.criteria) ||
    !Array.isArray(review.findings) ||
    !Array.isArray(review.residualRisks)
  ) {
    throw new Error("review output is incomplete");
  }
  for (const finding of review.findings) {
    if (
      !["critical", "high", "medium", "low"].includes(finding.severity) ||
      typeof finding.file !== "string" ||
      !Number.isInteger(finding.line) ||
      finding.line < 1 ||
      typeof finding.evidence !== "string" ||
      typeof finding.confidence !== "number" ||
      finding.confidence < 0 ||
      finding.confidence > 1 ||
      typeof finding.suggestedTest !== "string"
    ) {
      throw new Error("review finding is malformed");
    }
  }
}

async function spawnCodex(input: {
  executable: string;
  args: string[];
  cwd: string;
  input: string;
  timeoutMs: number;
  onThreadId: (threadId: string) => Promise<void>;
}): Promise<{ exitCode: number; timedOut: boolean; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: codexControllerEnvironment(),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    const stdoutChunks: Buffer[] = [];
    let stdoutBuffer = "";
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;
    let threadQueue = Promise.resolve();
    let threadRecorded = false;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const fail = (error: Error): void => finish(() => reject(error));
    const account = (chunk: Buffer): boolean => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 8 * 1024 * 1024) {
        killProcessTree(child.pid);
        fail(new Error("Codex output exceeded 8 MiB"));
        return false;
      }
      return true;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (!account(chunk)) return;
      stdoutChunks.push(chunk);
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
    child.stderr.on("data", (chunk: Buffer) => {
      if (account(chunk)) stderrChunks.push(chunk);
    });
    child.on("error", (error) => fail(error));
    child.on("close", (code) => {
      void threadQueue
        .then(() =>
          finish(() =>
            resolve({
              exitCode: code ?? -1,
              timedOut,
              stdout: redactSecrets(Buffer.concat(stdoutChunks).toString("utf8")),
              stderr: redactSecrets(Buffer.concat(stderrChunks).toString("utf8")),
            }),
          ),
        )
        .catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
    });

    child.stdin.end(input.input);
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, input.timeoutMs);
    timer.unref();
  });
}

function extractThreadId(line: string): string | undefined {
  if (!line.trim()) return undefined;
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const candidate =
      value.type === "thread.started"
        ? value.thread_id
        : value.threadId ?? value.thread_id ?? value.session_id;
    return typeof candidate === "string" && /^[0-9a-f-]{36}$/i.test(candidate)
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
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
      } catch {
        // The process group has already exited.
      }
    }, 2_000).unref();
  } catch {
    // The process group has already exited.
  }
}

export function codexArgumentsForTest(
  role: AgentAttempt["role"],
  cwd: string,
  schema: string,
  output: string,
): string[] {
  const sandbox = role === "builder" ? "workspace-write" : "read-only";
  return [
    "-a",
    "never",
    "-s",
    sandbox,
    "-c",
    "shell_environment_policy.inherit=core",
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

export function validateWorkerOutputForTest(
  role: AgentAttempt["role"],
  value: unknown,
): asserts value is WorkerOutput {
  validateWorkerOutput(role, value);
}
