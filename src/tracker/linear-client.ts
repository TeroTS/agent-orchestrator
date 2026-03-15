import {
  createStructuredLogger,
  type StructuredLogger,
} from "../observability/structured-logger.js";
import type { IssueComment } from "../orchestrator/rules.js";

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
  comments: IssueComment[];
  githubReviewSummary?: string | null;
  githubReviewRound?: number | null;
  githubReviewUrl?: string | null;
  githubReviewComments?: IssueComment[];
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
  projectSlug?: string;
  fetchFn?: typeof fetch;
  logger?: StructuredLogger;
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
const MAX_LOG_PREVIEW_LENGTH = 1000;

export class LinearTrackerClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly projectSlug: string | null;
  private readonly fetchFn: typeof fetch;
  private readonly logger: StructuredLogger;
  private readonly pageSize: number;
  private readonly timeoutMs: number;

  constructor(options: LinearTrackerClientOptions) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.projectSlug = options.projectSlug?.trim() || null;
    this.fetchFn = options.fetchFn ?? fetch;
    this.logger = options.logger ?? createStructuredLogger();
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

    const projectSlug = this.requireProjectSlug();
    const issues: LinearIssue[] = [];
    let after: string | null = null;

    do {
      const payload: GraphQLResponse<LinearCandidateIssuesPayload> =
        await this.request<LinearCandidateIssuesPayload>({
          query: candidateIssuesQuery,
          variables: {
            projectSlug,
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

  async fetchIssueContextById(issueId: string): Promise<LinearIssue> {
    const payload: GraphQLResponse<LinearIssueContextPayload> =
      await this.request<LinearIssueContextPayload>({
        query: issueContextByIdQuery,
        variables: {
          id: issueId,
          commentsFirst: 5,
        },
      });

    const issue = payload.data?.issue;
    if (!issue?.id || !issue.identifier) {
      throw new TrackerError(
        "linear_unknown_payload",
        "Linear issue context payload was malformed.",
      );
    }

    return normalizeIssue(issue);
  }

  async fetchIssueContextByIdentifier(
    issueIdentifier: string,
  ): Promise<LinearIssue> {
    const payload: GraphQLResponse<LinearIssueContextByIdentifierPayload> =
      await this.request<LinearIssueContextByIdentifierPayload>({
        query: issueContextByIdentifierQuery,
        variables: {
          id: issueIdentifier,
          commentsFirst: 20,
        },
      });

    const issue = payload.data?.issue;
    if (!issue?.id || !issue.identifier) {
      throw new TrackerError(
        "linear_unknown_payload",
        `Linear issue lookup payload was malformed for identifier ${issueIdentifier}.`,
      );
    }

    return normalizeIssue(issue);
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

  private requireProjectSlug(): string {
    if (this.projectSlug) {
      return this.projectSlug;
    }

    throw new TrackerError(
      "linear_project_slug_required",
      "Linear project slug is required for project-scoped issue queries.",
    );
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
    const startedAt = Date.now();
    const operationName = extractOperationName(body.query);

    this.logger.debug("linear api request", {
      endpoint: this.endpoint,
      operation_name: operationName,
      graphql_query: body.query,
      graphql_variables: body.variables,
    });

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
      const responseText = await response.text();
      const durationMs = Date.now() - startedAt;
      const operationDetail = operationName
        ? ` while executing ${operationName}`
        : "";
      const graphqlErrorDetail = extractGraphQLErrorDetail(responseText);

      if (!response.ok) {
        const errorMessage = graphqlErrorDetail
          ? `Linear responded with HTTP ${response.status}${operationDetail}. GraphQL errors: ${graphqlErrorDetail}`
          : `Linear responded with HTTP ${response.status}${operationDetail}.`;
        this.logger.debug("linear api request failed", {
          duration_ms: durationMs,
          endpoint: this.endpoint,
          error_code: "linear_api_status",
          error_message: errorMessage,
          operation_name: operationName,
          response_preview: previewForLog(responseText),
          status: response.status,
        });
        throw new TrackerError("linear_api_status", errorMessage);
      }

      let payload: GraphQLResponse<T>;
      try {
        payload = (
          responseText ? JSON.parse(responseText) : {}
        ) as GraphQLResponse<T>;
      } catch {
        const errorMessage = `Linear returned a non-JSON response body${operationDetail}.`;
        this.logger.debug("linear api request failed", {
          duration_ms: durationMs,
          endpoint: this.endpoint,
          error_code: "linear_graphql_invalid_json_response",
          error_message: errorMessage,
          operation_name: operationName,
          response_preview: previewForLog(responseText),
          status: response.status,
        });
        throw new TrackerError(
          "linear_graphql_invalid_json_response",
          errorMessage,
        );
      }

      if (Array.isArray(payload.errors) && payload.errors.length > 0) {
        const errorMessage = `Linear returned GraphQL errors${operationDetail}.`;
        this.logger.debug("linear api request failed", {
          duration_ms: durationMs,
          endpoint: this.endpoint,
          error_code: "linear_graphql_errors",
          error_message: errorMessage,
          graphql_errors: payload.errors,
          operation_name: operationName,
          response_preview: previewForLog(responseText),
          status: response.status,
        });
        throw new TrackerError("linear_graphql_errors", errorMessage);
      }

      this.logger.debug("linear api request succeeded", {
        duration_ms: durationMs,
        endpoint: this.endpoint,
        operation_name: operationName,
        response_preview: previewForLog(responseText),
        status: response.status,
      });

      return payload;
    } catch (error) {
      if (error instanceof TrackerError) {
        throw error;
      }

      this.logger.debug("linear api request failed", {
        duration_ms: Date.now() - startedAt,
        endpoint: this.endpoint,
        error_code: "linear_api_request",
        error_message: error instanceof Error ? error.message : String(error),
        operation_name: operationName,
      });

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

function extractOperationName(query: string): string | null {
  const match = /^\s*(query|mutation)\s+([_A-Za-z][_0-9A-Za-z]*)/m.exec(query);
  return match?.[2] ?? null;
}

function previewForLog(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.length <= MAX_LOG_PREVIEW_LENGTH) {
    return trimmed;
  }

  return `${trimmed.slice(0, MAX_LOG_PREVIEW_LENGTH)}...(truncated)`;
}

function extractGraphQLErrorDetail(responseText: string): string | null {
  const trimmed = responseText.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const payload = JSON.parse(trimmed) as GraphQLResponse<unknown>;
    if (!Array.isArray(payload.errors) || payload.errors.length === 0) {
      return null;
    }

    const messages = payload.errors
      .map((error) => error?.message?.trim())
      .filter((message): message is string => typeof message === "string")
      .filter((message) => message.length > 0);

    return messages.length > 0 ? messages.join("; ") : null;
  } catch {
    return null;
  }
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

interface LinearIssueContextPayload {
  issue?: LinearIssueNode | null;
}

interface LinearIssueContextByIdentifierPayload {
  issue?: LinearIssueNode | null;
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
  comments?: {
    nodes?: Array<{
      id?: string;
      body?: string;
      url?: string | null;
      createdAt?: string | null;
      user?: {
        name?: string | null;
      } | null;
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
    comments: (node.comments?.nodes ?? [])
      .filter(
        (
          comment,
        ): comment is {
          id: string;
          body: string;
          url?: string | null;
          createdAt?: string | null;
          user?: { name?: string | null } | null;
        } => !!comment?.id && typeof comment.body === "string",
      )
      .map((comment) => ({
        id: comment.id,
        body: comment.body,
        url: comment.url ?? null,
        authorName: comment.user?.name ?? null,
        createdAt: parseDate(comment.createdAt),
      })),
    githubReviewSummary: null,
    githubReviewRound: null,
    githubReviewUrl: null,
    githubReviewComments: [],
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

const issueContextByIdQuery = `
  query IssueContextById($id: String!, $commentsFirst: Int!) {
    issue(id: $id) {
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
      comments(first: $commentsFirst) {
        nodes {
          id
          body
          url
          createdAt
          user {
            name
          }
        }
      }
    }
  }
`;

const issueContextByIdentifierQuery = `
  query IssueContextByIdentifier($id: String!, $commentsFirst: Int!) {
    issue(id: $id) {
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
      comments(first: $commentsFirst) {
        nodes {
          id
          body
          url
          createdAt
          user {
            name
          }
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
