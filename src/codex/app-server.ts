import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";

import {
  createStructuredLogger,
  type StructuredLogger,
} from "../observability/structured-logger.js";
import {
  LinearTrackerClient,
  TrackerError,
  type LinearComment,
} from "../tracker/linear-client.js";

export interface CodexRuntimeEvent {
  event: string;
  timestamp: string;
  sessionId?: string | undefined;
  codexAppServerPid?: number | undefined;
  usage?: Record<string, number> | undefined;
  message?: string | undefined;
  payload?: unknown;
}

export interface CodexAppServerClientOptions {
  command: string;
  workspacePath: string;
  approvalPolicy: unknown;
  threadSandbox: unknown;
  turnSandboxPolicy: unknown;
  readTimeoutMs: number;
  turnTimeoutMs: number;
  clientInfo?: {
    name: string;
    version: string;
  };
  linearGraphql?: {
    endpoint: string;
    apiKey: string;
    projectSlug?: string;
    fetchFn?: typeof fetch;
  };
  logger?: StructuredLogger;
  onEvent?: (event: CodexRuntimeEvent) => void;
}

export interface CodexTurnResult {
  outcome: "completed";
  threadId: string;
  turnId: string;
  sessionId: string;
  completionComment?: LinearComment | undefined;
}

export class CodexAppServerError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "CodexAppServerError";
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

interface CurrentTurn {
  threadId: string;
  turnId: string;
  sessionId: string;
  completionComment?: LinearComment | undefined;
  pendingToolCalls: number;
  completionPending: boolean;
  pendingCompletionPayload?: unknown;
  resolve: (result: CodexTurnResult) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

export class CodexAppServerClient {
  private readonly options: CodexAppServerClientOptions;
  private readonly logger: StructuredLogger;
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private nextRequestId = 1;
  private pendingRequests = new Map<string | number, PendingRequest>();
  private currentTurn: CurrentTurn | null = null;
  private threadId: string | null = null;
  private turnStartPending = false;
  private bufferedTurnMessages: any[] = [];

  constructor(options: CodexAppServerClientOptions) {
    this.options = options;
    this.logger = options.logger ?? createStructuredLogger();
  }

  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    const workspacePath = resolve(this.options.workspacePath);
    const child = spawn("bash", ["-lc", this.options.command], {
      cwd: workspacePath,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.logger.info("codex app-server starting", {
      workspace_path: workspacePath,
    });

    this.process = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      this.handleStdoutChunk(chunk);
    });

    child.stderr.on("data", (chunk: string) => {
      // Stderr is observability-only and intentionally not parsed as protocol JSON.
      const normalized = chunk.trim();
      if (!normalized) {
        return;
      }

      this.logger.warn("codex app-server stderr", {
        chunk: normalized,
      });
    });

    child.on("error", (error) => {
      this.logger.error("codex app-server start failed", {
        reason: error.message,
      });
      this.rejectPending(
        new CodexAppServerError(
          "codex_not_found",
          "Failed to start codex app-server.",
          {
            cause: error,
          },
        ),
      );
    });

    child.on("exit", () => {
      this.logger.warn("codex app-server exited", {});
      this.rejectPending(
        new CodexAppServerError(
          "port_exit",
          "Codex app-server exited unexpectedly.",
        ),
      );
    });

    try {
      await this.request("initialize", {
        clientInfo: this.options.clientInfo ?? {
          name: "symphony-ts",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      this.notify("initialized", {});
      const threadResult = await this.request("thread/start", {
        approvalPolicy: this.options.approvalPolicy,
        sandbox: this.options.threadSandbox,
        cwd: workspacePath,
        dynamicTools: this.options.linearGraphql
          ? buildLinearDynamicToolSpecs()
          : undefined,
        tools: this.options.linearGraphql
          ? buildLegacyLinearToolSpecs()
          : undefined,
      });

      const threadId = readNestedString(threadResult, ["thread", "id"]);
      if (!threadId) {
        throw new CodexAppServerError(
          "response_error",
          "thread/start did not return thread id.",
        );
      }
      this.threadId = threadId;
      this.logger.info("codex app-server ready", {
        thread_id: threadId,
      });
    } catch (error) {
      this.emit({
        event: "startup_failed",
        payload: error,
      });
      throw error;
    }
  }

  async runTurn(input: {
    prompt: string;
    title: string;
  }): Promise<CodexTurnResult> {
    if (!this.process || !this.threadId) {
      throw new CodexAppServerError(
        "response_error",
        "Codex app-server session has not been started.",
      );
    }

    if (this.currentTurn) {
      throw new CodexAppServerError(
        "response_error",
        "A turn is already in progress.",
      );
    }

    this.turnStartPending = true;
    this.logger.info("codex turn starting", {
      thread_id: this.threadId,
      title: input.title,
    });
    const turnResult = await this.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: input.prompt }],
      cwd: resolve(this.options.workspacePath),
      title: input.title,
      approvalPolicy: this.options.approvalPolicy,
      sandboxPolicy: this.options.turnSandboxPolicy,
    });

    const turnId = readNestedString(turnResult, ["turn", "id"]);
    if (!turnId) {
      throw new CodexAppServerError(
        "response_error",
        "turn/start did not return turn id.",
      );
    }

    const sessionId = `${this.threadId}-${turnId}`;

    return new Promise<CodexTurnResult>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        if (this.currentTurn?.sessionId === sessionId) {
          this.currentTurn = null;
        }
        rejectPromise(
          new CodexAppServerError(
            "turn_timeout",
            `Turn timed out after ${this.options.turnTimeoutMs}ms.`,
          ),
        );
      }, this.options.turnTimeoutMs);

      this.currentTurn = {
        threadId: this.threadId!,
        turnId,
        sessionId,
        pendingToolCalls: 0,
        completionPending: false,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      };

      this.emit({
        event: "session_started",
        sessionId,
        payload: {
          threadId: this.threadId,
          turnId,
        },
      });
      this.logger.info("codex turn started", {
        session_id: sessionId,
        thread_id: this.threadId,
        turn_id: turnId,
      });

      this.turnStartPending = false;
      const bufferedMessages = this.bufferedTurnMessages;
      this.bufferedTurnMessages = [];
      for (const message of bufferedMessages) {
        this.handleProtocolMessage(message);
      }
    });
  }

  async stop(): Promise<void> {
    const child = this.process;
    this.process = null;
    this.threadId = null;
    if (!child) {
      return;
    }

    if (!child.killed) {
      this.logger.info("codex app-server stopping", {
        pid: child.pid,
      });
      child.kill("SIGTERM");
    }
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        this.logger.warn("codex malformed stdout line", {
          line,
        });
        this.emit({
          event: "malformed",
          message: line,
        });
        continue;
      }

      if (
        message.id != null &&
        this.pendingRequests.has(message.id) &&
        ("result" in message || "error" in message)
      ) {
        const pending = this.pendingRequests.get(message.id)!;
        this.pendingRequests.delete(message.id);
        clearTimeout(pending.timer);
        if ("error" in message) {
          pending.reject(
            new CodexAppServerError(
              "response_error",
              "Codex returned response error.",
              { cause: message.error },
            ),
          );
        } else {
          pending.resolve(message.result);
        }
        continue;
      }

      this.handleProtocolMessage(message);
    }
  }

  private handleProtocolMessage(message: any): void {
    const method = typeof message.method === "string" ? message.method : "";

    if (this.turnStartPending && method) {
      this.bufferedTurnMessages.push(message);
      return;
    }

    if (method === "approval/request" && message.id != null) {
      this.send({
        id: message.id,
        result: {
          approved: true,
        },
      });
      this.logger.info("codex approval auto approved", {});
      this.emit({
        event: "approval_auto_approved",
        payload: message.params,
      });
      return;
    }

    if (method === "item/tool/call" && message.id != null) {
      const toolName = readToolCallName(message.params);
      const toolArguments = readToolCallArguments(message.params);

      if (toolName === "linear_graphql" && this.options.linearGraphql) {
        void this.handleLinearGraphqlToolCall(message);
        return;
      }

      if (
        toolName === "linear_add_issue_comment" &&
        this.options.linearGraphql
      ) {
        void this.handleLinearAddIssueCommentToolCall(message);
        return;
      }

      this.send({
        id: message.id,
        result: buildDynamicToolResponse({
          success: false,
          error: "unsupported_tool_call",
        }),
      });
      this.logger.warn("codex unsupported tool call", {
        tool_name: toolName ?? "unknown",
      });
      this.emit({
        event: "unsupported_tool_call",
        payload: {
          ...message.params,
          arguments: toolArguments,
          tool: toolName,
        },
      });
      return;
    }

    if (method === "item/tool/requestUserInput") {
      this.logger.error("codex turn requested user input", {});
      this.emit({
        event: "turn_input_required",
        payload: message.params,
      });
      const currentTurn = this.currentTurn;
      if (currentTurn) {
        clearTimeout(currentTurn.timer);
        this.currentTurn = null;
        currentTurn.reject(
          new CodexAppServerError(
            "turn_input_required",
            "Codex requested user input.",
          ),
        );
      }
      return;
    }

    if (method === "turn/completed") {
      const currentTurn = this.currentTurn;
      if (!currentTurn) {
        return;
      }

      if (currentTurn.pendingToolCalls > 0) {
        currentTurn.completionPending = true;
        currentTurn.pendingCompletionPayload = message.params;
        return;
      }

      this.completeCurrentTurn(currentTurn, message.params);
      return;
    }

    if (method === "turn/failed" || method === "turn/cancelled") {
      const currentTurn = this.currentTurn;
      if (!currentTurn) {
        return;
      }

      clearTimeout(currentTurn.timer);
      this.currentTurn = null;
      const code = method === "turn/failed" ? "turn_failed" : "turn_cancelled";
      this.logger.warn("codex turn ended without completion", {
        code,
        session_id: currentTurn.sessionId,
      });
      this.emit({
        event: code,
        sessionId: currentTurn.sessionId,
        payload: message.params,
      });
      currentTurn.reject(new CodexAppServerError(code, `Codex ${method}.`));
      return;
    }

    this.emit({
      event: method === "notification" ? "notification" : "other_message",
      message: summarizeProtocolMessage(method, message.params ?? message),
      payload: message.params ?? message,
    });
  }

  private request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = this.nextRequestId++;
    this.send({ id, method, params });

    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        rejectPromise(
          new CodexAppServerError(
            "response_timeout",
            `${method} timed out after ${this.options.readTimeoutMs}ms.`,
          ),
        );
      }, this.options.readTimeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  private send(message: Record<string, unknown>): void {
    if (!this.process) {
      throw new CodexAppServerError(
        "port_exit",
        "Codex app-server process is not running.",
      );
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectPending(error: CodexAppServerError): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();

    if (this.currentTurn) {
      clearTimeout(this.currentTurn.timer);
      this.currentTurn.reject(error);
      this.currentTurn = null;
    }
  }

  private emit(
    event: Omit<CodexRuntimeEvent, "timestamp" | "codexAppServerPid">,
  ): void {
    this.options.onEvent?.({
      timestamp: new Date().toISOString(),
      codexAppServerPid: this.process?.pid,
      ...event,
    });
  }

  private async handleLinearGraphqlToolCall(message: any): Promise<void> {
    const toolConfig = this.options.linearGraphql;
    if (!toolConfig) {
      return;
    }

    this.beginTurnToolCall();
    const result = await executeLinearGraphqlToolCall(
      message.params?.arguments,
      toolConfig,
    );
    this.send({
      id: message.id,
      result: buildDynamicToolResponse(result),
    });
    if (result.success === true) {
      this.logger.info("linear graphql tool executed", {});
    } else {
      this.logger.warn("linear graphql tool failed", {
        error_code:
          typeof result.error === "object" &&
          result.error !== null &&
          "code" in result.error &&
          typeof result.error.code === "string"
            ? result.error.code
            : "unknown",
      });
    }
    this.emit({
      event:
        result.success === true
          ? "linear_graphql_executed"
          : "linear_graphql_failed",
      payload: result,
    });
    this.finishTurnToolCall();
  }

  private async handleLinearAddIssueCommentToolCall(
    message: any,
  ): Promise<void> {
    const toolConfig = this.options.linearGraphql;
    if (!toolConfig) {
      return;
    }

    this.beginTurnToolCall();
    const result = await executeLinearAddIssueCommentToolCall(
      message.params?.arguments,
      toolConfig,
    );
    this.send({
      id: message.id,
      result: buildDynamicToolResponse(result),
    });
    if (result.success === true) {
      const currentTurn = this.currentTurn;
      if (currentTurn) {
        currentTurn.completionComment = result.comment;
      }
      this.logger.info("linear issue comment created", {
        comment_id: result.comment.id,
      });
    } else {
      this.logger.warn("linear issue comment failed", {
        error_code:
          typeof result.error === "object" &&
          result.error !== null &&
          "code" in result.error &&
          typeof result.error.code === "string"
            ? result.error.code
            : "unknown",
      });
    }
    this.emit({
      event:
        result.success === true
          ? "linear_issue_comment_created"
          : "linear_issue_comment_failed",
      payload: result,
    });
    this.finishTurnToolCall();
  }

  private beginTurnToolCall(): void {
    if (this.currentTurn) {
      this.currentTurn.pendingToolCalls += 1;
    }
  }

  private finishTurnToolCall(): void {
    const currentTurn = this.currentTurn;
    if (!currentTurn) {
      return;
    }

    currentTurn.pendingToolCalls = Math.max(
      0,
      currentTurn.pendingToolCalls - 1,
    );
    if (currentTurn.pendingToolCalls === 0 && currentTurn.completionPending) {
      const completionPayload = currentTurn.pendingCompletionPayload;
      currentTurn.completionPending = false;
      currentTurn.pendingCompletionPayload = undefined;
      this.completeCurrentTurn(currentTurn, completionPayload);
    }
  }

  private completeCurrentTurn(
    currentTurn: CurrentTurn,
    payload: unknown,
  ): void {
    clearTimeout(currentTurn.timer);
    this.currentTurn = null;
    this.emit({
      event: "turn_completed",
      sessionId: currentTurn.sessionId,
      usage: extractUsage(payload),
      payload,
    });
    this.logger.info("codex turn completed", {
      session_id: currentTurn.sessionId,
    });
    currentTurn.resolve({
      outcome: "completed",
      threadId: currentTurn.threadId,
      turnId: currentTurn.turnId,
      sessionId: currentTurn.sessionId,
      completionComment: currentTurn.completionComment,
    });
  }
}

function readNestedString(value: unknown, path: string[]): string | null {
  let current: any = value;
  for (const part of path) {
    if (current == null || typeof current !== "object" || !(part in current)) {
      return null;
    }
    current = current[part];
  }
  return typeof current === "string" ? current : null;
}

function extractUsage(value: any): Record<string, number> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const usage = value.usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const result: Record<string, number> = {};
  for (const key of ["input_tokens", "output_tokens", "total_tokens"]) {
    if (typeof usage[key] === "number") {
      result[key] = usage[key];
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function summarizeProtocolMessage(
  method: string,
  payload: unknown,
): string | undefined {
  if (!method) {
    return undefined;
  }

  if (
    payload &&
    typeof payload === "object" &&
    "name" in payload &&
    typeof payload.name === "string"
  ) {
    return `${method}:${payload.name}`;
  }

  return method;
}

function readToolCallName(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const toolCall = payload as Record<string, unknown>;

  if (typeof toolCall.tool === "string") {
    return toolCall.tool;
  }

  if (typeof toolCall.name === "string") {
    return toolCall.name;
  }

  return null;
}

function readToolCallArguments(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  return (payload as Record<string, unknown>).arguments;
}

function buildDynamicToolResponse(result: Record<string, unknown>): Record<
  string,
  unknown
> & {
  contentItems: Array<{
    type: "inputText";
    text: string;
  }>;
  success: boolean;
} {
  return {
    ...result,
    contentItems: [
      {
        type: "inputText",
        text: summarizeDynamicToolResult(result),
      },
    ],
    success: result.success === true,
  };
}

function summarizeDynamicToolResult(result: Record<string, unknown>): string {
  if (result.success === true) {
    if (
      isPlainObject(result.comment) &&
      typeof result.comment.id === "string"
    ) {
      return `Created Linear comment ${result.comment.id}.`;
    }

    if (isPlainObject(result.body)) {
      return JSON.stringify(result.body);
    }

    return "Tool call completed successfully.";
  }

  const error = result.error;
  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (isPlainObject(error)) {
    const code =
      typeof error.code === "string" && error.code.trim() ? error.code : null;
    const message =
      typeof error.message === "string" && error.message.trim()
        ? error.message
        : null;
    if (code && message) {
      return `${code}: ${message}`;
    }
    if (message) {
      return message;
    }
    if (code) {
      return code;
    }
  }

  return "Tool call failed.";
}

function buildLegacyLinearToolSpecs(): Array<{
  name: string;
  description: string;
}> {
  return [
    {
      name: "linear_graphql",
      description: "Execute a single GraphQL operation against Linear.",
    },
    {
      name: "linear_add_issue_comment",
      description:
        "Create a Linear issue comment with a short completion summary.",
    },
  ];
}

function buildLinearDynamicToolSpecs(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return [
    {
      name: "linear_graphql",
      description: "Execute a single GraphQL operation against Linear.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "A single GraphQL query or mutation document.",
          },
          variables: {
            type: "object",
            description: "Optional GraphQL variables object.",
            additionalProperties: true,
          },
        },
      },
    },
    {
      name: "linear_add_issue_comment",
      description:
        "Create a Linear issue comment with a short completion summary.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["issueId", "body"],
        properties: {
          issueId: {
            type: "string",
            description: "The Linear issue id for the comment.",
          },
          body: {
            type: "string",
            description:
              "A short plain-text summary of what was completed and how it was validated.",
          },
        },
      },
    },
  ];
}

async function executeLinearGraphqlToolCall(
  input: unknown,
  config: NonNullable<CodexAppServerClientOptions["linearGraphql"]>,
): Promise<Record<string, unknown>> {
  const parsed = parseLinearGraphqlArguments(input);
  if (!parsed.ok) {
    return errorResult(parsed.error.code, parsed.error.message);
  }

  if (!config.endpoint.trim() || !config.apiKey.trim()) {
    return errorResult(
      "linear_graphql_missing_auth",
      "Linear GraphQL tool is not configured with endpoint and auth.",
    );
  }

  const fetchFn = config.fetchFn ?? fetch;

  try {
    const response = await fetchFn(config.endpoint, {
      method: "POST",
      headers: {
        Authorization: config.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: parsed.query,
        variables: parsed.variables,
      }),
    });
    const responseText = await response.text();

    if (!response.ok) {
      return errorResult(
        "linear_api_status",
        `Linear responded with HTTP ${response.status}.`,
        {
          status: response.status,
          body: responseText || null,
        },
      );
    }

    let body: unknown;
    try {
      body = responseText ? JSON.parse(responseText) : null;
    } catch {
      return errorResult(
        "linear_graphql_invalid_json_response",
        "Linear returned a non-JSON response body.",
      );
    }

    if (!isPlainObject(body)) {
      return errorResult(
        "linear_graphql_invalid_response",
        "Linear returned a malformed GraphQL response.",
      );
    }

    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      return {
        success: false,
        error: {
          code: "linear_graphql_errors",
          message: "Linear returned GraphQL errors.",
        },
        body,
      };
    }

    return {
      success: true,
      body,
    };
  } catch (error) {
    return errorResult(
      "linear_api_request",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function executeLinearAddIssueCommentToolCall(
  input: unknown,
  config: NonNullable<CodexAppServerClientOptions["linearGraphql"]>,
): Promise<
  | { success: true; comment: LinearComment }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    }
> {
  const parsed = parseLinearAddIssueCommentArguments(input);
  if (!parsed.ok) {
    return {
      success: false,
      error: parsed.error,
    };
  }

  if (!config.endpoint.trim() || !config.apiKey.trim()) {
    return {
      success: false,
      error: {
        code: "linear_graphql_missing_auth",
        message:
          "Linear GraphQL tool is not configured with endpoint and auth.",
      },
    };
  }

  try {
    const client = new LinearTrackerClient({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      projectSlug: config.projectSlug ?? "",
      ...(config.fetchFn ? { fetchFn: config.fetchFn } : {}),
    });
    const comment = await client.createIssueComment(
      parsed.issueId,
      parsed.body,
    );
    return {
      success: true,
      comment,
    };
  } catch (error) {
    if (error instanceof TrackerError) {
      return {
        success: false,
        error: {
          code: error.code,
          message: error.message,
        },
      };
    }

    return {
      success: false,
      error: {
        code: "linear_api_request",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function parseLinearGraphqlArguments(input: unknown):
  | { ok: true; query: string; variables: Record<string, unknown> }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    } {
  if (typeof input === "string") {
    const query = input.trim();
    return query
      ? { ok: true, query, variables: {} }
      : {
          ok: false,
          error: {
            code: "linear_graphql_invalid_input",
            message: "query must be a non-empty string.",
          },
        };
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error: {
        code: "linear_graphql_invalid_input",
        message:
          "tool input must be a query string or an object with query and variables.",
      },
    };
  }

  const extraKeys = Object.keys(input).filter(
    (key) => key !== "query" && key !== "variables",
  );
  if (extraKeys.length > 0) {
    return {
      ok: false,
      error: {
        code: "linear_graphql_invalid_input",
        message: `unexpected fields: ${extraKeys.join(", ")}`,
      },
    };
  }

  const query =
    typeof (input as { query?: unknown }).query === "string"
      ? (input as { query: string }).query.trim()
      : "";
  const variables = (input as { variables?: unknown }).variables;

  if (!query) {
    return {
      ok: false,
      error: {
        code: "linear_graphql_invalid_input",
        message: "query must be a non-empty string.",
      },
    };
  }

  if (variables != null && !isPlainObject(variables)) {
    return {
      ok: false,
      error: {
        code: "linear_graphql_invalid_input",
        message: "variables must be a JSON object when provided.",
      },
    };
  }

  const operationMatches = query.match(/\b(query|mutation|subscription)\b/g);
  if ((operationMatches?.length ?? 0) > 1) {
    return {
      ok: false,
      error: {
        code: "linear_graphql_multiple_operations",
        message: "query must contain exactly one GraphQL operation.",
      },
    };
  }

  return {
    ok: true,
    query,
    variables: (variables as Record<string, unknown> | undefined) ?? {},
  };
}

function parseLinearAddIssueCommentArguments(input: unknown):
  | { ok: true; issueId: string; body: string }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    } {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      error: {
        code: "linear_issue_comment_invalid_input",
        message: "tool input must be an object with issueId and body.",
      },
    };
  }

  const extraKeys = Object.keys(input).filter(
    (key) => key !== "issueId" && key !== "body",
  );
  if (extraKeys.length > 0) {
    return {
      ok: false,
      error: {
        code: "linear_issue_comment_invalid_input",
        message: `unexpected fields: ${extraKeys.join(", ")}`,
      },
    };
  }

  const issueId = typeof input.issueId === "string" ? input.issueId.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";

  if (!issueId) {
    return {
      ok: false,
      error: {
        code: "linear_issue_comment_invalid_input",
        message: "issueId must be a non-empty string.",
      },
    };
  }

  if (!body) {
    return {
      ok: false,
      error: {
        code: "linear_issue_comment_invalid_input",
        message: "body must be a non-empty string.",
      },
    };
  }

  return {
    ok: true,
    issueId,
    body,
  };
}

function errorResult(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    success: false,
    error: {
      code,
      message,
      ...extra,
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
