import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  cp, lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexExecutable } from "../plugins/codex-harness/runtime/executables.js";
import {
  loadTailBroomstickManifest,
  supportsCodexVersion,
  validateTailBroomstickAssets,
} from "./tail-broomstick-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = fileURLToPath(import.meta.url);
const fixtureIndex = process.argv.indexOf("--mcp-fixture");
if (fixtureIndex !== -1) {
  await runMcpFixture(process.argv[fixtureIndex + 1]);
} else {
  await runSmoke();
}

async function runSmoke() {
  if (process.platform !== "win32") throw new Error("the Codex prompt-fire smoke requires Windows");
  const manifest = await loadTailBroomstickManifest(root);
  if (!(await validateTailBroomstickAssets(manifest, root))) {
    throw new Error("Tail Broomstick integration assets are invalid");
  }
  const codex = await resolveCodexExecutable();
  const temporaryBase = path.resolve(os.tmpdir());
  const temporaryRoot = await mkdtemp(path.join(temporaryBase, "harness-tail-broomstick-smoke-"));
  const codexHome = path.join(temporaryRoot, "codex-home");
  const workspace = path.join(temporaryRoot, "workspace");
  const marketplace = path.join(temporaryRoot, "marketplace");
  const plugin = path.join(marketplace, "plugins", manifest.plugin.name);
  const marker = path.join(temporaryRoot, "broker-invoked");
  try {
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(workspace, { recursive: true }),
      mkdir(path.dirname(plugin), { recursive: true }),
    ]);
    await cp(path.join(root, "plugins", manifest.plugin.name), plugin, { recursive: true });
    await mkdir(path.join(marketplace, ".agents", "plugins"), { recursive: true });
    await writeFile(path.join(marketplace, ".agents", "plugins", "marketplace.json"), `${JSON.stringify({
      name: manifest.plugin.marketplace,
      plugins: [{
        name: manifest.plugin.name,
        source: { source: "local", path: `./plugins/${manifest.plugin.name}` },
        policy: {
          installation: manifest.plugin.installationPolicy,
          authentication: manifest.plugin.authenticationPolicy,
        },
        category: "Developer Tools",
      }],
    }, null, 2)}\n`);

    const mcpPath = path.join(plugin, ".mcp.json");
    const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
    const server = mcp.mcpServers?.[manifest.mcp.server];
    if (!server || server.command !== manifest.broker.executable
        || JSON.stringify(server.args) !== JSON.stringify(manifest.broker.mcpArgs)) {
      throw new Error("the staged plugin no longer matches the checked integration contract");
    }
    server.command = process.execPath;
    server.args = [script, "--mcp-fixture", marker];
    await writeFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);

    const environment = isolatedEnvironment(codexHome, temporaryRoot);
    const versionResult = await run(codex, ["--version"], workspace, environment);
    const version = /^codex-cli (\d+\.\d+\.\d+)\r?\n?$/.exec(versionResult.stdout)?.[1];
    if (!version || !supportsCodexVersion(versionResult.stdout, manifest.codexVersion)) {
      throw new Error("the installed Codex version is not the tested integration version");
    }

    await requireSuccess(run(codex, ["plugin", "marketplace", "add", marketplace, "--json"], marketplace, environment), "marketplace add");
    await requireSuccess(run(codex, ["plugin", "add", `${manifest.plugin.name}@${manifest.plugin.marketplace}`, "--json"], marketplace, environment), "plugin add");
    const listed = await requireSuccess(run(codex, ["plugin", "list", "--json"], marketplace, environment), "plugin list");
    const installed = JSON.parse(listed.stdout).installed?.filter((entry) => (
      entry.pluginId === `${manifest.plugin.name}@${manifest.plugin.marketplace}`
    ));
    if (installed?.length !== 1 || installed[0].installed !== true || installed[0].enabled !== true) {
      throw new Error("Codex did not enable the isolated Tail Broomstick plugin");
    }
    const installedConfig = await readFile(path.join(codexHome, "config.toml"), "utf8");

    const control = await promptCase({
      codex, codexHome, environment, installedConfig,
      name: "control", prompt: "harness-tail-broomstick-control",
      temporaryRoot, workspace,
    });
    if (!control.providerContacted) throw new Error("the control prompt did not reach the loopback provider");
    if (await exists(marker)) throw new Error("the broker fixture ran for an unrelated prompt");

    const invalid = await promptCase({
      codex, codexHome, environment, installedConfig,
      name: "invalid", prompt: "tb: put alias:github-work extra-synthetic-value-canary",
      temporaryRoot, workspace,
    });
    requireBlockedWithoutModel(invalid, "invalid reserved prompt");
    if (await exists(marker)) throw new Error("an invalid reserved prompt invoked the broker fixture");
    await requireCanaryAbsent(
      "extra-synthetic-value-canary",
      [invalid.stdout, invalid.stderr],
      temporaryRoot,
    );

    const directive = await promptCase({
      codex, codexHome, environment, installedConfig,
      name: "directive", prompt: "tb: put alias:github-work",
      temporaryRoot, workspace,
    });
    requireBlockedWithoutModel(directive, "alias-only directive");
    if (!(await exists(marker)) || await readFile(marker, "utf8") !== "invoked") {
      throw new Error("the alias-only directive did not invoke the isolated broker fixture exactly once");
    }

    process.stdout.write(`PASS: Codex ${version} installed the staged core plugin; control reached only the loopback provider, while invalid and exact reserved prompts stopped before model use.\n`);
  } finally {
    const resolved = path.resolve(temporaryRoot);
    if (path.dirname(resolved) !== temporaryBase
        || !path.basename(resolved).startsWith("harness-tail-broomstick-smoke-")) {
      throw new Error("refused unsafe smoke cleanup");
    }
    await rm(resolved, { recursive: true, force: true });
  }
}

async function promptCase({
  codex, codexHome, environment, installedConfig, name, prompt, workspace,
}) {
  const contacted = { value: false };
  const tripwire = createServer((request, response) => {
    contacted.value = true;
    request.resume();
    const body = JSON.stringify({ error: { message: "synthetic tripwire", type: "test" } });
    response.writeHead(400, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    tripwire.once("error", reject);
    tripwire.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = tripwire.address();
    if (!address || typeof address === "string") throw new Error("loopback tripwire did not bind");
    const provider = [
      'model_provider = "tb_tripwire"',
      "",
      "[model_providers.tb_tripwire]",
      `name = "Tail Broomstick ${name} tripwire"`,
      `base_url = "http://127.0.0.1:${address.port}/v1"`,
      'env_key = "TB_CODEX_SMOKE_DUMMY_KEY"',
      'wire_api = "responses"',
      "request_max_retries = 0",
      "stream_max_retries = 0",
      "stream_idle_timeout_ms = 2000",
      "supports_websockets = false",
      "",
      "[features]",
      "hooks = true",
      "plugins = true",
      "",
    ].join("\n");
    await writeFile(path.join(codexHome, "config.toml"), `${provider}${installedConfig.trim()}\n`);
    const result = await run(codex, [
      "exec", "--ephemeral", "--json", "--dangerously-bypass-hook-trust",
      "--skip-git-repo-check", prompt,
    ], workspace, environment, 30_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { ...metrics(result.stdout), ...result, providerContacted: contacted.value };
  } finally {
    await new Promise((resolve) => tripwire.close(resolve));
  }
}

function requireBlockedWithoutModel(result, label) {
  if (result.timedOut || result.status !== 0 || result.providerContacted
      || !result.turnCompleted || !result.zeroModelTokens) {
    throw new Error(`${label} did not finish at the pre-model boundary`);
  }
}

function metrics(output) {
  const completed = output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const event = JSON.parse(line);
      return event.type === "turn.completed" ? [event] : [];
    } catch {
      return [];
    }
  });
  const usage = completed.length === 1 ? completed[0].usage : undefined;
  const fields = [
    "input_tokens", "cached_input_tokens", "cache_write_input_tokens",
    "output_tokens", "reasoning_output_tokens",
  ];
  return {
    turnCompleted: completed.length === 1,
    zeroModelTokens: fields.every((field) => Number.isInteger(usage?.[field]) && usage[field] === 0),
  };
}

async function run(executable, args, cwd, env, timeoutMs = 30_000) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const output = { stdout: "", stderr: "", bytes: 0 };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, timeoutMs);
    const collect = (name) => (chunk) => {
      output.bytes += chunk.length;
      if (output.bytes > 8 * 1024 * 1024) {
        timedOut = true;
        terminate(child);
      } else {
        output[name] += chunk.toString("utf8");
      }
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.once("error", reject);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ ...output, status, signal, timedOut });
    });
  });
}

function terminate(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), [
      "/PID", String(child.pid), "/T", "/F",
    ], { shell: false, windowsHide: true, stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

async function requireSuccess(promise, operation) {
  const result = await promise;
  if (result.timedOut || result.status !== 0) throw new Error(`${operation} failed`);
  return result;
}

function isolatedEnvironment(codexHome, temporaryRoot) {
  const allowed = [
    "ALLUSERSPROFILE", "APPDATA", "CommonProgramFiles", "CommonProgramFiles(x86)",
    "CommonProgramW6432", "COMPUTERNAME", "ComSpec", "HOMEDRIVE", "HOMEPATH",
    "LOCALAPPDATA", "NUMBER_OF_PROCESSORS", "OS", "Path", "PATHEXT", "ProgramData",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "PUBLIC", "SystemDrive",
    "SystemRoot", "USERNAME", "USERPROFILE", "WINDIR",
  ];
  const env = Object.fromEntries(allowed.flatMap((name) => (
    process.env[name] === undefined ? [] : [[name, process.env[name]]]
  )));
  return {
    ...env,
    CODEX_HOME: codexHome,
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    NO_COLOR: "1",
    TB_CODEX_SMOKE_DUMMY_KEY: "synthetic-test-value",
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "127.0.0.1,localhost",
  };
}

async function exists(file) {
  try {
    await readFile(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function requireCanaryAbsent(canary, outputs, directory) {
  const encodings = [Buffer.from(canary, "utf8"), Buffer.from(canary, "utf16le")];
  if (outputs.some((output) => encodings.some((needle) => Buffer.from(output).includes(needle)))) {
    throw new Error("a reserved prompt was reflected in Codex output");
  }
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("the isolated smoke created an unexpected link");
      if (entry.isDirectory()) {
        pending.push(candidate);
        continue;
      }
      if (!entry.isFile()) throw new Error("the isolated smoke created an unexpected file type");
      const metadata = await lstat(candidate);
      if (metadata.size > 16 * 1024 * 1024) throw new Error("the isolated smoke created an oversized file");
      const bytes = await readFile(candidate);
      if (encodings.some((needle) => bytes.includes(needle))) {
        throw new Error("a reserved prompt was persisted by the isolated Codex run");
      }
    }
  }
}

async function runMcpFixture(marker) {
  if (!marker || !path.isAbsolute(marker)) process.exit(2);
  let buffer = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line) await handleMcpLine(line, marker);
    }
  }
}

async function handleMcpLine(line, marker) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return writeRpc({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    return writeRpc({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "tail-broomstick-smoke-fixture", version: "1.0.0" },
      },
    });
  }
  if (request.method === "tools/list") {
    return writeRpc({
      jsonrpc: "2.0",
      id: request.id,
      result: { tools: [{
        name: "tail_broomstick.codex_user_prompt_submit",
        description: "Synthetic prompt-fire fixture",
        inputSchema: {
          type: "object",
          properties: { prompt: { type: "string" } },
          required: ["prompt"],
          additionalProperties: false,
        },
      }] },
    });
  }
  if (request.method === "tools/call"
      && request.params?.name === "tail_broomstick.codex_user_prompt_submit"
      && typeof request.params?.arguments?.prompt === "string") {
    const prompt = request.params.arguments.prompt;
    let text = "";
    if (prompt === "tb: put alias:github-work") {
      await writeFile(marker, "invoked", { flag: "wx" });
      text = JSON.stringify({
        decision: "block",
        reason: "Tail Broomstick completed the isolated alias-only request.",
      });
    } else if (prompt.startsWith("tb:")) {
      text = JSON.stringify({
        decision: "block",
        reason: "Tail Broomstick rejected the isolated reserved request.",
      });
    }
    return writeRpc({
      jsonrpc: "2.0",
      id: request.id,
      result: { content: text ? [{ type: "text", text }] : [], isError: false },
    });
  }
  writeRpc({
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32601, message: "Method not found" },
  });
}

function writeRpc(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
