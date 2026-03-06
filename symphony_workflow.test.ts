import test from "node:test";
import assert from "node:assert/strict";

import { parseSymphonyWorkflow, renderSymphonyPrompt } from "./symphony_workflow.ts";

test("parseSymphonyWorkflow parses front matter and prompt body", () => {
  const workflow = parseSymphonyWorkflow(`---
version: 1
tracker:
  provider: filesystem
  poll_interval_seconds: 20
workspace:
  cleanup: false
hooks:
  after_create:
    - echo "created"
agent:
  provider: codex
  max_turns: 6
codex:
  web_search: true
---

Run issue {{NODE_ID}} with context {{PROMPT_CONTEXT_FILE}}.
`);

  assert.equal(workflow.frontmatter.version, 1);
  assert.equal(workflow.frontmatter.tracker?.provider, "filesystem");
  assert.equal(workflow.frontmatter.tracker?.poll_interval_seconds, 20);
  assert.equal(workflow.frontmatter.workspace?.cleanup, false);
  assert.deepEqual(workflow.frontmatter.hooks?.after_create, ['echo "created"']);
  assert.equal(workflow.frontmatter.agent?.provider, "codex");
  assert.equal(workflow.frontmatter.agent?.max_turns, 6);
  assert.equal(workflow.frontmatter.codex?.web_search, true);
  assert.match(workflow.promptBody, /Run issue \{\{NODE_ID\}\}/);
});

test("renderSymphonyPrompt replaces placeholders", () => {
  const rendered = renderSymphonyPrompt("Issue {{NODE_ID}} => {{RESULT_FILE}}", {
    NODE_ID: "T42",
    RESULT_FILE: "/tmp/T42.result.json",
  });

  assert.equal(rendered, "Issue T42 => /tmp/T42.result.json");
});
