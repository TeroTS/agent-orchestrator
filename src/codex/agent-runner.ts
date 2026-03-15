import { execFile } from "node:child_process";
import {
  CodexAppServerClient,
  type CodexRuntimeEvent,
  type DeliveryCommandRunner,
} from "./app-server.js";
import { promisify } from "node:util";

import type {
  IssueComment,
  OrchestrationIssue,
} from "../orchestrator/rules.js";
import {
  createStructuredLogger,
  type StructuredLogger,
} from "../observability/structured-logger.js";
import {
  ensureWorkspace,
  finalizeWorkspaceRun,
  prepareWorkspaceForRun,
} from "../workspace/manager.js";
import {
  renderPromptTemplate,
  validateWorkflowForDispatch,
  type WorkflowDefinition,
} from "../workflow/loader.js";

export interface AgentRunnerOptions {
  workflowDefinition: WorkflowDefinition;
  issueStateRefresher: (issueIds: string[]) => Promise<OrchestrationIssue[]>;
  issueContextFetcher?: (issueId: string) => Promise<OrchestrationIssue>;
  linearFetchFn?: typeof fetch;
  githubReviewFeedbackFetcher?: (input: {
    issue: OrchestrationIssue;
    workspacePath: string;
  }) => Promise<{
    reviewRound: number | null;
    reviewUrl: string | null;
    summary: string | null;
    comments: IssueComment[];
  } | null>;
  deliveryCommandRunner?: DeliveryCommandRunner;
  templateReadFile?: typeof import("node:fs/promises").readFile;
  logger?: StructuredLogger;
}

export class AgentRunner {
  private readonly workflowDefinition: WorkflowDefinition;
  private readonly issueStateRefresher: (
    issueIds: string[],
  ) => Promise<OrchestrationIssue[]>;
  private readonly issueContextFetcher:
    | ((issueId: string) => Promise<OrchestrationIssue>)
    | undefined;
  private readonly linearFetchFn: typeof fetch | undefined;
  private readonly githubReviewFeedbackFetcher:
    | AgentRunnerOptions["githubReviewFeedbackFetcher"]
    | undefined;
  private readonly deliveryCommandRunner:
    | AgentRunnerOptions["deliveryCommandRunner"]
    | undefined;
  private readonly templateReadFile:
    | AgentRunnerOptions["templateReadFile"]
    | undefined;
  private readonly logger: StructuredLogger;

  constructor(options: AgentRunnerOptions) {
    this.workflowDefinition = options.workflowDefinition;
    this.issueStateRefresher = options.issueStateRefresher;
    this.issueContextFetcher = options.issueContextFetcher;
    this.linearFetchFn = options.linearFetchFn;
    this.githubReviewFeedbackFetcher = options.githubReviewFeedbackFetcher;
    this.deliveryCommandRunner = options.deliveryCommandRunner;
    this.templateReadFile = options.templateReadFile;
    this.logger = options.logger ?? createStructuredLogger();
  }

  async runAttempt(input: {
    issue: OrchestrationIssue;
    attempt: number | null;
    signal?: AbortSignal;
    onEvent?: (event: CodexRuntimeEvent) => void;
  }): Promise<{ reason: "normal" }> {
    const validation = validateWorkflowForDispatch(this.workflowDefinition);
    if (!validation.ok) {
      throw new Error(validation.errors.join(", "));
    }
    const config = validation.config;
    this.logger.info("run attempt started", {
      attempt: input.attempt ?? 0,
      issue_id: input.issue.id,
      issue_identifier: input.issue.identifier,
    });

    const workspace = await ensureWorkspace({
      workspaceRoot: config.workspace.root,
      issueIdentifier: input.issue.identifier,
      hooks: config.hooks,
    });
    this.logger.info("workspace ready", {
      created_now: workspace.createdNow,
      issue_id: input.issue.id,
      issue_identifier: input.issue.identifier,
      workspace_path: workspace.path,
    });

    await prepareWorkspaceForRun({
      workspacePath: workspace.path,
      hooks: config.hooks,
    });
    this.logger.info("workspace prepared", {
      issue_id: input.issue.id,
      issue_identifier: input.issue.identifier,
      workspace_path: workspace.path,
    });

    let issue = input.issue;
    const client = new CodexAppServerClient({
      command: config.codex.command,
      workspacePath: workspace.path,
      approvalPolicy: config.codex.approvalPolicy ?? "never",
      threadSandbox: config.codex.threadSandbox ?? "workspace-write",
      turnSandboxPolicy: config.codex.turnSandboxPolicy ?? {
        type: "workspaceWrite",
      },
      readTimeoutMs: config.codex.readTimeoutMs,
      turnTimeoutMs: config.codex.turnTimeoutMs,
      linearGraphql: {
        endpoint: config.tracker.endpoint,
        apiKey: config.tracker.apiKey,
        projectSlug: config.tracker.projectSlug,
        ...(this.linearFetchFn ? { fetchFn: this.linearFetchFn } : {}),
      },
      issueDelivery: {
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        branchName: issue.branchName,
        ...(this.deliveryCommandRunner
          ? { commandRunner: this.deliveryCommandRunner }
          : {}),
        ...(this.templateReadFile ? { readFileFn: this.templateReadFile } : {}),
      },
      logger: this.logger,
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    });

    const abortHandler = () => {
      void client.stop();
    };

    try {
      input.signal?.addEventListener("abort", abortHandler);
      if (input.signal?.aborted) {
        throw new Error("run canceled");
      }

      await client.start();
      this.logger.info("codex session ready", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        workspace_path: workspace.path,
      });

      if (input.signal?.aborted) {
        throw new Error("run canceled");
      }

      const issueContext =
        (await this.issueContextFetcher?.(issue.id).catch(() => issue)) ??
        issue;
      const promptIssue = await this.enrichIssueContextWithGithubReviewFeedback(
        issueContext,
        workspace.path,
      );
      const prompt = await renderPromptTemplate(this.workflowDefinition, {
        issue: {
          ...promptIssue,
          comments: promptIssue.comments ?? [],
          githubReviewSummary: promptIssue.githubReviewSummary ?? null,
          githubReviewRound: promptIssue.githubReviewRound ?? null,
          githubReviewUrl: promptIssue.githubReviewUrl ?? null,
          githubReviewComments: promptIssue.githubReviewComments ?? [],
        },
        attempt: input.attempt,
      });

      this.logger.info("run turn started", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        turn_number: 1,
      });
      const turnResult = await client.runTurn({
        prompt,
        title: `${issue.identifier}: ${issue.title}`,
      });
      this.logger.info("run turn completed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        turn_number: 1,
      });

      if (!turnResult.deliveryResult?.commentId) {
        if (!turnResult.completionComment) {
          throw new Error("Codex did not post a completion comment.");
        }
        if (!containsGitHubPullRequestUrl(turnResult.completionComment.body)) {
          throw new Error(
            "Codex did not include a GitHub PR URL in the completion comment.",
          );
        }
      } else if (!turnResult.deliveryResult?.prUrl) {
        throw new Error(
          "Codex did not include a GitHub PR URL in the delivery result.",
        );
      }

      const refreshedIssues = await this.issueStateRefresher([issue.id]);
      if (refreshedIssues[0]) {
        issue = refreshedIssues[0];
        this.logger.info("issue state refreshed", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          state: issue.state,
        });
      }

      this.logger.info("run attempt completed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        workspace_path: workspace.path,
      });
      return { reason: "normal" };
    } catch (error) {
      this.logger.error("run attempt failed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        reason: error instanceof Error ? error.message : String(error),
        workspace_path: workspace.path,
      });
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", abortHandler);
      await client.stop();
      await finalizeWorkspaceRun({
        workspacePath: workspace.path,
        hooks: config.hooks,
      });
      this.logger.info("workspace finalized", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        workspace_path: workspace.path,
      });
    }
  }

  private async enrichIssueContextWithGithubReviewFeedback(
    issue: OrchestrationIssue,
    workspacePath: string,
  ): Promise<OrchestrationIssue> {
    const baseIssue: OrchestrationIssue = {
      ...issue,
      comments: issue.comments ?? [],
      githubReviewSummary: issue.githubReviewSummary ?? null,
      githubReviewRound: issue.githubReviewRound ?? null,
      githubReviewUrl: issue.githubReviewUrl ?? null,
      githubReviewComments: issue.githubReviewComments ?? [],
    };

    if (issue.state.toLowerCase() !== "rework") {
      return baseIssue;
    }

    const fetcher =
      this.githubReviewFeedbackFetcher ?? fetchGithubReviewFeedback;

    try {
      const feedback = await fetcher({
        issue: baseIssue,
        workspacePath,
      });
      if (!feedback) {
        return baseIssue;
      }

      return {
        ...baseIssue,
        githubReviewSummary: feedback.summary,
        githubReviewRound: feedback.reviewRound,
        githubReviewUrl: feedback.reviewUrl,
        githubReviewComments: feedback.comments,
      };
    } catch (error) {
      this.logger.warn("github review feedback fetch failed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        reason: error instanceof Error ? error.message : String(error),
      });
      return baseIssue;
    }
  }
}

function containsGitHubPullRequestUrl(body: string): boolean {
  return /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\S*/i.test(body);
}

const execFileAsync = promisify(execFile);

async function fetchGithubReviewFeedback(input: {
  issue: OrchestrationIssue;
  workspacePath: string;
}): Promise<{
  reviewRound: number | null;
  reviewUrl: string | null;
  summary: string | null;
  comments: IssueComment[];
} | null> {
  if (!input.issue.branchName) {
    return null;
  }

  const repo = (
    await runGhCommand(
      ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
      input.workspacePath,
    )
  ).trim();
  if (!repo) {
    return null;
  }

  const pullRequests = JSON.parse(
    await runGhCommand(
      [
        "pr",
        "list",
        "--repo",
        repo,
        "--head",
        input.issue.branchName,
        "--state",
        "open",
        "--json",
        "number,url",
      ],
      input.workspacePath,
    ),
  ) as Array<{ number?: number; url?: string }>;
  if (!Array.isArray(pullRequests) || pullRequests.length === 0) {
    return null;
  }
  if (pullRequests.length > 1) {
    throw new Error("multiple open pull requests for branch");
  }

  const pullRequest = pullRequests[0];
  if (!pullRequest?.number) {
    return null;
  }

  const reviews = JSON.parse(
    await runGhCommand(
      ["api", `repos/${repo}/pulls/${pullRequest.number}/reviews?per_page=100`],
      input.workspacePath,
    ),
  ) as Array<{
    id?: number;
    state?: string;
    body?: string | null;
    submitted_at?: string | null;
  }>;
  const blockingReviews = (Array.isArray(reviews) ? reviews : []).filter(
    (review) => review?.state === "CHANGES_REQUESTED",
  );
  if (blockingReviews.length === 0) {
    return null;
  }

  const latestBlockingReview = [...blockingReviews].sort((left, right) =>
    String(left?.submitted_at ?? "").localeCompare(
      String(right?.submitted_at ?? ""),
    ),
  )[blockingReviews.length - 1];
  const latestReviewId = latestBlockingReview?.id;
  const latestReviewTimestamp = Date.parse(
    String(latestBlockingReview?.submitted_at ?? ""),
  );

  const reviewComments = JSON.parse(
    await runGhCommand(
      [
        "api",
        `repos/${repo}/pulls/${pullRequest.number}/comments?per_page=100`,
      ],
      input.workspacePath,
    ),
  ) as Array<{
    id?: number;
    body?: string | null;
    path?: string | null;
    line?: number | null;
    original_line?: number | null;
    html_url?: string | null;
    created_at?: string | null;
    pull_request_review_id?: number | null;
    user?: { login?: string | null } | null;
  }>;

  const comments = (Array.isArray(reviewComments) ? reviewComments : [])
    .filter((comment) => {
      if (
        latestReviewId != null &&
        comment?.pull_request_review_id != null &&
        comment.pull_request_review_id === latestReviewId
      ) {
        return true;
      }

      const createdAt = Date.parse(String(comment?.created_at ?? ""));
      return (
        !Number.isNaN(latestReviewTimestamp) &&
        !Number.isNaN(createdAt) &&
        createdAt >= latestReviewTimestamp
      );
    })
    .map((comment): IssueComment | null => {
      const location = [comment.path, comment.line ?? comment.original_line]
        .filter(
          (value) => value !== undefined && value !== null && value !== "",
        )
        .join(":");
      const body = normalizePromptText(comment.body);
      if (!comment.id || !body) {
        return null;
      }
      return {
        id: String(comment.id),
        body: location ? `${location} ${body}` : body,
        url: comment.html_url ?? null,
        authorName: comment.user?.login ?? null,
        createdAt: parsePromptDate(comment.created_at),
      };
    })
    .filter((comment): comment is IssueComment => comment !== null);

  return {
    reviewRound: blockingReviews.length,
    reviewUrl: pullRequest.url ?? null,
    summary: normalizePromptText(latestBlockingReview?.body),
    comments,
  };
}

async function runGhCommand(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync("gh", args, {
    cwd,
    encoding: "utf8",
  });
  return result.stdout;
}

function normalizePromptText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized : null;
}

function parsePromptDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
