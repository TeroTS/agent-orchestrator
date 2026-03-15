import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

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
  issueDelivery?: {
    issueId: string;
    identifier: string;
    title: string;
    url: string | null;
    branchName: string | null;
    commandRunner?: DeliveryCommandRunner;
    readFileFn?: typeof readFile;
  };
  logger?: StructuredLogger;
  onEvent?: (event: CodexRuntimeEvent) => void;
}

export interface DeliveryCommandInput {
  command: string;
  args: string[];
  cwd: string;
}

export interface DeliveryCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type DeliveryCommandRunner = (
  input: DeliveryCommandInput,
) => Promise<DeliveryCommandResult>;

export interface TicketDeliveryResult {
  prUrl: string;
  commentId: string;
  branch: string;
  commitSha?: string | undefined;
}

type ToolErrorResult = {
  success: false;
  error: {
    code: string;
    message: string;
  };
};

export interface CodexTurnResult {
  outcome: "completed";
  threadId: string;
  turnId: string;
  sessionId: string;
  completionComment?: LinearComment | undefined;
  deliveryResult?: TicketDeliveryResult | undefined;
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
  deliveryResult?: TicketDeliveryResult | undefined;
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
          ? buildLinearDynamicToolSpecs(Boolean(this.options.issueDelivery))
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

      if (
        toolName === "complete_ticket_delivery" &&
        this.options.linearGraphql &&
        this.options.issueDelivery
      ) {
        void this.handleCompleteTicketDeliveryToolCall(message);
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

    const highSignalEvent = mapHighSignalProtocolEvent(
      method,
      message.params ?? message,
      this.currentTurn?.sessionId,
    );
    if (highSignalEvent) {
      this.emit(highSignalEvent);
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
      this.logger,
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
      this.logger,
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

  private async handleCompleteTicketDeliveryToolCall(
    message: any,
  ): Promise<void> {
    const toolConfig = this.options.linearGraphql;
    const deliveryConfig = this.options.issueDelivery;
    if (!toolConfig || !deliveryConfig) {
      return;
    }

    this.beginTurnToolCall();
    const result = await executeCompleteTicketDeliveryToolCall(
      message.params?.arguments,
      deliveryConfig,
      toolConfig,
      resolve(this.options.workspacePath),
      this.logger,
    );
    this.send({
      id: message.id,
      result: buildDynamicToolResponse(result),
    });
    if (result.success === true) {
      const currentTurn = this.currentTurn;
      if (currentTurn) {
        currentTurn.completionComment = result.comment;
        currentTurn.deliveryResult = result.delivery;
      }
      this.logger.info("ticket delivery completed", {
        branch: result.delivery.branch,
        comment_id: result.comment.id,
        pr_url: result.delivery.prUrl,
      });
    } else {
      this.logger.warn("ticket delivery failed", {
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
          ? "ticket_delivery_completed"
          : "ticket_delivery_failed",
      payload: result,
    });
    if (result.success !== true) {
      const currentTurn = this.currentTurn;
      if (currentTurn) {
        clearTimeout(currentTurn.timer);
        this.currentTurn = null;
        currentTurn.reject(
          new CodexAppServerError(result.error.code, result.error.message),
        );
      }
      return;
    }
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
      deliveryResult: currentTurn.deliveryResult,
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

function mapHighSignalProtocolEvent(
  method: string,
  payload: unknown,
  sessionId: string | undefined,
): Omit<CodexRuntimeEvent, "timestamp" | "codexAppServerPid"> | null {
  switch (method) {
    case "codex/event/task_started":
      return {
        event: "task_started",
        message: "Codex task started.",
        payload,
        sessionId,
      };
    case "codex/event/task_complete":
      return {
        event: "task_complete",
        message: "Codex task completed.",
        payload,
        sessionId,
      };
    case "codex/event/exec_command_begin":
      return {
        event: "exec_command_begin",
        message: summarizeExecCommandBegin(payload),
        payload,
        sessionId,
      };
    case "codex/event/exec_command_end":
      return {
        event: "exec_command_end",
        message: summarizeExecCommandEnd(payload),
        payload,
        sessionId,
      };
    case "codex/event/agent_message":
      return {
        event: "agent_message",
        message: summarizeAgentMessage(payload),
        payload,
        sessionId,
      };
    default:
      return null;
  }
}

function summarizeExecCommandBegin(payload: unknown): string {
  if (
    payload &&
    typeof payload === "object" &&
    "command" in payload &&
    typeof payload.command === "string" &&
    payload.command.trim()
  ) {
    return `Running command: ${payload.command.trim()}`;
  }

  return "Running command.";
}

function summarizeExecCommandEnd(payload: unknown): string {
  const command =
    payload &&
    typeof payload === "object" &&
    "command" in payload &&
    typeof payload.command === "string" &&
    payload.command.trim()
      ? payload.command.trim()
      : null;
  const exitCode =
    payload &&
    typeof payload === "object" &&
    "exit_code" in payload &&
    typeof payload.exit_code === "number"
      ? payload.exit_code
      : null;

  if (command && exitCode !== null) {
    return `Command finished with exit code ${exitCode}: ${command}`;
  }
  if (command) {
    return `Command finished: ${command}`;
  }
  if (exitCode !== null) {
    return `Command finished with exit code ${exitCode}.`;
  }

  return "Command finished.";
}

function summarizeAgentMessage(payload: unknown): string {
  if (
    payload &&
    typeof payload === "object" &&
    "message" in payload &&
    typeof payload.message === "string" &&
    payload.message.trim()
  ) {
    return payload.message.trim();
  }

  return "Agent update received.";
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

function buildLinearDynamicToolSpecs(includeTicketDelivery: boolean): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const specs: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> = [
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

  if (includeTicketDelivery) {
    specs.push({
      name: "complete_ticket_delivery",
      description:
        "Commit workspace changes, publish or update the GitHub pull request, and post the final Linear completion comment.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["summary"],
        properties: {
          summary: {
            type: "string",
            description: "A short plain-text summary of what changed.",
          },
          targeted_checks: {
            type: "array",
            description:
              "Additional targeted validation checks beyond ./scripts/verify.",
            items: {
              type: "string",
            },
          },
          validation: {
            type: "string",
            description:
              "Deprecated compatibility field for a single targeted check.",
          },
        },
      },
    });
  }

  return specs;
}

async function executeLinearGraphqlToolCall(
  input: unknown,
  config: NonNullable<CodexAppServerClientOptions["linearGraphql"]>,
  logger: StructuredLogger,
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
  const operationName = extractGraphqlOperationName(parsed.query);
  const startedAt = Date.now();

  logger.debug("linear graphql request", {
    endpoint: config.endpoint,
    graphql_query: parsed.query,
    graphql_variables: parsed.variables,
    operation_name: operationName,
  });

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
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      logger.debug("linear graphql request failed", {
        duration_ms: durationMs,
        endpoint: config.endpoint,
        error_code: "linear_api_status",
        error_message: `Linear responded with HTTP ${response.status}.`,
        operation_name: operationName,
        response_preview: previewGraphqlLogValue(responseText),
        status: response.status,
      });
      return errorResult(
        "linear_api_status",
        `Linear responded with HTTP ${response.status}.`,
      );
    }

    let body: unknown;
    try {
      body = responseText ? JSON.parse(responseText) : null;
    } catch {
      logger.debug("linear graphql request failed", {
        duration_ms: durationMs,
        endpoint: config.endpoint,
        error_code: "linear_graphql_invalid_json_response",
        error_message: "Linear returned a non-JSON response body.",
        operation_name: operationName,
        response_preview: previewGraphqlLogValue(responseText),
        status: response.status,
      });
      return errorResult(
        "linear_graphql_invalid_json_response",
        "Linear returned a non-JSON response body.",
      );
    }

    if (!isPlainObject(body)) {
      logger.debug("linear graphql request failed", {
        duration_ms: durationMs,
        endpoint: config.endpoint,
        error_code: "linear_graphql_invalid_response",
        error_message: "Linear returned a malformed GraphQL response.",
        operation_name: operationName,
        response_preview: previewGraphqlLogValue(responseText),
        status: response.status,
      });
      return errorResult(
        "linear_graphql_invalid_response",
        "Linear returned a malformed GraphQL response.",
      );
    }

    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      logger.debug("linear graphql request failed", {
        duration_ms: durationMs,
        endpoint: config.endpoint,
        error_code: "linear_graphql_errors",
        error_message: "Linear returned GraphQL errors.",
        graphql_errors: body.errors,
        operation_name: operationName,
        response_preview: previewGraphqlLogValue(responseText),
        status: response.status,
      });
      return {
        success: false,
        error: {
          code: "linear_graphql_errors",
          message: "Linear returned GraphQL errors.",
        },
        body,
      };
    }

    logger.debug("linear graphql request succeeded", {
      duration_ms: durationMs,
      endpoint: config.endpoint,
      operation_name: operationName,
      response_preview: previewGraphqlLogValue(responseText),
      status: response.status,
    });

    return {
      success: true,
      body,
    };
  } catch (error) {
    logger.debug("linear graphql request failed", {
      duration_ms: Date.now() - startedAt,
      endpoint: config.endpoint,
      error_code: "linear_api_request",
      error_message: error instanceof Error ? error.message : String(error),
      operation_name: operationName,
    });
    return errorResult(
      "linear_api_request",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function executeLinearAddIssueCommentToolCall(
  input: unknown,
  config: NonNullable<CodexAppServerClientOptions["linearGraphql"]>,
  logger: StructuredLogger,
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
      logger,
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

async function executeCompleteTicketDeliveryToolCall(
  input: unknown,
  deliveryConfig: NonNullable<CodexAppServerClientOptions["issueDelivery"]>,
  linearConfig: NonNullable<CodexAppServerClientOptions["linearGraphql"]>,
  workspacePath: string,
  logger: StructuredLogger,
): Promise<
  | {
      success: true;
      delivery: TicketDeliveryResult;
      comment: LinearComment;
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    }
> {
  const parsed = parseCompleteTicketDeliveryArguments(input);
  if (!parsed.ok) {
    return {
      success: false,
      error: parsed.error,
    };
  }

  if (!linearConfig.endpoint.trim() || !linearConfig.apiKey.trim()) {
    return {
      success: false,
      error: {
        code: "linear_graphql_missing_auth",
        message:
          "Linear GraphQL tool is not configured with endpoint and auth.",
      },
    };
  }

  const runCommand =
    deliveryConfig.commandRunner ?? defaultDeliveryCommandRunner;
  const templateReadFile = deliveryConfig.readFileFn ?? readFile;
  let tempDir: string | null = null;

  try {
    const branch = await runCommandExpectSuccess(
      runCommand,
      {
        command: "git",
        args: ["branch", "--show-current"],
        cwd: workspacePath,
      },
      "ticket_delivery_branch",
    );
    const currentBranch = branch.stdout.trim();
    if (!currentBranch) {
      return errorResult(
        "ticket_delivery_detached_head",
        "Current HEAD is detached.",
      );
    }
    if (currentBranch === "main") {
      return errorResult(
        "ticket_delivery_main_branch",
        "Refusing to publish from main.",
      );
    }

    const status = await runCommandExpectSuccess(
      runCommand,
      {
        command: "git",
        args: ["status", "--porcelain"],
        cwd: workspacePath,
      },
      "ticket_delivery_git_status",
    );

    await runCommandExpectSuccess(
      runCommand,
      {
        command: "./scripts/verify",
        args: [],
        cwd: workspacePath,
      },
      "ticket_delivery_verify",
    );

    let commitSha: string | undefined;
    if (status.stdout.trim()) {
      await runCommandExpectSuccess(
        runCommand,
        {
          command: "git",
          args: ["add", "-A"],
          cwd: workspacePath,
        },
        "ticket_delivery_git_add",
      );
      const commit = await runCommandExpectSuccess(
        runCommand,
        {
          command: "git",
          args: [
            "commit",
            "-m",
            `${deliveryConfig.identifier}: ${deliveryConfig.title}`,
          ],
          cwd: workspacePath,
        },
        "ticket_delivery_git_commit",
      );
      commitSha =
        parseCommitSha(commit.stdout) ?? parseCommitSha(commit.stderr);
    }

    const repoResult = await runCommandExpectSuccess(
      runCommand,
      {
        command: "gh",
        args: [
          "repo",
          "view",
          "--json",
          "nameWithOwner",
          "-q",
          ".nameWithOwner",
        ],
        cwd: workspacePath,
      },
      "ticket_delivery_repo_view",
    );
    const repo = repoResult.stdout.trim();
    if (!repo) {
      return errorResult(
        "ticket_delivery_missing_repo",
        "GitHub repository could not be resolved.",
      );
    }

    await runCommandExpectSuccess(
      runCommand,
      {
        command: "git",
        args: ["push", "-u", "origin", "HEAD"],
        cwd: workspacePath,
      },
      "ticket_delivery_git_push",
    );

    const existingPrResult = await runCommandExpectSuccess(
      runCommand,
      {
        command: "gh",
        args: [
          "pr",
          "list",
          "--repo",
          repo,
          "--head",
          currentBranch,
          "--state",
          "open",
          "--json",
          "number,url",
          "--jq",
          'if length == 1 then .[0].url elif length == 0 then "" else error("multiple open pull requests for branch") end',
        ],
        cwd: workspacePath,
      },
      "ticket_delivery_pr_list",
    );
    const existingPrUrl = existingPrResult.stdout.trim();

    const template = await templateReadFile(
      join(workspacePath, ".github", "pull_request_template.md"),
      "utf8",
    );
    tempDir = await mkdtemp(join(tmpdir(), "symphony-ticket-delivery-"));
    const prBodyPath = join(tempDir, "pull-request.md");
    await writeFile(
      prBodyPath,
      renderPullRequestBody(template, {
        identifier: deliveryConfig.identifier,
        title: deliveryConfig.title,
        ticketUrl: deliveryConfig.url,
        summary: parsed.summary,
        targetedChecks: parsed.targetedChecks,
      }),
      "utf8",
    );

    const prTitle = `${deliveryConfig.identifier}: ${deliveryConfig.title}`;
    if (!existingPrUrl) {
      await runCommandExpectSuccess(
        runCommand,
        {
          command: "gh",
          args: [
            "pr",
            "create",
            "--repo",
            repo,
            "--base",
            "main",
            "--head",
            currentBranch,
            "--title",
            prTitle,
            "--body-file",
            prBodyPath,
          ],
          cwd: workspacePath,
        },
        "ticket_delivery_pr_create",
      );
    } else {
      await runCommandExpectSuccess(
        runCommand,
        {
          command: "gh",
          args: [
            "pr",
            "edit",
            existingPrUrl,
            "--title",
            prTitle,
            "--body-file",
            prBodyPath,
          ],
          cwd: workspacePath,
        },
        "ticket_delivery_pr_edit",
      );
    }

    const prViewResult = await runCommandExpectSuccess(
      runCommand,
      {
        command: "gh",
        args: [
          "pr",
          "view",
          currentBranch,
          "--repo",
          repo,
          "--json",
          "url",
          "-q",
          ".url",
        ],
        cwd: workspacePath,
      },
      "ticket_delivery_pr_view",
    );
    const prUrl = prViewResult.stdout.trim();
    if (!prUrl) {
      return errorResult(
        "ticket_delivery_missing_pr_url",
        "GitHub pull request URL could not be resolved.",
      );
    }

    const client = new LinearTrackerClient({
      endpoint: linearConfig.endpoint,
      apiKey: linearConfig.apiKey,
      logger,
      projectSlug: linearConfig.projectSlug ?? "",
      ...(linearConfig.fetchFn ? { fetchFn: linearConfig.fetchFn } : {}),
    });
    const comment = await client.createIssueComment(
      deliveryConfig.issueId,
      buildCompletionComment(parsed.summary, parsed.targetedChecks, prUrl),
    );

    return {
      success: true,
      delivery: {
        branch: currentBranch,
        prUrl,
        commentId: comment.id,
        commitSha,
      },
      comment,
    };
  } catch (error) {
    if (error instanceof TrackerError) {
      return errorResult(error.code, error.message);
    }
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      "message" in error &&
      typeof (error as { code: unknown }).code === "string" &&
      typeof (error as { message: unknown }).message === "string"
    ) {
      return errorResult(
        (error as { code: string }).code,
        (error as { message: string }).message,
      );
    }

    return errorResult(
      "ticket_delivery_failed",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

type CompleteTicketDeliveryArguments =
  | { ok: true; summary: string; targetedChecks: string[] }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };

function parseCompleteTicketDeliveryArguments(
  input: unknown,
): CompleteTicketDeliveryArguments {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error: {
        code: "ticket_delivery_invalid_input",
        message:
          "tool input must be an object with summary and optional targeted_checks.",
      },
    };
  }

  const extraKeys = Object.keys(input).filter(
    (key) =>
      key !== "summary" && key !== "targeted_checks" && key !== "validation",
  );
  if (extraKeys.length > 0) {
    return {
      ok: false,
      error: {
        code: "ticket_delivery_invalid_input",
        message: `unexpected fields: ${extraKeys.join(", ")}`,
      },
    };
  }

  const summary =
    typeof (input as { summary?: unknown }).summary === "string"
      ? (input as { summary: string }).summary.trim()
      : "";
  const targetedChecks =
    Array.isArray((input as { targeted_checks?: unknown }).targeted_checks) &&
    (input as { targeted_checks: unknown[] }).targeted_checks.every(
      (item) => typeof item === "string",
    )
      ? (input as { targeted_checks: string[] }).targeted_checks
          .map((item) => item.trim())
          .filter(Boolean)
      : null;
  const deprecatedValidation =
    typeof (input as { validation?: unknown }).validation === "string"
      ? (input as { validation: string }).validation.trim()
      : "";

  if (!summary) {
    return {
      ok: false,
      error: {
        code: "ticket_delivery_invalid_input",
        message: "summary must be a non-empty string.",
      },
    };
  }

  if (targetedChecks === null) {
    return {
      ok: false,
      error: {
        code: "ticket_delivery_invalid_input",
        message:
          "targeted_checks must be an array of strings when it is provided.",
      },
    };
  }

  return {
    ok: true,
    summary,
    targetedChecks:
      targetedChecks.length > 0
        ? targetedChecks
        : deprecatedValidation
          ? [deprecatedValidation]
          : [],
  };
}

async function runCommandExpectSuccess(
  runCommand: DeliveryCommandRunner,
  input: DeliveryCommandInput,
  code: string,
): Promise<DeliveryCommandResult> {
  const result = await runCommand(input);
  if (result.exitCode !== 0) {
    throw {
      code,
      message: formatCommandFailure(input, result),
    };
  }
  return result;
}

function formatCommandFailure(
  input: DeliveryCommandInput,
  result: DeliveryCommandResult,
): string {
  const parts = [
    `${input.command} ${input.args.join(" ")}`.trim(),
    `failed with exit code ${result.exitCode}.`,
  ];
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(" ");
}

async function defaultDeliveryCommandRunner(
  input: DeliveryCommandInput,
): Promise<DeliveryCommandResult> {
  return await new Promise<DeliveryCommandResult>(
    (resolvePromise, rejectPromise) => {
      const child = spawn(input.command, input.args, {
        cwd: input.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        rejectPromise(error);
      });
      child.on("close", (exitCode) => {
        resolvePromise({
          stdout,
          stderr,
          exitCode: exitCode ?? 1,
        });
      });
    },
  );
}

function parseCommitSha(output: string): string | undefined {
  const match = /\[.+?\s([0-9a-f]{7,40})\]/i.exec(output);
  return match?.[1];
}

function normalizeBulletList(text: string): string[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s*/, ""));
  return lines.length > 0 ? lines : [text.trim()];
}

function renderPullRequestBody(
  template: string,
  input: {
    identifier: string;
    title: string;
    ticketUrl: string | null;
    summary: string;
    targetedChecks: string[];
  },
): string {
  const summaryBullets = normalizeBulletList(input.summary)
    .map((line) => `- ${line}`)
    .join("\n");
  const targetedCheckBullets = input.targetedChecks
    .map((line) => `- [x] ${line}`)
    .join("\n");
  const context = input.ticketUrl
    ? `Implements ${input.identifier}: ${input.title}. Ticket: ${input.ticketUrl}`
    : `Implements ${input.identifier}: ${input.title}.`;
  const testPlan = ["- [x] `./scripts/verify`", targetedCheckBullets]
    .filter(Boolean)
    .join("\n");

  return template
    .replace(/^Linear Issue:.*$/m, `Linear Issue: ${input.identifier}`)
    .replace(
      /#### Context\s*\n\s*\n[\s\S]*?\n#### TL;DR/m,
      `#### Context\n\n${context}\n\n#### TL;DR`,
    )
    .replace(
      /#### TL;DR\s*\n\s*\n[\s\S]*?\n#### Summary/m,
      `#### TL;DR\n\n${input.summary}\n\n#### Summary`,
    )
    .replace(
      /#### Summary\s*\n\s*\n[\s\S]*?\n#### Alternatives/m,
      `#### Summary\n\n${summaryBullets}\n\n#### Alternatives`,
    )
    .replace(
      /#### Alternatives\s*\n\s*\n[\s\S]*?\n#### Test Plan/m,
      "#### Alternatives\n\n- None documented.\n\n#### Test Plan",
    )
    .replace(
      /#### Test Plan\s*\n\s*\n[\s\S]*$/m,
      `#### Test Plan\n\n${testPlan}`,
    );
}

function buildCompletionComment(
  summary: string,
  targetedChecks: string[],
  prUrl: string,
): string {
  const validationSummary =
    targetedChecks.length > 0
      ? targetedChecks.join("; ")
      : "`./scripts/verify`";
  return `${summary} Validation: ${validationSummary}. PR: ${prUrl}`;
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

const MAX_GRAPHQL_LOG_PREVIEW_LENGTH = 1000;

function extractGraphqlOperationName(query: string): string | null {
  const match = /^\s*(query|mutation)\s+([_A-Za-z][_0-9A-Za-z]*)/m.exec(query);
  return match?.[2] ?? null;
}

function previewGraphqlLogValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.length <= MAX_GRAPHQL_LOG_PREVIEW_LENGTH) {
    return trimmed;
  }

  return `${trimmed.slice(0, MAX_GRAPHQL_LOG_PREVIEW_LENGTH)}...(truncated)`;
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

function errorResult(code: string, message: string): ToolErrorResult {
  return {
    success: false,
    error: {
      code,
      message,
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
