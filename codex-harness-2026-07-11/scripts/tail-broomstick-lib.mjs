import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const DOCTOR_KEYS = [
  "schema_version",
  "platform",
  "installed_image",
  "service_request_endpoint",
  "windows_hello",
  "readiness",
];
const DOCTOR_STATES = new Set(["READY", "UNAVAILABLE", "DEGRADED", "UNSUPPORTED"]);
const OS_ENVIRONMENT = [
  "SystemRoot",
  "WINDIR",
  "SystemDrive",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
];
const FIXED_MANIFEST_KEYS = [
  "schemaVersion", "id", "version", "platform", "codexVersion",
  "plugin", "broker", "doctor", "mcp", "hook", "skill", "assets",
];

export async function loadTailBroomstickManifest(root) {
  const text = await readFile(path.join(root, "integrations", "tail-broomstick.json"), "utf8");
  const manifest = JSON.parse(text);
  if (!validateTailBroomstickManifest(manifest)) throw new Error("invalid Tail Broomstick manifest");
  return manifest;
}

export function validateTailBroomstickManifest(manifest) {
  if (!isPlainObject(manifest) || !sameArray(Object.keys(manifest), FIXED_MANIFEST_KEYS)) return false;
  if (manifest.schemaVersion !== 1
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id ?? "")
      || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(manifest.version ?? "")
      || manifest.platform !== "win32"
      || !/^\d+\.\d+\.\d+$/.test(manifest.codexVersion ?? "")) return false;
  if (!isPlainObject(manifest.plugin)
      || !sameArray(Object.keys(manifest.plugin), [
        "name", "marketplace", "source", "installationPolicy", "authenticationPolicy",
      ])
      || manifest.plugin.name !== manifest.id
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.plugin.marketplace ?? "")
      || manifest.plugin.source !== `./plugins/${manifest.plugin.name}`
      || manifest.plugin.installationPolicy !== "AVAILABLE"
      || manifest.plugin.authenticationPolicy !== "ON_INSTALL") return false;
  if (!isPlainObject(manifest.broker)
      || !sameArray(Object.keys(manifest.broker), [
        "executable", "doctorArgs", "mcpArgs", "environmentVariables",
      ])
      || !path.win32.isAbsolute(manifest.broker.executable ?? "")
      || path.win32.basename(manifest.broker.executable).toLocaleLowerCase("en-US") !== "tb.exe"
      || !sameArray(manifest.broker.doctorArgs ?? [], ["doctor", "--json"])
      || !sameArray(manifest.broker.mcpArgs ?? [], ["mcp", "codex-hook"])
      || !sameArray(manifest.broker.environmentVariables ?? [], OS_ENVIRONMENT)) return false;
  if (!isPlainObject(manifest.doctor)
      || !sameArray(Object.keys(manifest.doctor), ["schemaVersion", "timeoutMs", "maxOutputBytes"])
      || manifest.doctor.schemaVersion !== 1
      || !boundedInteger(manifest.doctor.timeoutMs, 1_000, 10_000)
      || !boundedInteger(manifest.doctor.maxOutputBytes, 1_024, 262_144)) return false;
  if (!isPlainObject(manifest.mcp)
      || !sameArray(Object.keys(manifest.mcp), [
        "server", "tool", "cwd", "startupTimeoutSeconds", "toolTimeoutSeconds",
      ])
      || !/^[a-z0-9_]+$/.test(manifest.mcp.server ?? "")
      || !/^[a-z0-9_.]+$/.test(manifest.mcp.tool ?? "")
      || manifest.mcp.cwd !== "."
      || !boundedInteger(manifest.mcp.startupTimeoutSeconds, 1, 10)
      || !boundedInteger(manifest.mcp.toolTimeoutSeconds, 1, 150)) return false;
  if (!isPlainObject(manifest.hook)
      || !sameArray(Object.keys(manifest.hook), ["event", "timeoutSeconds"])
      || manifest.hook.event !== "UserPromptSubmit"
      || !boundedInteger(manifest.hook.timeoutSeconds, 1, 180)
      || manifest.mcp.startupTimeoutSeconds + manifest.mcp.toolTimeoutSeconds
        > manifest.hook.timeoutSeconds - 20) return false;
  if (!isPlainObject(manifest.skill)
      || !sameArray(Object.keys(manifest.skill), ["name"])
      || manifest.skill.name !== manifest.plugin.name) return false;
  const assetsValid = Array.isArray(manifest.assets)
    && manifest.assets.length >= 5
    && manifest.assets.every(exactAsset)
    && manifest.assets.every((asset, index) => index === 0 || asset.path > manifest.assets[index - 1].path);
  if (!assetsValid) return false;
  const requiredAssets = [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "hooks/hooks.json",
    `skills/${manifest.skill.name}/SKILL.md`,
    `skills/${manifest.skill.name}/agents/openai.yaml`,
  ];
  return requiredAssets.every((required) => manifest.assets.some((asset) => asset.path === required));
}

export async function validateTailBroomstickAssets(manifest, root) {
  try {
    if (!validateTailBroomstickManifest(manifest)) return false;
    const pluginRoot = path.join(root, "plugins", manifest.plugin.name);
    const actualPaths = await listAssetPaths(pluginRoot);
    if (!sameArray(actualPaths, manifest.assets.map((asset) => asset.path))) return false;
    const hashes = await Promise.all(manifest.assets.map(async (asset) => ({
      path: asset.path,
      sha256: createHash("sha256")
        .update(await readFile(path.join(pluginRoot, ...asset.path.split("/"))))
        .digest("hex"),
    })));
    if (hashes.some((actual, index) => !exactObject(actual, manifest.assets[index]))) return false;

    const [plugin, mcp, hooks, marketplace, skill] = await Promise.all([
      readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json")),
      readJson(path.join(pluginRoot, ".mcp.json")),
      readJson(path.join(pluginRoot, "hooks", "hooks.json")),
      readJson(path.join(root, ".agents", "plugins", "marketplace.json")),
      readFile(path.join(pluginRoot, "skills", manifest.skill.name, "SKILL.md"), "utf8"),
    ]);
    const entry = marketplace.plugins?.find((candidate) => candidate?.name === manifest.plugin.name);
    const server = mcp.mcpServers?.[manifest.mcp.server];
    const handlers = hooks.hooks?.[manifest.hook.event];
    return plugin.name === manifest.plugin.name
      && plugin.version === manifest.version
      && plugin.skills === "./skills/"
      && plugin.mcpServers === "./.mcp.json"
      && entry?.source?.source === "local"
      && entry.source.path === manifest.plugin.source
      && entry.policy?.installation === manifest.plugin.installationPolicy
      && entry.policy?.authentication === manifest.plugin.authenticationPolicy
      && JSON.stringify(Object.keys(mcp.mcpServers ?? {})) === JSON.stringify([manifest.mcp.server])
      && JSON.stringify(server) === JSON.stringify(expectedMcpServer(manifest))
      && JSON.stringify(Object.keys(hooks.hooks ?? {})) === JSON.stringify([manifest.hook.event])
      && Array.isArray(handlers)
      && handlers.length === 1
      && Array.isArray(handlers[0]?.hooks)
      && handlers[0].hooks.length === 1
      && JSON.stringify(handlers[0].hooks[0]) === JSON.stringify(expectedHook(manifest))
      && skill.replaceAll("\r\n", "\n").startsWith(`---\nname: ${manifest.skill.name}\n`);
  } catch {
    return false;
  }
}

export function tailBroomstickEnvironment(source = process.env) {
  return Object.fromEntries(
    OS_ENVIRONMENT.flatMap((name) => source[name] === undefined ? [] : [[name, source[name]]]),
  );
}

export function parseCodexVersion(output) {
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)\r?\n?$/.exec(output);
  if (!match) throw new Error("invalid Codex version");
  const version = match.slice(1).map(Number);
  if (version.some((part) => !Number.isSafeInteger(part))) throw new Error("invalid Codex version");
  return version;
}

export function supportsCodexVersion(output, expected) {
  const current = parseCodexVersion(output);
  const required = expected.split(".").map(Number);
  if (required.length !== 3 || required.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    throw new Error("invalid Codex version");
  }
  return expected === required.join(".")
    && output.replace(/\r?\n$/, "") === `codex-cli ${expected}`
    && current.every((part, index) => part === required[index]);
}

export function probeCodexHost(manifest, codex, { run = defaultRun } = {}) {
  let result;
  try {
    result = run(codex, ["--version"], { timeout: 10_000, maxBuffer: 64 * 1024 });
  } catch {
    return runtimeResult("DEGRADED", "CODEX_VERSION_UNAVAILABLE");
  }
  if (result.error || result.status !== 0 || result.signal) {
    return runtimeResult("DEGRADED", "CODEX_VERSION_UNAVAILABLE");
  }
  try {
    return supportsCodexVersion(result.stdout ?? "", manifest.codexVersion)
      ? runtimeResult("AVAILABLE", "READY")
      : runtimeResult("UNAVAILABLE", "CODEX_VERSION_UNSUPPORTED");
  } catch {
    return runtimeResult("DEGRADED", "CODEX_VERSION_INVALID");
  }
}

export function parseDoctorOutput(output, doctor) {
  if (Buffer.byteLength(output, "utf8") > doctor.maxOutputBytes) throw new Error("invalid doctor output");
  const value = JSON.parse(output);
  if (!isPlainObject(value) || !sameArray(Object.keys(value), DOCTOR_KEYS)) {
    throw new Error("invalid doctor output");
  }
  if (output !== JSON.stringify(value, null, 2) + "\n") throw new Error("invalid doctor output");
  if (value.schema_version !== doctor.schemaVersion || value.platform !== "WINDOWS") {
    throw new Error("invalid doctor output");
  }
  const states = [
    value.installed_image,
    value.service_request_endpoint,
    value.windows_hello,
    value.readiness,
  ];
  if (!states.every((state) => typeof state === "string" && DOCTOR_STATES.has(state))) {
    throw new Error("invalid doctor output");
  }
  const components = states.slice(0, 3);
  const expected = components.some((state) => state === "DEGRADED" || state === "UNSUPPORTED")
    ? "DEGRADED"
    : components.includes("UNAVAILABLE")
      ? "UNAVAILABLE"
      : "READY";
  if (value.readiness !== expected) throw new Error("invalid doctor output");
  return value;
}

export async function probeTailBroomstick(
  manifest,
  {
    platform = process.platform,
    sourceEnvironment = process.env,
    executableExists = defaultExecutableExists,
    run = defaultRun,
  } = {},
) {
  if (platform !== manifest.platform) return runtimeResult("UNAVAILABLE", "PLATFORM_UNSUPPORTED");
  const programFiles = sourceEnvironment.ProgramFiles;
  if (typeof programFiles !== "string" || programFiles.length === 0) {
    return runtimeResult("DEGRADED", "OS_PATH_UNAVAILABLE");
  }
  const expectedExecutable = path.win32.join(programFiles, "Tail Broomstick", "tb.exe");
  if (!sameWindowsPath(expectedExecutable, manifest.broker.executable)) {
    return runtimeResult("UNAVAILABLE", "BROKER_LOCATION_UNSUPPORTED");
  }
  try {
    if (!(await executableExists(manifest.broker.executable))) {
      return runtimeResult("UNAVAILABLE", "BROKER_NOT_INSTALLED");
    }
  } catch {
    return runtimeResult("DEGRADED", "BROKER_PATH_UNREADABLE");
  }

  let result;
  try {
    result = run(manifest.broker.executable, manifest.broker.doctorArgs, {
      env: tailBroomstickEnvironment(sourceEnvironment),
      timeout: manifest.doctor.timeoutMs,
      maxBuffer: manifest.doctor.maxOutputBytes,
    });
  } catch {
    return runtimeResult("DEGRADED", "DOCTOR_FAILED");
  }
  if (result.error || result.status !== 0 || result.signal) {
    return runtimeResult("DEGRADED", "DOCTOR_FAILED");
  }
  try {
    const report = parseDoctorOutput(result.stdout ?? "", manifest.doctor);
    if (report.readiness === "UNAVAILABLE") return runtimeResult("UNAVAILABLE", "RUNTIME_NOT_READY");
    if (report.readiness !== "READY") return runtimeResult("DEGRADED", "RUNTIME_DEGRADED");
  } catch {
    return runtimeResult("DEGRADED", "DOCTOR_CONTRACT_INVALID");
  }

  let handshake;
  try {
    handshake = run(manifest.broker.executable, manifest.broker.mcpArgs, {
      env: tailBroomstickEnvironment(sourceEnvironment),
      input: mcpProbeInput(),
      timeout: manifest.mcp.startupTimeoutSeconds * 1_000,
      maxBuffer: manifest.doctor.maxOutputBytes,
    });
  } catch {
    return runtimeResult("DEGRADED", "MCP_HANDSHAKE_FAILED");
  }
  if (handshake.error || handshake.status !== 0 || handshake.signal) {
    return runtimeResult("DEGRADED", "MCP_HANDSHAKE_FAILED");
  }
  try {
    validateMcpProbeOutput(handshake.stdout ?? "", manifest);
    return runtimeResult("AVAILABLE", "READY");
  } catch {
    return runtimeResult("DEGRADED", "MCP_CONTRACT_INVALID");
  }
}

export function evaluateTailBroomstick(
  manifest,
  root,
  runtime,
  installed,
  host = runtimeResult("AVAILABLE", "READY"),
  assetsValid = true,
) {
  if (!assetsValid) {
    return capabilityResult(manifest, "DEGRADED", runtime.state, host.state, "DRIFTED", "PLUGIN_ASSET_DRIFT");
  }
  if (!Array.isArray(installed)) {
    return capabilityResult(manifest, "DEGRADED", runtime.state, host.state, "UNKNOWN", "CODEX_STATE_UNAVAILABLE");
  }
  const pluginId = `${manifest.plugin.name}@${manifest.plugin.marketplace}`;
  const entries = installed.filter((candidate) => candidate?.pluginId === pluginId);
  if (entries.length === 0) {
    const state = runtime.state === "DEGRADED" || host.state === "DEGRADED" ? "DEGRADED" : "UNAVAILABLE";
    const reason = host.state !== "AVAILABLE"
      ? host.reason
      : runtime.state === "AVAILABLE" ? "PLUGIN_NOT_INSTALLED" : runtime.reason;
    return capabilityResult(manifest, state, runtime.state, host.state, "NOT_INSTALLED", reason);
  }
  if (entries.length !== 1) {
    return capabilityResult(manifest, "DEGRADED", runtime.state, host.state, "DRIFTED", "PLUGIN_DRIFT");
  }
  const [entry] = entries;
  const expectedSource = path.resolve(root, manifest.plugin.source);
  const exact = entry.installed === true
    && entry.enabled === true
    && entry.version === manifest.version
    && typeof entry.source?.path === "string"
    && path.isAbsolute(entry.source.path)
    && sameHostPath(path.resolve(entry.source.path), expectedSource);
  if (!exact) {
    return capabilityResult(manifest, "DEGRADED", runtime.state, host.state, "DRIFTED", "PLUGIN_DRIFT");
  }
  if (runtime.state !== "AVAILABLE" || host.state !== "AVAILABLE") {
    return capabilityResult(manifest, "DEGRADED", runtime.state, host.state, "INSTALLED", "STALE_PLUGIN_ENABLED");
  }
  return capabilityResult(manifest, "AVAILABLE", "AVAILABLE", "AVAILABLE", "INSTALLED", "READY");
}

export function reconcileTailBroomstickPlugin(
  manifest,
  root,
  runtime,
  host,
  assetsValid,
  initialInstalled,
  { run },
) {
  const pluginId = `${manifest.plugin.name}@${manifest.plugin.marketplace}`;
  const shouldEnable = assetsValid && runtime.state === "AVAILABLE" && host.state === "AVAILABLE";
  let failed = !Array.isArray(initialInstalled);
  const initial = Array.isArray(initialInstalled) ? initialInstalled : [];
  const initiallyPresent = initial.some((entry) => entry?.pluginId === pluginId);

  if (shouldEnable) {
    if (evaluateTailBroomstick(manifest, root, runtime, initial, host, assetsValid).state !== "AVAILABLE") {
      failed = !runPluginMutation(run, "add", pluginId) || failed;
    }
  } else if (initiallyPresent) {
    failed = !runPluginMutation(run, "remove", pluginId) || failed;
  }

  let finalInstalled = readInstalledPlugins(run);
  failed = !Array.isArray(finalInstalled) || failed;
  let capability = evaluateTailBroomstick(
    manifest,
    root,
    runtime,
    finalInstalled,
    host,
    assetsValid,
  );
  const finalEntries = finalInstalled?.filter((entry) => entry?.pluginId === pluginId);
  const finalMatches = shouldEnable ? capability.state === "AVAILABLE" : finalEntries?.length === 0;
  failed = !finalMatches || failed;

  if (!finalMatches && finalEntries?.length !== 0) {
    failed = !runPluginMutation(run, "remove", pluginId) || failed;
    finalInstalled = readInstalledPlugins(run);
    failed = !Array.isArray(finalInstalled) || failed;
    capability = evaluateTailBroomstick(
      manifest,
      root,
      runtime,
      finalInstalled,
      host,
      assetsValid,
    );
  }

  if (failed) {
    capability = {
      ...capability,
      state: "DEGRADED",
      reason: shouldEnable ? "PLUGIN_ENABLE_FAILED" : "PLUGIN_DISABLE_FAILED",
    };
  }
  return { tailBroomstick: capability, failed };
}

function runtimeResult(state, reason) {
  return { state, reason };
}

function capabilityResult(manifest, state, runtimeState, hostState, pluginState, reason) {
  return {
    schemaVersion: 1,
    capability: manifest.id,
    version: manifest.version,
    state,
    runtimeState,
    hostState,
    pluginState,
    reason,
  };
}

async function defaultExecutableExists(executable) {
  try {
    await access(executable);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function defaultRun(executable, args, options) {
  return spawnSync(executable, args, {
    ...options,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactObject(actual, expected) {
  return isPlainObject(actual) && JSON.stringify(actual) === JSON.stringify(expected);
}

function exactAsset(asset) {
  return isPlainObject(asset)
    && sameArray(Object.keys(asset), ["path", "sha256"])
    && typeof asset.path === "string"
    && !path.posix.isAbsolute(asset.path)
    && !asset.path.includes("\\")
    && asset.path.split("/").every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..")
    && /^[0-9a-f]{64}$/.test(asset.sha256 ?? "");
}

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function sameWindowsPath(left, right) {
  return path.win32.normalize(left).toLocaleLowerCase("en-US")
    === path.win32.normalize(right).toLocaleLowerCase("en-US");
}

function sameHostPath(left, right) {
  return process.platform === "win32" ? sameWindowsPath(left, right) : left === right;
}

function expectedMcpServer(manifest) {
  return {
    type: "stdio",
    command: manifest.broker.executable,
    args: manifest.broker.mcpArgs,
    env_vars: manifest.broker.environmentVariables,
    cwd: manifest.mcp.cwd,
    enabled: true,
    required: true,
    enabled_tools: [manifest.mcp.tool],
    default_tools_approval_mode: "prompt",
    startup_timeout_sec: manifest.mcp.startupTimeoutSeconds,
    tool_timeout_sec: manifest.mcp.toolTimeoutSeconds,
  };
}

function expectedHook(manifest) {
  return {
    type: "mcp_tool",
    server: manifest.mcp.server,
    tool: manifest.mcp.tool,
    input: { prompt: "${prompt}" },
    timeout: manifest.hook.timeoutSeconds,
  };
}

function mcpProbeInput() {
  return [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "tail-broomstick-harness-probe", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n";
}

function validateMcpProbeOutput(output, manifest) {
  if (Buffer.byteLength(output, "utf8") > manifest.doctor.maxOutputBytes) {
    throw new Error("invalid MCP output");
  }
  const messages = output.split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const initialize = messages.filter((message) => message?.id === 1);
  const listed = messages.filter((message) => message?.id === 2);
  if (initialize.length !== 1 || listed.length !== 1
      || !isPlainObject(initialize[0].result) || initialize[0].error !== undefined
      || typeof initialize[0].result.protocolVersion !== "string"
      || !isPlainObject(initialize[0].result.capabilities?.tools)
      || typeof initialize[0].result.serverInfo?.name !== "string"
      || typeof initialize[0].result.serverInfo?.version !== "string"
      || !Array.isArray(listed[0].result?.tools) || listed[0].error !== undefined) {
    throw new Error("invalid MCP output");
  }
  const tools = listed[0].result.tools.filter((tool) => tool?.name === manifest.mcp.tool);
  const schema = tools[0]?.inputSchema;
  if (tools.length !== 1 || schema?.type !== "object"
      || !isPlainObject(schema.properties)
      || !sameArray(Object.keys(schema.properties), ["prompt"])
      || schema.properties?.prompt?.type !== "string"
      || !Array.isArray(schema.required) || !sameArray(schema.required, ["prompt"])
      || schema.additionalProperties !== false) {
    throw new Error("invalid MCP output");
  }
}

function runPluginMutation(run, action, pluginId) {
  try {
    const result = run(["plugin", action, pluginId, "--json"]);
    return !result?.error && result?.status === 0 && !result?.signal;
  } catch {
    return false;
  }
}

function readInstalledPlugins(run) {
  try {
    const result = run(["plugin", "list", "--json"]);
    if (result?.error || result?.status !== 0 || result?.signal) return undefined;
    const parsed = JSON.parse(result.stdout ?? "");
    return Array.isArray(parsed.installed) ? parsed.installed : undefined;
  } catch {
    return undefined;
  }
}

async function listAssetPaths(root, relative = "") {
  const entries = await readdir(path.join(root, ...relative.split("/").filter(Boolean)), {
    withFileTypes: true,
  });
  const paths = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const candidate = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error("plugin assets cannot contain links");
    if (entry.isDirectory()) {
      paths.push(...await listAssetPaths(root, candidate));
    } else if (entry.isFile()) {
      paths.push(candidate);
    } else {
      throw new Error("plugin assets must be regular files");
    }
  }
  return paths.sort(compareText);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
