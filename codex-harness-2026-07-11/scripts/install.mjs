import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexExecutable } from "../plugins/codex-harness/runtime/executables.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketplaceName = "youkamii-harness";
const pluginId = `codex-harness@${marketplaceName}`;
const codex = await resolveCodexExecutable();

function run(args, { allowFailure = false } = {}) {
  const result = spawnSync(codex, args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
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
process.stdout.write(JSON.stringify({ installed: true, pluginId, marketplaceRoot: root, source: expectedSource }, null, 2) + "\n");
