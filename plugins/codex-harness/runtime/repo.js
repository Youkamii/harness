import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./hash.js";
import { runChecked, runProcess } from "./process.js";
const MAX_SUBMODULE_DEPTH = 16;
export async function discoverRepo(cwd) {
    const rootResult = await runChecked({
        executable: "git",
        args: ["rev-parse", "--show-toplevel"],
        cwd,
    });
    const root = await realpath(rootResult.stdout.trim());
    const commonResult = await runChecked({
        executable: "git",
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd: root,
    });
    const gitCommonDir = await realpath(commonResult.stdout.trim());
    return {
        root,
        gitCommonDir,
        stateRoot: path.join(gitCommonDir, "codex-harness"),
    };
}
export async function workspaceFingerprint(repoRoot) {
    const canonicalRoot = await realpath(repoRoot);
    return await fingerprintRepository(canonicalRoot, { depth: 0, visited: new Set() });
}
async function fingerprintRepository(canonicalRoot, traversal) {
    if (traversal.depth > MAX_SUBMODULE_DEPTH) {
        throw new Error(`submodule depth exceeds ${MAX_SUBMODULE_DEPTH}: ${canonicalRoot}`);
    }
    if (traversal.visited.has(canonicalRoot)) {
        throw new Error(`submodule cycle detected at ${canonicalRoot}`);
    }
    traversal.visited.add(canonicalRoot);
    const filesResult = await runChecked({
        executable: "git",
        args: ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd: canonicalRoot,
    });
    const files = [...new Set(filesResult.stdout.split("\u0000").filter(Boolean))].sort();
    const gitlinks = await trackedGitlinks(canonicalRoot);
    const hashes = [];
    for (const relativePath of files) {
        const absolutePath = path.resolve(canonicalRoot, relativePath);
        assertWithin(canonicalRoot, absolutePath);
        const gitlink = gitlinks.get(relativePath);
        if (gitlink) {
            if (!(await pathExists(absolutePath))) {
                hashes.push(`${relativePath}:gitlink:index=${gitlink}:working=unavailable:content=unavailable`);
                continue;
            }
            const canonicalSubmodule = await realpath(absolutePath);
            assertWithin(canonicalRoot, canonicalSubmodule);
            if (traversal.visited.has(canonicalSubmodule)) {
                throw new Error(`submodule cycle detected at ${relativePath}`);
            }
            if (traversal.depth >= MAX_SUBMODULE_DEPTH) {
                throw new Error(`submodule depth exceeds ${MAX_SUBMODULE_DEPTH}: ${relativePath}`);
            }
            const working = await runProcess({
                executable: "git",
                args: ["-C", canonicalSubmodule, "rev-parse", "HEAD"],
                cwd: canonicalRoot,
            });
            let nestedFingerprint = "unavailable";
            if (working.exitCode === 0) {
                nestedFingerprint = await fingerprintRepository(canonicalSubmodule, {
                    depth: traversal.depth + 1,
                    visited: traversal.visited,
                });
            }
            hashes.push(`${relativePath}:gitlink:index=${gitlink}:working=${working.exitCode === 0 ? working.stdout.trim() : "unavailable"}:content=${nestedFingerprint}`);
            continue;
        }
        try {
            const metadata = await lstat(absolutePath);
            if (metadata.isSymbolicLink()) {
                hashes.push(`${relativePath}:symlink:${await readlink(absolutePath)}`);
            }
            else if (metadata.isFile()) {
                const resolved = await realpath(absolutePath);
                assertWithin(canonicalRoot, resolved);
                hashes.push(`${relativePath}:file:${metadata.mode.toString(8)}:${sha256(await readFile(resolved))}`);
            }
            else {
                hashes.push(`${relativePath}:unsupported`);
            }
        }
        catch {
            if ((await pathExists(absolutePath)) === false)
                continue;
            hashes.push(`${relativePath}:unreadable`);
        }
    }
    return sha256(hashes.join("\n"));
}
async function trackedGitlinks(repoRoot) {
    const result = await runChecked({
        executable: "git",
        args: ["ls-files", "--stage", "-z"],
        cwd: repoRoot,
    });
    const gitlinks = new Map();
    for (const record of result.stdout.split("\u0000").filter(Boolean)) {
        const match = record.match(/^(\d{6}) ([0-9a-f]{40,64}) \d\t(.+)$/s);
        if (match?.[1] === "160000" && match[2] && match[3])
            gitlinks.set(match[3], match[2]);
    }
    return gitlinks;
}
/** Resolve an existing candidate and reject symlink or junction escapes from root. */
export async function realpathWithin(root, candidate) {
    const canonicalRoot = await realpath(root);
    const canonicalCandidate = await realpath(candidate);
    assertWithin(canonicalRoot, canonicalCandidate);
    return canonicalCandidate;
}
async function pathExists(candidate) {
    try {
        await lstat(candidate);
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
export function assertWithin(root, candidate) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)))
        return;
    throw new Error(`path escapes repository: ${candidate}`);
}
//# sourceMappingURL=repo.js.map