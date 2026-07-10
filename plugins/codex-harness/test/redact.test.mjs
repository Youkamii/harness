import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedRemoteText,
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

test("shell metacharacters remain inert bounded text", () => {
  const input = "feature ; | && `whoami` $(Get-ChildItem) --force";
  assert.equal(boundedRemoteText(input), input);
});

