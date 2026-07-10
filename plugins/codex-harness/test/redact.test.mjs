import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedRemoteText,
  codexControllerEnvironment,
  githubControllerEnvironment,
  containsLikelySecret,
  redactSecrets,
  sanitizedEnvironment,
} from "../runtime/redact.js";

test("redaction removes common credential forms", () => {
  const input = "token=super-secret-value ghp_abcdefghijklmnopqrstuvwxyz123456";
  const output = redactSecrets(input);
  assert.doesNotMatch(output, /super-secret-value/);
  assert.doesNotMatch(output, /ghp_/);
  assert.equal(containsLikelySecret(input), true);
});

test("sanitized environment removes credential variables", () => {
  const output = sanitizedEnvironment({
    PATH: "safe",
    GH_TOKEN: "secret",
    OPENAI_API_KEY: "secret",
    USERPROFILE: "home",
  });
  assert.equal(output.PATH, "safe");
  assert.equal(output.USERPROFILE, "home");
  assert.equal(output.GH_TOKEN, undefined);
  assert.equal(output.OPENAI_API_KEY, undefined);
});

test("trusted controller calls retain only their required headless credentials", () => {
  const source = {
    PATH: "safe",
    GH_TOKEN: "github-secret",
    GITHUB_TOKEN: "github-actions-secret",
    OPENAI_API_KEY: "openai-secret",
    PASSWORD: "never",
  };
  const github = githubControllerEnvironment(source);
  assert.equal(github.GH_TOKEN, "github-secret");
  assert.equal(github.GITHUB_TOKEN, "github-actions-secret");
  assert.equal(github.OPENAI_API_KEY, undefined);
  assert.equal(github.PASSWORD, undefined);

  const codex = codexControllerEnvironment(source);
  assert.equal(codex.OPENAI_API_KEY, "openai-secret");
  assert.equal(codex.GH_TOKEN, undefined);
  assert.equal(codex.PASSWORD, undefined);
});

test("shell metacharacters remain inert bounded text", () => {
  const input = "feature ; | && `whoami` $(Get-ChildItem) --force";
  assert.equal(boundedRemoteText(input), input);
});
