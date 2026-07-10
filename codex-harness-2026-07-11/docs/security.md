# Security model

## Trust boundaries

User goals, repository files, issues, model output, command output, and tests are treated as untrusted data. They may inform a decision but cannot directly mutate controller state or select an unrestricted shell command.

The controller uses argument arrays with `shell: false` for Codex, Git, GitHub CLI, and checks. Model text is passed through stdin or bounded files, never interpolated into a command string. Plans may specify verification argv arrays, but shell interpreters, Git, GitHub CLI, Codex, download tools, and destructive executables are denied.

## Least privilege

- Builders receive only workspace-write access to an isolated worktree and no nested plugins, apps, browser, computer use, or agents.
- Planners and reviewers are read-only and ephemeral.
- Verification commands run inside `codex sandbox` with direct network disabled.
- Verification receives a temporary home, empty Git/GitHub/npm configuration paths, and an environment scrubbed of token, secret, password, API key, cloud, SSH-agent, and npm-token variables.
- Authoritative state is kept in the Git common directory, outside all worker worktrees.

`-a never` means workers cannot interrupt the user with approval requests. It does not bypass the sandbox. The dangerous Codex bypass flags are never emitted.

## Git and remote effects

The controller never uses `git add -A`, force push, hard reset, or broad cleanup. It checks every changed and staged path against task ownership, scans the staged diff for common secret forms, commits through a message file, and records an idempotency key before the commit. Controller-owned commits, worktree creation, and cherry-picks use an empty hooks directory and disabled GPG signing so repository hooks cannot inherit controller authority.

GitHub issues use a stable run marker, opaque task hash, exact run search, run lease, and outbox record so a crash can reuse an existing issue instead of duplicating it. Model-generated titles and acceptance text remain in the local tamper-evident ledger rather than being copied to GitHub; remote issue text is derived from the direct user goal and controller metadata, then redacted and size-bounded. The current version creates requested tracking issues but does not infer permission to push, deploy, close issues, or mutate other repositories.

## Verification attacks covered

- journal tampering and snapshot lag;
- simultaneous reviewer state writes;
- dependency cycles and path ownership overlap, including case differences;
- forbidden shell, Git, GitHub, Codex, and download checks;
- unowned dirty files such as `.env`;
- staged secret patterns;
- verifier commands that exit zero after mutating non-ignored repository content;
- credential inheritance and direct network access inside verification;
- duplicate reviewer identities and undisposed medium findings;
- retry commits omitted from final integration;
- stale evidence from a different tree or plan hash.
- dirty or moved integration branches;
- baseline checks that mutate source before a builder starts;
- dead controller locks and simultaneous resume processes.

Residual boundary: repository tests are arbitrary code. The harness contains them with the Codex OS sandbox and no-network state, but an operating-system or Codex sandbox vulnerability remains outside this repository's control.
