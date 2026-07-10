# Codex Harness

A Codex-native personal harness for autonomous issue-to-verified-commit execution. It combines an installable Codex plugin with a deterministic local control plane for durable goals, task DAGs, GitHub issues, evidence gates, resumable execution, and adversarial multi-agent review.

## Status

Active development. The repository was rebuilt for Codex on 2026-07-11; the previous Claude-oriented implementation remains available in Git history.

## Development

```bash
npm install
npm run build
npm test
npm run validate
```

The plugin is under `plugins/codex-harness`. Installation and workflow documentation is expanded as the implementation issues land.

