import { afterEach, describe, expect, it } from "vitest";

import { startStatusServer } from "../src/status-server.js";

const servers: Array<{ stop: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => server.stop()));
  servers.length = 0;
});

describe("startStatusServer", () => {
  it("serves json state at /api/v1/state and html at /", async () => {
    const server = await startStatusServer({
      port: 0,
      snapshot: () => ({
        running: [],
        retries: [],
        completedIssueIds: ["ABC-1"]
      }),
      refresh: async () => ({
        refreshed: true
      })
    });
    servers.push(server);

    const stateResponse = await fetch(`${server.baseUrl}/api/v1/state`);
    expect(stateResponse.status).toBe(200);
    await expect(stateResponse.json()).resolves.toEqual({
      running: [],
      retries: [],
      completedIssueIds: ["ABC-1"]
    });

    const dashboardResponse = await fetch(`${server.baseUrl}/`);
    expect(dashboardResponse.status).toBe(200);
    await expect(dashboardResponse.text()).resolves.toContain("completedIssueIds");
  });

  it("serves issue-scoped state and a refresh endpoint", async () => {
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
        refreshed: true
      })
    });
    servers.push(server);

    const issueResponse = await fetch(`${server.baseUrl}/api/v1/ABC-2`);
    expect(issueResponse.status).toBe(200);
    await expect(issueResponse.json()).resolves.toEqual({
      running: null,
      retry: {
        issueId: "issue-2",
        identifier: "ABC-2",
        attempt: 2,
        dueAtMs: 123456,
        error: "retrying"
      },
      completed: false
    });

    const refreshResponse = await fetch(`${server.baseUrl}/api/v1/refresh`, {
      method: "POST"
    });
    expect(refreshResponse.status).toBe(200);
    await expect(refreshResponse.json()).resolves.toEqual({
      refreshed: true
    });
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
