import { afterEach, describe, expect, it, vi } from "vitest";

import { startStatusServer } from "../src/status-server.js";

const servers: Array<{ stop: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => server.stop()));
  servers.length = 0;
});

describe("startStatusServer", () => {
  it("serves summary state, list endpoints, and html status", async () => {
    const server = await startStatusServer({
      port: 0,
      snapshot: () => ({
        running: [
          {
            issueId: "issue-1",
            identifier: "ABC-1",
            state: "In Progress",
            sessionId: "thread-1-turn-1",
            startedAt: "2026-03-11T00:00:00.000Z"
          }
        ],
        retries: [
          {
            issueId: "issue-2",
            identifier: "ABC-2",
            attempt: 2,
            dueAtMs: 123456,
            error: "retrying"
          }
        ],
        completedIssueIds: ["ABC-3"]
      }),
      refresh: async () => ({
        queued: true
      })
    });
    servers.push(server);

    const stateResponse = await fetch(`${server.baseUrl}/api/v1/state`);
    expect(stateResponse.status).toBe(200);
    await expect(stateResponse.json()).resolves.toEqual(
      expect.objectContaining({
        generated_at: expect.any(String),
        counts: {
          running: 1,
          retrying: 1,
          completed: 1
        },
        running: [
          expect.objectContaining({
            issue_id: "issue-1",
            issue_identifier: "ABC-1",
            session_id: "thread-1-turn-1"
          })
        ],
        retrying: [
          expect.objectContaining({
            issue_id: "issue-2",
            issue_identifier: "ABC-2",
            attempt: 2
          })
        ],
        completed_issue_ids: ["ABC-3"],
        codex_totals: null,
        rate_limits: null
      })
    );

    const issuesResponse = await fetch(`${server.baseUrl}/api/v1/issues`);
    expect(issuesResponse.status).toBe(200);
    await expect(issuesResponse.json()).resolves.toEqual([
      expect.objectContaining({
        issue_identifier: "ABC-1",
        status: "running"
      }),
      expect.objectContaining({
        issue_identifier: "ABC-2",
        status: "retrying"
      }),
      expect.objectContaining({
        issue_identifier: "ABC-3",
        status: "completed"
      })
    ]);

    const runningResponse = await fetch(`${server.baseUrl}/api/v1/running`);
    expect(runningResponse.status).toBe(200);
    await expect(runningResponse.json()).resolves.toEqual([
      expect.objectContaining({
        issue_identifier: "ABC-1"
      })
    ]);

    const retriesResponse = await fetch(`${server.baseUrl}/api/v1/retries`);
    expect(retriesResponse.status).toBe(200);
    await expect(retriesResponse.json()).resolves.toEqual([
      expect.objectContaining({
        issue_identifier: "ABC-2"
      })
    ]);

    const completedResponse = await fetch(`${server.baseUrl}/api/v1/completed`);
    expect(completedResponse.status).toBe(200);
    await expect(completedResponse.json()).resolves.toEqual(["ABC-3"]);

    const healthResponse = await fetch(`${server.baseUrl}/api/v1/health`);
    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toEqual({ ok: true });

    const readyResponse = await fetch(`${server.baseUrl}/api/v1/ready`);
    expect(readyResponse.status).toBe(200);
    await expect(readyResponse.json()).resolves.toEqual({ ready: true });

    const dashboardResponse = await fetch(`${server.baseUrl}/`);
    expect(dashboardResponse.status).toBe(200);
    await expect(dashboardResponse.text()).resolves.toContain("completed_issue_ids");
  });

  it("serves issue-scoped state and returns 404 for unknown issues", async () => {
    const server = await startStatusServer({
      port: 0,
      snapshot: () => ({
        running: [
          {
            issueId: "issue-1",
            identifier: "ABC-1",
            state: "In Progress",
            startedAt: "2026-03-11T00:00:00.000Z"
          }
        ],
        retries: [
          {
            issueId: "issue-2",
            identifier: "ABC-2",
            attempt: 2,
            dueAtMs: 123456,
            error: "retrying"
          }
        ],
        completedIssueIds: ["ABC-3"]
      }),
      refresh: async () => ({
        queued: true
      })
    });
    servers.push(server);

    const issueResponse = await fetch(`${server.baseUrl}/api/v1/issues/ABC-2`);
    expect(issueResponse.status).toBe(200);
    await expect(issueResponse.json()).resolves.toEqual(
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
          error: "retrying"
        },
        last_error: "retrying"
      })
    );

    const missingIssueResponse = await fetch(`${server.baseUrl}/api/v1/issues/MISSING-1`);
    expect(missingIssueResponse.status).toBe(404);
    await expect(missingIssueResponse.json()).resolves.toEqual({
      error: {
        code: "issue_not_found",
        message: "Issue MISSING-1 is not present in the current runtime state."
      }
    });
  });

  it("queues refresh/reconcile requests and logs request metadata", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const server = await startStatusServer({
      port: 0,
      snapshot: () => ({
        running: [],
        retries: [],
        completedIssueIds: []
      }),
      refresh: async () => ({
        queued: true
      }),
      logger
    });
    servers.push(server);

    const refreshResponse = await fetch(`${server.baseUrl}/api/v1/refresh`, {
      method: "POST"
    });
    expect(refreshResponse.status).toBe(202);
    await expect(refreshResponse.json()).resolves.toEqual({
      queued: true,
      coalesced: false,
      requested_at: expect.any(String),
      operations: ["poll", "reconcile"]
    });

    const reconcileResponse = await fetch(`${server.baseUrl}/api/v1/reconcile`, {
      method: "POST"
    });
    expect(reconcileResponse.status).toBe(202);

    await fetch(`${server.baseUrl}/missing`);

    expect(logger.info).toHaveBeenCalledWith(
      "status request completed",
      expect.objectContaining({
        path: "/api/v1/refresh",
        method: "POST",
        status_code: 202
      })
    );
    expect(logger.info).toHaveBeenCalledWith(
      "status request completed",
      expect.objectContaining({
        path: "/missing",
        method: "GET",
        status_code: 404
      })
    );
  });

  it("returns 404 for unknown paths", async () => {
    const server = await startStatusServer({
      port: 0,
      snapshot: () => ({
        running: [],
        retries: [],
        completedIssueIds: []
      })
    });
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/missing`);
    expect(response.status).toBe(404);
  });
});
