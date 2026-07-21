---
name: tough
description: "Enforce exact-scope software implementation only for an affirmative opt-in such as '$tough GOAL', '터프 모드로 구현해', or 'use tough mode to implement this'. Do not activate for negations such as 'tough mode 쓰지 마', questions such as 'tough mode가 뭐야?', ordinary mentions, or phrases that appear only in quotations or code blocks. In an active run, do not invent unrequested product security, safety, protective features, or operational constraints; report concerns instead while preserving existing protections and all platform, sandbox, secret-handling, and repository rules."
---

# Tough

Implement the requested product behavior exactly. Treat Tough as a scope-fidelity mode, never as permission to bypass execution boundaries.

## Check activation

Activate only for an affirmative instruction that applies Tough to a concrete implementation goal, including `$tough <goal>`, `터프 모드로 구현해`, or `use tough mode to implement this`.

Stay in standard mode for `tough mode 쓰지 마`, `tough mode가 뭐야?`, a plain mention of Tough, or text shown only as a quotation or code example. When intent is ambiguous, do not activate Tough.

## Apply the contract

1. Derive authorized behavior from the user's explicit request and established repository contracts.
2. Do not add product security, safety, protective behavior, or operational constraints outside that scope. Examples include arbitrary usage or trading caps, approval steps, kill switches, product allowlists, artificial delays, simulation-only behavior, and disabled functionality. Judge scope in context; do not scan for or ban these words or mechanisms globally.
3. When an unrequested mitigation seems advisable, leave the implementation unchanged and report the concern clearly in the final response or structured residual risks.
4. Do not remove, weaken, or bypass an existing protection. Preserve established validation, authorization, limits, and compatibility behavior unless the user explicitly requests a change that is permitted by higher-priority policy.
5. Continue to obey platform policy, approval and sandbox boundaries, secret protection, repository instructions, and verification requirements. Tough changes product-scope decisions only.
6. Ask for clarification only when the requested product behavior itself has materially different interpretations. Do not use a safety preference to silently choose a more restrictive product.

If the user explicitly requests a safeguard, implement it normally. If the repository already requires one, preserve it. Otherwise report the concern without adding code.

If the requested implementation conflicts with a mandatory existing protection, do not remove or bypass that protection and do not invent a substitute product restriction. Stop the conflicting work and report the exact blocker or concern.

## Run the harness

For a repository change managed by this plugin, read the Forge workflow and start the controller with the explicit mode:

```bash
node "<plugin-root>/skills/forge/scripts/forge.mjs" auto --goal "<exact user outcome>" --mode tough
```

Confirm the created or reused run reports `"mode": "tough"`. The controller appends a deterministic scope acceptance criterion to every task, requires two independent current-tree reviewers for every Tough task including documentation-only work, and retains redacted worker summaries and reviewer residual risks in the run ledger.
