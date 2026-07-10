# Codex Harness repository instructions

Operate autonomously. Ask the user only when work needs new authority, unavailable credentials, an irreversible external action not already requested, or a product decision with materially different outcomes. Make and record safe, reversible assumptions in every other case.

For every feature:

1. Find or create a GitHub issue before implementation.
2. Create a dependency-aware task plan with explicit acceptance criteria.
3. Inspect relevant code and upstream documentation before editing.
4. Implement one logical feature at a time and commit it separately with the issue number.
5. Run targeted tests followed by the repository validation suite.
6. Invoke independent agents for non-trivial verification. Keep their prompts artifact-focused and do not leak the intended conclusion.
7. Perform an adversarial review that attempts to disprove the completion claim.
8. Close an issue only after required evidence is recorded.

Never mark work complete from an agent's status message alone. Verify the diff, commands, exit codes, and acceptance criteria directly. Preserve unrelated user changes. Never bypass approvals or sandboxing by default.

Primary commands:

- `npm run build`
- `npm test`
- `npm run check`
- `npm run validate`

Runtime code lives in `plugins/codex-harness/src/`; compiled plugin-safe JavaScript lives in `plugins/codex-harness/runtime/`. Skills must stay concise and move detailed procedures into one-level `references/` files.

