import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillPath = new URL("../skills/tough/SKILL.md", import.meta.url);
const metadataPath = new URL("../skills/tough/agents/openai.yaml", import.meta.url);

test("tough skill metadata distinguishes opt-in from mention, negation, and questions", async () => {
  const skill = await readFile(skillPath, "utf8");
  const frontmatter = skill.split("---", 3)[1] ?? "";

  for (const affirmative of ["$tough GOAL", "터프 모드로 구현해", "use tough mode to implement this"]) {
    assert.ok(frontmatter.includes(affirmative), `missing affirmative trigger: ${affirmative}`);
  }
  for (const nonTrigger of ["tough mode 쓰지 마", "tough mode가 뭐야?", "quotations or code blocks"]) {
    assert.ok(frontmatter.includes(nonTrigger), `missing non-trigger rule: ${nonTrigger}`);
  }
  assert.match(skill, /when intent is ambiguous, do not activate Tough/i);
});

test("tough skill preserves mandatory protections and reports conflicts", async () => {
  const skill = await readFile(skillPath, "utf8");
  assert.match(skill, /do not remove, weaken, or bypass an existing protection/i);
  assert.match(skill, /conflicts with a mandatory existing protection/i);
  assert.match(skill, /report the exact blocker or concern/i);
  assert.match(skill, /do not invent a substitute product restriction/i);
});

test("tough skill UI metadata is valid and explicitly invokes $tough", async () => {
  const metadata = await readFile(metadataPath, "utf8");
  const shortDescription = metadata.match(/short_description: "([^"]+)"/)?.[1] ?? "";
  const defaultPrompt = metadata.match(/default_prompt: "([^"]+)"/)?.[1] ?? "";

  assert.ok(shortDescription.length >= 25 && shortDescription.length <= 64);
  assert.match(defaultPrompt, /\$tough/);
  assert.match(metadata, /allow_implicit_invocation: true/);
});
