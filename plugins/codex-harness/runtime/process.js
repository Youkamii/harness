import { spawn } from "node:child_process";
export async function runProcess(request) {
    const timeoutMs = request.timeoutMs ?? 30_000;
    const maxOutputBytes = request.maxOutputBytes ?? 2 * 1024 * 1024;
    return await new Promise((resolve, reject) => {
        const child = spawn(request.executable, request.args, {
            cwd: request.cwd,
            env: request.env ?? process.env,
            shell: false,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout = [];
        const stderr = [];
        let outputBytes = 0;
        let timedOut = false;
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const collect = (bucket, chunk) => {
            outputBytes += chunk.byteLength;
            if (outputBytes > maxOutputBytes) {
                child.kill();
                reject(new Error(`process output exceeded ${maxOutputBytes} bytes`));
                return;
            }
            bucket.push(chunk);
        };
        child.stdout.on("data", (chunk) => collect(stdout, chunk));
        child.stderr.on("data", (chunk) => collect(stderr, chunk));
        child.on("error", reject);
        child.on("close", (code) => {
            finish({
                exitCode: code ?? -1,
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8"),
                timedOut,
            });
        });
        if (request.input !== undefined)
            child.stdin.end(request.input);
        else
            child.stdin.end();
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
        }, timeoutMs);
        timer.unref();
    });
}
export async function runChecked(request) {
    const result = await runProcess(request);
    if (result.exitCode !== 0) {
        throw new Error(`${request.executable} exited with ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result;
}
//# sourceMappingURL=process.js.map