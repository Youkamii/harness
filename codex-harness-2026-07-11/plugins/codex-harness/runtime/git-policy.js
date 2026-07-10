import { runProcess } from "./process.js";
import { sanitizedEnvironment } from "./redact.js";
export async function assertSafeGitConfiguration(repoRoot, candidatePaths) {
    let paths = candidatePaths;
    if (!paths) {
        const tracked = await runProcess({
            executable: "git",
            args: ["ls-files", "-z"],
            cwd: repoRoot,
            env: sanitizedEnvironment(),
            timeoutMs: 10_000,
            maxOutputBytes: 4 * 1024 * 1024,
        });
        if (tracked.exitCode !== 0)
            throw new Error(`unable to inspect tracked paths: ${tracked.stderr.trim()}`);
        paths = tracked.stdout.split("\u0000").filter(Boolean);
    }
    if (paths.length === 0)
        return;
    const attributes = await runProcess({
        executable: "git",
        args: ["check-attr", "-z", "--stdin", "filter"],
        cwd: repoRoot,
        env: sanitizedEnvironment(),
        input: paths.join("\u0000") + "\u0000",
        timeoutMs: 10_000,
        maxOutputBytes: 4 * 1024 * 1024,
    });
    if (attributes.exitCode !== 0) {
        throw new Error(`unable to inspect Git attributes: ${attributes.stderr.trim()}`);
    }
    const fields = attributes.stdout.split("\u0000");
    const active = new Set();
    for (let index = 0; index + 2 < fields.length; index += 3) {
        const value = fields[index + 2];
        if (value && !["unspecified", "unset", "set"].includes(value))
            active.add(value);
    }
    for (const name of active) {
        if (!/^[A-Za-z0-9_.-]+$/.test(name))
            throw new Error("invalid Git filter name");
        const configured = await runProcess({
            executable: "git",
            args: ["config", "--get-regexp", `^filter\\.${name.replaceAll(".", "\\.")}\\.(clean|smudge|process)$`],
            cwd: repoRoot,
            env: sanitizedEnvironment(),
            timeoutMs: 10_000,
            maxOutputBytes: 256 * 1024,
        });
        if (configured.exitCode === 0 && configured.stdout.trim()) {
            throw new Error("external Git clean/smudge/process filters are not allowed in harness-controlled worktrees");
        }
        if (configured.exitCode !== 0 && configured.exitCode !== 1) {
            throw new Error(`unable to inspect Git filter configuration: ${configured.stderr.trim()}`);
        }
    }
}
//# sourceMappingURL=git-policy.js.map