import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";

import { Liquid } from "liquidjs";
import YAML from "yaml";

export type WorkflowConfigMap = Record<string, unknown>;

export interface WorkflowDefinition {
  config: WorkflowConfigMap;
  promptTemplate: string;
}

export interface LoadWorkflowDefinitionOptions {
  workflowPath: string;
}

export interface TrackerConfig {
  kind: string;
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  activeStates: string[];
  terminalStates: string[];
}

export interface PollingConfig {
  intervalMs: number;
}

export interface WorkspaceConfig {
  root: string;
}

export interface HookConfig {
  afterCreate?: string | undefined;
  beforeRun?: string | undefined;
  afterRun?: string | undefined;
  beforeRemove?: string | undefined;
  timeoutMs: number;
}

export interface AgentConfig {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: Record<string, number>;
}

export interface CodexConfig {
  command: string;
  approvalPolicy?: unknown;
  threadSandbox?: unknown;
  turnSandboxPolicy?: unknown;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
}

export interface EffectiveWorkflowConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HookConfig;
  agent: AgentConfig;
  codex: CodexConfig;
}

export type ValidationResult =
  | { ok: true; config: EffectiveWorkflowConfig }
  | { ok: false; errors: string[] };

export class WorkflowError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "WorkflowError";
  }
}

const DEFAULT_PROMPT = "You are working on an issue from Linear.";
const DEFAULT_TRACKER_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];
const DEFAULT_POLL_INTERVAL_MS = 30000;
const DEFAULT_HOOK_TIMEOUT_MS = 60000;
const DEFAULT_MAX_CONCURRENT_AGENTS = 10;
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_RETRY_BACKOFF_MS = 300000;
const DEFAULT_CODEX_COMMAND = "codex app-server";
const DEFAULT_TURN_TIMEOUT_MS = 3600000;
const DEFAULT_READ_TIMEOUT_MS = 5000;
const DEFAULT_STALL_TIMEOUT_MS = 300000;
const DEFAULT_WORKSPACE_ROOT = join(tmpdir(), "symphony_workspaces");

const liquidEngine = new Liquid({
  strictFilters: true,
  strictVariables: true
});

export async function loadWorkflowDefinition(
  options: LoadWorkflowDefinitionOptions
): Promise<WorkflowDefinition> {
  let contents: string;
  try {
    contents = await readFile(options.workflowPath, "utf8");
  } catch (error) {
    throw new WorkflowError(
      "missing_workflow_file",
      `Unable to read workflow file at ${options.workflowPath}`,
      { cause: error }
    );
  }

  return parseWorkflowDefinition(contents);
}

export async function loadWorkflowDefinitionFromPathOrCwd(options: {
  workflowPath?: string;
  cwd: string;
}): Promise<WorkflowDefinition> {
  const workflowPath = options.workflowPath ?? resolve(options.cwd, "WORKFLOW.md");
  return loadWorkflowDefinition({ workflowPath });
}

export function parseWorkflowDefinition(contents: string): WorkflowDefinition {
  if (!contents.startsWith("---")) {
    return {
      config: {},
      promptTemplate: contents.trim()
    };
  }

  const closingIndex = contents.indexOf("\n---", 3);
  if (closingIndex === -1) {
    throw new WorkflowError(
      "workflow_parse_error",
      "Workflow front matter is missing a closing delimiter."
    );
  }

  const yamlSource = contents.slice(4, closingIndex);
  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlSource);
  } catch (error) {
    throw new WorkflowError("workflow_parse_error", "Failed to parse workflow YAML.", {
      cause: error
    });
  }

  if (parsed == null) {
    parsed = {};
  }

  if (!isPlainObject(parsed)) {
    throw new WorkflowError(
      "workflow_front_matter_not_a_map",
      "Workflow front matter must decode to an object."
    );
  }

  const promptBody = contents.slice(closingIndex + 4).trim();

  return {
    config: parsed,
    promptTemplate: promptBody
  };
}

export function validateWorkflowForDispatch(definition: WorkflowDefinition): ValidationResult {
  const config = definition.config;
  const trackerConfig = objectAt(config, "tracker");
  const pollingConfig = objectAt(config, "polling");
  const workspaceConfig = objectAt(config, "workspace");
  const hooksConfig = objectAt(config, "hooks");
  const agentConfig = objectAt(config, "agent");
  const codexConfig = objectAt(config, "codex");

  const effectiveConfig: EffectiveWorkflowConfig = {
    tracker: {
      kind: stringAt(trackerConfig, "kind") ?? "",
      endpoint: stringAt(trackerConfig, "endpoint") ?? DEFAULT_TRACKER_ENDPOINT,
      apiKey: resolveTrackerApiKey(trackerConfig),
      projectSlug: stringAt(trackerConfig, "project_slug") ?? "",
      activeStates: stringListAt(trackerConfig, "active_states") ?? DEFAULT_ACTIVE_STATES,
      terminalStates: stringListAt(trackerConfig, "terminal_states") ?? DEFAULT_TERMINAL_STATES
    },
    polling: {
      intervalMs: positiveIntegerLike(stringOrNumberAt(pollingConfig, "interval_ms")) ?? DEFAULT_POLL_INTERVAL_MS
    },
    workspace: {
      root: normalizeWorkspaceRoot(stringAt(workspaceConfig, "root"))
    },
    hooks: {
      afterCreate: stringAt(hooksConfig, "after_create"),
      beforeRun: stringAt(hooksConfig, "before_run"),
      afterRun: stringAt(hooksConfig, "after_run"),
      beforeRemove: stringAt(hooksConfig, "before_remove"),
      timeoutMs: positiveIntegerLike(stringOrNumberAt(hooksConfig, "timeout_ms")) ?? DEFAULT_HOOK_TIMEOUT_MS
    },
    agent: {
      maxConcurrentAgents:
        positiveIntegerLike(stringOrNumberAt(agentConfig, "max_concurrent_agents")) ??
        DEFAULT_MAX_CONCURRENT_AGENTS,
      maxTurns: positiveIntegerLike(stringOrNumberAt(agentConfig, "max_turns")) ?? DEFAULT_MAX_TURNS,
      maxRetryBackoffMs:
        positiveIntegerLike(stringOrNumberAt(agentConfig, "max_retry_backoff_ms")) ??
        DEFAULT_MAX_RETRY_BACKOFF_MS,
      maxConcurrentAgentsByState: normalizePerStateLimits(
        objectAt(agentConfig, "max_concurrent_agents_by_state")
      )
    },
    codex: {
      command: stringAt(codexConfig, "command")?.trim() || DEFAULT_CODEX_COMMAND,
      approvalPolicy: codexConfig.approval_policy,
      threadSandbox: codexConfig.thread_sandbox,
      turnSandboxPolicy: codexConfig.turn_sandbox_policy,
      turnTimeoutMs:
        positiveIntegerLike(stringOrNumberAt(codexConfig, "turn_timeout_ms")) ??
        DEFAULT_TURN_TIMEOUT_MS,
      readTimeoutMs:
        positiveIntegerLike(stringOrNumberAt(codexConfig, "read_timeout_ms")) ??
        DEFAULT_READ_TIMEOUT_MS,
      stallTimeoutMs: integerLike(stringOrNumberAt(codexConfig, "stall_timeout_ms")) ?? DEFAULT_STALL_TIMEOUT_MS
    }
  };

  const errors: string[] = [];

  if (!effectiveConfig.tracker.kind) {
    errors.push("tracker.kind is required");
  } else if (effectiveConfig.tracker.kind !== "linear") {
    errors.push("tracker.kind must be 'linear'");
  }

  if (!effectiveConfig.tracker.apiKey) {
    errors.push("tracker.api_key is required");
  }

  if (!effectiveConfig.tracker.projectSlug) {
    errors.push("tracker.project_slug is required");
  }

  if (!effectiveConfig.codex.command) {
    errors.push("codex.command is required");
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, config: effectiveConfig };
}

export async function renderPromptTemplate(
  definition: WorkflowDefinition,
  context: Record<string, unknown>
): Promise<string> {
  const template = definition.promptTemplate || DEFAULT_PROMPT;
  try {
    return await liquidEngine.parseAndRender(template, context);
  } catch (error) {
    throw new WorkflowError("template_render_error", "Failed to render workflow prompt template.", {
      cause: error
    });
  }
}

function resolveTrackerApiKey(config: Record<string, unknown>): string {
  const explicit = stringAt(config, "api_key");
  if (!explicit || explicit === "$LINEAR_API_KEY") {
    return process.env.LINEAR_API_KEY?.trim() ?? "";
  }

  if (explicit.startsWith("$")) {
    return process.env[explicit.slice(1)]?.trim() ?? "";
  }

  return explicit.trim();
}

function normalizeWorkspaceRoot(value: string | undefined): string {
  if (!value) {
    return DEFAULT_WORKSPACE_ROOT;
  }

  const resolvedEnv = value.startsWith("$") ? process.env[value.slice(1)]?.trim() || "" : value;
  if (!resolvedEnv) {
    return DEFAULT_WORKSPACE_ROOT;
  }

  const expandedHome = resolvedEnv.startsWith("~")
    ? join(homedir(), resolvedEnv.slice(1))
    : resolvedEnv;

  if (!looksLikePath(expandedHome)) {
    return expandedHome;
  }

  return isAbsolute(expandedHome) ? normalize(expandedHome) : normalize(expandedHome);
}

function normalizePerStateLimits(
  value: Record<string, unknown>
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const parsed = positiveIntegerLike(raw);
    if (parsed) {
      result[key.toLowerCase()] = parsed;
    }
  }
  return result;
}

function objectAt(value: unknown, key: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    return {};
  }

  const nested = value[key];
  return isPlainObject(nested) ? nested : {};
}

function stringAt(value: Record<string, unknown>, key: string): string | undefined {
  const nested = value[key];
  return typeof nested === "string" ? nested : undefined;
}

function stringListAt(value: Record<string, unknown>, key: string): string[] | undefined {
  const nested = value[key];
  if (!Array.isArray(nested)) {
    return undefined;
  }

  const items = nested.filter((item): item is string => typeof item === "string");
  return items.length === nested.length ? items : undefined;
}

function stringOrNumberAt(value: Record<string, unknown>, key: string): string | number | undefined {
  const nested = value[key];
  return typeof nested === "string" || typeof nested === "number" ? nested : undefined;
}

function positiveIntegerLike(value: unknown): number | undefined {
  const parsed = integerLike(value);
  return parsed && parsed > 0 ? parsed : undefined;
}

function integerLike(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }

  return undefined;
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
