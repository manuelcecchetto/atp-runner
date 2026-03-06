import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  bridgeStatus,
  exportReadyNodes,
  resolveBridgeConfig,
  syncResults,
} from "./atp_symphony_bridge.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atp-symphony-"));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

test("bridge exports shared prerequisite once and unlocks dependents after sync", () => {
  const root = makeTempDir();
  const atpFile = path.join(root, ".atp.json");
  const stateDir = path.join(root, ".atp-symphony");

  writeJson(atpFile, {
    meta: {
      project_name: "Shared dependency",
      version: "1.3",
      project_status: "ACTIVE",
    },
    nodes: {
      A_foundation: {
        title: "Build auth abstraction",
        instruction: "Create the shared prerequisite.",
        dependencies: [],
        status: "READY",
      },
      B_billing: {
        title: "Use auth in billing",
        instruction: "Update billing to depend on A.",
        dependencies: ["A_foundation"],
        status: "LOCKED",
      },
      C_admin: {
        title: "Use auth in admin",
        instruction: "Update admin to depend on A.",
        dependencies: ["A_foundation"],
        status: "LOCKED",
      },
    },
  });

  const exportConfig = resolveBridgeConfig(["export", "--atp-file", atpFile, "--state-dir", stateDir]);
  assert.ok(exportConfig);

  const firstExport = exportReadyNodes(exportConfig);
  assert.deepEqual(firstExport.exportedNodeIds, ["A_foundation"]);
  assert.ok(fs.existsSync(path.join(stateDir, "requests", "A_foundation.request.json")));
  assert.ok(fs.existsSync(path.join(stateDir, "requests", "A_foundation.prompt-context.json")));
  const firstIssue = readJson<any>(path.join(stateDir, "requests", "A_foundation.request.json"));
  assert.equal(firstIssue.workflow.version, 1);
  assert.equal(firstIssue.workflow.agentProvider, "codex");
  assert.equal(firstIssue.executionId, "atp-node:A_foundation");
  assert.match(firstIssue.executionPrompt, /Node ID: A_foundation/);
  assert.match(firstIssue.executionPrompt, /result JSON file/);
  assert.match(firstIssue.promptContextFile, /A_foundation\.prompt-context\.json$/);

  const duplicateExport = exportReadyNodes(exportConfig);
  assert.deepEqual(duplicateExport.exportedNodeIds, []);
  assert.deepEqual(duplicateExport.skippedNodeIds, ["A_foundation"]);

  writeJson(path.join(stateDir, "results", "A_foundation.result.json"), {
    schemaVersion: "atp-symphony-result/v1",
    node_id: "A_foundation",
    status: "DONE",
    report: "Created the shared auth abstraction.",
    artifacts: ["src/auth.ts"],
    external: {
      issue_id: "ATP-A_foundation",
      branch: "worker/A_foundation",
      pr_url: "https://example.invalid/pr/1",
    },
  });

  const syncConfig = resolveBridgeConfig(["sync", "--atp-file", atpFile, "--state-dir", stateDir]);
  assert.ok(syncConfig);
  const syncSummary = syncResults(syncConfig);
  assert.deepEqual(syncSummary.completedNodeIds, ["A_foundation"]);

  const graph = readJson<any>(atpFile);
  assert.equal(graph.nodes.A_foundation.status, "COMPLETED");
  assert.equal(graph.nodes.B_billing.status, "READY");
  assert.equal(graph.nodes.C_admin.status, "READY");
  assert.match(graph.nodes.A_foundation.report, /Issue: ATP-A_foundation/);
  assert.ok(fs.existsSync(path.join(stateDir, "results", "processed", "A_foundation.result.json")));

  const secondWave = exportReadyNodes(exportConfig);
  assert.deepEqual(secondWave.exportedNodeIds, ["B_billing", "C_admin"]);
});

test("bridge status reflects exported and synced nodes", () => {
  const root = makeTempDir();
  const atpFile = path.join(root, ".atp.json");
  const stateDir = path.join(root, ".atp-symphony");

  writeJson(atpFile, {
    meta: {
      project_name: "Status demo",
      version: "1.3",
      project_status: "ACTIVE",
    },
    nodes: {
      T01: {
        title: "Implement task",
        instruction: "Do the task.",
        dependencies: [],
        status: "READY",
      },
    },
  });

  const exportConfig = resolveBridgeConfig(["export", "--atp-file", atpFile, "--state-dir", stateDir]);
  assert.ok(exportConfig);
  exportReadyNodes(exportConfig);
  const issue = readJson<any>(path.join(stateDir, "requests", "T01.request.json"));
  assert.equal(issue.workflow.trackerProvider, "filesystem");
  assert.match(issue.executionPrompt, /ATP-derived Symphony node request/);

  writeJson(path.join(stateDir, "results", "T01.result.json"), {
    schemaVersion: "atp-symphony-result/v1",
    node_id: "T01",
    status: "FAILED",
    report: "Blocked by missing secret.",
  });

  const syncConfig = resolveBridgeConfig(["sync", "--atp-file", atpFile, "--state-dir", stateDir]);
  assert.ok(syncConfig);
  syncResults(syncConfig);

  const statusConfig = resolveBridgeConfig(["status", "--atp-file", atpFile, "--state-dir", stateDir]);
  assert.ok(statusConfig);
  const statusText = bridgeStatus(statusConfig);

  assert.match(statusText, /Project: Status demo/);
  assert.match(statusText, /Synced failed: 1 \(T01\)/);
  assert.match(statusText, /Exported execution requests: 0/);
  assert.match(statusText, /Workflow file:/);
});
