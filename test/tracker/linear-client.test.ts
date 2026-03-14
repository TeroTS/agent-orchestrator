import { describe, expect, it, vi } from "vitest";

import {
  LinearTrackerClient,
  type LinearIssue,
} from "../../src/tracker/linear-client.js";
import { createStructuredLogger } from "../../src/observability/structured-logger.js";

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
        comments: [],
        createdAt: null,
        updatedAt: null,
      },
    ]);
  });

  it("fetches full issue context with recent comments for prompt rendering", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          issue: {
            id: "issue-1",
            identifier: "ABC-1",
            title: "Refresh state",
            description: "Investigate reviewer feedback.",
            priority: 2,
            branchName: "abc-1-fix",
            url: "https://linear.app/demo/issue/ABC-1",
            createdAt: "2026-03-01T10:00:00.000Z",
            updatedAt: "2026-03-01T12:00:00.000Z",
            state: { name: "Rework" },
            comments: {
              nodes: [
                {
                  id: "comment-1",
                  body: "GitHub review: add a missing regression test.",
                  url: "https://linear.app/demo/comment/comment-1",
                  createdAt: "2026-03-14T12:00:00.000Z",
                  user: {
                    name: "Claude Reviewer",
                  },
                },
              ],
            },
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

    const issue = await client.fetchIssueContextById("issue-1");

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody.query).toContain("IssueContextById");
    expect(requestBody.variables).toEqual({ id: "issue-1", commentsFirst: 5 });
    expect(issue).toMatchObject({
      id: "issue-1",
      identifier: "ABC-1",
      state: "Rework",
      comments: [
        {
          id: "comment-1",
          body: "GitHub review: add a missing regression test.",
          url: "https://linear.app/demo/comment/comment-1",
          authorName: "Claude Reviewer",
        },
      ],
    });
  });

  it("moves an issue to a named workflow state by resolving the team state id first", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issue: {
              id: "issue-1",
              team: {
                id: "team-1",
                states: {
                  nodes: [
                    { id: "state-1", name: "Todo", type: "unstarted" },
                    {
                      id: "state-2",
                      name: "In Progress",
                      type: "started",
                    },
                    {
                      id: "state-3",
                      name: "In Review",
                      type: "started",
                    },
                  ],
                },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issueUpdate: {
              success: true,
              issue: {
                id: "issue-1",
                identifier: "ABC-1",
                title: "Refresh state",
                state: {
                  name: "In Review",
                },
              },
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

    const issue = await client.transitionIssueToState("issue-1", "In Review");

    const lookupBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(lookupBody.query).toContain("IssueTeamStates");
    expect(lookupBody.variables).toEqual({ id: "issue-1" });

    const updateBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(updateBody.query).toContain("MoveIssueToState");
    expect(updateBody.variables).toEqual({
      id: "issue-1",
      stateId: "state-3",
    });

    expect(issue).toMatchObject({
      id: "issue-1",
      identifier: "ABC-1",
      state: "In Review",
    });
  });

  it("creates an issue comment and returns the created comment metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          commentCreate: {
            success: true,
            comment: {
              id: "comment-1",
              body: "Implemented the fix and ran npm test.",
              url: "https://linear.app/demo/comment/comment-1",
            },
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

    const comment = await client.createIssueComment(
      "issue-1",
      "Implemented the fix and ran npm test.",
    );

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody.query).toContain("CreateIssueComment");
    expect(requestBody.variables).toEqual({
      issueId: "issue-1",
      body: "Implemented the fix and ran npm test.",
    });
    expect(comment).toEqual({
      id: "comment-1",
      body: "Implemented the fix and ran npm test.",
      url: "https://linear.app/demo/comment/comment-1",
    });
  });

  it("fails with a typed error when comment creation returns a malformed payload", async () => {
    const client = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "demo-project",
      fetchFn: vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            commentCreate: {
              success: true,
              comment: null,
            },
          },
        }),
      ),
    });

    await expect(
      client.createIssueComment("issue-1", "Implemented the fix."),
    ).rejects.toMatchObject({
      code: "linear_unknown_payload",
    });
  });

  it("fails with a typed error when the named destination workflow state is missing", async () => {
    const client = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "demo-project",
      fetchFn: vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issue: {
              id: "issue-1",
              team: {
                id: "team-1",
                states: {
                  nodes: [{ id: "state-1", name: "Todo", type: "unstarted" }],
                },
              },
            },
          },
        }),
      ),
    });

    await expect(
      client.transitionIssueToState("issue-1", "In Review"),
    ).rejects.toMatchObject({
      code: "linear_state_not_found",
    });
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

  it("emits debug request and response logs for successful api calls", async () => {
    const lines: string[] = [];
    const client = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "demo-project",
      fetchFn: vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issues: {
              nodes: [],
            },
          },
        }),
      ),
      logger: createStructuredLogger({
        level: "debug",
        write: (line) => lines.push(line),
      }),
    });

    await client.fetchIssueStatesByIds(["issue-1"]);

    expect(
      lines.some((line) => line.includes('msg="linear api request"')),
    ).toBe(true);
    expect(
      lines.some((line) => line.includes('msg="linear api request succeeded"')),
    ).toBe(true);
    expect(lines.join("\n")).toContain("graphql_query=");
    expect(lines.join("\n")).toContain("graphql_variables=");
    expect(lines.join("\n")).toContain("status=200");
    expect(lines.join("\n")).not.toContain("linear-token");
  });

  it("emits bounded debug failure logs for http and graphql errors", async () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
      level: "debug",
      write: (line) => lines.push(line),
    });

    const statusClient = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "demo-project",
      fetchFn: vi
        .fn()
        .mockResolvedValue(new Response("x".repeat(1200), { status: 502 })),
      logger,
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
      logger,
    });

    await expect(
      graphqlClient.fetchCandidateIssues(["Todo"]),
    ).rejects.toMatchObject({
      code: "linear_graphql_errors",
    });

    const output = lines.join("\n");
    expect(output).toContain('msg="linear api request failed"');
    expect(output).toContain("error_code=linear_api_status");
    expect(output).toContain("error_code=linear_graphql_errors");
    expect(output).toContain("status=502");
    expect(output).toContain("response_preview=");
    expect(output).toContain("...(truncated)");
    expect(output).toContain("graphql_errors=");
    expect(output).not.toContain("linear-token");
  });

  it("suppresses debug request logs above the info threshold", async () => {
    const lines: string[] = [];
    const client = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "demo-project",
      fetchFn: vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issues: {
              nodes: [],
            },
          },
        }),
      ),
      logger: createStructuredLogger({
        level: "info",
        write: (line) => lines.push(line),
      }),
    });

    await client.fetchIssueStatesByIds(["issue-1"]);

    expect(lines).toEqual([]);
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
