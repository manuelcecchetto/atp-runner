# Memory Changelog

Chronological log of memory-impacting changes across ATP nodes.

## Ownership

- Primary owner: ATP orchestrator
- Maintainers: all workers

## Entry Template

```md
### [CHG-<number>] <Short Title>
- NodeID: <ATP node id>
- Date: YYYY-MM-DD
- Author: <agent_id>
- Status: proposed | approved | superseded | closed
- Changed Files: <list of files>
- Summary: <what changed>
- Related Decision/Contract/Risk/Evidence IDs: <IDs or none>
```

## Changes

### [CHG-000] Shared Memory Bootstrap
- NodeID: BOOTSTRAP
- Date: 2026-02-05
- Author: codex_runner_setup
- Status: approved
- Changed Files: `docs/memory/README.md`, `docs/memory/decision-log.md`, `docs/memory/contracts.md`, `docs/memory/risk-register.md`, `docs/memory/evidence-index.md`, `docs/memory/changelog.md`, `RUNNER.md`
- Summary: initialized shared memory folder and enforced runner-level governance protocol for all workers
- Related Decision/Contract/Risk/Evidence IDs: DEC-000, CON-000, RISK-000, EVD-000
