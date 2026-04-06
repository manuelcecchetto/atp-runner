import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { buildJudgePrompt, buildWorkerPrompt, resolveConfig } from "./atp_runner.ts";

const runnerTemplate = fs.readFileSync(new URL("./RUNNER.md", import.meta.url), "utf8");

const baseRuntime = {
  projectRoot: "/tmp/project",
  atpFile: "/tmp/project/.atp.json",
  agentId: "codex_agent_1",
  workerId: "1",
  workers: 1,
  workingDirectory: "/tmp/project",
  branchName: "worker/codex_agent_1",
  hasPreCommit: false,
  hasRuff: false,
  judgeMode: "strict" as const,
};

test("buildWorkerPrompt enforces commit-per-node when enabled", () => {
  const prompt = buildWorkerPrompt(runnerTemplate, {
    ...baseRuntime,
    commitPerNode: true,
  });

  assert.match(prompt, /create exactly one git commit before calling atp_complete_task/i);
  assert.doesNotMatch(prompt, /Do not create git commits as part of normal node completion/i);
});

test("buildWorkerPrompt forbids automatic task commits when disabled", () => {
  const prompt = buildWorkerPrompt(runnerTemplate, {
    ...baseRuntime,
    commitPerNode: false,
  });

  assert.match(prompt, /Do not create git commits as part of normal node completion/i);
  assert.match(prompt, /Complete the node via atp_complete_task without making an automatic task commit, even if files changed/i);
});

test("buildWorkerPrompt adds adaptive judge handoff guidance when enabled", () => {
  const prompt = buildWorkerPrompt(runnerTemplate, {
    ...baseRuntime,
    commitPerNode: false,
    judgeMode: "adaptive",
  });

  assert.match(prompt, /post-node adaptive judge consumes node reports/i);
  assert.match(prompt, /Facts Learned/i);
  assert.match(prompt, /Recommended Next Step/i);
});

test("buildJudgePrompt uses dry-run guidance without future patch apply", () => {
  const prompt = buildJudgePrompt({
    projectRoot: "/tmp/project",
    atpFile: "/tmp/project/.atp.json",
    judgeMode: "adaptive-dry-run",
    round: 2,
    agentId: "codex_agent_judge",
    summary: {
      ACTIVITY: 1,
      NO_TASKS_AVAILABLE: 0,
      PROJECT_INACTIVE: 0,
      ERROR: 0,
    },
  });

  assert.match(prompt, /Do not call atp_apply_future_patch in this mode/i);
  assert.match(prompt, /ATP_JUDGE_DECISION_JSON_START/);
});

test("resolveConfig defaults judge mode to strict", () => {
  const config = resolveConfig([]);

  assert.ok(config);
  assert.equal(config.judgeMode, "strict");
});

test("resolveConfig defaults Codex runs to gpt-5.4", () => {
  const config = resolveConfig([]);

  assert.ok(config);
  assert.equal(config.agentProvider, "codex");
  assert.equal(config.model, "gpt-5.4");
});

test("resolveConfig honors --commit-per-node false", () => {
  const config = resolveConfig([
    "--project-root",
    "/tmp/project",
    "--atp-file",
    "/tmp/project/.atp.json",
    "--onboarding",
    "false",
    "--commit-per-node",
    "false",
  ]);

  assert.ok(config);
  assert.equal(config.commitPerNode, false);
  assert.equal(config.commitPerNodeExplicit, true);
});

test("resolveConfig honors adaptive judge flags", () => {
  const config = resolveConfig([
    "--project-root",
    "/tmp/project",
    "--atp-file",
    "/tmp/project/.atp.json",
    "--onboarding",
    "false",
    "--judge-mode",
    "adaptive",
    "--judge-log",
    "logs/judge.ndjson",
  ]);

  assert.ok(config);
  assert.equal(config.judgeMode, "adaptive");
  assert.equal(config.judgeModeExplicit, true);
  assert.equal(config.judgeLogFile, path.resolve("logs/judge.ndjson"));
});
