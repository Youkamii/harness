import path from "node:path";
import { runProcess } from "./process.js";
const probes = new Map();
export async function assertSandboxNetworkIsolation(options) {
    const key = [
        path.resolve(options.codexExecutable),
        options.env.HOME ?? "",
        options.env.USERPROFILE ?? "",
    ].join("\u0000");
    let probe = probes.get(key);
    if (!probe) {
        probe = runIsolationProbe(options);
        probes.set(key, probe);
    }
    return await probe;
}
async function runIsolationProbe(options) {
    const result = await runProcess({
        executable: options.codexExecutable,
        args: [
            "sandbox",
            "--sandbox-state-disable-network",
            "--sandbox-state-readable-root",
            path.dirname(process.execPath),
            "-P",
            ":workspace",
            "-C",
            options.cwd,
            "--",
            process.execPath,
            "--eval",
            "fetch('https://example.com').then(() => process.exit(9)).catch(() => process.exit(0))",
        ],
        cwd: options.cwd,
        env: options.env,
        timeoutMs: 30_000,
        maxOutputBytes: 256 * 1024,
    });
    if (result.exitCode === 0 && !result.timedOut)
        return;
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim().slice(0, 1_000);
    throw new Error(`verification network isolation is unavailable (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""})${detail ? `: ${detail}` : ""}`);
}
//# sourceMappingURL=sandbox-network.js.map