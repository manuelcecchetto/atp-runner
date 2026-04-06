# atp-runner

Headless runner for ATP (Agent Task Protocol) workflows with selectable agents.

This repo provides:
- A multi-worker ATP runner (`atp_runner.ts`)
- The worker prompt/instructions (`RUNNER.md`)
- An optional post-node adaptive judge for future-graph replanning

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

Run with adaptive judge proposals only:

```bash
npm start -- \
  --project-root /path/to/repo \
  --atp-file /path/to/plan.atp.json \
  --onboarding false \
  --judge-mode adaptive-dry-run
```

Run with adaptive judge patch apply enabled:

```bash
npm start -- \
  --project-root /path/to/repo \
  --atp-file /path/to/plan.atp.json \
  --onboarding false \
  --judge-mode adaptive \
  --judge-log /path/to/judge.ndjson
```

In adaptive modes, the runner launches a short ATP v1.4 judge turn after active worker rounds. The judge reads the full ATP graph, skips if any nodes remain claimed, and either proposes or applies bounded future-graph patches through the ATP MCP server.

## Browser Testing Runs

For ATP plans that need live browser automation, start the runner from a shell
that has the correct `nvm` Node selected before launching `npm start`.

On this machine, the known working `playwright-cli` install is under Node
`v24.3.0`.

```bash
source ~/.nvm/nvm.sh
nvm use 24.3.0
which playwright-cli
playwright-cli --help
```

If `which playwright-cli` is empty after `nvm use 24`, you are likely on a
different Node 24 install than the one that has the global package. Either:

- switch to the exact installed version, for example `nvm use 24.3.0`, or
- install `@playwright/cli` under the active Node 24 environment.

For browser-heavy ATP plans, also avoid the default Codex sandbox:

```bash
source ~/.nvm/nvm.sh
nvm use 24.3.0
npm start -- \
  --project-root /path/to/repo \
  --atp-file /path/to/plan.atp.json \
  --onboarding false \
  --workers 1 \
  --web-search-mode live \
  --reasoning-effort high \
  --sandbox-mode danger-full-access
```

The runner inherits the shell environment that launches it, so the `nvm use`
step must happen before `npm start`.

## Common Options

- `--project-root <path>`: workspace root
- `--atp-file <path>`: ATP plan file path
- `--prompt-file <path>`: worker prompt (defaults to `RUNNER.md`)
- `--agent-provider <name>`: `codex` or `claude`
- `--workers <n>`: parallel worker count
- `--commit-per-node <bool>`: enable/disable one git commit per completed node
- `--model <name>`: model name for selected provider
- `--judge-mode <mode>`: `strict|adaptive-dry-run|adaptive`
- `--judge-log <path>`: NDJSON audit log for judge decisions
- `--claude-bin <path>`: Claude CLI binary (default: `claude`)
- `--onboarding <bool>`: enable/disable interactive startup selector
- `--no-tui`: disable live terminal dashboard

Default model behavior:

- Codex provider defaults to `gpt-5.4`
- Claude provider defaults to `sonnet`

Environment variable equivalents are supported (for example `ATP_FILE`, `ATP_PROJECT_ROOT`, `ATP_RUNNER_WORKERS`).
For automation/CI, use `--onboarding false`.

Judge mode behavior:

- `strict`: current runner behavior, no inter-round replanning
- `adaptive-dry-run`: judge proposes future-graph patches and writes them to the audit log without applying
- `adaptive`: judge may call `atp_apply_future_patch(...)` when the graph version matches and claimed-node count is zero

## Repository Notes

- Keep `RUNNER.md` as the worker system prompt. It is consumed by the runner.
- Shared worker memory conventions live under `docs/memory/`.

## Scripts

- `npm start` -> run ATP runner (`tsx atp_runner.ts`)
