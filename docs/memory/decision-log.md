# Decision Log

Source of truth for architecture and policy decisions.

## Ownership

- Primary owner: ATP orchestrator / tech lead
- Maintainers: all ATP workers

## Entry Template

```md
### [DEC-<number>] <Decision Title>
- NodeID: <ATP node id>
- Date: YYYY-MM-DD
- Author: <agent_id>
- Status: proposed | approved | superseded
- Scope: architecture | policy | platform | process
- Context: <why this decision is needed>
- Decision: <what is being decided>
- Rationale: <why this option>
- Impact: <systems/files/teams affected>
- Supersedes: <DEC-id or none>
- Superseded By: <DEC-id or none>
```

## Decisions

### [DEC-000] Shared Memory Governance Initialized
- NodeID: BOOTSTRAP
- Date: 2026-02-05
- Author: codex_runner_setup
- Status: approved
- Scope: process
- Context: Large ATP projects require durable shared memory to avoid drift across workers.
- Decision: `docs/memory/*` is mandatory shared memory and must be updated on relevant nodes.
- Rationale: Centralized, append-only memory improves consistency and traceability.
- Impact: All workers and node handoffs.
- Supersedes: none
- Superseded By: none
