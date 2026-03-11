import { workspacePathFor } from "./workspace-manager.js";
import type { CodexRuntimeEvent } from "./codex-app-server.js";
import {
  computeReconciliationAction,
  computeRetryDelayMs,
  type OrchestrationIssue,
} from "./orchestration-rules.js";
import {
  buildRetryEntry,
  createRuntimeSnapshot,
  selectIssuesToDispatch,
  type RetryEntry,
  type RunningEntry,
} from "./orchestrator-state.js";
import {
  validateWorkflowForDispatch,
  type EffectiveWorkflowConfig,
  type WorkflowDefinition,
} from "./workflow-loader.js";
import {
  createStructuredLogger,
  type StructuredLogger,
} from "./structured-logger.js";

export interface WorkflowStoreLike {
  load(): Promise<{ current: WorkflowDefinition }>;
  current(): WorkflowDefinition;
  reload(): Promise<{
    ok: boolean;
    current?: WorkflowDefinition | null;
    error?: unknown;
  }>;
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
  startRun(input: {
    issue: OrchestrationIssue;
    attempt: number | null;
    onEvent?: (event: CodexRuntimeEvent) => void;
  }): RunnerHandle;
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
  private running = new Map<
    string,
    RunningEntry & { cancel: () => void; retryAttempt: number | null }
  >();
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
      outcome: "completed",
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
    await this.reloadConfigKeepingLastKnownGood();

    const refreshedConfig = this.currentConfig();
    let issues: OrchestrationIssue[];
    try {
      issues = await this.tracker.fetchCandidateIssues(
        refreshedConfig.tracker.activeStates,
      );
    } catch (error) {
      this.logger.warn("candidate fetch failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      this.scheduleTick(refreshedConfig.polling.intervalMs);
      return;
    }

    const selected = selectIssuesToDispatch({
      issues,
      activeStates: refreshedConfig.tracker.activeStates,
      terminalStates: refreshedConfig.tracker.terminalStates,
      claimedIssueIds: this.claimed,
      runningIssues: new Map(
        Array.from(this.running.entries(), ([id, entry]) => [
          id,
          { issue: entry.issue, startedAt: entry.startedAt },
        ]),
      ),
      maxConcurrentAgents: refreshedConfig.agent.maxConcurrentAgents,
      maxConcurrentAgentsByState:
        refreshedConfig.agent.maxConcurrentAgentsByState,
    });

    for (const issue of selected) {
      this.logger.info("dispatch scheduled", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      });
      await this.dispatchNow(issue, null);
    }

    this.scheduleTick(refreshedConfig.polling.intervalMs);
  }

  async dispatchNow(
    issue: OrchestrationIssue,
    attempt: number | null,
  ): Promise<void> {
    this.claimed.add(issue.id);
    this.retryAttempts.delete(issue.id);
    this.clearRetryTimer(issue.id);

    const runningEntry: RunningEntry & {
      cancel: () => void;
      retryAttempt: number | null;
    } = {
      issue,
      startedAt: new Date(),
      cancel: () => {},
      retryAttempt: attempt,
      turnCount: 0,
    };
    this.running.set(issue.id, runningEntry);

    let handle: RunnerHandle;
    try {
      handle = this.runner.startRun({
        issue,
        attempt,
        onEvent: (event) => {
          this.handleRuntimeEvent(issue.id, event);
        },
      });
    } catch (error) {
      this.running.delete(issue.id);
      this.logger.error("worker spawn failed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        reason: error instanceof Error ? error.message : String(error),
      });
      this.scheduleRetry(
        issue,
        (attempt ?? 0) + 1,
        "failed to spawn agent",
        false,
      );
      return;
    }

    runningEntry.cancel = handle.cancel;

    handle.promise
      .then((result) => {
        void this.onWorkerExit(issue, result);
      })
      .catch((error) => {
        void this.onWorkerExit(issue, {
          reason: "error",
          error: error instanceof Error ? error.message : String(error),
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
            sessionId: entry.sessionId,
            threadId: entry.threadId,
            turnId: entry.turnId,
            codexAppServerPid: entry.codexAppServerPid,
            lastCodexEvent: entry.lastCodexEvent,
            lastCodexTimestamp: entry.lastCodexTimestamp,
            lastCodexMessage: entry.lastCodexMessage,
            turnCount: entry.turnCount,
          },
        ]),
      ),
      retryEntries: this.retryAttempts,
      completedIssueIds: this.completed,
    });
  }

  private async startupTerminalWorkspaceCleanup(): Promise<void> {
    const config = this.currentConfig();
    try {
      const terminalIssues = await this.tracker.fetchIssuesByStates(
        config.tracker.terminalStates,
      );
      await Promise.all(
        terminalIssues.map((issue) =>
          this.removeWorkspaceFn(
            workspacePathFor(config.workspace.root, issue.identifier),
          ),
        ),
      );
    } catch (error) {
      this.logger.warn("startup terminal cleanup failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async reconcileRunningIssues(
    config: EffectiveWorkflowConfig,
  ): Promise<void> {
    this.reconcileStalledRuns(config);
    if (this.running.size === 0) {
      return;
    }

    const runningIds = Array.from(this.running.keys());
    let refreshedIssues: OrchestrationIssue[];
    try {
      refreshedIssues = await this.tracker.fetchIssueStatesByIds(runningIds);
    } catch (error) {
      this.logger.warn("reconciliation refresh failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (const refreshedIssue of refreshedIssues) {
      const running = this.running.get(refreshedIssue.id);
      if (!running) {
        continue;
      }

      const action = computeReconciliationAction({
        nextState: refreshedIssue.state,
        activeStates: config.tracker.activeStates,
        terminalStates: config.tracker.terminalStates,
      });

      if (action === "update") {
        running.issue = refreshedIssue;
        continue;
      }

      running.cancel();
      this.logger.info("run reconciled", {
        issue_id: refreshedIssue.id,
        issue_identifier: refreshedIssue.identifier,
        outcome: action,
      });
      this.running.delete(refreshedIssue.id);
      if (action === "stop_and_cleanup") {
        await this.removeWorkspaceFn(
          workspacePathFor(config.workspace.root, refreshedIssue.identifier),
        );
      }
      this.claimed.delete(refreshedIssue.id);
    }
  }

  private async onWorkerExit(
    issue: OrchestrationIssue,
    result: { reason: "normal" } | { reason: "error"; error: string },
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
        outcome: "completed",
      });
      this.completed.add(issue.id);
      this.scheduleRetry(issue, 1, null, true);
      return;
    }

    this.logger.warn("worker failed", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      outcome: "retrying",
      reason: result.error,
    });
    const nextAttempt = (running.retryAttempt ?? 0) + 1;
    this.scheduleRetry(issue, nextAttempt, result.error, false);
  }

  private scheduleRetry(
    issue: OrchestrationIssue,
    attempt: number,
    error: string | null,
    normalExit: boolean,
  ): void {
    const config = this.currentConfig();
    const delayMs = computeRetryDelayMs({
      attempt,
      maxRetryBackoffMs: config.agent.maxRetryBackoffMs,
      normalExit,
    });

    const retryEntry = buildRetryEntry({
      issueId: issue.id,
      identifier: issue.identifier,
      attempt,
      error,
      delayMs,
      nowMs: Date.now(),
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
    const candidates = await this.tracker.fetchCandidateIssues(
      config.tracker.activeStates,
    );
    const issue = candidates.find((candidate) => candidate.id === issueId);
    if (!issue) {
      this.claimed.delete(issueId);
      return;
    }

    const selected = selectIssuesToDispatch({
      issues: [issue],
      activeStates: config.tracker.activeStates,
      terminalStates: config.tracker.terminalStates,
      claimedIssueIds: new Set(
        Array.from(this.claimed).filter((id) => id !== issueId),
      ),
      runningIssues: new Map(
        Array.from(this.running.entries(), ([id, entry]) => [
          id,
          { issue: entry.issue, startedAt: entry.startedAt },
        ]),
      ),
      maxConcurrentAgents: config.agent.maxConcurrentAgents,
      maxConcurrentAgentsByState: config.agent.maxConcurrentAgentsByState,
    });

    if (selected.length === 0) {
      this.scheduleRetry(
        issue,
        retryEntry.attempt + 1,
        "no available orchestrator slots",
        false,
      );
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

  private requireValidConfig(
    definition: WorkflowDefinition,
  ): EffectiveWorkflowConfig {
    const validation = validateWorkflowForDispatch(definition);
    if (!validation.ok) {
      this.logger.error("validation failed", {
        outcome: "failed",
        reason: validation.errors.join(", "),
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

  private async reloadConfigKeepingLastKnownGood(): Promise<void> {
    const reloaded = await this.workflowStore.reload();
    if (!reloaded.ok) {
      this.logger.warn("workflow reload failed", {
        reason:
          reloaded.error instanceof Error
            ? reloaded.error.message
            : String(reloaded.error),
      });
      return;
    }

    const definition = reloaded.current ?? this.workflowStore.current();
    const validation = validateWorkflowForDispatch(definition);
    if (!validation.ok) {
      this.logger.error("workflow reload validation failed", {
        reason: validation.errors.join(", "),
      });
      return;
    }

    this.config = validation.config;
  }

  private reconcileStalledRuns(config: EffectiveWorkflowConfig): void {
    if (config.codex.stallTimeoutMs <= 0) {
      return;
    }

    const nowMs = Date.now();
    for (const [issueId, running] of Array.from(this.running.entries())) {
      const lastSeenMs = running.lastCodexTimestamp
        ? Date.parse(running.lastCodexTimestamp)
        : running.startedAt.getTime();
      if (!Number.isFinite(lastSeenMs)) {
        continue;
      }

      if (nowMs - lastSeenMs <= config.codex.stallTimeoutMs) {
        continue;
      }

      running.cancel();
      this.running.delete(issueId);
      this.logger.warn("run stalled", {
        issue_id: running.issue.id,
        issue_identifier: running.issue.identifier,
        outcome: "retrying",
      });
      this.scheduleRetry(
        running.issue,
        (running.retryAttempt ?? 0) + 1,
        "stalled session",
        false,
      );
    }
  }

  private handleRuntimeEvent(issueId: string, event: CodexRuntimeEvent): void {
    const running = this.running.get(issueId);
    if (!running) {
      return;
    }

    running.lastCodexEvent = event.event;
    running.lastCodexTimestamp = event.timestamp;
    if (typeof event.codexAppServerPid === "number") {
      running.codexAppServerPid = event.codexAppServerPid;
    }

    const message = summarizeRuntimeMessage(event);
    if (message) {
      running.lastCodexMessage = message;
    }

    if (event.sessionId) {
      running.sessionId = event.sessionId;
    }

    if (event.event === "session_started") {
      const payload = event.payload as
        | { threadId?: unknown; turnId?: unknown }
        | undefined;
      if (typeof payload?.threadId === "string") {
        running.threadId = payload.threadId;
      }
      if (typeof payload?.turnId === "string") {
        running.turnId = payload.turnId;
      }
      running.turnCount = (running.turnCount ?? 0) + 1;
    }
  }
}

function summarizeRuntimeMessage(event: CodexRuntimeEvent): string | undefined {
  if (typeof event.message === "string" && event.message.trim()) {
    return event.message.trim();
  }

  if (
    event.payload &&
    typeof event.payload === "object" &&
    "message" in event.payload &&
    typeof event.payload.message === "string" &&
    event.payload.message.trim()
  ) {
    return event.payload.message.trim();
  }

  return undefined;
}
