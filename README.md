# atp-runner

Headless runner for ATP (Agent Task Protocol) workflows with selectable agents.

This repo provides:
- A multi-worker ATP runner (`atp_runner.ts`)
- A local ATP <-> Symphony bridge (`atp_symphony_bridge.ts`)
- The worker prompt/instructions (`RUNNER.md`)

## What This Is

`atp-runner` executes ATP plans by spawning worker sessions that:
- claim tasks from an ATP MCP server
- implement changes in the target repo
- complete or decompose ATP nodes

The runner injects runtime context (agent id, plan path, worker metadata) into `RUNNER.md`.

## Requirements

- Node.js 18+
- An ATP plan file (default: `.atp.json`)
- MCP access to an ATP server (for ATP tools)
- For `claude` provider: Claude Code CLI installed and authenticated

## Install

```bash
npm install
```

## Quick Start

Run the runner:

```bash
npm start
```

When TUI is enabled, an onboarding prompt lets users pick workspace path, ATP plan path, agent provider (`codex` or `claude`), and model for that session.
The onboarding wizard is keyboard-driven (`Up/Down`, `Enter`, `Esc`) with an orange framed TUI, and can also set worker count, commit-per-node behavior, plus Codex-only runtime settings (reasoning effort, sandbox mode).
It includes a full-width step header and supports back-navigation (`Esc` in menus, `/back` in text inputs).
Path inputs support `Tab` filesystem autocompletion.

Run with explicit paths:

```bash
npm start -- --project-root /path/to/repo --atp-file /path/to/.atp.json
```

Run directly with Claude provider (no onboarding prompt):

```bash
npm start -- --agent-provider claude --onboarding false --model sonnet
```

## Common Options

- `--project-root <path>`: workspace root
- `--atp-file <path>`: ATP plan file path
- `--prompt-file <path>`: worker prompt (defaults to `RUNNER.md`)
- `--agent-provider <name>`: `codex` or `claude`
- `--workers <n>`: parallel worker count
- `--commit-per-node <bool>`: enable/disable one git commit per completed node
- `--model <name>`: model name for selected provider
- `--claude-bin <path>`: Claude CLI binary (default: `claude`)
- `--onboarding <bool>`: enable/disable interactive startup selector
- `--no-tui`: disable live terminal dashboard

Default model behavior:

- Codex provider defaults to `gpt-5.4`
- Claude provider defaults to `sonnet`

Environment variable equivalents are supported (for example `ATP_FILE`, `ATP_PROJECT_ROOT`, `ATP_RUNNER_WORKERS`).
For automation/CI, use `--onboarding false`.

## Repository Notes

- Keep `RUNNER.md` as the worker system prompt. It is consumed by the runner.
- `SYMPHONY_WORKFLOW.md` is a Symphony-spec-shaped workflow file with YAML front matter and prompt body templates used by the ATP Symphony bridge.
- Shared worker memory conventions live under `docs/memory/`.

## ATP Symphony Bridge

The bridge keeps ATP as the source of truth for the dependency graph while exporting READY ATP nodes into a filesystem-backed execution-request queue that Symphony or another node executor can consume.

This is intentionally not another `agent-provider`. ATP Runner still owns worker turns for `codex` and `claude`; the bridge is a separate integration path for ATP-node execution.

Bridge layout:

- `.atp-symphony/requests/*.request.json`: exported ATP node execution requests
- `.atp-symphony/results/*.result.json`: incoming execution results to sync back
- `.atp-symphony/results/processed/`: archived result payloads after sync
- `.atp-symphony/WORKFLOW.md`: Symphony-style workflow file copied from `SYMPHONY_WORKFLOW.md`
- `.atp-symphony/state.json`: node-to-request mapping and sync state

Commands:

```bash
npm run symphony:bridge -- status --atp-file /path/to/.atp.json
npm run symphony:bridge -- export --atp-file /path/to/.atp.json
npm run symphony:bridge -- sync --atp-file /path/to/.atp.json
```

The bridge reads the workflow front matter and renders one execution prompt per exported ATP node.

Export output:

- `*.request.json`: workflow summary, ATP node metadata, rendered execution prompt, and result contract
- `*.prompt-context.json`: machine-readable ATP handoff context for the node request

Exported request payloads include ATP instruction text, static context, parent handoff context, workflow summary, rendered execution prompt, and the expected result file path. Result payloads must use:

```json
{
  "schemaVersion": "atp-symphony-result/v1",
  "node_id": "T01_example",
  "status": "DONE",
  "report": "Summary of changes and verification.",
  "artifacts": ["src/example.ts"]
}
```

On `sync`, `DONE` marks the ATP node `COMPLETED`, `FAILED` marks it `FAILED`, and successful completions unlock downstream READY nodes. Shared prerequisites are exported once, then downstream siblings fan out only after the prerequisite result is synced back into ATP.

Current scope:

- Uses Symphony-style workflow configuration directly
- Renders per-node prompts from workflow placeholders such as `{{NODE_ID}}` and `{{PROMPT_CONTEXT_FILE}}`
- Includes a local filesystem-backed executor service that runs exported ATP node requests with Codex
- Does not yet implement tracker integration beyond the filesystem queue, or hosted/remote PR automation

## ATP Symphony Service

The service is the local executor layer for exported ATP node requests. It polls `.atp-symphony/requests`, provisions one isolated workspace per request, runs Codex until a result JSON is produced, and then syncs results back into ATP automatically.

Commands:

```bash
npm run symphony:service -- status --atp-file /path/to/.atp.json
npm run symphony:service -- once --atp-file /path/to/.atp.json
npm run symphony:service -- run --atp-file /path/to/.atp.json
```

Notes:

- `once` processes the currently exported request files one time.
- `run` stays alive and polls based on `tracker.poll_interval_seconds` from `WORKFLOW.md`.
- Execution is open-ended by default. `agent.max_turns` is treated only as an optional compatibility cap if you explicitly add it to `WORKFLOW.md`.
- The default tracker is still `filesystem`, so execution requests must first be created by `npm run symphony:bridge -- export ...`.
- Workspace strategy defaults to `auto`: use Git worktrees with per-node branches when the project is a Git repo, otherwise fall back to copied directories.
- `workspace.root_dir`, `workspace.strategy`, `workspace.base_ref`, and `workspace.branch_prefix` in `WORKFLOW.md` control isolation behavior.
- The service still does not create PRs or remote sandboxes.

## ATP Intake

The intake tool helps place new ad hoc issues into the ATP graph before they are exported to Symphony.

It answers:

- should this issue be a new root node?
- should it depend on an existing node?
- is it really a merge/synthesis node?
- does it look separate enough to belong in another ATP plan?

Commands:

```bash
npm run atp:intake -- recommend --atp-file /path/to/.atp.json --title "Runner delivery mode retry bug" --summary "Fix a bug in the Codex runner delivery mode startup path." --files "atp-runner/atp_runner.ts" --labels "runner,bug"
npm run atp:intake -- insert --atp-file /path/to/.atp.json --title "Runner delivery mode retry bug" --summary "Fix a bug in the Codex runner delivery mode startup path." --files "atp-runner/atp_runner.ts" --labels "runner,bug"
npm run atp:intake -- prompt --atp-file /path/to/.atp.json --issue-file /path/to/issue.json
```

Input issue JSON format:

```json
{
  "title": "Runner delivery mode retry bug",
  "summary": "Fix a bug in the Codex runner delivery mode startup path.",
  "context": "Observed while testing startup retries.",
  "files": ["atp-runner/atp_runner.ts"],
  "labels": ["runner", "bug"]
}
```

`recommend` returns a placement recommendation with suggested dependencies, node title, instruction, and nearby candidate nodes. `insert` writes the recommended node into the ATP graph, marks it `READY` when all dependencies are already completed or `LOCKED` otherwise, and refuses `separate_plan_candidate` recommendations unless you pass `--force`. `prompt` renders `INTAKE.md`, which is intended for a short Codex triage thread when the heuristic recommendation needs judgment.

## Scripts

- `npm start` -> run ATP runner (`tsx atp_runner.ts`)
- `npm run symphony:bridge -- <command>` -> run ATP Symphony bridge (`tsx atp_symphony_bridge.ts`)
- `npm run symphony:service -- <command>` -> run local Codex executor for exported ATP node requests (`tsx atp_symphony_service.ts`)
- `npm run atp:intake -- <command>` -> run ATP intake/placement recommender (`tsx atp_intake.ts`)
