import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./hash.js";
import { runChecked } from "./process.js";

export interface RepoContext {
  root: string;
  gitCommonDir: string;
  stateRoot: string;
}

export async function discoverRepo(cwd: string): Promise<RepoContext> {
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

export async function workspaceFingerprint(repoRoot: string): Promise<string> {
  const head = await runChecked({
    executable: "git",
    args: ["rev-parse", "HEAD"],
    cwd: repoRoot,
  });
  const diff = await runChecked({
    executable: "git",
    args: ["diff", "--binary", "--no-ext-diff", "HEAD", "--"],
    cwd: repoRoot,
    maxOutputBytes: 16 * 1024 * 1024,
  });
  const untrackedResult = await runChecked({
    executable: "git",
    args: ["ls-files", "--others", "--exclude-standard", "-z"],
    cwd: repoRoot,
  });
  const untracked = untrackedResult.stdout.split("\u0000").filter(Boolean).sort();
  const hashes: string[] = [];
  for (const relativePath of untracked) {
    const absolutePath = path.resolve(repoRoot, relativePath);
    assertWithin(repoRoot, absolutePath);
    try {
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        hashes.push(`${relativePath}:symlink:${await readlink(absolutePath)}`);
      } else if (metadata.isFile()) {
        const resolved = await realpath(absolutePath);
        assertWithin(repoRoot, resolved);
        hashes.push(`${relativePath}:${sha256(await readFile(resolved))}`);
      } else {
        hashes.push(`${relativePath}:unsupported`);
      }
    } catch {
      hashes.push(`${relativePath}:unreadable`);
    }
  }
  return sha256([head.stdout.trim(), diff.stdout, ...hashes].join("\n"));
}

export function assertWithin(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`path escapes repository: ${candidate}`);
}
