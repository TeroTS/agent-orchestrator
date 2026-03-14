import {
  CodexAppServerClient,
  type CodexRuntimeEvent,
  type DeliveryCommandRunner,
} from "./app-server.js";
import type { OrchestrationIssue } from "../orchestrator/rules.js";
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
      const prompt = await renderPromptTemplate(this.workflowDefinition, {
        issue: {
          ...issueContext,
          comments: issueContext.comments ?? [],
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
}

function containsGitHubPullRequestUrl(body: string): boolean {
  return /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\S*/i.test(body);
}
