import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadSymphonyWorkflow,
  renderSymphonyPrompt,
  type LoadedSymphonyWorkflow,
} from "./symphony_workflow.ts";

type NodeStatus = "LOCKED" | "READY" | "CLAIMED" | "COMPLETED" | "FAILED";
type BridgeCommand = "export" | "sync" | "status";
type ResultStatus = "DONE" | "FAILED";
type BridgeIssueState = "exported" | "completed" | "failed";

interface AtpMeta {
  project_name: string;
  version: string;
  project_status: "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";
  created_at?: string;
}

interface AtpNode {
  title: string;
  instruction: string;
  context?: string;
  dependencies: string[];
  status: NodeStatus;
  reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  type?: string;
  scope_children?: string[];
  worker_id?: string;
  started_at?: string;
  completed_at?: string;
  artifacts?: string[];
  report?: string;
  lease_expires_at?: string | null;
}

interface AtpGraph {
  meta: AtpMeta;
  nodes: Record<string, AtpNode>;
}

interface BridgeIssueRecord {
  nodeId: string;
  executionId: string;
  requestFile: string;
  state: BridgeIssueState;
  exportedAt: string;
  syncedAt?: string;
  resultFile?: string;
}

interface BridgeState {
  version: 1;
  generatedAt: string;
  requests: Record<string, BridgeIssueRecord>;
}

interface BridgeConfig {
  command: BridgeCommand;
  atpFile: string;
  stateDir: string;
  requestsDir: string;
  resultsDir: string;
  processedDir: string;
  stateFile: string;
  workflowFile: string;
}

interface DependencyContext {
  nodeId: string;
  title: string;
  status: NodeStatus;
  report: string;
}

interface SymphonyIssuePayload {
  schemaVersion: "atp-symphony-bridge/v1";
  executionId: string;
  nodeId: string;
  title: string;
  workflow: {
    path: string;
    version: number;
    trackerProvider?: string;
    agentProvider?: string;
    maxTurns?: number;
    codexModel?: string;
    sandboxMode?: string;
  };
  instruction: string;
  context?: string;
  reasoningEffort?: AtpNode["reasoning_effort"];
  project: {
    name: string;
    atpFile: string;
    workflowFile: string;
  };
  dependencies: string[];
  dependencyContext: DependencyContext[];
  promptContextFile: string;
  executionPrompt: string;
  resultContract: {
    resultsDir: string;
    expectedFile: string;
    acceptedStatuses: ResultStatus[];
  };
}

interface SymphonyResultPayload {
  schemaVersion: "atp-symphony-result/v1";
  node_id: string;
  status: ResultStatus;
  report: string;
  artifacts?: string[];
  external?: {
    issue_id?: string;
    branch?: string;
    pr_url?: string;
    run_url?: string;
  };
}

interface ExportSummary {
  exportedNodeIds: string[];
  skippedNodeIds: string[];
}

interface SyncSummary {
  completedNodeIds: string[];
  failedNodeIds: string[];
  skippedResultFiles: string[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKFLOW_TEMPLATE = path.join(__dirname, "SYMPHONY_WORKFLOW.md");

function usage(): string {
  return `ATP Symphony Bridge

Usage:
  tsx atp_symphony_bridge.ts <export|sync|status> [options]

Options:
  --atp-file <path>       ATP plan path (default: ./.atp.json)
  --state-dir <path>      Bridge state directory (default: ./.atp-symphony)
  --requests-dir <path>   Exported execution request directory (default: <state-dir>/requests)
  --issues-dir <path>     Backward-compatible alias for --requests-dir
  --results-dir <path>    Incoming result directory (default: <state-dir>/results)
  --workflow-file <path>  Workflow file path exposed to Symphony (default: <state-dir>/WORKFLOW.md)
  --help                  Show this message
`;
}

function isoNow(): string {
  return new Date().toISOString();
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function parseArgs(argv: string[]): BridgeConfig | null {
  let command: BridgeCommand | null = null;
  let atpFile = path.resolve(".atp.json");
  let stateDir = path.resolve(".atp-symphony");
  let requestsDir: string | null = null;
  let resultsDir: string | null = null;
  let workflowFile: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      return null;
    }
    if (!arg.startsWith("--")) {
      if (!command) {
        if (arg !== "export" && arg !== "sync" && arg !== "status") {
          throw new Error(`Unknown command "${arg}". Expected export, sync, or status.`);
        }
        command = arg;
        continue;
      }
      throw new Error(`Unexpected positional argument "${arg}".`);
    }

    const next = argv[index + 1];
    if (!next) {
      throw new Error(`Missing value for ${arg}.`);
    }
    if (arg === "--atp-file") {
      atpFile = path.resolve(next);
    } else if (arg === "--state-dir") {
      stateDir = path.resolve(next);
    } else if (arg === "--requests-dir" || arg === "--issues-dir") {
      requestsDir = path.resolve(next);
    } else if (arg === "--results-dir") {
      resultsDir = path.resolve(next);
    } else if (arg === "--workflow-file") {
      workflowFile = path.resolve(next);
    } else {
      throw new Error(`Unknown option "${arg}".`);
    }
    index += 1;
  }

  if (!command) {
    console.log(usage());
    return null;
  }

  const resolvedRequestsDir = path.resolve(requestsDir ?? path.join(stateDir, "requests"));
  const resolvedResultsDir = path.resolve(resultsDir ?? path.join(stateDir, "results"));
  const resolvedWorkflowFile = path.resolve(workflowFile ?? path.join(stateDir, "WORKFLOW.md"));

  return {
    command,
    atpFile,
    stateDir,
    requestsDir: resolvedRequestsDir,
    resultsDir: resolvedResultsDir,
    processedDir: path.join(resolvedResultsDir, "processed"),
    stateFile: path.join(stateDir, "state.json"),
    workflowFile: resolvedWorkflowFile,
  };
}

function ensureGraph(graph: unknown): asserts graph is AtpGraph {
  if (!graph || typeof graph !== "object") {
    throw new Error("ATP graph must be an object.");
  }
  const candidate = graph as Partial<AtpGraph>;
  if (!candidate.meta || !candidate.nodes) {
    throw new Error("ATP graph must contain meta and nodes.");
  }
  for (const [nodeId, node] of Object.entries(candidate.nodes)) {
    if (!Array.isArray(node.dependencies)) {
      throw new Error(`Node ${nodeId} is missing a dependencies array.`);
    }
    for (const depId of node.dependencies) {
      if (!candidate.nodes[depId]) {
        throw new Error(`Node ${nodeId} references missing dependency ${depId}.`);
      }
    }
  }
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function loadGraph(atpFile: string): AtpGraph {
  const graph = readJsonFile<unknown>(atpFile);
  ensureGraph(graph);
  return graph;
}

function saveGraph(atpFile: string, graph: AtpGraph): void {
  writeJsonFile(atpFile, graph);
}

function loadState(stateFile: string): BridgeState {
  if (!fs.existsSync(stateFile)) {
    return {
      version: 1,
      generatedAt: isoNow(),
      requests: {},
    };
  }
  const state = readJsonFile<BridgeState>(stateFile);
  return {
    version: 1,
    generatedAt: state.generatedAt ?? isoNow(),
    requests: (state as any).requests ?? (state as any).issues ?? {},
  };
}

function saveState(stateFile: string, state: BridgeState): void {
  state.generatedAt = isoNow();
  writeJsonFile(stateFile, state);
}

function ensureBridgePaths(config: BridgeConfig): void {
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.mkdirSync(config.requestsDir, { recursive: true });
  fs.mkdirSync(config.resultsDir, { recursive: true });
  fs.mkdirSync(config.processedDir, { recursive: true });

  if (fs.existsSync(config.workflowFile)) {
    return;
  }

  const template = fs.existsSync(DEFAULT_WORKFLOW_TEMPLATE)
    ? fs.readFileSync(DEFAULT_WORKFLOW_TEMPLATE, "utf8")
    : [
        "---",
        "version: 1",
      "tracker:",
        "  provider: filesystem",
        "  issue_source: atp-node-execution-request",
        "  poll_interval_seconds: 30",
        "agent:",
        "  provider: codex",
        "  max_turns: 8",
        "---",
        "",
      "Execute the ATP-exported node request using the attached prompt context file.",
      ].join("\n");
  fs.writeFileSync(config.workflowFile, template, "utf8");
}

function findChildren(nodes: Record<string, AtpNode>, nodeId: string): string[] {
  return Object.entries(nodes)
    .filter(([, node]) => node.dependencies.includes(nodeId))
    .map(([childId]) => childId);
}

function dependenciesSatisfied(nodes: Record<string, AtpNode>, node: AtpNode): boolean {
  return node.dependencies.every((dependencyId) => nodes[dependencyId]?.status === "COMPLETED");
}

function refreshReadyNodes(graph: AtpGraph): string[] {
  const unblocked: string[] = [];
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    if (node.type === "SCOPE") {
      continue;
    }
    if (node.status !== "LOCKED") {
      continue;
    }
    if (!dependenciesSatisfied(graph.nodes, node)) {
      continue;
    }
    node.status = "READY";
    unblocked.push(nodeId);
  }
  return unblocked;
}

function listDependencyContext(graph: AtpGraph, node: AtpNode): DependencyContext[] {
  return node.dependencies.map((dependencyId) => {
    const dependencyNode = graph.nodes[dependencyId];
    return {
      nodeId: dependencyId,
      title: dependencyNode.title,
      status: dependencyNode.status,
      report: dependencyNode.report ?? "(no handoff provided)",
    };
  });
}

function summarizeDependencyContext(dependencyContext: DependencyContext[]): string {
  if (dependencyContext.length === 0) {
    return "- No ATP parent context.";
  }
  return dependencyContext
    .map((dependency) => `- From ${dependency.nodeId} (${dependency.status}): ${dependency.report}`)
    .join("\n");
}

function toWorkflowSummary(workflow: LoadedSymphonyWorkflow): SymphonyIssuePayload["workflow"] {
  const frontmatter = workflow.frontmatter;
  return {
    path: workflow.path,
    version: frontmatter.version,
    trackerProvider: frontmatter.tracker?.provider,
    agentProvider: frontmatter.agent?.provider,
    maxTurns: frontmatter.agent?.max_turns,
    codexModel: frontmatter.codex?.model,
    sandboxMode: frontmatter.codex?.sandbox_mode,
  };
}

function buildPromptContextPayload(config: BridgeConfig, graph: AtpGraph, nodeId: string): Record<string, unknown> {
  const node = graph.nodes[nodeId];
  return {
    schemaVersion: "atp-symphony-context/v1",
    project: {
      name: graph.meta.project_name,
      atpFile: config.atpFile,
    },
    node: {
      id: nodeId,
      title: node.title,
      instruction: node.instruction,
      context: node.context ?? "",
      reasoningEffort: node.reasoning_effort ?? "medium",
      dependencies: [...node.dependencies],
    },
    dependencyContext: listDependencyContext(graph, node),
    resultContract: {
      resultsDir: config.resultsDir,
      expectedFile: path.join(config.resultsDir, `${nodeId}.result.json`),
    },
  };
}

function buildPromptTemplateValues(
  config: BridgeConfig,
  graph: AtpGraph,
  nodeId: string,
  promptContextFile: string,
): Record<string, string> {
  const node = graph.nodes[nodeId];
  const dependencyContext = listDependencyContext(graph, node);
  return {
    PROJECT_NAME: graph.meta.project_name,
    ATP_FILE: config.atpFile,
    NODE_ID: nodeId,
    NODE_TITLE: node.title,
    NODE_INSTRUCTION: node.instruction,
    NODE_CONTEXT: node.context ?? "",
    NODE_REASONING_EFFORT: node.reasoning_effort ?? "medium",
    DEPENDENCY_IDS: node.dependencies.join(", "),
    DEPENDENCY_CONTEXT: summarizeDependencyContext(dependencyContext),
    RESULT_FILE: path.join(config.resultsDir, `${nodeId}.result.json`),
    PROMPT_CONTEXT_FILE: promptContextFile,
  };
}

export function selectNodesForExport(graph: AtpGraph, state: BridgeState): string[] {
  return Object.entries(graph.nodes)
    .filter(([nodeId, node]) => {
      if (node.type === "SCOPE") {
        return false;
      }
      if (node.status !== "READY") {
        return false;
      }
      const existing = state.requests[nodeId];
      if (!existing) {
        return true;
      }
      return existing.state !== "exported";
    })
    .sort(([leftId, leftNode], [rightId, rightNode]) => {
      const leftChildren = findChildren(graph.nodes, leftId).length;
      const rightChildren = findChildren(graph.nodes, rightId).length;
      return leftNode.dependencies.length - rightNode.dependencies.length || leftChildren - rightChildren || leftId.localeCompare(rightId);
    })
    .map(([nodeId]) => nodeId);
}

function buildIssuePayload(
  config: BridgeConfig,
  graph: AtpGraph,
  nodeId: string,
  workflow: LoadedSymphonyWorkflow,
  promptContextFile: string,
): SymphonyIssuePayload {
  const node = graph.nodes[nodeId];
  const templateValues = buildPromptTemplateValues(config, graph, nodeId, promptContextFile);
  const dependencyContext = listDependencyContext(graph, node);
  return {
    schemaVersion: "atp-symphony-bridge/v1",
    executionId: `atp-node:${nodeId}`,
    nodeId,
    title: node.title,
    workflow: toWorkflowSummary(workflow),
    instruction: node.instruction,
    context: node.context,
    reasoningEffort: node.reasoning_effort,
    project: {
      name: graph.meta.project_name,
      atpFile: config.atpFile,
      workflowFile: config.workflowFile,
    },
    dependencies: [...node.dependencies],
    dependencyContext,
    promptContextFile,
    executionPrompt: renderSymphonyPrompt(workflow.promptBody, templateValues),
    resultContract: {
      resultsDir: config.resultsDir,
      expectedFile: path.join(config.resultsDir, `${nodeId}.result.json`),
      acceptedStatuses: ["DONE", "FAILED"],
    },
  };
}

export function exportReadyNodes(config: BridgeConfig): ExportSummary {
  ensureBridgePaths(config);
  const graph = loadGraph(config.atpFile);
  const state = loadState(config.stateFile);
  const workflow = loadSymphonyWorkflow(config.workflowFile);

  if (graph.meta.project_status !== "ACTIVE") {
    return { exportedNodeIds: [], skippedNodeIds: [] };
  }

  const candidateNodeIds = selectNodesForExport(graph, state);
  const skippedNodeIds: string[] = [];
  for (const [nodeId, record] of Object.entries(state.requests)) {
    if (record.state === "exported" && graph.nodes[nodeId]?.status === "READY") {
      skippedNodeIds.push(nodeId);
    }
  }

  for (const nodeId of candidateNodeIds) {
    const promptContextFile = path.join(config.requestsDir, `${nodeId}.prompt-context.json`);
    writeJsonFile(promptContextFile, buildPromptContextPayload(config, graph, nodeId));
    const payload = buildIssuePayload(config, graph, nodeId, workflow, promptContextFile);
    const requestFile = path.join(config.requestsDir, `${nodeId}.request.json`);
    writeJsonFile(requestFile, payload);
    state.requests[nodeId] = {
      nodeId,
      executionId: payload.executionId,
      requestFile,
      state: "exported",
      exportedAt: isoNow(),
    };
  }

  saveState(config.stateFile, state);
  return {
    exportedNodeIds: candidateNodeIds,
    skippedNodeIds: skippedNodeIds.sort(),
  };
}

function buildResultReport(result: SymphonyResultPayload): string {
  const lines = [result.report.trim()];
  const external = result.external ?? {};
  const metadata = [
    external.issue_id ? `Issue: ${external.issue_id}` : "",
    external.branch ? `Branch: ${external.branch}` : "",
    external.pr_url ? `PR: ${external.pr_url}` : "",
    external.run_url ? `Run: ${external.run_url}` : "",
  ].filter(Boolean);
  if (metadata.length > 0) {
    lines.push("", "External execution metadata:", ...metadata.map((item) => `- ${item}`));
  }
  return lines.join("\n");
}

function clearRuntimeFields(node: AtpNode): void {
  delete node.worker_id;
  delete node.started_at;
  delete node.lease_expires_at;
}

function moveProcessedResult(resultFile: string, processedDir: string): string {
  const target = path.join(processedDir, path.basename(resultFile));
  fs.renameSync(resultFile, target);
  return target;
}

function listResultFiles(resultsDir: string): string[] {
  if (!fs.existsSync(resultsDir)) {
    return [];
  }
  return fs.readdirSync(resultsDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => path.join(resultsDir, entry))
    .sort();
}

export function syncResults(config: BridgeConfig): SyncSummary {
  ensureBridgePaths(config);
  const graph = loadGraph(config.atpFile);
  const state = loadState(config.stateFile);
  const resultFiles = listResultFiles(config.resultsDir);

  const completedNodeIds: string[] = [];
  const failedNodeIds: string[] = [];
  const skippedResultFiles: string[] = [];

  for (const resultFile of resultFiles) {
    const result = readJsonFile<SymphonyResultPayload>(resultFile);
    const nodeId = result.node_id;
    const node = graph.nodes[nodeId];
    const issue = state.requests[nodeId];

    if (!node || !issue || issue.state !== "exported") {
      skippedResultFiles.push(path.basename(resultFile));
      continue;
    }

    if (result.status !== "DONE" && result.status !== "FAILED") {
      skippedResultFiles.push(path.basename(resultFile));
      continue;
    }

    clearRuntimeFields(node);
    node.report = buildResultReport(result);
    node.artifacts = unique([...(node.artifacts ?? []), ...(result.artifacts ?? [])]);
    node.completed_at = isoNow();
    node.status = result.status === "DONE" ? "COMPLETED" : "FAILED";

    const processedPath = moveProcessedResult(resultFile, config.processedDir);
    issue.resultFile = processedPath;
    issue.syncedAt = isoNow();
    issue.state = result.status === "DONE" ? "completed" : "failed";

    if (result.status === "DONE") {
      completedNodeIds.push(nodeId);
    } else {
      failedNodeIds.push(nodeId);
    }
  }

  if (completedNodeIds.length > 0) {
    refreshReadyNodes(graph);
  }

  saveGraph(config.atpFile, graph);
  saveState(config.stateFile, state);

  return {
    completedNodeIds,
    failedNodeIds,
    skippedResultFiles,
  };
}

export function bridgeStatus(config: BridgeConfig): string {
  ensureBridgePaths(config);
  const graph = loadGraph(config.atpFile);
  const state = loadState(config.stateFile);
  const workflow = loadSymphonyWorkflow(config.workflowFile);
  const readyNodes = Object.entries(graph.nodes)
    .filter(([, node]) => node.status === "READY" && node.type !== "SCOPE")
    .map(([nodeId]) => nodeId)
    .sort();
  const exportedNodes = Object.values(state.requests)
    .filter((issue) => issue.state === "exported")
    .map((issue) => issue.nodeId)
    .sort();
  const completedNodes = Object.values(state.requests)
    .filter((issue) => issue.state === "completed")
    .map((issue) => issue.nodeId)
    .sort();
  const failedNodes = Object.values(state.requests)
    .filter((issue) => issue.state === "failed")
    .map((issue) => issue.nodeId)
    .sort();

  return [
    `Project: ${graph.meta.project_name}`,
    `ATP status: ${graph.meta.project_status}`,
    `Ready nodes: ${readyNodes.length}${readyNodes.length ? ` (${readyNodes.join(", ")})` : ""}`,
    `Exported execution requests: ${exportedNodes.length}${exportedNodes.length ? ` (${exportedNodes.join(", ")})` : ""}`,
    `Synced complete: ${completedNodes.length}${completedNodes.length ? ` (${completedNodes.join(", ")})` : ""}`,
    `Synced failed: ${failedNodes.length}${failedNodes.length ? ` (${failedNodes.join(", ")})` : ""}`,
    `Workflow version: ${workflow.frontmatter.version}`,
    `Workflow tracker: ${workflow.frontmatter.tracker?.provider ?? "unspecified"}`,
    `Workflow agent: ${workflow.frontmatter.agent?.provider ?? "unspecified"}${workflow.frontmatter.agent?.max_turns ? ` (max_turns=${workflow.frontmatter.agent.max_turns})` : ""}`,
    `Requests dir: ${config.requestsDir}`,
    `Results dir: ${config.resultsDir}`,
    `Workflow file: ${config.workflowFile}`,
  ].join("\n");
}

export function resolveBridgeConfig(argv: string[]): BridgeConfig | null {
  return parseArgs(argv);
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  if (!config) {
    return;
  }

  if (config.command === "export") {
    const summary = exportReadyNodes(config);
    console.log(`Exported ${summary.exportedNodeIds.length} node(s).`);
    if (summary.exportedNodeIds.length > 0) {
      console.log(`Nodes: ${summary.exportedNodeIds.join(", ")}`);
    }
    if (summary.skippedNodeIds.length > 0) {
      console.log(`Already exported: ${summary.skippedNodeIds.join(", ")}`);
    }
    return;
  }

  if (config.command === "sync") {
    const summary = syncResults(config);
    console.log(`Completed: ${summary.completedNodeIds.length}, Failed: ${summary.failedNodeIds.length}`);
    if (summary.completedNodeIds.length > 0) {
      console.log(`Completed nodes: ${summary.completedNodeIds.join(", ")}`);
    }
    if (summary.failedNodeIds.length > 0) {
      console.log(`Failed nodes: ${summary.failedNodeIds.join(", ")}`);
    }
    if (summary.skippedResultFiles.length > 0) {
      console.log(`Skipped result files: ${summary.skippedResultFiles.join(", ")}`);
    }
    return;
  }

  console.log(bridgeStatus(config));
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
