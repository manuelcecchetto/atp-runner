# Evidence Index

Index of acceptance and verification evidence produced by ATP nodes.

## Ownership

- Primary owner: QA/verification lead
- Maintainers: workers producing tests, checks, or validation artifacts

## Entry Template

```md
### [EVD-<number>] <Evidence Title>
- NodeID: <ATP node id>
- Date: YYYY-MM-DD
- Author: <agent_id>
- Status: proposed | approved | superseded
- Requirement/Acceptance Link: <requirement id or text>
- Evidence Type: test | benchmark | manual verification | doc
- Location: <file path / command / URL>
- Result Summary: <pass/fail/findings>
- Notes: <limitations/follow-up>
```

## Evidence

### [EVD-000] Memory Governance Bootstrap
- NodeID: BOOTSTRAP
- Date: 2026-02-05
- Author: codex_runner_setup
- Status: approved
- Requirement/Acceptance Link: shared memory folder and governance protocol must exist
- Evidence Type: doc
- Location: `docs/memory/*`, `RUNNER.md`
- Result Summary: initial memory artifacts and mandatory update protocol added
- Notes: future nodes should append concrete test/command evidence entries
