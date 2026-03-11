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
