# Forge workflow

## States

`created -> grounded -> planned -> executing -> verifying -> reviewing -> complete`

Any active state may transition to `failed` or `blocked`. A failed run may return to `planned` after a changed approach. A blocked run resumes only after its recorded condition changes.

## Task states

`pending -> ready -> running -> verifying -> committed -> reviewed -> complete`

Reject transitions that skip required evidence. A task is ready only when all dependencies are complete.

## Required artifacts

- goal and explicit non-goals;
- acceptance criteria;
- issue number or recorded offline reason;
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

1. every acceptance criterion maps to passing evidence;
2. all required checks exit successfully;
3. evidence matches the current SHA and configuration hash;
4. no unresolved critical or high review finding remains;
5. no task-owned change is uncommitted;
6. unrelated user changes remain preserved;
7. the issue contains a bounded completion summary when remote updates are enabled.

## Question gate

Continue without asking when a choice is reversible and consistent with repository evidence. Ask only for missing authority, credentials, an unauthorized irreversible action, or an unresolved product fork with materially different outcomes.

