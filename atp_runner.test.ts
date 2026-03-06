import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { buildWorkerPrompt, resolveConfig } from "./atp_runner.ts";

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
  assert.match(prompt, /If runtime says commit-per-node is disabled, do not create an automatic task commit/i);
});

test("resolveConfig defaults Codex runs to gpt-5.4", () => {
  const config = resolveConfig([]);

  assert.ok(config);
  assert.equal(config.agentProvider, "codex");
  assert.equal(config.model, "gpt-5.4");
});
