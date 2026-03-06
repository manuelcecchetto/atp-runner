import test from "node:test";
import assert from "node:assert/strict";

import { insertIssueIntoGraph, recommendPlacement } from "./atp_intake.ts";

const graph = {
  meta: {
    project_name: "Demo graph",
    version: "1.3",
    project_status: "ACTIVE",
  },
  nodes: {
    T10_runner_contract: {
      title: "Define runner delivery contract",
      instruction: "Specify the runner delivery mode and constraints for Codex.",
      dependencies: [],
      status: "COMPLETED",
      report: "Defined Codex delivery contract for the runner.",
    },
    T11_runner_impl: {
      title: "Implement runner delivery mode",
      instruction: "Implement the runner delivery mode for Codex and wire it into startup.",
      dependencies: ["T10_runner_contract"],
      status: "READY",
    },
    T12_docs: {
      title: "Rewrite runner docs",
      instruction: "Update quickstart and delivery docs for the new runner mode.",
      dependencies: ["T10_runner_contract"],
      status: "LOCKED",
    },
  },
} as const;

test("recommendPlacement returns new_root for unrelated bug", () => {
  const recommendation = recommendPlacement(graph as any, {
    title: "Fix typo in detached settings page",
    summary: "Simple bug in unrelated UI copy.",
    labels: ["bug"],
    files: ["settings/page.tsx"],
  });

  assert.equal(recommendation.kind, "new_root");
  assert.deepEqual(recommendation.recommendedDependencies, []);
});

test("recommendPlacement anchors adjacent work to existing node", () => {
  const recommendation = recommendPlacement(graph as any, {
    title: "Runner delivery mode retry bug",
    summary: "Fix a bug in the Codex runner delivery mode startup path.",
    files: ["atp-runner/atp_runner.ts"],
    labels: ["runner", "bug"],
  });

  assert.equal(recommendation.kind, "depends_on_existing");
  assert.deepEqual(recommendation.recommendedDependencies, ["T11_runner_impl"]);
  assert.match(recommendation.suggestedInstruction, /Runner delivery mode retry bug/);
});

test("insertIssueIntoGraph adds a new READY root node for unrelated bugs", () => {
  const mutableGraph = structuredClone(graph) as any;

  const inserted = insertIssueIntoGraph(mutableGraph, {
    title: "Fix typo in detached settings page",
    summary: "Simple bug in unrelated UI copy.",
    labels: ["bug"],
    files: ["settings/page.tsx"],
  });

  assert.equal(inserted.nodeId, "N_fix_typo_in_detached_settings_page");
  assert.equal(inserted.status, "READY");
  assert.deepEqual(inserted.dependencies, []);
  assert.equal(mutableGraph.nodes[inserted.nodeId].status, "READY");
});

test("insertIssueIntoGraph adds a LOCKED node when depending on unfinished work", () => {
  const mutableGraph = structuredClone(graph) as any;

  const inserted = insertIssueIntoGraph(mutableGraph, {
    title: "Runner delivery mode retry bug",
    summary: "Fix a bug in the Codex runner delivery mode startup path.",
    files: ["atp-runner/atp_runner.ts"],
    labels: ["runner", "bug"],
  });

  assert.equal(inserted.nodeId, "N_runner_delivery_mode_retry_bug");
  assert.equal(inserted.status, "LOCKED");
  assert.deepEqual(inserted.dependencies, ["T11_runner_impl"]);
  assert.equal(mutableGraph.nodes[inserted.nodeId].status, "LOCKED");
});

test("insertIssueIntoGraph refuses separate_plan_candidate without force", () => {
  const mutableGraph = structuredClone(graph) as any;
  mutableGraph.nodes.T11_runner_impl.status = "COMPLETED";
  mutableGraph.nodes.T12_docs.status = "COMPLETED";

  mutableGraph.nodes.T13_runner_tests = {
    title: "Runner tests",
    instruction: "Runner tests and retry coverage.",
    dependencies: [],
    status: "COMPLETED",
  };
  mutableGraph.nodes.T14_runner_docs = {
    title: "Runner docs",
    instruction: "Runner docs and rollout notes.",
    dependencies: [],
    status: "COMPLETED",
  };
  mutableGraph.nodes.T15_runner_triage = {
    title: "Runner triage",
    instruction: "Runner bug triage and retry summaries.",
    dependencies: [],
    status: "COMPLETED",
  };
  mutableGraph.nodes.T16_runner_rollout = {
    title: "Runner rollout",
    instruction: "Runner rollout and coordination notes.",
    dependencies: [],
    status: "COMPLETED",
  };

  assert.throws(
    () => insertIssueIntoGraph(mutableGraph, {
      title: "Runner follow-up bug",
      summary: "Runner docs tests triage rollout coordination needs alignment for a messy bug.",
      labels: ["runner", "bug"],
    }),
    /separate_plan_candidate/,
  );
});
