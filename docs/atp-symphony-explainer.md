# ATP + Symphony

## Why combine them

ATP and Symphony solve different parts of the same delivery problem.

- ATP is the planning and coordination layer.
- Symphony is the execution layer for issue-shaped coding work.

ATP is useful when the project is not a straight line. It models work as a directed acyclic graph, which means one task can unlock several others, and several tasks can converge into one later integration task. That matters because real delivery usually has shared prerequisites, fan-out implementation work, and fan-in validation work.

Symphony is useful when a task is ready to be executed. It is good at taking an issue, creating an isolated workspace, running an agent over time, and moving that issue toward code review and completion.

The combination is simple: ATP decides what is safe and useful to work on next, and Symphony executes those ready tasks well.

## Why non-linear work matters

The main weakness of a pure issue queue is shared dependencies.

Example:

- A: introduce a new auth abstraction
- B: update billing to use it
- C: update admin flows to use it

This is not a line. It is a graph:

- A -> B
- A -> C

If B and C are treated as independent issues without a shared dependency model, several bad outcomes become likely:

- both issues rebuild the same prerequisite
- one issue blocks because the prerequisite only exists in another branch
- both issues make different assumptions and integration breaks later

ATP prevents that by representing the shared prerequisite as a first-class node. A gets done once. Then B and C unlock.

## What ATP contributes

ATP should remain the source of truth for project structure.

It gives the system:

- explicit dependencies between work items
- project-wide status such as READY, CLAIMED, COMPLETED, and FAILED
- decomposition of broad work into smaller nodes
- coordination across several agents
- support for non-code tasks such as design, migration planning, rollout checks, and verification

This is broader than a branch stack or an issue workflow. A stacked PR graph is a graph of code diffs. ATP is a graph of work.

## What Symphony contributes

Symphony should be treated as the execution backend for ATP leaf nodes that are suitable for issue-driven implementation.

It gives the system:

- issue polling and workflow progression
- isolated workspaces or branches
- long-running agent execution
- PR-oriented delivery
- a clean operational model for repeated coding turns

That makes Symphony a strong runtime for implementation tasks after ATP has already resolved dependencies and sequencing.

## Recommended combined model

The clean architecture is:

1. ATP remains the control plane.
2. Only READY ATP leaf nodes are exported for execution.
3. A bridge maps ATP node IDs to tracker issue IDs.
4. Symphony executes those issues in isolated workspaces.
5. Results are synced back into ATP.

In practice, the flow looks like this:

1. ATP marks a node READY because all dependencies are complete.
2. The bridge publishes that node as an issue and stores the mapping.
3. Symphony picks up the issue and runs the coding workflow.
4. Symphony produces code, branch or PR state, and a handoff report.
5. The bridge calls ATP completion APIs with the result.
6. ATP unlocks downstream nodes.

## Why not just use stacked PRs

Stacked PRs help with dependent code delivery, but they do not replace a task graph.

They do not model:

- design and investigation tasks
- shared prerequisites across multiple future tasks
- decomposition of broad work
- project-level readiness and claiming
- fan-out and fan-in coordination beyond code review order

Stacked PRs are still useful, but only as a transport for implementation nodes. ATP should decide whether two tasks are separate nodes with a dependency. Symphony can then implement them, and stacked PRs can express the review sequence when needed.

## Practical value

The strongest reason to keep ATP in the loop is this:

Symphony is good at running the right issue well.

ATP is good at deciding what the right issue is.

Without ATP, shared prerequisites can be duplicated or missed. With ATP, prerequisite work is completed once, downstream work unlocks cleanly, and Symphony can focus on execution instead of global coordination.

## Suggested rollout

Start small.

Phase 1:

- keep ATP as the planner
- export only implementation-ready leaf nodes
- let Symphony execute those nodes

Phase 2:

- sync Symphony completion data back into ATP automatically
- attach branch, PR, and report artifacts to completed ATP nodes

Phase 3:

- add policies for blocked tasks, retries, and decomposition handoff
- optionally map ATP dependencies to review hints or stacked PR hints where that helps delivery

This avoids replacing either system. ATP stays responsible for non-linear project structure. Symphony specializes in execution once the graph says the work is ready.
