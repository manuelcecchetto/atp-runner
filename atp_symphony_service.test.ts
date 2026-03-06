import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { prepareWorkspace, resolveServiceConfig, serviceStatus } from "./atp_symphony_service.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atp-symphony-service-"));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runGit(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("serviceStatus summarizes filesystem request queue state", () => {
  const root = makeTempDir();
  const atpFile = path.join(root, ".atp.json");
  const stateDir = path.join(root, ".atp-symphony");
  const requestsDir = path.join(stateDir, "requests");
  const serviceStateFile = path.join(stateDir, "service-state.json");
  const workflowFile = path.join(stateDir, "WORKFLOW.md");

  writeJson(atpFile, {
    meta: { project_name: "Service demo", version: "1.3", project_status: "ACTIVE" },
    nodes: {},
  });
  fs.mkdirSync(requestsDir, { recursive: true });
  fs.writeFileSync(path.join(requestsDir, "T01.request.json"), "{}\n", "utf8");
  writeJson(serviceStateFile, {
    version: 1,
    requests: {
      T01: {
        nodeId: "T01",
        requestFile: path.join(requestsDir, "T01.request.json"),
        state: "running",
      },
      T02: {
        nodeId: "T02",
        requestFile: path.join(requestsDir, "T02.request.json"),
        state: "completed",
      },
    },
  });
  fs.writeFileSync(workflowFile, `---
version: 1
tracker:
  provider: filesystem
  poll_interval_seconds: 15
agent:
  provider: codex
  max_turns: 4
---

Run the execution request.
`, "utf8");

  const config = resolveServiceConfig([
    "status",
    "--atp-file",
    atpFile,
    "--state-dir",
    stateDir,
  ]);
  assert.ok(config);

  const text = serviceStatus(config);
  assert.match(text, /Tracker: filesystem/);
  assert.match(text, /Running: 1 \(T01\)/);
  assert.match(text, /Completed: 1/);
});

test("prepareWorkspace falls back to copy mode outside git", () => {
  const root = makeTempDir();
  const projectRoot = path.join(root, "project");
  const stateDir = path.join(projectRoot, ".atp-symphony");
  const workflowFile = path.join(stateDir, "WORKFLOW.md");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "README.md"), "demo\n", "utf8");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(workflowFile, `---
version: 1
workspace:
  root_dir: .atp-symphony/workspaces
  strategy: auto
---

Run the execution request.
`, "utf8");

  const prepared = prepareWorkspace(projectRoot, stateDir, workflowFile, "T01_copy");
  assert.equal(prepared.mode, "copy");
  assert.ok(fs.existsSync(path.join(prepared.workspaceDir, "README.md")));
});

test("prepareWorkspace uses git worktree mode when repo is available", () => {
  const root = makeTempDir();
  const repoRoot = path.join(root, "repo");
  const stateDir = path.join(repoRoot, ".atp-symphony");
  const workflowFile = path.join(stateDir, "WORKFLOW.md");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "demo\n", "utf8");
  runGit(["init"], repoRoot);
  runGit(["config", "user.email", "test@example.com"], repoRoot);
  runGit(["config", "user.name", "Test User"], repoRoot);
  runGit(["add", "."], repoRoot);
  runGit(["commit", "-m", "init"], repoRoot);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(workflowFile, `---
version: 1
workspace:
  root_dir: ../.atp-symphony-workspaces
  strategy: git-worktree
  base_ref: HEAD
  branch_prefix: symphony/
---

Run the execution request.
`, "utf8");

  const prepared = prepareWorkspace(repoRoot, stateDir, workflowFile, "T01_node");
  assert.equal(prepared.mode, "git-worktree");
  assert.equal(prepared.branchName, "symphony/t01_node");
  assert.ok(fs.existsSync(path.join(prepared.workspaceDir, "README.md")));
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], prepared.workspaceDir);
  assert.equal(branch, "symphony/t01_node");
});
