# atp-runner

Headless runner for ATP (Agent Task Protocol) workflows with selectable agents.

This repo provides:
- A multi-worker ATP runner (`atp_runner.ts`)
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

Environment variable equivalents are supported (for example `ATP_FILE`, `ATP_PROJECT_ROOT`, `ATP_RUNNER_WORKERS`).
For automation/CI, use `--onboarding false`.

## Repository Notes

- Keep `RUNNER.md` as the worker system prompt. It is consumed by the runner.
- Shared worker memory conventions live under `docs/memory/`.

## Scripts

- `npm start` -> run ATP runner (`tsx atp_runner.ts`)
