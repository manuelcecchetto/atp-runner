import { Codex, type ModelReasoningEffort, type SandboxMode, type WebSearchMode } from "@openai/codex-sdk";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { execFileSync, spawn } from "child_process";
import { stripVTControlCharacters } from "util";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROMPT_FILE = path.join(__dirname, "RUNNER.md");

const STOP_NO_TASKS = "NO_TASKS_AVAILABLE";
const STOP_PROJECT_INACTIVE = "Project is not ACTIVE";
const TASK_ASSIGNED_MARKER = "TASK ASSIGNED:";

const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";

const ALLOWED_REASONING_EFFORTS: ReadonlySet<ModelReasoningEffort> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const ALLOWED_SANDBOX_MODES: ReadonlySet<SandboxMode> = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
const ALLOWED_WEB_SEARCH_MODES: ReadonlySet<WebSearchMode> = new Set(["disabled", "cached", "live"]);
const ALLOWED_AGENT_PROVIDERS = new Set(["codex", "claude"] as const);
type AgentProvider = "codex" | "claude";

type WorkerOutcomeKind = "ACTIVITY" | "NO_TASKS_AVAILABLE" | "PROJECT_INACTIVE" | "ERROR";
type WorkerPhase = "QUEUED" | "RUNNING" | "FINISHED";
type LogLevel = "info" | "warn" | "error" | "success";

type RoundSummary = Record<WorkerOutcomeKind, number>;

interface WorkerOutcome {
  kind: WorkerOutcomeKind;
  workerId: string;
  details?: string;
}

interface WorkerRuntime {
  workerId: string;
  workerNumber: number;
  workingDirectory: string;
  branchName: string;
  hasPreCommit: boolean;
  hasRuff: boolean;
}

interface WorkerState {
  workerId: string;
  phase: WorkerPhase;
  progress: number;
  detail: string;
  events: number;
  startedAt: number;
  endedAt?: number;
  outcome?: WorkerOutcomeKind;
  usageInputTokens?: number;
  usageCachedInputTokens?: number;
  usageOutputTokens?: number;
}

interface DashboardLog {
  timestamp: number;
  level: LogLevel;
  workerId?: string;
  message: string;
}

interface TokenTotals {
  input: number;
  cachedInput: number;
  output: number;
}

interface WorkerEventOptions {
  bump?: number;
  minProgress?: number;
  logEvent?: boolean;
  logLevel?: LogLevel;
}

interface RunnerConfig {
  projectRoot: string;
  atpFile: string;
  promptFile: string;
  projectRootExplicit: boolean;
  atpFileExplicit: boolean;
  agentProvider: AgentProvider;
  modelExplicit: boolean;
  providerExplicit: boolean;
  workersExplicit: boolean;
  commitPerNodeExplicit: boolean;
  reasoningExplicit: boolean;
  sandboxExplicit: boolean;
  workers: number;
  commitPerNode: boolean;
  webSearchMode: WebSearchMode;
  workerTimeoutMs: number;
  pollIntervalMs: number;
  maxIdleRounds: number;
  maxErrorRounds: number;
  agentPrefix: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  sandboxMode: SandboxMode;
  tuiEnabled: boolean;
  onboardingEnabled: boolean;
  claudeBinary: string;
}

type CliArgs = Record<string, string | boolean>;
type ArrowMenuOption<T> = { label: string; value: T; description?: string };
interface OnboardingFrameMeta {
  stepLabels: readonly string[];
  stepIndex: number;
}
type PromptNavigation<T> =
  | { kind: "value"; value: T }
  | { kind: "back" }
  | { kind: "cancel" };

const ONBOARDING_STEP_LABELS = [
  "Workspace",
  "Plan",
  "Provider",
  "Model",
  "Reasoning",
  "Sandbox",
  "Commit",
  "Workers",
  "Confirm",
] as const;

interface SignalState {
  sawNoTasks: boolean;
  sawProjectInactive: boolean;
  sawTaskAssignment: boolean;
  sawTaskMutation: boolean;
  sawFileChange: boolean;
  assignedNodeId: string | null;
  assignedTitle: string | null;
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  orange: "\x1b[38;5;208m",
  orangeSoft: "\x1b[38;5;214m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
} as const;

function createEmptySummary(): RoundSummary {
  return {
    ACTIVITY: 0,
    NO_TASKS_AVAILABLE: 0,
    PROJECT_INACTIVE: 0,
    ERROR: 0,
  };
}

class RunnerDashboard {
  private readonly live: boolean;
  private readonly useColor: boolean;
  private readonly workerIds: string[];
  private readonly workers = new Map<string, WorkerState>();
  private readonly spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private readonly logs: DashboardLog[] = [];

  private startedAt = Date.now();
  private round = 0;
  private roundStartedAt = Date.now();
  private idleRounds = 0;
  private errorRounds = 0;
  private spinnerTick = 0;
  private renderTimer: NodeJS.Timeout | undefined;
  private lastRenderAt = 0;
  private stopped = false;

  private lastSummary: RoundSummary = createEmptySummary();
  private totals: RoundSummary = createEmptySummary();
  private tokenTotals: TokenTotals = { input: 0, cachedInput: 0, output: 0 };
  private roundTokenTotals: TokenTotals = { input: 0, cachedInput: 0, output: 0 };

  constructor(private readonly config: RunnerConfig) {
    this.live = config.tuiEnabled && Boolean(process.stdout.isTTY);
    const supportsColor = typeof process.stdout.hasColors === "function" ? process.stdout.hasColors() : true;
    this.useColor = this.live && supportsColor && !Object.prototype.hasOwnProperty.call(process.env, "NO_COLOR");
    this.workerIds = Array.from({ length: config.workers }, (_, index) => `${config.agentPrefix}_${index + 1}`);

    const now = Date.now();
    this.workerIds.forEach((workerId) => {
      this.workers.set(workerId, {
        workerId,
        phase: "QUEUED",
        progress: 0,
        detail: "Waiting for next round",
        events: 0,
        startedAt: now,
        usageInputTokens: 0,
        usageCachedInputTokens: 0,
        usageOutputTokens: 0,
      });
    });
  }

  start(): void {
    this.startedAt = Date.now();
    if (!this.live) {
      console.log("Starting ATP Task Runner...");
      return;
    }

    process.stdout.write(CURSOR_HIDE);
    this.render(true);
    this.renderTimer = setInterval(() => {
      this.render();
    }, 110);
    process.stdout.on("resize", this.handleResize);
  }

  stop(message?: string): void {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    if (message) {
      this.pushLog(message, "info");
    }

    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = undefined;
    }

    if (this.live) {
      process.stdout.off("resize", this.handleResize);
      this.render(true);
      process.stdout.write(`\n${CURSOR_SHOW}`);
      return;
    }
  }

  logRunner(message: string, level: LogLevel = "info"): void {
    this.pushLog(message, level);
    this.render();
  }

  beginRound(round: number, idleRounds: number, errorRounds: number): void {
    this.round = round;
    this.roundStartedAt = Date.now();
    this.idleRounds = idleRounds;
    this.errorRounds = errorRounds;

    const now = Date.now();
    this.roundTokenTotals = { input: 0, cachedInput: 0, output: 0 };
    this.workerIds.forEach((workerId) => {
      this.workers.set(workerId, {
        workerId,
        phase: "QUEUED",
        progress: 2,
        detail: "Queued",
        events: 0,
        startedAt: now,
        usageInputTokens: 0,
        usageCachedInputTokens: 0,
        usageOutputTokens: 0,
      });
    });

    this.pushLog(`Round ${round} started with ${this.config.workers} workers.`, "info");
    this.render(true);
  }

  markWorkerStarted(workerId: string, detail: string): void {
    const state = this.ensureWorker(workerId);
    state.phase = "RUNNING";
    state.progress = Math.max(state.progress, 8);
    state.startedAt = Date.now();
    state.detail = detail;
    this.pushLog(detail, "info", workerId);
    this.render();
  }

  markWorkerEvent(workerId: string, detail: string, options: WorkerEventOptions = {}): void {
    const state = this.ensureWorker(workerId);

    if (state.phase !== "RUNNING") {
      state.phase = "RUNNING";
      state.startedAt = Date.now();
    }

    state.events += 1;
    const bump = options.bump ?? 3;
    const minProgress = options.minProgress ?? 0;
    state.progress = Math.min(95, Math.max(state.progress + bump, minProgress));
    state.detail = detail;

    if (options.logEvent) {
      this.pushLog(detail, options.logLevel ?? "info", workerId);
    }

    this.render();
  }

  markWorkerOutcome(outcome: WorkerOutcome): void {
    const state = this.ensureWorker(outcome.workerId);
    state.phase = "FINISHED";
    state.progress = 100;
    state.endedAt = Date.now();
    state.outcome = outcome.kind;

    if (outcome.details) {
      state.detail = outcome.details;
    } else {
      state.detail = this.outcomeMessage(outcome.kind);
    }

    const level: LogLevel =
      outcome.kind === "ERROR"
        ? "error"
        : outcome.kind === "ACTIVITY"
          ? "success"
          : outcome.kind === "NO_TASKS_AVAILABLE"
            ? "warn"
            : "warn";

    this.pushLog(`${this.outcomeLabel(outcome.kind)} - ${state.detail}`, level, outcome.workerId);
    this.render(true);
  }

  markWorkerUsage(
    workerId: string,
    usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number },
  ): void {
    const state = this.ensureWorker(workerId);
    state.usageInputTokens = usage.input_tokens;
    state.usageCachedInputTokens = usage.cached_input_tokens;
    state.usageOutputTokens = usage.output_tokens;

    this.roundTokenTotals.input += usage.input_tokens;
    this.roundTokenTotals.cachedInput += usage.cached_input_tokens;
    this.roundTokenTotals.output += usage.output_tokens;

    this.tokenTotals.input += usage.input_tokens;
    this.tokenTotals.cachedInput += usage.cached_input_tokens;
    this.tokenTotals.output += usage.output_tokens;

    this.render();
  }

  finishRound(summary: RoundSummary, idleRounds: number, errorRounds: number): void {
    this.lastSummary = summary;
    this.idleRounds = idleRounds;
    this.errorRounds = errorRounds;

    this.totals.ACTIVITY += summary.ACTIVITY;
    this.totals.NO_TASKS_AVAILABLE += summary.NO_TASKS_AVAILABLE;
    this.totals.PROJECT_INACTIVE += summary.PROJECT_INACTIVE;
    this.totals.ERROR += summary.ERROR;

    this.pushLog(
      `Round ${this.round} summary: activity=${summary.ACTIVITY}, no_tasks=${summary.NO_TASKS_AVAILABLE}, inactive=${summary.PROJECT_INACTIVE}, errors=${summary.ERROR}`,
      summary.ERROR > 0 ? "warn" : "info",
    );
    this.render(true);
  }

  private handleResize = (): void => {
    this.render(true);
  };

  private ensureWorker(workerId: string): WorkerState {
    const existing = this.workers.get(workerId);
    if (existing) {
      return existing;
    }

    const created: WorkerState = {
      workerId,
      phase: "QUEUED",
      progress: 0,
      detail: "Queued",
      events: 0,
      startedAt: Date.now(),
    };
    this.workers.set(workerId, created);
    return created;
  }

  private pushLog(message: string, level: LogLevel, workerId?: string): void {
    const entry: DashboardLog = {
      timestamp: Date.now(),
      level,
      workerId,
      message,
    };

    this.logs.push(entry);
    if (this.logs.length > 40) {
      this.logs.splice(0, this.logs.length - 40);
    }

    if (!this.live) {
      const label = workerId ? `[${workerId}] ` : "";
      console.log(`${label}${message}`);
    }
  }

  private render(force = false): void {
    if (!this.live || this.stopped) {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastRenderAt < 70) {
      return;
    }

    this.lastRenderAt = now;
    this.spinnerTick += 1;

    const lines = this.composeLines(now, process.stdout.columns ?? 120, process.stdout.rows ?? 44);
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
    process.stdout.write(lines.join("\n"));
  }

  private composeLines(now: number, columns: number, rows: number): string[] {
    const width = Math.max(90, columns);
    const lines: string[] = [];
    const completedWorkers = this.workerIds.reduce((count, workerId) => {
      const state = this.ensureWorker(workerId);
      return state.phase === "FINISHED" ? count + 1 : count;
    }, 0);

    const barWidth = Math.max(16, Math.min(34, Math.floor(width * 0.25)));
    const idleBarWidth = Math.max(8, Math.min(20, Math.floor(width * 0.15)));

    const titleSpinner = this.spinnerFrames[this.spinnerTick % this.spinnerFrames.length];
    const title = `${this.paint("ATP Runner", ANSI.bold, ANSI.cyan)} ${this.paint(titleSpinner, ANSI.cyan)} ${this.paint("LIVE", ANSI.green, ANSI.bold)}`;
    lines.push(this.clip(title, width));

    const projectInfo = `${this.paint("Project", ANSI.dim)} ${this.shortenPath(this.config.projectRoot, 38)}  ${this.paint("Plan", ANSI.dim)} ${this.shortenPath(this.config.atpFile, 32)}`;
    lines.push(this.clip(projectInfo, width));

    const modelInfo =
      this.config.agentProvider === "codex"
        ? `${this.config.model} (${this.config.reasoningEffort})`
        : this.config.model;
    const executionInfo =
      this.config.agentProvider === "codex"
        ? `${this.paint("Sandbox", ANSI.dim)} ${this.config.sandboxMode}`
        : `${this.paint("Permissions", ANSI.dim)} bypass`;
    const runtimeInfo = `${this.paint("Agent", ANSI.dim)} ${this.config.agentProvider}  ${this.paint("Model", ANSI.dim)} ${modelInfo}  ${executionInfo}  ${this.paint("Workers", ANSI.dim)} ${this.config.workers}  ${this.paint("Uptime", ANSI.dim)} ${formatDuration(now - this.startedAt)}`;
    lines.push(this.clip(runtimeInfo, width));

    const roundInfo = `${this.paint("Round", ANSI.dim)} ${this.round} (${formatDuration(now - this.roundStartedAt)})  ${this.paint("Poll", ANSI.dim)} ${this.config.pollIntervalMs}ms`;
    lines.push(this.clip(roundInfo, width));

    const tokenInfo = `${this.paint("Tokens", ANSI.dim)} round ${formatTokens(this.roundTokenTotals)}  total ${formatTokens(this.tokenTotals)}`;
    lines.push(this.clip(tokenInfo, width));
    lines.push(this.paint("─".repeat(Math.max(1, width - 1)), ANSI.gray));

    const roundBar = this.colorizeBar(completedWorkers, this.config.workers, barWidth, ANSI.cyan);
    const roundPct = `${Math.round((completedWorkers / Math.max(1, this.config.workers)) * 100)}%`.padStart(4, " ");
    lines.push(this.clip(`${this.paint("Round Progress", ANSI.bold)} ${roundBar} ${roundPct}  ${completedWorkers}/${this.config.workers}`, width));

    const idleBar = this.colorizeBar(this.idleRounds, this.config.maxIdleRounds, idleBarWidth, ANSI.yellow);
    const errorBar = this.colorizeBar(this.errorRounds, this.config.maxErrorRounds, idleBarWidth, ANSI.red);
    lines.push(
      this.clip(
        `${this.paint("Idle Guard", ANSI.bold)} ${idleBar} ${this.idleRounds}/${this.config.maxIdleRounds}   ${this.paint("Error Guard", ANSI.bold)} ${errorBar} ${this.errorRounds}/${this.config.maxErrorRounds}`,
        width,
      ),
    );

    const totals = `Totals: ${this.paint("activity", ANSI.green)}=${this.totals.ACTIVITY}  ${this.paint("no_tasks", ANSI.yellow)}=${this.totals.NO_TASKS_AVAILABLE}  ${this.paint("inactive", ANSI.magenta)}=${this.totals.PROJECT_INACTIVE}  ${this.paint("errors", ANSI.red)}=${this.totals.ERROR}`;
    lines.push(this.clip(totals, width));

    lines.push("");
    lines.push(this.paint("Workers", ANSI.bold, ANSI.blue));

    const detailWidth = Math.max(18, width - 62);
    this.workerIds.forEach((workerId, index) => {
      const state = this.ensureWorker(workerId);
      const elapsed =
        state.phase === "FINISHED" && state.endedAt
          ? state.endedAt - state.startedAt
          : now - state.startedAt;

      const symbol = this.workerSymbol(state, index);
      const status = this.workerStatus(state);
      const bar = this.workerBar(state);
      const detail = truncatePlain(state.detail, detailWidth);
      const usageSuffix =
        (state.usageInputTokens ?? 0) + (state.usageOutputTokens ?? 0) > 0
          ? this.paint(
              ` in:${formatTokenCount(state.usageInputTokens ?? 0)} out:${formatTokenCount(state.usageOutputTokens ?? 0)}`,
              ANSI.dim,
            )
          : "";
      const line = `${symbol} ${padRight(workerId, 16)} ${padRight(status, 10)} ${bar} ${`${state.progress}%`.padStart(4, " ")} ${padRight(formatDuration(elapsed), 8)} ${detail}${usageSuffix}`;
      lines.push(this.clip(line, width));
    });

    lines.push("");
    lines.push(this.paint("Recent Events", ANSI.bold, ANSI.blue));

    const logRows = Math.max(4, Math.min(10, rows - (this.config.workers + 15)));
    const visibleLogs = this.logs.slice(-logRows);
    if (visibleLogs.length === 0) {
      lines.push(this.paint("  (no events yet)", ANSI.dim));
    } else {
      visibleLogs.forEach((entry) => {
        const stamp = formatClock(entry.timestamp);
        const levelColor =
          entry.level === "error"
            ? ANSI.red
            : entry.level === "warn"
              ? ANSI.yellow
              : entry.level === "success"
                ? ANSI.green
                : ANSI.gray;
        const worker = entry.workerId ? `${entry.workerId}: ` : "";
        const message = `${this.paint(stamp, ANSI.gray)} ${this.paint("●", levelColor)} ${worker}${entry.message}`;
        lines.push(this.clip(message, width));
      });
    }

    const footer = this.paint(
      `Last round: activity=${this.lastSummary.ACTIVITY}, no_tasks=${this.lastSummary.NO_TASKS_AVAILABLE}, inactive=${this.lastSummary.PROJECT_INACTIVE}, errors=${this.lastSummary.ERROR}`,
      ANSI.dim,
    );
    lines.push("");
    lines.push(this.clip(footer, width));

    return lines;
  }

  private paint(text: string, ...codes: string[]): string {
    if (!this.useColor) {
      return text;
    }
    return `${codes.join("")}${text}${ANSI.reset}`;
  }

  private clip(text: string, width: number): string {
    const plain = stripVTControlCharacters(text);
    if (plain.length <= width) {
      return text;
    }
    return `${plain.slice(0, Math.max(0, width - 1))}…`;
  }

  private shortenPath(value: string, maxLen: number): string {
    if (value.length <= maxLen) {
      return value;
    }
    const suffix = value.slice(-(maxLen - 1));
    return `…${suffix}`;
  }

  private colorizeBar(value: number, total: number, width: number, colorCode: string): string {
    const ratio = clamp(value / Math.max(1, total), 0, 1);
    const filled = Math.round(width * ratio);
    const empty = Math.max(0, width - filled);
    const filledPart = this.paint("█".repeat(filled), colorCode, ANSI.bold);
    const emptyPart = this.paint("░".repeat(empty), ANSI.gray);
    return `[${filledPart}${emptyPart}]`;
  }

  private workerBar(state: WorkerState): string {
    const color =
      state.outcome === "ERROR"
        ? ANSI.red
        : state.outcome === "ACTIVITY"
          ? ANSI.green
          : state.outcome === "NO_TASKS_AVAILABLE"
            ? ANSI.yellow
            : state.outcome === "PROJECT_INACTIVE"
              ? ANSI.magenta
              : state.phase === "RUNNING"
                ? ANSI.cyan
                : ANSI.gray;

    return this.colorizeBar(state.progress, 100, 14, color);
  }

  private workerSymbol(state: WorkerState, index: number): string {
    if (state.phase === "RUNNING") {
      const frame = this.spinnerFrames[(this.spinnerTick + index) % this.spinnerFrames.length];
      return this.paint(frame, ANSI.cyan, ANSI.bold);
    }

    if (state.phase === "QUEUED") {
      return this.paint("◌", ANSI.gray);
    }

    if (state.outcome === "ACTIVITY") {
      return this.paint("✔", ANSI.green, ANSI.bold);
    }
    if (state.outcome === "NO_TASKS_AVAILABLE") {
      return this.paint("⏸", ANSI.yellow, ANSI.bold);
    }
    if (state.outcome === "PROJECT_INACTIVE") {
      return this.paint("⛔", ANSI.magenta, ANSI.bold);
    }
    return this.paint("✖", ANSI.red, ANSI.bold);
  }

  private workerStatus(state: WorkerState): string {
    if (state.phase === "RUNNING") {
      return this.paint("RUNNING", ANSI.cyan, ANSI.bold);
    }
    if (state.phase === "QUEUED") {
      return this.paint("QUEUED", ANSI.gray);
    }

    if (state.outcome === "ACTIVITY") {
      return this.paint("ACTIVITY", ANSI.green, ANSI.bold);
    }
    if (state.outcome === "NO_TASKS_AVAILABLE") {
      return this.paint("NO_TASKS", ANSI.yellow, ANSI.bold);
    }
    if (state.outcome === "PROJECT_INACTIVE") {
      return this.paint("INACTIVE", ANSI.magenta, ANSI.bold);
    }
    return this.paint("ERROR", ANSI.red, ANSI.bold);
  }

  private outcomeLabel(kind: WorkerOutcomeKind): string {
    if (kind === "ACTIVITY") {
      return "ACTIVITY";
    }
    if (kind === "NO_TASKS_AVAILABLE") {
      return "NO_TASKS_AVAILABLE";
    }
    if (kind === "PROJECT_INACTIVE") {
      return "PROJECT_INACTIVE";
    }
    return "ERROR";
  }

  private outcomeMessage(kind: WorkerOutcomeKind): string {
    if (kind === "ACTIVITY") {
      return "Worker completed useful task activity.";
    }
    if (kind === "NO_TASKS_AVAILABLE") {
      return "No claimable tasks were available.";
    }
    if (kind === "PROJECT_INACTIVE") {
      return "Project reported as not ACTIVE.";
    }
    return "Worker failed while executing its turn.";
  }
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument "${token}". Use --help for usage.`);
    }

    if (token === "--help") {
      args.help = true;
      continue;
    }

    const eqIndex = token.indexOf("=");
    if (eqIndex >= 0) {
      const key = token.slice(2, eqIndex);
      const value = token.slice(eqIndex + 1);
      args[key] = value;
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return args;
}

function parseBoolean(raw: string, key: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Expected a boolean value for ${key}, got "${raw}".`);
}

function readStringOption(args: CliArgs, key: string, envKey: string, fallback: string): string {
  const cliValue = args[key];
  if (typeof cliValue === "string") {
    return cliValue.trim();
  }
  if (cliValue === true) {
    throw new Error(`Missing value for --${key}`);
  }

  const envValue = process.env[envKey];
  if (typeof envValue === "string" && envValue.trim().length > 0) {
    return envValue.trim();
  }

  return fallback;
}

function readPositiveIntOption(args: CliArgs, key: string, envKey: string, fallback: number): number {
  const fromCli = args[key];
  const raw =
    typeof fromCli === "string"
      ? fromCli
      : fromCli === true
        ? ""
        : process.env[envKey] ?? `${fallback}`;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer for --${key} (or ${envKey}), got "${raw}".`);
  }
  return parsed;
}

function readBooleanOption(args: CliArgs, key: string, envKey: string, fallback: boolean): boolean {
  const fromCli = args[key];
  if (fromCli === true) {
    return true;
  }
  if (typeof fromCli === "string") {
    return parseBoolean(fromCli, `--${key}`);
  }

  const fromEnv = process.env[envKey];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return parseBoolean(fromEnv, envKey);
  }

  return fallback;
}

function readReasoningEffort(args: CliArgs): ModelReasoningEffort {
  const effort = readStringOption(args, "reasoning-effort", "ATP_RUNNER_REASONING_EFFORT", "high");
  if (!ALLOWED_REASONING_EFFORTS.has(effort as ModelReasoningEffort)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Allowed: ${Array.from(ALLOWED_REASONING_EFFORTS).join(", ")}.`,
    );
  }
  return effort as ModelReasoningEffort;
}

function readSandboxMode(args: CliArgs): SandboxMode {
  const mode = readStringOption(args, "sandbox-mode", "ATP_RUNNER_SANDBOX_MODE", "workspace-write");
  if (!ALLOWED_SANDBOX_MODES.has(mode as SandboxMode)) {
    throw new Error(
      `Unsupported sandbox mode "${mode}". Allowed: ${Array.from(ALLOWED_SANDBOX_MODES).join(", ")}.`,
    );
  }
  return mode as SandboxMode;
}

function readWebSearchMode(args: CliArgs): WebSearchMode {
  const mode = readStringOption(args, "web-search-mode", "ATP_RUNNER_WEB_SEARCH_MODE", "live");
  if (!ALLOWED_WEB_SEARCH_MODES.has(mode as WebSearchMode)) {
    throw new Error(`Unsupported web search mode "${mode}". Allowed: disabled, cached, live.`);
  }
  return mode as WebSearchMode;
}

function hasExplicitOption(args: CliArgs, key: string, envKey: string): boolean {
  const fromCli = args[key];
  if (typeof fromCli === "string" || fromCli === true) {
    return true;
  }
  const fromEnv = process.env[envKey];
  return typeof fromEnv === "string" && fromEnv.trim().length > 0;
}

function readAgentProvider(args: CliArgs): AgentProvider {
  const provider = readStringOption(args, "agent-provider", "ATP_RUNNER_AGENT_PROVIDER", "codex");
  if (!ALLOWED_AGENT_PROVIDERS.has(provider as AgentProvider)) {
    throw new Error(`Unsupported agent provider "${provider}". Allowed: codex, claude.`);
  }
  return provider as AgentProvider;
}

export function resolveConfig(argv: string[]): RunnerConfig | null {
  const args = parseCliArgs(argv);
  if (args.help) {
    printHelp();
    return null;
  }

  const projectRoot = path.resolve(readStringOption(args, "project-root", "ATP_PROJECT_ROOT", process.cwd()));
  const projectRootExplicit = hasExplicitOption(args, "project-root", "ATP_PROJECT_ROOT");
  const atpFile = path.resolve(
    readStringOption(args, "atp-file", "ATP_FILE", path.join(projectRoot, ".atp.json")),
  );
  const atpFileExplicit = hasExplicitOption(args, "atp-file", "ATP_FILE");
  const promptFile = path.resolve(readStringOption(args, "prompt-file", "ATP_RUNNER_PROMPT", DEFAULT_PROMPT_FILE));

  const workers = readPositiveIntOption(args, "workers", "ATP_RUNNER_WORKERS", 1);
  const commitPerNode = readBooleanOption(args, "commit-per-node", "ATP_RUNNER_COMMIT_PER_NODE", true);
  const webSearchMode = readWebSearchMode(args);
  const workerTimeoutMs = readPositiveIntOption(args, "worker-timeout-ms", "ATP_RUNNER_WORKER_TIMEOUT_MS", 9000000);
  const pollIntervalMs = readPositiveIntOption(args, "poll-ms", "ATP_RUNNER_POLL_MS", 2000);
  const maxIdleRounds = readPositiveIntOption(args, "max-idle-rounds", "ATP_RUNNER_MAX_IDLE_ROUNDS", 3);
  const maxErrorRounds = readPositiveIntOption(args, "max-error-rounds", "ATP_RUNNER_MAX_ERROR_ROUNDS", 3);
  const onboardingEnabled = readBooleanOption(args, "onboarding", "ATP_RUNNER_ONBOARDING", true);

  const workersExplicit = hasExplicitOption(args, "workers", "ATP_RUNNER_WORKERS");
  const commitPerNodeExplicit = hasExplicitOption(args, "commit-per-node", "ATP_RUNNER_COMMIT_PER_NODE");
  const agentPrefix = readStringOption(args, "agent-prefix", "ATP_RUNNER_AGENT_PREFIX", "codex_agent");
  const agentProvider = readAgentProvider(args);
  const modelExplicit = hasExplicitOption(args, "model", "ATP_RUNNER_MODEL");
  const providerExplicit = hasExplicitOption(args, "agent-provider", "ATP_RUNNER_AGENT_PROVIDER");
  const reasoningExplicit = hasExplicitOption(args, "reasoning-effort", "ATP_RUNNER_REASONING_EFFORT");
  const sandboxExplicit = hasExplicitOption(args, "sandbox-mode", "ATP_RUNNER_SANDBOX_MODE");
  const modelDefault = agentProvider === "claude" ? "sonnet" : "gpt-5.4";
  const model = readStringOption(args, "model", "ATP_RUNNER_MODEL", modelDefault);
  const claudeBinary = readStringOption(args, "claude-bin", "ATP_RUNNER_CLAUDE_BIN", "claude");
  const reasoningEffort = readReasoningEffort(args);
  const sandboxMode = readSandboxMode(args);

  const noTui = readBooleanOption(args, "no-tui", "ATP_RUNNER_NO_TUI", false);

  return {
    projectRoot,
    atpFile,
    promptFile,
    projectRootExplicit,
    atpFileExplicit,
    workers,
    commitPerNode,
    webSearchMode,
    workerTimeoutMs,
    pollIntervalMs,
    maxIdleRounds,
    maxErrorRounds,
    agentProvider,
    modelExplicit,
    providerExplicit,
    workersExplicit,
    commitPerNodeExplicit,
    reasoningExplicit,
    sandboxExplicit,
    agentPrefix,
    model,
    reasoningEffort,
    sandboxMode,
    tuiEnabled: !noTui,
    onboardingEnabled,
    claudeBinary,
  };
}

function visibleWidth(value: string): number {
  return stripVTControlCharacters(value).length;
}

function clearOnboardingViewport(): void {
  if (!process.stdout.isTTY) {
    return;
  }
  readline.cursorTo(process.stdout, 0, 0);
  readline.clearScreenDown(process.stdout);
}

function fitVisible(value: string, width: number): string {
  const textWidth = visibleWidth(value);
  if (textWidth === width) {
    return value;
  }
  if (textWidth < width) {
    return `${value}${" ".repeat(width - textWidth)}`;
  }
  const plain = stripVTControlCharacters(value);
  return truncatePlain(plain, width);
}

function buildOnboardingStepHeader(meta: OnboardingFrameMeta): string {
  const segments = meta.stepLabels.map((label, idx) => {
    const prefix = `${idx + 1}:${label}`;
    if (idx < meta.stepIndex) {
      return `${ANSI.dim}${prefix}${ANSI.reset}`;
    }
    if (idx === meta.stepIndex) {
      return `${ANSI.bold}${ANSI.orangeSoft}${prefix}${ANSI.reset}`;
    }
    return `${ANSI.gray}${prefix}${ANSI.reset}`;
  });
  return `${ANSI.bold}${ANSI.orange}Steps${ANSI.reset} ${segments.join(`${ANSI.gray} │ ${ANSI.reset}`)}`;
}

function renderOnboardingFrame(title: string, lines: string[], options?: { meta?: OnboardingFrameMeta }): void {
  const stdout = process.stdout;
  const termWidth = stdout.columns ?? 120;
  const safeInnerMax = Math.max(24, termWidth - 4);
  const header = `${ANSI.bold}${ANSI.orange}${title}${ANSI.reset}`;
  const stepHeader = options?.meta ? buildOnboardingStepHeader(options.meta) : null;
  const innerWidth = safeInnerMax;

  const top = `${ANSI.orange}╭${"─".repeat(innerWidth + 2)}╮${ANSI.reset}`;
  const mid = `${ANSI.orange}├${"─".repeat(innerWidth + 2)}┤${ANSI.reset}`;
  const bottom = `${ANSI.orange}╰${"─".repeat(innerWidth + 2)}╯${ANSI.reset}`;
  const out: string[] = [top];

  if (stepHeader) {
    out.push(
      `${ANSI.orange}│${ANSI.reset} ${fitVisible(stepHeader, innerWidth)} ${ANSI.orange}│${ANSI.reset}`,
    );
    out.push(mid);
  }
  out.push(
    `${ANSI.orange}│${ANSI.reset} ${fitVisible(header, innerWidth)} ${ANSI.orange}│${ANSI.reset}`,
  );
  out.push(mid);
  lines.forEach((line) => {
    out.push(
      `${ANSI.orange}│${ANSI.reset} ${fitVisible(line, innerWidth)} ${ANSI.orange}│${ANSI.reset}`,
    );
  });
  out.push(bottom);
  stdout.write(`${out.join("\n")}\n`);
}

function askQuestion(
  question: string,
  options?: {
    completer?: readline.Completer;
    title?: string;
    subtitle?: string;
    meta?: OnboardingFrameMeta;
  },
): Promise<PromptNavigation<string>> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: options?.completer,
  });

  const toNavigation = (answer: string): PromptNavigation<string> => {
    const value = answer.trim();
    const lowered = value.toLowerCase();
    if (lowered === "/back" || lowered === ":back") {
      return { kind: "back" };
    }
    if (lowered === "/cancel" || lowered === ":cancel") {
      return { kind: "cancel" };
    }
    return { kind: "value", value };
  };

  return new Promise((resolve) => {
    rl.on("SIGINT", () => {
      rl.close();
      resolve({ kind: "cancel" });
    });

    clearOnboardingViewport();
    if (options?.title) {
      const frameLines: string[] = [];
      if (options.subtitle) {
        frameLines.push(`${ANSI.dim}${options.subtitle}${ANSI.reset}`);
        frameLines.push("");
      }
      frameLines.push(`${ANSI.dim}Type /back to go to previous step. Type /cancel to exit onboarding.${ANSI.reset}`);
      frameLines.push("");
      frameLines.push(`${ANSI.orangeSoft}${question}${ANSI.reset}`);
      renderOnboardingFrame(options.title, frameLines, { meta: options.meta });

      // Place the text cursor at the end of the prompt line inside the frame.
      readline.moveCursor(process.stdout, 0, -2);
      readline.cursorTo(process.stdout, 2 + visibleWidth(question));
      rl.question("", (answer) => {
        rl.close();
        resolve(toNavigation(answer));
      });
      return;
    }
    const prompt = `${ANSI.orangeSoft}${question}${ANSI.reset}`;
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(toNavigation(answer));
    });
  });
}

async function askArrowMenu<T>(
  title: string,
  options: ArrowMenuOption<T>[],
  initialIndex = 0,
  subtitle?: string,
  meta?: OnboardingFrameMeta,
): Promise<PromptNavigation<T>> {
  const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean; setRawMode?: (mode: boolean) => void };
  const stdout = process.stdout;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    return { kind: "value", value: options[clamp(initialIndex, 0, Math.max(0, options.length - 1))]?.value };
  }

  readline.emitKeypressEvents(stdin);
  const startIndex = clamp(initialIndex, 0, Math.max(0, options.length - 1));
  const wasRaw = Boolean(stdin.isRaw);

  return new Promise((resolve) => {
    let index = startIndex;

    const render = (): void => {
      clearOnboardingViewport();

      const lines: string[] = [];
      if (subtitle) {
        subtitle.split(/\r?\n/).forEach((line) => {
          lines.push(`${ANSI.dim}${line}${ANSI.reset}`);
        });
      }
      lines.push("");
      options.forEach((option, i) => {
        const active = i === index;
        const marker = active ? `${ANSI.bold}${ANSI.orange}❯${ANSI.reset}` : `${ANSI.dim}·${ANSI.reset}`;
        const label = active
          ? `${ANSI.bold}${ANSI.orangeSoft}${option.label}${ANSI.reset}`
          : `${ANSI.white}${option.label}${ANSI.reset}`;
        lines.push(`${marker} ${label}`);
        if (option.description) {
          lines.push(`  ${ANSI.dim}${option.description}${ANSI.reset}`);
        }
      });
      lines.push("");
      lines.push(`${ANSI.dim}Arrow Up/Down (or j/k), Enter select, Esc back, Ctrl+C cancel.${ANSI.reset}`);
      renderOnboardingFrame(title, lines, { meta });
    };

    const cleanup = (): void => {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode?.(wasRaw);
      stdout.write("\n");
    };

    const onKeypress = (str: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key?.ctrl && key.name === "c") {
        cleanup();
        resolve({ kind: "cancel" });
        return;
      }
      if (key?.name === "escape") {
        cleanup();
        resolve({ kind: "back" });
        return;
      }
      if (key?.name === "up" || str === "k") {
        index = (index - 1 + options.length) % options.length;
        render();
        return;
      }
      if (key?.name === "down" || str === "j") {
        index = (index + 1) % options.length;
        render();
        return;
      }
      if (key?.name === "return" || key?.name === "enter") {
        const selected = options[index];
        cleanup();
        resolve({ kind: "value", value: selected.value });
      }
    };

    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("keypress", onKeypress);
    render();
  });
}

async function askPositiveInteger(
  question: string,
  fallback: number,
  meta?: OnboardingFrameMeta,
): Promise<PromptNavigation<number>> {
  while (true) {
    const answer = await askQuestion(`${question} [${fallback}]: `, {
      title: "ATP Runner :: Numeric Input",
      subtitle: "Enter a positive integer value.",
      meta,
    });
    if (answer.kind === "back" || answer.kind === "cancel") {
      return answer;
    }
    const raw = answer.value;
    if (!raw) {
      return { kind: "value", value: fallback };
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return { kind: "value", value: parsed };
    }
    console.log("Please enter a positive integer.");
  }
}

function expandTilde(inputPath: string): string {
  if (!inputPath.startsWith("~")) {
    return inputPath;
  }
  const home = process.env.HOME;
  if (!home) {
    return inputPath;
  }
  if (inputPath === "~") {
    return home;
  }
  if (inputPath.startsWith("~/")) {
    return path.join(home, inputPath.slice(2));
  }
  return inputPath;
}

function toDisplayPath(absPath: string, baseDir: string): string {
  const home = process.env.HOME;
  if (home && (absPath === home || absPath.startsWith(`${home}${path.sep}`))) {
    const relHome = path.relative(home, absPath);
    return relHome ? `~/${relHome}` : "~";
  }
  if (path.isAbsolute(absPath)) {
    const rel = path.relative(baseDir, absPath);
    if (rel && !rel.startsWith("..")) {
      return rel;
    }
  }
  return absPath;
}

function createPathCompleter(
  baseDir: string,
  options?: {
    directoriesOnly?: boolean;
  },
): readline.Completer {
  return (line: string): [string[], string] => {
    const raw = line.trim();
    const entered = raw.length > 0 ? raw : ".";
    const expanded = expandTilde(entered);
    const absolute = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(baseDir, expanded);

    const endsWithSlash = entered.endsWith("/") || entered.endsWith(path.sep);
    const targetDir = endsWithSlash ? absolute : path.dirname(absolute);
    const namePrefix = endsWithSlash ? "" : path.basename(absolute);

    let dirents: fs.Dirent[] = [];
    try {
      dirents = fs.readdirSync(targetDir, { withFileTypes: true });
    } catch {
      return [[], line];
    }

    const hits = dirents
      .filter((entry) => entry.name.startsWith(namePrefix))
      .filter((entry) => !options?.directoriesOnly || entry.isDirectory())
      .map((entry) => {
        const absCandidate = path.join(targetDir, entry.name);
        const display = toDisplayPath(absCandidate, baseDir);
        return entry.isDirectory() ? `${display}/` : display;
      })
      .sort((a, b) => a.localeCompare(b));

    return [hits.length > 0 ? hits : [], line];
  };
}

async function askPathQuestion(
  question: string,
  fallback: string,
  baseDir: string,
  options?: {
    directoriesOnly?: boolean;
  },
  meta?: OnboardingFrameMeta,
): Promise<PromptNavigation<string>> {
  const answer = await askQuestion(`${question} [${fallback}]: `, {
    completer: createPathCompleter(baseDir, options),
    title: "ATP Runner :: Path Input",
    subtitle: "Tab autocompletes filesystem paths.",
    meta,
  });
  if (answer.kind === "back" || answer.kind === "cancel") {
    return answer;
  }
  return { kind: "value", value: resolvePathInput(answer.value, fallback, baseDir) };
}

function resolvePathInput(input: string, fallback: string, baseDir = process.cwd()): string {
  const raw = input.trim();
  if (!raw) {
    return fallback;
  }
  const expanded = expandTilde(raw);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

async function runOnboarding(config: RunnerConfig): Promise<RunnerConfig> {
  const canPrompt =
    config.onboardingEnabled && config.tuiEnabled && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  if (!canPrompt) {
    return config;
  }
  if (
    config.projectRootExplicit &&
    config.atpFileExplicit &&
    config.providerExplicit &&
    config.modelExplicit &&
    config.workersExplicit &&
    config.commitPerNodeExplicit &&
    config.reasoningExplicit &&
    config.sandboxExplicit
  ) {
    return config;
  }

  let next = { ...config };

  const steps = ONBOARDING_STEP_LABELS;
  let stepIndex = 0;

  const goBack = (): boolean => {
    if (stepIndex === 0) {
      return false;
    }
    stepIndex -= 1;
    return true;
  };

  while (stepIndex < steps.length) {
    const meta: OnboardingFrameMeta = { stepLabels: steps, stepIndex };

    switch (stepIndex) {
      case 0: {
        if (next.projectRootExplicit) {
          stepIndex += 1;
          break;
        }
        const workspaceChoice = await askArrowMenu<"keep" | "custom">(
          "ATP Runner :: Select Workspace Path",
          [
            { label: "Keep current workspace", value: "keep", description: next.projectRoot },
            { label: "Custom workspace path...", value: "custom" },
          ],
          0,
          "Workspace root where workers will run.",
          meta,
        );
        if (workspaceChoice.kind === "cancel") {
          throw new Error("Onboarding cancelled by user.");
        }
        if (workspaceChoice.kind === "back") {
          if (!goBack()) {
            throw new Error("Onboarding cancelled by user.");
          }
          break;
        }
        if (workspaceChoice.value === "custom") {
          const pathResult = await askPathQuestion(
            "Enter workspace path",
            next.projectRoot,
            process.cwd(),
            { directoriesOnly: true },
            meta,
          );
          if (pathResult.kind === "cancel") {
            throw new Error("Onboarding cancelled by user.");
          }
          if (pathResult.kind === "back") {
            break;
          }
          next.projectRoot = pathResult.value;
        }
        stepIndex += 1;
        break;
      }

      case 1: {
        if (next.atpFileExplicit) {
          stepIndex += 1;
          break;
        }
        const suggestedAtp = path.join(next.projectRoot, ".atp.json");
        const planOptions: ArrowMenuOption<"keep" | "suggested" | "custom">[] = [
          { label: "Keep current ATP plan path", value: "keep", description: next.atpFile },
        ];
        if (suggestedAtp !== next.atpFile) {
          planOptions.push({
            label: "Use workspace default ATP plan",
            value: "suggested",
            description: suggestedAtp,
          });
        }
        planOptions.push({ label: "Custom ATP plan path...", value: "custom" });

        const planChoice = await askArrowMenu<"keep" | "suggested" | "custom">(
          "ATP Runner :: Select ATP Plan Path",
          planOptions,
          suggestedAtp !== next.atpFile ? 1 : 0,
          "ATP JSON plan used by claim/complete tools.",
          meta,
        );
        if (planChoice.kind === "cancel") {
          throw new Error("Onboarding cancelled by user.");
        }
        if (planChoice.kind === "back") {
          if (!goBack()) {
            throw new Error("Onboarding cancelled by user.");
          }
          break;
        }
        if (planChoice.value === "suggested") {
          next.atpFile = suggestedAtp;
        } else if (planChoice.value === "custom") {
          const planResult = await askPathQuestion("Enter ATP plan path", suggestedAtp, next.projectRoot, undefined, meta);
          if (planResult.kind === "cancel") {
            throw new Error("Onboarding cancelled by user.");
          }
          if (planResult.kind === "back") {
            break;
          }
          next.atpFile = planResult.value;
        }
        stepIndex += 1;
        break;
      }

      case 2: {
        if (next.providerExplicit) {
          stepIndex += 1;
          break;
        }
        const provider = await askArrowMenu<AgentProvider>(
          "ATP Runner :: Select Agent Provider",
          [
            { label: "Codex", value: "codex", description: "OpenAI Codex SDK runtime." },
            { label: "Claude", value: "claude", description: "Claude Code CLI runtime." },
          ],
          next.agentProvider === "claude" ? 1 : 0,
          "Pick the engine for this run.",
          meta,
        );
        if (provider.kind === "cancel") {
          throw new Error("Onboarding cancelled by user.");
        }
        if (provider.kind === "back") {
          if (!goBack()) {
            throw new Error("Onboarding cancelled by user.");
          }
          break;
        }
        next.agentProvider = provider.value;
        stepIndex += 1;
        break;
      }

      case 3: {
        if (next.modelExplicit) {
          stepIndex += 1;
          break;
        }
        const recommended = next.agentProvider === "claude" ? "sonnet" : "gpt-5.4";
        const modelOptions: ArrowMenuOption<string>[] = [
          { label: `Keep current model (${next.model})`, value: next.model },
        ];
        if (recommended !== next.model) {
          modelOptions.push({ label: `Use recommended model (${recommended})`, value: recommended });
        }
        modelOptions.push({ label: "Custom model...", value: "__custom__" });

        const modelChoice = await askArrowMenu<string>(
          "ATP Runner :: Select Model",
          modelOptions,
          0,
          `Provider: ${next.agentProvider}`,
          meta,
        );
        if (modelChoice.kind === "cancel") {
          throw new Error("Onboarding cancelled by user.");
        }
        if (modelChoice.kind === "back") {
          if (!goBack()) {
            throw new Error("Onboarding cancelled by user.");
          }
          break;
        }
        if (modelChoice.value === "__custom__") {
          const custom = await askQuestion(`Enter model name [${recommended}]: `, {
            title: "ATP Runner :: Model Input",
            subtitle: "Type a model identifier and press Enter.",
            meta,
          });
          if (custom.kind === "cancel") {
            throw new Error("Onboarding cancelled by user.");
          }
          if (custom.kind === "back") {
            break;
          }
          next.model = custom.value || recommended;
        } else {
          next.model = modelChoice.value;
        }
        stepIndex += 1;
        break;
      }

      case 4: {
        if (next.agentProvider !== "codex" || next.reasoningExplicit) {
          stepIndex += 1;
          break;
        }
        const efforts: ModelReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
        const currentIndex = Math.max(0, efforts.indexOf(next.reasoningEffort));
        const effort = await askArrowMenu<ModelReasoningEffort>(
          "ATP Runner :: Select Reasoning Effort",
          efforts.map((value) => ({ label: value, value })),
          currentIndex,
          "Higher effort usually improves quality but can increase latency/cost.",
          meta,
        );
        if (effort.kind === "cancel") {
          throw new Error("Onboarding cancelled by user.");
        }
        if (effort.kind === "back") {
          if (!goBack()) {
            throw new Error("Onboarding cancelled by user.");
          }
          break;
        }
        next.reasoningEffort = effort.value;
        stepIndex += 1;
        break;
      }

      case 5: {
        if (next.agentProvider !== "codex" || next.sandboxExplicit) {
          stepIndex += 1;
          break;
        }
        const sandboxes: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
        const currentIndex = Math.max(0, sandboxes.indexOf(next.sandboxMode));
        const sandbox = await askArrowMenu<SandboxMode>(
          "ATP Runner :: Select Sandbox Mode",
          sandboxes.map((value) => ({ label: value, value })),
          currentIndex,
          "Controls filesystem/network permissions for Codex.",
          meta,
        );
        if (sandbox.kind === "cancel") {
          throw new Error("Onboarding cancelled by user.");
        }
        if (sandbox.kind === "back") {
          if (!goBack()) {
            throw new Error("Onboarding cancelled by user.");
          }
          break;
        }
        next.sandboxMode = sandbox.value;
        stepIndex += 1;
        break;
      }

      case 6: {
        if (next.commitPerNodeExplicit) {
          stepIndex += 1;
          break;
        }
        const commitChoice = await askArrowMenu<boolean>(
          "ATP Runner :: Commit Per Node",
          [
            {
              label: "Enable commit-per-node",
              value: true,
              description: "Create one local git commit for each completed node with file changes.",
            },
            {
              label: "Disable commit-per-node",
              value: false,
              description: "Do not enforce one commit per node.",
            },
          ],
          next.commitPerNode ? 0 : 1,
          "Local commits only. The runner never pushes to GitHub automatically.",
          meta,
        );
        if (commitChoice.kind === "cancel") {
          throw new Error("Onboarding cancelled by user.");
        }
        if (commitChoice.kind === "back") {
          if (!goBack()) {
            throw new Error("Onboarding cancelled by user.");
          }
          break;
        }
        next.commitPerNode = commitChoice.value;
        stepIndex += 1;
        break;
      }

      case 7: {
        if (next.workersExplicit) {
          stepIndex += 1;
          break;
        }
        const workerChoice = await askArrowMenu<number>(
          "ATP Runner :: Select Parallel Workers",
          [
            { label: "1 worker", value: 1 },
            { label: "2 workers", value: 2 },
            { label: "4 workers", value: 4 },
            { label: "8 workers", value: 8 },
            { label: "Custom...", value: -1 },
          ],
          [1, 2, 4, 8].includes(next.workers) ? [1, 2, 4, 8].indexOf(next.workers) : 4,
          "Use more workers only if tasks are mostly independent.",
          meta,
        );
        if (workerChoice.kind === "cancel") {
          throw new Error("Onboarding cancelled by user.");
        }
        if (workerChoice.kind === "back") {
          if (!goBack()) {
            throw new Error("Onboarding cancelled by user.");
          }
          break;
        }
        if (workerChoice.value === -1) {
          const customWorkers = await askPositiveInteger("Enter worker count", next.workers, meta);
          if (customWorkers.kind === "cancel") {
            throw new Error("Onboarding cancelled by user.");
          }
          if (customWorkers.kind === "back") {
            break;
          }
          next.workers = customWorkers.value;
        } else {
          next.workers = workerChoice.value;
        }
        stepIndex += 1;
        break;
      }

      default: {
        const summary = `provider=${next.agentProvider}  model=${next.model}  workers=${next.workers}  commit_per_node=${next.commitPerNode ? "on" : "off"}`;
        const startChoice = await askArrowMenu<"start" | "cancel">(
          "ATP Runner :: Start Run?",
          [
            { label: "Start run", value: "start", description: summary },
            { label: "Cancel", value: "cancel", description: "Exit without running." },
          ],
          0,
          `${ANSI.dim}workspace: ${next.projectRoot}${ANSI.reset}\n${ANSI.dim}plan: ${next.atpFile}${ANSI.reset}\n${ANSI.dim}commit per node: ${next.commitPerNode ? "enabled" : "disabled"}${ANSI.reset}`,
          meta,
        );
        if (startChoice.kind === "cancel") {
          throw new Error("Onboarding cancelled by user.");
        }
        if (startChoice.kind === "back") {
          if (!goBack()) {
            throw new Error("Onboarding cancelled by user.");
          }
          break;
        }
        if (startChoice.value === "cancel") {
          throw new Error("Onboarding cancelled by user.");
        }
        clearOnboardingViewport();
        return next;
      }
    }
  }

  clearOnboardingViewport();
  return next;
}

function printHelp(): void {
  console.log(`ATP Runner

Usage:
  npm start -- [options]

Options:
  --project-root <path>      Project workspace root (default: $ATP_PROJECT_ROOT or current directory)
  --atp-file <path>          ATP plan path (default: $ATP_FILE or <project-root>/.atp.json)
  --prompt-file <path>       Worker prompt markdown (default: RUNNER.md next to atp_runner.ts)
  --workers <n>              Worker count (default: 1, recommended)
  --commit-per-node <bool>   Enforce one git commit per completed node (default: true)
  --web-search-mode <mode>   disabled|cached|live (default: live)
  --worker-timeout-ms <ms>   Per-worker max turn duration before abort (default: 9000000)
  --poll-ms <ms>             Delay between rounds in milliseconds (default: 2000)
  --max-idle-rounds <n>      Exit after N all-idle rounds (default: 3)
  --max-error-rounds <n>     Abort after N all-error rounds (default: 3)
  --agent-provider <name>    codex|claude (default: codex)
  --agent-prefix <text>      Prefix used to generate per-worker agent IDs (default: codex_agent)
  --model <name>             Model name (default: gpt-5.4 for codex, sonnet for claude)
  --reasoning-effort <mode>  minimal|low|medium|high|xhigh (default: high)
  --sandbox-mode <mode>      read-only|workspace-write|danger-full-access (default: workspace-write)
  --claude-bin <path>        Claude CLI binary/command (default: claude)
  --onboarding <bool>        Interactive startup agent/model selection in TUI (default: true)
  --no-tui                   Disable the live color dashboard and use plain logs
  --help                     Show this help
`);
}

function ensureConfigIsValid(config: RunnerConfig): void {
  if (!fs.existsSync(config.projectRoot)) {
    throw new Error(`Project root does not exist: ${config.projectRoot}`);
  }
  if (!fs.statSync(config.projectRoot).isDirectory()) {
    throw new Error(`Project root is not a directory: ${config.projectRoot}`);
  }
  if (!fs.existsSync(config.atpFile)) {
    throw new Error(`Could not find ATP file at ${config.atpFile}`);
  }
  if (!fs.existsSync(config.promptFile)) {
    throw new Error(`Could not find worker prompt file at ${config.promptFile}`);
  }
  if (config.agentProvider === "claude") {
    try {
      execFileSync(config.claudeBinary, ["--version"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const err = error as { stderr?: string; message?: string };
      const details = err.stderr?.toString().trim() || err.message || "unknown error";
      throw new Error(
        `Selected agent-provider=claude but "${config.claudeBinary}" is not available or not working: ${details}`,
      );
    }
  }
}

function runGitCommand(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    const details = err.stderr?.toString().trim() || err.message || "unknown git error";
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${details}`);
  }
}

function getHeadSha(cwd: string): string | null {
  try {
    const sha = runGitCommand(cwd, ["rev-parse", "HEAD"]);
    return sha || null;
  } catch {
    return null;
  }
}

function hasUncommittedChanges(cwd: string): boolean {
  try {
    const status = runGitCommand(cwd, ["status", "--porcelain"]);
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

function commitAllChanges(cwd: string, message: string): string {
  runGitCommand(cwd, ["add", "-A"]);
  runGitCommand(cwd, ["commit", "-m", message]);
  const sha = runGitCommand(cwd, ["rev-parse", "HEAD"]);
  return sha;
}

function prepareWorkerRuntimes(config: RunnerConfig): WorkerRuntime[] {
  let branchName = "detached";
  try {
    branchName = runGitCommand(config.projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]) || "detached";
  } catch {
    branchName = "non-git";
  }

  const hasPreCommit = fs.existsSync(path.join(config.projectRoot, ".pre-commit-config.yaml"));
  const hasRuff =
    fs.existsSync(path.join(config.projectRoot, "ruff.toml")) ||
    fs.existsSync(path.join(config.projectRoot, ".ruff.toml")) ||
    fs.existsSync(path.join(config.projectRoot, "pyproject.toml"));

  return Array.from({ length: config.workers }, (_, index) => {
    const workerNumber = index + 1;
    return {
      workerId: `${config.agentPrefix}_${workerNumber}`,
      workerNumber,
      workingDirectory: config.projectRoot,
      branchName,
      hasPreCommit,
      hasRuff,
    };
  });
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function getMemoryTemplates(projectRoot: string): Array<{ path: string; content: string }> {
  const date = todayIsoDate();
  const memoryDir = path.join(projectRoot, "docs", "memory");

  return [
    {
      path: path.join(memoryDir, "README.md"),
      content: `# Shared Memory Governance

This directory is mandatory collaboration infrastructure for ATP workers.

## Purpose

Maintain durable, cross-node memory so all workers make consistent decisions and avoid drift.

## Canonical Artifacts

- \`decision-log.md\`: approved architecture/policy decisions and supersession history.
- \`contracts.md\`: API/schema/interface contracts and compatibility constraints.
- \`risk-register.md\`: active risks, impact, mitigation, and owners.
- \`evidence-index.md\`: acceptance evidence and verification references.
- \`changelog.md\`: memory-impacting project changes by node.

## Required Update Protocol

When a node changes architecture, policy, API, schema, or acceptance evidence, update relevant memory files in the same task.

Each appended entry must include:

- \`NodeID\`: ATP node identifier.
- \`Date\`: \`YYYY-MM-DD\`.
- \`Author\`: agent identifier.
- \`Change\`: concise summary of what changed.
- \`Status\`: \`proposed\`, \`approved\`, \`superseded\`, or \`closed\` as applicable.

## Conflict Resolution

Latest **approved** decision in \`decision-log.md\` is source of truth and supersedes stale assumptions.

## Worker Checklist (Required)

- [ ] Read this README and relevant memory artifacts before implementation.
- [ ] Verify whether node scope affects decision/contract/risk/evidence/changelog memory.
- [ ] Append NodeID/date-tagged entries to all impacted memory files.
- [ ] Include updated memory paths in ATP \`artifacts\` and mention them in the completion \`report\`.
- [ ] If memory cannot be safely updated due to missing context, fail the node with explicit blocker details.

## Ownership

- Primary owner: ATP orchestrator / tech lead.
- Maintainers: all ATP workers modifying this project.
`,
    },
    {
      path: path.join(memoryDir, "decision-log.md"),
      content: `# Decision Log

Source of truth for architecture and policy decisions.

## Ownership

- Primary owner: ATP orchestrator / tech lead
- Maintainers: all ATP workers

## Entry Template

\`\`\`md
### [DEC-<number>] <Decision Title>
- NodeID: <ATP node id>
- Date: YYYY-MM-DD
- Author: <agent_id>
- Status: proposed | approved | superseded
- Scope: architecture | policy | platform | process
- Context: <why this decision is needed>
- Decision: <what is being decided>
- Rationale: <why this option>
- Impact: <systems/files/teams affected>
- Supersedes: <DEC-id or none>
- Superseded By: <DEC-id or none>
\`\`\`

## Decisions

### [DEC-000] Shared Memory Governance Initialized
- NodeID: BOOTSTRAP
- Date: ${date}
- Author: codex_runner_setup
- Status: approved
- Scope: process
- Context: Large ATP projects require durable shared memory to avoid drift across workers.
- Decision: \`docs/memory/*\` is mandatory shared memory and must be updated on relevant nodes.
- Rationale: Centralized, append-only memory improves consistency and traceability.
- Impact: All workers and node handoffs.
- Supersedes: none
- Superseded By: none
`,
    },
    {
      path: path.join(memoryDir, "contracts.md"),
      content: `# Contracts

Canonical register of API, schema, and interface contracts.

## Ownership

- Primary owner: API/domain leads
- Maintainers: workers changing interfaces, schemas, or integration behavior

## Entry Template

\`\`\`md
### [CON-<number>] <Contract Name>
- NodeID: <ATP node id>
- Date: YYYY-MM-DD
- Author: <agent_id>
- Status: proposed | approved | superseded
- Surface: API | event | DB schema | config | internal interface
- Contract: <exact shape/rules/version>
- Compatibility: backward-compatible | breaking
- Consumers: <services/modules/users affected>
- Validation Evidence: <tests/docs/commands/links>
- Notes: <migration or rollout notes>
\`\`\`

## Contracts

### [CON-000] Shared Memory Artifact Contract
- NodeID: BOOTSTRAP
- Date: ${date}
- Author: codex_runner_setup
- Status: approved
- Surface: internal interface
- Contract: \`docs/memory/\` must contain decision-log.md, contracts.md, risk-register.md, evidence-index.md, changelog.md, and README.md.
- Compatibility: backward-compatible
- Consumers: all ATP workers
- Validation Evidence: folder and templates created in repository
- Notes: updates must be append-only and NodeID-tagged
`,
    },
    {
      path: path.join(memoryDir, "risk-register.md"),
      content: `# Risk Register

Active and historical project risks with mitigations and ownership.

## Ownership

- Primary owner: tech lead / project manager
- Maintainers: all workers identifying or resolving risks

## Entry Template

\`\`\`md
### [RISK-<number>] <Risk Title>
- NodeID: <ATP node id>
- Date: YYYY-MM-DD
- Author: <agent_id>
- Status: open | monitoring | mitigated | closed
- Probability: low | medium | high
- Impact: low | medium | high
- Area: architecture | delivery | quality | security | operations
- Description: <risk statement>
- Mitigation: <planned or completed actions>
- Owner: <person/role/agent>
- Evidence: <tests/metrics/logs/docs>
\`\`\`

## Risks

### [RISK-000] Cross-Worker Decision Drift
- NodeID: BOOTSTRAP
- Date: ${date}
- Author: codex_runner_setup
- Status: monitoring
- Probability: high
- Impact: high
- Area: delivery
- Description: Parallel workers may diverge on assumptions without a shared memory protocol.
- Mitigation: enforce updates to \`docs/memory/*\` and treat latest approved decision log entry as canonical.
- Owner: ATP orchestrator
- Evidence: runner prompt governance + memory templates
`,
    },
    {
      path: path.join(memoryDir, "evidence-index.md"),
      content: `# Evidence Index

Index of acceptance and verification evidence produced by ATP nodes.

## Ownership

- Primary owner: QA/verification lead
- Maintainers: workers producing tests, checks, or validation artifacts

## Entry Template

\`\`\`md
### [EVD-<number>] <Evidence Title>
- NodeID: <ATP node id>
- Date: YYYY-MM-DD
- Author: <agent_id>
- Status: proposed | approved | superseded
- Requirement/Acceptance Link: <requirement id or text>
- Evidence Type: test | benchmark | manual verification | doc
- Location: <file path / command / URL>
- Result Summary: <pass/fail/findings>
- Notes: <limitations/follow-up>
\`\`\`

## Evidence

### [EVD-000] Memory Governance Bootstrap
- NodeID: BOOTSTRAP
- Date: ${date}
- Author: codex_runner_setup
- Status: approved
- Requirement/Acceptance Link: shared memory folder and governance protocol must exist
- Evidence Type: doc
- Location: \`docs/memory/*\`, \`RUNNER.md\`
- Result Summary: initial memory artifacts and mandatory update protocol added
- Notes: future nodes should append concrete test/command evidence entries
`,
    },
    {
      path: path.join(memoryDir, "changelog.md"),
      content: `# Memory Changelog

Chronological log of memory-impacting changes across ATP nodes.

## Ownership

- Primary owner: ATP orchestrator
- Maintainers: all workers

## Entry Template

\`\`\`md
### [CHG-<number>] <Short Title>
- NodeID: <ATP node id>
- Date: YYYY-MM-DD
- Author: <agent_id>
- Status: proposed | approved | superseded | closed
- Changed Files: <list of files>
- Summary: <what changed>
- Related Decision/Contract/Risk/Evidence IDs: <IDs or none>
\`\`\`

## Changes

### [CHG-000] Shared Memory Bootstrap
- NodeID: BOOTSTRAP
- Date: ${date}
- Author: codex_runner_setup
- Status: approved
- Changed Files: \`docs/memory/README.md\`, \`docs/memory/decision-log.md\`, \`docs/memory/contracts.md\`, \`docs/memory/risk-register.md\`, \`docs/memory/evidence-index.md\`, \`docs/memory/changelog.md\`, \`RUNNER.md\`
- Summary: initialized shared memory folder and enforced runner-level governance protocol for all workers
- Related Decision/Contract/Risk/Evidence IDs: DEC-000, CON-000, RISK-000, EVD-000
`,
    },
  ];
}

function ensureProjectMemoryArtifacts(projectRoot: string): string[] {
  const templates = getMemoryTemplates(projectRoot);
  const created: string[] = [];
  const memoryDir = path.join(projectRoot, "docs", "memory");
  fs.mkdirSync(memoryDir, { recursive: true });

  templates.forEach((template) => {
    if (!fs.existsSync(template.path)) {
      fs.writeFileSync(template.path, template.content, "utf-8");
      created.push(template.path);
    }
  });

  return created;
}

function toStringRecord(env: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return { ...out, ...extra };
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncate(value: unknown, maxLength = 2000): string {
  const text = stringifyUnknown(value);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}... (truncated)`;
}

function truncatePlain(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 10_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(2)}k`;
  }
  return `${value}`;
}

function formatTokens(totals: TokenTotals): string {
  const inText = formatTokenCount(totals.input);
  const cachedText = totals.cachedInput > 0 ? ` (cached ${formatTokenCount(totals.cachedInput)})` : "";
  const outText = formatTokenCount(totals.output);
  const total = totals.input + totals.output;
  return `in ${inText}${cachedText} | out ${outText} | total ${formatTokenCount(total)}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatClock(timestampMs: number): string {
  const date = new Date(timestampMs);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(
    date.getSeconds(),
  ).padStart(2, "0")}`;
}

function padRight(value: string, width: number): string {
  const plainLength = stripVTControlCharacters(value).length;
  if (plainLength >= width) {
    return value;
  }
  return `${value}${" ".repeat(width - plainLength)}`;
}

function trackSignals(text: string, signals: SignalState): void {
  if (!text) {
    return;
  }
  if (text.includes(STOP_NO_TASKS)) {
    signals.sawNoTasks = true;
  }
  if (text.includes(STOP_PROJECT_INACTIVE)) {
    signals.sawProjectInactive = true;
  }
  if (text.includes(TASK_ASSIGNED_MARKER)) {
    signals.sawTaskAssignment = true;
  }
}

function summarizeAgentText(text: string): string {
  if (!text.trim()) {
    return "Received empty agent message";
  }

  if (text.includes(STOP_NO_TASKS)) {
    return "Agent reported no tasks available";
  }

  if (text.includes(STOP_PROJECT_INACTIVE)) {
    return "Agent reported project is not ACTIVE";
  }

  const assignmentMatch = text.match(/TASK ASSIGNED:\s*([^\n]+)/i);
  if (assignmentMatch && assignmentMatch[1]) {
    return `Assigned ${assignmentMatch[1].trim()}`;
  }

  const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? text;
  return truncatePlain(firstLine, 90);
}

function extractAssignment(text: string): { nodeId: string; title: string } | null {
  const match = text.match(/TASK ASSIGNED:\s*([^\s-]+)\s*-\s*([^\n]+)/i);
  if (!match || !match[1]) {
    return null;
  }
  return {
    nodeId: match[1].trim(),
    title: (match[2] ?? "").trim(),
  };
}

export function buildWorkerPrompt(
  promptTemplate: string,
  runtime: {
    projectRoot: string;
    atpFile: string;
    agentId: string;
    workerId: string;
    workers: number;
    workingDirectory: string;
    branchName: string;
    commitPerNode: boolean;
    hasPreCommit: boolean;
    hasRuff: boolean;
  },
): string {
  const runtimePreamble = [
    "### Runtime Context (Injected by ATP Runner)",
    `- project_root: ${runtime.projectRoot}`,
    `- plan_path: ${runtime.atpFile}`,
    `- agent_id: ${runtime.agentId}`,
    `- worker_slot: ${runtime.workerId}/${runtime.workers}`,
    `- working_directory: ${runtime.workingDirectory}`,
    `- git_branch: ${runtime.branchName}`,
    `- repo_has_precommit: ${runtime.hasPreCommit}`,
    `- repo_has_ruff: ${runtime.hasRuff}`,
    "",
    "Use these runtime values for ATP tool calls in this thread.",
    "",
    "### Runtime Turn Rules (Hard Constraints)",
    "- Claim at most one task in this turn.",
    "- If claim returns NO_TASKS_AVAILABLE or Project is not ACTIVE, exit immediately with a short status message.",
    "- Do not run repository exploration commands (find/rg/ls/etc.) if no task was assigned.",
    "- After completing or decomposing one assigned task, end this turn immediately.",
    ...(runtime.commitPerNode
      ? [
          "- When a node is completed successfully with file changes, create exactly one git commit before calling atp_complete_task.",
          "- Commit message format: node(<NODE_ID>): <short title>.",
          "- If no files changed for a successfully completed node, state this explicitly in the report instead of committing.",
          "- If commit is blocked by sandbox/permissions, do not fail the node solely for that. Continue, report the commit blocker clearly, and let runner-side commit enforcement handle fallback.",
        ]
      : [
          "- Do not create git commits as part of normal node completion unless the human explicitly asks for one.",
          "- Complete the node via atp_complete_task without making an automatic task commit, even if files changed.",
        ]),
    "- Use web search whenever the task depends on fast-changing external docs/APIs/SDKs, and cite sources in the completion report.",
    "- Before calling atp_complete_task with status DONE, run lint and typecheck appropriate for the files/systems touched in this node.",
    "- If lint/typecheck fails, attempt autofixes first (do not immediately fail). Rerun checks after applying fixes.",
    ...(runtime.hasRuff
      ? [
          "- If Ruff is present, prefer: ruff check --fix and ruff format (scoped to touched paths when possible).",
        ]
      : []),
    ...(runtime.hasPreCommit
      ? [
          "- If pre-commit is present, run: pre-commit run --all-files. If it fails, apply fixes and rerun until clean (or fail with evidence if non-fixable).",
        ]
      : []),
    "- Only mark FAILED for lint/typecheck when issues are not fixable within scope (provide concrete errors).",
    "- Include which lint/typecheck commands were run and their results (or failure reason) in the completion report.",
  ].join("\n");

  const hydratedPrompt = promptTemplate
    .replaceAll("{{PROJECT_ROOT}}", runtime.projectRoot)
    .replaceAll("{{PLAN_PATH}}", runtime.atpFile)
    .replaceAll("{{AGENT_ID}}", runtime.agentId);

  return `${runtimePreamble}\n\n${hydratedPrompt}`;
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return path.resolve(entry) === fileURLToPath(metaUrl);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function summarizeOutcomes(outcomes: WorkerOutcome[]): RoundSummary {
  return outcomes.reduce<RoundSummary>((acc, outcome) => {
    acc[outcome.kind] += 1;
    return acc;
  }, createEmptySummary());
}

async function runOneTaskCodex(
  config: RunnerConfig,
  promptTemplate: string,
  runtime: WorkerRuntime,
  dashboard: RunnerDashboard,
): Promise<WorkerOutcome> {
  const workerId = runtime.workerId;
  const systemPrompt = buildWorkerPrompt(promptTemplate, {
    projectRoot: config.projectRoot,
    atpFile: config.atpFile,
    agentId: workerId,
    workerId: `${runtime.workerNumber}`,
    workers: config.workers,
    workingDirectory: runtime.workingDirectory,
    branchName: runtime.branchName,
    commitPerNode: config.commitPerNode,
    hasPreCommit: runtime.hasPreCommit,
    hasRuff: runtime.hasRuff,
  });

  dashboard.markWorkerStarted(workerId, `Launching Codex thread in ${runtime.workingDirectory}...`);

  const env = toStringRecord(process.env, {
    ATP_FILE: config.atpFile,
    ATP_AGENT_ID: workerId,
    ATP_WORKER_DIR: runtime.workingDirectory,
    ATP_WORKER_BRANCH: runtime.branchName,
    PYTHONUNBUFFERED: "1",
  });

  const client = new Codex({ env });
  const thread = client.startThread({
    sandboxMode: config.sandboxMode,
    skipGitRepoCheck: true,
    model: config.model,
    modelReasoningEffort: config.reasoningEffort,
    workingDirectory: runtime.workingDirectory,
    webSearchEnabled: config.webSearchMode !== "disabled",
    webSearchMode: config.webSearchMode,
    additionalDirectories: [
      config.projectRoot,
      path.join(config.projectRoot, ".git"),
    ],
  });

  const signals: SignalState = {
    sawNoTasks: false,
    sawProjectInactive: false,
    sawTaskAssignment: false,
    sawTaskMutation: false,
    sawFileChange: false,
    assignedNodeId: null,
    assignedTitle: null,
  };
  const startHead = getHeadSha(runtime.workingDirectory);
  const startDirty = hasUncommittedChanges(runtime.workingDirectory);
  const abortController = new AbortController();
  let abortedForNoTask = false;
  let abortedForTimeout = false;
  const timeoutHandle = setTimeout(() => {
    abortedForTimeout = true;
    abortController.abort();
  }, config.workerTimeoutMs);

  const maybeAbortNoTask = (): void => {
    if (!signals.sawNoTasks || signals.sawTaskAssignment || signals.sawTaskMutation) {
      return;
    }
    if (!abortController.signal.aborted) {
      abortedForNoTask = true;
      abortController.abort();
    }
  };

  try {
    const streamResult = await thread.runStreamed(systemPrompt, { signal: abortController.signal });
    dashboard.markWorkerEvent(workerId, "Thread running", { bump: 4, minProgress: 12 });

    for await (const event of streamResult.events) {
      if (event.type === "turn.completed") {
        dashboard.markWorkerEvent(workerId, "Turn completed", { bump: 2, minProgress: 90 });
        dashboard.markWorkerUsage(workerId, event.usage);
        continue;
      }

      if (event.type === "turn.failed") {
        dashboard.markWorkerEvent(workerId, `Turn failed: ${truncatePlain(event.error.message, 90)}`, {
          bump: 4,
          logEvent: true,
          logLevel: "warn",
          minProgress: 90,
        });
        continue;
      }

      if (event.type === "item.started") {
        dashboard.markWorkerEvent(workerId, `Started ${event.item.type}`, { bump: 2 });
        continue;
      }

      if (event.type === "item.updated") {
        const item = event.item;
        if (item.type === "mcp_tool_call") {
          dashboard.markWorkerEvent(workerId, `${item.tool} (${item.status})`, {
            bump: 2,
            minProgress: 20,
          });
        }
        continue;
      }

      if (event.type === "item.completed") {
        const item = event.item;

        if (item.type === "agent_message") {
          const text = item.text ?? "";
          trackSignals(text, signals);
          const assignment = extractAssignment(text);
          if (assignment) {
            signals.assignedNodeId = assignment.nodeId;
            signals.assignedTitle = assignment.title;
          }
          maybeAbortNoTask();

          const summary = summarizeAgentText(text);
          dashboard.markWorkerEvent(workerId, summary, {
            bump: 4,
            minProgress: signals.sawTaskAssignment ? 45 : 20,
            logEvent: summary.includes("Assigned") || summary.includes("reported"),
            logLevel: summary.includes("reported") ? "warn" : "info",
          });
        } else if (item.type === "command_execution") {
          dashboard.markWorkerEvent(workerId, `Command: ${truncatePlain(item.command, 60)}`, {
            bump: 3,
            minProgress: 30,
          });
        } else if (item.type === "file_change") {
          signals.sawFileChange = true;
          signals.sawTaskMutation = true;
          dashboard.markWorkerEvent(workerId, `File changes: ${item.changes.length}`, {
            bump: 10,
            minProgress: 78,
            logEvent: true,
            logLevel: "success",
          });
        } else if (item.type === "mcp_tool_call") {
          const resultText = stringifyUnknown(item.result);
          const argsText = stringifyUnknown(item.arguments);
          const errorText = stringifyUnknown(item.error);
          const combined = `${resultText}\n${argsText}\n${errorText}`;

          trackSignals(combined, signals);
          const assignment = extractAssignment(combined);
          if (assignment) {
            signals.assignedNodeId = assignment.nodeId;
            signals.assignedTitle = assignment.title;
          }
          maybeAbortNoTask();

          if (item.tool.includes("atp_claim_task") && combined.includes(TASK_ASSIGNED_MARKER)) {
            signals.sawTaskAssignment = true;
            dashboard.markWorkerEvent(workerId, "Claimed ATP task", {
              bump: 8,
              minProgress: 45,
              logEvent: true,
            });
          } else if (item.tool.includes("atp_complete_task")) {
            signals.sawTaskMutation = true;
            dashboard.markWorkerEvent(workerId, "Completed ATP task", {
              bump: 12,
              minProgress: 82,
              logEvent: true,
              logLevel: "success",
            });
          } else if (item.tool.includes("atp_decompose_task")) {
            signals.sawTaskMutation = true;
            dashboard.markWorkerEvent(workerId, "Decomposed ATP task", {
              bump: 12,
              minProgress: 82,
              logEvent: true,
              logLevel: "success",
            });
          } else {
            dashboard.markWorkerEvent(workerId, `Tool: ${item.tool}`, { bump: 3, minProgress: 22 });
          }

          if (item.error) {
            dashboard.markWorkerEvent(workerId, `Tool error: ${truncate(item.error, 120)}`, {
              bump: 4,
              logEvent: true,
              logLevel: "warn",
            });
          }
        } else if (item.type === "reasoning") {
          dashboard.markWorkerEvent(workerId, "Reasoning step", { bump: 1 });
        } else if (item.type === "todo_list") {
          dashboard.markWorkerEvent(workerId, `Todo list updated (${item.items.length} items)`, {
            bump: 2,
          });
        } else if (item.type === "web_search") {
          dashboard.markWorkerEvent(workerId, `Web search: ${truncatePlain(item.query, 50)}`, {
            bump: 2,
          });
        } else if (item.type === "error") {
          dashboard.markWorkerEvent(workerId, `Error item: ${truncatePlain(item.message, 80)}`, {
            bump: 4,
            logEvent: true,
            logLevel: "warn",
          });
        }

        continue;
      }

      if (event.type === "error") {
        dashboard.markWorkerEvent(workerId, `Stream error: ${truncatePlain(event.message, 90)}`, {
          bump: 4,
          logEvent: true,
          logLevel: "warn",
        });
      }
    }
  } catch (error) {
    clearTimeout(timeoutHandle);
    if (abortedForNoTask) {
      return {
        kind: "NO_TASKS_AVAILABLE",
        workerId,
        details: "No claimable tasks available",
      };
    }
    if (abortedForTimeout) {
      return {
        kind: "ERROR",
        workerId,
        details: `Worker timed out after ${config.workerTimeoutMs}ms`,
      };
    }
    const details = error instanceof Error ? error.message : String(error);
    return {
      kind: "ERROR",
      workerId,
      details: truncatePlain(details, 160),
    };
  }
  clearTimeout(timeoutHandle);

  if (!signals.sawFileChange && signals.sawTaskAssignment && !startDirty && hasUncommittedChanges(runtime.workingDirectory)) {
    signals.sawFileChange = true;
  }

  if (config.commitPerNode && signals.sawTaskAssignment && signals.sawFileChange) {
    const endHead = getHeadSha(runtime.workingDirectory);
    if (endHead === startHead && hasUncommittedChanges(runtime.workingDirectory)) {
      const nodeId = signals.assignedNodeId ?? "unknown-node";
      const title = signals.assignedTitle?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ?? "task";
      const shortTitle = truncatePlain(title || "task", 50);
      const message = `node(${nodeId}): ${shortTitle}`;

      try {
        const sha = commitAllChanges(runtime.workingDirectory, message);
        dashboard.markWorkerEvent(workerId, `Runner auto-committed ${sha.slice(0, 8)} for ${nodeId}`, {
          logEvent: true,
          logLevel: "success",
          minProgress: 94,
          bump: 8,
        });
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        dashboard.markWorkerEvent(workerId, `Runner could not auto-commit: ${truncatePlain(details, 110)}`, {
          logEvent: true,
          logLevel: "warn",
          minProgress: 94,
          bump: 2,
        });
      }
    }
  }

  if (signals.sawProjectInactive) {
    return {
      kind: "PROJECT_INACTIVE",
      workerId,
      details: "Project reported as not ACTIVE",
    };
  }

  if (signals.sawNoTasks && !signals.sawTaskAssignment && !signals.sawTaskMutation) {
    return {
      kind: "NO_TASKS_AVAILABLE",
      workerId,
      details: "No claimable tasks available",
    };
  }

  return {
    kind: "ACTIVITY",
    workerId,
    details: signals.sawTaskMutation
      ? "Claimed and updated ATP graph"
      : signals.sawTaskAssignment
        ? "Claimed ATP work and progressed execution"
        : "Completed worker turn",
  };
}

function detectClaudeToolSignals(text: string, signals: SignalState, workerId: string, dashboard: RunnerDashboard): void {
  const lower = text.toLowerCase();
  const mentionsTool = lower.includes("tool");

  if (mentionsTool && lower.includes("atp_claim_task") && text.includes(TASK_ASSIGNED_MARKER)) {
    signals.sawTaskAssignment = true;
    dashboard.markWorkerEvent(workerId, "Claimed ATP task", {
      bump: 8,
      minProgress: 45,
      logEvent: true,
    });
  }
  if (mentionsTool && lower.includes("atp_complete_task")) {
    signals.sawTaskMutation = true;
    dashboard.markWorkerEvent(workerId, "Completed ATP task", {
      bump: 12,
      minProgress: 82,
      logEvent: true,
      logLevel: "success",
    });
  }
  if (mentionsTool && lower.includes("atp_decompose_task")) {
    signals.sawTaskMutation = true;
    dashboard.markWorkerEvent(workerId, "Decomposed ATP task", {
      bump: 12,
      minProgress: 82,
      logEvent: true,
      logLevel: "success",
    });
  }
}

function summarizeClaudeStreamEvent(payload: Record<string, unknown>): string {
  const eventType = typeof payload.type === "string" ? payload.type : "event";
  if (eventType.includes("error")) {
    return `Claude event: ${eventType} (error)`;
  }
  if (eventType.includes("result")) {
    return "Claude turn completed";
  }
  if (eventType.includes("tool")) {
    return `Claude ${eventType}`;
  }
  if (eventType.includes("assistant")) {
    return "Claude assistant message";
  }
  return `Claude ${eventType}`;
}

async function runOneTaskClaude(
  config: RunnerConfig,
  promptTemplate: string,
  runtime: WorkerRuntime,
  dashboard: RunnerDashboard,
): Promise<WorkerOutcome> {
  const workerId = runtime.workerId;
  const systemPrompt = buildWorkerPrompt(promptTemplate, {
    projectRoot: config.projectRoot,
    atpFile: config.atpFile,
    agentId: workerId,
    workerId: `${runtime.workerNumber}`,
    workers: config.workers,
    workingDirectory: runtime.workingDirectory,
    branchName: runtime.branchName,
    commitPerNode: config.commitPerNode,
    hasPreCommit: runtime.hasPreCommit,
    hasRuff: runtime.hasRuff,
  });

  dashboard.markWorkerStarted(workerId, `Launching Claude turn in ${runtime.workingDirectory}...`);

  const env = toStringRecord(process.env, {
    ATP_FILE: config.atpFile,
    ATP_AGENT_ID: workerId,
    ATP_WORKER_DIR: runtime.workingDirectory,
    ATP_WORKER_BRANCH: runtime.branchName,
    PYTHONUNBUFFERED: "1",
  });

  const args = [
    "-p",
    "Execute one ATP worker turn now. Follow the appended system prompt and runtime context exactly.",
    "--append-system-prompt",
    systemPrompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--dangerously-skip-permissions",
    "--model",
    config.model,
  ];

  const child = spawn(config.claudeBinary, args, {
    cwd: runtime.workingDirectory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const signals: SignalState = {
    sawNoTasks: false,
    sawProjectInactive: false,
    sawTaskAssignment: false,
    sawTaskMutation: false,
    sawFileChange: false,
    assignedNodeId: null,
    assignedTitle: null,
  };
  const startHead = getHeadSha(runtime.workingDirectory);
  const startDirty = hasUncommittedChanges(runtime.workingDirectory);

  let abortedForNoTask = false;
  let abortedForTimeout = false;
  let stderrText = "";

  const maybeAbortNoTask = (): void => {
    if (!signals.sawNoTasks || signals.sawTaskAssignment || signals.sawTaskMutation) {
      return;
    }
    if (!child.killed) {
      abortedForNoTask = true;
      child.kill("SIGTERM");
    }
  };

  const timeoutHandle = setTimeout(() => {
    abortedForTimeout = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 1500);
  }, config.workerTimeoutMs);

  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    stderrText = `${stderrText}${text}`.slice(-4000);
    dashboard.markWorkerEvent(workerId, `Claude stderr: ${truncatePlain(text.trim(), 90)}`, {
      bump: 1,
      logEvent: false,
      minProgress: 10,
    });
  });

  const stdoutLines = readline.createInterface({ input: child.stdout });
  stdoutLines.on("line", (line) => {
    if (!line.trim()) {
      return;
    }
    let combined = line;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      combined = stringifyUnknown(parsed);
      dashboard.markWorkerEvent(workerId, summarizeClaudeStreamEvent(parsed), {
        bump: 2,
        minProgress: 15,
      });
    } catch {
      dashboard.markWorkerEvent(workerId, `Claude output: ${truncatePlain(line, 80)}`, {
        bump: 1,
        minProgress: 15,
      });
    }

    trackSignals(combined, signals);
    detectClaudeToolSignals(combined, signals, workerId, dashboard);
    const assignment = extractAssignment(combined);
    if (assignment) {
      signals.assignedNodeId = assignment.nodeId;
      signals.assignedTitle = assignment.title;
      dashboard.markWorkerEvent(workerId, `Assigned ${assignment.nodeId} - ${truncatePlain(assignment.title, 48)}`, {
        bump: 6,
        minProgress: 45,
        logEvent: true,
      });
    }
    maybeAbortNoTask();
  });

  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    });
  } catch (error) {
    clearTimeout(timeoutHandle);
    const details = error instanceof Error ? error.message : String(error);
    return {
      kind: "ERROR",
      workerId,
      details: truncatePlain(`Failed to launch Claude process: ${details}`, 160),
    };
  }
  clearTimeout(timeoutHandle);

  if (!signals.sawFileChange && signals.sawTaskAssignment && !startDirty && hasUncommittedChanges(runtime.workingDirectory)) {
    signals.sawFileChange = true;
    dashboard.markWorkerEvent(workerId, "Detected workspace file changes", {
      bump: 8,
      minProgress: 75,
      logEvent: true,
      logLevel: "success",
    });
  }

  if (config.commitPerNode && signals.sawTaskAssignment && signals.sawFileChange) {
    const endHead = getHeadSha(runtime.workingDirectory);
    if (endHead === startHead && hasUncommittedChanges(runtime.workingDirectory)) {
      const nodeId = signals.assignedNodeId ?? "unknown-node";
      const title = signals.assignedTitle?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ?? "task";
      const shortTitle = truncatePlain(title || "task", 50);
      const message = `node(${nodeId}): ${shortTitle}`;

      try {
        const sha = commitAllChanges(runtime.workingDirectory, message);
        dashboard.markWorkerEvent(workerId, `Runner auto-committed ${sha.slice(0, 8)} for ${nodeId}`, {
          logEvent: true,
          logLevel: "success",
          minProgress: 94,
          bump: 8,
        });
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        dashboard.markWorkerEvent(workerId, `Runner could not auto-commit: ${truncatePlain(details, 110)}`, {
          logEvent: true,
          logLevel: "warn",
          minProgress: 94,
          bump: 2,
        });
      }
    }
  }

  if (abortedForNoTask || (signals.sawNoTasks && !signals.sawTaskAssignment && !signals.sawTaskMutation)) {
    return {
      kind: "NO_TASKS_AVAILABLE",
      workerId,
      details: "No claimable tasks available",
    };
  }

  if (abortedForTimeout) {
    return {
      kind: "ERROR",
      workerId,
      details: `Worker timed out after ${config.workerTimeoutMs}ms`,
    };
  }

  if (signals.sawProjectInactive) {
    return {
      kind: "PROJECT_INACTIVE",
      workerId,
      details: "Project reported as not ACTIVE",
    };
  }

  if ((exitCode ?? 1) !== 0) {
    const detail = stderrText.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? `Claude exited with code ${exitCode}`;
    return {
      kind: "ERROR",
      workerId,
      details: truncatePlain(detail, 160),
    };
  }

  return {
    kind: "ACTIVITY",
    workerId,
    details: signals.sawTaskMutation
      ? "Claimed and updated ATP graph"
      : signals.sawTaskAssignment
        ? "Claimed ATP work and progressed execution"
        : "Completed worker turn",
  };
}

async function runOneTask(
  config: RunnerConfig,
  promptTemplate: string,
  runtime: WorkerRuntime,
  dashboard: RunnerDashboard,
): Promise<WorkerOutcome> {
  if (config.agentProvider === "claude") {
    return runOneTaskClaude(config, promptTemplate, runtime, dashboard);
  }
  return runOneTaskCodex(config, promptTemplate, runtime, dashboard);
}

async function main(): Promise<void> {
  let config = resolveConfig(process.argv.slice(2));
  if (!config) {
    return;
  }
  try {
    config = await runOnboarding(config);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    console.error(details);
    return;
  }

  ensureConfigIsValid(config);
  const promptTemplate = fs.readFileSync(config.promptFile, "utf-8");

  const dashboard = new RunnerDashboard(config);

  let stopMessage = "Runner stopped.";
  let exiting = false;

  const handleSignal = (signal: NodeJS.Signals): void => {
    stopMessage = `Received ${signal}. Exiting.`;
    exiting = true;
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  try {
    dashboard.start();
    const createdMemoryFiles = ensureProjectMemoryArtifacts(config.projectRoot);
    dashboard.logRunner(`Project root: ${config.projectRoot}`);
    dashboard.logRunner(`ATP file: ${config.atpFile}`);
    dashboard.logRunner(`Prompt: ${config.promptFile}`);
    dashboard.logRunner(`Agent provider: ${config.agentProvider}`);
    dashboard.logRunner(
      config.agentProvider === "codex"
        ? `Model: ${config.model} (${config.reasoningEffort})`
        : `Model: ${config.model}`,
    );
    dashboard.logRunner(
      config.agentProvider === "codex"
        ? `Sandbox: ${config.sandboxMode}`
        : `Claude CLI: ${config.claudeBinary} (permission-mode=bypassPermissions)`,
    );
    dashboard.logRunner(`Parallel workers: ${config.workers}`);
    dashboard.logRunner(`Commit per node: ${config.commitPerNode ? "enabled" : "disabled"}`);
    dashboard.logRunner(`Web search mode: ${config.webSearchMode}`);
    dashboard.logRunner(`Worker timeout: ${config.workerTimeoutMs}ms`);
    if (config.workers > 1) {
      dashboard.logRunner(
        "Parallel mode is enabled. Use strict node boundaries or expect merge conflicts on shared files.",
        "warn",
      );
    }
    if (createdMemoryFiles.length > 0) {
      dashboard.logRunner(`Bootstrapped shared memory in project root (${createdMemoryFiles.length} files).`, "success");
    } else {
      dashboard.logRunner("Shared memory already present in project root.", "info");
    }
    const workerRuntimes = prepareWorkerRuntimes(config);

    let idleRounds = 0;
    let allErrorRounds = 0;
    let round = 0;

    while (!exiting) {
      round += 1;
      dashboard.beginRound(round, idleRounds, allErrorRounds);

      const outcomes = await Promise.all(
        workerRuntimes.map((runtime) => runOneTask(config, promptTemplate, runtime, dashboard)),
      );

      outcomes.forEach((outcome) => {
        dashboard.markWorkerOutcome(outcome);
      });

      const summary = summarizeOutcomes(outcomes);
      if (summary.PROJECT_INACTIVE > 0) {
        stopMessage = "Project is not ACTIVE. Stopping runner.";
      }

      if (summary.ACTIVITY > 0) {
        idleRounds = 0;
      } else if (summary.NO_TASKS_AVAILABLE === config.workers) {
        idleRounds += 1;
      } else {
        idleRounds = 0;
      }

      if (summary.ERROR === config.workers) {
        allErrorRounds += 1;
      } else {
        allErrorRounds = 0;
      }

      dashboard.finishRound(summary, idleRounds, allErrorRounds);

      if (summary.PROJECT_INACTIVE > 0) {
        break;
      }

      if (idleRounds >= config.maxIdleRounds) {
        stopMessage = `Reached max idle rounds (${config.maxIdleRounds}). Exiting cleanly.`;
        break;
      }

      if (allErrorRounds >= config.maxErrorRounds) {
        throw new Error(
          `All workers failed for ${config.maxErrorRounds} consecutive rounds. Aborting to avoid a tight failure loop.`,
        );
      }

      await sleep(config.pollIntervalMs);
    }
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    dashboard.stop(stopMessage);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    if (process.stdout.isTTY) {
      process.stdout.write(CURSOR_SHOW);
    }
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
