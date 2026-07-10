# Adversarial review rubric

Review the exact diff and completion evidence across these dimensions.

## Correctness

- acceptance criteria not implemented;
- incorrect boundary conditions or state transitions;
- stale, partial, or misleading evidence;
- behavior that depends on local uncommitted state;
- missing error propagation, cleanup, timeout, or cancellation.

## Regression

- existing callers or file formats broken;
- unrelated behavior changed;
- platform-specific path, shell, newline, encoding, or permission failures;
- concurrency races, duplicate operations, or non-idempotent resume.

## Security

- shell injection, argument confusion, path traversal, symlink or reparse escape;
- secret exposure in environment, logs, issue bodies, prompts, or evidence;
- prompt injection crossing a capability boundary;
- sandbox, network, approval, or Git protection weakened;
- untrusted output treated as an instruction.

## Maintainability

- duplicated policy outside the deterministic controller;
- hidden coupling, ambiguous ownership, or unbounded retries;
- tests that assert implementation details instead of outcomes;
- configuration without validation or safe defaults.

## Verdict

`approved` requires passing deterministic checks and no unresolved critical or high finding. Medium findings require an explicit disposition. A verbal `PASS` never substitutes for evidence.

