---
version: 1
tracker:
  provider: filesystem
  issue_source: atp-node-execution-request
  poll_interval_seconds: 30
workspace:
  root_dir: ../.atp-symphony-workspaces
  strategy: auto
  base_ref: HEAD
  branch_prefix: symphony/
  cleanup: false
hooks:
  after_create:
    - echo "workspace created for {{NODE_ID}}"
  before_run: []
  after_run: []
  before_remove: []
agent:
  provider: codex
codex:
  model: gpt-5.4
  sandbox_mode: workspace-write
  approval_policy: never
  web_search: true
issue:
  prompt_context_file: "{{PROMPT_CONTEXT_FILE}}"
  result_filename_template: "{{NODE_ID}}.result.json"
---

You are executing one ATP-derived Symphony node request.

Execution identity:
- Project: {{PROJECT_NAME}}
- Node ID: {{NODE_ID}}
- Title: {{NODE_TITLE}}

Primary instruction:
{{NODE_INSTRUCTION}}

Static node context:
{{NODE_CONTEXT}}

Dependency handoff:
{{DEPENDENCY_CONTEXT}}

Execution constraints:
- Use the prompt context file at `{{PROMPT_CONTEXT_FILE}}` as the canonical machine-readable handoff.
- Work toward task completion across multiple turns until the task is complete or clearly blocked.
- Do not mutate the ATP graph directly.
- When you finish or determine the task is blocked, write exactly one result JSON file to `{{RESULT_FILE}}`.

Required result shape:
- `schemaVersion: "atp-symphony-result/v1"`
- `node_id: "{{NODE_ID}}"`
- `status: "DONE"` or `"FAILED"`
- `report`: summary of changes, verification, and blockers
- `artifacts`: optional list of changed file paths
- `external`: optional provenance/branch/PR/run metadata

Reasoning guidance:
- Requested ATP reasoning effort: {{NODE_REASONING_EFFORT}}
- Dependency IDs: {{DEPENDENCY_IDS}}
