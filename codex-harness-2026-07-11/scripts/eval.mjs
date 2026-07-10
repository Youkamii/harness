import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { routeLane } from "../plugins/codex-harness/runtime/autonomy.js";
import { validatePlan } from "../plugins/codex-harness/runtime/graph.js";
import { redactSecrets } from "../plugins/codex-harness/runtime/redact.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(await readFile(path.join(root, "evals", "cases.json"), "utf8"));
const results = [];

for (const evaluation of cases) {
  try {
    if (evaluation.kind === "denied-check") {
      assert.throws(
        () => validatePlan([{
          id: "eval",
          title: "Eval",
          dependencies: [],
          acceptanceCriteria: ["bounded"],
          ownedPaths: ["src/eval"],
          checks: [{ argv: [evaluation.executable, "untrusted $(payload)"] }],
          risk: "high",
        }]),
        new RegExp(evaluation.expected, "i"),
      );
    } else if (evaluation.kind === "redaction") {
      assert.equal(redactSecrets(evaluation.input).includes(evaluation.forbidden), false);
    } else if (evaluation.kind === "lane") {
      assert.equal(routeLane(evaluation.input), evaluation.expected);
    } else if (evaluation.kind === "policy-text") {
      for (const file of evaluation.files) {
        const content = await readFile(path.join(root, file), "utf8");
        assert.match(content, new RegExp(evaluation.expected, "i"));
      }
    } else {
      throw new Error(`unknown evaluation kind: ${evaluation.kind}`);
    }
    results.push({ id: evaluation.id, status: "pass" });
  } catch (error) {
    results.push({ id: evaluation.id, status: "fail", error: error instanceof Error ? error.message : String(error) });
  }
}

process.stdout.write(JSON.stringify({ passed: results.every((result) => result.status === "pass"), results }, null, 2) + "\n");
if (results.some((result) => result.status !== "pass")) process.exitCode = 1;
