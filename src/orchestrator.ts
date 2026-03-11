import { workspacePathFor } from "./workspace-manager.js";
import {
  computeReconciliationAction,
  computeRetryDelayMs,
  type OrchestrationIssue
} from "./orchestration-rules.js";
import {
  buildRetryEntry,
  createRuntimeSnapshot,
  selectIssuesToDispatch,
  type RetryEntry,
  type RunningEntry
} from "./orchestrator-state.js";
import {
  validateWorkflowForDispatch,
  type EffectiveWorkflowConfig,
  type WorkflowDefinition
} from "./workflow-loader.js";
import { createStructuredLogger, type StructuredLogger } from "./structured-logger.js";

export interface WorkflowStoreLike {
  load(): Promise<{ current: WorkflowDefinition }>;
  current(): WorkflowDefinition;
  reload(): Promise<{ ok: boolean; current?: WorkflowDefinition | null; error?: unknown }>;
}

export interface TrackerLike {
  fetchCandidateIssues(activeStates: string[]): Promise<OrchestrationIssue[]>;
  fetchIssuesByStates(states: string[]): Promise<OrchestrationIssue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<OrchestrationIssue[]>;
}

export interface RunnerHandle {
  cancel(): void;
  promise: Promise<{ reason: "normal" } | { reason: "error"; error: string }>;
}

export interface RunnerLike {
  startRun(input: { issue: OrchestrationIssue; attempt: number | null }): RunnerHandle;
}

export interface SymphonyOrchestratorOptions {
  workflowStore: WorkflowStoreLike;
  tracker: TrackerLike;
  runner: RunnerLike;
  removeWorkspace: (workspacePath: string) => Promise<void>;
  logger?: StructuredLogger;
}

export class SymphonyOrchestrator {
  private readonly workflowStore: WorkflowStoreLike;
  private readonly tracker: TrackerLike;
  private readonly runner: RunnerLike;
  private readonly removeWorkspaceFn: (workspacePath: string) => Promise<void>;
  private readonly logger: StructuredLogger;

  private config: EffectiveWorkflowConfig | null = null;
  private running = new Map<string, RunningEntry & { cancel: () => void; retryAttempt: number | null }>();
  private claimed = new Set<string>();
  private retryAttempts = new Map<string, RetryEntry>();
  private retryTimers = new Map<string, NodeJS.Timeout>();
  private completed = new Set<string>();
  private tickTimer: NodeJS.Timeout | null = null;

  constructor(options: SymphonyOrchestratorOptions) {
    this.workflowStore = options.workflowStore;
    this.tracker = options.tracker;
    this.runner = options.runner;
    this.removeWorkspaceFn = options.removeWorkspace;
    this.logger = options.logger ?? createStructuredLogger();
  }

  async start(): Promise<void> {
    const loaded = await this.workflowStore.load();
    this.config = this.requireValidConfig(loaded.current);
    this.logger.info("startup completed", {
      outcome: "completed"
    });
    await this.startupTerminalWorkspaceCleanup();
    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }

    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();

    for (const running of this.running.values()) {
      running.cancel();
    }
  }

  async tick(): Promise<void> {
    const config = this.currentConfig();
    await this.reconcileRunningIssues(config);

    const reloaded = await this.workflowStore.reload();
    const definition = reloaded.ok ? reloaded.current ?? this.workflowStore.current() : this.workflowStore.current();
    this.config = this.requireValidConfig(definition);

    const refreshedConfig = this.currentConfig();
    const issues = await this.tracker.fetchCandidateIssues(refreshedConfig.tracker.activeStates);
    const selected = selectIssuesToDispatch({
      issues,
      activeStates: refreshedConfig.tracker.activeStates,
      terminalStates: refreshedConfig.tracker.terminalStates,
      claimedIssueIds: this.claimed,
      runningIssues: new Map(
        Array.from(this.running.entries(), ([id, entry]) => [id, { issue: entry.issue, startedAt: entry.startedAt }])
      ),
      maxConcurrentAgents: refreshedConfig.agent.maxConcurrentAgents,
      maxConcurrentAgentsByState: refreshedConfig.agent.maxConcurrentAgentsByState
    });

    for (const issue of selected) {
      this.logger.info("dispatch scheduled", {
        issue_id: issue.id,
        issue_identifier: issue.identifier
      });
      await this.dispatchNow(issue, null);
    }

    this.scheduleTick(refreshedConfig.polling.intervalMs);
  }

  async dispatchNow(issue: OrchestrationIssue, attempt: number | null): Promise<void> {
    const handle = this.runner.startRun({ issue, attempt });
    this.claimed.add(issue.id);
    this.retryAttempts.delete(issue.id);
    this.clearRetryTimer(issue.id);

    this.running.set(issue.id, {
      issue,
      startedAt: new Date(),
      cancel: handle.cancel,
      retryAttempt: attempt
    });

    handle.promise
      .then((result) => {
        void this.onWorkerExit(issue, result);
      })
      .catch((error) => {
        void this.onWorkerExit(issue, {
          reason: "error",
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  snapshot() {
    return createRuntimeSnapshot({
      runningIssues: new Map(
        Array.from(this.running.entries(), ([id, entry]) => [
          id,
          {
            issue: entry.issue,
            startedAt: entry.startedAt,
            sessionId: entry.sessionId
          }
        ])
      ),
      retryEntries: this.retryAttempts,
      completedIssueIds: this.completed
    });
  }

  private async startupTerminalWorkspaceCleanup(): Promise<void> {
    const config = this.currentConfig();
    const terminalIssues = await this.tracker.fetchIssuesByStates(config.tracker.terminalStates);
    await Promise.all(
      terminalIssues.map((issue) =>
        this.removeWorkspaceFn(workspacePathFor(config.workspace.root, issue.identifier))
      )
    );
  }

  private async reconcileRunningIssues(config: EffectiveWorkflowConfig): Promise<void> {
    if (this.running.size === 0) {
      return;
    }

    const runningIds = Array.from(this.running.keys());
    const refreshedIssues = await this.tracker.fetchIssueStatesByIds(runningIds);
    for (const refreshedIssue of refreshedIssues) {
      const running = this.running.get(refreshedIssue.id);
      if (!running) {
        continue;
      }

      const action = computeReconciliationAction({
        nextState: refreshedIssue.state,
        activeStates: config.tracker.activeStates,
        terminalStates: config.tracker.terminalStates
      });

      if (action === "update") {
        running.issue = refreshedIssue;
        continue;
      }

      running.cancel();
      this.logger.info("run reconciled", {
        issue_id: refreshedIssue.id,
        issue_identifier: refreshedIssue.identifier,
        outcome: action
      });
      this.running.delete(refreshedIssue.id);
      if (action === "stop_and_cleanup") {
        await this.removeWorkspaceFn(workspacePathFor(config.workspace.root, refreshedIssue.identifier));
      }
      this.claimed.delete(refreshedIssue.id);
    }
  }

  private async onWorkerExit(
    issue: OrchestrationIssue,
    result: { reason: "normal" } | { reason: "error"; error: string }
  ): Promise<void> {
    const running = this.running.get(issue.id);
    if (!running) {
      return;
    }

    this.running.delete(issue.id);

    if (result.reason === "normal") {
      this.logger.info("worker completed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        outcome: "completed"
      });
      this.completed.add(issue.id);
      this.scheduleRetry(issue, 1, null, true);
      return;
    }

    this.logger.warn("worker failed", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      outcome: "retrying",
      reason: result.error
    });
    const nextAttempt = (running.retryAttempt ?? 0) + 1;
    this.scheduleRetry(issue, nextAttempt, result.error, false);
  }

  private scheduleRetry(
    issue: OrchestrationIssue,
    attempt: number,
    error: string | null,
    normalExit: boolean
  ): void {
    const config = this.currentConfig();
    const delayMs = computeRetryDelayMs({
      attempt,
      maxRetryBackoffMs: config.agent.maxRetryBackoffMs,
      normalExit
    });

    const retryEntry = buildRetryEntry({
      issueId: issue.id,
      identifier: issue.identifier,
      attempt,
      error,
      delayMs,
      nowMs: Date.now()
    });

    this.retryAttempts.set(issue.id, retryEntry);
    this.claimed.add(issue.id);
    this.clearRetryTimer(issue.id);
    const timer = setTimeout(() => {
      void this.onRetryTimer(issue.id);
    }, delayMs);
    this.retryTimers.set(issue.id, timer);
  }

  private async onRetryTimer(issueId: string): Promise<void> {
    const retryEntry = this.retryAttempts.get(issueId);
    if (!retryEntry) {
      return;
    }

    this.retryAttempts.delete(issueId);
    this.clearRetryTimer(issueId);

    const config = this.currentConfig();
    const candidates = await this.tracker.fetchCandidateIssues(config.tracker.activeStates);
    const issue = candidates.find((candidate) => candidate.id === issueId);
    if (!issue) {
      this.claimed.delete(issueId);
      return;
    }

    const selected = selectIssuesToDispatch({
      issues: [issue],
      activeStates: config.tracker.activeStates,
      terminalStates: config.tracker.terminalStates,
      claimedIssueIds: new Set(Array.from(this.claimed).filter((id) => id !== issueId)),
      runningIssues: new Map(
        Array.from(this.running.entries(), ([id, entry]) => [id, { issue: entry.issue, startedAt: entry.startedAt }])
      ),
      maxConcurrentAgents: config.agent.maxConcurrentAgents,
      maxConcurrentAgentsByState: config.agent.maxConcurrentAgentsByState
    });

    if (selected.length === 0) {
      this.scheduleRetry(issue, retryEntry.attempt + 1, "no available orchestrator slots", false);
      return;
    }

    await this.dispatchNow(issue, retryEntry.attempt);
  }

  private currentConfig(): EffectiveWorkflowConfig {
    if (!this.config) {
      throw new Error("Orchestrator has not been started.");
    }
    return this.config;
  }

  private requireValidConfig(definition: WorkflowDefinition): EffectiveWorkflowConfig {
    const validation = validateWorkflowForDispatch(definition);
    if (!validation.ok) {
      this.logger.error("validation failed", {
        outcome: "failed",
        reason: validation.errors.join(", ")
      });
      throw new Error(validation.errors.join(", "));
    }
    return validation.config;
  }

  private scheduleTick(delayMs: number): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
    }
    this.tickTimer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private clearRetryTimer(issueId: string): void {
    const existingTimer = this.retryTimers.get(issueId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.retryTimers.delete(issueId);
    }
  }
}
