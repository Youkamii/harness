import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "plugins", "codex-harness");
const failures = [];

async function loadJson(relativePath) {
  const absolutePath = path.join(root, relativePath);
  try {
    return JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    failures.push(`${relativePath}: ${error.message}`);
    return null;
  }
}

const manifest = await loadJson("plugins/codex-harness/.codex-plugin/plugin.json");
const marketplace = await loadJson(".agents/plugins/marketplace.json");

if (manifest) {
  if (manifest.name !== "codex-harness") failures.push("plugin name must be codex-harness");
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(manifest.version ?? "")) {
    failures.push("plugin version must be semver");
  }
  if (manifest.hooks) failures.push("plugin manifest must not contain unsupported hooks");
  if (manifest.skills !== "./skills/") failures.push("plugin skills path must be ./skills/");
}

if (marketplace) {
  const entry = marketplace.plugins?.find((item) => item.name === "codex-harness");
  if (!entry) failures.push("marketplace is missing codex-harness");
  if (entry?.source?.path !== "./plugins/codex-harness") {
    failures.push("marketplace plugin source must be ./plugins/codex-harness");
  }
}

const skillRoot = path.join(pluginRoot, "skills");
for (const entry of await readdir(skillRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const skillPath = path.join(skillRoot, entry.name, "SKILL.md");
  const text = (await readFile(skillPath, "utf8")).replaceAll("\r\n", "\n");
  if (!text.startsWith("---\n")) failures.push(`${entry.name}: missing YAML frontmatter`);
  if (!text.includes(`name: ${entry.name}\n`)) failures.push(`${entry.name}: name mismatch`);
  if (/\[TODO:|\bTODO\b/.test(text)) failures.push(`${entry.name}: contains TODO text`);
  const lineCount = text.split("\n").length;
  if (lineCount > 500) failures.push(`${entry.name}: SKILL.md exceeds 500 lines`);
}

if (failures.length > 0) {
  process.stderr.write(failures.map((failure) => `- ${failure}\n`).join(""));
  process.exit(1);
}

process.stdout.write("repository validation passed\n");
