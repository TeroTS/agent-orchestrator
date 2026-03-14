import {
  createStructuredLogger,
  type StructuredLogger,
} from "./structured-logger.js";

interface RuntimeSnapshot {
  running?: RuntimeRunningEntry[];
  retries?: RuntimeRetryEntry[];
  completedIssueIds?: string[];
}

interface RuntimeRunningEntry {
  issueId: string;
  identifier: string;
  state?: string;
  sessionId?: string | undefined;
  threadId?: string | undefined;
  turnId?: string | undefined;
  codexAppServerPid?: number | undefined;
  lastCodexEvent?: string | undefined;
  lastCodexTimestamp?: string | undefined;
  lastCodexMessage?: string | undefined;
  turnCount?: number | undefined;
  startedAt?: string | undefined;
}

interface RuntimeRetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  error: string | null;
}

export interface StatusHandlerResponse {
  statusCode: number;
  contentType: string;
  body: string;
}

export async function handleStatusRequest(options: {
  method?: string | undefined;
  url?: string | undefined;
  snapshot: () => unknown;
  refresh?: (() => Promise<unknown> | unknown) | undefined;
  logger?: StructuredLogger | undefined;
}): Promise<StatusHandlerResponse> {
  const logger = options.logger ?? createStructuredLogger();
  const method = options.method ?? "GET";
  const path = parsePath(options.url ?? "/");

  let result: StatusHandlerResponse | undefined;
  try {
    const methodError = validateMethod(path, method);
    if (methodError) {
      result = jsonResponse(405, {
        error: {
          code: "method_not_allowed",
          message: `Method ${method} is not allowed for ${path}.`,
        },
      });
      return result;
    }

    if (path === "/api/v1/health") {
      result = jsonResponse(200, { ok: true });
      return result;
    }

    if (path === "/api/v1/ready") {
      result = jsonResponse(200, { ready: true });
      return result;
    }

    if (path === "/api/v1/state") {
      result = jsonResponse(
        200,
        buildStateResponse(readSnapshot(options.snapshot)),
      );
      return result;
    }

    if (path === "/api/v1/issues") {
      result = jsonResponse(
        200,
        buildIssueList(readSnapshot(options.snapshot)),
      );
      return result;
    }

    if (path === "/api/v1/running") {
      result = jsonResponse(
        200,
        buildRunningList(readSnapshot(options.snapshot)),
      );
      return result;
    }

    if (path === "/api/v1/retries") {
      result = jsonResponse(
        200,
        buildRetryList(readSnapshot(options.snapshot)),
      );
      return result;
    }

    if (path === "/api/v1/completed") {
      result = jsonResponse(
        200,
        buildCompletedList(readSnapshot(options.snapshot)),
      );
      return result;
    }

    if (
      (path === "/api/v1/refresh" || path === "/api/v1/reconcile") &&
      method === "POST"
    ) {
      if (options.refresh) {
        await options.refresh();
      }
      result = jsonResponse(202, {
        queued: true,
        coalesced: false,
        requested_at: new Date().toISOString(),
        operations: ["poll", "reconcile"],
      });
      return result;
    }

    if (path.startsWith("/api/v1/issues/")) {
      const identifier = decodeURIComponent(
        path.slice("/api/v1/issues/".length),
      );
      const payload = buildIssueDetail(
        readSnapshot(options.snapshot),
        identifier,
      );
      if (!payload) {
        result = jsonResponse(404, {
          error: {
            code: "issue_not_found",
            message: `Issue ${identifier} is not present in the current runtime state.`,
          },
        });
        return result;
      }
      result = jsonResponse(200, payload);
      return result;
    }

    if (
      path.startsWith("/api/v1/") &&
      path !== "/api/v1/refresh" &&
      path !== "/api/v1/reconcile"
    ) {
      const identifier = decodeURIComponent(path.slice("/api/v1/".length));
      const payload = buildIssueDetail(
        readSnapshot(options.snapshot),
        identifier,
      );
      if (!payload) {
        result = jsonResponse(404, {
          error: {
            code: "issue_not_found",
            message: `Issue ${identifier} is not present in the current runtime state.`,
          },
        });
        return result;
      }
      result = jsonResponse(200, payload);
      return result;
    }

    if (path === "/") {
      result = htmlResponse(
        200,
        renderHtml(buildStateResponse(readSnapshot(options.snapshot))),
      );
      return result;
    }

    result = textResponse(404, "Not Found");
    return result;
  } catch (error) {
    logger.error("status request failed", {
      method,
      path,
      reason: error instanceof Error ? error.message : String(error),
    });
    result = jsonResponse(500, {
      error: {
        code: "status_request_failed",
        message: "The status request could not be completed.",
      },
    });
    return result;
  } finally {
    logger.info("status request completed", {
      method,
      path,
      status_code: result?.statusCode ?? 500,
    });
  }
}

function parsePath(rawUrl: string): string {
  return new URL(rawUrl, "http://127.0.0.1").pathname;
}

function validateMethod(path: string, method: string): "known_route" | null {
  if (
    path === "/" ||
    path === "/api/v1/state" ||
    path === "/api/v1/issues" ||
    path === "/api/v1/running" ||
    path === "/api/v1/retries" ||
    path === "/api/v1/completed" ||
    path === "/api/v1/health" ||
    path === "/api/v1/ready" ||
    path.startsWith("/api/v1/issues/")
  ) {
    return method === "GET" ? null : "known_route";
  }

  if (path === "/api/v1/refresh" || path === "/api/v1/reconcile") {
    return method === "POST" ? null : "known_route";
  }

  return null;
}

function readSnapshot(snapshotFn: () => unknown): RuntimeSnapshot {
  const snapshot = snapshotFn();
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return {};
  }
  return snapshot as RuntimeSnapshot;
}

function buildStateResponse(snapshot: RuntimeSnapshot) {
  const running = buildRunningList(snapshot);
  const retrying = buildRetryList(snapshot);
  const completed = buildCompletedList(snapshot);

  return {
    generated_at: new Date().toISOString(),
    counts: {
      running: running.length,
      retrying: retrying.length,
      completed: completed.length,
    },
    running,
    retrying,
    completed_issue_ids: completed,
    codex_totals: null,
    rate_limits: null,
  };
}

function buildRunningList(snapshot: RuntimeSnapshot) {
  return (snapshot.running ?? []).map((entry) => ({
    issue_id: entry.issueId,
    issue_identifier: entry.identifier,
    state: entry.state ?? null,
    session_id: entry.sessionId ?? null,
    thread_id: entry.threadId ?? null,
    turn_id: entry.turnId ?? null,
    codex_app_server_pid: entry.codexAppServerPid ?? null,
    last_event: entry.lastCodexEvent ?? null,
    last_event_at: entry.lastCodexTimestamp ?? null,
    last_message: entry.lastCodexMessage ?? null,
    turn_count: entry.turnCount ?? 0,
    started_at: entry.startedAt ?? null,
  }));
}

function buildRetryList(snapshot: RuntimeSnapshot) {
  return (snapshot.retries ?? []).map((entry) => ({
    issue_id: entry.issueId,
    issue_identifier: entry.identifier,
    attempt: entry.attempt,
    due_at: new Date(entry.dueAtMs).toISOString(),
    error: entry.error,
  }));
}

function buildCompletedList(snapshot: RuntimeSnapshot) {
  return [...(snapshot.completedIssueIds ?? [])].sort();
}

function buildIssueList(snapshot: RuntimeSnapshot) {
  const entries = new Map<
    string,
    {
      issue_identifier: string;
      issue_id: string | null;
      status: "running" | "retrying" | "completed";
    }
  >();

  for (const running of snapshot.running ?? []) {
    entries.set(running.identifier, {
      issue_identifier: running.identifier,
      issue_id: running.issueId,
      status: "running",
    });
  }

  for (const retry of snapshot.retries ?? []) {
    entries.set(retry.identifier, {
      issue_identifier: retry.identifier,
      issue_id: retry.issueId,
      status: "retrying",
    });
  }

  for (const identifier of snapshot.completedIssueIds ?? []) {
    if (!entries.has(identifier)) {
      entries.set(identifier, {
        issue_identifier: identifier,
        issue_id: null,
        status: "completed",
      });
    }
  }

  return Array.from(entries.values()).sort((left, right) =>
    left.issue_identifier.localeCompare(right.issue_identifier),
  );
}

function buildIssueDetail(snapshot: RuntimeSnapshot, identifier: string) {
  const runningEntry = (snapshot.running ?? []).find(
    (entry) => entry.identifier === identifier,
  );
  const retryEntry = (snapshot.retries ?? []).find(
    (entry) => entry.identifier === identifier,
  );
  const completed = (snapshot.completedIssueIds ?? []).includes(identifier);

  if (!runningEntry && !retryEntry && !completed) {
    return null;
  }

  const issueId = runningEntry?.issueId ?? retryEntry?.issueId ?? null;
  const status = runningEntry
    ? "running"
    : retryEntry
      ? "retrying"
      : "completed";

  return {
    issue_identifier: identifier,
    issue_id: issueId,
    status,
    running: runningEntry
      ? {
          issue_id: runningEntry.issueId,
          issue_identifier: runningEntry.identifier,
          state: runningEntry.state ?? null,
          session_id: runningEntry.sessionId ?? null,
          thread_id: runningEntry.threadId ?? null,
          turn_id: runningEntry.turnId ?? null,
          codex_app_server_pid: runningEntry.codexAppServerPid ?? null,
          last_event: runningEntry.lastCodexEvent ?? null,
          last_event_at: runningEntry.lastCodexTimestamp ?? null,
          last_message: runningEntry.lastCodexMessage ?? null,
          turn_count: runningEntry.turnCount ?? 0,
          started_at: runningEntry.startedAt ?? null,
        }
      : null,
    retry: retryEntry
      ? {
          issue_id: retryEntry.issueId,
          issue_identifier: retryEntry.identifier,
          attempt: retryEntry.attempt,
          due_at: new Date(retryEntry.dueAtMs).toISOString(),
          error: retryEntry.error,
        }
      : null,
    last_error: retryEntry?.error ?? null,
  };
}

function jsonResponse(
  statusCode: number,
  body: unknown,
): StatusHandlerResponse {
  return {
    statusCode,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  };
}

function textResponse(statusCode: number, body: string): StatusHandlerResponse {
  return {
    statusCode,
    contentType: "text/plain; charset=utf-8",
    body,
  };
}

function htmlResponse(statusCode: number, body: string): StatusHandlerResponse {
  return {
    statusCode,
    contentType: "text/html; charset=utf-8",
    body,
  };
}

function renderHtml(snapshot: unknown): string {
  const escaped = JSON.stringify(snapshot, null, 2)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Symphony Status</title>
  </head>
  <body>
    <h1>Symphony Status</h1>
    <pre>${escaped}</pre>
  </body>
</html>`;
}
