# Contracts

Canonical register of API, schema, and interface contracts.

## Ownership

- Primary owner: API/domain leads
- Maintainers: workers changing interfaces, schemas, or integration behavior

## Entry Template

```md
### [CON-<number>] <Contract Name>
- NodeID: <ATP node id>
- Date: YYYY-MM-DD
- Author: <agent_id>
- Status: proposed | approved | superseded
- Surface: API | event | DB schema | config | internal interface
- Contract: <exact shape/rules/version>
- Compatibility: backward-compatible | breaking
- Consumers: <services/modules/users affected>
- Validation Evidence: <tests/docs/commands/links>
- Notes: <migration or rollout notes>
```

## Contracts

### [CON-000] Shared Memory Artifact Contract
- NodeID: BOOTSTRAP
- Date: 2026-02-05
- Author: codex_runner_setup
- Status: approved
- Surface: internal interface
- Contract: `docs/memory/` must contain decision-log.md, contracts.md, risk-register.md, evidence-index.md, changelog.md, and README.md.
- Compatibility: backward-compatible
- Consumers: all ATP workers
- Validation Evidence: folder and templates created in repository
- Notes: updates must be append-only and NodeID-tagged
