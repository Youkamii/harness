# Forge workflow

## States

`created -> planning -> issue_sync -> executing -> verifying -> reviewing -> integrating -> complete`

Active states may transition to `failed`, `blocked`, or `cancelled` where the controller's transition table permits. A failed run may return to `planning` after a changed approach. A blocked run resumes through an explicit valid transition only after its recorded condition changes.

## Task states

`pending -> ready -> running -> verifying -> committed -> reviewed -> complete`

`running`, `verifying`, `committed`, and `reviewed` may fail or block; a failed or blocked task may return to `ready` for a bounded retry. Reject transitions that skip required evidence. A task is ready only when all dependencies are complete.

## Required artifacts

- goal and explicit non-goals;
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

## Completion gate

Complete only when:

1. every acceptance criterion for every task maps to passing current-tree evidence;
2. every task has passing current-tree verification and all of its required checks exit successfully;
3. evidence matches the current SHA and configuration hash;
4. every task has its required number of distinct approved current-tree reviewers;
5. no unresolved critical or high review finding remains;
6. no task-owned change is uncommitted;
7. unrelated user changes remain preserved;

## Question gate

Continue without asking when a choice is reversible and consistent with repository evidence. Ask only for missing authority, credentials, an unauthorized irreversible action, or an unresolved product fork with materially different outcomes.

Automatic permission authorizes execution inside the requested outcome. It never authorizes speculative features, unrelated cleanup, deployment, cross-repository mutation, or a materially broader product decision.
