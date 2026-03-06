import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Codex, type SandboxMode, type WebSearchMode } from "@openai/codex-sdk";

import { resolveBridgeConfig, syncResults } from "./atp_symphony_bridge.ts";
import { loadSymphonyWorkflow, renderSymphonyPrompt } from "./symphony_workflow.ts";

type ServiceCommand = "run" | "once" | "status";
type ServiceIssueState = "pending" | "running" | "completed" | "failed";
type WorkspaceMode = "git-worktree" | "copy";

interface ServiceConfig {
  command: ServiceCommand;
  atpFile: string;
  stateDir: string;
  requestsDir: string;
  resultsDir: string;
  workflowFile: string;
  serviceStateFile: string;
  logFile: string;
  projectRoot: string;
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
  promptContextFile: string;
  executionPrompt: string;
  resultContract: {
    resultsDir: string;
    expectedFile: string;
    acceptedStatuses: Array<"DONE" | "FAILED">;
  };
}

interface ServiceIssueRecord {
  nodeId: string;
  requestFile: string;
  workspaceDir?: string;
  workspaceMode?: WorkspaceMode;
  branchName?: string;
  state: ServiceIssueState;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

interface ServiceState {
  version: 1;
  requests: Record<string, ServiceIssueRecord>;
}

function usage(): string {
  return `ATP Symphony Service

Usage:
  tsx atp_symphony_service.ts <run|once|status> [options]

Options:
  --atp-file <path>       ATP plan path (default: ./.atp.json)
  --state-dir <path>      Bridge/service state directory (default: ./.atp-symphony)
  --requests-dir <path>   Exported execution request directory (default: <state-dir>/requests)
  --issues-dir <path>     Backward-compatible alias for --requests-dir
  --results-dir <path>    Result directory (default: <state-dir>/results)
  --workflow-file <path>  Workflow file (default: <state-dir>/WORKFLOW.md)
  --project-root <path>   Source project root (default: dirname(atp-file))
  --help                  Show this message
`;
}

function isoNow(): string {
  return new Date().toISOString();
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseArgs(argv: string[]): ServiceConfig | null {
  let command: ServiceCommand | null = null;
  let atpFile = path.resolve(".atp.json");
  let stateDir = path.resolve(".atp-symphony");
  let requestsDir: string | undefined;
  let resultsDir: string | undefined;
  let workflowFile: string | undefined;
  let projectRoot: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      return null;
    }
    if (!arg.startsWith("--")) {
      if (!command) {
        if (arg !== "run" && arg !== "once" && arg !== "status") {
          throw new Error(`Unknown command "${arg}". Expected run, once, or status.`);
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
    } else if (arg === "--project-root") {
      projectRoot = path.resolve(next);
    } else {
      throw new Error(`Unknown option "${arg}".`);
    }
    index += 1;
  }

  if (!command) {
    console.log(usage());
    return null;
  }

  const resolvedRequestsDir = requestsDir ?? path.join(stateDir, "requests");
  const resolvedResultsDir = resultsDir ?? path.join(stateDir, "results");
  const resolvedWorkflowFile = workflowFile ?? path.join(stateDir, "WORKFLOW.md");
  const resolvedProjectRoot = projectRoot ?? path.dirname(atpFile);

  return {
    command,
    atpFile,
    stateDir,
    requestsDir: resolvedRequestsDir,
    resultsDir: resolvedResultsDir,
    workflowFile: resolvedWorkflowFile,
    serviceStateFile: path.join(stateDir, "service-state.json"),
    logFile: path.join(stateDir, "service.log"),
    projectRoot: resolvedProjectRoot,
  };
}

function ensureServicePaths(config: ServiceConfig): void {
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.mkdirSync(config.requestsDir, { recursive: true });
  fs.mkdirSync(config.resultsDir, { recursive: true });
  if (!fs.existsSync(config.serviceStateFile)) {
    writeJsonFile(config.serviceStateFile, { version: 1, requests: {} });
  }
}

function loadState(config: ServiceConfig): ServiceState {
  ensureServicePaths(config);
  const raw = readJsonFile<any>(config.serviceStateFile);
  return {
    version: 1,
    requests: raw.requests ?? raw.issues ?? {},
  };
}

function saveState(config: ServiceConfig, state: ServiceState): void {
  writeJsonFile(config.serviceStateFile, state);
}

function appendLog(config: ServiceConfig, line: string): void {
  fs.appendFileSync(config.logFile, `${isoNow()} ${line}\n`, "utf8");
}

function listIssueFiles(issuesDir: string): string[] {
  if (!fs.existsSync(issuesDir)) {
    return [];
  }
  return fs.readdirSync(issuesDir)
    .filter((entry) => entry.endsWith(".request.json") || entry.endsWith(".issue.json"))
    .map((entry) => path.join(issuesDir, entry))
    .sort();
}

function copyProjectToWorkspace(projectRoot: string, workspaceDir: string, ignoreRoots: string[]): void {
  fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });
  const ignored = ignoreRoots.map((root) => path.resolve(root));
  fs.cpSync(projectRoot, workspaceDir, {
    recursive: true,
    dereference: false,
    filter(source) {
      const resolved = path.resolve(source);
      return !ignored.some((ignoredRoot) => resolved === ignoredRoot || resolved.startsWith(`${ignoredRoot}${path.sep}`));
    },
  });
}

function runGit(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function detectGitRepoRoot(projectRoot: string): string | null {
  const result = runGit(["rev-parse", "--show-toplevel"], projectRoot);
  if (result.status !== 0) {
    return null;
  }
  const repoRoot = result.stdout.trim();
  return repoRoot ? path.resolve(repoRoot) : null;
}

function sanitizeBranchSuffix(nodeId: string): string {
  return nodeId
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "") || "node";
}

function resolveWorkspaceStrategy(strategy: string | undefined, repoRoot: string | null): WorkspaceMode {
  if (strategy === "git-worktree") {
    return "git-worktree";
  }
  if (strategy === "copy") {
    return "copy";
  }
  return repoRoot ? "git-worktree" : "copy";
}

function resolveWorkspaceRoot(
  projectRoot: string,
  repoRoot: string | null,
  workflowRootDir: string | undefined,
  mode: WorkspaceMode,
): string {
  if (workflowRootDir) {
    if (path.isAbsolute(workflowRootDir)) {
      return workflowRootDir;
    }
    if (mode === "git-worktree" && repoRoot) {
      const candidate = path.resolve(repoRoot, workflowRootDir);
      if (candidate === repoRoot || candidate.startsWith(`${repoRoot}${path.sep}`)) {
        return path.join(path.dirname(repoRoot), path.basename(candidate));
      }
      return candidate;
    }
    const candidate = path.resolve(projectRoot, workflowRootDir);
    if (candidate === projectRoot || candidate.startsWith(`${projectRoot}${path.sep}`)) {
      return path.join(path.dirname(projectRoot), path.basename(candidate));
    }
    return candidate;
  }

  if (mode === "git-worktree" && repoRoot) {
    return path.join(path.dirname(repoRoot), `.${path.basename(repoRoot)}-symphony-workspaces`);
  }
  return path.resolve(projectRoot, ".atp-symphony/workspaces");
}

interface PreparedWorkspace {
  workspaceDir: string;
  mode: WorkspaceMode;
  branchName?: string;
  repoRoot?: string;
}

export function prepareWorkspace(
  projectRoot: string,
  stateDir: string,
  workflowFile: string,
  nodeId: string,
): PreparedWorkspace {
  const workflow = loadSymphonyWorkflow(workflowFile);
  const repoRoot = detectGitRepoRoot(projectRoot);
  const mode = resolveWorkspaceStrategy(workflow.frontmatter.workspace?.strategy, repoRoot);
  const workspaceRoot = resolveWorkspaceRoot(projectRoot, repoRoot, workflow.frontmatter.workspace?.root_dir, mode);
  const workspaceDir = path.join(workspaceRoot, nodeId);

  if (mode === "git-worktree" && repoRoot) {
    const branchPrefix = workflow.frontmatter.workspace?.branch_prefix ?? "symphony/";
    const branchName = `${branchPrefix}${sanitizeBranchSuffix(nodeId)}`;

    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });
      const branchExists = runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repoRoot).status === 0;
      const baseRef = workflow.frontmatter.workspace?.base_ref ?? "HEAD";
      const args = branchExists
        ? ["worktree", "add", workspaceDir, branchName]
        : ["worktree", "add", "-b", branchName, workspaceDir, baseRef];
      const result = runGit(args, repoRoot);
      if (result.status !== 0) {
        throw new Error(`git worktree add failed for ${nodeId}: ${result.stderr || result.stdout}`.trim());
      }
    }

    return {
      workspaceDir,
      mode,
      branchName,
      repoRoot,
    };
  }

  if (!fs.existsSync(workspaceDir)) {
    copyProjectToWorkspace(projectRoot, workspaceDir, [
      path.resolve(stateDir),
      path.resolve(workspaceRoot),
    ]);
  }

  return {
    workspaceDir,
    mode,
  };
}

function placeholderValues(issue: SymphonyIssuePayload, workspaceDir: string, branchName?: string): Record<string, string> {
  return {
    NODE_ID: issue.nodeId,
    ISSUE_FILE: issue.executionId,
    WORKSPACE_DIR: workspaceDir,
    RESULT_FILE: issue.resultContract.expectedFile,
    PROMPT_CONTEXT_FILE: issue.promptContextFile,
    BRANCH_NAME: branchName ?? "",
  };
}

function runHookCommands(commands: string[] | undefined, issue: SymphonyIssuePayload, workspaceDir: string, branchName?: string): void {
  if (!commands || commands.length === 0) {
    return;
  }
  const values = placeholderValues(issue, workspaceDir, branchName);
  for (const command of commands) {
    const rendered = renderSymphonyPrompt(command, values);
    const result = spawnSync("/bin/zsh", ["-lc", rendered], {
      cwd: workspaceDir,
      stdio: "pipe",
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`Hook failed: ${rendered}\n${result.stderr || result.stdout}`.trim());
    }
  }
}

function toSandboxMode(value: string | undefined): SandboxMode {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  return "workspace-write";
}

function toWebSearchMode(enabled: boolean | undefined): WebSearchMode {
  return enabled === false ? "disabled" : "live";
}

async function runIssueWithCodex(config: ServiceConfig, issue: SymphonyIssuePayload, workspaceDir: string): Promise<void> {
  const workflow = loadSymphonyWorkflow(config.workflowFile);
  const maxTurns = workflow.frontmatter.agent?.max_turns;
  const env = {
    ...process.env,
    ATP_FILE: config.atpFile,
    ATP_PROJECT_ROOT: config.projectRoot,
    SYMPHONY_NODE_ID: issue.nodeId,
    SYMPHONY_RESULT_FILE: issue.resultContract.expectedFile,
  };

  const client = new Codex({ env });
  const thread = client.startThread({
    sandboxMode: toSandboxMode(workflow.frontmatter.codex?.sandbox_mode),
    skipGitRepoCheck: true,
    model: workflow.frontmatter.codex?.model ?? "gpt-5.4",
    workingDirectory: workspaceDir,
    webSearchEnabled: workflow.frontmatter.codex?.web_search !== false,
    webSearchMode: toWebSearchMode(workflow.frontmatter.codex?.web_search),
    additionalDirectories: [config.projectRoot, config.stateDir],
  });

  let prompt = issue.executionPrompt;
  for (let turn = 1; ; turn += 1) {
    appendLog(config, `node=${issue.nodeId} turn=${turn} starting`);
    const streamResult = await thread.runStreamed(prompt);
    for await (const event of streamResult.events) {
      if (event.type === "turn.failed") {
        appendLog(config, `node=${issue.nodeId} turn=${turn} failed=${event.error.message}`);
      }
      if (event.type === "turn.completed") {
        appendLog(config, `node=${issue.nodeId} turn=${turn} completed`);
      }
    }
    if (fs.existsSync(issue.resultContract.expectedFile)) {
      appendLog(config, `node=${issue.nodeId} result-file-created`);
      return;
    }
    prompt = [
      `Continue working on issue ${issue.nodeId}.`,
      `The required result file does not exist yet at ${issue.resultContract.expectedFile}.`,
      "Finish the task if possible, or write a FAILED result JSON with a clear blocker report.",
    ].join(" ");
    if (maxTurns !== undefined && turn >= maxTurns) {
      writeJsonFile(issue.resultContract.expectedFile, {
        schemaVersion: "atp-symphony-result/v1",
        node_id: issue.nodeId,
        status: "FAILED",
        report: `Codex reached configured max_turns=${maxTurns} without creating the required result file at ${issue.resultContract.expectedFile}.`,
      });
      appendLog(config, `node=${issue.nodeId} turn-limit-hit=${maxTurns}`);
      return;
    }
  }
}

async function processIssue(config: ServiceConfig, issueFile: string): Promise<void> {
  const workflow = loadSymphonyWorkflow(config.workflowFile);
  const issue = readJsonFile<SymphonyIssuePayload>(issueFile);
  const state = loadState(config);
  const existing = state.requests[issue.nodeId];
  if (existing?.state === "running") {
    return;
  }
  const prepared = prepareWorkspace(config.projectRoot, config.stateDir, config.workflowFile, issue.nodeId);
  const createdFresh = !existing?.workspaceDir || existing.workspaceDir !== prepared.workspaceDir || !fs.existsSync(existing.workspaceDir);
  if (createdFresh) {
    runHookCommands(workflow.frontmatter.hooks?.after_create, issue, prepared.workspaceDir, prepared.branchName);
  }

  state.requests[issue.nodeId] = {
    nodeId: issue.nodeId,
    requestFile: issueFile,
    workspaceDir: prepared.workspaceDir,
    workspaceMode: prepared.mode,
    branchName: prepared.branchName,
    state: "running",
    startedAt: isoNow(),
  };
  saveState(config, state);
  appendLog(config, `node=${issue.nodeId} workspace=${prepared.workspaceDir} mode=${prepared.mode}${prepared.branchName ? ` branch=${prepared.branchName}` : ""} state=running`);

  try {
    runHookCommands(workflow.frontmatter.hooks?.before_run, issue, prepared.workspaceDir, prepared.branchName);
    await runIssueWithCodex(config, issue, prepared.workspaceDir);
    runHookCommands(workflow.frontmatter.hooks?.after_run, issue, prepared.workspaceDir, prepared.branchName);

    const nextState = loadState(config);
    nextState.requests[issue.nodeId] = {
      ...nextState.requests[issue.nodeId],
      state: "completed",
      completedAt: isoNow(),
    };
    saveState(config, nextState);
    appendLog(config, `node=${issue.nodeId} state=completed`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJsonFile(issue.resultContract.expectedFile, {
      schemaVersion: "atp-symphony-result/v1",
      node_id: issue.nodeId,
      status: "FAILED",
      report: `Executor error: ${message}`,
    });

    const nextState = loadState(config);
    nextState.requests[issue.nodeId] = {
      ...nextState.requests[issue.nodeId],
      state: "failed",
      completedAt: isoNow(),
      error: message,
    };
    saveState(config, nextState);
    appendLog(config, `node=${issue.nodeId} state=failed error=${message}`);
  }

  const syncConfig = resolveBridgeConfig([
    "sync",
    "--atp-file",
    config.atpFile,
    "--state-dir",
    config.stateDir,
    "--requests-dir",
    config.requestsDir,
    "--results-dir",
    config.resultsDir,
    "--workflow-file",
    config.workflowFile,
  ]);
  if (syncConfig) {
    syncResults(syncConfig);
  }
}

async function runOnce(config: ServiceConfig): Promise<void> {
  ensureServicePaths(config);
  const issueFiles = listIssueFiles(config.requestsDir);
  for (const issueFile of issueFiles) {
    const issue = readJsonFile<SymphonyIssuePayload>(issueFile);
    const state = loadState(config);
    if (state.requests[issue.nodeId]?.state === "running") {
      continue;
    }
    if (fs.existsSync(issue.resultContract.expectedFile)) {
      continue;
    }
    await processIssue(config, issueFile);
  }
}

export function serviceStatus(config: ServiceConfig): string {
  ensureServicePaths(config);
  const workflow = loadSymphonyWorkflow(config.workflowFile);
  const state = loadState(config);
  const pendingIssues = listIssueFiles(config.requestsDir).length;
  const running = Object.values(state.requests).filter((issue) => issue.state === "running").map((issue) => issue.nodeId);
  const completed = Object.values(state.requests).filter((issue) => issue.state === "completed").length;
  const failed = Object.values(state.requests).filter((issue) => issue.state === "failed").length;
  const strategy = workflow.frontmatter.workspace?.strategy ?? "auto";
  return [
    `Workflow: ${config.workflowFile}`,
    `Tracker: ${workflow.frontmatter.tracker?.provider ?? "unspecified"}`,
    `Agent: ${workflow.frontmatter.agent?.provider ?? "unspecified"}${workflow.frontmatter.agent?.max_turns !== undefined ? ` (max_turns=${workflow.frontmatter.agent.max_turns})` : " (open-ended)"}`,
    `Project root: ${config.projectRoot}`,
    `Workspace strategy: ${strategy}`,
    `Pending execution requests: ${pendingIssues}`,
    `Running: ${running.length}${running.length ? ` (${running.join(", ")})` : ""}`,
    `Completed: ${completed}`,
    `Failed: ${failed}`,
    `Log file: ${config.logFile}`,
  ].join("\n");
}

async function runLoop(config: ServiceConfig): Promise<void> {
  const workflow = loadSymphonyWorkflow(config.workflowFile);
  const pollSeconds = workflow.frontmatter.tracker?.poll_interval_seconds ?? 30;
  appendLog(config, `service started poll=${pollSeconds}s project_root=${config.projectRoot}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await runOnce(config);
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  if (!config) {
    return;
  }

  if (config.command === "status") {
    console.log(serviceStatus(config));
    return;
  }

  if (config.command === "once") {
    await runOnce(config);
    console.log("Processed available issue files once.");
    return;
  }

  await runLoop(config);
}

export function resolveServiceConfig(argv: string[]): ServiceConfig | null {
  return parseArgs(argv);
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
