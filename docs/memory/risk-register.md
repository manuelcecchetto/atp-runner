# Risk Register

Active and historical project risks with mitigations and ownership.

## Ownership

- Primary owner: tech lead / project manager
- Maintainers: all workers identifying or resolving risks

## Entry Template

```md
### [RISK-<number>] <Risk Title>
- NodeID: <ATP node id>
- Date: YYYY-MM-DD
- Author: <agent_id>
- Status: open | monitoring | mitigated | closed
- Probability: low | medium | high
- Impact: low | medium | high
- Area: architecture | delivery | quality | security | operations
- Description: <risk statement>
- Mitigation: <planned or completed actions>
- Owner: <person/role/agent>
- Evidence: <tests/metrics/logs/docs>
```

## Risks

### [RISK-000] Cross-Worker Decision Drift
- NodeID: BOOTSTRAP
- Date: 2026-02-05
- Author: codex_runner_setup
- Status: monitoring
- Probability: high
- Impact: high
- Area: delivery
- Description: Parallel workers may diverge on assumptions without a shared memory protocol.
- Mitigation: enforce updates to `docs/memory/*` and treat latest approved decision log entry as canonical.
- Owner: ATP orchestrator
- Evidence: runner prompt governance + memory templates
