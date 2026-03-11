import {
  isIssueDispatchEligible,
  sortDispatchCandidates,
  type OrchestrationIssue,
} from "./orchestration-rules.js";

export interface RunningEntry {
  issue: OrchestrationIssue;
  startedAt: Date;
  sessionId?: string | undefined;
  threadId?: string | undefined;
  turnId?: string | undefined;
  codexAppServerPid?: number | undefined;
  lastCodexEvent?: string | undefined;
  lastCodexTimestamp?: string | undefined;
  lastCodexMessage?: string | undefined;
  turnCount?: number | undefined;
}

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  error: string | null;
}

export interface SelectIssuesToDispatchInput {
  issues: OrchestrationIssue[];
  activeStates: string[];
  terminalStates: string[];
  claimedIssueIds: Set<string>;
  runningIssues: Map<string, RunningEntry>;
  maxConcurrentAgents: number;
  maxConcurrentAgentsByState: Record<string, number>;
}

export function selectIssuesToDispatch(
  input: SelectIssuesToDispatchInput,
): OrchestrationIssue[] {
  const selected: OrchestrationIssue[] = [];
  const runningIssues = new Map(input.runningIssues);
  const claimedIssueIds = new Set(input.claimedIssueIds);

  for (const issue of sortDispatchCandidates(input.issues)) {
    const eligibility = isIssueDispatchEligible({
      issue,
      activeStates: input.activeStates,
      terminalStates: input.terminalStates,
      claimedIssueIds,
      runningIssues: new Map(
        Array.from(runningIssues.entries(), ([id, entry]) => [id, entry.issue]),
      ),
      maxConcurrentAgents: input.maxConcurrentAgents,
      maxConcurrentAgentsByState: input.maxConcurrentAgentsByState,
    });

    if (!eligibility.ok) {
      continue;
    }

    selected.push(issue);
    claimedIssueIds.add(issue.id);
    runningIssues.set(issue.id, {
      issue,
      startedAt: new Date(0),
    });
  }

  return selected;
}

export function buildRetryEntry(input: {
  issueId: string;
  identifier: string;
  attempt: number;
  error: string | null;
  delayMs: number;
  nowMs: number;
}): RetryEntry {
  return {
    issueId: input.issueId,
    identifier: input.identifier,
    attempt: input.attempt,
    error: input.error,
    dueAtMs: input.nowMs + input.delayMs,
  };
}

export function createRuntimeSnapshot(input: {
  runningIssues: Map<string, RunningEntry>;
  retryEntries: Map<string, RetryEntry>;
  completedIssueIds: Set<string>;
}) {
  return {
    running: Array.from(input.runningIssues.values()).map((entry) => ({
      issueId: entry.issue.id,
      identifier: entry.issue.identifier,
      state: entry.issue.state,
      sessionId: entry.sessionId,
      threadId: entry.threadId,
      turnId: entry.turnId,
      codexAppServerPid: entry.codexAppServerPid,
      lastCodexEvent: entry.lastCodexEvent,
      lastCodexTimestamp: entry.lastCodexTimestamp,
      lastCodexMessage: entry.lastCodexMessage,
      turnCount: entry.turnCount ?? 0,
      startedAt: entry.startedAt.toISOString(),
    })),
    retries: Array.from(input.retryEntries.values()),
    completedIssueIds: Array.from(input.completedIssueIds).sort(),
  };
}
