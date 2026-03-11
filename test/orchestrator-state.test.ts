import { describe, expect, it } from "vitest";

import {
  buildRetryEntry,
  createRuntimeSnapshot,
  selectIssuesToDispatch,
  type RetryEntry,
  type RunningEntry
} from "../src/orchestrator-state.js";
import type { OrchestrationIssue } from "../src/orchestration-rules.js";

describe("selectIssuesToDispatch", () => {
  it("sorts and selects only eligible issues while slots remain", () => {
    const selected = selectIssuesToDispatch({
      issues: [
        makeIssue({ identifier: "ABC-2", priority: 2, createdAt: "2026-03-02T10:00:00.000Z" }),
        makeIssue({ identifier: "ABC-1", priority: 1, createdAt: "2026-03-01T10:00:00.000Z" }),
        makeIssue({
          identifier: "ABC-3",
          priority: 1,
          state: "Todo",
          blockedBy: [{ id: "block-1", identifier: "BLK-1", state: "In Progress" }]
        })
      ],
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done", "Closed"],
      claimedIssueIds: new Set(),
      runningIssues: new Map(),
      maxConcurrentAgents: 2,
      maxConcurrentAgentsByState: {}
    });

    expect(selected.map((issue) => issue.identifier)).toEqual(["ABC-1", "ABC-2"]);
  });

  it("respects existing claims and running slots", () => {
    const runningIssues = new Map<string, RunningEntry>([
      [
        "issue-1",
        {
          issue: makeIssue({ id: "issue-1", identifier: "ABC-1", state: "In Progress" }),
          startedAt: new Date("2026-03-01T10:00:00.000Z")
        }
      ]
    ]);

    const selected = selectIssuesToDispatch({
      issues: [
        makeIssue({ id: "issue-1", identifier: "ABC-1", state: "In Progress" }),
        makeIssue({ id: "issue-2", identifier: "ABC-2", state: "In Progress" }),
        makeIssue({ id: "issue-3", identifier: "ABC-3", state: "Todo" })
      ],
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done", "Closed"],
      claimedIssueIds: new Set(["issue-2"]),
      runningIssues,
      maxConcurrentAgents: 2,
      maxConcurrentAgentsByState: {}
    });

    expect(selected.map((issue) => issue.identifier)).toEqual(["ABC-3"]);
  });
});

describe("buildRetryEntry", () => {
  it("records attempt, identifier, error, and due time", () => {
    const now = 1_000_000;
    const retry = buildRetryEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      attempt: 3,
      error: "turn_failed",
      delayMs: 40000,
      nowMs: now
    });

    expect(retry).toEqual<RetryEntry>({
      issueId: "issue-1",
      identifier: "ABC-1",
      attempt: 3,
      error: "turn_failed",
      dueAtMs: now + 40000
    });
  });
});

describe("createRuntimeSnapshot", () => {
  it("returns running and retry rows in a stable operator-facing shape", () => {
    const runningIssues = new Map<string, RunningEntry>([
      [
        "issue-1",
        {
          issue: makeIssue({ id: "issue-1", identifier: "ABC-1", state: "In Progress" }),
          startedAt: new Date("2026-03-01T10:00:00.000Z"),
          sessionId: "thread-1-turn-1"
        }
      ]
    ]);
    const retryEntries = new Map<string, RetryEntry>([
      [
        "issue-2",
        {
          issueId: "issue-2",
          identifier: "ABC-2",
          attempt: 2,
          dueAtMs: 123456,
          error: "no available orchestrator slots"
        }
      ]
    ]);

    const snapshot = createRuntimeSnapshot({
      runningIssues,
      retryEntries,
      completedIssueIds: new Set(["issue-9"])
    });

    expect(snapshot).toEqual({
      running: [
        {
          issueId: "issue-1",
          identifier: "ABC-1",
          state: "In Progress",
          sessionId: "thread-1-turn-1",
          threadId: undefined,
          turnId: undefined,
          codexAppServerPid: undefined,
          lastCodexEvent: undefined,
          lastCodexTimestamp: undefined,
          lastCodexMessage: undefined,
          turnCount: 0,
          startedAt: "2026-03-01T10:00:00.000Z"
        }
      ],
      retries: [
        {
          issueId: "issue-2",
          identifier: "ABC-2",
          attempt: 2,
          dueAtMs: 123456,
          error: "no available orchestrator slots"
        }
      ],
      completedIssueIds: ["issue-9"]
    });
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
