import { describe, expect, it, vi } from "vitest";

import {
  LinearTrackerClient,
  type LinearIssue,
} from "../src/tracker/linear-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("LinearTrackerClient", () => {
  it("fetches candidate issues with project slug and active states, preserving pagination order", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              pageInfo: {
                hasNextPage: true,
                endCursor: "cursor-1",
              },
              nodes: [
                makeLinearIssue({
                  id: "1",
                  identifier: "ABC-1",
                  labels: ["Bug", "P1"],
                }),
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
              nodes: [
                makeLinearIssue({
                  id: "2",
                  identifier: "ABC-2",
                  blockers: [
                    {
                      type: "blocks",
                      issue: {
                        id: "block-1",
                        identifier: "ABC-0",
                        state: {
                          name: "In Progress",
                        },
                      },
                    },
                  ],
                }),
              ],
            },
          },
        }),
      );

    const client = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "demo-project",
      fetchFn: fetchMock,
    });

    const issues = await client.fetchCandidateIssues(["Todo", "In Progress"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.linear.app/graphql");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "linear-token",
    });

    const firstQuery = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(firstQuery.query).toContain("slugId");
    expect(firstQuery.variables).toMatchObject({
      projectSlug: "demo-project",
      states: ["Todo", "In Progress"],
      first: 50,
      after: null,
    });

    const secondQuery = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(secondQuery.variables.after).toBe("cursor-1");

    expect(issues).toEqual<LinearIssue[]>([
      expect.objectContaining({
        id: "1",
        identifier: "ABC-1",
        labels: ["bug", "p1"],
      }),
      expect.objectContaining({
        id: "2",
        identifier: "ABC-2",
        blockedBy: [
          {
            id: "block-1",
            identifier: "ABC-0",
            state: "In Progress",
          },
        ],
      }),
    ]);
  });

  it("returns early for fetchIssuesByStates([]) without calling the api", async () => {
    const fetchMock = vi.fn();
    const client = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "demo-project",
      fetchFn: fetchMock,
    });

    const issues = await client.fetchIssuesByStates([]);

    expect(issues).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches minimal issue state snapshots by GraphQL issue ids", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          issues: {
            nodes: [
              {
                id: "issue-1",
                identifier: "ABC-1",
                title: "Refresh state",
                state: { name: "Done" },
              },
            ],
          },
        },
      }),
    );

    const client = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "demo-project",
      fetchFn: fetchMock,
    });

    const issues = await client.fetchIssueStatesByIds(["issue-1"]);

    const queryBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(queryBody.query).toContain("$issueIds: [ID!]");
    expect(queryBody.variables.issueIds).toEqual(["issue-1"]);
    expect(issues).toEqual([
      {
        id: "issue-1",
        identifier: "ABC-1",
        title: "Refresh state",
        description: null,
        priority: null,
        state: "Done",
        branchName: null,
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      },
    ]);
  });

  it("maps transport, status, graphql, and malformed payload failures to typed tracker errors", async () => {
    const transportClient = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "demo-project",
      fetchFn: vi.fn().mockRejectedValue(new Error("socket closed")),
    });

    await expect(
      transportClient.fetchCandidateIssues(["Todo"]),
    ).rejects.toMatchObject({
      code: "linear_api_request",
    });

    const statusClient = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "demo-project",
      fetchFn: vi
        .fn()
        .mockResolvedValue(new Response("bad gateway", { status: 502 })),
    });

    await expect(
      statusClient.fetchCandidateIssues(["Todo"]),
    ).rejects.toMatchObject({
      code: "linear_api_status",
    });

    const graphqlClient = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "demo-project",
      fetchFn: vi
        .fn()
        .mockResolvedValue(jsonResponse({ errors: [{ message: "broken" }] })),
    });

    await expect(
      graphqlClient.fetchCandidateIssues(["Todo"]),
    ).rejects.toMatchObject({
      code: "linear_graphql_errors",
    });

    const malformedClient = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "demo-project",
      fetchFn: vi
        .fn()
        .mockResolvedValue(jsonResponse({ data: { issues: { nope: [] } } })),
    });

    await expect(
      malformedClient.fetchCandidateIssues(["Todo"]),
    ).rejects.toMatchObject({
      code: "linear_unknown_payload",
    });
  });

  it("raises a pagination integrity error when hasNextPage is true without an endCursor", async () => {
    const client = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "demo-project",
      fetchFn: vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issues: {
              pageInfo: {
                hasNextPage: true,
                endCursor: null,
              },
              nodes: [],
            },
          },
        }),
      ),
    });

    await expect(client.fetchCandidateIssues(["Todo"])).rejects.toMatchObject({
      code: "linear_missing_end_cursor",
    });
  });
});

function makeLinearIssue({
  id,
  identifier,
  labels = [],
  blockers = [],
}: {
  id: string;
  identifier: string;
  labels?: string[];
  blockers?: Array<{
    type: string;
    issue: {
      id: string;
      identifier: string;
      state?: { name?: string };
    };
  }>;
}) {
  return {
    id,
    identifier,
    title: `Issue ${identifier}`,
    description: `Description for ${identifier}`,
    priority: 2,
    branchName: `branch/${identifier}`,
    url: `https://linear.app/demo/issue/${identifier}`,
    createdAt: "2026-03-01T10:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
    state: {
      name: "Todo",
    },
    labels: {
      nodes: labels.map((name) => ({ name })),
    },
    inverseRelations: {
      nodes: blockers,
    },
  };
}
