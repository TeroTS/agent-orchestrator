export interface LinearBlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: LinearBlockerRef[];
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface LinearComment {
  id: string;
  body: string;
  url: string | null;
}

export interface LinearTrackerClientOptions {
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  fetchFn?: typeof fetch;
  pageSize?: number;
  timeoutMs?: number;
}

export class TrackerError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "TrackerError";
  }
}

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 30000;

export class LinearTrackerClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly projectSlug: string;
  private readonly fetchFn: typeof fetch;
  private readonly pageSize: number;
  private readonly timeoutMs: number;

  constructor(options: LinearTrackerClientOptions) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.projectSlug = options.projectSlug;
    this.fetchFn = options.fetchFn ?? fetch;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async fetchCandidateIssues(activeStates: string[]): Promise<LinearIssue[]> {
    return this.fetchIssuesByStates(activeStates);
  }

  async fetchIssuesByStates(states: string[]): Promise<LinearIssue[]> {
    if (states.length === 0) {
      return [];
    }

    const issues: LinearIssue[] = [];
    let after: string | null = null;

    do {
      const payload: GraphQLResponse<LinearCandidateIssuesPayload> =
        await this.request<LinearCandidateIssuesPayload>({
          query: candidateIssuesQuery,
          variables: {
            projectSlug: this.projectSlug,
            states,
            first: this.pageSize,
            after,
          },
        });

      const connection: LinearCandidateIssuesPayload["issues"] | undefined =
        payload.data?.issues;
      if (!isIssuesConnection(connection)) {
        throw new TrackerError(
          "linear_unknown_payload",
          "Linear issues payload was malformed.",
        );
      }

      issues.push(...connection.nodes.map(normalizeIssue));

      if (connection.pageInfo.hasNextPage) {
        if (!connection.pageInfo.endCursor) {
          throw new TrackerError(
            "linear_missing_end_cursor",
            "Linear returned hasNextPage=true without an endCursor.",
          );
        }
        after = connection.pageInfo.endCursor;
      } else {
        after = null;
      }
    } while (after);

    return issues;
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<LinearIssue[]> {
    if (issueIds.length === 0) {
      return [];
    }

    const payload: GraphQLResponse<LinearIssueStatePayload> =
      await this.request<LinearIssueStatePayload>({
        query: issueStatesByIdsQuery,
        variables: {
          issueIds,
        },
      });

    const connection: LinearIssueStatePayload["issues"] | undefined =
      payload.data?.issues;
    if (!connection || !Array.isArray(connection.nodes)) {
      throw new TrackerError(
        "linear_unknown_payload",
        "Linear issue state payload was malformed.",
      );
    }

    return connection.nodes.map(normalizeIssue);
  }

  async transitionIssueToState(
    issueId: string,
    stateName: string,
  ): Promise<LinearIssue> {
    const stateId = await this.resolveWorkflowStateId(issueId, stateName);
    const payload: GraphQLResponse<LinearIssueUpdatePayload> =
      await this.request<LinearIssueUpdatePayload>({
        query: issueUpdateMutation,
        variables: {
          id: issueId,
          stateId,
        },
      });

    const updatedIssue = payload.data?.issueUpdate?.issue;
    if (!updatedIssue || !payload.data?.issueUpdate?.success) {
      throw new TrackerError(
        "linear_unknown_payload",
        "Linear issue update payload was malformed.",
      );
    }

    return normalizeIssue(updatedIssue);
  }

  async createIssueComment(
    issueId: string,
    body: string,
  ): Promise<LinearComment> {
    if (!body.trim()) {
      throw new TrackerError(
        "linear_invalid_comment_body",
        "Linear issue comment body must be non-empty.",
      );
    }

    const payload: GraphQLResponse<LinearCommentCreatePayload> =
      await this.request<LinearCommentCreatePayload>({
        query: issueCommentCreateMutation,
        variables: {
          issueId,
          body,
        },
      });

    const createdComment = payload.data?.commentCreate?.comment;
    if (
      !payload.data?.commentCreate?.success ||
      !createdComment?.id ||
      typeof createdComment.body !== "string"
    ) {
      throw new TrackerError(
        "linear_unknown_payload",
        "Linear comment creation payload was malformed.",
      );
    }

    return {
      id: createdComment.id,
      body: createdComment.body,
      url: createdComment.url ?? null,
    };
  }

  private async resolveWorkflowStateId(
    issueId: string,
    stateName: string,
  ): Promise<string> {
    const payload: GraphQLResponse<LinearIssueTeamStatesPayload> =
      await this.request<LinearIssueTeamStatesPayload>({
        query: issueTeamStatesQuery,
        variables: {
          id: issueId,
        },
      });

    const states = payload.data?.issue?.team?.states?.nodes;
    if (!Array.isArray(states)) {
      throw new TrackerError(
        "linear_unknown_payload",
        "Linear issue team states payload was malformed.",
      );
    }

    const target = states.find(
      (state) =>
        typeof state?.name === "string" &&
        state.name.toLowerCase() === stateName.toLowerCase(),
    );
    if (!target?.id) {
      throw new TrackerError(
        "linear_state_not_found",
        `Linear workflow state '${stateName}' was not found for issue ${issueId}.`,
      );
    }

    return target.id;
  }

  private async request<T>(body: {
    query: string;
    variables: Record<string, unknown>;
  }): Promise<GraphQLResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: this.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new TrackerError(
          "linear_api_status",
          `Linear responded with HTTP ${response.status}.`,
        );
      }

      const payload = (await response.json()) as GraphQLResponse<T>;

      if (Array.isArray(payload.errors) && payload.errors.length > 0) {
        throw new TrackerError(
          "linear_graphql_errors",
          "Linear returned GraphQL errors.",
        );
      }

      return payload;
    } catch (error) {
      if (error instanceof TrackerError) {
        throw error;
      }

      throw new TrackerError("linear_api_request", "Linear request failed.", {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface LinearCandidateIssuesPayload {
  issues: {
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
    nodes: LinearIssueNode[];
  };
}

interface LinearIssueStatePayload {
  issues: {
    nodes: LinearIssueNode[];
  };
}

interface LinearIssueTeamStatesPayload {
  issue?: {
    id?: string;
    team?: {
      id?: string;
      states?: {
        nodes?: Array<{
          id?: string;
          name?: string;
          type?: string;
        }>;
      };
    };
  };
}

interface LinearIssueUpdatePayload {
  issueUpdate?: {
    success?: boolean;
    issue?: LinearIssueNode;
  };
}

interface LinearCommentCreatePayload {
  commentCreate?: {
    success?: boolean;
    comment?: {
      id?: string;
      body?: string;
      url?: string | null;
    } | null;
  };
}

interface LinearIssueNode {
  id: string;
  identifier: string;
  title?: string;
  description?: string | null;
  priority?: unknown;
  state?: {
    name?: string;
  };
  branchName?: string | null;
  url?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  labels?: {
    nodes?: Array<{ name?: string }>;
  };
  inverseRelations?: {
    nodes?: Array<{
      type?: string;
      issue?: {
        id?: string;
        identifier?: string;
        state?: {
          name?: string;
        };
      };
    }>;
  };
}

function normalizeIssue(node: LinearIssueNode): LinearIssue {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title ?? "",
    description: node.description ?? null,
    priority: Number.isInteger(node.priority)
      ? (node.priority as number)
      : null,
    state: node.state?.name ?? "",
    branchName: node.branchName ?? null,
    url: node.url ?? null,
    labels: (node.labels?.nodes ?? [])
      .map((label) => label.name)
      .filter((label): label is string => typeof label === "string")
      .map((label) => label.toLowerCase()),
    blockedBy: (node.inverseRelations?.nodes ?? [])
      .filter((relation) => relation.type === "blocks")
      .map((relation) => ({
        id: relation.issue?.id ?? null,
        identifier: relation.issue?.identifier ?? null,
        state: relation.issue?.state?.name ?? null,
      })),
    createdAt: parseDate(node.createdAt),
    updatedAt: parseDate(node.updatedAt),
  };
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isIssuesConnection(
  value: unknown,
): value is LinearCandidateIssuesPayload["issues"] {
  if (!isRecord(value)) {
    return false;
  }

  return (
    Array.isArray(value.nodes) &&
    isRecord(value.pageInfo) &&
    typeof value.pageInfo.hasNextPage === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const candidateIssuesQuery = `
  query CandidateIssues($projectSlug: String!, $states: [String!]!, $first: Int!, $after: String) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $states } }
      }
      first: $first
      after: $after
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        identifier
        title
        description
        priority
        branchName
        url
        createdAt
        updatedAt
        state {
          name
        }
        labels {
          nodes {
            name
          }
        }
        inverseRelations {
          nodes {
            type
            issue {
              id
              identifier
              state {
                name
              }
            }
          }
        }
      }
    }
  }
`;

const issueStatesByIdsQuery = `
  query IssueStatesByIds($issueIds: [ID!]) {
    issues(filter: { id: { in: $issueIds } }) {
      nodes {
        id
        identifier
        title
        description
        priority
        branchName
        url
        createdAt
        updatedAt
        state {
          name
        }
      }
    }
  }
`;

const issueTeamStatesQuery = `
  query IssueTeamStates($id: String!) {
    issue(id: $id) {
      id
      team {
        id
        states {
          nodes {
            id
            name
            type
          }
        }
      }
    }
  }
`;

const issueUpdateMutation = `
  mutation MoveIssueToState($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
      issue {
        id
        identifier
        title
        description
        priority
        branchName
        url
        createdAt
        updatedAt
        state {
          name
        }
        labels {
          nodes {
            name
          }
        }
        inverseRelations {
          nodes {
            type
            issue {
              id
              identifier
              state {
                name
              }
            }
          }
        }
      }
    }
  }
`;

const issueCommentCreateMutation = `
  mutation CreateIssueComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment {
        id
        body
        url
      }
    }
  }
`;
