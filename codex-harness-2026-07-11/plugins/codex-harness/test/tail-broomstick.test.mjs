import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp, mkdir, mkdtemp, readFile, rm, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  evaluateTailBroomstick,
  loadTailBroomstickManifest,
  parseDoctorOutput,
  probeCodexHost,
  probeTailBroomstick,
  reconcileTailBroomstickPlugin,
  supportsCodexVersion,
  tailBroomstickEnvironment,
  validateTailBroomstickAssets,
  validateTailBroomstickManifest,
} from "../../../scripts/tail-broomstick-lib.mjs";

const root = path.resolve(".");
const manifest = await loadTailBroomstickManifest(root);
const secretCanary = ["synthetic", "secret", "canary"].join("-");
const promptCanary = ["extra", "synthetic", "value", "canary"].join("-");

function windowsEnvironment(overrides = {}) {
  return {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    SystemDrive: "C:",
    ProgramData: "C:\\ProgramData",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    ProgramW6432: "C:\\Program Files",
    ...overrides,
  };
}

function doctor(overrides = {}) {
  return JSON.stringify({
    schema_version: 1,
    platform: "WINDOWS",
    installed_image: "READY",
    service_request_endpoint: "READY",
    windows_hello: "READY",
    readiness: "READY",
    ...overrides,
  }, null, 2) + "\n";
}

function installed(overrides = {}) {
  return [{
    pluginId: "tail-broomstick-core@youkamii-harness",
    installed: true,
    enabled: true,
    version: manifest.version,
    source: { path: path.join(root, "plugins", "tail-broomstick-core") },
    ...overrides,
  }];
}

function handshake(tool = manifest.mcp.tool) {
  return [
    {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [{
          name: tool,
          inputSchema: {
            type: "object",
            properties: { prompt: { type: "string" } },
            required: ["prompt"],
            additionalProperties: false,
          },
        }],
      },
    },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n";
}

test("doctor contract accepts only canonical, consistent, value-free JSON", () => {
  assert.equal(parseDoctorOutput(doctor(), manifest.doctor).readiness, "READY");
  for (const invalid of [
    doctor({ readiness: "UNAVAILABLE" }),
    doctor({ secret: secretCanary }),
    doctor().replace("\n", ""),
    doctor().replace('  "readiness": "READY"', '  "readiness": "READY",\n  "readiness": "READY"'),
  ]) {
    assert.throws(() => parseDoctorOutput(invalid, manifest.doctor), /invalid doctor output/);
  }
});

test("probe uses an absolute argv call and only the seven OS variables", async () => {
  const calls = [];
  const runtime = await probeTailBroomstick(manifest, {
    platform: "win32",
    sourceEnvironment: windowsEnvironment({
      PATH: "synthetic-path",
      GH_TOKEN: secretCanary,
    }),
    executableExists: async () => true,
    run(executable, args, options) {
      calls.push({ executable, args, options });
      return { status: 0, stdout: args[0] === "doctor" ? doctor() : handshake(), stderr: "" };
    },
  });
  assert.equal(runtime.state, "AVAILABLE");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.args), [manifest.broker.doctorArgs, manifest.broker.mcpArgs]);
  for (const call of calls) {
    assert.equal(call.executable, manifest.broker.executable);
    assert.deepEqual(Object.keys(call.options.env).sort(), [
      "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
      "SystemDrive", "SystemRoot", "WINDIR",
    ]);
  }
  assert.equal(calls[1].options.timeout, manifest.mcp.startupTimeoutSeconds * 1_000);
  assert.match(calls[1].options.input, /"method":"initialize"/);
  assert.match(calls[1].options.input, /"method":"tools\/list"/);
  assert.equal(JSON.stringify(calls).includes(secretCanary), false);
  assert.doesNotMatch(JSON.stringify(calls), /synthetic-path/);
});

test("READY doctor is not enough when the value-free MCP handshake is broken", async () => {
  let call = 0;
  const runtime = await probeTailBroomstick(manifest, {
    platform: "win32",
    sourceEnvironment: windowsEnvironment(),
    executableExists: async () => true,
    run() {
      call += 1;
      return { status: 0, stdout: call === 1 ? doctor() : handshake("wrong.tool"), stderr: "" };
    },
  });
  assert.deepEqual(runtime, { state: "DEGRADED", reason: "MCP_CONTRACT_INVALID" });
});

test("probe fails closed without reflecting broker output", async () => {
  const runtime = await probeTailBroomstick(manifest, {
    platform: "win32",
    sourceEnvironment: windowsEnvironment(),
    executableExists: async () => true,
    run: () => ({ status: 0, stdout: secretCanary, stderr: "second-canary" }),
  });
  assert.deepEqual(runtime, { state: "DEGRADED", reason: "DOCTOR_CONTRACT_INVALID" });
  assert.doesNotMatch(JSON.stringify(runtime), /canary/);
});

test("probe distinguishes absence from unreadable or failed runtime", async () => {
  const unavailable = await probeTailBroomstick(manifest, {
    platform: "linux",
    executableExists: async () => { throw new Error("must not run"); },
  });
  assert.deepEqual(unavailable, { state: "UNAVAILABLE", reason: "PLATFORM_UNSUPPORTED" });

  const unreadable = await probeTailBroomstick(manifest, {
    platform: "win32",
    sourceEnvironment: windowsEnvironment(),
    executableExists: async () => { throw new Error(secretCanary); },
  });
  assert.deepEqual(unreadable, { state: "DEGRADED", reason: "BROKER_PATH_UNREADABLE" });

  const failed = await probeTailBroomstick(manifest, {
    platform: "win32",
    sourceEnvironment: windowsEnvironment(),
    executableExists: async () => true,
    run: () => { throw new Error(secretCanary); },
  });
  assert.deepEqual(failed, { state: "DEGRADED", reason: "DOCTOR_FAILED" });
  assert.doesNotMatch(JSON.stringify([unreadable, failed]), /canary/);
});

test("missing runtime stays unavailable and an enabled stale plugin is degraded", async () => {
  const runtime = await probeTailBroomstick(manifest, {
    platform: "win32",
    sourceEnvironment: windowsEnvironment(),
    executableExists: async () => false,
  });
  assert.equal(runtime.state, "UNAVAILABLE");
  assert.equal(evaluateTailBroomstick(manifest, root, runtime, []).state, "UNAVAILABLE");
  const stale = evaluateTailBroomstick(manifest, root, runtime, installed());
  assert.equal(stale.state, "DEGRADED");
  assert.equal(stale.reason, "STALE_PLUGIN_ENABLED");
});

test("only an exact installed plugin and READY runtime are available", () => {
  const runtime = { state: "AVAILABLE", reason: "READY" };
  assert.equal(evaluateTailBroomstick(manifest, root, runtime, installed()).state, "AVAILABLE");
  assert.equal(
    evaluateTailBroomstick(manifest, root, runtime, installed({ version: "9.9.9" })).reason,
    "PLUGIN_DRIFT",
  );
  assert.equal(evaluateTailBroomstick(manifest, root, runtime, undefined).reason, "CODEX_STATE_UNAVAILABLE");
  assert.equal(
    evaluateTailBroomstick(manifest, root, runtime, installed(), undefined, false).reason,
    "PLUGIN_ASSET_DRIFT",
  );
  assert.equal(
    evaluateTailBroomstick(manifest, root, runtime, [...installed(), ...installed()]).reason,
    "PLUGIN_DRIFT",
  );
});

test("checked-in plugin assets match the single integration manifest", async () => {
  assert.equal(validateTailBroomstickManifest(manifest), true);
  assert.equal(await validateTailBroomstickAssets(manifest, root), true);
});

test("asset validation rejects unlisted or changed plugin files", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "harness-tail-assets-"));
  try {
    const pluginRoot = path.join(temporaryRoot, "plugins", manifest.plugin.name);
    await mkdir(path.join(temporaryRoot, ".agents", "plugins"), { recursive: true });
    await cp(path.join(root, "plugins", manifest.plugin.name), pluginRoot, { recursive: true });
    await cp(
      path.join(root, ".agents", "plugins", "marketplace.json"),
      path.join(temporaryRoot, ".agents", "plugins", "marketplace.json"),
    );
    assert.equal(await validateTailBroomstickAssets(manifest, temporaryRoot), true);
    await writeFile(path.join(pluginRoot, "unlisted.txt"), "not allowed\n");
    assert.equal(await validateTailBroomstickAssets(manifest, temporaryRoot), false);
    await rm(path.join(pluginRoot, "unlisted.txt"));
    await writeFile(path.join(pluginRoot, ".mcp.json"), "{}\n");
    assert.equal(await validateTailBroomstickAssets(manifest, temporaryRoot), false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("manifest validation pins every security boundary", async () => {
  for (const mutate of [
    (value) => { value.broker.environmentVariables.push("GH_TOKEN"); },
    (value) => { value.broker.executable = "tb.exe"; },
    (value) => { value.broker.mcpArgs = ["mcp", "unsafe"]; },
    (value) => { value.mcp.cwd = "C:\\"; },
    (value) => { value.mcp.toolTimeoutSeconds = 151; },
    (value) => { value.hook.timeoutSeconds = 179; },
    (value) => { value.codexVersion = "latest"; },
    (value) => { value.assets[0].sha256 = "not-a-hash"; },
    (value) => { value.extra = true; },
  ]) {
    const drifted = structuredClone(manifest);
    mutate(drifted);
    assert.equal(validateTailBroomstickManifest(drifted), false);
    assert.equal(await validateTailBroomstickAssets(drifted, root), false);
  }

  for (const mutate of [
    (value) => { value.mcp.tool = "tail_broomstick.changed"; },
    (value) => { value.assets[0].sha256 = "0".repeat(64); },
  ]) {
    const drifted = structuredClone(manifest);
    mutate(drifted);
    assert.equal(validateTailBroomstickManifest(drifted), true);
    assert.equal(await validateTailBroomstickAssets(drifted, root), false);
  }

  const nextTestedHost = structuredClone(manifest);
  nextTestedHost.codexVersion = "0.149.2";
  assert.equal(validateTailBroomstickManifest(nextTestedHost), true);
  assert.equal(await validateTailBroomstickAssets(nextTestedHost, root), true);
});

test("environment helper never retains arbitrary variables", () => {
  assert.deepEqual(tailBroomstickEnvironment({ PATH: "x", GH_TOKEN: "y", SystemRoot: "z" }), {
    SystemRoot: "z",
  });
});

test("probe rejects a relocated or missing Program Files root", async () => {
  assert.deepEqual(await probeTailBroomstick(manifest, {
    platform: "win32",
    sourceEnvironment: windowsEnvironment({ ProgramFiles: "D:\\Programs" }),
    executableExists: async () => { throw new Error("must not run"); },
  }), { state: "UNAVAILABLE", reason: "BROKER_LOCATION_UNSUPPORTED" });
  assert.deepEqual(await probeTailBroomstick(manifest, {
    platform: "win32",
    sourceEnvironment: windowsEnvironment({ ProgramFiles: "" }),
    executableExists: async () => { throw new Error("must not run"); },
  }), { state: "DEGRADED", reason: "OS_PATH_UNAVAILABLE" });
});

test("Codex host compatibility is pinned without reflecting version output", () => {
  assert.equal(supportsCodexVersion("codex-cli 0.149.1\n", manifest.codexVersion), true);
  assert.equal(supportsCodexVersion("codex-cli 0.149.0\n", manifest.codexVersion), false);
  assert.equal(supportsCodexVersion("codex-cli 0.149.2\n", manifest.codexVersion), false);
  assert.equal(supportsCodexVersion("codex-cli 0.0149.1\n", manifest.codexVersion), false);
  assert.deepEqual(
    probeCodexHost(manifest, "codex.exe", {
      run: () => ({ status: 0, stdout: secretCanary, stderr: "" }),
    }),
    { state: "DEGRADED", reason: "CODEX_VERSION_INVALID" },
  );
});

test("plugin reconciliation reports add, remove, or list failures", () => {
  const ready = { state: "AVAILABLE", reason: "READY" };
  const unavailable = { state: "UNAVAILABLE", reason: "RUNTIME_NOT_READY" };
  const addFailed = reconcileTailBroomstickPlugin(
    manifest, root, ready, ready, true, [],
    { run: (args) => args[1] === "list"
      ? { status: 0, stdout: JSON.stringify({ installed: [] }) }
      : { status: 1, stdout: secretCanary } },
  );
  assert.equal(addFailed.failed, true);
  assert.equal(addFailed.tailBroomstick.reason, "PLUGIN_ENABLE_FAILED");
  assert.doesNotMatch(JSON.stringify(addFailed), /canary/);

  const removeFailed = reconcileTailBroomstickPlugin(
    manifest, root, unavailable, ready, true, installed(),
    { run: (args) => args[1] === "list"
      ? { status: 0, stdout: JSON.stringify({ installed: installed() }) }
      : { status: 1, stderr: secretCanary } },
  );
  assert.equal(removeFailed.failed, true);
  assert.equal(removeFailed.tailBroomstick.reason, "PLUGIN_DISABLE_FAILED");
  assert.doesNotMatch(JSON.stringify(removeFailed), /canary/);

  const listFailed = reconcileTailBroomstickPlugin(
    manifest, root, unavailable, ready, true, [],
    { run: () => ({ status: 1 }) },
  );
  assert.equal(listFailed.failed, true);
});

test("plugin reconciliation verifies the requested final state", () => {
  const ready = { state: "AVAILABLE", reason: "READY" };
  const unavailable = { state: "UNAVAILABLE", reason: "RUNTIME_NOT_READY" };
  let entries = [];
  const run = (args) => {
    if (args[1] === "add") entries = installed();
    if (args[1] === "remove") entries = [];
    return args[1] === "list"
      ? { status: 0, stdout: JSON.stringify({ installed: entries }) }
      : { status: 0, stdout: "{}" };
  };
  const enabled = reconcileTailBroomstickPlugin(manifest, root, ready, ready, true, entries, { run });
  assert.equal(enabled.failed, false);
  assert.equal(enabled.tailBroomstick.state, "AVAILABLE");
  const disabled = reconcileTailBroomstickPlugin(
    manifest, root, unavailable, ready, true, entries, { run },
  );
  assert.equal(disabled.failed, false);
  assert.equal(disabled.tailBroomstick.pluginState, "NOT_INSTALLED");

  entries = installed({ installed: false, enabled: false });
  const removedDrift = reconcileTailBroomstickPlugin(
    manifest, root, unavailable, ready, true, entries, { run },
  );
  assert.equal(removedDrift.failed, false);
  assert.equal(entries.length, 0);
});

test("installer routes every Codex subprocess through one finite timeout", async () => {
  const source = await readFile(path.join(root, "scripts", "install.mjs"), "utf8");
  assert.equal(source.match(/spawnSync\(/g)?.length, 1);
  assert.match(source, /const CODEX_COMMAND_TIMEOUT_MS = 30_000;/);
  assert.match(source, /timeout: CODEX_COMMAND_TIMEOUT_MS,/);
});

test("prompt-fire fixture blocks the namespace and invokes only the exact alias", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "harness-tail-fixture-test-"));
  const marker = path.join(temporaryRoot, "invoked");
  const fixture = path.join(root, "scripts", "tail-broomstick-codex-smoke.mjs");
  const request = (id, method, params) => ({ jsonrpc: "2.0", id, method, params });
  const input = [
    request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "fixture-test", version: "1.0.0" },
    }),
    { jsonrpc: "2.0", method: "notifications/initialized" },
    request(2, "tools/list", {}),
    request(3, "tools/call", {
      name: "tail_broomstick.codex_user_prompt_submit",
      arguments: { prompt: "ordinary control" },
    }),
    request(4, "tools/call", {
      name: "tail_broomstick.codex_user_prompt_submit",
      arguments: { prompt: `tb: put alias:github-work ${promptCanary}` },
    }),
    request(5, "tools/call", {
      name: "tail_broomstick.codex_user_prompt_submit",
      arguments: { prompt: "tb: put alias:github-work" },
    }),
  ].map((value) => JSON.stringify(value)).join("\n") + "\n";
  try {
    const result = spawnSync(process.execPath, [fixture, "--mcp-fixture", marker], {
      cwd: root,
      encoding: "utf8",
      input,
      shell: false,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes(promptCanary), false);
    const responses = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(responses.length, 5);
    assert.equal(responses[1].result.tools[0].name, manifest.mcp.tool);
    assert.deepEqual(responses[2].result.content, []);
    assert.match(responses[3].result.content[0].text, /"decision":"block"/);
    assert.match(responses[4].result.content[0].text, /"decision":"block"/);
    assert.equal(await readFile(marker, "utf8"), "invoked");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
