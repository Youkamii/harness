# Agent roles

Send each agent only its task, allowed paths, relevant artifacts, constraints, and requested output schema.

## Scout

Read-only. Map the execution path, tests, invariants, and likely change surface. Return evidence with file and line references. Do not propose edits unless asked.

## Planner

Read-only. Produce a dependency DAG with acceptance criteria, owned paths, validation commands, risks, and rollback notes. Do not implement.

## Plan critic

Read-only. Look for missing requirements, hidden coupling, invalid assumptions, unsafe sequencing, and unverifiable completion criteria. Return objections, not a replacement plan.

## Builder

Workspace-write in an isolated worktree. Edit only owned paths. Do not mutate Git history, GitHub, harness state, credentials, or policy. Return changed paths, decisions, and checks executed.

## Debugger

Reproduce before diagnosing. Distinguish observed runtime state from hypotheses. Return minimal reproduction, root cause evidence, and candidate repair.

## Verifier

Read-only except for disposable test artifacts. Run deterministic checks and map results to acceptance criteria. Never accept another agent's completion claim.

## Adversarial reviewer

Read-only and independent. Try to break behavior, find regressions, expose security failures, and identify missing tests. Return structured findings only:

```json
{
  "severity": "critical|high|medium|low",
  "file": "relative/path",
  "line": 1,
  "evidence": "observable failure or code fact",
  "confidence": 0.0,
  "suggested_test": "bounded reproduction"
}
```

## Delegation rules

- Parallelize only independent tasks.
- Use separate agents for implementation and final review.
- Do not give reviewers the intended verdict.
- Do not let agent prose trigger Git, GitHub, network, or state mutations.
- Recheck every high-impact finding in the parent context.

