import { spawn, type ChildProcess } from "node:child_process";

export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  const timeoutMs = request.timeoutMs ?? 30_000;
  const maxOutputBytes = request.maxOutputBytes ?? 2 * 1024 * 1024;

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: request.env ?? process.env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;
    let terminating = false;
    let outputLimitError: Error | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };

    const finish = (result: ProcessResult, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (error) reject(error);
      else resolve(result);
    };

    const terminateTree = (): void => {
      if (terminating) return;
      terminating = true;
      signalProcessTree(child, "SIGTERM");
      forceKillTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), 2_000);
      forceKillTimer.unref();
    };

    const collect = (bucket: Buffer[], chunk: Buffer): void => {
      if (terminating) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        outputLimitError = new Error(`process output exceeded ${maxOutputBytes} bytes`);
        terminateTree();
        return;
      }
      bucket.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => finish({
      exitCode: -1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      timedOut,
    }, error));
    child.on("close", (code) => {
      const result = {
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
      };
      finish(result, outputLimitError);
    });

    child.stdin.on("error", () => undefined);
    if (request.input !== undefined) child.stdin.end(request.input);
    else child.stdin.end();

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateTree();
    }, timeoutMs);
    timeoutTimer.unref();
  });
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => undefined);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited between the close check and signal delivery.
    }
  }
}

export async function runChecked(request: ProcessRequest): Promise<ProcessResult> {
  const result = await runProcess(request);
  if (result.exitCode !== 0) {
    throw new Error(
      `${request.executable} exited with ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result;
}
