import { CodexAppServerClient } from "./codex-app-server.js";
import type { OrchestrationIssue } from "./orchestration-rules.js";
import {
  ensureWorkspace,
  finalizeWorkspaceRun,
  prepareWorkspaceForRun
} from "./workspace-manager.js";
import {
  renderPromptTemplate,
  validateWorkflowForDispatch,
  type WorkflowDefinition
} from "./workflow-loader.js";

export interface AgentRunnerOptions {
  workflowDefinition: WorkflowDefinition;
  issueStateRefresher: (issueIds: string[]) => Promise<OrchestrationIssue[]>;
}

export class AgentRunner {
  private readonly workflowDefinition: WorkflowDefinition;
  private readonly issueStateRefresher: (issueIds: string[]) => Promise<OrchestrationIssue[]>;

  constructor(options: AgentRunnerOptions) {
    this.workflowDefinition = options.workflowDefinition;
    this.issueStateRefresher = options.issueStateRefresher;
  }

  async runAttempt(input: {
    issue: OrchestrationIssue;
    attempt: number | null;
    signal?: AbortSignal;
  }): Promise<{ reason: "normal" }> {
    const validation = validateWorkflowForDispatch(this.workflowDefinition);
    if (!validation.ok) {
      throw new Error(validation.errors.join(", "));
    }
    const config = validation.config;

    const workspace = await ensureWorkspace({
      workspaceRoot: config.workspace.root,
      issueIdentifier: input.issue.identifier,
      hooks: config.hooks
    });

    await prepareWorkspaceForRun({
      workspacePath: workspace.path,
      hooks: config.hooks
    });

    const client = new CodexAppServerClient({
      command: config.codex.command,
      workspacePath: workspace.path,
      approvalPolicy: config.codex.approvalPolicy ?? "never",
      threadSandbox: config.codex.threadSandbox ?? "workspace-write",
      turnSandboxPolicy: config.codex.turnSandboxPolicy ?? { type: "workspaceWrite" },
      readTimeoutMs: config.codex.readTimeoutMs,
      turnTimeoutMs: config.codex.turnTimeoutMs
    });

    let issue = input.issue;
    const abortHandler = () => {
      void client.stop();
    };

    try {
      input.signal?.addEventListener("abort", abortHandler);
      if (input.signal?.aborted) {
        throw new Error("run canceled");
      }

      await client.start();

      for (let turnNumber = 1; turnNumber <= config.agent.maxTurns; turnNumber += 1) {
        if (input.signal?.aborted) {
          throw new Error("run canceled");
        }

        const prompt =
          turnNumber === 1
            ? await renderPromptTemplate(this.workflowDefinition, { issue, attempt: input.attempt })
            : buildContinuationPrompt(issue, turnNumber, config.agent.maxTurns);

        await client.runTurn({
          prompt,
          title: `${issue.identifier}: ${issue.title}`
        });

        const refreshedIssues = await this.issueStateRefresher([issue.id]);
        if (refreshedIssues[0]) {
          issue = refreshedIssues[0];
        }

        if (!config.tracker.activeStates.map((state) => state.toLowerCase()).includes(issue.state.toLowerCase())) {
          break;
        }
      }

      return { reason: "normal" };
    } finally {
      input.signal?.removeEventListener("abort", abortHandler);
      await client.stop();
      await finalizeWorkspaceRun({
        workspacePath: workspace.path,
        hooks: config.hooks
      });
    }
  }
}

function buildContinuationPrompt(
  issue: OrchestrationIssue,
  turnNumber: number,
  maxTurns: number
): string {
  return [
    `Continue working on issue ${issue.identifier}.`,
    `This is continuation turn ${turnNumber} of ${maxTurns}.`,
    "Resume from the existing thread and workspace state."
  ].join("\n");
}
