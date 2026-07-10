import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
let cachedCodex;
export async function resolveCodexExecutable() {
    cachedCodex ??= findCodexExecutable();
    return await cachedCodex;
}
async function findCodexExecutable() {
    const override = process.env.CODEX_HARNESS_CODEX_BINARY;
    if (override) {
        const resolved = path.resolve(override);
        if (!isCodexBinaryName(resolved) || !(await isFile(resolved))) {
            throw new Error("CODEX_HARNESS_CODEX_BINARY must point to a codex executable");
        }
        return resolved;
    }
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const located = spawnSync(locator, ["codex"], {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
    });
    const candidates = located.status === 0
        ? located.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
        : [];
    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        if (process.platform !== "win32" && (await isFile(resolved)))
            return resolved;
        if (/codex\.exe$/i.test(resolved) && (await isFile(resolved)))
            return resolved;
        if (/codex\.cmd$/i.test(resolved)) {
            const native = await nativeBinaryFromCmd(resolved);
            if (native)
                return native;
        }
    }
    if (process.platform === "win32" && process.env.APPDATA) {
        const architecture = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
        const packageName = process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
        const candidate = path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", packageName, "vendor", architecture, "bin", "codex.exe");
        if (await isFile(candidate))
            return candidate;
    }
    throw new Error("Codex executable was not found; install Codex or set CODEX_HARNESS_CODEX_BINARY");
}
async function nativeBinaryFromCmd(commandFile) {
    let content;
    try {
        content = (await readFile(commandFile, "utf8")).slice(0, 64 * 1024);
    }
    catch {
        return undefined;
    }
    const relative = content.match(/%~dp0([^"\r\n]*codex\.exe)/i)?.[1];
    if (!relative)
        return undefined;
    const candidate = path.resolve(path.dirname(commandFile), relative.replaceAll("\\", path.sep));
    return isCodexBinaryName(candidate) && (await isFile(candidate)) ? candidate : undefined;
}
function isCodexBinaryName(candidate) {
    return process.platform === "win32"
        ? path.basename(candidate).toLocaleLowerCase("en-US") === "codex.exe"
        : path.basename(candidate) === "codex";
}
async function isFile(candidate) {
    try {
        return (await stat(candidate)).isFile();
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
//# sourceMappingURL=executables.js.map