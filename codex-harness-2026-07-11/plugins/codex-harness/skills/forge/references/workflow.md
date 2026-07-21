# Forge workflow

## States

`created -> planning -> issue_sync -> executing -> verifying -> reviewing -> integrating -> complete`

Active states may transition to `failed`, `blocked`, or `cancelled` where the controller's transition table permits. A failed run may return to `planning` after a changed approach. A blocked run resumes through an explicit valid transition only after its recorded condition changes.

## Task states

`pending -> ready -> running -> verifying -> committed -> reviewed -> complete`

`running`, `verifying`, `committed`, and `reviewed` may fail or block; a failed or blocked task may return to `ready` for a bounded retry. Reject transitions that skip required evidence. A task is ready only when all dependencies are complete.

## Required artifacts

- goal and explicit non-goals;
- run mode (`standard` or explicitly selected `tough`);
- acceptance criteria;
- synchronized GitHub issue number;
- dependency-aware task list;
- file ownership per writer;
- verification commands;
- exact tree or commit SHA for each evidence record;
- normalized review findings;
- completion summary.

## Lane selection

| Signal | Lane |
| --- | --- |
| comment, typo, or isolated mechanical change | fast |
| ordinary feature with known architecture | build |
| cross-cutting, security-sensitive, migration, or unclear failure | deep |
| long-running outcome requested without supervision | autonomous |

Upgrade the lane when risk increases. Downgrade only when evidence shows the task is smaller than expected.

## Run mode

Run mode is independent from lane:

| Mode | Contract |
| --- | --- |
| `standard` | Default behavior for new runs and legacy schema-version-1 runs without a stored mode. |
| `tough` | Explicit opt-in exact-scope behavior. Do not invent product security, safety, protective behavior, or operational constraints absent from the user request and established repository contracts. Report concerns without implementing them. |

Tough mode never permits removing or weakening an existing protection. Platform policy, approvals, sandboxing, secret handling, and repository instructions still apply. If requested behavior conflicts with a mandatory existing protection, preserve it and report the concrete blocker rather than adding a substitute product restriction.

The controller prepends the Tough non-goal and appends a deterministic Tough acceptance criterion to every task. The planner may supply at most 19 additional non-goals and 99 criteria per task; overflow is rejected without mutating the run. Only the current unfinished run is considered for reuse, and it is reused only when goal, repository, lane, and effective mode all match; older non-current runs are not searched. New-run mode participates in the configuration hash, and GitHub task metadata displays it. A legacy schema-version-1 run without `mode` retains the pre-mode hash shape so its existing evidence remains current while its effective behavior is `standard`. Tough planner/builder summaries and reviewer residual risks are redacted into the run ledger instead of being discarded.

## Completion gate

Complete only when:

1. every acceptance criterion for every task maps to passing current-tree evidence;
2. every task has passing current-tree verification and all of its required checks exit successfully;
3. evidence matches the current SHA and configuration hash;
4. every task has its required number of distinct approved current-tree reviewers; Tough mode requires two for every task, including documentation-only tasks;
5. no unresolved critical or high review finding remains;
6. no task-owned change is uncommitted;
7. unrelated user changes remain preserved;

## Question gate

Continue without asking when a choice is reversible and consistent with repository evidence. Ask only for missing authority, credentials, an unauthorized irreversible action, or an unresolved product fork with materially different outcomes.

Automatic permission authorizes execution inside the requested outcome. It never authorizes speculative features, unrelated cleanup, deployment, cross-repository mutation, or a materially broader product decision.
