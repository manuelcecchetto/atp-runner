import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type NodeStatus = "LOCKED" | "READY" | "CLAIMED" | "COMPLETED" | "FAILED";

interface AtpMeta {
  project_name: string;
  version: string;
  project_status: "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";
}

interface AtpNode {
  title: string;
  instruction: string;
  context?: string;
  dependencies: string[];
  status: NodeStatus;
  reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  report?: string;
}

interface AtpGraph {
  meta: AtpMeta;
  nodes: Record<string, AtpNode>;
}

interface IntakeIssue {
  title: string;
  summary: string;
  context?: string;
  files?: string[];
  labels?: string[];
  requested_node_id?: string;
}

interface IntakeCandidate {
  nodeId: string;
  title: string;
  status: NodeStatus;
  score: number;
  reasons: string[];
}

type PlacementKind = "new_root" | "depends_on_existing" | "merge_node" | "separate_plan_candidate";

interface IntakeRecommendation {
  kind: PlacementKind;
  recommendedDependencies: string[];
  suggestedNodeId: string;
  suggestedTitle: string;
  suggestedInstruction: string;
  reasoningEffort: "low" | "medium" | "high";
  rationale: string[];
  candidates: IntakeCandidate[];
}

interface IntakeCliConfig {
  atpFile: string;
  issueFile?: string;
  title?: string;
  summary?: string;
  context?: string;
  files?: string[];
  labels?: string[];
  requestedNodeId?: string;
  dependenciesOverride?: string[];
  reasoningEffortOverride?: AtpNode["reasoning_effort"];
  force: boolean;
  format: "text" | "json";
  promptFile: string;
  command: "recommend" | "prompt" | "insert";
}

interface InsertSummary {
  nodeId: string;
  status: NodeStatus;
  dependencies: string[];
  recommendation: IntakeRecommendation;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROMPT_FILE = path.join(__dirname, "INTAKE.md");

function usage(): string {
  return `ATP Intake

Usage:
  tsx atp_intake.ts <recommend|prompt|insert> [options]

Options:
  --atp-file <path>       ATP plan path (default: ./.atp.json)
  --issue-file <path>     JSON file with { title, summary, context?, files?, labels? }
  --title <text>          Issue title
  --summary <text>        Issue summary
  --context <text>        Extra issue context
  --files <csv>           Comma-separated impacted files/modules
  --labels <csv>          Comma-separated issue labels
  --node-id <id>          Override suggested node id for insert
  --depends-on <csv>      Override inserted dependency ids for insert
  --reasoning-effort <v>  Override reasoning effort for insert
  --force                 Allow insert even for separate_plan_candidate recommendations
  --prompt-file <path>    Intake prompt template (default: INTAKE.md)
  --format <text|json>    Output format for recommend (default: text)
  --help                  Show this message
`;
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function ensureGraph(graph: unknown): asserts graph is AtpGraph {
  if (!graph || typeof graph !== "object") {
    throw new Error("ATP graph must be an object.");
  }
  const candidate = graph as Partial<AtpGraph>;
  if (!candidate.meta || !candidate.nodes) {
    throw new Error("ATP graph must contain meta and nodes.");
  }
}

function loadGraph(atpFile: string): AtpGraph {
  const graph = readJsonFile<unknown>(atpFile);
  ensureGraph(graph);
  return graph;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function csv(value: string | undefined): string[] {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function parseArgs(argv: string[]): IntakeCliConfig | null {
  let command: IntakeCliConfig["command"] | null = null;
  let atpFile = path.resolve(".atp.json");
  let issueFile: string | undefined;
  let title: string | undefined;
  let summary: string | undefined;
  let context: string | undefined;
  let files: string[] = [];
  let labels: string[] = [];
  let requestedNodeId: string | undefined;
  let dependenciesOverride: string[] | undefined;
  let reasoningEffortOverride: AtpNode["reasoning_effort"] | undefined;
  let force = false;
  let format: "text" | "json" = "text";
  let promptFile = DEFAULT_PROMPT_FILE;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      return null;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      if (!command) {
        if (arg !== "recommend" && arg !== "prompt" && arg !== "insert") {
          throw new Error(`Unknown command "${arg}". Expected recommend, prompt, or insert.`);
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
    } else if (arg === "--issue-file") {
      issueFile = path.resolve(next);
    } else if (arg === "--title") {
      title = next;
    } else if (arg === "--summary") {
      summary = next;
    } else if (arg === "--context") {
      context = next;
    } else if (arg === "--files") {
      files = csv(next);
    } else if (arg === "--labels") {
      labels = csv(next);
    } else if (arg === "--node-id") {
      requestedNodeId = next.trim();
    } else if (arg === "--depends-on") {
      dependenciesOverride = csv(next);
    } else if (arg === "--reasoning-effort") {
      if (!["minimal", "low", "medium", "high", "xhigh"].includes(next)) {
        throw new Error(`Unknown reasoning effort "${next}".`);
      }
      reasoningEffortOverride = next as AtpNode["reasoning_effort"];
    } else if (arg === "--format") {
      if (next !== "text" && next !== "json") {
        throw new Error(`Unknown format "${next}". Expected text or json.`);
      }
      format = next;
    } else if (arg === "--prompt-file") {
      promptFile = path.resolve(next);
    } else {
      throw new Error(`Unknown option "${arg}".`);
    }
    index += 1;
  }

  if (!command) {
    console.log(usage());
    return null;
  }

  return {
    atpFile,
    issueFile,
    title,
    summary,
    context,
    files,
    labels,
    requestedNodeId,
    dependenciesOverride,
    reasoningEffortOverride,
    force,
    format,
    promptFile,
    command,
  };
}

function normalizeIssue(config: IntakeCliConfig): IntakeIssue {
  if (config.issueFile) {
    const issue = readJsonFile<IntakeIssue>(config.issueFile);
    if (!issue.title || !issue.summary) {
      throw new Error("Issue file must include title and summary.");
    }
    return issue;
  }
  if (!config.title || !config.summary) {
    throw new Error("Provide --title and --summary, or use --issue-file.");
  }
  return {
    title: config.title,
    summary: config.summary,
    context: config.context,
    files: config.files,
    labels: config.labels,
    requested_node_id: config.requestedNodeId,
  };
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) {
    if (right.has(token)) {
      count += 1;
    }
  }
  return count;
}

function findChildren(nodes: Record<string, AtpNode>, nodeId: string): string[] {
  return Object.entries(nodes)
    .filter(([, node]) => node.dependencies.includes(nodeId))
    .map(([candidateId]) => candidateId);
}

function scoreCandidate(issue: IntakeIssue, nodeId: string, node: AtpNode): IntakeCandidate {
  const issueTokens = tokenize(`${issue.title} ${issue.summary} ${issue.context ?? ""} ${(issue.files ?? []).join(" ")} ${(issue.labels ?? []).join(" ")}`);
  const nodeTokens = tokenize(`${nodeId} ${node.title} ${node.instruction} ${node.context ?? ""} ${node.report ?? ""}`);
  const score = intersectionSize(issueTokens, nodeTokens);
  const reasons: string[] = [];

  if (score > 0) {
    reasons.push(`shared tokens=${score}`);
  }
  if ((issue.files ?? []).length > 0) {
    const fileHints = issue.files?.filter((fileHint) => node.instruction.includes(fileHint) || node.title.includes(fileHint) || (node.context ?? "").includes(fileHint)) ?? [];
    if (fileHints.length > 0) {
      reasons.push(`file overlap: ${fileHints.join(", ")}`);
    }
  }
  if ((issue.labels ?? []).some((label) => node.title.toLowerCase().includes(label.toLowerCase()))) {
    reasons.push("label overlap with node title");
  }

  return {
    nodeId,
    title: node.title,
    status: node.status,
    score,
    reasons,
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "new_issue";
}

function saveGraph(atpFile: string, graph: AtpGraph): void {
  writeJsonFile(atpFile, graph);
}

function dependenciesSatisfied(nodes: Record<string, AtpNode>, dependencies: string[]): boolean {
  return dependencies.every((dependencyId) => nodes[dependencyId]?.status === "COMPLETED");
}

function resolveInsertedDependencies(
  graph: AtpGraph,
  recommendation: IntakeRecommendation,
  config: IntakeCliConfig,
): string[] {
  const dependencies = config.dependenciesOverride ?? recommendation.recommendedDependencies;
  for (const dependencyId of dependencies) {
    if (!graph.nodes[dependencyId]) {
      throw new Error(`Cannot insert node: dependency ${dependencyId} does not exist in the ATP graph.`);
    }
  }
  return dependencies;
}

function choosePlacement(graph: AtpGraph, issue: IntakeIssue): IntakeRecommendation {
  const candidates = Object.entries(graph.nodes)
    .map(([nodeId, node]) => scoreCandidate(issue, nodeId, node))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId))
    .slice(0, 5);

  const suggestedNodeId = issue.requested_node_id ?? `N_${slugify(issue.title)}`;
  const reasoningEffort: IntakeRecommendation["reasoningEffort"] = (issue.summary.length + (issue.context?.length ?? 0)) > 320 ? "high" : "medium";
  const suggestedInstruction = [
    `Goal: ${issue.title}.`,
    `Issue summary: ${issue.summary}`,
    issue.context ? `Additional context: ${issue.context}` : "",
    (issue.files ?? []).length > 0 ? `Likely impacted files/modules: ${(issue.files ?? []).join(", ")}.` : "",
    "Verification: inspect the touched scope, implement the fix or change, and run the smallest relevant checks before completion.",
  ].filter(Boolean).join(" ");

  if (candidates.length === 0) {
    return {
      kind: "new_root",
      recommendedDependencies: [],
      suggestedNodeId,
      suggestedTitle: issue.title,
      suggestedInstruction,
      reasoningEffort,
      rationale: [
        "No existing node had meaningful lexical overlap with the new issue.",
        "Treating this as a new root avoids inventing dependencies without evidence.",
      ],
      candidates: [],
    };
  }

  const top = candidates[0];
  const topNode = graph.nodes[top.nodeId];
  const topChildren = findChildren(graph.nodes, top.nodeId);
  const activeStatuses = new Set<NodeStatus>(["READY", "CLAIMED", "LOCKED"]);

  if (activeStatuses.has(topNode.status) && top.score >= 3) {
    return {
      kind: "depends_on_existing",
      recommendedDependencies: [top.nodeId],
      suggestedNodeId,
      suggestedTitle: issue.title,
      suggestedInstruction,
      reasoningEffort,
      rationale: [
        `Top related node ${top.nodeId} is still active (${topNode.status}) and likely produces prerequisite context.`,
        `This issue appears adjacent to existing in-flight work: ${top.reasons.join("; ") || "high lexical overlap"}.`,
      ],
      candidates,
    };
  }

  if (topChildren.length >= 2 && top.score >= 2) {
    return {
      kind: "merge_node",
      recommendedDependencies: [top.nodeId, ...topChildren.slice(0, 2)],
      suggestedNodeId,
      suggestedTitle: issue.title,
      suggestedInstruction,
      reasoningEffort: "high",
      rationale: [
        `Top related node ${top.nodeId} fans out into multiple downstream nodes (${topChildren.join(", ")}).`,
        "The new issue may need synthesis across an existing branch point rather than a standalone root.",
      ],
      candidates,
    };
  }

  if (top.score === 1 && candidates.length === 1 && (issue.labels ?? []).includes("bug")) {
    return {
      kind: "new_root",
      recommendedDependencies: [],
      suggestedNodeId,
      suggestedTitle: issue.title,
      suggestedInstruction,
      reasoningEffort: "low",
      rationale: [
        `Only weak overlap with ${top.nodeId}; this looks more like a standalone bug than a dependent continuation.`,
      ],
      candidates,
    };
  }

  if (candidates.length >= 4 && candidates[0].score - candidates[candidates.length - 1].score <= 1) {
    return {
      kind: "separate_plan_candidate",
      recommendedDependencies: [],
      suggestedNodeId,
      suggestedTitle: issue.title,
      suggestedInstruction,
      reasoningEffort,
      rationale: [
        "The issue overlaps several unrelated nodes without a clear anchor point.",
        "That usually means the workstream may belong in a separate ATP plan or needs manual triage before insertion.",
      ],
      candidates,
    };
  }

  return {
    kind: "depends_on_existing",
    recommendedDependencies: [top.nodeId],
    suggestedNodeId,
    suggestedTitle: issue.title,
    suggestedInstruction,
    reasoningEffort,
    rationale: [
      `The strongest placement anchor is ${top.nodeId}.`,
      top.reasons.length > 0 ? top.reasons.join("; ") : "Lexical overlap suggests this node is the nearest prerequisite.",
    ],
    candidates,
  };
}

function renderRecommendationText(recommendation: IntakeRecommendation): string {
  const lines = [
    `Placement: ${recommendation.kind}`,
    `Suggested node id: ${recommendation.suggestedNodeId}`,
    `Suggested title: ${recommendation.suggestedTitle}`,
    `Reasoning effort: ${recommendation.reasoningEffort}`,
    `Recommended dependencies: ${recommendation.recommendedDependencies.length ? recommendation.recommendedDependencies.join(", ") : "(none)"}`,
    "",
    "Rationale:",
    ...recommendation.rationale.map((line) => `- ${line}`),
    "",
    "Suggested instruction:",
    recommendation.suggestedInstruction,
  ];

  if (recommendation.candidates.length > 0) {
    lines.push("", "Related nodes:");
    for (const candidate of recommendation.candidates) {
      lines.push(`- ${candidate.nodeId} [${candidate.status}] score=${candidate.score}: ${candidate.title}`);
    }
  }

  return lines.join("\n");
}

function renderIntakePrompt(template: string, graph: AtpGraph, issue: IntakeIssue, recommendation: IntakeRecommendation): string {
  const replacements: Record<string, string> = {
    PROJECT_NAME: graph.meta.project_name,
    ATP_FILE: "",
    ISSUE_TITLE: issue.title,
    ISSUE_SUMMARY: issue.summary,
    ISSUE_CONTEXT: issue.context ?? "",
    ISSUE_FILES: (issue.files ?? []).join(", "),
    ISSUE_LABELS: (issue.labels ?? []).join(", "),
    RECOMMENDED_KIND: recommendation.kind,
    RECOMMENDED_DEPENDENCIES: recommendation.recommendedDependencies.join(", "),
    RECOMMENDED_NODE_ID: recommendation.suggestedNodeId,
    RECOMMENDED_TITLE: recommendation.suggestedTitle,
    RECOMMENDED_INSTRUCTION: recommendation.suggestedInstruction,
    CANDIDATE_SUMMARY: recommendation.candidates
      .map((candidate) => `${candidate.nodeId} [${candidate.status}] score=${candidate.score}: ${candidate.title}`)
      .join("\n"),
  };

  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key: string) => replacements[key] ?? "");
}

export function recommendPlacement(graph: AtpGraph, issue: IntakeIssue): IntakeRecommendation {
  return choosePlacement(graph, issue);
}

export function insertIssueIntoGraph(graph: AtpGraph, issue: IntakeIssue, config: Partial<IntakeCliConfig> = {}): InsertSummary {
  const recommendation = choosePlacement(graph, issue);
  if (recommendation.kind === "separate_plan_candidate" && !config.force) {
    throw new Error(
      "Insertion refused: intake classified this as separate_plan_candidate. Re-run with --force after manual review if you still want it in this ATP graph.",
    );
  }

  const nodeId = (config.requestedNodeId ?? issue.requested_node_id ?? recommendation.suggestedNodeId).trim();
  if (!nodeId) {
    throw new Error("Cannot insert node: resolved node id is empty.");
  }
  if (graph.nodes[nodeId]) {
    throw new Error(`Cannot insert node: ${nodeId} already exists in the ATP graph.`);
  }

  const dependencies = resolveInsertedDependencies(graph, recommendation, {
    atpFile: "",
    format: "text",
    promptFile: DEFAULT_PROMPT_FILE,
    command: "insert",
    files: [],
    labels: [],
    force: false,
    ...config,
  });
  const status: NodeStatus = dependencies.length === 0 || dependenciesSatisfied(graph.nodes, dependencies) ? "READY" : "LOCKED";
  const reasoningEffort = config.reasoningEffortOverride ?? recommendation.reasoningEffort;

  graph.nodes[nodeId] = {
    title: recommendation.suggestedTitle,
    instruction: recommendation.suggestedInstruction,
    context: issue.context,
    dependencies,
    status,
    reasoning_effort: reasoningEffort,
  };

  return {
    nodeId,
    status,
    dependencies,
    recommendation,
  };
}

export function resolveIntakeConfig(argv: string[]): IntakeCliConfig | null {
  return parseArgs(argv);
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  if (!config) {
    return;
  }

  const graph = loadGraph(config.atpFile);
  const issue = normalizeIssue(config);
  const recommendation = choosePlacement(graph, issue);

  if (config.command === "prompt") {
    const template = fs.readFileSync(config.promptFile, "utf8");
    console.log(renderIntakePrompt(template, graph, issue, recommendation));
    return;
  }

  if (config.command === "insert") {
    const summary = insertIssueIntoGraph(graph, issue, config);
    saveGraph(config.atpFile, graph);
    if (config.format === "json") {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log([
      `Inserted node: ${summary.nodeId}`,
      `Status: ${summary.status}`,
      `Dependencies: ${summary.dependencies.length ? summary.dependencies.join(", ") : "(none)"}`,
      "",
      renderRecommendationText(summary.recommendation),
    ].join("\n"));
    return;
  }

  if (config.format === "json") {
    console.log(JSON.stringify(recommendation, null, 2));
    return;
  }

  console.log(renderRecommendationText(recommendation));
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
