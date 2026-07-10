import { resolveCodexExecutable } from "./executables.js";
import { runProcess } from "./process.js";
import { githubControllerEnvironment, redactSecrets, sanitizedEnvironment } from "./redact.js";

export interface DoctorCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export async function runDoctor(repoRoot: string): Promise<{ passed: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  checks.push({
    name: "node-version",
    passed: nodeAtLeast(20, 11),
    detail: process.version,
  });
  checks.push(await commandCheck("git", "git", ["rev-parse", "--show-toplevel"], repoRoot));
  checks.push(
    await commandCheck(
      "github-auth",
      "gh",
      ["auth", "status", "--hostname", "github.com"],
      repoRoot,
      githubControllerEnvironment(),
    ),
  );

  try {
    const codex = await resolveCodexExecutable();
    const codexCheck = await commandCheck("codex", codex, ["--version"], repoRoot);
    const version = codexCheck.detail.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
    if (codexCheck.passed && (!version || !versionAtLeast(version, [0, 144, 1]))) {
      codexCheck.passed = false;
      codexCheck.detail += " (minimum supported version is 0.144.1)";
    }
    checks.push(codexCheck);
    checks.push(
      await commandCheck(
        "verification-sandbox",
        codex,
        [
          "sandbox",
          "--sandbox-state-disable-network",
          "-P",
          ":workspace",
          "-C",
          repoRoot,
          "--",
          process.execPath,
          "--version",
        ],
        repoRoot,
      ),
    );
  } catch (error) {
    checks.push({
      name: "codex",
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return { passed: checks.every((check) => check.passed), checks };
}

async function commandCheck(
  name: string,
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = sanitizedEnvironment(),
): Promise<DoctorCheck> {
  try {
    const result = await runProcess({
      executable,
      args,
      cwd,
      env,
      timeoutMs: 30_000,
      maxOutputBytes: 256 * 1024,
    });
    const detail = redactSecrets([result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim())
      .slice(0, 1_000);
    return {
      name,
      passed: result.exitCode === 0 && !result.timedOut,
      detail: detail || `exit ${result.exitCode}`,
    };
  } catch (error) {
    return { name, passed: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function nodeAtLeast(major: number, minor: number): boolean {
  const [currentMajor = 0, currentMinor = 0] = process.versions.node.split(".").map(Number);
  return currentMajor > major || (currentMajor === major && currentMinor >= minor);
}

function versionAtLeast(current: number[], minimum: number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    const difference = (current[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}
