import * as fs from "node:fs";
import * as path from "node:path";

type Scalar = string | number | boolean | null;
type YamlValue = Scalar | YamlObject | YamlValue[];
type YamlObject = Record<string, YamlValue>;

export interface SymphonyWorkflowConfig {
  version: number;
  tracker?: {
    provider?: string;
    poll_interval_seconds?: number;
    issue_source?: string;
  };
  workspace?: {
    root_dir?: string;
    branch_prefix?: string;
    cleanup?: boolean;
    strategy?: string;
    base_ref?: string;
  };
  hooks?: {
    after_create?: string[];
    before_run?: string[];
    after_run?: string[];
    before_remove?: string[];
  };
  agent?: {
    provider?: string;
    max_turns?: number;
  };
  codex?: {
    model?: string;
    sandbox_mode?: string;
    approval_policy?: string;
    web_search?: boolean;
  };
  issue?: {
    prompt_context_file?: string;
    result_filename_template?: string;
  };
}

export interface LoadedSymphonyWorkflow {
  path: string;
  frontmatter: SymphonyWorkflowConfig;
  promptBody: string;
  rawFrontmatter: string;
}

interface ParseState {
  index: number;
  lines: string[];
}

function parseScalar(value: string): YamlValue {
  const trimmed = value.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed === "null") {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return inner.split(",").map((part) => parseScalar(part.trim()));
  }
  return trimmed;
}

function indentation(line: string): number {
  return line.length - line.trimStart().length;
}

function currentLine(state: ParseState): string | null {
  return state.index < state.lines.length ? state.lines[state.index] : null;
}

function parseBlock(state: ParseState, baseIndent: number): YamlValue {
  const line = currentLine(state);
  if (line === null) {
    return {};
  }
  if (line.trimStart().startsWith("- ")) {
    return parseArray(state, baseIndent);
  }
  return parseObject(state, baseIndent);
}

function parseArray(state: ParseState, baseIndent: number): YamlValue[] {
  const result: YamlValue[] = [];
  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      state.index += 1;
      continue;
    }
    const indent = indentation(line);
    if (indent < baseIndent || !line.trimStart().startsWith("- ")) {
      break;
    }

    const itemText = line.trimStart().slice(2).trim();
    state.index += 1;

    if (!itemText) {
      result.push(parseBlock(state, indent + 2));
      continue;
    }

    if (itemText.includes(":")) {
      const [firstKey, ...restParts] = itemText.split(":");
      const firstValue = restParts.join(":").trim();
      const inlineObject: YamlObject = {};
      inlineObject[firstKey.trim()] = firstValue ? parseScalar(firstValue) : null;

      const next = currentLine(state);
      if (next !== null && indentation(next) > indent) {
        const nested = parseObject(state, indent + 2);
        result.push({ ...inlineObject, ...nested });
      } else {
        result.push(inlineObject);
      }
      continue;
    }

    result.push(parseScalar(itemText));
  }
  return result;
}

function parseObject(state: ParseState, baseIndent: number): YamlObject {
  const result: YamlObject = {};
  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      state.index += 1;
      continue;
    }

    const indent = indentation(line);
    if (indent < baseIndent) {
      break;
    }
    if (indent > baseIndent) {
      throw new Error(`Unexpected indentation in workflow front matter near: ${trimmed}`);
    }
    if (line.trimStart().startsWith("- ")) {
      break;
    }

    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      throw new Error(`Expected key/value pair in workflow front matter near: ${trimmed}`);
    }

    const key = trimmed.slice(0, separator).trim();
    const inlineValue = trimmed.slice(separator + 1).trim();
    state.index += 1;

    if (inlineValue) {
      result[key] = parseScalar(inlineValue);
      continue;
    }

    const next = currentLine(state);
    if (next === null) {
      result[key] = null;
      continue;
    }

    const nextTrimmed = next.trim();
    if (!nextTrimmed || nextTrimmed.startsWith("#")) {
      result[key] = null;
      continue;
    }

    const nextIndent = indentation(next);
    if (nextIndent <= indent) {
      result[key] = null;
      continue;
    }

    result[key] = parseBlock(state, nextIndent);
  }
  return result;
}

function extractFrontmatterParts(source: string): { rawFrontmatter: string; body: string } {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error("Workflow file must start with YAML front matter delimited by ---");
  }
  const closingIndex = normalized.indexOf("\n---\n", 4);
  if (closingIndex === -1) {
    throw new Error("Workflow front matter is missing a closing --- delimiter");
  }
  const rawFrontmatter = normalized.slice(4, closingIndex);
  const body = normalized.slice(closingIndex + 5).trim();
  return { rawFrontmatter, body };
}

function asObject(value: YamlValue, label: string): YamlObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping in workflow front matter`);
  }
  return value as YamlObject;
}

function asStringArray(value: YamlValue | undefined, label: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a list of strings in workflow front matter`);
  }
  return value as string[];
}

function asOptionalString(value: YamlValue | undefined, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string in workflow front matter`);
  }
  return value;
}

function asOptionalNumber(value: YamlValue | undefined, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number") {
    throw new Error(`${label} must be a number in workflow front matter`);
  }
  return value;
}

function asOptionalBoolean(value: YamlValue | undefined, label: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean in workflow front matter`);
  }
  return value;
}

function normalizeFrontmatter(value: YamlObject): SymphonyWorkflowConfig {
  const version = asOptionalNumber(value.version, "version");
  if (version === undefined) {
    throw new Error("Workflow front matter must define numeric version");
  }

  const tracker = value.tracker ? asObject(value.tracker, "tracker") : undefined;
  const workspace = value.workspace ? asObject(value.workspace, "workspace") : undefined;
  const hooks = value.hooks ? asObject(value.hooks, "hooks") : undefined;
  const agent = value.agent ? asObject(value.agent, "agent") : undefined;
  const codex = value.codex ? asObject(value.codex, "codex") : undefined;
  const issue = value.issue ? asObject(value.issue, "issue") : undefined;

  return {
    version,
    tracker: tracker
      ? {
          provider: asOptionalString(tracker.provider, "tracker.provider"),
          poll_interval_seconds: asOptionalNumber(tracker.poll_interval_seconds, "tracker.poll_interval_seconds"),
          issue_source: asOptionalString(tracker.issue_source, "tracker.issue_source"),
        }
      : undefined,
    workspace: workspace
      ? {
          root_dir: asOptionalString(workspace.root_dir, "workspace.root_dir"),
          branch_prefix: asOptionalString(workspace.branch_prefix, "workspace.branch_prefix"),
          cleanup: asOptionalBoolean(workspace.cleanup, "workspace.cleanup"),
          strategy: asOptionalString(workspace.strategy, "workspace.strategy"),
          base_ref: asOptionalString(workspace.base_ref, "workspace.base_ref"),
        }
      : undefined,
    hooks: hooks
      ? {
          after_create: asStringArray(hooks.after_create, "hooks.after_create"),
          before_run: asStringArray(hooks.before_run, "hooks.before_run"),
          after_run: asStringArray(hooks.after_run, "hooks.after_run"),
          before_remove: asStringArray(hooks.before_remove, "hooks.before_remove"),
        }
      : undefined,
    agent: agent
      ? {
          provider: asOptionalString(agent.provider, "agent.provider"),
          max_turns: asOptionalNumber(agent.max_turns, "agent.max_turns"),
        }
      : undefined,
    codex: codex
      ? {
          model: asOptionalString(codex.model, "codex.model"),
          sandbox_mode: asOptionalString(codex.sandbox_mode, "codex.sandbox_mode"),
          approval_policy: asOptionalString(codex.approval_policy, "codex.approval_policy"),
          web_search: asOptionalBoolean(codex.web_search, "codex.web_search"),
        }
      : undefined,
    issue: issue
      ? {
          prompt_context_file: asOptionalString(issue.prompt_context_file, "issue.prompt_context_file"),
          result_filename_template: asOptionalString(issue.result_filename_template, "issue.result_filename_template"),
        }
      : undefined,
  };
}

export function parseSymphonyWorkflow(source: string, workflowPath = "<memory>"): LoadedSymphonyWorkflow {
  const { rawFrontmatter, body } = extractFrontmatterParts(source);
  const state: ParseState = {
    index: 0,
    lines: rawFrontmatter.split("\n"),
  };
  const parsed = parseObject(state, 0);
  const frontmatter = normalizeFrontmatter(parsed);
  return {
    path: workflowPath,
    frontmatter,
    promptBody: body,
    rawFrontmatter,
  };
}

export function loadSymphonyWorkflow(workflowPath: string): LoadedSymphonyWorkflow {
  const resolved = path.resolve(workflowPath);
  const source = fs.readFileSync(resolved, "utf8");
  return parseSymphonyWorkflow(source, resolved);
}

export function renderSymphonyPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, rawKey: string) => values[rawKey] ?? "");
}
