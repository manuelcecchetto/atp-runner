# Shared Memory Governance

This directory is mandatory collaboration infrastructure for ATP workers.

## Purpose

Maintain durable, cross-node memory so all workers make consistent decisions and avoid drift.

## Canonical Artifacts

- `decision-log.md`: approved architecture/policy decisions and supersession history.
- `contracts.md`: API/schema/interface contracts and compatibility constraints.
- `risk-register.md`: active risks, impact, mitigation, and owners.
- `evidence-index.md`: acceptance evidence and verification references.
- `changelog.md`: memory-impacting project changes by node.

## Required Update Protocol

When a node changes architecture, policy, API, schema, or acceptance evidence, update relevant memory files in the same task.

Each appended entry must include:

- `NodeID`: ATP node identifier.
- `Date`: `YYYY-MM-DD`.
- `Author`: agent identifier.
- `Change`: concise summary of what changed.
- `Status`: `proposed`, `approved`, `superseded`, or `closed` as applicable.

## Conflict Resolution

Latest **approved** decision in `decision-log.md` is source of truth and supersedes stale assumptions.

## Worker Checklist (Required)

- [ ] Read this README and relevant memory artifacts before implementation.
- [ ] Verify whether node scope affects decision/contract/risk/evidence/changelog memory.
- [ ] Append NodeID/date-tagged entries to all impacted memory files.
- [ ] Include updated memory paths in ATP `artifacts` and mention them in the completion `report`.
- [ ] If memory cannot be safely updated due to missing context, fail the node with explicit blocker details.

## Ownership

- Primary owner: ATP orchestrator / tech lead.
- Maintainers: all ATP workers modifying this project.
