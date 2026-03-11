import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";

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
    fetchFn?: typeof fetch;
  };
  onEvent?: (event: CodexRuntimeEvent) => void;
}

export interface CodexTurnResult {
  outcome: "completed";
  threadId: string;
  turnId: string;
  sessionId: string;
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
  resolve: (result: CodexTurnResult) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

export class CodexAppServerClient {
  private readonly options: CodexAppServerClientOptions;
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
  }

  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    const workspacePath = resolve(this.options.workspacePath);
    const child = spawn("bash", ["-lc", this.options.command], {
      cwd: workspacePath,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.process = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      this.handleStdoutChunk(chunk);
    });

    child.stderr.on("data", () => {
      // Stderr is observability-only and intentionally not parsed as protocol JSON.
    });

    child.on("error", (error) => {
      this.rejectPending(
        new CodexAppServerError("codex_not_found", "Failed to start codex app-server.", {
          cause: error
        })
      );
    });

    child.on("exit", () => {
      this.rejectPending(
        new CodexAppServerError("port_exit", "Codex app-server exited unexpectedly.")
      );
    });

    try {
      await this.request("initialize", {
        clientInfo: this.options.clientInfo ?? { name: "symphony-ts", version: "0.1.0" },
        capabilities: {}
      });
      this.notify("initialized", {});
      const threadResult = await this.request("thread/start", {
        approvalPolicy: this.options.approvalPolicy,
        sandbox: this.options.threadSandbox,
        cwd: workspacePath,
        tools: this.options.linearGraphql
          ? [
              {
                name: "linear_graphql",
                description: "Execute a single GraphQL operation against Linear."
              }
            ]
          : undefined
      });

      const threadId = readNestedString(threadResult, ["thread", "id"]);
      if (!threadId) {
        throw new CodexAppServerError("response_error", "thread/start did not return thread id.");
      }
      this.threadId = threadId;
    } catch (error) {
      this.emit({
        event: "startup_failed",
        payload: error
      });
      throw error;
    }
  }

  async runTurn(input: { prompt: string; title: string }): Promise<CodexTurnResult> {
    if (!this.process || !this.threadId) {
      throw new CodexAppServerError("response_error", "Codex app-server session has not been started.");
    }

    if (this.currentTurn) {
      throw new CodexAppServerError("response_error", "A turn is already in progress.");
    }

    this.turnStartPending = true;
    const turnResult = await this.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: input.prompt }],
      cwd: resolve(this.options.workspacePath),
      title: input.title,
      approvalPolicy: this.options.approvalPolicy,
      sandboxPolicy: this.options.turnSandboxPolicy
    });

    const turnId = readNestedString(turnResult, ["turn", "id"]);
    if (!turnId) {
      throw new CodexAppServerError("response_error", "turn/start did not return turn id.");
    }

    const sessionId = `${this.threadId}-${turnId}`;

    return new Promise<CodexTurnResult>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        if (this.currentTurn?.sessionId === sessionId) {
          this.currentTurn = null;
        }
        rejectPromise(
          new CodexAppServerError("turn_timeout", `Turn timed out after ${this.options.turnTimeoutMs}ms.`)
        );
      }, this.options.turnTimeoutMs);

      this.currentTurn = {
        threadId: this.threadId!,
        turnId,
        sessionId,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer
      };

      this.emit({
        event: "session_started",
        sessionId,
        payload: {
          threadId: this.threadId,
          turnId
        }
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
        this.emit({
          event: "malformed",
          message: line
        });
        continue;
      }

      if (message.id != null && this.pendingRequests.has(message.id) && ("result" in message || "error" in message)) {
        const pending = this.pendingRequests.get(message.id)!;
        this.pendingRequests.delete(message.id);
        clearTimeout(pending.timer);
        if ("error" in message) {
          pending.reject(new CodexAppServerError("response_error", "Codex returned response error.", { cause: message.error }));
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

    if (
      this.turnStartPending &&
      (method === "turn/completed" ||
        method === "turn/failed" ||
        method === "turn/cancelled" ||
        method === "item/tool/requestUserInput")
    ) {
      this.bufferedTurnMessages.push(message);
      return;
    }

    if (method === "approval/request" && message.id != null) {
      this.send({
        id: message.id,
        result: {
          approved: true
        }
      });
      this.emit({
        event: "approval_auto_approved",
        payload: message.params
      });
      return;
    }

    if (method === "item/tool/call" && message.id != null) {
      if (message.params?.name === "linear_graphql" && this.options.linearGraphql) {
        void this.handleLinearGraphqlToolCall(message);
        return;
      }

      this.send({
        id: message.id,
        result: {
          success: false,
          error: "unsupported_tool_call"
        }
      });
      this.emit({
        event: "unsupported_tool_call",
        payload: message.params
      });
      return;
    }

    if (method === "item/tool/requestUserInput") {
      this.emit({
        event: "turn_input_required",
        payload: message.params
      });
      const currentTurn = this.currentTurn;
      if (currentTurn) {
        clearTimeout(currentTurn.timer);
        this.currentTurn = null;
        currentTurn.reject(
          new CodexAppServerError("turn_input_required", "Codex requested user input.")
        );
      }
      return;
    }

    if (method === "turn/completed") {
      const currentTurn = this.currentTurn;
      if (!currentTurn) {
        return;
      }

      clearTimeout(currentTurn.timer);
      this.currentTurn = null;
      this.emit({
        event: "turn_completed",
        sessionId: currentTurn.sessionId,
        usage: extractUsage(message.params),
        payload: message.params
      });
      currentTurn.resolve({
        outcome: "completed",
        threadId: currentTurn.threadId,
        turnId: currentTurn.turnId,
        sessionId: currentTurn.sessionId
      });
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
      this.emit({
        event: code,
        sessionId: currentTurn.sessionId,
        payload: message.params
      });
      currentTurn.reject(new CodexAppServerError(code, `Codex ${method}.`));
      return;
    }

    this.emit({
      event: method === "notification" ? "notification" : "other_message",
      payload: message.params ?? message
    });
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextRequestId++;
    this.send({ id, method, params });

    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        rejectPromise(
          new CodexAppServerError("response_timeout", `${method} timed out after ${this.options.readTimeoutMs}ms.`)
        );
      }, this.options.readTimeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  private send(message: Record<string, unknown>): void {
    if (!this.process) {
      throw new CodexAppServerError("port_exit", "Codex app-server process is not running.");
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

  private emit(event: Omit<CodexRuntimeEvent, "timestamp" | "codexAppServerPid">): void {
    this.options.onEvent?.({
      timestamp: new Date().toISOString(),
      codexAppServerPid: this.process?.pid,
      ...event
    });
  }

  private async handleLinearGraphqlToolCall(message: any): Promise<void> {
    const toolConfig = this.options.linearGraphql;
    if (!toolConfig) {
      return;
    }

    const result = await executeLinearGraphqlToolCall(message.params?.arguments, toolConfig);
    this.send({
      id: message.id,
      result
    });
    this.emit({
      event: "linear_graphql_executed",
      payload: result
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

async function executeLinearGraphqlToolCall(
  input: unknown,
  config: NonNullable<CodexAppServerClientOptions["linearGraphql"]>
): Promise<Record<string, unknown>> {
  const parsed = parseLinearGraphqlArguments(input);
  if (!parsed.ok) {
    return {
      success: false,
      error: parsed.error
    };
  }

  const fetchFn = config.fetchFn ?? fetch;

  try {
    const response = await fetchFn(config.endpoint, {
      method: "POST",
      headers: {
        Authorization: config.apiKey,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        query: parsed.query,
        variables: parsed.variables
      })
    });
    const body = await response.json();

    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      return {
        success: false,
        body
      };
    }

    return {
      success: true,
      body
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseLinearGraphqlArguments(
  input: unknown
): { ok: true; query: string; variables: Record<string, unknown> } | { ok: false; error: string } {
  if (typeof input === "string") {
    const query = input.trim();
    return query ? { ok: true, query, variables: {} } : { ok: false, error: "invalid_input" };
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "invalid_input" };
  }

  const query = typeof (input as { query?: unknown }).query === "string"
    ? (input as { query: string }).query.trim()
    : "";
  const variables = (input as { variables?: unknown }).variables;

  if (!query) {
    return { ok: false, error: "invalid_input" };
  }

  if (variables != null && (typeof variables !== "object" || Array.isArray(variables))) {
    return { ok: false, error: "invalid_input" };
  }

  const operationMatches = query.match(/\b(query|mutation|subscription)\b/g);
  if ((operationMatches?.length ?? 0) > 1) {
    return { ok: false, error: "multiple_operations_not_supported" };
  }

  return {
    ok: true,
    query,
    variables: (variables as Record<string, unknown> | undefined) ?? {}
  };
}
