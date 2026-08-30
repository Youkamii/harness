import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexExecutable } from "../plugins/codex-harness/runtime/executables.js";
import {
  loadTailBroomstickManifest,
  probeCodexHost,
  probeTailBroomstick,
  reconcileTailBroomstickPlugin,
  validateTailBroomstickAssets,
} from "./tail-broomstick-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketplaceName = "youkamii-harness";
const pluginId = `codex-harness@${marketplaceName}`;
const codex = await resolveCodexExecutable();
const fixedTailPluginId = `tail-broomstick-core@${marketplaceName}`;
const CODEX_COMMAND_TIMEOUT_MS = 30_000;

function run(args, { allowFailure = false } = {}) {
  const result = spawnSync(codex, args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: CODEX_COMMAND_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (!allowFailure && (result.error || result.status !== 0 || result.signal)) {
    throw new Error(`${args.join(" ")} failed`);
  }
  return result;
}

const marketplaces = JSON.parse(run(["plugin", "marketplace", "list", "--json"]).stdout).marketplaces;
const configured = marketplaces.find((entry) => entry.name === marketplaceName);
if (configured && path.resolve(configured.root) !== root) {
  throw new Error(`${marketplaceName} already points at a different marketplace: ${configured.root}`);
}
if (!configured) run(["plugin", "marketplace", "add", root, "--json"]);

run(["plugin", "add", pluginId, "--json"]);

const after = JSON.parse(run(["plugin", "list", "--json"]).stdout).installed;
const installed = after.find((entry) => entry.pluginId === pluginId);
const expectedSource = path.join(root, "plugins", "codex-harness");
if (!installed?.installed || !installed.enabled || path.resolve(installed.source?.path ?? "") !== expectedSource) {
  throw new Error("Codex did not report the expected local plugin as installed and enabled");
}

let tailBroomstick = {
  schemaVersion: 1,
  capability: "tail-broomstick-core",
  version: "UNKNOWN",
  state: "DEGRADED",
  runtimeState: "DEGRADED",
  hostState: "DEGRADED",
  pluginState: "UNKNOWN",
  reason: "INTEGRATION_CONTRACT_INVALID",
};
let tailInstallFailed = false;
try {
  const tailManifest = await loadTailBroomstickManifest(root);
  const assetsValid = await validateTailBroomstickAssets(tailManifest, root);
  const runtime = await probeTailBroomstick(tailManifest);
  const host = probeCodexHost(tailManifest, codex);
  const reconciled = reconcileTailBroomstickPlugin(
    tailManifest,
    root,
    runtime,
    host,
    assetsValid,
    after,
    { run: (args) => run(args, { allowFailure: true }) },
  );
  tailBroomstick = reconciled.tailBroomstick;
  tailInstallFailed = reconciled.failed;
} catch {
  tailInstallFailed = true;
  if (after.some((entry) => entry.pluginId === fixedTailPluginId && entry.installed)) {
    const removed = run(["plugin", "remove", fixedTailPluginId, "--json"], { allowFailure: true });
    const listed = run(["plugin", "list", "--json"], { allowFailure: true });
    let stillInstalled = true;
    try {
      const entries = JSON.parse(listed.stdout).installed;
      stillInstalled = !Array.isArray(entries)
        || entries.some((entry) => entry?.pluginId === fixedTailPluginId && entry.installed);
    } catch {
      stillInstalled = true;
    }
    if (removed.error || removed.status !== 0 || removed.signal
        || listed.error || listed.status !== 0 || listed.signal || stillInstalled) {
      tailBroomstick.reason = "PLUGIN_DISABLE_FAILED";
    }
  }
}
process.stdout.write(JSON.stringify({
  installed: true,
  pluginId,
  marketplaceRoot: root,
  source: expectedSource,
  tailBroomstick,
}, null, 2) + "\n");
if (tailInstallFailed) process.exitCode = 1;
