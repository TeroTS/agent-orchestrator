export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface OrchestrationIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface DispatchEligibilityInput {
  issue: OrchestrationIssue;
  activeStates: string[];
  terminalStates: string[];
  claimedIssueIds: Set<string>;
  runningIssues: Map<string, OrchestrationIssue>;
  maxConcurrentAgents: number;
  maxConcurrentAgentsByState: Record<string, number>;
}

export type DispatchEligibilityResult =
  | { ok: true }
  | { ok: false; reason: string };

export type ReconciliationAction =
  | "update"
  | "stop_and_cleanup"
  | "stop_without_cleanup";

export function sortDispatchCandidates(
  issues: OrchestrationIssue[],
): OrchestrationIssue[] {
  return [...issues].sort((left, right) => {
    const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    const leftCreatedAt = left.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const rightCreatedAt =
      right.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }

    return left.identifier.localeCompare(right.identifier);
  });
}

export function isIssueDispatchEligible(
  input: DispatchEligibilityInput,
): DispatchEligibilityResult {
  const issue = input.issue;
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
    return { ok: false, reason: "missing_required_issue_fields" };
  }

  const normalizedState = issue.state.toLowerCase();
  const activeStates = new Set(
    input.activeStates.map((state) => state.toLowerCase()),
  );
  const terminalStates = new Set(
    input.terminalStates.map((state) => state.toLowerCase()),
  );

  if (
    !activeStates.has(normalizedState) ||
    terminalStates.has(normalizedState)
  ) {
    return { ok: false, reason: "issue_not_active" };
  }

  if (input.runningIssues.has(issue.id)) {
    return { ok: false, reason: "already_running" };
  }

  if (input.claimedIssueIds.has(issue.id)) {
    return { ok: false, reason: "already_claimed" };
  }

  if (
    availableGlobalSlots(input.runningIssues.size, input.maxConcurrentAgents) <=
    0
  ) {
    return { ok: false, reason: "no_global_slots" };
  }

  if (
    availableStateSlots(
      issue.state,
      input.runningIssues,
      input.maxConcurrentAgents,
      input.maxConcurrentAgentsByState,
    ) <= 0
  ) {
    return { ok: false, reason: "no_state_slots" };
  }

  if (
    normalizedState === "todo" &&
    hasNonTerminalBlocker(issue, terminalStates)
  ) {
    return { ok: false, reason: "todo_blocked_by_non_terminal_issue" };
  }

  return { ok: true };
}

export function computeRetryDelayMs(input: {
  attempt: number;
  maxRetryBackoffMs: number;
  normalExit: boolean;
}): number {
  if (input.normalExit) {
    return 1000;
  }

  const baseDelay = 10000 * 2 ** Math.max(input.attempt - 1, 0);
  return Math.min(baseDelay, input.maxRetryBackoffMs);
}

export function computeReconciliationAction(input: {
  nextState: string;
  activeStates: string[];
  terminalStates: string[];
}): ReconciliationAction {
  const normalizedState = input.nextState.toLowerCase();
  const terminalStates = new Set(
    input.terminalStates.map((state) => state.toLowerCase()),
  );
  if (terminalStates.has(normalizedState)) {
    return "stop_and_cleanup";
  }

  const activeStates = new Set(
    input.activeStates.map((state) => state.toLowerCase()),
  );
  if (activeStates.has(normalizedState)) {
    return "update";
  }

  return "stop_without_cleanup";
}

function availableGlobalSlots(
  runningCount: number,
  maxConcurrentAgents: number,
): number {
  return Math.max(maxConcurrentAgents - runningCount, 0);
}

function availableStateSlots(
  state: string,
  runningIssues: Map<string, OrchestrationIssue>,
  maxConcurrentAgents: number,
  maxConcurrentAgentsByState: Record<string, number>,
): number {
  const normalizedState = state.toLowerCase();
  const stateLimit =
    maxConcurrentAgentsByState[normalizedState] ?? maxConcurrentAgents;
  let stateCount = 0;

  for (const runningIssue of runningIssues.values()) {
    if (runningIssue.state.toLowerCase() === normalizedState) {
      stateCount += 1;
    }
  }

  return Math.max(stateLimit - stateCount, 0);
}

function hasNonTerminalBlocker(
  issue: OrchestrationIssue,
  terminalStates: Set<string>,
): boolean {
  return issue.blockedBy.some((blocker) => {
    if (!blocker.state) {
      return true;
    }

    return !terminalStates.has(blocker.state.toLowerCase());
  });
}
