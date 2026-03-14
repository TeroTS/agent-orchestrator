import { describe, expect, it, vi } from "vitest";

import { handleStatusRequest } from "../../src/observability/status-handler.js";

function createSnapshot() {
  return {
    running: [
      {
        issueId: "issue-1",
        identifier: "ABC-1",
        state: "In Progress",
        sessionId: "thread-1-turn-1",
        startedAt: "2026-03-11T00:00:00.000Z",
      },
    ],
    retries: [
      {
        issueId: "issue-2",
        identifier: "ABC-2",
        attempt: 2,
        dueAtMs: 123456,
        error: "retrying",
      },
    ],
    completedIssueIds: ["ABC-3"],
  };
}

async function request(options: {
  method?: string;
  url: string;
  snapshot?: () => unknown;
  refresh?: () => Promise<unknown> | unknown;
  logger?: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}) {
  const result = await handleStatusRequest({
    method: options.method,
    url: options.url,
    snapshot: options.snapshot ?? createSnapshot,
    refresh: options.refresh,
    logger: options.logger,
  });

  return {
    status: result.statusCode,
    contentType: result.contentType,
    json: () => JSON.parse(result.body) as unknown,
    text: () => result.body,
  };
}

describe("handleStatusRequest", () => {
  it("serves summary state, list endpoints, and html status", async () => {
    const stateResponse = await request({ url: "/api/v1/state" });
    expect(stateResponse.status).toBe(200);
    expect(stateResponse.json()).toEqual(
      expect.objectContaining({
        generated_at: expect.any(String),
        counts: {
          running: 1,
          retrying: 1,
          completed: 1,
        },
        running: [
          expect.objectContaining({
            issue_id: "issue-1",
            issue_identifier: "ABC-1",
            session_id: "thread-1-turn-1",
          }),
        ],
        retrying: [
          expect.objectContaining({
            issue_id: "issue-2",
            issue_identifier: "ABC-2",
            attempt: 2,
          }),
        ],
        completed_issue_ids: ["ABC-3"],
        codex_totals: null,
        rate_limits: null,
      }),
    );

    const issuesResponse = await request({ url: "/api/v1/issues" });
    expect(issuesResponse.status).toBe(200);
    expect(issuesResponse.json()).toEqual([
      expect.objectContaining({
        issue_identifier: "ABC-1",
        status: "running",
      }),
      expect.objectContaining({
        issue_identifier: "ABC-2",
        status: "retrying",
      }),
      expect.objectContaining({
        issue_identifier: "ABC-3",
        status: "completed",
      }),
    ]);

    const runningResponse = await request({ url: "/api/v1/running" });
    expect(runningResponse.status).toBe(200);
    expect(runningResponse.json()).toEqual([
      expect.objectContaining({
        issue_identifier: "ABC-1",
      }),
    ]);

    const retriesResponse = await request({ url: "/api/v1/retries" });
    expect(retriesResponse.status).toBe(200);
    expect(retriesResponse.json()).toEqual([
      expect.objectContaining({
        issue_identifier: "ABC-2",
      }),
    ]);

    const completedResponse = await request({ url: "/api/v1/completed" });
    expect(completedResponse.status).toBe(200);
    expect(completedResponse.json()).toEqual(["ABC-3"]);

    const healthResponse = await request({ url: "/api/v1/health" });
    expect(healthResponse.status).toBe(200);
    expect(healthResponse.json()).toEqual({ ok: true });

    const readyResponse = await request({ url: "/api/v1/ready" });
    expect(readyResponse.status).toBe(200);
    expect(readyResponse.json()).toEqual({ ready: true });

    const dashboardResponse = await request({ url: "/" });
    expect(dashboardResponse.status).toBe(200);
    expect(dashboardResponse.contentType).toBe("text/html; charset=utf-8");
    expect(dashboardResponse.text()).toContain("completed_issue_ids");
  });

  it("serves issue-scoped state and returns 404 for unknown issues", async () => {
    const issueResponse = await request({ url: "/api/v1/issues/ABC-2" });
    expect(issueResponse.status).toBe(200);
    expect(issueResponse.json()).toEqual(
      expect.objectContaining({
        issue_identifier: "ABC-2",
        issue_id: "issue-2",
        status: "retrying",
        running: null,
        retry: {
          issue_id: "issue-2",
          issue_identifier: "ABC-2",
          attempt: 2,
          due_at: "1970-01-01T00:02:03.456Z",
          error: "retrying",
        },
        last_error: "retrying",
      }),
    );

    const missingIssueResponse = await request({
      url: "/api/v1/issues/MISSING-1",
    });
    expect(missingIssueResponse.status).toBe(404);
    expect(missingIssueResponse.json()).toEqual({
      error: {
        code: "issue_not_found",
        message: "Issue MISSING-1 is not present in the current runtime state.",
      },
    });
  });

  it("queues refresh and reconcile requests and logs request metadata", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const refresh = vi.fn(async () => ({
      queued: true,
    }));

    const refreshResponse = await request({
      method: "POST",
      url: "/api/v1/refresh",
      refresh,
      logger,
    });
    expect(refreshResponse.status).toBe(202);
    expect(refreshResponse.json()).toEqual({
      queued: true,
      coalesced: false,
      requested_at: expect.any(String),
      operations: ["poll", "reconcile"],
    });

    const reconcileResponse = await request({
      method: "POST",
      url: "/api/v1/reconcile",
      refresh,
      logger,
    });
    expect(reconcileResponse.status).toBe(202);
    expect(refresh).toHaveBeenCalledTimes(2);

    await request({ url: "/missing", logger });

    expect(logger.info).toHaveBeenCalledWith(
      "status request completed",
      expect.objectContaining({
        path: "/api/v1/refresh",
        method: "POST",
        status_code: 202,
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "status request completed",
      expect.objectContaining({
        path: "/missing",
        method: "GET",
        status_code: 404,
      }),
    );
  });

  it("returns 404 for unknown paths", async () => {
    const response = await request({ url: "/missing" });
    expect(response.status).toBe(404);
    expect(response.text()).toBe("Not Found");
  });

  it("returns 405 for unsupported methods on known routes", async () => {
    const statePost = await request({
      method: "POST",
      url: "/api/v1/state",
    });
    expect(statePost.status).toBe(405);
    expect(statePost.json()).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Method POST is not allowed for /api/v1/state.",
      },
    });

    const refreshGet = await request({ url: "/api/v1/refresh" });
    expect(refreshGet.status).toBe(405);
    expect(refreshGet.json()).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Method GET is not allowed for /api/v1/refresh.",
      },
    });
  });
});
