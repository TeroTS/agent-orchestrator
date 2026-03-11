import { describe, expect, it } from "vitest";

import {
  computeReconciliationAction,
  computeRetryDelayMs,
  isIssueDispatchEligible,
  sortDispatchCandidates,
  type OrchestrationIssue
} from "../src/orchestration-rules.js";

describe("sortDispatchCandidates", () => {
  it("sorts by priority, then oldest createdAt, then identifier", () => {
    const sorted = sortDispatchCandidates([
      makeIssue({ identifier: "ABC-3", priority: null, createdAt: "2026-03-02T10:00:00.000Z" }),
      makeIssue({ identifier: "ABC-2", priority: 2, createdAt: "2026-03-03T10:00:00.000Z" }),
      makeIssue({ identifier: "ABC-1", priority: 2, createdAt: "2026-03-01T10:00:00.000Z" }),
      makeIssue({ identifier: "ABC-0", priority: 1, createdAt: "2026-03-05T10:00:00.000Z" })
    ]);

    expect(sorted.map((issue) => issue.identifier)).toEqual(["ABC-0", "ABC-1", "ABC-2", "ABC-3"]);
  });
});

describe("isIssueDispatchEligible", () => {
  it("rejects Todo issues with non-terminal blockers", () => {
    const eligible = isIssueDispatchEligible({
      issue: makeIssue({
        identifier: "ABC-10",
        state: "Todo",
        blockedBy: [{ id: "block-1", identifier: "ABC-9", state: "In Progress" }]
      }),
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done", "Closed"],
      claimedIssueIds: new Set(),
      runningIssues: new Map(),
      maxConcurrentAgents: 5,
      maxConcurrentAgentsByState: {}
    });

    expect(eligible.ok).toBe(false);
    if (eligible.ok) {
      throw new Error("expected issue to be ineligible");
    }
    expect(eligible.reason).toBe("todo_blocked_by_non_terminal_issue");
  });

  it("accepts Todo issues when all blockers are terminal", () => {
    const eligible = isIssueDispatchEligible({
      issue: makeIssue({
        identifier: "ABC-11",
        state: "Todo",
        blockedBy: [{ id: "block-1", identifier: "ABC-9", state: "Done" }]
      }),
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done", "Closed"],
      claimedIssueIds: new Set(),
      runningIssues: new Map(),
      maxConcurrentAgents: 5,
      maxConcurrentAgentsByState: {}
    });

    expect(eligible).toEqual({ ok: true });
  });

  it("enforces per-state concurrency limits over the global fallback", () => {
    const runningIssues = new Map<string, OrchestrationIssue>([
      ["in-progress-1", makeIssue({ id: "in-progress-1", identifier: "ABC-1", state: "In Progress" })]
    ]);

    const eligible = isIssueDispatchEligible({
      issue: makeIssue({ identifier: "ABC-2", state: "In Progress" }),
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done", "Closed"],
      claimedIssueIds: new Set(),
      runningIssues,
      maxConcurrentAgents: 10,
      maxConcurrentAgentsByState: {
        "in progress": 1
      }
    });

    expect(eligible.ok).toBe(false);
    if (eligible.ok) {
      throw new Error("expected issue to be ineligible");
    }
    expect(eligible.reason).toBe("no_state_slots");
  });
});

describe("computeRetryDelayMs", () => {
  it("uses a fixed 1 second delay after normal worker exit", () => {
    expect(computeRetryDelayMs({ attempt: 1, maxRetryBackoffMs: 300000, normalExit: true })).toBe(1000);
  });

  it("uses capped exponential backoff for failures", () => {
    expect(computeRetryDelayMs({ attempt: 1, maxRetryBackoffMs: 300000, normalExit: false })).toBe(10000);
    expect(computeRetryDelayMs({ attempt: 3, maxRetryBackoffMs: 300000, normalExit: false })).toBe(40000);
    expect(computeRetryDelayMs({ attempt: 10, maxRetryBackoffMs: 60000, normalExit: false })).toBe(60000);
  });
});

describe("computeReconciliationAction", () => {
  it("keeps active issues running and updates the snapshot", () => {
    expect(
      computeReconciliationAction({
        nextState: "In Progress",
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["Done", "Closed"]
      })
    ).toBe("update");
  });

  it("stops and cleans up terminal issues", () => {
    expect(
      computeReconciliationAction({
        nextState: "Done",
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["Done", "Closed"]
      })
    ).toBe("stop_and_cleanup");
  });

  it("stops without cleanup for non-active non-terminal states", () => {
    expect(
      computeReconciliationAction({
        nextState: "Human Review",
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["Done", "Closed"]
      })
    ).toBe("stop_without_cleanup");
  });
});

function makeIssue(
  overrides: Omit<Partial<OrchestrationIssue>, "createdAt" | "updatedAt"> & {
    createdAt?: Date | string | null;
    updatedAt?: Date | string | null;
  } = {}
): OrchestrationIssue {
  const identifier = overrides.identifier ?? "ABC-1";
  return {
    id: overrides.id ?? identifier.toLowerCase(),
    identifier,
    title: overrides.title ?? `Issue ${identifier}`,
    description: overrides.description ?? null,
    priority: "priority" in overrides ? overrides.priority ?? null : 1,
    state: overrides.state ?? "Todo",
    branchName: overrides.branchName ?? null,
    url: overrides.url ?? null,
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    createdAt:
      "createdAt" in overrides
        ? toDateOrNull(overrides.createdAt)
        : new Date("2026-03-01T10:00:00.000Z"),
    updatedAt:
      "updatedAt" in overrides
        ? toDateOrNull(overrides.updatedAt)
        : new Date("2026-03-01T10:00:00.000Z")
  };
}

function toDateOrNull(value: Date | string | null | undefined): Date | null {
  if (value == null) {
    return null;
  }

  return value instanceof Date ? value : new Date(value);
}
