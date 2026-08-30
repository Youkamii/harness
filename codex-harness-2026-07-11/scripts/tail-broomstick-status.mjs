import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexExecutable } from "../plugins/codex-harness/runtime/executables.js";
import {
  evaluateTailBroomstick,
  loadTailBroomstickManifest,
  probeCodexHost,
  probeTailBroomstick,
  validateTailBroomstickAssets,
} from "./tail-broomstick-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fallback = {
  schemaVersion: 1,
  capability: "tail-broomstick-core",
  version: "UNKNOWN",
  state: "DEGRADED",
  runtimeState: "DEGRADED",
  hostState: "DEGRADED",
  pluginState: "UNKNOWN",
  reason: "INTEGRATION_CONTRACT_INVALID",
};

async function status() {
  try {
    const manifest = await loadTailBroomstickManifest(root);
    const assetsValid = await validateTailBroomstickAssets(manifest, root);
    const runtime = await probeTailBroomstick(manifest);
    let installed;
    let host = { state: "DEGRADED", reason: "CODEX_VERSION_UNAVAILABLE" };
    try {
      const codex = await resolveCodexExecutable();
      host = probeCodexHost(manifest, codex);
      const result = spawnSync(codex, ["plugin", "list", "--json"], {
        cwd: root,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      });
      if (result.status === 0 && !result.error && !result.signal) {
        const value = JSON.parse(result.stdout);
        if (Array.isArray(value.installed)) installed = value.installed;
      }
    } catch {
      installed = undefined;
    }
    return evaluateTailBroomstick(manifest, root, runtime, installed, host, assetsValid);
  } catch {
    return fallback;
  }
}

process.stdout.write(JSON.stringify(await status(), null, 2) + "\n");
